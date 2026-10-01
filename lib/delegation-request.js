/**
 * Canonical request identity for delegated jobs (idempotency + replay).
 */

import { createHash } from 'crypto';
import { normalizeAgentTransport } from './agent-transport.js';
import {
  normalizeDelegationAssignment,
  normalizeDelegationExecutionMode,
} from './delegation-assignment.js';

export {
  normalizeDelegationAssignment,
  normalizeDelegationExecutionMode,
};

/**
 * Upper bound for the optional `pickReason` carried by a delegation start. The
 * value is a short, human-readable justification produced by `model_pick`
 * (score/rotation/observed context); it is stored verbatim for the card and
 * must not become an unbounded blob.
 */
export const MAX_DELEGATION_PICK_REASON_LENGTH = 500;

/**
 * Trim an optional pick reason. Persisting is best-effort: a missing value
 * stays an empty string so old callers and pre-existing records keep working.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDelegationPickReason(value) {
  return String(value || '').trim();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDelegationPickReasonTooLong(value) {
  return normalizeDelegationPickReason(value).length > MAX_DELEGATION_PICK_REASON_LENGTH;
}

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
 * Resolve the SDK mode used by a child. A review needs to inspect a workspace
 * with the normal read-capable agent tool surface; SDK Plan mode can cancel a
 * DeepSeek turn when it probes the repository through shell tools. The
 * assignment remains review, so the executor prompt still forbids edits.
 *
 * @param {unknown} value
 * @param {unknown} assignment
 * @param {unknown} [fallback]
 * @returns {'plan' | 'agent'}
 */
export function resolveDelegationChildExecutionMode(value, assignment, fallback = 'agent') {
  const mode = normalizeDelegationExecutionMode(value, fallback);
  const intent = normalizeDelegationAssignment(assignment, mode);
  return intent === 'review' ? 'agent' : mode;
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
 *   assignment?: unknown,
 *   extraInstructions?: unknown,
 * }} input
 * @returns {string}
 */
export function buildDelegationRequestHash(input) {
  const assignment = normalizeDelegationAssignment(input?.assignment, input?.executionMode);
  const executionMode = resolveDelegationChildExecutionMode(input?.executionMode, assignment);
  const payload = {
    parentChatId: String(input?.parentChatId || '').trim(),
    sourceKind: normalizeDelegationSourceKind(input?.sourceKind),
    sourceHistorySeq: Number(input?.sourceHistorySeq) > 0 ? Number(input.sourceHistorySeq) : 0,
    planRevision: Number(input?.planRevision) > 0 ? Number(input.planRevision) : 0,
    sourceHash: String(input?.sourceHash || '').trim(),
    harness: normalizeAgentTransport(input?.harness || input?.executor?.transport),
    model: String(input?.model || input?.executor?.model || '').trim(),
    executionMode,
    assignment,
    extraInstructions: String(input?.extraInstructions || '').trim(),
  };
  return hashDelegationContent(JSON.stringify(payload));
}
