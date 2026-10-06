/**
 * Task 2.1 — activity prune only on server-declared full index.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFullChatListIndexForServer,
  shouldPruneChatActivityFromListResponse,
} from '../lib/chat-list-payload.js';
import { createChatController } from '../app_front/features/chat/chatController.js';
import {
  __resetChatActivityStoreForTest,
  getChatActivityStore,
} from '../app_front/features/chat/chatActivityStore.js';

test('shouldPruneChatActivityFromListResponse requires fullIndex and non-empty chats', () => {
  assert.equal(shouldPruneChatActivityFromListResponse(null), false);
  assert.equal(shouldPruneChatActivityFromListResponse({ ok: true, chats: [{ id: 'a' }] }), false);
  assert.equal(shouldPruneChatActivityFromListResponse({ fullIndex: true, chats: [] }), false);
  assert.equal(shouldPruneChatActivityFromListResponse({ fullIndex: false, chats: [{ id: 'a' }] }), false);
  assert.equal(shouldPruneChatActivityFromListResponse({ fullIndex: true, chats: [{ id: 'a' }] }), true);
});

test('isFullChatListIndexForServer excludes widget and pinned lookups', () => {
  assert.equal(isFullChatListIndexForServer({ query: {} }, true), true);
  assert.equal(isFullChatListIndexForServer({ query: {} }, false), false);
  assert.equal(isFullChatListIndexForServer({ widgetAccess: { installationId: 'w' }, query: {} }, true), false);
  assert.equal(isFullChatListIndexForServer({ query: { pinnedTo: 'https://example.com' } }, true), false);
});

function createPruneHarness(getChatsResponse) {
  const chats = [];
  const controller = createChatController({
    api: {
      getChats: () => Promise.resolve(getChatsResponse()),
    },
    CHAT_BUFFER_MAX: 100,
    LAST_CHAT_ID_KEY: 'last',
    getChats: () => chats,
    getActiveChatId: () => '',
    setActiveChatId: () => {},
    getWorkspaces: () => [],
    setWorkspaces: () => {},
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFolder: () => '',
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
  });
  return { controller, chats };
}

test('loadChatsFromServer prunes only when fullIndex is true', async () => {
  __resetChatActivityStoreForTest();
  const store = getChatActivityStore();
  store.recordActivity('keep', 100);
  store.recordActivity('drop', 200);
  const { controller } = createPruneHarness(() => ({
    ok: true,
    fullIndex: true,
    chats: [{ id: 'keep', title: 'Keep' }],
  }));
  await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(store.getActivityAt('keep'), 100);
  assert.equal(store.getActivityAt('drop'), 0);
  __resetChatActivityStoreForTest();
});

test('widget-scoped list response does not prune activity', async () => {
  __resetChatActivityStoreForTest();
  const store = getChatActivityStore();
  store.recordActivity('inScope', 100);
  store.recordActivity('outOfScope', 300);
  const { controller } = createPruneHarness(() => ({
    ok: true,
    fullIndex: false,
    chats: [{ id: 'inScope', title: 'Widget' }],
  }));
  await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(store.getActivityAt('inScope'), 100);
  assert.equal(store.getActivityAt('outOfScope'), 300, 'partial index keeps unknown activity');
  __resetChatActivityStoreForTest();
});

test('partial snapshot without fullIndex flag does not prune', async () => {
  __resetChatActivityStoreForTest();
  const store = getChatActivityStore();
  store.recordActivity('loaded', 50);
  store.recordActivity('notLoaded', 150);
  const { controller } = createPruneHarness(() => ({
    ok: true,
    chats: [{ id: 'loaded', title: 'Boot' }],
  }));
  await controller.loadChatsFromServer({ includeArchived: true, skipAutoSelect: true });
  assert.equal(store.getActivityAt('notLoaded'), 150);
  __resetChatActivityStoreForTest();
});
