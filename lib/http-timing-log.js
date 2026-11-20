/**
 * Leveled, bounded HTTP request timing output.
 *
 * The middleware always measures API request duration. When the debug timing
 * flag is on, only requests slower than the threshold are printed as a single
 * ISO-timestamped `[http-timing] end` line (the old `start` line is gone). When
 * the flag is off, a slower-than-threshold request still produces a
 * `[slow-request]` warning, budgeted so a burst cannot flood the log.
 *
 * The decision and the rate budget live here, with an injected clock, so they
 * can be tested without a live server.
 */

const DEFAULT_MIN_MS = 500;
const DEFAULT_SLOW_BUDGET = 20;
const DEFAULT_BUDGET_WINDOW_MS = 60_000;

/** Long-poll endpoints whose duration is a normal wait, never a stall. */
const EXCLUDED_PATHS = new Set(['/api/mcp/bridge/call']);

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveHttpTimingMinMs(env = process.env) {
  const parsed = Number.parseInt(String(env?.CRETLI_HTTP_TIMING_MIN_MS ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_MS;
}

/**
 * Long-poll bridge calls are excluded from both the timing line and the slow
 * warning: their duration reflects an intentional wait, not a stall.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isHttpTimingExcludedPath(pathname) {
  return EXCLUDED_PATHS.has(String(pathname || ''));
}

/**
 * @param {{
 *   clock?: () => number,
 *   minMs?: number,
 *   slowBudget?: number,
 *   budgetWindowMs?: number,
 *   log?: (...args: unknown[]) => void,
 *   warn?: (...args: unknown[]) => void,
 * }} [options]
 */
export function createHttpTimingLog({
  clock = Date.now,
  minMs = DEFAULT_MIN_MS,
  slowBudget = DEFAULT_SLOW_BUDGET,
  budgetWindowMs = DEFAULT_BUDGET_WINDOW_MS,
  log = (...args) => console.log(...args),
  warn = (...args) => console.warn(...args),
} = {}) {
  let windowStartedAt = clock();
  let emittedInWindow = 0;
  let suppressedSlowCount = 0;

  /**
   * When the budget window has elapsed, emit one summary for the suppressed
   * slow-request lines and reset the window.
   *
   * @param {number} now
   */
  function flushSuppressedIfWindowElapsed(now) {
    if (now - windowStartedAt < budgetWindowMs) return;
    if (suppressedSlowCount > 0) {
      warn(`[slow-request] suppressed ${suppressedSlowCount} slow-request lines`);
      suppressedSlowCount = 0;
    }
    windowStartedAt = now;
    emittedInWindow = 0;
  }

  /**
   * Records one finished request. `durationMs` is measured by the caller.
   *
   * @param {{ method?: string, url?: string, path: string, statusCode?: number, durationMs: number, timingEnabled?: boolean }} request
   */
  function record({ method = '', url = '', path, statusCode = 0, durationMs, timingEnabled = false }) {
    if (isHttpTimingExcludedPath(path)) return;
    const now = clock();
    flushSuppressedIfWindowElapsed(now);
    if (!Number.isFinite(durationMs) || durationMs <= minMs) return;
    const stamp = new Date(now).toISOString();
    const context = `${statusCode} ${Math.round(durationMs)}ms ${method} ${url}`;
    if (timingEnabled) {
      log(`[http-timing] end ${stamp} ${context}`);
      return;
    }
    if (emittedInWindow >= slowBudget) {
      suppressedSlowCount += 1;
      return;
    }
    emittedInWindow += 1;
    warn(`[slow-request] ${stamp} ${context}`);
  }

  return { record };
}
