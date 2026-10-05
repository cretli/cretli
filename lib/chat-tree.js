/**
 * Sidebar chat tree: children nest under their immediate `forkParentChatId`.
 * Forks, delegations, and manually nested chats share that parent field.
 */

/**
 * @param {object | null | undefined} chat
 * @returns {string}
 */
export function readForkParentChatId(chat) {
  if (!chat || typeof chat.forkParentChatId !== 'string') return '';
  return chat.forkParentChatId.trim();
}

/**
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isChatArchived(chat) {
  return Boolean(String(chat?.archivedAt || '').trim());
}

/** @type {number} */
let collectForkSubtreeIdsCallCount = 0;

/** Resets the test counter for {@link collectForkSubtreeIds} invocations. */
export function resetCollectForkSubtreeIdsCallCount() {
  collectForkSubtreeIdsCallCount = 0;
}

/** @returns {number} */
export function getCollectForkSubtreeIdsCallCount() {
  return collectForkSubtreeIdsCallCount;
}

/**
 * The chat plus every fork descendant. Archiving a parent moves this whole set.
 *
 * @param {object[] | null | undefined} chats
 * @param {unknown} rootId
 * @returns {Set<string>}
 */
export function collectForkSubtreeIds(chats, rootId) {
  collectForkSubtreeIdsCallCount += 1;
  const root = String(rootId || '').trim();
  /** @type {Set<string>} */
  const ids = new Set();
  if (!root || !Array.isArray(chats)) return ids;
  ids.add(root);
  let changed = true;
  while (changed) {
    changed = false;
    for (const chat of chats) {
      const id = String(chat?.id || '').trim();
      const parentId = readForkParentChatId(chat);
      if (!id || !parentId || ids.has(id)) continue;
      if (!ids.has(parentId)) continue;
      ids.add(id);
      changed = true;
    }
  }
  return ids;
}

/**
 * One O(n) pass: ids whose fork subtree contains a busy chat (self or descendant).
 * Marks busy rows and walks `forkParentChatId` upward; stops on cycles, missing
 * parents, or an ancestor already marked busy (O(chats) even when many rows share a chain).
 *
 * @param {object[] | null | undefined} chats
 * @param {(chat: object) => boolean} isBusy
 * @returns {{ blocked: Set<string>, buildPassSteps: number }}
 */
export function buildForkArchiveBlockedIds(chats, isBusy) {
  /** @type {Set<string>} */
  const blocked = new Set();
  let buildPassSteps = 0;
  if (typeof isBusy !== 'function' || !Array.isArray(chats) || !chats.length) {
    return { blocked, buildPassSteps };
  }
  const byId = new Map();
  for (const chat of chats) {
    const id = String(chat?.id || '').trim();
    if (id) byId.set(id, chat);
  }
  for (const chat of chats) {
    buildPassSteps += 1;
    const id = String(chat?.id || '').trim();
    if (!id || isBusy(chat) !== true) continue;
    blocked.add(id);
    const seen = new Set();
    let parentId = readForkParentChatId(chat);
    while (parentId && !seen.has(parentId)) {
      if (blocked.has(parentId)) break;
      buildPassSteps += 1;
      seen.add(parentId);
      blocked.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      parentId = readForkParentChatId(parent);
    }
  }
  return { blocked, buildPassSteps };
}

/**
 * @param {Set<string> | null | undefined} blocked
 * @param {unknown} chatId
 * @returns {boolean}
 */
export function isForkArchiveBlocked(blocked, chatId) {
  const id = String(chatId || '').trim();
  if (!id || !blocked) return false;
  return blocked.has(id);
}

/**
 * True when `rootId` or any fork descendant matches `isBusy`.
 *
 * @param {object[] | null | undefined} chats
 * @param {unknown} rootId
 * @param {(chat: object) => boolean} isBusy
 * @returns {boolean}
 */
