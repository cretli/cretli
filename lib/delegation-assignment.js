/**
 * Delegation assignment / child execution mode (browser-safe, no Node crypto).
 */

import { normalizeSdkMode } from './sdk/sdk-mode.ts';

/**
 * Child run mode. Ask cannot execute a delegation.
 *
 * @param {unknown} value
 * @param {unknown} [fallback]
 * @returns {'plan' | 'agent'}
 */
export function normalizeDelegationExecutionMode(value, fallback = 'agent') {
  const explicit = String(value || '').trim().toLowerCase();
  if (explicit === 'plan' || explicit === 'agent') return explicit;
  const inherited = normalizeSdkMode(fallback);
  return inherited === 'plan' ? 'plan' : 'agent';
}

/**
 * What the child should do. Distinct from SDK mode: parent Agent is required
 * to start a job, but the child may still only review.
 *
 * @param {unknown} value
 * @param {unknown} [executionMode]
 * @returns {'review' | 'implement'}
 */
export function normalizeDelegationAssignment(value, executionMode = 'agent') {
  const explicit = String(value || '').trim().toLowerCase();
  if (explicit === 'review' || explicit === 'implement') return explicit;
  return normalizeDelegationExecutionMode(executionMode) === 'plan' ? 'review' : 'implement';
}

/**
 * Reconcile the explicit `assignment` with `requested_role` before the
 * assignment is normalized. Without this a bare `requested_role=review`
 * silently fell back to an implement (write-capable) start.
 *
 * Legacy `assignment=plan|fix` aliases are mapped first (plan -> review,
 * fix -> implement). `assignment=implement` + `requested_role=plan` (plan
 * authoring) and `assignment=review` + `requested_role=plan` (plan review)
 * stay valid.
 *
 * @param {{ assignment?: unknown, requestedRole?: unknown }} input
 * @returns {{ ok: boolean, assignment?: string, requestedRole?: string, code?: string, error?: string }}
 */
export function reconcileDelegationRoleAssignment(input) {
  const rawAssignment = String(input?.assignment || '').trim().toLowerCase();
  const requestedRole = String(input?.requestedRole || '').trim().toLowerCase();
  let assignment = rawAssignment;
  if (rawAssignment === 'plan') assignment = 'review';
  else if (rawAssignment === 'fix') assignment = 'implement';
  if (!assignment) {
    if (requestedRole === 'review') assignment = 'review';
    else if (requestedRole === 'implement' || requestedRole === 'fix') assignment = 'implement';
    else if (requestedRole === 'plan') {
      return {
        ok: false,
        code: 'requested_role_requires_assignment',
        error: 'requested_role=plan is ambiguous without assignment: use assignment=implement for plan authoring or assignment=review for a plan review.',
      };
    }
  } else if (
    (requestedRole === 'review' && assignment !== 'review')
    || ((requestedRole === 'implement' || requestedRole === 'fix') && assignment === 'review')
  ) {
    return {
      ok: false,
      code: 'requested_role_conflict',
      error: `requested_role=${requestedRole} contradicts assignment=${rawAssignment}.`,
    };
  }
  return { ok: true, assignment, requestedRole };
}
