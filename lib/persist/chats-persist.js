/**
 * Chat list persistence (SDK + OpenRouter harnesses).
 * data/chats.json: { chats: [ { id, title, cursorSessionId, agentTransport, createdAt } ] }
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { normalizeAgentTransport } from '../agent-transport.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.js';
import { normalizeSdkUiMode } from '../sdk/sdk-ui-mode.js';
import { writeJsonAtomic } from './atomic-write.js';
import { deleteChatHistory } from './chat-history-persist.js';
import { normalizeContextAdvisoryWarnPercent } from '../sdk/sdk-context-advisory.js';
import { normalizeAutoContextCompressionThresholdPercent } from '../context-compression.js';
import { isSamePageUrl } from '../widget/widget-page-url.js';
import { wouldCreateChatParentCycle } from '../chat-tree.js';
import { resolveDataPath } from '../runtime-paths.js';

const DATA_FILE = resolveDataPath('chats.json');

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeAutoContextThreshold(value) {
  return normalizeAutoContextCompressionThresholdPercent(value);
}

/**
 * @returns {Array<{ id: string, title: string, cursorSessionId: string, workspaceFile?: string, workspaceFolder?: string, model?: string, createdAt: string }>}
 */
export function loadChats() {
  ensureDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const all = Array.isArray(data.chats) ? data.chats : [];
    return all.filter((chat) => chat && typeof chat === 'object');
  } catch (err) {
    // Returning [] silently would let the next saveChats() overwrite the damaged
    // file and destroy every chat, so keep a copy the user can recover from.
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(DATA_FILE, backup);
      console.error(`[cretli] ${DATA_FILE} is unreadable (${err.message}). Moved to ${backup}.`);
    } catch (renameErr) {
      console.error(
        `[cretli] ${DATA_FILE} is unreadable (${err.message}) and could not be backed up: ${renameErr.message}`,
      );
    }
    return [];
  }
}

/**
 * @param {string} cursorSessionId
 * @returns {{ id: string, title: string, cursorSessionId: string, workspaceFile?: string, workspaceFolder?: string, model?: string } | null}
 */
export function getChatByCursorSessionId(cursorSessionId) {
  return loadChats().find((c) => c.cursorSessionId === cursorSessionId) || null;
}

/**
 * @param {Array<{ id: string, title: string, cursorSessionId: string, workspaceFile?: string, createdAt?: string }>} chats
 */
export function saveChats(chats) {
  ensureDir();
  writeJsonAtomic(DATA_FILE, { chats });
}

/**
 * Builds a chat entry pointing at a new, empty SDK session.
 *
 * @param {object} chat
 * @param {string} cursorSessionId
 * @returns {object}
 */
export function createFreshSdkContextEntry(chat, cursorSessionId) {
  if (!chat || typeof chat !== 'object') {
    throw new TypeError('Chat entry is required');
  }
  const nextCursorSessionId = String(cursorSessionId || '').trim();
  if (!nextCursorSessionId) {
    throw new TypeError('New cursor session id is required');
  }
  const nextChat = {
    ...chat,
    cursorSessionId: nextCursorSessionId,
  };
  delete nextChat.sdkAgentId;
  return nextChat;
}

/**
 * @param {string} cursorSessionId - SDK session key (uuid)
 * @param {string} [title] - optional title
 * @param {string} [workspaceFile] - absolute path to the .code-workspace file (multi-root)
 * @param {string} [workspaceFolder] - directory to start the agent in (a folder from the workspace)
 * @param {string} [model] - agent model (e.g. Auto)
 * @param {{ sdkMode?: string, sdkUiMode?: string, todoId?: string, isTemporary?: boolean, forkParentChatId?: string, forkKind?: string, summaries?: unknown[] }} [extras]
 * @returns {{ id: string, title: string, cursorSessionId: string, workspaceFile?: string, workspaceFolder?: string, model?: string, agentTransport: 'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen', opencodeSessionId?: string, codebuddySessionId?: string, deepseekSessionId?: string, codexThreadId?: string, qwenSessionId?: string, createdAt: string }}
 */
