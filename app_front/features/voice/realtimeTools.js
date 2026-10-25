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
  getTodos,
  getWorkspaceDelegations,
  postDelegationCancel,
} from '../../core/api/index.js';
import { getChatSpeaker } from './chatSpeaker.js';
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
import { getTodoWorkspaceFolder } from '../todo/todoWorkspaceScope.js';
import { resolveTodoStartHarness } from '../todo/todoTreeView.js';
import { getVoiceSessionUsd } from './voiceSessionState.js';
import { formatUsd } from './voiceCost.js';
import { appendVoiceSessionEvent } from './voiceSessionLog.js';

const DEFAULT_ANSWER_CHARS = 1200;

/** @type {Promise<object>|null} */
let chatModulePromise = null;
/** @type {Promise<object>|null} */
let tasksModulePromise = null;

function loadChatModule() {
  if (!chatModulePromise) chatModulePromise = import('../chat/index.js');
  return chatModulePromise;
}

function loadTasksModule() {
  if (!tasksModulePromise) tasksModulePromise = import('../tasks/index.js');
  return tasksModulePromise;
}

/**
 * @param {object} chatModule
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
 * @param {object} chatModule
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
    const scope = await import('../watcher/watcherWorkspaceScope.js');
    const { cretliApiFetch } = await import('../../lib/cretliApiRequest.js');
    const scoped = scope.scopeWatcherRequestToWorkspace(
      `/api/workspace-watcher/scout?status=pending&max=${8}`,
      {},
      scope.getWatcherWorkspaceFolder()
    );
    const res = await cretliApiFetch(scoped.path, { headers: { Accept: 'application/json' }, credentials: 'include' });
    return { status: res.status, json: await res.json().catch(() => null) };
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
 * @param {object} chatModule
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

/**
 * Scoped JSON call to the Workspace Watcher API (same scoping as the Todo bar).
 *
 * @param {string} path
 * @param {{ method?: string }} [options]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function watcherRequest(path, options = {}) {
  const scope = await import('../watcher/watcherWorkspaceScope.js');
  const { cretliApiFetch } = await import('../../lib/cretliApiRequest.js');
  const scoped = scope.scopeWatcherRequestToWorkspace(path, options, scope.getWatcherWorkspaceFolder());
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * Todo / Watcher / delegation tools. Harness and model for a started todo come
 * from the todo's assignee and the new-chat harness select, never from a
 * catalog listing.
 */
