/**
 * Cache-hit / cost / latency regression detection for reused review sessions.
 *
 * A turn that pays the full input price is not automatically a regression: a
 * first turn of a session generation, a changed stable prefix, a reset, or an
 * idle gap longer than the provider TTL are all expected cold starts. Only a
 * turn that SHOULD have been warm and was not (or was much more expensive or
 * slower than the warm baseline) is reported as a regression.
 *
 * Pure function over caller-supplied observations: it reads no state, issues
 * no request and never extends a cache. A missing metric produces no signal
 * (absence is not zero), so unmeasured harnesses report `insufficient_data`.
 */

/** Stable status vocabulary. */
export const CACHE_REGRESSION_STATUS = Object.freeze({
  OK: 'ok',
  COLD_START: 'cold_start',
  REGRESSION: 'regression',
  INSUFFICIENT_DATA: 'insufficient_data',
});

/** Why a turn is an expected cold start (never a regression). */
export const CACHE_COLD_START_CAUSE = Object.freeze({
  FIRST_TURN: 'first_turn',
  PREFIX_CHANGED: 'prefix_changed',
  GENERATION_CHANGED: 'generation_changed',
  TTL_EXPIRED: 'ttl_expired',
});

/** Regression signal ids. */
export const CACHE_REGRESSION_SIGNAL = Object.freeze({
  HIT_RATIO_DROP: 'cache_hit_ratio_drop',
  COST_INCREASE: 'cost_increase',
  LATENCY_INCREASE: 'latency_increase',
});

export const CACHE_REGRESSION_DEFAULTS = Object.freeze({
  /** Absolute drop of the hit ratio (0..1) versus the warm baseline. */
  hitRatioDrop: 0.25,
  /** Relative increase of cost per input token / latency versus the baseline. */
  costIncrease: 0.5,
  latencyIncrease: 0.75,
});

/**
 * @typedef {{
 *   at: number,
 *   cacheRead?: number|null,
 *   inputTokens?: number|null,
 *   costUsd?: number|null,
 *   latencyMs?: number|null,
 *   prefixFingerprint?: string,
 *   generation?: number,
 * }} CacheObservation
 */

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function positive(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {CacheObservation} observation
 * @returns {number|null} 0..1, or null without a reliable denominator.
 */
function hitRatioOf(observation) {
  const total = positive(observation.inputTokens);
  if (total == null) return null;
  const read = Math.max(0, Number(observation.cacheRead) || 0);
  if (observation.cacheRead == null) return null;
  return Math.min(1, read / total);
}

/**
 * @param {CacheObservation} observation
 * @returns {number|null} Cost per 1k input tokens.
 */
function unitCostOf(observation) {
  const cost = positive(observation.costUsd);
  const total = positive(observation.inputTokens);
  if (cost == null || total == null) return null;
  return cost / (total / 1000);
}

/**
 * Evaluate the LAST observation against the earlier ones.
 *
 * @param {CacheObservation[]} observations Oldest first.
 * @param {{
 *   ttlMs?: number|null,
 *   hitRatioDrop?: number,
 *   costIncrease?: number,
 *   latencyIncrease?: number,
 * }} [options]
 * @returns {{
 *   status: string,
 *   coldStartCause: string|null,
 *   signals: Array<{ id: string, baseline: number, observed: number }>,
 *   baselineTurns: number,
 * }}
 */
export function detectCacheRegression(observations, options = {}) {
  const list = (Array.isArray(observations) ? observations : [])
    .filter((row) => row && Number.isFinite(Number(row.at)))
    .sort((a, b) => Number(a.at) - Number(b.at));
  const result = { status: CACHE_REGRESSION_STATUS.INSUFFICIENT_DATA, coldStartCause: null, signals: [], baselineTurns: 0 };
  if (!list.length) return result;
  const latest = list[list.length - 1];
  const earlier = list.slice(0, -1);
  const ttlMs = positive(options.ttlMs);
  const previous = earlier[earlier.length - 1] || null;
  const cold = (cause) => ({ ...result, status: CACHE_REGRESSION_STATUS.COLD_START, coldStartCause: cause });
  if (!previous) return cold(CACHE_COLD_START_CAUSE.FIRST_TURN);
  const generation = Number(latest.generation) || 0;
  if ((Number(previous.generation) || 0) !== generation) return cold(CACHE_COLD_START_CAUSE.GENERATION_CHANGED);
  if (String(previous.prefixFingerprint || '') !== String(latest.prefixFingerprint || '')) {
    return cold(CACHE_COLD_START_CAUSE.PREFIX_CHANGED);
  }
  if (ttlMs != null && Number(latest.at) - Number(previous.at) > ttlMs) {
    return cold(CACHE_COLD_START_CAUSE.TTL_EXPIRED);
  }
  // Warm baseline: earlier turns of the same generation and prefix that hit.
  const baseline = earlier.filter((row) => (Number(row.generation) || 0) === generation
    && String(row.prefixFingerprint || '') === String(latest.prefixFingerprint || '')
    && (hitRatioOf(row) ?? 0) > 0);
  result.baselineTurns = baseline.length;
  const dropTol = Number(options.hitRatioDrop) > 0 ? Number(options.hitRatioDrop) : CACHE_REGRESSION_DEFAULTS.hitRatioDrop;
  const costTol = Number(options.costIncrease) > 0 ? Number(options.costIncrease) : CACHE_REGRESSION_DEFAULTS.costIncrease;
  const latTol = Number(options.latencyIncrease) > 0 ? Number(options.latencyIncrease) : CACHE_REGRESSION_DEFAULTS.latencyIncrease;
  let evaluated = 0;
  const baseRatio = median(baseline.map(hitRatioOf).filter((v) => v != null));
  const ratio = hitRatioOf(latest);
  if (baseRatio != null && ratio != null) {
    evaluated += 1;
    if (ratio < baseRatio - dropTol) {
      result.signals.push({ id: CACHE_REGRESSION_SIGNAL.HIT_RATIO_DROP, baseline: baseRatio, observed: ratio });
    }
  }
  const baseCost = median(baseline.map(unitCostOf).filter((v) => v != null));
  const cost = unitCostOf(latest);
  if (baseCost != null && cost != null) {
    evaluated += 1;
    if (cost > baseCost * (1 + costTol)) {
      result.signals.push({ id: CACHE_REGRESSION_SIGNAL.COST_INCREASE, baseline: baseCost, observed: cost });
    }
  }
  const baseLatency = median(baseline.map((row) => positive(row.latencyMs)).filter((v) => v != null));
  const latency = positive(latest.latencyMs);
  if (baseLatency != null && latency != null) {
    evaluated += 1;
    if (latency > baseLatency * (1 + latTol)) {
      result.signals.push({ id: CACHE_REGRESSION_SIGNAL.LATENCY_INCREASE, baseline: baseLatency, observed: latency });
    }
  }
  if (result.signals.length) result.status = CACHE_REGRESSION_STATUS.REGRESSION;
  else if (evaluated > 0) result.status = CACHE_REGRESSION_STATUS.OK;
  return result;
}
