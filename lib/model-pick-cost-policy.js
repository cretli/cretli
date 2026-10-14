/**
 * Cost ceiling, model policy and quality/effort floors for `model_pick`
 * (plan v10 §2.3, §2.4, §2.7).
 *
 * The module is a layer around the ranking, not a second ranker: it judges the
 * candidates the picker already produced and, in `enforce`, re-runs the picker
 * with the rejected pairs excluded. The default mode is `shadow`: the verdict
 * and the counterfactual are recorded, the selection is untouched.
 *
 * Stored records carry closed-list reason codes and ids only, never free text.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { decodeModelValue } from './model-catalog.js';
import { normalizeEffortParam } from './model-effort.js';
import { isFlashDelegationModel } from './model-pick-gate-primitives.js';
import { resolveDataPath } from './runtime-paths.js';
import { writeJsonAtomic } from './persist/atomic-write.js';

export const COMPLEXITY_POLICY_MODES = Object.freeze(['off', 'shadow', 'enforce']);
export const MODEL_POLICIES = Object.freeze(['auto', 'heavy_only', 'manual_only']);
export const AUTO_PREMIUM_MODES = Object.freeze(['heavy_only', 'never']);

/** Closed list of reasons a candidate can be rejected by the policy. */
export const COST_POLICY_REASONS = Object.freeze([
  'cost_ceiling',
  'tier5_not_allowed',
  'model_policy_manual_only',
  'model_policy_heavy_only',
  'quality_floor',
  'flash_not_allowed',
  'effort_floor',
  'infra_fail_ceiling',
]);

export const PREMIUM_COST_TIER = 5;

/** Default ceilings per (role, level); tier 5 additionally needs `premium`. */
export const DEFAULT_COST_CEILINGS = Object.freeze({
  implement: Object.freeze({ trivial: 2, standard: 3, demanding: 4 }),
  fix: Object.freeze({ trivial: 2, standard: 3, demanding: 4 }),
  review: Object.freeze({ trivial: 4, standard: 4, demanding: 4 }),
  plan: Object.freeze({ trivial: 4, standard: 4, demanding: 4 }),
});

/** Minimum quality tier per level; review/plan are lifted to 4 separately. */
export const DEFAULT_QUALITY_FLOOR = Object.freeze({ trivial: 1, standard: 3, demanding: 4 });

/** Infra-fail ceiling per role; review is stricter (plan §2.4). */
export const DEFAULT_INFRA_FAIL_CEILING = Object.freeze({
  default: 0.5, implement: 0.5, fix: 0.5, plan: 0.5, review: 0.35,
});
export const DEFAULT_INFRA_MIN_N = 3;

export const DEFAULT_CANARY = Object.freeze({
  enabled: true,
  percent: 20,
  days: 7,
  // Rollback criteria (plan §2.7).
  failReviewIncreasePp: 10,
  noCandidateIncreasePct: 5,
  noCandidateReviewIncreasePct: 2,
  infraFailMaxIncreasePp: 10,
  minSamples: 10,
});

const LEVELS = Object.freeze(['trivial', 'standard', 'demanding']);
const ROLES = Object.freeze(['plan', 'implement', 'review', 'fix']);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   mode: 'off' | 'shadow' | 'enforce',
 *   ceilings: Record<string, Record<string, number>>,
 *   qualityFloor: Record<string, number>,
 *   autoPremium: 'heavy_only' | 'never',
 *   modelPolicy: { default: string, models: Record<string, string> },
 *   effortFloorMin: string,
 *   infraFailCeiling: Record<string, number>,
 *   infraMinN: number,
 *   canary: typeof DEFAULT_CANARY,
 * }} CostPolicyConfig
 */

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number | null}
 */
