import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSidebarSortMode,
  sortChatsForSidebar,
  filterChatsToFavorites,
} from '../app_front/features/sidebar/sidebarListSort.js';

const chats = [
  { id: 'a', title: 'beta 10', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
  { id: 'b', title: 'Alpha', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z' },
  { id: 'c', title: 'beta 2', createdAt: '2026-01-15T00:00:00Z', updatedAt: '2026-01-16T00:00:00Z' },
];
const ids = (list) => list.map((c) => c.id).join('');

test('unknown sort mode falls back to created', () => {
  assert.equal(normalizeSidebarSortMode('nope'), 'created');
  assert.equal(normalizeSidebarSortMode('title'), 'title');
});

test('sort modes order the list and favorites lead', () => {
  assert.equal(ids(sortChatsForSidebar(chats, 'created')), 'bca');
  assert.equal(ids(sortChatsForSidebar(chats, 'updated')), 'abc');
  assert.equal(ids(sortChatsForSidebar(chats, 'title')), 'bca');
  assert.equal(ids(sortChatsForSidebar(chats, 'updated', (c) => c.id === 'c')), 'cab');
});

test('favorites filter keeps the open chat and fork ancestors', () => {
  const list = [
    { id: 'p', title: 'p' },
    { id: 'k', title: 'k', forkParentChatId: 'p' },
    { id: 'x', title: 'x' },
    { id: 'open', title: 'open' },
  ];
  const kept = filterChatsToFavorites(list, { isFavorite: (c) => c.id === 'k', activeChatId: 'open' });
  assert.deepEqual(kept.map((c) => c.id), ['p', 'k', 'open']);
});

test('active-use filter counts recently used chats, not only running ones', async () => {
  const { isChatInActiveUse } = await import('../app_front/features/sidebar/sidebarOnlyActiveFilter.js');
  const now = 10_000_000;
  const deps = (live, at) => ({ isLive: () => live, getActivityAt: () => at, now });
  assert.equal(isChatInActiveUse({}, deps(true, 0)), true);
  assert.equal(isChatInActiveUse({}, deps(false, now - 60_000)), true);
  assert.equal(isChatInActiveUse({}, deps(false, now - 3 * 3_600_000)), false);
  assert.equal(isChatInActiveUse({}, deps(false, 0)), false);
});

test('filters keep the open subchat, its cross-workspace parent and their workspaces', async () => {
  const f = await import('../app_front/features/sidebar/sidebarOnlyActiveFilter.js');
  const chats = [
    { id: 'parent', workspaceFolder: '/a' },
    { id: 'sub', workspaceFolder: '/b', forkParentChatId: 'parent' },
    { id: 'other', workspaceFolder: '/a' },
  ];
  const chain = f.collectActiveChatChain(chats, 'sub');
  assert.deepEqual([...chain].sort(), ['parent', 'sub']);
  const kept = f.filterChatsToLive(chats.filter((c) => c.workspaceFolder === '/a'), {
    isLive: () => false, activeChatId: 'sub', keepIds: chain,
  });
  assert.deepEqual(kept.map((c) => c.id), ['parent']);
  const ws = [{ sidebarKey: 'a', workspaceFolder: '/a' }, { sidebarKey: 'b', workspaceFolder: '/b' }, { sidebarKey: 'c', workspaceFolder: '/c' }];
  const out = f.filterWorkspacesByActiveWorkspace(ws, {
    enabled: true, searching: false, activeWorkspaceFolder: '/b',
    getPreferredWorkspaceFolder: () => '', keepWorkspace: (w) => w.sidebarKey === 'a',
  });
  assert.deepEqual(out.workspaces.map((w) => w.sidebarKey), ['a', 'b']);
});
