/**
 * Shared runner for recurring, subject-less background jobs (for example the
 * idle-chat auto-archive sweep). Wake-up rows are single-fire episodes, so a
 * periodic job is not modelled as one. The runner has no dependency on the
 * wake-up scheduler, so it also works while the delegation runtime is degraded.
 */

const MAX_ERROR_LENGTH = 200;

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   intervalMs: number,
 *   settingKey: string,
 *   runOnStart?: boolean,
 *   jitterMs?: number,
 *   isEnabled: () => boolean,
 *   run: (ctx: { now: number }) => unknown,
 * }} PeriodicJob
 */

/**
 * @typedef {{
 *   enabled: boolean,
 *   running: boolean,
 *   lastRunAt: string|null,
 *   lastDurationMs: number|null,
 *   maxDurationMs: number,
 *   runs: number,
 *   lastResult: unknown,
 *   lastError: string|null,
 *   skipped: number,
 * }} PeriodicJobState
 */

/** Last-run measurements for jobs that are not driven by the runner (for example watcher tick passes). */
const externalTimings = new Map();

/**
 * Record one run of a named periodic task so /api/health can show where
 * periodic work lands. Cheap: one Map write per call.
 *
 * @param {string} id
 * @param {{ durationMs: number, at?: number, skipped?: boolean }} sample
 */
export function recordJobTiming(id, sample) {
  const prev = externalTimings.get(id) || { runs: 0, skipped: 0, lastRunAt: null, lastDurationMs: null, maxDurationMs: 0 };
  if (sample.skipped) {
    externalTimings.set(id, { ...prev, skipped: prev.skipped + 1 });
    return;
  }
  const durationMs = Math.max(0, Math.round(Number(sample.durationMs) || 0));
  externalTimings.set(id, {
    runs: prev.runs + 1,
    skipped: prev.skipped,
    lastRunAt: new Date(sample.at ?? Date.now()).toISOString(),
    lastDurationMs: durationMs,
    maxDurationMs: Math.max(prev.maxDurationMs, durationMs),
  });
}

/** Runs `fn` and records its duration under `id`. */
export function timeJob(id, fn) {
  const startedAt = Date.now();
  try {
    return fn();
  } finally {
    recordJobTiming(id, { durationMs: Date.now() - startedAt, at: startedAt });
  }
}

/** Async variant of {@link timeJob}; the duration covers the awaited promise. */
export async function timeJobAsync(id, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordJobTiming(id, { durationMs: Date.now() - startedAt, at: startedAt });
  }
}

/** @returns {Array<{ id: string, runs: number, skipped: number, lastRunAt: string|null, lastDurationMs: number|null, maxDurationMs: number }>} */
export function getExternalJobTimings() {
  return [...externalTimings.entries()].map(([id, v]) => ({ id, ...v }));
}

export function resetExternalJobTimings() {
  externalTimings.clear();
}

function shortError(error) {
  const text = String(error?.message || error || 'error');
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

function readEnabled(job) {
  try {
    return Boolean(job.isEnabled());
  } catch {
    return false;
  }
}

/**
 * @param {{ now?: () => number, setTimeoutFn?: Function, clearTimeoutFn?: Function, setIntervalFn?: Function, clearIntervalFn?: Function, random?: () => number }} [deps]
 */
export function createPeriodicJobRunner(deps = {}) {
  const now = deps.now || Date.now;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const clearIntervalFn = deps.clearIntervalFn || clearInterval;
  const random = deps.random || Math.random;
  /** @type {Map<string, { job: PeriodicJob, state: PeriodicJobState, interval: any, boot: any, jitterMs?: number }>} */
  const entries = new Map();
  let started = false;

  function unref(handle) {
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  }

  async function execute(entry) {
    const { job, state } = entry;
    state.enabled = readEnabled(job);
    if (!state.enabled) return;
    if (state.running) {
      state.skipped += 1;
      return;
    }
    state.running = true;
    const startedAt = now();
    try {
      const result = await job.run({ now: now() });
      state.lastResult = result === undefined ? null : result;
      state.lastError = null;
    } catch (error) {
      state.lastError = shortError(error);
    } finally {
      state.running = false;
      state.lastDurationMs = Math.max(0, now() - startedAt);
      state.maxDurationMs = Math.max(state.maxDurationMs, state.lastDurationMs);
      state.runs += 1;
      state.lastRunAt = new Date(now()).toISOString();
    }
  }

  function arm(entry) {
    const { job } = entry;
    // Jitter spreads job starts so periodic jobs do not land in the same second.
    // A job without jitterMs keeps the original timing (boot run at 0).
    const jitter = Number(job.jitterMs) > 0 ? Math.floor(random() * Number(job.jitterMs)) : 0;
    entry.jitterMs = jitter;
    const startInterval = () => {
      entry.interval = unref(setIntervalFn(() => { void execute(entry); }, job.intervalMs));
    };
    if (job.runOnStart !== false) {
      entry.boot = unref(setTimeoutFn(() => {
        entry.boot = null;
        void execute(entry);
        if (jitter > 0) startInterval();
      }, jitter));
      if (jitter > 0) return;
    } else if (jitter > 0) {
      entry.boot = unref(setTimeoutFn(() => {
        entry.boot = null;
        startInterval();
      }, jitter));
      return;
    }
    startInterval();
  }

  function disarm(entry) {
    if (entry.boot) clearTimeoutFn(entry.boot);
    if (entry.interval) clearIntervalFn(entry.interval);
    entry.boot = null;
    entry.interval = null;
  }

  /** @param {PeriodicJob} job */
  function register(job) {
    if (!job || !job.id || !(Number(job.intervalMs) > 0) || typeof job.run !== 'function') {
      throw new Error('invalid periodic job');
    }
    const previous = entries.get(job.id);
    if (previous) disarm(previous);
    const entry = {
      job,
      boot: null,
      interval: null,
      state: { enabled: readEnabled(job), running: false, lastRunAt: null, lastDurationMs: null, maxDurationMs: 0, runs: 0, lastResult: null, lastError: null, skipped: 0 },
    };
    entries.set(job.id, entry);
    if (started) arm(entry);
  }

  function start() {
    if (started) return;
    started = true;
    for (const entry of entries.values()) arm(entry);
  }

  function stop() {
    started = false;
    for (const entry of entries.values()) disarm(entry);
  }

  function getJobsStatus() {
    return [...entries.values()].map(({ job, state }) => ({
      id: job.id,
      label: job.label || job.id,
      intervalMs: job.intervalMs,
      enabled: readEnabled(job),
      settingKey: job.settingKey || '',
      running: state.running,
      lastRunAt: state.lastRunAt,
      lastDurationMs: state.lastDurationMs,
      maxDurationMs: state.maxDurationMs,
      runs: state.runs,
      lastResult: state.lastResult,
      lastError: state.lastError,
      skipped: state.skipped,
    }));
  }

  /** Run one job now (same gates as a tick). */
  async function runNow(id) {
    const entry = entries.get(id);
    if (!entry) return false;
    await execute(entry);
    return true;
  }

  return { register, start, stop, getJobsStatus, runNow };
}
