/**
 * Auth session boundary — order: invalidate queue, rotate RAM session, clear metadata IDB,
 * then drop legacy localStorage boot snapshot (task 5.1).
 *
 * Must run before persistence queue flush and activity hydration on logout / 401.
 */

import { invalidateChatPersistenceQueue } from './chatPersistenceQueue.js';
import { resetChatActivitySession } from './chatActivityStore.js';
import { clearChatLocalBootCache } from './chatLocalBootCache.js';
import { clearChatLocalBootSync } from './chatLocalBootSync.js';
import { getChatBootListHydrationController } from './chatLocalBootAsyncHydrate.js';
import {
  clearChatMetadataDbContents,
  invalidateChatMetadataIdbSession,
  setChatMetadataIdbSessionScope,
} from './chatMetadataIdb.js';

/** @type {() => void} */
let listLoadFreshnessInvalidateHook = () => {};

/**
 * Register chat list freshness + archive catalog invalidation on auth boundary.
 *
 * @param {() => void} hook
 */
export function registerChatSessionBoundaryListFreshnessHook(hook) {
  listLoadFreshnessInvalidateHook = typeof hook === 'function' ? hook : () => {};
}

/**
 * @param {{
 *   reason?: string,
 *   persistActivity?: boolean,
 *   storage?: Storage | null,
 *   idb?: () => (IDBFactory | null),
 * }} [options]
 * @returns {Promise<{ sessionId: string, generation: number, reason: string }>}
 */
export async function applyChatAuthSessionBoundary(options = {}) {
  const reason = typeof options.reason === 'string' ? options.reason : '';
  const persist = options.persistActivity !== false;
  invalidateChatPersistenceQueue({ clearBootRevision: true });
  await invalidateChatMetadataIdbSession(reason);
  const reset = resetChatActivitySession({ persist, reason });
  setChatMetadataIdbSessionScope({ sessionId: reset.sessionId, generation: reset.generation });
  getChatBootListHydrationController().setSessionScope({
    sessionId: reset.sessionId,
    generation: reset.generation,
  });
  const storage = options.storage === undefined
    ? (typeof localStorage !== 'undefined' ? localStorage : null)
    : options.storage;
  clearChatLocalBootCache(storage);
  clearChatLocalBootSync(storage);
  getChatBootListHydrationController().cancel();
  try {
    listLoadFreshnessInvalidateHook();
  } catch (_) {}
  await clearChatMetadataDbContents({ idb: options.idb });
  return reset;
}
