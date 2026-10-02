/**
 * Reads push inbox records written by the Service Worker while the app was closed.
 */

import {
  PUSH_INBOX_DB_NAME,
  PUSH_INBOX_STORE_NAME,
  PUSH_INBOX_STATE_MAX_AGE_MS,
  clipPushInboxSnippet,
  resolvePushInboxRecordDeviceTime,
  shouldApplyPushInboxPresenceRecord,
  shouldSyncChatHistoryFromPushInbox,
} from '../../../lib/push-inbox-logic.js';
import { agentRunStateDedupeKey } from '../chat/chatHistorySyncPoll.js';

export { PUSH_INBOX_DB_NAME, shouldSyncChatHistoryFromPushInbox };

/**
 * Reads every pending record WITHOUT clearing it. Records are deleted only after
 * they were applied, or once they are too old to matter — a record whose chat is
 * not in the list yet must survive until a later reconcile (first open without a
 * boot cache, or a chat created on another device).
 *
 * @returns {Promise<object[]>}
 */
export function readPushInbox() {
  if (typeof indexedDB === 'undefined') return Promise.resolve([]);
  return new Promise((resolve) => {
    let db;
    const finish = (records) => {
      try {
        db?.close();
      } catch (_) {}
      resolve(Array.isArray(records) ? records : []);
    };
    const request = indexedDB.open(PUSH_INBOX_DB_NAME, 1);
    request.onerror = () => finish([]);
    request.onupgradeneeded = () => {
      const nextDb = request.result;
      if (!nextDb.objectStoreNames.contains(PUSH_INBOX_STORE_NAME)) {
        nextDb.createObjectStore(PUSH_INBOX_STORE_NAME, { keyPath: 'chatId' });
      }
    };
    request.onsuccess = () => {
      db = request.result;
      const tx = db.transaction(PUSH_INBOX_STORE_NAME, 'readonly');
      const store = tx.objectStore(PUSH_INBOX_STORE_NAME);
      const readReq = store.getAll();
      readReq.onerror = () => finish([]);
      readReq.onsuccess = () => finish(readReq.result);
    };
  });
}

/**
 * Pure delete decision: only remove the stored record when its `at` still
 * matches the value the caller read. A newer record written by the Service
 * Worker in the meantime must survive.
 *
 * A missing expected value keeps the legacy unconditional delete.
 *
 * @param {object | null | undefined} storedRecord
 * @param {unknown} expectedAt
 * @returns {boolean}
 */
export function shouldDeletePushInboxRecord(storedRecord, expectedAt) {
  if (!storedRecord || typeof storedRecord !== 'object') return false;
  const expected = Number(expectedAt);
  if (!Number.isFinite(expected)) return true;
  return (Number(storedRecord.at) || 0) === expected;
}

/**
 * @param {unknown} value
 * @returns {Map<string, number>}
 */
function normalizeExpectedDeleteTimes(value) {
  const map = new Map();
  if (value instanceof Map) {
    for (const [id, at] of value) {
      const key = String(id || '').trim();
      if (key) map.set(key, Number(at));
    }
    return map;
  }
  if (value && typeof value === 'object') {
    for (const [id, at] of Object.entries(value)) {
      const key = String(id || '').trim();
      if (key) map.set(key, Number(at));
    }
  }
  return map;
}

/**
 * Deletes the given chatId-keyed records. When `expectedAtByChatId` carries the
 * `at` that was read for a chat, the stored record is re-read and deleted only
 * if it still has the same `at` (get + delete inside one readwrite transaction).
 * Missing keys are a no-op.
 *
 * @param {string[]} chatIds
 * @param {Map<string, number> | Record<string, number>} [expectedAtByChatId]
 * @returns {Promise<void>}
 */
export function deletePushInboxRecords(chatIds, expectedAtByChatId) {
  const ids = Array.isArray(chatIds)
    ? [...new Set(chatIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  if (ids.length === 0 || typeof indexedDB === 'undefined') return Promise.resolve();
  const expectedTimes = normalizeExpectedDeleteTimes(expectedAtByChatId);
  return new Promise((resolve) => {
    let db;
    const finish = () => {
      try {
        db?.close();
      } catch (_) {}
      resolve();
    };
    const request = indexedDB.open(PUSH_INBOX_DB_NAME, 1);
    request.onerror = () => finish();
    request.onupgradeneeded = () => {
      const nextDb = request.result;
      if (!nextDb.objectStoreNames.contains(PUSH_INBOX_STORE_NAME)) {
        nextDb.createObjectStore(PUSH_INBOX_STORE_NAME, { keyPath: 'chatId' });
      }
    };
    request.onsuccess = () => {
      db = request.result;
      const tx = db.transaction(PUSH_INBOX_STORE_NAME, 'readwrite');
      const store = tx.objectStore(PUSH_INBOX_STORE_NAME);
      for (const id of ids) {
        const expectedAt = expectedTimes.has(id) ? expectedTimes.get(id) : undefined;
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          if (shouldDeletePushInboxRecord(getReq.result, expectedAt)) store.delete(id);
        };
      }
      tx.oncomplete = () => finish();
      tx.onerror = () => finish();
      tx.onabort = () => finish();
    };
  });
}

/**
 * @returns {Promise<void>}
 */
export function clearPushInboxCache() {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(PUSH_INBOX_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch (_) {
      resolve();
    }
  });
}

