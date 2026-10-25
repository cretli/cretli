/**
 * Storage worker thread entry (A2 S3, protocol: lib/storage/worker-protocol.md).
 *
 * Owns the single read-write `node:sqlite` connection of the consolidated
 * store. `openStorageDb()` (including the conditional O(size) `integrity_check`, skipped after a clean shutdown) runs here,
 * never on the main event loop.
 *
 * Every request message is ONE whole transaction: BEGIN IMMEDIATE (command) or
 * a query_only read transaction (query), the synchronous handler, then COMMIT
 * or ROLLBACK before the reply is posted. No transaction is ever left open
 * between messages, and handlers cannot be asynchronous (async and generator
 * functions are refused at registration, a returned thenable at call time),
 * so nothing awaits while a transaction is open. Handlers get a guarded
 * connection facade (handler-sql-guard.js), never the raw connection.
 *
 * Commit state of a failure is read from SQLite (`db.isTransaction`), not
 * inferred from where the exception came from: if the transaction ended
 * inside the handler, its durability is `unknown` and not reconcilable. A
 * COMMIT that fails after the transaction ended closes the connection and
 * exits the thread right after the reply (recycle).
 *
 * The main thread never sends SQL: it names a handler from the registry module
 * whose absolute path is fixed in `workerData` at start.
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CHECKPOINT_BLOCKED_BY_READER, openStorageDb, runWalTruncateBarrierBounded } from './db-lifecycle.js';
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { SQLITE_PRIMARY_CODES, sqlitePrimaryCode, toStorageError } from './sqlite-errors.js';
import { BATCH_REQUEST_NAME, COMMAND_ID_PATTERN, CONTROL_OPS, HANDLER_NAME_PATTERN, toWireJson } from './worker-wire.js';
import { createGuardedConnection } from './handler-sql-guard.js';
import { isReceiptHandler } from './command-receipts.js';

const MAX_CACHED_STATEMENTS = 256;
const SQLITE_INTERRUPT = 9;
const AUTO_ROLLBACK_PRIMARY_CODES = new Set([
  SQLITE_PRIMARY_CODES.FULL,
  SQLITE_PRIMARY_CODES.IOERR,
  SQLITE_PRIMARY_CODES.BUSY,
  SQLITE_PRIMARY_CODES.NOMEM,
  SQLITE_INTERRUPT,
]);
const DEFAULT_MAX_RESULT_BYTES = 4 * 1024 * 1024;
/**
 * Savepoint name of a batch member. Issued by the worker on the raw
 * connection only; handlers still cannot issue SAVEPOINT (guard).
 */
const MEMBER_SAVEPOINT = 'cretli_gc_member';
/** Exit code used when an outcome could not be reported to the host. */
const EXIT_UNREPORTABLE = 70;
/** Exit code after a COMMIT-time unknown_commit abandoned the connection. */
const EXIT_RECYCLE = 75;
/** Function kinds refused at registration: their body would not run synchronously. */
const NON_SYNC_FUNCTION_KINDS = new Set(['AsyncFunction', 'AsyncGeneratorFunction', 'GeneratorFunction']);
const maxResultBytes = Number.isFinite(workerData?.maxResultBytes) && workerData.maxResultBytes > 0
  ? workerData.maxResultBytes
  : DEFAULT_MAX_RESULT_BYTES;

/** @type {import('./db-lifecycle.js').StorageDbHandle | null} */
let handle = null;
/** @type {{ commands: Map<string, Function>, queries: Map<string, Function> }} */
let registry = { commands: new Map(), queries: new Map() };
/** Guarded `{ db, prepare }` handed to handlers (lib/storage/handler-sql-guard.js). */
/** @type {ReturnType<typeof createGuardedConnection> | null} */
let guarded = null;
/**
 * Test-only fault injection (enabled by the host `faultInjection` seam):
 * `afterCommit(ctx, name)` runs after COMMIT and before the reply.
 *
 * @type {((ctx: object, name: string) => void) | null}
 */
let afterCommitHook = null;
/**
 * Test-only fault injection: `commitFault(ctx, name)` may return `'commit'`
 * (COMMIT really runs, then fails as if its I/O errored) or `'rollback'`
 * (the transaction is rolled back, then reported as a failed COMMIT). Both
 * end the transaction before the simulated error, like a real COMMIT-time
 * I/O failure whose outcome SQLite cannot report.
 *
 * @type {((ctx: object, name: string) => unknown) | null}
 */
let commitFaultHook = null;
/**
 * Test-only fault injection: `durabilityBarrierFault()` returning true makes
 * the post-recycle durability barrier fail as if the checkpoint fsync errored.
 *
 * @type {(() => unknown) | null}
 */
