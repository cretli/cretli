/**
 * Role profiles for MCP model_pick (plan / implement / review / fix).
 * Defaults are substring matchers. Optional operator override:
 * data/model-role-profiles.json (gitignored with the rest of data/).
 * Ranking uses cost/quality/speed axes (matcher lists are eligibility only).
 * Cost/quality/speed are never scraped from the network.
 */

import fs from 'node:fs';
import { decodeModelValue } from './model-catalog.js';
import {
  estimateModelCostTier,
  estimateModelQualityTier,
  estimateModelSpeedTier,
} from './model-catalog-meta.js';
import { resolveDataPath } from './runtime-paths.js';

/** @typedef {'plan' | 'implement' | 'review' | 'fix'} ModelPickRole */

/** @type {Readonly<ModelPickRole[]>} */
export const MODEL_PICK_ROLES = Object.freeze(['plan', 'implement', 'review', 'fix']);

/**
 * @typedef {{ pattern: string, priority: number }} ModelRoleMatcher
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

/** @type {ModelRoleProfiles} */
export const DEFAULT_MODEL_ROLE_PROFILES = Object.freeze({
  plan: Object.freeze([
    { pattern: 'grok', priority: 0 },
    { pattern: 'luna', priority: 1 },
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
    { pattern: 'kimi', priority: 6 },
    { pattern: 'luna', priority: 7 },
    { pattern: 'astra', priority: 8 },
    { pattern: 'sonnet', priority: 9 },
  ]),
  review: Object.freeze([
    { pattern: 'grok', priority: 0 },
    { pattern: 'sonnet', priority: 1 },
    { pattern: 'composer', priority: 2 },
    { pattern: 'glm', priority: 3 },
    { pattern: 'qwen', priority: 4 },
    { pattern: 'deepseek', priority: 5 },
    { pattern: 'astra', priority: 6 },
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
    { pattern: 'kimi', priority: 6 },
  ]),
});

/**
 * @param {unknown} raw
 * @returns {ModelRoleMatcher[]}
 */
