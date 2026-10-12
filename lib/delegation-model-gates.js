/**
 * Shared start-time model gates for `delegation_start` and `model_pick`.
 *
 * This module is the thin compatibility façade over
 * `lib/model-pick-hard-gates.js` (the single hard-gate validator). It keeps the
 * historical exported names, codes and messages so the named-executor path in
 * `delegation-service.js` and the existing contract tests keep working, while
 * the decision itself lives in exactly one place.
 *
 * @see ./model-pick-hard-gates.js
 */

import {
  MODEL_PICK_HARD_GATE_CODES,
  evaluateModelPickHardGates,
  modelPickCostTier,
  resolveModelPickGateRole,
} from './model-pick-hard-gates.js';
import { listHarnessModels, readSyncHarnessDelegatableRow } from './harness-catalog.js';
import {
  listEnabledDelegationModels,
  readDelegationEmptyFavoritesPolicy,
} from './delegation-executor.js';
import { loadSettings } from './persist/settings.js';
import { listRolesForModel, loadModelRoleProfiles } from './model-role-profiles.js';
import { loadModelPickOverridesForSelection } from './persist/model-pick-overrides-persist.js';
import { collectModelPickOverrideEffects } from './model-pick-overrides.js';
import { classifyLeafSize } from './model-pick-leaf-size.js';
import { getTodoById } from './persist/todos-persist.js';
import { resolveDataPath } from './runtime-paths.js';

/** Stable machine codes surfaced on a refused start (legacy names kept). */
export const DELEGATION_MODEL_GATE_CODES = Object.freeze({
  FLASH_REVIEW: 'flash_review_confirmation_required',
  FLASH_IMPLEMENT_LARGE_LEAF: 'flash_implement_large_leaf',
  REVIEW_UNCERTIFIED: 'review_uncertified',
  PREMIUM_JUSTIFICATION: 'premium_pick_justification_required',
});

/** Roles this gate understands (mirrors `MODEL_PICK_ROLES`). */
export const DELEGATION_MODEL_GATE_ROLES = Object.freeze(['plan', 'implement', 'review', 'fix']);

/**
 * The gate role for a start request. A `review` assignment with
 * `execution_mode=plan` is a planner (read-only plan), matching
 * `model-pick-history.js`'s persisted-role mapping.
 *
 * @param {{ role?: unknown, assignment?: unknown, executionMode?: unknown }} [input]
 * @returns {'plan' | 'implement' | 'review' | 'fix' | ''}
 */
export function resolveDelegationGateRole(input = {}) {
  return resolveModelPickGateRole(input);
}

/**
 * Relative cost tier for a delegation model id (heuristic, never a price).
 *
 * @param {unknown} model
 * @returns {number}
 */
export function modelCostTierForDelegation(model) {
  return modelPickCostTier(model);
}

/**
 * Translate a shared-validator refusal back to the historical delegation codes.
 *
 * @param {object} refusal
 * @returns {object}
 */
function toDelegationRefusal(refusal) {
  if (refusal.code === MODEL_PICK_HARD_GATE_CODES.FLASH_REVIEW) {
    return { ...refusal, code: DELEGATION_MODEL_GATE_CODES.FLASH_REVIEW };
  }
  if (refusal.code === MODEL_PICK_HARD_GATE_CODES.FLASH_IMPLEMENT_LARGE_LEAF) {
    return { ...refusal, code: DELEGATION_MODEL_GATE_CODES.FLASH_IMPLEMENT_LARGE_LEAF };
  }
  if (refusal.code === MODEL_PICK_HARD_GATE_CODES.PREMIUM_JUSTIFICATION) {
    return { ...refusal, code: DELEGATION_MODEL_GATE_CODES.PREMIUM_JUSTIFICATION };
  }
  if (refusal.code === MODEL_PICK_HARD_GATE_CODES.MODEL_REQUIRED) {
    return { ...refusal, code: 'model_unavailable' };
  }
  // `review_uncertified` is already the historical code; pass it through with
  // the adapter capabilities so the caller keeps the old response shape.
  return refusal;
}

/**
 * Full start gate: the confirmation gates plus every injected store gate
 * (favorites, lockout, quota, exclusions) that `delegation_start` can supply.
 *
 * @param {object} [input] see {@link evaluateModelPickHardGates}
 * @returns {{ ok: true, role: string, costTier: number, reviewUncertified: boolean } | { ok: false, status: number, code: string, error: string, reason?: string, capabilities?: object, reviewUncertified?: boolean }}
 */
export function evaluateDelegationStartHardGates(input = {}) {
  const verdict = evaluateModelPickHardGates(input);
  if (!verdict.ok) return toDelegationRefusal(verdict);
  return {
    ok: true,
    role: verdict.role,
    costTier: verdict.costTier,
    reviewUncertified: verdict.reviewUncertified,
  };
}