let durabilityBarrierFaultHook = null;
/**
 * Test-only fault injection: `savepointFault(ctx, name)` returning true makes
 * the worker-issued SAVEPOINT of that batch member fail (transaction still
 * open).
 *
 * @type {((ctx: object, name: string) => unknown) | null}
 */
let savepointFaultHook = null;
/**
 * Set when a COMMIT failed after SQLite ended the transaction: the
 * connection is closed and the thread exits right after the reply, so no
 * later request (a `resolveUnknown` lookup in particular) is ever served by
 * this connection's in-memory view of a commit whose flush failed.
 */
let recycleAfterReply = false;
/** @type {Map<string, import('node:sqlite').StatementSync>} */
const statements = new Map();

/**
 * @param {unknown} message
 */
function post(message) {
  parentPort?.postMessage(message);
}

/**
 * @param {Function} fn
 * @returns {boolean}
 */
function isNonSyncFunction(fn) {
  return NON_SYNC_FUNCTION_KINDS.has(fn.constructor?.name);
}

/**
 * @param {unknown} table
 * @param {string} label
 * @returns {Map<string, Function>}
 */
function readHandlerTable(table, label) {
  /** @type {Map<string, Function>} */
  const out = new Map();
  if (table === undefined) return out;
  if (!table || typeof table !== 'object') throw new TypeError(`Storage handlers: ${label} must be an object`);
  for (const [name, fn] of Object.entries(table)) {
    if (!HANDLER_NAME_PATTERN.test(name)) throw new TypeError(`Storage handlers: invalid ${label} name`);
    if (typeof fn !== 'function') throw new TypeError(`Storage handlers: ${label}.${name} is not a function`);
    if (isNonSyncFunction(fn)) throw new TypeError(`Storage handlers: ${label}.${name} must be synchronous`);
    out.set(name, fn);
  }
  return out;
}

/**
 * @param {unknown} handlersPath
 */
async function loadRegistry(handlersPath) {
  if (typeof handlersPath !== 'string' || !path.isAbsolute(handlersPath)) {
    throw new TypeError('Storage handlers path must be absolute');
  }
  const mod = await import(pathToFileURL(handlersPath).href);
  const source = mod.default && typeof mod.default === 'object' ? mod.default : mod;
  const hook = source.faultInjection?.afterCommit;
  afterCommitHook = workerData?.faultInjection === true && typeof hook === 'function' ? hook : null;
  const fault = source.faultInjection?.commitFault;
  commitFaultHook = workerData?.faultInjection === true && typeof fault === 'function' ? fault : null;
  const barrierFault = source.faultInjection?.durabilityBarrierFault;
  durabilityBarrierFaultHook = workerData?.faultInjection === true && typeof barrierFault === 'function' ? barrierFault : null;
  const savepointFault = source.faultInjection?.savepointFault;
  savepointFaultHook = workerData?.faultInjection === true && typeof savepointFault === 'function' ? savepointFault : null;
  return {
    commands: readHandlerTable(source.commands, 'commands'),
    queries: readHandlerTable(source.queries, 'queries'),
  };
}

/**
 * Prepared statement cache so handlers do not re-prepare hot SQL.
 *
 * @param {string} sql
 * @returns {import('node:sqlite').StatementSync}
 */
function prepare(sql) {
  let stmt = statements.get(sql);
  if (stmt) return stmt;
  stmt = /** @type {import('./db-lifecycle.js').StorageDbHandle} */ (handle).db.prepare(sql);
  if (statements.size >= MAX_CACHED_STATEMENTS) statements.delete(statements.keys().next().value);
  statements.set(sql, stmt);
  return stmt;
}

/**
 * @param {StorageError} err
 * @param {'not_committed' | 'unknown'} commitState
 * @returns {StorageError}
 */
