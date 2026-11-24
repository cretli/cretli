/**
 * Chat list persistence facade (SDK + OpenRouter harnesses).
 *
 * Every export is async: it goes through the active chats runtime (lib/persist/chats-runtime.js), which owns an
 * adapter - `chats-backend-legacy` (over the `chats.json` store in `chats-legacy-store.js`) or `chats-backend-sqlite`.
 * Naming rule and caller list: docs/storage-chats-b-caller-inventory.md. The synchronous `chats.json` code is no
 * longer exported from here (ADR docs/storage-chats-metadata-decision.md, leaf B5.4).
 */

import { createChatsRuntime, getActiveChatsRuntime } from './chats-runtime.js';
import { createLegacyChatsBackend } from './chats-backend-legacy.js';
import {
  loadChats, loadChatsSnapshot, peekChatsSnapshot, peekChats, peekChatsByIds, getChatById, getChatByCursorSessionId,
  saveChats, addChat, removeChat, deleteTemporaryForkChats, updateChat, markChatReadState, applyAutoTitle,
  setChatTitleLocked, setChatSessionField, rotateChatSdkSession, migrateChatWorkspaceIds, archiveChats,
} from './chats-legacy-store.js';

export {
  CHAT_TITLE_SOURCES,
  createFreshSdkContextEntry,
  DEFAULT_CHAT_TITLE_RE,
  inferChatTitleSource,
  onChatArchived,
  setChatArchiveRejector,
  withTitleSource,
} from './chats-backend-domain.js';

export { getChatsReadStats } from './chats-legacy-store.js';

/** @typedef {import('../shared-types/persist-records.js').ChatRecord} ChatRecord */

/**
 * Full server-side chat removal: the list entry plus any related data (chat history, title history, manifests,
 * Browser screenshots, media). Runs on the active chats runtime, so it is the same call on every adapter.
 *
 * The durable history delete runs FIRST: when it fails (typed adapter error, `details.retryToken` for an unknown
 * commit) the chat list entry and the other metadata are untouched, so the caller can retry with the same token and
 * nothing is orphaned. Once the history is gone, the remaining removals are local and idempotent.
 *
 * @param {string} id - chat id (uuid)
 * @param {{ retryToken?: string }} [options]
 */
export async function deleteChat(id, options = {}) {
  return getActiveChatsRuntime().api.deleteChatAsync(id, options);
}

// ---------------------------------------------------------------------------------------------------
// Async API (adapter-neutral). Convention: the same name with an `Async` suffix; see the caller inventory.
// ---------------------------------------------------------------------------------------------------

/**
 * Legacy adapter over the synchronous code of this file. It executes the sync body inside the async wrapper
 * (no await before it), so sync and async calls share one cache and are serialized by the event loop.
 */
export const legacyChatsBackend = createLegacyChatsBackend({
  loadChats, loadChatsSnapshot, peekChatsSnapshot, peekChats, peekChatsByIds, getChatById, getChatByCursorSessionId,
  saveChats, addChat, removeChat, deleteTemporaryForkChats, updateChat, markChatReadState, applyAutoTitle,
  setChatTitleLocked, setChatSessionField, rotateChatSdkSession, migrateChatWorkspaceIds, archiveChats,
});

// The default (and, until B5, only production) runtime.
getActiveChatsRuntime.installDefault(() => createChatsRuntime({ backend: legacyChatsBackend, backendKind: 'legacy' }));

/** @param {string} name */
const viaRuntime = (name) => (...args) => getActiveChatsRuntime().api[name](...args);

export const loadChatsAsync = viaRuntime('loadChatsAsync');
export const loadChatsSnapshotAsync = viaRuntime('loadChatsSnapshotAsync');
export const peekChatsSnapshotAsync = viaRuntime('peekChatsSnapshotAsync');
export const pageChatsAsync = viaRuntime('pageChatsAsync');
export const chatCountsAsync = viaRuntime('chatCountsAsync');
export const peekChatsAsync = viaRuntime('peekChatsAsync');
export const peekChatsByIdsAsync = viaRuntime('peekChatsByIdsAsync');
export const getChatByIdAsync = viaRuntime('getChatByIdAsync');
export const getChatByCursorSessionIdAsync = viaRuntime('getChatByCursorSessionIdAsync');
export const saveChatsAsync = viaRuntime('saveChatsAsync');
export const addChatAsync = viaRuntime('addChatAsync');
export const createConversationForkChatAsync = viaRuntime('createConversationForkChatAsync');
export const createTemporaryForkChatAsync = viaRuntime('createTemporaryForkChatAsync');
export const deleteTemporaryForkChatsAsync = viaRuntime('deleteTemporaryForkChatsAsync');
export const removeChatAsync = viaRuntime('removeChatAsync');
export const deleteChatAsync = viaRuntime('deleteChatAsync');
export const updateChatAsync = viaRuntime('updateChatAsync');
export const archiveChatsAsync = viaRuntime('archiveChatsAsync');
export const markChatReadStateAsync = viaRuntime('markChatReadStateAsync');
export const applyAutoTitleAsync = viaRuntime('applyAutoTitleAsync');
export const setChatTitleLockedAsync = viaRuntime('setChatTitleLockedAsync');
export const setChatSdkAgentIdAsync = viaRuntime('setChatSdkAgentIdAsync');
export const setChatOpenCodeSessionIdAsync = viaRuntime('setChatOpenCodeSessionIdAsync');
export const setChatCodeBuddySessionIdAsync = viaRuntime('setChatCodeBuddySessionIdAsync');
export const setChatDeepSeekSessionIdAsync = viaRuntime('setChatDeepSeekSessionIdAsync');
export const setChatCodexThreadIdAsync = viaRuntime('setChatCodexThreadIdAsync');
export const setChatQwenSessionIdAsync = viaRuntime('setChatQwenSessionIdAsync');
export const setChatClaudeSessionIdAsync = viaRuntime('setChatClaudeSessionIdAsync');
export const rotateChatSdkSessionAsync = viaRuntime('rotateChatSdkSessionAsync');
export const migrateChatWorkspaceIdsAsync = viaRuntime('migrateChatWorkspaceIdsAsync');
export const importChatsBatchAsync = viaRuntime('importChatsBatchAsync');
export const readChatsStrictAsync = viaRuntime('readChatsStrictAsync');
export const rollbackImportedChatsAsync = viaRuntime('rollbackImportedChatsAsync');