export function isForkSubtreeBusy(chats, rootId, isBusy) {
  if (typeof isBusy !== 'function' || !Array.isArray(chats)) return false;
  const ids = collectForkSubtreeIds(chats, rootId);
  for (const chat of chats) {
    const id = String(chat?.id || '').trim();
    if (!id || !ids.has(id)) continue;
    if (isBusy(chat) === true) return true;
  }
  return false;
}

/**
 * Stamp `archivedAt` on the root and every fork descendant, keeping the rows in
 * place. Callers pass the live list the sidebar renders: removing the parent row
 * instead of stamping it would make `flattenChatsTree` treat orphaned children
 * as roots. Already archived rows keep their original stamp.
 *
 * @param {object[] | null | undefined} chats
 * @param {unknown} rootId
 * @param {string} [stamp] ISO timestamp; defaults to now
 * @returns {string[]} the stamped subtree ids in list order (root first)
 */
export function markForkSubtreeArchived(chats, rootId, stamp) {
  const ids = collectForkSubtreeIds(chats, rootId);
  if (!Array.isArray(chats) || ids.size === 0) return [];
  const archivedAt = String(stamp || '').trim() || new Date().toISOString();
  const marked = [];
  for (const chat of chats) {
    const id = String(chat?.id || '').trim();
    if (!id || !ids.has(id)) continue;
    if (!isChatArchived(chat)) chat.archivedAt = archivedAt;
    marked.push(id);
  }
  return marked;
}

/**
 * Live sidebar row the user may open: not archived and not the durable watcher feed.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isLiveSelectableChat(chat) {
  if (!chat || typeof chat !== 'object') return false;
  if (isChatArchived(chat)) return false;
  if (chat.watcherPinned === true) return false;
  return Boolean(String(chat.id || '').trim());
}

/**
 * @param {object[] | null | undefined} chats
 * @param {string} chatId
 * @returns {boolean}
 */
function isLiveSelectableChatId(chats, chatId) {
  const id = String(chatId || '').trim();
  if (!id || !Array.isArray(chats)) return false;
  const row = chats.find((entry) => entry?.id === id);
  return isLiveSelectableChat(row);
}

/**
 * Last selectable live row in list order (bottom-up), for archive/delete fallbacks.
 *
 * @param {object[] | null | undefined} chats
 * @param {string} [excludeChatId]
 * @returns {string | null}
 */
export function findLastLiveSelectableChatId(chats, excludeChatId = '') {
  const exclude = String(excludeChatId || '').trim();
  if (!Array.isArray(chats) || !chats.length) return null;
  for (let index = chats.length - 1; index >= 0; index -= 1) {
    const chat = chats[index];
    if (!chat || chat.id === exclude) continue;
    if (!isLiveSelectableChat(chat)) continue;
    return chat.id;
  }
  return null;
}

/**
 * Target chat for the active pane after archiving one or more subtrees. Preserves
 * the current active chat when it stays live and outside the archived set; skips
 * watcher-pinned rows as automatic fallbacks. Returns empty when nothing was
 * archived (caller must not force `preferChatId` / `selectChat`).
 *
 * @param {{
 *   chats: object[],
 *   requestedId?: string | null,
 *   archivedIds: Set<string>,
 *   activeChatId?: string | null,
 * }} params
 * @returns {string}
 */
export function resolveArchiveSwitchId({ chats, requestedId, archivedIds, activeChatId }) {
  if (!archivedIds || archivedIds.size === 0) return '';
  const requested = String(requestedId || '').trim();
  if (requested && !archivedIds.has(requested) && isLiveSelectableChatId(chats, requested)) {
    return requested;
  }
  const active = String(activeChatId || '').trim();
  if (active && !archivedIds.has(active) && isLiveSelectableChatId(chats, active)) {
    return active;
  }
  return findLastLiveSelectableChatId(chats, '') || '';
}

/**
 * Related-chat history cards stay out of the stream when the target is
 * archived or missing from the live chat list.
 *
 * @param {object[] | null | undefined} chats
 * @param {string} chatId
 * @returns {boolean}
 */
