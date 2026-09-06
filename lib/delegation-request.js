/**
 * Canonical request identity for delegated jobs (idempotency + replay).
 */

import { createHash } from 'crypto';
import { normalizeAgentTransport } from './agent-transport.js';
import { normalizeSdkMode } from './sdk/sdk-mode.js';

/**
 * @param {unknown} value
 * @returns {'plan' | 'message' | 'text'}
 */
export function normalizeDelegationSourceKind(value) {
  const raw = String(value || '').trim();
  if (raw === 'message' || raw === 'text') return raw;
  return 'plan';
}

/**
 * @param {unknown} row
 * @returns {boolean}
 */
export function isPlanDelegationSource(row) {
  const kind = String(row?.sourceKind || '').trim();
  return kind === '' || kind === 'plan';
}

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
 * @param {string} text
 * @returns {string}
 */
export function hashDelegationContent(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * @param {{
 *   parentChatId?: unknown,
 *   sourceKind?: unknown,
 *   sourceHistorySeq?: unknown,
 *   planRevision?: unknown,
 *   sourceHash?: unknown,
 *   harness?: unknown,
 *   model?: unknown,
 *   executor?: { transport?: unknown, model?: unknown },
 *   executionMode?: unknown,
 *   extraInstructions?: unknown,
 * }} input
 * @returns {string}
 */
export function buildDelegationRequestHash(input) {
  const payload = {
    parentChatId: String(input?.parentChatId || '').trim(),
    sourceKind: normalizeDelegationSourceKind(input?.sourceKind),
    sourceHistorySeq: Number(input?.sourceHistorySeq) > 0 ? Number(input.sourceHistorySeq) : 0,
    planRevision: Number(input?.planRevision) > 0 ? Number(input.planRevision) : 0,
    sourceHash: String(input?.sourceHash || '').trim(),
    harness: normalizeAgentTransport(input?.harness || input?.executor?.transport),
    model: String(input?.model || input?.executor?.model || '').trim(),
    executionMode: normalizeDelegationExecutionMode(input?.executionMode),
    extraInstructions: String(input?.extraInstructions || '').trim(),
  };
  return hashDelegationContent(JSON.stringify(payload));
}
