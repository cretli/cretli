import assert from 'node:assert/strict';
import {
  canAddTodoChild,
  flattenTodoTree,
  formatTodoAssigneeBadge,
  readTodoRowMark,
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

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('todo-tree-view: all passed');
