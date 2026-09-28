/**
 * DeepSeek runtime reuse: sandbox mode is fixed at dsh process start.
 */

/**
 * @param {any} room
 * @param {string} mcpRevision
 * @param {boolean} reviewReadOnly
 * @returns {boolean}
 */
export function shouldReuseDeepSeekHarness(room, mcpRevision, reviewReadOnly) {
  if (!room?._harness) return false;
  if (room._mcpRevision !== mcpRevision) return false;
  if (room._reviewReadOnly !== reviewReadOnly) return false;
  return true;
}
