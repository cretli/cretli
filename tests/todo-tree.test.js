import assert from 'node:assert/strict';
import {
  TODO_MAX_DEPTH,
  collectTodoSubtreeIds,
  isTodoNodeBlocked,
  listReadyTodoLeaves,
  renumberTodoSiblings,
  todoNodeDepth,
  todoSubtreeHeight,
  wouldCreateTodoParentCycle,
} from '../lib/todo-tree.js';

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

runCase('TODO_MAX_DEPTH is 6', () => {
  assert.equal(TODO_MAX_DEPTH, 6);
});

runCase('wouldCreateTodoParentCycle: chain, self, and clean cases', () => {
  const items = [
    { id: 'r' },
    { id: 'a', parentId: 'r' },
    { id: 'b', parentId: 'a' },
  ];
  assert.equal(wouldCreateTodoParentCycle(items, 'r', 'b'), true);
  assert.equal(wouldCreateTodoParentCycle(items, 'a', 'b'), true);
  assert.equal(wouldCreateTodoParentCycle(items, 'a', 'a'), true);
  // 'r' is an ancestor of 'a', so parenting r under a is also a cycle.
  assert.equal(wouldCreateTodoParentCycle(items, 'r', 'a'), true);
  assert.equal(wouldCreateTodoParentCycle(items, 'a', 'r'), false);
  assert.equal(wouldCreateTodoParentCycle(items, 'b', 'r'), false);
  assert.equal(wouldCreateTodoParentCycle(items, 'b', ''), false);
});

runCase('wouldCreateTodoParentCycle: cyclic stored data terminates', () => {
  const items = [
    { id: 'x', parentId: 'y' },
    { id: 'y', parentId: 'x' },
  ];
  assert.equal(wouldCreateTodoParentCycle(items, 'x', 'y'), true);
  assert.equal(wouldCreateTodoParentCycle(items, 'z', 'x'), false);
});

runCase('todoNodeDepth and todoSubtreeHeight', () => {
  const items = [
    { id: 'r' },
    { id: 'a', parentId: 'r' },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'r' },
  ];
  assert.equal(todoNodeDepth(items, 'r'), 1);
  assert.equal(todoNodeDepth(items, 'b'), 3);
  assert.equal(todoNodeDepth(items, 'missing'), 0);
  assert.equal(todoSubtreeHeight(items, 'r'), 3);
  assert.equal(todoSubtreeHeight(items, 'c'), 1);
  assert.equal(todoSubtreeHeight(items, 'missing'), 0);
});

runCase('collectTodoSubtreeIds: BFS over the whole subtree', () => {
  const items = [
    { id: 'r' },
    { id: 'a', parentId: 'r' },
    { id: 'b', parentId: 'r' },
    { id: 'leaf', parentId: 'a' },
    { id: 'other' },
  ];
  assert.deepEqual(collectTodoSubtreeIds(items, 'r'), ['r', 'a', 'b', 'leaf']);
  assert.deepEqual(collectTodoSubtreeIds(items, 'a'), ['a', 'leaf']);
  assert.deepEqual(collectTodoSubtreeIds(items, 'missing'), []);
});

runCase('renumberTodoSiblings: gaps, ties, and missing indexes', () => {
  const items = [
    { id: 'r1', siblingIndex: 7 },
    { id: 'r2' },
    { id: 'r3', siblingIndex: 2 },
    { id: 'c1', parentId: 'p', siblingIndex: 1 },
    { id: 'c2', parentId: 'p' },
    { id: 'p', siblingIndex: 0 },
  ];
  renumberTodoSiblings(items);
  // The global array order is untouched; only the indexes change.
  const roots = items
    .filter((row) => !row.parentId)
    .sort((a, b) => a.siblingIndex - b.siblingIndex)
    .map((row) => [row.id, row.siblingIndex]);
  // p (0) sorts first, r3 (2) before r1 (7); r2 has no index and lands last.
  assert.deepEqual(roots, [['p', 0], ['r3', 1], ['r1', 2], ['r2', 3]]);
  const children = items.filter((row) => row.parentId === 'p').map((row) => [row.id, row.siblingIndex]);
  assert.deepEqual(children, [['c1', 0], ['c2', 1]]);
});