function withCommitState(err, commitState) {
  return new StorageError(err.code, err.message, {
    cause: err.cause,
    retryable: err.retryable,
    details: { ...err.details, commitState },
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function rollbackQuietly(db) {
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } catch {
    // The connection rolls back on its own when ROLLBACK itself fails.
  }
}

/**
 * Run the handler and serialize its result to wire JSON while the transaction
 * is still open, so a result that cannot be sent (not plain JSON, too large)
 * rolls the transaction back instead of being lost after COMMIT.
 *
 * @param {Function} fn
 * @param {object} ctx
 * @param {unknown} payload
 * @returns {string} result JSON
 */
function invokeHandler(fn, ctx, payload, resultBudget = maxResultBytes) {
  const result = fn(ctx, payload);
  if (result && typeof /** @type {any} */ (result).then === 'function') {
    throw new StorageError(STORAGE_ERROR_CODES.IO, 'Storage handlers must be synchronous', {
      retryable: false,
      details: { operation: 'handler_async' },
    });
  }
  let wire;
  try {
    wire = toWireJson(result);
  } catch (err) {
    throw new StorageError(STORAGE_ERROR_CODES.IO, 'Storage handler result is not plain JSON', {
      cause: err,
      retryable: false,
      details: { operation: 'result_invalid' },
    });
  }
  if (wire.bytes > resultBudget) {
    throw new StorageError(STORAGE_ERROR_CODES.IO, 'Storage handler result exceeds the size limit', {
      retryable: false,
      details: { operation: 'result_too_large' },
    });
  }
  return wire.json;
}

/**
 * True for a native SQLite error after which SQLite may roll the whole
 * transaction back automatically (https://sqlite.org/lang_transaction.html:
 * SQLITE_FULL, SQLITE_IOERR, SQLITE_BUSY, SQLITE_NOMEM, SQLITE_INTERRUPT).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isAutoRollbackError(err) {
  return AUTO_ROLLBACK_PRIMARY_CODES.has(sqlitePrimaryCode(err));
}

/**
 * @param {unknown} [cause]
 * @returns {StorageError}
 */
function handlerEndedTransaction(cause) {
  // The handler committed or rolled back on its own; whatever it did is
  // outside the protocol, so its durability cannot be stated.
  // Not reconcilable: a mutation may be durable without its receipt, so a
  // missing receipt does not prove `not_committed` (receipts.md).
  return new StorageError(STORAGE_ERROR_CODES.UNKNOWN_COMMIT, 'Handler ended the transaction', {
    cause,
    details: { operation: 'handler_transaction', commitState: 'unknown', reconcilable: false },
  });
}

/**
 * Error standing in for a COMMIT whose I/O failed (fault injection only).
 *
 * @returns {Error}
 */
function simulatedCommitIoError() {
  return simulatedSqliteError(SQLITE_PRIMARY_CODES.IOERR, 'simulated COMMIT I/O failure');
}

/**
 * Native-shaped SQLite error (fault injection only).
 *
 * @param {number} errcode
 * @param {string} message
 * @returns {Error}
 */
function simulatedSqliteError(errcode, message) {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
}

/** Owner epoch of the request being executed; null = no fencing (see coordinator.md). */
let activeFenceEpoch = null;

/** @type {WeakMap<object, { read: import('node:sqlite').StatementSync, raise: import('node:sqlite').StatementSync }>} */
const fencingStatements = new WeakMap();

/**
 * Prepared-once fencing statements for a connection.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function getFencingStatements(db) {
  let statements = fencingStatements.get(db);
  if (!statements) {
    statements = {
      read: db.prepare('SELECT hwm FROM storage_fencing WHERE id = 1'),
      raise: db.prepare('UPDATE storage_fencing SET hwm = ? WHERE id = 1'),
    };
    fencingStatements.set(db, statements);
  }
  return statements;
}

/**
 * Stored high-water mark. The singleton row is seeded by migration 2, so a
 * missing or invalid row is damage and fails closed (`corrupt`), never as 0.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
function readFenceMark(db) {
  const row = getFencingStatements(db).read.get();
  const hwm = Number(row?.hwm);
  if (!row || !Number.isSafeInteger(hwm) || hwm < 0) {
    throw withCommitState(new StorageError(STORAGE_ERROR_CODES.CORRUPT, 'Storage fencing mark is missing', {
      details: { operation: 'fence' },
    }), 'not_committed');
  }
  return hwm;
}

/**
 * Fencing check inside an open write transaction (BEGIN IMMEDIATE already
 * holds the write lock, so the read-compare-raise is atomic). An epoch below
 * the stored high-water mark is a zombie owner: roll back and refuse with
 * `conflict` / `fenced`. A higher epoch raises the mirror in the same
 * transaction, so it becomes durable together with the first write.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function enforceFence(db) {
  if (activeFenceEpoch === null) return;
  try {
    const hwm = readFenceMark(db);
    if (activeFenceEpoch < hwm) {
      rollbackQuietly(db);
      throw withCommitState(new StorageError(STORAGE_ERROR_CODES.CONFLICT, 'Storage write fenced by a newer owner epoch', {
        details: { operation: 'fence', conflictKind: 'fenced', expectedRevision: hwm, actualRevision: activeFenceEpoch },
      }), 'not_committed');
    }
    if (activeFenceEpoch > hwm) getFencingStatements(db).raise.run(activeFenceEpoch);
  } catch (err) {
    rollbackQuietly(db);
    if (err instanceof StorageError) throw err;
    throw withCommitState(toStorageError(err, 'fence'), 'not_committed');
  }
}

/**
 * One write transaction: BEGIN IMMEDIATE, handler, COMMIT. A failure while
 * our transaction is still open rolls back (not_committed). A failure after
 * the transaction ended (handler COMMIT/ROLLBACK, or a COMMIT that SQLite
 * already finished) is `unknown_commit`: frames may be durable.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Function} fn
 * @param {object} ctx
 * @param {unknown} payload
 * @returns {string} result JSON
 */
function runCommand(db, fn, ctx, payload) {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    throw withCommitState(toStorageError(err, 'begin'), 'not_committed');
  }
  enforceFence(db);
  let resultJson;
  try {
    resultJson = invokeHandler(fn, ctx, payload);
  } catch (err) {
    if (!db.isTransaction) {
      // SQLite itself rolls the whole transaction back on these errors, so
      // nothing of it can be durable (handlers never COMMIT; see the known
      // limit in worker-protocol.md).
      if (isAutoRollbackError(err)) throw withCommitState(toStorageError(err, 'command'), 'not_committed');
      throw handlerEndedTransaction(err);
    }
    rollbackQuietly(db);
    throw withCommitState(toStorageError(err, 'command'), 'not_committed');
  }
  if (!db.isTransaction) throw handlerEndedTransaction();
  try {
    const fault = commitFaultHook?.(ctx, /** @type {any} */ (ctx).name);
    db.exec(fault === 'rollback' ? 'ROLLBACK' : 'COMMIT');
    if (fault === 'commit' || fault === 'rollback') throw simulatedCommitIoError();
  } catch (err) {
    const mapped = toStorageError(err, 'commit');
    if (db.isTransaction) {
      rollbackQuietly(db);
      throw withCommitState(mapped, 'not_committed');
    }
    // SQLite ended the transaction but reported a failure: the commit may be
    // in the WAL or not, and this connection's view of it may differ from
    // what WAL recovery will find. Abandon the connection (see handleRequest).
    recycleAfterReply = true;
    throw new StorageError(STORAGE_ERROR_CODES.UNKNOWN_COMMIT, mapped.message, {
      cause: err,
      details: { ...mapped.details, operation: 'commit', commitState: 'unknown' },
    });
  }
  return resultJson;
}

/**
 * One read transaction under `query_only`, so a query handler cannot write.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Function} fn
 * @param {object} ctx
 * @param {unknown} payload
 * @returns {string} result JSON
 */
function runQuery(db, fn, ctx, payload) {
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('BEGIN');
    return invokeHandler(fn, ctx, payload);
  } catch (err) {
    throw withCommitState(toStorageError(err, 'query'), 'not_committed');
  } finally {
    rollbackQuietly(db);
    try {
      db.exec('PRAGMA query_only = OFF');
    } catch {
      // A connection that cannot reset query_only only fails later writes.
    }
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} op
 * @returns {string} result JSON
 */
function runControl(db, op) {
  if (op === 'ping') return JSON.stringify({ schemaVersion: /** @type {any} */ (handle).schemaVersion });
  if (op === 'fence') return runFenceControl(db);
  try {
    const row = /** @type {Record<string, unknown>} */ (db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get());
    return JSON.stringify({ busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) });
  } catch (err) {
    throw withCommitState(toStorageError(err, 'checkpoint'), 'not_committed');
  }
}

