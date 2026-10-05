/**
 * Cold-start chat list boot cache.
 *
 * Covers the pure "render from cache vs wait" decision, the snapshot sanitizer/parser
 * (metadata only, runtime fields dropped), the localStorage round-trip, the discreet
 * sync indicator decision, and the chatController wiring that seeds the list + active
 * chat before `GET /api/chats` answers and reconciles in place afterwards.
 *
 * No DOM is required: the controller is driven through its injectable deps and a fake
 * `localStorage`/`document` where needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  CHAT_LOCAL_BOOT_CACHE_VERSION,
  buildChatLocalBootCache,
  parseChatLocalBootCache,
  readChatLocalBootCache,
  sanitizeChatRowForBootCache,
  sanitizeWorkspaceForBootCache,
  shouldHydrateChatListFromBootCache,
  writeChatLocalBootCache,
  clearChatLocalBootCache,
} from '../app_front/features/chat/chatLocalBootCache.js';
import {
  shouldArmCachedHistorySyncIndicator,
} from '../app_front/features/chat/chatHistoryConvergence.js';
import { createChatController } from '../app_front/features/chat/chatController.js';

function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
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

// --- 1. row sanitizer: metadata whitelist, runtime fields dropped -----------------
const sanitized = sanitizeChatRowForBootCache({
  id: 'chat-a',
  title: 'Chat A',
  cursorSessionId: 'sess-a',
  agentTransport: 'sdk',
  workspaceFile: '/ws/a.code-workspace',
  updatedAt: '2026-01-02T03:04:05.000Z',
  summaries: [1, 2, 3, 4],
  harnessState: { code: 'plugin_unavailable', runnable: false },
  isTemporary: true,
  _buffer: 'VERY LONG HISTORY',
  _sdkRichView: { huge: true },
  _pushPreview: { text: 'transient push preview', at: 123 },
  pane: { isConnected: true },
  ws: { readyState: 1 },
  unknownSecret: 'nope',
});
assert.equal(sanitized.id, 'chat-a');
assert.equal(sanitized.title, 'Chat A');
assert.equal(sanitized.agentTransport, 'sdk');
assert.equal(sanitized.harnessState.code, 'plugin_unavailable');
assert.equal(sanitized.isTemporary, true);
assert.equal('summaries' in sanitized, false, 'compressed conversation summaries must not be cached');
assert.equal(
  'widgetPinnedUrl' in sanitizeChatRowForBootCache({
    id: 'w',
    widgetPinnedUrl: 'https://example.com/page',
  }),
  false,
  'widget pin URL must not be cached',
);
assert.equal('_buffer' in sanitized, false, 'live history buffer must not be cached');
assert.equal('_sdkRichView' in sanitized, false, 'runtime view must not be cached');
assert.equal('_pushPreview' in sanitized, false, 'transient push preview must not be cached');
assert.equal('pane' in sanitized, false, 'runtime pane must not be cached');
assert.equal('ws' in sanitized, false, 'runtime socket must not be cached');
assert.equal('unknownSecret' in sanitized, false, 'unknown fields are dropped');
assert.equal(sanitizeChatRowForBootCache({}), null, 'a row without an id is not cacheable');
assert.equal(sanitizeChatRowForBootCache(null), null);

// --- 2. document build/parse round-trip ------------------------------------------
const doc = buildChatLocalBootCache({
  now: 12345,
  activeChatId: 'chat-b',
  workspaceContext: { workspaceFile: '/ws/a.code-workspace', workspaceFolder: '/ws/a' },
  workspaces: [
    {
      id: '/ws/a.code-workspace',
      kind: 'file',
      workspaceFile: '/ws/a.code-workspace',
      name: 'a',
      workspaceDir: '/ws',
      fileExists: true,
      folders: [{ name: 'src', resolvedPath: '/ws/a/src', enabled: true, secret: 'x' }],
      secret: 'drop-me',
    },
  ],
  chats: [
    { id: 'chat-a', title: 'A', cursorSessionId: 'sa' },
    { id: 'chat-b', title: 'B', cursorSessionId: 'sb' },
  ],
});
assert.equal(doc.v, CHAT_LOCAL_BOOT_CACHE_VERSION);
assert.equal(doc.activeChatId, 'chat-b');
assert.equal(doc.workspaceContext.workspaceFile, '/ws/a.code-workspace');
assert.equal(doc.chats.length, 2);
const overflow = [];
for (let index = 0; index < 301; index += 1) {
  overflow.push({
    id: `old-${index}`,
    title: 'old',
    updatedAt: '2020-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
}
overflow[50].updatedAt = '2010-01-01T00:00:00.000Z';
overflow[50].createdAt = '2010-01-01T00:00:00.000Z';
overflow.push({
  id: 'newest',
  title: 'new',
  updatedAt: '2026-10-05T00:00:00.000Z',
  createdAt: '2026-10-05T00:00:00.000Z',
});
overflow.push({
  id: 'pinned',
  title: 'pin',
  watcherPinned: true,
  updatedAt: '2019-01-01T00:00:00.000Z',
});
const capped = buildChatLocalBootCache({ chats: overflow, activeChatId: 'old-0' });
const cappedIds = capped.chats.map((chat) => chat.id);
assert.equal(cappedIds.includes('newest'), true);
assert.equal(cappedIds.includes('pinned'), true);
assert.equal(cappedIds.includes('old-0'), true);
assert.equal(cappedIds.includes('old-50'), false);
assert.ok(capped.chats.length <= 302);
assert.equal(doc.workspaces.length, 1);
assert.deepEqual(doc.workspaces[0].folders, [{ name: 'src', resolvedPath: '/ws/a/src', enabled: true }]);
assert.equal('fileExists' in doc.workspaces[0], false, 'workspace sanitizer keeps only UI fields');

const reparsed = parseChatLocalBootCache(JSON.stringify(doc));
assert.equal(reparsed.activeChatId, 'chat-b');
assert.deepEqual(reparsed.chats.map((chat) => chat.id), ['chat-a', 'chat-b']);
assert.deepEqual(reparsed.workspaces, doc.workspaces);

// Malformed / wrong-version / empty documents are ignored (network path as before).
assert.equal(parseChatLocalBootCache(''), null);
assert.equal(parseChatLocalBootCache('{not json'), null);
assert.equal(parseChatLocalBootCache(JSON.stringify({ v: 999, chats: [{ id: 'x' }] })), null);
assert.equal(parseChatLocalBootCache(JSON.stringify({ v: 1, chats: [] })), null);
assert.equal(
  parseChatLocalBootCache(JSON.stringify({ v: 1, chats: [{ title: 'no id' }] })),
  null,
);

// --- 3. storage read/write with a throwing storage -------------------------------
const storage = createFakeStorage();
assert.equal(readChatLocalBootCache(storage), null);
assert.equal(
  writeChatLocalBootCache(storage, { chats: [{ id: 'chat-a', title: 'A' }] }),
  true,
);
assert.ok(storage.getItem(CHAT_LOCAL_BOOT_CACHE_KEY), 'snapshot is stored under the versioned key');
assert.equal(readChatLocalBootCache(storage).chats[0].id, 'chat-a');
assert.equal(
  writeChatLocalBootCache(storage, { chats: [] }),
  false,
  'an empty list must not overwrite the previous snapshot',
);
assert.equal(readChatLocalBootCache(storage).chats[0].id, 'chat-a');
clearChatLocalBootCache(storage);
assert.equal(readChatLocalBootCache(storage), null, 'clear removes the boot snapshot');

// An empty workspace list must not clobber a usable cached one (the workspaces fetch can
// resolve after the first chat list).
const workspaceStorage = createFakeStorage();
writeChatLocalBootCache(workspaceStorage, {
  chats: [{ id: 'chat-a' }],
  workspaces: [{ id: 'w', workspaceFile: '/w.code-workspace', name: 'w' }],
});
writeChatLocalBootCache(workspaceStorage, { chats: [{ id: 'chat-a', title: 'A' }], workspaces: [] });
assert.equal(readChatLocalBootCache(workspaceStorage).workspaces.length, 1);
const throwing = {
  getItem() {
    throw new Error('private mode');
  },
  setItem() {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  },
  removeItem() {},
};
assert.equal(readChatLocalBootCache(throwing), null, 'a throwing storage reads as empty');
assert.equal(
  writeChatLocalBootCache(throwing, { chats: [{ id: 'x' }] }),
  false,
  'a throwing storage is a no-op, not a crash',
);

// --- 4. hydrate decision ----------------------------------------------------------
assert.equal(
  shouldHydrateChatListFromBootCache({ cachedChatCount: 2, runtimeChatCount: 0 }),
  true,
);
assert.equal(
  shouldHydrateChatListFromBootCache({ cachedChatCount: 2, runtimeChatCount: 1 }),
  false,
  'a non-empty runtime list wins over the cache',
);
assert.equal(shouldHydrateChatListFromBootCache({ cachedChatCount: 0, runtimeChatCount: 0 }), false);
assert.equal(
  shouldHydrateChatListFromBootCache({ cachedChatCount: 2, runtimeChatCount: 0, alreadyHydrated: true }),
  false,
);
assert.equal(
  shouldHydrateChatListFromBootCache({ cachedChatCount: 2, runtimeChatCount: 0, skipCache: true }),
  false,
);

// --- 5. indicator decision --------------------------------------------------------
assert.equal(shouldArmCachedHistorySyncIndicator({ structuredReplayDone: true }), true);
assert.equal(shouldArmCachedHistorySyncIndicator({ structuredReplayDone: false }), false);
assert.equal(shouldArmCachedHistorySyncIndicator(null), false);
assert.equal(shouldArmCachedHistorySyncIndicator(undefined), false);

// --- 6. chatController: cache first, server reconciles in place -------------------
const fakeStorage = createFakeStorage({
  'cretli-last-chat-id': 'chat-b',
});
writeChatLocalBootCache(fakeStorage, {
  activeChatId: 'chat-b',
  workspaceContext: { workspaceFile: '/ws/a.code-workspace', workspaceFolder: '/ws/a' },
  workspaces: [
    { id: '/ws/a.code-workspace', kind: 'file', workspaceFile: '/ws/a.code-workspace', name: 'a', folders: [] },
  ],
  chats: [
    { id: 'chat-a', title: 'Cached A', cursorSessionId: 'sa', workspaceFile: '/ws/a.code-workspace' },
    { id: 'chat-b', title: 'Cached B', cursorSessionId: 'sb', workspaceFile: '/ws/a.code-workspace' },
  ],
});

const previousLocalStorage = globalThis.localStorage;
globalThis.localStorage = fakeStorage;
const hadDocument = typeof globalThis.document !== 'undefined';
const previousDocument = globalThis.document;
if (!hadDocument) {
  globalThis.document = {
    body: { classList: { contains: () => false } },
    getElementById: () => null,
  };
}

try {
  const chats = [];
  let activeChatId = '';
  let workspaces = [];
  const selected = [];
  const rendered = [];
  const noop = () => {};
  let resolveServerChats;
  const serverChatsPromise = new Promise((resolve) => {
    resolveServerChats = resolve;
  });
  const tornDown = [];
  const controller = createChatController({
    api: { getChats: () => serverChatsPromise },
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
    renderChatList: () => rendered.push(Date.now()),
    updateChatBarSelect: noop,
    selectChat: (id) => selected.push(id),
    syncBackgroundChatConnections: noop,
    bindChatVisibilityAndReconnect: noop,
    startChatBackgroundMonitor: noop,
    startGlobalChatPingLoop: noop,
    ensureChatConnection: noop,
    teardownChatRuntime: (chat) => tornDown.push(chat.id),
    openTerminal: noop,
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: noop,
  });

  const loadPromise = controller.loadChatsFromServer({});
  // The cache path is synchronous: the list and active chat exist before the server answers.
  assert.deepEqual(chats.map((chat) => chat.id), ['chat-a', 'chat-b']);
  assert.equal(activeChatId, 'chat-b', 'the last active chat is restored from localStorage');
  assert.deepEqual(selected, ['chat-b'], 'the active pane is opened from the cache, before the network');
  assert.equal(rendered.length, 1, 'the list is rendered from the cache first');
  assert.equal(workspaces.length, 1, 'the workspace list is seeded from the cache');

  const cachedA = chats.find((chat) => chat.id === 'chat-a');
  resolveServerChats({
    ok: true,
    chats: [
      { id: 'chat-a', title: 'Fresh A', cursorSessionId: 'sa', workspaceFile: '/ws/a.code-workspace' },
      { id: 'chat-c', title: 'Fresh C', cursorSessionId: 'sc', workspaceFile: '/ws/a.code-workspace' },
    ],
  });
  await loadPromise;

  assert.equal(chats.find((chat) => chat.id === 'chat-a'), cachedA, 'rows reconcile in place (no flicker)');
  assert.equal(cachedA.title, 'Fresh A', 'server fields overwrite cached ones');
  assert.deepEqual(chats.map((chat) => chat.id), ['chat-a', 'chat-c']);
  assert.ok(rendered.length >= 2, 'the reconciled list is rendered again');
  const persisted = readChatLocalBootCache(fakeStorage);
  assert.deepEqual(persisted.chats.map((chat) => chat.id), ['chat-a', 'chat-c']);

  // A second load does not re-seed the cache (and must not clear the live list).
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.deepEqual(chats.map((chat) => chat.id), ['chat-a', 'chat-c']);
  assert.equal(cachedA._fromBootCache, undefined, 'server-confirmed rows drop the boot-cache marker');

  // --- stale boot-cache row: pane mounted, absent on server -> teardown + drop from snapshot ---
  writeChatLocalBootCache(fakeStorage, {
    activeChatId: 'chat-zombie',
    workspaceContext: { workspaceFile: '/ws/a.code-workspace', workspaceFolder: '/ws/a' },
    workspaces: [
      { id: '/ws/a.code-workspace', kind: 'file', workspaceFile: '/ws/a.code-workspace', name: 'a', folders: [] },
    ],
    chats: [
      { id: 'chat-zombie', title: 'Zombie', workspaceFile: '/ws/a.code-workspace' },
      { id: 'chat-live', title: 'Live', workspaceFile: '/ws/a.code-workspace' },
    ],
  });
  chats.length = 0;
  activeChatId = '';
  selected.length = 0;
  tornDown.length = 0;
  rendered.length = 0;

  const zombieController = createChatController({
    api: {
      getChats: () => Promise.resolve({
        ok: true,
        chats: [{ id: 'chat-live', title: 'Live', workspaceFile: '/ws/a.code-workspace' }],
      }),
    },
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
    selectChat: (id) => {
      selected.push(id);
      const chat = chats.find((entry) => entry.id === id);
      if (chat) chat.pane = { isConnected: true };
    },
    syncBackgroundChatConnections: noop,
    bindChatVisibilityAndReconnect: noop,
    startChatBackgroundMonitor: noop,
    startGlobalChatPingLoop: noop,
    ensureChatConnection: noop,
    teardownChatRuntime: (chat) => tornDown.push(chat.id),
    openTerminal: (chat) => {
      chat.pane = { isConnected: true };
    },
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: noop,
  });

  await zombieController.loadChatsFromServer({});
  assert.deepEqual(chats.map((chat) => chat.id), ['chat-live']);
  assert.deepEqual(tornDown, ['chat-zombie']);
  assert.deepEqual(
    readChatLocalBootCache(fakeStorage).chats.map((chat) => chat.id),
    ['chat-live'],
  );

  // --- true live orphan (local, not from boot cache) survives reconcile ---
  chats.push({
    id: 'chat-local-orphan',
    title: 'Local orphan',
    pane: { isConnected: true },
    ws: { readyState: 1 },
  });
  await zombieController.loadChatsFromServer({ skipAutoSelect: true });
  assert.ok(chats.some((chat) => chat.id === 'chat-local-orphan'), 'non-cache live orphan is kept');

  // --- preferChatId missing from cache: no selectChat before HTTP ---
  writeChatLocalBootCache(fakeStorage, {
    activeChatId: 'chat-b',
    workspaceContext: { workspaceFile: '/ws/a.code-workspace', workspaceFolder: '/ws/a' },
    chats: [{ id: 'chat-b', title: 'B', workspaceFile: '/ws/a.code-workspace' }],
  });
  chats.length = 0;
  activeChatId = '';
  selected.length = 0;
  tornDown.length = 0;

  let resolvePrefer;
  const preferPromise = new Promise((resolve) => {
    resolvePrefer = resolve;
  });
  const preferController = createChatController({
    api: { getChats: () => preferPromise },
    CHAT_BUFFER_MAX: 1000,
    LAST_CHAT_ID_KEY: 'cretli-last-chat-id',
    getChats: () => chats,
    getActiveChatId: () => activeChatId,
    setActiveChatId: (next) => {
      activeChatId = next;
    },
    getWorkspaces: () => workspaces,
    setWorkspaces: noop,
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
  });

  const preferLoad = preferController.loadChatsFromServer({ preferChatId: 'chat-wanted' });
  assert.deepEqual(selected, [], '?chat= not in cache must not open a pane before HTTP');
  resolvePrefer({
    ok: true,
    chats: [{ id: 'chat-wanted', title: 'Wanted', workspaceFile: '/ws/a.code-workspace' }],
  });
  await preferLoad;
  assert.deepEqual(selected.slice(-1), ['chat-wanted'], 'HTTP reconcile opens the requested chat');
} finally {
  globalThis.localStorage = previousLocalStorage;
  if (!hadDocument) delete globalThis.document;
  else globalThis.document = previousDocument;
}

// --- 7. source wiring: boot order + no full-screen spinner -----------------------
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const appSource = read('app_front/App.js');
assert.match(appSource, /readChatLocalBootCache/);
assert.match(appSource, /clearChatLocalBootCache/);
const seedCallAt = appSource.indexOf('seedWorkspacesListFromBootCache();');
assert.ok(seedCallAt > -1, 'App boot must seed the workspace list from the snapshot');
assert.ok(
  seedCallAt < appSource.indexOf('void loadChatsFromServer({ preferChatId: readRequestedChatId() })'),
  'the workspace seed must run before the chat list load',
);
assert.match(
  appSource,
  /ensureWorkspacesListLoaded\(\{ refresh: true \}\)/,
  'the seeded workspace list must still be revalidated from the server',
);

const chatSource = read('app_front/chat.js');
const openTerminalAt = chatSource.indexOf('function openTerminal(chat)');
const armAt = chatSource.indexOf('shouldArmCachedHistorySyncIndicator(localHydration)', openTerminalAt);
assert.ok(armAt > openTerminalAt, 'openTerminal must arm the cached-render indicator');
assert.match(
  chatSource,
  /if \(cachedSyncIndicatorArmed\) \{\s*\n\s*setChatHistorySyncInFlight\(chat, false, renderChatTerminalState\)/,
  'the cached-render indicator must be cleared after catch-up (finally)',
);

console.log('chat-local-boot-cache.test.js OK');