function boundedNumber(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * Merge an operator `complexityPolicy` block over the defaults. Invalid values
 * are ignored, so a typo can neither disable a ceiling nor raise it silently.
 *
 * @param {unknown} [raw]
 * @returns {CostPolicyConfig}
 */
export function normalizeCostPolicyConfig(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const mode = String(src.mode || '').trim().toLowerCase();
  /** @type {CostPolicyConfig} */
  const out = {
    // Shadow is the default: no behavior change until an operator opts in.
    mode: /** @type {any} */ (COMPLEXITY_POLICY_MODES.includes(mode) ? mode : 'shadow'),
    ceilings: {},
    qualityFloor: { ...DEFAULT_QUALITY_FLOOR },
    autoPremium: 'heavy_only',
    modelPolicy: { default: 'auto', models: {} },
    effortFloorMin: 'medium',
    infraFailCeiling: { ...DEFAULT_INFRA_FAIL_CEILING },
    infraMinN: DEFAULT_INFRA_MIN_N,
    canary: { ...DEFAULT_CANARY },
  };
  const ceilings = src.ceilings && typeof src.ceilings === 'object' ? src.ceilings : {};
  for (const role of ROLES) {
    out.ceilings[role] = { ...DEFAULT_COST_CEILINGS[role] };
    for (const level of LEVELS) {
      const n = boundedNumber(ceilings[role]?.[level], 1, 4);
      // Tier 5 is never a ceiling: it is a separate, explicit grant.
      if (n != null) out.ceilings[role][level] = Math.floor(n);
    }
  }
  const floors = src.qualityFloor && typeof src.qualityFloor === 'object' ? src.qualityFloor : {};
  for (const level of LEVELS) {
    const n = boundedNumber(floors[level], 1, 5);
    if (n != null) out.qualityFloor[level] = Math.floor(n);
  }
  const autoPremium = String(src.autoPremium || '').trim().toLowerCase();
  if (AUTO_PREMIUM_MODES.includes(autoPremium)) out.autoPremium = /** @type {any} */ (autoPremium);
  const mp = src.modelPolicy && typeof src.modelPolicy === 'object' ? src.modelPolicy : {};
  const def = String(mp.default || '').trim().toLowerCase();
  if (MODEL_POLICIES.includes(def)) out.modelPolicy.default = def;
  const models = mp.models && typeof mp.models === 'object' ? mp.models : {};
  for (const [key, value] of Object.entries(models)) {
    const policy = String(value || '').trim().toLowerCase();
    const id = String(key || '').trim().toLowerCase();
    if (id && MODEL_POLICIES.includes(policy)) out.modelPolicy.models[id] = policy;
  }
  const effortMin = String(src.effortFloorMin || '').trim().toLowerCase();
  if (['low', 'medium', 'high'].includes(effortMin)) out.effortFloorMin = effortMin;
  const infra = src.infraFailCeiling && typeof src.infraFailCeiling === 'object' ? src.infraFailCeiling : {};
  for (const key of Object.keys(out.infraFailCeiling)) {
    const n = boundedNumber(infra[key], 0.01, 1);
    if (n != null) out.infraFailCeiling[key] = n;
  }
  const minN = boundedNumber(src.infraMinN, 1, 1000);
  if (minN != null) out.infraMinN = Math.floor(minN);
  const canary = src.canary && typeof src.canary === 'object' ? src.canary : {};
  if (typeof canary.enabled === 'boolean') out.canary.enabled = canary.enabled;
  for (const [key, min, max] of [
    ['percent', 1, 100], ['days', 1, 90], ['failReviewIncreasePp', 0, 100],
    ['noCandidateIncreasePct', 0, 100], ['noCandidateReviewIncreasePct', 0, 100],
    ['infraFailMaxIncreasePp', 0, 100], ['minSamples', 1, 10000],
  ]) {
    const n = boundedNumber(canary[/** @type {string} */ (key)], /** @type {number} */ (min), /** @type {number} */ (max));
    if (n != null) /** @type {any} */ (out.canary)[/** @type {string} */ (key)] = n;
  }
  return out;
}

/**
 * @param {{ filePath?: string }} [input]
 * @returns {CostPolicyConfig}
 */
export function loadCostPolicyConfig(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeCostPolicyConfig(doc?.complexityPolicy);
  } catch {
    return normalizeCostPolicyConfig(null);
  }
}

/**
 * Policy for one model: exact stored value, then base model id, then default.
 *
 * @param {CostPolicyConfig} config
 * @param {string} model
 * @returns {string}
 */
export function resolveModelPolicy(config, model) {
  const full = String(model || '').trim().toLowerCase();
  const base = String(decodeModelValue(model).modelId || '').trim().toLowerCase();
  return config.modelPolicy.models[full] || config.modelPolicy.models[base] || config.modelPolicy.default;
}

