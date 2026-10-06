/**
 * Normalized completion payload for `replayHistoryRecords`.
 */

/** @typedef {'complete' | 'cancelled' | 'superseded' | 'destroyed' | 'error'} HistoryReplayFinishReason */

/**
 * @typedef {{
 *   generation: number,
 *   total: number,
 *   applied: number,
 *   cancelled: boolean,
 *   reason: HistoryReplayFinishReason,
 * }} HistoryReplayResult
 */

/**
 * @param {{
 *   generation: number,
 *   total: number,
 *   applied: number,
 *   reason: HistoryReplayFinishReason,
 * }} input
 * @returns {HistoryReplayResult}
 */
export function buildHistoryReplayResult(input) {
  const generation = Math.max(0, Math.round(Number(input.generation) || 0));
  const total = Math.max(0, Math.round(Number(input.total) || 0));
  const applied = Math.min(total, Math.max(0, Math.round(Number(input.applied) || 0)));
  const reason = input.reason || 'complete';
  const cancelled = reason === 'cancelled' || reason === 'superseded' || reason === 'destroyed';
  return { generation, total, applied, cancelled, reason };
}

/** @returns {HistoryReplayResult} */
export function emptyHistoryReplayResult() {
  return buildHistoryReplayResult({
    generation: 0,
    total: 0,
    applied: 0,
    reason: 'complete',
  });
}
