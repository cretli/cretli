/**
 * Offline cold-start boot decision (todo 1a336b36).
 *
 * Covers `resolveBootOnAuthStatusFailure` (the gate used when GET /api/auth-status
 * rejects) and the snapshot probe it depends on (`hasLocalChatBootCacheForColdStart`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveBootOnAuthStatusFailure } from '../app_front/features/chat/chatBootDecision.js';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { __resetChatBootListHydrationControllerForTest } from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';
import {
  CHAT_LOCAL_BOOT_SYNC_MAX_BYTES,
  CHAT_LOCAL_BOOT_SYNC_MAX_ROWS,
  buildChatLocalBootSyncDoc,
  hasLocalChatBootCacheForColdStart,
  readChatLocalBootSync,
  selectChatsForSyncBootstrap,
  writeChatLocalBootSync,
} from '../app_front/features/chat/chatLocalBootSync.js';
import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  buildChatLocalBootCache,
  isPartialBootCacheSubsetShrink,
  isUnconfirmedBootCacheSource,
  writeChatLocalBootCacheToAdapter,
  writeChatLocalBootCacheToAdapterAsync,
  writeChatLocalBootSyncFromFullDoc,
} from '../app_front/features/chat/chatLocalBootCache.js';
import {
  hasLocalBootCacheForOfflineBoot,
  readLocalBootCacheDocFromIdb,
  seedLocalBootSyncFromIdbBootCache,
} from '../app_front/features/chat/chatOfflineBootSeed.js';
import {
  CHAT_METADATA_IDB_NAME,
  CHAT_METADATA_STORE_META,
} from '../app_front/features/chat/chatMetadataIdbSchema.js';

/**
 * Minimal IDBFactory double for the raw boot-snapshot read. `databases()` tells the
 * helper whether the DB exists; `open()` returns a single meta store with one row.
 */
function createFakeIdbFactory({ exists = true, rows = {} } = {}) {
  return {
    async databases() {
      return exists ? [{ name: CHAT_METADATA_IDB_NAME, version: 1 }] : [];
    },
    open() {
      const request = {};
      queueMicrotask(() => {
        if (!exists) {
          request.error = new Error('missing-db');
          request.onerror?.();
          return;
        }
        const store = {
          get(key) {
            const getRequest = {};
            queueMicrotask(() => {
              getRequest.result = rows[key];
              getRequest.onsuccess?.();
            });
            return getRequest;
          },
        };
        request.result = {
          objectStoreNames: { contains: (name) => name === CHAT_METADATA_STORE_META },
          transaction: () => ({ objectStore: () => store }),
          close: () => {},
        };
        request.onsuccess?.();
      });
      return request;
    },
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
  };
}

test('offline cold start boots only when a local snapshot exists', () => {
  assert.equal(resolveBootOnAuthStatusFailure({ online: false, hasLocalBootCache: true }), 'boot');
});

test('offline cold start without a local snapshot keeps the overlay', () => {
  assert.equal(resolveBootOnAuthStatusFailure({ online: false, hasLocalBootCache: false }), 'overlay');
});

test('online backend failure keeps the overlay even with a local snapshot', () => {
  assert.equal(resolveBootOnAuthStatusFailure({ online: true, hasLocalBootCache: true }), 'overlay');
  assert.equal(resolveBootOnAuthStatusFailure({ online: true, hasLocalBootCache: false }), 'overlay');
});

test('unknown connectivity is treated as online (overlay, never a blind boot)', () => {
  assert.equal(resolveBootOnAuthStatusFailure({ online: null, hasLocalBootCache: true }), 'overlay');
  assert.equal(resolveBootOnAuthStatusFailure({ online: undefined, hasLocalBootCache: true }), 'overlay');
  assert.equal(resolveBootOnAuthStatusFailure({ hasLocalBootCache: true }), 'overlay');
  assert.equal(resolveBootOnAuthStatusFailure(), 'overlay');
});