const EFFORT_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 });

/**
 * Judge one candidate. `qualityRelax` lowers the quality floor by that many
 * tiers; it is only ever set by {@link applyCostPolicyToPick}.
 *
 * @param {{
 *   candidate: any,
 *   role: string,
 *   level: string,
 *   heavy?: boolean,
 *   premium?: boolean,
 *   config: CostPolicyConfig,
 *   qualityRelax?: number,
 * }} input
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
export function evaluateCandidatePolicy(input) {
  const { candidate, config } = input;
  const role = String(input.role || '').trim().toLowerCase();
  const level = LEVELS.includes(input.level) ? input.level : 'standard';
  const heavy = input.heavy === true;
  const premium = input.premium === true;
  const reviewLike = role === 'review' || role === 'plan';
  const model = String(candidate?.model || '');
  const costTier = Number(candidate?.cost_tier);
  const qualityTier = Number(candidate?.quality_tier);
  /** @type {Set<string>} */
  const reasons = new Set();

  if (Number.isFinite(costTier)) {
    if (costTier >= PREMIUM_COST_TIER) {
      const granted = level === 'demanding'
        && (premium || (heavy && config.autoPremium === 'heavy_only'));
      if (!granted) reasons.add('tier5_not_allowed');
    } else {
      const ceiling = config.ceilings[role]?.[level] ?? DEFAULT_COST_CEILINGS.implement[level];
      if (costTier > ceiling) reasons.add('cost_ceiling');
    }
  }

  const policy = resolveModelPolicy(config, model);
  if (policy === 'manual_only') reasons.add('model_policy_manual_only');
  else if (policy === 'heavy_only' && !heavy && !premium) reasons.add('model_policy_heavy_only');

  let floor = config.qualityFloor[level] ?? 1;
  if (reviewLike) floor = Math.max(floor, 4);
  floor = Math.max(1, floor - Math.max(0, Math.floor(Number(input.qualityRelax) || 0)));
  if (Number.isFinite(qualityTier) && qualityTier < floor) reasons.add('quality_floor');

  if ((reviewLike || level === 'demanding') && isFlashDelegationModel(model)) {
    reasons.add('flash_not_allowed');
  }

  if (reviewLike || level === 'demanding') {
    const effort = normalizeEffortParam(decodeModelValue(model).params);
    // Models without an effort parameter do not pass through this rule.
    if (effort.level !== 'none' && EFFORT_RANK[effort.level] < EFFORT_RANK[config.effortFloorMin]) {
      reasons.add('effort_floor');
    }
  }

  const ceiling = config.infraFailCeiling[role] ?? config.infraFailCeiling.default;
  const observed = candidate?.observed;
  if (observed && typeof observed === 'object') {
    const n = Number(observed.n);
    const rate = Number(observed.infra_fail_rate);
    if (Number.isFinite(n) && n >= config.infraMinN && Number.isFinite(rate) && rate > ceiling) {
      reasons.add('infra_fail_ceiling');
    }
  }
  return { allowed: reasons.size === 0, reasons: COST_POLICY_REASONS.filter((code) => reasons.has(code)) };
}

/**
 * @param {any} row
 * @returns {string}
 */
function pairKey(row) {
  return `${String(row?.harness || '').trim().toLowerCase()}/${String(row?.model || '').trim()}`;
}

/**
 * Judge every row the picker exposed (picks + candidates), de-duplicated.
 *
 * @param {any} picked
 * @param {object} ctx
 * @returns {{ rejected: Map<string, { harness: string, model: string, reasons: string[] }>, accepted: any[] }}
 */
function judgePicked(picked, ctx) {
  const seen = new Set();
  const rows = [
    ...(Array.isArray(picked.picks) ? picked.picks : picked.pick ? [picked.pick] : []),
    ...(Array.isArray(picked.candidates) ? picked.candidates : []),
  ];
  const rejected = new Map();
  const accepted = [];
  for (const row of rows) {
    const key = pairKey(row);
    if (!row || seen.has(key)) continue;
    seen.add(key);
    const verdict = evaluateCandidatePolicy({ ...ctx, candidate: row });
    if (verdict.allowed) accepted.push(row);
    else rejected.set(key, { harness: String(row.harness), model: String(row.model), reasons: verdict.reasons });
  }
  return { rejected, accepted };
}

