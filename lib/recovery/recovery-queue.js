/**
 * Durable approved-prompt queue, durable Stop/cancel and durable waiting
 * (leaf R4).
 *
 * This module is the store-level primitive behind three user-visible promises:
 *
 * 1. **Persist before ACK.** `enqueueApprovedPrompt` writes the approved prompt
 *    payload + metadata in one `BEGIN IMMEDIATE` transaction and returns only
 *    after `COMMIT`. A caller may tell the user "approved" only on a successful
 *    return; any failure throws `RecoveryQueueError('queue_write_failed')` and
 *    the caller must NOT ack.
 * 2. **Cancel before ACK.** `requestRunCancel` moves the run to lifecycle
 *    `cancelled` and records the cancel ledger before returning. A crash after
 *    the Stop ack can therefore never resurrect the run.
 * 3. **Waiting is never auto-answered.** A run enters `waiting` only through
 *    `markRunWaiting` (kind `question` | `approval`) and leaves it only through
 *    an explicit `resolveRunWaiting`; `resolveQueueEntryAction` reports a
 *    `waiting` run/entry as `manual_only` with `automatic:false`.
 *
 * Scope boundary: like the rest of `lib/recovery/**` this module is persistence
 * only. It does not touch the runtime (`chat-run-service.js`,
 * `delegation-service.js`, `workspace-watcher*.js`, routes) and it does not
 * implement recovery policy — later leaves wire it in.
 *
 * Schema: the `recovery_queue`, `recovery_cancels` and `recovery_waiting` tables
 * (recovery store schema v3). Idempotency rides on the shared
 * `recovery_requests` ledger with the kinds `queue_enqueue`, `run_cancel`,
 * `run_waiting` and `run_waiting_resolve`, so the same `requestId` never creates
 * a duplicate and a reused `requestId` for another identity is a hard
 * `request_conflict`.
 */

import {
  getRecoveryStoreDatabase,
  getRun,
  transitionRun,
} from './recovery-store.js';
import {
  normalizeRunLifecycleState,
  ownerOfRunFamily,
} from './recovery-contract.js';
import { isRecoveryId } from './recovery-ids.js';

/** Persisted shape version of one queue/waiting JSON record. */
export const RECOVERY_QUEUE_SCHEMA_VERSION = 1;

/** Queue entry states. */
export const RECOVERY_QUEUE_ENTRY_STATES = Object.freeze([
  'queued',
  'launched',
  'waiting',
  'cancelled',
]);

/** Waiting kinds. There is deliberately no other reason to enter `waiting`. */
export const RECOVERY_QUEUE_WAITING_KINDS = Object.freeze(['question', 'approval']);

/** `recovery_requests` kinds owned by this module. */
export const RECOVERY_QUEUE_REQUEST_KINDS = Object.freeze([
  'queue_enqueue',
  'run_cancel',
  'run_waiting',
  'run_waiting_resolve',
]);

/**
 * Queue-level failure. `.code` is a stable machine code and `.details` carries
 * structured context (it may contain the queue `promptRef`, never secrets).
 */