test('snapshot probe is false for empty storage and true for a sync doc', () => {
  const empty = createFakeStorage();
  assert.equal(hasLocalChatBootCacheForColdStart(empty), false);
  assert.equal(hasLocalChatBootCacheForColdStart(null), false);

  writeChatLocalBootSync(empty, {
    activeChatId: 'chat-a',
    workspaceContext: { workspaceFile: '/ws/a.code-workspace', workspaceFolder: '' },
    chats: [{ id: 'chat-a', title: 'Chat A' }],
  });
  assert.equal(hasLocalChatBootCacheForColdStart(empty), true);
});

test('snapshot probe is true for a legacy full cache with rows', () => {
  const storage = createFakeStorage({
    [CHAT_LOCAL_BOOT_CACHE_KEY]: JSON.stringify(buildChatLocalBootCache({
      activeChatId: 'legacy-active',
      chats: [{ id: 'legacy-active', title: 'Legacy' }],
    })),
  });
  assert.equal(hasLocalChatBootCacheForColdStart(storage), true);
});

test('snapshot probe is false when the cached document has zero rows', () => {
  const storage = createFakeStorage({
    [CHAT_LOCAL_BOOT_CACHE_KEY]: JSON.stringify(buildChatLocalBootCache({
      activeChatId: '',
      chats: [],
    })),
  });
  assert.equal(hasLocalChatBootCacheForColdStart(storage), false);
});

function idbDocRow(overrides = {}) {
  const doc = buildChatLocalBootCache({
    activeChatId: 'chat-idb',
    chats: [
      { id: 'chat-idb', title: 'From IDB' },
      { id: 'chat-other', title: 'Other' },
    ],
    ...overrides,
  });
  return { key: CHAT_LOCAL_BOOT_CACHE_KEY, value: JSON.stringify(doc) };
}

test('raw IDB reader fetches the durable snapshot without a session scope', async () => {
  const idbFactory = createFakeIdbFactory({ rows: { [CHAT_LOCAL_BOOT_CACHE_KEY]: idbDocRow() } });
  const doc = await readLocalBootCacheDocFromIdb({ idbFactory });
  assert.equal(doc?.chats?.length, 2);
  assert.equal(doc?.activeChatId, 'chat-idb');
});

test('raw IDB reader returns null when the metadata DB or row is absent', async () => {
  assert.equal(await readLocalBootCacheDocFromIdb({ idbFactory: createFakeIdbFactory({ exists: false }) }), null);
  assert.equal(await readLocalBootCacheDocFromIdb({ idbFactory: createFakeIdbFactory({ rows: {} }) }), null);
  assert.equal(await readLocalBootCacheDocFromIdb({ idbFactory: null }), null);
});

test('offline probe falls back to the IDB snapshot when localStorage is empty', async () => {
  const storage = createFakeStorage();
  const idbFactory = createFakeIdbFactory({ rows: { [CHAT_LOCAL_BOOT_CACHE_KEY]: idbDocRow() } });
  assert.equal(await hasLocalBootCacheForOfflineBoot({ storage, idbFactory }), true);
  assert.equal(await hasLocalBootCacheForOfflineBoot({ storage: createFakeStorage(), idbFactory: createFakeIdbFactory({ rows: {} }) }), false);
});

test('idb seed rebuilds the sync localStorage document for an offline boot', async () => {
  const storage = createFakeStorage();
  const idbFactory = createFakeIdbFactory({ rows: { [CHAT_LOCAL_BOOT_CACHE_KEY]: idbDocRow() } });
  const seeded = await seedLocalBootSyncFromIdbBootCache({ storage, idbFactory });
  assert.equal(seeded, true);
  assert.equal(hasLocalChatBootCacheForColdStart(storage), true);
});

