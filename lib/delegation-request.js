/**
 * Canonical request identity for delegated jobs (idempotency + replay).
 */

import { createHash } from 'crypto';
import { normalizeAgentTransport } from './agent-transport.js';
import {
  normalizeDelegationAssignment,
  normalizeDelegationExecutionMode,
} from './delegation-assignment.js';
// The pure review-subject vocabulary lives in a `node:crypto`-free module so the
// front bundle never pulls `crypto` through `lib/delegation-attempt.js`. It is
// re-exported here to keep the existing server import sites unchanged.
import {
  DELEGATION_REVIEW_SUBJECTS,
  DELEGATION_REVIEW_SUBJECT_SOURCES,
  isDelegationReviewSubject,
  normalizeDelegationReviewSubject,
  normalizeDelegationReviewSubjectSource,
  resolveDelegationReviewSubject,
} from './delegation-review-subject.js';

export {
  normalizeDelegationAssignment,
  normalizeDelegationExecutionMode,
  DELEGATION_REVIEW_SUBJECTS,
  DELEGATION_REVIEW_SUBJECT_SOURCES,
  isDelegationReviewSubject,
  normalizeDelegationReviewSubject,
  normalizeDelegationReviewSubjectSource,
  resolveDelegationReviewSubject,
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
 * @param {{ sourceKind?: unknown } | null | undefined} row
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
 * Plan mode is an explicit choice: an executor (implement/fix) child never
 * inherits the parent's Plan mode through `fallback`. Only a request that names
 * `plan` keeps the child read-only, so a plan-mode parent cannot hand an
 * implementation job to a chat that is unable to write.
 *
 * @param {unknown} value
 * @param {unknown} assignment
 * @param {unknown} [fallback]
 * @returns {'plan' | 'agent'}
 */
export function resolveDelegationChildExecutionMode(value, assignment, fallback = 'agent') {
  const explicit = String(value || '').trim().toLowerCase();
  const mode = normalizeDelegationExecutionMode(value, fallback);
  const intent = normalizeDelegationAssignment(assignment, mode);
  if (intent === 'review') return 'agent';
  return explicit === 'plan' ? 'plan' : 'agent';
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
 *   workRole?: unknown,
 *   extraInstructions?: unknown,
 *   allowChildDelegations?: unknown,
 *   [key: string]: any,
 * }} input
 * @returns {string}
 */
export function buildDelegationRequestHash(input) {
  const assignment = normalizeDelegationAssignment(input?.assignment, input?.executionMode);
  const executionMode = resolveDelegationChildExecutionMode(input?.executionMode, assignment);
  /** @type {Record<string, unknown>} */
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
  // Only a true grant enters the payload so pre-existing hashes stay valid.
  if (input?.allowChildDelegations === true) payload.allowChildDelegations = true;
  const workRole = String(input?.workRole || '').trim().toLowerCase();
  if (workRole) payload.workRole = workRole;
  return hashDelegationContent(JSON.stringify(payload));
}
