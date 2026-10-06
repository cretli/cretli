import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSidebarView } from '../app_front/features/sidebar/sidebarView.js';
import {
  __resetSidebarLayoutSyncForTest,
  applyRemoteSidebarLayout,
  configureSidebarLayoutSync,
  filterChangedSidebarLayoutFields,
  normalizeSidebarLayoutList,
  pickEffectiveRemoteSidebarLayoutFields,
  publishSidebarLayout,
  sidebarLayoutListsEqual,
} from '../app_front/features/sidebar/sidebarLayoutSync.js';

const here = dirname(fileURLToPath(import.meta.url));
const viewSource = readFileSync(resolve(here, '../app_front/features/sidebar/sidebarView.js'), 'utf8');
const appSource = readFileSync(resolve(here, '../app_front/App.js'), 'utf8');

function installLocalStorageStub() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  return map;
}

function makeTwoWorkspaceView() {
  const workspaces = [
    { name: 'Alpha', workspaceFile: '/a', workspaceFolder: '/a/app', sidebarKey: '/a' },
    { name: 'Beta', workspaceFile: '/b', workspaceFolder: '/b/app', sidebarKey: '/b' },
  ];
  return createSidebarView({
    getWorkspaces: () => workspaces,
    getChats: () => [
      { id: 'c1', title: 'One', workspaceFile: '/a', workspaceFolder: '/a/app' },
      { id: 'c2', title: 'Two', workspaceFile: '/b', workspaceFolder: '/b/app' },
    ],
    getActiveWorkspaceFile: () => '/a',
    getActiveWorkspaceFolder: () => '/a/app',
    getActiveChatId: () => 'c1',
    getArchivedCounts: () => ({ '/a\n/a/app': 2, '/b\n/b/app': 1 }),
    chatFavorites: { isFavorite: () => false },
    resolveChatState: () => 'idle',
    getTerminalStateMeta: () => ({ tone: 'idle', label: 'Idle' }),
    escapeHtml: (v) => String(v ?? ''),
    selectChat: () => {},
    switchWorkspace: () => Promise.resolve(true),
    requestLoadArchivedChats: () => Promise.resolve(),
  });
}

test('normalizeSidebarLayoutList treats collapsed paths as sorted sets', () => {
  assert.deepEqual(
    normalizeSidebarLayoutList('collapsedWorkspaces', ['/b/', '/a']),
    ['/a', '/b'],
  );
  assert.equal(
    sidebarLayoutListsEqual('collapsedWorkspaces', ['/a/'], ['/a']),
    true,
  );
});

test('filterChangedSidebarLayoutFields drops equivalent partial keys', () => {
  const local = { chatOrder: ['c1', 'c2'], archiveOpen: [] };
  const partial = { chatOrder: ['c1', 'c2'], archiveOpen: [] };
  assert.deepEqual(filterChangedSidebarLayoutFields(partial, local), {});
  assert.deepEqual(
    filterChangedSidebarLayoutFields({ archiveOpen: ['/w'] }, local),
    { archiveOpen: ['/w'] },
  );
});

test('identical sidebarLayout echo from two sockets applies once', () => {
  const applied = [];
  /** @type {string[]} */
  let chatOrder = [];
  __resetSidebarLayoutSyncForTest();
  configureSidebarLayoutSync({
    readLocal: () => ({ chatOrder, archiveOpen: [] }),
    apply: (layout) => {
      applied.push(layout);
      if (Array.isArray(layout.chatOrder)) chatOrder = layout.chatOrder;
    },
  });
  const frame = {
    type: 'sidebarLayout',
    updatedAt: '2026-10-06T10:00:00.000Z',
    chatOrder: ['c1'],
  };
  applyRemoteSidebarLayout(frame);
  applyRemoteSidebarLayout({ ...frame });
  assert.equal(applied.length, 1);
  __resetSidebarLayoutSyncForTest();
});

test('equal updatedAt with a partial payload still applies when a field differs', () => {
  const applied = [];
  /** @type {string[]} */
  let archiveOpen = [];
  __resetSidebarLayoutSyncForTest();
  configureSidebarLayoutSync({
    readLocal: () => ({ chatOrder: ['c1'], archiveOpen }),
    apply: (layout) => {
      applied.push(layout);
      if (Array.isArray(layout.archiveOpen)) archiveOpen = layout.archiveOpen;
    },
  });
  applyRemoteSidebarLayout({
    type: 'sidebarLayout',
    updatedAt: '2026-10-06T10:00:00.000Z',
    chatOrder: ['c1'],
    archiveOpen: ['/w'],
  });
  assert.deepEqual(applied, [{ archiveOpen: ['/w'] }]);
  applyRemoteSidebarLayout({
    type: 'sidebarLayout',
    updatedAt: '2026-10-06T10:00:00.000Z',
    archiveOpen: ['/w'],
  });
  assert.equal(applied.length, 1, 'second equal-timestamp echo is a no-op');
  __resetSidebarLayoutSyncForTest();
});

