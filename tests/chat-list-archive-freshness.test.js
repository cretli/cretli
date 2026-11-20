/**
 * Task 7.1 — rapid archive re-open joins in-flight / skips redundant full GET.
 */
import assert from 'node:assert/strict';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { __resetChatBootListHydrationControllerForTest } from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';
import { CHAT_LIST_FULL_INDEX_FRESH_MS } from '../app_front/features/chat/chatListLoadFreshness.js';

function makeController(getChatsApi) {
  const chats = [];
  return {
    chats,
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
      getBootActivitySession: () => ({ sessionId: 'test-session', generation: 1 }),
      onArchiveCatalogHydrate: async () => {},
      invalidateArchiveCatalog: () => {},
    }),
  };
}

__resetChatBootListHydrationControllerForTest();

{
  let getChatsCalls = 0;
  let resolveFirst;
  const firstPromise = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const { controller } = makeController(() => {
    getChatsCalls += 1;
    return firstPromise;
  });
  const first = controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  const second = controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(getChatsCalls, 1, 'two rapid archive opens share one GET');
  resolveFirst({
    ok: true,
    fullIndex: true,
    chats: [{ id: 'a', title: 'A', archivedAt: '2026-01-01' }],
    archivedCounts: {},
  });
  await Promise.all([first, second]);
  await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(getChatsCalls, 1, 'immediate re-open inside TTL skips second GET');
}

__resetChatBootListHydrationControllerForTest();

{
  let getChatsCalls = 0;
  const now = { t: 5000 };
  const originalDateNow = Date.now;
  Date.now = () => now.t;
  try {
    const { controller } = makeController(() => {
      getChatsCalls += 1;
      return Promise.resolve({
        ok: true,
        fullIndex: true,
        chats: [{ id: 'b', title: 'B' }],
      });
    });
    await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
    assert.equal(getChatsCalls, 1);
    now.t += CHAT_LIST_FULL_INDEX_FRESH_MS + 5;
    await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
    assert.equal(getChatsCalls, 2, 'after TTL a new full GET is required');
  } finally {
    Date.now = originalDateNow;
  }
}

__resetChatBootListHydrationControllerForTest();

{
  let getChatsCalls = 0;
  const { controller } = makeController(() => {
    getChatsCalls += 1;
    return Promise.resolve({ ok: true, chats: [{ id: 'c', title: 'C' }] });
  });
  await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  controller.invalidateListLoadFreshness();
  await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(getChatsCalls, 2, 'session invalidation forces refresh');
}

console.log('chat-list-archive-freshness.test.js OK');
