/**
 * Group commit of receipt commands (A2 S5, semantics: lib/storage/group-commit.md).
 *
 * Main-thread collector on top of the storage worker host. Receipt commands
 * submitted here are buffered and sent as ONE `batch` request, which the
 * worker runs in one BEGIN IMMEDIATE transaction: every member in its own
 * worker-level savepoint, with its own command receipt, then one COMMIT. A
 * member's promise resolves only after that COMMIT (durable ACK).
 *
 * Flush triggers: the buffer fills a batch (`maxBatchBytes`, 256 KiB, or
 * `maxBatchCount` members), the oldest member waited `windowMs` (40 ms), a
 * member of a priority class (stop / claim / intent / final: flushed at once,
 * never held for the window), `flush()` or `close()`.
 *
 * Two lanes: the main lane carries any member; while it is busy, priority
 * members go out at once as a priority-only batch on the priority lane, so
 * they never wait behind a normal batch (the host queue then runs that batch
 * ahead of normal traffic). Nothing is held locked across an `await` and there
 * is no synchronous facade. The clock and the timer functions are injectable
 * for tests.
 */
import { performance } from 'node:perf_hooks';
import { fromJSON, isStorageError, StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { STORAGE_PRIORITIES } from './fair-queue.js';
import { noteReceiptFailure, prepareReceiptCommand, readReceiptReply } from './command-receipts.js';
import { assertWriteAllowed } from './maintenance-coordinator.js';
import { toWireJson } from './worker-wire.js';

/** Upper bound of one batch request text (JSON bytes, frame included). */
export const DEFAULT_GROUP_MAX_BATCH_BYTES = 256 * 1024;
/** Flush when the oldest buffered member waited this long. */
export const DEFAULT_GROUP_WINDOW_MS = 40;
/** Members per batch transaction. */
export const DEFAULT_GROUP_MAX_BATCH_COUNT = 256;
/** Bytes of the batch frame `{"members":[]}` around the member entries. */
export const GROUP_BATCH_FRAME_BYTES = Buffer.byteLength('{"members":[]}');
/** Backpressure: buffered plus in-flight member bytes. */
export const DEFAULT_GROUP_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Backpressure: buffered plus in-flight members. */
export const DEFAULT_GROUP_MAX_BUFFERED_COUNT = 4096;
/** Dispatch attempts of a member after retryable `not_committed` batch failures. */
export const DEFAULT_GROUP_MAX_FLUSH_ATTEMPTS = 4;
/** First retry delay after a failed flush; doubles per attempt. */
export const DEFAULT_GROUP_RETRY_DELAY_MS = 25;
/** A normal member waiting this long is no longer placed behind priority members. */
export const DEFAULT_GROUP_MAX_NORMAL_WAIT_MS = 200;
export const DEFAULT_GROUP_CLOSE_TIMEOUT_MS = 5000;
/** Classes that flush at once (worker-protocol.md "Queue and priorities"). */
export const GROUP_IMMEDIATE_PRIORITIES = Object.freeze(['stop', 'claim', 'intent', 'final']);

const IMMEDIATE = new Set(GROUP_IMMEDIATE_PRIORITIES);

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ operation: string, commitState: 'not_committed' | 'unknown', retryable?: boolean, commandId?: string | null }} info
 * @returns {StorageError}
 */
function groupError(code, message, info) {
  /** @type {Record<string, unknown>} */
  const details = { operation: info.operation, commitState: info.commitState };
  if (info.commandId) details.commandId = info.commandId;
  return new StorageError(code, message, { retryable: info.retryable, details });
}

/**
 * @param {string | null} [commandId]
 * @returns {StorageError}
 */
function malformedReply(commandId = null) {
  return groupError(STORAGE_ERROR_CODES.UNKNOWN_COMMIT, 'Malformed storage batch reply', {
    operation: 'response', commitState: 'unknown', commandId,
  });
}

/**
 * A batch rejection as a StorageError. A plain object of the serialized
 * shape is revived (its details may be missing); anything else, including a
 * revived error without `commitState`, ends up `unknown`.
 *
 * @param {unknown} err
 * @returns {StorageError}
 */
function toBatchError(err) {
  if (err instanceof StorageError) return err;
  const revived = isStorageError(err) ? fromJSON(err) : null;
  return revived || groupError(STORAGE_ERROR_CODES.UNKNOWN_COMMIT, 'Storage batch failed', { operation: 'batch', commitState: 'unknown' });
}

