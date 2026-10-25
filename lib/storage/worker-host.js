/**
 * Main-thread host of the storage worker (A2 S3, selected A1 variant
 * "sqlite-worker"; protocol: lib/storage/worker-protocol.md).
 *
 * The host never touches SQLite. It owns:
 *   - a bounded fair queue (lib/storage/fair-queue.js) with strict priority
 *     classes stop > claim > intent > final > normal and a bounded aging
 *     bypass, overflow => `busy`;
 *   - exactly one in-flight request to the worker at a time, so the worker
 *     always runs one whole transaction per message;
 *   - a JSON snapshot of every payload taken at enqueue (exact byte budget,
 *     later caller mutation cannot change what commits);
 *   - per-request deadlines and AbortSignal cancellation before dispatch;
 *   - an execution watchdog (`maxExecutionMs`) for a handler that never
 *     returns, which terminates the worker;
 *   - crash handling: the in-flight command is rejected as `unknown_commit`
 *     (never retried here), queued requests stay queued and a replacement
 *     worker is started with exponential backoff only after the old worker
 *     has exited, so two writers never run at once; a crash loop fails the host;
 *   - graceful shutdown that drains the queue within a timeout.
 *
 * There is no synchronous facade, no blocking shared-memory wait and no lock:
 * every caller gets a Promise and nothing is held locked across an `await`.
 */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fromJSON, isStorageError, StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { createFairQueue, DEFAULT_MAX_QUEUE_BYTES, percentile, STORAGE_PRIORITIES } from './fair-queue.js';
import { BATCH_REQUEST_NAME, COMMAND_ID_PATTERN, CONTROL_OPS, HANDLER_NAME_PATTERN, toWireJson } from './worker-wire.js';

const WORKER_URL = new URL('./sqlite-worker.js', import.meta.url);
const REQUEST_KINDS = new Set(['command', 'query', 'control', 'batch']);
/** Request kinds that write: a loss or an unreadable reply is `unknown_commit`. */
const WRITE_KINDS = new Set(['command', 'batch']);
/** Upper bound of members in one batch request (group commit, S5). */
export const MAX_BATCH_MEMBERS = 4096;

export const DEFAULT_MAX_EXECUTION_MS = 30000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
export const DEFAULT_RESTART_BACKOFF_MS = Object.freeze({ initial: 50, max: 2000 });
export const DEFAULT_MAX_START_ATTEMPTS = 5;
/**
 * Extra queue-wait windows granted to a request of a protected class (everything above `normal`: stop, claim,
 * intent, final) before its expiry is surfaced. An expired request was never dispatched, so re-queueing it is
 * always safe; this keeps ack/report-style writes from failing under load while background writes still shed.
 * Each re-queue restarts the full `deadlineMs` window, so a protected request can wait up to
 * (1 + retries) x the caller's `deadlineMs` before the expiry is surfaced.
 */
export const DEFAULT_PROTECTED_EXPIRY_RETRIES = 3;
/** Largest single payload (JSON bytes); never more than the queue byte budget. */
export const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Largest handler result (JSON bytes); a bigger result rolls the transaction back. */
export const DEFAULT_MAX_RESULT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_WORKER_RESOURCE_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 512 });
/** Crash-loop breaker: this many worker losses inside the window fail the host. */
export const DEFAULT_MAX_WORKER_LOSSES = 5;
export const DEFAULT_WORKER_LOSS_WINDOW_MS = 60000;
/** Codes that make a start failure permanent: retrying the open cannot help. */
const PERMANENT_START_CODES = new Set([
  STORAGE_ERROR_CODES.CORRUPT,
  STORAGE_ERROR_CODES.CONFLICT,
  STORAGE_ERROR_CODES.UNSUPPORTED_RUNTIME,
  STORAGE_ERROR_CODES.MISSING,
  STORAGE_ERROR_CODES.FULL_DISK,
]);
const SAMPLE_WINDOW = 4096;
/** Default database file name (mirrors db-lifecycle.js, which the host does not load). */
const DEFAULT_DB_FILENAME = 'cretli-store.sqlite';

/**
 * Worker threads of closed hosts that had not exited when `close()` gave up
 * waiting, keyed by database file. Such a thread may still be inside a
 * native COMMIT; a new host on the same file in this process refuses to
 * start until it exited, otherwise its `resolveUnknown` could answer
 * `not_committed` for a commit that lands a moment later.
 *
 * @type {Map<string, Set<Worker>>}
 */
const orphanWorkers = new Map();

/**
 * @param {string} dbKey
 * @param {Worker} target
 * @param {Promise<void>} exited
 */
function registerOrphan(dbKey, target, exited) {
  let set = orphanWorkers.get(dbKey);
  if (!set) {
    set = new Set();
    orphanWorkers.set(dbKey, set);
  }
  set.add(target);
  exited.then(() => {
    set.delete(target);
    if (set.size === 0 && orphanWorkers.get(dbKey) === set) orphanWorkers.delete(dbKey);
  });
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ operation: string, commitState: 'not_committed' | 'unknown', retryable?: boolean, commandId?: string | null, cause?: unknown }} info
 * @returns {StorageError}
 */
function hostError(code, message, info) {
  /** @type {Record<string, unknown>} */
  const details = { operation: info.operation, commitState: info.commitState };
  if (info.commandId) details.commandId = info.commandId;
  return new StorageError(code, message, { retryable: info.retryable, details, cause: info.cause });
}

