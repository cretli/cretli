/**
 * Persistent custom order for sidebar chats (drag & drop).
 */

import {
  readStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import { mergeChatOrder } from '../../../lib/chat-tree.js';

const SIDEBAR_CHAT_ORDER_KEY = 'cretli-sidebar-chat-order';

/**
 * @returns {string[]}
 */
export function readChatOrder() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = readStorageValueWithAlias(localStorage, SIDEBAR_CHAT_ORDER_KEY, '');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => String(id || '').trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * @param {string[]} ids
 * @returns {void}
 */
export function writeChatOrder(ids) {
  if (typeof localStorage === 'undefined' || !Array.isArray(ids)) return;
  const seen = new Set();
  const normalized = [];
  ids.forEach((id) => {
    const value = String(id || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    normalized.push(value);
  });
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_CHAT_ORDER_KEY, JSON.stringify(normalized));
  } catch (_) {}
}

/**
 * @param {string[]} listIds
 * @returns {void}
 */
export function writeChatOrderForList(listIds) {
  writeChatOrder(mergeChatOrder(readChatOrder(), listIds));
}

/**
 * @param {ParentNode | null | undefined} list
 * @returns {string[]}
 */
export function collectChatIdsFromList(list) {
  if (!list || typeof list.querySelectorAll !== 'function') return [];
  return Array.from(list.querySelectorAll('.sidebar-chat-item'))
    .map((li) => (li.dataset && li.dataset.chatId) || '')
    .filter((id) => id);
}