/**
 * Copy of `err` for one member: its own commandId and the given commit state.
 * `reconcilable: false` is dropped unless `keepReconcilable` (it belongs to
 * the member that ended the transaction, not to members whose receipts were
 * written in the same transaction as their mutations).
 *
 * @param {StorageError} err
 * @param {string} commandId
 * @param {'not_committed' | 'unknown'} commitState
 * @param {boolean} [keepReconcilable]
 * @returns {StorageError}
 */
function forMember(err, commandId, commitState, keepReconcilable = false) {
  const details = { ...err.details, commitState, commandId };
  if (!keepReconcilable) delete /** @type {any} */ (details).reconcilable;
  const code = commitState === 'unknown' ? STORAGE_ERROR_CODES.UNKNOWN_COMMIT : err.code;
  const retryable = commitState === 'unknown' ? false : err.retryable;
  return new StorageError(code, err.message, { cause: err, retryable, details });
}

/**
 * Shape of one member entry of a batch reply: `ok` (ran, result attached),
 * `notRun`, `failed` (own error attached) or `malformed`.
 *
 * @param {unknown} entry
 * @returns {'ok' | 'notRun' | 'failed' | 'malformed'}
 */
function entryKind(entry) {
  const o = /** @type {Record<string, any>} */ (entry);
  if (!o || typeof o !== 'object') return 'malformed';
  if (o.ok === true) return typeof o.resultJson === 'string' ? 'ok' : 'malformed';
  if (o.ok !== false) return 'malformed';
  if (o.notRun === true) return 'notRun';
  return fromJSON(o.error) ? 'failed' : 'malformed';
}

/**
 * Batch entry bytes of a member: `{"name":…,"commandId":…,"payload":<snapshot>}`
 * plus the separating comma.
 *
 * @param {string} name
 * @param {string} commandId
 * @param {number} snapshotBytes
 * @returns {number}
 */
function entryBytes(name, commandId, snapshotBytes) {
  return Buffer.byteLength(`{"name":${JSON.stringify(name)},"commandId":${JSON.stringify(commandId)},"payload":},`) + snapshotBytes;
}

/**
 * @typedef {{
 *   prepared: ReturnType<typeof prepareReceiptCommand>,
 *   json: string,
 *   bytes: number,
 *   priority: string,
 *   submittedAt: number,
 *   attempts: number,
 *   deferred: boolean,
 *   settled: boolean,
 *   done: boolean,
 *   resolve: (v: { result: unknown, replayed: boolean }) => void,
 *   reject: (e: unknown) => void,
 * }} GroupMember
 */

/**
 * @typedef {{ members: GroupMember[], backoff: boolean }} Requeue
 */

/**
 * @param {{
 *   host: { commandBatch: Function },
 *   maxBatchBytes?: number,
 *   windowMs?: number,
 *   maxBatchCount?: number,
 *   maxMemberBytes?: number,
 *   maxBufferedBytes?: number,
 *   maxBufferedCount?: number,
 *   maxFlushAttempts?: number,
 *   retryDelayMs?: number,
 *   maxNormalWaitMs?: number,
 *   deadlineMs?: number,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   writeGate?: { controlDir: string, registry: import('./maintenance-coordinator.js').WriteGateRegistry, writerId: string, fence: number } | typeof import('./maintenance-coordinator.js').WRITE_GATE_TEST_EXEMPTION,
 * }} options `now` / `setTimer` / `clearTimer` are test seams (defaults: monotonic performance.now, unref'd setTimeout).
 */
