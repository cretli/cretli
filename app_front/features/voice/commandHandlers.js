/**
 * Shared executors for voice commands.
 *
 * Three callers reach the same functions so a command behaves identically
 * wherever it was spoken: browser voice mode (`localCommands.js`, Web Speech,
 * no model), the OpenAI/Gemini Realtime tools (`realtimeTools.js`) and the
 * touch UI of the car view. Handlers are keyed idempotent: a repeated call
 * with the same key inside `ttlMs` returns the first result instead of acting
 * twice (a card answered by voice and by tap, a reconnect that replays a tool
 * call).
 *
 * `chat/index.js` is imported lazily: the send bar owns that module and a
 * static import would close an import cycle.
 */

import { t } from '../../i18n/index.js';
import { matchChatBySpokenTitle } from './voiceChatMatch.js';
import { createChatOpsToolHandlers } from './voiceChatOpsTools.js';
import { createInboxToolHandlers } from './voiceInboxTools.js';
import { createOpsToolHandlers } from './voiceOpsTools.js';
import { canSteerSdkChat } from '../chat/services/sdkPendingSteer.js';
import { ORCHESTRATOR_PAGE_SIZE, resolveAgent, summarizeAgents } from '../car/orchestratorModel.js';

/** @typedef {import('./voiceCommandTypes.js').VoiceCommandResult} VoiceCommandResult */
/** @typedef {import('./voiceCommandTypes.js').VoiceChatModule} VoiceChatModule */

const DEFAULT_IDEMPOTENCY_TTL_MS = 4000;
const SEND_WINDOW_MS = 4000;
const STOP_WINDOW_MS = 1500;
const SWITCH_WINDOW_MS = 1000;

/**
 * @param {{ now?: () => number, ttlMs?: number }} [options]
 * @returns {(key: string, run: () => Promise<VoiceCommandResult>, ttl?: number) => Promise<VoiceCommandResult>}
 */
export function createIdempotentRunner(options = {}) {
  const now = options.now || (() => Date.now());
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  /** @type {Map<string, { at: number, ttl: number, result: Promise<VoiceCommandResult> }>} */
  const seen = new Map();
  return (key, run, ttl = ttlMs) => {
    const at = now();
    for (const [entryKey, entry] of seen) {
      if (at - entry.at > entry.ttl) seen.delete(entryKey);
    }
    const hit = key ? seen.get(key) : null;
    if (hit) return hit.result;
    const result = run();
    if (key) {
      seen.set(key, { at, ttl, result });
      // A failure must stay retryable.
      result.then((value) => {
        if (value?.ok === false) seen.delete(key);
      }, () => seen.delete(key));
    }
    return result;
  };
}

/**
 * @param {VoiceChatModule} chatModule
 * @returns {import('./voiceCommandTypes.js').VoiceChat|null}
 */
function findActiveChat(chatModule) {
  const activeId = chatModule.getActiveChatIdValue();
  if (!activeId) return null;
  return chatModule.getChatsList().find((chat) => chat.id === activeId) || null;
}

/**
 * Chats that can be stepped through with "next / previous agent".
 *
 * @param {VoiceChatModule} chatModule
 * @returns {import('./voiceCommandTypes.js').VoiceChat[]}
 */
function listCyclableChats(chatModule) {
  return chatModule.getChatsList().filter((chat) => chat && chat.id && !chat.archived);
}

/**
 * Real dependencies of the `chat_ops` handlers: the chat list, with the archive loaded on demand.
 *
 * @param {VoiceChatModule} chatModule
 * @param {{ submit: (input: { text: string, steer: boolean }) => Promise<VoiceCommandResult> }} options
 * @returns {import('./voiceChatOpsTools.js').ChatOpsDeps}
 */
