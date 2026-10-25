/**
 * Time-sliced work with scheduler.yield (when available) or macrotask fallback.
 * Microtasks (Promise.resolve().then) are intentionally not used as a yield path.
 */

/** @typedef {'scheduler' | 'messageChannel' | 'setTimeout'} YieldMode */

/** Default wall-clock budget per synchronous slice (~8 ms, calibrate with `now()`). */
export const DEFAULT_SLICE_BUDGET_MS = 8;

/** Reference item count when calibrating slice budget in Node microbenchmarks (task 8.1). */
export const SLICE_BUDGET_CALIBRATION_ITEMS = 400;

/** @typedef {object} SliceToken
 * @property {number} generation
 * @property {number} revision
 */

/** @typedef {object} SchedulerYieldDeps
 * @property {() => number} [now]
 * @property {{ yield?: () => Promise<void> } | undefined} [scheduler]
 * @property {typeof MessageChannel | undefined} [MessageChannel]
 * @property {typeof setTimeout} [setTimeoutFn]
 * @property {typeof clearTimeout} [clearTimeoutFn]
 * @property {typeof requestAnimationFrame | undefined} [requestAnimationFrameFn]
 * @property {typeof cancelAnimationFrame | undefined} [cancelAnimationFrameFn]
 * @property {Document | { hidden?: boolean } | undefined} [documentRef]
 */

/**
 * @returns {SchedulerYieldDeps}
 */
export function createDefaultSchedulerYieldDeps() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  return {
    now: () => {
      if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
      }
      return Date.now();
    },
    scheduler: g.scheduler,
    MessageChannel: typeof MessageChannel !== 'undefined' ? MessageChannel : undefined,
    setTimeoutFn: typeof setTimeout === 'function' ? setTimeout : undefined,
    clearTimeoutFn: typeof clearTimeout === 'function' ? clearTimeout : undefined,
    requestAnimationFrameFn:
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined,
    cancelAnimationFrameFn:
      typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined,
    documentRef: typeof document !== 'undefined' ? document : undefined,
  };
}

/**
 * Feature-detect scheduler.yield (never infer from user-agent).
 *
 * @param {SchedulerYieldDeps} [deps]
 * @returns {boolean}
 */
export function isSchedulerYieldSupported(deps = createDefaultSchedulerYieldDeps()) {
  return typeof deps.scheduler?.yield === 'function';
}

/**
 * @param {SchedulerYieldDeps} [deps]
 * @returns {YieldMode}
 */
export function resolvePreferredYieldMode(deps = createDefaultSchedulerYieldDeps()) {
  if (isSchedulerYieldSupported(deps)) return 'scheduler';
  if (deps.MessageChannel) return 'messageChannel';
  return 'setTimeout';
}

/** @type {Set<object>} */
const activeMessageChannelsForTest = new Set();

/**
 * @returns {number}
 */
export function getActiveMessageChannelCountForTest() {
  return activeMessageChannelsForTest.size;
}

export function __resetSchedulerYieldChannelsForTest() {
  activeMessageChannelsForTest.clear();
}

/**
 * @param {SchedulerYieldDeps} deps
 * @param {YieldMode} mode
 * @returns {Promise<void>}
 */
function yieldViaMode(deps, mode) {
  if (mode === 'scheduler') {
    const yieldFn = deps.scheduler?.yield;
    if (typeof yieldFn !== 'function') {
      return Promise.reject(new Error('scheduler.yield is not available'));
    }
    return yieldFn.call(deps.scheduler);
  }
  if (mode === 'messageChannel') {
    const MC = deps.MessageChannel;
    if (!MC) {
      return Promise.reject(new Error('MessageChannel is not available'));
    }
    return new Promise((resolve) => {
      const channel = new MC();
      activeMessageChannelsForTest.add(channel);
      const finish = () => {
        channel.port1.onmessage = null;
        try {
          channel.port1.close?.();
        } catch {
          /* ignore */
        }
        try {
          channel.port2.close?.();
        } catch {
          /* ignore */
        }
        activeMessageChannelsForTest.delete(channel);
        resolve();
      };
      channel.port1.onmessage = finish;
      channel.port2.postMessage(0);
    });
  }
  const setTimeoutFn = deps.setTimeoutFn;
  if (!setTimeoutFn) {
    return Promise.reject(new Error('setTimeout is not available'));
  }
  return new Promise((resolve) => {
    setTimeoutFn(resolve, 0);
  });
}

/**
 * Yield to a new task (macrotask or scheduler yield). Never uses Promise.resolve microtasks.
 *
 * @param {SchedulerYieldDeps} [deps]
 * @param {{ forceMode?: YieldMode }} [options]
 * @returns {Promise<YieldMode>}
 */
export async function yieldToNewTask(deps = createDefaultSchedulerYieldDeps(), options = {}) {
  const forced = options.forceMode;
  const mode = forced || resolvePreferredYieldMode(deps);
  await yieldViaMode(deps, mode);
  return mode;
}

/**
 * Cancellation / revision guard for chunked async work.
 */
export function createSliceSession() {
  let generation = 0;
  let revision = 0;
  return {
    /** @returns {number} */
    getGeneration() {
      return generation;
    },
    /** @returns {number} */
    getRevision() {
      return revision;
    },
    /** @returns {SliceToken} */
    captureToken() {
      return { generation, revision };
    },
    /** @param {SliceToken} token */
    isFresh(token) {
      return token.generation === generation && token.revision === revision;
    },
    cancel() {
      generation += 1;
    },
    /** @returns {number} */
    bumpRevision() {
      revision += 1;
      return revision;
    },
  };
}

