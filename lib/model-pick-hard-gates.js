/**
 * Shared hard-gate validator for every model-selection path.
 *
 * `model_pick` filters candidates before it proposes one, `delegation_start`
 * must accept exactly the same (harness, model, role) combinations when a
 * caller names an executor, the Workspace Watcher orchestrator resolves an
 * explicit policy pair, and a fallback retry carries `exclude_model` /
 * `exclude_harness`. Keeping the refusal decision in ONE pure function stops a
 * path from silently bypassing a rule another path enforces.
 *
 * The module is deliberately I/O-free: every piece of store data (favorites,
 * lockouts, usage limits, MCP capability) is injected by the caller. That makes
 * it deterministic, cheap to test, and reusable by the sibling audited-overrides
 * leaf without importing the persistence layer.
 *
 * What this module does NOT decide: which eligible model is *ranked* first.
 * Scoring, rotation/exploration and observed-outcome blending stay in
 * `model-role-profiles.js` / `model-pick-service.js`.
 */

import { resolveDelegationEnv } from './delegation-settings.js';
import { assertReviewAdapterAllowed } from './delegation-adapter-capabilities.js';
import { isStartupFailureLockoutRow } from './delegation-startup-lockout-policy.js';
import { MCP_CAPABILITY_DENIED } from './mcp/mcp-capability-codes.js';
import { isUnknownModelFamily } from './model-alias-policy.js';
import { decodeModelValue } from './model-catalog.js';
import { planWindowExhaustedReason } from './model-pick-plan-window-gate.js';
import { estimateModelCostTier } from './model-catalog-meta.js';
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

/**
 * Loose store row (usage limit, lockout or favorite) the gates read. Every
 * field is optional because the sources differ in shape.
 *
 * @typedef {object} ModelPickHardGateRow
 * @property {string} [harness]
 * @property {string} [model]
 * @property {string} [resetAt]
 * @property {string} [resetsAt]
 * @property {string} [code]
 * @property {boolean} [available]
 */

/**
 * @typedef {object} ModelPickHardGateHarnessRow
 * @property {boolean} [enabled]
 * @property {boolean} [ready]
 * @property {boolean} [can_delegate]
 */

/**
 * @typedef {object} ModelPickHardGateInput
 * @property {unknown} [role]
 * @property {unknown} [assignment]
 * @property {unknown} [executionMode]
 * @property {unknown} [harness]
 * @property {unknown} [model]
 * @property {boolean} [allowFlashReview]
 * @property {boolean} [allowPremium]
 * @property {unknown} [pickReason]
 * @property {unknown} [costTier]
 * @property {unknown} [sourceKind]
 * @property {unknown} [leafSize]
 * @property {boolean} [checkReviewAdapter]
 * @property {unknown} [reviewAdapter]
 * @property {unknown} [allowedHarnesses]
 * @property {ModelPickHardGateHarnessRow} [harnessRow]
 * @property {boolean} [favoritesConfigured]
 * @property {unknown} [favoriteModels]
 * @property {unknown} [excludeModels]
 * @property {unknown} [excludeHarnesses]
 * @property {unknown} [excludePairs]
 * @property {unknown} [historyExcludeModels]
 * @property {unknown} [softExcludeModels]
 * @property {boolean} [applySoftExcludes]
 * @property {unknown} [modelAvailable]
 * @property {{ available?: boolean }} [row]
 * @property {unknown} [now]
 * @property {ModelPickHardGateRow[]} [lockouts]
 * @property {boolean} [permitStartupFailureLockoutOverride]
 * @property {ModelPickHardGateRow[]} [usageLimits]
 * @property {ModelPickHardGateRow[]} [activeUsageLimits]
 * @property {object[]} [planWindowLimits]
 * @property {{ enabled?: boolean, hardUtilizationPct?: number, hardFreePercent?: number }} [planWindowConfig]
 * @property {boolean} [allowNamedModel]
 * @property {string[]} [modelRoles]
 * @property {boolean} [requireMcp]
 * @property {unknown} [mcpCapabilityDenial]
 * @property {unknown} [mcpCapabilityProbe]
 * @property {unknown} [workspaceFolder]
 */