/**
 * Build the in-memory sidebar preview patch for an `agent-finished` record.
 * Never persisted: only `_pushPreview` on the runtime chat row.
 *
 * @param {object} record
 * @param {number} [nowMs]
 * @returns {{ text: string, at: number } | null}
 */
export function buildPushPreviewPatch(record, nowMs = Date.now()) {
  if (String(record?.type || '').trim() !== 'agent-finished') return null;
  const text = clipPushInboxSnippet(record?.snippet);
  if (!text) return null;
  const at = resolvePushInboxRecordDeviceTime(record) || nowMs;
  return { text, at };
}

/**
 * Remove the transient push preview (history was synced or the chat opened).
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function clearPushPreview(chat) {
  if (!chat || typeof chat !== 'object' || !chat._pushPreview) return false;
  delete chat._pushPreview;
  return true;
}

/**
 * Caller must have already passed `shouldApplyPushInboxPresenceRecord`.
 *
 * @param {object} chat
 * @param {object} record
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function applyPushInboxPresenceRecordToChat(chat, record, nowMs = Date.now()) {
  const type = String(record?.type || '').trim();
  const at = resolvePushInboxRecordDeviceTime(record) || nowMs;
  let next = /** @type {object | null} */ (null);
  if (type === 'agent-finished') {
    next = null;
  } else if (type === 'agent-needs-input') {
    next = {
      state: 'waiting',
      attention: true,
      delegationId: '',
      runId: '',
      waitingAgentCount: 0,
    };
  } else {
    return false;
  }
  if (agentRunStateDedupeKey(chat._serverRunState) === agentRunStateDedupeKey(next)) return false;
  chat._serverRunState = next;
  // Never write `_serverRunStateAt`: that watermark belongs to authoritative
  // server/WS presence. The inbox uses its own device clock so a server snapshot
  // can always override a push record.
  chat._inboxRunStateAt = at;
  return true;
}

/**
 * @param {object[]} chats
 * @param {object[]} records
 * @param {(chatId: string) => number} [getLastAckedSeq]
 * @param {number} [nowMs]
 * @returns {{
 *   dirtyIds: string[],
 *   syncChatIds: string[],
 *   previewIds: string[],
 *   changed: boolean,
 *   appliedIds: string[],
 *   ignoredIds: string[],
 *   expiredIds: string[],
 * }}
 */
export function applyPushInboxRecordsToChats(chats, records, getLastAckedSeq = () => 0, nowMs = Date.now()) {
  const list = Array.isArray(chats) ? chats : [];
  const rows = Array.isArray(records) ? records : [];
  if (rows.length === 0) {
    return {
      dirtyIds: [],
      syncChatIds: [],
      previewIds: [],
      changed: false,
      appliedIds: [],
      ignoredIds: [],
      expiredIds: [],
    };
  }
  const byId = new Map(list.map((chat) => [chat.id, chat]));
  const syncChatIds = [];
  const dirtyIds = [];
  const previewIds = [];
  const appliedIds = [];
  const ignoredIds = [];
  const expiredIds = [];

  for (const record of rows) {
    const chatId = String(record?.chatId || '').trim();
    if (!chatId) continue;
    // Freshness uses the device clock (`receivedAt`, `at` only for legacy),
    // never the server `at`, so it is comparable with `_serverRunStateAt`.
    const ageAt = resolvePushInboxRecordDeviceTime(record);
    const expired = ageAt > 0 && nowMs - ageAt > PUSH_INBOX_STATE_MAX_AGE_MS;
    const chat = byId.get(chatId);
    if (!chat) {
      // The chat may not exist on this device yet. Keep the record so a later
      // reconcile (after loadChatsFromServer) can apply it; only drop it once it
      // is too old to be trusted.
      if (expired) expiredIds.push(chatId);
      continue;
    }
    // headSeq is a delta-sync watermark and has no age limit: a late delta is
    // still safe to request, even from an otherwise expired presence record.
    const headSeq = Number(record?.headSeq);
    const shouldSyncHeadSeq = shouldSyncChatHistoryFromPushInbox(headSeq, getLastAckedSeq(chatId));
    if (shouldSyncHeadSeq) {
      chat._pendingRemoteHistory = true;
      syncChatIds.push(chatId);
    }
    if (expired) {
      // Delete but never apply the stale presence patch.
      expiredIds.push(chatId);
      continue;
    }
    const presenceEligible = shouldApplyPushInboxPresenceRecord(record, chat, nowMs);
    if (presenceEligible && applyPushInboxPresenceRecordToChat(chat, record, nowMs)) {
      dirtyIds.push(chatId);
    }
    if (presenceEligible || shouldSyncHeadSeq) {
      // The record produced a real effect (or a delta request): delete after use.
      const preview = buildPushPreviewPatch(record, nowMs);
      if (preview) {
        chat._pushPreview = preview;
        previewIds.push(chatId);
      }
      appliedIds.push(chatId);
    } else {
      // Rejected by the watermark: safe to delete, but it is NOT an applied
      // change, so it must not trigger a server refresh.
      ignoredIds.push(chatId);
    }
  }

  return {
    dirtyIds: [...new Set(dirtyIds)],
    syncChatIds: [...new Set(syncChatIds)],
    previewIds: [...new Set(previewIds)],
    changed: dirtyIds.length > 0 || previewIds.length > 0,
    appliedIds: [...new Set(appliedIds)],
    ignoredIds: [...new Set(ignoredIds)],
    expiredIds: [...new Set(expiredIds)],
  };
}

