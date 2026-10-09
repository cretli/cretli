/**
 * Versioned policy constants for persisted model_pick decisions and for the
 * out-of-band exploration budget (stage 6).
 */

/** Bump when pick semantics or candidate bounds change. */
export const MODEL_PICK_POLICY_VERSION = 'pick-policy-2026-10-06';

/**
 * Version of the review protocol that turns an implement/fix → review cycle
 * into an acceptance signal: VERDICT parsing, sibling rules, the verify
 * requirement and the manual-accept rule. Bump it when any of those change.
 *
 * Canonical model stats key a cohort by this version. History written before
 * the field existed carries no version, so it is reported as `unknown` — never
 * silently attributed to this current value.
 */
export const MODEL_PICK_REVIEW_PROTOCOL_VERSION = 'review-protocol-2026-10-09';

/** Bump when an explore allocation rule changes: unit, budget, caps, cooldown. */
export const MODEL_PICK_EXPLORE_POLICY_VERSION = 'explore-policy-2026-10-08';

/** Exploration modes: `off` never evaluates, `dry-run` logs, `real` may start. */
export const MODEL_PICK_EXPLORE_MODES = Object.freeze(['off', 'dry-run', 'real']);

/**
 * Hard ceilings of one exploration attempt. A config row may lower them, never
 * raise them: an out-of-band attempt must stay inside a bounded, enforceable
 * cost and a bounded executor time, and a leaf with less than ten minutes of
 * deadline left must not be the place where that is discovered.
 */
export const MODEL_PICK_EXPLORE_MAX_USD = 0.5;
export const MODEL_PICK_EXPLORE_MAX_EXECUTOR_MS = 5 * 60 * 1000;
export const MODEL_PICK_EXPLORE_MIN_DEADLINE_MS = 10 * 60 * 1000;
/** Post-infra-fail pair lockout floor: configurable upward, never downward. */
export const MODEL_PICK_EXPLORE_MIN_COOLDOWN_MS = 72 * 60 * 60 * 1000;

/** A pick proposal expires after 30 minutes if no delegation claims a slot. */
export const MODEL_PICK_TTL_MS = 30 * 60 * 1000;

/** Unclaimed pick records are retained for 30 days before purge. */
export const MODEL_PICK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum candidates stored on one pick (bounded set for audit). */
export const MODEL_PICK_MAX_CANDIDATES = 12;

/** Maximum fanout slots per pick (matches model_pick count cap). */
export const MODEL_PICK_MAX_SLOTS = 5;

/**
 * Acceptance policy for cycle metrics. When true, an `accepted-by-review`
 * cycle additionally needs a passed host verify on every review; a missing
 * verify then blocks acceptance. A verify that ran and did not pass always
 * blocks, whatever this flag says.
 */
export const MODEL_PICK_REQUIRE_VERIFY_FOR_ACCEPTANCE = false;

/** Usage events are joined over this window; older events are cut off. */
export const MODEL_PICK_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Alias for explore attempt summarization (same window as usage). */
export const MODEL_PICK_EXPLORE_WINDOW_MS = MODEL_PICK_USAGE_WINDOW_MS;

/**
 * @typedef {{
 *   mode: 'off' | 'dry-run' | 'real',
 *   minObservedN: number,
 *   windowMs: number,
 *   everyAutoExecuted: number,
 *   maxPerWorkspacePerUtcDay: number,
 *   maxPerHarnessPerUtcDay: number,
 *   minPairIntervalMs: number,
 *   infraCooldownMs: number,
 *   maxAttemptUsd: number,
 *   maxExecutorMs: number,
 *   minDeadlineMs: number,
 *   maxCostTier: number,
 *   premiumOptIn: boolean,
 *   autopilot: boolean,
 *   allowFixWithoutReview: boolean,
 * }} ModelPickExploreConfig
 */

/**
 * First-deployment defaults: dry-run only, real exploration OFF.
 *
 * `everyAutoExecuted` mints one explore credit per ten automatically executed
 * implement/fix jobs; the caps bound how fast those credits may be spent.
 *
 * @type {ModelPickExploreConfig}
 */
