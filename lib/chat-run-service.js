/**
 * Server-side chat run start/cancel, shared by interactive WS and delegations.
 */

import { getChatByCursorSessionIdAsync, getChatByIdAsync, peekChatsAsync } from './persist/chats-persist.js';
// Sync probes read the in-process row index fed by the chats facade (lib/chat-row-index.js), never a chat store, so
// they work on every backend; a chat the facade has not handed out yet reads as missing. Callers that can
// await use the `*Async` twins below.
import { getIndexedChatRow, getIndexedChatRowBySession, listIndexedChatRows } from './chat-row-index.js';
import { getChatAgentTransport } from './agent-transport.js';
import { assertCanAcceptNewRun } from './update-gate.js';
import { markAgentPresenceDirty } from './agent-presence-hooks.js';
import { assertChatCanReceiveMessages } from './chat-message-guard.js';
import { describeRecoveryAdapterContract } from './recovery/recovery-contract.ts';
import { resolveEffectiveRecoveryCapabilities } from './chat-run/adapter-capabilities.ts';
import { createServerShuttingDownError, isServerShuttingDown } from './update-gate.js';
import { withTimeout } from './with-timeout.js';
import {
  beginChatRunRecord,
  recordChatRunAccepted,
  recordChatRunStartFailed,
  noteChatRunStopped,
} from './chat-run/chat-run-recovery.ts';

/** @type {Map<string, ChatRunAdapter>} */
const adapters = new Map();

/** @type {Map<string, Promise<unknown>>} */
const startLocks = new Map();

/** @type {Set<(event: { chatId: string, origin: string }) => void>} */
const runStartObservers = new Set();

/**
 * Observes every server-side run start AFTER the executor accepted it. The
 * `origin` is `keep_alive` for a keep-alive ping and `other` for everything
 * else, so a scheduler can tell its own turns from a user or review turn
 * without reading chat history. Observers must not throw into the start path.
 *
 * @param {(event: { chatId: string, origin: string }) => void} observer
 * @returns {() => void} unsubscribe
 */
export function observeChatRunStarts(observer) {
  if (typeof observer !== 'function') return () => {};
  runStartObservers.add(observer);
  return () => runStartObservers.delete(observer);
}

function notifyRunStarted(chatId, deps) {
  const origin = deps && typeof deps === 'object' && deps.keepAlive === true ? 'keep_alive' : 'other';
  for (const observer of runStartObservers) {
    try {
      observer({ chatId, origin });
    } catch {
      // An observer never breaks a run start.
    }
  }
}

/**
 * lookupRequest `accepted` is tri-state: `true` = durable proof the executor
 * took the run, `false` = a run row exists without acceptance proof, `null` =
 * the adapter cannot answer (no recovery contract). Only `true` is evidence of
 * a start; `null` must never be read as "ended".
 *
 * @typedef {{
 *   transport: string,
 *   start: (input: {
 *     chat: Record<string, any>,
 *     prompt: string,
 *     mode?: string,
 *     requestId?: string,
 *     displayText?: string,
 *     origin?: import('./chat-run/start-prompt-args.ts').StartPromptInput['origin'],
 *     selectedSkillIds?: string[],
 *     deps?: Record<string, any>,
 *     recoveryRecord?: unknown,
 *   }) => Promise<{ runId: string, accepted?: boolean }>,
 *   cancel: (input: { chat: Record<string, any>, runId?: string }) => Promise<void>,
 *   getState: (input: { chat: Record<string, any>, runId?: string }) => {
 *     runId: string,
 *     busy: boolean,
 *     waitingForInput?: boolean,
 *   } | null,
 *   listLiveRuns?: () => Array<{ chatId: string, sessionId: string, busy: boolean, canSteer: boolean }>,
 *   steerLiveRun?: (input: { chat: Record<string, any>, text: string }) => Promise<void>,
 *   lookupRequest?: (input: { chat: Record<string, any>, requestId: string }) => {
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
 * @param {{ timeoutMs?: number }} [opts] `timeoutMs` bounds the wait for the predecessor (opt-in; default unbounded).
 *   On expiry the task never runs and `start_lock_timeout` is thrown.
 * @returns {Promise<T>}
 * @template T
 */
