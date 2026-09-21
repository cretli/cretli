/**
 * Server-side chat run start/cancel, shared by interactive WS and delegations.
 */

import { getChatByCursorSessionId, loadChats } from './persist/chats-persist.js';
import { getChatAgentTransport } from './agent-transport.js';
import { markAgentPresenceDirty } from './agent-presence-hooks.js';

/** @type {Map<string, ChatRunAdapter>} */
const adapters = new Map();

/** @type {Map<string, Promise<unknown>>} */
const startLocks = new Map();

/**
 * @typedef {{
 *   transport: string,
 *   start: (input: {
 *     chat: object,
 *     prompt: string,
 *     mode?: string,
 *     requestId?: string,
 *     displayText?: string,
 *     deps?: object,
 *   }) => Promise<{ runId: string, accepted?: boolean }>,
 *   cancel: (input: { chat: object, runId?: string }) => Promise<void>,
 *   getState: (input: { chat: object, runId?: string }) => {
 *     runId: string,
 *     busy: boolean,
 *     waitingForInput?: boolean,
 *   } | null,
 *   lookupRequest?: (input: { chat: object, requestId: string }) => {
 *     accepted: boolean,
 *     runId?: string,
 *   } | null,
 *   capabilities?: {
 *     canLookupRequest?: boolean,
 *     canCancel?: boolean,
 *     canReconstructSession?: boolean,
 *     canReadFiles?: boolean,
 *     canSearch?: boolean,
 *     deniesMutation?: boolean,
 *   },
 * }} ChatRunAdapter
 */

/**
 * @param {string} chatId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
export async function withChatRunStartLock(chatId, task) {
  const key = String(chatId || '').trim();
  const previous = startLocks.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate, () => gate);
  startLocks.set(key, chain);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (startLocks.get(key) === chain) startLocks.delete(key);
  }
}

/**
 * @param {ChatRunAdapter} adapter
 */
export function registerChatRunAdapter(adapter) {
  const transport = String(adapter?.transport || '').trim();
  if (!transport) throw new TypeError('Chat run adapter requires transport');
  adapters.set(transport, adapter);
}

/**
 * @param {string} transport
 */
export function unregisterChatRunAdapter(transport) {
  adapters.delete(String(transport || '').trim());
}

/**
 * @returns {string[]}
 */
export function listChatRunAdapterTransports() {
  return [...adapters.keys()];
}

/**
 * @param {string} transport
 * @returns {boolean}
 */
export function hasChatRunAdapter(transport) {
  return adapters.has(String(transport || '').trim());
}

/**
 * @param {string} transport
 * @returns {object | null}
 */
export function getChatRunAdapter(transport) {
  return adapters.get(String(transport || '').trim()) || null;
}

/**
 * @param {string} transport
 * @returns {{
 *   transport: string,
 *   canLookupRequest: boolean,
 *   canCancel: boolean,
 *   canReconstructSession: boolean,
 *   canReadFiles: boolean,
 *   canSearch: boolean,
 *   deniesMutation: boolean,
 * }}
 */
export function getChatRunAdapterCapabilities(transport) {
  const adapter = getChatRunAdapter(transport);
  const caps = adapter?.capabilities && typeof adapter.capabilities === 'object'
    ? adapter.capabilities
    : {};
  return {
    transport: String(transport || '').trim(),
    canLookupRequest: caps.canLookupRequest === true || typeof adapter?.lookupRequest === 'function',
    canCancel: caps.canCancel !== false,
    canReconstructSession: caps.canReconstructSession === true,
    canReadFiles: caps.canReadFiles === true,
    canSearch: caps.canSearch === true,
    deniesMutation: caps.deniesMutation === true,
  };
}

/**
 * @param {{ chatId: string, requestId: string }} input
 * @returns {{ accepted: boolean, runId: string } | null}
 */
export function lookupChatRunRequest(input) {
  const chat = loadChatById(input.chatId);
  if (!chat) return null;
  const adapter = adapters.get(getChatAgentTransport(chat));
  if (!adapter || typeof adapter.lookupRequest !== 'function') return null;
  const found = adapter.lookupRequest({
    chat,
    requestId: String(input.requestId || '').trim(),
  });
  if (!found || found.accepted !== true) return found && typeof found === 'object' ? found : null;
  return {
    accepted: true,
    runId: String(found.runId || '').trim(),
  };
}

/**
 * @param {string} chatId
 * @returns {object | null}
 */
function loadChatById(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return loadChats().find((row) => row.id === id) || null;
}

function throwRecipientBusy() {
  const error = new Error('Recipient is busy');
  error.code = 'recipient_busy';
  throw error;
}