/**
 * `fence` control op: without `fenceEpoch` it reads the stored high-water mark;
 * with one it raises the mark (or refuses a lower epoch as `fenced`) in its own
 * tiny write transaction. Used by the coordinator right after a takeover so a
 * zombie owner is fenced before the new owner's first real write.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string} result JSON
 */
function runFenceControl(db) {
  try {
    if (activeFenceEpoch !== null) {
      db.exec('BEGIN IMMEDIATE');
      enforceFence(db);
      db.exec('COMMIT');
    }
    return JSON.stringify({ hwm: readFenceMark(db) });
  } catch (err) {
    if (db.isTransaction) rollbackQuietly(db);
    if (err instanceof StorageError) throw err;
    throw withCommitState(toStorageError(err, 'fence'), 'not_committed');
  }
}

/**
 * @param {string} name
 * @returns {StorageError}
 */
function unknownHandler(name) {
  return new StorageError(STORAGE_ERROR_CODES.IO, `Unknown storage handler ${name}`, {
    retryable: false,
    details: { operation: 'unknown_handler', commitState: 'not_committed' },
  });
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parsePayload(raw) {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : 'null');
  } catch (err) {
    throw new StorageError(STORAGE_ERROR_CODES.IO, 'Storage payload is not valid JSON', {
      cause: err,
      retryable: false,
      details: { operation: 'payload_invalid', commitState: 'not_committed' },
    });
  }
}

/**
 * Refusal of a receipt request addressed to a handler that is not wrapped by
 * `withReceipt` (F30): decided before BEGIN, so nothing ran.
 *
 * @returns {StorageError}
 */