/** Stable machine codes surfaced on a refused selection. */
export const MODEL_PICK_HARD_GATE_CODES = Object.freeze({
  ROLE_INVALID: 'role_invalid',
  MODEL_REQUIRED: 'model_required',
  FLASH_REVIEW: 'flash_review',
  FLASH_IMPLEMENT_LARGE_LEAF: 'flash_implement_large_leaf',
  REVIEW_UNCERTIFIED: 'review_uncertified',
  PREMIUM_JUSTIFICATION: 'premium_review_justification_required',
  HARNESS_NOT_ALLOWED: 'harness_not_allowed',
  HARNESS_UNAVAILABLE: 'harness_unavailable',
  FAVORITES_MISSING: 'favorites_missing',
  MODEL_NOT_FAVORITE: 'model_not_favorite',
  MODEL_EXCLUDED: 'model_excluded',
  HARNESS_EXCLUDED: 'harness_excluded',
  HISTORY_EXCLUDED: 'history_excluded',
  MODEL_UNAVAILABLE: 'model_unavailable',
  ACTIVE_LOCKOUT: 'active_lockout',
  STARTUP_FAILURE_LOCKOUT: 'startup_failure_lockout',
  USAGE_LIMIT: 'usage_limit',
  PLAN_WINDOW_EXHAUSTED: 'plan_window_exhausted',
  ROLE_MEMBERSHIP: 'role_membership',
  MCP_CAPABILITY: 'mcp_capability',
});

/** Roles this validator understands (mirrors `MODEL_PICK_ROLES`). */
export const MODEL_PICK_HARD_GATE_ROLES = MODEL_PICK_ROLES;

/**
 * The gate role for a start request. A `review` assignment with
 * `execution_mode=plan` is a planner (read-only plan), matching
 * `model-pick-history.js`'s persisted-role mapping.
 *
 * @param {{ role?: unknown, assignment?: unknown, executionMode?: unknown }} [input]
 * @returns {'plan' | 'implement' | 'review' | 'fix' | ''}
 */
export function resolveModelPickGateRole(input = {}) {
  const explicit = String(input.role || '').trim().toLowerCase();
  if (MODEL_PICK_ROLES.includes(/** @type {'plan'|'implement'|'review'|'fix'} */ (explicit))) {
    return /** @type {'plan' | 'implement' | 'review' | 'fix'} */ (explicit);
  }
  const assignment = String(input.assignment || '').trim().toLowerCase();
  const mode = String(input.executionMode || '').trim().toLowerCase();
  if (assignment === 'review') return mode === 'plan' ? 'plan' : 'review';
  if (assignment === 'implement') return 'implement';
  return '';
}

/**
 * Relative cost tier for a model id (heuristic, never a price).
 *
 * @param {unknown} model
 * @returns {number}
 */
export function modelPickCostTier(model) {
  const decoded = decodeModelValue(String(model || '').trim());
  return estimateModelCostTier(decoded.modelId, decoded.params);
}

/**
 * @param {unknown} value
 * @returns {boolean} true when the caller explicitly confirmed the gate.
 */
function confirmed(value) {
  return value === true;
}

/**
 * @param {unknown} value
 * @returns {string} lower-cased trimmed string
 */
function lower(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Active usage-limit / quota row for one harness/model pair (base-model aware).
 *
 * A harness-level row (empty `model`) blocks every model of that harness; a
 * `harness:model` row blocks that model and its base id. An expired row never
 * blocks. Mirrors `hasActiveLockout`, but reads the injected usage-limit rows so
 * the caller keeps the two data sources (lockouts vs quota) separate.
 *
 * @param {string} harness
 * @param {string} model
 * @param {ModelPickHardGateRow[]} rows
 * @param {number} now
 * @returns {ModelPickHardGateRow | null} the blocking row, or null
 */
export function findActiveUsageLimit(harness, model, rows, now = Date.now()) {
  const wantedHarness = lower(harness);
  const wantedModel = lower(model);
  const wantedBase = decodeModelValue(wantedModel).modelId.toLowerCase();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isStartupFailureLockoutRow(row)) continue;
    if (lower(row?.harness) !== wantedHarness) continue;
    const resetAt = Date.parse(String(row?.resetAt ?? row?.resetsAt ?? ''));
    if (Number.isFinite(resetAt) && resetAt <= now) continue;
    const limited = lower(row?.model);
    if (!limited) return row;
    if (limited === wantedModel) return row;
    if (decodeModelValue(limited).modelId.toLowerCase() === wantedBase) return row;
  }
  return null;
}

