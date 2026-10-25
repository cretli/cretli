/**
 * Terminal outcome classification for cycle metrics (infra vs quality vs cancel).
 */

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

export { delegationPersistedRole } from './model-pick-history.js';
import { delegationPersistedRole } from './model-pick-history.js';
import { isUsageLimitMessage } from './harness-usage-limits.js';
import { isIncompleteDelegationReport, isUsableDelegationVerdict, resolveDelegationRecordVerdict } from './delegation-verdict.js';
import { readRowWorkRole } from './delegation-work-role.js';

const INFRA_ERROR_PATTERNS = Object.freeze([
  /adapter_incomplete/i,
  /adapter_no_verdict/i,
  /timed?\s*out|timeout/i,
  /server restarted|run was lost|grace period|inactive context/i,
  /aborted/i,
  /exited with code/i,
  /no payment method|insufficient balance|subscription plan does not/i,
  /subscription (?:is )?required/i,
  /ai model not found|invalid parameters for registry model/i,
  // Provider-side 5xx (observed: `Status 503` + `unreachable_backend`); never 4xx.
  /\bStatus\s*5\d\d\b|unreachable_backend/i,
  // The attempt expired while queued for a storage/worker slot and never ran.
  /Storage request expired in queue/i,
]);

/**
 * @param {DelegationRecord} row
 * @returns {string}
 */
function delegationErrorText(row) {
  /** @type {string[]} */
  const parts = [];
  const direct = String(row?.error || '').trim();
  if (direct) parts.push(direct);
  for (const entry of Array.isArray(row?.errors) ? row.errors : []) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      parts.push(entry);
      continue;
    }
    if (typeof entry !== 'object') continue;
    const code = String(entry.code || '').trim();
    if (code === 'adapter_after_terminal') continue;
    const message = String(entry.message || '').trim();
    if (code) parts.push(code);
    if (message) parts.push(message);
  }
  return parts.join('\n');
}

/**
 * A `cancelled` terminal status is a deliberate cancel (user/parent request
 * through the cancel API). It is a cancel, not an infrastructure failure, so it
 * must never be counted as infra and the generic "aborted" error pattern must
 * not reclassify it either.
 *
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
export function isUserCancelledDelegation(row) {
  return String(row?.status || '').trim().toLowerCase() === 'cancelled';
}

/**
 * Structured-only infrastructure classification: terminal status, `taskOutcome`,
 * the `error` string and the structured `errors[]` — never the report body
 * (`docs/todo-review-contract.md` §5.3). The review snapshot uses this so a
 * persisted `reportVerdict` survives retention truncating the report body,
 * instead of being reclassified as infra because the body lost its VERDICT line.
 *
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
export function isStructuredInfraDelegationOutcome(row) {
  if (isUserCancelledDelegation(row)) return false;
  const error = delegationErrorText(row);
  if (isUsageLimitMessage(error)) return true;
  return INFRA_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

/**
 * @param {Record<string, any>} row
 * @param {'plan' | 'implement' | 'review' | ''} role
 * @returns {boolean}
 */
export function isInfraDelegationOutcomeForCycle(row, role) {
  if (isStructuredInfraDelegationOutcome(row)) return true;
  const report = String(row?.report || '');
  const status = String(row?.status || '').trim().toLowerCase();
  const verdict = resolveDelegationRecordVerdict(row);
  const meaningful = report.trim().length > 0
    && (isUsableDelegationVerdict(verdict) || !isIncompleteDelegationReport(report));
  if (['failed', 'interrupted'].includes(status) && !meaningful) return true;
  if (role === 'review') {
    if (!meaningful) return true;
    if (verdict === 'unspecified' || verdict === 'conflict') return true;
  }
  return false;
}

/**
 * Explicit role for cycle grouping. Prefers the role persisted on the record
 * (`pickRole`, written from the *requested* assignment before normalization) so
 * a real `fix` job stays a `fix` instead of being flattened into the legacy
 * shared implement/fix bucket. Legacy rows without that field fall back to the
 * assignment-derived role and are reported as `implement`, never guessed as fix.
 *
 * @param {Record<string, any>} row
 * @returns {'plan' | 'implement' | 'review' | 'fix' | ''}
 */
export function delegationCycleRole(row) {
  const workRole = readRowWorkRole(row);
  if (workRole === 'plan' || workRole === 'implement' || workRole === 'fix') return workRole;
  if (workRole.startsWith('review_')) return 'review';
  const explicit = String(row?.pickRole || '').trim().toLowerCase();
  if (explicit === 'fix' || explicit === 'implement' || explicit === 'review' || explicit === 'plan') {
    return explicit;
  }
  return delegationPersistedRole(row);
}

/**
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
export function resolveDelegationTechnicalSuccess(row) {
  const role = delegationPersistedRole(row);
  if (String(row?.status || '').trim().toLowerCase() !== 'completed') return false;
  return !isInfraDelegationOutcomeForCycle(row, role);
}
