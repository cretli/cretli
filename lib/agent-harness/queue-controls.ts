/**
 * Shared handler for the `queueRemove` / `queueForceSend` / `queueSteer` /
 * `queueMove` WebSocket controls (the trash / lightning / steer / up-down
 * buttons on queued prompts in the chat UI).
 */

import { isQueuedPromptText, resolveQueuedPromptUiText } from '../prompt-ui-text.js';
import { buildSdkSteerErrorPayload, SDK_STEER_ERROR_CODES } from '../sdk/sdk-run-steer.ts';

export const QUEUE_CONTROL_TYPES = Object.freeze(['queueRemove', 'queueForceSend', 'queueSteer', 'queueMove']);

/**
 * `queueMove`: shift one queued prompt up (`direction: 'up'`, towards the
 * front) or down by one slot. The queue is transient, so the move is not
 * persisted; every client gets the full new order in `sdkQueueReordered` and
 * reconnecting clients read it from the hello `queuedPrompts` snapshot.
 *
 * @returns the new UI order, or null when nothing moved
 */
export function moveQueuedPrompt(
  room: any,
  target: string,
  direction: unknown,
  { broadcast }: { broadcast: (room: any, payload: Record<string, unknown>) => void },
): string[] | null {
  const needle = typeof target === 'string' ? target.trim() : '';
  if (!needle) return null;
  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
  const queue = room.pendingPrompts;
  const idx = queue.findIndex((item: any) => isQueuedPromptText(item, needle));
  if (idx < 0) return null;
  const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
  const next = idx + delta;
  if (!delta || next < 0 || next >= queue.length) return null;
  const [item] = queue.splice(idx, 1);
  queue.splice(next, 0, item);
  const order = queue.map((entry: any) => resolveQueuedPromptUiText(entry));
  broadcast(room, { type: 'sdkQueueReordered', text: needle, order });
  return order;
}

/**
 * `queueSteer`: take the prompt out of the queue and inject it into the running
 * turn through the room's `steerQueuedItem`. An undelivered steer re-queues it
 * (the harness steer path never drops text). Without a running turn the prompt
 * stays queued and the client gets a typed steer error.
 *
 * @returns true when the frame was handled
 */
export function handleQueueSteer(
  room: any,
  target: string,
  { broadcast }: { broadcast: (room: any, payload: Record<string, unknown>) => void },
): boolean {
  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
  const idx = room.pendingPrompts.findIndex((item: any) => isQueuedPromptText(item, target));
  if (idx < 0 || !room.busy || typeof room.steerQueuedItem !== 'function') {
    const missing = idx < 0;
    const unsupported = !missing && room.busy && typeof room.steerQueuedItem !== 'function';
    broadcast(room, buildSdkSteerErrorPayload({
      code: missing
        ? SDK_STEER_ERROR_CODES.DELIVERY_FAILED
        : (unsupported ? SDK_STEER_ERROR_CODES.UNSUPPORTED : SDK_STEER_ERROR_CODES.NO_ACTIVE_RUN),
      message: missing
        ? 'The queued message was not found.'
        : (unsupported ? 'This chat does not support steering.' : 'There is no active run to steer.'),
      text: target,
    }));
    return true;
  }
  const [item] = room.pendingPrompts.splice(idx, 1);
  void room.steerQueuedItem(item);
  return true;
}

/**
 * @returns true when `msg` was a queue control and has been handled
 */
export function handleQueueControlMessage(
  room: any,
  msg: any,
  { broadcast }: { broadcast: (room: any, payload: Record<string, unknown>) => void },
): boolean {
  if (!msg || typeof msg.text !== 'string') return false;
  if (!QUEUE_CONTROL_TYPES.includes(msg.type)) return false;
  const target = msg.text.trim();
  if (!target) return true;
  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
  if (msg.type === 'queueSteer') return handleQueueSteer(room, target, { broadcast });
  if (msg.type === 'queueMove') {
    moveQueuedPrompt(room, target, msg.direction, { broadcast });
    return true;
  }
  const idx = room.pendingPrompts.findIndex((item: any) => isQueuedPromptText(item, target));

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
