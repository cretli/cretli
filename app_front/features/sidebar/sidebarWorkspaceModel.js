/**
 * Stable list keys and Lit host markup for sidebar workspaces (stage 6.4).
 */

/** @typedef {'chat' | 'subchat-group' | 'archive' | 'more' | 'empty'} SidebarListEntryKind */

/**
 * @typedef {object} SidebarListEntry
 * @property {SidebarListEntryKind} kind
 * @property {string} key Stable repeat key (chat.id, group parent id, workspace-scoped sentinel)
 * @property {string} [chatId]
 * @property {string} [parentId]
 * @property {string} [sidebarKey]
 * @property {number} [hiddenCount]
 */

/**
 * @typedef {object} SidebarWorkspaceRegistration
 * @property {string} sidebarKey
 * @property {object} workspace
 * @property {boolean} isActive
 * @property {boolean} isCollapsed
 * @property {boolean} searching
 * @property {boolean} serializeList
 * @property {number} count
 * @property {string} preferredFolder
 * @property {string} autopilotBadgeHtml
 * @property {SidebarListEntry[]} listEntries
 * @property {object} deps
 */

/**
 * @param {string} parentId
 * @returns {string}
 */
export function sidebarSubchatGroupRepeatKey(parentId) {
  return 'group:' + String(parentId || '').trim();
}

/**
 * @param {string} sidebarKey
 * @returns {string}
 */
export function sidebarArchiveRepeatKey(sidebarKey) {
  return 'archive:' + String(sidebarKey || '').trim();
}

/**
 * @param {string} sidebarKey
 * @returns {string}
 */
export function sidebarShowMoreRepeatKey(sidebarKey) {
  return 'more:' + String(sidebarKey || '').trim();
}

/**
 * @param {string} sidebarKey
 * @returns {string}
 */
export function sidebarEmptyRepeatKey(sidebarKey) {
  return 'empty:' + String(sidebarKey || '').trim();
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function sidebarChatRepeatKey(chatId) {
  return String(chatId || '').trim();
}

/**
 * @param {string} sidebarKey
 * @param {(value: unknown) => string} escapeHtml
 * @returns {string}
 */
export function buildSidebarWorkspaceHostHtml(sidebarKey, escapeHtml) {
  const key = String(sidebarKey || '').trim();
  if (!key) return '';
  return '<cr-sidebar-workspace sidebar-key="' + escapeHtml(key) + '"></cr-sidebar-workspace>';
}

/**
 * @param {string} parentId
 * @param {(value: unknown) => string} escapeHtml
 * @returns {string}
 */
export function buildSidebarSubchatGroupHostHtml(parentId, escapeHtml) {
  const id = String(parentId || '').trim();
  if (!id) return '';
  return '<cr-sidebar-subchat-group parent-id="' + escapeHtml(id) + '"></cr-sidebar-subchat-group>';
}

/**
 * @param {string} sidebarKey
 * @param {(value: unknown) => string} escapeHtml
 * @returns {string}
 */
export function buildSidebarArchiveGroupHostHtml(sidebarKey, escapeHtml) {
  const key = String(sidebarKey || '').trim();
  if (!key) return '';
  return '<cr-sidebar-archive-group sidebar-key="' + escapeHtml(key) + '"></cr-sidebar-archive-group>';
}