function receiptRequired() {
  return new StorageError(STORAGE_ERROR_CODES.IO, 'Storage handler is not receipt-wrapped', {
    retryable: false,
    details: { operation: 'receipt_required', commitState: 'not_committed' },
  });
}

/**
 * @param {StorageError} err
 * @param {string} commandId
 * @returns {ReturnType<StorageError['toJSON']>}
 */
function memberErrorJson(err, commandId) {
  return serializeFailure(err, { kind: 'command', commandId });
}

/**
 * Validate the batch members before BEGIN. A malformed batch is refused as a
 * whole; an unknown or non-receipt handler only fails its own member.
 *
 * @param {unknown} payload
 * @returns {Array<{ name: string, commandId: string, payload: unknown, fn: Function | null, refusal: StorageError | null }>}
 */
function readBatchMembers(payload) {
  const members = /** @type {any} */ (payload)?.members;
  if (!Array.isArray(members) || members.length === 0) {
    throw new StorageError(STORAGE_ERROR_CODES.IO, 'Storage batch has no members', {
      retryable: false,
      details: { operation: 'payload_invalid', commitState: 'not_committed' },
    });
  }
  return members.map((m) => {
    const name = String(m?.name);
    const commandId = typeof m?.commandId === 'string' && COMMAND_ID_PATTERN.test(m.commandId) ? m.commandId : null;
    if (!HANDLER_NAME_PATTERN.test(name) || !commandId) {
      throw new StorageError(STORAGE_ERROR_CODES.IO, 'Invalid storage batch member', {
        retryable: false,
        details: { operation: 'payload_invalid', commitState: 'not_committed' },
      });
    }
    const fn = registry.commands.get(name) || null;
    let refusal = null;
    if (!fn) refusal = unknownHandler(name);
    else if (!isReceiptHandler(fn)) refusal = receiptRequired();
    return { name, commandId, payload: m.payload, fn, refusal };
  });
}

/**
 * Run one batch member inside its own worker-level savepoint. Returns the
 * member outcome; throws only when the outer transaction ended (the batch is
 * then aborted by the caller).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ name: string, commandId: string, payload: unknown, fn: Function }} member
 * @param {object} ctx
 * @param {number | null} resultBudget bytes still available in the batch reply (null: no result yet)
 * @returns {{ ok: true, resultJson: string, embeddedBytes: number } | { ok: false, error: StorageError } | { ok: false, deferred: true }}
 */
function runMember(db, member, ctx, resultBudget) {
  if (savepointFaultHook?.(ctx, member.name)) throw simulatedSqliteError(SQLITE_PRIMARY_CODES.ERROR, 'simulated SAVEPOINT failure');
  db.exec(`SAVEPOINT ${MEMBER_SAVEPOINT}`);
  let resultJson;
  try {
    // Per-member cap: a result larger than the whole reply budget can never
    // be sent, so it fails the member permanently (`result_too_large`).
    resultJson = invokeHandler(member.fn, ctx, member.payload);
    if (!db.isTransaction) throw handlerEndedTransaction();
  } catch (err) {
    if (!db.isTransaction) throw err;
    db.exec(`ROLLBACK TO ${MEMBER_SAVEPOINT}`);
    db.exec(`RELEASE ${MEMBER_SAVEPOINT}`);
    return { ok: false, error: withCommitState(toStorageError(err, 'command'), 'not_committed') };
  }
  // The reply embeds the result as a JSON string, so the shared budget is
  // charged with the escaped bytes. `resultBudget === null` marks the first
  // result of the batch, which is always accepted (it passed the per-member
  // cap), so a deferred member always fits once it runs first.
  const embeddedBytes = Buffer.byteLength(JSON.stringify(resultJson));
  if (resultBudget !== null && embeddedBytes > resultBudget) {
    db.exec(`ROLLBACK TO ${MEMBER_SAVEPOINT}`);
    db.exec(`RELEASE ${MEMBER_SAVEPOINT}`);
    return { ok: false, deferred: true };
  }
  db.exec(`RELEASE ${MEMBER_SAVEPOINT}`);
  return { ok: true, resultJson, embeddedBytes };
}

/**
 * Error for a batch whose outer transaction ended inside a member: the
 * mapped error when SQLite rolled back by itself (nothing durable), else the
 * non-reconcilable `handler_transaction`.
 *
 * @param {unknown} err
 * @returns {StorageError}
 */
function batchEndedError(err) {
  if (isAutoRollbackError(err)) return withCommitState(toStorageError(err, 'command'), 'not_committed');
  if (err instanceof StorageError && err.details.operation === 'handler_transaction') return err;
  return handlerEndedTransaction(err);
}