/**
 * @param {{ chatId: string, prompt: string, mode?: string, requestId?: string, displayText?: string, deps?: object }} input
 * @returns {Promise<{ runId: string, chatId: string, transport: string, accepted: boolean }>}
 */
export async function startChatRun(input) {
  const chat = loadChatById(input.chatId);
  if (!chat) {
    const error = new Error('Chat not found');
    error.code = 'chat_not_found';
    throw error;
  }
  const transport = getChatAgentTransport(chat);
  const adapter = adapters.get(transport);
  if (!adapter) {
    const error = new Error(`Server-side start is not available for ${transport}`);
    error.code = 'adapter_unavailable';
    throw error;
  }
  const prompt = String(input.prompt || '').trim();
  if (!prompt) {
    const error = new Error('Prompt is required');
    error.code = 'prompt_required';
    throw error;
  }
  return withChatRunStartLock(chat.id, async () => {
    const requestId = String(input.requestId || '').trim();
    if (requestId) {
      const found = lookupChatRunRequest({ chatId: chat.id, requestId });
      if (found?.accepted === true && found.runId) {
        return {
          runId: found.runId,
          accepted: true,
          chatId: chat.id,
          transport,
        };
      }
    }
    const state = getChatRunStateForChat(chat);
    if (state?.busy || state?.waitingForInput) throwRecipientBusy();
    const result = await adapter.start({
      chat,
      prompt,
      mode: input.mode || 'agent',
      requestId,
      displayText: input.displayText || '',
      deps: input.deps || {},
    });
    const accepted = result?.accepted !== false;
    const runId = String(result?.runId || '').trim();
    if (!accepted) throwRecipientBusy();
    markAgentPresenceDirty([chat.id]);
    return {
      runId,
      accepted: true,
      chatId: chat.id,
      transport,
    };
  });
}

/**
 * @param {{ chatId: string, runId?: string }} input
 */
export async function cancelChatRun(input) {
  const chat = loadChatById(input.chatId);
  if (!chat) return;
  const adapter = adapters.get(getChatAgentTransport(chat));
  if (!adapter) return;
  await adapter.cancel({ chat, runId: String(input.runId || '').trim() });
  markAgentPresenceDirty([chat.id]);
}

/**
 * @param {{ chatId: string, runId?: string }} input
 */
export function getChatRunState(input) {
  const chat = loadChatById(input.chatId);
  if (!chat) return null;
  return getChatRunStateForChat(chat, String(input.runId || '').trim());
}

/**
 * Distinguish adapter idle from adapter lookup failure. A missing adapter,
 * null/undefined getState, or a mismatched runId is not proof that the child
 * run ended.
 *
 * @param {{ chatId?: string, runId?: string }} input
 * @returns {{ known: boolean, busy: boolean, reason: string }}
 */
export function probeChatRunLiveness(input = {}) {
  try {
    const chat = loadChatById(input.chatId);
    if (!chat) return { known: false, busy: false, reason: 'chat_missing' };
    const adapter = adapters.get(getChatAgentTransport(chat));
    if (!adapter) return { known: false, busy: false, reason: 'adapter_missing' };
    const wantedRunId = String(input.runId || '').trim();
    let state;
    try {
      state = adapter.getState({ chat, runId: wantedRunId });
    } catch {
      return { known: false, busy: false, reason: 'adapter_error' };
    }
    if (state == null) {
      return { known: false, busy: false, reason: 'state_missing' };
    }
    const stateRunId = String(state.runId || '').trim();
    if (wantedRunId && stateRunId && wantedRunId !== stateRunId) {
      return { known: false, busy: false, reason: 'run_mismatch' };
    }
    const busy = !!(state.busy || state.waitingForInput);
    return {
      known: true,
      busy,
      reason: busy ? 'busy' : 'idle',
    };
  } catch {
    return { known: false, busy: false, reason: 'probe_failed' };
  }
}

/**
 * Confirmed adapter idle for this chat/run. Unknown or missing state is not idle.
 *
 * @param {{ chatId?: string, runId?: string }} input
 * @returns {boolean}
 */
export function isChatRunConfirmedIdle(input = {}) {
  const live = probeChatRunLiveness(input);
  return live.known === true && live.busy === false;
}

/**
 * @param {object | null | undefined} chat
 * @param {string} [runId]
 */
export function getChatRunStateForChat(chat, runId = '') {
  if (!chat) return null;
  const adapter = adapters.get(getChatAgentTransport(chat));
  if (!adapter) return null;
  return adapter.getState({ chat, runId: String(runId || '').trim() });
}

/**
 * @param {string} sessionKey
 * @returns {object | null}
 */
export function getChatBySessionKey(sessionKey) {
  return getChatByCursorSessionId(sessionKey);
}
