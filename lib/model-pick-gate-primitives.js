/**
 * Low-level, dependency-light primitives shared by every model-selection gate.
 *
 * The shared hard-gate validator (`model-pick-hard-gates.js`) needs the role
 * vocabulary, the flash/role predicates and the active-lockout predicate. The
 * normal picker (`model-role-profiles.js`) needs the exact same definitions and
 * now also consumes the validator. Keeping the primitives in this standalone
 * module breaks the would-be import cycle
 * `hard-gates -> role-profiles -> hard-gates`: both sides depend on this leaf,
 * and `model-role-profiles.js` re-exports every name so existing imports keep
 * working unchanged.
 *
 * Nothing here ranks or scores a candidate; these are pure predicates.
 */

import { decodeModelValue } from './model-catalog.js';
import { canonicalizeClaudeModelId } from './claude/claude-models.ts';
import { isFlashModelFamily } from './model-alias-policy.js';

/**
 * @typedef {{ harness?: unknown, model?: unknown, resetAt?: unknown }} ModelPickLockoutRow
 */

/** Roles the picker and every start gate understand. */
export const MODEL_PICK_ROLES = Object.freeze(['plan', 'implement', 'review', 'fix']);

/**
 * Relative cost tier at/above which a review pick counts as "premium". The
 * cost tier is a heuristic, not a price; it is used only to require an explicit
 * justification on a review start and to annotate the pick reason.
 *
 * This is NOT a global concurrency limit: general parallelism caps stay in the
 * existing admission / slot path and apply regardless of the cost tier. A
 * premium review start is gated on a reason here, never on how many other runs
 * are in flight.
 */
export const PREMIUM_REVIEW_COST_TIER = 4;

/**
 * A premium pick is justified when the caller supplied a substantive reason.
 * Kept deliberately short so any non-trivial human/model justification passes;
 * an empty or whitespace-only `pick_reason` does not.
 *
 * @param {unknown} pickReason
 * @returns {boolean}
 */
export function hasPremiumPickJustification(pickReason) {
  return String(pickReason || '').trim().length >= 12;
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
  // A Claude moving alias (`sonnet`) is the same model as the numbered id it
  // resolves to; non-Claude ids pass through canonicalization unchanged.
  const left = canonicalizeClaudeModelId(decodeModelValue(id).modelId);
  const right = canonicalizeClaudeModelId(decodeModelValue(exclude).modelId);
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
 * Flash ids are too short-lived for **autonomous** review (quiet-stop /
 * first-event timeout). Implement and fix may still pick them, and a model the
 * user named themselves stays the exception in `named` mode — the picker is
 * automatic by contract, so this filter never reaches a named start, while the
 * adapter guarantees keep applying there.
 *
 * The class comes from the verified `flash` family (aliases `flash`, `flashx`),
 * matched on name boundaries: `glm-5.3-flashx` is flash, `flashlight-9b` is not.
 *
 * @param {string} modelValue
 * @returns {boolean}
 */
export function isFlashDelegationModel(modelValue) {
  return isFlashModelFamily(modelValue);
}

/**
 * Active lockout row for one harness/model pair (base-model aware). A
 * harness-wide row (empty `model`) blocks every model of that harness; a
 * `harness:model` row blocks that model and its base id. An expired row never
 * blocks.
 *
 * @param {ModelPickLockoutRow[]} lockouts
 * @param {string} harnessId
 * @param {string} modelId
 * @param {number} now
 * @returns {boolean}
 */
/**
 * @param {ModelPickLockoutRow[]} lockouts
 * @param {string} harnessId
 * @param {string} modelId
 * @param {number} now
 * @returns {ModelPickLockoutRow | null}
 */
export function findActiveLockoutRow(lockouts, harnessId, modelId, now) {
  const full = String(modelId || '').trim().toLowerCase();
  const base = decodeModelValue(modelId).modelId.toLowerCase();
  /** @type {ModelPickLockoutRow | null} */
  let best = null;
  for (const row of Array.isArray(lockouts) ? lockouts : []) {
    if (String(row?.harness || '').trim().toLowerCase() !== harnessId) continue;
    const resetAt = Date.parse(String(row?.resetAt || ''));
    if (Number.isFinite(resetAt) && resetAt <= now) continue;
    const limited = String(row?.model || '').trim().toLowerCase();
    const matches = !limited || limited === full || limited === base;
    if (!matches) continue;
    if (!best) {
      best = row;
      continue;
    }
    const bestReset = Date.parse(String(best.resetAt || ''));
    if (Number.isFinite(resetAt) && (!Number.isFinite(bestReset) || resetAt < bestReset)) {
      best = row;
    }
  }
  return best;
}

export function hasActiveLockout(lockouts, harnessId, modelId, now) {
  return findActiveLockoutRow(lockouts, harnessId, modelId, now) != null;
}
