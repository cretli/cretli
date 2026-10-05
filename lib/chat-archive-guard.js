/**
 * Refuse to archive a chat while it, or any fork descendant, still has a live run.
 * Registers itself on the chat store so every `updateChat({ archived: true })`
 * path (HTTP, MCP, watcher) shares one gate.
 */

import { probeChatRunLiveness } from './chat-run-service.js';
import { collectForkSubtreeIds } from './chat-tree.js';
import { setChatArchiveRejector } from './persist/chats-persist.js';

/**
 * First chat id in the fork subtree whose adapter reports a live run.
 * Unknown liveness (no room, missing adapter) is not "in progress".
 *
 * @param {object[]} chats
 * @param {string} rootId
 * @returns {string}
 */
export function findBusyArchiveChatId(chats, rootId) {
  const ids = collectForkSubtreeIds(chats, rootId);
  const byId = new Map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const id = String(chat?.id || '').trim();
    if (id) byId.set(id, chat);
  }
  for (const id of ids) {
    const chat = byId.get(id);
    if (!chat) continue;
    const live = probeChatRunLiveness({ chatId: id, chat });
    if (live.known === true && live.busy === true) return id;
  }
  return '';
}

/**
 * @param {object[]} chats
 * @param {string} rootId
 * @returns {void}
 */
export function assertChatArchiveAllowed(chats, rootId) {
  const busyId = findBusyArchiveChatId(chats, rootId);
  if (!busyId) return;
  const error = new Error('Cannot archive a chat that is in progress or has a child in progress.');
  error.code = 'CHAT_ARCHIVE_BUSY';
  error.chatId = busyId;
  throw error;
}

setChatArchiveRejector(assertChatArchiveAllowed);
