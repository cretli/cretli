/**
 * Shared handler for the `queueRemove` / `queueForceSend` WebSocket controls
 * (the trash / lightning buttons on queued prompts in the chat UI).
 */

import { isQueuedPromptText } from '../prompt-ui-text.js';

/**
 * @param {any} room
 * @param {any} msg
 * @param {{ broadcast: (room: any, payload: Record<string, unknown>) => void }} deps
 * @returns {boolean} true when `msg` was a queue control and has been handled
 */
export function handleQueueControlMessage(room, msg, { broadcast }) {
  if (!msg || typeof msg.text !== 'string') return false;
  if (msg.type !== 'queueRemove' && msg.type !== 'queueForceSend') return false;
  const target = msg.text.trim();
  if (!target) return true;
  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
  const idx = room.pendingPrompts.findIndex((item) => isQueuedPromptText(item, target));

  if (msg.type === 'queueRemove') {
    if (idx >= 0) {
      room.pendingPrompts.splice(idx, 1);
      broadcast(room, { type: 'sdkQueueRemoved', text: target });
    }
    return true;
  }

  // queueForceSend: move to the front, then interrupt the current run (its
  // finalizer drains the queue) or start it right away when idle.
  const [item] = idx >= 0
    ? room.pendingPrompts.splice(idx, 1)
    : [{ text: target, mode: room.sdkMode }];
  room.pendingPrompts.unshift(item);
  if (room.busy) {
    if (typeof room.cancelCurrentRun === 'function') void room.cancelCurrentRun();
    return true;
  }
  if (typeof room.drainQueue === 'function') room.drainQueue();
  return true;
}
