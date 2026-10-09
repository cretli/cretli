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

/** Stable machine codes surfaced on a refused start (legacy names kept). */
export const DELEGATION_MODEL_GATE_CODES = Object.freeze({
  FLASH_REVIEW: 'flash_review_confirmation_required',
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
