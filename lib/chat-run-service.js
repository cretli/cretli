/**
 * Server-side chat run start/cancel, shared by interactive WS and delegations.
 */

import { getChatByCursorSessionId, loadChats } from './persist/chats-persist.js';
import { getChatAgentTransport } from './agent-transport.js';
import { markAgentPresenceDirty } from './agent-presence-hooks.js';
import { assertChatCanReceiveMessages } from './chat-message-guard.js';
import { describeRecoveryAdapterContract } from './recovery/recovery-contract.js';
import { resolveEffectiveRecoveryCapabilities } from './chat-run/adapter-capabilities.js';

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
 *   // lookupRequest `accepted` is tri-state: `true` = durable proof the
 *   // executor took the run, `false` = a run row exists without acceptance
 *   // proof, `null` = the adapter cannot answer (no recovery contract). Only
 *   // `true` is evidence of a start; `null` must never be read as "ended".
 *   lookupRequest?: (input: { chat: object, requestId: string }) => {
 *     accepted: boolean | null,
 *     runId?: string,
 *   } | null,
 *   capabilities?: {
 *     canLookupRequest?: boolean,
 *     canCancel?: boolean,
 *     canReconstructSession?: boolean,
 *     canReadFiles?: boolean,
 *     canSearch?: boolean,
 *     deniesMutation?: boolean,
 *     canReattach?: boolean,
 *     canResumeSession?: boolean,
 *     resumeStrategy?: string,
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
 * Live adapter contract for one transport: what the registered adapter can do
 * at runtime, narrowed by the static recovery contract in
 * `lib/recovery/recovery-contract.js` (the single source for the MVP table).
 *
 * A runtime adapter may only report LESS than the contract grants: `canReattach`
 * and `canResumeSession` are the intersection of the declared MVP row and the
 * adapter's own capabilities, so a transport outside the MVP set (`codebuddy`,
 * `openrouter`, anything unknown) is surfaced as an EXPLICIT unsupported
 * (`recoveryDecision` / `recoveryInfraOutcome` = 'unsupported') instead of a
 * silent false a caller could misread as "the run ended".
 *
 * `transcriptLost` describes what a resume of this adapter costs, not what
 * happened to the run: only a reattach keeps the live context, every other MVP
 * strategy re-enters a saved session id as a fresh turn. `lookupRequest` adds
 * the observed signals (`room_missing`, `no_live_run_match`) for a specific run.
 *
 * @param {string} transport
 * @returns {{
 *   transport: string,
 *   canLookupRequest: boolean,
 *   canCancel: boolean,
 *   canReconstructSession: boolean,
 *   canReadFiles: boolean,
 *   canSearch: boolean,
 *   deniesMutation: boolean,
 *   canReattach: boolean,
 *   canResumeSession: boolean,
 *   resumeStrategy: string,
 *   recoverySupported: boolean,
 *   recoveryScope: string,
 *   recoveryDecision: string,
 *   recoveryInfraOutcome: string,
 *   requiresCrashValidation: boolean,
 *   recoveryValidation: string,
 *   transcriptLost: boolean,
 *   transcriptLossReason: string,
 * }}
 */