runCase('isTodoNodeBlocked: unapproved parent plan blocks children', () => {
  const items = [
    { id: 'root', plan: { markdown: 'x' } },
    { id: 'kid', parentId: 'root' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[1]), true);
  items[0].plan.approvedAt = '2024-01-01T00:00:00.000Z';
  assert.equal(isTodoNodeBlocked(items, items[1]), false);
  assert.equal(isTodoNodeBlocked(items, items[0]), false);
});

runCase('isTodoNodeBlocked: a grouping parent without a plan does not block', () => {
  const items = [
    { id: 'group' },
    { id: 'kid', parentId: 'group' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[1]), false);
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), ['kid']);
});

runCase('isTodoNodeBlocked: sequential parent blocks on earlier unfinished sibling', () => {
  const items = [
    { id: 'root', plan: { approvedAt: 'yes' }, runMode: 'sequential' },
    { id: 's0', parentId: 'root', siblingIndex: 0, status: 'doing' },
    { id: 's1', parentId: 'root', siblingIndex: 1, status: 'idea' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[1]), false);
  assert.equal(isTodoNodeBlocked(items, items[2]), true);
  items[1].status = 'done';
  assert.equal(isTodoNodeBlocked(items, items[2]), false);
});

runCase('isTodoNodeBlocked: parallel parent ignores earlier siblings', () => {
  const items = [
    { id: 'root', plan: { approvedAt: 'yes' }, runMode: 'parallel' },
    { id: 's0', parentId: 'root', siblingIndex: 0, status: 'doing' },
    { id: 's1', parentId: 'root', siblingIndex: 1, status: 'idea' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[2]), false);
});

runCase('listReadyTodoLeaves: filters done/doing, non-leaves, and blocked', () => {
  const items = [
    { id: 'root', plan: { approvedAt: 'yes' } },
    { id: 'a', parentId: 'root', status: 'idea' },
    { id: 'b', parentId: 'root', status: 'done' },
    { id: 'c', parentId: 'root', status: 'doing' },
    { id: 'd', parentId: 'root', status: 'idea', plan: { approvedAt: 'yes' } },
    { id: 'd1', parentId: 'd', status: 'idea' },
    { id: 'solo', status: 'idea' },
    { id: 'blockedParent', plan: { markdown: 'no approval' } },
    { id: 'blockedKid', parentId: 'blockedParent', status: 'idea' },
  ];
  const ready = listReadyTodoLeaves(items);
  const readyIds = ready.map((row) => row.id).sort();
  // 'root' has children; 'b' done; 'c' doing; 'd' has child d1; d1 ready;
  // 'a' ready; 'solo' ready; 'blockedKid' blocked by unapproved parent plan.
  assert.deepEqual(readyIds, ['a', 'd1', 'solo']);
});

runCase('listReadyTodoLeaves: rootId limits to a subtree', () => {
  const items = [
    { id: 'root', plan: { approvedAt: 'yes' } },
    { id: 'a', parentId: 'root', status: 'idea' },
    { id: 'b', parentId: 'root', status: 'idea' },
    { id: 'other', status: 'idea' },
  ];
  const ready = listReadyTodoLeaves(items, { rootId: 'a' });
  assert.deepEqual(ready.map((row) => row.id), ['a']);
  assert.deepEqual(listReadyTodoLeaves(items, { rootId: 'missing' }), []);
  assert.deepEqual(listReadyTodoLeaves([]), []);
});

runCase('listReadyTodoLeaves: rootId scope still sees earlier siblings of a sequential parent', () => {
  const items = [
    { id: 'root', runMode: 'sequential', plan: { approvedAt: 'yes' } },
    { id: 'a', parentId: 'root', siblingIndex: 0, status: 'idea' },
    { id: 'b', parentId: 'root', siblingIndex: 1, status: 'idea' },
  ];
  assert.deepEqual(listReadyTodoLeaves(items, { rootId: 'b' }), []);
});

runCase('listReadyTodoLeaves: a blocked ancestor blocks its descendants', () => {
  const items = [
    { id: 'root', runMode: 'sequential', plan: { approvedAt: 'yes' } },
    { id: 'a', parentId: 'root', siblingIndex: 0, status: 'idea' },
    { id: 'b', parentId: 'root', siblingIndex: 1, status: 'idea', plan: { approvedAt: 'yes' } },
    { id: 'b1', parentId: 'b', siblingIndex: 0, status: 'idea' },
  ];
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), ['a']);
});

process.exit(failed ? 1 : 0);
