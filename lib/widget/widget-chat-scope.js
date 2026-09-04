/**
 * Checks whether chat belongs to the current widget page scope.
 * @param {object | null | undefined} chat
 * @param {object | null | undefined} access
 * @returns {boolean}
 */
export function widgetChatListScope(chat, access) {
  if (!chat || !access) return false;
  if (chat.widgetInstallationId !== access.installationId) return false;
  if (chat.widgetPageSessionId !== access.pageSessionId) return false;
  if (access.workspaceFile && chat.workspaceFile !== access.workspaceFile) return false;
  if (access.workspaceFolder && chat.workspaceFolder !== access.workspaceFolder) return false;
  return true;
}

/**
 * Checks whether chat can be accessed from widget session.
 * Includes page-scoped chats and pinned chats from the same installation/workspace.
 * @param {object | null | undefined} chat
 * @param {object | null | undefined} access
 * @returns {boolean}
 */
export function widgetChatAccessScope(chat, access) {
  if (widgetChatListScope(chat, access)) return true;
  if (!chat || !access) return false;
  if (chat.widgetInstallationId !== access.installationId) return false;
  if (access.workspaceFile && chat.workspaceFile !== access.workspaceFile) return false;
  if (access.workspaceFolder && chat.workspaceFolder !== access.workspaceFolder) return false;
  const pinnedUrl = typeof chat.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
  return !!pinnedUrl;
}
