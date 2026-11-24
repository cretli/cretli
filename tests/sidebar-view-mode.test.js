import assert from 'node:assert/strict';

// Minimal localStorage for the persistence helpers.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};

const { readViewMode, writeViewMode, invalidateViewModeCache, SIDEBAR_VIEW_MODE_KEY } = await import('../app_front/features/sidebar/state/sidebarPersistence.js');
const { sortChatsByOpened } = await import('../app_front/features/sidebar/sidebarOpenedOrder.js');
const { renderWorkspaceMarkerHtml, ALL_CHATS_KEY } = await import('../app_front/features/sidebar/sidebarWorkspaceMarker.js');

// Default mode and validation.
assert.equal(readViewMode(), 'workspaces');
writeViewMode('agents');
assert.equal(readViewMode(), 'agents');
writeViewMode('bogus');
assert.equal(readViewMode(), 'agents', 'an invalid mode is ignored');

// Migration: the old flat flag becomes the "all" mode once, and the old keys are dropped.
store.clear();
invalidateViewModeCache();
store.set('cretli-sidebar-recent-flat', '1');
store.set('cretli-sidebar-recent-collapsed', '1');
assert.equal(readViewMode(), 'all');
assert.equal(store.has('cretli-sidebar-recent-flat'), false);
assert.equal(store.has('cretli-sidebar-recent-collapsed'), false);
assert.ok([...store.keys()].some((key) => key.includes('sidebar-view-mode')) || SIDEBAR_VIEW_MODE_KEY);
store.clear();
invalidateViewModeCache();
assert.equal(readViewMode(), 'workspaces', 'no legacy flag migrates to the grouped view');

// Order: last opened (server lastSeenAt) first, then server change time; favorites optional.
const chats = [
  { id: 'old', updatedAt: '2026-10-01T00:00:00Z' },
  { id: 'opened', lastSeenAt: '2026-11-24T10:00:00Z', updatedAt: '2026-10-02T00:00:00Z' },
  { id: 'changed', updatedAt: '2026-11-01T00:00:00Z' },
  { id: 'fav', updatedAt: '2026-09-01T00:00:00Z' },
];
assert.deepEqual(sortChatsByOpened(chats).map((chat) => chat.id), ['opened', 'changed', 'old', 'fav']);
assert.deepEqual(sortChatsByOpened(chats, (chat) => chat.id === 'fav').map((chat) => chat.id)[0], 'fav');

// Marker: emoji icon or colour dot, unknown colours ignored, markup escaped.
const esc = (value) => String(value).replace(/</g, '&lt;');
assert.match(renderWorkspaceMarkerHtml({ color: 'blue' }, esc), /ws-color-blue/);
assert.match(renderWorkspaceMarkerHtml({ icon: '🚀', color: 'neon' }, esc), /has-icon[^>]*>🚀</);
assert.doesNotMatch(renderWorkspaceMarkerHtml({ color: 'neon' }, esc), /ws-color-/);
assert.equal(typeof ALL_CHATS_KEY, 'string');

// The virtual flat workspace owns every chat, has no archive section and is matched per chat workspace.
const { createSidebarSearchService } = await import('../app_front/features/sidebar/services/sidebarSearchService.js');
const allChats = [
  { id: 'a', title: 'Alpha', workspaceFile: '/w/one.code-workspace', workspaceFolder: '/w/one', updatedAt: '2026-11-01T00:00:00Z' },
  { id: 'b', title: 'Beta', workspaceFile: '/w/two.code-workspace', workspaceFolder: '/w/two', lastSeenAt: '2026-11-24T10:00:00Z' },
  { id: 'w', title: 'Watcher', watcherPinned: true, workspaceFolder: '/w/one' },
];
const workspaces = [
  { sidebarKey: '/w/one.code-workspace', workspaceFile: '/w/one.code-workspace', name: 'One', workspaceFolder: '/w/one' },
  { sidebarKey: '/w/two.code-workspace', workspaceFile: '/w/two.code-workspace', name: 'Two', workspaceFolder: '/w/two' },
];
const service = createSidebarSearchService({
  getChats: () => allChats,
  getWorkspaces: () => workspaces,
  getActiveChatId: () => '',
  getPreferredWorkspaceFolder: () => '',
  readSidebarOnlyWorktreeFlag: () => false,
  orderedChats: (list) => list,
  getArchivedCounts: () => ({ 'x\ny': 7 }),
  normalizePath: (value) => String(value || '').replace(/\\/g, '/'),
});
const flat = { sidebarKey: ALL_CHATS_KEY, workspaceFile: ALL_CHATS_KEY, name: 'All chats', isAllChats: true };
assert.deepEqual(service.visibleChatsForWorkspace(flat).map((chat) => chat.id), ['b', 'a'], 'opened first, watcher chat excluded');
assert.equal(service.archivedCountForWorkspace(flat), 0, 'no archive section in the flat view');
service.setQuery('two');
assert.deepEqual(service.visibleChatsForWorkspace(flat).map((chat) => chat.id), ['b'], 'search matches the chat workspace name');
service.setQuery('');

console.log('sidebar-view-mode.test.js: ok');