export function addChat(cursorSessionId, title, workspaceFile, workspaceFolder, model, extras = null) {
  const chats = loadChats();
  const reservedId = String(extras?.id || '').trim();
  if (reservedId) {
    const existing = chats.find((row) => row.id === reservedId);
    if (existing) return existing;
  }
  const id = reservedId || randomUUID();
  const createdAt = new Date().toISOString();
  const transport = normalizeAgentTransport(extras?.agentTransport);
  const entry = {
    id,
    title: title || 'Chat ' + (chats.length + 1),
    cursorSessionId,
    createdAt,
    updatedAt: createdAt,
    agentTransport: transport,
    sdkMode: normalizeSdkMode(extras?.sdkMode),
    sdkUiMode: normalizeSdkUiMode(extras?.sdkUiMode),
  };
  if (workspaceFile) entry.workspaceFile = workspaceFile;
  if (workspaceFolder) entry.workspaceFolder = workspaceFolder;
  if (model) entry.model = model;
  if (extras && typeof extras === 'object' && extras.widgetInstallationId) {
    entry.widgetInstallationId = String(extras.widgetInstallationId);
  }
  if (extras && typeof extras === 'object' && extras.widgetPageSessionId) {
    entry.widgetPageSessionId = String(extras.widgetPageSessionId);
  }
  if (extras && typeof extras === 'object' && extras.todoId) {
    entry.todoId = String(extras.todoId);
  }
  if (extras && typeof extras === 'object' && extras.isTemporary === true) {
    entry.isTemporary = true;
  }
  if (extras && typeof extras === 'object' && extras.forkParentChatId) {
    entry.forkParentChatId = String(extras.forkParentChatId);
  }
  if (extras && typeof extras === 'object' && extras.forkKind) {
    entry.forkKind = String(extras.forkKind);
  }
  if (extras && typeof extras === 'object' && extras.delegationParentChatId) {
    entry.delegationParentChatId = String(extras.delegationParentChatId);
  }
  if (extras && typeof extras === 'object' && extras.delegationId) {
    entry.delegationId = String(extras.delegationId);
  }
  if (extras && typeof extras === 'object' && Array.isArray(extras.summaries)) {
    entry.summaries = JSON.parse(JSON.stringify(extras.summaries));
  }
  if (extras && typeof extras === 'object' && extras.autoContextCompressionEnabled === true) {
    entry.autoContextCompressionEnabled = true;
  }
  if (extras && typeof extras === 'object' && Object.prototype.hasOwnProperty.call(extras, 'autoContextCompressionThreshold')) {
    entry.autoContextCompressionThreshold = normalizeAutoContextThreshold(
      extras.autoContextCompressionThreshold
    );
  }
  if (extras && typeof extras === 'object' && extras.autoContextCompressionReset === false) {
    entry.autoContextCompressionReset = false;
  }
  if (extras && typeof extras === 'object' && extras.opencodeSessionId) {
    entry.opencodeSessionId = String(extras.opencodeSessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.codebuddySessionId) {
    entry.codebuddySessionId = String(extras.codebuddySessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.deepseekSessionId) {
    entry.deepseekSessionId = String(extras.deepseekSessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.codexThreadId) {
    entry.codexThreadId = String(extras.codexThreadId).trim();
  }
  if (extras && typeof extras === 'object' && extras.qwenSessionId) {
    entry.qwenSessionId = String(extras.qwenSessionId).trim();
  }
  chats.push(entry);
  saveChats(chats);
  return entry;
}

/**
 * Creates a persistent conversation fork with a new session and the source chat metadata.
 * @param {object} parentChat
 * @param {{
 *   workspaceFile?: string,
 *   workspaceFolder?: string,
 *   agentTransport?: string,
 *   model?: string,
 *   title?: string,
 *   forkKind?: string,
 * }} [overrides]
 * @returns {object}
 */
export function createConversationForkChat(parentChat, overrides = null) {
  if (!parentChat?.id) {
    throw new TypeError('Parent chat is required');
  }
  const overrideTitle = typeof overrides?.title === 'string' ? overrides.title.trim() : '';
  const title = overrideTitle || `${parentChat.title || 'Chat'} (fork)`;
  const overrideWorkspaceFile =
    typeof overrides?.workspaceFile === 'string' ? overrides.workspaceFile.trim() : '';
  const overrideWorkspaceFolder =
    typeof overrides?.workspaceFolder === 'string' ? overrides.workspaceFolder.trim() : '';
  const overrideModel = typeof overrides?.model === 'string' ? overrides.model.trim() : '';
  const hasTransportOverride =
    typeof overrides?.agentTransport === 'string' && overrides.agentTransport.trim() !== '';
  const workspaceFile = overrideWorkspaceFile || parentChat.workspaceFile;
  const workspaceFolder = overrideWorkspaceFolder || parentChat.workspaceFolder;
  const model = overrideModel || parentChat.model;
  const forkKind =
    typeof overrides?.forkKind === 'string' && overrides.forkKind.trim()
      ? overrides.forkKind.trim()
      : 'conversation';
  const extras = {
    agentTransport: hasTransportOverride
      ? normalizeAgentTransport(overrides.agentTransport)
      : parentChat.agentTransport,
    sdkMode: parentChat.sdkMode,
    sdkUiMode: parentChat.sdkUiMode,
    forkParentChatId: parentChat.id,
    forkKind,
  };
  if (forkKind !== 'analyze') {
    extras.summaries = parentChat.summaries;
    extras.autoContextCompressionEnabled = parentChat.autoContextCompressionEnabled === true;
    extras.autoContextCompressionThreshold = parentChat.autoContextCompressionThreshold;
    extras.autoContextCompressionReset = parentChat.autoContextCompressionReset;
  }
  return addChat(randomUUID(), title, workspaceFile, workspaceFolder, model, extras);
}

const FORK_TEMP_TITLES = Object.freeze({
  title: '[Temp] Chat title',
  summary: '[Temp] Summary',
});

/**
 * Creates a temporary SDK chat for a fork (title / summary), replacing a previous fork of the same kind.
 * @param {string} parentChatId
 * @param {'title'|'summary'} forkKind
 * @param {string} [workspaceFile]
 * @param {string|null} [workspaceFolder]
 * @param {string} [model]
 * @returns {object}
 */
export function createTemporaryForkChat(parentChatId, forkKind, workspaceFile, workspaceFolder, model) {
  deleteTemporaryForkChats(parentChatId, forkKind);
  const sdkSessionKey = randomUUID();
  const title = FORK_TEMP_TITLES[forkKind] || '[Temp] Agent';
  return addChat(sdkSessionKey, title, workspaceFile, workspaceFolder, model || undefined, {
    isTemporary: true,
    forkParentChatId: parentChatId,
    forkKind,
    sdkMode: 'agent',
  });
}

/**
 * Removes the temporary fork chats linked to a source chat.
 * @param {string} parentChatId
 * @param {'title'|'summary'} [forkKind]
 * @returns {Array<object>}
 */
export function deleteTemporaryForkChats(parentChatId, forkKind) {
  const chats = loadChats();
  const doomed = chats.filter(
    (c) =>
      c &&
      c.isTemporary === true &&
      c.forkParentChatId === parentChatId &&
      (!forkKind || c.forkKind === forkKind)
  );
  if (doomed.length === 0) return [];
  const doomedIds = new Set(doomed.map((c) => c.id));
  saveChats(chats.filter((c) => !doomedIds.has(c.id)));
  return doomed;
}

/**
 * @param {string} id - our own chat id (uuid)
 */
export function removeChat(id) {
  const chats = loadChats().filter((c) => c.id !== id);
  saveChats(chats);
}

/**
 * Full server-side chat removal: the list entry plus any related data.
 * Single place for all cleanup — currently only data/chats.json.
 * @param {string} id - chat id (uuid)
 */
export function deleteChat(id) {
  removeChat(id);
  deleteChatHistory(id);
}

/**
 * @param {string} id - chat id (uuid)
 * @param {{ title?: string, model?: string, sdkMode?: string, sdkUiMode?: string, summary?: string, summaryTitle?: string, todoId?: string|null, archived?: boolean, forkParentChatId?: string|null }} updates - fields to update; summary + summaryTitle append one entry to summaries
 * @returns {{ id: string, title: string, cursorSessionId: string, workspaceFile?: string, workspaceFolder?: string, model?: string, todoId?: string, summaries?: Array<{ summary: string, title?: string, at: string }>, createdAt: string } | null}
 */
export function updateChat(id, updates) {
  const chats = loadChats();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  if (typeof updates.title === 'string') chats[idx].title = updates.title.trim() || chats[idx].title;
  if (updates.model !== undefined) chats[idx].model = updates.model || undefined;
  if (updates.sdkMode !== undefined) chats[idx].sdkMode = normalizeSdkMode(updates.sdkMode);
  if (updates.sdkUiMode !== undefined) {
    chats[idx].sdkUiMode = normalizeSdkUiMode(updates.sdkUiMode);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'todoId')) {
    const nextTodoId = updates.todoId == null ? '' : String(updates.todoId).trim();
    if (nextTodoId) chats[idx].todoId = nextTodoId;
    else delete chats[idx].todoId;
  }
  if (typeof updates.summary === 'string' && updates.summary.trim()) {
    if (!Array.isArray(chats[idx].summaries)) chats[idx].summaries = [];
    chats[idx].summaries.push({
      summary: updates.summary.trim(),
      title: typeof updates.summaryTitle === 'string' ? updates.summaryTitle.trim() : undefined,
      at: new Date().toISOString(),
    });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionEnabled')) {
    chats[idx].autoContextCompressionEnabled = updates.autoContextCompressionEnabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionThreshold')) {
    chats[idx].autoContextCompressionThreshold = normalizeAutoContextThreshold(
      updates.autoContextCompressionThreshold
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionReset')) {
    chats[idx].autoContextCompressionReset = updates.autoContextCompressionReset !== false;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contextAdvisoryEnabled')) {
    if (updates.contextAdvisoryEnabled === false) chats[idx].contextAdvisoryEnabled = false;
    else delete chats[idx].contextAdvisoryEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contextAdvisoryWarnPercent')) {
    chats[idx].contextAdvisoryWarnPercent = normalizeContextAdvisoryWarnPercent(
      updates.contextAdvisoryWarnPercent
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'opencodeSessionId')) {
    const nextId = updates.opencodeSessionId == null ? '' : String(updates.opencodeSessionId).trim();
    if (nextId) chats[idx].opencodeSessionId = nextId;
    else delete chats[idx].opencodeSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'codebuddySessionId')) {
    const nextId = updates.codebuddySessionId == null ? '' : String(updates.codebuddySessionId).trim();
    if (nextId) chats[idx].codebuddySessionId = nextId;
    else delete chats[idx].codebuddySessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'deepseekSessionId')) {
    const nextId = updates.deepseekSessionId == null ? '' : String(updates.deepseekSessionId).trim();
    if (nextId) chats[idx].deepseekSessionId = nextId;
    else delete chats[idx].deepseekSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'codexThreadId')) {
    const nextId = updates.codexThreadId == null ? '' : String(updates.codexThreadId).trim();
    if (nextId) chats[idx].codexThreadId = nextId;
    else delete chats[idx].codexThreadId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'qwenSessionId')) {
    const nextId = updates.qwenSessionId == null ? '' : String(updates.qwenSessionId).trim();
    if (nextId) chats[idx].qwenSessionId = nextId;
    else delete chats[idx].qwenSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'forkParentChatId')) {
    const nextParent = updates.forkParentChatId == null ? '' : String(updates.forkParentChatId).trim();
    if (!nextParent) {
      delete chats[idx].forkParentChatId;
    } else if (nextParent === id) {
      throw new Error('Chat cannot be nested under itself');
    } else if (!chats.some((chat) => chat.id === nextParent)) {
      throw new Error('Parent chat not found');
    } else if (wouldCreateChatParentCycle(chats, id, nextParent)) {
      throw new Error('Cannot nest a chat under its descendant');
    } else {
      chats[idx].forkParentChatId = nextParent;
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'archived')) {
    if (updates.archived === true) chats[idx].archivedAt = new Date().toISOString();
    else delete chats[idx].archivedAt;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'widgetPinnedUrl')) {
    const nextPinnedUrl = updates.widgetPinnedUrl == null ? '' : String(updates.widgetPinnedUrl).trim();
    if (nextPinnedUrl) {
      for (let i = 0; i < chats.length; i += 1) {
        if (i === idx) continue;
        const otherPinnedUrl = typeof chats[i].widgetPinnedUrl === 'string'
          ? chats[i].widgetPinnedUrl.trim()
          : '';
        if (otherPinnedUrl && isSamePageUrl(otherPinnedUrl, nextPinnedUrl)) {
          delete chats[i].widgetPinnedUrl;
        }
      }
      chats[idx].widgetPinnedUrl = nextPinnedUrl;
    } else {
      delete chats[idx].widgetPinnedUrl;
    }
  }
  chats[idx].updatedAt = new Date().toISOString();
  saveChats(chats);
  return chats[idx];
}