export async function withChatRunStartLock(chatId, task, opts = {}) {
  const key = String(chatId || '').trim();
  const previous = startLocks.get(key) || Promise.resolve();
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate, () => gate);
  startLocks.set(key, chain);
  const cleanup = () => {
    if (startLocks.get(key) === chain) startLocks.delete(key);
  };
  const timeoutMs = Number(opts?.timeoutMs);
  if (timeoutMs > 0) {
    try {
      await withTimeout(previous.catch(() => {}), timeoutMs, 'start_lock_timeout');
    } catch (err) {
      // Give up our turn without running the task. The map entry must stay while the predecessor is still
      // running, otherwise a later waiter would see no predecessor and run beside the holder; `chain` settles
      // only after `previous` does, so cleanup runs then (identity check unchanged).
      release();
      chain.then(cleanup, cleanup);
      throw err;
    }
  } else {
    await previous.catch(() => {});
  }
  try {
    return await task();
  } finally {
    release();
    cleanup();
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
 * Live rooms across adapters that expose them (Claude / Codex kernel adapters).
 * Used by the fast-restart orchestration; adapters without `listLiveRuns` are skipped.
 *
 * @returns {Array<{ transport: string, chatId: string, sessionId: string, busy: boolean, canSteer: boolean }>}
 */
export function listLiveChatRuns() {
  const out = [];
  for (const [transport, adapter] of adapters) {
    if (typeof adapter?.listLiveRuns !== 'function') continue;
    try {
      for (const run of adapter.listLiveRuns()) out.push({ transport, ...run });
    } catch { /* one broken adapter must not hide the others */ }
  }
  return out;
}

/**
 * Steer a live turn of a chat (throws when the adapter or room cannot steer).
 *
 * @param {{ transport: string, chatId: string, text: string }} input
 */
export async function steerLiveChatRun(input) {
  const adapter = adapters.get(String(input?.transport || '').trim());
  if (!adapter || typeof adapter.steerLiveRun !== 'function') throw new Error('steer_unsupported');
  const chat = await loadChatByIdAsync(String(input.chatId || ''));
  if (!chat) throw new Error('chat_not_found');
  await adapter.steerLiveRun({ chat, text: String(input.text || '') });
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
 * @returns {Record<string, any> | null}
 */
export function getChatRunAdapter(transport) {
  return adapters.get(String(transport || '').trim()) || null;
}

/**
 * Live adapter contract for one transport: what the registered adapter can do
 * at runtime, narrowed by the static recovery contract in
 * `lib/recovery/recovery-contract.ts` (the single source for the MVP table).
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
 * @param {{ chatId: string, requestId: string, chat?: Record<string, any> }} input `chat` skips the row read
 * @returns {{ accepted: boolean | null, runId?: string } | null}
 */
export function lookupChatRunRequest(input) {
  return lookupChatRunRequestForChat(input.chat || loadChatById(input.chatId), input);
}

/**
 * Async twin of `lookupChatRunRequest`: the row is read through the active chats runtime.
 *
 * @param {{ chatId: string, requestId: string, chat?: Record<string, any> }} input
 * @returns {Promise<{ accepted: boolean | null, runId?: string } | null>}
 */
export async function lookupChatRunRequestAsync(input) {
  return lookupChatRunRequestForChat(input.chat || await loadChatByIdAsync(input.chatId), input);
}

/**
 * @param {Record<string, any> | null | undefined} chat
 * @param {{ requestId: string }} input
 */
function lookupChatRunRequestForChat(chat, input) {
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
 * @returns {Record<string, any> | null}
 */
function loadChatById(chatId) {
  // Sync entry points kept for unconverted callers (delegation, watcher): the in-process row index, any backend.
  return getIndexedChatRow(chatId);
}

/**
 * @param {string} chatId
 * @returns {Promise<Record<string, any> | null>}
 */
async function loadChatByIdAsync(chatId) {
  return getChatByIdAsync(chatId);
}

function throwRecipientBusy() {
  const error = /** @type {Error & { code?: string }} */ (new Error('Recipient is busy'));
  error.code = 'recipient_busy';
  throw error;
}

/**
 * @param {{ timeouts?: { lockMs?: number, startMs?: number }, chatId: string, prompt: string, mode?: string, requestId?: string, displayText?: string, selectedSkillIds?: string[], origin?: { kind: string, subtype?: string, clientId?: string, clientName?: string, sourceChatId?: string, sourceChatTitle?: string }, deps?: Record<string, any> }} input `selectedSkillIds` are explicit
 *   skill IDs for this run; the prompt text itself never activates a skill here.
 * @returns {Promise<{ runId: string, chatId: string, transport: string, accepted: boolean }>}
 */
export async function startChatRun(input) {
  // R9: once shutdown began, no new run may start (not even a queue drain).
  if (isServerShuttingDown()) throw createServerShuttingDownError();
  let chat = await loadChatByIdAsync(input.chatId);
  if (!chat) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Chat not found'));
    error.code = 'chat_not_found';
    throw error;
  }
  assertChatCanReceiveMessages(chat);
  const transport = getChatAgentTransport(chat);
  const adapter = adapters.get(transport);
  if (!adapter) {
    const error = /** @type {Error & { code?: string }} */ (new Error(`Server-side start is not available for ${transport}`));
    error.code = 'adapter_unavailable';
    throw error;
  }
  const rawPrompt = String(input.prompt || '').trim();
  if (!rawPrompt) {
    const error = /** @type {Error & { code?: string }} */ (new Error('Prompt is required'));
    error.code = 'prompt_required';
    throw error;
  }
  const allowedOrigins = new Set(['operator', 'delegation', 'mailbox', 'watcher', 'system']);
  const origin = allowedOrigins.has(input.origin?.kind) ? {
    kind: input.origin.kind,
    ...(typeof input.origin.subtype === 'string' ? { subtype: input.origin.subtype } : {}),
    ...(typeof input.origin.clientId === 'string' ? { clientId: input.origin.clientId } : {}),
    ...(typeof input.origin.clientName === 'string' ? { clientName: input.origin.clientName } : {}),
    ...(typeof input.origin.sourceChatId === 'string' ? { sourceChatId: input.origin.sourceChatId } : {}),
    ...(typeof input.origin.sourceChatTitle === 'string' ? { sourceChatTitle: input.origin.sourceChatTitle } : {}),
  } : undefined;
  const safeLabel = String(origin?.clientName || '')
    // eslint-disable-next-line no-control-regex -- strip control chars and brackets from the label
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const promptPrefix = origin?.kind === 'operator'
    ? `[Operator Cretli${safeLabel ? ` — ${safeLabel}` : ''}]`
    : origin?.kind === 'mailbox' ? '[Mailbox Cretli]' : '';
  const prompt = promptPrefix ? `${promptPrefix}\n${rawPrompt}` : rawPrompt;
  const lockMs = Number(input.timeouts?.lockMs);
  const startMs = Number(input.timeouts?.startMs);
  // Shared with a timed-out in-lock section: once abandoned, a late `adapter.start` must not flip the failed record.
  const section = { abandoned: false, record: /** @type {any} */ (null) };
  const locked = async () => {
    chat = await loadChatByIdAsync(input.chatId);
    if (section.abandoned) throwStartTimeout();
    if (!chat) {
      const error = /** @type {Error & { code?: string }} */ (new Error('Chat not found'));
      error.code = 'chat_not_found';
      throw error;
    }
    assertChatCanReceiveMessages(chat);
    const requestId = String(input.requestId || '').trim();
    if (requestId) {
      const found = lookupChatRunRequestForChat(chat, { requestId });
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
    // A durable replay returned above; anything that reaches this point is a new
    // run, so refuse it while an update/install owns the update slot.
    assertCanAcceptNewRun();
    const state = getChatRunStateForChat(chat);
    if (state?.busy || state?.waitingForInput) throwRecipientBusy();
    // Durable intent BEFORE the prompt reaches the executor (R5). A failed
    // write throws `launch_blocked` and nothing is started.
    const record = beginChatRunRecord({ chat, transport, requestId, mode: input.mode || 'agent' });
    section.record = record;
    let result;
    try {
      result = await adapter.start({
        chat,
        prompt,
        mode: input.mode || 'agent',
        requestId,
        recoveryRecord: record,
        displayText: input.displayText || '',
        origin,
        selectedSkillIds: Array.isArray(input.selectedSkillIds) ? input.selectedSkillIds : [],
        deps: input.deps || {},
      });
    } catch (err) {
      if (record && !section.abandoned) recordChatRunStartFailed({ record, error: err });
      throw err;
    }
    const accepted = result?.accepted !== false;
    const runId = String(result?.runId || '').trim();
    if (section.abandoned) {
      // Late acceptance after `adapter_start_timeout`: the record already failed. Stop exactly this run (never a
      // chat-level cancel), bounded and best-effort.
      if (accepted && runId) {
        withTimeout(cancelChatRun({ chatId: chat.id, runId, reason: 'internal_cancel' }), startMs > 0 ? startMs : 15000, 'adapter_start_timeout')
          .catch((err) => console.warn('[chat-run] late cancel of abandoned start failed:', chat.id, err?.message || err));
      }
      throwStartTimeout();
    }
    if (!accepted) {
      if (record) recordChatRunStartFailed({ record, error: { code: 'recipient_busy' } });
      throwRecipientBusy();
    }
    if (record) recordChatRunAccepted({ record, runId });
    markAgentPresenceDirty([chat.id]);
    notifyRunStarted(chat.id, input.deps);
    return {
      runId,
      accepted: true,
      chatId: chat.id,
      transport,
    };
  };
  const bounded = startMs > 0
    ? async () => {
      try {
        return await withTimeout(locked(), startMs, 'adapter_start_timeout');
      } catch (err) {
        if (err?.code === 'adapter_start_timeout' && !section.abandoned) {
          section.abandoned = true;
          if (section.record) recordChatRunStartFailed({ record: section.record, error: err });
        }
        throw err;
      }
    }
    : locked;
  return withChatRunStartLock(chat.id, bounded, lockMs > 0 ? { timeoutMs: lockMs } : {});
}

function throwStartTimeout() {
  const error = /** @type {Error & { code?: string }} */ (new Error('Run start timed out'));
  error.code = 'adapter_start_timeout';
  throw error;
}

/**
 * @param {{ chatId: string, runId?: string, reason?: string }} input
 */
export async function cancelChatRun(input) {
  const chat = await loadChatByIdAsync(input.chatId);
  if (!chat) return;
  const adapter = adapters.get(getChatAgentTransport(chat));
  if (!adapter) return;
  // Durable User Stop first: it must forbid auto-resume even if we crash next.
  noteChatRunStopped(/** @type {Parameters<typeof noteChatRunStopped>[0]} */ ({
    chatId: chat.id,
    runId: input.runId,
    reason: input.reason || 'internal_cancel',
  }));
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
 * Async twin of `getChatRunState`.
 *
 * @param {{ chatId?: string, runId?: string, chat?: Record<string, any> }} input
 */
export async function getChatRunStateAsync(input) {
  const chat = await resolveProbeChatAsync(input);
  if (!chat) return null;
  return getChatRunStateForChat(chat, String(input.runId || '').trim());
}

/**
 * A caller that already loaded the chat list can pass `chat` and skip another
 * full read of chats.json. Without it, the row is loaded by id.
 *
 * @param {{ chatId?: string, chat?: Record<string, any> }} input
 * @returns {Record<string, any> | null}
 */
function resolveProbeChat(input) {
  const provided = input?.chat;
  if (provided && typeof provided === 'object' && !Array.isArray(provided)) return provided;
  return loadChatById(input?.chatId);
}

/**
 * @param {{ chatId?: string, chat?: Record<string, any> }} input
 * @returns {Promise<Record<string, any> | null>}
 */
async function resolveProbeChatAsync(input) {
  const provided = input?.chat;
  if (provided && typeof provided === 'object' && !Array.isArray(provided)) return provided;
  return loadChatByIdAsync(String(input?.chatId || ''));
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
 * @param {{ chatId?: string, runId?: string, chat?: Record<string, any> }} input
 * @returns {{ known: boolean, busy: boolean, reason: string, errorCode?: string }}
 */
export function probeChatRunLiveness(input = {}) {
  try {
    // Absence in the row index reads as `chat_missing`: boot warms the index with every row before any probe consumer
    // starts and every later create/read goes through the facade, so it is authoritative once the server is up.
    return probeChatRunLivenessForChat(resolveProbeChat(input), input);
  } catch {
    return { known: false, busy: false, reason: 'probe_failed' };
  }
}

/**
 * Async twin of `probeChatRunLiveness`: the row (when `chat` is not supplied) is read through the active runtime.
 *
 * @param {{ chatId?: string, runId?: string, chat?: Record<string, any> }} input
 * @returns {Promise<{ known: boolean, busy: boolean, reason: string, errorCode?: string }>}
 */
export async function probeChatRunLivenessAsync(input = {}) {
  try {
    return probeChatRunLivenessForChat(await resolveProbeChatAsync(input), input);
  } catch {
    return { known: false, busy: false, reason: 'probe_failed' };
  }
}

/**
 * @param {Record<string, any> | null | undefined} chat
 * @param {{ runId?: string }} input
 * @returns {{ known: boolean, busy: boolean, reason: string, errorCode?: string }}
 */
function probeChatRunLivenessForChat(chat, input) {
  try {
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
 * @param {{ chatId?: string, runId?: string, chat?: Record<string, any> }} input
 * @returns {boolean}
 */
export function isChatRunConfirmedIdle(input = {}) {
  const live = probeChatRunLiveness(input);
  return live.known === true && live.busy === false;
}

/**
 * Async twin of `isChatRunConfirmedIdle`.
 *
 * @param {{ chatId?: string, runId?: string, chat?: Record<string, any> }} input
 * @returns {Promise<boolean>}
 */
export async function isChatRunConfirmedIdleAsync(input = {}) {
  const live = await probeChatRunLivenessAsync(input);
  return live.known === true && live.busy === false;
}

/**
 * @param {Record<string, any> | null | undefined} chat
 * @param {string} [runId]
 */
export function getChatRunStateForChat(chat, runId = '') {
  if (!chat) return null;
  const adapter = adapters.get(getChatAgentTransport(chat));
  if (!adapter) return null;
  return adapter.getState({ chat, runId: String(runId || '').trim() });
}

/**
 * Count chats with a live adapter run (busy or waiting for input). Uses
 * in-process adapter state only — the same signal the update gate needs to
 * avoid replacing files under an interactive or server-started chat run.
 *
 * @returns {number}
 */
export function countActiveChatRuns() {
  return countActiveRunsIn(listIndexedChatRows());
}

/**
 * Async twin of `countActiveChatRuns`.
 *
 * @returns {Promise<number>}
 */
export async function countActiveChatRunsAsync() {
  return countActiveRunsIn(await peekChatsAsync());
}

/** @param {ReadonlyArray<Record<string, any>>} chats */
function countActiveRunsIn(chats) {
  let count = 0;
  for (const chat of chats) {
    const state = getChatRunStateForChat(chat);
    if (state?.busy || state?.waitingForInput) count += 1;
  }
  return count;
}

/**
 * @param {string} sessionKey
 * @returns {Record<string, any> | null}
 */
export function getChatBySessionKey(sessionKey) {
  return getIndexedChatRowBySession(sessionKey);
}

/**
 * @param {string} sessionKey
 * @returns {Promise<Record<string, any> | null>}
 */
export async function getChatBySessionKeyAsync(sessionKey) {
  return getChatByCursorSessionIdAsync(sessionKey);
}