/**
 * Re-run the picker with rejected pairs excluded until the pick passes or the
 * picker has nothing left. Never raises the ceiling and never selects a
 * rejected pair; an empty pool becomes `MODEL_UNAVAILABLE` / `cost_ceiling`.
 *
 * @param {{
 *   select: (input: object) => any,
 *   selectInput: object,
 *   picked: any,
 *   role: string,
 *   level: string,
 *   heavy?: boolean,
 *   premium?: boolean,
 *   config: CostPolicyConfig,
 *   maxRounds?: number,
 * }} input
 * @returns {{ result: any, rejected: object[], qualityRelaxed: boolean, rounds: number }}
 */
export function applyCostPolicyToPick(input) {
  const role = String(input.role || '').trim().toLowerCase();
  const relaxable = (role === 'implement' || role === 'fix') && input.level !== 'demanding';
  const attempt = (qualityRelax) => {
    const ctx = { role, level: input.level, heavy: input.heavy, premium: input.premium, config: input.config, qualityRelax };
    const excludePairs = [];
    const rejectedAll = new Map();
    let current = input.picked;
    const maxRounds = Math.max(1, Math.floor(Number(input.maxRounds) || 8));
    for (let round = 1; round <= maxRounds; round += 1) {
      if (!current?.ok) return { current, rejectedAll, round, empty: true };
      const { rejected } = judgePicked(current, ctx);
      for (const [key, row] of rejected) rejectedAll.set(key, row);
      const picksOk = (Array.isArray(current.picks) && current.picks.length ? current.picks : [current.pick])
        .every((row) => !rejected.has(pairKey(row)));
      if (picksOk) return { current, rejectedAll, round, empty: false };
      for (const row of rejected.values()) excludePairs.push({ harness: row.harness, model: row.model });
      current = input.select({
        ...input.selectInput,
        excludePairs: [...(Array.isArray(input.selectInput.excludePairs) ? input.selectInput.excludePairs : []), ...excludePairs],
      });
    }
    return { current: { ok: false, code: 'MODEL_UNAVAILABLE' }, rejectedAll, round: maxRounds, empty: true };
  };
  let outcome = attempt(0);
  let qualityRelaxed = false;
  if (outcome.empty && relaxable) {
    const onlyQuality = [...outcome.rejectedAll.values()].length > 0
      && [...outcome.rejectedAll.values()].every((row) => row.reasons.includes('quality_floor'));
    if (onlyQuality) {
      const relaxed = attempt(1);
      if (!relaxed.empty) {
        outcome = relaxed;
        qualityRelaxed = true;
      }
    }
  }
  const rejected = [...outcome.rejectedAll.values()].slice(0, 12);
  if (outcome.empty) {
    return {
      result: {
        ok: false,
        code: 'MODEL_UNAVAILABLE',
        reason: 'cost_ceiling',
        error: 'No candidate satisfies the cost ceiling, model policy and quality floors for this role and complexity level. '
          + 'Raise the level with premium=true (demanding tasks only) or change the favorite models.',
        cost_policy: { rejected, premium_hint: 'premium:true' },
      },
      rejected,
      qualityRelaxed,
      rounds: outcome.round,
    };
  }
  return { result: outcome.current, rejected, qualityRelaxed, rounds: outcome.round };
}

/**
 * Deterministic bucket 0..99 for a pick key.
 *
 * @param {string} key
 * @returns {number}
 */