/**
 * Group commit (S5): every member in ONE BEGIN IMMEDIATE transaction, each in
 * its own savepoint, then one COMMIT. A member whose handler throws is rolled
 * back to its savepoint and reported failed without failing the others
 * (lib/storage/group-commit.md, partial-failure semantics). The reply is a
 * JSON object `{ committed, error?, members: [...] }`; a batch-level failure
 * is reported inside it so each member keeps its own outcome. With
 * `committed: false` no member is durable unless `error.commitState` is
 * `unknown`; members after an abort carry `notRun: true`. A member whose
 * result fits the per-member cap but not what is left of the shared reply
 * budget is rolled back to its savepoint and, like every member after it,
 * reported `notRun: true, deferred: 'result_budget'` (the committer runs it
 * first in the next batch).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} msg
 * @param {unknown} payload
 * @returns {string} result JSON
 */
function runBatch(db, msg, payload) {
  const members = readBatchMembers(payload);
  const ctxBase = { db: /** @type {any} */ (guarded).db, prepare: /** @type {any} */ (guarded).prepare };
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    throw withCommitState(toStorageError(err, 'begin'), 'not_committed');
  }
  enforceFence(db);
  /** @type {Array<Record<string, unknown>>} */
  const outcomes = [];
  /** Escaped result bytes left in the reply; null until the first result. */
  /** @type {number | null} */
  let budget = null;
  /** @type {StorageError | null} */
  let batchError = null;
  let deferring = false;
  for (let i = 0; i < members.length; i += 1) {
    const member = members[i];
    if (batchError) {
      outcomes.push({ ok: false, notRun: true });
      continue;
    }
    if (deferring) {
      // After a member that did not fit the shared reply budget nothing else
      // runs, so the deferred members keep their order on the next attempt.
      outcomes.push({ ok: false, notRun: true, deferred: 'result_budget' });
      continue;
    }
    if (member.refusal) {
      outcomes.push({ ok: false, error: memberErrorJson(member.refusal, member.commandId) });
      continue;
    }
    const ctx = Object.freeze({ ...ctxBase, requestId: `${msg.id}:${i}`, commandId: member.commandId, name: member.name });
    let outcome;
    try {
      outcome = runMember(db, /** @type {any} */ (member), ctx, budget);
    } catch (err) {
      if (db.isTransaction) {
        // The savepoint itself failed: abandon the whole batch.
        rollbackQuietly(db);
        batchError = withCommitState(toStorageError(err, 'command'), 'not_committed');
      } else {
        batchError = batchEndedError(err);
      }
      outcomes.push({ ok: false, error: memberErrorJson(batchError, member.commandId), offender: true });
      continue;
    }
    if (outcome.ok) {
      budget = (budget === null ? maxResultBytes : budget) - outcome.embeddedBytes;
      outcomes.push({ ok: true, resultJson: outcome.resultJson });
    } else if ('deferred' in outcome) {
      deferring = true;
      outcomes.push({ ok: false, notRun: true, deferred: 'result_budget' });
    } else {
      outcomes.push({ ok: false, error: memberErrorJson(outcome.error, member.commandId) });
    }
  }
  if (!batchError) batchError = commitBatch(db, msg);
  if (!batchError) {
    try {
      afterCommitHook?.({ requestId: msg.id, commandId: null, name: BATCH_REQUEST_NAME }, BATCH_REQUEST_NAME);
    } catch {
      // Test hook only; the transaction is already committed.
    }
  }
  return JSON.stringify({ committed: batchError === null, error: batchError ? batchError.toJSON() : null, members: outcomes });
}

/**
 * COMMIT of a batch. Returns null on success or the batch-level error: a
 * COMMIT that failed with the transaction still open rolled back
 * (`not_committed`); one that failed after SQLite ended it is
 * `unknown_commit` and recycles the connection, like `runCommand`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, any>} msg
 * @returns {StorageError | null}
 */
function commitBatch(db, msg) {
  if (!db.isTransaction) return handlerEndedTransaction();
  try {
    const fault = commitFaultHook?.({ requestId: msg.id, commandId: null, name: BATCH_REQUEST_NAME }, BATCH_REQUEST_NAME);
    // 'busy': COMMIT fails before it ran, the transaction is still open.
    if (fault === 'busy') throw simulatedSqliteError(SQLITE_PRIMARY_CODES.BUSY, 'simulated COMMIT busy');
    db.exec(fault === 'rollback' ? 'ROLLBACK' : 'COMMIT');
    if (fault === 'commit' || fault === 'rollback') throw simulatedCommitIoError();
    return null;
  } catch (err) {
    const mapped = toStorageError(err, 'commit');
    if (db.isTransaction) {
      rollbackQuietly(db);
      return withCommitState(mapped, 'not_committed');
    }
    recycleAfterReply = true;
    return new StorageError(STORAGE_ERROR_CODES.UNKNOWN_COMMIT, mapped.message, {
      cause: err,
      details: { ...mapped.details, operation: 'commit', commitState: 'unknown' },
    });
  }
}

