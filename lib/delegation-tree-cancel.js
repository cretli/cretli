/**
 * Pure helpers for cancelling a delegation (sub)tree.
 *
 * The tree is linked through chats: a row's `parentChatId` is the executor
 * child chat of the row that delegated it. A subtree is therefore everything
 * reachable from `start.childChatId` by following `parentChatId`.
 */

import { resolveRecordTreeFields } from './delegation-tree.js';

/** Guard against corrupted parent/child cycles. */
const MAX_SUBTREE_WALK = 2000;

/**
 * Rows of the subtree under (and including) `start`, deepest first so that
 * descendants are always cancelled before their ancestors.
 *
 * @param {{ start: object | null, rows: object[] }} input
 * @returns {object[]}
 */
export function collectDelegationSubtreePostOrder(input) {
  const start = input?.start || null;
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  if (!start) return [];
  const byParentChat = new Map();
  for (const row of rows) {
    const key = String(row?.parentChatId || '').trim();
    if (!key) continue;
    if (!byParentChat.has(key)) byParentChat.set(key, []);
    byParentChat.get(key).push(row);
  }
  const seen = new Set([String(start.id)]);
  const order = [];
  let budget = MAX_SUBTREE_WALK;
  const visit = (node) => {
    const childChat = String(node?.childChatId || '').trim();
    for (const child of childChat ? byParentChat.get(childChat) || [] : []) {
      const id = String(child.id);
      if (seen.has(id) || budget <= 0) continue;
      seen.add(id);
      budget -= 1;
      visit(child);
    }
    order.push(node);
  };
  visit(start);
  return order;
}

/**
 * Whether `chatId` may cancel the subtree of `row`: only the chat that started
 * the row (its parent) or the root chat of its tree. A child never reaches an
 * ancestor (its own row is started by its parent) or a sibling branch.
 *
 * @param {object} row
 * @param {string} chatId
 * @returns {boolean}
 */
export function canChatCancelDelegationTree(row, chatId) {
  const chat = String(chatId || '').trim();
  if (!row || !chat) return false;
  if (String(row.parentChatId || '').trim() === chat) return true;
  return resolveRecordTreeFields(row).rootChatId === chat;
}
