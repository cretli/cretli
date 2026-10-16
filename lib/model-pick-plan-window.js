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

/* ------------------------------------------------------------------------- *
 * Weekly pace (burn rate relative to elapsed window time).
 *
 * Mirrors the "pace" idea of the plan-limits chat view (`elapsed - used`), but
 * deliberately does NOT import the front code: that view lives in app_front and
 * may differ, so the two are kept consistent by hand, not by a shared module.
 * ------------------------------------------------------------------------- */

const HOUR_MS = 60 * 60 * 1000;
/** Nominal window lengths used to turn `resetsAt` into elapsed time. */
export const PLAN_WINDOW_DURATION_MS = Object.freeze({
  [PLAN_WINDOW_TYPES.FIVE_HOUR]: 5 * HOUR_MS,
  [PLAN_WINDOW_TYPES.SEVEN_DAY]: 7 * 24 * HOUR_MS,
  [PLAN_WINDOW_TYPES.SEVEN_DAY_OPUS]: 7 * 24 * HOUR_MS,
  [PLAN_WINDOW_TYPES.SEVEN_DAY_SONNET]: 7 * 24 * HOUR_MS,
});

/** Weekly windows that take part in the pace level. */
const PACE_WINDOW_TYPES = new Set([
  PLAN_WINDOW_TYPES.SEVEN_DAY,
  PLAN_WINDOW_TYPES.SEVEN_DAY_OPUS,
  PLAN_WINDOW_TYPES.SEVEN_DAY_SONNET,
]);

/** Above pace: used exceeds elapsed by more than this many pp (level -1)... */
export const PLAN_PACE_AHEAD_SLACK_PP = -10;
/** ...but only once this much of the window has elapsed (early noise guard). */
export const PLAN_PACE_AHEAD_MIN_ELAPSED_PCT = 10;
/** Wasted reserve: elapsed exceeds used by more than this many pp (level +1)... */
export const PLAN_PACE_BEHIND_SLACK_PP = 15;
/** ...but only late in the window, when the reserve can no longer be spent. */
export const PLAN_PACE_BEHIND_MIN_ELAPSED_PCT = 70;
/** A pace reading older than this is unreliable (same as the 5h bonus). */
export const PLAN_PACE_STALE_MS = PLAN_WINDOW_BONUS_STALE_MS;

/**
 * Cost multiplier of the pace penalty by model cost tier: an expensive model
 * of a harness that is above pace is avoided harder than a cheap one.
 * Tier 1-2 => 0.5, 3 => 1, 4 => 1.5, 5 => 2 (unknown tier => 1).
 *
 * @param {unknown} costTier
 * @returns {number}
 */
export function paceCostFactor(costTier) {
  const tier = Number(costTier);
  if (!Number.isFinite(tier)) return 1;
  if (tier <= 2) return 0.5;
  if (tier <= 3) return 1;
  if (tier <= 4) return 1.5;
  return 2;
}

/**
 * Pace of one window: how much of it has elapsed and how far usage is from the
 * proportional line (`slackPct = elapsedPct - utilization`; negative = above
 * pace). `null` for an unknown window type, a percentage outside 0-100, an
 * expired reset, or a reset further ahead than the window length.
 *
 * @param {{ type: string, utilization: unknown, resetsAt: unknown, now: number }} input
 * @returns {{ elapsedPct: number, slackPct: number } | null}
 */
export function planWindowPace(input) {
  const duration = PLAN_WINDOW_DURATION_MS[String(input?.type || '')];
  if (!duration) return null;
  const raw = input.utilization;
  const utilization = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(utilization) || utilization < 0 || utilization > 100) return null;
  const resetsAt = typeof input.resetsAt === 'number' ? input.resetsAt : Date.parse(String(input.resetsAt || ''));
  if (!Number.isFinite(resetsAt) || !Number.isFinite(input.now)) return null;
  const remaining = resetsAt - input.now;
  if (remaining <= 0 || remaining > duration + PLAN_WINDOW_FUTURE_SKEW_MS) return null;
  const elapsedPct = Math.min(100, Math.max(0, 100 * (1 - remaining / duration)));
  return { elapsedPct, slackPct: elapsedPct - utilization };
}

/**
 * @param {{ elapsedPct: number, slackPct: number }} pace
 * @returns {-1 | 0 | 1}
 */
function paceWindowLevel(input) {
  // Round away float noise so exact boundaries (slack -10, elapsed 10) are stable.
  const pace = { slackPct: Math.round(input.slackPct * 1e6) / 1e6, elapsedPct: Math.round(input.elapsedPct * 1e6) / 1e6 };
  if (pace.slackPct < PLAN_PACE_AHEAD_SLACK_PP && pace.elapsedPct >= PLAN_PACE_AHEAD_MIN_ELAPSED_PCT) return -1;
  if (pace.slackPct > PLAN_PACE_BEHIND_SLACK_PP && pace.elapsedPct >= PLAN_PACE_BEHIND_MIN_ELAPSED_PCT) return 1;
  return 0;
}