/**
 * Full hard-gate snapshot for a user-named `delegation_start` (with or without
 * `pick_id`). Keeps favorites, harness readiness and role membership aligned
 * with `model_pick` / the Watcher orchestrator resolver.
 *
 * @param {{
 *   role?: unknown,
 *   assignment?: unknown,
 *   executionMode?: unknown,
 *   harness?: unknown,
 *   model?: unknown,
 *   sourceKind?: unknown,
 *   pickReason?: unknown,
 *   allowFlashReview?: unknown,
 *   allowPremium?: unknown,
 *   lockouts?: object[],
 *   usageLimits?: object[],
 *   workspaceFolder?: unknown,
 *   overrideRows?: object[],
 *   excludeModels?: unknown,
 *   excludeHarnesses?: unknown,
 * }} input
 * @returns {object}
 */
export function buildNamedDelegationStartHardGateInput(input = {}) {
  const harness = String(input.harness || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  const profiles = loadModelRoleProfiles();
  let listed = null;
  try {
    listed = listHarnessModels({ harness, enabledOnly: false });
  } catch {
    listed = { favorites_configured: false, items: [] };
  }
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const row = items.find((item) => String(item?.id ?? '').trim() === model);
  const modelRoles = Array.isArray(row?.roles)
    ? row.roles
    : listRolesForModel(model, profiles, { mode: 'named' });
  const settings = loadSettings();
  const enabledFavorites = listEnabledDelegationModels({ transport: harness, settings });
  const emptyFavoritesAllowed = readDelegationEmptyFavoritesPolicy() === 'all';
  const favoritesConfigured = listed?.favorites_configured === true
    || enabledFavorites.length > 0
    || emptyFavoritesAllowed;
  let favoriteModels = items
    .filter((item) => item?.enabled !== false)
    .map((item) => String(item?.id ?? '').trim())
    .filter(Boolean);
  if (favoriteModels.length === 0 && enabledFavorites.length > 0) {
    favoriteModels = enabledFavorites;
  }
  // The legacy `CRETLI_DELEGATION_EMPTY_FAVORITES=all` policy means "no
  // favorites are configured, so any requested id is start-eligible" (mirrors
  // `resolveDelegationModel`). The catalog fallback rows above are not Settings
  // favorites, so the named model still has to be added to the membership list
  // when that policy is active. With real favorites configured the list stays
  // authoritative.
  if (
    emptyFavoritesAllowed
    && enabledFavorites.length === 0
    && model
    && !favoriteModels.includes(model)
  ) {
    favoriteModels = [...favoriteModels, model];
  }
  const harnessRow = input.harnessRow && typeof input.harnessRow === 'object'
    ? input.harnessRow
    : readSyncHarnessDelegatableRow(harness);
  // Audited overrides are re-read at start so an override that expired (or was
  // revoked) between the pick and the start no longer applies. Only the
  // exclusions matter for a named start; an explicit-orchestrator row is a
  // Watcher-resolution concern and never grants a named executor anything.
  const overrideEffects = collectModelPickOverrideEffects({
    overrides: Array.isArray(input.overrideRows)
      ? input.overrideRows
      : loadModelPickOverridesForSelection({ workspaceFolder: input.workspaceFolder }),
    workspaceFolder: input.workspaceFolder,
    role: resolveModelPickGateRole(input),
    now: input.now,
  });
  const gateRole = resolveModelPickGateRole(input);
  let leafSize = String(input.leafSize || '').trim().toLowerCase();
  const leafExists = typeof input.exists === 'function' ? input.exists : undefined;
  if (!leafSize && gateRole === 'implement') {
    const explicitBody = String(input.leafBody || '').trim();
    if (explicitBody) {
      leafSize = classifyLeafSize(explicitBody, { exists: leafExists });
    } else {
      const leafId = String(input.leafId || input.todoId || '').trim();
      const workspaceFolder = String(input.workspaceFolder || '').trim();
      if (leafId && workspaceFolder) {
        const dataDir = String(input.dataDir || '').trim() || resolveDataPath();
        const todo = getTodoById(dataDir, workspaceFolder, leafId);
        if (todo) leafSize = classifyLeafSize(todo.body || '', { exists: leafExists });
      }
      if (!leafSize) {
        const sourceText = String(input.sourceText || '');
        const refMatch = sourceText.match(/cretli-ref\s+todo=([0-9a-f-]{8,})/i);
        const refId = refMatch ? String(refMatch[1] || '').trim() : '';
        if (refId && workspaceFolder) {
          const dataDir = String(input.dataDir || '').trim() || resolveDataPath();
          const todo = getTodoById(dataDir, workspaceFolder, refId);
          if (todo) leafSize = classifyLeafSize(todo.body || '', { exists: leafExists });
        }
      }
      // A delegation attributed to a todo only via the parent chat's todoId
      // (no leaf_id/todo_id, no cretli-ref, parent not the orchestrator) still
      // must fire the flash-implement-large-leaf gate, so resolve the body from
      // the inherited parent.todoId when no other leaf context resolved.
      if (!leafSize) {
        const parentTodoId = String(input.parentTodoId || '').trim();
        if (parentTodoId && workspaceFolder) {
          const dataDir = String(input.dataDir || '').trim() || resolveDataPath();
          const todo = getTodoById(dataDir, workspaceFolder, parentTodoId);
          if (todo) leafSize = classifyLeafSize(todo.body || '', { exists: leafExists });
        }
      }
    }
  }
  return {
    role: input.role,
    assignment: input.assignment,
    executionMode: input.executionMode,
    harness,
    model,
    sourceKind: input.sourceKind,
    pickReason: input.pickReason,
    leafSize: leafSize || undefined,
    allowFlashReview: input.allowFlashReview,
    allowPremium: input.allowPremium,
    lockouts: input.lockouts,
    usageLimits: input.usageLimits,
    permitStartupFailureLockoutOverride: input.permitStartupFailureLockoutOverride === true,
    harnessRow: harnessRow || undefined,
    favoritesConfigured,
    favoriteModels,
    modelRoles,
    modelAvailable: row ? row.available !== false : undefined,
    allowNamedModel: true,
    excludeModels: [
      ...(Array.isArray(input.excludeModels) ? input.excludeModels : []),
      ...overrideEffects.excludedModels,
    ],
    excludeHarnesses: [
      ...(Array.isArray(input.excludeHarnesses) ? input.excludeHarnesses : []),
      ...overrideEffects.excludedHarnesses,
    ],
    excludePairs: [
      ...(Array.isArray(input.excludePairs) ? input.excludePairs : []),
      ...overrideEffects.excludedPairs,
    ],
    overrideSummary: {
      active: overrideEffects.active.map((override) => String(override.id || '')).filter(Boolean),
      expired: overrideEffects.expired.map((override) => String(override.id || '')).filter(Boolean),
    },
  };
}

/**
 * One pure start gate shared by the picker and `delegation_start`.
 *
 * Input:
 * - `role` / `assignment` + `executionMode`: which role is starting.
 * - `harness`, `model`: the requested executor.
 * - `costTier`: optional override; otherwise derived from the model id.
 * - `allowFlashReview`, `allowPremium`: explicit confirmations; a gate is only
 *   bypassed when the matching one is `true`.
 * - `pickReason`: justification required for a premium review.
 * - `checkReviewAdapter`: `false` skips the adapter guarantee (already checked
 *   by the caller); `reviewAdapter` injects a precomputed decision for tests.
 *
 * The measured high-infra rule is enforced by `model_pick`'s candidate
 * ordering (see `high_infra_risk` / `allowHighInfra`), not here: a deliberately
 * named executor is itself the explicit exception, and a review's "no VERDICT"
 * rows legitimately count as infra in the outcome aggregate.
 *
 * Callers that also hold favorites / lockout / quota / exclusion / MCP data
 * pass it to `evaluateDelegationStartHardGates` (or directly to
 * `evaluateModelPickHardGates`); this narrow façade only carries the start-time
 * confirmation gates and keeps the historical response shape.
 *
 * @param {{
 *   role?: unknown,
 *   assignment?: unknown,
 *   executionMode?: unknown,
 *   harness?: unknown,
 *   model?: unknown,
 *   costTier?: unknown,
 *   sourceKind?: unknown,
 *   allowFlashReview?: unknown,
 *   allowPremium?: unknown,
 *   pickReason?: unknown,
 *   checkReviewAdapter?: unknown,
 *   reviewAdapter?: unknown,
 * }} [input]
 * @returns {{ ok: true, role: string, costTier: number, reviewUncertified: boolean } | { ok: false, status: number, code: string, error: string, reason?: string, capabilities?: object, reviewUncertified?: boolean }}
 */
export function evaluateDelegationModelGate(input = {}) {
  return evaluateDelegationStartHardGates({
    role: input.role,
    assignment: input.assignment,
    executionMode: input.executionMode,
    harness: input.harness,
    model: input.model,
    costTier: input.costTier,
    sourceKind: input.sourceKind,
    allowFlashReview: input.allowFlashReview,
    allowPremium: input.allowPremium,
    pickReason: input.pickReason,
    checkReviewAdapter: input.checkReviewAdapter,
    reviewAdapter: input.reviewAdapter,
  });
}
