/**
 * Command receipts, idempotent replay and durable ACK (A2 S4, protocol:
 * lib/storage/receipts.md, contract: docs/storage-contract.md "History
 * operations and acknowledgements").
 *
 * A receipt `(dataset_generation, command_id, request_digest, result_json)` is
 * written by `withReceipt()` inside the worker's BEGIN IMMEDIATE transaction,
 * in the same transaction as the handler's mutation, so both commit or neither
 * does. The host-side `executeCommand()` resolves only after the worker
 * replied with success, i.e. after COMMIT (durable ACK). After
 * `unknown_commit` the caller reconciles with `resolveUnknown()` before any
 * retry.
 *
 * This module is loaded on both threads: the worker uses `withReceipt` and
 * `RECEIPT_QUERIES` from a handler registry, the host uses `executeCommand` /
 * `resolveUnknown`. Its only state is the host-side, process-local memory of
 * non-reconcilable outcomes (see `rememberUnreconcilable`).
 */
import { createHash } from 'node:crypto';
import { isStorageError, StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { assertWriteAllowed } from './maintenance-coordinator.js';
import { COMMAND_ID_PATTERN, HANDLER_NAME_PATTERN, toWireJson } from './worker-wire.js';

/** Envelope version sent from `executeCommand` to `withReceipt`. */
export const RECEIPT_ENVELOPE_VERSION = 1;
/**
 * Domain-separation prefix of the request digest. Changing the scheme or the
 * canonicalization needs a new version here AND dual-read of receipts stored
 * under the old one (otherwise a retry across the change misses its receipt
 * and applies twice); tests pin golden digests of this version.
 */
const DIGEST_SCHEME = 'cretli-storage-receipt-v1';
/** Function kinds `withReceipt` refuses: their body does not run synchronously. */
const NON_SYNC_FUNCTION_KINDS = new Set(['AsyncFunction', 'AsyncGeneratorFunction', 'GeneratorFunction']);
/** Upper bound of remembered non-reconcilable commands per host. */
const MAX_UNRECONCILABLE_PER_HOST = 4096;
/** @type {WeakMap<object, Set<string>>} */
const unreconcilableByHost = new WeakMap();
/** Query every receipt-enabled handler registry must expose (see RECEIPT_QUERIES). */
export const RECEIPT_LOOKUP_QUERY = 'storage.receipt.lookup';
/**
 * Default cap for a stored result. Receipts are kept for at least the retry
 * window (retention is A3a), so results stay small; larger results roll back.
 */
export const DEFAULT_RECEIPT_MAX_RESULT_BYTES = 256 * 1024;
/**
 * Dataset generations share the commandId alphabet: short, no path
 * separators, so they survive the StorageError detail sanitizer.
 */
export const DATASET_GENERATION_PATTERN = COMMAND_ID_PATTERN;
/**
 * Marker set on every `withReceipt` wrapper (F30). The worker refuses a
 * receipt request (`requireReceipt`) addressed to a handler without it before
 * any transaction starts, so `receipt_missing` is prevented, not only
 * detected after a commit. `Symbol.for` so the worker and the host agree.
 */
export const RECEIPT_HANDLER_MARK = Symbol.for('cretli.storage.receiptHandler');

const SELECT_RECEIPT_SQL = `SELECT request_digest, result_json, created_at FROM command_receipts
WHERE dataset_generation = ? AND command_id = ?`;
const INSERT_RECEIPT_SQL = `INSERT INTO command_receipts
(dataset_generation, command_id, request_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?)`;

/**
 * @param {string} message
 * @param {string} operation
 * @param {{ commandId?: string | null, commitState?: string, reconcilable?: boolean, cause?: unknown }} [extra]
 * @returns {StorageError}
 */
function invalidReceiptRequest(message, operation, extra = {}) {
  /** @type {Record<string, unknown>} */
  const details = { operation, commitState: extra.commitState ?? 'not_committed' };
  if (extra.commandId) details.commandId = extra.commandId;
  if (extra.reconcilable === false) details.reconcilable = false;
  return new StorageError(STORAGE_ERROR_CODES.IO, message, { cause: extra.cause, retryable: false, details });
}

/**
 * @param {string | null} commandId
 * @param {string} operation
 * @returns {StorageError}
 */
function digestMismatch(commandId, operation) {
  /** @type {Record<string, unknown>} */
  const details = { operation, conflictKind: 'receipt_digest_mismatch', commitState: 'not_committed' };
  if (commandId) details.commandId = commandId;
  return new StorageError(STORAGE_ERROR_CODES.CONFLICT, 'commandId was already committed with another request digest', {
    retryable: false,
    details,
  });
}

/**
 * Typed refusal to reconcile or retry a command whose outcome cannot be
 * decided from the receipt (`handler_transaction`, `receipt_missing`). The
 * caller must escalate (operator / repair), never retry.
 *
 * @param {string} commandId
 * @returns {StorageError}
 */
function notReconcilable(commandId) {
  return new StorageError(STORAGE_ERROR_CODES.UNKNOWN_COMMIT, 'Command outcome cannot be reconciled through its receipt', {
    retryable: false,
    details: { operation: 'not_reconcilable', commitState: 'unknown', reconcilable: false, commandId },
  });
}

/**
 * @param {string} datasetGeneration
 * @param {string} commandId
 * @returns {string}
 */
function commandKey(datasetGeneration, commandId) {
  return `${datasetGeneration}\0${commandId}`;
}

/**
 * Remember (per host object, in this process only) that a command ended
 * non-reconcilable, so a later `resolveUnknown` / `executeCommand` with the
 * same identity refuses instead of answering `not_committed` or re-running.
 * The memory is bounded and does not survive a restart: callers persisting
 * pending work must persist `reconcilable: false` with it (receipts.md).
 *
 * @param {object} host
 * @param {string} key
 */
function rememberUnreconcilable(host, key) {
  let set = unreconcilableByHost.get(host);
  if (!set) {
    set = new Set();
    unreconcilableByHost.set(host, set);
  }
  if (set.size >= MAX_UNRECONCILABLE_PER_HOST) set.delete(set.values().next().value);
  set.add(key);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnreconcilableError(err) {
  return isStorageError(err) && /** @type {StorageError} */ (err).details?.reconcilable === false;
}

/**
 * Serialize already-normalized JSON data with object keys sorted by UTF-16
 * code unit order (Array.prototype.sort default) at every level.
 *
 * @param {unknown} value
 * @returns {string}
 */
function serializeSorted(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeSorted).join(',')}]`;
  const obj = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serializeSorted(obj[k])}`).join(',')}}`;
}

/**
 * Canonical JSON text of a payload. The value first goes through the strict
 * wire serializer and back (so `undefined` members vanish, `-0` becomes `0`
 * and non-JSON values are refused exactly as on the wire), then objects are
 * re-serialized with sorted keys. The host and the worker therefore compute
 * the same text for the same logical payload, whatever its key order.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return serializeSorted(JSON.parse(toWireJson(value).json));
}

/**
 * Stable request digest: `sha256:<hex>` of
 * `cretli-storage-receipt-v1 \0 commandName \0 canonicalJson(payload)`.
 * Key order does not matter; any change of a value, of array order or of the
 * command name changes the digest. Throws TypeError for an invalid name or a
 * payload that is not plain JSON.
 *
 * @param {string} commandName
 * @param {unknown} payload Parsed payload (plain JSON data).
 * @returns {string}
 */
export function computeRequestDigest(commandName, payload) {
  return digestCanonical(commandName, () => canonicalJson(payload));
}

/**
 * @param {string} commandName
 * @param {() => string} canonicalize
 * @returns {string}
 */
function digestCanonical(commandName, canonicalize) {
  if (typeof commandName !== 'string' || !HANDLER_NAME_PATTERN.test(commandName)) {
    throw new TypeError('Receipt digest needs a valid command name');
  }
  const hash = createHash('sha256').update(`${DIGEST_SCHEME}\0${commandName}\0${canonicalize()}`, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Digest of a payload that was itself parsed from wire JSON (the worker's
 * view): it is already normalized, so the serialize + parse round trip of
 * `canonicalJson` is skipped. Equal to `computeRequestDigest` for such input.
 *
 * @param {string} commandName
 * @param {unknown} parsedPayload
 * @returns {string}
 */
function digestParsedPayload(commandName, parsedPayload) {
  return digestCanonical(commandName, () => serializeSorted(parsedPayload === undefined ? null : parsedPayload));
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isDatasetGeneration(value) {
  return typeof value === 'string' && DATASET_GENERATION_PATTERN.test(value);
}

/**
 * @param {unknown} envelope
 * @param {string | null} commandId
 * @returns {{ datasetGeneration: string, requestDigest: string, payload: unknown }}
 */
function readEnvelope(envelope, commandId) {
  const env = /** @type {Record<string, any>} */ (envelope);
  const receipt = env && typeof env === 'object' ? env.receipt : null;
  if (!receipt || typeof receipt !== 'object' || receipt.v !== RECEIPT_ENVELOPE_VERSION
    || !isDatasetGeneration(receipt.datasetGeneration) || typeof receipt.requestDigest !== 'string') {
    throw invalidReceiptRequest('Receipt command needs an executeCommand envelope', 'receipt_envelope', { commandId });
  }
  return { datasetGeneration: receipt.datasetGeneration, requestDigest: receipt.requestDigest, payload: env.payload };
}

/**
 * Wrap a synchronous command handler so it runs at most once per
 * `(datasetGeneration, commandId)`. Runs inside the worker's already-open
 * BEGIN IMMEDIATE transaction:
 *
 * 1. recompute the digest from `ctx.name` + payload and require it to match
 *    the digest the host sent;
 * 2. SELECT the receipt: same digest => return the stored result without
 *    running the handler (`replayed: true`); different digest => `conflict`
 *    (`conflictKind: receipt_digest_mismatch`), decided by comparison, never
 *    by catching a constraint error;
 * 3. run the handler, cap its result, INSERT the receipt in the same
 *    transaction. A handler error rolls everything back: no receipt.
 *
 * The returned object is what `executeCommand` unwraps:
 * `{ receiptVersion, commandId, replayed, result }`.
 *
 * @param {(ctx: any, payload: any) => unknown} handlerFn synchronous handler
 * @param {{ maxResultBytes?: number }} [options]
 * @returns {(ctx: any, envelope: unknown) => { receiptVersion: number, commandId: string, replayed: boolean, result: unknown }}
 */
export function withReceipt(handlerFn, options = {}) {
  if (typeof handlerFn !== 'function') throw new TypeError('withReceipt needs a handler function');
  if (NON_SYNC_FUNCTION_KINDS.has(handlerFn.constructor?.name)) throw new TypeError('withReceipt handlers must be synchronous');
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_RECEIPT_MAX_RESULT_BYTES;
  if (!Number.isFinite(maxResultBytes) || maxResultBytes <= 0) throw new TypeError('withReceipt maxResultBytes must be positive');
  const receiptHandler = function receiptHandler(ctx, envelope) {
    const commandId = typeof ctx?.commandId === 'string' ? ctx.commandId : null;
    if (!commandId) throw invalidReceiptRequest('Receipt command needs a commandId', 'receipt_command_id');
    const { datasetGeneration, requestDigest, payload } = readEnvelope(envelope, commandId);
    if (digestParsedPayload(ctx.name, payload) !== requestDigest) {
      throw invalidReceiptRequest('Receipt digest does not match the payload', 'receipt_digest_invalid', { commandId });
    }
    const existing = /** @type {Record<string, any> | undefined} */ (
      ctx.prepare(SELECT_RECEIPT_SQL).get(datasetGeneration, commandId)
    );
    if (existing) {
      if (existing.request_digest !== requestDigest) throw digestMismatch(commandId, 'receipt');
      return { receiptVersion: RECEIPT_ENVELOPE_VERSION, commandId, replayed: true, result: JSON.parse(existing.result_json) };
    }
    const result = handlerFn(ctx, payload);
    if (result && typeof /** @type {any} */ (result).then === 'function') {
      throw invalidReceiptRequest('Storage handlers must be synchronous', 'handler_async', { commandId });
    }
    // A handler that ended the transaction itself is reported by the worker
    // as unknown_commit; never write the receipt in autocommit mode.
    if (!ctx.db.isTransaction) {
      throw invalidReceiptRequest('Handler ended the transaction', 'handler_transaction', {
        commandId,
        commitState: 'unknown',
        reconcilable: false,
      });
    }
    let wire;
    try {
      wire = toWireJson(result);
    } catch (err) {
      throw invalidReceiptRequest('Storage handler result is not plain JSON', 'result_invalid', { commandId, cause: err });
    }
    if (wire.bytes > maxResultBytes) {
      throw invalidReceiptRequest('Receipt result exceeds the size limit', 'result_too_large', { commandId });
    }
    ctx.prepare(INSERT_RECEIPT_SQL).run(datasetGeneration, commandId, requestDigest, wire.json, Date.now());
    return { receiptVersion: RECEIPT_ENVELOPE_VERSION, commandId, replayed: false, result: JSON.parse(wire.json) };
  };
  Object.defineProperty(receiptHandler, RECEIPT_HANDLER_MARK, { value: true });
  return receiptHandler;
}

/**
 * True for a handler produced by `withReceipt`.
 *
 * @param {unknown} fn
 * @returns {boolean}
 */
export function isReceiptHandler(fn) {
  return typeof fn === 'function' && /** @type {any} */ (fn)[RECEIPT_HANDLER_MARK] === true;
}

/**
 * Read-only receipt lookup used by `resolveUnknown`. Returns the stored row
 * (digest + result JSON text) or null; the digest comparison happens on the
 * host so a mismatch is reported to the caller who knows the payload.
 *
 * @param {any} ctx
 * @param {{ datasetGeneration?: unknown }} payload
 * @returns {{ requestDigest: string, resultJson: string, createdAt: number } | null}
 */
function lookupReceipt(ctx, payload) {
  const commandId = typeof ctx?.commandId === 'string' ? ctx.commandId : null;
  if (!commandId || !isDatasetGeneration(payload?.datasetGeneration)) {
    throw invalidReceiptRequest('Receipt lookup needs a commandId and a dataset generation', 'receipt_lookup', { commandId });
  }
  const row = /** @type {Record<string, any> | undefined} */ (
    ctx.prepare(SELECT_RECEIPT_SQL).get(payload.datasetGeneration, commandId)
  );
  if (!row) return null;
  return { requestDigest: row.request_digest, resultJson: row.result_json, createdAt: Number(row.created_at) };
}

/**
 * Query handlers a receipt-enabled registry spreads into its `queries`
 * (`queries: { ...RECEIPT_QUERIES, ... }`); `resolveUnknown` needs them.
 */
export const RECEIPT_QUERIES = Object.freeze({ [RECEIPT_LOOKUP_QUERY]: lookupReceipt });

/**
 * @param {Record<string, any>} args
 * @param {string} operation
 * @returns {{ datasetGeneration: string, commandId: string, name: string, requestDigest: string }}
 */
function validateCommandArgs(args, operation) {
  if (!args || typeof args !== 'object') throw invalidReceiptRequest('Receipt arguments must be an object', operation);
  const { datasetGeneration, commandId, name, payload } = args;
  if (typeof commandId !== 'string' || !COMMAND_ID_PATTERN.test(commandId)) {
    throw invalidReceiptRequest('Receipt command needs a valid commandId', operation);
  }
  if (!isDatasetGeneration(datasetGeneration)) {
    throw invalidReceiptRequest('Receipt command needs a valid dataset generation', operation, { commandId });
  }
  if (typeof name !== 'string' || !HANDLER_NAME_PATTERN.test(name)) {
    throw invalidReceiptRequest('Receipt command needs a valid handler name', operation, { commandId });
  }
  let requestDigest;
  try {
    requestDigest = computeRequestDigest(name, payload);
  } catch (err) {
    throw invalidReceiptRequest('Storage payload is not plain JSON', 'payload_invalid', { commandId, cause: err });
  }
  return { datasetGeneration, commandId, name, requestDigest };
}

/**
 * Validate a receipt command and build its envelope (shared by
 * `executeCommand` and the group committer). Refuses with `not_reconcilable`
 * when this host already reported a non-reconcilable outcome for it.
 *
 * @param {object} host
 * @param {Record<string, any>} args
 * @returns {{ key: string, commandId: string, name: string, envelope: object }}
 */
export function prepareReceiptCommand(host, args) {
  const { datasetGeneration, commandId, name, requestDigest } = validateCommandArgs(args, 'invalid_request');
  const key = commandKey(datasetGeneration, commandId);
  if (unreconcilableByHost.get(host)?.has(key)) throw notReconcilable(commandId);
  const envelope = { receipt: { v: RECEIPT_ENVELOPE_VERSION, datasetGeneration, requestDigest }, payload: args.payload };
  return { key, commandId, name, envelope };
}

/**
 * Record a rejection of a prepared receipt command: a non-reconcilable one is
 * remembered for this host. Returns `err` unchanged.
 *
 * @param {object} host
 * @param {string} key from `prepareReceiptCommand`
 * @param {unknown} err
 * @returns {unknown}
 */
export function noteReceiptFailure(host, key, err) {
  if (isUnreconcilableError(err)) rememberUnreconcilable(host, key);
  return err;
}

/**
 * Unwrap a worker reply of a prepared receipt command. A reply that is not a
 * receipt reply is `receipt_missing` (non-reconcilable, remembered).
 *
 * @param {object} host
 * @param {{ key: string, commandId: string }} prepared
 * @param {unknown} rawReply
 * @returns {{ result: unknown, replayed: boolean }}
 */
export function readReceiptReply(host, prepared, rawReply) {
  const reply = /** @type {Record<string, any>} */ (rawReply);
  if (!reply || reply.receiptVersion !== RECEIPT_ENVELOPE_VERSION || reply.commandId !== prepared.commandId
    || typeof reply.replayed !== 'boolean') {
    // The handler committed without the receipt wrapper: a registry bug, not
    // something a retry can fix, and the absence of a receipt proves nothing.
    // The worker refuses unmarked handlers before BEGIN (F30), so this is
    // only reachable with a forged marker or a broken worker.
    rememberUnreconcilable(host, prepared.key);
    throw invalidReceiptRequest('Command handler is not receipt-wrapped', 'receipt_missing', {
      commandId: prepared.commandId,
      commitState: 'unknown',
      reconcilable: false,
    });
  }
  return { result: reply.result, replayed: reply.replayed };
}

/**
 * Run a receipt-wrapped command. Resolves with `{ result, replayed }` only
 * after the worker replied with success, which it posts after COMMIT: that is
 * the durable ACK. A storage rejection carries `details.commitState` (an
 * abort before dispatch rejects with the caller's `signal.reason`); on
 * `unknown_commit` call `resolveUnknown` with the same arguments before any
 * retry, unless `details.reconcilable === false`: then escalate, never retry
 * (lib/storage/receipts.md). Refuses with `not_reconcilable` when this host
 * already reported such an outcome for the same command. The request is sent
 * with `requireReceipt`, so the worker refuses a handler that is not
 * receipt-wrapped before its transaction starts (`receipt_required`).
 *
 * @param {{ command: Function }} host storage worker host
 * @param {{
 *   datasetGeneration: string,
 *   commandId: string,
 *   name: string,
 *   payload: unknown,
 *   priority?: string,
 *   deadlineMs?: number,
 *   signal?: AbortSignal,
 *   writeGate?: { controlDir: string, registry: import('./maintenance-coordinator.js').WriteGateRegistry, writerId: string, fence: number } | typeof import('./maintenance-coordinator.js').WRITE_GATE_TEST_EXEMPTION,
 * }} args `commandId` must be created before dispatch and kept across retries.
 * @returns {Promise<{ result: unknown, replayed: boolean }>}
 */
export async function executeCommand(host, args) {
  // Write gate (per call or set on the host): restore pause, registered writer and fence are checked
  // before dispatch, so a refused write never reaches the database.
  const writeGate = args.writeGate ?? /** @type {any} */ (host).writeGate;
  assertWriteAllowed(writeGate);
  const prepared = prepareReceiptCommand(host, args);
  let reply;
  try {
    reply = await host.command(prepared.name, prepared.envelope, {
      commandId: prepared.commandId,
      priority: args.priority,
      deadlineMs: args.deadlineMs,
      signal: args.signal,
      requireReceipt: true,
    });
  } catch (err) {
    throw noteReceiptFailure(host, prepared.key, err);
  }
  return readReceiptReply(host, prepared, reply);
}

/**
 * Reconcile a command whose outcome is unknown (`unknown_commit`). Issues a
 * read-only query for the receipt of `(datasetGeneration, commandId)`:
 *
 * - receipt with the same digest => `{ outcome: 'committed', result }`; do
 *   not run the command again (a retry would only replay this result);
 * - receipt with another digest => rejects with `conflict`
 *   (`conflictKind: receipt_digest_mismatch`);
 * - no receipt => `{ outcome: 'not_committed' }`; retrying `executeCommand`
 *   with the SAME commandId and payload is safe.
 *
 * The query waits behind the host restart like any request, so it reads the
 * state after the lost (or recycled) worker exited.
 *
 * Refuses with `unknown_commit` / `not_reconcilable` (`reconcilable: false`)
 * instead of answering when `args.error` is the non-reconcilable rejection
 * being reconciled, or this host already reported one for this command
 * (`handler_transaction`, `receipt_missing`): a missing receipt does not
 * prove `not_committed` there. Pass the rejection as `args.error`.
 *
 * @param {{ query: Function }} host
 * @param {{ datasetGeneration: string, commandId: string, name: string, payload: unknown, error?: unknown, priority?: string, signal?: AbortSignal }} args
 * @returns {Promise<{ outcome: 'committed', result: unknown } | { outcome: 'not_committed' }>}
 */
export async function resolveUnknown(host, args) {
  const { datasetGeneration, commandId, requestDigest } = validateCommandArgs(args, 'invalid_request');
  const key = commandKey(datasetGeneration, commandId);
  if (isUnreconcilableError(args.error)) rememberUnreconcilable(host, key);
  if (unreconcilableByHost.get(host)?.has(key)) throw notReconcilable(commandId);
  const row = /** @type {Record<string, any> | null} */ (await host.query(RECEIPT_LOOKUP_QUERY, { datasetGeneration }, {
    commandId,
    priority: args.priority,
    signal: args.signal,
  }));
  if (row === null) return { outcome: 'not_committed' };
  if (!row || typeof row.requestDigest !== 'string' || typeof row.resultJson !== 'string') {
    throw invalidReceiptRequest('Receipt lookup returned a malformed row', 'receipt_lookup', { commandId });
  }
  if (row.requestDigest !== requestDigest) throw digestMismatch(commandId, 'receipt_resolve');
  return { outcome: 'committed', result: JSON.parse(row.resultJson) };
}
