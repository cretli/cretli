/**
 * Register a chat-run adapter for a kernel-backed harness room.
 */

import { registerChatRunAdapter } from '../chat-run-service.js';

/**
 * Kick off a room prompt without waiting for the model to finish.
 *
 * @param {object} room
 * @param {{
 *   prompt: string,
 *   mode?: string,
 *   displayText?: string,
 *   startPrompt?: (...args: unknown[]) => unknown,
 * }} startInput
 * @param {(room: object) => boolean} waitingForInput
 * @returns {{ runId: string, accepted: true }}
 */
export function acceptRoomPrompt(room, startInput, waitingForInput = () => false) {
  const startPrompt = typeof startInput.startPrompt === 'function'
    ? startInput.startPrompt
    : room?.startPrompt;
  if (!room || typeof startPrompt !== 'function') {
    const error = new Error('Prompt runner is missing');
    error.code = 'adapter_unavailable';
    throw error;
  }
  if (waitingForInput(room) || room.busy) {
    const error = new Error('Recipient is busy');
    error.code = 'recipient_busy';
    throw error;
  }
  room.serverHold = true;
  void startPrompt.call(
    room,
    startInput.prompt,
    startInput.mode || 'agent',
    false,
    startInput.displayText || '',
  );
  return {
    runId: String(room.currentRun?.id || ''),
    accepted: true,
  };
}

/**
 * @param {{
 *   transport: string,
 *   rooms: Map<string, object>,
 *   ensureRoom: (sessionKey: string, deps?: object) =>
 *     | { room: object, chat: object }
 *     | { error: string, code: string }
 *     | Promise<{ room: object, chat: object } | { error: string, code: string }>,
 *   waitingForInput?: (room: object) => boolean,
 * }} input
 */
export function registerKernelChatRunAdapter(input) {
  const transport = String(input?.transport || '').trim();
  const rooms = input?.rooms;
  const ensureRoom = input?.ensureRoom;
  if (!transport || !(rooms instanceof Map) || typeof ensureRoom !== 'function') {
    throw new TypeError('Kernel chat-run adapter requires transport, rooms, and ensureRoom');
  }
  const waitingForInput = typeof input.waitingForInput === 'function'
    ? input.waitingForInput
    : () => false;
  registerChatRunAdapter({
    transport,
    async start(startInput) {
      const sessionKey = String(startInput.chat?.cursorSessionId || '').trim();
      const ensured = await ensureRoom(sessionKey, startInput.deps || {});
      if ('error' in ensured) {
        const error = new Error(ensured.error);
        error.code = ensured.code;
        throw error;
      }
      const { room } = ensured;
      return acceptRoomPrompt(room, {
        prompt: startInput.prompt,
        mode: startInput.mode,
        displayText: startInput.displayText,
      }, waitingForInput);
    },
    async cancel(cancelInput) {
      const room = rooms.get(String(cancelInput.chat?.cursorSessionId || ''));
      if (!room) return;
      if (cancelInput.runId && room.currentRun?.id && room.currentRun.id !== cancelInput.runId) {
        return;
      }
      if (typeof room.cancelCurrentRun === 'function') {
        await room.cancelCurrentRun();
        return;
      }
      room.cancelled = true;
    },
    getState({ chat, runId }) {
      const room = rooms.get(String(chat?.cursorSessionId || ''));
      if (!room) return null;
      if (runId && room.currentRun?.id && room.currentRun.id !== runId) return null;
      return {
        runId: String(room.currentRun?.id || room.lastRunId || ''),
        busy: !!room.busy,
        waitingForInput: waitingForInput(room),
      };
    },
  });
}
