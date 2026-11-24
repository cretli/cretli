/**
 * Executes the tool calls the Realtime model makes.
 *
 * The tool schemas live on the server
 * (`lib/voice/realtime-session-config.ts`) so the browser cannot widen its own
 * permissions; this file only maps names to actions in the running app.
 *
 * `chat.js` and `tasks.js` are imported lazily: the voice panel is reached from
 * the send bar, which chat.js itself owns, and a static import would close that
 * cycle.
 */

import { isVoiceActionId } from '../../../lib/voice/action-registry.ts';
import {
  getTasks,
} from '../../core/api/index.js';
import { getChatSpeaker } from './chatSpeaker.js';
import { commandHandlers } from './commandHandlers.js';
import { getVoiceSendGate } from './voiceSendGate.js';
import { createConfirmGuard } from './voiceConfirmGuard.js';
import { createConfirmBinding } from './voiceConfirmBinding.js';
import { isCarViewOpen } from '../car/carViewProbe.js';
import { t } from '../../i18n/index.js';
import { toSpeakableText } from './speakableText.js';
import { matchChatBySpokenTitle } from './voiceChatMatch.js';
import { resolveVoiceHarness } from './voiceHarnessMatch.js';
import { compactVoiceModelList } from './voiceModelListCompact.js';
import { matchModelBySpokenName } from './voiceModelMatch.js';
import { resolveVoiceNavKey } from './voiceNavMatch.js';
import { resolveVoiceReadMode } from './voiceReadMatch.js';
import { resolveVoiceSdkMode } from './voiceSdkMode.js';
import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.ts';
import { matchTaskBySpokenLabel } from './voiceTaskMatch.js';
import { getReadMode, setReadMode } from './voicePrefs.js';
import { getConnectionSnapshot as connectionSnapshotRef } from '../connection/connectionStatus.js';
import { createAppToolHandlers, readActivePanelId } from './voiceAppTools.js';
import {
  collectPendingApprovals,
  createApprovalToolHandlers,
  readClosedPermissionRequestIds,
  readPendingPermissionCards,
} from '../approval/voiceApprovalTools.js';
import { createWorkToolHandlers } from './voiceWorkTools.js';
import { buildWorkToolDeps } from './realtimeWorkDeps.js';
import { installToolFamilies } from './realtimeToolFamilies.js';
import { getTodoWorkspaceFolder } from '../todo/todoWorkspaceScope.js';
import { getVoiceSessionUsd } from './voiceSessionState.js';
import { formatUsd } from './voiceCost.js';
import { appendVoiceSessionEvent } from './voiceSessionLog.js';

const DEFAULT_ANSWER_CHARS = 1200;

/** Hard two-step confirm and the send_now cooldown (the tool descriptions alone cannot enforce them). */
let confirmGuard = createConfirmGuard();

/** @returns {Promise<string>} the active chat id, '' when it cannot be read */
async function activeChatIdOrEmpty() {
  try {
    return String((await commandHandlers.getActiveChat?.())?.id || '');
  } catch {
    return '';
  }
}

/** Test seam: swaps the guard (e.g. one with a manual clock). */
export function setRealtimeConfirmGuard(guard) {
  confirmGuard = guard || createConfirmGuard();
}

/** The Realtime session heard the driver start a new utterance. */
export function noteRealtimeUserSpeech() {
  confirmGuard.noteUserSpeech();
}

/** Two-step bindings of `workspace` task_run and `delete_chat` (one pending at a time). */
const stepBinding = createConfirmBinding();

/** Driver-speech guard handed to the bindings; reads the current guard so a swapped one is honoured. */
const driverConfirm = {
  ask: (action, target) => confirmGuard.askConfirm(action, target),
  consume: (action, target) => confirmGuard.consumeConfirm(action, target),
};

/** @returns {Promise<{ workspaceFolder: string, chatId: string }>} what a step-one binding is tied to */
async function bindingContext() {
  return { workspaceFolder: String(getTodoWorkspaceFolder() || ''), chatId: await activeChatIdOrEmpty() };
}

