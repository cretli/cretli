/**
 * Shadow agreement report and the dormant rollout gate.
 *
 * Everything here is pure arithmetic over counters and rates: no model call, no
 * store read, no network. The shadow observer itself lives in
 * `lib/model-pick-shadow.js`; this module only turns the observed comparisons
 * into an agreement report and evaluates the (currently dormant) promotion
 * criteria.
 *
 * The observer changes nothing, so a stop flag is a report signal, never a
 * runtime kill. The selection stays the ordinary `selectModelPick` output.
 */

import {
  MODEL_PICK_SHADOW_CONFIG_DEFAULTS,
  MODEL_PICK_SHADOW_INFRA_FAIL_MAX_INCREASE_PP,
  MODEL_PICK_SHADOW_MIN_CALLS,
  MODEL_PICK_SHADOW_MIN_DAYS,
  MODEL_PICK_SHADOW_REVIEW_AGREEMENT_FLOOR,
  MODEL_PICK_SHADOW_ROLLOUT_MIN_DECIDED_CYCLES,
  MODEL_PICK_SHADOW_COST_INCREASE_MAX_RATIO,
  MODEL_PICK_SHADOW_PASS_RATE_IMPROVEMENT_MIN_PP,
} from './model-pick-policy.js';

/** Two-sided 95% normal quantile used by the Wilson score interval. */
export const WILSON_Z_95 = 1.959963984540054;

/** One day in milliseconds, for the minimum observation window. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function asCount(value, fallback = 0) {
  const n = asFinite(value);
  if (n == null || n < 0) return fallback;
  return Math.round(n);
}

/**
 * Wilson score interval for a binomial proportion. This is the
 * small-sample-safe interval the rollout gate uses instead of the normal
 * approximation: with 20 cycles a raw `p - z*se` lower bound is almost always
 * negative even for a genuinely better arm.
 *
 * @param {number} successes
 * @param {number} n
 * @param {number} [z]
 * @returns {{ p: number, lower: number, upper: number } | null} null when n = 0
 */
export function wilsonInterval(successes, n, z = WILSON_Z_95) {
  const total = asCount(n);
  if (total <= 0) return null;
  const wins = Math.max(0, Math.min(total, asCount(successes)));
  const p = wins / total;
  const z2 = z * z;
  const denom = 1 + (z2 / total);
  const center = p + (z2 / (2 * total));
  const margin = z * Math.sqrt(((p * (1 - p)) / total) + (z2 / (4 * total * total)));
  return {
    p,
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
  };
}

/**
 * @param {number} successes
 * @param {number} n
 * @param {number} [z]
 * @returns {number | null}
 */
export function wilsonLowerBound(successes, n, z = WILSON_Z_95) {
  const interval = wilsonInterval(successes, n, z);
  return interval ? interval.lower : null;
}

/**
 * @param {number} successes
 * @param {number} n
 * @param {number} [z]
 * @returns {number | null}
 */
export function wilsonUpperBound(successes, n, z = WILSON_Z_95) {
  const interval = wilsonInterval(successes, n, z);
  return interval ? interval.upper : null;
}

/**
 * Lower bound of the Wilson score interval for the **difference** of two
 * proportions (Newcombe hybrid score method 10). The rollout gate requires
 * `>= 0`: the shadow arm must not look worse than the baseline even at the
 * pessimistic edge of the interval.
 *
 * @param {{ successes?: number, n?: number }} arm
 * @param {{ successes?: number, n?: number }} baseline
 * @param {number} [z]
 * @returns {number | null} null when either arm has no decided cycle
 */
export function wilsonLowerBoundDifference(arm, baseline, z = WILSON_Z_95) {
  const armInterval = wilsonInterval(arm?.successes, arm?.n, z);
  const baseInterval = wilsonInterval(baseline?.successes, baseline?.n, z);
  if (!armInterval || !baseInterval) return null;
  const p1 = armInterval.p;
  const p2 = baseInterval.p;
  const margin = Math.sqrt(
    ((p1 - armInterval.lower) ** 2) + ((baseInterval.upper - p2) ** 2),
  );
  return (p1 - p2) - margin;
}

