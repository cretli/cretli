import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChatOrder,
  buildForkArchiveBlockedIds,
  flattenChatsTree,
  getCollectForkSubtreeIdsCallCount,
  isChatArchived,
  isForkArchiveBlocked,
  isForkSubtreeBusy,
  isRelatedChatLinkVisible,
  markForkSubtreeArchived,
  mergeChatOrder,
  partitionChatsByArchive,
  resetCollectForkSubtreeIdsCallCount,
  selectChatsForSidebarList,
  resolveArchiveSwitchId,
  resolveHarnessSwitchNest,
  findLastLiveSelectableChatId,
  wouldCreateChatParentCycle,
} from '../lib/chat-tree.js';
import { resolveChatDrop, updateChatNestHold } from '../app_front/features/sidebar/sidebarChatDrop.js';

function chat(id, parent) {
  const row = { id, title: id };
  if (parent) row.forkParentChatId = parent;
  return row;
}

test('isForkSubtreeBusy is true for the chat or a nested child', () => {
  const chats = [
    { id: 'parent', _serverRunState: { state: 'idle' } },
    { id: 'child', forkParentChatId: 'parent', _serverRunState: { state: 'busy' } },
    { id: 'other', _serverRunState: { state: 'busy' } },
  ];
  const isBusy = (chat) => chat._serverRunState?.state === 'busy';
  assert.equal(isForkSubtreeBusy(chats, 'parent', isBusy), true);
  assert.equal(isForkSubtreeBusy(chats, 'child', isBusy), true);
  assert.equal(isForkSubtreeBusy(chats, 'missing', isBusy), false);
  const idleParent = [{ id: 'parent' }, { id: 'child', forkParentChatId: 'parent' }];
  assert.equal(isForkSubtreeBusy(idleParent, 'parent', isBusy), false);
});

test('buildForkArchiveBlockedIds matches isForkSubtreeBusy for every chat id', () => {
  const chats = [
    chat('root'),
    chat('c1', 'root'),
    chat('c2', 'c1'),
    { id: 'busy-leaf', forkParentChatId: 'c2', _serverRunState: { state: 'busy' } },
    chat('other'),
    chat('orphan', 'missing-parent'),
  ];
  const isBusy = (c) => c._serverRunState?.state === 'busy';
  const { blocked, buildPassSteps } = buildForkArchiveBlockedIds(chats, isBusy);
  for (const row of chats) {
    assert.equal(
      isForkArchiveBlocked(blocked, row.id),
      isForkSubtreeBusy(chats, row.id, isBusy),
      row.id,
    );
  }
  assert.equal(isForkArchiveBlocked(blocked, 'missing'), false);
  assert.equal(buildPassSteps, chats.length + 3, 'one upward step per ancestor of the busy leaf');
});

test('buildForkArchiveBlockedIds lookup pass does not call collectForkSubtreeIds', () => {
  const chats = [];
  for (let i = 0; i < 40; i += 1) {
    chats.push(i === 0 ? chat('n0') : chat(`n${i}`, `n${i - 1}`));
  }
  chats[39]._serverRunState = { state: 'busy' };
  const isBusy = (c) => c._serverRunState?.state === 'busy';
  resetCollectForkSubtreeIdsCallCount();
  const { blocked } = buildForkArchiveBlockedIds(chats, isBusy);
  for (const row of chats) {
    isForkArchiveBlocked(blocked, row.id);
  }
  assert.equal(getCollectForkSubtreeIdsCallCount(), 0);
});

test('buildForkArchiveBlockedIds stops on fork parent cycles', () => {
  const chats = [
    { id: 'a', forkParentChatId: 'b', _serverRunState: { state: 'busy' } },
    { id: 'b', forkParentChatId: 'a' },
  ];
  const isBusy = (c) => c._serverRunState?.state === 'busy';
  const { blocked, buildPassSteps } = buildForkArchiveBlockedIds(chats, isBusy);
  assert.equal(isForkArchiveBlocked(blocked, 'a'), true);
  assert.equal(isForkArchiveBlocked(blocked, 'b'), true);
  assert.equal(buildPassSteps, chats.length + 1, 'one upward step then stops on already-blocked ancestor');
});

