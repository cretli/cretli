import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
const CHAT_LAST_USED_KEY = 'cretli-chat-last-used';
const CHAT_ACTIVITY_KEY = 'cretli-chat-activity';
const CHAT_DRAFT_LOCALSTORAGE_PREFIX = 'cretli-chat-draft-';
const CHAT_DELETE_CONFIRM_SKIP_KEY = 'cretli-chat-delete-skip-confirm';

function readObjectMap(key) {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = readStorageValueWithAlias(localStorage, key, '');
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_) {
    return {};
  }
}

export function readChatLastUsedMap() {
  return readObjectMap(CHAT_LAST_USED_KEY);
}

export function getChatLastUsedAt(chatId) {
  if (!chatId) return 0;
  const value = readChatLastUsedMap()[chatId];
  return typeof value === 'number' && value > 0 ? value : 0;
}

export function recordChatLastUsed(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return;
  try {
    const map = readChatLastUsedMap();
    map[chatId] = Date.now();
    writeStorageValueWithAlias(localStorage, CHAT_LAST_USED_KEY, JSON.stringify(map));
  } catch (_) {}
}

export function readChatActivityMap() {
  return readObjectMap(CHAT_ACTIVITY_KEY);
}

export function getChatActivityAt(chat, getChatLastUsedAtFn = getChatLastUsedAt) {
  if (!chat?.id) return 0;
  const persisted = readChatActivityMap()[chat.id];
  const persistedAt = typeof persisted === 'number' && persisted > 0 ? persisted : 0;
  const usedAt = getChatLastUsedAtFn(chat.id);
  const outputAt = typeof chat._lastOutputAt === 'number' ? chat._lastOutputAt : 0;
  return Math.max(persistedAt, usedAt, outputAt);
}

export function recordChatActivity(chatId) {
  if (!chatId || typeof localStorage === 'undefined') return;
  try {
    const map = readChatActivityMap();
    map[chatId] = Date.now();
    writeStorageValueWithAlias(localStorage, CHAT_ACTIVITY_KEY, JSON.stringify(map));
  } catch (_) {}
}

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

