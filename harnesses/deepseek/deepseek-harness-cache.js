/**
 * DeepSeek runtime reuse: sandbox mode is fixed at dsh process start.
 */

/**
 * @param {any} room
 * @param {string} mcpRevision
 * @param {boolean} reviewReadOnly
 * @returns {boolean}
 */
export function shouldReuseDeepSeekHarness(room, mcpRevision, reviewReadOnly, attemptId = '') {
  if (!room?._harness) return false;
  if (room._mcpRevision !== mcpRevision) return false;
  if (room._reviewReadOnly !== reviewReadOnly) return false;
  // The bridge token pins the delegation attempt; a new round needs a new bridge.
  if (String(room._harnessAttemptId || '') !== String(attemptId || '')) return false;
  return true;
}
