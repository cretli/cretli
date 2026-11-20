/**
 * Task 7.1 fix — scope keys, pending drain, session apply guard, archive catalog IDB.
 *
 * Run: node tests/chat-list-load-scope-guard.test.js
 */
import assert from 'node:assert/strict';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { createChatArchiveCatalog } from '../app_front/features/chat/chatArchiveCatalog.js';
import { __resetChatBootListHydrationControllerForTest } from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';
import { CHAT_LIST_FULL_INDEX_FRESH_MS } from '../app_front/features/chat/chatListLoadFreshness.js';

/**
 * @param {object} options
 * @returns {{ chats: object[], controller: ReturnType<typeof createChatController>, getSession: () => object }}
 */
function makeController(options = {}) {
  const chats = [];
  let session = options.session || { sessionId: 'test-session', generation: 1 };
  const getChatsApi = options.getChatsApi || (() => Promise.resolve({ ok: true, chats: [] }));
  return {
    chats,
    getSession: () => session,
    setSession(next) {
      session = { ...next };
    },
    controller: createChatController({
      api: { getChats: getChatsApi },
      CHAT_BUFFER_MAX: 100,
      LAST_CHAT_ID_KEY: 'last',
      getChats: () => chats,
      getActiveChatId: () => '',
      setActiveChatId: () => {},
      getWorkspaces: () => [],
      setWorkspaces: () => {},
      getSelectedWorkspaceFile: () => '',
      setSelectedWorkspaceFile: () => {},
      setSelectedWorkspaceFolder: () => {},
      getSelectedModel: () => 'auto',
      readChatBufferForChatRestore: () => null,
      updateFolderSelect: () => {},
      renderModelSelectOptions: () => {},
      renderChatList: () => {},
      updateChatBarSelect: () => {},
      selectChat: () => {},
      syncBackgroundChatConnections: () => {},
      bindChatVisibilityAndReconnect: () => {},
      startChatBackgroundMonitor: () => {},
      startGlobalChatPingLoop: () => {},
      ensureChatConnection: () => {},
      teardownBlockedChatRuntime: () => {},
      teardownChatRuntime: () => {},
      openTerminal: () => {},
      getChatsForCurrentWorkspace: () => chats,
      setChatStatus: () => {},
      getBootActivitySession: () => session,
      onArchiveCatalogHydrate: async () => {},
      invalidateArchiveCatalog: () => {},
    }),
  };
}

__resetChatBootListHydrationControllerForTest();

{
  let getChatsCalls = 0;
  let resolveLive;
  const livePromise = new Promise((resolve) => {
    resolveLive = resolve;
  });
  const scopes = [];
  const { chats, controller } = makeController({
    getChatsApi: (query) => {
      getChatsCalls += 1;
      scopes.push(query?.includeArchived === true ? 'full' : 'live');
      if (getChatsCalls === 1) return livePromise;
      return Promise.resolve({
        ok: true,
        fullIndex: true,
        chats: [{ id: 'arch-1', title: 'Archived', archivedAt: '2026-02-01T00:00:00.000Z' }],
        archivedCounts: {},
      });
    },
  });
  const liveLoad = controller.loadChatsFromServer({ skipAutoSelect: true });
  const archiveLoad = controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(getChatsCalls, 1, 'live GET stays in flight; archive queues follow-up');
  resolveLive({
    ok: true,
    chats: [{ id: 'live-1', title: 'Live', archivedAt: '2026-01-01T00:00:00.000Z' }],
  });
  await Promise.all([liveLoad, archiveLoad]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getChatsCalls, 2, 'archive open gets its own full GET after live completes');
  assert.deepEqual(scopes, ['live', 'full']);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, 'arch-1', 'stale live response must not win over full refresh');
}

__resetChatBootListHydrationControllerForTest();

{
  let getChatsCalls = 0;
  const { controller } = makeController({
    getChatsApi: () => {
      getChatsCalls += 1;
      return Promise.resolve({ ok: true, fullIndex: true, chats: [{ id: 'x', title: 'X' }] });
    },
  });
  await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(getChatsCalls, 1);
  controller.invalidateListLoadFreshness();
  await controller.loadChatsFromServer({
    includeArchived: true,
    skipAutoSelect: true,
    forceRefresh: true,
  });
  assert.equal(getChatsCalls, 2, 'forceRefresh after completed full scope still fetches');
}

