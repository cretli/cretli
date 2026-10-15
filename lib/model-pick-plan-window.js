/**
 * Plan-window signal for `model_pick`: maps stored plan-limit rows
 * (`readHarnessPlanLimits`) onto a candidate (harness + model) and derives a
 * quantized 5h "headroom" level used only as a within-band tie-break.
 *
 * Pure: no I/O, no `Date.now()`. The caller passes `now`. Seven-day windows are
 * only classified here (`scope`, `type`); the hard threshold built on them
 * belongs to the next leaf.
 */
import { decodeModelValue } from './model-catalog.js';

/** A 5h reading older than this is neutral for the headroom bonus (D5). */
export const PLAN_WINDOW_BONUS_STALE_MS = 20 * 60 * 1000;
/** A reading older than this triggers a best-effort async refresh (D5). */
export const PLAN_WINDOW_REFRESH_AFTER_MS = 10 * 60 * 1000;
/** Tolerated clock skew before a future `observedAt` is treated as invalid. */
export const PLAN_WINDOW_FUTURE_SKEW_MS = 60 * 1000;

/** Headroom levels (D6). `NEUTRAL` is also the level of "no usable window". */
export const PLAN_HEADROOM_LEVEL_SPARE = 0;
export const PLAN_HEADROOM_LEVEL_NEUTRAL = 1;
export const PLAN_HEADROOM_LEVEL_COMFORTABLE = 2;
export const PLAN_HEADROOM_LEVEL_PLENTY = 3;

/** Free-percent thresholds between levels (free = 100 - utilization). */
export const PLAN_HEADROOM_SPARE_BELOW_FREE_PERCENT = 20;
export const PLAN_HEADROOM_COMFORTABLE_FROM_FREE_PERCENT = 50;
export const PLAN_HEADROOM_PLENTY_ABOVE_FREE_PERCENT = 80;
/** A window about to reset with at least this much free counts as plenty. */
export const PLAN_HEADROOM_URGENT_RESET_MS = 60 * 60 * 1000;
export const PLAN_HEADROOM_URGENT_MIN_FREE_PERCENT = 40;

export const PLAN_WINDOW_TYPES = Object.freeze({
  FIVE_HOUR: 'five_hour',
  SEVEN_DAY: 'seven_day',
  SEVEN_DAY_OPUS: 'seven_day_opus',
  SEVEN_DAY_SONNET: 'seven_day_sonnet',
  SEVEN_DAY_OAUTH_APPS: 'seven_day_oauth_apps',
});

const KNOWN_TYPES = new Set(Object.values(PLAN_WINDOW_TYPES));
const CODEX_WHOLE_HARNESS_LIMIT_ID = 'codex';

/** Hard weekly threshold, as free percent of the window (Settings, D8). */
export const PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT = 5;
export const PLAN_WINDOW_HARD_FREE_PERCENT_MIN = 1;
export const PLAN_WINDOW_HARD_FREE_PERCENT_MAX = 20;

/**
 * @typedef {{
 *   enabled: boolean,
 *   hardFreePercent: number,
 *   hardUtilizationPct?: number,
 * }} PlanWindowConfig
 */

/**
 * Caller-injected configuration (D8). Defaults to enabled; the Settings layer
 * only feeds it. `enabled: false` restores the legacy per-harness behavior.
 *
 * @param {unknown} [raw]
 * @returns {PlanWindowConfig}
 */
export function resolvePlanWindowConfig(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const free = Number(src.hardFreePercent);
  const hardFreePercent = Number.isFinite(free)
    ? Math.min(PLAN_WINDOW_HARD_FREE_PERCENT_MAX, Math.max(PLAN_WINDOW_HARD_FREE_PERCENT_MIN, free))
    : PLAN_WINDOW_HARD_FREE_PERCENT_DEFAULT;
  const explicit = Number(src.hardUtilizationPct);
  return {
    enabled: src.enabled !== false,
    hardFreePercent,
    ...(Number.isFinite(explicit) && explicit > 0 && explicit <= 100 ? { hardUtilizationPct: explicit } : {}),
  };
}

/**
 * Split a stored `rateLimitType` into its bucket id and window type. Codex
 * emits `<limitId>:<type>` for non-default buckets; an unprefixed row (or the
 * `codex` bucket) covers the whole harness. An unknown suffix has `type: ''`
 * and must be treated as neutral by readers.
 *
 * @param {unknown} rateLimitType
 * @returns {{ limitId: string, type: string, known: boolean }}
 */
