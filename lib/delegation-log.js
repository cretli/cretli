/**
 * Compact diagnostic logs for delegation lifecycle.
 */

/**
 * @param {string} event
 * @param {object} [record]
 * @param {Record<string, unknown>} [extra]
 */
export function logDelegationEvent(event, record = {}, extra = {}) {
  if (process.env.CRETLI_TEST_DATA_DIR) return;
  const payload = {
    event: String(event || '').trim(),
    delegationId: String(record.id || extra.delegationId || '').trim(),
    attemptId: String(record.attemptId || extra.attemptId || '').trim(),
    runId: String(record.runId || extra.runId || '').trim(),
    messageId: String(extra.messageId || '').trim(),
    status: String(record.status || extra.status || '').trim(),
    queuedAt: String(record.createdAt || '').trim(),
    startedAt: String(record.startedAt || '').trim(),
    runningAt: String(record.runningAt || '').trim(),
    finishedAt: String(record.finishedAt || '').trim(),
    ...extra,
  };
  console.info('[delegation]', JSON.stringify(payload));
}