/**
 * Forgets pending confirmations, the submit cooldown and the proposals read so far when a voice session
 * starts or ends (Realtime, Gemini; the Web Speech mode calls `commandHandlers.resetSession` itself).
 */
export function resetRealtimeToolGuards() {
  confirmGuard.reset();
  stepBinding.cancel();
  commandHandlers.resetSession?.();
}

/** @type {Promise<object>|null} */
let chatModulePromise = null;
/** @type {Promise<object>|null} */
let tasksModulePromise = null;

/** Test seam: replaces the lazily imported chat / tasks modules and the task list request. */
export function setRealtimeToolModules(overrides) {
  chatModulePromise = overrides?.chat ? Promise.resolve(overrides.chat) : null;
  tasksModulePromise = overrides?.tasks ? Promise.resolve(overrides.tasks) : null;
  fetchTaskList = overrides?.getTasks || getTasks;
}

let fetchTaskList = getTasks;

function loadChatModule() {
  if (!chatModulePromise) chatModulePromise = import('../chat/index.js');
  return chatModulePromise;
}

function loadTasksModule() {
  if (!tasksModulePromise) tasksModulePromise = import('../tasks/index.js');
  return tasksModulePromise;
}

/**
 * @param {any} chatModule
 * @returns {object|null}
 */
