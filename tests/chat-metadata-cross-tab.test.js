/**
 * Task 5.4 — cross-tab metadata notifications (BroadcastChannel + storage fallback).
 *
 * Run: node tests/chat-metadata-cross-tab.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_METADATA_CROSS_TAB_CHANNEL,
  CHAT_METADATA_CROSS_TAB_STORAGE_KEY,
  __resetChatMetadataCrossTabSyncForTest,
  createChatMetadataCrossTabSync,
  parseChatMetadataCrossTabMessage,
} from '../app_front/features/chat/chatMetadataCrossTab.js';
import {
  __resetChatActivityStoreForTest,
  createChatActivityStore,
} from '../app_front/features/chat/chatActivityStore.js';
import {
  chatIdbActivityEntryKey,
  createChatMetadataIdbPersistenceAdapter,
} from '../app_front/features/chat/chatPersistenceIdbAdapter.js';
import {
  __resetChatMetadataIdbForTest,
  __testOpenChatMetadataDatabase,
  getChatMetadataIdbOperationEpoch,
  putChatMetadataKv,
  setChatMetadataIdbSessionScope,
} from '../app_front/features/chat/chatMetadataIdb.js';
import { CHAT_METADATA_IDB_NAME, CHAT_METADATA_STORE_META } from '../app_front/features/chat/chatMetadataIdbSchema.js';
import { createChatPersistenceQueue } from '../app_front/features/chat/chatPersistenceQueue.js';
import { applyChatAuthSessionBoundary } from '../app_front/features/chat/chatSessionBoundary.js';
import { createMemoryPersistenceAdapter } from '../app_front/features/chat/chatPersistenceAdapter.js';

/** @type {Map<string, Set<FakeBroadcastChannel>>} */
const channelPeers = new Map();

class FakeBroadcastChannel {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    /** @type {((event: { data: unknown }) => void) | null} */
    this.onmessage = null;
    if (!channelPeers.has(name)) channelPeers.set(name, new Set());
    channelPeers.get(name).add(this);
  }

  /** @param {unknown} data */
  postMessage(data) {
    for (const peer of channelPeers.get(this.name) || []) {
      if (peer === this) continue;
      peer.onmessage?.({ data });
    }
  }

  close() {
    channelPeers.get(this.name)?.delete(this);
  }
}

function createFakeStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    _map: map,
  };
}

function resetChannels() {
  channelPeers.clear();
}

/**
 * @param {{
 *   onGet?: (key: string, resume: (result: unknown) => void) => void,
 * }} [hooks]
 */
function createMinimalReadWriteFactory(hooks = {}) {
  const stores = new Map();
  const db = {
    objectStoreNames: {
      contains(name) {
        return name === CHAT_METADATA_STORE_META;
      },
    },
    transaction(storeName, mode) {
      assert.equal(storeName, CHAT_METADATA_STORE_META);
      void mode;
      const tx = {
        error: null,
        onabort: null,
        onerror: null,
        oncomplete: null,
        objectStore() {
          return {
            put(value) {
              stores.set(value.key, value);
              queueMicrotask(() => {
                if (typeof tx.oncomplete === 'function') tx.oncomplete();
              });
            },
            get(key) {
              const req = {
                result: undefined,
                onsuccess: null,
                onerror: null,
              };
              const finish = (result) => {
                req.result = result;
                queueMicrotask(() => {
                  if (typeof req.onsuccess === 'function') req.onsuccess();
                  queueMicrotask(() => {
                    if (typeof tx.oncomplete === 'function') tx.oncomplete();
                  });
                });
              };
              if (hooks.onGet) {
                hooks.onGet(String(key), finish);
              } else {
                finish(stores.get(key));
              }
              return req;
            },
            openCursor() {
              const keys = [...stores.keys()].sort();
              let index = 0;
              const req = {
                result: undefined,
                onsuccess: null,
                onerror: null,
              };
              const deliver = () => {
                if (index >= keys.length) {
                  req.result = null;
                } else {
                  const rowKey = keys[index];
                  index += 1;
                  req.result = {
                    value: stores.get(rowKey),
                    continue() {
                      queueMicrotask(deliver);
                    },
                  };
                }
                queueMicrotask(() => {
                  if (typeof req.onsuccess === 'function') req.onsuccess();
                });
              };
              queueMicrotask(deliver);
              return req;
            },
          };
        },
        abort() {
          queueMicrotask(() => {
            if (typeof tx.onabort === 'function') tx.onabort();
          });
        },
      };
      return tx;
    },
    close() {},
  };
  return {
    factory: {
      open(name, version) {
        assert.equal(name, CHAT_METADATA_IDB_NAME);
        void version;
        const req = {
          result: db,
          onblocked: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => {
          if (typeof req.onsuccess === 'function') req.onsuccess();
        });
        return req;
      },
    },
    stores,
  };
}

