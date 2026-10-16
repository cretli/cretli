/**
 * Role profiles for MCP model_pick (plan / implement / review / fix).
 *
 * Eligibility is a declarative alias/family policy, not a substring test: every
 * built-in rule names a **verified family** from `lib/model-alias-policy.js`
 * (with its catalog evidence) and matches it on name boundaries, so no model can
 * gain a role because its id merely looks similar to one (`sol` never matches
 * `resolution`, `gpt-6-solomon` or a `::effort=sol` parameter). Rules may narrow
 * a match with `variant` / `effort`, and an operator may override the policy from
 * `data/model-role-profiles.json` (gitignored with the rest of `data/`),
 * including the documented rule grammar (`!` revoke, `sub:`, `exact:`, `re:`).
 * A family the policy does not know keeps the documented fallback: no role at
 * all, so it is never picked autonomously.
 *
 * Ranking uses cost/quality/speed axes (matcher lists are eligibility only).
 * Cost/quality/speed are heuristic tiers, never an invoice or a subscription
 * price, and are never scraped from the network.
 *
 * `MODEL_ROLE_POLICY_VERSION` plus the alias policy version form the
 * **eligibility cohort** reported on every pick, so the effect of a role change
 * is never attributed to a weights change (see `lib/model-pick-policy.js`).
 *
 * ## Operator format: legacy full-list vs delta
 *
 * The operator file (`data/model-role-profiles.json`) can express role overrides
 * in two ways. Per role the documented precedence is:
 *
 * 1. **Legacy full-list override** — `roles.<role>` (or a top-level `<role>`
 *    key) is a non-empty array. The whole built-in list for that role is
 *    replaced by the operator list (`normalizeMatchers(..., 'operator')`). An
 *    empty array is ignored, so the built-in policy stays. This is the original
 *    behavior and is preserved bit-for-bit.
 * 2. **Delta** — top-level `rolesDelta.<role>` is applied **on top of** the
 *    built-in policy list. The delta is `{ set, remove }` where `set` is an
 *    object keyed by pattern (`{ "<pattern>": { priority } }`) and `remove` is an
 *    array of patterns. Both are keyed by the canonical pattern, so the result
 *    does not depend on array order; a repeated `remove` is idempotent and a
 *    `set` over an existing pattern replaces its priority.
 * 3. Built-in policy when neither is present.
 *
 * The store that writes the delta (`lib/model-role-config-store.js`) migrates
 * legacy full-list overrides to an equivalent delta (`remove` = policy patterns
 * absent from the list, `set` = the remaining patterns with their explicit
 * priority), so a save converges the file to the delta form without changing
 * the effective list. Unknown top-level keys and advanced matcher rows
 * (`sub:` / `re:` / `deny` / `variant` / `effort` / unknown fields) are never
 * rewritten.
 *
 * The legacy `delegation.rotation` and `delegation.adaptivePick` keys are still
 * read for `rotation` / `adaptive` (`normalizeRotationConfig`,
 * `normalizeAdaptiveConfig`); a store write keeps `delegation` untouched.
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeModelValue } from './model-catalog.js';
import {
  PLAN_HEADROOM_LEVEL_NEUTRAL,
  PLAN_HEADROOM_LEVEL_SPARE,
  PLAN_WINDOW_TYPES,
  planHeadroomLevel,
  buildPlanPaceSignal,
  buildPlanPaceSnapshot,
  paceCostFactor,
  resolvePlanWindowConfig,
  selectPlanWindows,
} from './model-pick-plan-window.js';
import {
  PLAN_WINDOW_ESTIMATED_NOTE,
  PLAN_WINDOW_EXHAUSTED_REASON,
  PLAN_WINDOW_RELAXED_NOTE,
  planWindowExhaustedReason,
} from './model-pick-plan-window-gate.js';
import {
  estimateModelCostTier,
  estimateModelQualityTier,
  estimateModelSpeedTier,
  resolveModelProviderId,
} from './model-catalog-meta.js';
import {
  MODEL_PICK_ROLES,
  PREMIUM_REVIEW_COST_TIER,
  findActiveLockoutRow,
  hasActiveLockout,
  hasPremiumPickJustification,
  isExcludedDelegationHarness,
  isExcludedDelegationModel,
  isFlashDelegationModel,
} from './model-pick-gate-primitives.js';
import {
  MODEL_PICK_HARD_GATE_CODES,
  evaluateModelPickHardGates,
} from './model-pick-hard-gates.js';
import {
  MODEL_ALIAS_POLICY_VERSION,
  MODEL_PICK_MODES,
  UNKNOWN_FAMILY_FALLBACK,
  UNKNOWN_MODEL_FAMILY,
  compileModelNameRules,
  describeModelFamilyMatch,
  matchesModelNameRule,
  resolveModelFamily,
} from './model-alias-policy.js';
import { assertReviewAdapterAllowed, resolveHarnessDelegationTraits } from './delegation-adapter-capabilities.js';
import { resolveDelegationEnv } from './delegation-settings.js';
import { composeModelPickPolicyVersion } from './model-pick-policy.js';
import {
  evaluateModelPickExploration,
  loadModelPickExploreConfig,
  normalizeModelPickExploreConfig,
} from './model-pick-explore.js';
import { resolveDataPath } from './runtime-paths.js';

/** @typedef {'plan' | 'implement' | 'review' | 'fix'} ModelPickRole */

/**
 * Revision of the role tables below. Bumped together with
 * `MODEL_ALIAS_POLICY_VERSION` whenever a family gains or loses a role.
 */
export const MODEL_ROLE_POLICY_VERSION = 'role-policy-2026-10-12';

/**
 * Eligibility cohort boundary for pick telemetry (alias + role tables).
 *
 * @returns {string}
 */
export function buildModelPickEligibilityCohort() {
  return `${MODEL_ALIAS_POLICY_VERSION}+${MODEL_ROLE_POLICY_VERSION}`;
}

/**
 * Documented unknown-family fallback: the id is reported with the
 * `unknown-family` rejection cause and is never eligible for an autonomous pick.
 */
export const MODEL_ROLE_UNKNOWN_FAMILY_REASON = UNKNOWN_FAMILY_FALLBACK.reason;

/**
 * Re-exported from `model-pick-gate-primitives.js`. The normal picker consumes
 * the shared hard-gate validator, so the role vocabulary, the flash/lockout
 * predicates and the premium constants must stay single-sourced with it. The
 * re-export keeps every existing `model-role-profiles.js` import working.
 */
export {
  MODEL_PICK_ROLES,
  PREMIUM_REVIEW_COST_TIER,
  hasPremiumPickJustification,
  isExcludedDelegationModel,
  isExcludedDelegationHarness,
  isFlashDelegationModel,
  hasActiveLockout,
};

/**
 * @typedef {{
 *   pattern: string,
 *   priority: number,
 *   family?: string,
 *   operator?: boolean,
 *   mode?: string,
 *   deny?: boolean,
 *   variant?: string[],
 *   effort?: string[],
 * }} ModelRoleMatcher
 * @typedef {Readonly<Record<ModelPickRole, Readonly<ModelRoleMatcher[]>>>} ModelRoleProfiles
 */

/**
 * @typedef {{ cost: number, quality: number, speed: number }} ModelRoleScoreWeights
 * @typedef {Readonly<Record<ModelPickRole, Readonly<ModelRoleScoreWeights>>>} ModelRoleScoreWeightsByRole
 */

/** @type {ModelRoleScoreWeightsByRole} */
export const DEFAULT_ROLE_SCORE_WEIGHTS = Object.freeze({
  plan: Object.freeze({ cost: 0.2, quality: 0.65, speed: 0.15 }),
  implement: Object.freeze({ cost: 0.6, quality: 0.25, speed: 0.15 }),
  review: Object.freeze({ cost: 0.2, quality: 0.7, speed: 0.1 }),
  fix: Object.freeze({ cost: 0.4, quality: 0.2, speed: 0.4 }),
});

/**
 * @typedef {'off' | 'balanced' | 'explore'} ModelPickRotationMode
 * @typedef {{ band: number, mode: ModelPickRotationMode }} ModelPickRotationConfig
 */

/** Modes understood by the `rotation` setting / argument. */
export const ROTATION_MODES = Object.freeze(['off', 'balanced', 'explore']);

/**
 * Default tie-band width and rotation mode. `off` restores pure score order.
 * `data/model-role-profiles.json` may override both (`rotation.band`,
 * `rotation.mode`, or the legacy `delegation.rotation` string).
 *
 * @type {ModelPickRotationConfig}
 */
export const DEFAULT_ROTATION_CONFIG = Object.freeze({
  band: 0.05,
  mode: 'balanced',
});

/** Score bonus that lifts a cold-start harness into the tie band. */
export const COLD_START_BONUS = 0.06;
/** Cold start applies on every Nth role job across all chats (history count). */
export const COLD_START_EVERY = 5;
/** Score penalty for a fresh plan limit at/above this utilization. */
export const PLAN_LIMIT_PENALTY = 0.1;
/** Utilization percentage (0..100) treated as "plan limit nearly exhausted". */
export const PLAN_LIMIT_UTILIZATION = 90;
/**
 * Upper bound of the proportional plan-limit penalty. The penalty is a bounded
 * rotation signal: it only ever subtracts from `rotation_score`, never filters a
 * candidate or turns into a hard skip (that stays `hasActiveLockout`).
 */
export const PLAN_LIMIT_PENALTY_MAX = 0.5;
/** Base penalty of a candidate above weekly pace, before the cost-tier factor. */
export const PLAN_PACE_PENALTY = 0.15;
/**
 * Utilization percentage (0..100) from which the proportional penalty starts to
 * grow. Below it only an explicit forecast/exhaustion signal can penalise a
 * window; at/above `PLAN_LIMIT_UTILIZATION` the `PLAN_LIMIT_PENALTY` floor holds.
 */
export const PLAN_LIMIT_WARN_UTILIZATION = 70;
/**
 * Projected utilization growth (%/h) from which a plan window is treated as
 * fast-rising. A forecast below it contributes no growth penalty.
 */
export const PLAN_LIMIT_GROWTH_WARN_PERCENT_PER_HOUR = 8;
/** Projected utilization growth (%/h) at/above which the growth signal is maximal. */
export const PLAN_LIMIT_GROWTH_MAX_PERCENT_PER_HOUR = 32;
/**
 * A task is assumed to need roughly this long. When a forecast exhausts before
 * its reset, a remaining margin below it is riskier because the window can
 * collapse mid-task; the penalty grows to its maximum as the margin reaches 0.
 */
export const PLAN_LIMIT_TYPICAL_TASK_MS = 10 * 60 * 1000;

/**
 * Observed-outcome blend (task 3 of the "Delegacja v2" plan).
 *
 * A role job is a plan/implement/review delegation for one
 * (harness, base model) pair. `history.observed` carries per-pair statistics
 * computed by `lib/model-pick-history.js`; this module only consumes them, so
 * `selectModelPick` stays a pure function.
 *
 * - `OBSERVED_BLEND_HALF_LIFE`: `w = n / (n + halfLife)` — 10 jobs move the
 *   observed signal to 50% weight; it never reaches 100%. There is no hard
 *   `n` gate: every candidate shrinks toward its role prior, so a pair with no
 *   history inherits that prior instead of keeping an untouched score.
 * - `INFRA_SCORE_PENALTY_RATIO`: `score *= 1 - 0.5 * infra_eff`, where
 *   `infra_eff` is the shrunk infra rate; the penalty is proportional to the
 *   failure share, not a cliff.
 */
export const OBSERVED_BLEND_HALF_LIFE = 10;
export const INFRA_SCORE_PENALTY_RATIO = 0.5;

/**
 * Observed infra-failure share at/above which a (harness, base model) pair is
 * treated as high-risk. The score already penalises it proportionally; this
 * threshold drives the candidate ordering / top-2 exclusion, never a
 * scoring/weight change (ranking belongs to the shadow ranking work).
 */
export const HIGH_INFRA_FAIL_RATE = 0.5;

/**
 * Minimum measured jobs before the high-infra rate is trusted. A rate from one
 * or two jobs is noise (a review without a usable VERDICT counts as infra), so
 * it must not demote an otherwise eligible pair.
 */
export const HIGH_INFRA_MIN_N = 3;

/**
 * @param {unknown} observed
 * @param {number} [threshold]
 * @param {number} [minJobs]
 * @returns {boolean} true when the pair has at least `minJobs` measured jobs
 *   and infra failures above the threshold. No measurement is never high-risk.
 */
export function isHighInfraRiskObserved(observed, threshold = HIGH_INFRA_FAIL_RATE, minJobs = HIGH_INFRA_MIN_N) {
  if (!observed || typeof observed !== 'object') return false;
  const row = /** @type {{ n?: unknown, infra_fail_rate?: unknown }} */ (observed);
  const n = Number(row.n);
  const rate = Number(row.infra_fail_rate);
  return Number.isFinite(n) && n >= minJobs && Number.isFinite(rate) && rate > threshold;
}

/**
 * @param {unknown} observed
 * @param {number} [threshold]
 * @param {number} [minJobs]
 * @returns {boolean}
 */
export function isLowCompletionRiskObserved(
  observed,
  threshold = LOW_COMPLETION_MIN_RATE,
  minJobs = LOW_COMPLETION_MIN_N,
) {
  if (!observed || typeof observed !== 'object') return false;
  const row = /** @type {{ n?: unknown, completion_rate?: unknown }} */ (observed);
  const n = Number(row.n);
  const rate = row.completion_rate == null ? null : Number(row.completion_rate);
  return Number.isFinite(n) && n >= minJobs && Number.isFinite(rate) && rate < threshold;
}

/**
 * Star-rating blend (delegation ratings, any rater, weighted user 2 : parent 1).
 *
 * `share = RATING_BLEND_MAX_SHARE * rating_n_scored / (rating_n_scored + RATING_BLEND_HALF_LIFE)`
 * — with no rating the share is exactly 0 and the score is bit-for-bit the
 * pre-rating one; many ratings asymptote at a 25% share of the quality term.
 * The rating is normalized from the 1..5 stars to 0..1, mixed into the current
 * `quality_eff` (itself a blend), and applies to **every** role including
 * `review`, where the verdict-based quality blend stays disabled. Parent
 * ratings never enter here (see `summarizeDelegationRatingsForScoring`); they
 * stay display telemetry on `rating_avg` / `rating_n`.
 */
export const RATING_BLEND_MAX_SHARE = 0.25;
export const RATING_BLEND_HALF_LIFE = 5;

/**
 * @typedef {{
 *   enabled: boolean,
 *   completionMinRate: number,
 *   completionMinN: number,
 *   medianPenaltyRatio: number,
 *   medianReferenceMin: number,
 * }} ModelPickAdaptiveConfig
 */

/** Adaptive picking is on unless `data/model-role-profiles.json` disables it. */
export const DEFAULT_ADAPTIVE_CONFIG = Object.freeze({
  enabled: true,
  completionMinRate: 0.8,
  completionMinN: 10,
  medianPenaltyRatio: 0.25,
  medianReferenceMin: 2,
});

/** Terminal job completion share below which implement/fix pairs are demoted (n >= completionMinN). */
export const LOW_COMPLETION_MIN_RATE = DEFAULT_ADAPTIVE_CONFIG.completionMinRate;

/** Minimum terminal jobs before completion/median ranking terms apply. */
export const LOW_COMPLETION_MIN_N = DEFAULT_ADAPTIVE_CONFIG.completionMinN;

/**
 * Default eligibility tables. A row is `{ pattern, priority }` where `pattern`
 * names a family in `MODEL_ALIAS_FAMILIES` (`lib/model-alias-policy.js`), which
 * is where the catalog evidence for the name lives. The alias is matched on name
 * boundaries, so no model can gain a role because its id merely looks similar to
 * a family (`resolution-7b` is not Sol, `astronaut-8b` is not Astra).
 *
 * Roles are capability claims, so a family without catalog evidence never appears
 * here: a declared-but-unverified name grants nothing, and an operator file is
 * the only way to assert one (that is an explicit override, not a substring).
 * Priorities are eligibility only, never a sort key — the score decides ranking.
 *
 * Sol / Luna / Astra are verified Codex families
 * (`lib/codex/codex-models.js`: gpt-5.6-sol, gpt-6.1-sol, gpt-5.6-luna,
 * gpt-6-astra, and `gpt-5.6` as the Sol alias), so they carry the working roles
 * `implement` and `fix` next to `plan`. Sol is **not** granted `review`; Astra
 * and Luna are listed for review in the table below, but eligibility is still
 * not enough: review also needs the harness read-only / certification guarantee,
 * which is an adapter property (`review_uncertified` gate), not a model-name one.
 *
 * @type {ModelRoleProfiles}
 */
