/**
 * Pure agent-state resolution based on WS messages from the SDK server.
 * DOM-free, so it can be unit tested. Used by chatTransport.
 */

/**
 * @param {'idle' | 'active' | 'disconnected'} prev
 * @param {Record<string, unknown>} msg
 * @returns {'idle' | 'active' | 'disconnected' | null} the new state, or null when unchanged
 */
export function resolveAgentStateFromMessage(prev, msg) {
  if (!msg || typeof msg !== 'object') return null;
  const t = typeof msg.type === 'string' ? msg.type : '';

  if (t === 'hello' && (msg.transport === 'cursor-sdk' || msg.transport === 'openrouter' || msg.transport === 'opencode')) {
    const hasQueuedPrompts = Array.isArray(msg.queuedPrompts) && msg.queuedPrompts.length > 0;
    if (msg.busy === true || hasQueuedPrompts) return 'active';
    return 'idle';
  }
  if (t === 'sdkBusy') {
    if (msg.busy === false) return 'idle';
    return 'active';
  }
  if (t === 'sdkQueued') return 'active';
  if (t === 'sdkPromptStarted') return 'active';
  if (t === 'sdkEvent') return 'active';
  if (t === 'sdkRunFinished') {
    const remaining = Number(msg.remaining);
    return Number.isSafeInteger(remaining) && remaining > 0 ? 'active' : 'idle';
  }
  if (t === 'sdkError') return null;
  // sdkPlanGuard: the run gets cancelled, but the incoming sdkRunFinished is what sets idle.
  return null;
}