/**
 * @param {{ sessionId: string, generation: number }} session
 * @param {ReturnType<typeof createMinimalReadWriteFactory>} idbHarness
 */
async function seedActivityInIdb(session, idbHarness, chatId, ts) {
  await putChatMetadataKv(
    chatIdbActivityEntryKey(chatId),
    String(ts),
    session,
    { idb: () => idbHarness.factory },
  );
}

test('parseChatMetadataCrossTabMessage accepts flush payloads', () => {
  const parsed = parseChatMetadataCrossTabMessage({
    v: 1,
    kind: 'flush',
    tabId: 'tab-a',
    seq: 3,
    sessionId: 'sess-1',
    generation: 2,
    idbEpoch: 4,
    revision: 'rev1',
    activityIds: ['c1'],
    lastUsedIds: [],
  });
  assert.ok(parsed);
  assert.equal(parsed.sessionId, 'sess-1');
  assert.deepEqual(parsed.activityIds, ['c1']);
});

test('BroadcastChannel delivers activity deltas to peer RAM without re-persist', async () => {
  resetChannels();
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
  const storage = createFakeStorage();
  const session = { sessionId: 'shared', generation: 1 };
  const idbHarness = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => idbHarness.factory }, 1);
  setChatMetadataIdbSessionScope(session);
  await seedActivityInIdb(session, idbHarness, 'peer-chat', 500);
  const storeA = createChatActivityStore({ storage, createSessionId: () => 'shared' });
  const storeB = createChatActivityStore({ storage, createSessionId: () => 'shared' });
  storeA.hydrateLegacyOnce();
  storeB.hydrateLegacyOnce();
  const adapterA = createChatMetadataIdbPersistenceAdapter({
    getSession: () => storeA.getSession(),
    idb: () => idbHarness.factory,
  });
  const adapterB = createChatMetadataIdbPersistenceAdapter({
    getSession: () => storeB.getSession(),
    idb: () => idbHarness.factory,
  });
  let persistCalls = 0;
  const tabA = createChatMetadataCrossTabSync({
    tabId: 'tab-a',
    getSession: () => storeA.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapterA,
    getActivityStore: () => storeA,
    broadcastChannel: FakeBroadcastChannel,
  });
  const tabB = createChatMetadataCrossTabSync({
    tabId: 'tab-b',
    getSession: () => storeB.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapterB,
    getActivityStore: () => storeB,
    broadcastChannel: FakeBroadcastChannel,
  });
  const originalRecord = storeB.recordActivity.bind(storeB);
  storeB.recordActivity = (...args) => {
    persistCalls += 1;
    return originalRecord(...args);
  };
  tabA.publishFlush({
    sessionId: session.sessionId,
    generation: session.generation,
    idbEpoch: getChatMetadataIdbOperationEpoch(),
    activityIds: ['peer-chat'],
    lastUsedIds: [],
  });
  await tabB.drainIncomingForTest();
  assert.equal(storeB.getActivityAt('peer-chat'), 500);
  assert.equal(persistCalls, 0, 'peer merge must not enqueue durable writes');
  tabA.close();
  tabB.close();
});

