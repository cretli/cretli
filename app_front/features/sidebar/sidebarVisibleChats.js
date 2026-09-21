/** Max live chats rendered per workspace group unless search is active or the user expands. */
export const SIDEBAR_VISIBLE_CHAT_LIMIT = 40;

/**
 * Keep the first `limit` tree rows, plus the active chat (and its ancestors).
 *
 * @param {Array<{ chat: { id?: string }, parentId?: string }>} treeChats
 * @param {{ limit?: number, activeChatId?: string, showAll?: boolean }} [options]
 * @returns {{ items: typeof treeChats, hidden: number }}
 */
export function capSidebarVisibleTreeChats(treeChats, options = {}) {
  const list = Array.isArray(treeChats) ? treeChats : [];
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.round(Number(options.limit)))
    : SIDEBAR_VISIBLE_CHAT_LIMIT;
  if (options.showAll === true || list.length <= limit) {
    return { items: list, hidden: 0 };
  }
  const keep = new Set();
  for (const item of list.slice(0, limit)) {
    if (item?.chat?.id) keep.add(item.chat.id);
  }
  const activeId = typeof options.activeChatId === 'string' ? options.activeChatId.trim() : '';
  if (activeId) {
    const byId = new Map();
    for (const item of list) {
      if (item?.chat?.id) byId.set(item.chat.id, item);
    }
    let cursor = activeId;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      keep.add(cursor);
      const row = byId.get(cursor);
      cursor = typeof row?.parentId === 'string' ? row.parentId : '';
    }
  }
  const items = list.filter((item) => item?.chat?.id && keep.has(item.chat.id));
  return { items, hidden: Math.max(0, list.length - items.length) };
}

/**
 * Collapsed workspace groups skip chat-row HTML (header + count only).
 *
 * @param {boolean} isCollapsed
 * @param {boolean} [searching]
 * @returns {boolean}
 */
export function shouldSerializeWorkspaceChatList(isCollapsed, searching = false) {
  if (searching === true) return true;
  return isCollapsed !== true;
}

/** @type {Set<string>} */
let renderedSidebarChatIds = new Set();
let sidebarArchiveSectionOpen = false;

/**
 * @param {Iterable<string> | null | undefined} ids
 */
export function setRenderedSidebarChatIds(ids) {
  renderedSidebarChatIds = new Set(ids || []);
}

/**
 * @returns {Set<string>}
 */
export function getRenderedSidebarChatIds() {
  return renderedSidebarChatIds;
}

/**
 * @param {boolean} isOpen
 */
export function setSidebarArchiveSectionOpen(isOpen) {
  sidebarArchiveSectionOpen = isOpen === true;
}

/**
 * @returns {boolean}
 */
export function isSidebarArchiveSectionOpen() {
  return sidebarArchiveSectionOpen;
}