/**
 * Weekly pace level of a candidate: `-1` above pace, `0` neutral, `+1` wasted
 * reserve. Only `seven_day` / `_opus` / `_sonnet` windows that apply to the
 * model count. `row.utilization` is expected to be reservation-corrected
 * already (`applyPlanWindowReservations`), so reservations are counted once.
 * The worst (lowest) window level wins; a known window whose reading is
 * unusable (stale, expired, scope mismatch, old, invalid) contributes 0, which
 * blocks a bonus but never erases a credible -1 from another window.
 * Disabled config or no data => 0. The caller zeroes +1 when a plan penalty,
 * a fresh limit hit or 5h headroom 0 already applies.
 *
 * @param {{
 *   planLimits: object[], harnessId: string, modelId: string, now: number,
 *   config?: unknown,
 * }} input
 * @returns {{ level: -1 | 0 | 1, windows: object[] }}
 */
export function buildPlanPaceSignal(input) {
  const { planLimits, harnessId, modelId, now } = input;
  if (resolvePlanWindowConfig(input.config).enabled === false) return { level: 0, windows: [] };
  const windows = [];
  let sawEligible = false;
  // Aggregate as we go: `anyNegative` wins, a bonus needs every known window
  // eligible and exactly +1, and an unusable window blocks the bonus.
  let anyNegative = false;
  let allPositive = true;
  for (const { row, limitId, type } of selectPlanWindows(planLimits, harnessId, modelId)) {
    if (!PACE_WINDOW_TYPES.has(type)) continue;
    const rawUtilization = row?.utilization;
    const utilization = rawUtilization == null || rawUtilization === '' ? NaN : Number(rawUtilization);
    const measuredRaw = Number(row?.measuredUtilization);
    const base = {
      type,
      limitId,
      resetsAt: String(row?.resetsAt || ''),
      utilization: Number.isFinite(utilization) ? utilization : null,
      measuredUtilization: Number.isFinite(measuredRaw) ? measuredRaw : (Number.isFinite(utilization) ? utilization : null),
      estimatedPp: row?.utilizationEstimated === true ? Number(row?.estimatedPp) || 0 : 0,
      readingObservedAt: String(row?.utilizationObservedAt || row?.observedAt || ''),
      elapsedPct: null,
      slackPct: null,
      eligible: false,
      reason: '',
    };
    let reason = '';
    if (row?.stale === true) reason = 'stale';
    else if (row?.expired === true) reason = 'expired';
    else if (row?.scopeMismatch === true) reason = 'scope_mismatch';
    else if (!Number.isFinite(readingAgeMs(row, now))) reason = 'reading_unknown';
    else if (readingAgeMs(row, now) > PLAN_PACE_STALE_MS) reason = 'reading_old';
    const pace = reason ? null : planWindowPace({ type, utilization, resetsAt: row?.resetsAt, now });
    if (!reason && !pace) reason = 'invalid_window';
    if (pace) {
      base.elapsedPct = Math.round(pace.elapsedPct * 10) / 10;
      base.slackPct = Math.round(pace.slackPct * 10) / 10;
      base.eligible = true;
      sawEligible = true;
      const windowLevel = paceWindowLevel(pace);
      if (windowLevel === -1) anyNegative = true;
      if (windowLevel !== 1) allPositive = false;
    } else {
      base.reason = reason;
      allPositive = false;
    }
    windows.push(base);
  }
  if (!sawEligible) return { level: 0, windows };
  // Aggregate: minimum over known windows, unusable ones counting as 0.
  return { level: anyNegative ? -1 : (allPositive ? 1 : 0), windows };
}

/**
 * Compact, serializable "why this pair is (not) at weekly pace" record stored on
 * a delegation (D9), mirroring `buildPlanHeadroomSnapshot`. `null` when the mode
 * is off or no eligible weekly window applies to the pair, so legacy records and
 * deployments without pace stay unchanged. The level is the same one the picker
 * computes from the same `planLimits` and `now`.
 *
 * @param {{
 *   planLimits: object[],
 *   harnessId: string,
 *   modelId: string,
 *   now: number,
 *   config?: unknown,
 *   costTier?: unknown,
 * }} input
 * @returns {{
 *   level: number, costFactor: number, observedAt: string,
 *   windows: {
 *     type: string, limitId: string, resetsAt: string,
 *     utilization: number | null, measuredUtilization: number | null,
 *     estimatedPp: number, elapsedPct: number | null, slackPct: number | null,
 *     eligible: boolean, reason: string, readingObservedAt: string,
 *   }[],
 * } | null}
 */