export const DEFAULT_MODEL_ROLE_PROFILES = Object.freeze({
  plan: Object.freeze([
    { pattern: 'grok', priority: 0 },
    { pattern: 'luna', priority: 1 },
    { pattern: 'mimo-v2.6-pro', priority: 2 },
    { pattern: 'sol', priority: 2 },
    { pattern: 'astra', priority: 3 },
    { pattern: 'opus', priority: 4 },
    { pattern: 'sonnet', priority: 5 },
  ]),
  implement: Object.freeze([
    { pattern: 'flash', priority: 0 },
    { pattern: 'glm', priority: 1 },
    { pattern: 'composer', priority: 2 },
    { pattern: 'deepseek', priority: 3 },
    { pattern: 'qwen', priority: 4 },
    { pattern: 'gpt-5.3-codex', priority: 5 },
    { pattern: 'hy3', priority: 5 },
    { pattern: 'hy4', priority: 5 },
    { pattern: 'mistral-large', priority: 5 },
    { pattern: 'kimi', priority: 6 },
    { pattern: 'mimo-v2.6-pro', priority: 6 },
    { pattern: 'sol', priority: 6 },
    { pattern: 'luna', priority: 7 },
    { pattern: 'astra', priority: 8 },
    { pattern: 'sonnet', priority: 9 },
    { pattern: 'opus', priority: 10 },
  ]),
  review: Object.freeze([
    { pattern: 'grok', priority: 0 },
    { pattern: 'sonnet', priority: 1 },
    { pattern: 'composer', priority: 2 },
    { pattern: 'glm', priority: 3 },
    { pattern: 'qwen', priority: 4 },
    { pattern: 'deepseek', priority: 5 },
    { pattern: 'mistral-large', priority: 5 },
    { pattern: 'mimo-v2.6-pro', priority: 6 },
    { pattern: 'astra', priority: 6 },
    { pattern: 'hy3', priority: 7 },
    { pattern: 'hy4', priority: 7 },
    { pattern: 'luna', priority: 7 },
    { pattern: 'opus', priority: 8 },
    { pattern: 'kimi', priority: 9 },
  ]),
  fix: Object.freeze([
    { pattern: 'flash', priority: 0 },
    { pattern: 'composer', priority: 1 },
    { pattern: 'grok', priority: 2 },
    { pattern: 'glm', priority: 3 },
    { pattern: 'qwen', priority: 4 },
    { pattern: 'deepseek', priority: 5 },
    { pattern: 'hy3', priority: 5 },
    { pattern: 'hy4', priority: 5 },
    { pattern: 'kimi', priority: 6 },
    { pattern: 'sol', priority: 6 },
    { pattern: 'luna', priority: 6 },
    { pattern: 'astra', priority: 6 },
    { pattern: 'mistral-large', priority: 6 },
    { pattern: 'sonnet', priority: 7 },
  ]),
});

/**
 * Top-level config section that carries the role **delta** (see the header).
 * A delta is `{ <role>: { set: { pattern: { priority } }, remove: [pattern] } }`.
 */
export const MODEL_ROLE_DELTA_SECTION = 'rolesDelta';

/**
 * Canonical key for one matcher within a role list. A leading `!` and an
 * explicit `alias:` prefix are stripped; an explicit `sub:` / `exact:` / `re:`
 * mode keeps its prefix so it stays a distinct identity from a plain alias.
 * Delta operations are keyed by this value, which is what makes a delta
 * independent of array order.
 *
 * @param {unknown} matcher matcher row or raw pattern string
 * @returns {string}
 */
function matcherDeltaKey(matcher) {
  const raw = matcher && typeof matcher === 'object'
    ? String(matcher.pattern || matcher.family || '')
    : String(matcher ?? '');
  let value = raw.trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('!')) value = value.slice(1).trim();
  if (value.startsWith('alias:')) value = value.slice('alias:'.length).trim();
  return value;
}

/**
 * Apply a `rolesDelta.<role>` entry to a normalized policy matcher list.
 *
 * - `remove` entries delete the matching matcher (by {@link matcherDeltaKey}).
 * - `set` entries add or replace a matcher, always flagged `operator: true`
 *   (an explicit assertion) with the exact priority from the delta.
 * - Everything else keeps its original object, so built-in rows stay `policy`
 *   and their provenance is not rewritten.
 *
 * `set` keys are applied in sorted order and `remove` is a set, so two deltas
 * that describe the same change produce the same list regardless of order.
 *
 * @param {Readonly<ModelRoleMatcher[]>} baseMatchers
 * @param {unknown} delta
 * @returns {ModelRoleMatcher[]}
 */
export function applyRoleMatcherDelta(baseMatchers, delta) {
  const base = Array.isArray(baseMatchers) ? baseMatchers : [];
  const setSource = delta && typeof delta === 'object' && delta.set && typeof delta.set === 'object' && !Array.isArray(delta.set)
    ? delta.set
    : {};
  const removeSource = delta && typeof delta === 'object' && Array.isArray(delta.remove) ? delta.remove : [];
  /** @type {Map<string, ModelRoleMatcher | object>} */
  const byKey = new Map();
  /** @type {string[]} */
  const order = [];
  for (const matcher of base) {
    const key = matcherDeltaKey(matcher);
    if (!key) continue;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, matcher);
  }
  const removals = new Set(removeSource.map((row) => matcherDeltaKey(row)).filter(Boolean));
  for (const key of removals) byKey.delete(key);
  const setEntries = Object.entries(setSource)
    .map(([key, spec]) => /** @type {[string, object]} */ ([matcherDeltaKey(key), spec && typeof spec === 'object' ? spec : {}]))
    .filter(([key]) => key && !removals.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [key, spec] of setEntries) {
    const priority = Number(spec.priority);
    /** @type {ModelRoleMatcher} */
    const row = {
      pattern: key,
      priority: Number.isFinite(priority) ? priority : 0,
      operator: true,
    };
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, row);
  }
  /** @type {ModelRoleMatcher[]} */
  const result = [];
  for (const key of order) {
    const matcher = byKey.get(key);
    if (matcher) result.push(/** @type {ModelRoleMatcher} */ (matcher));
  }
  return result;
}

/**
 * Normalize one matcher list.
 *
 * - Built-in (default) rows are policy: a row grants a role only when its
 *   `pattern` names a **verified family** in `lib/model-alias-policy.js` (the
 *   family table carries the catalog evidence). A declared-but-unverified name
 *   (or an unknown one) grants nothing, so no capability comes from a similar
 *   looking id.
 * - Operator rows (`data/model-role-profiles.json`) are explicit assertions:
 *   they are flagged `operator` and honoured as written — still boundary
 *   matched unless the documented grammar says otherwise (`sub:` / `exact:` /
 *   `re:`), and `!` / `deny: true` revokes a role.
 *
 * @param {unknown} raw
 * @param {'policy' | 'operator'} [origin]
 * @returns {ModelRoleMatcher[]}
 */
function normalizeMatchers(raw, origin = 'policy') {
  if (!Array.isArray(raw)) return [];
  /** @type {ModelRoleMatcher[]} */
  const out = [];
  for (const row of raw) {
    const declaredFamily = String(row?.family || '').trim().toLowerCase();
    const pattern = String(row?.pattern || declaredFamily || '').trim().toLowerCase();
    if (!pattern) continue;
    const priority = Number(row?.priority);
    /** @type {ModelRoleMatcher} */
    const matcher = {
      pattern,
      priority: Number.isFinite(priority) ? priority : out.length,
    };
    if (origin === 'operator') matcher.operator = true;
    if (declaredFamily) matcher.family = declaredFamily;
    if (row && typeof row === 'object') {
      if (typeof row.mode === 'string') matcher.mode = row.mode.trim().toLowerCase();
      if (row.deny === true || pattern.startsWith('!')) matcher.deny = true;
      if (Array.isArray(row.variant)) {
        matcher.variant = row.variant.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
      }
      if (Array.isArray(row.effort)) {
        matcher.effort = row.effort.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
      }
    }
    out.push(matcher);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeWeightValue(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * @param {unknown} raw
 * @returns {ModelRoleScoreWeightsByRole}
 */
export function normalizeRoleScoreWeights(raw) {
  const base = DEFAULT_ROLE_SCORE_WEIGHTS;
  if (!raw || typeof raw !== 'object') return base;
  const weightsRaw = /** @type {{ weights?: unknown }} */ (raw).weights;
  if (!weightsRaw || typeof weightsRaw !== 'object') return base;
  /** @type {Record<string, ModelRoleScoreWeights>} */
  const merged = {
    plan: { ...base.plan },
    implement: { ...base.implement },
    review: { ...base.review },
    fix: { ...base.fix },
  };
  for (const role of MODEL_PICK_ROLES) {
    const row = /** @type {Record<string, unknown>} */ (weightsRaw)[role];
    const defaults = base[/** @type {ModelPickRole} */ (role)];
    if (!row || typeof row !== 'object') continue;
    const obj = /** @type {Record<string, unknown>} */ (row);
    merged[role] = {
      cost: normalizeWeightValue(obj.cost, defaults.cost),
      quality: normalizeWeightValue(obj.quality, defaults.quality),
      speed: normalizeWeightValue(obj.speed, defaults.speed),
    };
  }
  return /** @type {ModelRoleScoreWeightsByRole} */ (merged);
}

export function normalizeModelRoleProfiles(raw) {
  const base = DEFAULT_MODEL_ROLE_PROFILES;
  if (!raw || typeof raw !== 'object') return base;
  const roles = raw.roles && typeof raw.roles === 'object' ? raw.roles : raw;
  const deltas = raw[MODEL_ROLE_DELTA_SECTION] && typeof raw[MODEL_ROLE_DELTA_SECTION] === 'object'
    && !Array.isArray(raw[MODEL_ROLE_DELTA_SECTION])
    ? raw[MODEL_ROLE_DELTA_SECTION]
    : null;
  /** @type {Record<string, ModelRoleMatcher[]>} */
  const merged = {
    plan: [...base.plan],
    implement: [...base.implement],
    review: [...base.review],
    fix: [...base.fix],
  };
  for (const role of MODEL_PICK_ROLES) {
    // Precedence per role: legacy full-list override > delta > built-in policy.
    if (Object.prototype.hasOwnProperty.call(roles, role)) {
      // Anything that came from disk is an operator assertion, not policy.
      const matchers = normalizeMatchers(roles[role], 'operator');
      if (matchers.length === 0) {
        // An empty/absent list is not an override; fall through to delta/policy.
      } else {
        merged[role] = matchers;
        continue;
      }
    }
    if (deltas && Object.prototype.hasOwnProperty.call(deltas, role)) {
      merged[role] = applyRoleMatcherDelta(merged[role], deltas[role]);
    }
  }
  return /** @type {ModelRoleProfiles} */ (merged);
}

/**
 * @param {{ filePath?: string }} [input]
 * @returns {ModelRoleProfiles}
 */
export function loadModelRoleProfiles(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeModelRoleProfiles(JSON.parse(raw));
  } catch {
    return DEFAULT_MODEL_ROLE_PROFILES;
  }
}

/**
 * @param {{ filePath?: string }} [input]
 * @returns {ModelRoleScoreWeightsByRole}
 */
export function loadRoleScoreWeights(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeRoleScoreWeights(JSON.parse(raw));
  } catch {
    return DEFAULT_ROLE_SCORE_WEIGHTS;
  }
}

/**
 * Accepts a mode string, `{ band, mode }`, a whole config file with a top-level
 * `rotation` key, or the legacy `delegation.rotation` string.
 *
 * @param {unknown} raw
 * @returns {ModelPickRotationConfig}
 */
export function normalizeRotationConfig(raw) {
  const base = DEFAULT_ROTATION_CONFIG;
  if (raw == null || raw === '') return base;
  if (typeof raw === 'string') {
    const mode = raw.trim().toLowerCase();
    return ROTATION_MODES.includes(/** @type {ModelPickRotationMode} */ (mode))
      ? Object.freeze({ band: base.band, mode: /** @type {ModelPickRotationMode} */ (mode) })
      : base;
  }
  if (typeof raw !== 'object') return base;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const legacy = obj.delegation && typeof obj.delegation === 'object'
    ? /** @type {Record<string, unknown>} */ (obj.delegation).rotation
    : undefined;
  const nested = Object.prototype.hasOwnProperty.call(obj, 'rotation') ? obj.rotation : legacy;
  const source = nested && typeof nested === 'object'
    ? /** @type {Record<string, unknown>} */ (nested)
    : obj;
  const modeRaw = typeof nested === 'string' ? nested : (source.mode ?? obj.mode);
  const mode = String(modeRaw || '').trim().toLowerCase();
  const bandValue = Number(source.band ?? obj.band);
  const band = Number.isFinite(bandValue) && bandValue >= 0 ? bandValue : base.band;
  return Object.freeze({
    band,
    mode: ROTATION_MODES.includes(/** @type {ModelPickRotationMode} */ (mode))
      ? /** @type {ModelPickRotationMode} */ (mode)
      : base.mode,
  });
}

/**
 * @param {{ filePath?: string }} [input]
 * @returns {ModelPickRotationConfig}
 */
export function loadRotationConfig(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeRotationConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_ROTATION_CONFIG;
  }
}

/**
 * Adaptive picking accepts a boolean, `{ enabled }`, a whole config file with a
 * top-level `adaptive` key, or the legacy `delegation.adaptivePick` boolean.
 * Anything unrecognised falls back to the default (on).
 *
 * @param {unknown} raw
 * @returns {ModelPickAdaptiveConfig}
 */
/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampAdaptiveNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {Partial<ModelPickAdaptiveConfig>} [overrides]
 * @returns {ModelPickAdaptiveConfig}
 */
export function normalizeAdaptiveConfig(raw, overrides = undefined) {
  /** @type {ModelPickAdaptiveConfig} */
  let base = { ...DEFAULT_ADAPTIVE_CONFIG };
  if (typeof raw === 'boolean') base = { ...base, enabled: raw };
  else if (raw != null && raw !== '' && typeof raw === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (raw);
    const nested = obj.adaptive;
    if (typeof nested === 'boolean') base = { ...base, enabled: nested };
    else if (nested && typeof nested === 'object') {
      const cfg = /** @type {Record<string, unknown>} */ (nested);
      if (typeof cfg.enabled === 'boolean') base = { ...base, enabled: cfg.enabled };
      base = {
        ...base,
        completionMinRate: clampAdaptiveNumber(cfg.completionMinRate, 0, 1, base.completionMinRate),
        completionMinN: Math.floor(clampAdaptiveNumber(cfg.completionMinN, 1, 1000, base.completionMinN)),
        medianPenaltyRatio: clampAdaptiveNumber(cfg.medianPenaltyRatio, 0, 1, base.medianPenaltyRatio),
        medianReferenceMin: clampAdaptiveNumber(cfg.medianReferenceMin, 0.1, 120, base.medianReferenceMin),
      };
    } else {
      const legacy = obj.delegation && typeof obj.delegation === 'object'
        ? /** @type {Record<string, unknown>} */ (obj.delegation).adaptivePick
        : undefined;
      if (typeof legacy === 'boolean') base = { ...base, enabled: legacy };
    }
  }
  if (overrides && typeof overrides === 'object') {
    base = {
      ...base,
      ...(typeof overrides.enabled === 'boolean' ? { enabled: overrides.enabled } : {}),
      ...(overrides.completionMinRate != null
        ? { completionMinRate: clampAdaptiveNumber(overrides.completionMinRate, 0, 1, base.completionMinRate) }
        : {}),
      ...(overrides.completionMinN != null
        ? { completionMinN: Math.floor(clampAdaptiveNumber(overrides.completionMinN, 1, 1000, base.completionMinN)) }
        : {}),
      ...(overrides.medianPenaltyRatio != null
        ? { medianPenaltyRatio: clampAdaptiveNumber(overrides.medianPenaltyRatio, 0, 1, base.medianPenaltyRatio) }
        : {}),
      ...(overrides.medianReferenceMin != null
        ? { medianReferenceMin: clampAdaptiveNumber(overrides.medianReferenceMin, 0.1, 120, base.medianReferenceMin) }
        : {}),
    };
  }
  return Object.freeze(base);
}

/**
 * @param {{ filePath?: string }} [input]
 * @returns {ModelPickAdaptiveConfig}
 */
export function loadAdaptiveConfig(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeAdaptiveConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_ADAPTIVE_CONFIG;
  }
}

/**
 * @param {{
 *   costTier: number,
 *   qualityTier: number,
 *   speedTier: number,
 *   weights: ModelRoleScoreWeights,
 * }} input
 * @returns {number}
 */
export function computeModelPickScore(input) {
  const costTier = Math.max(1, Math.min(5, Math.round(Number(input.costTier) || 3)));
  const qualityTier = Math.max(1, Math.min(5, Math.round(Number(input.qualityTier) || 3)));
  const speedTier = Math.max(1, Math.min(5, Math.round(Number(input.speedTier) || 3)));
  const w = input.weights;
  const costTerm = (6 - costTier) / 5;
  const qualityTerm = qualityTier / 5;
  const speedTerm = speedTier / 5;
  return (w.cost * costTerm) + (w.quality * qualityTerm) + (w.speed * speedTerm);
}