export function isRelatedChatLinkVisible(chats, chatId) {
  const id = String(chatId || '').trim();
  if (!id || !Array.isArray(chats)) return false;
  const row = chats.find((chat) => chat?.id === id);
  if (!row) return false;
  return !isChatArchived(row);
}

/**
 * Archived chats that still have a live descendant. The sidebar keeps these
 * rows in the live tree so the descendant does not jump to the root.
 *
 * @param {object[] | null | undefined} chats
 * @returns {Set<string>}
 */
export function collectArchivedAncestorIds(chats) {
  const keep = new Set();
  if (!Array.isArray(chats) || !chats.length) return keep;
  const byId = new Map();
  chats.forEach((chat) => {
    if (chat?.id) byId.set(chat.id, chat);
  });
  chats.forEach((chat) => {
    if (!chat?.id || isChatArchived(chat)) return;
    let parentId = readForkParentChatId(chat);
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || !isChatArchived(parent)) break;
      keep.add(parent.id);
      parentId = readForkParentChatId(parent);
    }
  });
  return keep;
}

/**
 * Default sidebar payload: live chats plus archived ancestors of those chats.
 * `includeArchived` returns every row.
 *
 * @param {object[] | null | undefined} chats
 * @param {{ includeArchived?: boolean }} [options]
 * @returns {object[]}
 */
export function selectChatsForSidebarList(chats, options = {}) {
  if (!Array.isArray(chats)) return [];
  if (options.includeArchived === true) {
    return chats.filter((chat) => chat && typeof chat === 'object');
  }
  const keep = collectArchivedAncestorIds(chats);
  return chats.filter((chat) => {
    if (!chat || typeof chat !== 'object') return false;
    if (!isChatArchived(chat)) return true;
    return keep.has(chat.id);
  });
}

/**
 * Archived forks of a live parent stay out of the nest. An archived parent of
 * a live chat stays in `live` so the child keeps its place in the tree.
 *
 * @param {object[]} chats
 * @returns {{ live: object[], archived: object[] }}
 */
export function partitionChatsByArchive(chats) {
  const live = [];
  const archived = [];
  if (!Array.isArray(chats)) return { live, archived };
  const keep = collectArchivedAncestorIds(chats);
  chats.forEach((chat) => {
    if (isChatArchived(chat) && !keep.has(chat?.id)) {
      archived.push(chat);
      return;
    }
    live.push(chat);
  });
  return { live, archived };
}

/**
 * Harness switch lineage: a nested chat stays in its folder; a root chat
 * becomes the child of the new harness chat.
 *
 * @param {object | null | undefined} currentChat
 * @param {string} newChatId
 * @returns {{ childId: string, parentId: string } | null}
 */
export function resolveHarnessSwitchNest(currentChat, newChatId) {
  const newId = String(newChatId || '').trim();
  const currentId = String(currentChat?.id || '').trim();
  if (!newId || !currentId || newId === currentId) return null;
  const existingParent = readForkParentChatId(currentChat);
  if (existingParent && existingParent !== currentId && existingParent !== newId) {
    return { childId: newId, parentId: existingParent };
  }
  return { childId: currentId, parentId: newId };
}

/**
 * Walks ancestors of `parentId`. True when `chatId` appears in that chain.
 *
 * @param {object[]} chats
 * @param {string} chatId
 * @param {string} parentId
 * @returns {boolean}
 */
export function wouldCreateChatParentCycle(chats, chatId, parentId) {
  const id = String(chatId || '').trim();
  const startParent = String(parentId || '').trim();
  if (!id || !startParent) return false;
  if (id === startParent) return true;
  if (!Array.isArray(chats) || !chats.length) return false;
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  let current = byId.get(startParent);
  const visited = new Set();
  while (current?.id) {
    if (current.id === id) return true;
    if (visited.has(current.id)) break;
    visited.add(current.id);
    const nextId = readForkParentChatId(current);
    if (!nextId) break;
    current = byId.get(nextId);
  }
  return false;
}

