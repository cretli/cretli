/**
 * Gate-aware dequeue for harness prompt queues. Callers must check before
 * `shift()` so prompts are not dropped when the update slot is held.
 */

import { canAcceptNewRun } from '../update-gate.js';

/**
 * @param {object | null | undefined} room
 * @param {{ isBlocked?: (room: object) => boolean }} [options]
 * @returns {boolean}
 */
export function canStartPendingPromptDrain(room, options = {}) {
  if (!room || room.busy) return false;
  if (typeof options.isBlocked === 'function' && options.isBlocked(room)) return false;
  return canAcceptNewRun();
}

/**
 * @param {object} room
 * @param {(item: object) => void} runItem
 * @param {{ isBlocked?: (room: object) => boolean }} [options]
 * @returns {boolean} true when a queued item was handed to `runItem`
 */
export function drainOnePendingPrompt(room, runItem, options = {}) {
  if (!canStartPendingPromptDrain(room, options)) return false;
  if (!Array.isArray(room.pendingPrompts) || room.pendingPrompts.length === 0) return false;
  const next = room.pendingPrompts.shift();
  if (!next) return false;
  runItem(next);
  return true;
}
