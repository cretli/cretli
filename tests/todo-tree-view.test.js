import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import {
  buildTodoMarkdown,
  canAddTodoChild,
  countActiveTodoChats,
  filterTodoItemsByRootStatus,
  flattenTodoTree,
  formatTodoAssigneeBadge,
  normalizeTodoItemStatus,
  parseTodoSortMode,
  parseTodoIntegrationFilter,
  matchesTodoIntegrationFilter,
  parseTodoRootStatusFilter,
  serializeTodoRootStatusFilter,
  TODO_INTEGRATION_PENDING_FILTERS,
  formatTodoRelativeTime,
  isTodoDeferredOverdue,
  isTodoOpenStatus,
  splitDeferredTodoRows,
  TODO_ITEM_STATUSES,
  formatTodoShortId,
  readTodoRowMark,
  readTodoRowMeta,
  resolveTodoChatCountKey,
  resolveTodoDrop,
  todoDropZoneFromRatio,
} from '../app_front/features/todo/todoTreeView.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

function rowIds(rows) {
  return rows.map((row) => row.item.id);
}

runCase('normalizeTodoItemStatus and root status filter parsing', () => {
  assert.equal(normalizeTodoItemStatus('ready'), 'ready');
  assert.equal(normalizeTodoItemStatus('unknown'), 'idea');
  assert.equal(parseTodoRootStatusFilter(null), null);
  assert.equal(parseTodoRootStatusFilter([]), null);
  assert.equal(parseTodoRootStatusFilter(['idea', 'ready', 'doing', 'done', 'deferred']), null);
  const partial = parseTodoRootStatusFilter(['ready', 'doing']);
  assert.ok(partial instanceof Set);
  assert.deepEqual([...partial], ['ready', 'doing']);
  assert.deepEqual(serializeTodoRootStatusFilter(partial), ['ready', 'doing']);
  assert.deepEqual(serializeTodoRootStatusFilter(null), []);
});

runCase('integration filter parsing falls back to the pending preset', () => {
  assert.deepEqual([...parseTodoIntegrationFilter(null)], TODO_INTEGRATION_PENDING_FILTERS);
  assert.deepEqual([...parseTodoIntegrationFilter('[not json')], TODO_INTEGRATION_PENDING_FILTERS);
  assert.equal(parseTodoIntegrationFilter('[]').size, 0);
  assert.deepEqual([...parseTodoIntegrationFilter('["conflict","bogus","integrated"]')], ['conflict', 'integrated']);
  assert.deepEqual([...parseTodoIntegrationFilter('unconfirmed')], ['unconfirmed']);
});

runCase('no-code integration results stay out of pending filters', () => {
  const item = { integrationSummary: { state: 'unconfirmed', detail: 'no_code_changes' } };
  assert.equal(matchesTodoIntegrationFilter(item, 'unconfirmed'), false);
  assert.equal(matchesTodoIntegrationFilter(item, 'no_code_changes'), true);
});

runCase('filterTodoItemsByRootStatus keeps matching roots and their subtrees', () => {
  const items = [
    { id: 'a', status: 'idea', siblingIndex: 0 },
    { id: 'a1', parentId: 'a', status: 'done', siblingIndex: 0 },
    { id: 'b', status: 'ready', siblingIndex: 1 },
    { id: 'c', status: 'doing', siblingIndex: 2 },
    { id: 'orphan', parentId: 'missing', status: 'done', siblingIndex: 0 },
  ];
  const all = filterTodoItemsByRootStatus(items, null);
  assert.equal(all.length, 5);
  const readyOnly = filterTodoItemsByRootStatus(items, new Set(['ready']));
  assert.deepEqual(
    readyOnly.map((row) => row.id),
    ['b']
  );
  const ideaBranch = filterTodoItemsByRootStatus(items, new Set(['idea']));
  assert.deepEqual(
    ideaBranch.map((row) => row.id),
    ['a', 'a1']
  );
  const doneRoots = filterTodoItemsByRootStatus(items, new Set(['done']));
  assert.deepEqual(
    doneRoots.map((row) => row.id),
    ['orphan']
  );
  const open = flattenTodoTree(ideaBranch, []);
  assert.deepEqual(rowIds(open), ['a', 'a1']);
});

