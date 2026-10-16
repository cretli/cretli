/**
 * Structured classification of a failed delegation's error text
 * (`docs/model-pick-decisions.md`, "Failure classes and exclusion scope").
 *
 * The class decides how wide an exclusion may be and whether a bounded
 * fallback makes sense. It never creates a lockout by itself: the shared
 * lockout store in `harness-usage-limits.js` stays the only blacklist, and
 * `unknown` failures never become an exclusion at all.
 */

import { isDelegationStartupFailure } from './delegation-startup-failure.js';
import {
  isAccountWideUsageLimitHarness,
  isInsufficientBalanceMessage,
  isModelUnavailableMessage,
  isUsageLimitMessage,
} from './harness-usage-limits.js';

/** Failure classes, in classification priority order. */
export const DELEGATION_FAILURE_CLASSES = Object.freeze([
  'quota',
  'model_unavailable',
  'auth',
  'harness_outage',
  'transient_transport',
  'unknown',
]);

/** Exclusion scopes a class may justify. */
export const DELEGATION_FAILURE_SCOPES = Object.freeze({
  workspaceModel: 'workspace+model',
  model: 'model',
  harness: 'harness',
  workspaceHarness: 'workspace+harness',
  none: 'none',
});

const AUTH_PATTERN = /\b(?:unauthori[sz]ed|invalid\s+api[\s_-]*key|authentication\s+(?:failed|required|error)|not\s+logged\s+in|login\s+required|please\s+(?:log\s*in|sign\s*in)|(?:\bHTTP(?:\/\d(?:\.\d)?)?|\bstatus(?:\s+code)?)\s*[:=]?\s*401\b)/i;
const HARNESS_OUTAGE_PATTERN = /\b(?:executable\s+not\s+found|failed\s+to\s+(?:start|spawn)\s+(?:the\s+)?(?:harness|adapter|cli)|adapter\s+(?:failed\s+to\s+start|not\s+found)|cli\s+is\s+not\s+installed|harness\s+(?:is\s+)?(?:disabled|unavailable|not\s+installed))\b/i;

/**
 * @param {{ error?: unknown, errors?: unknown[] }} input
 * @returns {string}
 */
function collectText(input) {
  const parts = [String(input?.error || '').trim()];
  for (const entry of Array.isArray(input?.errors) ? input.errors : []) {
    if (typeof entry === 'string') parts.push(entry);
    else if (entry && typeof entry === 'object') {
      parts.push(String(entry.code || ''), String(entry.message || ''));
    }
  }
  return parts.map((part) => part.trim()).filter(Boolean).join('\n');
}

/**
 * @param {{ error?: unknown, errors?: unknown[], status?: unknown }} input
 * @returns {{
 *   failureClass: 'quota' | 'model_unavailable' | 'auth' | 'harness_outage' | 'transient_transport' | 'unknown',
 *   scope: string,
 *   retryable: boolean,
 *   harnessWide: boolean,
 * }}
 */
export function classifyDelegationFailure(input = {}) {
  const text = collectText(input);
  const make = (failureClass, scope, extras = {}) => ({
    failureClass,
    scope,
    retryable: false,
    harnessWide: scope === DELEGATION_FAILURE_SCOPES.harness || scope === DELEGATION_FAILURE_SCOPES.workspaceHarness,
    ...extras,
  });
  if (!text) return make('unknown', DELEGATION_FAILURE_SCOPES.none);
  if (isUsageLimitMessage(text)) {
    // Credit exhaustion blocks the whole account; a rate window is per model.
    // Codex plan windows are account-wide too, so a Codex limit is harness-wide.
    return make(
      'quota',
      isInsufficientBalanceMessage(text) || isAccountWideUsageLimitHarness(input.harness)
        ? DELEGATION_FAILURE_SCOPES.harness
        : DELEGATION_FAILURE_SCOPES.model,
    );
  }
  if (isModelUnavailableMessage(text)) return make('model_unavailable', DELEGATION_FAILURE_SCOPES.workspaceModel);
  if (AUTH_PATTERN.test(text)) return make('auth', DELEGATION_FAILURE_SCOPES.workspaceHarness);
  if (HARNESS_OUTAGE_PATTERN.test(text)) return make('harness_outage', DELEGATION_FAILURE_SCOPES.workspaceHarness);
  if (isDelegationStartupFailure(input)) {
    return make('transient_transport', DELEGATION_FAILURE_SCOPES.workspaceModel, { retryable: true });
  }
  return make('unknown', DELEGATION_FAILURE_SCOPES.none);
}
