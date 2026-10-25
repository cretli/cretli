/**
 * Server-side classification of the WORK role a delegation performs, separate
 * from the review subject. It decides which session-continuation switch
 * applies (`continue_plan_sessions`, `continue_implement_sessions`,
 * `continue_fix_sessions`, or the reviewer policy for reviews) and which earlier
 * chats may be re-entered.
 *
 * `plan` means PLAN AUTHORING: an explicit `requested_role=plan` start whose
 * assignment is explicitly `implement` (read-only plan execution mode, writes
 * the plan through the controller). A plan REVIEW is `review` + subject `plan`;
 * the bare alias `assignment=plan` is not classified as authoring because the
 * legacy normalization folds it into a plan review. Rows persisted before this
 * field existed carry no `workRole` and are never eligible reuse sources.
 */

/** @typedef {import('./shared-types/persist-records.js').DelegationRecord} DelegationRecord */

export const DELEGATION_WORK_ROLES = Object.freeze(['plan', 'implement', 'fix', 'review_plan', 'review_code', 'review_other']);

/** Roles whose reuse is governed by the three work switches. */
export const WORK_SWITCH_FIELDS = Object.freeze({
  plan: 'continue_plan_sessions',
  implement: 'continue_implement_sessions',
  fix: 'continue_fix_sessions',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * @param {{ rawAssignment?: unknown, assignment?: unknown, requestedRole?: unknown, reviewSubject?: unknown }} input
 * `rawAssignment` is the caller's value before normalization; `assignment` the
 * normalized one (`implement` | `review`).
 * @returns {string} one of DELEGATION_WORK_ROLES
 */
export function classifyDelegationWorkRole(input = {}) {
  const assignment = lower(input.assignment);
  const raw = lower(input.rawAssignment);
  const requestedRole = lower(input.requestedRole);
  if (assignment === 'review') {
    const subject = lower(input.reviewSubject);
    return subject === 'plan' ? 'review_plan' : subject === 'code' ? 'review_code' : 'review_other';
  }
  if (requestedRole === 'fix' || raw === 'fix') return 'fix';
  if (requestedRole === 'plan' && raw === 'implement') return 'plan';
  if (assignment === 'implement') return 'implement';
  return '';
}

/**
 * Work role of a stored row; '' for rows written before classification existed.
 *
 * @param {Partial<DelegationRecord> | null | undefined} row
 * @returns {string}
 */
export function readRowWorkRole(row) {
  const role = lower(row?.workRole);
  return DELEGATION_WORK_ROLES.includes(role) ? role : '';
}

/**
 * Source roles a start of `role` may re-enter. implement→fix is the only
 * cross-role edge and is only valid inside one leaf (enforced by the gate).
 *
 * @param {string} role
 * @returns {string[]}
 */
export function allowedResumeSourceRoles(role) {
  if (role === 'plan') return ['plan'];
  if (role === 'implement') return ['implement'];
  if (role === 'fix') return ['fix', 'implement'];
  return [];
}

/**
 * Roles that may share one executor chat when `continue_cross_role_sessions`
 * is on: code review and implement/fix. Plan authoring, plan review and
 * `review_other` never cross roles.
 */
export const CROSS_ROLE_SESSION_ROLES = Object.freeze(['review_code', 'implement', 'fix']);

/**
 * True when a start of `startRole` re-entering a `sourceRole` chat changes role
 * between code review and implement/fix (either direction).
 *
 * @param {string} startRole
 * @param {string} sourceRole
 * @returns {boolean}
 */
export function isCrossRoleSessionPair(startRole, sourceRole) {
  const isWork = (/** @type {string} */ role) => role === 'implement' || role === 'fix';
  return (startRole === 'review_code' && isWork(sourceRole))
    || (isWork(startRole) && sourceRole === 'review_code');
}

/**
 * @param {string} role
 * @returns {boolean} true for the roles governed by the three work switches
 */
export function isWorkContinuationRole(role) {
  return Object.prototype.hasOwnProperty.call(WORK_SWITCH_FIELDS, role);
}

/**
 * @param {Partial<DelegationRecord> | null | undefined} row
 * @returns {boolean}
 */
export function isPlanAuthoringDelegationRow(row) {
  return readRowWorkRole(row) === 'plan';
}

/**
 * Implementation evidence excludes explicit planner rows even though their
 * durable assignment remains `implement` for backward-compatible APIs.
 * Legacy rows without a work role keep the historical assignment semantics.
 *
 * @param {Partial<DelegationRecord> | null | undefined} row
 * @returns {boolean}
 */
export function isImplementationWorkDelegationRow(row) {
  const role = readRowWorkRole(row);
  if (role) return role === 'implement' || role === 'fix';
  const assignment = lower(row?.assignment);
  return lower(row?.pickRole) === 'fix' || assignment === 'implement' || assignment === 'fix';
}

/**
 * Runtime adapters already enforce a certified read-only profile for review.
 * A planner uses that profile without becoming a review record or subject.
 *
 * @param {Partial<DelegationRecord> | null | undefined} row
 * @returns {string}
 */
export function delegationRuntimeAssignment(row) {
  return isPlanAuthoringDelegationRow(row) ? 'review' : lower(row?.assignment);
}
