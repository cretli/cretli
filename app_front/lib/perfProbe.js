/**
 * Cheap step timing for the Chat -> Todo tab switch, read-only on
 * `window.__cretliPerf`. Each step is also written as a `performance.measure`
 * (`cretli:<name>`) so it shows in the Chrome Performance panel.
 *
 * Timings are synchronous time spent inside the wrapped call; async work (the
 * fetch) is measured start-to-settle with `probeStart`/`probeEnd`. Missing
 * performance API: every helper degrades to a plain call. Behaviour never
 * changes and exceptions from the wrapped function pass through unchanged.
 */

/**
 * Low-frequency steps (a handful per tab switch) that also get a
 * `performance.measure` for the DevTools timeline. Every other step
 * (per-row paints, state mutators) is aggregated in the Map only: Chrome's
 * User Timing buffer is unbounded, so per-row measures would grow without limit.
 */
const MEASURED_STEPS = new Set([
  'todo.tabSwitch',
  'todo.tabSwitch.refreshCall',
  'todo.fetch',
  'todo.applySuccess',
  'todo.isUnchanged',
  'todo.renderList',
  'todo.notifyViewContextTodoScope',
  'sidebar.renderPass',
  'chat.switch',
  'sidebar.activeOnly',
  'chat.history.fetch',
  'chat.history.replay',
]);
/** Hard cap on measures created until `resetPerfProbe()`. */
export const MAX_PERF_MEASURES = 500;
let measureCount = 0;

/** @type {Map<string, { name: string, count: number, totalMs: number, maxMs: number, lastMs: number }>} */
const steps = new Map();
let seq = 0;

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

function record(name, start, end) {
  const ms = end - start;
  let s = steps.get(name);
  if (!s) {
    s = { name, count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    steps.set(name, s);
  }
  s.count += 1;
  s.totalMs += ms;
  s.lastMs = ms;
  if (ms > s.maxMs) s.maxMs = ms;
  if (!MEASURED_STEPS.has(name) || measureCount >= MAX_PERF_MEASURES) return;
  try {
    if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
      measureCount += 1;
      performance.measure(`cretli:${name}`, { start, end });
    }
  } catch {
    /* measure is best effort */
  }
}

/** Runs `fn` and records its synchronous duration under `name`. */
export function probeSync(name, fn) {
  const start = now();
  try {
    return fn();
  } finally {
    record(name, start, now());
  }
}

/** Starts a span that may end later (async). Returns a token for `probeEnd`. */
export function probeStart(name) {
  return { name, start: now(), id: ++seq };
}

export function probeEnd(token) {
  if (token) record(token.name, token.start, now());
}

export function resetPerfProbe() {
  steps.clear();
  measureCount = 0;
  try {
    if (typeof performance !== 'undefined' && typeof performance.clearMeasures === 'function') {
      for (const name of MEASURED_STEPS) performance.clearMeasures(`cretli:${name}`);
    }
  } catch {
    /* best effort */
  }
}

/** Snapshot: `entries` is `{name, durationMs (total), count, maxMs, lastMs}` per step. */
export function getPerfProbeEntries() {
  return [...steps.values()].map((s) => ({
    name: s.name,
    durationMs: Math.round(s.totalMs * 100) / 100,
    count: s.count,
    maxMs: Math.round(s.maxMs * 100) / 100,
    lastMs: Math.round(s.lastMs * 100) / 100,
  }));
}

/** Installs the read-only `window.__cretliPerf` (idempotent). */
export function installPerfProbe(target = typeof window !== 'undefined' ? window : null) {
  if (!target || Object.getOwnPropertyDescriptor(target, '__cretliPerf')) return;
  const api = {
    get entries() {
      return getPerfProbeEntries();
    },
    /** Sum of synchronous time for the steps listed (default: every step except `tabSwitch`/`fetch`). */
    get totalSyncMs() {
      return Math.round(
        getPerfProbeEntries()
          .filter((e) => e.name !== 'todo.tabSwitch' && e.name !== 'todo.fetch' && e.name !== 'sidebar.renderPass' && e.name !== 'chat.switch')
          .reduce((a, e) => a + e.durationMs, 0) * 100
      ) / 100;
    },
    reset: resetPerfProbe,
  };
  try {
    Object.defineProperty(target, '__cretliPerf', { value: Object.freeze(api), enumerable: false });
  } catch {
    /* non-configurable global: skip */
  }
}
