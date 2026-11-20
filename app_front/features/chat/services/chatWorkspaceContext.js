/** Workspace context lookups and header workspace filtering for the chat list. */
import { getViewContextRuntimeScope } from '../../../app/appShell/viewContextBridge.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { listLoadedWorkspaces } from './voiceWorkspaces.js';
import { chatBelongsToWorkspaceGroup } from '../../sidebar/workspaceChatMatch.js';

import { chatShell } from '../state/chatShellState.js';
import { chatHost } from './chatHost.js';

/** Chats assigned to the current header workspace. Older chats (no workspaceFile) are hidden. */
export function getWorkspaceContextForChat() {
  const scoped = getViewContextRuntimeScope();
  if (scoped.workspaceFile || scoped.workspaceFolder) {
    return {
      workspaceFile: scoped.workspaceFile,
      workspaceFolder: scoped.workspaceFolder,
    };
  }
  const embedOverride = (typeof window !== 'undefined' && window.__crWorkspaceOverride)
    ? window.__crWorkspaceOverride
    : null;
  const workspaceFile = embedOverride?.workspaceFile || '';
  const workspaceFolder = embedOverride?.workspaceFolder || '';
  if (!workspaceFile && !workspaceFolder) return null;
  return {
    workspaceFile,
    workspaceFolder,
  };
}

export function resolveChatCreationWorkspaceContext() {
  const workspaceSel = document.getElementById('chat-new-workspace-select');
  const folderSel = document.getElementById('chat-new-folder-select');
  const ctx = getWorkspaceContextForChat();
  const workspaceFile = (
    chatRuntime.selectedWorkspaceFile ||
    workspaceSel?.value ||
    ctx?.workspaceFile ||
    ''
  ).trim();
  const workspaceFolder = (
    chatRuntime.selectedWorkspaceFolder ||
    folderSel?.value ||
    ctx?.workspaceFolder ||
    ''
  ).trim();
  return {
    workspaceFile,
    workspaceFolder,
  };
}

/** Use the same configured workspace folders for direct and sidebar chat selection. */
export function setWorkspacePreferredFolderLookup(lookup, listWorkspaceContexts) {
  chatShell.getPreferredWorkspaceFolderForChat = typeof lookup === 'function' ? lookup : () => '';
  chatShell.listWorkspaceContextsForChat = typeof listWorkspaceContexts === 'function'
    ? listWorkspaceContexts : () => listLoadedWorkspaces();
}

/**
 * Sidebar clone folders for a .code-workspace file. Used so the chat panel
 * does not list a clone's chats on the parent workspace.
 *
 * @param {(workspaceFile: string) => string[]} lookup
 */
export function setWorkspaceCloneFolderLookup(lookup) {
  chatShell.listCloneFoldersForHeader = typeof lookup === 'function' ? lookup : () => [];
}

export function filterChatsForHeaderWorkspace(wantArchived) {
  const ctx = getWorkspaceContextForChat();
  const headerWorkspace = ctx?.workspaceFile || null;
  if (!headerWorkspace) return [];
  const cloneFolders = chatShell.listCloneFoldersForHeader(headerWorkspace);
  const headerFolder = ctx?.workspaceFolder || '';
  const isCloneView = cloneFolders.some(
    (folder) => chatHost.normalizePath(folder) === chatHost.normalizePath(headerFolder),
  );
  return chats.filter((chat) => {
    if (!chatBelongsToWorkspaceGroup(chat, {
      workspaceFile: headerWorkspace,
      groupFolder: headerFolder,
      isClone: isCloneView,
      cloneFolders,
    })) return false;
    return wantArchived ? !!chat.archivedAt : !chat.archivedAt;
  });
}

export function getChatsForCurrentWorkspace() {
  return filterChatsForHeaderWorkspace(false);
}

export function getArchivedChatsForCurrentWorkspace() {
  return filterChatsForHeaderWorkspace(true);
}

/**
 * @param {string} harness Transport id.
 * @param {unknown} enabledKeys
 */
export function applyEnabledModelsForHarness(harness, enabledKeys) {
  chatRuntime.chatModelSelectApi?.applyEnabledModels(harness, enabledKeys);
}