test('idb seed is a no-op when the sync snapshot already exists', async () => {
  const storage = createFakeStorage();
  writeChatLocalBootSync(storage, {
    activeChatId: 'sync-chat',
    chats: [{ id: 'sync-chat', title: 'Sync' }],
  });
  const idbFactory = createFakeIdbFactory({ rows: { [CHAT_LOCAL_BOOT_CACHE_KEY]: idbDocRow() } });
  assert.equal(await seedLocalBootSyncFromIdbBootCache({ storage, idbFactory }), true);
  assert.equal(hasLocalChatBootCacheForColdStart(storage), true);
  const sync = JSON.parse(storage.getItem('cretli-chat-boot-sync-v1'));
  assert.equal(sync.activeChatId, 'sync-chat');
});

test('idb seed returns false when there is no durable snapshot', async () => {
  const storage = createFakeStorage();
  const idbFactory = createFakeIdbFactory({ rows: {} });
  assert.equal(await seedLocalBootSyncFromIdbBootCache({ storage, idbFactory }), false);
});

test('an oversized full-document signature does not reject the sync write', () => {
  const storage = createFakeStorage();
  const full = buildChatLocalBootCache({
    activeChatId: 'chat-3',
    chats: [
      { id: 'chat-3', title: 'Chat 3', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'chat-4', title: 'Chat 4', updatedAt: '2026-01-02T00:00:00.000Z' },
    ],
  });
  // A real full-document signature serializes every chat row (observed ~78 KB for 120
  // chats) and therefore always exceeds the 64 KB sync budget.
  const signature = 'x'.repeat(CHAT_LOCAL_BOOT_SYNC_MAX_BYTES + 1);
  const ok = writeChatLocalBootSyncFromFullDoc(storage, full, signature);
  assert.equal(ok, true, 'oversized signature must be dropped, not reject the snapshot');
  const sync = readChatLocalBootSync(storage);
  assert.ok(sync && sync.chats.length > 0);
  assert.equal(sync.activeChatId, 'chat-3');
  assert.equal(sync.fullSignature, '');
  assert.ok(JSON.stringify(sync).length <= CHAT_LOCAL_BOOT_SYNC_MAX_BYTES);
});

test('a fitting full-document signature is still attached', () => {
  const storage = createFakeStorage();
  const ok = writeChatLocalBootSync(storage, {
    activeChatId: 'chat-a',
    chats: [{ id: 'chat-a', title: 'Chat A' }],
  }, { fullSignature: 'sig-123' });
  assert.equal(ok, true);
  assert.equal(readChatLocalBootSync(storage)?.fullSignature, 'sig-123');
});

function createBootAdapter(storeDoc) {
  return {
    store: JSON.stringify(storeDoc),
    read(key) {
      return key === CHAT_LOCAL_BOOT_CACHE_KEY ? this.store : null;
    },
    write(key, value) {
      if (key !== CHAT_LOCAL_BOOT_CACHE_KEY) return false;
      this.store = value;
      return true;
    },
  };
}

test('unconfirmed boot-cache subset must not shrink the durable IDB boot cache (B1)', () => {
  const fullChats = [
    { id: 'chat-active', title: 'Active' },
    ...Array.from({ length: CHAT_LOCAL_BOOT_SYNC_MAX_ROWS + 10 }, (_, index) => ({
      id: `chat-extra-${index}`,
      title: `Extra ${index}`,
    })),
  ];
  const full = buildChatLocalBootCache({
    activeChatId: 'chat-active',
    chats: fullChats,
  });
  const partial = buildChatLocalBootCache({
    activeChatId: 'chat-active',
    chats: fullChats.slice(0, CHAT_LOCAL_BOOT_SYNC_MAX_ROWS),
  });
  // Pure shape: a 40-row slice of a 51-row durable snapshot is a subset shrink.
  assert.equal(isPartialBootCacheSubsetShrink(full, partial), true);
  assert.equal(isPartialBootCacheSubsetShrink(full, full), false);
  // Only the explicit unconfirmed-boot-cache source may skip the write.
  assert.equal(isUnconfirmedBootCacheSource({ source: 'boot-cache' }), true);
  assert.equal(isUnconfirmedBootCacheSource({ source: 'server' }), false);
  assert.equal(isUnconfirmedBootCacheSource({}), false);
  assert.equal(isUnconfirmedBootCacheSource(null), false);

  const adapter = createBootAdapter(full);
  const result = writeChatLocalBootCacheToAdapter(adapter, {
    activeChatId: 'chat-active',
    chats: partial.chats,
    source: 'boot-cache',
  });
  assert.equal(result.written, false);
  assert.equal(result.skippedSubsetShrink, true);
  assert.equal(JSON.parse(adapter.store).chats.length, fullChats.length);
});

