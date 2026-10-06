/**
 * Task 5.2 — persistence queue with IndexedDB backend.
 *
 * Run: node tests/chat-persistence-idb-queue.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CHAT_METADATA_IDB_NAME, CHAT_METADATA_STORE_META } from '../app_front/features/chat/chatMetadataIdbSchema.js';
import {
  CHAT_PERSISTENCE_SESSION_KEY,
  serializeSessionMarker,
} from '../app_front/features/chat/chatPersistenceAdapter.js';
import { CHAT_LOCAL_BOOT_CACHE_KEY } from '../app_front/features/chat/chatLocalBootCache.js';
import {
  __resetChatMetadataIdbForTest,
  __testOpenChatMetadataDatabase,
  getChatMetadataIdbOperationEpoch,
  putChatMetadataKv,
  setChatMetadataIdbSessionScope,
} from '../app_front/features/chat/chatMetadataIdb.js';
import {
  chatIdbActivityEntryKey,
  createChatMetadataIdbPersistenceAdapter,
} from '../app_front/features/chat/chatPersistenceIdbAdapter.js';
import { createChatPersistenceQueue } from '../app_front/features/chat/chatPersistenceQueue.js';
import { applyChatAuthSessionBoundary } from '../app_front/features/chat/chatSessionBoundary.js';
import {
  __resetChatActivityStoreForTest,
  __setChatActivityStoreForTest,
  createChatActivityStore,
} from '../app_front/features/chat/chatActivityStore.js';

/**
 * @param {{
 *   failPutCount?: number,
 *   throwOnPut?: boolean,
 * }} [hooks]
 */
