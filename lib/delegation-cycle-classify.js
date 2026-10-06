/**
 * Terminal outcome classification for cycle metrics (infra vs quality vs cancel).
 */

export { delegationPersistedRole } from './model-pick-history.js';
import { delegationPersistedRole } from './model-pick-history.js';
import { isUsageLimitMessage } from './harness-usage-limits.js';
import { isIncompleteDelegationReport, parseDelegationVerdict } from './delegation-verdict.js';

const INFRA_ERROR_PATTERNS = Object.freeze([
  /adapter_incomplete/i,
  /timed?\s*out|timeout/i,
  /server restarted|run was lost|grace period|inactive context/i,
  /aborted/i,
  /exited with code/i,
  /no payment method|insufficient balance|subscription plan does not/i,
  /ai model not found|invalid parameters for registry model/i,
]);

/**
 * @param {object} row
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
 * @param {object} row
 * @returns {boolean}
 */
export function isUserCancelledDelegation(row) {
  return String(row?.status || '').trim().toLowerCase() === 'cancelled';
}

/**
 * @param {object} row
 * @param {'plan' | 'implement' | 'review' | ''} role
 * @returns {boolean}
 */
export function isInfraDelegationOutcomeForCycle(row, role) {
  if (isUserCancelledDelegation(row)) return false;
  const error = delegationErrorText(row);
  const report = String(row?.report || '');
  const status = String(row?.status || '').trim().toLowerCase();
  if (isUsageLimitMessage(error)) return true;
  if (INFRA_ERROR_PATTERNS.some((pattern) => pattern.test(error))) return true;
  const meaningful = report.trim().length > 0 && !isIncompleteDelegationReport(report);
  if (['failed', 'interrupted'].includes(status) && !meaningful) return true;
  if (role === 'review') {
    if (!meaningful) return true;
    const verdict = parseDelegationVerdict(report);
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
 * @param {object} row
 * @returns {'plan' | 'implement' | 'review' | 'fix' | ''}
 */
export function delegationCycleRole(row) {
  const explicit = String(row?.pickRole || '').trim().toLowerCase();
  if (explicit === 'fix' || explicit === 'implement' || explicit === 'review' || explicit === 'plan') {
    return explicit;
  }
  return delegationPersistedRole(row);
}

/**
 * @param {object} row
 * @returns {boolean}
 */
export function resolveDelegationTechnicalSuccess(row) {
  const role = delegationPersistedRole(row);
  if (String(row?.status || '').trim().toLowerCase() !== 'completed') return false;
  return !isInfraDelegationOutcomeForCycle(row, role);
}