export function getChatRunAdapterCapabilities(transport) {
  const adapter = getChatRunAdapter(transport);
  const caps = adapter?.capabilities && typeof adapter.capabilities === 'object'
    ? adapter.capabilities
    : {};
  const contract = describeRecoveryAdapterContract(transport);
  // The intersection with the runtime's own declarations lives in ONE helper,
  // shared with `createDurableRequestLookup`, so this surface and the per-run
  // lookup cannot disagree about the same transport (finding F1).
  const {
    canReattach,
    canResumeSession,
    resumeStrategy,
    transcriptLost,
    transcriptLossReason,
  } = resolveEffectiveRecoveryCapabilities({
    contract,
    canReattachDeclared: caps.canReattach,
    canResumeSessionDeclared: caps.canResumeSession,
  });
  return {
    transport: String(transport || '').trim(),
    canLookupRequest: caps.canLookupRequest === true || typeof adapter?.lookupRequest === 'function',
    canCancel: caps.canCancel !== false,
    canReconstructSession: caps.canReconstructSession === true,
    canReadFiles: caps.canReadFiles === true,
    canSearch: caps.canSearch === true,
    deniesMutation: caps.deniesMutation === true,
    canReattach,
    canResumeSession,
    resumeStrategy,
    recoverySupported: contract.supported,
    recoveryScope: contract.scope,
    recoveryDecision: contract.decision,
    recoveryInfraOutcome: contract.infraOutcome,
    requiresCrashValidation: contract.requiresCrashValidation,
    recoveryValidation: contract.validation,
    transcriptLost,
    transcriptLossReason,
  };
}

/**
 * Durable probe for a requestId the caller already has.
 *
 * `accepted` is tri-state (see the ChatRunAdapter typedef): pass the adapter's
 * answer through untouched apart from normalizing the accepted `runId`, so a
 * caller can still tell `false` (row without acceptance proof) from `null`
 * (adapter has nothing to say / no recovery contract) from a bare `null` result
 * (unknown requestId).
 *
 * @param {{ chatId: string, requestId: string }} input
 * @returns {{ accepted: boolean | null, runId: string } | null}
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
  if (!found || typeof found !== 'object') return null;
  if (found.accepted !== true) return found;
  return {
    ...found,
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
  let chat = loadChatById(input.chatId);
  if (!chat) {
    const error = new Error('Chat not found');
    error.code = 'chat_not_found';
    throw error;
  }
  assertChatCanReceiveMessages(chat);
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
    chat = loadChatById(input.chatId);
    if (!chat) {
      const error = new Error('Chat not found');
      error.code = 'chat_not_found';
      throw error;
    }
    assertChatCanReceiveMessages(chat);
    const requestId = String(input.requestId || '').trim();
    if (requestId) {
      const found = lookupChatRunRequest({ chatId: chat.id, requestId });
      // Proven acceptance alone replays the run: `adapterRunId` is optional in
      // the durable record, and re-sending the prompt for a request the store
      // already recorded as accepted would start a second attempt.
      if (found?.accepted === true) {
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
  const chat = resolveProbeChat(input);
  if (!chat) return null;
  return getChatRunStateForChat(chat, String(input.runId || '').trim());
}

/**
 * A caller that already loaded the chat list can pass `chat` and skip another
 * full read of chats.json. Without it, the row is loaded by id.
 *
 * @param {{ chatId?: string, chat?: object }} input
 * @returns {object | null}
 */
function resolveProbeChat(input) {
  const provided = input?.chat;
  if (provided && typeof provided === 'object' && !Array.isArray(provided)) return provided;
  return loadChatById(input?.chatId);
}

/**
 * Liveness of the run in THIS process, from `getState` alone.
 *
 * Distinguish adapter idle from adapter lookup failure. A missing adapter,
 * null/undefined getState, or a mismatched runId is not proof that the child
 * run ended.
 *
 * Deliberately NOT durable: `lookupRequest` answers "was this requestId ever
 * accepted" from the recovery registry, while this probe answers "is there a
 * live room in this process holding it". A durable-but-dead run (the process
 * restarted and the room Map is empty) therefore stays
 * `{ known:false, busy:false, reason:'state_missing' }` — it must never be
 * reported busy/alive, and equally must never be read as proof that the
 * executor ended.
 *
 * @param {{ chatId?: string, runId?: string, chat?: object }} input
 * @returns {{ known: boolean, busy: boolean, reason: string }}
 */
export function probeChatRunLiveness(input = {}) {
  try {
    const chat = resolveProbeChat(input);
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
      errorCode: typeof state.lastErrorCode === 'string' ? state.lastErrorCode.trim() : '',
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
