/**
 * An archived chat opened by the user survives list reloads: it is never an auto-select
 * candidate, and a live-only GET must not swap it or empty the open archive section.
 */
import assert from 'node:assert/strict';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { __resetChatBootListHydrationControllerForTest } from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';
import { isPendingSummaryForkChat } from '../app_front/features/chat/chatBackgroundPolicy.js';
import { createChatArchiveCatalog } from '../app_front/features/chat/chatArchiveCatalog.js';
import { retainArchivedRowsAfterLiveLoad } from '../app_front/features/chat/chatListScopedArchiveMerge.js';

const row = (id, extra = {}) => ({
  id, title: id, workspaceFile: '/w/a.code-workspace', workspaceFolder: '/w/a', ...extra,
});
const live = row('live');
const archivedOpen = row('archived-open', { archivedAt: '2026-10-01T00:00:00.000Z' });
const archivedOther = row('archived-other', { archivedAt: '2026-10-01T00:00:00.000Z' });

function makeHarness(activeId, extraDeps = {}) {
  __resetChatBootListHydrationControllerForTest();
  const state = { chats: [{ ...live }, { ...archivedOpen }, { ...archivedOther }], activeId, selected: [] };
  const controller = createChatController({
    api: { getChats: async () => ({ ok: true, chats: [{ ...live }], archivedCounts: {} }) },
    CHAT_BUFFER_MAX: 100,
    LAST_CHAT_ID_KEY: 'last',
    getChats: () => state.chats,
    getActiveChatId: () => state.activeId,
    setActiveChatId: (id) => { state.activeId = id; },
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
    selectChat: (id) => { state.selected.push(id); },
    syncBackgroundChatConnections: () => {},
    bindChatVisibilityAndReconnect: () => {},
    startChatBackgroundMonitor: () => {},
    startGlobalChatPingLoop: () => {},
    hydratePresenceChat: () => false,
    getChatsForCurrentWorkspace: () => state.chats.filter((chat) => !chat.archivedAt),
    setChatStatus: () => {},
    ...extraDeps,
  });
  return { state, controller };
}

// A live list load keeps the open archived chat active and the archive rows loaded.
{
  const { state, controller } = makeHarness('archived-open');
  await controller.loadChatsFromServer({ skipIfInFlight: true });
  assert.equal(state.activeId, 'archived-open');
  assert.deepEqual(state.selected, ['archived-open']);
  assert.deepEqual(state.chats.map((chat) => chat.id), ['live', 'archived-open', 'archived-other']);
}

// A workspace refresh keeps an archived chat of that workspace open.
{
  const { state, controller } = makeHarness('archived-open', {
    getArchivedChatsForCurrentWorkspace: () => state2().chats.filter((chat) => chat.archivedAt),
  });
  function state2() { return state; }
  controller.refreshChatListForWorkspace();
  assert.equal(state.activeId, 'archived-open');
  assert.deepEqual(state.selected, []);
}

// An archived chat of another workspace still yields to that workspace's live chat.
{
  const { state, controller } = makeHarness('archived-open', {
    getArchivedChatsForCurrentWorkspace: () => [],
  });
  controller.refreshChatListForWorkspace();
  assert.equal(state.activeId, 'live');
}

// Retention keeps server rows, skips duplicates, live rows and unconfirmed boot-cache rows.
{
  const server = [row('b')];
  const merged = retainArchivedRowsAfterLiveLoad(
    [row('a'), row('b', { archivedAt: 'x' }), row('c', { archivedAt: 'x' }), row('d', { archivedAt: 'x', _fromBootCache: true })],
    server,
  );
  assert.deepEqual(merged.map((chat) => chat.id), ['b', 'c']);
  assert.equal(retainArchivedRowsAfterLiveLoad([row('a')], server), server);
}

// A finished, archived summary fork must not take a background socket once the index loads.
{
  const fork = { id: 'f', cursorSessionId: 's', isTemporary: true, forkKind: 'summary' };
  assert.equal(isPendingSummaryForkChat(fork), true);
  assert.equal(isPendingSummaryForkChat({ ...fork, archivedAt: '2026-10-01T00:00:00.000Z' }), false);
}

// Search reads archived rows into its catalog; only an opened hit joins the runtime list.
{
  const runtime = [row('live')];
  let fetches = 0;
  let renders = 0;
  const catalog = createChatArchiveCatalog({
    getChats: () => runtime,
    getSession: () => ({}),
    onHydrated: () => { renders += 1; },
    fetchArchivedRows: async () => {
      fetches += 1;
      return [row('archived-a', { archivedAt: 'x' }), row('archived-b', { archivedAt: 'x' })];
    },
  });
  await catalog.refreshSearchCatalog();
  await catalog.refreshSearchCatalog();
  assert.equal(fetches, 1, 'the TTL reuses the catalog');
  assert.equal(renders, 1);
  assert.equal(runtime.length, 1);
  assert.deepEqual(catalog.getArchiveCatalogForWorkspace().map((chat) => chat.id).sort(), ['archived-a', 'archived-b']);
  assert.equal(catalog.adoptCatalogRow('archived-a')._fromArchiveCatalog, true);
  assert.deepEqual(runtime.map((chat) => chat.id), ['live', 'archived-a']);
  assert.equal(catalog.adoptCatalogRow('missing'), null);
}

console.log('chat-archived-open-sticky ok');