export const MODEL_PICK_EXPLORE_CONFIG_DEFAULTS = Object.freeze({
  mode: 'dry-run',
  minObservedN: 10,
  windowMs: MODEL_PICK_USAGE_WINDOW_MS,
  everyAutoExecuted: 10,
  maxPerWorkspacePerUtcDay: 2,
  maxPerHarnessPerUtcDay: 1,
  minPairIntervalMs: 7 * 24 * 60 * 60 * 1000,
  infraCooldownMs: MODEL_PICK_EXPLORE_MIN_COOLDOWN_MS,
  maxAttemptUsd: MODEL_PICK_EXPLORE_MAX_USD,
  maxExecutorMs: MODEL_PICK_EXPLORE_MAX_EXECUTOR_MS,
  minDeadlineMs: MODEL_PICK_EXPLORE_MIN_DEADLINE_MS,
  maxCostTier: 3,
  premiumOptIn: false,
  autopilot: false,
  allowFixWithoutReview: false,
});

/**
 * Bump when a shadow scoring or observability rule changes.
 *
 * `shadow-policy-2026-10-09` integrates the stage-7 measurement fact input
 * (`lib/model-pick-shadow-facts.js`): a measured `api_metered` cost and a
 * provenance-labelled speed signal can now drive the shadow score. Because that
 * is a new normalization, the version is part of the agreement-window segment,
 * so comparisons taken under the previous normalization are not mixed in.
 */
export const MODEL_PICK_SHADOW_POLICY_VERSION = 'shadow-policy-2026-10-09';

/**
 * Shadow modes. `off` disables the shadow layer completely; `shadow` computes
 * the alternative ranking and persists the comparison but never changes the
 * selection. Promotion to a real ranking change is a separate, dormant flag.
 */
export const MODEL_PICK_SHADOW_MODES = Object.freeze(['off', 'shadow']);

/**
 * Minimum observation window before any rollout decision may be taken: the
 * later of 14 days and 200 shadow calls. This stage only counts the window;
 * it does not promote.
 */
export const MODEL_PICK_SHADOW_MIN_DAYS = 14;
export const MODEL_PICK_SHADOW_MIN_CALLS = 200;

/** p99 overhead budget of the whole shadow layer inside one pick. */
export const MODEL_PICK_SHADOW_MAX_OVERHEAD_MS = 20;

/**
 * Review agreement floor. Below it the report raises a stop flag (a report
 * signal, never a runtime kill: the selected pick is unchanged anyway).
 */
export const MODEL_PICK_SHADOW_REVIEW_AGREEMENT_FLOOR = 0.7;

/**
 * Freshness threshold of an endpoint price read from the stage-3 cache.
 *
 * The cache itself refreshes every 15 minutes (`OPENROUTER_MODELS_CACHE_TTL_MS`)
 * and keeps the last good catalog indefinitely, so a served price can be
 * arbitrarily old. The shadow treats a price older than this threshold as
 * `stale`: it still reports the value with its age, but it does not let an old
 * estimate move a score. One day keeps a normal refresh cycle fresh while
 * excluding a cache that survived an outage or a long offline period.
 */
export const MODEL_PICK_SHADOW_PRICE_FRESH_MS = 24 * 60 * 60 * 1000;

/** Rollout-gate thresholds (computed in this stage, promotion stays off). */
export const MODEL_PICK_SHADOW_ROLLOUT_MIN_DECIDED_CYCLES = 20;
export const MODEL_PICK_SHADOW_INFRA_FAIL_MAX_INCREASE_PP = 5;
export const MODEL_PICK_SHADOW_COST_INCREASE_MAX_RATIO = 0.15;
export const MODEL_PICK_SHADOW_PASS_RATE_IMPROVEMENT_MIN_PP = 10;

/**
 * @typedef {{
 *   mode: 'off' | 'shadow',
 *   promotion: boolean,
 *   minDays: number,
 *   minCalls: number,
 *   priceFreshMs: number,
 *   maxOverheadMs: number,
 *   reviewAgreementFloor: number,
 *   rolloutMinDecidedCycles: number,
 *   infraFailMaxIncreasePp: number,
 *   costIncreaseMaxRatio: number,
 *   passRateImprovementMinPp: number,
 * }} ModelPickShadowConfig
 */

/**
 * Shipped default: shadow observation ON, promotion OFF. Like `explore`
 * `dry-run`, the observer runs by default so the agreement window starts
 * collecting, while nothing about the actual selection changes.
 *
 * @type {ModelPickShadowConfig}
 */