/**
 * Agreement report per role from persisted counters.
 *
 * @param {Record<string, { n?: number, agree?: number }>} byRole
 * @param {{
 *   reviewAgreementFloor?: number,
 *   reviewPassRateInfluencesScore?: boolean,
 * }} [options]
 * @returns {{
 *   byRole: Record<string, { n: number, agree: number, disagree: number, agreement_rate: number }>,
 *   overall: { n: number, agree: number, agreement_rate: number },
 *   stop_flags: {
 *     review_agreement_below_floor: boolean,
 *     review_pass_rate_in_quality_score: boolean,
 *     stop: boolean,
 *   },
 * }}
 */
export function buildShadowAgreementReport(byRole = {}, options = {}) {
  const floor = asFinite(options.reviewAgreementFloor) ?? MODEL_PICK_SHADOW_REVIEW_AGREEMENT_FLOOR;
  /** @type {Record<string, { n: number, agree: number, disagree: number, agreement_rate: number }>} */
  const roles = {};
  let overallN = 0;
  let overallAgree = 0;
  for (const [role, raw] of Object.entries(byRole || {})) {
    const n = asCount(raw?.n);
    const agree = Math.max(0, Math.min(n, asCount(raw?.agree)));
    roles[role] = {
      n,
      agree,
      disagree: n - agree,
      agreement_rate: n > 0 ? agree / n : null,
    };
    overallN += n;
    overallAgree += agree;
  }
  const review = roles.review;
  const reviewAgreementBelowFloor = Boolean(review)
    && review.n > 0
    && review.agreement_rate != null
    && review.agreement_rate < floor;
  const reviewPassRateInQuality = options.reviewPassRateInfluencesScore === true;
  return {
    byRole: roles,
    overall: {
      n: overallN,
      agree: overallAgree,
      agreement_rate: overallN > 0 ? overallAgree / overallN : null,
    },
    stop_flags: {
      review_agreement_below_floor: reviewAgreementBelowFloor,
      review_pass_rate_in_quality_score: reviewPassRateInQuality,
      stop: reviewAgreementBelowFloor || reviewPassRateInQuality,
    },
  };
}

/**
 * Minimum observation window: the **later** of `minDays` and `minCalls`. The
 * counters may still be growing; this only reports whether the window is
 * satisfied, it never promotes.
 *
 * @param {{
 *   firstAt?: unknown,
 *   now?: unknown,
 *   calls?: unknown,
 *   minDays?: unknown,
 *   minCalls?: unknown,
 * }} [input]
 * @returns {{
 *   first_at: string | null,
 *   age_days: number,
 *   calls: number,
 *   min_days: number,
 *   min_calls: number,
 *   days_satisfied: boolean,
 *   calls_satisfied: boolean,
 *   satisfied: boolean,
 * }}
 */
export function evaluateShadowWindow(input = {}) {
  const now = asFinite(input.now) ?? Date.now();
  const minDays = asFinite(input.minDays) ?? MODEL_PICK_SHADOW_MIN_DAYS;
  const minCalls = asFinite(input.minCalls) ?? MODEL_PICK_SHADOW_MIN_CALLS;
  const calls = asCount(input.calls);
  const firstMs = input.firstAt == null ? NaN : Date.parse(String(input.firstAt));
  const ageMs = Number.isFinite(firstMs) ? Math.max(0, now - firstMs) : 0;
  const ageDays = ageMs / DAY_MS;
  const daysSatisfied = Number.isFinite(firstMs) && ageDays >= minDays;
  const callsSatisfied = calls >= minCalls;
  return {
    first_at: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    age_days: ageDays,
    calls,
    min_days: minDays,
    min_calls: minCalls,
    days_satisfied: daysSatisfied,
    calls_satisfied: callsSatisfied,
    satisfied: daysSatisfied && callsSatisfied,
  };
}

