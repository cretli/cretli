import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDEBAR_VISIBLE_CHAT_LIMIT,
  capSidebarVisibleTreeChats,
  shouldSerializeWorkspaceChatList,
} from '../app_front/features/sidebar/sidebarVisibleChats.js';
import {
  mapChatForClientList,
  mapChatsForClientList,
  buildChatsListApiQuery,
  countArchivedChatsByWorkspace,
  mergeChatListLoadQuery,
} from '../lib/chat-list-payload.js';
import { resolveBackgroundHttpBatchSize } from '../app_front/features/chat/chatWsReconnectPolicy.js';

test('capSidebarVisibleTreeChats keeps the prefix and the active ancestor chain', () => {
  const tree = Array.from({ length: 50 }, (_, index) => ({
    chat: { id: `c${index}` },
    parentId: index === 49 ? 'c0' : '',
  }));
  const capped = capSidebarVisibleTreeChats(tree, { limit: 5, activeChatId: 'c49' });
  assert.equal(capped.items.some((row) => row.chat.id === 'c0'), true);
  assert.equal(capped.items.some((row) => row.chat.id === 'c49'), true);
  assert.equal(capped.hidden, 50 - capped.items.length);
  assert.ok(capped.items.length <= 6);
});

test('capSidebarVisibleTreeChats showAll returns the full tree', () => {
  const tree = [{ chat: { id: 'a' } }, { chat: { id: 'b' } }];
  const capped = capSidebarVisibleTreeChats(tree, { limit: 1, showAll: true });
  assert.equal(capped.items.length, 2);
  assert.equal(capped.hidden, 0);
  assert.equal(SIDEBAR_VISIBLE_CHAT_LIMIT, 40);
});

test('collapsed workspace groups skip chat-row HTML', () => {
  assert.equal(shouldSerializeWorkspaceChatList(true, false), false);
  assert.equal(shouldSerializeWorkspaceChatList(true, true), true);
  assert.equal(shouldSerializeWorkspaceChatList(false, false), true);
});

test('capSidebarVisibleTreeChats keeps a subchat-group header with its parent', () => {
  const tree = [
    { chat: { id: 'p' }, parentId: '', level: 0, isLastChild: false },
    { isGroup: true, parentId: 'p', id: 'subchat-group:p', level: 1, isLastChild: false },
    { chat: { id: 'c1' }, parentId: 'p', level: 1, isLastChild: true },
  ];
  const capped = capSidebarVisibleTreeChats(tree, { limit: 10 });
  assert.deepEqual(
    capped.items.map((row) => (row.isGroup ? row.id : row.chat.id)),
    ['p', 'subchat-group:p', 'c1']
  );
  assert.equal(capped.hidden, 0);
});

test('capSidebarVisibleTreeChats drops a group header when its parent fell outside the cap', () => {
  const tree = [
    { chat: { id: 'a' }, parentId: '', level: 0, isLastChild: false },
    { chat: { id: 'b' }, parentId: '', level: 0, isLastChild: false },
    { chat: { id: 'p' }, parentId: '', level: 0, isLastChild: false },
    { isGroup: true, parentId: 'p', id: 'subchat-group:p', level: 1, isLastChild: false },
    { chat: { id: 'c1' }, parentId: 'p', level: 1, isLastChild: true },
  ];
  const capped = capSidebarVisibleTreeChats(tree, { limit: 2 });
  assert.deepEqual(capped.items.map((row) => (row.isGroup ? row.id : row.chat.id)), ['a', 'b']);
});

test('mapChatForClientList omits summaries unless requested', () => {
  const chat = { id: '1', title: 'A', summaries: [{ summary: 'long' }] };
  const slim = mapChatForClientList(chat);
  assert.equal(slim.summaries, undefined);
  assert.equal(chat.summaries.length, 1);
  assert.equal(mapChatForClientList(chat, { includeSummaries: true }).summaries.length, 1);
  assert.equal(mapChatsForClientList([chat]).length, 1);
});

test('background HTTP history batch is larger than the WS reconnect batch', () => {
  assert.equal(resolveBackgroundHttpBatchSize(false), 16);
  assert.equal(resolveBackgroundHttpBatchSize(true), 8);
});

test('buildChatsListApiQuery archives only when opted in', () => {
  assert.deepEqual(buildChatsListApiQuery({}), {});
  assert.deepEqual(buildChatsListApiQuery({ includeArchived: false }), {});
  assert.deepEqual(buildChatsListApiQuery({ includeArchived: true, pinnedTo: ' https://a ' }), {
    pinnedTo: 'https://a',
    includeArchived: true,
  });
});

test('countArchivedChatsByWorkspace keys by file and folder', () => {
  const counts = countArchivedChatsByWorkspace([
    { id: '1', archivedAt: '2026-01-01', workspaceFile: '/a', workspaceFolder: '/a/app' },
    { id: '2', archivedAt: '2026-01-02', workspaceFile: '/a', workspaceFolder: '/a/app' },
    { id: '3', workspaceFile: '/a', workspaceFolder: '/a/app' },
  ]);
  assert.equal(counts['/a\n/a/app'], 2);
});

test('mergeChatListLoadQuery unions archived and keeps preferChatId', () => {
  const merged = mergeChatListLoadQuery(
    { preferChatId: 'boot', skipAutoSelect: false },
    { skipIfInFlight: true, skipAutoSelect: true }
  );
  assert.equal(merged.preferChatId, 'boot');
  assert.equal(merged.skipAutoSelect, false);
  assert.equal(merged.includeArchived, false);
  const archived = mergeChatListLoadQuery(
    { skipAutoSelect: true },
    { includeArchived: true, skipAutoSelect: true }
  );
  assert.equal(archived.includeArchived, true);
  assert.equal(archived.skipAutoSelect, true);
});
