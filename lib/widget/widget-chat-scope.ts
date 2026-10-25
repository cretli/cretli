export type WidgetChatRecord = {
  widgetInstallationId?: unknown;
  widgetPageSessionId?: unknown;
  widgetPinnedUrl?: unknown;
  workspaceFile?: unknown;
  workspaceFolder?: unknown;
  [key: string]: unknown;
};

export type WidgetAccessRecord = {
  installationId?: unknown;
  pageSessionId?: unknown;
  workspaceFile?: unknown;
  workspaceFolder?: unknown;
  [key: string]: unknown;
};

/**
 * Checks whether chat belongs to the current widget page scope.
 * @param chat
 * @param access
 */
export function widgetChatListScope(chat: WidgetChatRecord | null | undefined, access: WidgetAccessRecord | null | undefined): boolean {
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
 * @param chat
 * @param access
 */
export function widgetChatAccessScope(chat: WidgetChatRecord | null | undefined, access: WidgetAccessRecord | null | undefined): boolean {
  if (widgetChatListScope(chat, access)) return true;
  if (!chat || !access) return false;
  if (chat.widgetInstallationId !== access.installationId) return false;
  if (access.workspaceFile && chat.workspaceFile !== access.workspaceFile) return false;
  if (access.workspaceFolder && chat.workspaceFolder !== access.workspaceFolder) return false;
  const pinnedUrl = typeof chat.widgetPinnedUrl === 'string' ? chat.widgetPinnedUrl.trim() : '';
  return !!pinnedUrl;
}