test('server-confirmed 41 -> 40 deletion always writes and drops the ghost row (F1)', () => {
  const fullChats = Array.from({ length: 41 }, (_, index) => ({
    id: `chat-${index}`,
    title: `Chat ${index}`,
  }));
  const confirmed = fullChats.slice(0, 40); // the server deleted chat-40
  const incumbent = buildChatLocalBootCache({ activeChatId: 'chat-0', chats: fullChats });
  const candidate = buildChatLocalBootCache({ activeChatId: 'chat-0', chats: confirmed });

  // The shape test alone would flag this as a shrink (40 of 41 ids), which is exactly why
  // the skip decision may not use a row-count threshold.
  assert.equal(isPartialBootCacheSubsetShrink(incumbent, candidate), true);

  const adapter = createBootAdapter(incumbent);
  const result = writeChatLocalBootCacheToAdapter(adapter, {
    activeChatId: 'chat-0',
    chats: confirmed,
    source: 'server',
  });
  assert.equal(result.written, true, 'a server-confirmed shrink must persist');
  assert.equal(result.skippedSubsetShrink, undefined);
  assert.equal(JSON.parse(adapter.store).chats.length, 40);
  assert.equal(
    JSON.parse(adapter.store).chats.some((row) => row.id === 'chat-40'),
    false,
    'the deleted chat must not survive as a ghost in IDB',
  );
});

test('an input without an explicit source writes like a server-confirmed list', () => {
  const fullChats = Array.from({ length: 41 }, (_, index) => ({ id: `chat-${index}` }));
  const incumbent = buildChatLocalBootCache({ activeChatId: 'chat-0', chats: fullChats });
  const adapter = createBootAdapter(incumbent);
  const result = writeChatLocalBootCacheToAdapter(adapter, {
    activeChatId: 'chat-0',
    chats: fullChats.slice(0, 40),
  });
  assert.equal(result.written, true);
  assert.equal(JSON.parse(adapter.store).chats.length, 40);
});

test('a boot-cache list that is not a subset still writes (no false skip)', () => {
  const incumbentChats = Array.from({ length: 50 }, (_, index) => ({ id: `chat-${index}` }));
  const incumbent = buildChatLocalBootCache({ activeChatId: 'chat-0', chats: incumbentChats });
  const adapter = createBootAdapter(incumbent);
  const candidateChats = [
    ...incumbentChats.slice(0, 20),
    { id: 'chat-brand-new', title: 'New' },
  ];
  const result = writeChatLocalBootCacheToAdapter(adapter, {
    activeChatId: 'chat-0',
    chats: candidateChats,
    source: 'boot-cache',
  });
  assert.equal(result.written, true, 'a new id means it is not a pure subset shrink');
  assert.equal(result.skippedSubsetShrink, undefined);
});