/**
 * Compiled matcher rules per matcher array (arrays are stable references: the
 * frozen defaults, or one array per loaded profile file).
 *
 * @type {WeakMap<Readonly<ModelRoleMatcher[]>, import('./model-alias-policy.js').ModelNameRule[]>}
 */
const compiledMatcherRules = new WeakMap();

/**
 * @param {Readonly<ModelRoleMatcher[]>} matchers
 * @returns {import('./model-alias-policy.js').ModelNameRule[]}
 */
function getCompiledMatchers(matchers) {
  const cached = compiledMatcherRules.get(matchers);
  if (cached) return cached;
  const compiled = compileModelNameRules(matchers);
  compiledMatcherRules.set(matchers, compiled);
  return compiled;
}

/**
 * Matcher priority for a catalog id: boundary-aligned alias rules only. A deny
 * rule revokes the role, and an unverified alias never grants one — that is what
 * keeps a similar-looking name from claiming a capability.
 *
 * @param {string} modelValue catalog id or stored `value::params`
 * @param {Readonly<ModelRoleMatcher[]>} matchers
 * @returns {number} Infinity when the id is not eligible
 */
function resolveMatcherPriority(modelValue, matchers) {
  let best = Number.POSITIVE_INFINITY;
  for (const rule of getCompiledMatchers(matchers)) {
    if (!matchesModelNameRule(rule, modelValue)) continue;
    if (rule.deny) return Number.POSITIVE_INFINITY;
    if (!rule.verified) continue;
    if (rule.priority < best) best = rule.priority;
  }
  return best;
}

/**
 * Why a role was refused for this id, as a machine-readable cause:
 * `unknown-family` (the alias policy knows no family for this name — the
 * documented fallback), `unverified-alias` (a declared name without catalog
 * evidence, which grants nothing by itself), or `role-mismatch` (a verified
 * family that does not claim this role).
 *
 * @param {string} modelValue
 * @param {ModelPickRole} _role Role the caller wanted (documented per-role cause)
 * @returns {'unknown-family' | 'unverified-alias' | 'role-mismatch'}
 */
export function describeRoleRejection(modelValue, _role) {
  const resolved = resolveModelFamily(modelValue);
  if (resolved.family === UNKNOWN_MODEL_FAMILY) return UNKNOWN_FAMILY_FALLBACK.reason;
  if (!resolved.verified) return 'unverified-alias';
  return 'role-mismatch';
}

/**
 * @param {string} modelValue
 * @param {ModelRoleProfiles} [profiles]
 * @param {{ mode?: string }} [options] `named` lifts the automatic-only filters
 * @returns {ModelPickRole[]}
 */
export function listRolesForModel(modelValue, profiles = DEFAULT_MODEL_ROLE_PROFILES, options = {}) {
  const id = String(modelValue || '').trim();
  if (!id) return [];
  const automatic = String(options.mode || 'automatic').trim().toLowerCase() !== 'named';
  const flash = automatic && isFlashDelegationModel(id);
  return MODEL_PICK_ROLES.filter((role) => {
    if (role === 'review' && flash) return false;
    return Number.isFinite(resolveMatcherPriority(id, profiles[role] || []));
  });
}

/**
 * Read-only per-role matcher provenance for one catalog id. It uses the same
 * compiled rules as the picker (`getCompiledMatchers` + `matchesModelNameRule`)
 * so a Settings diagnostics row names the exact matcher — built-in policy family
 * vs operator override, allow vs deny — that granted or refused a role. It does
 * not rank and does not change any pick behavior.
 *
 * `eligible` mirrors `listRolesForModel` for the automatic mode; the
 * flash-for-review veto is a picker ranking filter, reported separately as
 * `flash_blocked`.
 *
 * @param {string} modelValue catalog id or stored `value::params`
 * @param {ModelRoleProfiles} [profiles]
 * @returns {Record<ModelPickRole, {
 *   eligible: boolean,
 *   priority: number | null,
 *   flash_blocked: boolean,
 *   matched: Array<{
 *     pattern: string,
 *     source: 'policy' | 'operator',
 *     mode: string,
 *     deny: boolean,
 *     verified: boolean,
 *   }>,
 * }>}
 */
export function describeModelRoleMatchers(modelValue, profiles = DEFAULT_MODEL_ROLE_PROFILES) {
  const id = String(modelValue || '').trim();
  const flash = id ? isFlashDelegationModel(id) : false;
  /** @type {Record<string, object>} */
  const out = {};
  for (const role of MODEL_PICK_ROLES) {
    const matchers = profiles[role] || [];
    /** @type {Array<object>} */
    const matched = [];
    if (id) {
      for (const rule of getCompiledMatchers(matchers)) {
        if (!matchesModelNameRule(rule, id)) continue;
        matched.push({
          pattern: String(rule.pattern || ''),
          source: rule.operator === true ? 'operator' : 'policy',
          mode: String(rule.mode || 'alias'),
          deny: rule.deny === true,
          verified: rule.verified === true,
        });
      }
    }
    const priority = id ? resolveMatcherPriority(id, matchers) : Number.POSITIVE_INFINITY;
    out[role] = {
      eligible: Number.isFinite(priority),
      priority: Number.isFinite(priority) ? priority : null,
      flash_blocked: role === 'review' && flash,
      matched,
    };
  }
  return /** @type {Record<ModelPickRole, any>} */ (out);
}

/**
 * Tier comparison, used only as the tie-break when two candidates share a score.
 * Matcher priority is eligibility only (not a sort key).
 *
 * @param {ModelPickRole} role
 * @param {ModelPickCandidate} left
 * @param {ModelPickCandidate} right
 * @returns {number}
 */
function compareModelPickTiers(role, left, right) {
  if (role === 'plan') {
    if (left.quality_tier !== right.quality_tier) return right.quality_tier - left.quality_tier;
    if (left.speed_tier !== right.speed_tier) return right.speed_tier - left.speed_tier;
    if (left.cost_tier !== right.cost_tier) return left.cost_tier - right.cost_tier;
  } else if (role === 'implement') {
    if (left.cost_tier !== right.cost_tier) return left.cost_tier - right.cost_tier;
    if (left.speed_tier !== right.speed_tier) return right.speed_tier - left.speed_tier;
    if (left.quality_tier !== right.quality_tier) return right.quality_tier - left.quality_tier;
  } else if (role === 'review') {
    if (left.quality_tier !== right.quality_tier) return right.quality_tier - left.quality_tier;
    if (left.cost_tier !== right.cost_tier) return left.cost_tier - right.cost_tier;
    if (left.speed_tier !== right.speed_tier) return right.speed_tier - left.speed_tier;
  } else {
    if (left.speed_tier !== right.speed_tier) return right.speed_tier - left.speed_tier;
    if (left.cost_tier !== right.cost_tier) return left.cost_tier - right.cost_tier;
    if (left.quality_tier !== right.quality_tier) return right.quality_tier - left.quality_tier;
  }
  return 0;
}

/**
 * Ranking: score DESC first (weights are the role policy), then the per-role
 * tier axes as a tie-break. There is deliberately no alphabetical fallback:
 * `selectModelPick` resolves remaining ties with usage (rotation) or a stable
 * order. Matcher priority is eligibility only, never a sort key.
 *
 * @param {ModelPickRole} role
 * @param {ModelPickCandidate} left
 * @param {ModelPickCandidate} right
 * @returns {number}
 */
export function compareModelPickCandidates(role, left, right) {
  if (left.score !== right.score) return right.score - left.score;
  return compareModelPickTiers(role, left, right);
}

/**
 * @typedef {{
 *   id: string,
 *   enabled?: boolean,
 *   ready?: boolean,
 *   can_delegate?: boolean,
 * }} ModelPickHarnessRow
 *
 * @typedef {{
 *   id: string,
 *   label?: string,
 *   cost_tier?: number,
 *   quality_tier?: number,
 *   speed_tier?: number,
 *   available?: boolean,
 *   roles?: string[],
 * }} ModelPickModelRow
 *
 * @typedef {{
 *   items?: ModelPickModelRow[],
 *   favorites_configured?: boolean,
 * }} ModelPickHarnessModels
 *
 * @typedef {{
 *   harness: string,
 *   model: string,
 *   label: string,
 *   provider: string,
 *   cost_tier: number,
 *   quality_tier: number,
 *   speed_tier: number,
 *   priority: number,
 *   score: number,
 *   rotation_score: number,
 *   weights: ModelRoleScoreWeights,
 *   in_band: boolean,
 *   cold_start: boolean,
 *   plan_limit_penalty: number,
 *   plan_headroom_level?: number,
 *   plan_pace_level?: number,
 *   pace_cost_factor?: number,
 *   chat_uses: number,
 *   role_uses_7d: number,
 *   model_uses_7d: number,
 *   last_used_at: string,
 *   keep_winner: boolean,
 *   reason: string,
 *   heuristic_score: number,
 *   prior_infra: number,
 *   traits: import('./delegation-adapter-capabilities.js').HarnessDelegationTraits,
 *   observed: {
 *     n: number,
 *     pass_rate: number | null,
 *     completion_rate: number | null,
 *     infra_fail_rate: number,
 *     median_min: number | null,
 *     median_tokens_per_sec?: number | null,
 *     median_tool_calls?: number | null,
 *     median_files_changed?: number | null,
 *     quality: number | null,
 *     verdict_fail_rate?: number | null,
 *     useful_rate?: number | null,
 *     rating_avg?: number | null,
 *     rating_n?: number,
 *     rating_avg_scored?: number | null,
 *     rating_n_scored?: number,
 *   } | null,
 *   observed_applied: boolean,
 *   observed_penalty: number,
 *   observed_changed: boolean,
 *   rating_applied: boolean,
 *   high_infra_risk: boolean,
 *   low_completion_risk: boolean,
 * }} ModelPickCandidate
 *
 * @typedef {{
 *   roleUsage7d?: {
 *     harness?: Record<string, number>,
 *     model?: Record<string, number>,
 *     lastAt?: Record<string, string>,
 *   },
 *   chatUsage?: {
 *     harnesses?: Record<string, number>,
 *     models?: Record<string, { count?: number, lastAt?: string, next_review_passed?: boolean }>,
 *   },
 *   coldStartHarnesses14d?: string[],
 *   lockouts?: { harness?: string, model?: string, resetAt?: string }[],
 *   planLimits?: { harness?: string, utilization?: number, resetsAt?: string, stale?: boolean }[],
 *   freshLimitHits?: Record<string, number | { whole?: boolean, models?: string[] }>,
 *   excludeModels?: string[],
 *   pickIndex?: number,
 *   prior?: { infra_fail_rate?: number },
 *   observed?: Record<string, {
 *     n?: number,
 *     pass_rate?: number | null,
 *     infra_fail_rate?: number,
 *     median_min?: number | null,
 *     median_tokens_per_sec?: number | null,
 *     median_tool_calls?: number | null,
 *     median_files_changed?: number | null,
 *     quality?: number | null,
 *     verdict_fail_rate?: number | null,
 *     useful_rate?: number | null,
 *     rating_avg?: number | null,
 *     rating_n?: number,
 *     rating_avg_scored?: number | null,
 *     rating_n_scored?: number,
 *   }>,
 *   reviewTestObservations?: Record<string, { positive?: number, negative?: number }>,
 * }} ModelPickHistory
 */

/**
 * Counters explaining why no candidate survived selection, used to build the
 * `MODEL_UNAVAILABLE` message.
 *
 * @typedef {{
 *   delegatableHarnesses: number,
 *   harnessExcluded: number,
 *   favoritesHarnesses: number,
 *   hardExcluded: number,
 *   historyExcluded: number,
 *   lockedOut: number,
 *   flash: number,
 *   unavailable: number,
 *   roleMismatch: number,
 *   reviewAdapterBlocked: number,
 *   planWindowExhausted: number,
 * }} ModelPickFilterStats
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function toUsageCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Normalize fresh limit hits to `{ whole, models }` per harness. A positive
 * number is the legacy whole-harness shape; `{ whole: true }` means the
 * incident had no model, while `models` scopes it to specific base ids.
 *
 * @param {unknown} raw
 * @returns {Record<string, { whole: boolean, models: string[] }>}
 */
