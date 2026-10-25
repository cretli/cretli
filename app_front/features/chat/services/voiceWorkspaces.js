/** Voice-assistant chat and workspace helpers. */
import * as api from '../../../core/api/index.js';
import { normalizeSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../../../../lib/sdk/sdk-ui-mode.ts';
import {
  workspaceSpokenLabel,
  matchWorkspaceBySpokenName,
  collectWorkspaceFolders,
  matchFolderBySpokenName,
} from '../../voice/voiceWorkspaceMatch.js';
import { isEmbedWidgetMode, normalizeNewChatHarness } from './newChatHarnessState.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { chatHost } from './chatHost.js';

export function listLoadedWorkspaces() {
  return Array.isArray(chatRuntime.workspaces)
    ? chatRuntime.workspaces.filter((entry) => entry && String(entry.workspaceFile || '').trim())
    : [];
}

function findLoadedWorkspaceByFile(workspaceFile) {
  const wanted = chatHost.normalizePath(workspaceFile);
  if (!wanted) return null;
  return listLoadedWorkspaces().find((entry) => chatHost.normalizePath(entry.workspaceFile) === wanted) || null;
}

function voiceWidgetBlocked() {
  if (!isEmbedWidgetMode()) return null;
  return { ok: false, error: 'not available in widget' };
}

/**
 * @param {string} workspaceFile
 * @param {string} [workspaceFolder]
 * @returns {Promise<boolean>}
 */
export async function applyVoiceWorkspaceSwitch(workspaceFile, workspaceFolder) {
  const file = String(workspaceFile || '').trim();
  const folder = String(workspaceFolder || '').trim();
  if (!file) return false;
  if (typeof chatRuntime.workspaceSwitchHook === 'function') {
    return !!(await chatRuntime.workspaceSwitchHook(file, folder));
  }
  window.dispatchEvent(
    new CustomEvent('cretli-request-workspace', {
      detail: { workspaceFile: file, workspaceFolder: folder },
    })
  );
  return true;
}

function voiceWorkspaceSnapshot() {
  const ctx = chatHost.getWorkspaceContextForChat();
  const active = findLoadedWorkspaceByFile(ctx?.workspaceFile);
  const folderPath = String(ctx?.workspaceFolder || '').replace(/\\/g, '/');
  return {
    workspace: active
      ? workspaceSpokenLabel(active)
      : workspaceSpokenLabel({ workspaceFile: ctx?.workspaceFile }),
    folder: folderPath.split('/').filter(Boolean).pop() || folderPath || '',
    chatCount: chatHost.getChatsForCurrentWorkspace().length,
  };
}

/**
 * Creates a chat from voice Live: active workspace, or the one the user named.
 *
 * @param {{ title?: string, workspace?: string }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   chatId?: string,
 *   title?: string,
 *   workspace?: string,
 *   harness?: string,
 *   error?: string,
 *   workspaces?: string[],
 * }>}
 */
export async function createVoiceChat(options = {}) {
  const title = String(options.title || '').trim();
  const spoken = String(options.workspace || '').trim();
  await chatHost.loadWorkspaces();
  const items = Array.isArray(chatRuntime.workspaces)
    ? chatRuntime.workspaces.filter((entry) => entry && String(entry.workspaceFile || '').trim())
    : [];
  const activeChat = chats.find((chat) => chat.id === chatRuntime.activeChatId) || null;
  const ctx = chatHost.getWorkspaceContextForChat();
  let chosen = null;
  if (spoken) {
    const result = matchWorkspaceBySpokenName(items, spoken);
    if (result.ambiguous) {
      return {
        ok: false,
        error: `Several workspaces match "${spoken}"`,
        workspaces: result.candidates,
      };
    }
    if (!result.match) {
      return {
        ok: false,
        error: `Workspace not found: ${spoken}`,
        workspaces: items.map((entry) => workspaceSpokenLabel(entry)).slice(0, 12),
      };
    }
    chosen = result.match;
  } else {
    const preferredFile = (activeChat?.workspaceFile || ctx?.workspaceFile || '').trim();
    chosen =
      items.find((entry) => chatHost.normalizePath(entry.workspaceFile) === chatHost.normalizePath(preferredFile)) ||
      items[0] ||
      null;
  }
  const workspaceFile = String(
    chosen?.workspaceFile || activeChat?.workspaceFile || ctx?.workspaceFile || ''
  ).trim();
  if (!workspaceFile) return { ok: false, error: 'No workspace available' };
  const sameAsActive = chatHost.normalizePath(workspaceFile) === chatHost.normalizePath(activeChat?.workspaceFile || '');
  const sameAsHeader = chatHost.normalizePath(workspaceFile) === chatHost.normalizePath(ctx?.workspaceFile || '');
  const workspaceFolder = String(
    (sameAsActive && activeChat?.workspaceFolder) ||
      (sameAsHeader && ctx?.workspaceFolder) ||
      chatHost.getWorkspaceDefaultFolder(chosen) ||
      ''
  ).trim();
  if (!workspaceFolder) return { ok: false, error: 'Workspace has no folder' };
  const harness = normalizeNewChatHarness(chatRuntime.selectedHarness || activeChat?.agentTransport || 'sdk');
  const payload = {
    workspaceFile,
    workspaceFolder,
    agentTransport: harness,
    sdkMode: 'agent',
    sdkUiMode: 'compact',
  };
  if (title) payload.title = title;
  let data;
  try {
    data = await api.postChat(payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!data?.ok || !data.chat?.id) {
    return { ok: false, error: data?.error || 'Could not create the chat' };
  }
  const chat = data.chat;
  chat.agentTransport = normalizeNewChatHarness(chat.agentTransport);
  chat.sdkMode = normalizeSdkMode(chat.sdkMode);
  chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
  chat.workspaceFile ||= workspaceFile;
  chat.workspaceFolder ||= workspaceFolder;
  if (!chats.some((entry) => entry.id === chat.id)) chats.push(chat);
  const headerFile = String(ctx?.workspaceFile || '').trim();
  if (headerFile && chatHost.normalizePath(headerFile) !== chatHost.normalizePath(workspaceFile)) {
    await applyVoiceWorkspaceSwitch(workspaceFile, workspaceFolder);
  }
  chatHost.renderChatList();
  chatHost.openTerminal(chat);
  chatHost.selectChat(chat.id);
  chatRuntime.chatModelSelectApi?.setModelPickerHarness(harness);
  chatHost.notifySidebar();
  return {
    ok: true,
    chatId: chat.id,
    title: String(chat.title || title || '').trim() || 'untitled',
    workspace: chosen ? workspaceSpokenLabel(chosen) : workspaceSpokenLabel({ workspaceFile }),
    harness,
  };
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   workspaces?: Array<{ name: string, active: boolean, folderCount: number }>,
 *   error?: string,
 * }>}
 */
export async function listVoiceWorkspaces() {
  await chatHost.loadWorkspaces();
  const ctx = chatHost.getWorkspaceContextForChat();
  const headerNorm = chatHost.normalizePath(ctx?.workspaceFile);
  const workspacesOut = listLoadedWorkspaces().map((entry) => ({
    name: workspaceSpokenLabel(entry),
    active: chatHost.normalizePath(entry.workspaceFile) === headerNorm,
    folderCount: collectWorkspaceFolders(entry).length,
  }));
  return { ok: true, workspaces: workspacesOut };
}

/**
 * @param {{ workspace?: string, folder?: string }} [options]
 * @returns {Promise<object>}
 */
export async function switchVoiceWorkspace(options = {}) {
  const blocked = voiceWidgetBlocked();
  if (blocked) return blocked;
  const spoken = String(options.workspace || '').trim();
  if (!spoken) return { ok: false, error: 'Missing workspace name' };
  await chatHost.loadWorkspaces();
  const items = listLoadedWorkspaces();
  const result = matchWorkspaceBySpokenName(items, spoken);
  if (result.ambiguous) {
    return { ok: false, error: `Several workspaces match "${spoken}"`, workspaces: result.candidates };
  }
  if (!result.match) {
    return {
      ok: false,
      error: `Workspace not found: ${spoken}`,
      workspaces: items.map((entry) => workspaceSpokenLabel(entry)).slice(0, 12),
    };
  }
  const chosen = result.match;
  const folders = collectWorkspaceFolders(chosen);
  const spokenFolder = String(options.folder || '').trim();
  let folderPath = chatHost.getWorkspaceDefaultFolder(chosen);
  if (spokenFolder) {
    const folderResult = matchFolderBySpokenName(folders, spokenFolder);
    if (folderResult.ambiguous) {
      return { ok: false, error: `Several folders match "${spokenFolder}"`, folders: folderResult.candidates };
    }
    if (!folderResult.match) {
      return {
        ok: false,
        error: `Folder not found: ${spokenFolder}`,
        folders: folders.map((entry) => entry.name).slice(0, 12),
      };
    }
    folderPath = folderResult.match.path;
  }
  const switched = await applyVoiceWorkspaceSwitch(chosen.workspaceFile, folderPath);
  if (!switched) return { ok: false, error: 'Could not switch workspace' };
  return { ok: true, ...voiceWorkspaceSnapshot() };
}

/**
 * @returns {Promise<object>}
 */
export async function listVoiceFolders() {
  await chatHost.loadWorkspaces();
  const ctx = chatHost.getWorkspaceContextForChat();
  const current = findLoadedWorkspaceByFile(ctx?.workspaceFile);
  if (!current) return { ok: false, error: 'No workspace is active' };
  const activePath = chatHost.normalizePath(ctx?.workspaceFolder);
  const folders = collectWorkspaceFolders(current).map((entry) => ({
    name: entry.name,
    active: chatHost.normalizePath(entry.path) === activePath,
  }));
  return { ok: true, workspace: workspaceSpokenLabel(current), folders };
}

/**
 * @param {{ folder?: string }} [options]
 * @returns {Promise<object>}
 */
export async function switchVoiceFolder(options = {}) {
  const blocked = voiceWidgetBlocked();
  if (blocked) return blocked;
  const spoken = String(options.folder || '').trim();
  if (!spoken) return { ok: false, error: 'Missing folder name' };
  await chatHost.loadWorkspaces();
  const ctx = chatHost.getWorkspaceContextForChat();
  const current = findLoadedWorkspaceByFile(ctx?.workspaceFile);
  if (!current) return { ok: false, error: 'No workspace is active' };
  const folders = collectWorkspaceFolders(current);
  const folderResult = matchFolderBySpokenName(folders, spoken);
  if (folderResult.ambiguous) {
    return { ok: false, error: `Several folders match "${spoken}"`, folders: folderResult.candidates };
  }
  if (!folderResult.match) {
    return {
      ok: false,
      error: `Folder not found: ${spoken}`,
      folders: folders.map((entry) => entry.name).slice(0, 12),
    };
  }
  const switched = await applyVoiceWorkspaceSwitch(current.workspaceFile, folderResult.match.path);
  if (!switched) return { ok: false, error: 'Could not switch folder' };
  return { ok: true, ...voiceWorkspaceSnapshot() };
}

/**
 * @param {{ chatId: string }} options
 * @returns {Promise<object>}
 */
export async function closeVoiceChat(options = {}) {
  const chatId = String(options.chatId || '').trim();
  if (!chatId) return { ok: false, error: 'Missing chat id' };
  const chat = chats.find((entry) => entry.id === chatId);
  if (!chat) return { ok: false, error: 'Chat not found' };
  const title = String(chat.title || '').trim() || 'untitled';
  const archived = await chatHost.requestArchiveChat(chatId);
  if (!archived) return { ok: false, error: 'Could not archive the chat' };
  return { ok: true, chatId, title, archived: true };
}

/**
 * @param {{ chatId: string, title: string }} options
 * @returns {Promise<object>}
 */
export async function renameVoiceChat(options = {}) {
  const chatId = String(options.chatId || '').trim();
  const nextTitle = String(options.title || '').trim();
  if (!chatId) return { ok: false, error: 'Missing chat id' };
  if (!nextTitle) return { ok: false, error: 'Missing title' };
  const chat = chats.find((entry) => entry.id === chatId);
  if (!chat) return { ok: false, error: 'Chat not found' };
  try {
    const data = await api.patchChat(chat.id, { title: nextTitle });
    if (!data?.ok) return { ok: false, error: data?.error || 'Could not rename the chat' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  chat.title = nextTitle;
  chatHost.renderChatList();
  chatHost.notifySidebar();
  return { ok: true, chatId: chat.id, title: nextTitle };
}
