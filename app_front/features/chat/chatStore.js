import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import { getChatActivityStore } from './chatActivityStore.js';
const CHAT_DRAFT_LOCALSTORAGE_PREFIX = 'cretli-chat-draft-';
const CHAT_DELETE_CONFIRM_SKIP_KEY = 'cretli-chat-delete-skip-confirm';

/**
 * Task 2.1: activity/last-used live in a RAM store (see chatActivityStore.js).
 * These accessors are the compatibility surface used by the sorter, the
 * background policy and the runtime; they never touch storage after the
 * one-time legacy hydration, so the boot-cache comparator and the renderer stay
 * storage-free.
 */

export function readChatLastUsedMap() {
  return getChatActivityStore().snapshotLastUsed();
}

export function getChatLastUsedAt(chatId) {
  if (!chatId) return 0;
  return getChatActivityStore().getLastUsedAt(chatId);
}

export function recordChatLastUsed(chatId) {
  if (!chatId) return;
  getChatActivityStore().recordLastUsed(chatId);
}

export function readChatActivityMap() {
  return getChatActivityStore().snapshotActivity();
}

export function getChatActivityAt(chat, getChatLastUsedAtFn = getChatLastUsedAt) {
  if (!chat?.id) return 0;
  const persistedAt = getChatActivityStore().getActivityAt(chat.id);
  const usedAt = getChatLastUsedAtFn(chat.id);
  const outputAt = typeof chat._lastOutputAt === 'number' ? chat._lastOutputAt : 0;
  return Math.max(persistedAt, usedAt, outputAt);
}

export function recordChatActivity(chatId) {
  if (!chatId) return;
  getChatActivityStore().recordActivity(chatId);
}

export {
  getChatActivityStore,
  mergeChatActivity,
  mergeChatLastUsed,
  pruneChatActivityToKnownIds,
  resetChatActivitySession,
  subscribeChatActivity,
} from './chatActivityStore.js';

export function clearChatLocalData(id) {
  if (!id || typeof localStorage === 'undefined') return;
  try {
    removeStorageValueWithAlias(localStorage, CHAT_DRAFT_LOCALSTORAGE_PREFIX + id);
  } catch (_) {}
}

export function readChatDraft(id) {
  if (!id || typeof localStorage === 'undefined') return '';
  try {
    return readStorageValueWithAlias(localStorage, CHAT_DRAFT_LOCALSTORAGE_PREFIX + id, '');
  } catch (_) {
    return '';
  }
}

export function writeChatDraft(id, value) {
  if (!id || typeof localStorage === 'undefined') return;
  const normalized = typeof value === 'string' ? value : '';
  try {
    if (!normalized) {
      removeStorageValueWithAlias(localStorage, CHAT_DRAFT_LOCALSTORAGE_PREFIX + id);
      return;
    }
    writeStorageValueWithAlias(localStorage, CHAT_DRAFT_LOCALSTORAGE_PREFIX + id, normalized);
  } catch (_) {}
}

export function getSkipChatDeleteConfirm() {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, CHAT_DELETE_CONFIRM_SKIP_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

export function setSkipChatDeleteConfirm(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, CHAT_DELETE_CONFIRM_SKIP_KEY, value ? '1' : '0');
  } catch (_) {}
}

export function getResizeColsRows(cols, rows) {
  return {
    cols: Math.max(2, cols || 2),
    rows: Math.max(2, rows || 2),
  };
}