/**
 * Roots in input order, then each parent's children (any depth) in input order.
 *
 * @param {object[]} chats
 * @returns {{ chat: object, level: number, isLastChild: boolean, parentId: string }[]}
 */
export function flattenChatsTree(chats) {
  if (!Array.isArray(chats) || !chats.length) return [];
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const childrenByParent = new Map();
  const roots = [];
  chats.forEach((chat) => {
    const parentId = readForkParentChatId(chat);
    if (!parentId || parentId === chat.id || !byId.has(parentId)) {
      roots.push(chat);
      return;
    }
    const list = childrenByParent.get(parentId) || [];
    list.push(chat);
    childrenByParent.set(parentId, list);
  });
  const linear = [];
  const visited = new Set();
  /** @type {{ chat: object, level: number, parentId: string, isLast: boolean }[]} */
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push({ chat: roots[i], level: 0, parentId: '', isLast: false });
  }
  while (stack.length) {
    const node = stack.pop();
    if (!node?.chat?.id || visited.has(node.chat.id)) continue;
    visited.add(node.chat.id);
    linear.push({
      chat: node.chat,
      level: node.level,
      isLastChild: node.level > 0 && node.isLast,
      parentId: node.parentId,
    });
    const children = childrenByParent.get(node.chat.id) || [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({
        chat: children[i],
        level: node.level + 1,
        parentId: node.chat.id,
        isLast: i === children.length - 1,
      });
    }
  }
  return linear;
}

/**
 * Chats whose ids are not in `order` stay at the front (new chats). The rest
 * follow the saved sequence.
 *
 * @param {object[]} chats
 * @param {string[] | null | undefined} order
 * @returns {object[]}
 */
export function applyChatOrder(chats, order) {
  if (!Array.isArray(chats) || !chats.length) return [];
  if (!Array.isArray(order) || !order.length) return chats.slice();
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const orderedIds = order.map((id) => String(id || '').trim()).filter(Boolean);
  const known = new Set(orderedIds);
  const next = [];
  const seen = new Set();
  chats.forEach((chat) => {
    if (!chat?.id || known.has(chat.id) || seen.has(chat.id)) return;
    next.push(chat);
    seen.add(chat.id);
  });
  orderedIds.forEach((id) => {
    if (seen.has(id)) return;
    const chat = byId.get(id);
    if (!chat) return;
    next.push(chat);
    seen.add(id);
  });
  return next;
}

/**
 * Replace the ids that belong to one visible list, keeping other ids in place.
 *
 * @param {string[]} previous
 * @param {string[]} listIds
 * @returns {string[]}
 */
export function mergeChatOrder(previous, listIds) {
  const seenList = new Set();
  const nextList = [];
  (Array.isArray(listIds) ? listIds : []).forEach((id) => {
    const value = String(id || '').trim();
    if (!value || seenList.has(value)) return;
    seenList.add(value);
    nextList.push(value);
  });
  const prev = [];
  const seenPrev = new Set();
  (Array.isArray(previous) ? previous : []).forEach((id) => {
    const value = String(id || '').trim();
    if (!value || seenPrev.has(value)) return;
    seenPrev.add(value);
    prev.push(value);
  });
  if (!nextList.length) return prev;
  const visible = new Set(nextList);
  const firstIdx = prev.findIndex((id) => visible.has(id));
  const withoutVisible = prev.filter((id) => !visible.has(id));
  if (firstIdx < 0) return [...nextList, ...withoutVisible];
  let insertAt = 0;
  for (let i = 0; i < firstIdx; i += 1) {
    if (!visible.has(prev[i])) insertAt += 1;
  }
  return [...withoutVisible.slice(0, insertAt), ...nextList, ...withoutVisible.slice(insertAt)];
}