export function canaryBucketOf(key) {
  const digest = crypto.createHash('sha256').update(String(key || '')).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * @param {{ role?: string, level?: string }} input
 * @returns {boolean}
 */
export function isCanaryEligible(input) {
  const role = String(input?.role || '').trim().toLowerCase();
  return (role === 'implement' || role === 'fix')
    && (input?.level === 'trivial' || input?.level === 'standard');
}

/**
 * Compare canary vs control counters against the rollback criteria (§2.7).
 * Each side is `{ n, failReview, noCandidate, infraFail }` (counts).
 *
 * @param {{
 *   canary: { n: number, failReview?: number, noCandidate?: number, infraFail?: number },
 *   control: { n: number, failReview?: number, noCandidate?: number, infraFail?: number },
 *   config?: CostPolicyConfig,
 *   review?: boolean,
 * }} input
 * @returns {{ rollback: boolean, reasons: string[], insufficient: boolean }}
 */
export function evaluateCanaryRollback(input) {
  const cfg = (input.config || normalizeCostPolicyConfig(null)).canary;
  const rate = (side, key) => {
    const n = Number(side?.n) || 0;
    return n > 0 ? (Number(side?.[key]) || 0) / n : 0;
  };
  const canaryN = Number(input.canary?.n) || 0;
  const controlN = Number(input.control?.n) || 0;
  if (canaryN < cfg.minSamples || controlN < cfg.minSamples) {
    return { rollback: false, reasons: [], insufficient: true };
  }
  const reasons = [];
  const pp = (key) => (rate(input.canary, key) - rate(input.control, key)) * 100;
  if (pp('failReview') > cfg.failReviewIncreasePp) reasons.push('fail_review_increase');
  const noCandidateLimit = input.review ? cfg.noCandidateReviewIncreasePct : cfg.noCandidateIncreasePct;
  if (pp('noCandidate') > noCandidateLimit) reasons.push('no_candidate_increase');
  if (pp('infraFail') > cfg.infraFailMaxIncreasePp) reasons.push('infra_fail_increase');
  return { rollback: reasons.length > 0, reasons, insufficient: false };
}

export const COST_POLICY_STATE_FILE = resolveDataPath('model-pick-cost-policy-state.json');

/**
 * Pick-time counters of the canary window (`n`, `noCandidate` per bucket).
 *
 * @param {unknown} raw
 * @returns {{ canary: { n: number, noCandidate: number }, control: { n: number, noCandidate: number } }}
 */
function normalizeCounters(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  const side = (v) => ({
    n: Math.max(0, Math.floor(Number(v?.n)) || 0),
    noCandidate: Math.max(0, Math.floor(Number(v?.noCandidate)) || 0),
  });
  return { canary: side(src.canary), control: side(src.control) };
}

/**
 * @param {{ file?: string }} [input]
 * @returns {{ canaryStartedAt: string, rolledBackAt: string, rollbackReasons: string[], counters: ReturnType<typeof normalizeCounters> }}
 */
export function loadCostPolicyState(input = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(input.file || COST_POLICY_STATE_FILE, 'utf8'));
    return {
      canaryStartedAt: String(raw?.canaryStartedAt || ''),
      rolledBackAt: String(raw?.rolledBackAt || ''),
      rollbackReasons: (Array.isArray(raw?.rollbackReasons) ? raw.rollbackReasons : [])
        .map((r) => String(r)).filter((r) => /^[a-z_]+$/.test(r)).slice(0, 8),
      counters: normalizeCounters(raw?.counters),
    };
  } catch {
    return { canaryStartedAt: '', rolledBackAt: '', rollbackReasons: [], counters: normalizeCounters(null) };
  }
}

/**
 * @param {ReturnType<typeof loadCostPolicyState>} state
 * @param {{ file?: string }} [input]
 */
export function saveCostPolicyState(state, input = {}) {
  writeJsonAtomic(input.file || COST_POLICY_STATE_FILE, state);
}

/**
 * Decide what the policy does for one pick. `off` = nothing; `shadow` =
 * record only; `enforce` = filter, but during the canary window only for the
 * deterministic bucket of eligible picks, with a rolling rollback evaluator.
 *
 * @param {{
 *   config: CostPolicyConfig,
 *   state?: ReturnType<typeof loadCostPolicyState>,
 *   role: string,
 *   level: string,
 *   pickKey?: string,
 *   now?: number,
 *   metrics?: { canary: object, control: object } | null,
 *   persistState?: (state: object) => void,
 * }} input
 * @returns {{ mode: 'off'|'shadow'|'enforce', configured: string, bucket: 'none'|'canary'|'control', phase: string, rollbackReasons: string[] }}
 */