/**
 * @param {Record<string, any>} msg
 * @returns {string} result JSON
 */
function execute(msg) {
  const db = /** @type {import('./db-lifecycle.js').StorageDbHandle} */ (handle).db;
  const name = String(msg.name);
  activeFenceEpoch = Number.isSafeInteger(msg.fenceEpoch) && msg.fenceEpoch >= 0 ? msg.fenceEpoch : null;
  if (msg.kind === 'control') {
    if (!CONTROL_OPS.has(name)) throw unknownHandler(name);
    return runControl(db, name);
  }
  if (msg.kind === 'batch') {
    if (name !== BATCH_REQUEST_NAME) throw unknownHandler(name);
    return runBatch(db, msg, parsePayload(msg.payloadJson));
  }
  const table = msg.kind === 'command' ? registry.commands : msg.kind === 'query' ? registry.queries : null;
  const fn = table?.get(name);
  if (!fn) throw unknownHandler(name);
  if (msg.kind === 'command' && msg.requireReceipt === true && !isReceiptHandler(fn)) throw receiptRequired();
  const payload = parsePayload(msg.payloadJson);
  const { db: guardedDb, prepare: guardedPrepare } = /** @type {ReturnType<typeof createGuardedConnection>} */ (guarded);
  const ctx = Object.freeze({ db: guardedDb, prepare: guardedPrepare, requestId: msg.id, commandId: msg.commandId ?? null, name });
  if (msg.kind !== 'command') return runQuery(db, fn, ctx, payload);
  const resultJson = runCommand(db, fn, ctx, payload);
  try {
    afterCommitHook?.(ctx, name);
  } catch {
    // Test hook only; the transaction is already committed.
  }
  return resultJson;
}

/**
 * @param {unknown} err
 * @param {Record<string, any>} msg
 * @returns {ReturnType<StorageError['toJSON']>}
 */
function serializeFailure(err, msg) {
  let mapped = toStorageError(err, msg.kind);
  // A failure that may mean damaged or unsynced data must not be vouched for by a clean marker.
  if (['corrupt', 'io', 'full_disk', 'unknown_commit'].includes(mapped.code)) handle?.markDirty?.();
  /** @type {Record<string, unknown>} */
  const extra = {};
  if (mapped.details.commitState === undefined) extra.commitState = 'not_committed';
  if (typeof msg.commandId === 'string' && mapped.details.commandId === undefined) extra.commandId = msg.commandId;
  if (Object.keys(extra).length > 0) {
    mapped = new StorageError(mapped.code, mapped.message, {
      cause: mapped.cause,
      retryable: mapped.retryable,
      details: { ...mapped.details, ...extra },
    });
  }
  return mapped.toJSON();
}

/**
 * Execute one request, then report it. Execution and reporting are separate:
 * a reply that cannot be posted after a COMMIT is never turned into a
 * `not_committed` error. If even the fallback report fails the thread exits,
 * which the host reports as a worker loss (`unknown_commit` for a command).
 *
 * @param {Record<string, any>} msg
 */
function handleRequest(msg) {
  const startedAt = performance.now();
  /** @type {Record<string, unknown>} */
  let response;
  try {
    const resultJson = execute(msg);
    response = { type: 'response', id: msg.id, ok: true, resultJson, executeMs: performance.now() - startedAt };
  } catch (err) {
    response = { type: 'response', id: msg.id, ok: false, error: serializeFailure(err, msg), executeMs: performance.now() - startedAt };
  }
  if (recycleAfterReply) {
    // Close before the reply so the host can only ever reach a fresh
    // connection (WAL recovery) once it sees this outcome.
    abandonConnection();
    response.recycle = true;
  }
  try {
    post(response);
    if (recycleAfterReply) process.exit(EXIT_RECYCLE);
    return;
  } catch {
    // Fall through to the minimal report below.
  }
  const isWrite = msg.kind === 'command' || msg.kind === 'batch';
  const lost = new StorageError(
    isWrite ? STORAGE_ERROR_CODES.UNKNOWN_COMMIT : STORAGE_ERROR_CODES.IO,
    'Storage reply could not be posted',
    { details: { operation: 'response', commitState: isWrite ? 'unknown' : 'not_committed' } },
  );
  try {
    post({
      type: 'response',
      id: msg.id,
      ok: false,
      error: serializeFailure(lost, msg),
      executeMs: performance.now() - startedAt,
      ...(recycleAfterReply ? { recycle: true } : {}),
    });
  } catch {
    process.exit(EXIT_UNREPORTABLE);
  }
  if (recycleAfterReply) process.exit(EXIT_RECYCLE);
}

