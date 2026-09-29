/**
 * Snapshot helpers for delegation attempts.
 */

/**
 * @param {object} record
 * @returns {object}
 */
export function snapshotDelegationAttempt(record) {
  const executor = record?.executor && typeof record.executor === 'object' ? record.executor : {};
  return {
    attemptId: String(record?.attemptId || '').trim(),
    status: String(record?.status || '').trim(),
    runId: String(record?.runId || '').trim(),
    startedAt: String(record?.startedAt || '').trim(),
    finishedAt: String(record?.finishedAt || '').trim(),
    report: String(record?.report || ''),
    error: String(record?.error || ''),
    taskOutcome: String(record?.taskOutcome || 'unspecified').trim() || 'unspecified',
    interruptCode: String(record?.interruptCode || '').trim(),
    runStoppingAt: String(record?.runStoppingAt || '').trim(),
    unverified: record?.unverified !== false,
    acknowledgedAt: String(record?.acknowledgedAt || '').trim(),
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
