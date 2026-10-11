/**
 * Review-subject vocabulary shared by the server and the front bundle
 * (`docs/todo-review-contract.md` §3).
 *
 * Kept separate from `lib/delegation-request.js` on purpose: that module imports
 * `node:crypto` for request hashing, and `delegation-request.js` is reachable
 * from `app_front` through `lib/delegation-attempt.js` → `lib/delegation-card-model.js`.
 * Moving the pure subject helpers here keeps the browser bundle free of a Node
 * core module while the server re-exports them from `delegation-request.js`.
 */

/** Review subjects. `code` and `plan` have separate snapshots; `other` is audit-only. */
export const DELEGATION_REVIEW_SUBJECTS = Object.freeze(['code', 'plan', 'other']);

/** How a subject got onto a job (`docs/todo-review-contract.md` §3.3, §3.2). */
export const DELEGATION_REVIEW_SUBJECT_SOURCES = Object.freeze(['explicit', 'default', 'unknown']);

/** @type {Set<string>} */
const DELEGATION_REVIEW_SUBJECT_SET = new Set(DELEGATION_REVIEW_SUBJECTS);
/** @type {Set<string>} */
const DELEGATION_REVIEW_SUBJECT_SOURCE_SET = new Set(DELEGATION_REVIEW_SUBJECT_SOURCES);

/**
 * Normalize a requested/stored review subject. An unrecognized value returns
 * `''` so callers choose between a default and `other` — it is never silently
 * treated as `code` (`docs/todo-review-contract.md` §3.2).
 *
 * @param {unknown} value
 * @returns {'code' | 'plan' | 'other' | ''}
 */
export function normalizeDelegationReviewSubject(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return DELEGATION_REVIEW_SUBJECT_SET.has(raw) ? /** @type {any} */ (raw) : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDelegationReviewSubject(value) {
  return DELEGATION_REVIEW_SUBJECT_SET.has(String(value ?? '').trim().toLowerCase());
}

/**
 * @param {unknown} value
 * @returns {'explicit' | 'default' | 'unknown' | ''}
 */
export function normalizeDelegationReviewSubjectSource(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return DELEGATION_REVIEW_SUBJECT_SOURCE_SET.has(raw) ? /** @type {any} */ (raw) : '';
}

/**
 * Resolve the subject of a review/implement start and how it was determined
 * (`docs/todo-review-contract.md` §3):
 *
 * - an explicit recognized value → `subjectSource: 'explicit'`;
 * - an unrecognized explicit value → `other` / `subjectSource: 'unknown'`;
 * - a missing value on a plan-mode review (`requestedRole: 'plan'` or
 *   `executionMode: 'plan'`) → `plan` / `subjectSource: 'default'`;
 * - any other missing value → `other` / `subjectSource: 'default'`.
 *
 * @param {{
 *   requested?: unknown,
 *   reviewSubject?: unknown,
 *   review_subject?: unknown,
 *   requestedRole?: unknown,
 *   assignment?: unknown,
 *   executionMode?: unknown,
 * }} [input]
 * @returns {{ subject: 'code' | 'plan' | 'other', source: 'explicit' | 'default' | 'unknown' }}
 */
export function resolveDelegationReviewSubject(input = {}) {
  const requested = String(
    input.requested ?? input.reviewSubject ?? input.review_subject ?? '',
  ).trim().toLowerCase();
  const explicit = normalizeDelegationReviewSubject(requested);
  if (explicit) return { subject: explicit, source: 'explicit' };
  if (requested) return { subject: 'other', source: 'unknown' };
  const assignment = String(input.assignment || '').trim().toLowerCase();
  const executionMode = String(input.executionMode || '').trim().toLowerCase();
  const requestedRole = String(input.requestedRole ?? input.requested_role ?? '').trim().toLowerCase();
  if (assignment === 'review' && (executionMode === 'plan' || requestedRole === 'plan')) {
    return { subject: 'plan', source: 'default' };
  }
  return { subject: 'other', source: 'default' };
}