test('async boot persist honors the same explicit source signal', async () => {
  const fullChats = Array.from({ length: 41 }, (_, index) => ({ id: `chat-${index}` }));
  const incumbent = buildChatLocalBootCache({ activeChatId: 'chat-0', chats: fullChats });

  const serverAdapter = createBootAdapter(incumbent);
  const serverResult = await writeChatLocalBootCacheToAdapterAsync(
    serverAdapter,
    { activeChatId: 'chat-0', chats: fullChats.slice(0, 40), source: 'server' },
    { lastSignature: '' },
  );
  assert.equal(serverResult.written, true);
  assert.equal(JSON.parse(serverAdapter.store).chats.length, 40);

  const bootAdapter = createBootAdapter(incumbent);
  const bootResult = await writeChatLocalBootCacheToAdapterAsync(
    bootAdapter,
    { activeChatId: 'chat-0', chats: fullChats.slice(0, 40), source: 'boot-cache' },
    { lastSignature: '' },
  );
  assert.equal(bootResult.written, false);
  assert.equal(bootResult.skippedSubsetShrink, true);
  assert.equal(JSON.parse(bootAdapter.store).chats.length, 41);
});

test('async boot persist primes a cold adapter mirror before the shrink guard', async () => {
  // Regression: the IDB adapter's synchronous `read()` only serves its in-memory mirror.
  // On an offline cold start the mirror is often cold, so the incumbent used to read as null
  // and the 40-row boot slice overwrote the durable snapshot. The guard must prime first.
  const fullChats = Array.from({ length: 41 }, (_, index) => ({ id: `chat-${index}` }));
  const incumbent = buildChatLocalBootCache({ activeChatId: 'chat-0', chats: fullChats });
  let mirror = null;
  let refreshedKey = '';
  const adapter = {
    read(key) {
      return key === CHAT_LOCAL_BOOT_CACHE_KEY ? mirror : null;
    },
    write(key, value) {
      if (key !== CHAT_LOCAL_BOOT_CACHE_KEY) return false;
      mirror = value;
      return true;
    },
    async refreshMetaKeyFromIdb(key) {
      refreshedKey = key;
      mirror = JSON.stringify(incumbent);
      return true;
    },
  };
  const result = await writeChatLocalBootCacheToAdapterAsync(
    adapter,
    { activeChatId: 'chat-0', chats: fullChats.slice(0, 40), source: 'boot-cache' },
    { lastSignature: '' },
  );
  assert.equal(refreshedKey, CHAT_LOCAL_BOOT_CACHE_KEY, 'the durable snapshot must be primed first');
  assert.equal(result.written, false);
  assert.equal(result.skippedSubsetShrink, true);
  assert.equal(JSON.parse(mirror).chats.length, 41, 'the full snapshot is preserved');
});

test('idb seed keeps a URL-requested chat outside the active row in the sync bootstrap', async () => {
  const storage = createFakeStorage();
  const requestedId = 'chat-requested-not-active';
  const idbFactory = createFakeIdbFactory({
    rows: {
      [CHAT_LOCAL_BOOT_CACHE_KEY]: idbDocRow({
        activeChatId: 'chat-idb',
        chats: [
          { id: 'chat-idb', title: 'Active in IDB', updatedAt: '2026-10-07T12:00:00.000Z' },
          { id: requestedId, title: 'Requested', updatedAt: '2026-01-01T00:00:00.000Z' },
          ...Array.from({ length: CHAT_LOCAL_BOOT_SYNC_MAX_ROWS + 5 }, (_, index) => ({
            id: `chat-filler-${index}`,
            title: `Filler ${index}`,
            updatedAt: `2026-01-02T00:00:${String(index).padStart(2, '0')}.000Z`,
          })),
        ],
      }),
    },
  });
  const seeded = await seedLocalBootSyncFromIdbBootCache({
    storage,
    idbFactory,
    preferChatId: requestedId,
  });
  assert.equal(seeded, true);
  const sync = readChatLocalBootSync(storage);
  assert.ok(sync?.chats.some((row) => row.id === requestedId));
  assert.ok(sync?.chats.some((row) => row.id === 'chat-idb'));
  assert.ok(sync.chats.length <= CHAT_LOCAL_BOOT_SYNC_MAX_ROWS);
});

