/**
 * Classify delegation executor startup failures (infra transport/startup only).
 */

import { DELEGATION_ADAPTER_TIMEOUT_CODE } from './delegation-adapter-error.js';
import { isUsageLimitMessage } from './harness-usage-limits.js';

export {
  STARTUP_FAILURE_LOCKOUT_CODE,
  isStartupFailureLockoutCode,
  isStartupFailureLockoutRow,
  resolveOpenCodeDelegatedFirstEventTimeoutMs,
  resolveStartupFailureEscalationWindowMs,
  resolveStartupFailureExtendedLockoutMs,
  resolveStartupFailureLockoutDurationMs,
  resolveStartupFailureLockoutMs,
  resolveStartupRetryCount,
  resolveStartupRetryDelayMs,
} from './delegation-startup-lockout-policy.js';

/**
 * @param {unknown} message
 * @returns {boolean}
 */
export function isTransportNotStartedMessage(message) {
  return /transport not started/i.test(String(message || ''));
}

/** OpenCode (and similar) first-event wait timeout — not post-start prompt idle timeout. */
const DELEGATION_FIRST_EVENT_TIMEOUT_PATTERN = /first event timed out/i;

/**
 * @param {unknown} message
 * @returns {boolean}
 */
export function isDelegationFirstEventTimeoutEvidence(message) {
  return DELEGATION_FIRST_EVENT_TIMEOUT_PATTERN.test(String(message || ''));
}

/**
 * @param {{ error?: unknown, errors?: unknown[] }} input
 * @returns {string}
 */
function collectStartupFailureErrorText(input) {
  /** @type {string[]} */
  const parts = [];
  const direct = String(input?.error || '').trim();
  if (direct) parts.push(direct);
  for (const entry of Array.isArray(input?.errors) ? input.errors : []) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      parts.push(entry.trim());
      continue;
    }
    if (typeof entry !== 'object') continue;
    const code = String(entry.code || '').trim();
    const message = String(entry.message || '').trim();
    if (code) parts.push(code);
    if (message) parts.push(message);
  }
  return parts.join('\n');
}

/**
 * @param {{ error?: unknown, errors?: unknown[], status?: unknown }} input
 * @returns {boolean}
 */
export function isDelegationStartupFailure(input) {
  if (String(input?.status || '').trim().toLowerCase() === 'cancelled') return false;
  const text = collectStartupFailureErrorText(input);
  if (!text) return false;
  if (isUsageLimitMessage(text)) return false;
  if (isTransportNotStartedMessage(text)) return true;
  if (isDelegationFirstEventTimeoutEvidence(text)) return true;
  const directError = String(input?.error || '').trim();
  if (
    directError.includes(`[${DELEGATION_ADAPTER_TIMEOUT_CODE}]`)
    && isDelegationFirstEventTimeoutEvidence(directError)
  ) {
    return true;
  }
  for (const entry of Array.isArray(input?.errors) ? input.errors : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.code || '').trim() !== DELEGATION_ADAPTER_TIMEOUT_CODE) continue;
    if (isDelegationFirstEventTimeoutEvidence(entry.message)) return true;
  }
  return false;
}