export function buildChatOpsDeps(chatModule, options) {
  const workspaceName = (workspaceFile) => {
    const list = typeof chatModule.getWorkspacesList === 'function' ? chatModule.getWorkspacesList() : [];
    const entry = Array.isArray(list) ? list.find((item) => item?.workspaceFile && item.workspaceFile === workspaceFile) : null;
    return String(entry?.name || '').trim()
      || String(workspaceFile || '').replace(/.*\//, '').replace(/\.code-workspace$/i, '');
  };
  /** @type {Promise<void>|null} */
  let archiveLoad = null;
  /** Archived rows are loaded lazily by the sidebar; pull them in once per call (the loader has its own freshness check). */
  const ensureArchive = (spokenWorkspace) => {
    if (archiveLoad) return archiveLoad;
    const active = findActiveChat(chatModule);
    const scoped = String(spokenWorkspace ?? '').trim() === '' ? String(active?.workspaceFile || '') : '';
    archiveLoad = typeof chatModule.loadChatsFromServer === 'function'
      ? Promise.resolve(chatModule.loadChatsFromServer({ includeArchived: true, archiveWorkspace: scoped, skipAutoSelect: true })).catch(() => {})
      : Promise.resolve();
    return archiveLoad;
  };
  return {
    listChats: async (scope = {}) => {
      await ensureArchive(scope.workspace);
      return chatModule.getChatsList().filter((chat) => chat?.id).map((chat) => ({
        id: String(chat.id),
        title: String(chat.title || '').trim(),
        workspaceFile: String(chat.workspaceFile || ''),
        workspaceName: workspaceName(chat.workspaceFile),
        harness: String(chat.agentTransport || 'sdk'),
        archived: Boolean(String(chat.archivedAt || '').trim()),
      }));
    },
    getActiveChat: () => {
      const chat = findActiveChat(chatModule);
      if (!chat) return null;
      return {
        id: String(chat.id),
        title: String(chat.title || '').trim(),
        workspaceFile: String(chat.workspaceFile || ''),
        running: chatModule.getChatListAgentStatePublic(chat) === 'active',
        canSteer: canSteerSdkChat(chat),
      };
    },
    // Content hits of one workspace; a failed or slow search degrades to title matches only.
    searchContent: async ({ query, workspaceFile }) => {
      const { getChatContentSearch } = await import('../../core/api/index.js');
      const body = /** @type {{ results?: import('./voiceChatOpsTools.js').ChatContentHit[], truncated?: boolean, timedOut?: boolean }} */ (await getChatContentSearch({ q: query, workspaceFile, archived: true }));
      // The server stops at its time / size budget: that partial scan must reach the spoken answer.
      return { results: Array.isArray(body?.results) ? body.results : [], truncated: body?.truncated === true || body?.timedOut === true };
    },
    // `requestRestoreChat` also selects the restored chat once the list reloads.
    restoreChat: (chatId) => chatModule.requestRestoreChat(chatId),
    submit: options.submit,
  };
}

const AGENT_ERRORS = {
  not_found: 'car.err.agent_not_found',
  none_waiting: 'car.err.none_waiting',
  bad_reference: 'car.err.agent_not_found',
};
const CAR_ERROR_CODES = new Set([
  'stale', 'human_only', 'bad_options', 'no_card', 'ambiguous_card', 'bad_option', 'nothing_to_confirm', 'send_failed',
]);

/**
 * @param {string} code
 * @returns {string}
 */
function carErrorText(code) {
  return t(CAR_ERROR_CODES.has(code) ? `car.err.${code}` : 'car.err.generic');
}

/**
 * @param {{ loadChatModule?: () => Promise<VoiceChatModule>, runOnce?: ReturnType<typeof createIdempotentRunner>, loadCarService?: () => Promise<any>, loadOpsDeps?: () => Promise<import('./voiceOpsTools.js').OpsToolDeps>, loadInboxDeps?: () => Promise<import('./voiceInboxTools.js').InboxToolDeps> }} [deps]
 */
export function createCommandHandlers(deps = {}) {
  const loadChatModule = deps.loadChatModule || (() => /** @type {Promise<VoiceChatModule>} */ (import('../chat/index.js')));
  const runOnce = deps.runOnce || createIdempotentRunner();
  /** @type {Map<string, Promise<VoiceCommandResult>>} */
  const cyclesInFlight = new Map();
  /** @type {ReturnType<typeof createOpsToolHandlers>|null} */
  let opsTools = null;
  /** @type {ReturnType<typeof createInboxToolHandlers>|null} */
  let inboxTools = null;
  /** One shared first load, so two early calls never build two handlers with separate session memory. */
  let inboxToolsLoading = null;
  /** Bumped by resetSession: a call that started before a session boundary must not run after it. */
  let inboxSession = 0;
  const loadCarService = deps.loadCarService || (() => import('../car/carService.js'));
  const loadOpsDeps = deps.loadOpsDeps || (async () => (await import('./voiceOpsDeps.js')).buildOpsDeps());
  const loadInboxDeps = deps.loadInboxDeps || (async () => (await import('./voiceInboxDeps.js')).buildInboxDeps());

  const handlers = {
    /**
     * @param {string} text
     * @param {{ expectChatId?: string, isCurrent?: () => boolean, steer?: boolean }} [options] `steer`: use the send
     *   bar's Steer action (inject into the running turn) instead of queueing. `expectChatId`: refuse when another
     *   chat is active now (the undo window remembers the chat the words were meant for; the send bar belongs
     *   to the active one). `isCurrent`: false once the voice session ended, so a send already in flight is dropped.
     * @returns {Promise<VoiceCommandResult>}
     */
    async sendPrompt(text, options = {}) {
      const prompt = String(text || '').trim();
      if (!prompt) return { ok: false, error: t('car.err.empty_prompt') };
      const cancelled = { ok: false, code: 'cancelled', error: t('car.undo.cancelled') };
      if (options?.isCurrent && !options.isCurrent()) return cancelled;
      const chatModule = await loadChatModule();
      if (options?.isCurrent && !options.isCurrent()) return cancelled;
      const sendBar = chatModule.getActiveSendBar();
      if (!sendBar?.input || typeof sendBar.submit !== 'function') {
        return { ok: false, error: t('car.err.no_chat_open') };
      }
      const chatId = chatModule.getActiveChatIdValue() || '';
      if (options?.expectChatId && options.expectChatId !== chatId) {
        return { ok: false, code: 'chat_changed', error: t('car.err.chat_changed') };
      }
      // The same words to the same chat inside a short window are one prompt (replayed tool call, echo).
      const steer = options?.steer === true;
      return runOnce(`${steer ? 'steer' : 'send'}:${chatId}:${prompt}`, async () => {
        if (options?.isCurrent && !options.isCurrent()) return cancelled;
        sendBar.input.value = prompt;
        const before = findActiveChat(chatModule);
        // The steer was checked when it was requested; the window may have closed since (the turn ended).
        const degraded = steer && !(before && canSteerSdkChat(before));
        if (steer && !degraded) {
          // Steer is the send bar's own action: it reports whether the message really left.
          if ((await sendBar.submit({ actionId: 'steer' })) !== true) {
            return { ok: false, code: 'not_sent', error: t('voice.chatOps.notSent') };
          }
        } else {
          sendBar.submit();
        }
        const chat = findActiveChat(chatModule);
        return {
          ok: true,
          sent: prompt,
          state: chat ? chatModule.getChatListAgentStatePublic(chat) : null,
          ...(degraded ? { degraded: true, message: t('voice.chatOps.steerDegraded') } : {}),
        };
      }, SEND_WINDOW_MS);
    },

    /**
     * Chat search / restore / queue / steer (`chat_ops`). The caller supplies `submit`, the path a queued or
     * steered message takes (the shared voice send gate), so every voice source keeps its own send safety.
     *
     * @param {any} args
     * @param {{ submit: (input: { text: string, steer: boolean }) => Promise<VoiceCommandResult> }} options
     * @returns {Promise<VoiceCommandResult>}
     */
    async chatOps(args, options) {
      const chatModule = await loadChatModule();
      return createChatOpsToolHandlers(buildChatOpsDeps(chatModule, options)).chat_ops(args);
    },

    /**
     * Git status / commit, task stop and quick commands (`ops`). One instance per handler set: the two-step
     * confirmations keep their binding between calls.
     *
     * @param {any} args
     * @param {{ driverConfirm?: { ask: (action: string, target: string) => void, consume: (action: string, target: string) => boolean } }} [options]
     * @returns {Promise<VoiceCommandResult>}
     */
    async ops(args, options) {
      if (!opsTools) {
        opsTools = createOpsToolHandlers(await loadOpsDeps());
      }
      return opsTools.ops(args, options);
    },

    /** Drops a pending `ops` confirmation (another voice tool ran in between). */
    cancelOps() {
      opsTools?.cancelPending();
    },

    /**
     * Notifications and Scout proposals (`inbox`). One instance per handler set: the proposals read in this
     * session and the two-step Scout confirmations live in it.
     *
     * @param {any} args
     * @param {{ driverConfirm?: { ask: (action: string, target: string) => void, consume: (action: string, target: string) => boolean } }} [options]
     * @returns {Promise<VoiceCommandResult>}
     */
    async inbox(args, options) {
      const session = inboxSession;
      if (!inboxTools) {
        inboxToolsLoading ||= loadInboxDeps().then((deps) => {
          inboxTools = createInboxToolHandlers(deps);
          return inboxTools;
        }).finally(() => { inboxToolsLoading = null; });
        await inboxToolsLoading;
      }
      // The session ended while the handlers were loading: the old call must not read proposals into the new one.
      if (session !== inboxSession) return { ok: false, code: 'stale_session', error: 'The voice session changed. Nothing was done.' };
      return inboxTools.inbox(args, options);
    },

    /** Drops a pending `inbox` confirmation (another voice tool ran in between). */
    cancelInbox() {
      inboxTools?.cancelPending();
    },

    /** Voice session boundary (start / stop of Realtime, Gemini or Web Speech): proposals read so far no longer count. */
    resetSession() {
      inboxSession += 1;
      inboxTools?.reset();
      opsTools?.cancelPending();
    },

    /** @returns {Promise<{ id: string, title: string }|null>} the active chat, for the car-mode read-back */
    async getActiveChat() {
      const chatModule = await loadChatModule();
      const chat = findActiveChat(chatModule);
      return chat ? { id: String(chat.id), title: String(chat.title || '').trim() } : null;
    },

    /**
     * Interrupts the active chat's run. `sendKeySequenceToActiveChat('\x03')` covers every chat kind:
     * a PTY chat gets the raw Ctrl-C, an SDK/harness chat (no PTY) gets `{ type: 'cancel' }` over its
     * socket (`sendSequenceToTerminalState` in `terminal/services/inputDispatch.js`), the same call
     * the chat toolbar's stop item makes. A closed socket returns false, reported as "nothing to stop".
     *
     * @returns {Promise<VoiceCommandResult>}
     */
    async stopAgent() {
      const chatModule = await loadChatModule();
      const chatId = chatModule.getActiveChatIdValue() || '';
      // One Ctrl-C per chat inside the window, however many callers asked (touch + voice, replayed call).
      return runOnce(`stop:${chatId}`, async () => {
        const stopped = chatModule.sendKeySequenceToActiveChat('\x03');
        return stopped ? { ok: true } : { ok: false, error: t('car.err.nothing_to_stop') };
      }, STOP_WINDOW_MS);
    },

    /**
     * @param {{ chat_id?: unknown, title?: unknown }} args
     * @returns {Promise<VoiceCommandResult>}
     */
    async switchChat(args) {
      const chatModule = await loadChatModule();
      const chats = chatModule.getChatsList();
      const wantedId = String(args?.chat_id || '').trim();
      if (wantedId) {
        const target = chats.find((chat) => chat.id === wantedId);
        if (!target) return { ok: false, error: t('car.err.chat_not_found') };
        const key = chatModule.getActiveChatIdValue() === target.id ? `switch:${target.id}` : '';
        return runOnce(key, async () => {
          if (chatModule.getActiveChatIdValue() !== target.id) {
            chatModule.selectChat(target.id, { byUser: true });
          }
          return { ok: true, chatId: target.id, title: String(target.title || '').trim() };
        }, SWITCH_WINDOW_MS);
      }
      const result = matchChatBySpokenTitle(chats, /** @type {string} */ (args?.title));
      if (result.ambiguous) {
        return {
          ok: false,
          error: `${t('car.err.agent_ambiguous')} ${(result.candidates || []).slice(0, 8).join(', ')}`,
          candidates: result.candidates,
        };
      }
      if (!result.match) return { ok: false, error: t('car.err.chat_not_found') };
      return handlers.switchChat({ chat_id: result.match.id });
    },

    /**
     * Steps to the next or previous open chat; wraps around.
     *
     * @param {1|-1} direction
     * @returns {Promise<VoiceCommandResult>}
     */
    async cycleChat(direction) {
      const chatModule = await loadChatModule();
      const chats = listCyclableChats(chatModule);
      if (chats.length < 2) return { ok: false, error: t('car.err.no_other_chat') };
      const activeId = chatModule.getActiveChatIdValue();
      const step = direction < 0 ? -1 : 1;
      const key = activeId ? `cycle:${activeId}:${step}` : '';
      // A finished cycle is never reused: the active chat has moved on, so a cached success would be stale.
      const pending = cyclesInFlight.get(key);
      if (key && pending) return pending;
      const run = (async () => {
        const index = chats.findIndex((chat) => chat.id === activeId);
        const nextIndex = index < 0 ? 0 : (index + step + chats.length) % chats.length;
        const target = chats[nextIndex];
        chatModule.selectChat(target.id, { byUser: true });
        return { ok: true, chatId: target.id, title: String(target.title || '').trim() };
      })();
      if (key) {
        cyclesInFlight.set(key, run);
        const clear = () => cyclesInFlight.delete(key);
        run.then(clear, clear);
      }
      return run;
    },

    /**
     * @param {{ workspace?: unknown, folder?: unknown }} args
     * @returns {Promise<VoiceCommandResult>}
     */
    async switchWorkspace(args) {
      const chatModule = await loadChatModule();
      if (typeof chatModule.switchVoiceWorkspace !== 'function') {
        return { ok: false, error: t('car.err.workspace_unavailable') };
      }
      return chatModule.switchVoiceWorkspace({ workspace: /** @type {string} */ (args?.workspace), folder: /** @type {string} */ (args?.folder) });
    },

    /**
     * "Switch to <name>": a chat title wins when it is unique, otherwise the
     * name is tried as a workspace. A name that fits both is reported as
     * ambiguous instead of guessing.
     *
     * @param {string} spoken
     * @returns {Promise<VoiceCommandResult>}
     */
    async switchTo(spoken) {
      const name = String(spoken || '').trim();
      if (!name) return { ok: false, error: t('car.err.agent_not_found') };
      const chatModule = await loadChatModule();
      const chatHit = matchChatBySpokenTitle(chatModule.getChatsList(), name);
      if (chatHit.match) return handlers.switchChat({ chat_id: chatHit.match.id });
      if (chatHit.ambiguous) return handlers.switchChat({ title: name });
      return handlers.switchWorkspace({ workspace: name });
    },

    /**
     * Opens or closes the car view. Idempotent.
     *
     * @param {boolean} [enable]
     * @returns {Promise<VoiceCommandResult>}
     */
    async setCarMode(enable = true) {
      const car = await loadCarService();
      if (enable === false) return car.closeCarView();
      return car.openCarView();
    },

    /**
     * Opens the agents screen (every workspace) or returns to the decision screen.
     *
     * @param {boolean} [enable]
     * @returns {Promise<VoiceCommandResult>}
     */
    async setOrchestrator(enable = true) {
      const car = await loadCarService();
      return car.setOrchestratorScreen(enable);
    },

    /** @returns {Promise<VoiceCommandResult>} agents of all workspaces, needs-decision first */
    async listAgents() {
      const car = await loadCarService();
      const rows = await car.loadAgentRows();
      return {
        ok: true,
        total: rows.length,
        agents: rows.slice(0, ORCHESTRATOR_PAGE_SIZE).map((row) => ({
          chat_id: row.chatId,
          title: row.title,
          workspace: row.workspaceLabel,
          status: row.status,
          active: row.active,
        })),
        message: summarizeAgents(rows, t),
      };
    },

    /**
     * Switches to an agent of any workspace: by id, by spoken name (optionally
     * with a workspace), or "the one that waits for me".
     *
     * @param {{ chat_id?: unknown, name?: unknown, workspace?: unknown, waiting?: unknown, announced?: unknown }} args
     * @returns {Promise<VoiceCommandResult>}
     */
    async switchAgent(args) {
      const car = await loadCarService();
      const announced = args?.announced === true || args?.announced === 'true';
      const announcedId = announced ? car.getLastAnnouncedChatId() : '';
      if (announced && !announcedId) return { ok: false, code: 'nothing_announced', error: t('car.announce.nothing') };
      const rows = await car.loadAgentRows();
      const found = /** @type {ReturnType<typeof resolveAgent> & { code?: string, candidates?: string[] }} */ (resolveAgent(rows, {
        chatId: announcedId || String(args?.chat_id || '').trim() || undefined,
        name: String(args?.name || '').trim() || undefined,
        workspace: String(args?.workspace || '').trim() || undefined,
        waiting: args?.waiting === true || args?.waiting === 'true',
      }));
      if (!found.ok) {
        return {
          ok: false,
          code: found.code,
          error: found.code === 'ambiguous'
            ? `${t('car.err.agent_ambiguous')} ${(found.candidates || []).slice(0, 6).join(', ')}`
            : t(AGENT_ERRORS[found.code] || 'car.err.generic'),
          candidates: found.candidates,
        };
      }
      // Selecting a chat of another workspace switches the workspace with it.
      const result = await handlers.switchChat({ chat_id: found.row.chatId });
      return result.ok === false
        ? result
        : { ...result, workspace: found.row.workspaceLabel, status: found.row.status };
    },

    /** @returns {Promise<VoiceCommandResult>} "What's new / repeat": the newest car-mode announcement, spoken again */
    async whatsNew() {
      const car = await loadCarService();
      return car.repeatLastAnnouncement();
    },

    /**
     * First step of answering a decision card: remember the pick, ask for a yes.
     *
     * @param {{ option?: unknown, card_id?: unknown }} args
     * @returns {Promise<VoiceCommandResult>}
     */
    async chooseOption(args) {
      const car = await loadCarService();
      await car.refreshCarCards();
      // The screen shows the lessons aggregate: nothing to decide, and no other card may be picked blindly.
      if (!String(args?.card_id || '').trim() && car.isCarOnLessonsAggregate?.()) {
        return { ok: false, error: carErrorText('no_card'), code: 'no_card' };
      }
      // Voice never passes a `source`: cards only a person may decide are refused here and need a tap.
      const result = car.getCarChoiceFlow().choose({
        cardId: String(args?.card_id || '').trim() || car.getCurrentCarCard?.()?.id || undefined,
        option: args?.option,
      });
      if (!result.ok) return { ok: false, error: carErrorText(result.code), code: result.code };
      const label = car.localizedPickLabel?.(result.cardId, result.optionId, result.label) || result.label;
      return {
        ok: true,
        needsConfirm: true,
        option: result.index,
        label,
        cardId: result.cardId,
        message: t('car.choosing', { label }),
      };
    },

    /**
     * Steps the car view to the next/previous decision card ("next card").
     *
     * @param {number} direction 1 = next, -1 = previous
     * @returns {Promise<VoiceCommandResult>}
     */
    async cycleCard(direction) {
      const car = await loadCarService();
      await car.refreshCarCards();
      const { card, index, total } = car.stepCarCard(direction < 0 ? -1 : 1);
      if (!card) return { ok: false, error: carErrorText('no_card'), code: 'no_card' };
      return {
        ok: true,
        cardId: card.id,
        position: index + 1,
        total,
        title: car.carCardTitle(card),
        message: t('car.cardPosition', { n: index + 1, total, title: car.carCardTitle(card) }),
      };
    },

    /**
     * Second step: send the pick (or drop it with `confirm: false`).
     *
     * @param {{ confirm?: unknown }} args
     * @returns {Promise<VoiceCommandResult>}
     */
    async confirmChoice(args) {
      const car = await loadCarService();
      const flow = car.getCarChoiceFlow();
      if (args?.confirm === false || args?.confirm === 'false') {
        flow.cancel();
        return { ok: true, cancelled: true, message: t('car.cancelled') };
      }
      const result = await flow.confirm();
      if (!result.ok) return { ok: false, error: carErrorText(result.code || ''), code: result.code };
      return { ok: true, optionId: result.optionId, message: t('car.sent') };
    },

    /**
     * @param {string} key idempotency key
     * @param {() => Promise<VoiceCommandResult>} run
     * @returns {Promise<VoiceCommandResult>}
     */
    once(key, run) {
      return runOnce(key, run);
    },
  };

  return handlers;
}

export const commandHandlers = createCommandHandlers();