export const MODEL_PICK_SHADOW_CONFIG_DEFAULTS = Object.freeze({
  mode: 'shadow',
  promotion: false,
  minDays: MODEL_PICK_SHADOW_MIN_DAYS,
  minCalls: MODEL_PICK_SHADOW_MIN_CALLS,
  priceFreshMs: MODEL_PICK_SHADOW_PRICE_FRESH_MS,
  maxOverheadMs: MODEL_PICK_SHADOW_MAX_OVERHEAD_MS,
  reviewAgreementFloor: MODEL_PICK_SHADOW_REVIEW_AGREEMENT_FLOOR,
  rolloutMinDecidedCycles: MODEL_PICK_SHADOW_ROLLOUT_MIN_DECIDED_CYCLES,
  infraFailMaxIncreasePp: MODEL_PICK_SHADOW_INFRA_FAIL_MAX_INCREASE_PP,
  costIncreaseMaxRatio: MODEL_PICK_SHADOW_COST_INCREASE_MAX_RATIO,
  passRateImprovementMinPp: MODEL_PICK_SHADOW_PASS_RATE_IMPROVEMENT_MIN_PP,
});

/**
 * Shadow policy from `data/model-role-profiles.json`. Accepts a whole document
 * with a top-level `shadow` key, a bare shadow object, a mode string, or a
 * boolean (`true` = shadow, `false` = off). Anything unrecognised falls back to
 * the defaults, which never promote.
 *
 * Every threshold is a floor/ceiling, not a suggestion: a row that asks for a
 * shorter window, a higher overhead budget or a lower review floor gets the
 * documented bound, so an operator file cannot weaken a safety gate.
 *
 * @param {unknown} raw
 * @returns {ModelPickShadowConfig}
 */
export function normalizeModelPickShadowConfig(raw) {
  const base = MODEL_PICK_SHADOW_CONFIG_DEFAULTS;
  if (raw == null || raw === '') return base;
  if (typeof raw === 'boolean') return Object.freeze({ ...base, mode: raw ? 'shadow' : 'off' });
  if (typeof raw === 'string') {
    const mode = raw.trim().toLowerCase();
    return MODEL_PICK_SHADOW_MODES.includes(/** @type {'off'|'shadow'} */ (mode))
      ? Object.freeze({ ...base, mode })
      : base;
  }
  if (typeof raw !== 'object') return base;
  const doc = /** @type {Record<string, unknown>} */ (raw);
  const nested = doc.shadow;
  if (typeof nested === 'boolean' || typeof nested === 'string') return normalizeModelPickShadowConfig(nested);
  const src = (nested && typeof nested === 'object'
    ? /** @type {Record<string, unknown>} */ (nested)
    : doc);
  const modeValue = String(src.mode ?? doc.mode ?? '').trim().toLowerCase();
  const mode = MODEL_PICK_SHADOW_MODES.includes(/** @type {any} */ (modeValue))
    ? /** @type {'off'|'shadow'} */ (modeValue)
    : base.mode;
  return Object.freeze({
    mode,
    promotion: src.promotion === true || doc.promotion === true,
    minDays: normalizeSpan(src.minDays ?? doc.minDays, base.minDays, { min: MODEL_PICK_SHADOW_MIN_DAYS }),
    minCalls: Math.max(
      MODEL_PICK_SHADOW_MIN_CALLS,
      normalizeCount(src.minCalls ?? doc.minCalls, base.minCalls, 1000000),
    ),
    priceFreshMs: normalizeSpan(src.priceFreshMs ?? doc.priceFreshMs, base.priceFreshMs, {
      max: MODEL_PICK_SHADOW_PRICE_FRESH_MS,
      min: 60 * 1000,
    }),
    maxOverheadMs: normalizeSpan(src.maxOverheadMs ?? doc.maxOverheadMs, base.maxOverheadMs, {
      max: MODEL_PICK_SHADOW_MAX_OVERHEAD_MS,
      min: 1,
    }),
    reviewAgreementFloor: normalizeSpan(src.reviewAgreementFloor ?? doc.reviewAgreementFloor, base.reviewAgreementFloor, {
      min: MODEL_PICK_SHADOW_REVIEW_AGREEMENT_FLOOR,
      max: 1,
    }),
    rolloutMinDecidedCycles: Math.max(
      MODEL_PICK_SHADOW_ROLLOUT_MIN_DECIDED_CYCLES,
      normalizeCount(
        src.rolloutMinDecidedCycles ?? doc.rolloutMinDecidedCycles,
        base.rolloutMinDecidedCycles,
        1000000,
      ),
    ),
    infraFailMaxIncreasePp: normalizeSpan(src.infraFailMaxIncreasePp ?? doc.infraFailMaxIncreasePp, base.infraFailMaxIncreasePp, {
      max: MODEL_PICK_SHADOW_INFRA_FAIL_MAX_INCREASE_PP,
      min: 0,
    }),
    costIncreaseMaxRatio: normalizeSpan(src.costIncreaseMaxRatio ?? doc.costIncreaseMaxRatio, base.costIncreaseMaxRatio, {
      max: MODEL_PICK_SHADOW_COST_INCREASE_MAX_RATIO,
      min: 0,
    }),
    passRateImprovementMinPp: normalizeSpan(
      src.passRateImprovementMinPp ?? doc.passRateImprovementMinPp,
      base.passRateImprovementMinPp,
      { min: MODEL_PICK_SHADOW_PASS_RATE_IMPROVEMENT_MIN_PP, max: 100 },
    ),
  });
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ max?: number, min?: number }} [bounds]
 * @returns {number}
 */
