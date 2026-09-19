import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChatOrder,
  flattenChatsTree,
  isChatArchived,
  isRelatedChatLinkVisible,
  mergeChatOrder,
  partitionChatsByArchive,
  resolveHarnessSwitchNest,
  wouldCreateChatParentCycle,
} from '../lib/chat-tree.js';
import { resolveChatDrop, updateChatNestHold } from '../app_front/features/sidebar/sidebarChatDrop.js';

function chat(id, parent) {
  const row = { id, title: id };
  if (parent) row.forkParentChatId = parent;
  return row;
}

test('flattenChatsTree nests forks one level under the folder root', () => {
  const chats = [chat('root'), chat('child', 'root'), chat('other')];
  const actual = flattenChatsTree(chats).map((row) => [row.chat.id, row.level, row.isLastChild]);
  assert.deepEqual(actual, [
    ['root', 0, false],
    ['child', 1, true],
    ['other', 0, false],
  ]);
});

test('flattenChatsTree nests grandchildren under their parent', () => {
  const chats = [chat('a'), chat('b', 'a'), chat('c', 'b'), chat('d', 'a')];
  const actual = flattenChatsTree(chats).map((row) => [row.chat.id, row.level, row.parentId, row.isLastChild]);
  assert.deepEqual(actual, [
    ['a', 0, '', false],
    ['b', 1, 'a', false],
    ['c', 2, 'b', true],
    ['d', 1, 'a', true],
  ]);
});

test('flattenChatsTree keeps chats deeper than eight levels', () => {
  const chats = [];
  let parent = '';
  for (let i = 0; i < 12; i += 1) {
    const id = `n${i}`;
    chats.push(parent ? chat(id, parent) : chat(id));
    parent = id;
  }
  const actual = flattenChatsTree(chats);
  assert.equal(actual.length, 12);
  assert.equal(actual[11].chat.id, 'n11');
  assert.equal(actual[11].level, 11);
  assert.equal(actual[11].parentId, 'n10');
});
test('isRelatedChatLinkVisible hides archived and missing chats', () => {
  const live = chat('live');
  const archived = { ...chat('old'), archivedAt: '2026-09-19T08:00:00.000Z' };
  assert.equal(isRelatedChatLinkVisible([live, archived], 'live'), true);
  assert.equal(isRelatedChatLinkVisible([live, archived], 'old'), false);
  assert.equal(isRelatedChatLinkVisible([live], 'old'), false);
  assert.equal(isRelatedChatLinkVisible([], 'live'), false);
});

test('partitionChatsByArchive drops archived forks from the live nest tree', () => {
  const root = chat('root');
  const liveChild = chat('live', 'root');
  const archivedChild = { ...chat('old', 'root'), archivedAt: '2026-09-19T08:00:00.000Z' };
  const { live, archived } = partitionChatsByArchive([root, liveChild, archivedChild]);
  assert.equal(isChatArchived(archivedChild), true);
  assert.deepEqual(live.map((row) => row.id), ['root', 'live']);
  assert.deepEqual(archived.map((row) => row.id), ['old']);
  const tree = flattenChatsTree(live).map((row) => [row.chat.id, row.level]);
  assert.deepEqual(tree, [
    ['root', 0],
    ['live', 1],
  ]);
});

test('flattenChatsTree treats a missing parent as a root', () => {
  const chats = [chat('orphan', 'gone'), chat('root')];
  const actual = flattenChatsTree(chats).map((row) => row.chat.id);
  assert.deepEqual(actual, ['orphan', 'root']);
});

test('resolveHarnessSwitchNest hangs a root chat under the new harness chat', () => {
  const actual = resolveHarnessSwitchNest(chat('old'), 'new');
  assert.deepEqual(actual, { childId: 'old', parentId: 'new' });
});

test('resolveHarnessSwitchNest keeps a nested switch in the existing parent', () => {
  const actual = resolveHarnessSwitchNest(chat('child', 'root'), 'new');
  assert.deepEqual(actual, { childId: 'new', parentId: 'root' });
});

test('resolveHarnessSwitchNest returns null when ids are missing or the same', () => {
  assert.equal(resolveHarnessSwitchNest(chat('a'), 'a'), null);
  assert.equal(resolveHarnessSwitchNest(chat('a'), ''), null);
  assert.equal(resolveHarnessSwitchNest(null, 'new'), null);
});

test('wouldCreateChatParentCycle detects self and descendant loops', () => {
  const chats = [chat('a'), chat('b', 'a'), chat('c', 'b')];
  assert.equal(wouldCreateChatParentCycle(chats, 'a', 'a'), true);
  assert.equal(wouldCreateChatParentCycle(chats, 'a', 'c'), true);
  assert.equal(wouldCreateChatParentCycle(chats, 'c', 'a'), false);
  assert.equal(wouldCreateChatParentCycle(chats, 'c', ''), false);
});

test('applyChatOrder keeps unknown chats first then the saved sequence', () => {
  const chats = [chat('new'), chat('b'), chat('a')];
  const actual = applyChatOrder(chats, ['a', 'b']).map((row) => row.id);
  assert.deepEqual(actual, ['new', 'a', 'b']);
});