/**
 * Close the connection without serving anything else. Errors are ignored:
 * the thread exits next and the replacement worker re-opens the store.
 */
function abandonConnection() {
  statements.clear();
  guarded = null;
  try {
    handle?.close({ clean: false });
  } catch {
    // The process-level close on exit releases what is left.
  }
  handle = null;
}

/**
 * Durability barrier run by EVERY fresh worker connection before `ready`
 * (S4 review F29). The ambiguity left by a COMMIT-time I/O failure cannot be
 * remembered in host memory (the host or process may die before the recycle),
 * so the barrier is a mandatory part of startup. WAL
 * recovery on the fresh connection can read frames that exist only in the OS
 * page cache. `wal_checkpoint(TRUNCATE)` under synchronous=FULL fsyncs the WAL,
 * copies every frame into the database file, fsyncs it and resets the WAL; only
 * a fully completed checkpoint (busy = 0, every frame checkpointed) lets this
 * worker report ready. Any failure is a start failure: the host retries with
 * backoff and finally fails stopped, so nothing is ACKed on unstable frames.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function runDurabilityBarrier(db) {
  try {
    if (durabilityBarrierFaultHook?.()) throw simulatedSqliteError(SQLITE_PRIMARY_CODES.IOERR, 'simulated barrier fsync failure');
    runWalTruncateBarrierBounded(db, { maxWaitMs: workerData?.checkpointWaitMs });
  } catch (err) {
    if (err instanceof StorageError && err.details?.operation === CHECKPOINT_BLOCKED_BY_READER) throw err;
    throw new StorageError(STORAGE_ERROR_CODES.IO, 'Durability barrier after COMMIT failure did not hold', {
      cause: err,
      retryable: true,
      details: { operation: 'durability_barrier', commitState: 'not_committed' },
    });
  }
}

function shutdown() {
  statements.clear();
  guarded = null;
  try {
    handle?.close();
  } catch {
    // Exit anyway; the host already stopped dispatching.
  }
  handle = null;
  post({ type: 'closed' });
  parentPort?.close();
}

/**
 * One `[boot] phase=storage-open` line per DB open (worker stdout is forwarded to the server log): clean-marker
 * result, whether the full integrity_check ran, and the duration of each open step. Timings only, no data.
 *
 * @param {Record<string, any>} diag
 */
function logOpenDiagnostics(diag) {
  const t = diag.timings || {};
  const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)}ms` : 'n/a');
  const age = diag.lastFullCheckAgeMs === null ? 'n/a' : `${Math.round(diag.lastFullCheckAgeMs / 60000)}min`;
  console.log(`[boot] phase=storage-open marker=${diag.marker} reason=${diag.reason} lastFullCheckAge=${age}`
    + ` fullCheck=${diag.fullCheckRan ? 'ran' : 'skipped'} integrity=${ms(t.integrityMs)} openRo=${ms(t.openRoMs)}`
    + ` schema=${ms(t.schemaMs)} fk=${ms(t.fkMs)} openRw=${ms(t.openRwMs)} wal=${ms(t.walMs)}`
    + ` migrations=${ms(t.migrateMs)} total=${ms(t.totalMs)}`);
}

async function start() {
  const startedAt = performance.now();
  /** Per-phase start diagnostics posted with `ready` (timings only, no data). */
  const startPhases = { registryMs: 0, openMs: 0, barrierMs: 0 };
  try {
    registry = await loadRegistry(workerData?.handlersPath);
    startPhases.registryMs = performance.now() - startedAt;
    const openStarted = performance.now();
    handle = openStorageDb({
      dir: workerData?.dir,
      filename: workerData?.filename,
      busyTimeoutMs: workerData?.busyTimeoutMs,
      create: workerData?.create !== false,
      onDiag: logOpenDiagnostics,
    });
    startPhases.openMs = performance.now() - openStarted;
    guarded = createGuardedConnection(handle.db, prepare);
    // Unconditional: no host-memory flag, so a restarted process cannot skip it.
    const barrierStarted = performance.now();
    runDurabilityBarrier(handle.db);
    startPhases.barrierMs = performance.now() - barrierStarted;
    console.log(`[boot] phase=storage-barrier wal_checkpoint=${Math.round(startPhases.barrierMs)}ms`);
  } catch (err) {
    abandonConnection();
    post({ type: 'start_failed', error: toStorageError(err, 'worker_start').toJSON() });
    parentPort?.close();
    return;
  }
  parentPort?.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (recycleAfterReply) return;
    if (msg.type === 'request') handleRequest(msg);
    else if (msg.type === 'shutdown') shutdown();
  });
  post({ type: 'ready', schemaVersion: handle.schemaVersion, runtime: handle.runtime, startPhases });
}

start();