/**
 * Backwards-compatible alias for the Workspace Watcher predicate. The cycle
 * resolver previously owned this loop; it now lives next to the other gates.
 *
 * @param {string} harness
 * @param {string} model
 * @param {ModelPickHardGateRow[]} activeUsageLimits
 * @param {number} [now]
 * @returns {boolean}
 */
export function isModelUsageLimited(harness, model, activeUsageLimits, now = Date.now()) {
  return findActiveUsageLimit(harness, model, activeUsageLimits, now) !== null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [];
}

/**
 * @param {string} harness
 * @param {string[]} harnesses
 * @returns {boolean}
 */
function anyHarnessExcluded(harness, harnesses) {
  return harnesses.some((excluded) => isExcludedDelegationHarness(harness, excluded));
}

/**
 * @param {string} model
 * @param {string[]} models
 * @returns {boolean}
 */
function anyModelExcluded(model, models) {
  return models.some((excluded) => isExcludedDelegationModel(model, excluded));
}

/**
 * @param {unknown} value
 * @returns {{ harness: string, model: string }[]}
 */
function normalizeExcludePairs(value) {
  if (!Array.isArray(value)) return [];
  /** @type {{ harness: string, model: string }[]} */
  const out = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const harness = lower(row.harness);
    const model = String(row.model || '').trim();
    if (!harness || !model) continue;
    out.push({ harness, model });
  }
  return out;
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {{ harness: string, model: string }} pair
 * @returns {boolean}
 */
