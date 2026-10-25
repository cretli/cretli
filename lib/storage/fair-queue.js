/**
 * Bounded fair request queue for the storage worker host (A2 S3).
 *
 * Pure data structure: no timers, no worker, no I/O. Time comes from an
 * injected `now()` so scheduling is unit-testable with a fake clock.
 *
 * Scheduling algorithm (strict priority with a bounded aging bypass):
 *   - classes, highest first: stop > claim > intent > final > normal; every
 *     class is a FIFO, so a dispatch compares at most five class heads (O(1));
 *   - the default pick is the head of the highest non-empty class (strict);
 *   - a head that has waited at least `agingMs` (default 250) is "aged". When
 *     the strict pick passes over an aged head of a LOWER class, a pass-over
 *     counter is incremented; once it reaches `bypassEvery` (K, default 4) and
 *     an aged lower head exists, the oldest aged lower head (arrival order) is
 *     dispatched instead and the counter resets to 0. At most one bypass is
 *     therefore served per K strict dispatches that passed over aged work.
 *
 * Worst-case bounds (S = longest single transaction, one request in flight):
 *   - a request at the head of its class waits for the in-flight transaction,
 *     at most ONE bypass and the requests of strictly higher classes; for
 *     `stop` that is `<= 2 * S` plus earlier `stop` requests (FIFO). Nothing a
 *     lower class does can delay a higher class by more than one bypass;
 *   - under continuous higher-priority load an aged lower head is served
 *     within K + 1 dispatches after it ages, so the lower classes together
 *     keep at least 1/(K+1) of the dispatch slots. A lower request that has
 *     n aged lower requests ahead of it waits at most
 *     `agingMs + (n + 1) * (K + 1) * S`;
 *   - under SUSTAINED priority overload (priority arrivals faster than the
 *     worker drains them) normal requests can still wait long: the hard limit
 *     is `maxAgeMs` (or the request deadline), after which the request expires
 *     with a retryable `busy` (never dispatched, so not committed).
 *
 * Bounds: `maxDepth` requests, `maxBytes` of payload and `maxAgeMs` of queue
 * age. A push that would exceed depth or bytes is refused with a retryable
 * `busy` StorageError instead of growing the queue (backpressure); a single
 * request larger than `maxBytes` can never fit and is refused with a
 * non-retryable `io` (`payload_too_large`). A request older than its own
 * deadline or `maxAgeMs` is expired by `expireDue()` before it is ever
 * dispatched, so it is known not to have committed.
 */
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';

/** Priority classes, highest first. Values are part of the worker protocol. */
export const STORAGE_PRIORITIES = Object.freeze(['stop', 'claim', 'intent', 'final', 'normal']);

export const DEFAULT_MAX_QUEUE_DEPTH = 1024;
export const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_QUEUE_AGE_MS = 5000;
/** Queue age after which a lower-class head may take a bypass slot. */
export const DEFAULT_AGING_MS = 250;
/** K: strict dispatches passing over aged work per one bypass. */
export const DEFAULT_BYPASS_EVERY = 4;

/** Rolling window for dispatched queue-age percentiles. */
const AGE_SAMPLE_WINDOW = 4096;

/**
 * @typedef {{
 *   id: string,
 *   priority: string,
 *   sizeBytes: number,
 *   deadlineMs?: number,
 *   [key: string]: unknown,
 * }} FairQueueInput
 */

/**
 * @typedef {FairQueueInput & {
 *   enqueuedAt: number,
 *   expiresAt: number,
 *   seq: number,
 * }} FairQueueEntry
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || /** @type {number} */ (value) <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return /** @type {number} */ (value);
}

/**
 * Nearest-rank percentile of an unsorted sample list.
 *
 * @param {number[]} samples
 * @param {number} p 0..100
 * @returns {number | null}
 */