__resetChatBootListHydrationControllerForTest();

{
  let getChatsCalls = 0;
  let resolveSlow;
  const slow = new Promise((resolve) => {
    resolveSlow = resolve;
  });
  const { chats, controller, setSession } = makeController({
    getChatsApi: () => {
      getChatsCalls += 1;
      return slow;
    },
  });
  const load = controller.loadChatsFromServer({ skipAutoSelect: true });
  setSession({ sessionId: 'after-logout', generation: 2 });
  controller.invalidateListLoadFreshness();
  resolveSlow({
    ok: true,
    chats: [{ id: 'stale-session', title: 'Stale' }],
  });
  await load;
  assert.equal(chats.length, 0, 'stale GET after session change must not apply chats');
  assert.equal(getChatsCalls, 1);
}

__resetChatBootListHydrationControllerForTest();

{
  let session = { sessionId: 'cat-s1', generation: 1 };
  let resolveIdb;
  const idbPromise = new Promise((resolve) => {
    resolveIdb = resolve;
  });
  const catalog = createChatArchiveCatalog({
    getChats: () => [],
    getSession: () => session,
    listIdbArchived: () => idbPromise,
  });
  const loadRows = catalog.ensureIdbArchivedRows();
  session = { sessionId: 'cat-s2', generation: 2 };
  resolveIdb([{ id: 'idb-a', title: 'IDB', archivedAt: '2026-01-01', archivedFlag: 1 }]);
  const rows = await loadRows;
  assert.equal(rows.length, 0, 'IDB rows discarded when session changed before apply');
  assert.equal(catalog.getMergedArchiveCatalog().length, 0);
}

__resetChatBootListHydrationControllerForTest();

{
  let getChatsCalls = 0;
  let resolveLive;
  const livePromise = new Promise((resolve) => {
    resolveLive = resolve;
  });
  const now = { t: 10_000 };
  const originalDateNow = Date.now;
  Date.now = () => now.t;
  try {
    const { controller } = makeController({
      getChatsApi: () => {
        getChatsCalls += 1;
        if (getChatsCalls === 1) return livePromise;
        return Promise.resolve({
          ok: true,
          fullIndex: true,
          chats: [{ id: 'f', title: 'Full' }],
        });
      },
    });
    const first = controller.loadChatsFromServer({ skipAutoSelect: true });
    controller.loadChatsFromServer({ skipAutoSelect: true, skipIfInFlight: true });
    resolveLive({ ok: true, chats: [{ id: 'l', title: 'Live' }] });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(getChatsCalls, 1, 'join-in-flight live does not leave a stray pending full GET');
    now.t += CHAT_LIST_FULL_INDEX_FRESH_MS + 1;
    await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
    assert.equal(getChatsCalls, 2, 'later archive open is not blocked by leaked pending');
  } finally {
    Date.now = originalDateNow;
  }
}

__resetChatBootListHydrationControllerForTest();

{
  const { chats, controller } = makeController({
    getChatsApi: () => Promise.resolve({
      ok: true,
      fullIndex: true,
      chats: [{ id: 'small-1', title: 'Small list' }],
    }),
  });
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, 'small-1', 'fresh GET (≤64 rows) must commit after response bump');
}

__resetChatBootListHydrationControllerForTest();

{
  const many = [];
  for (let index = 0; index < 100; index += 1) {
    many.push({ id: `wide-${index}`, title: `Row ${index}`, updatedAt: '2026-01-01T00:00:00.000Z' });
  }
  const { chats, controller } = makeController({
    getChatsApi: () => Promise.resolve({ ok: true, fullIndex: true, chats: many }),
  });
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.equal(chats.length, 100, 'fresh GET (>64 rows) must commit sliced reconcile');
  assert.equal(chats[0].id, 'wide-0');
}

console.log('chat-list-load-scope-guard.test.js OK');