function createMinimalReadWriteFactory(hooks = {}) {
  const stores = new Map();
  let putAttempts = 0;
  const db = {
    objectStoreNames: {
      contains(name) {
        return name === CHAT_METADATA_STORE_META;
      },
    },
    transaction(storeName, mode) {
      assert.equal(storeName, CHAT_METADATA_STORE_META);
      void mode;
      let aborted = false;
      const tx = {
        error: null,
        onabort: null,
        onerror: null,
        oncomplete: null,
        objectStore() {
          return {
            put(value) {
              putAttempts += 1;
              if (hooks.throwOnPut) {
                const err = new Error('quota');
                err.name = 'QuotaExceededError';
                throw err;
              }
              if (Number.isFinite(Number(hooks.failPutCount)) && putAttempts <= Number(hooks.failPutCount)) {
                const err = new Error('transient');
                err.name = 'UnknownError';
                throw err;
              }
              stores.set(value.key, value);
            },
            get(key) {
              const req = {
                result: undefined,
                onsuccess: null,
                onerror: null,
              };
              queueMicrotask(() => {
                req.result = stores.get(key);
                if (typeof req.onsuccess === 'function') req.onsuccess();
              });
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
          aborted = true;
          queueMicrotask(() => {
            if (typeof tx.onabort === 'function') tx.onabort();
          });
        },
      };
      queueMicrotask(() => {
        if (!aborted && typeof tx.oncomplete === 'function') tx.oncomplete();
      });
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
 * @param {{ idbHooks?: { failPutCount?: number, throwOnPut?: boolean } }} [overrides]
 */
async function createIdbQueueHarness(overrides = {}) {
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
  const { factory, stores } = createMinimalReadWriteFactory(overrides.idbHooks || {});
  await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  const scope = { sessionId: 'sess-idb', generation: 1 };
  setChatMetadataIdbSessionScope(scope);
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => store.getSession(),
    idb: () => factory,
  });
  const store = createChatActivityStore({
    adapter,
    createSessionId: () => scope.sessionId,
  });
  store.recordActivity('c1', 100);
  store.recordActivity('c2', 200);
  __setChatActivityStoreForTest(store);
  const queue = createChatPersistenceQueue({
    adapter,
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    getSession: () => store.getSession(),
    getBootCacheInput: () => null,
    getActivitySnapshots: () => ({
      activity: store.snapshotActivity(),
      lastUsed: store.snapshotLastUsed(),
    }),
    debounceMs: 0,
  });
  return { queue, adapter, store, stores, factory };
}

test('coalesced dirty chat ids produce one batched IDB write', async () => {
  const { queue, stores } = await createIdbQueueHarness();
  queue.markActivityDirty({ activityIds: ['c1'] });
  queue.markActivityDirty({ activityIds: ['c2'] });
  await queue.flushNow();
  assert.equal(queue.getPendingTransactionCount(), 0);
  assert.ok(stores.has(chatIdbActivityEntryKey('c1')));
  assert.ok(stores.has(chatIdbActivityEntryKey('c2')));
  const c2Row = stores.get(chatIdbActivityEntryKey('c2'));
  assert.equal(String(c2Row.value), '200');
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
});

test('quota failure keeps activity entry out of IDB until a later successful flush', async () => {
  const harness = await createIdbQueueHarness({ idbHooks: { throwOnPut: true } });
  harness.store.recordActivity('c9', 900);
  harness.queue.markActivityDirty({ activityIds: ['c9'] });
  await harness.queue.flushNow();
  assert.equal(harness.queue.getPendingTransactionCount(), 0);
  assert.equal(harness.stores.has(chatIdbActivityEntryKey('c9')), false);
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
});

test('stale flush after auth boundary does not write activity rows', async () => {
  const harness = await createIdbQueueHarness();
  harness.queue.markActivityDirty({ activityIds: ['c1'] });
  await applyChatAuthSessionBoundary({ reason: 'logout', idb: () => harness.factory });
  await harness.queue.flushNow();
  assert.equal(harness.stores.has(chatIdbActivityEntryKey('c1')), false);
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
});

test('retry backoff succeeds after transient IDB put failure', async () => {
  const harness = await createIdbQueueHarness({ idbHooks: { failPutCount: 1 } });
  harness.queue.markActivityDirty({ activityIds: ['c2'] });
  await harness.queue.flushNow();
  assert.equal(harness.stores.has(chatIdbActivityEntryKey('c2')), true);
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
});

test('ensurePrime after scope loads persisted maps, session marker, and boot cache (reload)', async () => {
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
  const scope = { sessionId: 'sess-reload', generation: 2 };
  const { factory, stores } = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  setChatMetadataIdbSessionScope(scope);
  const markerPayload = serializeSessionMarker({
    id: scope.sessionId,
    generation: scope.generation,
    updatedAt: 1000,
    reason: 'test',
  });
  const bootPayload = JSON.stringify({ chats: [{ id: 'c-boot' }], version: 1 });
  await putChatMetadataKv(CHAT_PERSISTENCE_SESSION_KEY, markerPayload, scope, { idb: () => factory });
  await putChatMetadataKv(chatIdbActivityEntryKey('c-reload'), '555', scope, { idb: () => factory });
  await putChatMetadataKv(CHAT_LOCAL_BOOT_CACHE_KEY, bootPayload, scope, { idb: () => factory });
  assert.equal(stores.size, 3);
  /** @type {ReturnType<typeof createChatActivityStore>} */
  let reloadedStore;
  const reloadedAdapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => reloadedStore.getSession(),
    idb: () => factory,
  });
  reloadedStore = createChatActivityStore({
    adapter: reloadedAdapter,
    createSessionId: () => 'must-not-be-used',
  });
  setChatMetadataIdbSessionScope(reloadedStore.peekSessionScope());
  await reloadedAdapter.ensurePrime();
  setChatMetadataIdbSessionScope(reloadedStore.getSession());
  assert.equal(reloadedAdapter.read(CHAT_PERSISTENCE_SESSION_KEY), markerPayload);
  assert.equal(reloadedAdapter.read(CHAT_LOCAL_BOOT_CACHE_KEY), bootPayload);
  assert.equal(reloadedStore.getActivityAt('c-reload'), 555);
  assert.equal(reloadedAdapter.isCacheReady(), true);
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
});

test('session marker is persisted to IDB after scope is set (not via queue bypass)', async () => {
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
  const scope = { sessionId: 'sess-marker', generation: 1 };
  const { factory, stores } = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  setChatMetadataIdbSessionScope(scope);
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => store.getSession(),
    idb: () => factory,
  });
  const store = createChatActivityStore({
    adapter,
    createSessionId: () => scope.sessionId,
  });
  store.getSession();
  assert.equal(stores.has(CHAT_PERSISTENCE_SESSION_KEY), false, 'marker must not write before scope flush');
  await adapter.persistPendingSessionMarker({ epoch: getChatMetadataIdbOperationEpoch() });
  assert.ok(stores.has(CHAT_PERSISTENCE_SESSION_KEY));
  const row = stores.get(CHAT_PERSISTENCE_SESSION_KEY);
  assert.equal(row.sessionId, scope.sessionId);
  assert.equal(String(row.value), adapter.read(CHAT_PERSISTENCE_SESSION_KEY));
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
});

test('activity delta flush still writes only touched chat ids with max timestamp', async () => {
  const harness = await createIdbQueueHarness();
  harness.queue.markActivityDirty({ activityIds: ['c1', 'c2'] });
  await harness.queue.flushNow();
  harness.store.recordActivity('c1', 150);
  harness.queue.markActivityDirty({ activityIds: ['c1'] });
  await harness.queue.flushNow();
  assert.equal(String(harness.stores.get(chatIdbActivityEntryKey('c1')).value), '150');
  assert.equal(String(harness.stores.get(chatIdbActivityEntryKey('c2')).value), '200');
  assert.equal(harness.stores.has(chatIdbActivityEntryKey('c9')), false);
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
});

test('activity store comparator path does not import chatMetadataIdb', async () => {
  const source = await readFile(
    new URL('../app_front/features/chat/chatActivityStore.js', import.meta.url),
    'utf8'
  );
  assert.equal(/chatMetadataIdb/.test(source), false);
  assert.equal(/indexedDB/.test(source), false);
});
