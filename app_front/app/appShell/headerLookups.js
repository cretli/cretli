/** Reads the active workspace file/folder from the header workspace trigger. */
import { getActiveChatIdValue, getChatsList } from '../../features/chat/index.js';

export function getActiveWorkspaceFileFromHeader() {
  const trigger = document.getElementById('header-workspace-trigger');
  return trigger?.dataset?.workspaceFile || '';
}

export function getActiveWorkspaceFolderFromHeader() {
  const trigger = document.getElementById('header-workspace-trigger');
  return trigger?.dataset?.workspaceFolder || '';
}

export function getActiveChatWorkspaceFolder() {
  const activeId = getActiveChatIdValue();
  const chat = getChatsList().find((entry) => entry.id === activeId);
  return String(chat?.workspaceFolder || getActiveWorkspaceFolderFromHeader() || '').trim();
}
