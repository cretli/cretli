/**
 * In-process chat-run adapter for tests and local dry-runs.
 */

import { randomUUID } from 'crypto';
import { registerChatRunAdapter, unregisterChatRunAdapter } from '../chat-run-service.js';

/** @type {Map<string, { runId: string, busy: boolean, cancelled: boolean, waitingForInput: boolean, prompt: string, hold: boolean, requestId: string }>} */
const runs = new Map();
/** @type {Map<string, { runId: string, chatId: string, accepted: boolean }>} */
const requests = new Map();

/** @type {(event: object) => void} */
let onEvent = () => {};
let failNextCancel = false;
let failNextStart = 0;
let failStartMessage = 'executor would not start';
let startCount = 0;
/** @type {null | Promise<void>} */
let hangOnce = null;
/** @type {null | Promise<void>} */
let hangCancelOnce = null;

export function resetMockChatRuns() {
  runs.clear();
  requests.clear();
  onEvent = () => {};
  failNextCancel = false;
  failNextStart = 0;
  failStartMessage = 'executor would not start';
  startCount = 0;
  hangOnce = null;
  hangCancelOnce = null;
}

/**
 * @returns {number}
 */
export function getMockChatRunStartCount() {
  return startCount;
}

/**
 * @returns {string[]}
 */
export function listMockChatRunChatIds() {
  return [...runs.keys()];
}

/**
 * @param {(event: object) => void} listener
 */
export function setMockChatRunListener(listener) {
  onEvent = typeof listener === 'function' ? listener : () => {};
}

/**
 * @param {boolean} value
 */
export function setMockChatRunFailCancel(value) {
  failNextCancel = value === true;
}

/**
 * @param {boolean | number} value Number of upcoming starts to fail.
 * @param {string} [message]
 */
export function setMockChatRunFailStart(value, message = 'executor would not start') {
  failNextStart = typeof value === 'number' ? Math.max(0, value) : (value === true ? 1 : 0);
  failStartMessage = String(message);
}

/**
 * Next start() waits until the returned release function is called.
 *
 * @returns {() => void}
 */
export function hangNextMockChatRunStart() {
  let release = () => {};
  hangOnce = new Promise((resolve) => {
    release = resolve;
  });
  return () => {
    hangOnce = null;
    release();
  };
}

/**
 * Next cancel() waits until the returned release function is called.
 *
 * @returns {() => void}
 */
export function hangNextMockChatRunCancel() {
  let release = () => {};
  hangCancelOnce = new Promise((resolve) => {
    release = resolve;
  });
  return () => {
    hangCancelOnce = null;
    release();
  };
}

/**
 * @param {string} chatId
 */
export function getMockChatRun(chatId) {
  return runs.get(chatId) || null;
}

/**
 * @param {string} requestId
 */
export function getMockChatRunByRequestId(requestId) {
  return requests.get(String(requestId || '').trim()) || null;
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

/**
 * @param {string} chatId
 * @param {{ runId?: string, busy?: boolean, waitingForInput?: boolean }} [input]
 */
export function seedMockChatRun(chatId, input = {}) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  const runId = String(input.runId || randomUUID()).trim();
  runs.set(id, {
    runId,
    busy: input.busy !== false,
    cancelled: false,
    waitingForInput: input.waitingForInput === true,
    prompt: '',
    hold: false,
    mode: 'agent',
    requestId: '',
    displayText: '',
    attemptId: '',
    delegationId: '',
  });
  return runs.get(id) || null;
}

export function registerMockChatRunAdapter(transport = 'mock') {
  const id = String(transport || 'mock').trim() || 'mock';
  unregisterChatRunAdapter(id);
  registerChatRunAdapter({
    transport: id,
    capabilities: {
      canLookupRequest: true,
      canCancel: true,
      canReconstructSession: false,
      canReadFiles: true,
      canSearch: true,
      deniesMutation: false,
    },
    lookupRequest({ requestId }) {
      const key = String(requestId || '').trim();
      if (!key) return null;
      return requests.get(key) || null;
    },
    async start({ chat, prompt, requestId, mode, displayText, deps }) {
      const key = String(requestId || '').trim();
      if (key && requests.has(key)) {
        const existing = requests.get(key);
        return { runId: existing.runId, accepted: existing.accepted !== false };
      }
      const gate = hangOnce;
      hangOnce = null;
      if (gate) await gate;
      if (failNextStart > 0) {
        failNextStart -= 1;
        throw Object.assign(new Error(failStartMessage), { code: 'start_failed' });
      }
      const current = runs.get(chat.id);
      if (current?.busy || current?.waitingForInput) {
        const error = new Error('Recipient is busy');
        error.code = 'recipient_busy';
        throw error;
      }
      startCount += 1;
      const runId = randomUUID();
      runs.set(chat.id, {
        runId,
        busy: true,
        cancelled: false,
        waitingForInput: false,
        prompt,
        hold: true,
        mode: String(mode || 'agent'),
        requestId: key,
        displayText: String(displayText || ''),
        attemptId: String(deps?.attemptId || '').trim(),
        delegationId: String(deps?.delegationId || '').trim(),
      });
      if (key) requests.set(key, { runId, chatId: chat.id, accepted: true });
      onEvent({ type: 'started', chatId: chat.id, runId, prompt });
      return { runId, accepted: true };
    },
    async cancel({ chat, runId }) {
      if (failNextCancel) {
        failNextCancel = false;
        throw new Error('cancel failed');
      }
      const gate = hangCancelOnce;
      hangCancelOnce = null;
      if (gate) await gate;
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
        attemptId: current.attemptId || '',
      };
    },
  });
}