export class RecoveryQueueError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object }} [options]
   */
  constructor(message, { code = 'recovery_queue_error', details = {} } = {}) {
    super(String(message));
    this.name = 'RecoveryQueueError';
    this.code = String(code);
    this.details = details && typeof details === 'object' ? details : {};
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRecoveryQueueError(err) {
  return err instanceof RecoveryQueueError;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {RecoveryQueueError}
 */
function queueError(code, message, details = {}) {
  return new RecoveryQueueError(message, { code, details });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string} an ISO timestamp; `now` may be a number (ms) or a date string
 */
function normalizeNow(value) {
  if (value === undefined || value === null || value === '') return new Date().toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  const parsed = new Date(String(value));
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(1000, Math.floor(parsed));
}

/**
 * @param {unknown} value
 * @returns {string} a canonical queue entry state, or '' for an unknown value
 */
function normalizeQueueEntryState(value) {
  const raw = text(value).toLowerCase();
  return RECOVERY_QUEUE_ENTRY_STATES.includes(raw) ? raw : '';
}

/**
 * Resolve a database handle. An injected open `store` is used as-is; otherwise
 * the process default store is used. Any failure is mapped to the caller's
 * stable queue error code so a broken store can never look like a success.
 *
 * @param {object|undefined} store
 * @param {string} failureCode
 * @returns {import('node:sqlite').DatabaseSync}
 */
function requireQueueDb(store, failureCode) {
  try {
    return getRecoveryStoreDatabase(store);
  } catch (err) {
    throw queueError(failureCode, `Recovery queue requires an open recovery store: ${err?.message || err}`, {
      cause: String(err?.code || err?.message || err),
    });
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} work
 * @returns {T}
 * @template T
 */
function withImmediate(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback may fail when the transaction never started.
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Raw row helpers
// ---------------------------------------------------------------------------

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} logicalRunId
 * @returns {object|null}
 */
function readRunJson(db, logicalRunId) {
  if (!logicalRunId) return null;
  const row = db.prepare('SELECT json FROM recovery_runs WHERE logical_run_id = ?').get(logicalRunId);
  return row ? JSON.parse(String(row.json)) : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} queueId
 * @returns {object|null}
 */
function readQueueJson(db, queueId) {
  if (!queueId) return null;
  const row = db.prepare('SELECT json FROM recovery_queue WHERE queue_id = ?').get(queueId);
  return row ? JSON.parse(String(row.json)) : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} requestId
 * @returns {object|null}
 */
function readQueueByRequestId(db, requestId) {
  if (!requestId) return null;
  const row = db.prepare('SELECT json FROM recovery_queue WHERE request_id = ?').get(requestId);
  return row ? JSON.parse(String(row.json)) : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} kind
 * @param {string} requestId
 * @returns {object|null}
 */
function readRequest(db, kind, requestId) {
  if (!requestId) return null;
  const row = db
    .prepare('SELECT request_id, kind, logical_run_id, attempt_id, json FROM recovery_requests WHERE kind = ? AND request_id = ?')
    .get(kind, requestId);
  return row || null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} logicalRunId
 * @returns {object|null}
 */
function readCancelJson(db, logicalRunId) {
  if (!logicalRunId) return null;
  const row = db
    .prepare('SELECT logical_run_id, request_id, reason, created_at, json FROM recovery_cancels WHERE logical_run_id = ?')
    .get(logicalRunId);
  if (!row) return null;
  return JSON.parse(String(row.json));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} logicalRunId
 * @returns {object|null}
 */
function readWaitingJson(db, logicalRunId) {
  if (!logicalRunId) return null;
  const row = db
    .prepare('SELECT state, json FROM recovery_waiting WHERE logical_run_id = ?')
    .get(logicalRunId);
  if (!row || text(row.state) !== 'pending') return null;
  return JSON.parse(String(row.json));
}

/**
 * When the run CAS committed `waiting` but the `recovery_waiting` row or ledger
 * did not (crash between transactions), surface the pending question from run
 * metadata — same pattern as `getRunCancel`.
 *
 * @param {object|null} run
 * @returns {object|null}
 */
function synthesizeWaitingFromRun(run) {
  if (!run || typeof run !== 'object') return null;
  if (text(run.state) !== 'waiting') return null;
  const requestId = text(run.waitingRequestId);
  if (!requestId) return null;
  const kind = text(run.waitingKind).toLowerCase();
  if (!RECOVERY_QUEUE_WAITING_KINDS.includes(kind)) return null;
  const at = text(run.waitingSince) || text(run.updatedAt);
  return {
    schemaVersion: RECOVERY_QUEUE_SCHEMA_VERSION,
    logicalRunId: text(run.logicalRunId),
    requestId,
    kind,
    state: 'pending',
    promptRef: text(run.waitingPromptRef),
    answer: '',
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} entry
 */
function insertQueueRow(db, entry) {
  db.prepare(`
    INSERT INTO recovery_queue(
      queue_id, logical_run_id, attempt_id, request_id, family, owner, state,
      workspace_folder, chat_id, harness, model, mode, payload, payload_ref,
      created_at, updated_at, json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    text(entry.queueId),
    text(entry.logicalRunId),
    text(entry.attemptId),
    text(entry.requestId),
    text(entry.family),
    text(entry.owner),
    text(entry.state),
    text(entry.workspaceFolder),
    text(entry.chatId),
    text(entry.harness),
    text(entry.model),
    text(entry.mode),
    entry.prompt === undefined || entry.prompt === null ? '' : String(entry.prompt),
    text(entry.promptRef),
    text(entry.createdAt),
    text(entry.updatedAt),
    JSON.stringify(entry)
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} kind
 * @param {string} requestId
 * @param {string} logicalRunId
 * @param {string} attemptId
 * @param {string} at
 * @param {object} json
 */
function insertRequestRow(db, kind, requestId, logicalRunId, attemptId, at, json) {
  db.prepare(`
    INSERT INTO recovery_requests(request_id, kind, logical_run_id, attempt_id, created_at, json)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(text(requestId), text(kind), text(logicalRunId), text(attemptId), text(at), JSON.stringify(json));
}

/**
 * Insert a request ledger row, ignoring a duplicate (idempotent replay).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} kind
 * @param {string} requestId
 * @param {string} logicalRunId
 * @param {string} attemptId
 * @param {string} at
 * @param {object} json
 */
function insertRequestRowIfAbsent(db, kind, requestId, logicalRunId, attemptId, at, json) {
  db.prepare(`
    INSERT INTO recovery_requests(request_id, kind, logical_run_id, attempt_id, created_at, json)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, request_id) DO NOTHING
  `).run(text(requestId), text(kind), text(logicalRunId), text(attemptId), text(at), JSON.stringify(json));
}

/**
 * Persist a queue entry under a new state, keeping the JSON record in sync.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} entry
 * @param {string} state
 * @param {string} at
 * @returns {object}
 */
function updateQueueEntryState(db, entry, state, at) {
  const next = { ...entry, state, updatedAt: at };
  db.prepare('UPDATE recovery_queue SET state = ?, updated_at = ?, json = ? WHERE queue_id = ?').run(
    text(state),
    text(at),
    JSON.stringify(next),
    text(entry.queueId)
  );
  return next;
}

// ---------------------------------------------------------------------------
// enqueueApprovedPrompt
// ---------------------------------------------------------------------------

/**
 * Validate and normalize an `enqueueApprovedPrompt` payload.
 *
 * @param {object} input
 * @returns {object}
 */
function buildQueueEntry(input) {
  const src = input && typeof input === 'object' ? input : {};
  const invalid = [];
  const logicalRunId = text(src.logicalRunId);
  const attemptId = text(src.attemptId);
  const requestId = text(src.requestId);
  const family = text(src.family).toLowerCase();
  const owner = text(src.owner);
  const ownerEntry = ownerOfRunFamily(family);
  const rawQueueId = src.queueId;

  if (!isRecoveryId(logicalRunId, 'logical_run')) invalid.push('logicalRunId');
  if (!isRecoveryId(attemptId, 'attempt')) invalid.push('attemptId');
  if (!isRecoveryId(requestId, 'request')) invalid.push('requestId');
  if (!ownerEntry) invalid.push('family');
  else if (!owner || ownerEntry.owner !== owner) invalid.push('owner');
  if (rawQueueId !== undefined && rawQueueId !== null && text(rawQueueId) === '') invalid.push('queueId');

  if (invalid.length > 0) {
    throw queueError('invalid_queue_input', `Invalid queue input: ${invalid.join(', ')}`, {
      fields: invalid,
    });
  }

  // `queueId` defaults to the requestId: the enqueue request is already unique
  // per approved prompt, so it doubles as the durable correlation key.
  const queueId = text(rawQueueId) || requestId;
  const at = normalizeNow(src.now);
  return {
    schemaVersion: RECOVERY_QUEUE_SCHEMA_VERSION,
    queueId,
    logicalRunId,
    attemptId,
    requestId,
    family,
    owner,
    state: 'queued',
    workspaceFolder: text(src.workspaceFolder),
    chatId: text(src.chatId),
    harness: text(src.harness),
    model: text(src.model),
    mode: text(src.mode),
    prompt: src.prompt === undefined || src.prompt === null ? '' : String(src.prompt),
    promptRef: text(src.promptRef),
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Durably enqueue an approved prompt. In one `BEGIN IMMEDIATE` transaction it
 * persists the payload + metadata and the enqueue request ledger, committing
 * before it returns.
 *
 * This is the **block-ACK signal**: a caller may ack the approval to the user
 * only after this returns successfully. `RecoveryQueueError('queue_write_failed')`
 * means the caller must NOT ack.
 *
 * Required: `logicalRunId`, `attemptId`, `requestId`, `family`, `owner`.
 * Optional: `queueId` (defaults to `requestId`), `chatId`, `workspaceFolder`,
 * `harness`, `model`, `mode`, `prompt`, `promptRef`, `now`.
 *
 * - same `requestId` + same run/attempt identity -> `{ created:false, entry }`,
 *   no duplicate row;
 * - same `requestId` + different identity -> `request_conflict`;
 * - malformed input / unknown run -> `invalid_queue_input`;
 * - any persistence failure -> `queue_write_failed`.
 *
 * @param {object} input
 * @param {object} [store]
 * @returns {{ created: boolean, entry: object }}
 */
export function enqueueApprovedPrompt(input, store) {
  const entry = buildQueueEntry(input);
  try {
    const db = requireQueueDb(store, 'queue_write_failed');
    return withImmediate(db, () => {
      const existingRequest = readRequest(db, 'queue_enqueue', entry.requestId);
      if (existingRequest) {
        const existingLogicalRunId = text(existingRequest.logical_run_id);
        const existingAttemptId = text(existingRequest.attempt_id);
        // Idempotent only for the exact same run identity; pointing the caller
        // at another run under the same requestId is a hard conflict.
        if (existingLogicalRunId !== entry.logicalRunId || existingAttemptId !== entry.attemptId) {
          throw queueError(
            'request_conflict',
            'requestId already belongs to a different queue entry',
            {
              requestId: entry.requestId,
              expectedLogicalRunId: entry.logicalRunId,
              expectedAttemptId: entry.attemptId,
              existingLogicalRunId,
              existingAttemptId,
            }
          );
        }
        const existing = readQueueByRequestId(db, entry.requestId);
        return { created: false, entry: existing };
      }

      const run = readRunJson(db, entry.logicalRunId);
      if (!run) {
        throw queueError('invalid_queue_input', 'Logical run not found for queue entry', {
          cause: 'run_not_found',
          logicalRunId: entry.logicalRunId,
        });
      }
      if (text(run.family) !== entry.family || text(run.owner) !== entry.owner) {
        throw queueError('invalid_queue_input', 'family/owner do not match the logical run', {
          cause: 'family_owner_mismatch',
          logicalRunId: entry.logicalRunId,
          family: entry.family,
          owner: entry.owner,
        });
      }

      insertQueueRow(db, entry);
      insertRequestRow(db, 'queue_enqueue', entry.requestId, entry.logicalRunId, entry.attemptId, entry.createdAt, {
        kind: 'queue_enqueue',
        queueId: entry.queueId,
        logicalRunId: entry.logicalRunId,
        attemptId: entry.attemptId,
      });
      return { created: true, entry };
    });
  } catch (err) {
    if (
      isRecoveryQueueError(err) &&
      (err.code === 'invalid_queue_input' || err.code === 'request_conflict')
    ) {
      throw err;
    }
    throw queueError('queue_write_failed', `Failed to persist queue entry: ${err?.message || err}`, {
      logicalRunId: entry.logicalRunId,
      requestId: entry.requestId,
      cause: String(err?.code || err?.message || err),
    });
  }
}

// ---------------------------------------------------------------------------
// Queue reads and claim
// ---------------------------------------------------------------------------

/**
 * @param {string} queueId
 * @param {object} [store]
 * @returns {object|null}
 */
export function getQueueEntry(queueId, store) {
  const id = text(queueId);
  if (!id) return null;
  const db = requireQueueDb(store, 'store_unavailable');
  return readQueueJson(db, id);
}

/**
 * List queue entries. Filters: `family`, `state` (canonical entry state),
 * `workspaceFolder`, `chatId`, `logicalRunId`, `limit`.
 *
 * @param {object} [options]
 * @param {object} [store]
 * @returns {object[]}
 */
export function listQueueEntries(options = {}, store) {
  const opts = options && typeof options === 'object' ? options : {};
  const db = requireQueueDb(store, 'store_unavailable');
  const where = [];
  const params = [];
  if (opts.family !== undefined && opts.family !== null && opts.family !== '') {
    const family = text(opts.family).toLowerCase();
    if (!ownerOfRunFamily(family)) return [];
    where.push('family = ?');
    params.push(family);
  }
  if (opts.state !== undefined && opts.state !== null && opts.state !== '') {
    const state = normalizeQueueEntryState(opts.state);
    if (!state) return [];
    where.push('state = ?');
    params.push(state);
  }
  if (opts.workspaceFolder !== undefined && opts.workspaceFolder !== null) {
    where.push('workspace_folder = ?');
    params.push(text(opts.workspaceFolder));
  }
  if (opts.chatId !== undefined && opts.chatId !== null) {
    where.push('chat_id = ?');
    params.push(text(opts.chatId));
  }
  if (opts.logicalRunId !== undefined && opts.logicalRunId !== null && opts.logicalRunId !== '') {
    where.push('logical_run_id = ?');
    params.push(text(opts.logicalRunId));
  }
  const limit = normalizeLimit(opts.limit, 100);
  const sql = `SELECT json FROM recovery_queue ${
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at ASC, rowid ASC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params).map((row) => JSON.parse(String(row.json)));
}

/**
 * Atomically claim the oldest `queued` entry whose run is neither `waiting` nor
 * `cancelled`, and move it to `launched`.
 *
 * The whole read + CAS update runs in one `BEGIN IMMEDIATE` transaction, so two
 * independent `openRecoveryStore` connections (or two OS processes on the same
 * file) resolve the claim to exactly one winner. A waiting or cancelled run can
 * never be claimed; neither can a `waiting`/`cancelled` entry.
 *
 * @param {{ family?: string, workspaceFolder?: string, now?: number|string }} [options]
 * @param {object} [store]
 * @returns {{ entry: object }|null}
 */
export function claimNextQueuedEntry(options = {}, store) {
  const opts = options && typeof options === 'object' ? options : {};
  const family = text(opts.family).toLowerCase();
  if (family && !ownerOfRunFamily(family)) return null;
  const hasWorkspace = opts.workspaceFolder !== undefined && opts.workspaceFolder !== null;
  const workspaceFolder = hasWorkspace ? text(opts.workspaceFolder) : '';
  const at = normalizeNow(opts.now);
  try {
    const db = requireQueueDb(store, 'queue_claim_failed');
    return withImmediate(db, () => {
      const where = ["q.state = 'queued'", "r.state NOT IN ('waiting', 'cancelled')"];
      const params = [];
      if (family) {
        where.push('q.family = ?');
        params.push(family);
      }
      if (hasWorkspace) {
        where.push('q.workspace_folder = ?');
        params.push(workspaceFolder);
      }
      const row = db
        .prepare(`
          SELECT q.json FROM recovery_queue q
          JOIN recovery_runs r ON r.logical_run_id = q.logical_run_id
          WHERE ${where.join(' AND ')}
          ORDER BY q.created_at ASC, q.rowid ASC
          LIMIT 1
        `)
        .get(...params);
      if (!row) return null;
      const entry = JSON.parse(String(row.json));
      const info = db
        .prepare("UPDATE recovery_queue SET state = 'launched', updated_at = ?, json = ? WHERE queue_id = ? AND state = 'queued'")
        .run(at, JSON.stringify({ ...entry, state: 'launched', updatedAt: at }), text(entry.queueId));
      if (Number(info?.changes) !== 1) return null;
      return { entry: { ...entry, state: 'launched', updatedAt: at } };
    });
  } catch (err) {
    if (isRecoveryQueueError(err)) throw err;
    throw queueError('queue_claim_failed', `Failed to claim queue entry: ${err?.message || err}`, {
      cause: String(err?.code || err?.message || err),
    });
  }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Validate a `requestRunCancel` / `isRunCancelled` style input.
 *
 * @param {object} input
 * @returns {{ logicalRunId: string, requestId: string, reason: string, at: string }}
 */
function buildCancelInput(input) {
  const src = input && typeof input === 'object' ? input : {};
  const invalid = [];
  const logicalRunId = text(src.logicalRunId);
  const requestId = text(src.requestId);
  if (!isRecoveryId(logicalRunId, 'logical_run')) invalid.push('logicalRunId');
  if (!isRecoveryId(requestId, 'request')) invalid.push('requestId');
  if (invalid.length > 0) {
    throw queueError('invalid_cancel_input', `Invalid cancel input: ${invalid.join(', ')}`, {
      fields: invalid,
    });
  }
  return {
    logicalRunId,
    requestId,
    reason: text(src.reason) || 'user_cancel',
    at: normalizeNow(src.now),
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} cancel
 */
function upsertCancelRow(db, cancel) {
  db.prepare(`
    INSERT INTO recovery_cancels(logical_run_id, request_id, reason, created_at, json)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(logical_run_id) DO UPDATE SET
      request_id = excluded.request_id,
      reason = excluded.reason,
      json = excluded.json
  `).run(
    text(cancel.logicalRunId),
    text(cancel.requestId),
    text(cancel.reason),
    text(cancel.createdAt),
    JSON.stringify(cancel)
  );
}

/**
 * Cancel every non-terminal queue entry of a run (idempotent). A Stop is the
 * terminal answer for the whole lineage: `queued` and `waiting` entries are
 * retired together with an already `launched` entry, so nothing about the run
 * can be claimed or auto-resumed again.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} logicalRunId
 * @param {string} at
 */
function cancelRunEntries(db, logicalRunId, at) {
  const rows = db
    .prepare("SELECT json FROM recovery_queue WHERE logical_run_id = ? AND state IN ('queued', 'waiting', 'launched')")
    .all(text(logicalRunId));
  for (const row of rows) {
    const entry = JSON.parse(String(row.json));
    updateQueueEntryState(db, entry, 'cancelled', at);
  }
}

/**
 * Durably Stop a run. This is the cancel-before-ACK primitive: the run is moved
 * to lifecycle `cancelled` (through the store CAS, tolerating a run that is
 * already `cancelled`) and the cancel ledger + queued-entry cancellation are
 * persisted before the function returns.
 *
 * Idempotent by `requestId`; a reused `requestId` for another run is a
 * `request_conflict`. Any persistence failure throws
 * `RecoveryQueueError('cancel_write_failed')` and the caller must NOT ack.
 *
 * A run already `completed` is terminal and cannot be moved to `cancelled`; the
 * call then returns with `cancelled:false` (no resurrect is possible either
 * way).
 *
 * @param {{ logicalRunId: string, requestId: string, reason?: string, now?: number|string }} input
 * @param {object} [store]
 * @returns {{
 *   cancelled: boolean,
 *   alreadyCancelled: boolean,
 *   run: object|null,
 *   entries: object[],
 *   cancel: object|null,
 * }}
 */
export function requestRunCancel(input, store) {
  const cancel = buildCancelInput(input);
  try {
    const db = requireQueueDb(store, 'cancel_write_failed');
    const replay = readRequest(db, 'run_cancel', cancel.requestId);
    if (replay) {
      const existingLogicalRunId = text(replay.logical_run_id);
      if (existingLogicalRunId !== cancel.logicalRunId) {
        throw queueError('request_conflict', 'requestId already belongs to a different cancel', {
          requestId: cancel.requestId,
          expectedLogicalRunId: cancel.logicalRunId,
          existingLogicalRunId,
        });
      }
      return {
        cancelled: false,
        alreadyCancelled: true,
        run: getRun(cancel.logicalRunId, store),
        entries: listQueueEntries({ logicalRunId: cancel.logicalRunId }, store),
        cancel: readCancelJson(db, cancel.logicalRunId),
      };
    }

    const initial = readRunJson(db, cancel.logicalRunId);
    if (!initial) {
      throw queueError('invalid_cancel_input', 'Logical run not found for cancel', {
        cause: 'run_not_found',
        logicalRunId: cancel.logicalRunId,
      });
    }

    let applied = false;
    let run = initial;
    if (text(initial.state) === 'cancelled') {
      run = initial;
    } else {
      // CAS with a retry on revision/state drift: Stop must win against a
      // concurrent lifecycle write, not silently lose the race.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = readRunJson(db, cancel.logicalRunId);
        if (!current) break;
        if (text(current.state) === 'cancelled') {
          run = current;
          break;
        }
        const result = transitionRun(
          {
            logicalRunId: cancel.logicalRunId,
            expectedRevision: current.revision,
            expectedState: current.state,
            to: 'cancelled',
            patch: {
              cancelRequestId: cancel.requestId,
              cancelReason: cancel.reason,
              cancelledAt: cancel.at,
            },
          },
          store
        );
        if (result.ok) {
          applied = true;
          run = result.run;
          break;
        }
        if (result.reason === 'revision_conflict' || result.reason === 'state_mismatch') {
          run = result.run || current;
          continue;
        }
        // not_found / illegal_transition (e.g. already completed): terminal,
        // nothing more to do.
        run = result.run || current;
        break;
      }
    }

    withImmediate(db, () => {
      upsertCancelRow(db, {
        schemaVersion: RECOVERY_QUEUE_SCHEMA_VERSION,
        logicalRunId: cancel.logicalRunId,
        requestId: cancel.requestId,
        reason: cancel.reason,
        createdAt: cancel.at,
      });
      insertRequestRowIfAbsent(
        db,
        'run_cancel',
        cancel.requestId,
        cancel.logicalRunId,
        '',
        cancel.at,
        { kind: 'run_cancel', logicalRunId: cancel.logicalRunId, reason: cancel.reason }
      );
      cancelRunEntries(db, cancel.logicalRunId, cancel.at);
    });

    const finalRun = readRunJson(db, cancel.logicalRunId) || run;
    return {
      cancelled: applied,
      alreadyCancelled: text(initial.state) === 'cancelled',
      run: finalRun,
      entries: listQueueEntries({ logicalRunId: cancel.logicalRunId }, store),
      cancel: readCancelJson(db, cancel.logicalRunId),
    };
  } catch (err) {
    if (
      isRecoveryQueueError(err) &&
      (err.code === 'invalid_cancel_input' || err.code === 'request_conflict')
    ) {
      throw err;
    }
    throw queueError('cancel_write_failed', `Failed to persist run cancel: ${err?.message || err}`, {
      logicalRunId: cancel.logicalRunId,
      requestId: cancel.requestId,
      cause: String(err?.code || err?.message || err),
    });
  }
}

/**
 * Durable Stop predicate. True when the run row is lifecycle `cancelled` or a
 * cancel ledger row exists. A missing run reads as not cancelled.
 *
 * @param {string} logicalRunId
 * @param {object} [store]
 * @returns {boolean}
 */
export function isRunCancelled(logicalRunId, store) {
  const id = text(logicalRunId);
  if (!id) return false;
  const db = requireQueueDb(store, 'store_unavailable');
  if (readCancelJson(db, id)) return true;
  const run = readRunJson(db, id);
  return Boolean(run && text(run.state) === 'cancelled');
}

/**
 * Read the durable cancel record for a run, if any. When the ledger row is
 * missing but the run itself is `cancelled` (a crash between the run CAS and the
 * ledger write), the record is synthesized from the run metadata so the Stop is
 * still honored.
 *
 * @param {string} logicalRunId
 * @param {object} [store]
 * @returns {object|null}
 */
export function getRunCancel(logicalRunId, store) {
  const id = text(logicalRunId);
  if (!id) return null;
  const db = requireQueueDb(store, 'store_unavailable');
  const row = readCancelJson(db, id);
  if (row) return row;
  const run = readRunJson(db, id);
  if (run && text(run.state) === 'cancelled') {
    return {
      schemaVersion: RECOVERY_QUEUE_SCHEMA_VERSION,
      logicalRunId: id,
      requestId: text(run.cancelRequestId),
      reason: text(run.cancelReason) || 'user_cancel',
      createdAt: text(run.cancelledAt) || text(run.updatedAt),
    };
  }
  return null;
}

/**
 * List cancelled runs (authoritative run state `cancelled`), enriched with the
 * cancel ledger record when present. Filters: `family`, `workspaceFolder`,
 * `limit`.
 *
 * @param {object} [options]
 * @param {object} [store]
 * @returns {object[]}
 */
export function listCancelledRuns(options = {}, store) {
  const opts = options && typeof options === 'object' ? options : {};
  const db = requireQueueDb(store, 'store_unavailable');
  const where = ["state = 'cancelled'"];
  const params = [];
  if (opts.family !== undefined && opts.family !== null && opts.family !== '') {
    const family = text(opts.family).toLowerCase();
    if (!ownerOfRunFamily(family)) return [];
    where.push('family = ?');
    params.push(family);
  }
  if (opts.workspaceFolder !== undefined && opts.workspaceFolder !== null) {
    where.push('workspace_folder = ?');
    params.push(text(opts.workspaceFolder));
  }
  const limit = normalizeLimit(opts.limit, 100);
  const rows = db
    .prepare(`SELECT json FROM recovery_runs WHERE ${where.join(' AND ')} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
    .all(...params, limit);
  return rows.map((row) => {
    const run = JSON.parse(String(row.json));
    const cancel = readCancelJson(db, text(run.logicalRunId));
    return {
      schemaVersion: RECOVERY_QUEUE_SCHEMA_VERSION,
      logicalRunId: text(run.logicalRunId),
      family: text(run.family),
      owner: text(run.owner),
      workspaceFolder: text(run.workspaceFolder),
      chatId: text(run.chatId),
      state: 'cancelled',
      requestId: text(cancel?.requestId || run.cancelRequestId),
      reason: text(cancel?.reason || run.cancelReason) || 'user_cancel',
      createdAt: text(cancel?.createdAt || run.cancelledAt || run.updatedAt),
      run,
      cancel,
    };
  });
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/**
 * Validate a `markRunWaiting` input.
 *
 * @param {object} input
 * @returns {object}
 */
function buildWaitingInput(input) {
  const src = input && typeof input === 'object' ? input : {};
  const invalid = [];
  const logicalRunId = text(src.logicalRunId);
  const kind = text(src.kind).toLowerCase();
  const requestId = text(src.requestId);
  const revisionNumber = Number(src.expectedRevision);
  if (!isRecoveryId(logicalRunId, 'logical_run')) invalid.push('logicalRunId');
  if (!Number.isFinite(revisionNumber) || revisionNumber < 1) invalid.push('expectedRevision');
  if (!RECOVERY_QUEUE_WAITING_KINDS.includes(kind)) invalid.push('kind');
  if (!isRecoveryId(requestId, 'request')) invalid.push('requestId');
  if (invalid.length > 0) {
    throw queueError('invalid_waiting_input', `Invalid waiting input: ${invalid.join(', ')}`, {
      fields: invalid,
    });
  }
  return {
    logicalRunId,
    kind,
    requestId,
    expectedRevision: Math.floor(revisionNumber),
    promptRef: text(src.promptRef),
    at: normalizeNow(src.now),
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} waiting
 */
function upsertWaitingRow(db, waiting) {
  db.prepare(`
    INSERT INTO recovery_waiting(
      logical_run_id, request_id, kind, state, prompt_ref, answer, created_at, updated_at, json
    ) VALUES(?, ?, ?, 'pending', ?, '', ?, ?, ?)
    ON CONFLICT(logical_run_id) DO UPDATE SET
      request_id = excluded.request_id,
      kind = excluded.kind,
      state = 'pending',
      prompt_ref = excluded.prompt_ref,
      answer = '',
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      json = excluded.json
  `).run(
    text(waiting.logicalRunId),
    text(waiting.requestId),
    text(waiting.kind),
    text(waiting.promptRef),
    text(waiting.createdAt),
    text(waiting.updatedAt),
    JSON.stringify(waiting)
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} logicalRunId
 * @param {string} answer
 * @param {string} at
 * @returns {object|null}
 */
function resolveWaitingRow(db, logicalRunId, answer, at) {
  const row = db
    .prepare('SELECT json FROM recovery_waiting WHERE logical_run_id = ?')
    .get(text(logicalRunId));
  if (!row) return null;
  const waiting = JSON.parse(String(row.json));
  const next = { ...waiting, state: 'resolved', answer, resolvedAt: at, updatedAt: at };
  db.prepare("UPDATE recovery_waiting SET state = 'resolved', answer = ?, updated_at = ?, json = ? WHERE logical_run_id = ?").run(
    text(answer),
    text(at),
    JSON.stringify(next),
    text(logicalRunId)
  );
  return next;
}

/**
 * Move a run to lifecycle `waiting` because it needs a human answer/approval.
 * This is the **only** supported reason a run enters `waiting`: the transition
 * goes through the store CAS with the caller's `expectedRevision`, and only on a
 * successful transition is the pending input durably recorded.
 *
 * `kind` must be `question` or `approval` (otherwise
 * `RecoveryQueueError('invalid_waiting_input')`). An already-waiting run is
 * idempotent by `requestId`.
 *
 * @param {{
 *   logicalRunId: string,
 *   expectedRevision: number,
 *   kind: 'question'|'approval',
 *   requestId: string,
 *   promptRef?: string,
 *   now?: number|string,
 * }} input
 * @param {object} [store]
 * @returns {{ ok: boolean, applied: boolean, conflict: boolean, reason: string, run: object|null }}
 */
export function markRunWaiting(input, store) {
  const waiting = buildWaitingInput(input);
  try {
    const db = requireQueueDb(store, 'waiting_write_failed');
    const replay = readRequest(db, 'run_waiting', waiting.requestId);
    if (replay) {
      const existingLogicalRunId = text(replay.logical_run_id);
      if (existingLogicalRunId !== waiting.logicalRunId) {
        throw queueError('request_conflict', 'requestId already belongs to a different waiting', {
          requestId: waiting.requestId,
          expectedLogicalRunId: waiting.logicalRunId,
          existingLogicalRunId,
        });
      }
      return {
        ok: true,
        applied: false,
        conflict: false,
        reason: 'already_waiting',
        run: getRun(waiting.logicalRunId, store),
      };
    }

    const result = transitionRun(
      {
        logicalRunId: waiting.logicalRunId,
        expectedRevision: waiting.expectedRevision,
        to: 'waiting',
        patch: {
          waitingRequestId: waiting.requestId,
          waitingKind: waiting.kind,
          waitingPromptRef: waiting.promptRef,
          waitingSince: waiting.at,
        },
      },
      store
    );
    if (!result.ok) {
      return {
        ok: false,
        applied: false,
        conflict: true,
        reason: result.reason,
        run: result.run,
      };
    }

    const record = {
      schemaVersion: RECOVERY_QUEUE_SCHEMA_VERSION,
      logicalRunId: waiting.logicalRunId,
      requestId: waiting.requestId,
      kind: waiting.kind,
      state: 'pending',
      promptRef: waiting.promptRef,
      answer: '',
      createdAt: waiting.at,
      updatedAt: waiting.at,
    };
    withImmediate(db, () => {
      upsertWaitingRow(db, record);
      insertRequestRowIfAbsent(
        db,
        'run_waiting',
        waiting.requestId,
        waiting.logicalRunId,
        '',
        waiting.at,
        { kind: 'run_waiting', logicalRunId: waiting.logicalRunId, waitingKind: waiting.kind }
      );
      // Only `launched` entries are parked: `claimNextQueuedEntry` already
      // skips runs in lifecycle `waiting`, so a never-claimed `queued` entry can
      // stay `queued` and remain claimable after `resolveRunWaiting`.
      const rows = db
        .prepare("SELECT json FROM recovery_queue WHERE logical_run_id = ? AND state = 'launched'")
        .all(waiting.logicalRunId);
      for (const row of rows) {
        updateQueueEntryState(db, JSON.parse(String(row.json)), 'waiting', waiting.at);
      }
    });

    return { ok: true, applied: true, conflict: false, reason: 'applied', run: result.run };
  } catch (err) {
    if (
      isRecoveryQueueError(err) &&
      (err.code === 'invalid_waiting_input' || err.code === 'request_conflict')
    ) {
      throw err;
    }
    throw queueError('waiting_write_failed', `Failed to persist run waiting: ${err?.message || err}`, {
      logicalRunId: waiting.logicalRunId,
      requestId: waiting.requestId,
      cause: String(err?.code || err?.message || err),
    });
  }
}

/**
 * Resolve a pending waiting with an **explicit human answer**: the run returns
 * to `running` and the pending input is cleared (kept as a resolved audit row).
 *
 * Idempotent by `requestId`; a run that is already `running` reports
 * `already_resolved`. This function is the only supported way out of `waiting`
 * and it is never called by an automatic policy from this module.
 *
 * @param {{
 *   logicalRunId: string,
 *   expectedRevision: number,
 *   requestId: string,
 *   answer?: string,
 *   now?: number|string,
 * }} input
 * @param {object} [store]
 * @returns {{ ok: boolean, applied: boolean, conflict: boolean, reason: string, run: object|null }}
 */
export function resolveRunWaiting(input, store) {
  const src = input && typeof input === 'object' ? input : {};
  const invalid = [];
  const logicalRunId = text(src.logicalRunId);
  const requestId = text(src.requestId);
  const revisionNumber = Number(src.expectedRevision);
  if (!isRecoveryId(logicalRunId, 'logical_run')) invalid.push('logicalRunId');
  if (!isRecoveryId(requestId, 'request')) invalid.push('requestId');
  if (!Number.isFinite(revisionNumber) || revisionNumber < 1) invalid.push('expectedRevision');
  if (invalid.length > 0) {
    throw queueError('invalid_waiting_input', `Invalid waiting resolve input: ${invalid.join(', ')}`, {
      fields: invalid,
    });
  }
  const expectedRevision = Math.floor(revisionNumber);
  const answer = src.answer === undefined || src.answer === null ? '' : String(src.answer);
  const at = normalizeNow(src.now);

  try {
    const db = requireQueueDb(store, 'waiting_write_failed');
    const replay = readRequest(db, 'run_waiting_resolve', requestId);
    if (replay) {
      const existingLogicalRunId = text(replay.logical_run_id);
      if (existingLogicalRunId !== logicalRunId) {
        throw queueError('request_conflict', 'requestId already belongs to a different waiting resolve', {
          requestId,
          expectedLogicalRunId: logicalRunId,
          existingLogicalRunId,
        });
      }
      return {
        ok: true,
        applied: false,
        conflict: false,
        reason: 'already_resolved',
        run: getRun(logicalRunId, store),
      };
    }

    const current = readRunJson(db, logicalRunId);
    if (!current) {
      throw queueError('invalid_waiting_input', 'Logical run not found for waiting resolve', {
        cause: 'run_not_found',
        logicalRunId,
      });
    }
    if (text(current.state) !== 'waiting') {
      if (text(current.state) === 'running') {
        return { ok: true, applied: false, conflict: false, reason: 'already_resolved', run: current };
      }
      return { ok: false, applied: false, conflict: true, reason: 'not_waiting', run: current };
    }

    const result = transitionRun(
      {
        logicalRunId,
        expectedRevision,
        to: 'running',
        patch: {
          waitingResolvedRequestId: requestId,
          waitingAnswer: answer,
          waitingResolvedAt: at,
        },
      },
      store
    );
    if (!result.ok) {
      return { ok: false, applied: false, conflict: true, reason: result.reason, run: result.run };
    }

    withImmediate(db, () => {
      resolveWaitingRow(db, logicalRunId, answer, at);
      insertRequestRowIfAbsent(
        db,
        'run_waiting_resolve',
        requestId,
        logicalRunId,
        '',
        at,
        { kind: 'run_waiting_resolve', logicalRunId, answer }
      );
      // Un-park only entries that were `launched` before the question (`queued`
      // entries were never parked).
      const rows = db
        .prepare("SELECT json FROM recovery_queue WHERE logical_run_id = ? AND state = 'waiting'")
        .all(logicalRunId);
      for (const row of rows) {
        updateQueueEntryState(db, JSON.parse(String(row.json)), 'launched', at);
      }
    });

    return { ok: true, applied: true, conflict: false, reason: 'applied', run: result.run };
  } catch (err) {
    if (
      isRecoveryQueueError(err) &&
      (err.code === 'invalid_waiting_input' || err.code === 'request_conflict')
    ) {
      throw err;
    }
    throw queueError('waiting_write_failed', `Failed to persist waiting resolve: ${err?.message || err}`, {
      logicalRunId,
      requestId,
      cause: String(err?.code || err?.message || err),
    });
  }
}

/**
 * List pending waiting records. Filters: `family`, `workspaceFolder`, `chatId`,
 * `kind`, `limit`. Each record carries the joined run `family`, `owner` and
 * `runState` for display.
 *
 * @param {object} [options]
 * @param {object} [store]
 * @returns {object[]}
 */
export function listWaitingRuns(options = {}, store) {
  const opts = options && typeof options === 'object' ? options : {};
  const db = requireQueueDb(store, 'store_unavailable');
  const where = ["r.state = 'waiting'"];
  const params = [];
  if (opts.family !== undefined && opts.family !== null && opts.family !== '') {
    const family = text(opts.family).toLowerCase();
    if (!ownerOfRunFamily(family)) return [];
    where.push('r.family = ?');
    params.push(family);
  }
  if (opts.workspaceFolder !== undefined && opts.workspaceFolder !== null) {
    where.push('r.workspace_folder = ?');
    params.push(text(opts.workspaceFolder));
  }
  if (opts.chatId !== undefined && opts.chatId !== null) {
    where.push('r.chat_id = ?');
    params.push(text(opts.chatId));
  }
  const kindFilter =
    opts.kind !== undefined && opts.kind !== null && opts.kind !== ''
      ? text(opts.kind).toLowerCase()
      : '';
  if (kindFilter && !RECOVERY_QUEUE_WAITING_KINDS.includes(kindFilter)) return [];
  const limit = normalizeLimit(opts.limit, 100);
  const rows = db
    .prepare(`
      SELECT r.json AS run_json, w.json AS waiting_json, w.created_at AS waiting_created_at
      FROM recovery_runs r
      LEFT JOIN recovery_waiting w ON w.logical_run_id = r.logical_run_id AND w.state = 'pending'
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(w.created_at, json_extract(r.json, '$.waitingSince'), r.updated_at) ASC, r.rowid ASC
      LIMIT ?
    `)
    .all(...params, limit);
  const out = [];
  for (const row of rows) {
    const run = JSON.parse(String(row.run_json));
    const waiting = row.waiting_json
      ? JSON.parse(String(row.waiting_json))
      : synthesizeWaitingFromRun(run);
    if (!waiting) continue;
    if (kindFilter && text(waiting.kind).toLowerCase() !== kindFilter) continue;
    out.push({
      ...waiting,
      family: text(run.family),
      owner: text(run.owner),
      runState: 'waiting',
    });
  }
  return out;
}

/**
 * Read the pending waiting record for one run, or null.
 *
 * @param {string} logicalRunId
 * @param {object} [store]
 * @returns {object|null}
 */
export function getRunWaiting(logicalRunId, store) {
  const id = text(logicalRunId);
  if (!id) return null;
  const db = requireQueueDb(store, 'store_unavailable');
  const row = readWaitingJson(db, id);
  if (row) return row;
  const run = readRunJson(db, id);
  return synthesizeWaitingFromRun(run);
}

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------

/**
 * Deterministic decision for one queue entry. It never launches a run that is
 * (or whose entry is) waiting/cancelled, and it never auto-answers a question or
 * approval.
 *
 * - cancelled entry or cancelled run -> `skip`, automatic `false`;
 * - run lifecycle `waiting` -> `manual_only`, automatic `false` (never
 *   auto-answered);
 * - entry `waiting` -> `manual_only`, automatic `false`;
 * - entry `queued` with a present, non-waiting, non-cancelled run ->
 *   `launch`, automatic `true`;
 * - anything else (missing run/entry, `launched`) -> `skip`, automatic `false`.
 *
 * @param {object|null|undefined} entry
 * @param {object|null|undefined} [run]
 * @returns {{ action: 'launch'|'manual_only'|'skip', automatic: boolean, rationale: string }}
 */
export function resolveQueueEntryAction(entry, run) {
  if (!entry || typeof entry !== 'object') {
    return { action: 'skip', automatic: false, rationale: 'Brak wpisu kolejki; nie ma czego uruchamiac.' };
  }
  const entryState = normalizeQueueEntryState(entry.state);
  const runState = normalizeRunLifecycleState(run?.state);

  if (entryState === 'cancelled' || runState === 'cancelled') {
    return {
      action: 'skip',
      automatic: false,
      rationale: 'Run lub wpis anulowany trwale; Stop zakazuje wznowienia.',
    };
  }
  if (runState === 'waiting' || entryState === 'waiting') {
    return {
      action: 'manual_only',
      automatic: false,
      rationale: 'Run oczekuje na pytanie/zgode; odpowiedz wylacznie czlowiek, brak auto-odpowiedzi.',
    };
  }
  if (entryState === 'queued' && run && typeof run === 'object') {
    return {
      action: 'launch',
      automatic: true,
      rationale: 'Wpis oczekujacy i run nie jest waiting/cancelled; bezpieczny automatyczny start.',
    };
  }
  return {
    action: 'skip',
    automatic: false,
    rationale: 'Wpis nie jest w stanie queued albo brak runu; brak akcji automatycznej.',
  };
}
