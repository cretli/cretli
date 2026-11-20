/**
 * Task 5.3 — synchronous bootstrap, byte/row budget, legacy migration, async guards.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHAT_LOCAL_BOOT_SYNC_KEY,
  CHAT_LOCAL_BOOT_SYNC_MAX_BYTES,
  CHAT_LOCAL_BOOT_SYNC_MAX_ROWS,
  buildChatLocalBootSyncDoc,
  parseChatLocalBootSync,
  readChatLocalBootCacheForColdStart,
  readChatLocalBootSync,
  writeChatLocalBootSync,
  clearChatLocalBootSync,
  selectChatsForSyncBootstrap,
} from '../app_front/features/chat/chatLocalBootSync.js';
import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  buildChatLocalBootCache,
  writeChatLocalBootCache,
  readChatLocalBootCache,
} from '../app_front/features/chat/chatLocalBootCache.js';
import {
  migrateLegacyLocalBootCacheToIdb,
  readLegacyLocalBootCacheRaw,
} from '../app_front/features/chat/chatLocalBootLegacyMigration.js';
import {
  createChatBootListHydrationController,
  selectBootRowsMissingFromRuntime,
  __resetChatBootListHydrationControllerForTest,
} from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';
import { createChatMetadataIdbPersistenceAdapter } from '../app_front/features/chat/chatPersistenceIdbAdapter.js';
import {
  __resetChatMetadataIdbForTest,
  __testOpenChatMetadataDatabase,
  getChatMetadataIdbOperationEpoch,
  getChatMetadataIdbStatus,
  setChatMetadataIdbSessionScope,
} from '../app_front/features/chat/chatMetadataIdb.js';
import {
  CHAT_METADATA_IDB_NAME,
  CHAT_METADATA_STORE_META,
} from '../app_front/features/chat/chatMetadataIdbSchema.js';

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
              const req = { result: undefined, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                req.result = stores.get(key);
                if (typeof req.onsuccess === 'function') req.onsuccess();
              });
              return req;
            },
            openCursor() {
              const keys = [...stores.keys()].sort();
              let index = 0;
              const req = { result: undefined, onsuccess: null, onerror: null };
              const deliver = () => {
                if (index >= keys.length) req.result = null;
                else {
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

function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    _dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

test('sync bootstrap respects N=40 and 64KB budget constants from baseline 0.1', () => {
  assert.equal(CHAT_LOCAL_BOOT_SYNC_MAX_ROWS, 40);
  assert.equal(CHAT_LOCAL_BOOT_SYNC_MAX_BYTES, 65536);
  const chats = [];
  for (let i = 0; i < 120; i += 1) {
    chats.push({
      id: `chat-${i}`,
      title: `Chat ${i}`,
      updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    });
  }
  chats.push({ id: 'pinned', watcherPinned: true, title: 'Pinned' });
  const doc = buildChatLocalBootSyncDoc({ chats, activeChatId: 'chat-0' });
  assert.ok(doc);
  assert.ok(doc.chats.length <= CHAT_LOCAL_BOOT_SYNC_MAX_ROWS);
  assert.ok(doc.chats.some((row) => row.id === 'pinned'));
  assert.ok(doc.chats.some((row) => row.id === 'chat-0'));
  const json = JSON.stringify(doc);
  assert.ok(json.length <= CHAT_LOCAL_BOOT_SYNC_MAX_BYTES);
});

test('cold start prefers sync key over legacy full localStorage cache', () => {
  const storage = createFakeStorage();
  storage.setItem(
    CHAT_LOCAL_BOOT_CACHE_KEY,
    JSON.stringify(buildChatLocalBootCache({
      activeChatId: 'legacy-active',
      chats: [{ id: 'legacy-active', title: 'Legacy' }],
    }))
  );
  writeChatLocalBootSync(storage, {
    activeChatId: 'sync-active',
    workspaceContext: { workspaceFile: '/ws/a.code-workspace', workspaceFolder: '' },
    chats: [{ id: 'sync-active', title: 'Sync' }],
  });
  const view = readChatLocalBootCacheForColdStart(storage);
  assert.equal(view?.activeChatId, 'sync-active');
  assert.equal(view?.chats[0].id, 'sync-active');
});

test('legacy migration aborts with idb-unavailable when metadata IDB is not ok', async () => {
  __resetChatMetadataIdbForTest();
  await __testOpenChatMetadataDatabase({ idb: () => null });
  assert.equal(getChatMetadataIdbStatus(), 'unavailable');
  const scope = { sessionId: 'sess-idb-down', generation: 1 };
  const storage = createFakeStorage();
  const legacyDoc = buildChatLocalBootCache({
    activeChatId: 'c1',
    chats: [{ id: 'c1', title: 'One' }],
  });
  const raw = JSON.stringify(legacyDoc);
  storage.setItem(CHAT_LOCAL_BOOT_CACHE_KEY, raw);
  const { factory } = createMinimalReadWriteFactory();
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => scope,
    idb: () => factory,
  });
  const result = await migrateLegacyLocalBootCacheToIdb({
    storage,
    adapter,
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'idb-unavailable');
  assert.equal(result.removedLegacy, false);
  assert.equal(readLegacyLocalBootCacheRaw(storage), raw, 'must not clear legacy when IDB unavailable');
  __resetChatMetadataIdbForTest();
});

test('legacy migration keeps source until IDB commit succeeds', async () => {
  __resetChatMetadataIdbForTest();
  const scope = { sessionId: 'sess-migrate', generation: 1 };
  const { factory } = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  setChatMetadataIdbSessionScope(scope);
  const storage = createFakeStorage();
  const fullDoc = buildChatLocalBootCache({
    activeChatId: 'c1',
    chats: [{ id: 'c1', title: 'One' }, { id: 'c2', title: 'Two' }],
  });
  const raw = JSON.stringify(fullDoc);
  storage.setItem(CHAT_LOCAL_BOOT_CACHE_KEY, raw);
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => scope,
    idb: () => factory,
  });
  let failOnce = true;
  const first = await migrateLegacyLocalBootCacheToIdb({
    storage,
    adapter,
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
    persistKv: async (key, value, guard) => {
      if (failOnce) {
        failOnce = false;
        return false;
      }
      return adapter.persistKv(key, value, guard);
    },
  });
  assert.equal(first.ok, false);
  assert.equal(readLegacyLocalBootCacheRaw(storage), raw, 'failed commit must keep legacy source');
  const second = await migrateLegacyLocalBootCacheToIdb({
    storage,
    adapter,
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
  });
  assert.equal(second.ok, true);
  assert.equal(second.removedLegacy, true);
  assert.equal(readLegacyLocalBootCacheRaw(storage), '');
  assert.equal(adapter.read(CHAT_LOCAL_BOOT_CACHE_KEY), raw);
  __resetChatMetadataIdbForTest();
});

test('late async hydration is cancelled after list revision bump (HTTP/WS)', async () => {
  __resetChatBootListHydrationControllerForTest();
  const controller = createChatBootListHydrationController();
  controller.setSessionScope({ sessionId: 's1', generation: 1 });
  const fullDoc = buildChatLocalBootCache({
    chats: Array.from({ length: 50 }, (_, i) => ({ id: `row-${i}`, title: `R${i}` })),
  });
  const missing = selectBootRowsMissingFromRuntime(fullDoc, new Set(['row-0']));
  assert.ok(missing.length >= 40);
  const applied = [];
  let scheduled = 0;
  const slow = controller.hydrateRows(missing, (row) => {
    applied.push(row.id);
  }, {
    budgetMs: 0,
    now: () => scheduled,
    setTimeoutFn: (fn) => {
      scheduled += 10;
      setTimeout(fn, 0);
      return 1;
    },
    clearTimeoutFn: () => {},
    MessageChannel: undefined,
    scheduler: undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.bumpListRevision();
  const result = await slow;
  assert.equal(result.cancelled, true);
  assert.ok(applied.length < missing.length, 'stale slices must not apply entire IDB payload');
});

test('writeChatLocalBootCache also writes sync bootstrap key', () => {
  const storage = createFakeStorage();
  writeChatLocalBootCache(storage, {
    activeChatId: 'a',
    chats: [{ id: 'a', title: 'A' }],
  });
  assert.ok(storage.getItem(CHAT_LOCAL_BOOT_SYNC_KEY));
  assert.ok(readChatLocalBootSync(storage));
  clearChatLocalBootSync(storage);
});

test('selectChatsForSyncBootstrap keeps required rows outside cap', () => {
  const rows = selectChatsForSyncBootstrap(
    [
      { id: 'active', updatedAt: '2020-01-01T00:00:00.000Z' },
      { id: 'pin', watcherPinned: true, updatedAt: '2019-01-01T00:00:00.000Z' },
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `x-${i}`,
        updatedAt: `2026-02-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
      })),
    ],
    'active',
    5
  );
  const ids = rows.map((row) => row.id);
  assert.ok(ids.includes('active'));
  assert.ok(ids.includes('pin'));
  assert.ok(ids.length <= 5);
});

test('late IDB prime guard rejects rows after list revision bump before hydrateRows', async () => {
  __resetChatBootListHydrationControllerForTest();
  const controller = createChatBootListHydrationController();
  controller.setSessionScope({ sessionId: 's1', generation: 1 });
  const bootGuard = controller.captureGuard();
  const isRunActive = controller.captureRunEpoch();
  await Promise.resolve();
  controller.bumpListRevision();
  assert.equal(controller.isGuardFresh(bootGuard), false);
  const fullDoc = buildChatLocalBootCache({
    chats: [{ id: 'stale-a', title: 'A' }, { id: 'stale-b', title: 'B' }],
  });
  const missing = selectBootRowsMissingFromRuntime(fullDoc, new Set());
  const applied = [];
  const result = await controller.hydrateRows(missing, (row) => {
    applied.push(row.id);
  }, undefined, { guard: bootGuard, isRunActive });
  assert.equal(applied.length, 0);
  assert.equal(result.cancelled, true);
});

test('cancel during async boot hydration stops apply after await (logout/401)', async () => {
  __resetChatBootListHydrationControllerForTest();
  const controller = createChatBootListHydrationController();
  controller.setSessionScope({ sessionId: 'sess', generation: 1 });
  const bootGuard = controller.captureGuard();
  const isRunActive = controller.captureRunEpoch();
  const missing = [{ id: 'idb-1', title: 'One' }, { id: 'idb-2', title: 'Two' }];
  const applied = [];
  await Promise.resolve();
  controller.cancel();
  const result = await controller.hydrateRows(missing, (row) => {
    applied.push(row.id);
  }, undefined, { guard: bootGuard, isRunActive });
  assert.equal(result.cancelled, true);
  assert.equal(applied.length, 0);
});

test('legacy migration does not overwrite newer IDB boot snapshot', async () => {
  __resetChatMetadataIdbForTest();
  const scope = { sessionId: 'sess-mig-newer', generation: 1 };
  const { factory } = createMinimalReadWriteFactory();
  await __testOpenChatMetadataDatabase({ idb: () => factory }, 1);
  setChatMetadataIdbSessionScope(scope);
  const storage = createFakeStorage();
  const legacyDoc = buildChatLocalBootCache({
    now: 1000,
    activeChatId: 'old',
    chats: [{ id: 'old', title: 'Legacy' }],
  });
  storage.setItem(CHAT_LOCAL_BOOT_CACHE_KEY, JSON.stringify(legacyDoc));
  const adapter = createChatMetadataIdbPersistenceAdapter({
    getSession: () => scope,
    idb: () => factory,
  });
  const newerDoc = buildChatLocalBootCache({
    now: 5000,
    activeChatId: 'new',
    chats: [{ id: 'new', title: 'Fresh IDB' }],
  });
  const newerRaw = JSON.stringify(newerDoc);
  adapter.write(CHAT_LOCAL_BOOT_CACHE_KEY, newerRaw);
  await adapter.persistKv(CHAT_LOCAL_BOOT_CACHE_KEY, newerRaw, { epoch: getChatMetadataIdbOperationEpoch() });
  const result = await migrateLegacyLocalBootCacheToIdb({
    storage,
    adapter,
    getIdbEpoch: () => getChatMetadataIdbOperationEpoch(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'idb-newer');
  assert.equal(result.removedLegacy, false);
  assert.equal(adapter.read(CHAT_LOCAL_BOOT_CACHE_KEY), newerRaw);
  assert.equal(readLegacyLocalBootCacheRaw(storage), JSON.stringify(legacyDoc));
  __resetChatMetadataIdbForTest();
});

test('required-only sync bootstrap fits row cap N and 64KB budget', () => {
  const chats = Array.from({ length: 55 }, (_, i) => ({
    id: `pin-${i}`,
    watcherPinned: true,
    title: `Pinned ${i}`,
    updatedAt: '2020-01-01T00:00:00.000Z',
  }));
  chats.push({ id: 'active', title: 'Active', updatedAt: '2026-01-01T00:00:00.000Z' });
  const doc = buildChatLocalBootSyncDoc({ chats, activeChatId: 'active' });
  assert.ok(doc);
  assert.ok(doc.chats.some((row) => row.id === 'active'));
  assert.equal(doc.chats.length, CHAT_LOCAL_BOOT_SYNC_MAX_ROWS);
  assert.ok(JSON.stringify(doc).length <= CHAT_LOCAL_BOOT_SYNC_MAX_BYTES);
  const storage = createFakeStorage();
  assert.equal(writeChatLocalBootSync(storage, { chats, activeChatId: 'active' }), true);
});
