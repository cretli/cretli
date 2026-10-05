import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { broadcastSidebarLayout, __clearChatListUpdateClientsForTest, subscribeChatListUpdates } from '../lib/chat-list-updates.js';
import {
  loadSidebarLayout,
  patchSidebarLayout,
  sanitizeSidebarLayoutList,
} from '../lib/persist/sidebar-layout.js';
import { registerSidebarLayoutRoutes } from '../lib/routes/sidebar-layout-routes.js';
import {
  __resetSidebarLayoutSyncForTest,
  applyRemoteSidebarLayout,
  buildSidebarLayoutUpload,
  configureSidebarLayoutSync,
  flushSidebarLayoutSync,
  publishSidebarLayout,
} from '../app_front/features/sidebar/sidebarLayoutSync.js';

function layoutFile() {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'cr-sidebar-layout-')), 'sidebar-layout.json');
}

function socket() {
  const messages = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    messages,
    send: (payload) => messages.push(JSON.parse(payload)),
  });
}

test('sanitizeSidebarLayoutList drops blanks, duplicates, and paths trailing slash', () => {
  assert.deepEqual(
    sanitizeSidebarLayoutList('workspaceOrder', [' /a/b/ ', '/a/b', '', 'c']),
    ['/a/b', 'c']
  );
  assert.deepEqual(sanitizeSidebarLayoutList('chatOrder', ['a', 'a', ' b ']), ['a', 'b']);
});

test('patchSidebarLayout replaces one field and keeps the others', () => {
  const filePath = layoutFile();
  const first = patchSidebarLayout({
    chatOrder: ['c1', 'c2'],
    favoriteChatIds: ['c2'],
  }, filePath);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  const second = patchSidebarLayout({ collapsedWorkspaces: ['/work'] }, filePath);
  assert.equal(second.ok, true);
  assert.deepEqual(second.layout.chatOrder, ['c1', 'c2']);
  assert.deepEqual(second.layout.favoriteChatIds, ['c2']);
  assert.deepEqual(second.layout.collapsedWorkspaces, ['/work']);
  assert.ok(second.layout.updatedAt);
  assert.deepEqual(loadSidebarLayout(filePath).chatOrder, ['c1', 'c2']);
});

test('patchSidebarLayout rejects a non-array field without writing', () => {
  const filePath = layoutFile();
  patchSidebarLayout({ chatOrder: ['a'] }, filePath);
  const rejected = patchSidebarLayout({ chatOrder: 'a' }, filePath);
  assert.equal(rejected.ok, false);
  assert.deepEqual(loadSidebarLayout(filePath).chatOrder, ['a']);
});

test('broadcastSidebarLayout sends the layout frame to chat-list subscribers', () => {
  __clearChatListUpdateClientsForTest();
  const viewer = socket();
  subscribeChatListUpdates(viewer);
  broadcastSidebarLayout({
    updatedAt: '2026-10-05T00:00:00.000Z',
    chatOrder: ['b', 'a'],
    workspaceOrder: ['/w'],
    favoriteChatIds: ['b'],
    collapsedWorkspaces: [],
    subchatExpanded: ['parent'],
    archiveOpen: [],
  });
  assert.equal(viewer.messages.at(-1).type, 'sidebarLayout');
  assert.deepEqual(viewer.messages.at(-1).chatOrder, ['b', 'a']);
  assert.deepEqual(viewer.messages.at(-1).subchatExpanded, ['parent']);
  __clearChatListUpdateClientsForTest();
});

test('PATCH /api/sidebar-layout broadcasts after a change', () => {
  __clearChatListUpdateClientsForTest();
  const viewer = socket();
  subscribeChatListUpdates(viewer);
  /** @type {Record<string, Function>} */
  const handlers = {};
  const app = {
    get(route, handler) { handlers[`GET ${route}`] = handler; },
    patch(route, handler) { handlers[`PATCH ${route}`] = handler; },
  };
  registerSidebarLayoutRoutes(app);
  let status = 0;
  let body = null;
  handlers['PATCH /api/sidebar-layout']({
    body: { chatOrder: ['z'] },
  }, {
    status(code) { status = code; return this; },
    json(payload) { body = payload; },
  });
  assert.equal(status, 0);
  assert.equal(body.ok, true);
  assert.deepEqual(body.chatOrder, ['z']);
  assert.equal(viewer.messages.at(-1).type, 'sidebarLayout');
  assert.deepEqual(viewer.messages.at(-1).chatOrder, ['z']);
  __clearChatListUpdateClientsForTest();
});

test('buildSidebarLayoutUpload copies local lists only while the server field is empty', () => {
  const upload = buildSidebarLayoutUpload(
    { chatOrder: [], favoriteChatIds: ['keep'] },
    { chatOrder: ['local'], favoriteChatIds: ['other'] },
    false
  );
  assert.deepEqual(upload, { chatOrder: ['local'] });
  assert.equal(buildSidebarLayoutUpload({ chatOrder: [] }, { chatOrder: ['local'] }, true), null);
});

test('applyRemoteSidebarLayout does not publish a second save', async () => {
  const patches = [];
  const applied = [];
  __resetSidebarLayoutSyncForTest();
  configureSidebarLayoutSync({
    apply: (layout) => {
      applied.push(layout);
      publishSidebarLayout({ chatOrder: layout.chatOrder });
    },
    patchLayout: async (body) => {
      patches.push(body);
      return { ok: true, updatedAt: '2026-10-05T01:00:00.000Z', ...body };
    },
    setTimeoutFn: (fn) => {
      fn();
      return 1;
    },
  });
  applyRemoteSidebarLayout({
    type: 'sidebarLayout',
    updatedAt: '2026-10-05T01:00:00.000Z',
    chatOrder: ['remote'],
  });
  await flushSidebarLayoutSync();
  assert.deepEqual(applied, [{ chatOrder: ['remote'] }]);
  assert.deepEqual(patches, []);
  applyRemoteSidebarLayout({
    type: 'sidebarLayout',
    updatedAt: '2026-10-05T00:00:00.000Z',
    chatOrder: ['stale'],
  });
  assert.deepEqual(applied, [{ chatOrder: ['remote'] }]);
  __resetSidebarLayoutSyncForTest();
});