function normalizeSpan(value, fallback, bounds = {}) {
  const n = Number(value);
  let out = Number.isFinite(n) && n > 0 ? n : fallback;
  if (Number.isFinite(out)) {
    if (Number.isFinite(bounds.max)) out = Math.min(out, /** @type {number} */ (bounds.max));
    if (Number.isFinite(bounds.min)) out = Math.max(out, /** @type {number} */ (bounds.min));
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function normalizeCount(value, fallback, max) {
  const n = Number(value);
  const out = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.max(1, Math.min(out, max));
}

/**
 * Explore policy from `data/model-role-profiles.json`. Accepts a whole document
 * with a top-level `explore` key, a bare explore object, a mode string, or a
 * boolean (`true` = dry-run, `false` = off). Anything unrecognised falls back to
 * the defaults, which never enable real exploration.
 *
 * Cost, executor time and the cooldown floor are ceilings, not suggestions: a
 * row that asks for a 5 USD attempt or a 1-hour infra cooldown gets the ceiling.
 *
 * @param {unknown} raw
 * @returns {ModelPickExploreConfig}
 */
export function normalizeModelPickExploreConfig(raw) {
  const base = MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  if (raw == null || raw === '') return base;
  if (typeof raw === 'boolean') return Object.freeze({ ...base, mode: raw ? 'dry-run' : 'off' });
  if (typeof raw === 'string') {
    const mode = raw.trim().toLowerCase();
    return MODEL_PICK_EXPLORE_MODES.includes(/** @type {import('./model-pick-policy.js').ModelPickExploreConfig['mode']} */ (mode))
      ? Object.freeze({ ...base, mode })
      : base;
  }
  if (typeof raw !== 'object') return base;
  const doc = /** @type {Record<string, unknown>} */ (raw);
  const nested = doc.explore;
  if (typeof nested === 'boolean' || typeof nested === 'string') return normalizeModelPickExploreConfig(nested);
  const src = (nested && typeof nested === 'object'
    ? /** @type {Record<string, unknown>} */ (nested)
    : doc);
  const modeValue = String(src.mode ?? doc.mode ?? '').trim().toLowerCase();
  const mode = MODEL_PICK_EXPLORE_MODES.includes(/** @type {any} */ (modeValue))
    ? /** @type {import('./model-pick-policy.js').ModelPickExploreConfig['mode']} */ (modeValue)
    : base.mode;
  return Object.freeze({
    mode,
    minObservedN: normalizeCount(src.minObservedN ?? doc.minObservedN, base.minObservedN, 1000),
    windowMs: normalizeSpan(src.windowMs ?? doc.windowMs, base.windowMs, { max: base.windowMs }),
    everyAutoExecuted: normalizeCount(src.everyAutoExecuted ?? doc.everyAutoExecuted, base.everyAutoExecuted, 100000),
    maxPerWorkspacePerUtcDay: normalizeCount(src.maxPerWorkspacePerUtcDay ?? doc.maxPerWorkspacePerUtcDay, base.maxPerWorkspacePerUtcDay, 10),
    maxPerHarnessPerUtcDay: normalizeCount(src.maxPerHarnessPerUtcDay ?? doc.maxPerHarnessPerUtcDay, base.maxPerHarnessPerUtcDay, 10),
    minPairIntervalMs: normalizeSpan(src.minPairIntervalMs ?? doc.minPairIntervalMs, base.minPairIntervalMs, { min: 0 }),
    infraCooldownMs: normalizeSpan(src.infraCooldownMs ?? doc.infraCooldownMs, base.infraCooldownMs, { min: MODEL_PICK_EXPLORE_MIN_COOLDOWN_MS }),
    maxAttemptUsd: normalizeSpan(src.maxAttemptUsd ?? doc.maxAttemptUsd, base.maxAttemptUsd, { max: MODEL_PICK_EXPLORE_MAX_USD }),
    maxExecutorMs: normalizeSpan(src.maxExecutorMs ?? doc.maxExecutorMs, base.maxExecutorMs, { max: MODEL_PICK_EXPLORE_MAX_EXECUTOR_MS }),
    minDeadlineMs: normalizeSpan(src.minDeadlineMs ?? doc.minDeadlineMs, base.minDeadlineMs, { min: MODEL_PICK_EXPLORE_MIN_DEADLINE_MS }),
    maxCostTier: normalizeCount(src.maxCostTier ?? doc.maxCostTier, base.maxCostTier, 5),
    premiumOptIn: src.premiumOptIn === true || doc.premiumOptIn === true,
    autopilot: src.autopilot === true || doc.autopilot === true,
    allowFixWithoutReview: src.allowFixWithoutReview === true || doc.allowFixWithoutReview === true,
  });
}

/**
 * Full policy version stored on pick records and MCP `model_pick` responses.
 * Pass the eligibility cohort from {@link buildModelPickEligibilityCohort}.
 *
 * The shadow segment is a separate cohort label: the observer changes what is
 * measured, never what is selected, so a shadow cohort must not be mixed with
 * the pre-shadow one when agreement is evaluated.
 *
 * @param {string} [eligibilityCohort]
 * @param {string} [exploreSegment]
 * @param {string} [shadowSegment]
 * @returns {string}
 */
export function composeModelPickPolicyVersion(eligibilityCohort = '', exploreSegment = '', shadowSegment = '') {
  const cohort = String(eligibilityCohort || '').trim();
  const explore = String(exploreSegment || '').trim();
  const shadow = String(shadowSegment || '').trim();
  let version = MODEL_PICK_POLICY_VERSION;
  if (cohort) version += `;cohort=${cohort}`;
  if (explore) version += `;explore=${explore}`;
  if (shadow) version += `;shadow=${shadow}`;
  return version;
}

/**
 * Explore segment of the policy version. `off` composes an empty segment, so a
 * deployment without exploration keeps the historical version byte for byte;
 * `dry-run` and `real` are separate cohorts, so flipping the real-exploration
 * flag (or bumping the explore policy) segments the stage-7 shadow window
 * instead of mixing new attempts with the cohort measured so far.
 *
 * @param {ModelPickExploreConfig | string | null | undefined} config
 * @returns {string}
 */
export function composeModelPickExploreSegment(config) {
  const mode = typeof config === 'string'
    ? config.trim().toLowerCase()
    : String(config?.mode || '').trim().toLowerCase();
  if (mode !== 'dry-run' && mode !== 'real') return '';
  return `${mode}+${MODEL_PICK_EXPLORE_POLICY_VERSION}`;
}

/**
 * Shadow segment of the policy version. `off` composes an empty segment, so a
 * deployment without the observer keeps the historical version byte for byte.
 * `promotion` flips the segment too, so a future real rollout starts a new
 * cohort instead of reusing the agreement window measured in shadow mode.
 *
 * @param {ModelPickShadowConfig | string | null | undefined} config
 * @returns {string}
 */
export function composeModelPickShadowSegment(config) {
  const mode = typeof config === 'string'
    ? config.trim().toLowerCase()
    : String(config?.mode || '').trim().toLowerCase();
  if (mode !== 'shadow') return '';
  const promotion = typeof config === 'object' && config?.promotion === true;
  return `${mode}${promotion ? '+promoted' : ''}+${MODEL_PICK_SHADOW_POLICY_VERSION}`;
}
