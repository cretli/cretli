/**
 * Best-effort, fire-and-forget refresh of plan-limit readings (D5). The picker
 * never awaits it and never queries a provider itself; the refreshed reading
 * only benefits a later pick.
 */
import { getCodexPlanLimits } from './codex/codex-plan-limits.ts';
import { newestReadingAgeMs, oldestLiveReadingAgeMs, PLAN_WINDOW_REFRESH_AFTER_MS } from './model-pick-plan-window.js';

/** @type {Map<string, Promise<unknown>>} */
const pending = new Map();

/**
 * @param {string} key
 * @param {() => Promise<unknown>} run
 * @returns {boolean} true when a refresh was started
 */
function startOnce(key, run) {
  if (pending.has(key)) return false;
  let promise;
  try {
    promise = Promise.resolve(run());
  } catch {
    return false;
  }
  const tracked = promise.catch(() => {}).finally(() => {
    if (pending.get(key) === tracked) pending.delete(key);
  });
  pending.set(key, tracked);
  return true;
}

/**
 * Ask for a fresh reading of every plan-window harness whose newest stored
 * reading is older than `PLAN_WINDOW_REFRESH_AFTER_MS` (or missing).
 *
 * Codex uses `getCodexPlanLimits`. Claude uses the caller's live SDK session
 * query when given, otherwise a throwaway SDK query (`allowEphemeral`). Claude
 * staleness is judged per window: a fresh 5h event must not hide an old weekly
 * reading. With no stored Claude reading at all and no live query nothing is
 * spawned.
 *
 * @param {{
 *   planLimits?: object[],
 *   now?: number,
 *   dataDir?: string,
 *   claudeQuery?: object | null,
 *   refreshers?: { codex?: Function, claude?: Function },
 * }} [input]
 * @returns {string[]} harness ids a refresh was started for
 */
export function requestPlanLimitsRefresh(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const planLimits = Array.isArray(input.planLimits) ? input.planLimits : [];
  const started = [];
  const isOld = (harness) => {
    const age = newestReadingAgeMs(planLimits, harness, now);
    return age === null || age > PLAN_WINDOW_REFRESH_AFTER_MS;
  };
  if (isOld('codex')) {
    const refresh = input.refreshers?.codex || getCodexPlanLimits;
    if (startOnce('codex', () => refresh({ dataDir: input.dataDir }))) started.push('codex');
  }
  const claudeAge = oldestLiveReadingAgeMs(planLimits, 'claude', now);
  const claudeOld = claudeAge !== null && claudeAge > PLAN_WINDOW_REFRESH_AFTER_MS;
  if (input.claudeQuery ? isOld('claude') || claudeOld : claudeOld) {
    const refresh = input.refreshers?.claude
      || (async (args) => (await import('./claude/claude-plan-limits.ts')).getClaudePlanLimits(args));
    if (startOnce('claude', () => refresh({ dataDir: input.dataDir, query: input.claudeQuery, allowEphemeral: true }))) {
      started.push('claude');
    }
  }
  return started;
}