function normalizeFreshLimitHits(raw) {
  /** @type {Record<string, { whole: boolean, models: string[] }>} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [harness, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const id = String(harness || '').trim().toLowerCase();
    if (!id) continue;
    if (typeof value === 'number' || typeof value === 'string') {
      if (toUsageCount(value) > 0) out[id] = { whole: true, models: [] };
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const obj = /** @type {{ whole?: unknown, models?: unknown }} */ (value);
    const models = Array.isArray(obj.models)
      ? obj.models.map((model) => String(model || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (obj.whole === true || models.length > 0) {
      out[id] = { whole: obj.whole === true, models };
    }
  }
  return out;
}

/**
 * @param {ModelPickCandidate} candidate
 * @returns {string}
 */
function harnessKey(candidate) {
  return candidate.harness.toLowerCase();
}

/**
 * @param {ModelPickCandidate} candidate
 * @returns {string}
 */
function candidateModelKey(candidate) {
  return `${candidate.harness.toLowerCase()}/${candidate.model}`;
}

/**
 * Effective review traits for a harness: the static prior, overridden by the
 * injected observation counts (see `resolveHarnessDelegationTraits`). Keeping
 * the merge here lets `selectModelPick` stay pure while the loader
 * (`lib/model-pick-history.js`) does the report I/O.
 *
 * @param {string} harnessId
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @returns {import('./delegation-adapter-capabilities.js').HarnessDelegationTraits}
 */
function resolveCandidateTraits(harnessId, history) {
  const id = String(harnessId || '').trim().toLowerCase();
  return resolveHarnessDelegationTraits(id, history.reviewTestObservations[id]);
}

/**
 * Stats key used by `summarizeDelegationOutcomes`: harness + base model id
 * (model params such as `::effort=high` are stripped so every variant shares
 * one observed record).
 *
 * @param {string} harnessId
 * @param {string} modelId
 * @returns {string}
 */
function observedKey(harnessId, modelId) {
  return `${String(harnessId || '').toLowerCase()}/${decodeModelValue(modelId).modelId.toLowerCase()}`;
}

/**
 * @param {Record<string, object>} observed
 * @param {string} harnessId
 * @param {string} modelId
 * @returns {object | null}
 */
function lookupObserved(observed, harnessId, modelId) {
  if (!observed || typeof observed !== 'object') return null;
  const row = observed[observedKey(harnessId, modelId)];
  return row && typeof row === 'object' ? row : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatObservedRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

/**
 * Project the loader stats onto the public candidate shape. Returns null when
 * there is no data at all for the pair.
 *
 * @param {object | null} row
 * @returns {ModelPickCandidate['observed']}
 */
function buildObservedInfo(row) {
  if (!row || typeof row !== 'object') return null;
  const n = Number(/** @type {{ n?: unknown }} */ (row).n);
  if (!Number.isFinite(n) || n <= 0) return null;
  const obj = /** @type {Record<string, unknown>} */ (row);
  /** @param {unknown} value @returns {number | null} */
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  /** @type {ModelPickCandidate['observed']} */
  const info = {
    n,
    pass_rate: num(obj.pass_rate),
    completion_rate: num(obj.completion_rate),
    infra_fail_rate: Math.max(0, Math.min(1, Number(obj.infra_fail_rate) || 0)),
    median_min: num(obj.median_min),
    quality: num(obj.quality),
  };
  if (obj.verdict_fail_rate != null) info.verdict_fail_rate = num(obj.verdict_fail_rate);
  if (obj.useful_rate != null) info.useful_rate = num(obj.useful_rate);
  for (const key of ['median_tokens_per_sec', 'median_tool_calls', 'median_files_changed']) {
    if (!(key in obj)) continue;
    if (obj[key] == null) {
      info[key] = null;
      continue;
    }
    const parsed = num(obj[key]);
    if (parsed != null) info[key] = parsed;
  }
  const ratingN = Number(obj.rating_n);
  if (Number.isFinite(ratingN) && ratingN > 0) {
    const ratingAvg = num(obj.rating_avg);
    if (ratingAvg != null) {
      info.rating_avg = ratingAvg;
      info.rating_n = ratingN;
    }
  }
  // Display stars keep the parent's weighted ratings; the ranking reads only
  // this user-only pair (see `summarizeDelegationRatingsForScoring`).
  const ratingNScored = Number(obj.rating_n_scored);
  if (Number.isFinite(ratingNScored) && ratingNScored > 0) {
    const ratingAvgScored = num(obj.rating_avg_scored);
    if (ratingAvgScored != null) {
      info.rating_avg_scored = ratingAvgScored;
      info.rating_n_scored = ratingNScored;
    }
  }
  return info;
}

/**
 * Apply the observed-outcome blend, the star-rating blend, and the infra
 * penalty to one candidate's score.
 *
 * Observed terms shrink toward the role prior:
 *
 * ```text
 * w           = n / (n + OBSERVED_BLEND_HALF_LIFE)   // n = 0 -> w = 0
 * quality_eff = heur_quality * (1 - w) + observed_quality * w
 * infra_eff   = prior_infra  * (1 - w) + observed_infra  * w
 * ```
 *
 * Ratings then mix into that `quality_eff` at a bounded share:
 *
 * ```text
 * share       = 0.25 * rating_n_scored / (rating_n_scored + 5) // 0 scored -> 0
 * rating01    = (rating_avg_scored - 1) / 4      // stars 1..5 -> 0..1
 * quality_eff = lerp((quality_eff - 1) / 4, rating01, share) mapped back to 1..5
 * score       = (heuristic score with the quality term replaced by quality_eff)
 *             * (1 - INFRA_SCORE_PENALTY_RATIO * infra_eff)
 * ```
 *
 * The stars come from every rater: ratings are recorded autonomously by the
 * orchestrating parent (it cannot rate its own base model), so `rating_n_scored = 0`
 * means no rating influence and `rating_applied` stays false.
 *
 * There is no hard `n` gate: a candidate with no history inherits the role
 * prior for infra (so "no data" is not a free pass), while its quality stays
 * purely heuristic. The quality term is replaced against the same clamped tier
 * the heuristic score used, so `n = 0` is a no-op even for a fractional tier
 * (no residual offset), and `rating_n_scored = 0` reproduces the pre-rating score
 * bit-for-bit. `adaptive: false` short-circuits before every term.
 * Review candidates skip the *verdict* quality blend: their observed quality is
 * the productive-verdict share, where every PASS counts, so blending it would
 * reward lenient reviewers. Ratings are a separate, explicit user signal and
 * apply to every role, review included. Review keeps the infra term only on
 * top. `heuristic_score` keeps the pre-blend value so `reason` can tell whether
 * observed data changed a ranking.
 *
 * @param {ModelPickCandidate} candidate
 * @param {ModelRoleScoreWeights} weights
 * @param {boolean} adaptive
 * @param {{ infra_fail_rate?: number, role?: string }} [prior] Role-level
 *   job-weighted mean infra rate, computed by `lib/model-pick-history.js`.
 * @param {ModelPickRole} [pickRole] Role being picked (implement/fix get completion/median terms).
 * @param {ModelPickAdaptiveConfig} [adaptiveConfig]
 * @returns {void}
 */
function applyObservedOutcome(candidate, weights, adaptive, prior = {}, pickRole = 'implement', adaptiveConfig = DEFAULT_ADAPTIVE_CONFIG) {
  candidate.heuristic_score = candidate.score;
  candidate.observed_applied = false;
  candidate.observed_penalty = 0;
  candidate.observed_changed = false;
  candidate.rating_applied = false;
  if (!adaptive) return;
  const priorInfra = Math.max(0, Math.min(1, Number(prior?.infra_fail_rate) || 0));
  candidate.prior_infra = priorInfra;
  const row = candidate.observed;
  const n = row && Number.isFinite(row.n) && row.n > 0 ? row.n : 0;
  const w = n / (n + OBSERVED_BLEND_HALF_LIFE);
  let applied = false;
  /** Baseline tier the heuristic score used (clamped, rounded). */
  const baseQuality = Math.max(1, Math.min(5, Math.round(candidate.quality_tier)));
  /** @type {number | null} Quality on the 1..5 tier after the optional blends. */
  let qualityEff = null;
  // Quality: replace the heuristic quality term with the shrunk blend. The
  // baseline is the exact tier `computeModelPickScore` used, so n = 0 leaves
  // the score untouched and a fractional `quality_tier` cannot leave a residual
  // offset.
  if (n > 0 && prior?.role !== 'review') {
    const quality = Number(row.quality);
    if (Number.isFinite(quality)) {
      qualityEff = (baseQuality * (1 - w)) + (Math.max(1, Math.min(5, quality)) * w);
    }
  }
  // Stars: normalize the user-only 1..5 mean to 0..1 and mix it into the
  // current quality at a share capped at 25%. Ratings exist for every role
  // (review included), and rating_n_scored = 0 keeps the exact previous score.
  // Parent ratings are deliberately excluded here: the orchestrator rates the
  // models it picked, so its stars stay telemetry on `rating_avg`/`rating_n`.
  const ratingN = row && Number.isFinite(Number(row.rating_n_scored)) ? Math.max(0, Number(row.rating_n_scored)) : 0;
  const ratingAvg = Number(row?.rating_avg_scored);
  if (ratingN > 0 && Number.isFinite(ratingAvg)) {
    const current = qualityEff == null ? baseQuality : qualityEff;
    const share = RATING_BLEND_MAX_SHARE * (ratingN / (ratingN + RATING_BLEND_HALF_LIFE));
    const current01 = (current - 1) / 4;
    const rating01 = Math.max(0, Math.min(1, (ratingAvg - 1) / 4));
    qualityEff = 1 + (4 * ((current01 * (1 - share)) + (rating01 * share)));
    candidate.rating_applied = true;
  }
  if (qualityEff != null) {
    candidate.score += (weights.quality * (qualityEff - baseQuality)) / 5;
    applied = true;
  }
  // Infra: shrink the observed fail rate to the role prior; n = 0 uses the
  // prior alone, so an unproven candidate is not rewarded over a measured one.
  const observedInfra = n > 0
    ? Math.max(0, Math.min(1, Number(row.infra_fail_rate) || 0))
    : 0;
  const infraEff = (priorInfra * (1 - w)) + (observedInfra * w);
  if (infraEff > 0) {
    const factor = 1 - (INFRA_SCORE_PENALTY_RATIO * infraEff);
    candidate.score *= factor;
    candidate.observed_penalty = 1 - factor;
    applied = true;
  }
  const workingRole = pickRole === 'fix' ? 'implement' : pickRole;
  const minSample = adaptiveConfig.completionMinN;
  if (workingRole === 'implement' && n >= minSample && row && row.completion_rate != null) {
    const completionRate = Number(row.completion_rate);
    if (Number.isFinite(completionRate)) {
      const w = n / (n + OBSERVED_BLEND_HALF_LIFE);
      const completionGap = Math.max(0, 1 - Math.max(0, Math.min(1, completionRate)));
      const completionFactor = 1 - (0.3 * w * completionGap);
      if (completionFactor < 1) {
        candidate.score *= completionFactor;
        candidate.observed_penalty = Math.max(candidate.observed_penalty, 1 - completionFactor);
        applied = true;
      }
    }
    const medianMin = Number(row.median_min);
    if (Number.isFinite(medianMin) && medianMin > adaptiveConfig.medianReferenceMin) {
      const w = n / (n + OBSERVED_BLEND_HALF_LIFE);
      const excess = medianMin - adaptiveConfig.medianReferenceMin;
      const medianFactor = 1 - (adaptiveConfig.medianPenaltyRatio * w * Math.min(1, excess / 12));
      if (medianFactor < 1) {
        candidate.score *= medianFactor;
        candidate.observed_penalty = Math.max(candidate.observed_penalty, 1 - medianFactor);
        applied = true;
      }
    }
  }
  candidate.observed_applied = applied;
}

/**
 * Compact one-line description of a candidate's observed stats, e.g.
 * `n=12 infra fail 40% penalized pass 58% quality 3.32`.
 *
 * @param {ModelPickCandidate['observed']} observed
 * @returns {string}
 */
function describeObserved(observed) {
  if (!observed) return '';
  const bits = [];
  if (observed.infra_fail_rate > 0) {
    bits.push(`infra fail ${formatObservedRate(observed.infra_fail_rate)} (n=${observed.n}) penalized`);
  } else {
    bits.push(`n=${observed.n}`);
  }
  if (observed.pass_rate != null) bits.push(`pass ${formatObservedRate(observed.pass_rate)}`);
  else if (observed.useful_rate != null) bits.push(`useful ${formatObservedRate(observed.useful_rate)}`);
  if (observed.completion_rate != null) {
    bits.push(`completion=${formatObservedRate(observed.completion_rate)} n=${observed.n}`);
  }
  if (observed.median_min != null) bits.push(`median=${observed.median_min}min`);
  if (observed.quality != null) bits.push(`quality ${observed.quality.toFixed(2)}`);
  const ratingN = Number(observed.rating_n_scored);
  if (Number.isFinite(ratingN) && ratingN > 0 && Number.isFinite(Number(observed.rating_avg_scored))) {
    bits.push(`rating ${Number(observed.rating_avg_scored).toFixed(2)} (n=${ratingN})`);
  }
  return bits.join(' ');
}

/**
 * Human-readable observed fragment for a candidate's `reason`. Only names data
 * that actually changed the candidate's score, so an unchanged ranking stays
 * quiet. A candidate with no own history can still be named for the role prior
 * it inherited.
 *
 * @param {ModelPickCandidate} candidate
 * @returns {string[]}
 */
function observedReasonParts(candidate) {
  if (!candidate.observed_applied) return [];
  if (!candidate.observed) {
    const prior = Number(candidate.prior_infra);
    if (!(prior > 0)) return [];
    return [`prior infra ${formatObservedRate(prior)} penalized`];
  }
  return [`observed ${describeObserved(candidate.observed)}`];
}

/**
 * Normalize the injected rotation history. Everything is optional: an empty
 * history reproduces the old score-only, stable ordering.
 *
 * @param {unknown} raw
 * @returns {{
 *   harnessUses7d: Record<string, unknown>,
 *   modelUses7d: Record<string, unknown>,
 *   lastUsedAt: Record<string, unknown>,
 *   chatHarnesses: Record<string, unknown>,
 *   chatModels: Record<string, unknown>,
 *   coldStartHarnesses: Set<string>,
 *   lockouts: object[],
 *   planLimits: object[],
 *   freshLimitHits: Record<string, { whole: boolean, models: string[] }>,
 *   excludeModels: string[],
 *   hardExcludeModels: string[],
 *   softExcludeModels: string[],
 *   pickIndex: number,
 *   prior: { infra_fail_rate: number },
 *   observed: Record<string, object>,
 *   leafSticky: { key: string, harness: string, model: string } | null,
 * }}
 */
function normalizePickHistory(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  const roleUsage = src.roleUsage7d && typeof src.roleUsage7d === 'object'
    ? /** @type {Record<string, unknown>} */ (src.roleUsage7d)
    : {};
  const chatUsage = src.chatUsage && typeof src.chatUsage === 'object'
    ? /** @type {Record<string, unknown>} */ (src.chatUsage)
    : {};
  const cold = Array.isArray(src.coldStartHarnesses14d) ? src.coldStartHarnesses14d : [];
  const priorSrc = src.prior && typeof src.prior === 'object'
    ? /** @type {Record<string, unknown>} */ (src.prior)
    : {};
  return {
    harnessUses7d: roleUsage.harness && typeof roleUsage.harness === 'object' ? /** @type {Record<string, unknown>} */ (roleUsage.harness) : {},
    modelUses7d: roleUsage.model && typeof roleUsage.model === 'object' ? /** @type {Record<string, unknown>} */ (roleUsage.model) : {},
    lastUsedAt: roleUsage.lastAt && typeof roleUsage.lastAt === 'object' ? /** @type {Record<string, unknown>} */ (roleUsage.lastAt) : {},
    chatHarnesses: chatUsage.harnesses && typeof chatUsage.harnesses === 'object' ? /** @type {Record<string, unknown>} */ (chatUsage.harnesses) : {},
    chatModels: chatUsage.models && typeof chatUsage.models === 'object' ? /** @type {Record<string, unknown>} */ (chatUsage.models) : {},
    coldStartHarnesses: new Set(cold.map((id) => String(id || '').trim().toLowerCase()).filter(Boolean)),
    lockouts: Array.isArray(src.lockouts) ? src.lockouts : [],
    planLimits: Array.isArray(src.planLimits) ? src.planLimits : [],
    freshLimitHits: normalizeFreshLimitHits(src.freshLimitHits),
    excludeModels: Array.isArray(src.excludeModels) ? src.excludeModels.map((id) => String(id || '').trim()).filter(Boolean) : [],
    hardExcludeModels: Array.isArray(src.hardExcludeModels)
      ? src.hardExcludeModels.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
    softExcludeModels: Array.isArray(src.softExcludeModels)
      ? src.softExcludeModels.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
    pickIndex: Number.isFinite(Number(src.pickIndex)) ? Number(src.pickIndex) : 0,
    prior: {
      infra_fail_rate: Math.max(0, Math.min(1, Number(priorSrc.infra_fail_rate) || 0)),
    },
    observed: src.observed && typeof src.observed === 'object' && !Array.isArray(src.observed)
      ? /** @type {Record<string, object>} */ (src.observed)
      : {},
    reviewTestObservations: normalizeReviewTestObservations(src.reviewTestObservations),
    leafSticky: src.leafSticky && typeof src.leafSticky === 'object'
      ? /** @type {{ key: string, harness: string, model: string }} */ (src.leafSticky)
      : null,
  };
}

/**
 * Sanitize the injected review-test observation map. Only non-negative integer
 * counts per harness survive; anything else degrades to "no observation".
 *
 * @param {unknown} raw
 * @returns {Record<string, { positive: number, negative: number }>}
 */
function normalizeReviewTestObservations(raw) {
  /** @type {Record<string, { positive: number, negative: number }>} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [harness, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    const id = String(harness || '').trim().toLowerCase();
    if (!id || !value || typeof value !== 'object') continue;
    const obj = /** @type {{ positive?: unknown, negative?: unknown }} */ (value);
    const positive = Number(obj.positive);
    const negative = Number(obj.negative);
    const counts = {
      positive: Number.isFinite(positive) && positive > 0 ? Math.floor(positive) : 0,
      negative: Number.isFinite(negative) && negative > 0 ? Math.floor(negative) : 0,
    };
    if (counts.positive > 0 || counts.negative > 0) out[id] = counts;
  }
  return out;
}

/**
 * Clamps a numeric ratio to `[0, 1]`; non-finite input yields 0.
 *
 * @param {unknown} value
 * @returns {number}
 */
function clampUnit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

/**
 * Risk in `[0, 1]` that one plan window runs out before the current task ends.
 *
 * Three monotonic signals are combined with `max` (less margin / faster growth
 * never lowers the result):
 * - utilization ramp from `PLAN_LIMIT_WARN_UTILIZATION` to 100%;
 * - a remaining-margin ramp that grows as `forecast.remainingMs` falls below
 *   `PLAN_LIMIT_TYPICAL_TASK_MS`; a projected exhaustion before the reset
 *   (`forecast.beforeReset`) lifts it to at least a half-strength signal;
 * - a growth ramp over `forecast.percentPerHour` above
 *   `PLAN_LIMIT_GROWTH_WARN_PERCENT_PER_HOUR`.
 *
 * Pure: it reads only the passed row, so there is no I/O and no `Date.now()`.
 *
 * @param {object} row enriched plan-limit row from `readHarnessPlanLimits`
 * @returns {number} risk in `[0, 1]`
 */
function planLimitWindowRisk(row) {
  const utilization = Number(row?.utilization);
  const utilizationRisk = Number.isFinite(utilization) && utilization >= PLAN_LIMIT_WARN_UTILIZATION
    ? clampUnit((utilization - PLAN_LIMIT_WARN_UTILIZATION) / (100 - PLAN_LIMIT_WARN_UTILIZATION))
    : 0;
  const forecast = row?.forecast;
  if (!forecast || typeof forecast !== 'object') return utilizationRisk;
  const remainingMs = Number(forecast.remainingMs);
  const marginRisk = Number.isFinite(remainingMs)
    ? 1 - clampUnit(remainingMs / PLAN_LIMIT_TYPICAL_TASK_MS)
    : 0;
  // Exhausting before the reset is already a half-strength signal; the rest
  // grows as the projected remaining margin shrinks toward zero.
  const exhaustionRisk = forecast.beforeReset === true ? 0.5 + 0.5 * marginRisk : marginRisk;
  const percentPerHour = Number(forecast.percentPerHour);
  const growthRisk = Number.isFinite(percentPerHour)
    ? clampUnit(
      (percentPerHour - PLAN_LIMIT_GROWTH_WARN_PERCENT_PER_HOUR)
      / (PLAN_LIMIT_GROWTH_MAX_PERCENT_PER_HOUR - PLAN_LIMIT_GROWTH_WARN_PERCENT_PER_HOUR),
    )
    : 0;
  return Math.max(utilizationRisk, exhaustionRisk, growthRisk);
}

/**
 * Plan-limit penalty for one harness, in `[0, PLAN_LIMIT_PENALTY_MAX]`.
 *
 * No-data rows keep today's behavior: a stale/expired row, a row without a
 * usable utilization, or a row whose `resetsAt` already passed contribute
 * nothing. A row at/above `PLAN_LIMIT_UTILIZATION` keeps the historical
 * `PLAN_LIMIT_PENALTY` floor even without a forecast, and a row with a usable
 * forecast (`confidence` of `low` or `high`) may lift it to the proportional
 * {@link planLimitWindowRisk} term. The strongest matching window wins.
 *
 * With `planWindowConfig.enabled` (default) and a `modelId`, model-scoped
 * windows (`seven_day_opus` / `seven_day_sonnet`, Codex model buckets) only
 * penalise the models they belong to. Rows with an unrecognized window type
 * (`type: ''`) and `seven_day_oauth_apps` (not a Claude Code session window)
 * stay neutral there. Disabled, or without a model id, every row of the
 * harness counts: the exact legacy per-harness behavior.
 *
 * @param {object[]} planLimits
 * @param {string} harnessId
 * @param {number} now
 * @param {string} [modelId]
 * @param {{ enabled?: boolean }} [planWindowConfig]
 * @returns {number}
 */
function planLimitPenalty(planLimits, harnessId, now, modelId = '', planWindowConfig = undefined) {
  let penalty = 0;
  const scoped = resolvePlanWindowConfig(planWindowConfig).enabled && String(modelId || '').trim() !== '';
  const rows = scoped
    ? selectPlanWindows(planLimits, harnessId, modelId)
      .filter((entry) => entry.type !== '' && entry.type !== PLAN_WINDOW_TYPES.SEVEN_DAY_OAUTH_APPS)
      .map((entry) => entry.row)
    : planLimits;
  for (const row of rows) {
    if (String(row?.harness || '').trim().toLowerCase() !== harnessId) continue;
    if (row?.stale === true || row?.expired === true) continue;
    const resetsAt = Date.parse(String(row?.resetsAt || ''));
    if (Number.isFinite(resetsAt) && resetsAt <= now) continue;
    const rawUtilization = row?.utilization;
    const utilization = rawUtilization == null || rawUtilization === '' ? NaN : Number(rawUtilization);
    if (!Number.isFinite(utilization)) continue;
    let value = utilization >= PLAN_LIMIT_UTILIZATION ? PLAN_LIMIT_PENALTY : 0;
    const confident = row?.confidence === 'low' || row?.confidence === 'high';
    if (confident && row?.forecast && typeof row.forecast === 'object') {
      value = Math.max(value, PLAN_LIMIT_PENALTY_MAX * planLimitWindowRisk(row));
    }
    penalty = Math.max(penalty, Math.min(PLAN_LIMIT_PENALTY_MAX, value));
  }
  return penalty;
}

/**
 * A fresh limit hit on the whole harness, or on the same model/base id. A hit
 * for a sibling model must not penalise this candidate.
 *
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @param {string} harnessId
 * @param {string} modelId
 * @returns {boolean}
 */
function hasFreshLimitHit(history, harnessId, modelId) {
  const entry = history.freshLimitHits[String(harnessId || '').toLowerCase()];
  if (!entry) return false;
  if (entry.whole === true) return true;
  const full = String(modelId || '').trim().toLowerCase();
  const base = decodeModelValue(modelId).modelId.toLowerCase();
  return entry.models.some((model) => {
    const value = String(model || '').trim().toLowerCase();
    return value === full || value === base;
  });
}

/**
 * Prior uses in this chat for the same role. A model whose next review PASSed
 * wins ties (-1) so a proven winner is not rotated away.
 *
 * @param {ModelPickCandidate} candidate
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @returns {number}
 */
function chatUseCount(candidate, history, pickRole = '') {
  const role = String(pickRole || '').trim().toLowerCase();
  const sticky = history.leafSticky;
  if (sticky && (role === 'implement' || role === 'fix') && candidateModelKey(candidate) === sticky.key) {
    return -2;
  }
  const reviewSticky = history.leafReviewSticky;
  if (reviewSticky && role === 'review' && candidateModelKey(candidate) === reviewSticky.key) {
    return -2;
  }
  const entry = history.chatModels[candidateModelKey(candidate)];
  if (entry && typeof entry === 'object') {
    if (/** @type {{ next_review_passed?: unknown }} */ (entry).next_review_passed === true) return -1;
    const count = toUsageCount(/** @type {{ count?: unknown }} */ (entry).count);
    if (count > 0) return count;
  }
  return toUsageCount(history.chatHarnesses[harnessKey(candidate)]);
}

/**
 * @param {ModelPickCandidate} candidate
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @returns {number}
 */
function lastUsedMs(candidate, history) {
  const raw = history.lastUsedAt[candidateModelKey(candidate)] || history.lastUsedAt[harnessKey(candidate)] || '';
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Weekly pace level of a candidate: +1 wasted reserve, 0 neutral, -1 above pace.
 *
 * @param {ModelPickCandidate} candidate
 * @returns {number}
 */
function paceLevelOf(candidate) {
  const level = Number(candidate?.plan_pace_level);
  return Number.isFinite(level) ? level : 0;
}

/**
 * 5h headroom level of a candidate (higher wins). Absent (rotation off or
 * feature disabled) is neutral, so it never separates two candidates.
 *
 * @param {ModelPickCandidate} candidate
 * @returns {number}
 */
function headroomLevelOf(candidate) {
  const level = Number(candidate?.plan_headroom_level);
  return Number.isFinite(level) ? level : PLAN_HEADROOM_LEVEL_NEUTRAL;
}

/**
 * Deterministic within-band order: chat diversity, review test capability
 * (review only), 5h plan headroom level, least-used harness, then least-used model, then
 * least-recently-used, then id as the final stable key.
 *
 * @param {ModelPickCandidate} left
 * @param {ModelPickCandidate} right
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @param {boolean} [preferReviewTests] Review tie-break: a harness that can run
 *   the review-verify catalog itself wins over one that cannot.
 * @returns {number}
 */
function compareWithinBand(left, right, history, preferReviewTests = false, pickRole = '') {
  const chatDiff = chatUseCount(left, history, pickRole) - chatUseCount(right, history, pickRole);
  if (chatDiff !== 0) return chatDiff;
  if (preferReviewTests) {
    const leftTests = left.traits.review_can_run_tests === true;
    const rightTests = right.traits.review_can_run_tests === true;
    if (leftTests !== rightTests) return leftTests ? -1 : 1;
  }
  const leftSpare = headroomLevelOf(left) === PLAN_HEADROOM_LEVEL_SPARE;
  const rightSpare = headroomLevelOf(right) === PLAN_HEADROOM_LEVEL_SPARE;
  if (leftSpare !== rightSpare) return leftSpare ? 1 : -1;
  const paceDiff = paceLevelOf(right) - paceLevelOf(left);
  if (paceDiff !== 0) return paceDiff;
  const headroomDiff = headroomLevelOf(right) - headroomLevelOf(left);
  if (headroomDiff !== 0) return headroomDiff;
  const harnessDiff = toUsageCount(history.harnessUses7d[harnessKey(left)]) - toUsageCount(history.harnessUses7d[harnessKey(right)]);
  if (harnessDiff !== 0) return harnessDiff;
  const modelDiff = toUsageCount(history.modelUses7d[candidateModelKey(left)]) - toUsageCount(history.modelUses7d[candidateModelKey(right)]);
  if (modelDiff !== 0) return modelDiff;
  const lastDiff = lastUsedMs(left, history) - lastUsedMs(right, history);
  if (lastDiff !== 0) return lastDiff;
  return candidateModelKey(left).localeCompare(candidateModelKey(right));
}

/**
 * Name the within-band key that actually decided the pick. The order mirrors
 * `compareWithinBand`: keep-winner/chat uses -> review can run tests -> 5h plan
 * headroom -> harness 7d -> model 7d -> LRU -> id. The cold-start bonus is applied before the band
 * is cut, so it is named only when dropping it would have changed the winner.
 *
 * @param {ModelPickCandidate} pick
 * @param {ModelPickCandidate[]} inBand
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @param {ModelPickCandidate | undefined} noExplorePick
 * @param {boolean} exploreTurn
 * @param {boolean} [preferReviewTests]
 * @returns {string}
 */
function decisiveBandReason(pick, inBand, history, noExplorePick, exploreTurn, preferReviewTests = false, pickRole = '') {
  if (exploreTurn && pick.cold_start && noExplorePick !== pick) return 'cold-start explore';
  if (inBand.length <= 1) return 'only candidate in band';
  const rival = inBand[1];
  const pickChatUses = chatUseCount(pick, history, pickRole);
  if (pickChatUses !== chatUseCount(rival, history, pickRole)) {
    if (pickChatUses === -2) return 'sticky leaf executor (last completed implement/fix on leaf)';
    return pickChatUses === -1
      ? 'keep winner (last review PASS in chat)'
      : `fewer uses in this chat (${pickChatUses})`;
  }
  if (preferReviewTests) {
    const pickTests = pick.traits.review_can_run_tests === true;
    const rivalTests = rival.traits.review_can_run_tests === true;
    if (pickTests !== rivalTests) {
      return pickTests ? 'review can run tests' : 'review cannot run tests';
    }
  }
  const pickSpare = headroomLevelOf(pick) === PLAN_HEADROOM_LEVEL_SPARE;
  if (pickSpare !== (headroomLevelOf(rival) === PLAN_HEADROOM_LEVEL_SPARE)) return `5h plan headroom level ${headroomLevelOf(pick)}`;
  if (paceLevelOf(pick) !== paceLevelOf(rival)) return `weekly plan pace level ${paceLevelOf(pick)}`;
  const pickHeadroom = headroomLevelOf(pick);
  if (pickHeadroom !== headroomLevelOf(rival)) return `5h plan headroom level ${pickHeadroom}`;
  const pickHarnessUses = toUsageCount(history.harnessUses7d[harnessKey(pick)]);
  if (pickHarnessUses !== toUsageCount(history.harnessUses7d[harnessKey(rival)])) {
    return `harness least-used in role 7d (${pickHarnessUses})`;
  }
  const pickModelUses = toUsageCount(history.modelUses7d[candidateModelKey(pick)]);
  if (pickModelUses !== toUsageCount(history.modelUses7d[candidateModelKey(rival)])) {
    return `model least-used 7d (${pickModelUses})`;
  }
  if (lastUsedMs(pick, history) !== lastUsedMs(rival, history)) return 'least-recently-used';
  return 'stable id order';
}

/**
 * @param {ModelPickCandidate} candidate
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @param {boolean} inBand
 * @param {{ review?: boolean, pickRole?: string }} [options]
 * @returns {string}
 */
function candidateReason(candidate, history, inBand, options = {}) {
  const parts = [`score=${candidate.score.toFixed(3)}`];
  if (inBand) parts.push('in-band');
  if (candidate.cold_start) parts.push('cold-start');
  if (options.review) {
    parts.push(candidate.traits.review_can_run_tests ? 'can-run-tests' : 'no-tests');
  }
  const chat = chatUseCount(candidate, history, options.pickRole || '');
  if (chat === -2) parts.push('sticky-leaf');
  else if (chat === -1) parts.push('keep-winner');
  else if (chat > 0) parts.push(`chat_uses=${chat}`);
  const role = toUsageCount(history.harnessUses7d[harnessKey(candidate)]);
  if (role > 0) parts.push(`role_uses_7d=${role}`);
  if (candidate.plan_limit_penalty > 0) parts.push(`plan-limit-penalty=${candidate.plan_limit_penalty}`);
  if (paceLevelOf(candidate) !== 0) parts.push(`plan_pace_level=${paceLevelOf(candidate)}`);
  if (candidate.pace_cost_factor) parts.push(`pace_cost_factor=${candidate.pace_cost_factor}`);
  if (headroomLevelOf(candidate) !== PLAN_HEADROOM_LEVEL_NEUTRAL) parts.push(`plan-headroom=${headroomLevelOf(candidate)}`);
  if (candidate.high_infra_risk) parts.push('high-infra-risk');
  if (candidate.low_completion_risk) parts.push('low-completion-risk');
  parts.push(...observedReasonParts(candidate));
  return parts.join(' ');
}

/**
 * Explain a MODEL_UNAVAILABLE result: which filter dropped the candidates.
 *
 * @param {string} role
 * @param {ModelPickFilterStats} stats
 * @returns {string}
 */
function unavailableModelError(role, stats) {
  const reasons = [];
  if (stats.delegatableHarnesses === 0) {
    reasons.push('no enabled, ready, delegatable harness');
  } else if (stats.favoritesHarnesses === 0) {
    reasons.push('no delegatable harness has Settings favorites configured');
  } else {
    if (stats.reviewAdapterBlocked > 0) {
      reasons.push(`${stats.reviewAdapterBlocked} harness(es) blocked by review adapter guarantee`);
    }
    if (stats.harnessExcluded > 0) reasons.push(`${stats.harnessExcluded} harness(es) skipped by exclude_harness`);
    if (stats.hardExcluded > 0) reasons.push(`${stats.hardExcluded} model(s) skipped by exclude_model`);
    if (stats.lockedOut > 0) reasons.push(`${stats.lockedOut} model(s) under active usage lockout`);
    if (stats.flash > 0) reasons.push(`${stats.flash} flash model(s) skipped for review`);
    if (stats.unavailable > 0) reasons.push(`${stats.unavailable} model(s) unavailable`);
    if (stats.roleMismatch > 0) reasons.push(`${stats.roleMismatch} model(s) not eligible for role "${role}"`);
    if (stats.historyExcluded > 0) reasons.push(`${stats.historyExcluded} model(s) skipped by chat history`);
    if (stats.planWindowExhausted > 0) reasons.push(`${stats.planWindowExhausted} model(s) on an exhausted weekly plan window`);
    if (reasons.length === 0) reasons.push('no eligible favorite model');
  }
  return `No Settings favorite matches role "${role}" on an enabled, ready, delegatable harness (${reasons.join('; ')}).`;
}

/**
 * @param {string} model
 * @param {string[]} callerExcludeModels
 * @param {string[]} historyHardExcludeModels
 * @param {string[]} softExcludeModels
 * @param {boolean} applySoftExcludes
 * @returns {string[]}
 */
function modelExcludeFilterReasons(
  model,
  callerExcludeModels,
  historyHardExcludeModels,
  softExcludeModels,
  applySoftExcludes,
) {
  /** @type {string[]} */
  const reasons = [];
  if (callerExcludeModels.some((excluded) => isExcludedDelegationModel(model, excluded))) {
    reasons.push('caller-excluded');
  }
  if (historyHardExcludeModels.some((excluded) => isExcludedDelegationModel(model, excluded))) {
    reasons.push('history-excluded');
  }
  if (applySoftExcludes && softExcludeModels.some((excluded) => isExcludedDelegationModel(model, excluded))) {
    reasons.push('history-excluded-soft');
  }
  return reasons;
}

/**
 * Map one shared-validator refusal code to the picker's historical
 * `filter_reasons` machine strings. The Settings diagnosis is a persisted,
 * asserted contract, so the vocabulary stays stable while the decision itself
 * comes from the single validator.
 *
 * @param {object} verdict
 * @param {object} ctx
 * @returns {string[]}
 */
function favoriteGateFilterReasons(verdict, ctx) {
  const {
    role,
    model,
    callerExcludeModels,
    historyHardExcludeModels,
    softExcludeModels,
    applySoftExcludes,
  } = ctx;
  switch (verdict.code) {
    case MODEL_PICK_HARD_GATE_CODES.HARNESS_UNAVAILABLE:
    case MODEL_PICK_HARD_GATE_CODES.HARNESS_NOT_ALLOWED:
      return ['harness-disabled'];
    case MODEL_PICK_HARD_GATE_CODES.REVIEW_UNCERTIFIED:
      return ['review-adapter-blocked'];
    case MODEL_PICK_HARD_GATE_CODES.HARNESS_EXCLUDED:
      return ['harness-excluded'];
    case MODEL_PICK_HARD_GATE_CODES.FAVORITES_MISSING:
      return ['no-favorites'];
    case MODEL_PICK_HARD_GATE_CODES.MODEL_NOT_FAVORITE:
      return ['not-favorite'];
    case MODEL_PICK_HARD_GATE_CODES.MODEL_EXCLUDED:
    case MODEL_PICK_HARD_GATE_CODES.HISTORY_EXCLUDED: {
      const excludeReasons = modelExcludeFilterReasons(
        model,
        callerExcludeModels,
        historyHardExcludeModels,
        softExcludeModels,
        applySoftExcludes,
      );
      return excludeReasons.length > 0 ? excludeReasons : ['history-excluded'];
    }
    case MODEL_PICK_HARD_GATE_CODES.FLASH_REVIEW:
      return ['flash-for-review'];
    case MODEL_PICK_HARD_GATE_CODES.MODEL_UNAVAILABLE:
      return ['unavailable'];
    case MODEL_PICK_HARD_GATE_CODES.ACTIVE_LOCKOUT:
      return ['active-lockout'];
    case MODEL_PICK_HARD_GATE_CODES.STARTUP_FAILURE_LOCKOUT:
      return ['startup-failure'];
    case MODEL_PICK_HARD_GATE_CODES.USAGE_LIMIT:
      return ['unavailable'];
    case MODEL_PICK_HARD_GATE_CODES.PLAN_WINDOW_EXHAUSTED:
      return [PLAN_WINDOW_EXHAUSTED_REASON];
    case MODEL_PICK_HARD_GATE_CODES.ROLE_MEMBERSHIP:
      return [describeRoleRejection(model, role)];
    default:
      return [String(verdict.reason || 'unavailable')];
  }
}

/**
 * Attribute a refusal to the legacy filter-stat bucket the `MODEL_UNAVAILABLE`
 * message explains. Kept beside the reason mapping so the two never drift.
 *
 * @param {object} stats
 * @param {string} code
 * @returns {void}
 */
function bumpFavoriteFilterStat(stats, code) {
  switch (code) {
    case MODEL_PICK_HARD_GATE_CODES.REVIEW_UNCERTIFIED:
      stats.reviewAdapterBlocked += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.HARNESS_EXCLUDED:
      stats.harnessExcluded += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.MODEL_EXCLUDED:
      stats.hardExcluded += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.HISTORY_EXCLUDED:
      stats.historyExcluded += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.FLASH_REVIEW:
      stats.flash += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.MODEL_UNAVAILABLE:
    case MODEL_PICK_HARD_GATE_CODES.USAGE_LIMIT:
      stats.unavailable += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.ACTIVE_LOCKOUT:
      stats.lockedOut += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.STARTUP_FAILURE_LOCKOUT:
      stats.lockedOut += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.ROLE_MEMBERSHIP:
      stats.roleMismatch += 1;
      return;
    case MODEL_PICK_HARD_GATE_CODES.PLAN_WINDOW_EXHAUSTED:
      stats.planWindowExhausted += 1;
      return;
    default:
      return;
  }
}

/**
 * Review-adapter gate options carrying the workspace delegation env, or none
 * (env-only) when the caller has no workspace folder.
 *
 * @param {unknown} workspaceFolder
 * @returns {{ env?: NodeJS.ProcessEnv }}
 */
function workspaceReviewAdapterOptions(workspaceFolder) {
  const folder = String(workspaceFolder || '').trim();
  return folder ? { env: resolveDelegationEnv(folder) } : {};
}

/**
 * Run the ONE shared hard-gate validator for a single Settings favorite row.
 * The picker's admission loop and the Settings diagnosis both consume this, so
 * a rule cannot be enforced by one path and skipped by the other.
 *
 * @param {object} ctx see {@link favoriteHardFilterReasons}
 * @returns {{ ok: boolean, code: string, reasons: string[], verdict: object }}
 */
function classifyFavoriteRowGate(ctx) {
  const {
    role,
    harness,
    harnessId,
    model,
    row,
    listed,
    profiles,
    callerExcludeModels,
    historyHardExcludeModels,
    softExcludeModels,
    applySoftExcludes,
    hardExcludeHarnesses,
    hardExcludePairs,
    history,
    now,
    checkReviewAdapter,
    usageLimits,
    workspaceFolder,
  } = ctx;
  const roles = Array.isArray(row?.roles) ? row.roles : listRolesForModel(model, profiles);
  const adapter = checkReviewAdapter === true && (role === 'review' || role === 'plan')
    ? assertReviewAdapterAllowed(harnessId, workspaceReviewAdapterOptions(workspaceFolder))
    : undefined;
  const verdict = evaluateModelPickHardGates({
    role,
    harness: harnessId,
    model,
    harnessRow: harness,
    checkReviewAdapter: checkReviewAdapter === true,
    reviewAdapter: adapter,
    // Premium review is an annotation in the automatic picker; the start gate
    // enforces the justification or the explicit override.
    allowPremium: true,
    favoritesConfigured: listed ? listed.favorites_configured === true : false,
    favoriteModels: Array.isArray(listed?.items)
      ? listed.items.map((item) => String(item?.id ?? '').trim()).filter(Boolean)
      : undefined,
    excludeModels: callerExcludeModels,
    excludeHarnesses: hardExcludeHarnesses,
    excludePairs: hardExcludePairs,
    historyExcludeModels: historyHardExcludeModels,
    softExcludeModels,
    applySoftExcludes,
    lockouts: history?.lockouts,
    usageLimits,
    // Picker-only hard weekly-window gate; `relaxPlanWindow` is the D4 escape
    // hatch for a pool the gate itself emptied.
    planWindowLimits: ctx.relaxPlanWindow === true || !Array.isArray(history?.planLimits)
      ? undefined
      : history.planLimits,
    planWindowConfig: ctx.planWindowConfig,
    modelRoles: roles,
    modelAvailable: row?.available !== false,
    now,
  });
  if (verdict.ok) return { ok: true, code: '', reasons: [], verdict };
  return { ok: false, code: verdict.code, reasons: favoriteGateFilterReasons(verdict, ctx), verdict };
}

/**
 * Hard eligibility filters for one Settings favorite row. An empty list means the
 * model may enter ranking (penalties such as plan limits are reported separately).
 *
 * @param {{
 *   role: ModelPickRole,
 *   harness: ModelPickHarnessRow,
 *   harnessId: string,
 *   model: string,
 *   row: object,
 *   listed: ModelPickHarnessModels | undefined,
 *   profiles: ModelRoleProfiles,
 *   callerExcludeModels: string[],
 *   historyHardExcludeModels: string[],
 *   softExcludeModels: string[],
 *   applySoftExcludes: boolean,
 *   hardExcludeHarnesses: string[],
 *   history: ReturnType<typeof normalizePickHistory>,
 *   now: number,
 *   checkReviewAdapter: boolean,
 *   usageLimits?: object[],
 * }} ctx
 * @returns {string[]}
 */
/**
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @param {string} harnessId
 * @param {string} model
 * @param {number} now
 * @param {string[]} filterReasons
 * @returns {Record<string, string | null>}
 */
function lockoutDiagnosisFields(history, harnessId, model, now, filterReasons) {
  const hasLockoutReason = filterReasons.includes('startup-failure') || filterReasons.includes('active-lockout');
  if (!hasLockoutReason) return {};
  const row = findActiveLockoutRow(history?.lockouts, harnessId, model, now);
  if (!row) return {};
  return {
    lockout_code: String(row.code || '').trim() || null,
    lockout_reset_at: String(row.resetAt || '').trim() || null,
  };
}

/**
 * Informational note (never a filter reason) on rows the hard weekly-window
 * gate WOULD have excluded when an empty pool forced it off (D4).
 *
 * @param {boolean} relaxed
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @param {string} harnessId
 * @param {string} model
 * @param {number} now
 * @param {{ enabled?: boolean }} [planWindowConfig]
 * @param {string[]} [filterReasons]
 * @returns {Record<string, unknown>}
 */
function planWindowRelaxedDiagnosisFields(relaxed, history, harnessId, model, now, planWindowConfig, filterReasons = []) {
  const excluded = filterReasons.includes('plan-window-exhausted');
  if (!relaxed && !excluded) return {};
  const exhausted = planWindowExhaustedReason({
    harness: harnessId,
    modelId: model,
    planLimits: history.planLimits,
    now,
    config: planWindowConfig,
  });
  if (!exhausted) return {};
  // Show which window and whether the value is a measurement or a local
  // estimate (reservations), so an estimate-driven exclusion is explainable.
  const detail = {
    plan_window: {
      type: exhausted.type,
      utilization: exhausted.utilization,
      basis: exhausted.basis,
      measured_utilization: exhausted.measuredUtilization,
      estimated_pp: exhausted.estimatedPp,
      resets_at: exhausted.resetsAt,
    },
  };
  if (relaxed) return { plan_window_note: PLAN_WINDOW_RELAXED_NOTE, ...detail };
  return exhausted.basis === 'estimated' ? { plan_window_note: PLAN_WINDOW_ESTIMATED_NOTE, ...detail } : detail;
}

function favoriteHardFilterReasons(ctx) {
  const { role, harness, harnessId, model, listed, hardExcludeHarnesses, checkReviewAdapter, workspaceFolder } = ctx;
  // The empty-items diagnosis row carries no model id. The validator would stop
  // at `model_required`, so keep the historical cause strings for that row.
  if (!model) {
    if (!harness?.enabled || !harness?.ready || !harness?.can_delegate) return ['harness-disabled'];
    if (checkReviewAdapter && (role === 'review' || role === 'plan') && !assertReviewAdapterAllowed(harnessId, workspaceReviewAdapterOptions(workspaceFolder)).ok) {
      return ['review-adapter-blocked'];
    }
    if (hardExcludeHarnesses.some((excluded) => isExcludedDelegationHarness(harnessId, excluded))) {
      return ['harness-excluded'];
    }
    if (!listed || listed.favorites_configured !== true) return ['no-favorites'];
    return [describeRoleRejection(model, role)];
  }
  return classifyFavoriteRowGate(ctx).reasons;
}

/**
 * Score penalties that do not remove a model from the pool (distinct from hard filters).
 *
 * @param {ReturnType<typeof normalizePickHistory>} history
 * @param {string} harnessId
 * @param {string} model
 * @param {number} now
 * @param {{ enabled?: boolean }} [planWindowConfig]
 * @returns {string[]}
 */
function favoriteRankingPenalties(history, harnessId, model, now, planWindowConfig = undefined) {
  /** @type {string[]} */
  const penalties = [];
  if (planLimitPenalty(history.planLimits, harnessId, now, model, planWindowConfig) > 0) penalties.push('plan-limit-penalty');
  if (hasFreshLimitHit(history, harnessId, model)) penalties.push('fresh-limit-penalty');
  return penalties;
}

/**
 * Settings favorites audit table: every favorite row with assigned roles and why it
 * was rejected, penalized, or out-ranked. Heuristic tiers are not prices.
 *
 * @param {object} input same shape as {@link selectModelPick}
 * @param {{
 *   pick?: ModelPickCandidate | null,
 *   inBandKeys?: Set<string>,
 *   historyExcludeRelaxed?: boolean,
 *   checkReviewAdapter?: boolean,
 * }} [context]
 * @returns {{
 *   role: string,
 *   eligibilityCohort: string,
 *   policyVersion: string,
 *   rows: object[],
 * }}
 */
export function buildModelPickFavoriteDiagnosis(input = {}, context = {}) {
  const role = String(input.role || '').trim().toLowerCase();
  const profiles = input.profiles || DEFAULT_MODEL_ROLE_PROFILES;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const history = normalizePickHistory(input.history);
  const historyHardExcludeModels = history.hardExcludeModels;
  const historySoftExcludeModels = history.softExcludeModels.length > 0
    ? history.softExcludeModels
    : history.excludeModels;
  const callerExcludeModels = [
    String(input.excludeModel || '').trim(),
    ...(Array.isArray(input.excludeModels) ? input.excludeModels.map((id) => String(id || '').trim()) : []),
  ].filter(Boolean);
  const hardExcludeHarnesses = [
    String(input.excludeHarness || '').trim(),
    ...(Array.isArray(input.excludeHarnesses)
      ? input.excludeHarnesses.map((id) => String(id || '').trim())
      : []),
  ].filter(Boolean);
  const hardExcludePairs = Array.isArray(input.excludePairs)
    ? input.excludePairs.map((row) => ({
      harness: String(row?.harness || '').trim().toLowerCase(),
      model: String(row?.model || '').trim(),
    })).filter((row) => row.harness && row.model)
    : [];
  const applySoftExcludes = context.historyExcludeRelaxed !== true;
  const checkReviewAdapter = context.checkReviewAdapter === true;
  const pick = context.pick && typeof context.pick === 'object' ? context.pick : null;
  const pickKey = pick ? `${String(pick.harness || '').trim().toLowerCase()}/${String(pick.model || '').trim()}` : '';
  const inBandKeys = context.inBandKeys instanceof Set ? context.inBandKeys : new Set();
  /** @type {object[]} */
  const rows = [];
  for (const harness of input.harnesses || []) {
    const harnessId = String(harness?.id || '').trim();
    if (!harnessId) continue;
    const listed = input.modelsByHarness?.[harnessId];
    const items = Array.isArray(listed?.items) ? listed.items : [];
    if (items.length === 0) {
      const filterReasons = favoriteHardFilterReasons({
        role: /** @type {ModelPickRole} */ (role),
        harness,
        harnessId,
        model: '',
        row: {},
        listed,
        profiles,
        callerExcludeModels,
        historyHardExcludeModels,
        softExcludeModels: historySoftExcludeModels,
        applySoftExcludes,
        hardExcludeHarnesses,
        hardExcludePairs,
        history,
        now,
        checkReviewAdapter,
        usageLimits: input.usageLimits,
        workspaceFolder: input.workspaceFolder,
        planWindowConfig: input.planWindowConfig,
        relaxPlanWindow: context.planWindowRelaxed === true,
      });
      rows.push({
        harness: harnessId,
        model: '',
        label: '',
        roles: [],
        eligible: false,
        selected: false,
        filter_reasons: filterReasons,
        penalties: [],
        ranking_note: null,
      });
      continue;
    }
    for (const row of items) {
      const model = String(row.id || '').trim();
      if (!model) continue;
      const filterReasons = favoriteHardFilterReasons({
        role: /** @type {ModelPickRole} */ (role),
        harness,
        harnessId,
        model,
        row,
        listed,
        profiles,
        callerExcludeModels,
        historyHardExcludeModels,
        softExcludeModels: historySoftExcludeModels,
        applySoftExcludes,
        hardExcludeHarnesses,
        hardExcludePairs,
        history,
        now,
        checkReviewAdapter,
        usageLimits: input.usageLimits,
        workspaceFolder: input.workspaceFolder,
        planWindowConfig: input.planWindowConfig,
        relaxPlanWindow: context.planWindowRelaxed === true,
      });
      const roles = Array.isArray(row.roles) ? row.roles : listRolesForModel(model, profiles);
      const key = `${harnessId.toLowerCase()}/${model}`;
      const eligible = filterReasons.length === 0;
      const penalties = eligible ? favoriteRankingPenalties(history, harnessId, model, now, input.planWindowConfig) : [];
      /** @type {string | null} */
      let rankingNote = null;
      if (eligible && pickKey) {
        if (key === pickKey) rankingNote = 'selected';
        else if (inBandKeys.size > 0 && !inBandKeys.has(key)) rankingNote = 'out-of-band';
        else if (key !== pickKey) rankingNote = 'lower-score';
      }
      rows.push({
        harness: harnessId,
        model,
        label: String(row.label || model),
        roles,
        eligible,
        selected: key === pickKey,
        filter_reasons: filterReasons,
        penalties,
        ranking_note: rankingNote,
        ...planWindowRelaxedDiagnosisFields(context.planWindowRelaxed === true, history, harnessId, model, now, input.planWindowConfig, filterReasons),
        ...lockoutDiagnosisFields(history, harnessId, model, now, filterReasons),
      });
    }
  }
  const cohort = buildModelPickEligibilityCohort();
  return {
    role,
    eligibilityCohort: cohort,
    policyVersion: composeModelPickPolicyVersion(cohort),
    rows,
  };
}

/**
 * Pick `count` candidates from the rotation-ordered list.
 *
 * - Without `diverse`, every extra slot prefers a different harness but falls
 *   back to another model on a used harness to fill `count` (so `picks` is
 *   shorter only when fewer than `count` candidates exist).
 * - With `diverse: true`, a slot is only filled by a **new harness**; a
 *   same-harness candidate is never chosen, so `picks` is shorter than `count`
 *   when no unused harness remains. A new model provider is preferred within
 *   the new-harness pool.
 *
 * `ordered` is band-first, so the role band is exhausted before out-of-band
 * rows are considered.
 *
 * @param {ModelPickCandidate[]} ordered
 * @param {unknown} count
 * @param {boolean} diverse
 * @returns {ModelPickCandidate[]}
 */
function selectDiversePicks(ordered, count, diverse) {
  const requested = Math.floor(Number(count));
  const wanted = Number.isFinite(requested) && requested > 1
    ? Math.min(requested, ordered.length)
    : 1;
  const picks = [ordered[0]];
  if (wanted <= 1) return picks;
  const usedHarness = new Set([harnessKey(ordered[0])]);
  const usedProvider = new Set([ordered[0].provider]);
  const remaining = ordered.slice(1);
  while (picks.length < wanted && remaining.length > 0) {
    let bestIndex = 0;
    let bestRank = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const harnessNew = !usedHarness.has(harnessKey(candidate));
      const providerNew = !usedProvider.has(candidate.provider);
      const rank = diverse
        ? ((harnessNew ? 0 : 2) + (providerNew ? 0 : 1))
        : (harnessNew ? 0 : 1);
      if (rank < bestRank) {
        bestRank = rank;
        bestIndex = index;
      }
    }
    // `diverse` promises one pick per harness: stop instead of duplicating.
    if (diverse && bestRank >= 2) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    picks.push(chosen);
    usedHarness.add(harnessKey(chosen));
    usedProvider.add(chosen.provider);
  }
  return picks;
}

/**
 * Normalize the reviewer pool handed in by the parent (`prefer_models`).
 * Accepts `{ harness, model }` rows or `harness/model` strings; capped at 2.
 *
 * @param {unknown} value
 * @returns {{ harness: string, model: string }[]}
 */
export function normalizePreferModels(value) {
  if (!Array.isArray(value)) return [];
  /** @type {{ harness: string, model: string }[]} */
  const out = [];
  for (const row of value) {
    let harness = '';
    let model = '';
    if (row && typeof row === 'object') {
      harness = String(row.harness || '').trim().toLowerCase();
      model = String(row.model || '').trim();
    } else if (typeof row === 'string') {
      const at = row.indexOf('/');
      if (at > 0) {
        harness = row.slice(0, at).trim().toLowerCase();
        model = row.slice(at + 1).trim();
      }
    }
    if (!harness || !model) continue;
    if (out.some((member) => member.harness === harness && member.model === model)) continue;
    out.push({ harness, model });
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * @param {{ harness: string, model: string }} candidate
 * @param {{ harness: string, model: string }[]} members
 * @returns {boolean}
 */
function isPoolMember(candidate, members) {
  const harness = String(candidate.harness || '').toLowerCase();
  return members.some((member) => member.harness === harness && member.model === candidate.model);
}

/**
 * Join harness_list (enabled && ready && can_delegate) with favorite models.
 * Empty favorites (`favorites_configured` not true) are unset — no pick from
 * that harness, not the whole catalog. `delegation_start` uses the same unset
 * meaning by default (`CRETLI_DELEGATION_EMPTY_FAVORITES=all` is the legacy
 * start-any-id escape).
 *
 * Ranking: score DESC, then tier tie-break, then — inside the tie band — the
 * injected usage/rotation history. `rotation` accepts a mode string or a
 * `{ band, mode }` object. `history` is pure data (see `ModelPickHistory`).
 *
 * @param {{
 *   role?: unknown,
 *   excludeModel?: unknown,
 *   excludeModels?: unknown,
 *   excludeHarness?: unknown,
 *   excludeHarnesses?: unknown,
 *   harnesses?: ModelPickHarnessRow[],
 *   modelsByHarness?: Record<string, ModelPickHarnessModels>,
 *   profiles?: ModelRoleProfiles,
 *   weights?: ModelRoleScoreWeightsByRole,
 *   rotation?: unknown,
 *   history?: unknown,
 *   explore?: unknown,
 *   count?: unknown,
 *   diverse?: unknown,
 *   now?: unknown,
 *   allowHighInfra?: unknown,
 *   allowLowCompletion?: unknown,
 *   preferModels?: unknown,
 *   adaptiveConfig?: Partial<ModelPickAdaptiveConfig>,
 * }} input
 * @returns {{
 *   ok: true,
 *   pick: ModelPickCandidate,
 *   picks: ModelPickCandidate[],
 *   candidates: ModelPickCandidate[],
 *   rotation: object,
 * } | {
 *   ok: false,
 *   code: string,
 *   error: string,
 * }}
 */
export function selectModelPick(input = {}) {
  const role = String(input.role || '').trim().toLowerCase();
  if (!MODEL_PICK_ROLES.includes(/** @type {ModelPickRole} */ (role))) {
    return {
      ok: false,
      code: 'VALIDATION',
      error: 'role must be plan, implement, review, or fix',
    };
  }
  const profiles = input.profiles || DEFAULT_MODEL_ROLE_PROFILES;
  const weightsByRole = input.weights || loadRoleScoreWeights();
  const roleWeights = weightsByRole[/** @type {ModelPickRole} */ (role)] || DEFAULT_ROLE_SCORE_WEIGHTS.implement;
  const matchers = profiles[/** @type {ModelPickRole} */ (role)] || [];
  const rotation = normalizeRotationConfig(input.rotation ?? loadRotationConfig());
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const history = normalizePickHistory(input.history);
  // `count` / `diverse` build a fanout set: the first pick is always the normal
  // single pick, extra slots prefer another harness (and provider).
  const count = Math.max(1, Math.floor(Number(input.count)) || 1);
  const diverse = input.diverse === true;
  // Observed-outcome blend: on by default, `adaptive: false` (MCP argument) or
  // `adaptive.enabled: false` in `data/model-role-profiles.json` disables it and
  // restores the pure heuristic ranking. Observed stats are still reported.
  const adaptiveConfig = normalizeAdaptiveConfig({
    adaptive: {
      ...loadAdaptiveConfig(),
      ...(input.adaptiveConfig && typeof input.adaptiveConfig === 'object' ? input.adaptiveConfig : {}),
    },
  });
  const adaptive = input.adaptive === false
    ? false
    : input.adaptive === true
      ? true
      : adaptiveConfig.enabled;
  const resolvedAdaptiveConfig = input.adaptive === false
    ? { ...adaptiveConfig, enabled: false }
    : adaptiveConfig;
  // Caller excludes and the last implementer (review role) stay hard. The last
  // reviewer is a soft preference and may relax when no other candidate exists.
  const historyHardExcludeModels = history.hardExcludeModels;
  const historySoftExcludeModels = history.softExcludeModels.length > 0
    ? history.softExcludeModels
    : history.excludeModels;
  const callerExcludeModels = [
    String(input.excludeModel || '').trim(),
    ...(Array.isArray(input.excludeModels) ? input.excludeModels.map((id) => String(id || '').trim()) : []),
  ].filter(Boolean);
  const hardExcludeModels = [...callerExcludeModels, ...historyHardExcludeModels];
  const hardExcludeHarnesses = [
    String(input.excludeHarness || '').trim(),
    ...(Array.isArray(input.excludeHarnesses)
      ? input.excludeHarnesses.map((id) => String(id || '').trim())
      : []),
  ].filter(Boolean);
  const hardExcludePairs = Array.isArray(input.excludePairs)
    ? input.excludePairs.map((row) => ({
      harness: String(row?.harness || '').trim().toLowerCase(),
      model: String(row?.model || '').trim(),
    })).filter((row) => row.harness && row.model)
    : [];
  const checkReviewAdapter = input.checkReviewAdapter === true
    || (input.diagnosisInput && typeof input.diagnosisInput === 'object'
      && input.diagnosisInput.checkReviewAdapter === true);
  const cohort = buildModelPickEligibilityCohort();
  // Out-of-band exploration (stage 6) is opt-in per call: a caller that passes
  // none of `exploreConfig` / `exploreAttempts` / `exploreContext` gets exactly
  // the pre-exploration response, byte for byte, with no `explore` key at all.
  // The shared entry point (`pickModelForPurpose`) always passes them, so
  // `model_pick`, the Watcher and the Scout read one picker and one policy.
  const exploreRequested = input.exploreConfig !== undefined
    || input.exploreAttempts !== undefined
    || input.exploreLedger !== undefined
    || input.exploreContext !== undefined;
  const exploreConfig = normalizeModelPickExploreConfig(
    input.exploreConfig ?? loadModelPickExploreConfig(),
  );
  /** @type {ReturnType<typeof evaluateModelPickExploration> | null} */
  let exploration = null;
  /**
   * @param {object} body
   * @returns {object}
   */
  const withPickTelemetry = (body) => {
    const diagnosisInput = input.diagnosisInput && typeof input.diagnosisInput === 'object'
      ? { ...input, ...input.diagnosisInput }
      : input;
    const { inBandKeys, exploration: assessment, ...publicBody } = body;
    const segment = assessment?.segment || '';
    return {
      ...publicBody,
      eligibilityCohort: cohort,
      policyVersion: composeModelPickPolicyVersion(cohort, segment),
      ...(assessment ? { explore: assessment } : {}),
      diagnosis: buildModelPickFavoriteDiagnosis(diagnosisInput, {
        pick: body.ok ? body.pick : null,
        inBandKeys,
        historyExcludeRelaxed: body.rotation?.history_exclude_relaxed === true,
        planWindowRelaxed: body.rotation?.plan_window_relaxed === true,
        checkReviewAdapter: diagnosisInput.checkReviewAdapter === true,
      }),
    };
  };
  /**
   * One exploration pass over a finished candidate set. Shared by the
   * `rotation: off` escape hatch and the band path so a pair is assessed by the
   * same policy no matter how the ordinary pick was produced.
   *
   * @param {ModelPickCandidate[]} candidates
   * @param {ModelPickCandidate | null} pick
   * @param {Record<string, unknown>} context
   * @returns {ReturnType<typeof evaluateModelPickExploration> | null}
   */
  const runExploration = (candidates, pick, context) => {
    if (!exploreRequested) return null;
    const ledger = input.exploreLedger && typeof input.exploreLedger === 'object'
      ? /** @type {object} */ (input.exploreLedger)
      : {};
    return evaluateModelPickExploration({
      role,
      pick,
      candidates,
      config: exploreConfig,
      attempts: ledger.attempts ?? input.exploreAttempts,
      autoExecuted: ledger.autoExecuted ?? input.exploreAutoExecuted,
      delegationRows: ledger.delegations,
      context: {
        ...context,
        ...(input.exploreContext && typeof input.exploreContext === 'object' ? input.exploreContext : {}),
      },
      metering: input.exploreMetering,
      workspaceKey: String(ledger.workspaceKey || input.workspaceFolder || '').trim(),
      now,
      log: typeof input.exploreLog === 'function' ? input.exploreLog : undefined,
    });
  };
  /**
   * @param {string[]} softExcludeModels
   * @param {boolean} applySoftExcludes
   * @returns {{ ranked: ModelPickCandidate[], stats: ModelPickFilterStats }}
   */
  const collect = (softExcludeModels, applySoftExcludes = true, relaxPlanWindow = false) => {
    /** @type {ModelPickFilterStats} */
    const stats = {
      delegatableHarnesses: 0,
      harnessExcluded: 0,
      favoritesHarnesses: 0,
      hardExcluded: 0,
      historyExcluded: 0,
      lockedOut: 0,
      flash: 0,
      unavailable: 0,
      roleMismatch: 0,
      reviewAdapterBlocked: 0,
      planWindowExhausted: 0,
    };
    /** @type {ModelPickCandidate[]} */
    const out = [];
    for (const harness of input.harnesses || []) {
      if (!harness?.enabled || !harness?.ready || !harness?.can_delegate) continue;
      const harnessId = String(harness.id || '').trim();
      if (!harnessId) continue;
      stats.delegatableHarnesses += 1;
      const listed = input.modelsByHarness?.[harnessId];
      if (listed && listed.favorites_configured === true) stats.favoritesHarnesses += 1;
      if (hardExcludeHarnesses.some((excluded) => isExcludedDelegationHarness(harnessId, excluded))) {
        stats.harnessExcluded += 1;
        continue;
      }
      if (checkReviewAdapter && (role === 'review' || role === 'plan')
        && !assertReviewAdapterAllowed(harnessId, workspaceReviewAdapterOptions(input.workspaceFolder)).ok) {
        if (listed && listed.favorites_configured === true) stats.reviewAdapterBlocked += 1;
        continue;
      }
      if (!listed || listed.favorites_configured !== true) continue;
      for (const row of listed.items || []) {
        const model = String(row.id || '').trim();
        if (!model) continue;
        const observed = buildObservedInfo(lookupObserved(history.observed, harnessId, model));
        const gate = classifyFavoriteRowGate({
          role,
          harness,
          harnessId,
          model,
          row,
          listed,
          profiles,
          callerExcludeModels,
          historyHardExcludeModels,
          softExcludeModels,
          applySoftExcludes,
          hardExcludeHarnesses,
          hardExcludePairs,
          history,
          now,
          checkReviewAdapter,
          usageLimits: input.usageLimits,
          workspaceFolder: input.workspaceFolder,
          planWindowConfig: input.planWindowConfig,
          relaxPlanWindow,
        });
        if (!gate.ok) {
          bumpFavoriteFilterStat(stats, gate.code);
          continue;
        }
        const decoded = decodeModelValue(model);
        const costTier = Number.isFinite(row.cost_tier)
          ? Number(row.cost_tier)
          : estimateModelCostTier(decoded.modelId, decoded.params);
        const qualityTier = Number.isFinite(row.quality_tier)
          ? Number(row.quality_tier)
          : estimateModelQualityTier(decoded.modelId, decoded.params);
        const speedTier = Number.isFinite(row.speed_tier)
          ? Number(row.speed_tier)
          : estimateModelSpeedTier(decoded.modelId, decoded.params);
        const score = computeModelPickScore({
          costTier,
          qualityTier,
          speedTier,
          weights: roleWeights,
        });
        /** @type {ModelPickCandidate} */
        const candidate = {
          harness: harnessId,
          model,
          label: String(row.label || model),
          provider: resolveModelProviderId(decoded.modelId, row.label),
          cost_tier: costTier,
          quality_tier: qualityTier,
          speed_tier: speedTier,
          priority: resolveMatcherPriority(model, matchers),
          score,
          rotation_score: score,
          weights: { ...roleWeights },
          in_band: false,
          cold_start: false,
          plan_limit_penalty: 0,
          plan_headroom_level: PLAN_HEADROOM_LEVEL_NEUTRAL,
          chat_uses: 0,
          role_uses_7d: 0,
          model_uses_7d: 0,
          last_used_at: '',
          keep_winner: false,
          reason: '',
          heuristic_score: score,
          prior_infra: 0,
          traits: resolveCandidateTraits(harnessId, history),
          observed,
          observed_applied: false,
          observed_penalty: 0,
          observed_changed: false,
          rating_applied: false,
          high_infra_risk: false,
          low_completion_risk: false,
        };
        applyObservedOutcome(
          candidate,
          roleWeights,
          adaptive,
          { ...history.prior, role },
          /** @type {ModelPickRole} */ (role),
          resolvedAdaptiveConfig,
        );
        candidate.high_infra_risk = isHighInfraRiskObserved(candidate.observed);
        candidate.low_completion_risk = (role === 'implement' || role === 'fix')
          && isLowCompletionRiskObserved(
            candidate.observed,
            resolvedAdaptiveConfig.completionMinRate,
            resolvedAdaptiveConfig.completionMinN,
          );
        out.push(candidate);
      }
    }
    return { ranked: out, stats };
  };

  const initial = collect(historySoftExcludeModels, true);
  let ranked = initial.ranked;
  let stats = initial.stats;
  let historyExcludeRelaxed = false;
  if (ranked.length === 0 && historySoftExcludeModels.length > 0) {
    const relaxed = collect([], false);
    if (relaxed.ranked.length > 0) {
      ranked = relaxed.ranked;
      stats = relaxed.stats;
      historyExcludeRelaxed = true;
    }
  }
  // D4: relax the hard weekly-window gate only when it is what emptied the
  // pool (after the history soft excludes), so the pick matches today's.
  let planWindowRelaxed = false;
  if (ranked.length === 0 && (initial.stats.planWindowExhausted > 0 || stats.planWindowExhausted > 0)) {
    let relaxedPool = collect(historySoftExcludeModels, true, true);
    let relaxedHistory = false;
    if (relaxedPool.ranked.length === 0 && historySoftExcludeModels.length > 0) {
      relaxedPool = collect([], false, true);
      relaxedHistory = relaxedPool.ranked.length > 0;
    }
    if (relaxedPool.ranked.length > 0) {
      ranked = relaxedPool.ranked;
      stats = relaxedPool.stats;
      planWindowRelaxed = true;
      historyExcludeRelaxed = relaxedHistory;
    }
  }
  if (ranked.length === 0) {
    return withPickTelemetry({
      ok: false,
      code: 'MODEL_UNAVAILABLE',
      error: unavailableModelError(role, stats),
      rotation: { history_exclude_relaxed: historyExcludeRelaxed },
    });
  }
  // Reviewer pool (opt-in, `preferModels`): the caller resolved the pool from
  // settings; the picker never reads settings. Hard excludes were applied in
  // `collect`, so a pool member that is the implementer (or caller-excluded)
  // can never survive. Survivors replace the ranked set; a missing member is
  // replaced by the normal pick below and the pool is marked degraded.
  const poolMembers = normalizePreferModels(input.preferModels);
  /** @type {ModelPickCandidate[]} */
  let poolReplacements = [];
  /** @type {ModelPickCandidate[] | null} */
  let replacementSource = null;
  /** @type {{ members: number, honoured: number, degraded: boolean, missing: string[] } | null} */
  let poolInfo = null;
  if (poolMembers.length > 0) {
    let survivors = ranked.filter((candidate) => isPoolMember(candidate, poolMembers));
    // The last reviewer is only a soft exclude; a stable pool must be able to
    // reuse it, so retry without soft excludes before declaring a member lost.
    if (survivors.length < poolMembers.length && historySoftExcludeModels.length > 0 && !historyExcludeRelaxed) {
      const relaxedPool = collect([], false, planWindowRelaxed);
      const relaxedSurvivors = relaxedPool.ranked.filter((candidate) => isPoolMember(candidate, poolMembers));
      if (relaxedSurvivors.length > survivors.length) {
        survivors = relaxedSurvivors;
        replacementSource = relaxedPool.ranked;
      }
    }
    const missing = poolMembers
      .filter((member) => !survivors.some((candidate) => isPoolMember(candidate, [member])))
      .map((member) => `${member.harness}/${member.model}`);
    poolInfo = {
      members: poolMembers.length,
      honoured: survivors.length,
      degraded: missing.length > 0,
      missing,
    };
    if (survivors.length > 0) {
      const source = replacementSource || ranked;
      poolReplacements = source
        .filter((candidate) => !isPoolMember(candidate, poolMembers))
        .sort((left, right) => compareModelPickCandidates(/** @type {ModelPickRole} */ (role), left, right))
        .slice(0, missing.length);
      ranked = survivors;
    }
  }
  /**
   * Append the normal-pick replacement for a lost pool member (only when the
   * caller asked for enough picks to cover it).
   *
   * @param {ModelPickCandidate[]} picks
   * @returns {ModelPickCandidate[]}
   */
  const withPoolReplacements = (picks) => {
    if (poolReplacements.length === 0 || picks.length >= count) return picks;
    const extra = poolReplacements.slice(0, count - picks.length);
    for (const candidate of extra) {
      candidate.reason = `pool member replaced (pool degraded: ${poolInfo?.missing.join(', ')}); `
        + `${candidateReason(candidate, history, false, { review: role === 'review', pickRole: role })}`;
    }
    return [...picks, ...extra];
  };
  const relaxedNote = `${historyExcludeRelaxed ? ' history exclude relaxed' : ''}${planWindowRelaxed ? ` ${PLAN_WINDOW_RELAXED_NOTE}` : ''}`;

  // Used by the band tie-break and the premium-review reason in both the
  // `rotation: off` and band paths, so it is declared before both.
  const preferReviewTests = role === 'review';
  // `rotation: off` is the documented escape hatch: pure score, deterministic.
  if (rotation.mode === 'off') {
    ranked.sort((left, right) => compareModelPickCandidates(
      /** @type {ModelPickRole} */ (role),
      left,
      right,
    ));
    for (const candidate of ranked) {
      candidate.reason = candidateReason(candidate, history, false, { review: role === 'review', pickRole: role });
      candidate.chat_uses = chatUseCount(candidate, history, role);
      candidate.keep_winner = candidate.chat_uses === -1 || candidate.chat_uses === -2;
      candidate.role_uses_7d = toUsageCount(history.harnessUses7d[harnessKey(candidate)]);
      candidate.model_uses_7d = toUsageCount(history.modelUses7d[candidateModelKey(candidate)]);
      candidate.last_used_at = String(
        history.lastUsedAt[candidateModelKey(candidate)] || history.lastUsedAt[harnessKey(candidate)] || '',
      );
    }
    ranked[0].reason += relaxedNote;
    if (preferReviewTests && Number(ranked[0].cost_tier) >= PREMIUM_REVIEW_COST_TIER) {
      ranked[0].reason += `; premium cost tier ${ranked[0].cost_tier} review pick (reserve for exceptional cases; justify in pick_reason)`;
    }
    const picks = withPoolReplacements(selectDiversePicks(ranked, count, diverse));
    const measuredSafetyAllowed = input.allowHighInfra === true && input.allowLowCompletion === true;
    const offCandidates = measuredSafetyAllowed
      ? ranked
      : [
        ...ranked.filter((candidate) => {
          if (candidate === picks[0]) return true;
          if (candidate.high_infra_risk && input.allowHighInfra !== true) return false;
          if (candidate.low_completion_risk && input.allowLowCompletion !== true) return false;
          return true;
        }),
        ...ranked.filter((candidate) => {
          if (candidate === picks[0]) return false;
          if (candidate.high_infra_risk && input.allowHighInfra !== true) return true;
          if (candidate.low_completion_risk && input.allowLowCompletion !== true) return true;
          return false;
        }),
      ];
    const inBandKeys = new Set(ranked.map((candidate) => candidateModelKey(candidate)));
    return withPickTelemetry({
      ok: true,
      pick: picks[0],
      picks,
      candidates: offCandidates.slice(0, 8),
      inBandKeys,
      exploration: runExploration(ranked, picks[0], { rotationOff: true }),
      rotation: {
        band: rotation.band,
        mode: rotation.mode,
        explore_turn: false,
        history_exclude_relaxed: historyExcludeRelaxed,
        ...(planWindowRelaxed ? { plan_window_relaxed: true } : {}),
        count,
        diverse,
        ...(poolInfo ? { pool: poolInfo } : {}),
      },
    });
  }

  for (const candidate of ranked) {
    candidate.cold_start = history.coldStartHarnesses.has(candidate.harness.toLowerCase());
    const forecastPenalty = Math.max(
      planLimitPenalty(history.planLimits, candidate.harness, now, candidate.model, input.planWindowConfig),
      hasFreshLimitHit(history, candidate.harness, candidate.model) ? PLAN_LIMIT_PENALTY : 0,
    );
    // Weekly pace: above pace (-1) the penalty scales with the model cost tier.
    // It is max-ed with the forecast penalty (never summed) and stays capped.
    const pace = buildPlanPaceSignal({
      planLimits: history.planLimits,
      harnessId: candidate.harness,
      modelId: candidate.model,
      now,
      config: input.planWindowConfig,
    });
    const costFactor = paceCostFactor(candidate.cost_tier);
    const pacePenalty = pace.level === -1 ? Math.min(PLAN_LIMIT_PENALTY_MAX, PLAN_PACE_PENALTY * costFactor) : 0;
    candidate.plan_limit_penalty = Math.max(forecastPenalty, pacePenalty);
    // Within-band tie-break only (`compareWithinBand`); never part of the score,
    // so it cannot widen or shift the band.
    candidate.plan_headroom_level = planHeadroomLevel({
      planLimits: history.planLimits,
      harnessId: candidate.harness,
      modelId: candidate.model,
      now,
      config: input.planWindowConfig,
    });
    // A wasted-reserve bonus is void when a penalty, a limit hit or 5h headroom 0 applies.
    candidate.plan_pace_level = pace.level === 1
      && (forecastPenalty > 0 || candidate.plan_headroom_level === PLAN_HEADROOM_LEVEL_SPARE)
      ? 0
      : pace.level;
    if (pace.level === -1) candidate.pace_cost_factor = costFactor;
    candidate.rotation_score = candidate.score - candidate.plan_limit_penalty;
  }
  const exploreEnabled = input.explore !== false;
  // Cold start is a rotation signal for the working roles only: a planner pick
  // is quality-driven, so `plan` never explores.
  const exploreRole = role === 'implement' || role === 'fix' || role === 'review';
  const exploreTurn = exploreEnabled && exploreRole
    && (rotation.mode === 'explore' || (history.pickIndex % COLD_START_EVERY) === 0);
  const noExploreBest = Math.max(...ranked.map((candidate) => candidate.score - candidate.plan_limit_penalty));
  if (exploreTurn) {
    for (const candidate of ranked) {
      if (candidate.cold_start) candidate.rotation_score += COLD_START_BONUS;
    }
  }

  // Tie band around the best score. A proven winner (`keep_winner`: the last
  // implement->review cycle of this model in the chat PASSed) stays in the band
  // while it is within two bands of the best score, so an observed infra
  // penalty cannot silently rotate away a model the chat already validated.
  /**
   * @param {(candidate: ModelPickCandidate) => number} scoreOf
   * @returns {ModelPickCandidate[]}
   */
  const bandOf = (scoreOf) => {
    const bestScore = Math.max(...ranked.map(scoreOf));
    const strict = bestScore - rotation.band;
    const relaxed = bestScore - (2 * rotation.band);
    return ranked
      .filter((candidate) => {
        const value = scoreOf(candidate);
        if (value >= strict - 1e-9) return true;
        const uses = chatUseCount(candidate, history, role);
        return (uses === -1 || uses === -2) && value >= relaxed - 1e-9;
      })
      .sort((left, right) => compareWithinBand(left, right, history, preferReviewTests, role));
  };

  // Start-gate ordering (not a scoring change): measured high-infra or low-
  // completion pairs must not win the band while a safer alternative is in it,
  // unless the caller passed an explicit exception. Proven keep-winner / sticky
  // leaf executors are spared so documented chat/leaf continuity is preserved.
  const highInfraAllowed = input.allowHighInfra === true;
  const lowCompletionAllowed = input.allowLowCompletion === true;
  /** @param {ModelPickCandidate[]} band @returns {ModelPickCandidate[]} */
  const orderByMeasuredSafety = (band) => {
    if (highInfraAllowed && lowCompletionAllowed) return band;
    const proven = (candidate) => {
      const uses = chatUseCount(candidate, history, role);
      return uses === -1 || uses === -2;
    };
    const safe = (candidate) => {
      if (candidate.high_infra_risk && !highInfraAllowed && !proven(candidate)) return false;
      if (candidate.low_completion_risk && !lowCompletionAllowed && !proven(candidate)) return false;
      return true;
    };
    return [...band.filter(safe), ...band.filter((candidate) => !safe(candidate))];
  };
  const rawInBand = bandOf((candidate) => candidate.rotation_score);
  const inBand = orderByMeasuredSafety(rawInBand);
  const pick = inBand[0];
  const infraGateChangedPick = inBand[0] !== rawInBand[0];
  for (const candidate of inBand) candidate.in_band = true;
  // Which candidate would have won without the explore bonus? Used only to
  // explain the decision, so a fresh array keeps `ranked` intact.
  const noExplorePick = ranked
    .filter((candidate) => candidate.score - candidate.plan_limit_penalty >= noExploreBest - rotation.band - 1e-9)
    .sort((left, right) => compareWithinBand(left, right, history, preferReviewTests, role))[0];

  // Without observed data every candidate keeps its heuristic score, so the
  // heuristic band reproduces `inBand` exactly. When the observed blend/penalty
  // promoted a different winner, the pick names the pre-observed leader and its
  // observed stats — that is the case the reason must explain. Both bands use
  // the same keep-winner expansion so it is never mistaken for an observed
  // effect.
  const heuristicRotationScore = (candidate) => candidate.heuristic_score - candidate.plan_limit_penalty
    + (exploreTurn && candidate.cold_start ? COLD_START_BONUS : 0);
  const heuristicPick = orderByMeasuredSafety(bandOf(heuristicRotationScore))[0];
  pick.observed_changed = heuristicPick !== pick;

  const pickUses = toUsageCount(history.harnessUses7d[harnessKey(pick)]);
  const pickChatUses = chatUseCount(pick, history, role);
  const decision = decisiveBandReason(pick, inBand, history, noExplorePick, exploreTurn, preferReviewTests, role);
  pick.reason = `${rotation.mode} band=${rotation.band} ${inBand.length} candidate`
    + `${inBand.length === 1 ? '' : 's'}; `
    + `${decision} (role_uses_7d=${pickUses}, chat_uses=${pickChatUses})`
    + relaxedNote;
  if (adaptive && pick.observed_changed) {
    const observedBits = describeObserved(heuristicPick.observed) || describeObserved(pick.observed);
    pick.reason += `; observed changed ranking; pre-observed leader ${heuristicPick.harness}/${heuristicPick.model}`
      + `${observedBits ? ` (${observedBits})` : ''}`;
  } else if (adaptive && pick.observed_applied) {
    const parts = observedReasonParts(pick);
    if (parts.length > 0) pick.reason += `; ${parts.join(' ')}`;
  }
  if (infraGateChangedPick) {
    pick.reason += '; measured-risk band leader demoted (allow_high_infra / allow_low_completion to override)';
  }

  // Candidate order mirrors the real selection: the rotation-ordered tie band
  // first, then the rest by score. Within the band, position 1 prefers a
  // different harness so the documented infra fallback also changes provider
  // whenever a different harness is available.
  const inBandRest = inBand.filter((candidate) => candidate !== pick);
  const otherHarness = inBandRest.filter((candidate) => harnessKey(candidate) !== harnessKey(pick));
  const sameHarness = inBandRest.filter((candidate) => harnessKey(candidate) === harnessKey(pick));
  const outOfBand = ranked
    .filter((candidate) => !candidate.in_band)
    .sort((left, right) => compareModelPickCandidates(
      /** @type {ModelPickRole} */ (role),
      left,
      right,
    ));
  /** @type {ModelPickCandidate[]} */
  const ordered = [pick, ...otherHarness, ...sameHarness, ...outOfBand];
  for (const candidate of ordered) {
    if (!candidate.reason) {
      candidate.reason = candidateReason(candidate, history, candidate.in_band, { review: preferReviewTests, pickRole: role });
    }
    candidate.chat_uses = chatUseCount(candidate, history, role);
    candidate.keep_winner = candidate.chat_uses === -1 || candidate.chat_uses === -2;
    candidate.role_uses_7d = toUsageCount(history.harnessUses7d[harnessKey(candidate)]);
    candidate.model_uses_7d = toUsageCount(history.modelUses7d[candidateModelKey(candidate)]);
    candidate.last_used_at = String(
      history.lastUsedAt[candidateModelKey(candidate)] || history.lastUsedAt[harnessKey(candidate)] || '',
    );
  }
  // Out-of-band exploration runs on the picker's own surviving set, so Settings
  // favorites, `exclude_model`/`exclude_harness`, availability, active lockouts,
  // the flash rule and the review-adapter guarantee are all applied before an
  // explore pair is ever considered. `dry-run` (the shipped default) reports
  // `would-explore` and leaves the selection untouched; only a deliberate
  // `mode: 'real'` config hands the job to the out-of-band pair, and never to a
  // chat's proven winner.
  let selected = pick;
  if (exploreRequested) {
    exploration = runExploration(ordered, pick, {});
    if (exploration?.started && exploration.candidate && pick.keep_winner !== true) {
      const chosen = /** @type {ModelPickCandidate} */ (exploration.candidate);
      chosen.explore_out_of_band = true;
      chosen.reason = `out-of-band explore; band winner ${pick.harness}/${pick.model}; ${chosen.reason || ''}`.trim();
      selected = chosen;
    }
  }
  // Weekly pace snapshot at pick time: the decision's own `now` and
  // `history.planLimits`, with the same +1 zeroing the picker applied to
  // `plan_pace_level`. Stored on the pick (and persisted on the model_pick
  // proposal) so the delegation card shows the snapshot the pick actually
  // used, never a re-read taken at start time.
  const selectedPaceSnapshot = buildPlanPaceSnapshot({
    planLimits: history.planLimits,
    harnessId: selected.harness,
    modelId: selected.model,
    now,
    config: input.planWindowConfig,
    costTier: selected.cost_tier,
  });
  if (selectedPaceSnapshot) {
    const zeroedLevel = Number(selected.plan_pace_level);
    if (Number.isFinite(zeroedLevel)) selectedPaceSnapshot.level = zeroedLevel;
    selected.planPace = selectedPaceSnapshot;
  }
  const selectedOrdered = selected === pick
    ? ordered
    : [selected, ...ordered.filter((candidate) => candidate !== selected)];
  // A high-infra pair is kept as a candidate (its score already carries the
  // penalty) but is demoted below every measured-safe alternative unless the
  // caller passes the explicit `allowHighInfra` exception. This is an ordering
  // gate, not a scoring change, so "not in the top-2 candidates" holds without
  // touching role weights or the rotation band.
  const demoteMeasuredRisk = input.allowHighInfra !== true || input.allowLowCompletion !== true;
  const candidatesOrdered = demoteMeasuredRisk
    ? [
      ...selectedOrdered.filter((candidate) => {
        if (candidate === selected) return true;
        if (candidate.high_infra_risk && input.allowHighInfra !== true) return false;
        if (candidate.low_completion_risk && input.allowLowCompletion !== true) return false;
        return true;
      }),
      ...selectedOrdered.filter((candidate) => {
        if (candidate === selected) return false;
        if (candidate.high_infra_risk && input.allowHighInfra !== true) return true;
        if (candidate.low_completion_risk && input.allowLowCompletion !== true) return true;
        return false;
      }),
    ]
    : selectedOrdered;
  // Name the premium tier on a review pick: the highest relative cost tiers are
  // reserved for exceptional cases, so the reason must say the pick is premium
  // and that the start owes an explicit justification.
  if (preferReviewTests && Number(selected.cost_tier) >= PREMIUM_REVIEW_COST_TIER) {
    selected.reason += `; premium cost tier ${selected.cost_tier} review pick (reserve for exceptional cases; justify in pick_reason)`;
  }
  const picks = withPoolReplacements(selectDiversePicks(selectedOrdered, count, diverse));
  const inBandKeys = new Set(inBand.map((candidate) => candidateModelKey(candidate)));
  return withPickTelemetry({
    ok: true,
    pick: selected,
    picks,
    candidates: candidatesOrdered.slice(0, 8),
    inBandKeys,
    exploration,
    // Same snapshot as `selected.planPace`, exposed at the top level so a
    // caller can persist it without reaching into the candidate.
    planPace: selected.planPace ?? null,
    rotation: {
      band: rotation.band,
      mode: rotation.mode,
      explore_turn: exploreTurn,
      out_of_band_explore: selected !== pick,
      history_exclude_relaxed: historyExcludeRelaxed,
      ...(planWindowRelaxed ? { plan_window_relaxed: true } : {}),
      count,
      diverse,
      ...(poolInfo ? { pool: poolInfo } : {}),
    },
  });
}