function findActiveChat(chatModule) {
  const activeId = chatModule.getActiveChatIdValue();
  if (!activeId) return null;
  return chatModule.getChatsList().find((chat) => chat.id === activeId) || null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isToolConfirm(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * @param {any} chatModule
 * @param {{ chat_id?: unknown, title?: unknown, current_title?: unknown }} args
 * @returns {{ ok: true, chat: object } | { ok: false, error: string, candidates?: string[] }}
 */
function resolveChatTarget(chatModule, args) {
  const chats = chatModule.getChatsList();
  const wantedId = String(args?.chat_id || '').trim();
  if (wantedId) {
    const target = chats.find((chat) => chat.id === wantedId);
    if (!target) return { ok: false, error: 'Chat not found' };
    return { ok: true, chat: target };
  }
  const spoken = String(args?.title || args?.current_title || '').trim();
  if (spoken) {
    const result = matchChatBySpokenTitle(chats, spoken);
    if (result.ambiguous) {
      return {
        ok: false,
        error: `Ambiguous chat title. Candidates: ${(result.candidates || []).slice(0, 8).join(', ')}`,
        candidates: result.candidates,
      };
    }
    if (!result.match) return { ok: false, error: 'Chat not found' };
    return { ok: true, chat: result.match };
  }
  const active = findActiveChat(chatModule);
  if (!active) return { ok: false, error: 'No chat is open' };
  return { ok: true, chat: active };
}

/**
 * @param {number} maxChars
 * @returns {Promise<string>}
 */
async function readLastAnswerText(maxChars) {
  // The speaker keeps the answer already stripped of code, paths and links.
  let speakable = getChatSpeaker().getLastAnswerText();
  if (!speakable) {
    // Nothing tracked yet (voice mode opened mid-run): fall back to the raw pane.
    const chatModule = await loadChatModule();
    speakable = toSpeakableText(chatModule.getActiveChatBufferTail(6000));
  }
  if (!speakable) return '';
  return speakable.length > maxChars ? speakable.slice(-maxChars) : speakable;
}

/**
 * Real dependencies of the panel / settings / status tools. App modules are
 * imported on demand so loading this file stays cheap (and DOM-free in tests).
 */
const appTools = createAppToolHandlers({
  getDocument: () => (typeof document !== 'undefined' ? document : null),
  async setTheme(value) {
    (await import('../../core/theme/theme.js')).setTheme(value);
  },
  getLang: () => (typeof document !== 'undefined' ? document.documentElement.getAttribute('lang') || '' : ''),
  async setLang(value) {
    await (await import('../../i18n/index.js')).setLang(value);
  },
  async getNotificationState() {
    return (await import('../notifications/notificationStore.js')).getNotificationStore()?.getState() || null;
  },
  async fetchScout() {
    const { watcherApi } = await import('../settings/watcher/api.js');
    return watcherApi('/api/workspace-watcher/scout?status=pending&max=8');
  },
  async fetchHealth() {
    return (await import('../../core/api/index.js')).getHarnessHealth();
  },
  getConnection: () => connectionSnapshotRef(),
  async getActiveChat() {
    return findActiveChat(await loadChatModule());
  },
  requestMicMute(muted) {
    if (typeof window === 'undefined') return false;
    const detail = { muted, handled: false };
    window.dispatchEvent(new CustomEvent('cr-voice-mic-mute-request', { detail }));
    return detail.handled === true;
  },
});

/**
 * Pending permission requests for the active chat plus the other open chats.
 * Rendered cards are scoped to the active chat's stream so a hidden chat's
 * cards can never be attributed to the active one.
 *
 * @param {any} chatModule
 * @returns {{ requests: Array<object>, total: number }}
 */
function collectApprovalSnapshot(chatModule) {
  const chats = chatModule.getChatsList();
  const active = findActiveChat(chatModule);
  // `pane` carries data-chat-id, so cards from a hidden chat can never be read
  // as the active chat's requests.
  const root = active?.pane || active?._sdkRichView?.streamEl || active?._sdkRichView?.el || null;
  return collectPendingApprovals({
    chats,
    activeChatId: active?.id || '',
    cards: readPendingPermissionCards(root),
    closedRequestIds: readClosedPermissionRequestIds(root),
  });
}

/**
 * @param {any} chat
 * @returns {boolean} whether the chat socket can carry a permission reply
 */
function isChatSocketOpen(chat) {
  if (!chat?.ws || typeof chat.ws.send !== 'function') return false;
  return typeof WebSocket === 'undefined' || chat.ws.readyState === WebSocket.OPEN;
}

const approvalTools = createApprovalToolHandlers({
  async getActiveChat() {
    const chatModule = await loadChatModule();
    const chat = findActiveChat(chatModule);
    return chat ? { id: chat.id, title: chat.title } : null;
  },
  async listPendingApprovals() {
    return collectApprovalSnapshot(await loadChatModule());
  },
  async replyToApproval({ chatId, requestId, answer }) {
    // Defense in depth: the handler already narrowed this to once|reject, but
    // nothing except those two replies may ever reach the socket.
    if (answer !== 'once' && answer !== 'reject') {
      return { ok: false, error: 'Voice can only answer once or reject.' };
    }
    const chatModule = await loadChatModule();
    const chat = findActiveChat(chatModule);
    if (!chat || chat.id !== chatId) {
      return { ok: false, error: 'The active chat changed. Nothing was approved.' };
    }
    const snapshot = collectApprovalSnapshot(chatModule);
    const pending = snapshot.requests.find(
      (request) => request.requestId === requestId && request.chatId === chatId
    );
    if (!pending) {
      return { ok: false, error: 'The permission request is no longer pending. Nothing was approved.' };
    }
    if (!isChatSocketOpen(chat)) {
      return { ok: false, error: 'The chat connection is not ready. Nothing was approved.' };
    }
    // Same wire message the UI's permission buttons send.
    chat.ws.send(JSON.stringify({ type: 'opencodePermissionReply', requestId, reply: answer }));
    appendVoiceSessionEvent('tool.approval_reply', { chatId, requestId, reply: answer });
    return { ok: true };
  },
});

const workTools = createWorkToolHandlers(buildWorkToolDeps({ findActiveChat, loadChatModule }));

/** @type {Record<string, (args: object) => Promise<object>>} */
const handlers = {
  panel: appTools.panel,
  app_settings: appTools.app_settings,
  app_status: appTools.app_status,
  // Permission answers and todo start / delegation cancel need the driver to answer after the question.
  approval: (args) => approvalTools.approval(args, { driverConfirm }),
  work: (args) => workTools.work(args, { driverConfirm }),

  async ops(args) {
    // Commit / task stop / quick run need the driver to answer after the question, not only the model.
    return commandHandlers.ops(args, {
      driverConfirm: {
        ask: (action, target) => confirmGuard.askConfirm(action, target),
        consume: (action, target) => confirmGuard.consumeConfirm(action, target),
      },
    });
  },

  async chat_ops(args) {
    return commandHandlers.chatOps(args, {
      // The same door as send_prompt: car mode waits in the undo window and `send_now` needs fresh driver speech.
      submit: async ({ text, steer }) => {
        const gate = getVoiceSendGate();
        if (gate.isActive()) {
          const result = await gate.submit(text, { source: 'realtime', steer });
          if (result?.pending_undo) confirmGuard.noteSubmit();
          return result;
        }
        return commandHandlers.sendPrompt(text, steer ? { steer: true } : undefined);
      },
    });
  },

  async send_prompt(args) {
    // Car view open: the same undo window as browser voice (the screen shows the bar, the model speaks).
    const gate = getVoiceSendGate();
    if (gate.isActive()) {
      const result = await gate.submit(String(args?.text || ''), { source: 'realtime' });
      if (result?.pending_undo) confirmGuard.noteSubmit();
      return result;
    }
    return commandHandlers.sendPrompt(args?.text);
  },

  async undo_send() {
    const dropped = getVoiceSendGate().undo();
    return dropped ? { ok: true, message: t('car.undo.cancelled') } : { ok: false, error: t('car.undo.nothingPending') };
  },

  async send_now() {
    // Only the driver may send early: the model needs fresh driver speech after the submit (and a short pause).
    if (getVoiceSendGate().getPending() && !confirmGuard.sendNowAllowed()) {
      return { ok: false, error: t('car.undo.sendNowTooSoon') };
    }
    const result = await getVoiceSendGate().sendNow();
    return result ?? { ok: false, error: t('car.undo.nothingPending') };
  },

  async stop_agent(args) {
    // A stray word must not interrupt a run while driving: confirm=true counts only after an earlier needs_confirm.
    if (isCarViewOpen()) {
      const target = await activeChatIdOrEmpty();
      if (!isToolConfirm(args?.confirm) || !confirmGuard.consumeConfirm('stop_agent', target)) {
        confirmGuard.askConfirm('stop_agent', target);
        return { ok: false, needs_confirm: true, message: t('car.stopConfirm') };
      }
    }
    return commandHandlers.stopAgent();
  },

  async read_last_answer(args) {
    const requested = Number(args?.max_chars);
    const maxChars = Number.isFinite(requested) && requested > 0
      ? Math.min(4000, Math.floor(requested))
      : DEFAULT_ANSWER_CHARS;
    const text = await readLastAnswerText(maxChars);
    if (!text) return { ok: false, error: 'No answer to read yet' };
    return { ok: true, text };
  },

  async get_chat_status() {
    const chatModule = await loadChatModule();
    const chat = findActiveChat(chatModule);
    if (!chat) return { ok: false, error: 'No chat is open' };
    const workspaces = typeof chatModule.getWorkspacesList === 'function'
      ? chatModule.getWorkspacesList()
      : [];
    const workspace = Array.isArray(workspaces)
      ? workspaces.find((entry) => entry?.workspaceFile && entry.workspaceFile === chat.workspaceFile)
      : null;
    return {
      ok: true,
      chatId: chat.id,
      title: String(chat.title || '').trim() || 'untitled',
      harness: String(chat.agentTransport || 'sdk'),
      model: String(chat.model || 'auto').trim() || 'auto',
      workspace: workspace
        ? String(workspace.name || '').trim()
        : String(chat.workspaceFile || '').replace(/.*\//, '').replace(/\.code-workspace$/i, '') || null,
      state: chatModule.getChatListAgentStatePublic(chat),
      mode: normalizeSdkMode(chat.sdkMode),
    };
  },

  async list_chats() {
    const chatModule = await loadChatModule();
    const activeId = chatModule.getActiveChatIdValue();
    const chats = chatModule.getChatsList().map((chat) => ({
      chatId: chat.id,
      title: String(chat.title || '').trim() || 'untitled',
      harness: String(chat.agentTransport || 'sdk'),
      active: chat.id === activeId,
    }));
    return { ok: true, chats };
  },

  async switch_chat(args) {
    return commandHandlers.switchChat(args);
  },

  async cycle_agent(args) {
    return commandHandlers.cycleChat(args?.direction === 'previous' ? -1 : 1);
  },

  async cycle_card(args) {
    return commandHandlers.cycleCard(args?.direction === 'previous' ? -1 : 1);
  },

  async car_mode(args) {
    return commandHandlers.setCarMode(args?.enable !== false && args?.enable !== 'false');
  },

  async choose_option(args) {
    return commandHandlers.chooseOption(args);
  },

  async confirm_choice(args) {
    return commandHandlers.confirmChoice(args);
  },

  async orchestrator(args) {
    return commandHandlers.setOrchestrator(args?.enable !== false && args?.enable !== 'false');
  },

  async list_agents() {
    return commandHandlers.listAgents();
  },

  async switch_agent(args) {
    return commandHandlers.switchAgent(args);
  },

  async whats_new() {
    return commandHandlers.whatsNew();
  },

  async delete_chat(args) {
    const chatModule = await loadChatModule();
    if (typeof chatModule.requestDeleteChat !== 'function') {
      return { ok: false, error: 'Chat delete is not available' };
    }
    const context = await bindingContext();
    if (isToolConfirm(args?.confirm)) {
      // Step two deletes what step one described, whatever the confirming call names.
      const check = stepBinding.consume('delete_chat', String(args?.id || '').trim(), context, driverConfirm);
      if (!check.ok) return check.result;
      const target = chatModule.getChatsList().find((chat) => chat.id === check.data.chatId);
      if (!target) return { ok: false, code: 'not_found', error: 'That chat no longer exists. Nothing was deleted.' };
      chatModule.requestDeleteChat(target.id, { skipConfirm: true, preserveListOpen: true });
      return { ok: true, chatId: target.id, title: check.data.title };
    }
    const resolved = resolveChatTarget(chatModule, args);
    if (!resolved.ok) return resolved;
    const title = String(resolved.chat.title || '').trim() || 'untitled';
    const id = stepBinding.bind('delete_chat', 'd', context, { chatId: resolved.chat.id, title }, driverConfirm);
    return {
      ok: false,
      needsConfirm: true,
      id,
      chatId: resolved.chat.id,
      title,
      error: `Confirm delete of "${title}". Ask the user, then call delete_chat with confirm=true and this id.`,
    };
  },

  async create_chat(args) {
    const chatModule = await loadChatModule();
    if (typeof chatModule.createVoiceChat !== 'function') {
      return { ok: false, error: 'Chat create is not available' };
    }
    return chatModule.createVoiceChat({
      title: args?.title,
      workspace: args?.workspace,
    });
  },

  async open_chat_sidebar() {
    const chatModule = await loadChatModule();
    if (typeof chatModule.openChatSidebar !== 'function') {
      return { ok: false, error: 'Sidebar is not available' };
    }
    const opened = chatModule.openChatSidebar();
    return opened ? { ok: true } : { ok: false, error: 'Sidebar is not available' };
  },

  async set_chat_mode(args) {
    const mode = resolveVoiceSdkMode(args?.mode);
    if (!mode) return { ok: false, error: 'Mode must be plan, agent, or ask' };
    const chatModule = await loadChatModule();
    if (typeof chatModule.setActiveChatSdkMode !== 'function') {
      return { ok: false, error: 'Mode switch is not available' };
    }
    return chatModule.setActiveChatSdkMode(mode);
  },

  async close_chat_sidebar() {
    const chatModule = await loadChatModule();
    if (typeof chatModule.closeChatSidebar !== 'function') {
      return { ok: false, error: 'Sidebar is not available' };
    }
    const closed = chatModule.closeChatSidebar();
    return closed ? { ok: true } : { ok: false, error: 'Sidebar is not available' };
  },

  /** Resolves a spoken label to a task label (ambiguity and unknown labels are errors). */
  async run_task(args) {
    const label = String(args?.label || '').trim();
    if (!label) return { ok: false, error: 'Missing task label' };
    const tasksModule = await loadTasksModule();
    // A wrong label would start nothing and report success, so verify it first.
    const data = await fetchTaskList().catch(() => null);
    const labels = Array.isArray(data?.tasks)
      ? data.tasks.map((task) => String(task?.label || '')).filter(Boolean)
      : [];
    let resolved = label;
    if (args?.exact === true) {
      // Confirmed step of `workspace` task_run: run the bound label only if it still exists as is.
      if (!labels.includes(label)) return { ok: false, code: 'task_changed', error: 'The task list changed since the question. Nothing was started.' };
    } else if (labels.length > 0) {
      const result = matchTaskBySpokenLabel(labels, label);
      if (result.ambiguous) {
        return {
          ok: false,
          error: `Ambiguous task. Candidates: ${(result.candidates || []).slice(0, 12).join(', ')}`,
        };
      }
      if (!result.match) {
        return { ok: false, error: `Unknown task. Available: ${labels.slice(0, 12).join(', ')}` };
      }
      resolved = result.match;
    }
    // Step one of the two-step `workspace` task_run only resolves; the task starts after the bound confirmation.
    if (args?.resolveOnly === true) return { ok: true, label: resolved };
    const started = tasksModule.runTaskByLabel(resolved);
    return started ? { ok: true, label: resolved } : { ok: false, error: 'Could not start the task' };
  },

  async list_tasks() {
    const data = await getTasks().catch(() => null);
    const labels = Array.isArray(data?.tasks)
      ? data.tasks.map((task) => String(task?.label || '')).filter(Boolean)
      : [];
    return { ok: true, tasks: labels };
  },

  async list_workspaces() {
    const chatModule = await loadChatModule();
    if (typeof chatModule.listVoiceWorkspaces !== 'function') {
      return { ok: false, error: 'Workspace list is not available' };
    }
    return chatModule.listVoiceWorkspaces();
  },

  async switch_workspace(args) {
    return commandHandlers.switchWorkspace(args);
  },

  async list_folders() {
    const chatModule = await loadChatModule();
    if (typeof chatModule.listVoiceFolders !== 'function') {
      return { ok: false, error: 'Folder list is not available' };
    }
    return chatModule.listVoiceFolders();
  },

  async switch_folder(args) {
    const chatModule = await loadChatModule();
    if (typeof chatModule.switchVoiceFolder !== 'function') {
      return { ok: false, error: 'Folder switch is not available' };
    }
    return chatModule.switchVoiceFolder({ folder: args?.folder });
  },

  async close_chat(args) {
    const chatModule = await loadChatModule();
    if (typeof chatModule.closeVoiceChat !== 'function') {
      return { ok: false, error: 'Chat close is not available' };
    }
    const resolved = resolveChatTarget(chatModule, args);
    if (!resolved.ok) return resolved;
    return chatModule.closeVoiceChat({ chatId: resolved.chat.id });
  },

  async rename_chat(args) {
    const nextTitle = String(args?.title || '').trim();
    if (!nextTitle) return { ok: false, error: 'Missing title' };
    const chatModule = await loadChatModule();
    if (typeof chatModule.renameVoiceChat !== 'function') {
      return { ok: false, error: 'Chat rename is not available' };
    }
    const resolved = resolveChatTarget(chatModule, {
      chat_id: args?.chat_id,
      title: args?.current_title,
    });
    if (!resolved.ok) return resolved;
    return chatModule.renameVoiceChat({ chatId: resolved.chat.id, title: nextTitle });
  },

  async send_nav(args) {
    const key = resolveVoiceNavKey(args?.key);
    if (!key) return { ok: false, error: 'Key must be up, down, left, right, enter, escape, y, or n' };
    const chatModule = await loadChatModule();
    if (typeof chatModule.sendNavKeyToActiveChat !== 'function') {
      return { ok: false, error: 'Navigation is not available' };
    }
    const sent = chatModule.sendNavKeyToActiveChat(key);
    if (!sent) return { ok: false, error: 'Nothing to send. No terminal prompt or permission to answer.', key };
    return { ok: true, key };
  },

  async list_models(args) {
    const chatModule = await loadChatModule();
    if (typeof chatModule.listVoiceModels !== 'function') {
      return { ok: false, error: 'Model list is not available' };
    }
    const listed = await chatModule.listVoiceModels();
    if (!listed.ok) return listed;
    const compact = compactVoiceModelList(listed.models, {
      query: args?.query,
      current: listed.current,
    });
    return {
      ok: true,
      harness: listed.harness,
      current: listed.current,
      total: compact.total,
      truncated: compact.truncated,
      models: compact.models,
      hint: 'If the user named a model, call set_model with that spoken name. Do not list the full catalog.',
    };
  },

  async set_model(args) {
    const spoken = String(args?.model || '').trim();
    if (!spoken) return { ok: false, error: 'Missing model' };
    const chatModule = await loadChatModule();
    if (typeof chatModule.listVoiceModels !== 'function' || typeof chatModule.setVoiceChatModel !== 'function') {
      return { ok: false, error: 'Model switch is not available' };
    }
    const listed = await chatModule.listVoiceModels();
    if (!listed.ok) return listed;
    const result = matchModelBySpokenName(listed.models, spoken);
    if (result.ambiguous) {
      return {
        ok: false,
        error: `Ambiguous model. Candidates: ${(result.candidates || []).slice(0, 12).join(', ')}`,
      };
    }
    if (!result.match) {
      const names = (listed.models || []).map((model) => model.id).slice(0, 12);
      return { ok: false, error: `Unknown model. Available: ${names.join(', ')}` };
    }
    const outcome = await chatModule.setVoiceChatModel({ model: result.match.id });
    appendVoiceSessionEvent('tool.set_model', {
      requested: spoken,
      model: outcome?.model || result.match.id,
      ok: outcome?.ok === true,
      error: outcome?.error || '',
    });
    if (outcome?.ok === true && typeof chatModule.getChatListAgentStatePublic === 'function') {
      const chat = chatModule.getChatsList().find((item) => item.id === chatModule.getActiveChatIdValue());
      if (chat) {
        const status = await subHandlers.get_chat_status();
        if (status?.ok) outcome.verifiedModel = status.model || outcome.model;
      }
    }
    return outcome;
  },

  async switch_harness(args) {
    const harness = resolveVoiceHarness(args?.harness);
    if (!harness) {
      return {
        ok: false,
        error: 'Unknown harness. Try cursor, opencode, openrouter, codebuddy, deepseek, mistral, zai, mimo, codex, qwen, claude.',
      };
    }
    const chatModule = await loadChatModule();
    if (typeof chatModule.switchVoiceHarness !== 'function') {
      return { ok: false, error: 'Harness switch is not available' };
    }
    return chatModule.switchVoiceHarness({
      harness,
      confirm: args?.confirm,
      handoff: args?.handoff,
      keep_old: args?.keep_old,
    });
  },

  async fork_chat(args) {
    let harness = '';
    const spokenHarness = String(args?.harness || '').trim();
    if (spokenHarness) {
      harness = resolveVoiceHarness(spokenHarness);
      if (!harness) {
        return {
          ok: false,
          error: 'Unknown harness. Try cursor, opencode, openrouter, codebuddy, deepseek, mistral, zai, mimo, codex, qwen, claude.',
        };
      }
    }
    const chatModule = await loadChatModule();
    if (typeof chatModule.forkVoiceChat !== 'function') {
      return { ok: false, error: 'Chat fork is not available' };
    }
    return chatModule.forkVoiceChat({
      title: args?.title,
      harness,
    });
  },

  async set_read_mode(args) {
    const mode = resolveVoiceReadMode(args?.mode);
    if (!mode) return { ok: false, error: 'Mode must be off, final, stream, or agent' };
    setReadMode(mode);
    if (mode === 'off') getChatSpeaker().stop();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cr-voice-read-mode-changed', { detail: { mode } }));
    }
    return { ok: true, mode };
  },

  async get_cost() {
    const usd = getVoiceSessionUsd();
    return { ok: true, usd, text: formatUsd(usd) };
  },

  async end_voice_mode() {
    return { ok: true, endSession: true };
  },
};

const subHandlers = installToolFamilies(handlers, {
  stepBinding,
  driverConfirm,
  bindingContext,
  isToolConfirm,
  commandHandlers,
});

export const REALTIME_TOOL_NAMES = Object.keys(handlers);

/**
 * @param {string} name
 * @param {any} args
 * @returns {Promise<object>} JSON-serialisable result sent back to the model
 */
export async function executeRealtimeTool(name, args) {
  // The registry is the allow-list: a name outside it never reaches a handler.
  const handler = isVoiceActionId(name) ? handlers[name] : null;
  if (!handler) return { ok: false, error: `Unknown tool: ${name}` };
  // Any other tool between the two work steps closes the pending confirmation.
  if (name !== 'work') workTools.cancelPending();
  if (name !== 'ops') commandHandlers.cancelOps?.();
  if (name !== 'inbox') commandHandlers.cancelInbox?.();
  // A task_run / delete_chat confirmation survives only until the next other voice tool.
  if (name !== 'workspace' && name !== 'delete_chat') stepBinding.cancel();
  const startedAt = Date.now();
  const safeArgs = args && typeof args === 'object' ? args : {};
  appendVoiceSessionEvent('tool.start', { name, args: safeArgs });
  try {
    const result = await handler(safeArgs);
    const serialized = JSON.stringify(result ?? null);
    appendVoiceSessionEvent('tool.call', {
      name,
      ok: result?.ok === true,
      error: result?.error || '',
      durationMs: Date.now() - startedAt,
      resultBytes: serialized.length,
      modelCount: Array.isArray(result?.models) ? result.models.length : undefined,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendVoiceSessionEvent('tool.call', {
      name,
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, error: message };
  }
}

/**
 * Live app state for the voice state block (see `voiceStateSync.js`).
 *
 * @returns {Promise<import('./voiceStateSync.js').VoiceStateSnapshot>}
 */
export async function collectVoiceStateSnapshot() {
  const chatModule = await loadChatModule();
  const chat = findActiveChat(chatModule);
  const readMode = getReadMode();
  const openPanel = readActivePanelId(typeof document !== 'undefined' ? document : null);
  if (!chat) return { readMode, openPanel };
  const approvals = collectApprovalSnapshot(chatModule);
  const activeApprovals = approvals.requests.filter((request) => request.chatId === chat.id);
  const permissions = Math.max(
    0,
    Number(chat._sdkServerPendingPermissionCount) || 0,
    activeApprovals.length
  );
  const questions = Math.max(0, Number(chat._sdkServerPendingQuestionCount) || 0);
  const status = await subHandlers.get_chat_status();
  const onlyApproval = permissions === 1 && activeApprovals.length === 1 ? activeApprovals[0] : null;
  return {
    chatId: chat.id,
    title: status?.title,
    harness: status?.harness,
    mode: status?.mode,
    running: status?.state === 'active',
    workspace: status?.workspace || '',
    openPanel,
    pendingApproval: permissions > 0
      ? {
        kind: 'permission',
        count: permissions,
        ...(activeApprovals[0]?.summary ? { summary: activeApprovals[0].summary } : {}),
        ...(onlyApproval ? { requestId: onlyApproval.requestId } : {}),
      }
      : questions > 0 ? { kind: 'question', count: questions } : null,
    readMode,
  };
}