test('buildForkArchiveBlockedIds is O(chats) when every node in a deep chain is busy', () => {
  const depth = 80;
  const chats = [];
  for (let i = 0; i < depth; i += 1) {
    const row = i === 0 ? chat('n0') : chat(`n${i}`, `n${i - 1}`);
    row._serverRunState = { state: 'busy' };
    chats.push(row);
  }
  const isBusy = (c) => c._serverRunState?.state === 'busy';
  const { blocked, buildPassSteps } = buildForkArchiveBlockedIds(chats, isBusy);
  for (const row of chats) {
    assert.equal(
      isForkArchiveBlocked(blocked, row.id),
      isForkSubtreeBusy(chats, row.id, isBusy),
      row.id,
    );
  }
  resetCollectForkSubtreeIdsCallCount();
  for (const row of chats) {
    isForkArchiveBlocked(blocked, row.id);
  }
  assert.equal(getCollectForkSubtreeIdsCallCount(), 0);
  assert.ok(
    buildPassSteps <= chats.length + depth - 1,
    `expected linear pass steps, got ${buildPassSteps} for ${chats.length} chats`,
  );
  assert.ok(
    buildPassSteps < chats.length * (depth - 1) / 2,
    'must not replay full ancestor walks for every busy row',
  );
});

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

test('partitionChatsByArchive keeps an archived parent of a live child in the nest', () => {
  const parent = { ...chat('parent'), archivedAt: '2026-10-05T10:00:00.000Z' };
  const child = chat('child', 'parent');
  const sibling = { ...chat('sib', 'parent'), archivedAt: '2026-10-05T10:00:00.000Z' };
  const unrelated = { ...chat('old'), archivedAt: '2026-10-05T10:00:00.000Z' };
  const { live, archived } = partitionChatsByArchive([parent, child, sibling, unrelated]);
  assert.deepEqual(live.map((row) => row.id), ['parent', 'child']);
  assert.deepEqual(archived.map((row) => row.id), ['sib', 'old']);
  const tree = flattenChatsTree(live).map((row) => [row.chat.id, row.level, row.parentId]);
  assert.deepEqual(tree, [
    ['parent', 0, ''],
    ['child', 1, 'parent'],
  ]);
});

test('partitionChatsByArchive keeps an archived grandparent when the middle row is archived', () => {
  const root = { ...chat('root'), archivedAt: '2026-10-05T10:00:00.000Z' };
  const middle = { ...chat('middle', 'root'), archivedAt: '2026-10-05T10:00:00.000Z' };
  const leaf = chat('leaf', 'middle');
  const { live, archived } = partitionChatsByArchive([root, middle, leaf]);
  assert.deepEqual(archived, []);
  const tree = flattenChatsTree(live).map((row) => [row.chat.id, row.level]);
  assert.deepEqual(tree, [
    ['root', 0],
    ['middle', 1],
    ['leaf', 2],
  ]);
});

