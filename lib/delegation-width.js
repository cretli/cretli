/**
 * Parent-chat width for concurrent delegations (review fanout, not an executor pool).
 */

import { readEnvAlias } from './env-alias.js';
import { normalizeDelegationAssignment } from './delegation-assignment.js';

export const DELEGATION_REVIEW_FANOUT_MAX = 2;
const EXCLUSIVE_ERROR = 'Another execution job is already running for this chat.';
const FANOUT_FULL_ERROR = 'Two review jobs are already running for this chat.';

/**
 * Review concurrency. Default 2 (cap). Exact trimmed '1' opts out to one child.
 *
 * @returns {number}
 */
export function readDelegationReviewFanout() {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_REVIEW_FANOUT',
    defaultValue: '2',
  });
  return String(raw).trim() === '1' ? 1 : 2;
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isReviewDelegationRow(row) {
  return normalizeDelegationAssignment(row?.assignment, row?.executionMode) === 'review';
}

/**
 * Same predicate for createAndStart and retry. Resume of the same job is exempt.
 *
 * @param {{
 *   active?: object[],
 *   incomingAssignment?: unknown,
 *   resumeDelegationId?: unknown,
 *   gate?: 'start' | 'retry',
 *   fanout?: number,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   error?: string,
 *   blocker?: object,
 * }}
 */
export function resolveDelegationParentWidth(input) {
  const resumeId = String(input?.resumeDelegationId || '').trim();
  const others = (Array.isArray(input?.active) ? input.active : []).filter((row) => {
    if (!resumeId) return true;
    return String(row?.id || '').trim() !== resumeId;
  });
  if (others.length === 0) return { ok: true };
  const exclusiveCode = input?.gate === 'retry' ? 'parent_busy' : 'active_delegation_exists';
  const incomingReview = normalizeDelegationAssignment(input?.incomingAssignment, 'agent') === 'review';
  const implementBlocker = others.find((row) => !isReviewDelegationRow(row));
  if (implementBlocker) {
    return { ok: false, code: exclusiveCode, error: EXCLUSIVE_ERROR, blocker: implementBlocker };
  }
  if (!incomingReview) {
    return { ok: false, code: exclusiveCode, error: EXCLUSIVE_ERROR, blocker: others[0] };
  }
  const fanout = Number.isFinite(input?.fanout) ? Number(input.fanout) : readDelegationReviewFanout();
  if (others.length < fanout) return { ok: true };
  if (fanout > 1) {
    return {
      ok: false,
      code: 'review_fanout_full',
      error: FANOUT_FULL_ERROR,
      blocker: others[0],
    };
  }
  return { ok: false, code: exclusiveCode, error: EXCLUSIVE_ERROR, blocker: others[0] };
}