export function buildPlanPaceSnapshot(input) {
  const config = resolvePlanWindowConfig(input.config);
  if (config.enabled === false) return null;
  const signal = buildPlanPaceSignal({ ...input, config });
  if (!signal.windows.some((w) => w.eligible === true)) return null;
  return {
    level: signal.level,
    costFactor: paceCostFactor(input.costTier),
    // Time the snapshot was computed (not the provider's fetch time).
    observedAt: new Date(input.now).toISOString(),
    windows: signal.windows.map((w) => {
      const resets = Date.parse(String(w.resetsAt || ''));
      return {
        type: String(w.type || ''),
        limitId: String(w.limitId || ''),
        resetsAt: Number.isFinite(resets) ? new Date(resets).toISOString() : '',
        utilization: w.utilization == null ? null : Math.round(w.utilization * 10) / 10,
        measuredUtilization: w.measuredUtilization == null ? null : Math.round(w.measuredUtilization * 10) / 10,
        estimatedPp: Number(w.estimatedPp) || 0,
        elapsedPct: w.elapsedPct == null ? null : Math.round(w.elapsedPct * 10) / 10,
        slackPct: w.slackPct == null ? null : Math.round(w.slackPct * 10) / 10,
        eligible: w.eligible === true,
        reason: String(w.reason || ''),
        readingObservedAt: String(w.readingObservedAt || ''),
      };
    }),
  };
}

/** Upper bound on the number of windows a stored pace snapshot may carry. */
export const PLAN_PACE_SNAPSHOT_MAX_WINDOWS = 6;
/** Bounds for the stored pace level and cost factor (kept identical everywhere). */
const PLAN_PACE_LEVEL_MIN = -1;
const PLAN_PACE_LEVEL_MAX = 1;
const PLAN_PACE_COST_FACTOR_MIN = 0.5;
const PLAN_PACE_COST_FACTOR_MAX = 2;

/**
 * Shared, bounded copy of the weekly pace snapshot as stored on a delegation
 * or a model_pick proposal. Used by the persistence layer, the model_pick
 * record and the delegation-card view model so a record normalized once reads
 * the same everywhere.
 *
 * A window is kept when its `utilization` is a finite number, or when it
 * carries a neutrality `reason` (a known window whose reading is unusable).
 * That second case is exactly what the card must show: dropping it would hide
 * why an ineligible window did not contribute to the level. `null` when the
 * value is absent, malformed or has no window left.
 *
 * @param {unknown} value
 * @returns {{
 *   level: number, costFactor: number, observedAt: string,
 *   windows: {
 *     type: string, limitId: string, resetsAt: string,
 *     utilization: number | null, measuredUtilization: number | null,
 *     estimatedPp: number, elapsedPct: number | null, slackPct: number | null,
 *     eligible: boolean, reason: string, readingObservedAt: string,
 *   }[],
 * } | null}
 */
export function normalizePlanPaceSnapshot(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.windows)) return null;
  const windows = value.windows.slice(0, PLAN_PACE_SNAPSHOT_MAX_WINDOWS)
    .filter((w) => {
      if (!w || typeof w !== 'object') return false;
      const utilization = w.utilization;
      if (utilization === null || utilization === undefined || utilization === '') {
        // A known window with an unreliable reading still has a reason to show.
        return String(w.reason || '').trim().length > 0;
      }
      return Number.isFinite(Number(utilization)) || String(w.reason || '').trim().length > 0;
    })
    .map((w) => {
      const rawUtilization = w.utilization;
      const utilization = rawUtilization === null || rawUtilization === undefined || rawUtilization === ''
        ? null
        : (Number.isFinite(Number(rawUtilization)) ? Number(rawUtilization) : null);
      return {
        type: String(w.type || '').slice(0, 40),
        limitId: String(w.limitId || '').slice(0, 40),
        resetsAt: String(w.resetsAt || '').slice(0, 40),
        utilization,
        measuredUtilization: w.measuredUtilization == null || !Number.isFinite(Number(w.measuredUtilization))
          ? null
          : Number(w.measuredUtilization),
        estimatedPp: Number.isFinite(Number(w.estimatedPp)) ? Number(w.estimatedPp) : 0,
        elapsedPct: w.elapsedPct == null || !Number.isFinite(Number(w.elapsedPct)) ? null : Number(w.elapsedPct),
        slackPct: w.slackPct == null || !Number.isFinite(Number(w.slackPct)) ? null : Number(w.slackPct),
        eligible: w.eligible === true,
        reason: String(w.reason || '').slice(0, 40),
        readingObservedAt: String(w.readingObservedAt || '').slice(0, 40),
      };
    });
  if (!windows.length) return null;
  const level = Number(value.level);
  const costFactor = Number(value.costFactor);
  return {
    level: Number.isFinite(level)
      ? Math.min(PLAN_PACE_LEVEL_MAX, Math.max(PLAN_PACE_LEVEL_MIN, Math.round(level)))
      : 0,
    costFactor: Number.isFinite(costFactor) && costFactor > 0
      ? Math.min(PLAN_PACE_COST_FACTOR_MAX, Math.max(PLAN_PACE_COST_FACTOR_MIN, costFactor))
      : 1,
    observedAt: String(value.observedAt || '').slice(0, 40),
    windows,
  };
}
