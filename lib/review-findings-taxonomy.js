/**
 * Review findings taxonomy: categories, outcomes and the feature flag.
 *
 * The findings block is an additive, machine-readable companion to the prose
 * review report; prose stays authoritative for the verdict.
 */

export const REVIEW_FINDING_CATEGORIES = Object.freeze([
  'missing-test',
  'test-weak',
  'docs-not-updated',
  'caller-not-updated',
  'contract-violation',
  'error-handling',
  'concurrency-race',
  'security',
  'i18n',
  'style-convention',
  'scope-creep',
  'perf',
  'other',
]);

/** Final state of one finding in the durable ledger (`open` while undecided). */
export const REVIEW_FINDING_OUTCOMES = Object.freeze([
  'open',
  'fixed',
  'still_open_at_stop',
  'rejected',
  'out_of_scope',
  'follow_up',
  'unlinked',
]);

export const REVIEW_FINDING_REJECT_REASONS = Object.freeze([
  'false_positive',
  'wont_fix',
  'duplicate',
  'out_of_scope_elsewhere',
]);

export const REVIEW_FINDING_PRIORITIES = Object.freeze(['P1', 'P2', 'P3']);

/** Statuses a findings block entry may carry. */
export const REVIEW_FINDING_STATUSES = Object.freeze([
  'NEW',
  'FIXED',
  'STILL_OPEN',
  'REGRESSION',
  'OUT_OF_SCOPE',
  'FOLLOW_UP',
]);

export const REVIEW_FINDINGS_BLOCK_ENV = 'CRETLI_REVIEW_FINDINGS_BLOCK';

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean} default on; `0` / `false` / `off` restores the legacy prompts
 */
export function isReviewFindingsBlockEnabled(env = process.env) {
  const raw = String(env?.[REVIEW_FINDINGS_BLOCK_ENV] ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/**
 * @param {unknown} value
 * @returns {string} a taxonomy category (`other` for anything unknown)
 */
export function normalizeReviewFindingCategory(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  return REVIEW_FINDING_CATEGORIES.includes(raw) ? raw : 'other';
}

/**
 * @param {unknown} value
 * @returns {string} `P1` | `P2` | `P3` or an empty string
 */
export function normalizeReviewFindingPriority(value) {
  const raw = String(value || '').trim().toUpperCase();
  return REVIEW_FINDING_PRIORITIES.includes(raw) ? raw : '';
}

/**
 * @param {unknown} value
 * @returns {string} a reject reason or an empty string
 */
export function normalizeReviewFindingRejectReason(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return REVIEW_FINDING_REJECT_REASONS.includes(raw) ? raw : '';
}