test('pending local layout suppresses remote keys until flush', () => {
  const applied = [];
  __resetSidebarLayoutSyncForTest();
  configureSidebarLayoutSync({
    readLocal: () => ({ chatOrder: ['local'], archiveOpen: [] }),
    apply: (layout) => applied.push(layout),
    setTimeoutFn: () => 1,
  });
  publishSidebarLayout({ chatOrder: ['local'] });
  applyRemoteSidebarLayout({
    type: 'sidebarLayout',
    updatedAt: '2026-10-06T10:30:00.000Z',
    chatOrder: ['remote'],
    archiveOpen: ['/w'],
  });
  assert.deepEqual(applied, [{ archiveOpen: ['/w'] }]);
  __resetSidebarLayoutSyncForTest();
});

test('pickEffectiveRemoteSidebarLayoutFields matches pending merge', () => {
  const fields = pickEffectiveRemoteSidebarLayoutFields(
    { type: 'sidebarLayout', chatOrder: ['r'], subchatExpanded: ['p'] },
    { chatOrder: ['local'] },
  );
  assert.deepEqual(fields, { subchatExpanded: ['p'] });
});

test('applyLayoutSnapshot returns false when remote fields already match local', () => {
  installLocalStorageStub();
  const view = makeTwoWorkspaceView();
  view.applyLayoutSnapshot({ archiveOpen: [] });
  assert.equal(view.applyLayoutSnapshot({ archiveOpen: [] }), false);
  assert.equal(view.applyLayoutSnapshot({ chatOrder: [] }), false);
});

test('forceRerender clears reuse map; render path does not', () => {
  const forceBody = viewSource.slice(
    viewSource.indexOf('function forceRerender'),
    viewSource.indexOf('return {', viewSource.indexOf('function forceRerender')),
  );
  assert.match(forceBody, /renderedWorkspaceNodes\.clear\(\)/);
  const renderBody = viewSource.slice(
    viewSource.indexOf('function render()'),
    viewSource.indexOf('function renderPassBody'),
  );
  assert.doesNotMatch(renderBody, /renderedWorkspaceNodes\.clear\(\)/);
});

test('App layout apply schedules coalesced render instead of forceRerender', () => {
  assert.match(appSource, /let needsRender = sidebarView\.applyLayoutSnapshot\(layout\)/);
  assert.match(appSource, /if \(needsRender\) sidebarView\.scheduleUpdate\(\)/);
  const start = appSource.indexOf('apply: (layout) => {');
  const end = appSource.indexOf('getChatFavoritesStore().setChangeListener', start);
  const block = appSource.slice(start, end);
  assert.doesNotMatch(block, /forceRerender\(\)/);
});

test('toggleArchiveSection uses render without forceRerender', () => {
  const start = viewSource.indexOf('function toggleArchiveSection');
  assert.ok(start >= 0);
  const end = viewSource.indexOf('function toggleSubchatGroup', start);
  const body = viewSource.slice(start, end);
  assert.match(body, /\brender\(\)/);
  assert.doesNotMatch(body, /forceRerender\(\)/);
});

test('scroll and focus are captured before sidebar DOM mutations', () => {
  const start = viewSource.indexOf('function renderPassBody');
  const end = viewSource.indexOf('function buildSidebarNode', start);
  const body = viewSource.slice(start, end);
  const scrollIdx = body.indexOf('scrollTop');
  const reconcileIdx = body.indexOf('reconcileWorkspaceNodes');
  assert.ok(scrollIdx >= 0 && reconcileIdx > scrollIdx, 'scroll read precedes reconcile');
  const focusIdx = body.indexOf('focusInfo');
  assert.ok(focusIdx >= 0 && focusIdx < reconcileIdx, 'focus snapshot precedes reconcile');
});

test('language change still uses forceRerender for translated labels', () => {
  assert.match(
    viewSource,
    /cr-lang-changed[\s\S]{0,120}?forceRerender\(\)/,
    'full label regen stays on language change only',
  );
});