export function normalizeWindowType(rateLimitType) {
  const raw = String(rateLimitType || '').trim().toLowerCase();
  const colon = raw.lastIndexOf(':');
  const limitId = colon >= 0 ? raw.slice(0, colon) : '';
  const suffix = colon >= 0 ? raw.slice(colon + 1) : raw;
  const known = KNOWN_TYPES.has(suffix);
  return { limitId, type: known ? suffix : '', known };
}

/**
 * @param {string} modelId catalog id, possibly `base::effort=...`
 * @returns {string} lower-cased base model id
 */
function baseModelId(modelId) {
  return decodeModelValue(modelId).modelId.toLowerCase();
}

/**
 * Whether a window row applies to the candidate. Whole-harness windows apply
 * to every model; a Claude family window (`seven_day_opus` / `_sonnet`) only
 * to models of that family; a Codex model bucket only to the model it names.
 * `harnessId` is already matched by the caller.
 *
 * @param {{ limitId: string, type: string }} window
 * @param {string} harnessId
 * @param {string} modelId
 * @returns {boolean}
 */
export function windowAppliesToModel(window, harnessId, modelId) {
  const base = baseModelId(modelId);
  if (window.type === PLAN_WINDOW_TYPES.SEVEN_DAY_OPUS) return /opus/i.test(base);
  if (window.type === PLAN_WINDOW_TYPES.SEVEN_DAY_SONNET) return /sonnet/i.test(base);
  if (!window.limitId || window.limitId === CODEX_WHOLE_HARNESS_LIMIT_ID) return true;
  // A model-scoped bucket that cannot be matched to this model is ignored.
  if (!base) return false;
  // Exact match only (separator-insensitive): a substring match would hand the
  // bucket of `gpt-5-codex-mini` to the unrelated base model `gpt-5`.
  const squash = (value) => String(value).toLowerCase().replace(/[^a-z0-9.]+/g, '-');
  return squash(base) === squash(window.limitId);
}

/**
 * Plan-limit rows of one harness that apply to the candidate model, with the
 * parsed window attached. Rows with an unknown suffix are returned with
 * `type: ''` so the legacy penalty keeps seeing them.
 *
 * @param {object[]} planLimits
 * @param {string} harnessId
 * @param {string} modelId
 * @returns {{ row: object, limitId: string, type: string }[]}
 */
export function selectPlanWindows(planLimits, harnessId, modelId) {
  const harness = String(harnessId || '').trim().toLowerCase();
  const out = [];
  for (const row of Array.isArray(planLimits) ? planLimits : []) {
    if (String(row?.harness || '').trim().toLowerCase() !== harness) continue;
    const window = normalizeWindowType(row?.rateLimitType);
    if (!windowAppliesToModel(window, harness, modelId)) continue;
    out.push({ row, limitId: window.limitId, type: window.type });
  }
  return out;
}

/**
 * Age of the percentage in `row`, or `NaN` when it is unknown or lies in the
 * future (beyond the skew tolerance).
 *
 * @param {object} row
 * @param {number} now
 * @returns {number}
 */
export function readingAgeMs(row, now) {
  const at = Date.parse(String(row?.utilizationObservedAt || row?.observedAt || ''));
  if (!Number.isFinite(at)) return NaN;
  const age = now - at;
  return age < -PLAN_WINDOW_FUTURE_SKEW_MS ? NaN : Math.max(0, age);
}

/**
 * Newest reading age among ALL rows of `harnessId`, or `null` when there is
 * none. Model scoping is deliberately ignored here: a refresh should also be
 * triggered by an `opus` / `sonnet` family window or a Codex model bucket,
 * which `selectPlanWindows(..., '')` would drop.
 *
 * @param {object[]} planLimits
 * @param {string} harnessId
 * @param {number} now
 * @returns {number | null}
 */
export function newestReadingAgeMs(planLimits, harnessId, now) {
  const harness = String(harnessId || '').trim().toLowerCase();
  let best = null;
  for (const row of Array.isArray(planLimits) ? planLimits : []) {
    if (String(row?.harness || '').trim().toLowerCase() !== harness) continue;
    const age = readingAgeMs(row, now);
    if (Number.isFinite(age) && (best === null || age < best)) best = age;
  }
  return best;
}