test('storage fallback applies the same RAM merge as BroadcastChannel', async () => {
  resetChannels();
  __resetChatMetadataIdbForTest();
  const storage = createFakeStorage();
  const session = { sessionId: 'shared', generation: 1 };
  const idbHarness = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => idbHarness.factory }, 1);
  setChatMetadataIdbSessionScope(session);
  await seedActivityInIdb(session, idbHarness, 'ls-chat', 900);
  const storeA = createChatActivityStore({ storage, createSessionId: () => 'shared' });
  const storeB = createChatActivityStore({ storage, createSessionId: () => 'shared' });
  storeA.hydrateLegacyOnce();
  storeB.hydrateLegacyOnce();
  const adapterA = createChatMetadataIdbPersistenceAdapter({
    getSession: () => storeA.getSession(),
    idb: () => idbHarness.factory,
  });
  const adapterB = createChatMetadataIdbPersistenceAdapter({
    getSession: () => storeB.getSession(),
    idb: () => idbHarness.factory,
  });
  /** Force storage fallback even when Node exposes BroadcastChannel. */
  class BrokenBroadcastChannel {
    constructor() {
      throw new Error('BroadcastChannel unavailable');
    }
  }
  const tabA = createChatMetadataCrossTabSync({
    tabId: 'tab-a',
    getSession: () => storeA.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapterA,
    getActivityStore: () => storeA,
    storage,
    broadcastChannel: BrokenBroadcastChannel,
  });
  const tabB = createChatMetadataCrossTabSync({
    tabId: 'tab-b',
    getSession: () => storeB.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapterB,
    getActivityStore: () => storeB,
    storage,
    broadcastChannel: BrokenBroadcastChannel,
  });
  tabA.publishFlush({
    sessionId: storeA.getSession().sessionId,
    generation: storeA.getSession().generation,
    idbEpoch: getChatMetadataIdbOperationEpoch(),
    activityIds: ['ls-chat'],
    lastUsedIds: [],
  });
  const payload = tabA._readStorageFallback();
  assert.ok(payload);
  const handled = tabB.handleStorageEvent({ key: CHAT_METADATA_CROSS_TAB_STORAGE_KEY, newValue: payload });
  assert.equal(handled, true);
  await tabB.drainIncomingForTest();
  assert.equal(storeB.getActivityAt('ls-chat'), 900);
  tabA.close();
  tabB.close();
});

test('concurrent activity merges keep max timestamp per key', async () => {
  resetChannels();
  __resetChatMetadataIdbForTest();
  const storage = createFakeStorage();
  const session = { sessionId: 'shared', generation: 1 };
  const idbHarness = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => idbHarness.factory }, 1);
  setChatMetadataIdbSessionScope(session);
  await seedActivityInIdb(session, idbHarness, 'race', 250);
  const storeA = createChatActivityStore({ storage, createSessionId: () => 'shared' });
  const storeB = createChatActivityStore({ storage, createSessionId: () => 'shared' });
  storeA.hydrateLegacyOnce();
  storeB.hydrateLegacyOnce();
  storeB.recordActivity('race', 100);
  const adapterA = createChatMetadataIdbPersistenceAdapter({
    getSession: () => storeA.getSession(),
    idb: () => idbHarness.factory,
  });
  const adapterB = createChatMetadataIdbPersistenceAdapter({
    getSession: () => storeB.getSession(),
    idb: () => idbHarness.factory,
  });
  const tabA = createChatMetadataCrossTabSync({
    tabId: 'tab-a',
    getSession: () => storeA.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapterA,
    getActivityStore: () => storeA,
    broadcastChannel: FakeBroadcastChannel,
  });
  const tabB = createChatMetadataCrossTabSync({
    tabId: 'tab-b',
    getSession: () => storeB.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapterB,
    getActivityStore: () => storeB,
    broadcastChannel: FakeBroadcastChannel,
  });
  tabA.publishFlush({
    sessionId: storeA.getSession().sessionId,
    generation: storeA.getSession().generation,
    idbEpoch: getChatMetadataIdbOperationEpoch(),
    activityIds: ['race'],
    lastUsedIds: [],
  });
  await tabB.drainIncomingForTest();
  assert.equal(storeB.getActivityAt('race'), 250);
  tabA.close();
  tabB.close();
});