/**
 * Cloud @cursor/sdk agent id — set only by the server (SDK WebSocket), never through the public PATCH.
 * @param {string} id - chat id (uuid)
 * @param {string | null | undefined} sdkAgentId - e.g. bc-…; an empty value removes the field
 * @returns {object | null}
 */
export function setChatSdkAgentId(id, sdkAgentId) {
  const chats = loadChats();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = sdkAgentId == null ? '' : String(sdkAgentId).trim();
  if (!trimmed) {
    delete chats[idx].sdkAgentId;
  } else {
    chats[idx].sdkAgentId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  saveChats(chats);
  return chats[idx];
}

/**
 * OpenCode session id — set by server when session.create succeeds.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} opencodeSessionId
 * @returns {object | null}
 */
export function setChatOpenCodeSessionId(id, opencodeSessionId) {
  const chats = loadChats();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = opencodeSessionId == null ? '' : String(opencodeSessionId).trim();
  if (!trimmed) {
    delete chats[idx].opencodeSessionId;
  } else {
    chats[idx].opencodeSessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  saveChats(chats);
  return chats[idx];
}

/**
 * CodeBuddy session id — set by server from the SDK system/init message.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} codebuddySessionId
 * @returns {object | null}
 */
export function setChatCodeBuddySessionId(id, codebuddySessionId) {
  const chats = loadChats();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = codebuddySessionId == null ? '' : String(codebuddySessionId).trim();
  if (!trimmed) {
    delete chats[idx].codebuddySessionId;
  } else {
    chats[idx].codebuddySessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  saveChats(chats);
  return chats[idx];
}

/**
 * DeepSeek Harness session id — set by the server from the first SDK run.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} deepseekSessionId
 * @returns {object | null}
 */
export function setChatDeepSeekSessionId(id, deepseekSessionId) {
  const chats = loadChats();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = deepseekSessionId == null ? '' : String(deepseekSessionId).trim();
  if (!trimmed) {
    delete chats[idx].deepseekSessionId;
  } else {
    chats[idx].deepseekSessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  saveChats(chats);
  return chats[idx];
}

/**
 * Codex SDK thread id — set by the server from thread.started.
 * @param {string} id - chat uuid
 * @param {string | null | undefined} codexThreadId
 * @returns {object | null}
 */
export function setChatCodexThreadId(id, codexThreadId) {
  const chats = loadChats();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = codexThreadId == null ? '' : String(codexThreadId).trim();
  if (!trimmed) {
    delete chats[idx].codexThreadId;
  } else {
    chats[idx].codexThreadId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  saveChats(chats);
  return chats[idx];
}

/**
 * Qwen Code session id — set by the server after the first successful query().
 * @param {string} id - chat uuid
 * @param {string | null | undefined} qwenSessionId
 * @returns {object | null}
 */
export function setChatQwenSessionId(id, qwenSessionId) {
  const chats = loadChats();
  const idx = chats.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const trimmed = qwenSessionId == null ? '' : String(qwenSessionId).trim();
  if (!trimmed) {
    delete chats[idx].qwenSessionId;
  } else {
    chats[idx].qwenSessionId = trimmed;
  }
  chats[idx].updatedAt = new Date().toISOString();
  saveChats(chats);
  return chats[idx];
}

/**
 * Detaches the chat from its old agent and local store by rotating the SDK session key.
 *
 * @param {string} id
 * @returns {object | null}
 */
export function rotateChatSdkSession(id) {
  const chats = loadChats();
  const idx = chats.findIndex((chat) => chat.id === id);
  if (idx === -1) return null;
  chats[idx] = createFreshSdkContextEntry(chats[idx], randomUUID());
  chats[idx].updatedAt = new Date().toISOString();
  saveChats(chats);
  return chats[idx];
}