export function createGroupCommitter(options) {
  const host = options?.host;
  if (!host || typeof host.commandBatch !== 'function') throw new TypeError('createGroupCommitter needs a storage host');
  const maxBatchBytes = positiveNumber(options.maxBatchBytes, 'maxBatchBytes', DEFAULT_GROUP_MAX_BATCH_BYTES);
  if (maxBatchBytes <= GROUP_BATCH_FRAME_BYTES) throw new TypeError('maxBatchBytes is smaller than the batch frame');
  /** Member entry bytes that fit in one batch next to the frame. */
  const batchEntryLimit = maxBatchBytes - GROUP_BATCH_FRAME_BYTES;
  const windowMs = positiveNumber(options.windowMs, 'windowMs', DEFAULT_GROUP_WINDOW_MS);
  const maxBatchCount = positiveNumber(options.maxBatchCount, 'maxBatchCount', DEFAULT_GROUP_MAX_BATCH_COUNT);
  // Default: every member fits in one batch, so no batch exceeds maxBatchBytes.
  const maxMemberBytes = positiveNumber(options.maxMemberBytes, 'maxMemberBytes', batchEntryLimit);
  const maxBufferedBytes = positiveNumber(options.maxBufferedBytes, 'maxBufferedBytes', DEFAULT_GROUP_MAX_BUFFERED_BYTES);
  const maxBufferedCount = positiveNumber(options.maxBufferedCount, 'maxBufferedCount', DEFAULT_GROUP_MAX_BUFFERED_COUNT);
  const maxFlushAttempts = positiveNumber(options.maxFlushAttempts, 'maxFlushAttempts', DEFAULT_GROUP_MAX_FLUSH_ATTEMPTS);
  const retryDelayMs = positiveNumber(options.retryDelayMs, 'retryDelayMs', DEFAULT_GROUP_RETRY_DELAY_MS);
  const maxNormalWaitMs = positiveNumber(options.maxNormalWaitMs, 'maxNormalWaitMs', DEFAULT_GROUP_MAX_NORMAL_WAIT_MS);
  const deadlineMs = options.deadlineMs === undefined ? undefined : positiveNumber(options.deadlineMs, 'deadlineMs', 1);
  const now = options.now || (() => performance.now());
  const setTimer = options.setTimer || ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = options.clearTimer || ((t) => clearTimeout(/** @type {any} */ (t)));
  const writeGate = options.writeGate ?? /** @type {any} */ (host).writeGate;

  /** @type {'open' | 'closing' | 'closed'} */
  let state = 'open';
  /** @type {GroupMember[]} */
  let buffer = [];
  /** In-flight batch per lane. */
  /** @type {{ main: GroupMember[] | null, priority: GroupMember[] | null }} */
  const lanes = { main: null, priority: null };
  /** Member bytes / members held (buffered + in flight), for backpressure. */
  let heldBytes = 0;
  let heldCount = 0;
  /** No dispatch before this time (backoff after a failed flush). */
  let retryAt = 0;
  /** @type {unknown} */
  let timer = null;
  /** @type {Array<() => void>} */
  let idleWaiters = [];
  /** @type {Promise<void> | null} */
  let closePromise = null;
  const counters = {
    submitted: 0,
    batches: 0,
    priorityLaneBatches: 0,
    committed: 0,
    failed: 0,
    unknownCommit: 0,
    requeued: 0,
    deferred: 0,
    rejectedBusy: 0,
    flushBySize: 0,
    flushByWindow: 0,
    flushByPriority: 0,
    flushByCount: 0,
    flushForced: 0,
  };
  let forceFlush = false;

  /**
   * @param {GroupMember} member
   * @returns {boolean}
   */
  const isPriority = (member) => IMMEDIATE.has(member.priority);

  /**
   * @param {GroupMember} member
   */
  function release(member) {
    member.done = true;
    heldBytes -= member.bytes;
    heldCount -= 1;
  }

  /**
   * @param {GroupMember} member
   * @param {{ result: unknown, replayed: boolean }} value
   */
  function resolveMember(member, value) {
    if (member.done) return;
    release(member);
    counters.committed += 1;
    member.resolve(value);
  }

  /**
   * @param {GroupMember} member
   * @param {unknown} err
   */
  function rejectMember(member, err) {
    if (member.done) return;
    release(member);
    counters.failed += 1;
    if (isStorageError(err) && /** @type {StorageError} */ (err).code === STORAGE_ERROR_CODES.UNKNOWN_COMMIT) counters.unknownCommit += 1;
    let out = err;
    try {
      out = noteReceiptFailure(host, member.prepared.key, err);
    } catch {
      // Bookkeeping only; the member still settles with its error.
    }
    member.reject(out);
  }

  function notifyIdle() {
    if (buffer.length > 0 || lanes.main || lanes.priority) return;
    forceFlush = false;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  /**
   * @param {number} ms
   */
  function arm(ms) {
    clearScheduled();
    timer = setTimer(() => {
      timer = null;
      schedule();
    }, Math.max(0, ms));
  }

  /**
   * Which trigger (if any) makes the buffer due for the main lane now.
   *
   * @returns {keyof typeof counters | null}
   */
  function dueReason() {
    if (buffer.some(isPriority)) return 'flushByPriority';
    if (forceFlush || state !== 'open') return 'flushForced';
    if (buffer.some((m) => m.deferred)) return 'flushForced';
    if (buffer.length >= maxBatchCount) return 'flushByCount';
    let bytes = 0;
    for (const m of buffer) bytes += m.bytes;
    if (bytes >= batchEntryLimit) return 'flushBySize';
    if (now() - oldestSubmittedAt() >= windowMs) return 'flushByWindow';
    return null;
  }

  /**
   * @returns {number}
   */
  function oldestSubmittedAt() {
    let oldest = Infinity;
    for (const m of buffer) oldest = Math.min(oldest, m.submittedAt);
    return oldest;
  }

  /**
   * Dispatch on every free lane that has due work; otherwise arm the timer
   * for the window or the retry backoff. A busy lane re-runs this when its
   * batch settles.
   */
  function schedule() {
    if (buffer.length === 0) {
      clearScheduled();
      notifyIdle();
      return;
    }
    const wait = retryAt - now();
    if (wait > 0) {
      arm(wait);
      return;
    }
    if (!lanes.main) {
      const reason = dueReason();
      if (reason) {
        clearScheduled();
        counters[reason] += 1;
        dispatch(takeBatch(false), 'main');
      }
    }
    if (lanes.main && !lanes.priority && buffer.some(isPriority)) {
      clearScheduled();
      counters.flushByPriority += 1;
      counters.priorityLaneBatches += 1;
      dispatch(takeBatch(true), 'priority');
    }
    if (!lanes.main && buffer.length > 0) arm(windowMs - (now() - oldestSubmittedAt()));
  }

  /**
   * @param {GroupMember[]} first
   * @param {GroupMember[]} second
   * @returns {GroupMember[]}
   */
  function interleave(first, second) {
    const out = [];
    for (let i = 0; i < Math.max(first.length, second.length); i += 1) {
      if (i < first.length) out.push(first[i]);
      if (i < second.length) out.push(second[i]);
    }
    return out;
  }

  /**
   * Members of the next batch, each class in buffer order:
   * 1. members deferred by the shared reply budget (the first one always
   *    fits once it runs first);
   * 2. priority members, then normal members; once the front normal member
   *    waited `maxNormalWaitMs` the two classes alternate starting with it,
   *    so a priority stream cannot starve normal members (anti-starvation).
   * Stops at `maxBatchCount` members or before the member whose entry would
   * exceed `maxBatchBytes`; a single oversized member ships alone.
   *
   * @param {boolean} priorityOnly priority lane: priority members only
   * @returns {GroupMember[]}
   */
  function takeBatch(priorityOnly) {
    const eligible = priorityOnly ? buffer.filter(isPriority) : buffer;
    const deferred = eligible.filter((m) => m.deferred);
    const pri = eligible.filter((m) => !m.deferred && isPriority(m));
    const nor = eligible.filter((m) => !m.deferred && !isPriority(m));
    const aged = nor.length > 0 && now() - nor[0].submittedAt >= maxNormalWaitMs;
    const ordered = [...deferred, ...(aged ? interleave(nor, pri) : [...pri, ...nor])];
    const batch = [];
    let bytes = 0;
    for (const m of ordered) {
      if (batch.length >= maxBatchCount) break;
      if (batch.length > 0 && bytes + m.bytes > batchEntryLimit) break;
      batch.push(m);
      bytes += m.bytes;
    }
    const taken = new Set(batch);
    buffer = buffer.filter((m) => !taken.has(m));
    for (const m of batch) {
      m.deferred = false;
      m.settled = false;
    }
    return batch;
  }

  /**
   * @param {GroupMember[]} batch
   * @returns {string}
   */
  function batchPriority(batch) {
    let best = STORAGE_PRIORITIES.length - 1;
    for (const m of batch) best = Math.min(best, STORAGE_PRIORITIES.indexOf(m.priority));
    return STORAGE_PRIORITIES[best];
  }

  /**
   * Last-resort settlement when settling a batch itself threw: every member
   * not settled yet is `unknown_commit` (it may have committed).
   *
   * @param {GroupMember[]} batch
   */
  function abandonBatch(batch) {
    for (const m of batch) {
      if (m.settled) continue;
      m.settled = true;
      rejectMember(m, malformedReply(m.prepared.commandId));
    }
  }

  /**
   * @param {GroupMember[]} batch
   * @param {'main' | 'priority'} lane
   * @param {Requeue} requeue
   */
  function finishBatch(batch, lane, requeue) {
    if (lanes[lane] === batch) lanes[lane] = null;
    if (requeue.members.length > 0) {
      counters.requeued += requeue.members.length;
      buffer = [...requeue.members, ...buffer];
      if (requeue.backoff) {
        const attempt = Math.max(...requeue.members.map((m) => m.attempts));
        retryAt = now() + retryDelayMs * 2 ** (Math.max(1, attempt) - 1);
      }
    }
    schedule();
  }

  /**
   * @param {GroupMember[]} batch
   * @param {'main' | 'priority'} lane
   */
  function dispatch(batch, lane) {
    lanes[lane] = batch;
    counters.batches += 1;
    const members = batch.map((m) => ({ name: m.prepared.name, commandId: m.prepared.commandId, payloadJson: m.json }));
    /** @type {Requeue} */
    const requeue = { members: [], backoff: false };
    /**
     * Settle, free the lane and put requeued members back in ONE synchronous
     * step, before any member continuation runs: a caller reacting to its
     * result already sees the lane free and the retries at the front.
     *
     * @param {() => void} settle
     */
    const complete = (settle) => {
      try {
        settle();
      } catch {
        abandonBatch(batch);
      } finally {
        finishBatch(batch, lane, requeue);
      }
    };
    Promise.resolve()
      .then(() => host.commandBatch(members, { priority: batchPriority(batch), deadlineMs }))
      .then((reply) => complete(() => settleBatch(batch, reply, requeue)), (err) => complete(() => failBatch(batch, err, requeue)))
      // Terminal: nothing above may leave an unhandled rejection behind.
      .catch(() => abandonBatch(batch));
  }

  /**
   * Requeue a member after a retryable `not_committed` batch failure (same
   * snapshot, same commandId: the receipt makes the retry idempotent), or
   * reject it when attempts are exhausted, the error is final or the
   * committer is closing.
   *
   * @param {GroupMember} member
   * @param {StorageError} err already shaped for this member (not_committed)
   * @param {Requeue} requeue
   */
  function retryOrReject(member, err, requeue) {
    if (err.retryable && state === 'open' && member.attempts + 1 < maxFlushAttempts) {
      member.attempts += 1;
      requeue.members.push(member);
      requeue.backoff = true;
      return;
    }
    rejectMember(member, err);
  }

  /**
   * A member that did not fit the shared reply budget never ran: it goes
   * back to the front, runs first in the next batch (where it always fits)
   * and does not count as a failed attempt.
   *
   * @param {GroupMember} member
   * @param {Requeue} requeue
   */
  function deferMember(member, requeue) {
    if (state === 'closed') {
      rejectMember(member, groupError(STORAGE_ERROR_CODES.IO, 'Group committer closed before dispatch', {
        operation: 'shutdown', commitState: 'not_committed', retryable: false, commandId: member.prepared.commandId,
      }));
      return;
    }
    counters.deferred += 1;
    member.deferred = true;
    requeue.members.push(member);
  }

  /**
   * The batch request itself was rejected by the host: worker loss or an
   * unreadable reply (`unknown`) => every member `unknown_commit`; anything
   * else never reached COMMIT => retry or reject per member.
   *
   * @param {GroupMember[]} batch
   * @param {unknown} err
   * @param {Requeue} requeue
   */
  function failBatch(batch, err, requeue) {
    const typed = toBatchError(err);
    const unknown = typed.details.commitState !== 'not_committed';
    for (const m of batch) {
      if (m.settled) continue;
      m.settled = true;
      if (unknown) rejectMember(m, forMember(typed, m.prepared.commandId, 'unknown', true));
      else retryOrReject(m, forMember(typed, m.prepared.commandId, 'not_committed'), requeue);
    }
  }

  /**
   * @param {GroupMember[]} batch
   * @param {unknown} rawReply
   * @param {Requeue} requeue
   */
  function settleBatch(batch, rawReply, requeue) {
    const reply = /** @type {Record<string, any>} */ (rawReply);
    const outcomes = reply?.members;
    const batchErr = reply?.committed === false ? fromJSON(reply.error) : null;
    if (!Array.isArray(outcomes) || outcomes.length !== batch.length || typeof reply.committed !== 'boolean'
      || (reply.committed === false && !batchErr)) {
      failBatch(batch, malformedReply(), requeue);
      return;
    }
    batch.forEach((m, i) => {
      m.settled = true;
      try {
        settleMember(m, outcomes[i], /** @type {StorageError | null} */ (batchErr), requeue);
      } catch {
        rejectMember(m, malformedReply(m.prepared.commandId));
      }
    });
  }

  /**
   * @param {GroupMember} m
   * @param {unknown} entry
   * @param {StorageError | null} batchErr null when the batch committed
   * @param {Requeue} requeue
   */
  function settleMember(m, entry, batchErr, requeue) {
    const commandId = m.prepared.commandId;
    const o = /** @type {Record<string, any>} */ (entry);
    const kind = entryKind(entry);
    const rolledBack = batchErr !== null && batchErr.details.commitState === 'not_committed';
    if (kind === 'malformed') {
      // Nothing of a rolled-back batch is durable; otherwise this member's
      // fate cannot be read from the reply.
      if (rolledBack) retryOrReject(m, forMember(/** @type {StorageError} */ (batchErr), commandId, 'not_committed'), requeue);
      else rejectMember(m, malformedReply(commandId));
      return;
    }
    if (kind === 'failed') {
      const own = /** @type {StorageError} */ (fromJSON(o.error));
      // A member's own failure was rolled back to its savepoint (or it is the
      // member that ended the transaction and carries its own commit state).
      rejectMember(m, forMember(own, commandId, own.details.commitState === 'unknown' ? 'unknown' : 'not_committed', true));
      return;
    }
    if (!batchErr) {
      if (kind === 'notRun') {
        if (o.deferred === 'result_budget') deferMember(m, requeue);
        else rejectMember(m, malformedReply(commandId));
        return;
      }
      let value;
      try {
        value = readReceiptReply(host, m.prepared, JSON.parse(o.resultJson));
      } catch (err) {
        rejectMember(m, isStorageError(err) ? err : malformedReply(commandId));
        return;
      }
      resolveMember(m, value);
      return;
    }
    if (kind === 'ok' && !rolledBack) {
      // Ran in the transaction whose COMMIT outcome is unknown; its receipt
      // was written in that same transaction, so resolveUnknown decides it.
      rejectMember(m, forMember(batchErr, commandId, 'unknown'));
      return;
    }
    if (kind === 'notRun' && !rolledBack) {
      // Never ran: nothing of it can be durable.
      retryOrReject(m, groupError(STORAGE_ERROR_CODES.IO, 'Storage batch aborted before this member ran', {
        operation: 'batch_aborted', commitState: 'not_committed', retryable: true, commandId,
      }), requeue);
      return;
    }
    retryOrReject(m, forMember(batchErr, commandId, 'not_committed'), requeue);
  }

  /**
   * Submit one receipt command. Resolves `{ result, replayed }` after the
   * COMMIT of the batch that carried it; rejects like `executeCommand`
   * (`details.commitState` always set; on `unknown_commit` call
   * `resolveUnknown` with the same arguments before any retry).
   *
   * @param {{ datasetGeneration: string, commandId: string, name: string, payload: unknown, priority?: string, writeGate?: unknown }} args
   * @returns {Promise<{ result: unknown, replayed: boolean }>}
   */
  function submit(args) {
    const commandId = typeof args?.commandId === 'string' ? args.commandId : null;
    if (state !== 'open') {
      return Promise.reject(groupError(STORAGE_ERROR_CODES.IO, 'Group committer is closed', {
        operation: 'shutdown', commitState: 'not_committed', retryable: false, commandId,
      }));
    }
    const priority = args?.priority ?? 'normal';
    if (!STORAGE_PRIORITIES.includes(priority)) {
      return Promise.reject(groupError(STORAGE_ERROR_CODES.IO, 'Unknown storage priority', {
        operation: 'invalid_request', commitState: 'not_committed', retryable: false, commandId,
      }));
    }
    /** @type {ReturnType<typeof prepareReceiptCommand>} */
    let prepared;
    /** @type {{ json: string, bytes: number }} */
    let wire;
    try {
      assertWriteAllowed(args.writeGate ?? writeGate);
      prepared = prepareReceiptCommand(host, args);
      // The snapshot: later mutation of `args.payload` has no effect.
      wire = toWireJson(prepared.envelope);
    } catch (err) {
      return Promise.reject(err);
    }
    const bytes = entryBytes(prepared.name, prepared.commandId, wire.bytes);
    if (bytes > maxMemberBytes) {
      return Promise.reject(groupError(STORAGE_ERROR_CODES.IO, 'Storage payload exceeds the group member limit', {
        operation: 'payload_too_large', commitState: 'not_committed', retryable: false, commandId,
      }));
    }
    if (heldCount + 1 > maxBufferedCount || heldBytes + bytes > maxBufferedBytes) {
      counters.rejectedBusy += 1;
      return Promise.reject(groupError(STORAGE_ERROR_CODES.BUSY, 'Group commit buffer is full', {
        operation: 'group_buffer', commitState: 'not_committed', retryable: true, commandId,
      }));
    }
    counters.submitted += 1;
    const settled = new Promise((resolve, reject) => {
      heldBytes += bytes;
      heldCount += 1;
      buffer.push({
        prepared, json: wire.json, bytes, priority, submittedAt: now(), attempts: 0,
        deferred: false, settled: false, done: false, resolve, reject,
      });
      schedule();
    });
    // A dropped (fire-and-forget) submit must not become a process-fatal unhandledRejection when the host expires
    // its batch in the queue; awaiting callers still receive the rejection.
    settled.catch(() => {});
    return settled;
  }

  /**
   * Flush everything buffered now (ignores the window, not the retry
   * backoff). Resolves when the buffer is empty and no batch is in flight;
   * individual outcomes arrive through each `submit` promise.
   *
   * @returns {Promise<void>}
   */
  function flush() {
    forceFlush = true;
    const idle = new Promise((resolve) => idleWaiters.push(() => resolve(undefined)));
    schedule();
    return /** @type {Promise<void>} */ (idle);
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  async function runClose(timeoutMs) {
    state = 'closing';
    /** @type {unknown} */
    let closeTimer = null;
    const timedOut = new Promise((resolve) => {
      closeTimer = setTimer(() => resolve(false), timeoutMs);
    });
    const idle = new Promise((resolve) => idleWaiters.push(() => resolve(true)));
    retryAt = 0;
    schedule();
    await Promise.race([idle, timedOut]);
    if (closeTimer !== null) clearTimer(closeTimer);
    clearScheduled();
    state = 'closed';
    const left = buffer;
    buffer = [];
    for (const m of left) {
      rejectMember(m, groupError(STORAGE_ERROR_CODES.IO, 'Group committer closed before dispatch', {
        operation: 'shutdown', commitState: 'not_committed', retryable: false, commandId: m.prepared.commandId,
      }));
    }
  }

  /**
   * Stop accepting members, flush the buffer (no retries while closing) and
   * resolve once every buffered member settled, or after `timeoutMs`: then
   * members never dispatched are rejected (`not_committed`, `shutdown`); an
   * in-flight batch settles with its real outcome when the host does (closing
   * the host turns it into `unknown_commit`). Does not close the host.
   *
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<void>}
   */
  function close(opts = {}) {
    if (closePromise) return closePromise;
    let timeoutMs;
    try {
      timeoutMs = positiveNumber(opts.timeoutMs, 'timeoutMs', DEFAULT_GROUP_CLOSE_TIMEOUT_MS);
    } catch (err) {
      return Promise.reject(err);
    }
    closePromise = runClose(timeoutMs);
    return closePromise;
  }

  /**
   * Secret-free metrics (counts only). `inFlight` counts members,
   * `inFlightBatches` batches (at most two: main and priority lane).
   */
  function getMetrics() {
    const inFlightLanes = [lanes.main, lanes.priority].filter(Boolean);
    return {
      state,
      buffered: buffer.length,
      bufferedBytes: buffer.reduce((acc, m) => acc + m.bytes, 0),
      heldCount,
      heldBytes,
      inFlight: inFlightLanes.reduce((acc, b) => acc + /** @type {GroupMember[]} */ (b).length, 0),
      inFlightBatches: inFlightLanes.length,
      counters: { ...counters },
    };
  }

  return Object.freeze({ submit, flush, close, getMetrics });
}