const workTools = createWorkToolHandlers({
  async getContext() {
    const chat = findActiveChat(await loadChatModule());
    const trigger = typeof document !== 'undefined' ? document.getElementById('header-workspace-trigger') : null;
    // Capture both halves of the workspace pair at step one: the confirmation
    // is bound to this file/folder pair, not to the header at confirm time.
    return {
      workspaceFile: trigger?.dataset?.workspaceFile || '',
      workspaceFolder: getTodoWorkspaceFolder(),
      chatId: chat?.id || '',
    };
  },
  async listTodos() {
    const data = await getTodos(getTodoWorkspaceFolder());
    return Array.isArray(data?.items) ? data.items : [];
  },
  async startTodo({ todo, context }) {
    // Both values come from the context bound at step one (getContext), never
    // from the header trigger, so the server-validated pair always matches.
    const workspaceFile = context?.workspaceFile || '';
    const workspaceFolder = context?.workspaceFolder || '';
    if (!workspaceFile || !workspaceFolder) return { ok: false, error: 'No workspace is selected' };
    const select = typeof document !== 'undefined' ? document.getElementById('chat-new-harness-select') : null;
    const agentTransport = resolveTodoStartHarness(todo, String(select?.value || 'sdk').trim() || 'sdk');
    const panel = await import('../todo/index.js');
    const outcome = await panel.startTodoAgentForVoice(todo.id, { workspaceFile, workspaceFolder, agentTransport });
    appendVoiceSessionEvent('tool.todo_start', { todoId: todo.id, ok: outcome?.ok === true });
    if (!outcome?.ok) return { ok: false, error: outcome?.error || 'Could not start the todo' };
    return { ok: true, state: 'started' };
  },
  async getWatcherView() {
    const res = await watcherRequest('/api/workspace-watcher');
    return res.json?.ok ? res.json : null;
  },
  async setWatcherPaused(paused) {
    const res = await watcherRequest(`/api/workspace-watcher/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
    if (res.status >= 400 || res.json?.ok === false) {
      return { ok: false, error: res.json?.error || 'Could not change the watcher' };
    }
    import('../watcher/watcherPanel.js').then((panel) => panel.refreshWatcherPanel()).catch(() => {});
    return { ok: true };
  },
  async listDelegations() {
    const data = await getWorkspaceDelegations({ workspaceFolder: getTodoWorkspaceFolder(), limit: 30 });
    return Array.isArray(data?.delegations) ? data.delegations : [];
  },
  async cancelDelegation(id) {
    const data = await postDelegationCancel(id);
    appendVoiceSessionEvent('tool.delegation_cancel', { delegationId: id, ok: data?.ok !== false });
    return data?.ok === false ? { ok: false, error: data.error } : { ok: true };
  },
});

/** @type {Record<string, (args: object) => Promise<object>>} */
const handlers = {
  panel: appTools.panel,
  app_settings: appTools.app_settings,
  app_status: appTools.app_status,
  approval: approvalTools.approval,
  work: workTools.work,

  async send_prompt(args) {
    const text = String(args?.text || '').trim();
    if (!text) return { ok: false, error: 'Empty prompt' };
    const chatModule = await loadChatModule();
    const sendBar = chatModule.getActiveSendBar();
    if (!sendBar?.input || typeof sendBar.submit !== 'function') {
      return { ok: false, error: 'No chat is open' };
    }
    sendBar.input.value = text;
    sendBar.submit();
    const chat = findActiveChat(chatModule);
    return {
      ok: true,
      sent: text,
      state: chat ? chatModule.getChatListAgentStatePublic(chat) : null,
    };
  },

  async stop_agent() {
    const chatModule = await loadChatModule();
    const stopped = chatModule.sendKeySequenceToActiveChat('\x03');
    return stopped ? { ok: true } : { ok: false, error: 'Nothing to stop' };
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
    const chatModule = await loadChatModule();
    const chats = chatModule.getChatsList();
    const wantedId = String(args?.chat_id || '').trim();
    if (wantedId) {
      const target = chats.find((chat) => chat.id === wantedId);
      if (!target) return { ok: false, error: 'Chat not found' };
      chatModule.selectChat(target.id, { byUser: true });
      return { ok: true, chatId: target.id, title: String(target.title || '').trim() };
    }
    const result = matchChatBySpokenTitle(chats, args?.title);
    if (result.ambiguous) {
      return {
        ok: false,
        error: `Ambiguous chat title. Candidates: ${(result.candidates || []).slice(0, 8).join(', ')}`,
      };
    }
    if (!result.match) return { ok: false, error: 'Chat not found' };
    chatModule.selectChat(result.match.id, { byUser: true });
    return { ok: true, chatId: result.match.id, title: String(result.match.title || '').trim() };
  },

  async delete_chat(args) {
    const chatModule = await loadChatModule();
    if (typeof chatModule.requestDeleteChat !== 'function') {
      return { ok: false, error: 'Chat delete is not available' };
    }
    const resolved = resolveChatTarget(chatModule, args);
    if (!resolved.ok) return resolved;
    const title = String(resolved.chat.title || '').trim() || 'untitled';
    if (!isToolConfirm(args?.confirm)) {
      return {
        ok: false,
        needsConfirm: true,
        chatId: resolved.chat.id,
        title,
        error: `Confirm delete of "${title}". Call delete_chat again with confirm=true and this chat_id.`,
      };
    }
    chatModule.requestDeleteChat(resolved.chat.id, { skipConfirm: true, preserveListOpen: true });
    return { ok: true, chatId: resolved.chat.id, title };
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

  async run_task(args) {
    const label = String(args?.label || '').trim();
    if (!label) return { ok: false, error: 'Missing task label' };
    const tasksModule = await loadTasksModule();
    // A wrong label would start nothing and report success, so verify it first.
    const data = await getTasks().catch(() => null);
    const labels = Array.isArray(data?.tasks)
      ? data.tasks.map((task) => String(task?.label || '')).filter(Boolean)
      : [];
    if (labels.length > 0) {
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
      const started = tasksModule.runTaskByLabel(result.match);
      return started ? { ok: true, label: result.match } : { ok: false, error: 'Could not start the task' };
    }
    const started = tasksModule.runTaskByLabel(label);
    return started ? { ok: true, label } : { ok: false, error: 'Could not start the task' };
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
    const chatModule = await loadChatModule();
    if (typeof chatModule.switchVoiceWorkspace !== 'function') {
      return { ok: false, error: 'Workspace switch is not available' };
    }
    return chatModule.switchVoiceWorkspace({
      workspace: args?.workspace,
      folder: args?.folder,
    });
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
        const status = await handlers.get_chat_status();
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
    if (!mode) return { ok: false, error: 'Mode must be off, final, or stream' };
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

export const REALTIME_TOOL_NAMES = Object.keys(handlers);

/**
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object>} JSON-serialisable result sent back to the model
 */
export async function executeRealtimeTool(name, args) {
  // The registry is the allow-list: a name outside it never reaches a handler.
  const handler = isVoiceActionId(name) ? handlers[name] : null;
  if (!handler) return { ok: false, error: `Unknown tool: ${name}` };
  // Any other tool between the two work steps closes the pending confirmation.
  if (name !== 'work') workTools.cancelPending();
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
  const status = await handlers.get_chat_status();
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