/**
 * Rollout gate. All arithmetic is implemented and tested in this stage, but the
 * promotion flag defaults to `false`, so `eligible` is `false` and `dormant` is
 * `true`. `metrics_eligible` still reports what the numbers would have said, so
 * the decision is auditable without turning anything on.
 *
 * Rules:
 * - only the `implement` role is eligible for the first rollout;
 * - only `api_metered` arms are considered (`billingClass`);
 * - at least `rolloutMinDecidedCycles` decided cycles on divergent pairs;
 * - `wilsonLowerBoundDifference(pass_rate) >= 0`;
 * - infra-fail increase at most `infraFailMaxIncreasePp` percentage points;
 * - USD per successful cycle may not grow more than `costIncreaseMaxRatio`
 *   unless the pass rate improved by at least `passRateImprovementMinPp` points.
 *
 * @param {{
 *   role?: unknown,
 *   billingClass?: unknown,
 *   decidedCycles?: unknown,
 *   promotionEnabled?: unknown,
 *   passRate?: { successes?: number, n?: number },
 *   baselinePassRate?: { successes?: number, n?: number },
 *   infraFailRate?: unknown,
 *   baselineInfraFailRate?: unknown,
 *   usdPerSuccess?: unknown,
 *   baselineUsdPerSuccess?: unknown,
 *   config?: Partial<import('./model-pick-policy.js').ModelPickShadowConfig>,
 * }} [input]
 * @returns {{
 *   eligible: boolean,
 *   dormant: boolean,
 *   metrics_eligible: boolean,
 *   billing_class: string,
 *   reasons: string[],
 *   metrics: {
 *     decided_cycles: number,
 *     pass_rate_arm: number | null,
 *     pass_rate_baseline: number | null,
 *     pass_rate_delta_pp: number | null,
 *     wilson_lower_bound_diff: number | null,
 *     infra_fail_delta_pp: number | null,
 *     cost_ratio: number | null,
 *   },
 * }}
 */
export function evaluateShadowRolloutGate(input = {}) {
  const config = { ...MODEL_PICK_SHADOW_CONFIG_DEFAULTS, ...(input.config || {}) };
  const promotionEnabled = input.promotionEnabled === true || config.promotion === true;
  const billingClass = String(input.billingClass ?? 'api_metered').trim().toLowerCase();
  const decidedCycles = asCount(input.decidedCycles);
  const armInterval = wilsonInterval(input.passRate?.successes, input.passRate?.n);
  const baseInterval = wilsonInterval(input.baselinePassRate?.successes, input.baselinePassRate?.n);
  const passRateDelta = armInterval && baseInterval ? armInterval.p - baseInterval.p : null;
  const wilsonDiff = wilsonLowerBoundDifference(input.passRate, input.baselinePassRate);
  const infraArm = asFinite(input.infraFailRate);
  const infraBase = asFinite(input.baselineInfraFailRate);
  const infraDeltaPp = infraArm != null && infraBase != null ? (infraArm - infraBase) * 100 : null;
  const costArm = asFinite(input.usdPerSuccess);
  const costBase = asFinite(input.baselineUsdPerSuccess);
  const costRatio = costArm != null && costBase != null && costBase > 0 ? costArm / costBase : null;
  /** @type {string[]} */
  const reasons = [];
  const role = String(input.role ?? 'implement').trim().toLowerCase();
  if (role !== 'implement') reasons.push('role-not-implement');
  if (billingClass !== 'api_metered') reasons.push('billing-class-not-api_metered');
  if (decidedCycles < config.rolloutMinDecidedCycles) reasons.push('insufficient-decided-cycles');
  if (wilsonDiff == null || wilsonDiff < 0) reasons.push('wilson-lower-bound-negative');
  if (infraDeltaPp != null && infraDeltaPp > config.infraFailMaxIncreasePp) reasons.push('infra-fail-increase');
  const passRateImprovementPp = passRateDelta == null ? null : passRateDelta * 100;
  if (costRatio != null
    && costRatio > 1 + config.costIncreaseMaxRatio
    && (passRateImprovementPp == null || passRateImprovementPp < config.passRateImprovementMinPp)) {
    reasons.push('cost-increase-without-pass-rate-improvement');
  }
  const metricsEligible = reasons.length === 0;
  if (!promotionEnabled) reasons.unshift('promotion-disabled');
  return {
    eligible: promotionEnabled && metricsEligible,
    dormant: !promotionEnabled,
    metrics_eligible: metricsEligible,
    billing_class: billingClass,
    reasons,
    metrics: {
      decided_cycles: decidedCycles,
      pass_rate_arm: armInterval ? armInterval.p : null,
      pass_rate_baseline: baseInterval ? baseInterval.p : null,
      pass_rate_delta_pp: passRateImprovementPp,
      wilson_lower_bound_diff: wilsonDiff,
      infra_fail_delta_pp: infraDeltaPp,
      cost_ratio: costRatio,
    },
  };
}