test('selectChatsForSyncBootstrap pins preferChatId even when it is not active', () => {
  const preferId = 'chat-url';
  const chats = [
    { id: 'chat-active', title: 'Active', updatedAt: '2026-10-07T12:00:00.000Z' },
    { id: preferId, title: 'URL chat', updatedAt: '2026-01-01T00:00:00.000Z' },
    ...Array.from({ length: CHAT_LOCAL_BOOT_SYNC_MAX_ROWS + 2 }, (_, index) => ({
      id: `chat-rank-${index}`,
      title: `Rank ${index}`,
      updatedAt: `2026-06-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    })),
  ];
  const selected = selectChatsForSyncBootstrap(chats, 'chat-active', CHAT_LOCAL_BOOT_SYNC_MAX_ROWS, {
    preferChatId: preferId,
  });
  assert.ok(selected.some((row) => row.id === preferId));
  assert.ok(selected.some((row) => row.id === 'chat-active'));
  assert.equal(selected.length, CHAT_LOCAL_BOOT_SYNC_MAX_ROWS);
  const syncDoc = buildChatLocalBootSyncDoc({
    activeChatId: 'chat-active',
    preferChatId: preferId,
    chats,
  });
  assert.ok(syncDoc?.chats.some((row) => row.id === preferId));
});

// --- controller: `?chat=` outside the sync window falls back to IDB (F2) ----------

/**
 * Minimal controller harness: the sync bootstrap is already in localStorage, the durable
 * full snapshot only in a fake metadata adapter, and the network never answers. This is the
 * offline shape when the requested chat is outside the 40-row sync window.
 */
function createRequestedChatHarness(options = {}) {
  const requestedId = options.requestedId || 'chat-requested';
  const storage = createFakeStorage();
  writeChatLocalBootSync(storage, {
    activeChatId: 'chat-fill-0',
    workspaceContext: { workspaceFile: '/ws/a.code-workspace', workspaceFolder: '' },
    chats: Array.from({ length: CHAT_LOCAL_BOOT_SYNC_MAX_ROWS }, (_, index) => ({
      id: `chat-fill-${index}`,
      title: `Fill ${index}`,
      workspaceFile: '/ws/a.code-workspace',
    })),
  });
  const idbChats = [{ id: 'chat-fill-0', title: 'Fill 0', workspaceFile: '/ws/a.code-workspace' }];
  if (options.requestedInIdb !== false) {
    idbChats.push({ id: requestedId, title: 'Requested', workspaceFile: '/ws/a.code-workspace' });
  }
  const idbDoc = buildChatLocalBootCache({ activeChatId: 'chat-fill-0', chats: idbChats });
  const adapter = {
    async ensurePrime() {},
    async refreshMetaKeyFromIdb() {
      if (typeof options.onRefresh === 'function') await options.onRefresh();
    },
    read(key) {
      return key === CHAT_LOCAL_BOOT_CACHE_KEY ? JSON.stringify(idbDoc) : null;
    },
  };

  const chats = [];
  let activeChatId = '';
  let workspaces = [];
  const selected = [];
  const noop = () => {};
  const controller = createChatController({
    api: { getChats: () => new Promise(() => {}) },
    CHAT_BUFFER_MAX: 1000,
    LAST_CHAT_ID_KEY: 'cretli-last-chat-id',
    getChats: () => chats,
    getActiveChatId: () => activeChatId,
    setActiveChatId: (next) => {
      activeChatId = next;
    },
    getWorkspaces: () => workspaces,
    setWorkspaces: (next) => {
      workspaces = next;
    },
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFile: noop,
    getSelectedWorkspaceFolder: () => '',
    setSelectedWorkspaceFolder: noop,
    getSelectedModel: () => 'auto',
    setSelectedModel: noop,
    readChatBufferForChatRestore: () => null,
    updateFolderSelect: noop,
    renderModelSelectOptions: noop,
    renderChatList: noop,
    updateChatBarSelect: noop,
    selectChat: (id) => selected.push(id),
    syncBackgroundChatConnections: noop,
    bindChatVisibilityAndReconnect: noop,
    startChatBackgroundMonitor: noop,
    startGlobalChatPingLoop: noop,
    ensureChatConnection: noop,
    teardownChatRuntime: noop,
    openTerminal: noop,
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: noop,
    getBootMetadataAdapter: () => adapter,
  });
  return {
    controller,
    requestedId,
    chats,
    selected,
    getActiveChatId: () => activeChatId,
    setActiveChatId: (id) => {
      activeChatId = id;
    },
    storage,
  };
}

async function waitFor(predicate, timeoutMs = 2000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

test('requested chat missing from the sync doc but present in IDB hydrates and selects it', async () => {
  __resetChatBootListHydrationControllerForTest();
  const previousLocalStorage = globalThis.localStorage;
  const previousDocument = globalThis.document;
  const harness = createRequestedChatHarness({ requestedInIdb: true });
  globalThis.localStorage = harness.storage;
  globalThis.document = { body: { classList: { contains: () => false } }, getElementById: () => null };
  try {
    harness.controller.loadChatsFromServer({ preferChatId: harness.requestedId });
    assert.equal(
      harness.chats.some((chat) => chat.id === harness.requestedId),
      false,
      'the requested chat is not in the sync window yet',
    );
    const hydrated = await waitFor(() =>
      harness.selected.includes(harness.requestedId)
      && harness.getActiveChatId() === harness.requestedId
    );
    assert.equal(hydrated, true, 'the forceIdb fallback must hydrate and select the requested chat');
    assert.ok(harness.chats.some((chat) => chat.id === harness.requestedId));
  } finally {
    globalThis.localStorage = previousLocalStorage;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('requested chat missing from both sync and IDB leaves a sensible state without throwing', async () => {
  __resetChatBootListHydrationControllerForTest();
  const previousLocalStorage = globalThis.localStorage;
  const previousDocument = globalThis.document;
  const harness = createRequestedChatHarness({ requestedInIdb: false });
  globalThis.localStorage = harness.storage;
  globalThis.document = { body: { classList: { contains: () => false } }, getElementById: () => null };
  try {
    harness.controller.loadChatsFromServer({ preferChatId: harness.requestedId });
    // Give the deferred IDB read time to resolve; it must not throw or select a ghost.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(harness.chats.some((chat) => chat.id === harness.requestedId), false);
    assert.equal(harness.selected.includes(harness.requestedId), false);
    assert.equal(harness.getActiveChatId(), '', 'no ghost chat is selected when nothing to hydrate');
  } finally {
    globalThis.localStorage = previousLocalStorage;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('deferred ?chat= hydration never overrides an active chat the user already changed', async () => {
  __resetChatBootListHydrationControllerForTest();
  const previousLocalStorage = globalThis.localStorage;
  const previousDocument = globalThis.document;
  const harness = createRequestedChatHarness({
    requestedInIdb: true,
    // Simulate a user/other path selecting a chat while the IDB read is in flight.
    onRefresh: () => harness.setActiveChatId('chat-user-pick'),
  });
  globalThis.localStorage = harness.storage;
  globalThis.document = { body: { classList: { contains: () => false } }, getElementById: () => null };
  try {
    harness.controller.loadChatsFromServer({ preferChatId: harness.requestedId });
    const hydrated = await waitFor(() => harness.chats.some((chat) => chat.id === harness.requestedId));
    assert.equal(hydrated, true, 'the IDB read still hydrates the row');
    assert.equal(
      harness.getActiveChatId(),
      'chat-user-pick',
      'the deferred restore must not override the user pick',
    );
    assert.equal(harness.selected.includes(harness.requestedId), false);
  } finally {
    globalThis.localStorage = previousLocalStorage;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
