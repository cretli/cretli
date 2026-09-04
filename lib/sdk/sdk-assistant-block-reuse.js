/**
 * Reuse the live Answer block after a WS hello/reconnect.
 * onStreamReset clears assistantMdEl and _sdkAssistantAcc, so the next full
 * assistant snapshot would otherwise spawn a second identical Odpowiedź bubble.
 */

const ASSISTANT_REUSE_BREAK_VARIANTS = new Set([
  'user',
  'thinking',
  'run',
  'plan',
  'question',
]);

/**
 * @param {unknown} block
 * @returns {block is {
 *   variant?: string,
 *   isConnected?: boolean,
 *   hasAssistantMd?: boolean,
 * }}
 */
function asAssistantBlockMeta(block) {
  return !!block && typeof block === 'object' && !Array.isArray(block);
}

/**
 * A later user/tool/thinking turn means this answer is finished.
 *
 * @param {unknown} variant
 * @returns {boolean}
 */
export function breaksSdkAssistantBlockReuse(variant) {
  return ASSISTANT_REUSE_BREAK_VARIANTS.has(String(variant || ''));
}

/**
 * @param {unknown} block
 * @returns {boolean}
 */
export function isReusableSdkAssistantBlock(block) {
  if (!asAssistantBlockMeta(block)) return false;
  if (block.variant !== 'assistant') return false;
  if (block.isConnected === false) return false;
  if (block.hasAssistantMd === false) return false;
  return true;
}

/**
 * Walk from the tail. Skip muted/status-like blocks; stop on a new turn.
 *
 * @param {Array<{ variant?: string, isConnected?: boolean, hasAssistantMd?: boolean }>} blocks
 * @param {boolean} canResumeAfterReset
 * @returns {number}
 */
export function findReusableSdkAssistantBlockIndex(blocks, canResumeAfterReset) {
  if (!canResumeAfterReset) return -1;
  const list = Array.isArray(blocks) ? blocks : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (isReusableSdkAssistantBlock(item)) return i;
    if (breaksSdkAssistantBlockReuse(item?.variant)) return -1;
  }
  return -1;
}

/**
 * sdkStreamReset clears _sdkAssistantAcc. Rehydrate it from the DOM so the
 * reused block keeps prefix-matching the live stream instead of repeating it.
 *
 * @param {string} currentAcc
 * @param {string} existingBlockText
 * @returns {string}
 */
export function restoreSdkAssistantAccumulator(currentAcc, existingBlockText) {
  const current = typeof currentAcc === 'string' ? currentAcc : '';
  if (current) return current;
  return typeof existingBlockText === 'string' ? existingBlockText : '';
}