/**
 * @param {{
 *   getChats: () => object[],
 *   getLastAckedSeq: (chatId: string) => number,
 *   syncChatHistoryDelta: (chat: object) => Promise<unknown>,
 *   syncActiveChatHistory?: (chat: object) => Promise<unknown>,
 *   getActiveChatId?: () => string,
 *   renderChatList?: () => void,
 *   refreshFromServer?: () => Promise<unknown>,
 *   refreshAgentStates?: () => Promise<unknown>,
 *   readRecords?: () => Promise<object[]>,
 *   deleteRecords?: (chatIds: string[], expectedAtByChatId?: Map<string, number>) => Promise<unknown>,
 *   logger?: { log?: (tag: string, message: string, payload?: object) => void },
 * }} deps
 * @returns {Promise<void>}
 */
export async function consumePushInbox(deps) {
  const readRecords = typeof deps.readRecords === 'function' ? deps.readRecords : readPushInbox;
  const deleteRecords = typeof deps.deleteRecords === 'function'
    ? deps.deleteRecords
    : deletePushInboxRecords;
  const records = await readRecords();
  if (records.length === 0) return;
  const chats = deps.getChats();
  const applied = applyPushInboxRecordsToChats(chats, records, deps.getLastAckedSeq);
  // Delete what was applied, aged out, or safely ignored (watermark-rejected).
  // Records for chats that are not in the list yet stay for the post-refresh
  // reconcile. Each delete carries the `at` that was read so a newer record
  // written by the Service Worker in the meantime survives.
  const expectedAtByChatId = new Map();
  for (const record of records) {
    const id = String(record?.chatId || '').trim();
    if (id && !expectedAtByChatId.has(id)) expectedAtByChatId.set(id, Number(record?.at));
  }
  const idsToDelete = [...new Set([...applied.appliedIds, ...applied.ignoredIds, ...applied.expiredIds])];
  if (idsToDelete.length > 0) {
    try {
      await deleteRecords(idsToDelete, expectedAtByChatId);
    } catch (error) {
      deps.logger?.log?.('push-inbox', 'record delete failed', { error: String(error) });
    }
  }
  if ((applied.changed || applied.syncChatIds.length > 0)
    && typeof deps.renderChatList === 'function') {
    deps.renderChatList();
  }
  const activeChatId = typeof deps.getActiveChatId === 'function' ? deps.getActiveChatId() : '';
  for (const chatId of applied.syncChatIds) {
    const chat = chats.find((row) => row.id === chatId);
    if (!chat) continue;
    const record = records.find((row) => String(row?.chatId || '').trim() === chatId);
    if (!shouldSyncChatHistoryFromPushInbox(record?.headSeq, deps.getLastAckedSeq(chatId))) continue;
    try {
      if (chatId === activeChatId && typeof deps.syncActiveChatHistory === 'function') {
        await deps.syncActiveChatHistory(chat);
      } else {
        await deps.syncChatHistoryDelta(chat);
      }
      // History is authoritative now: the preview would be stale.
      clearPushPreview(chat);
    } catch (error) {
      deps.logger?.log?.('push-inbox', 'history sync failed', {
        chatId,
        error: String(error),
      });
    }
  }
  // A refresh is only meaningful when the inbox changed something; otherwise a
  // consume -> refreshFromServer -> consume chain would never settle.
  const didApply = applied.changed || applied.syncChatIds.length > 0;
  if (!didApply) return;
  // An inbox patch is a guess. Re-fetch authoritative state right after applying
  // it so a newer server snapshot overwrites the push record; loadChatsFromServer
  // alone does not refresh agent states.
  if (applied.changed && typeof deps.refreshAgentStates === 'function') {
    try {
      await deps.refreshAgentStates();
    } catch (error) {
      deps.logger?.log?.('push-inbox', 'agent-state refresh failed', { error: String(error) });
    }
  }
  if (typeof deps.refreshFromServer === 'function') {
    try {
      await deps.refreshFromServer();
    } catch (error) {
      deps.logger?.log?.('push-inbox', 'server refresh failed', { error: String(error) });
    }
  }
}

/**
 * @param {{
 *   consume: () => Promise<void>,
 * }} deps
 * @returns {() => void}
 */
export function initPushInboxResumeConsumer(deps) {
  const run = () => {
    void deps.consume().catch(() => {});
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      run();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pageshow', () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      run();
    });
  }
  return run;
}
