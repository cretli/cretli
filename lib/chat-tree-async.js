/**
 * Server-only async tree reads over the chats facade. Lives apart from `chat-tree.js` because that module is
 * bundled into the browser and must not import persistence code.
 */

import { pageChatsAsync } from './persist/chats-persist.js';

/**
 * Async, facade-backed tree read: walks `pageChats(archived=tree)` of the ACTIVE chats runtime, so it works on the
 * legacy and the SQLite backend alike. Returns the live rows of the scope plus their archived ancestors.
 *
 * @param {{ scope?: Record<string, any>, pageSize?: number }} [options]
 * @returns {Promise<{ chats: Record<string, any>[], ancestors: Record<string, any>[], revision: string }>}
 */
export async function readChatTreeAsync(options = {}) {
  const chats = [];
  const ancestors = new Map();
  let cursor = '';
  let revision = '';
  do {
    const result = await pageChatsAsync({ scope: options.scope, archived: 'tree', limit: options.pageSize || 500, cursor });
    chats.push(...(result.items || []));
    for (const ancestor of result.ancestors || []) ancestors.set(ancestor.id, ancestor);
    revision = String(result.revision ?? revision);
    cursor = result.nextCursor || '';
  } while (cursor);
  return { chats, ancestors: [...ancestors.values()], revision };
}

/**
 * Async counterpart of {@link collectArchivedAncestorIds}, served by the chats facade.
 *
 * @param {{ scope?: Record<string, any> }} [options]
 * @returns {Promise<Set<string>>}
 */
export async function collectArchivedAncestorIdsAsync(options = {}) {
  const { ancestors } = await readChatTreeAsync(options);
  return new Set(ancestors.map((chat) => chat.id));
}
