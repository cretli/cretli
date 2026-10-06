/**
 * Opt-in freeze instrumentation counters and span statistics.
 *
 * This is the measurement layer added for task 0.1 (baseline before any
 * behaviour change). It answers "how many times did the poll apply UI, how
 * many storage reads did one boot-cache build cost, how long was the layout
 * apply" — numbers the `PerformanceObserver('longtask')` path cannot give,
 * because a long task is only reported *after* it finishes.
 *
 * Contract:
 * - Every entry point checks the shared `uiFreezeTrace` flag (default off).
 *   When it is off, `getUiFreezeCounters()` returns `null` and the callers
 *   skip all work, so the production path keeps its previous cost.
 * - Nothing here records chat titles, message bodies, drafts or any other
 *   conversation content. Only ids/keys that the caller already handles,
 *   counts, and durations cross this boundary.
 * - All state is created lazily on the first observation taken while active.
 *   A closed 1-second window is folded into one `snapshot` trace entry, so the
 *   Logs panel "freeze" filter stays readable during a stall.
 *
 * The module is DOM-free so it can be unit-tested under `node`.
 */

import { beginSpan, endSpan } from './chatPerfBudget.js';
import { isUiFreezeTraceActive, traceUiFreeze } from './uiFreezeTrace.js';

/** Category used in the `ui-freeze-trace` log line: `freeze-counters:<event>`. */
export const UI_FREEZE_COUNTERS_CATEGORY = 'freeze-counters';

/**
 * Qualification buckets used by `selectMonitoredChatIds`. Kept in the same
 * order as the selection checks so a report reads naturally.
 */
export const MONITORING_REASON_NAMES = Object.freeze([
  'active',
  'recent',
  'live',
  'busy',
  'waiting',
  'attention',
]);

/** Span names added by task 0.1. */
export const INSTRUMENTED_SPAN_NAMES = Object.freeze([
  'history.poll.apply',
  'history.replay',
  'boot-cache.build',
  'boot-cache.hydrate',
  'sidebar.layout.apply',
  'sidebar.archive.render',
]);

/** @typedef {{ count: number, totalMs: number, maxMs: number, lastMs: number }} SpanStat */

/**
 * @param {unknown} value
 * @returns {number}
 */
function asNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * @param {{ now?: () => number, active?: () => boolean, trace?: (category: string, event: string, payload?: object) => void, windowMs?: number }} [options]
 */
