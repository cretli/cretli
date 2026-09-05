/**
 * Sidebar chat tree: one visible nesting level under a folder root.
 * Forks and manually nested chats share `forkParentChatId`.
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
 * @param {object[]} chats
 * @param {object} chat
 * @returns {string}
 */
function resolveFolderRootId(chats, chat) {
  if (!chat) return '';
  const byId = new Map(chats.map((entry) => [entry.id, entry]));
  let current = chat;
  const visited = new Set([chat.id]);
  while (current) {
    const parentId = readForkParentChatId(current);
    if (!parentId || parentId === current.id || visited.has(parentId)) break;
    const parent = byId.get(parentId);
    if (!parent) break;
    visited.add(parentId);
    current = parent;
  }
  return current?.id || '';
}

/**
 * Roots in input order, then each root's descendants (any depth) as level-1
 * children in input order.
 *
 * @param {object[]} chats
 * @returns {{ chat: object, level: number, isLastChild: boolean }[]}
 */
export function flattenChatsTree(chats) {
  if (!Array.isArray(chats) || !chats.length) return [];
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const childrenByRoot = new Map();
  const roots = [];

  chats.forEach((chat) => {
    const parentId = readForkParentChatId(chat);
    if (!parentId || parentId === chat.id || !byId.has(parentId)) {
      roots.push(chat);
      return;
    }
    const rootId = resolveFolderRootId(chats, byId.get(parentId)) || parentId;
    const list = childrenByRoot.get(rootId) || [];
    list.push(chat);
    childrenByRoot.set(rootId, list);
  });

  const linear = [];
  roots.forEach((chat) => {
    linear.push({ chat, level: 0, isLastChild: false });
    const children = childrenByRoot.get(chat.id);
    if (!children?.length) return;
    children.forEach((child, idx) => {
      linear.push({ chat: child, level: 1, isLastChild: idx === children.length - 1 });
    });
  });
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
