/**
 * Moves chat history and chat buffers out of localStorage into IndexedDB.
 *
 * Older builds mirrored both into localStorage, which shares a ~5MB quota with every other
 * key (theme, drafts, sync cursors), so a couple of long chats were enough to exhaust it.
 */

import { CHAT_BUFFER_LOCALSTORAGE_PREFIX } from '../config.js';
import { appLogger } from '../logger.js';
import { migrateChatBuffersOutOfLocalStorage } from './chatBufferStore.js';
import { migrateSdkChatHistoryOutOfLocalStorage } from './sdk-chat-history-store.js';

let didRun = false;

/**
 * Runs once per page load, after the chat list is known — ids are needed to tell a live chat
 * (migrate its doc) from a deleted one (just drop the key).
 *
 * @param {string[]} chatIds
 * @returns {Promise<void>}
 */
export async function migrateChatStorageOutOfLocalStorage(chatIds) {
  if (didRun) return;
  const ids = Array.isArray(chatIds) ? chatIds.filter((id) => typeof id === 'string' && id) : [];
  if (ids.length === 0) return;
  didRun = true;
  const [history, buffers] = await Promise.all([
    migrateSdkChatHistoryOutOfLocalStorage(ids),
    migrateChatBuffersOutOfLocalStorage(CHAT_BUFFER_LOCALSTORAGE_PREFIX, ids),
  ]);
  const removedKeys = history.removedKeys + buffers.removedKeys;
  if (removedKeys === 0) return;
  appLogger.log('chat-storage', 'localStorage chat data moved to IndexedDB', {
    removedKeys,
    freedKb: Math.round(((history.freedChars + buffers.freedChars) * 2) / 1024),
    historyKeys: history.removedKeys,
    bufferKeys: buffers.removedKeys,
  });
}
