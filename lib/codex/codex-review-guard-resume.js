/**
 * Codex exec cannot reject one shell call and keep the same process alive.
 * Review still aborts that turn (the command may already be starting), then
 * queues a follow-up so the reviewer continues read-only instead of the job
 * ending as a user cancel.
 */

import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { REVIEW_GUARD_USER_MESSAGE } from '../sdk/sdk-guard-messages.js';

/** Two follow-ups, then a further denied command ends the review. */
export const CODEX_REVIEW_GUARD_RESUME_MAX = 2;

export const CODEX_REVIEW_GUARD_RESUME_DISPLAY =
  'Review denied one shell command. Continuing read-only.';

/**
 * @param {{ assignment?: unknown, resumesUsed?: unknown }} [input]
 * @returns {boolean}
 */
export function canResumeCodexReviewAfterGuard(input = {}) {
  if (!isReviewReadOnlyAssignment(input.assignment)) return false;
  const used = Number(input.resumesUsed);
  const resumesUsed = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
  return resumesUsed < CODEX_REVIEW_GUARD_RESUME_MAX;
}

/**
 * @returns {string}
 */
export function buildCodexReviewGuardResumePrompt() {
  return [
    REVIEW_GUARD_USER_MESSAGE,
    'Continue the review from the evidence you already have. Do not retry the denied command.',
  ].join('\n\n');
}