test('stale session and idb epoch notifications are rejected', async () => {
  resetChannels();
  __resetChatMetadataIdbForTest();
  const storage = createFakeStorage();
  const idbHarness = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => idbHarness.factory }, 1);
  const store = createChatActivityStore({ storage });
  store.hydrateLegacyOnce();
  const before = store.getSession();
  setChatMetadataIdbSessionScope(before);
  await seedActivityInIdb(before, idbHarness, 'stale', 111);
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => store.getSession(),
    idb: () => idbHarness.factory,
  });
  const tab = createChatMetadataCrossTabSync({
    tabId: 'tab-b',
    getSession: () => store.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapter,
    getActivityStore: () => store,
    broadcastChannel: FakeBroadcastChannel,
  });
  const foreign = await tab.handleIncoming({
    v: 1,
    kind: 'flush',
    tabId: 'tab-a',
    seq: 1,
    sessionId: 'other-session',
    generation: before.generation,
    idbEpoch: getChatMetadataIdbOperationEpoch(),
    revision: '',
    activityIds: ['stale'],
    lastUsedIds: [],
  });
  assert.equal(foreign.rejected, true);
  assert.equal(store.getActivityAt('stale'), 0);
  await applyChatAuthSessionBoundary({ storage, persistActivity: true });
  setChatMetadataIdbSessionScope(store.getSession());
  await seedActivityInIdb(store.getSession(), idbHarness, 'stale', 222);
  const lateEpoch = await tab.handleIncoming({
    v: 1,
    kind: 'flush',
    tabId: 'tab-a',
    seq: 2,
    sessionId: store.getSession().sessionId,
    generation: store.getSession().generation,
    idbEpoch: 0,
    revision: '',
    activityIds: ['stale'],
    lastUsedIds: [],
  });
  assert.equal(lateEpoch.rejected, true);
  assert.equal(store.getActivityAt('stale'), 0);
  tab.close();
});

test('queue flush publishes cross-tab notification once', async () => {
  resetChannels();
  __resetChatMetadataCrossTabSyncForTest();
  const adapter = createMemoryPersistenceAdapter();
  const store = createChatActivityStore({ adapter });
  store.hydrateLegacyOnce();
  /** @type {unknown[]} */
  const published = [];
  const queue = createChatPersistenceQueue({
    adapter,
    getSession: () => store.getSession(),
    getIdbEpoch: () => 0,
    getActivitySnapshots: () => ({
      activity: store.snapshotActivity(),
      lastUsed: store.snapshotLastUsed(),
    }),
    debounceMs: 0,
    onDurableFlush: (detail) => published.push(detail),
  });
  store.recordActivity('q1', 50);
  queue.markActivityDirty({ activityIds: ['q1'] });
  await queue.flushNow();
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].activityIds, ['q1']);
});

test('partial index prune does not drop activity for unknown chats after cross-tab merge', () => {
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => ({ sessionId: 's1', generation: 1 }),
    idb: () => null,
  });
  const store = createChatActivityStore({ adapter, createSessionId: () => 's1' });
  store.hydrateLegacyOnce();
  store.mergeActivity({ unseen: 400 }, { sessionId: store.getSession().sessionId, generation: store.getSession().generation, persist: false });
  const partial = store.pruneToKnownIds(['loaded'], { authoritative: false });
  assert.equal(partial.skipped, true);
  assert.equal(store.getActivityAt('unseen'), 400);
});

test('two adapters: tab B reads timestamps from shared IDB not tab A cache', async () => {
  resetChannels();
  __resetChatMetadataIdbForTest();
  const session = { sessionId: 'dual-tab', generation: 1 };
  const idbHarness = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => idbHarness.factory }, 1);
  setChatMetadataIdbSessionScope(session);
  await seedActivityInIdb(session, idbHarness, 'only-in-idb', 777);
  const storeA = createChatActivityStore({ createSessionId: () => session.sessionId });
  const storeB = createChatActivityStore({ createSessionId: () => session.sessionId });
  storeA.hydrateLegacyOnce();
  storeB.hydrateLegacyOnce();
  const adapterA = createChatMetadataIdbPersistenceAdapter({
    getSession: () => storeA.getSession(),
    idb: () => idbHarness.factory,
  });
  const adapterB = createChatMetadataIdbPersistenceAdapter({
    getSession: () => storeB.getSession(),
    idb: () => idbHarness.factory,
  });
  adapterA.write(chatIdbActivityEntryKey('only-in-idb'), '1');
  assert.equal(adapterB.read(chatIdbActivityEntryKey('only-in-idb')), null);
  const tabA = createChatMetadataCrossTabSync({
    tabId: 'tab-a',
    getSession: () => storeA.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapterA,
    getActivityStore: () => storeA,
    broadcastChannel: FakeBroadcastChannel,
  });
  const tabB = createChatMetadataCrossTabSync({
    tabId: 'tab-b',
    getSession: () => storeB.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapterB,
    getActivityStore: () => storeB,
    broadcastChannel: FakeBroadcastChannel,
  });
  tabA.publishFlush({
    sessionId: session.sessionId,
    generation: session.generation,
    idbEpoch: getChatMetadataIdbOperationEpoch(),
    activityIds: ['only-in-idb'],
    lastUsedIds: [],
  });
  await tabB.drainIncomingForTest();
  assert.equal(storeB.getActivityAt('only-in-idb'), 777);
  tabA.close();
  tabB.close();
});

