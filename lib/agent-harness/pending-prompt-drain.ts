/**
 * Gate-aware dequeue for harness prompt queues. Callers must check before
 * `shift()` so prompts are not dropped when the update slot is held.
 */

import { canAcceptNewRun } from '../update-gate.js';

export interface PendingPromptDrainOptions {
  isBlocked?: (room: object) => boolean;
}

// Rooms are loosely typed (shared with lib/claude and lib/codex).
type PromptRoom = any;

export function canStartPendingPromptDrain(room: PromptRoom | null | undefined, options: PendingPromptDrainOptions = {}): boolean {
  if (!room || room.busy) return false;
  if (typeof options.isBlocked === 'function' && options.isBlocked(room)) return false;
  return canAcceptNewRun();
}

/**
 * @returns true when a queued item was handed to `runItem`
 */
export function drainOnePendingPrompt(room: PromptRoom, runItem: (item: object) => void, options: PendingPromptDrainOptions = {}): boolean {
  if (!canStartPendingPromptDrain(room, options)) return false;
  if (!Array.isArray(room.pendingPrompts) || room.pendingPrompts.length === 0) return false;
  const next = room.pendingPrompts.shift();
  if (!next) return false;
  runItem(next);
  return true;
}
