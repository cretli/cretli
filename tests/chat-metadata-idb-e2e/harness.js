/**
 * Playwright harness for real IndexedDB (task 5.1).
 */
import {
  CHAT_METADATA_IDB_NAME,
  CHAT_METADATA_IDB_VERSION,
  CHAT_METADATA_STORE_CHATS,
  CHAT_METADATA_STORE_META,
} from '../../app_front/features/chat/chatMetadataIdbSchema.js';
import {
  __resetChatMetadataIdbForTest,
  __testAbortMetadataWriteTransaction,
  __testOpenChatMetadataDatabase,
  clearChatMetadataDbContents,
  getChatMetadataDb,
  getChatMetadataIdbOperationEpoch,
  getChatMetadataIdbStatus,
  getChatMetadataKv,
  invalidateChatMetadataIdbSession,
  listChatMetadataChatRecords,
  putChatMetadataChatRecord,
  putChatMetadataKv,
  setChatMetadataIdbSessionScope,
} from '../../app_front/features/chat/chatMetadataIdb.js';
import { applyChatAuthSessionBoundary } from '../../app_front/features/chat/chatSessionBoundary.js';

const SDK_DB = 'cretli-sdk-chat';

/** @type {{ sessionId: string, generation: number }} */
let harnessScope = { sessionId: 'harness-a', generation: 1 };

function applyHarnessScope() {
  setChatMetadataIdbSessionScope(harnessScope);
}

async function seedSdkDbMarker() {
  return new Promise((resolve) => {
    const req = indexedDB.open(SDK_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('history')) {
        db.createObjectStore('history');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('history', 'readwrite');
      tx.objectStore('history').put({ events: [{ t: 'sdk-seed' }] }, 'probe-chat');
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => resolve(false);
    };
    req.onerror = () => resolve(false);
  });
}

async function readSdkProbe() {
  return new Promise((resolve) => {
    const req = indexedDB.open(SDK_DB, 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('history', 'readonly');
      const getReq = tx.objectStore('history').get('probe-chat');
      getReq.onsuccess = () => {
        db.close();
        resolve(getReq.result || null);
      };
      getReq.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

async function deleteMetadataDb() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(CHAT_METADATA_IDB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}

window.__chatMetadataIdb = {
  ready: false,
  async resetHarness() {
    __resetChatMetadataIdbForTest();
    await deleteMetadataDb();
    await seedSdkDbMarker();
    harnessScope = { sessionId: 'harness-a', generation: 1 };
    applyHarnessScope();
  },
  async putChat(chat) {
    applyHarnessScope();
    return putChatMetadataChatRecord(chat, harnessScope);
  },
  async listChats() {
    applyHarnessScope();
    return listChatMetadataChatRecords(harnessScope);
  },
  async putKv(key, value) {
    applyHarnessScope();
    return putChatMetadataKv(key, value, harnessScope);
  },
  async clearBoundary() {
    applyHarnessScope();
    await applyChatAuthSessionBoundary({ reason: 'harness-logout', idb: () => indexedDB });
    harnessScope = { sessionId: 'harness-b', generation: 2 };
    applyHarnessScope();
  },
  sdkProbe: () => readSdkProbe(),
  status: () => getChatMetadataIdbStatus(),
  epoch: () => getChatMetadataIdbOperationEpoch(),
  async openDb() {
    return Boolean(await getChatMetadataDb({ idb: () => indexedDB }));
  },
  async simulateVersionChange() {
    await __testOpenChatMetadataDatabase({ idb: () => indexedDB }, CHAT_METADATA_IDB_VERSION + 1);
    return getChatMetadataIdbStatus();
  },
  async simulateModuleAbortTransaction() {
    applyHarnessScope();
    return __testAbortMetadataWriteTransaction({ idb: () => indexedDB });
  },
  async holdExtraLegacyConnection() {
    if (window.__chatMetadataExtraHold?.close) {
      try {
        window.__chatMetadataExtraHold.close();
      } catch (_) {
        /* ignore */
      }
    }
    window.__chatMetadataExtraHold = await new Promise((resolve, reject) => {
      const req = indexedDB.open(CHAT_METADATA_IDB_NAME, CHAT_METADATA_IDB_VERSION);
      req.onerror = () => reject(new Error('hold-failed'));
      req.onsuccess = () => resolve(req.result);
    });
    return true;
  },
  async attemptUpgradeOpenWhilePeerConnected() {
    await getChatMetadataDb({ idb: () => indexedDB });
    await window.__chatMetadataIdb.holdExtraLegacyConnection();
    /** @type {string | null} */
    let statusAtBlocked = null;
    await __testOpenChatMetadataDatabase({
      idb: () => indexedDB,
      onBlocked: () => {
        statusAtBlocked = getChatMetadataIdbStatus();
      },
    }, CHAT_METADATA_IDB_VERSION + 1);
    return statusAtBlocked ?? getChatMetadataIdbStatus();
  },
  async getRawMetaKey(key) {
    const db = await getChatMetadataDb({ idb: () => indexedDB });
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(CHAT_METADATA_STORE_META, 'readonly');
      const req = tx.objectStore(CHAT_METADATA_STORE_META).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  },
  async countAllChatRowsUnfiltered() {
    const db = await getChatMetadataDb({ idb: () => indexedDB });
    if (!db) return 0;
    return new Promise((resolve) => {
      let count = 0;
      const tx = db.transaction(CHAT_METADATA_STORE_CHATS, 'readonly');
      const req = tx.objectStore(CHAT_METADATA_STORE_CHATS).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(count);
          return;
        }
        count += 1;
        cursor.continue();
      };
      req.onerror = () => resolve(count);
    });
  },
  async invalidateMidWrite() {
    applyHarnessScope();
    const write = putChatMetadataKv('mid-write', 'payload-old', harnessScope);
    await applyChatAuthSessionBoundary({ reason: 'mid-logout', idb: () => indexedDB });
    harnessScope = { sessionId: 'harness-b', generation: 3 };
    applyHarnessScope();
    await write;
    const rawKv = await window.__chatMetadataIdb.getRawMetaKey('mid-write');
    const staleKvRead = await getChatMetadataKv('mid-write', harnessScope, { idb: () => indexedDB });
    const rowCount = await window.__chatMetadataIdb.countAllChatRowsUnfiltered();
    return {
      rawKv,
      staleKvRead,
      rowCount,
      status: getChatMetadataIdbStatus(),
    };
  },
  async staleReadAfterEpochBump() {
    applyHarnessScope();
    await putChatMetadataKv('epoch-key', 'before', harnessScope);
    const scopeSnapshot = { ...harnessScope };
    const readPromise = getChatMetadataKv('epoch-key', scopeSnapshot, { idb: () => indexedDB });
    await invalidateChatMetadataIdbSession('epoch-test');
    harnessScope = { sessionId: 'harness-c', generation: 4 };
    applyHarnessScope();
    const value = await readPromise;
    return { value, status: getChatMetadataIdbStatus() };
  },
  async clearContentsOnly() {
    return clearChatMetadataDbContents({ idb: () => indexedDB });
  },
};

const skipHarnessReset = new URLSearchParams(window.location.search).get('norest') === '1';
if (skipHarnessReset) {
  applyHarnessScope();
  window.__chatMetadataIdb.ready = true;
} else {
  window.__chatMetadataIdb.resetHarness().then(() => {
    window.__chatMetadataIdb.ready = true;
  });
}
