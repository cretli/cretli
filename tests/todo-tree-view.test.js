import assert from 'node:assert/strict';
import {
  buildTodoMarkdown,
  canAddTodoChild,
  countActiveTodoChats,
  filterTodoItemsByRootStatus,
  flattenTodoTree,
  formatTodoAssigneeBadge,
  normalizeTodoItemStatus,
  parseTodoRootStatusFilter,
  serializeTodoRootStatusFilter,
  formatTodoRelativeTime,
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
  assert.equal(parseTodoRootStatusFilter(['idea', 'ready', 'doing', 'done']), null);
  const partial = parseTodoRootStatusFilter(['ready', 'doing']);
  assert.ok(partial instanceof Set);
  assert.deepEqual([...partial], ['ready', 'doing']);
  assert.deepEqual(serializeTodoRootStatusFilter(partial), ['ready', 'doing']);
  assert.deepEqual(serializeTodoRootStatusFilter(null), []);
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
    status: 'idea',
    assignee: { harness: 'opencode', model: 'glm', role: 'implement' },
  };
  const items = [parent, child];
  assert.equal(formatTodoAssigneeBadge(child), 'opencode · glm · implement');
  assert.equal(formatTodoAssigneeBadge(parent), '');
  assert.equal(readTodoRowMark(items, child), 'blocked');
  parent.plan = { markdown: '# plan', approvedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(readTodoRowMark(items, child), 'ready');
  assert.equal(readTodoRowMark(items, parent), '');
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


if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('todo-tree-view: all passed');
