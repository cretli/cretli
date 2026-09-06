/**
 * In-process chat-run adapter for tests and local dry-runs.
 */

import { randomUUID } from 'crypto';
import { registerChatRunAdapter, unregisterChatRunAdapter } from '../chat-run-service.js';

/** @type {Map<string, { runId: string, busy: boolean, cancelled: boolean, waitingForInput: boolean, prompt: string, hold: boolean }>} */
const runs = new Map();

/** @type {(event: object) => void} */
let onEvent = () => {};
let failNextCancel = false;

/**
 * @param {(event: object) => void} listener
 */
export function setMockChatRunListener(listener) {
  onEvent = typeof listener === 'function' ? listener : () => {};
}

export function resetMockChatRuns() {
  runs.clear();
  onEvent = () => {};
  failNextCancel = false;
}

/**
 * @param {boolean} value
 */
export function setMockChatRunFailCancel(value) {
  failNextCancel = value === true;
}

/**
 * @param {string} chatId
 */
export function getMockChatRun(chatId) {
  return runs.get(chatId) || null;
}

/**
 * @param {string} chatId
 * @param {Record<string, unknown>} patch
 */
export function patchMockChatRun(chatId, patch) {
  const current = runs.get(chatId);
  if (!current) return null;
  Object.assign(current, patch);
  return current;
}

export function registerMockChatRunAdapter(transport = 'mock') {
  const id = String(transport || 'mock').trim() || 'mock';
  unregisterChatRunAdapter(id);
  registerChatRunAdapter({
    transport: id,
    async start({ chat, prompt, requestId, mode }) {
      const current = runs.get(chat.id);
      if (current?.busy || current?.waitingForInput) {
        const error = new Error('Recipient is busy');
        error.code = 'recipient_busy';
        throw error;
      }
      const runId = randomUUID();
      runs.set(chat.id, {
        runId,
        busy: true,
        cancelled: false,
        waitingForInput: false,
        prompt,
        hold: true,
        mode: String(mode || 'agent'),
        requestId: String(requestId || ''),
      });
      onEvent({ type: 'started', chatId: chat.id, runId, prompt });
      return { runId, accepted: true };
    },
    async cancel({ chat, runId }) {
      if (failNextCancel) {
        failNextCancel = false;
        throw new Error('cancel failed');
      }
      const current = runs.get(chat.id);
      if (!current) return;
      if (runId && current.runId !== runId) return;
      current.cancelled = true;
      current.busy = false;
      current.waitingForInput = false;
      onEvent({ type: 'cancelled', chatId: chat.id, runId: current.runId });
    },
    getState({ chat, runId }) {
      const current = runs.get(chat.id);
      if (!current) return null;
      if (runId && current.runId !== runId) return null;
      return {
        runId: current.runId,
        busy: current.busy,
        waitingForInput: current.waitingForInput,
      };
    },
  });
}
