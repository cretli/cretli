/**
 * Snapshot helpers for delegation attempts.
 */

import { DELEGATION_VERDICTS } from './delegation-verdict.js';
import { normalizeDelegationAckActor } from './delegation-ack-actor.js';
import { normalizeDelegationReviewSubject } from './delegation-review-subject.js';

/**
 * @param {object} record
 * @returns {object}
 */
export function snapshotDelegationAttempt(record) {
  const executor = record?.executor && typeof record.executor === 'object' ? record.executor : {};
  const storedVerdict = String(record?.reportVerdict || '').trim();
  return {
    attemptId: String(record?.attemptId || '').trim(),
    status: String(record?.status || '').trim(),
    runId: String(record?.runId || '').trim(),
    // Leaf binding and host-verify obligation are captured per attempt so the
    // review snapshot can decide a round without re-reading the live record
    // (`docs/todo-review-contract.md` §5.1).
    leafId: String(record?.leafId || '').trim(),
    startedAt: String(record?.startedAt || '').trim(),
    finishedAt: String(record?.finishedAt || '').trim(),
    // Queue/start time for chronology; falls back to `createdAt` on legacy rows.
    queuedAt: String(record?.queuedAt || record?.createdAt || '').trim(),
    report: String(record?.report || ''),
    // Durable, pre-truncation report-credibility evidence. Retention may cut
    // `report` to 2000 chars, but this verdict survives and is what the review
    // snapshot reads (`docs/todo-review-contract.md` §5.1-§5.3).
    reportVerdict: DELEGATION_VERDICTS.includes(storedVerdict) ? storedVerdict : '',
    reportDegraded: record?.reportDegraded === true,
    reportSummary: String(record?.reportSummary || '').trim(),
    error: String(record?.error || ''),
    taskOutcome: String(record?.taskOutcome || 'unspecified').trim() || 'unspecified',
    interruptCode: String(record?.interruptCode || '').trim(),
    runStoppingAt: String(record?.runStoppingAt || '').trim(),
    unverified: record?.unverified !== false,
    // Host-owned verify evidence for this attempt (`recordDelegationVerifyResult`).
    verifyResult: record?.verifyResult && typeof record.verifyResult === 'object'
      ? { ...record.verifyResult }
      : null,
    verifyRequired: record?.verifyRequired === true,
    reviewCanRunTests: record?.reviewCanRunTests === true,
    reviewCanRunTestsSource: String(record?.reviewCanRunTestsSource || '').trim(),
    acknowledgedAt: String(record?.acknowledgedAt || '').trim(),
    acknowledgedReason: String(record?.acknowledgedReason || '').trim().toLowerCase(),
    acknowledgedActor: normalizeDelegationAckActor(record?.acknowledgedActor),
    acknowledgedAttemptId: String(record?.acknowledgedAttemptId || '').trim(),
    // The todo revision the accepting screen displayed (§7.3), archived with the
    // attempt so `review.*.acceptance.expectedTodoRevision` has a real producer.
    acknowledgedExpectedTodoRevision: String(record?.acknowledgedExpectedTodoRevision || '').trim(),
    reviewSubject: normalizeDelegationReviewSubject(record?.reviewSubject) || 'other',
    reviewSubjectSource: String(record?.reviewSubjectSource || '').trim() || 'unknown',
    reportDeliveredAt: String(record?.reportDeliveredAt || '').trim(),
    reportDeliveryId: String(record?.reportDeliveryId || '').trim(),
    historyDeliveredAt: String(record?.historyDeliveredAt || '').trim(),
    executionMode: String(record?.executionMode || '').trim(),
    assignment: String(record?.assignment || '').trim(),
    model: String(executor.model || '').trim(),
    transport: String(executor.transport || '').trim(),
  };
}

/**
 * @param {object} record
 * @returns {number}
 */
export function countDelegationAttempts(record) {
  const archived = Array.isArray(record?.attempts) ? record.attempts.length : 0;
  return archived + (String(record?.attemptId || '').trim() ? 1 : 0);
}

/**
 * @param {object} record
 * @returns {object[]}
 */
export function listDelegationAttempts(record) {
  const archived = Array.isArray(record?.attempts) ? record.attempts.filter((row) => row && typeof row === 'object') : [];
  if (!String(record?.attemptId || '').trim()) return archived;
  return [...archived, snapshotDelegationAttempt(record)];
}