runCase('flattenTodoTree sorts siblings and hides a collapsed subtree', () => {
  const items = [
    { id: 'b', siblingIndex: 1 },
    { id: 'a', siblingIndex: 0 },
    { id: 'child', parentId: 'a', siblingIndex: 0 },
    { id: 'orphan', parentId: 'missing', siblingIndex: 0 },
  ];
  const open = flattenTodoTree(items, []);
  assert.deepEqual(rowIds(open), ['a', 'child', 'orphan', 'b']);
  assert.equal(open[0].level, 0);
  assert.equal(open[1].level, 1);
  assert.equal(open[0].hasChildren, true);
  const closed = flattenTodoTree(items, ['a']);
  assert.deepEqual(rowIds(closed), ['a', 'orphan', 'b']);
  assert.equal(closed[0].collapsed, true);
});

runCase('flattenTodoTree sorts roots by creation, activity and live state; children keep order', () => {
  const items = [
    { id: 'old', siblingIndex: 0, status: 'idea', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'new', siblingIndex: 1, status: 'ready', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:00:00Z' },
    { id: 'mid', siblingIndex: 2, status: 'doing', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
    { id: 'c2', parentId: 'old', siblingIndex: 1, updatedAt: '2026-01-02T00:00:00Z' },
    { id: 'c1', parentId: 'old', siblingIndex: 0, listSlim: true, chatLastAt: '2026-05-01T00:00:00Z' },
  ];
  assert.deepEqual(rowIds(flattenTodoTree(items, [])), ['old', 'c1', 'c2', 'new', 'mid']);
  assert.deepEqual(rowIds(flattenTodoTree(items, [], { sort: 'created' })), ['new', 'mid', 'old', 'c1', 'c2']);
  // A descendant's chat activity lifts its whole root tree.
  assert.deepEqual(rowIds(flattenTodoTree(items, [], { sort: 'activity' })), ['old', 'c1', 'c2', 'new', 'mid']);
  // Without live agents: doing, then ready, then idea.
  assert.deepEqual(rowIds(flattenTodoTree(items, ['old'], { sort: 'active' })), ['mid', 'new', 'old']);
  const liveRank = (root) => (root.id === 'old' ? 0 : root.id === 'new' ? 1 : -1);
  assert.deepEqual(rowIds(flattenTodoTree(items, ['old'], { sort: 'active', liveRank })), ['old', 'new', 'mid']);
  assert.equal(parseTodoSortMode('activity'), 'activity');
  assert.equal(parseTodoSortMode('bogus'), 'manual');
});

runCase('todoDropZoneFromRatio: edges reorder, middle nests', () => {
  assert.equal(todoDropZoneFromRatio(0), 'before');
  assert.equal(todoDropZoneFromRatio(0.27), 'before');
  assert.equal(todoDropZoneFromRatio(0.5), 'nest');
  assert.equal(todoDropZoneFromRatio(0.73), 'after');
  assert.equal(todoDropZoneFromRatio(1), 'after');
});

runCase('resolveTodoDrop: nest, before, after, cycle, depth, noop', () => {
  const chain = [];
  for (let i = 0; i < 6; i += 1) {
    chain.push({ id: `n${i}`, parentId: i === 0 ? '' : `n${i - 1}`, siblingIndex: 0 });
  }
  const items = [
    { id: 'a', siblingIndex: 0 },
    { id: 'b', siblingIndex: 1 },
    { id: 'c', parentId: 'a', siblingIndex: 0 },
  ];
  const nest = resolveTodoDrop({ items, draggedId: 'b', targetId: 'a', zone: 'nest' });
  assert.equal(nest.ok, true);
  if (nest.ok) {
    assert.equal(nest.parentId, 'a');
    assert.equal(nest.siblingIndex, 1);
  }
  const before = resolveTodoDrop({ items, draggedId: 'b', targetId: 'a', zone: 'before' });
  assert.equal(before.ok, true);
  if (before.ok) {
    assert.equal(before.parentId, null);
    assert.equal(before.siblingIndex, 0);
  }
  const after = resolveTodoDrop({ items, draggedId: 'a', targetId: 'b', zone: 'after' });
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.equal(after.parentId, null);
    assert.equal(after.siblingIndex, 1);
  }
  const cycle = resolveTodoDrop({ items, draggedId: 'a', targetId: 'c', zone: 'nest' });
  assert.deepEqual(cycle, { ok: false, reason: 'cycle' });
  const depth = resolveTodoDrop({
    items: [...items, ...chain, { id: 'mover', siblingIndex: 2 }],
    draggedId: 'mover',
    targetId: 'n5',
    zone: 'nest',
  });
  assert.deepEqual(depth, { ok: false, reason: 'depth' });
  const noop = resolveTodoDrop({ items, draggedId: 'b', targetId: 'a', zone: 'after' });
  assert.deepEqual(noop, { ok: false, reason: 'noop' });
  const selfDrop = resolveTodoDrop({ items, draggedId: 'a', targetId: 'a', zone: 'nest' });
  assert.equal(selfDrop.ok, false);
});

runCase('formatTodoAssigneeBadge and row marks', () => {
  const parent = {
    id: 'p',
    plan: { markdown: '# plan', approvedAt: '' },
    runMode: 'parallel',
  };
  const child = {
    id: 'c',
    parentId: 'p',
    siblingIndex: 0,
    status: 'ready',
    assignee: { harness: 'testfake', model: 'glm', role: 'implement' },
  };
  const items = [parent, child];
  assert.equal(formatTodoAssigneeBadge(child), 'testfake · glm · implement');
  assert.equal(formatTodoAssigneeBadge(parent), '');
  // An unapproved plan on the parent gates the whole subtree.
  assert.equal(readTodoRowMark(items, child), 'blocked');
  parent.plan = { markdown: '# plan', approvedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(readTodoRowMark(items, child), 'ready');
  assert.equal(readTodoRowMark(items, parent), '');
  // An approved plan alone does not make a draft leaf runnable: `ready` is an
  // explicit status, so `idea` rows stay unmarked even under an approved parent.
  child.status = 'idea';
  assert.equal(readTodoRowMark(items, child), '');
  child.status = 'doing';
  assert.equal(readTodoRowMark(items, child), '');
});

runCase('canAddTodoChild stops at max depth', () => {
  const items = [];
  for (let i = 0; i < 6; i += 1) {
    items.push({ id: `n${i}`, parentId: i === 0 ? '' : `n${i - 1}`, siblingIndex: 0 });
  }
  assert.equal(canAddTodoChild(items, 'n4'), true);
  assert.equal(canAddTodoChild(items, 'n5'), false);
  assert.equal(canAddTodoChild(items, 'missing'), false);
});

runCase('formatTodoShortId keeps the first 8 characters', () => {
  assert.equal(formatTodoShortId('e7212fc3-b544-4894-baf1-6db621cfeece'), 'e7212fc3');
  assert.equal(formatTodoShortId('  abcd  '), 'abcd');
  assert.equal(formatTodoShortId(''), '');
  assert.equal(formatTodoShortId(null), '');
});

runCase('countActiveTodoChats ignores deleted entries', () => {
  assert.equal(countActiveTodoChats(null), 0);
  assert.equal(countActiveTodoChats({}), 0);
  assert.equal(
    countActiveTodoChats({
      chats: [{ id: 'a' }, { id: 'b', deleted: true }, { id: 'c', deleted: false }],
    }),
    2
  );
});

runCase('formatTodoRelativeTime buckets by minutes/hours/days', () => {
  const now = Date.parse('2026-02-01T12:00:00.000Z');
  assert.equal(formatTodoRelativeTime('', now), null);
  assert.equal(formatTodoRelativeTime('not-a-date', now), null);
  assert.deepEqual(formatTodoRelativeTime('2026-02-01T11:59:30.000Z', now), { unit: 'now', count: 0 });
  assert.deepEqual(formatTodoRelativeTime('2026-02-01T11:30:00.000Z', now), { unit: 'minutes', count: 30 });
  assert.deepEqual(formatTodoRelativeTime('2026-02-01T09:00:00.000Z', now), { unit: 'hours', count: 3 });
  assert.deepEqual(formatTodoRelativeTime('2026-01-30T12:00:00.000Z', now), { unit: 'days', count: 2 });
});

runCase('resolveTodoChatCountKey: Polish and English plurals', () => {
  assert.equal(resolveTodoChatCountKey(1, 'pl'), 'todo.chatCountOne');
  assert.equal(resolveTodoChatCountKey(2, 'pl'), 'todo.chatCountFew');
  assert.equal(resolveTodoChatCountKey(4, 'pl'), 'todo.chatCountFew');
  assert.equal(resolveTodoChatCountKey(5, 'pl'), 'todo.chatCountMany');
  assert.equal(resolveTodoChatCountKey(12, 'pl'), 'todo.chatCountMany');
  assert.equal(resolveTodoChatCountKey(22, 'pl'), 'todo.chatCountFew');
  assert.equal(resolveTodoChatCountKey(1, 'en'), 'todo.chatCountOne');
  assert.equal(resolveTodoChatCountKey(3, 'en'), 'todo.chatCountMany');
});

runCase('readTodoRowMeta picks the freshest chat activity', () => {
  const now = Date.parse('2026-02-01T12:00:00.000Z');
  const item = {
    id: 'e7212fc3-b544-4894-baf1-6db621cfeece',
    updatedAt: '2026-01-01T00:00:00.000Z',
    chats: [
      { id: 'a', lastAt: '2026-02-01T10:00:00.000Z', deleted: false },
      { id: 'b', lastAt: '2026-02-01T11:00:00.000Z', deleted: true },
    ],
  };
  assert.deepEqual(readTodoRowMeta(item, now), {
    shortId: 'e7212fc3',
    chats: 1,
    age: { unit: 'hours', count: 2 },
  });
  assert.deepEqual(readTodoRowMeta({ id: 'x', updatedAt: '' }, now), {
    shortId: 'x',
    chats: 0,
    age: null,
  });
});

runCase('buildTodoMarkdown includes title, body and plan', () => {
  assert.equal(buildTodoMarkdown({ title: 'Task' }), '# Task');
  assert.equal(
    buildTodoMarkdown({ title: 'Task', body: 'Notes', plan: { markdown: '# Plan' } }),
    '# Task\n\nNotes\n\n## Plan\n\n# Plan'
  );
  assert.equal(buildTodoMarkdown({}), '# (untitled)');
});


runCase('deferred is a known status and not open work', () => {
  assert.ok(TODO_ITEM_STATUSES.includes('deferred'));
  assert.equal(normalizeTodoItemStatus('deferred'), 'deferred');
  assert.equal(isTodoOpenStatus('deferred'), false);
  assert.equal(isTodoOpenStatus('done'), false);
  assert.equal(isTodoOpenStatus('ready'), true);
  // Four statuses selected (all but deferred) is a real filter now.
  assert.deepEqual([...parseTodoRootStatusFilter(['idea', 'ready', 'doing', 'done'])], ['idea', 'ready', 'doing', 'done']);
  assert.equal(parseTodoRootStatusFilter(TODO_ITEM_STATUSES), null);
});

runCase('splitDeferredTodoRows moves deferred roots and their subtree into the section', () => {
  const items = [
    { id: 'a', status: 'ready', siblingIndex: 0 },
    { id: 'd', status: 'deferred', siblingIndex: 1 },
    { id: 'd1', parentId: 'd', status: 'deferred', siblingIndex: 0 },
    { id: 'b', status: 'idea', siblingIndex: 2 },
    { id: 'x', parentId: 'b', status: 'deferred', siblingIndex: 0 },
  ];
  const split = splitDeferredTodoRows(flattenTodoTree(items, []));
  assert.deepEqual(rowIds(split.main), ['a', 'b', 'x']);
  assert.deepEqual(rowIds(split.deferred), ['d', 'd1']);
  assert.equal(split.deferredRoots, 1);
  assert.deepEqual(splitDeferredTodoRows(null), { main: [], deferred: [], deferredRoots: 0 });
});

runCase('isTodoDeferredOverdue only flags deferred todos with a past date', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  assert.equal(isTodoDeferredOverdue({ status: 'deferred', deferredUntil: '2026-05-31T00:00:00Z' }, now), true);
  assert.equal(isTodoDeferredOverdue({ status: 'deferred', deferredUntil: '2026-06-02T00:00:00Z' }, now), false);
  assert.equal(isTodoDeferredOverdue({ status: 'deferred' }, now), false);
  assert.equal(isTodoDeferredOverdue({ status: 'deferred', deferredUntil: 'garbage' }, now), false);
  assert.equal(isTodoDeferredOverdue({ status: 'idea', deferredUntil: '2026-05-31T00:00:00Z' }, now), false);
});

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('todo-tree-view: all passed');