/**
 * Invoke `fn` only when the token still matches the session (generation + revision).
 *
 * @param {ReturnType<typeof createSliceSession>} session
 * @param {SliceToken} token
 * @param {() => void} fn
 * @returns {boolean} true when `fn` ran
 */
export function applyIfFresh(session, token, fn) {
  if (!session.isFresh(token)) return false;
  fn();
  return true;
}

/**
 * @param {ReturnType<typeof createSliceSession>} session
 * @param {SliceToken} token
 * @param {T} value
 * @param {(value: T) => void} apply
 * @returns {boolean}
 * @template T
 */
export function applyValueIfFresh(session, token, value, apply) {
  if (!session.isFresh(token)) return false;
  apply(value);
  return true;
}

/**
 * Process items in time slices, yielding between slices. Does not apply results itself;
 * call `applyIfFresh` inside `onItem` when mutating external state.
 *
 * @param {Iterable<T>} items
 * @param {object} options
 * @param {(item: T, index: number) => void} options.onItem
 * @param {ReturnType<typeof createSliceSession>} [options.session]
 * @param {SchedulerYieldDeps} [options.deps]
 * @param {number} [options.budgetMs]
 * @param {YieldMode} [options.forceYieldMode]
 * @returns {Promise<{ processed: number, cancelled: boolean }>}
 * @template T
 */
export async function forEachInTimeSlices(items, options) {
  const deps = options.deps || createDefaultSchedulerYieldDeps();
  const session = options.session || createSliceSession();
  const budgetMs = options.budgetMs ?? DEFAULT_SLICE_BUDGET_MS;
  const list = [...items];
  let index = 0;
  while (index < list.length) {
    const token = session.captureToken();
    const sliceStart = deps.now();
    let itemsInSlice = 0;
    while (index < list.length) {
      if (!session.isFresh(token)) {
        return { processed: index, cancelled: true };
      }
      const withinBudget = itemsInSlice === 0 || deps.now() - sliceStart < budgetMs;
      if (!withinBudget) break;
      options.onItem(list[index], index);
      index += 1;
      itemsInSlice += 1;
    }
    if (index >= list.length) break;
    await yieldToNewTask(deps, { forceMode: options.forceYieldMode });
    if (!session.isFresh(token)) {
      return { processed: index, cancelled: true };
    }
  }
  return { processed: index, cancelled: false };
}

/**
 * Schedule a small DOM write on rAF. Correctness of slice continuations must not depend
 * on rAF firing (hidden tabs throttle rAF); use {@link yieldToNewTask} for pacing.
 *
 * @param {() => void} fn
 * @param {SchedulerYieldDeps} [deps]
 * @returns {number | null} rAF id, or null when rAF is unavailable (fn not scheduled)
 */
export function scheduleDomWrite(fn, deps = createDefaultSchedulerYieldDeps()) {
  const raf = deps.requestAnimationFrameFn;
  if (typeof raf !== 'function') return null;
  return raf(fn);
}

/**
 * @param {number | null} handle
 * @param {SchedulerYieldDeps} [deps]
 */
export function cancelDomWrite(handle, deps = createDefaultSchedulerYieldDeps()) {
  if (handle == null) return;
  const cancel = deps.cancelAnimationFrameFn;
  if (typeof cancel === 'function') cancel(handle);
}

/**
 * Whether the document is hidden (for diagnostics only; slice pacing uses macrotasks).
 *
 * @param {SchedulerYieldDeps} [deps]
 * @returns {boolean}
 */
export function isDocumentHidden(deps = createDefaultSchedulerYieldDeps()) {
  const doc = deps.documentRef;
  return Boolean(doc && doc.hidden);
}

/**
 * Measure how long a fixed number of `onItem` calls take; used to validate that the
 * default {@link DEFAULT_SLICE_BUDGET_MS} keeps each slice under the UI freeze budget.
 *
 * @param {number} itemCount
 * @param {(index: number) => void} onItem
 * @param {SchedulerYieldDeps} [deps]
 * @returns {number} duration in ms
 */
export function measureSyncChunkDurationMs(itemCount, onItem, deps = createDefaultSchedulerYieldDeps()) {
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  if (count === 0) return 0;
  const start = deps.now();
  for (let index = 0; index < count; index += 1) {
    onItem(index);
  }
  return deps.now() - start;
}

/**
 * Pick a slice budget from a representative per-item sample (defaults to ~8 ms target).
 *
 * @param {number} sampleDurationMs duration of {@link measureSyncChunkDurationMs} for
 *   {@link SLICE_BUDGET_CALIBRATION_ITEMS} items
 * @param {number} [targetMs]
 * @returns {number}
 */
export function calibrateSliceBudgetMsFromSample(sampleDurationMs, targetMs = DEFAULT_SLICE_BUDGET_MS) {
  const sample = Number(sampleDurationMs);
  const target = Number.isFinite(Number(targetMs)) ? Number(targetMs) : DEFAULT_SLICE_BUDGET_MS;
  if (!Number.isFinite(sample) || sample <= 0) return target;
  const perItem = sample / SLICE_BUDGET_CALIBRATION_ITEMS;
  if (perItem <= 0) return target;
  const itemsPerSlice = Math.max(1, Math.floor(target / perItem));
  const estimatedSliceMs = itemsPerSlice * perItem;
  if (estimatedSliceMs <= target * 1.25) return target;
  const scaled = Math.floor((target * target) / estimatedSliceMs);
  return Math.max(4, Math.min(16, scaled));
}
