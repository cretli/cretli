/**
 * Executes the tool calls the Realtime model makes.
 *
 * The tool schemas live on the server
 * (`lib/voice/realtime-session-config.js`) so the browser cannot widen its own
 * permissions; this file only maps names to actions in the running app.
 *
 * `chat.js` and `tasks.js` are imported lazily: the voice panel is reached from
 * the send bar, which chat.js itself owns, and a static import would close that
 * cycle.
 */

import { getTasks } from '../../api.js';
import { getChatSpeaker } from './chatSpeaker.js';
import { toSpeakableText } from './speakableText.js';
import { matchChatBySpokenTitle } from './voiceChatMatch.js';
import { resolveVoiceSdkMode } from './voiceSdkMode.js';

const DEFAULT_ANSWER_CHARS = 1200;

/** @type {Promise<object>|null} */
let chatModulePromise = null;
/** @type {Promise<object>|null} */
let tasksModulePromise = null;

function loadChatModule() {
  if (!chatModulePromise) chatModulePromise = import('../../chat.js');
  return chatModulePromise;
}

function loadTasksModule() {
  if (!tasksModulePromise) tasksModulePromise = import('../../tasks.js');
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

/** @type {Record<string, (args: object) => Promise<object>>} */
const handlers = {
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
    return { ok: true, sent: text };
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
      workspace: workspace
        ? String(workspace.name || '').trim()
        : String(chat.workspaceFile || '').replace(/.*\//, '').replace(/\.code-workspace$/i, '') || null,
      state: chatModule.getChatListAgentStatePublic(chat),
      mode: chat.sdkMode === 'plan' ? 'plan' : 'agent',
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
      chatModule.selectChat(target.id);
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
    chatModule.selectChat(result.match.id);
    return { ok: true, chatId: result.match.id, title: String(result.match.title || '').trim() };
  },

  async delete_chat(args) {
    const chatModule = await loadChatModule();
    if (typeof chatModule.requestDeleteChat !== 'function') {
      return { ok: false, error: 'Chat delete is not available' };
    }
    const chats = chatModule.getChatsList();
    const wantedId = String(args?.chat_id || '').trim();
    const wantedTitle = String(args?.title || '').trim();
    let target = null;
    if (wantedId) {
      target = chats.find((chat) => chat.id === wantedId) || null;
    } else if (wantedTitle) {
      const result = matchChatBySpokenTitle(chats, wantedTitle);
      if (result.ambiguous) {
        return {
          ok: false,
          error: `Ambiguous chat title. Candidates: ${(result.candidates || []).slice(0, 8).join(', ')}`,
        };
      }
      target = result.match || null;
    } else {
      target = findActiveChat(chatModule);
    }
    if (!target) return { ok: false, error: 'Chat not found' };
    const title = String(target.title || '').trim() || 'untitled';
    chatModule.requestDeleteChat(target.id, { skipConfirm: true, preserveListOpen: true });
    return { ok: true, chatId: target.id, title };
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
    if (!mode) return { ok: false, error: 'Mode must be plan or agent' };
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
    const exact = labels.find((item) => item === label)
      || labels.find((item) => item.toLowerCase() === label.toLowerCase());
    if (labels.length > 0 && !exact) {
      return { ok: false, error: `Unknown task. Available: ${labels.slice(0, 12).join(', ')}` };
    }
    const started = tasksModule.runTaskByLabel(exact || label);
    return started ? { ok: true, label: exact || label } : { ok: false, error: 'Could not start the task' };
  },
};

export const REALTIME_TOOL_NAMES = Object.keys(handlers);

/**
 * @param {string} name
 * @param {object} args
 * @returns {Promise<object>} JSON-serialisable result sent back to the model
 */
export async function executeRealtimeTool(name, args) {
  const handler = handlers[name];
  if (!handler) return { ok: false, error: `Unknown tool: ${name}` };
  try {
    return await handler(args || {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