test('selectChatsForSidebarList includes archived ancestors and drops other archived rows', () => {
  const parent = { ...chat('parent'), archivedAt: '2026-10-05T10:00:00.000Z' };
  const child = chat('child', 'parent');
  const unrelated = { ...chat('old'), archivedAt: '2026-10-05T10:00:00.000Z' };
  const actual = selectChatsForSidebarList([parent, child, unrelated]).map((row) => row.id);
  assert.deepEqual(actual, ['parent', 'child']);
  const all = selectChatsForSidebarList([parent, child, unrelated], { includeArchived: true }).map((row) => row.id);
  assert.deepEqual(all, ['parent', 'child', 'old']);
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

test('markForkSubtreeArchived stamps the whole subtree and keeps every row', () => {
  const chats = [chat('root'), chat('child', 'root'), chat('grand', 'child'), chat('other')];
  const ids = markForkSubtreeArchived(chats, 'root', '2026-10-05T12:00:00.000Z');
  assert.deepEqual(ids, ['root', 'child', 'grand']);
  assert.equal(chats.length, 4);
  assert.equal(chats[0].archivedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(chats[1].archivedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(chats[2].archivedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(chats[3].archivedAt, undefined);
});

test('markForkSubtreeArchived keeps the original stamp on already archived rows', () => {
  const chats = [
    chat('root'),
    { ...chat('child', 'root'), archivedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const ids = markForkSubtreeArchived(chats, 'root', '2026-10-05T12:00:00.000Z');
  assert.deepEqual(ids, ['root', 'child']);
  assert.equal(chats[0].archivedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(chats[1].archivedAt, '2026-01-01T00:00:00.000Z');
});

test('markForkSubtreeArchived leaves rows untouched for an unknown root', () => {
  const chats = [chat('a')];
  assert.deepEqual(markForkSubtreeArchived(chats, 'missing', '2026-10-05T12:00:00.000Z'), []);
  assert.equal(chats[0].archivedAt, undefined);
});

test('markForkSubtreeArchived keeps the archived subtree nested in the archive partition', () => {
  const chats = [chat('root'), chat('child', 'root'), chat('grand', 'child'), chat('live')];
  markForkSubtreeArchived(chats, 'root', '2026-10-05T12:00:00.000Z');
  const { live, archived } = partitionChatsByArchive(chats);
  assert.deepEqual(live.map((row) => row.id), ['live']);
  const tree = flattenChatsTree(archived).map((row) => [row.chat.id, row.level, row.parentId]);
  assert.deepEqual(tree, [
    ['root', 0, ''],
    ['child', 1, 'root'],
    ['grand', 2, 'child'],
  ]);
});

test('markForkSubtreeArchived archives a single chat without descendants', () => {
  const chats = [chat('only'), chat('other')];
  const ids = markForkSubtreeArchived(chats, 'only', '2026-10-05T12:00:00.000Z');
  assert.deepEqual(ids, ['only']);
  assert.equal(chats[0].archivedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(chats[1].archivedAt, undefined);
  const { live, archived } = partitionChatsByArchive(chats);
  assert.deepEqual(live.map((row) => row.id), ['other']);
  assert.deepEqual(archived.map((row) => row.id), ['only']);
});

test('markForkSubtreeArchived defaults to an ISO timestamp', () => {
  const chats = [chat('only')];
  markForkSubtreeArchived(chats, 'only');
  assert.match(chats[0].archivedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('resolveArchiveSwitchId keeps the active chat when archiving an unrelated row', () => {
  const chats = [chat('A'), chat('B'), chat('C')];
  const archivedIds = new Set(['B']);
  markForkSubtreeArchived(chats, 'B', '2026-10-05T12:00:00.000Z');
  assert.equal(
    resolveArchiveSwitchId({ chats, archivedIds, activeChatId: 'A' }),
    'A',
    'archiving B must not move the pane off A'
  );
});

test('resolveArchiveSwitchId picks a live fallback when the active chat is archived', () => {
  const chats = [chat('A'), chat('B'), chat('child', 'B')];
  const stamp = '2026-10-05T12:00:00.000Z';
  const archivedIds = new Set(markForkSubtreeArchived(chats, 'B', stamp));
  assert.equal(
    resolveArchiveSwitchId({ chats, archivedIds, activeChatId: 'child' }),
    'A',
    'active descendant leaves the live tree; fallback is another live row'
  );
});

test('resolveArchiveSwitchId returns empty when nothing was archived', () => {
  const chats = [chat('A'), chat('B')];
  assert.equal(resolveArchiveSwitchId({ chats, archivedIds: new Set(), activeChatId: 'A' }), '');
});

test('resolveArchiveSwitchId honors an explicit live switch target', () => {
  const chats = [chat('A'), chat('B'), chat('C')];
  const archivedIds = new Set(markForkSubtreeArchived(chats, 'B', '2026-10-05T12:00:00.000Z'));
  assert.equal(
    resolveArchiveSwitchId({ chats, archivedIds, activeChatId: 'A', requestedId: 'C' }),
    'C'
  );
});

test('findLastLiveSelectableChatId skips watcher-pinned rows', () => {
  const chats = [
    chat('A'),
    { ...chat('watcher'), watcherPinned: true },
  ];
  assert.equal(findLastLiveSelectableChatId(chats, ''), 'A');
});

test('resolveArchiveSwitchId never auto-opens a watcher-pinned chat', () => {
  const chats = [
    chat('A'),
    { ...chat('watcher'), watcherPinned: true },
  ];
  const archivedIds = new Set(markForkSubtreeArchived(chats, 'A', '2026-10-05T12:00:00.000Z'));
  assert.equal(resolveArchiveSwitchId({ chats, archivedIds, activeChatId: 'A' }), '');
});

test('buildForkArchiveBlockedIds counts an exact linear pass for a leaf-first deep chain', () => {
  const depth = 40;
  const chain = [];
  for (let i = 0; i < depth; i += 1) {
    const row = i === 0 ? chat('n0') : chat(`n${i}`, `n${i - 1}`);
    row._serverRunState = { state: 'busy' };
    chain.push(row);
  }
  // Worst-case iteration order: the deepest busy leaf is seen first, so its
  // upward walk blocks every ancestor; the remaining busy rows must then stop on
  // the already-blocked ancestor instead of re-walking the chain.
  const chats = [...chain].reverse();
  const isBusy = (c) => c._serverRunState?.state === 'busy';
  resetCollectForkSubtreeIdsCallCount();
  const { blocked, buildPassSteps } = buildForkArchiveBlockedIds(chats, isBusy);
  assert.equal(getCollectForkSubtreeIdsCallCount(), 0, 'the blocked pass never falls back to collectForkSubtreeIds');
  assert.equal(
    buildPassSteps,
    chats.length + depth - 1,
    `expected exactly one upward step per ancestor, got ${buildPassSteps} for ${chats.length} chats`,
  );
  assert.equal(blocked.size, depth, 'every node of an all-busy chain is blocked');
  for (const row of chats) {
    assert.equal(
      isForkArchiveBlocked(blocked, row.id),
      isForkSubtreeBusy(chats, row.id, isBusy),
      row.id,
    );
  }
});

test('buildForkArchiveBlockedIds counts one shared-ancestor step for many busy siblings', () => {
  const chats = [chat('root')]; // idle parent shared by every busy child
  for (let i = 0; i < 40; i += 1) {
    const row = chat(`c${i}`, 'root');
    row._serverRunState = { state: 'busy' };
    chats.push(row);
  }
  const isBusy = (c) => c._serverRunState?.state === 'busy';
  resetCollectForkSubtreeIdsCallCount();
  const { blocked, buildPassSteps } = buildForkArchiveBlockedIds(chats, isBusy);
  assert.equal(getCollectForkSubtreeIdsCallCount(), 0, 'the blocked pass never falls back to collectForkSubtreeIds');
  assert.equal(
    buildPassSteps,
    chats.length + 1,
    'the first busy child walks to the idle root once; the rest stop on the already-blocked ancestor',
  );
  assert.equal(blocked.size, chats.length, 'root plus every busy child is blocked');
  assert.equal(isForkArchiveBlocked(blocked, 'root'), true, 'an ancestor of a busy child is blocked');
});

test('archiving a subtree with an active descendant moves the whole branch to the archive partition', () => {
  const chats = [chat('root'), chat('child', 'root'), chat('grand', 'child'), chat('liveSibling')];
  const stamp = '2026-10-05T12:00:00.000Z';
  const archivedIds = new Set(markForkSubtreeArchived(chats, 'root', stamp));
  assert.deepEqual([...archivedIds], ['root', 'child', 'grand']);
  const { live, archived } = partitionChatsByArchive(chats);
  assert.deepEqual(
    archived.map((row) => row.id),
    ['root', 'child', 'grand'],
    'an archived branch with no live descendant leaves the live tree as one unit',
  );
  assert.deepEqual(live.map((row) => row.id), ['liveSibling']);
  const tree = flattenChatsTree(archived).map((row) => [row.chat.id, row.level, row.parentId]);
  assert.deepEqual(
    tree,
    [
      ['root', 0, ''],
      ['child', 1, 'root'],
      ['grand', 2, 'child'],
    ],
    'flattenChatsTree keeps the branch nested in the open archive (no level-0 orphan from a child)',
  );
  assert.equal(
    resolveArchiveSwitchId({ chats, archivedIds, activeChatId: 'grand' }),
    'liveSibling',
    'the pane hands off to the surviving live row when the active chat was a descendant',
  );
});