export function createUiFreezeCounters(options = {}) {
  const nowFn = options.now || (() => Date.now());
  const active = options.active || (() => true);
  const trace = options.trace || (() => {});
  const windowMs = options.windowMs || 1000;

  let built = false;
  /** @type {number | null} */
  let epoch = null;
  /** @type {Map<string, number>} */
  let counters = new Map();
  /** @type {Map<string, SpanStat>} */
  let spans = new Map();
  let mountedRows = 0;
  let mountedRowsMax = 0;
  const pending = {
    batches: 0,
    setTrue: 0,
    setFalse: 0,
    lastBatchNet: 0,
  };
  /** Flips observed inside the currently open poll batch. */
  let openBatch = null;
  /** @type {Map<string, number>} */
  let monitoring = new Map();
  /** Raw candidate reasons (pre-archive-gate, the "before" side). @type {Map<string, number>} */
  let monitoringCandidates = new Map();

  function build() {
    if (built) return;
    built = true;
    epoch = Math.floor(nowFn() / windowMs);
  }

  /** @returns {Record<string, unknown>} */
  function snapshotPayload(epochForCounts) {
    /** @type {Record<string, number>} */
    const counterOut = {};
    for (const [key, value] of counters) counterOut[key] = value;
    /** @type {Record<string, SpanStat>} */
    const spanOut = {};
    for (const [key, value] of spans) spanOut[key] = { ...value };
    /** @type {Record<string, number>} */
    const monitoringOut = {};
    for (const [key, value] of monitoring) monitoringOut[key] = value;
    /** @type {Record<string, number>} */
    const monitoringCandidateOut = {};
    for (const [key, value] of monitoringCandidates) monitoringCandidateOut[key] = value;
    return {
      windowMs,
      epoch: epochForCounts,
      counters: counterOut,
      spans: spanOut,
      mountedRows: { last: mountedRows, max: mountedRowsMax },
      pending: {
        batches: pending.batches,
        setTrue: pending.setTrue,
        setFalse: pending.setFalse,
        net: pending.setTrue - pending.setFalse,
        lastBatchNet: pending.lastBatchNet,
      },
      monitoring: monitoringOut,
      monitoringCandidates: monitoringCandidateOut,
    };
  }

  function emit(epochForCounts) {
    trace(UI_FREEZE_COUNTERS_CATEGORY, 'snapshot', snapshotPayload(epochForCounts));
  }

  function resetWindow() {
    counters = new Map();
    spans = new Map();
    mountedRows = 0;
    mountedRowsMax = 0;
    pending.batches = 0;
    pending.setTrue = 0;
    pending.setFalse = 0;
    pending.lastBatchNet = 0;
    monitoring = new Map();
    monitoringCandidates = new Map();
  }

  /**
   * Guards on the shared flag, materialises lazily, and rolls the window.
   * @returns {boolean}
   */
  function touch() {
    if (!active()) return false;
    build();
    const currentEpoch = Math.floor(nowFn() / windowMs);
    if (epoch !== null && currentEpoch !== epoch) {
      emit(epoch);
      resetWindow();
      epoch = currentEpoch;
    }
    return true;
  }

  return {
    /** @returns {boolean} true once any active observation materialised the meter */
    allocated() {
      return built;
    },
    /**
     * @param {string} name
     * @param {number} [by]
     */
    bump(name, by = 1) {
      if (!touch()) return;
      const key = String(name || 'counter');
      counters.set(key, (counters.get(key) || 0) + asNumber(by));
    },
    /**
     * Emits a `span-start` line before the timed work runs, so a freeze that
     * never returns still leaves the path (and its fields) in the Logs buffer.
     * @param {string} name
     * @param {Record<string, unknown>} [fields]
     */
    recordSpanStart(name, fields) {
      if (!touch()) return;
      trace(UI_FREEZE_COUNTERS_CATEGORY, 'span-start', {
        name: String(name || 'span'),
        ...(fields || {}),
      });
    },
    /**
     * @param {string} name
     * @param {number} durationMs
     * @param {Record<string, unknown>} [fields]
     */
    recordSpan(name, durationMs, fields) {
      if (!touch()) return;
      const key = String(name || 'span');
      const duration = asNumber(durationMs);
      const stat = spans.get(key) || { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
      stat.count += 1;
      stat.totalMs += duration;
      if (duration > stat.maxMs) stat.maxMs = duration;
      stat.lastMs = duration;
      spans.set(key, stat);
      trace(UI_FREEZE_COUNTERS_CATEGORY, 'span', {
        name: key,
        durationMs: Math.round(duration),
        ...(fields || {}),
      });
    },
    /**
     * Last sidebar row count after a render, plus the window maximum.
     * @param {number} rows
     */
    recordMountedRows(rows) {
      if (!touch()) return;
      const count = Math.max(0, Math.round(asNumber(rows)));
      mountedRows = count;
      if (count > mountedRowsMax) mountedRowsMax = count;
    },
    /**
     * Opens a pending-flip batch (one `runChatHistoryRevisionPoll` pass).
     */
    beginPendingBatch() {
      if (!touch()) return;
      openBatch = { setTrue: 0, setFalse: 0 };
    },
    /**
     * @param {boolean} toTrue
     */
    recordPendingFlip(toTrue) {
      if (!touch()) return;
      if (toTrue) {
        pending.setTrue += 1;
        if (openBatch) openBatch.setTrue += 1;
        return;
      }
      pending.setFalse += 1;
      if (openBatch) openBatch.setFalse += 1;
    },
    /**
     * Closes the batch and stores its net change (true minus false).
     * @returns {number}
     */
    endPendingBatch() {
      if (!touch()) return 0;
      if (!openBatch) return pending.lastBatchNet;
      const net = openBatch.setTrue - openBatch.setFalse;
      pending.batches += 1;
      pending.lastBatchNet = net;
      openBatch = null;
      return net;
    },
    /**
     * @param {{ reason: string, archived?: boolean }} input
     */
    recordMonitoringQualification(input) {
      if (!touch()) return;
      const reason = MONITORING_REASON_NAMES.includes(input?.reason) ? input.reason : 'unknown';
      const key = `${reason}|archived=${input?.archived === true}`;
      monitoring.set(key, (monitoring.get(key) || 0) + 1);
    },
    /**
     * Raw candidate reason before the archive gate. Same key shape as
     * `recordMonitoringQualification`, so "before" minus "after" is the count
     * of archived rows the 3.1 gate removed from monitoring.
     * @param {{ reason: string, archived?: boolean }} input
     */
    recordMonitoringCandidate(input) {
      if (!touch()) return;
      const reason = MONITORING_REASON_NAMES.includes(input?.reason) ? input.reason : 'unknown';
      const key = `${reason}|archived=${input?.archived === true}`;
      monitoringCandidates.set(key, (monitoringCandidates.get(key) || 0) + 1);
    },
    /** @returns {Record<string, unknown>} */
    snapshot() {
      return snapshotPayload(epoch);
    },
    /** Force-emits the still-open window (baseline wrap-up / pagehide). */
    flush() {
      if (!built) return;
      emit(epoch);
    },
    /** @param {number} [toEpoch] */
    reset(toEpoch) {
      resetWindow();
      built = false;
      epoch = toEpoch === undefined ? null : asNumber(toEpoch);
      openBatch = null;
    },
  };
}

/** @type {ReturnType<typeof createUiFreezeCounters> | null} */
let shared = null;

/**
 * Shared meter. Returns `null` while the freeze diagnostics flag is off, so
 * callers can use `getUiFreezeCounters()?.bump(...)` on hot paths.
 * @returns {ReturnType<typeof createUiFreezeCounters> | null}
 */
export function getUiFreezeCounters() {
  if (!isUiFreezeTraceActive()) return null;
  if (!shared) {
    shared = createUiFreezeCounters({
      trace: (category, event, payload) => traceUiFreeze(category, event, payload),
      active: isUiFreezeTraceActive,
    });
  }
  return shared;
}

/**
 * Times `fn` in the shared budget span stack (so a later long-task observer can
 * attribute the stall) and folds the duration into the counter snapshot.
 * A no-op wrapper when diagnostics are off.
 * @template T
 * @param {string} name
 * @param {Record<string, unknown>} [fields]
 * @param {() => T} fn
 * @returns {T}
 */
export function measureFreezeSpan(name, fields, fn) {
  const counters = getUiFreezeCounters();
  if (!counters) return fn();
  counters.recordSpanStart(name, fields);
  beginSpan(name, fields || {});
  try {
    return fn();
  } finally {
    const closed = endSpan();
    counters.recordSpan(name, closed ? closed.durationMs : 0, fields);
  }
}

/**
 * Emits the still-open counter window. Call before the page can be killed.
 */
export function flushUiFreezeCounters() {
  if (shared) shared.flush();
}

/**
 * @returns {Record<string, unknown> | null}
 */
export function snapshotUiFreezeCounters() {
  return shared ? shared.snapshot() : null;
}

/**
 * Flattens a snapshot into `metric=value` lines for the Logs panel / a bug
 * report. Never includes chat content.
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @returns {string}
 */
export function formatUiFreezeCountersSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const lines = [];
  const counters = /** @type {Record<string, number>} */ (snapshot.counters || {});
  for (const key of Object.keys(counters).sort()) {
    lines.push(`${key}=${counters[key]}`);
  }
  const spans = /** @type {Record<string, SpanStat>} */ (snapshot.spans || {});
  for (const key of Object.keys(spans).sort()) {
    const stat = spans[key];
    lines.push(
      `span:${key} count=${stat.count} last=${Math.round(stat.lastMs)}ms max=${Math.round(stat.maxMs)}ms total=${Math.round(stat.totalMs)}ms`
    );
  }
  const mounted = /** @type {{ last?: number, max?: number }} */ (snapshot.mountedRows || {});
  lines.push(`rows.last=${mounted.last || 0} rows.max=${mounted.max || 0}`);
  const pendingStats = /** @type {{ batches?: number, setTrue?: number, setFalse?: number, net?: number, lastBatchNet?: number }} */ (snapshot.pending || {});
  lines.push(
    `pending.batches=${pendingStats.batches || 0} setTrue=${pendingStats.setTrue || 0} setFalse=${pendingStats.setFalse || 0} net=${pendingStats.net || 0} lastBatchNet=${pendingStats.lastBatchNet || 0}`
  );
  const monitoring = /** @type {Record<string, number>} */ (snapshot.monitoring || {});
  for (const key of Object.keys(monitoring).sort()) {
    lines.push(`monitoring:${key}=${monitoring[key]}`);
  }
  const candidates = /** @type {Record<string, number>} */ (snapshot.monitoringCandidates || {});
  for (const key of Object.keys(candidates).sort()) {
    lines.push(`monitoringCandidate:${key}=${candidates[key]}`);
  }
  return lines.join('\n');
}

/**
 * Test seam: drops the singleton so a test can rebuild it with fresh state.
 */
export function __resetUiFreezeCountersForTest() {
  shared = null;
}
