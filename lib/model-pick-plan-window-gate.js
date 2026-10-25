/**
 * Hard plan-window threshold for `model_pick` (`plan-window-exhausted`).
 *
 * Pure: no I/O, no `Date.now()`. The caller injects the (reservation-corrected)
 * plan-limit rows and `now`. Only the weekly windows can exclude a candidate:
 * the 5h window stays a soft signal, and `seven_day_oauth_apps` does not
 * describe Claude Code session usage. The gate is picker-only; an explicit
 * named `delegation_start`, `pick_id` and audited overrides never see it.
 */
import {
  PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT,
  PLAN_WINDOW_TYPES,
  readingAgeMs,
  resolvePlanWindowConfig,
  selectPlanWindows,
} from './model-pick-plan-window.js';

/** A weekly window at or above this utilization is considered exhausted (D3). */
export const PLAN_WINDOW_HARD_UTILIZATION_PCT = 100 - PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT;
/** The gate only fires when the window resets MORE than this far away (D3). */
export const PLAN_WINDOW_MIN_RESET_MS = 60 * 60 * 1000;
/**
 * Windows that may hard-exclude a candidate (D1).
 *
 * @type {readonly string[]}
 */
export const PLAN_WINDOW_HARD_GATE_TYPES = Object.freeze([
  PLAN_WINDOW_TYPES.SEVEN_DAY,
  PLAN_WINDOW_TYPES.SEVEN_DAY_OPUS,
  PLAN_WINDOW_TYPES.SEVEN_DAY_SONNET,
]);
/** Local usage reservations expire after this long (D7). */
export const PLAN_WINDOW_RESERVATION_TTL_MS = 15 * 60 * 1000;
/** Estimated window percentage points consumed by one started delegation (D7). */
export const PLAN_WINDOW_ESTIMATE_PP = Object.freeze({
  plan: 1.5,
  review: 1.5,
  implement: 3,
  fix: 3,
});

/** Diagnostic `filter_reason` string for the hard gate. */
export const PLAN_WINDOW_EXHAUSTED_REASON = 'plan-window-exhausted';
/** Diagnostic note: the exclusion rests on a reservation-corrected value. */
export const PLAN_WINDOW_ESTIMATED_NOTE = 'plan-window-estimated';
/** Diagnostic (non-filter) note when an empty pool forced the gate off (D4). */
export const PLAN_WINDOW_RELAXED_NOTE = 'plan-window-relaxed';

/**
 * Utilization threshold: an explicit `hardUtilizationPct` wins, otherwise it
 * derives from the Settings `hardFreePercent` (default 5 => 95).
 *
 * @param {unknown} config
 * @returns {number}
 */
function hardThreshold(config) {
  const resolved = resolvePlanWindowConfig(config);
  return resolved.hardUtilizationPct ?? 100 - resolved.hardFreePercent;
}

/**
 * Why (if at all) a candidate's weekly window is exhausted.
 *
 * Freshness: a row counts while it is not flagged `stale` by the forecast
 * (6 h). Within one window (same `resetsAt`) weekly utilization never
 * decreases, so an older reading >= threshold is a lower bound and still
 * valid. The 20 min freshness applies only to the 5h bonus of leaf A.
 *
 * Does not fire for: a disabled config, a stale/expired/scope-mismatched row,
 * a missing/invalid/past reset, a reset within {@link PLAN_WINDOW_MIN_RESET_MS},
 * an unusable percentage or an unknown reading time. Model windows only apply
 * to matching models (`selectPlanWindows`).
 *
 * @param {{
 *   harness: string,
 *   modelId: string,
 *   planLimits: import('./model-pick-plan-window.js').ModelPickPlanLimitRow[],
 *   now: number,
 *   config?: { enabled?: boolean, hardUtilizationPct?: number, hardFreePercent?: number },
 * }} input
 * @returns {{
 *   type: string, utilization: number, resetsAt: string, resetInMs: number,
 *   basis: 'measured' | 'estimated', measuredUtilization: number, estimatedPp: number,
 * } | null} `basis: 'estimated'` means the value includes local reservations
 */
export function planWindowExhaustedReason(input) {
  const { harness, modelId, planLimits, now } = input;
  if (resolvePlanWindowConfig(input.config).enabled === false) return null;
  const threshold = hardThreshold(input.config);
  /** @type {ReturnType<typeof planWindowExhaustedReason>} */
  let worst = null;
  for (const entry of selectPlanWindows(planLimits, harness, modelId)) {
    if (!PLAN_WINDOW_HARD_GATE_TYPES.includes(entry.type)) continue;
    const { row } = entry;
    if (row?.stale === true || row?.expired === true || row?.scopeMismatch === true) continue;
    const raw = row?.utilization;
    const utilization = raw == null || raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(utilization) || utilization < threshold) continue;
    const resetsAt = Date.parse(String(row?.resetsAt || ''));
    if (!Number.isFinite(resetsAt) || resetsAt - now <= PLAN_WINDOW_MIN_RESET_MS) continue;
    if (!Number.isFinite(readingAgeMs(row, now))) continue;
    if (!worst || utilization > worst.utilization) {
      worst = {
        type: entry.type,
        utilization,
        resetsAt: new Date(resetsAt).toISOString(),
        resetInMs: resetsAt - now,
        basis: row?.utilizationEstimated === true ? 'estimated' : 'measured',
        measuredUtilization: Number.isFinite(Number(row?.measuredUtilization))
          ? Number(row.measuredUtilization)
          : utilization,
        estimatedPp: row?.utilizationEstimated === true ? Number(row?.estimatedPp) || 0 : 0,
      };
    }
  }
  return worst;
}
