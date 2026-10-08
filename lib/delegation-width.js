/**
 * Parent-chat width for concurrent delegations (review fanout, not an executor pool).
 */

import { readEnvAlias } from './env-alias.js';
import { normalizeDelegationAssignment } from './delegation-assignment.js';

export const DELEGATION_REVIEW_FANOUT_MAX = 2;
const EXCLUSIVE_ERROR = 'Another execution job is already running for this chat.';
const FANOUT_FULL_ERROR = 'Two review jobs are already running for this chat.';

/**
 * Parent-width conflicts on the SAME parent are queued instead of returning a
 * hard 409: the job is waiting on its own parent's slot, not on a foreign
 * workspace lock or a process-wide cap. `workspace_busy` and `global_limit`
 * stay hard rejections and must never appear here.
 */
const QUEUEABLE_CONFLICT_CODES = Object.freeze([
  'active_delegation_exists',
  'parent_busy',
  'review_fanout_full',
]);

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isQueueableDelegationConflict(code) {
  return QUEUEABLE_CONFLICT_CODES.includes(String(code || '').trim());
}

/**
 * Per-parent queued depth cap. Beyond it a start is refused with `queue_full`.
 * Default 8.
 *
 * @returns {number}
 */
export function readDelegationQueueMax() {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_QUEUE_MAX',
    defaultValue: '8',
  });
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 8;
  return parsed;
}

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
 *   ignoreQueued?: boolean,
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
  let active = Array.isArray(input?.active) ? input.active : [];
  if (input?.ignoreQueued === true) {
    active = active.filter((row) => String(row?.status || '') !== 'queued');
  }
  const others = active.filter((row) => {
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
