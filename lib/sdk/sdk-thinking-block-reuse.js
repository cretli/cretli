/**
 * Reuse the live Thinking block after a WS hello/reconnect.
 * DeepSeek (and similar) omit run_id, so onStreamReset bumps local-run-* and
 * would otherwise spawn a second Thinking block with the same accumulator text.
 */

/**
 * @param {unknown} block
 * @returns {block is {
 *   isConnected?: boolean,
 *   isActivityOnly?: boolean,
 *   hasThinkingPre?: boolean,
 *   runKey?: string,
 * }}
 */
function asThinkingBlockMeta(block) {
  return !!block && typeof block === 'object' && !Array.isArray(block);
}

/**
 * @param {unknown} block
 * @returns {boolean}
 */
export function isReusableSdkThinkingBlock(block) {
  if (!asThinkingBlockMeta(block)) return false;
  if (block.isConnected === false) return false;
  if (block.isActivityOnly === true) return false;
  if (block.hasThinkingPre === false) return false;
  return true;
}

/**
 * Prefer the block for this run key. After a stream reset the key changes, so
 * fall back to the most recently tracked connected Thinking block.
 *
 * @param {Array<{ runKey?: string, isConnected?: boolean, isActivityOnly?: boolean, hasThinkingPre?: boolean }>} blocks
 * @param {string} runKey
 * @param {boolean} canResumeAfterReset
 * @returns {number}
 */
export function findReusableSdkThinkingBlockIndex(blocks, runKey, canResumeAfterReset) {
  const list = Array.isArray(blocks) ? blocks : [];
  const key = String(runKey || '').trim();
  if (key) {
    for (let i = 0; i < list.length; i += 1) {
      if (!isReusableSdkThinkingBlock(list[i])) continue;
      if (String(list[i].runKey || '').trim() === key) return i;
    }
  }
  if (!canResumeAfterReset) return -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isReusableSdkThinkingBlock(list[i])) return i;
  }
  return -1;
}

/**
 * sdkStreamReset clears _sdkThinkingAcc. Rehydrate it from the DOM so the
 * reused block keeps prefix-matching the live stream instead of repeating it.
 *
 * @param {string} currentAcc
 * @param {string} existingBlockText
 * @returns {string}
 */
export function restoreSdkThinkingAccumulator(currentAcc, existingBlockText) {
  const current = typeof currentAcc === 'string' ? currentAcc : '';
  if (current) return current;
  return typeof existingBlockText === 'string' ? existingBlockText : '';
}