export function percentile(samples, p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

/**
 * @param {string} operation
 * @param {Record<string, unknown>} [extra]
 * @returns {StorageError}
 */
function busyError(operation, extra = {}) {
  return new StorageError(STORAGE_ERROR_CODES.BUSY, `Storage queue refused request (${operation})`, {
    retryable: true,
    details: { operation, commitState: 'not_committed', ...extra },
  });
}

/**
 * @param {string} operation
 * @returns {StorageError}
 */
function tooLargeError(operation) {
  return new StorageError(STORAGE_ERROR_CODES.IO, `Storage request can never fit (${operation})`, {
    retryable: false,
    details: { operation, commitState: 'not_committed' },
  });
}

/**
 * @param {{
 *   now?: () => number,
 *   maxDepth?: number,
 *   maxBytes?: number,
 *   maxAgeMs?: number,
 *   agingMs?: number,
 *   bypassEvery?: number,
 *   priorities?: readonly string[],
 * }} [options] `priorities` overrides the class list (highest first); the job
 *   queue reuses this scheduler with its own interactive/cycle/maintenance classes.
 */
export function createFairQueue(options = {}) {
  const now = options.now || (() => performance.now());
  const maxDepth = positiveInt(options.maxDepth, 'maxDepth', DEFAULT_MAX_QUEUE_DEPTH);
  const maxBytes = positiveInt(options.maxBytes, 'maxBytes', DEFAULT_MAX_QUEUE_BYTES);
  const maxAgeMs = positiveInt(options.maxAgeMs, 'maxAgeMs', DEFAULT_MAX_QUEUE_AGE_MS);
  const agingMs = positiveInt(options.agingMs, 'agingMs', DEFAULT_AGING_MS);
  const bypassEvery = positiveInt(options.bypassEvery, 'bypassEvery', DEFAULT_BYPASS_EVERY);
  const priorities = options.priorities ?? STORAGE_PRIORITIES;
  if (!Array.isArray(priorities) || priorities.length === 0 || priorities.some((p) => typeof p !== 'string' || !p)) {
    throw new TypeError('priorities must be a non-empty list of class names');
  }
  /** @type {Map<string, FairQueueEntry[]>} */
  const classes = new Map(priorities.map((p) => [p, []]));
  /** @type {Map<string, FairQueueEntry>} */
  const byId = new Map();
  let bytes = 0;
  let seq = 0;
  /** Strict dispatches that passed over an aged lower-class head since the last bypass. */
  let passedOver = 0;
  /** @type {number[]} */
  const ageSamples = [];
  const counters = { enqueued: 0, dispatched: 0, bypassed: 0, rejectedBusy: 0, rejectedTooLarge: 0, expired: 0, removed: 0 };

  /**
   * @param {FairQueueEntry} entry
   */
  function unlink(entry) {
    const list = /** @type {FairQueueEntry[]} */ (classes.get(entry.priority));
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    byId.delete(entry.id);
    bytes -= entry.sizeBytes;
  }

  /**
   * Enqueue a request. Throws a retryable `busy` StorageError (commitState
   * not_committed) when depth or bytes would overflow, a non-retryable `io`
   * (`payload_too_large`) when the request alone exceeds `maxBytes`, and a
   * TypeError for an invalid request shape.
   *
   * @param {FairQueueInput} input
   * @returns {FairQueueEntry}
   */
  function push(input) {
    if (!input || typeof input.id !== 'string' || input.id.length === 0) throw new TypeError('Request id is required');
    if (!classes.has(input.priority)) throw new TypeError(`Unknown storage priority: ${String(input.priority)}`);
    if (byId.has(input.id)) throw new TypeError('Duplicate request id');
    const sizeBytes = input.sizeBytes;
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0) throw new TypeError('sizeBytes must be a non-negative integer');
    if (input.deadlineMs !== undefined && (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0)) {
      throw new TypeError('deadlineMs must be a positive number');
    }
    if (sizeBytes > maxBytes) {
      counters.rejectedTooLarge += 1;
      throw tooLargeError('payload_too_large');
    }
    if (byId.size + 1 > maxDepth) {
      counters.rejectedBusy += 1;
      throw busyError('queue_depth');
    }
    if (bytes + sizeBytes > maxBytes) {
      counters.rejectedBusy += 1;
      throw busyError('queue_bytes');
    }
    const enqueuedAt = now();
    const ttl = Math.min(maxAgeMs, input.deadlineMs ?? maxAgeMs);
    /** @type {FairQueueEntry} */
    const entry = {
      ...input,
      enqueuedAt,
      expiresAt: enqueuedAt + ttl,
      seq: seq++,
    };
    /** @type {FairQueueEntry[]} */ (classes.get(input.priority)).push(entry);
    byId.set(entry.id, entry);
    bytes += sizeBytes;
    counters.enqueued += 1;
    return entry;
  }

  /**
   * Remove and return every request whose deadline or max age has passed.
   * They were never dispatched, so they are known not to have committed.
   *
   * @returns {FairQueueEntry[]}
   */
  function expireDue() {
    const t = now();
    /** @type {FairQueueEntry[]} */
    const expired = [];
    for (const list of classes.values()) {
      for (const entry of list) if (entry.expiresAt <= t) expired.push(entry);
    }
    for (const entry of expired) unlink(entry);
    counters.expired += expired.length;
    return expired;
  }

  /**
   * Dequeue the next request (strict class order with the bounded aging
   * bypass described in the module comment), or null. Callers run
   * `expireDue()` first so an expired request is never dispatched.
   *
   * @returns {FairQueueEntry | null}
   */
  function shift() {
    const t = now();
    const agedBefore = t - agingMs;
    /** @type {FairQueueEntry | null} */
    let strict = null;
    /** @type {FairQueueEntry | null} */
    let agedLower = null;
    for (const list of classes.values()) {
      const head = list[0];
      if (!head) continue;
      if (!strict) {
        strict = head;
        continue;
      }
      if (head.enqueuedAt <= agedBefore && (!agedLower || head.seq < agedLower.seq)) agedLower = head;
    }
    if (!strict) return null;
    let next = strict;
    if (agedLower && passedOver >= bypassEvery) {
      next = agedLower;
      passedOver = 0;
      counters.bypassed += 1;
    } else if (agedLower) {
      passedOver += 1;
    }
    unlink(next);
    counters.dispatched += 1;
    ageSamples.push(t - next.enqueuedAt);
    if (ageSamples.length > AGE_SAMPLE_WINDOW) ageSamples.shift();
    return next;
  }

  /**
   * Remove a queued (not yet dispatched) request, e.g. on abort.
   *
   * @param {string} id
   * @returns {FairQueueEntry | null} the removed entry, or null when unknown
   */
  function remove(id) {
    const entry = byId.get(id);
    if (!entry) return null;
    unlink(entry);
    counters.removed += 1;
    return entry;
  }

  /**
   * Remove and return every queued request (shutdown/failure).
   *
   * @returns {FairQueueEntry[]}
   */
  function drainAll() {
    const all = [...byId.values()].sort((a, b) => a.seq - b.seq);
    for (const entry of all) unlink(entry);
    counters.removed += all.length;
    return all;
  }

  /**
   * Time (ms from now) until the earliest queued expiry, or null when empty.
   *
   * @returns {number | null}
   */
  function msUntilNextExpiry() {
    let earliest = Infinity;
    for (const entry of byId.values()) earliest = Math.min(earliest, entry.expiresAt);
    return earliest === Infinity ? null : Math.max(0, earliest - now());
  }

  /**
   * Secret-free metrics: counts, bytes and ages only, never payloads or names.
   */
  function metrics() {
    const t = now();
    /** @type {Record<string, number>} */
    const depthByPriority = {};
    let oldest = null;
    for (const [priority, list] of classes) {
      depthByPriority[priority] = list.length;
      for (const entry of list) if (oldest === null || entry.enqueuedAt < oldest) oldest = entry.enqueuedAt;
    }
    return {
      depth: byId.size,
      bytes,
      maxDepth,
      maxBytes,
      maxAgeMs,
      agingMs,
      bypassEvery,
      depthByPriority,
      oldestAgeMs: oldest === null ? 0 : t - oldest,
      counters: { ...counters },
      queueAgeMs: {
        n: ageSamples.length,
        p50: percentile(ageSamples, 50),
        p95: percentile(ageSamples, 95),
        p99: percentile(ageSamples, 99),
        max: ageSamples.length ? Math.max(...ageSamples) : null,
      },
    };
  }

  return Object.freeze({
    push,
    shift,
    remove,
    expireDue,
    drainAll,
    msUntilNextExpiry,
    metrics,
    get size() {
      return byId.size;
    },
  });
}