export function resolveEffectivePolicyMode(input) {
  const { config } = input;
  const state = { ...(input.state || loadCostPolicyState()) };
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const base = { configured: config.mode, bucket: /** @type {'none'} */ ('none'), rollbackReasons: [] };
  if (config.mode === 'off') return { ...base, mode: 'off', phase: 'off' };
  if (config.mode === 'shadow') return { ...base, mode: 'shadow', phase: 'shadow' };
  if (state.rolledBackAt) {
    return { ...base, mode: 'shadow', phase: 'rolled_back', rollbackReasons: state.rollbackReasons };
  }
  if (!config.canary.enabled) return { ...base, mode: 'enforce', phase: 'enforce' };
  if (!state.canaryStartedAt) {
    state.canaryStartedAt = new Date(now).toISOString();
    if (typeof input.persistState === 'function') input.persistState(state);
  }
  const startedAt = Date.parse(state.canaryStartedAt);
  if (!Number.isFinite(startedAt)) {
    // Fail-safe: a corrupt start timestamp must never keep enforcing.
    const next = { ...state, rolledBackAt: new Date(now).toISOString(), rollbackReasons: ['invalid_canary_start'] };
    if (typeof input.persistState === 'function') input.persistState(next);
    return { ...base, mode: 'shadow', phase: 'rolled_back', rollbackReasons: ['invalid_canary_start'] };
  }
  const canaryEndsAt = startedAt + config.canary.days * DAY_MS;
  if (now >= canaryEndsAt) return { ...base, mode: 'enforce', phase: 'enforce' };
  if (input.metrics) {
    const verdict = evaluateCanaryRollback({
      canary: /** @type {any} */ (input.metrics.canary),
      control: /** @type {any} */ (input.metrics.control),
      config,
      review: String(input.role) === 'review',
    });
    if (verdict.rollback) {
      const next = { ...state, rolledBackAt: new Date(now).toISOString(), rollbackReasons: verdict.reasons };
      if (typeof input.persistState === 'function') input.persistState(next);
      return { ...base, mode: 'shadow', phase: 'rolled_back', rollbackReasons: verdict.reasons };
    }
  }
  if (!isCanaryEligible(input)) return { ...base, mode: 'shadow', phase: 'canary' };
  const inBucket = canaryBucketOf(String(input.pickKey || '')) < config.canary.percent;
  return {
    ...base,
    mode: inBucket ? 'enforce' : 'shadow',
    bucket: inBucket ? 'canary' : 'control',
    phase: 'canary',
  };
}

/**
 * Closed-field journal shape of the policy verdict.
 *
 * @param {unknown} input
 * @returns {object | null}
 */
export function normalizeCostPolicyRecord(input) {
  if (!input || typeof input !== 'object') return null;
  const row = /** @type {any} */ (input);
  const mode = String(row.mode || '').trim().toLowerCase();
  if (!COMPLEXITY_POLICY_MODES.includes(mode)) return null;
  const codes = (list) => (Array.isArray(list) ? list : [])
    .map((c) => String(c || '').trim()).filter((c) => COST_POLICY_REASONS.includes(c));
  const id = (v) => String(v || '').trim().slice(0, 200);
  const bucket = ['canary', 'control'].includes(String(row.bucket)) ? String(row.bucket) : 'none';
  return {
    mode,
    configured: COMPLEXITY_POLICY_MODES.includes(String(row.configured)) ? String(row.configured) : mode,
    bucket,
    phase: String(row.phase || '').replace(/[^a-z_]/g, '').slice(0, 24),
    wouldChange: row.wouldChange === true,
    applied: row.applied === true,
    qualityRelaxed: row.qualityRelaxed === true,
    pickReasons: codes(row.pickReasons),
    policyPick: id(row.policyPick),
    counterfactualPick: id(row.counterfactualPick),
    rejected: (Array.isArray(row.rejected) ? row.rejected : []).slice(0, 12).map((r) => ({
      candidateId: id(r?.candidateId),
      reasons: codes(r?.reasons),
    })).filter((r) => r.candidateId),
    rollbackReasons: (Array.isArray(row.rollbackReasons) ? row.rollbackReasons : [])
      .map((c) => String(c || '').replace(/[^a-z_]/g, '')).filter(Boolean).slice(0, 8),
  };
}

export { pairKey as costPolicyPairKey };
