/**
 * Mixed-phase shim (ADR docs/storage-chats-metadata-decision.md, leaf B2-B4; deleted in B5).
 *
 * Converted modules expose `*Async` APIs that read through the active chats runtime. A few of their synchronous
 * entry points still have callers in not-yet-converted groups (delegation, workspace watcher, SDK harness) that cannot
 * await. Those entry points read the row through this shim, which is the ONLY place outside `chats-persist.js` that
 * touches the synchronous chats exports on behalf of converted groups. On a non-legacy runtime the underlying sync
 * API throws `chats_sync_api_unavailable`, so a sqlite runtime can never be served by it silently.
 *
 * Converted callers must use the `*Async` functions; only a signature that has to stay synchronous for an unconverted
 * caller may call these.
 */
import { getChatById, getChatByCursorSessionId, peekChats } from './chats-persist.js';

/** @param {string} id @returns {Record<string, any> | null} */
export const getChatByIdCompat = (id) => getChatById(id);
/** @param {string} sessionKey @returns {Record<string, any> | null} */
export const getChatByCursorSessionIdCompat = (sessionKey) => getChatByCursorSessionId(sessionKey);
/** @returns {ReadonlyArray<Record<string, any>>} */
export const peekChatsCompat = () => peekChats();