test('failed IDB read leaves dedupe open so retry can apply', async () => {
  resetChannels();
  __resetChatMetadataIdbForTest();
  const session = { sessionId: 'retry-tab', generation: 1 };
  let failReads = true;
  const { factory: retryFactory, stores: retryStores } = createMinimalReadWriteFactory({
    onGet(key, resume) {
      if (failReads) {
        resume(undefined);
        return;
      }
      resume(retryStores.get(key));
    },
  });
  const idbHarness = { factory: retryFactory, stores: retryStores };
  await __testOpenChatMetadataDatabase({ idb: () => idbHarness.factory }, 1);
  setChatMetadataIdbSessionScope(session);
  await seedActivityInIdb(session, idbHarness, 'retry-chat', 432);
  const store = createChatActivityStore({ createSessionId: () => session.sessionId });
  store.hydrateLegacyOnce();
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => store.getSession(),
    idb: () => idbHarness.factory,
  });
  const tab = createChatMetadataCrossTabSync({
    tabId: 'tab-b',
    getSession: () => store.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapter,
    getActivityStore: () => store,
    broadcastChannel: FakeBroadcastChannel,
  });
  const message = {
    v: 1,
    kind: 'flush',
    tabId: 'tab-a',
    seq: 9,
    sessionId: session.sessionId,
    generation: session.generation,
    idbEpoch: getChatMetadataIdbOperationEpoch(),
    revision: '',
    activityIds: ['retry-chat'],
    lastUsedIds: [],
  };
  const first = await tab.handleIncoming(message);
  assert.equal(first.applied, 0);
  assert.equal(store.getActivityAt('retry-chat'), 0);
  failReads = false;
  const second = await tab.handleIncoming(message);
  assert.equal(second.applied, 1);
  assert.equal(store.getActivityAt('retry-chat'), 432);
  tab.close();
});

test('BroadcastChannel double delivery is deduped after successful apply', async () => {
  resetChannels();
  __resetChatMetadataIdbForTest();
  const session = { sessionId: 'dedupe', generation: 1 };
  const idbHarness = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => idbHarness.factory }, 1);
  setChatMetadataIdbSessionScope(session);
  await seedActivityInIdb(session, idbHarness, 'once', 50);
  const store = createChatActivityStore({ createSessionId: () => session.sessionId });
  store.hydrateLegacyOnce();
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => store.getSession(),
    idb: () => idbHarness.factory,
  });
  let mergeCalls = 0;
  const originalMerge = store.mergeActivity.bind(store);
  store.mergeActivity = (...args) => {
    mergeCalls += 1;
    return originalMerge(...args);
  };
  const tab = createChatMetadataCrossTabSync({
    tabId: 'tab-b',
    getSession: () => store.getSession(),
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getIdb: () => idbHarness.factory,
    getAdapter: () => adapter,
    getActivityStore: () => store,
    broadcastChannel: FakeBroadcastChannel,
  });
  const message = {
    v: 1,
    kind: 'flush',
    tabId: 'tab-a',
    seq: 1,
    sessionId: session.sessionId,
    generation: session.generation,
    idbEpoch: getChatMetadataIdbOperationEpoch(),
    revision: '',
    activityIds: ['once'],
    lastUsedIds: [],
  };
  await tab.handleIncoming(message);
  await tab.handleIncoming(message);
  assert.equal(mergeCalls, 1);
  tab.close();
});

void FakeBroadcastChannel;
void CHAT_METADATA_CROSS_TAB_CHANNEL;