function isPairExcluded(harness, model, pair) {
  if (!isExcludedDelegationHarness(harness, pair.harness)) return false;
  return isExcludedDelegationModel(model, pair.model);
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {{ harness: string, model: string }[]} pairs
 * @returns {boolean}
 */
function anyPairExcluded(harness, model, pairs) {
  return pairs.some((pair) => isPairExcluded(harness, model, pair));
}

/**
 * @param {unknown} probe
 * @param {string} harness
 * @param {string} workspaceFolder
 * @returns {string} denial code, or '' when capable
 */
export function readModelPickMcpCapabilityDenial(probe, harness, workspaceFolder) {
  let verdict;
  try {
    verdict = typeof probe === 'function' ? probe({ harness, workspaceFolder }) : probe;
  } catch {
    return MCP_CAPABILITY_DENIED.CONFIG;
  }
  if (verdict?.ok) return '';
  return String(verdict?.reason || '').trim() || MCP_CAPABILITY_DENIED.CONFIG;
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {number} status
 * @param {string} error
 * @param {Record<string, unknown>} [detail]
 * @returns {{ ok: false, code: string, reason: string, status: number, error: string }}
 */
function refuse(code, reason, status, error, detail = {}) {
  return { ok: false, code, reason, status, error, ...detail };
}

/**
 * One pure hard gate shared by the picker, the Watcher orchestrator, the named
 * `delegation_start` executor and the fallback/exclude retry.
 *
 * Input (all optional except the pair being evaluated):
 * - `role` / `assignment` + `executionMode`: which role is starting.
 * - `harness`, `model`: the requested executor.
 * - `allowFlashReview`, `allowPremium`, `pickReason`, `costTier`, `sourceKind`,
 *   `checkReviewAdapter` / `reviewAdapter`: the start-time confirmation gates.
 * - `allowedHarnesses`: non-empty harness allow-list (gate skipped when absent).
 * - `harnessRow`: `{ enabled, ready, can_delegate }`; gate skipped when absent.
 * - `favoritesConfigured` + `favoriteModels`: gate skipped unless either is
 *   provided; a caller that has no favorites data must not be forced to guess.
 * - `excludeModels` / `excludeHarnesses`: caller excludes (hard for every role).
 * - `excludePairs`: harness+model pair excludes (hard; does not widen to harness/model-wide).
 * - `historyExcludeModels`: durable hard excludes (last implementer, etc.).
 * - `softExcludeModels` / `applySoftExcludes`: the review-only soft preference.
 * - `lockouts`: active lockout rows; gate skipped unless an array is passed.
 * - `usageLimits` / `activeUsageLimits`: active quota rows; same opt-in rule.
 * - `planWindowLimits` + `planWindowConfig`: plan-limit rows for the picker's
 *   hard weekly-window threshold; gate skipped unless an array is passed (named
 *   starts, `pick_id` and overrides never pass it).
 * - `modelRoles`: the resolved roles for the pair. When an array is injected the
 *   gate rejects a role the model does not claim. Two narrow, operator-gated
 *   exceptions bypass membership: `allowNamedModel: true` skips membership only
 *   for an id whose alias policy reports `unknown` family (the documented
 *   explicit named-model exception for private/mock ids), and a confirmed
 *   uncertified review skips membership only for `role === 'review'` when the
 *   step-4 adapter guarantee returned `reviewUncertified === true` — which is
 *   produced solely by the explicit `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1`
 *   opt-in (without it step 4 refuses with `review_uncertified` and this step is
 *   never reached). Neither exception weakens any other gate.
 * - `modelAvailable`: `false` marks a favorite that is not actually available
 *   (independent of harness state).
 * - `requireMcp`, `mcpCapabilityProbe` / `mcpCapabilityDenial`,
 *   `workspaceFolder`: the orchestrator MCP contract (gate skipped unless
 *   `requireMcp === true`).
 *
 * @param {ModelPickHardGateInput} [input]
 * @returns {{ ok: true, role: string, costTier: number, reviewUncertified: boolean }
 *   | { ok: false, code: string, reason: string, status: number, error: string }}
 */
export function evaluateModelPickHardGates(input = {}) {
  const role = resolveModelPickGateRole(input);
  const harness = lower(input.harness);
  const model = String(input.model || '').trim();

  // 1. Role.
  if (!MODEL_PICK_ROLES.includes(/** @type {'plan'|'implement'|'review'|'fix'} */ (role))) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.ROLE_INVALID,
      'role-invalid',
      400,
      'role must be plan, implement, review, or fix',
    );
  }

  // 2. Model id.
  if (!model) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.MODEL_REQUIRED,
      'model-required',
      400,
      'A model id is required.',
    );
  }

  // 3. Harness enabled / ready / delegatable. Checked before the adapter
  //    certification so an unavailable harness reports the actionable reason
  //    (matches the picker's diagnosis order).
  if (input.harnessRow && typeof input.harnessRow === 'object') {
    const row = input.harnessRow;
    if (!row.enabled || !row.ready || !row.can_delegate) {
      return refuse(
        MODEL_PICK_HARD_GATE_CODES.HARNESS_UNAVAILABLE,
        'harness-unavailable',
        409,
        `Harness ${harness || '(missing)'} is not enabled, ready and delegatable.`,
      );
    }
  }

  // 4. Review-adapter certification (review and plan roles).
  let reviewUncertified = false;
  if ((role === 'review' || role === 'plan') && input.checkReviewAdapter !== false) {
    /** @type {{ ok: boolean, status?: number, error?: string, capabilities?: object, reviewUncertified?: boolean }} */
    const adapter = input.reviewAdapter && typeof input.reviewAdapter === 'object'
      ? /** @type {ReturnType<typeof assertReviewAdapterAllowed>} */ (input.reviewAdapter)
      : assertReviewAdapterAllowed(harness, { env: resolveDelegationEnv(input.workspaceFolder) });
    if (!adapter.ok) {
      return refuse(
        MODEL_PICK_HARD_GATE_CODES.REVIEW_UNCERTIFIED,
        'review-uncertified',
        Number(adapter.status) || 409,
        String(adapter.error || 'Review adapter guarantee is not available.'),
        { capabilities: adapter.capabilities, reviewUncertified: true },
      );
    }
    reviewUncertified = adapter.reviewUncertified === true;
  }

  // 5. Flash review.
  if (role === 'review' && isFlashDelegationModel(model) && !confirmed(input.allowFlashReview)) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.FLASH_REVIEW,
      'flash-for-review',
      409,
      `Review cannot run on a *flash* model (${model}): flash ids are too short-lived for an autonomous review and time out. Pick a non-flash reviewer, or pass confirm_flash_review=true to accept the risk explicitly.`,
    );
  }

  // 5b. Flash implement on a large todo leaf (explicit named start only).
  if (
    role === 'implement'
    && String(input.leafSize || '').trim().toLowerCase() === 'large'
    && isFlashDelegationModel(model)
    && !hasPremiumPickJustification(input.pickReason)
  ) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.FLASH_IMPLEMENT_LARGE_LEAF,
      'flash-implement-large-leaf',
      409,
      `Implement cannot run on a *flash* model (${model}) for a large leaf stage. Pick a non-flash implementer, or provide a substantive pick_reason to override explicitly.`,
    );
  }

  // 6. Premium review cost tier needs a justification or an explicit override.
  const costTier = Number.isFinite(Number(input.costTier))
    ? Number(input.costTier)
    : modelPickCostTier(model);
  if (
    role === 'review'
    && String(input.sourceKind || '').trim().toLowerCase() !== 'plan'
    && costTier >= PREMIUM_REVIEW_COST_TIER
    && !confirmed(input.allowPremium)
    && !hasPremiumPickJustification(input.pickReason)
  ) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.PREMIUM_JUSTIFICATION,
      'premium-justification-required',
      409,
      `Review on ${model} is a premium cost tier (${costTier}) and is reserved for exceptional cases. Provide a pick_reason justifying it, or pass confirm_premium_review=true to accept it explicitly.`,
    );
  }

  // 7. Harness allow-list.
  const allowedHarnesses = stringList(input.allowedHarnesses);
  if (allowedHarnesses.length > 0 && !allowedHarnesses.includes(harness)) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.HARNESS_NOT_ALLOWED,
      'harness-not-allowed',
      409,
      `Harness ${harness || '(missing)'} is not in the orchestrator allow-list.`,
    );
  }

  // 8. Favorites: only enforced when the caller injected favorites data.
  const favoritesInjected = input.favoritesConfigured !== undefined || Array.isArray(input.favoriteModels);
  if (favoritesInjected) {
    if (input.favoritesConfigured === false || (input.favoritesConfigured === undefined && isEmptyList(input.favoriteModels))) {
      return refuse(
        MODEL_PICK_HARD_GATE_CODES.FAVORITES_MISSING,
        'favorites-missing',
        409,
        `Harness ${harness || '(missing)'} has no Settings favorites configured.`,
      );
    }
    const favorites = stringList(input.favoriteModels);
    if (Array.isArray(input.favoriteModels) && !favorites.includes(model)) {
      return refuse(
        MODEL_PICK_HARD_GATE_CODES.MODEL_NOT_FAVORITE,
        'model-not-favorite',
        409,
        `Model ${model} is not an enabled favorite of ${harness || '(missing)'}.`,
      );
    }
  }

  // 9. Exclusions. Caller and history hard excludes apply to every role; the
  // soft history preference only ever reaches the review path.
  const callerExcludeModels = stringList(input.excludeModels);
  const callerExcludeHarnesses = stringList(input.excludeHarnesses);
  const callerExcludePairs = normalizeExcludePairs(input.excludePairs);
  const historyExcludeModels = stringList(input.historyExcludeModels);
  if (anyHarnessExcluded(harness, callerExcludeHarnesses)) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.HARNESS_EXCLUDED,
      'harness-excluded',
      409,
      `Harness ${harness || '(missing)'} is excluded for this selection.`,
    );
  }
  if (
    anyModelExcluded(model, callerExcludeModels)
    || anyModelExcluded(model, historyExcludeModels)
    || anyPairExcluded(harness, model, callerExcludePairs)
  ) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.MODEL_EXCLUDED,
      'model-excluded',
      409,
      `Model ${model} is excluded for this selection.`,
    );
  }
  if (
    role === 'review'
    && input.applySoftExcludes !== false
    && anyModelExcluded(model, stringList(input.softExcludeModels))
  ) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.HISTORY_EXCLUDED,
      'history-excluded',
      409,
      `Model ${model} is excluded by the recent review history.`,
    );
  }

  // 10. Model availability. A favorite row (or the caller) may mark the pair
  // unavailable independent of the harness state.
  if (input.modelAvailable === false
    || (input.row && typeof input.row === 'object' && input.row.available === false)) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.MODEL_UNAVAILABLE,
      'model-unavailable',
      409,
      `Model ${model} is not available on ${harness || '(missing)'}.`,
    );
  }

  // 11. Active lockout (harness-wide or model/base scoped).
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const activeLockout = /** @type {ModelPickHardGateRow | null} */ (Array.isArray(input.lockouts)
    ? findActiveLockoutRow(input.lockouts, harness, model, now)
    : null);
  if (activeLockout) {
    const startupLockout = isStartupFailureLockoutRow(activeLockout);
    if (startupLockout && input.permitStartupFailureLockoutOverride === true) {
      // Named explicit starts may proceed; the caller attaches a warning.
    } else {
      return refuse(
        startupLockout
          ? MODEL_PICK_HARD_GATE_CODES.STARTUP_FAILURE_LOCKOUT
          : MODEL_PICK_HARD_GATE_CODES.ACTIVE_LOCKOUT,
        startupLockout ? 'startup-failure' : 'active-lockout',
        409,
        startupLockout
          ? `Model ${model} on ${harness || '(missing)'} is cooling down after a startup failure (until ${activeLockout.resetAt || 'unknown'}).`
          : `Model ${model} is under an active lockout on ${harness || '(missing)'}.`,
        startupLockout
          ? { lockoutCode: activeLockout.code, lockoutResetAt: activeLockout.resetAt }
          : {},
      );
    }
  }

  // 12. Active usage limit / quota (harness-wide or model/base scoped).
  const usageRows = Array.isArray(input.usageLimits)
    ? input.usageLimits
    : Array.isArray(input.activeUsageLimits)
      ? input.activeUsageLimits
      : null;
  if (Array.isArray(usageRows) && findActiveUsageLimit(harness, model, usageRows, now)) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.USAGE_LIMIT,
      'usage-limit',
      409,
      `Model ${model} is under an active usage limit on ${harness || '(missing)'}.`,
    );
  }

  // 13. Role membership: the model must actually claim the gate role when the
  // caller injected the resolved roles. An empty role list on a *known* family
  // is a hard deny (role-mismatch), not a silent skip.
  //
  // Two narrow, operator-gated exceptions bypass membership:
  //   (a) `allowNamedModel` for an id whose alias policy reports an unknown
  //       family (private/mock model ids the catalog cannot classify).
  //   (b) a confirmed uncertified review: `role === 'review'` AND the adapter
  //       guarantee in step 4 returned `reviewUncertified === true`. That flag
  //       is only produced when the operator opted into an uncertified adapter
  //       via `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1` — otherwise step 4
  //       refuses with `review_uncertified` and never reaches this step. So the
  //       exception is a deliberate operator decision on a named executor, and
  //       it cannot weaken any other gate (favorites, readiness, availability,
  //       lockout, quota, exclusions, MCP, or membership for implement/plan/fix).
  const namedFlashReview = role === 'review'
    && isFlashDelegationModel(model)
    && confirmed(input.allowFlashReview);
  const namedUncertifiedReview = role === 'review' && reviewUncertified === true;
  const membershipSkipped = (input.allowNamedModel === true && isUnknownModelFamily(model))
    || namedFlashReview
    || namedUncertifiedReview;
  if (
    !membershipSkipped
    && Array.isArray(input.modelRoles)
    && !input.modelRoles.includes(role)
  ) {
    return refuse(
      MODEL_PICK_HARD_GATE_CODES.ROLE_MEMBERSHIP,
      'role-membership',
      409,
      `Model ${model} is not eligible for role "${role}".`,
    );
  }

  // 14. Orchestrator MCP contract.
  if (input.requireMcp === true) {
    const injected = String(input.mcpCapabilityDenial || '').trim();
    const denial = injected || readModelPickMcpCapabilityDenial(
      input.mcpCapabilityProbe,
      harness,
      String(input.workspaceFolder || '').trim(),
    );
    if (denial) {
      return refuse(
        MODEL_PICK_HARD_GATE_CODES.MCP_CAPABILITY,
        denial,
        409,
        `Harness ${harness || '(missing)'} cannot deliver the orchestrator MCP contract (${denial}).`,
        { mcpDenial: denial },
      );
    }
  }

  // 15. Hard weekly plan window (picker only; opt-in by injecting the rows).
  // Evaluated AFTER role membership and the MCP contract so a candidate that is
  // not eligible for the role keeps its role-membership reason and never looks
  // like a plan-window cut that the empty-pool relaxation could re-admit.
  if (Array.isArray(input.planWindowLimits)) {
    const exhausted = planWindowExhaustedReason({
      harness,
      modelId: model,
      planLimits: input.planWindowLimits,
      now,
      config: input.planWindowConfig,
    });
    if (exhausted) {
      return refuse(
        MODEL_PICK_HARD_GATE_CODES.PLAN_WINDOW_EXHAUSTED,
        'plan-window-exhausted',
        409,
        `Model ${model} on ${harness || '(missing)'} is on a plan window that is exhausted (${exhausted.type} at ${exhausted.utilization}%, resets ${exhausted.resetsAt}).`,
        { planWindow: exhausted },
      );
    }
  }

  return { ok: true, role, costTier, reviewUncertified };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEmptyList(value) {
  return Array.isArray(value) && value.length === 0;
}
