/**
 * Reuse the live Thinking block after a WS hello/reconnect.
 * DeepSeek (and similar) omit run_id, so onStreamReset bumps local-run-* and
 * would otherwise spawn a second Thinking block with the same accumulator text.
 */

interface ThinkingBlockMeta {
  isConnected?: boolean;
  isActivityOnly?: boolean;
  hasThinkingPre?: boolean;
  runKey?: string;
}

function asThinkingBlockMeta(block: unknown): block is ThinkingBlockMeta {
  return !!block && typeof block === 'object' && !Array.isArray(block);
}

export function isReusableSdkThinkingBlock(block: unknown): boolean {
  if (!asThinkingBlockMeta(block)) return false;
  if (block.isConnected === false) return false;
  if (block.isActivityOnly === true) return false;
  if (block.hasThinkingPre === false) return false;
  return true;
}

/**
 * Prefer the block for this run key. After a stream reset the key changes, so
 * fall back to the most recently tracked connected Thinking block.
 */
export function findReusableSdkThinkingBlockIndex(
  blocks: ThinkingBlockMeta[],
  runKey: string,
  canResumeAfterReset: boolean,
): number {
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
 */
export function restoreSdkThinkingAccumulator(currentAcc: string, existingBlockText: string): string {
  const current = typeof currentAcc === 'string' ? currentAcc : '';
  if (current) return current;
  return typeof existingBlockText === 'string' ? existingBlockText : '';
}