/**
 * Non-retryable refusal of a malformed request; nothing was queued.
 *
 * @param {string} message
 * @param {string} [operation]
 * @param {string | null} [commandId]
 * @returns {StorageError}
 */
function invalidRequest(message, operation = 'invalid_request', commandId = null) {
  return hostError(STORAGE_ERROR_CODES.IO, message, { operation, commitState: 'not_committed', retryable: false, commandId });
}

/**
 * Copy of `err` that carries `commandId` in its safe details.
 *
 * @param {StorageError} err
 * @param {string | null} commandId
 * @returns {StorageError}
 */
function withCommandId(err, commandId) {
  if (!commandId || err.details.commandId === commandId) return err;
  return new StorageError(err.code, err.message, {
    cause: err.cause,
    retryable: err.retryable,
    details: { ...err.details, commandId },
  });
}

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
 * @param {number[]} samples
 * @param {number} value
 */
function pushSample(samples, value) {
  samples.push(value);
  if (samples.length > SAMPLE_WINDOW) samples.shift();
}

/**
 * @param {number[]} samples
 */
function summarize(samples) {
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples.length ? Math.max(...samples) : null,
    sum: samples.reduce((acc, v) => acc + v, 0),
  };
}

/**
 * @typedef {{
 *   priority?: string,
 *   deadlineMs?: number,
 *   signal?: AbortSignal,
 *   commandId?: string,
 *   requireReceipt?: boolean,
 *   fenceEpoch?: number,
 * }} StorageRequestOptions
 */

/**
 * Validate request arguments before anything is queued.
 *
 * @param {string} kind
 * @param {unknown} name
 * @param {unknown} opts
 * @returns {{ commandId: string | null, priority: string, signal: AbortSignal | undefined, deadlineMs: number | undefined, requireReceipt: boolean, fenceEpoch: number | null }}
 */
function validateRequest(kind, name, opts) {
  if (!opts || typeof opts !== 'object') throw invalidRequest('Storage request options must be an object');
  const options = /** @type {StorageRequestOptions} */ (opts);
  const rawId = options.commandId;
  let commandId = null;
  if (rawId !== undefined && rawId !== null && rawId !== '') {
    if (typeof rawId !== 'string' || !COMMAND_ID_PATTERN.test(rawId)) throw invalidRequest('Invalid storage commandId');
    commandId = rawId;
  }
  if (!REQUEST_KINDS.has(kind)) throw invalidRequest('Unknown storage request kind', 'invalid_request', commandId);
  let validName;
  if (kind === 'control') validName = CONTROL_OPS.has(/** @type {string} */ (name));
  else if (kind === 'batch') validName = name === BATCH_REQUEST_NAME;
  else validName = typeof name === 'string' && HANDLER_NAME_PATTERN.test(name);
  if (!validName) throw invalidRequest('Invalid storage handler name', 'invalid_request', commandId);
  const priority = options.priority ?? 'normal';
  if (!STORAGE_PRIORITIES.includes(priority)) throw invalidRequest('Unknown storage priority', 'invalid_request', commandId);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidRequest('Storage request signal must be an AbortSignal', 'invalid_request', commandId);
  }
  const deadlineMs = options.deadlineMs;
  if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0)) {
    throw invalidRequest('Storage request deadlineMs must be a positive number', 'invalid_request', commandId);
  }
  if (options.requireReceipt !== undefined && typeof options.requireReceipt !== 'boolean') {
    throw invalidRequest('Storage request requireReceipt must be a boolean', 'invalid_request', commandId);
  }
  // Owner epoch for the fencing check (lib/storage/coordinator.md). Absent
  // means no check (single-process use, existing behaviour).
  const fenceEpoch = options.fenceEpoch;
  if (fenceEpoch !== undefined && (!Number.isSafeInteger(fenceEpoch) || fenceEpoch < 0)) {
    throw invalidRequest('Storage request fenceEpoch must be a non-negative integer', 'invalid_request', commandId);
  }
  return {
    commandId, priority, signal: options.signal, deadlineMs, requireReceipt: options.requireReceipt === true, fenceEpoch: fenceEpoch ?? null,
  };
}

/**
 * True when `text` is exactly one JSON object. The member snapshot is spliced
 * into the batch text verbatim, so anything else (a fragment such as
 * `{}]},{"name":…`) could corrupt the batch or inject extra members. Costs
 * one parse per member on the main thread (bounded by the batch byte limit).
 *
 * @param {string} text
 * @returns {boolean}
 */