test('mergeChatOrder replaces one visible list and keeps other ids', () => {
  const previous = ['x', 'a', 'b', 'y'];
  const actual = mergeChatOrder(previous, ['b', 'a']);
  assert.deepEqual(actual, ['x', 'b', 'a', 'y']);
});

test('mergeChatOrder prepends a list that was not in the saved order', () => {
  const actual = mergeChatOrder(['x'], ['a', 'b']);
  assert.deepEqual(actual, ['a', 'b', 'x']);
});

test('resolveChatDrop reorders in the middle of a root until nest is armed', () => {
  const items = [
    { id: 'a', top: 0, bottom: 100, isChild: false },
    { id: 'b', top: 100, bottom: 200, isChild: false },
  ];
  const actual = resolveChatDrop({ items, y: 50, draggedIds: ['b'] });
  assert.equal(actual.mode, 'insert');
  assert.equal(actual.hoveredId, 'a');
  assert.equal(actual.parentChatId, '');
});

test('resolveChatDrop nests onto the hovered chat after nest is armed', () => {
  const items = [
    { id: 'a', top: 0, bottom: 100, isChild: false },
    { id: 'b', top: 100, bottom: 200, isChild: false },
  ];
  const actual = resolveChatDrop({ items, y: 50, draggedIds: ['b'], nestArmed: true });
  assert.equal(actual.mode, 'nest');
  assert.equal(actual.parentChatId, 'a');
  assert.equal(actual.hoveredId, 'a');
  assert.equal(actual.beforeId, null);
});

test('updateChatNestHold arms after the pointer stays on the same chat', () => {
  const started = updateChatNestHold({ hoverId: '', hoverSince: 0 }, 'a', 1000, 500);
  assert.equal(started.nestArmed, false);
  assert.equal(started.hoverId, 'a');
  const waiting = updateChatNestHold(started, 'a', 1400, 500);
  assert.equal(waiting.nestArmed, false);
  const armed = updateChatNestHold(waiting, 'a', 1500, 500);
  assert.equal(armed.nestArmed, true);
  const moved = updateChatNestHold(armed, 'c', 1600, 500);
  assert.equal(moved.nestArmed, false);
  assert.equal(moved.hoverId, 'c');
});

test('resolveChatDrop inserts before a root in the top zone', () => {
  const items = [
    { id: 'a', top: 0, bottom: 100, isChild: false },
    { id: 'b', top: 100, bottom: 200, isChild: false },
  ];
  const actual = resolveChatDrop({ items, y: 10, draggedIds: ['b'] });
  assert.equal(actual.mode, 'insert');
  assert.equal(actual.parentChatId, '');
  assert.equal(actual.beforeId, 'a');
});

test('resolveChatDrop keeps the hole of the dragged item as an insert before the next row', () => {
  const items = [
    { id: 'a', top: 0, bottom: 40, isChild: false },
    { id: 'b', top: 40, bottom: 80, isChild: false },
    { id: 'c', top: 80, bottom: 120, isChild: false },
  ];
  const actual = resolveChatDrop({ items, y: 60, draggedIds: ['b'] });
  assert.equal(actual.mode, 'insert');
  assert.equal(actual.beforeId, 'c');
  assert.equal(actual.parentChatId, '');
});

test('resolveChatDrop nests onto a hovered child when nest is armed', () => {
  const items = [
    { id: 'a', top: 0, bottom: 40, isChild: false },
    { id: 'c1', top: 40, bottom: 80, isChild: true },
    { id: 'b', top: 80, bottom: 120, isChild: false },
  ];
  const actual = resolveChatDrop({ items, y: 60, draggedIds: ['b'], nestArmed: true });
  assert.equal(actual.mode, 'nest');
  assert.equal(actual.parentChatId, 'c1');
  assert.equal(actual.beforeId, null);
});

test('resolveChatDrop inserts a child among siblings in the same folder', () => {
  const items = [
    { id: 'a', top: 0, bottom: 40, isChild: false },
    { id: 'c1', top: 40, bottom: 80, isChild: true },
    { id: 'c2', top: 80, bottom: 120, isChild: true },
    { id: 'b', top: 120, bottom: 160, isChild: false },
  ];
  const actual = resolveChatDrop({ items, y: 90, draggedIds: ['b'] });
  assert.equal(actual.mode, 'insert');
  assert.equal(actual.parentChatId, 'a');
  assert.equal(actual.beforeId, 'c2');
});

test('resolveChatDrop inserts a grandchild among siblings of the same parent', () => {
  const items = [
    { id: 'a', top: 0, bottom: 40, isChild: false, level: 0, parentId: '' },
    { id: 'b', top: 40, bottom: 80, isChild: true, level: 1, parentId: 'a' },
    { id: 'c1', top: 80, bottom: 120, isChild: true, level: 2, parentId: 'b' },
    { id: 'c2', top: 120, bottom: 160, isChild: true, level: 2, parentId: 'b' },
  ];
  const actual = resolveChatDrop({ items, y: 130, draggedIds: ['x'] });
  assert.equal(actual.mode, 'insert');
  assert.equal(actual.parentChatId, 'b');
  assert.equal(actual.beforeId, 'c2');
});
