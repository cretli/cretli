/**
 * The durable watcher chat is an observability feed. No restore path (first paint from the
 * boot cache, server reconcile, workspace refresh) may open it, and selecting it must not be
 * remembered as the chat to restore on the next page load. An explicitly opened watcher chat
 * stays open across in-session list reloads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { writeChatLocalBootCache } from '../app_front/features/chat/chatLocalBootCache.js';
import { __resetChatBootListHydrationControllerForTest } from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';

const LAST_KEY = 'cretli-last-chat-id';
const watcher = () => ({ id: 'watcher', title: 'Watcher', watcherPinned: true, cursorSessionId: 's-watcher' });
const userA = () => ({ id: 'user-a', title: 'User A', cursorSessionId: 's-a' });

function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(String(key), String(value));
    },
    removeItem: (key) => {
      map.delete(String(key));
    },
  };
}

async function withBrowserShims(storage, run) {
  const previous = { localStorage: globalThis.localStorage, document: globalThis.document };
  globalThis.localStorage = storage;
  globalThis.document = {
    body: { classList: { contains: () => false } },
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  try {
    return await run();
  } finally {
    if (previous.localStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous.localStorage;
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
  }
}

/**
 * `serverChats: null` models a list request that has not answered: only the synchronous
 * boot-cache first paint runs.
 */
function createHarness({ chats = [], serverChats = [], workspaceChats, active = '' }) {
  __resetChatBootListHydrationControllerForTest();
  const state = { active };
  const selected = [];
  const controller = createChatController({
    api: {
      getChats: () => (serverChats === null
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, chats: serverChats, archivedCounts: {} })),
    },
    CHAT_BUFFER_MAX: 1000,
    LAST_CHAT_ID_KEY: LAST_KEY,
    getChats: () => chats,
    getActiveChatId: () => state.active,
    setActiveChatId: (id) => {
      state.active = id;
    },
    getWorkspaces: () => [],
    setWorkspaces: () => {},
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFile: () => {},
    getSelectedWorkspaceFolder: () => '',
    setSelectedWorkspaceFolder: () => {},
    getSelectedModel: () => 'auto',
    setSelectedModel: () => {},
    readChatBufferForChatRestore: () => null,
    updateFolderSelect: () => {},
    renderModelSelectOptions: () => {},
    renderChatList: () => {},
    updateChatBarSelect: () => {},
    selectChat: (id) => selected.push(id),
    syncBackgroundChatConnections: () => {},
    bindChatVisibilityAndReconnect: () => {},
    startChatBackgroundMonitor: () => {},
    startGlobalChatPingLoop: () => {},
    ensureChatConnection: () => {},
    teardownChatRuntime: () => {},
    teardownBlockedChatRuntime: () => {},
    openTerminal: () => {},
    getChatsForCurrentWorkspace: () => workspaceChats ?? chats,
    setChatStatus: () => {},
    onArchiveCatalogHydrate: async () => {},
    invalidateArchiveCatalog: () => {},
  });
  return { controller, state, selected };
}

test('a remembered last chat that is the watcher chat falls back to a user chat on load', async () => {
  const storage = createFakeStorage({ [LAST_KEY]: 'watcher' });
  await withBrowserShims(storage, async () => {
    const h = createHarness({ serverChats: [watcher(), userA()] });
    await h.controller.loadChatsFromServer({ skipAutoSelect: false });
    assert.equal(h.state.active, 'user-a');
    assert.ok(!h.selected.includes('watcher'));
  });
});

test('first paint from the boot cache never opens the watcher chat', async () => {
  const storage = createFakeStorage({ [LAST_KEY]: 'watcher' });
  await withBrowserShims(storage, async () => {
    writeChatLocalBootCache(storage, {
      activeChatId: 'watcher',
      workspaceContext: { workspaceFile: '', workspaceFolder: '' },
      workspaces: [],
      chats: [watcher(), userA()],
    });
    const h = createHarness({ serverChats: null });
    void h.controller.loadChatsFromServer({ skipAutoSelect: false });
    assert.equal(h.state.active, 'user-a');
    assert.ok(!h.selected.includes('watcher'));
  });
});

test('an explicitly opened watcher chat is not remembered and stays open on reload', async () => {
  const storage = createFakeStorage({ [LAST_KEY]: 'user-a' });
  await withBrowserShims(storage, async () => {
    const h = createHarness({
      chats: [watcher(), userA()],
      serverChats: [watcher(), userA()],
      active: 'user-a',
    });
    h.controller.selectChat('watcher');
    assert.equal(storage.getItem(LAST_KEY), 'user-a');
    await h.controller.loadChatsFromServer({ skipAutoSelect: false });
    assert.equal(h.state.active, 'watcher');
    assert.equal(storage.getItem(LAST_KEY), 'user-a');
  });
});

test('a stale boot-cache active chat is replaced by a user chat, not the watcher chat', async () => {
  const storage = createFakeStorage({ [LAST_KEY]: 'watcher' });
  await withBrowserShims(storage, async () => {
    const h = createHarness({
      chats: [{ id: 'gone', title: 'Gone', _fromBootCache: true }],
      serverChats: [watcher(), userA()],
      active: 'gone',
    });
    await h.controller.loadChatsFromServer({ skipAutoSelect: false });
    assert.equal(h.state.active, 'user-a');
    assert.ok(!h.selected.includes('watcher'));
  });
});

test('a workspace refresh that drops the open chat falls back to a user chat', async () => {
  const storage = createFakeStorage();
  await withBrowserShims(storage, async () => {
    const h = createHarness({
      workspaceChats: [watcher(), userA()],
      active: 'gone',
    });
    h.controller.refreshChatListForWorkspace();
    assert.equal(h.state.active, 'user-a');
    assert.deepEqual(h.selected, ['user-a']);
  });
});
