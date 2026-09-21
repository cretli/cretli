/**
 * Delegation assignment / child execution mode (browser-safe, no Node crypto).
 */

import { normalizeSdkMode } from './sdk/sdk-mode.js';

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