function normalizeMatchers(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {ModelRoleMatcher[]} */
  const out = [];
  for (const row of raw) {
    const pattern = String(row?.pattern || '').trim().toLowerCase();
    if (!pattern) continue;
    const priority = Number(row?.priority);
    out.push({
      pattern,
      priority: Number.isFinite(priority) ? priority : out.length,
    });
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
  /** @type {Record<string, ModelRoleMatcher[]>} */
  const merged = {
    plan: [...base.plan],
    implement: [...base.implement],
    review: [...base.review],
    fix: [...base.fix],
  };
  for (const role of MODEL_PICK_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(roles, role)) continue;
    const matchers = normalizeMatchers(roles[role]);
    if (matchers.length === 0) continue;
    merged[role] = matchers;
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
 * @param {string} modelId
 * @param {ModelRoleMatcher[]} matchers
 * @returns {number}
 */
function resolveMatcherPriority(modelId, matchers) {
  const hay = String(modelId || '').toLowerCase();
  let best = Number.POSITIVE_INFINITY;
  for (const matcher of matchers) {
    if (!hay.includes(matcher.pattern)) continue;
    if (matcher.priority < best) best = matcher.priority;
  }
  return best;
}

/**
 * @param {string} modelId
 * @param {ModelRoleProfiles} [profiles]
 * @returns {ModelPickRole[]}
 */
export function listRolesForModel(modelId, profiles = DEFAULT_MODEL_ROLE_PROFILES) {
  const id = String(modelId || '').trim();
  if (!id) return [];
  const flash = isFlashDelegationModel(id);
  return MODEL_PICK_ROLES.filter((role) => {
    if (role === 'review' && flash) return false;
    return Number.isFinite(resolveMatcherPriority(id, profiles[role] || []));
  });
}

/**
 * @param {string} modelId
 * @param {string} excludeModel
 * @returns {boolean}
 */
export function isExcludedDelegationModel(modelId, excludeModel) {
  const id = String(modelId || '').trim();
  const exclude = String(excludeModel || '').trim();
  if (!id || !exclude) return false;
  if (id === exclude) return true;
  const left = decodeModelValue(id).modelId.toLowerCase();
  const right = decodeModelValue(exclude).modelId.toLowerCase();
  return left !== '' && left === right;
}

/**
 * @param {string} harnessId
 * @param {string} excludeHarness
 * @returns {boolean}
 */
export function isExcludedDelegationHarness(harnessId, excludeHarness) {
  const id = String(harnessId || '').trim().toLowerCase();
  const exclude = String(excludeHarness || '').trim().toLowerCase();
  if (!id || !exclude) return false;
  return id === exclude;
}

/**
 * Flash ids are too short-lived for review (quiet-stop / first-event timeout).
 * Implement and fix may still pick them.
 *
 * @param {string} modelId
 * @returns {boolean}
 */
export function isFlashDelegationModel(modelId) {
  const decoded = decodeModelValue(String(modelId || '').trim()).modelId.toLowerCase();
  const hay = decoded || String(modelId || '').trim().toLowerCase();
  return hay.includes('flash');
}

/**
 * Role-axis ranking. Matcher priority is eligibility only (not a sort key).
 *
 * @param {ModelPickRole} role
 * @param {ModelPickCandidate} left
 * @param {ModelPickCandidate} right
 * @returns {number}
 */
export function compareModelPickCandidates(role, left, right) {
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
  return left.model.localeCompare(right.model);
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
 *   cost_tier: number,
 *   quality_tier: number,
 *   speed_tier: number,
 *   priority: number,
 *   score: number,
 *   weights: ModelRoleScoreWeights,
 * }} ModelPickCandidate
 */

/**
 * Join harness_list (enabled && ready && can_delegate) with favorite models.
 * Empty favorites (`favorites_configured` not true) are unset — no pick from
 * that harness, not the whole catalog. `delegation_start` uses the same unset
 * meaning by default (`CRETLI_DELEGATION_EMPTY_FAVORITES=all` is the legacy
 * start-any-id escape).
 *
 * @param {{
 *   role?: unknown,
 *   excludeModel?: unknown,
 *   excludeHarness?: unknown,
 *   harnesses?: ModelPickHarnessRow[],
 *   modelsByHarness?: Record<string, ModelPickHarnessModels>,
 *   profiles?: ModelRoleProfiles,
 *   weights?: ModelRoleScoreWeightsByRole,
 * }} input
 * @returns {{
 *   ok: true,
 *   pick: ModelPickCandidate,
 *   candidates: ModelPickCandidate[],
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
  const excludeModel = String(input.excludeModel || '').trim();
  const excludeHarness = String(input.excludeHarness || '').trim();
  /** @type {ModelPickCandidate[]} */
  const ranked = [];
  for (const harness of input.harnesses || []) {
    if (!harness?.enabled || !harness?.ready || !harness?.can_delegate) continue;
    const harnessId = String(harness.id || '').trim();
    if (!harnessId) continue;
    if (isExcludedDelegationHarness(harnessId, excludeHarness)) continue;
    const listed = input.modelsByHarness?.[harnessId];
    if (!listed || listed.favorites_configured !== true) continue;
    for (const row of listed.items || []) {
      const model = String(row.id || '').trim();
      if (!model) continue;
      if (isExcludedDelegationModel(model, excludeModel)) continue;
      if (role === 'review' && isFlashDelegationModel(model)) continue;
      if (row.available === false) continue;
      const roles = Array.isArray(row.roles) ? row.roles : listRolesForModel(model, profiles);
      if (!roles.includes(role)) continue;
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
      ranked.push({
        harness: harnessId,
        model,
        label: String(row.label || model),
        cost_tier: costTier,
        quality_tier: qualityTier,
        speed_tier: speedTier,
        priority: resolveMatcherPriority(model, matchers),
        score,
        weights: { ...roleWeights },
      });
    }
  }
  if (ranked.length === 0) {
    return {
      ok: false,
      code: 'MODEL_UNAVAILABLE',
      error: `No Settings favorite matches role "${role}" on an enabled, ready, delegatable harness.`,
    };
  }
  ranked.sort((left, right) => compareModelPickCandidates(
    /** @type {ModelPickRole} */ (role),
    left,
    right,
  ));
  return { ok: true, pick: ranked[0], candidates: ranked.slice(0, 8) };
}