function isJsonObjectText(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Wire JSON of a batch payload built from member snapshots that were already
 * serialized by `toWireJson` (no second serialization of member payloads).
 * Shape: `{"members":[{"name":…,"commandId":…,"payload":<json>},…]}`.
 *
 * @param {unknown} members
 * @returns {{ json: string, bytes: number }}
 */
function buildBatchWire(members) {
  if (!Array.isArray(members) || members.length === 0 || members.length > MAX_BATCH_MEMBERS) {
    throw invalidRequest('Storage batch needs 1..MAX_BATCH_MEMBERS members');
  }
  const parts = members.map((m) => {
    const member = /** @type {Record<string, any>} */ (m);
    if (!member || typeof member.name !== 'string' || !HANDLER_NAME_PATTERN.test(member.name)
      || typeof member.commandId !== 'string' || !COMMAND_ID_PATTERN.test(member.commandId)
      || typeof member.payloadJson !== 'string' || !isJsonObjectText(member.payloadJson)) {
      throw invalidRequest('Invalid storage batch member');
    }
    return `{"name":${JSON.stringify(member.name)},"commandId":${JSON.stringify(member.commandId)},"payload":${member.payloadJson}}`;
  });
  const json = `{"members":[${parts.join(',')}]}`;
  return { json, bytes: Buffer.byteLength(json) };
}

/**
 * @param {{
 *   dbDir: string,
 *   filename?: string,
 *   handlersPath: string,
 *   busyTimeoutMs?: number,
 *   checkpointWaitMs?: number,
 *   maxQueueDepth?: number,
 *   maxQueueBytes?: number,
 *   maxQueueAgeMs?: number,
 *   protectedExpiryRetries?: number,
 *   maxRequestBytes?: number,
 *   maxResultBytes?: number,
 *   agingMs?: number,
 *   bypassEvery?: number,
 *   maxExecutionMs?: number,
 *   restartBackoffMs?: { initial?: number, max?: number },
 *   maxStartAttempts?: number,
 *   maxWorkerLosses?: number,
 *   workerLossWindowMs?: number,
 *   resourceLimits?: import('node:worker_threads').ResourceLimits,
 *   now?: () => number,
 *   workerUrl?: URL | (() => URL),
 *   create?: boolean,
 *   faultInjection?: boolean,
 *   writeGate?: unknown,
 * }} options `create: false` makes every worker (re)start refuse a missing or empty database file
 *   instead of creating one (default true). `workerUrl` and `faultInjection` are test seams only.
 */
export function createStorageWorkerHost(options) {
  const { dbDir, filename, handlersPath, busyTimeoutMs } = options || {};
  if (typeof dbDir !== 'string' || !path.isAbsolute(dbDir)) throw new TypeError('dbDir must be an absolute path');
  if (typeof handlersPath !== 'string' || !path.isAbsolute(handlersPath)) {
    throw new TypeError('handlersPath must be an absolute path');
  }
  const now = options.now || (() => performance.now());
  const maxExecutionMs = positiveNumber(options.maxExecutionMs, 'maxExecutionMs', DEFAULT_MAX_EXECUTION_MS);
  const backoffInitial = positiveNumber(options.restartBackoffMs?.initial, 'restartBackoffMs.initial', DEFAULT_RESTART_BACKOFF_MS.initial);
  const backoffMax = positiveNumber(options.restartBackoffMs?.max, 'restartBackoffMs.max', DEFAULT_RESTART_BACKOFF_MS.max);
  const maxStartAttempts = positiveNumber(options.maxStartAttempts, 'maxStartAttempts', DEFAULT_MAX_START_ATTEMPTS);
  const maxWorkerLosses = positiveNumber(options.maxWorkerLosses, 'maxWorkerLosses', DEFAULT_MAX_WORKER_LOSSES);
  const workerLossWindowMs = positiveNumber(options.workerLossWindowMs, 'workerLossWindowMs', DEFAULT_WORKER_LOSS_WINDOW_MS);
  const maxResultBytes = positiveNumber(options.maxResultBytes, 'maxResultBytes', DEFAULT_MAX_RESULT_BYTES);
  const queue = createFairQueue({
    now,
    maxDepth: options.maxQueueDepth,
    maxBytes: options.maxQueueBytes,
    maxAgeMs: options.maxQueueAgeMs,
    agingMs: options.agingMs,
    bypassEvery: options.bypassEvery,
  });
  const maxRequestBytes = Math.min(
    positiveNumber(options.maxRequestBytes, 'maxRequestBytes', DEFAULT_MAX_REQUEST_BYTES),
    options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,
  );
  const resourceLimits = { ...DEFAULT_WORKER_RESOURCE_LIMITS, ...options.resourceLimits };
  const dbKey = path.resolve(dbDir, filename || DEFAULT_DB_FILENAME);

  /** @type {'idle' | 'starting' | 'ready' | 'restarting' | 'closing' | 'closed' | 'failed'} */
  let state = 'idle';
  /** @type {Worker | null} */
  let worker = null;
  let workerReady = false;
  let generation = 0;
  let startAttempts = 0;
  /** Timings of the latest successful worker start (diagnostics only). */
  let lastStart = null;
  let restarts = 0;
  /** Consecutive worker losses without any response; drives backoff. */
  let lossStreak = 0;
  /** @type {number[]} timestamps of worker losses (crash-loop breaker) */
  let lossTimes = [];
  /** @type {StorageError | null} */
  let failure = null;
  /** @type {Map<string, { commandId: string | null, enqueuedAt: number, expiryRetries?: number, resolve: (v: unknown) => void, reject: (e: unknown) => void, cleanup: () => void }>} */
  const pending = new Map();
  /** @type {{ id: string, kind: string, commandId: string | null, startedAt: number, watchdog: NodeJS.Timeout } | null} */
  let inFlight = null;
  /** @type {NodeJS.Timeout | null} */
  let expiryTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let restartTimer = null;
  /** @type {{ promise: Promise<void>, resolve: () => void, reject: (e: unknown) => void } | null} */
  let startDeferred = null;
  /** @type {Promise<void> | null} */
  let closePromise = null;
  /** @type {Array<() => void>} */
  const idleWaiters = [];
  /** Workers that have not emitted 'exit' yet, with a promise for it. */
  /** @type {Map<Worker, { exited: Promise<void>, onExit: (() => void) | null }>} */
  const liveWorkers = new Map();
  /** @type {number[]} */
  const executeSamples = [];
  /** @type {number[]} enqueue -> response for dispatched requests (queue wait + execute) */
  const requestSamples = [];
  const counters = {
    completed: 0,
    failed: 0,
    unknownCommit: 0,
    workerLost: 0,
    expired: 0,
    aborted: 0,
    rejectedBusy: 0,
    rejectedInvalid: 0,
    dispatchFailed: 0,
    expiryRetried: 0,
  };
  /** @type {Record<string, { expired: number, dispatched: number, waitTotalMs: number, waitMaxMs: number }>} */
  const byPriority = {};
  for (const p of STORAGE_PRIORITIES) byPriority[p] = { expired: 0, dispatched: 0, waitTotalMs: 0, waitMaxMs: 0 };
  const protectedExpiryRetries = options.protectedExpiryRetries === undefined
    ? DEFAULT_PROTECTED_EXPIRY_RETRIES
    : Math.max(0, Math.floor(Number(options.protectedExpiryRetries)) || 0);

  /**
   * @param {string} id
   * @returns {ReturnType<typeof pending.get>}
   */
  function takePending(id) {
    const item = pending.get(id);
    if (!item) return undefined;
    pending.delete(id);
    item.cleanup();
    return item;
  }

  /**
   * @param {string} id
   * @param {unknown} err
   */
  function rejectPending(id, err) {
    const item = takePending(id);
    if (!item) return;
    counters.failed += 1;
    if (isStorageError(err) && /** @type {StorageError} */ (err).code === STORAGE_ERROR_CODES.UNKNOWN_COMMIT) counters.unknownCommit += 1;
    item.reject(err);
  }

  function notifyIdle() {
    if (queue.size > 0 || inFlight) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function armExpiryTimer() {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    const wait = queue.msUntilNextExpiry();
    if (wait === null) return;
    expiryTimer = setTimeout(pump, Math.ceil(wait) + 1);
    expiryTimer.unref?.();
  }

  function canDispatch() {
    return !inFlight && workerReady && worker !== null && (state === 'ready' || state === 'closing');
  }

  /**
   * Expire overdue requests and dispatch while the worker is free. Loops so a
   * failed dispatch (which leaves nothing in flight) never stalls the queue.
   */
  function pump() {
    for (const entry of queue.expireDue()) {
      const prio = byPriority[entry.priority];
      const item = pending.get(entry.id);
      if (item && entry.priority !== 'normal' && (item.expiryRetries ?? 0) < protectedExpiryRetries && state === 'ready') {
        // Protected class: never ran, so grant another queue window instead of failing the caller.
        try {
          queue.push({
            id: entry.id, priority: entry.priority, sizeBytes: entry.sizeBytes, deadlineMs: entry.deadlineMs,
            kind: entry.kind, name: entry.name, payloadJson: entry.payloadJson, commandId: entry.commandId,
            requireReceipt: entry.requireReceipt, fenceEpoch: entry.fenceEpoch,
          });
          item.expiryRetries = (item.expiryRetries ?? 0) + 1;
          counters.expiryRetried += 1;
          continue;
        } catch {
          // Queue full: fall through and surface the expiry.
        }
      }
      if (prio) prio.expired += 1;
      counters.expired += 1;
      rejectPending(entry.id, hostError(STORAGE_ERROR_CODES.BUSY, 'Storage request expired in queue', {
        operation: 'deadline',
        commitState: 'not_committed',
        retryable: true,
        commandId: /** @type {any} */ (entry).commandId,
      }));
    }
    while (canDispatch()) {
      const entry = queue.shift();
      if (!entry) break;
      dispatch(entry);
    }
    armExpiryTimer();
    notifyIdle();
  }

  /**
   * @param {any} entry
   */
  function dispatch(entry) {
    const target = /** @type {Worker} */ (worker);
    const stat = byPriority[entry.priority];
    const waited = now() - (pending.get(entry.id)?.enqueuedAt ?? now());
    if (stat) {
      stat.dispatched += 1;
      stat.waitTotalMs += waited;
      stat.waitMaxMs = Math.max(stat.waitMaxMs, waited);
    }
    const watchdog = setTimeout(() => {
      // A handler that never returns cannot be interrupted inside the thread;
      // terminating it turns the in-flight request into a worker loss.
      loseWorker(target, 'execution_timeout');
    }, maxExecutionMs);
    watchdog.unref?.();
    inFlight = { id: entry.id, kind: entry.kind, commandId: entry.commandId, startedAt: now(), watchdog };
    try {
      target.postMessage({
        type: 'request',
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        priority: entry.priority,
        deadlineMs: entry.deadlineMs ?? null,
        commandId: entry.commandId,
        requireReceipt: entry.requireReceipt === true,
        fenceEpoch: entry.fenceEpoch ?? null,
        payloadJson: entry.payloadJson,
      });
    } catch (err) {
      // Nothing reached the worker, so nothing was committed.
      clearTimeout(watchdog);
      inFlight = null;
      counters.dispatchFailed += 1;
      rejectPending(entry.id, hostError(STORAGE_ERROR_CODES.IO, 'Storage dispatch failed', {
        operation: 'dispatch',
        commitState: 'not_committed',
        retryable: false,
        commandId: entry.commandId,
        cause: err,
      }));
    }
  }

  /**
   * Error for a response the host cannot interpret. A command may have
   * committed, so it is `unknown_commit`; reads have no durable effect.
   *
   * @param {{ kind: string, commandId: string | null }} done
   * @returns {StorageError}
   */
  function malformedResponseError(done) {
    return WRITE_KINDS.has(done.kind)
      ? hostError(STORAGE_ERROR_CODES.UNKNOWN_COMMIT, 'Malformed storage worker response', {
        operation: 'response',
        commitState: 'unknown',
        commandId: done.commandId,
      })
      : hostError(STORAGE_ERROR_CODES.IO, 'Malformed storage worker response', {
        operation: 'response',
        commitState: 'not_committed',
        retryable: true,
        commandId: done.commandId,
      });
  }

  /**
   * @param {Record<string, any>} msg
   */
  function onResponse(msg) {
    if (!inFlight || msg.id !== inFlight.id) return;
    const done = inFlight;
    clearTimeout(done.watchdog);
    inFlight = null;
    // Any reply (success or typed error) proves the worker is healthy.
    lossStreak = 0;
    if (typeof msg.executeMs === 'number') pushSample(executeSamples, msg.executeMs);
    const item = pending.get(msg.id);
    if (item) pushSample(requestSamples, now() - item.enqueuedAt);
    if (msg.ok) {
      let result;
      let parsed = typeof msg.resultJson === 'string';
      if (parsed) {
        try {
          result = JSON.parse(msg.resultJson);
        } catch {
          parsed = false;
        }
      }
      if (parsed) {
        takePending(msg.id);
        counters.completed += 1;
        item?.resolve(result);
      } else {
        rejectPending(msg.id, malformedResponseError(done));
      }
    } else {
      const revived = fromJSON(msg.error);
      rejectPending(msg.id, revived ? withCommandId(revived, done.commandId) : malformedResponseError(done));
    }
    // COMMIT-time unknown_commit: the worker closed its connection and exits.
    // Recycle it before anything else is dispatched, so the next request
    // (typically resolveUnknown) runs on a fresh connection after recovery.
    if (msg.recycle === true && worker) loseWorker(worker, 'commit_failed');
    pump();
  }

  /**
   * Reject the in-flight request after the worker died. A command may have
   * reached COMMIT, so it is `unknown_commit`; reads and control ops have no
   * durable effect and are retryable `io`.
   *
   * @param {string} reason Fixed host-side label, never a raw worker message.
   */
  function rejectInFlightOnLoss(reason) {
    if (!inFlight) return;
    const lost = inFlight;
    clearTimeout(lost.watchdog);
    inFlight = null;
    const isWrite = WRITE_KINDS.has(lost.kind);
    rejectPending(lost.id, isWrite
      ? hostError(STORAGE_ERROR_CODES.UNKNOWN_COMMIT, `Storage worker lost during command (${reason})`, {
        operation: 'worker_lost',
        commitState: 'unknown',
        commandId: lost.commandId,
      })
      : hostError(STORAGE_ERROR_CODES.IO, `Storage worker lost during ${lost.kind} (${reason})`, {
        operation: 'worker_lost',
        commitState: 'not_committed',
        retryable: true,
        commandId: lost.commandId,
      }));
  }

  /**
   * @param {StorageError} err
   * @param {string | null} commandId
   * @returns {StorageError}
   */
  function withNotCommitted(err, commandId) {
    /** @type {Record<string, unknown>} */
    const details = { ...err.details, commitState: 'not_committed' };
    if (commandId) details.commandId = commandId;
    return new StorageError(err.code, err.message, { cause: err, retryable: err.retryable, details });
  }

  /**
   * @param {StorageError} err
   */
  function failPermanently(err) {
    state = 'failed';
    failure = err;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    for (const entry of queue.drainAll()) rejectPending(entry.id, withNotCommitted(err, /** @type {any} */ (entry).commandId));
    startDeferred?.reject(err);
    notifyIdle();
  }

  /**
   * Count a failed start. Returns true when the host has failed for good.
   *
   * @param {StorageError} err
   * @returns {boolean}
   */
  function recordStartFailure(err) {
    startAttempts += 1;
    if (PERMANENT_START_CODES.has(/** @type {any} */ (err.code)) || !err.retryable || startAttempts >= maxStartAttempts) {
      failPermanently(err);
      return true;
    }
    return false;
  }

  /**
   * True when the losses inside the window reached the crash-loop limit.
   *
   * @returns {boolean}
   */
  function isCrashLoop() {
    const since = now() - workerLossWindowMs;
    lossTimes = lossTimes.filter((t) => t > since);
    return lossTimes.length >= maxWorkerLosses;
  }

  /**
   * Decide what happens after a lost worker has fully exited.
   *
   * @param {boolean} wasReady
   * @param {boolean} countedLoss
   * @param {string} reason
   * @param {StorageError | null} startError
   */
  function afterLoss(wasReady, countedLoss, reason, startError) {
    if (state === 'closed' || state === 'failed') return;
    if (state === 'closing' && queue.size === 0) {
      notifyIdle();
      return;
    }
    if (!wasReady) {
      const err = startError || hostError(STORAGE_ERROR_CODES.IO, `Storage worker exited before ready (${reason})`, {
        operation: 'worker_start',
        commitState: 'not_committed',
        retryable: true,
      });
      if (recordStartFailure(err)) return;
    } else if (countedLoss && isCrashLoop()) {
      failPermanently(hostError(STORAGE_ERROR_CODES.IO, 'Storage worker crash loop', {
        operation: 'worker_crash_loop',
        commitState: 'not_committed',
        retryable: false,
      }));
      return;
    }
    scheduleRestart();
  }

  /**
   * Handle the end of a worker (crash, exit, watchdog, start failure). The
   * in-flight request is settled at once; the restart decision waits for the
   * old thread's 'exit' so a worker still inside a native COMMIT can never run
   * concurrently with its replacement. Idempotent per worker.
   *
   * @param {Worker} target
   * @param {string} reason Fixed host-side label.
   * @param {StorageError | null} [startError]
   */
  function loseWorker(target, reason, startError = null) {
    if (target !== worker) return;
    const wasReady = workerReady;
    worker = null;
    workerReady = false;
    const countedLoss = wasReady && (Boolean(inFlight) || state !== 'closing');
    if (countedLoss) {
      counters.workerLost += 1;
      lossStreak += 1;
      lossTimes.push(now());
    }
    rejectInFlightOnLoss(reason);
    if (state !== 'closing') state = 'restarting';
    const proceed = () => afterLoss(wasReady, countedLoss, reason, startError);
    const live = liveWorkers.get(target);
    if (!live) {
      proceed();
      return;
    }
    live.onExit = proceed;
    target.terminate().catch(() => {});
  }

  function scheduleRestart() {
    if (state !== 'closing') state = 'restarting';
    const attempt = Math.max(0, startAttempts + lossStreak - 1);
    const delay = Math.min(backoffMax, backoffInitial * 2 ** attempt);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      restarts += 1;
      spawn(false);
    }, delay);
    // Deliberately ref'd: queued callers are waiting for this restart.
    armExpiryTimer();
  }

  /**
   * @returns {URL}
   */
  function resolveWorkerUrl() {
    const seam = options.workerUrl;
    if (typeof seam === 'function') return seam();
    return seam || WORKER_URL;
  }

  /**
   * @param {boolean} fromStart true when called by start() (not a restart)
   */
  function spawn(fromStart) {
    if (state !== 'closing') state = 'starting';
    generation += 1;
    /** @type {Worker} */
    let target;
    try {
      target = new Worker(resolveWorkerUrl(), {
        workerData: {
          dir: dbDir, filename, handlersPath, busyTimeoutMs, maxResultBytes,
          checkpointWaitMs: options.checkpointWaitMs,
          // false on EVERY (re)start: a missing or empty file is `missing`, never a silently created empty store.
          create: options.create !== false,
          faultInjection: options.faultInjection === true,
        },
        resourceLimits,
      });
    } catch (err) {
      // e.g. ERR_WORKER_INIT_FAILED or an invalid URL: no thread exists.
      worker = null;
      workerReady = false;
      const spawnError = hostError(STORAGE_ERROR_CODES.IO, 'Storage worker could not be spawned', {
        operation: 'worker_spawn',
        commitState: 'not_committed',
        retryable: true,
        cause: err,
      });
      if (fromStart) {
        startAttempts += 1;
        failPermanently(spawnError);
        return;
      }
      if (state === 'closing' && queue.size === 0) {
        notifyIdle();
        return;
      }
      if (!recordStartFailure(spawnError)) scheduleRestart();
      return;
    }
    worker = target;
    workerReady = false;
    const spawnedAt = now();
    /** @type {() => void} */
    let resolveExit = () => {};
    const live = { exited: new Promise((resolve) => { resolveExit = () => resolve(undefined); }), onExit: null };
    liveWorkers.set(target, live);
    target.on('message', (msg) => {
      if (target !== worker || !msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        // Every worker runs the durability barrier before it reports ready.
        workerReady = true;
        startAttempts = 0;
        lastStart = summarizeStart(now() - spawnedAt, msg.startPhases);
        if (state !== 'closing') state = 'ready';
        startDeferred?.resolve();
        pump();
      } else if (msg.type === 'start_failed') {
        const err = fromJSON(msg.error) || hostError(STORAGE_ERROR_CODES.IO, 'Storage worker failed to start', {
          operation: 'worker_start',
          commitState: 'not_committed',
          retryable: false,
        });
        loseWorker(target, 'start_failed', err);
      } else if (msg.type === 'response') {
        onResponse(msg);
      }
    });
    // A message that cannot be deserialized leaves the in-flight outcome
    // unknown: treat it as a worker loss.
    target.on('messageerror', () => loseWorker(target, 'messageerror'));
    target.on('error', () => loseWorker(target, 'worker_error'));
    target.on('exit', () => {
      liveWorkers.delete(target);
      resolveExit();
      if (target === worker) {
        loseWorker(target, 'exit');
        return;
      }
      const next = live.onExit;
      live.onExit = null;
      next?.();
    });
  }

  /**
   * Start the worker. Resolves once the store is open and the worker is
   * ready; rejects with the typed open error when the start fails for good.
   *
   * @returns {Promise<void>}
   */
  function start() {
    if (state === 'closing' || state === 'closed') {
      return Promise.reject(hostError(STORAGE_ERROR_CODES.IO, 'Storage host closed', {
        operation: 'shutdown',
        commitState: 'not_committed',
        retryable: false,
      }));
    }
    if (state === 'failed') return Promise.reject(failure);
    if (startDeferred) return startDeferred.promise;
    if (orphanWorkers.has(dbKey)) {
      // Nothing changes state: start() may be called again once it exited.
      return Promise.reject(hostError(STORAGE_ERROR_CODES.BUSY, 'A previous storage worker on this database has not exited', {
        operation: 'previous_worker_alive',
        commitState: 'not_committed',
        retryable: true,
      }));
    }
    /** @type {any} */
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });
    startDeferred = deferred;
    if (state === 'idle') spawn(true);
    return deferred.promise;
  }

  /**
   * @param {string} kind
   * @param {unknown} name
   * @param {unknown} payload
   * @param {StorageRequestOptions} [opts]
   * @returns {Promise<unknown>}
   */
  function request(kind, name, payload, opts = {}) {
    /** @type {ReturnType<typeof validateRequest>} */
    let req;
    try {
      req = validateRequest(kind, name, opts);
    } catch (err) {
      counters.rejectedInvalid += 1;
      return Promise.reject(err);
    }
    return enqueue(kind, name, req, () => toWireJson(payload));
  }

  /**
   * @param {string} kind
   * @param {unknown} name
   * @param {ReturnType<typeof validateRequest>} req
   * @param {() => { json: string, bytes: number }} snapshot
   * @returns {Promise<unknown>}
   */
  function enqueue(kind, name, req, snapshot) {
    const { commandId, priority, signal, deadlineMs, requireReceipt, fenceEpoch } = req;
    if (state === 'failed') return Promise.reject(withNotCommitted(/** @type {StorageError} */ (failure), commandId));
    if (state === 'closing' || state === 'closed') {
      return Promise.reject(hostError(STORAGE_ERROR_CODES.IO, 'Storage host is shutting down', {
        operation: 'shutdown',
        commitState: 'not_committed',
        retryable: false,
        commandId,
      }));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    // The snapshot: the worker receives exactly this text, whatever the caller
    // does with `payload` afterwards.
    /** @type {{ json: string, bytes: number }} */
    let wire;
    try {
      wire = snapshot();
    } catch (err) {
      counters.rejectedInvalid += 1;
      if (isStorageError(err)) return Promise.reject(err);
      return Promise.reject(hostError(STORAGE_ERROR_CODES.IO, 'Storage payload is not plain JSON', {
        operation: 'payload_invalid',
        commitState: 'not_committed',
        retryable: false,
        commandId,
        cause: err,
      }));
    }
    if (wire.bytes > maxRequestBytes) {
      counters.rejectedInvalid += 1;
      return Promise.reject(invalidRequest('Storage payload exceeds the request size limit', 'payload_too_large', commandId));
    }
    const settled = new Promise((resolve, reject) => {
      // The request id exists before dispatch and stays stable for its lifetime.
      const id = randomUUID();
      const onAbort = () => {
        // Only a request still in the queue can be cancelled; a dispatched one
        // settles with its real outcome.
        if (!queue.remove(id)) return;
        counters.aborted += 1;
        takePending(id)?.reject(signal?.reason);
        pump();
      };
      try {
        queue.push({
          id,
          priority,
          sizeBytes: wire.bytes,
          deadlineMs,
          kind,
          name,
          payloadJson: wire.json,
          commandId,
          requireReceipt,
          fenceEpoch,
        });
      } catch (err) {
        if (isStorageError(err)) {
          if (/** @type {StorageError} */ (err).code === STORAGE_ERROR_CODES.BUSY) counters.rejectedBusy += 1;
          else counters.rejectedInvalid += 1;
          reject(withCommandId(/** @type {StorageError} */ (err), commandId));
        } else {
          reject(err);
        }
        return;
      }
      // `signal` is a validated AbortSignal, so attaching cannot throw.
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        commandId,
        enqueuedAt: now(),
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      pump();
    });
    // A caller that drops the promise (fire-and-forget) must not turn a queue expiry or a rejected request into a
    // process-fatal unhandledRejection: the failure is already counted (`expired`, `failed`) and a request that
    // never ran is `not_committed`. Callers that await still receive the rejection.
    settled.catch(() => {});
    return settled;
  }

  /**
   * @param {Promise<unknown>} promise
   * @param {number} ms
   * @returns {Promise<boolean>} true when `promise` settled first
   */
  async function settlesWithin(promise, ms) {
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([promise.then(() => true), timedOut]);
    clearTimeout(timer);
    return /** @type {boolean} */ (result);
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  async function runClose(timeoutMs) {
    const previous = state;
    state = 'closing';
    // A never-started or failed host has no worker coming: reject at once.
    if (previous !== 'failed' && previous !== 'idle') {
      const idle = new Promise((resolve) => {
        idleWaiters.push(() => resolve(undefined));
        notifyIdle();
      });
      await settlesWithin(idle, timeoutMs);
    }
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    for (const entry of queue.drainAll()) {
      rejectPending(entry.id, hostError(STORAGE_ERROR_CODES.IO, 'Storage host shut down before dispatch', {
        operation: 'shutdown',
        commitState: 'not_committed',
        retryable: false,
        commandId: /** @type {any} */ (entry).commandId,
      }));
    }
    const target = worker;
    if (target) {
      if (inFlight || !workerReady) {
        loseWorker(target, 'shutdown_timeout');
      } else {
        target.postMessage({ type: 'shutdown' });
        const exited = liveWorkers.get(target)?.exited || Promise.resolve();
        if (!(await settlesWithin(exited, timeoutMs))) loseWorker(target, 'shutdown_timeout');
      }
    }
    // Wait for every thread (including one lost earlier) to really exit.
    await settlesWithin(Promise.all([...liveWorkers.values()].map((w) => w.exited)), timeoutMs);
    for (const [thread, live] of liveWorkers) registerOrphan(dbKey, thread, live.exited);
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    state = 'closed';
    startDeferred?.reject(hostError(STORAGE_ERROR_CODES.IO, 'Storage host closed', {
      operation: 'shutdown',
      commitState: 'not_committed',
      retryable: false,
    }));
  }

  /**
   * Graceful shutdown: refuse new requests, drain the queue for up to
   * `timeoutMs`, then reject what is left (not_committed), terminate a worker
   * that is still executing (its command becomes unknown_commit) and close
   * the database inside the worker. Concurrent calls share one shutdown.
   *
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<void>}
   */
  function close(opts = {}) {
    if (closePromise) return closePromise;
    let timeoutMs;
    try {
      timeoutMs = positiveNumber(opts.timeoutMs, 'timeoutMs', DEFAULT_SHUTDOWN_TIMEOUT_MS);
    } catch (err) {
      return Promise.reject(err);
    }
    closePromise = runClose(timeoutMs);
    return closePromise;
  }

  /**
   * @param {number} spawnToReadyMs wall time from `new Worker` to `ready`
   * @param {unknown} phases worker-reported `{ registryMs, openMs, barrierMs }`
   */
  function summarizeStart(spawnToReadyMs, phases) {
    const read = (key) => (phases && Number.isFinite(phases[key]) ? Number(phases[key]) : null);
    const registryMs = read('registryMs');
    const openMs = read('openMs');
    const barrierMs = read('barrierMs');
    const known = [registryMs, openMs, barrierMs];
    const inWorkerMs = known.every((value) => value !== null) ? known.reduce((sum, value) => sum + value, 0) : null;
    return {
      spawnToReadyMs,
      registryMs,
      openMs,
      barrierMs,
      // Thread creation, module load of the worker entry and message latency.
      threadOverheadMs: inWorkerMs === null ? null : Math.max(0, spawnToReadyMs - inWorkerMs),
    };
  }

  /**
   * Secret-free runtime metrics (counts and timings only).
   */
  function getMetrics() {
    return {
      state,
      generation,
      restarts,
      startAttempts,
      lastStart: lastStart ? { ...lastStart } : null,
      inFlight: Boolean(inFlight),
      inFlightAgeMs: inFlight ? now() - inFlight.startedAt : 0,
      queue: queue.metrics(),
      executeMs: summarize(executeSamples),
      requestMs: summarize(requestSamples),
      counters: { ...counters },
      byPriority: Object.fromEntries(Object.entries(byPriority).map(([k, v]) => [k, { ...v }])),
    };
  }

  return Object.freeze({
    writeGate: options.writeGate,
    start,
    close,
    getMetrics,
    /**
     * @param {string} name
     * @param {unknown} payload
     * @param {StorageRequestOptions} [opts]
     */
    command: (name, payload, opts) => request('command', name, payload, opts),
    /**
     * @param {string} name
     * @param {unknown} payload
     * @param {StorageRequestOptions} [opts]
     */
    query: (name, payload, opts) => request('query', name, payload, opts),
    /**
     * @param {'ping' | 'checkpoint' | 'fence'} op
     * @param {StorageRequestOptions} [opts]
     */
    control: (op, opts) => request('control', op, null, opts),
    /**
     * Group commit (S5): run several receipt-wrapped commands in ONE worker
     * transaction. `members` are `{ name, commandId, payloadJson }` where
     * `payloadJson` is a `toWireJson` snapshot of a receipt envelope. Resolves
     * with the worker's per-member outcome object (lib/storage/group-commit.md);
     * rejects (whole batch) like a command: `unknown_commit` on worker loss.
     *
     * @param {Array<{ name: string, commandId: string, payloadJson: string }>} members
     * @param {{ priority?: string, deadlineMs?: number, signal?: AbortSignal }} [opts]
     */
    commandBatch: (members, opts = {}) => {
      let req;
      try {
        if (opts && typeof opts === 'object' && /** @type {any} */ (opts).commandId !== undefined) {
          throw invalidRequest('Storage batch options take no commandId');
        }
        req = validateRequest('batch', BATCH_REQUEST_NAME, opts);
      } catch (err) {
        counters.rejectedInvalid += 1;
        return Promise.reject(err);
      }
      return enqueue('batch', BATCH_REQUEST_NAME, req, () => buildBatchWire(members));
    },
  });
}