/**
 * Quantized 5h headroom level for a candidate, `0..3` (higher is better).
 *
 * Neutral (`PLAN_HEADROOM_LEVEL_NEUTRAL`) for: disabled config, no window,
 * stale/expired/scope-mismatched row, no usable percentage, no valid future
 * reset, a reading older than `PLAN_WINDOW_BONUS_STALE_MS` or dated in the
 * future. Several buckets of the same type: the one with the highest
 * utilization wins.
 *
 * @param {{
 *   planLimits: object[],
 *   harnessId: string,
 *   modelId: string,
 *   now: number,
 *   config?: PlanWindowConfig,
 * }} input
 * @returns {number}
 */
export function planHeadroomLevel(input) {
  const { planLimits, harnessId, modelId, now } = input;
  if (resolvePlanWindowConfig(input.config).enabled === false) return PLAN_HEADROOM_LEVEL_NEUTRAL;
  let worst = null;
  for (const entry of selectPlanWindows(planLimits, harnessId, modelId)) {
    if (entry.type !== PLAN_WINDOW_TYPES.FIVE_HOUR) continue;
    const { row } = entry;
    if (row?.stale === true || row?.expired === true || row?.scopeMismatch === true) continue;
    const raw = row?.utilization;
    const utilization = raw == null || raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(utilization)) continue;
    const resetsAt = Date.parse(String(row?.resetsAt || ''));
    if (!Number.isFinite(resetsAt) || resetsAt <= now) continue;
    const age = readingAgeMs(row, now);
    if (!Number.isFinite(age) || age > PLAN_WINDOW_BONUS_STALE_MS) continue;
    if (!worst || utilization > worst.utilization) {
      worst = { utilization, resetInMs: resetsAt - now };
    }
  }
  if (!worst) return PLAN_HEADROOM_LEVEL_NEUTRAL;
  const free = 100 - Math.min(100, Math.max(0, worst.utilization));
  if (free > PLAN_HEADROOM_PLENTY_ABOVE_FREE_PERCENT) return PLAN_HEADROOM_LEVEL_PLENTY;
  if (free >= PLAN_HEADROOM_URGENT_MIN_FREE_PERCENT && worst.resetInMs <= PLAN_HEADROOM_URGENT_RESET_MS) {
    return PLAN_HEADROOM_LEVEL_PLENTY;
  }
  if (free < PLAN_HEADROOM_SPARE_BELOW_FREE_PERCENT) return PLAN_HEADROOM_LEVEL_SPARE;
  if (free < PLAN_HEADROOM_COMFORTABLE_FROM_FREE_PERCENT) return PLAN_HEADROOM_LEVEL_NEUTRAL;
  return PLAN_HEADROOM_LEVEL_COMFORTABLE;
}

/**
 * Compact, serializable "why this pair had headroom" record stored on a
 * delegation (D9). Independent of any user `pick_reason`. `null` when no window
 * applies to the pair or the mode is off, so legacy records stay unchanged.
 *
 * @param {{
 *   planLimits: object[],
 *   harnessId: string,
 *   modelId: string,
 *   now: number,
 *   config?: unknown,
 * }} input
 * @returns {{
 *   level: number, hardFreePercent: number, observedAt: string,
 *   windows: { type: string, utilization: number, resetsAt: string }[],
 * } | null}
 */
export function buildPlanHeadroomSnapshot(input) {
  const config = resolvePlanWindowConfig(input.config);
  if (config.enabled === false) return null;
  const windows = [];
  for (const { row, type } of selectPlanWindows(input.planLimits, input.harnessId, input.modelId)) {
    if (!type || type === PLAN_WINDOW_TYPES.SEVEN_DAY_OAUTH_APPS) continue;
    if (row?.stale === true || row?.expired === true || row?.scopeMismatch === true) continue;
    const raw = row?.utilization;
    const utilization = raw == null || raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(utilization)) continue;
    const resets = Date.parse(String(row?.resetsAt || ''));
    windows.push({
      type,
      utilization: Math.round(utilization * 10) / 10,
      resetsAt: Number.isFinite(resets) ? new Date(resets).toISOString() : '',
    });
  }
  if (!windows.length) return null;
  return {
    level: planHeadroomLevel({ ...input, config }),
    hardFreePercent: config.hardFreePercent,
    // Time the snapshot was computed from the cached reading (not the provider's fetch time).
    observedAt: new Date(input.now).toISOString(),
    windows,
  };
}
