import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterTodoItemsBySearch,
  filterTodoItemsByRootStatus,
  readTodoRowMark,
  readTodoRowBlockKind,
} from '../app_front/features/todo/todoTreeView.js';
import { isTodoBranchBlocked, listReadyTodoLeaves } from '../lib/todo-tree.js';
import { slimTodoForList } from '../lib/routes/todos-routes.js';

/**
 * Reference implementation: what readTodoRowMark did before the per-list cache
 * (a full rescan of the list for every row).
 */
function referenceMark(items, item) {
  if (isTodoBranchBlocked(items, item)) return 'blocked';
  return listReadyTodoLeaves(items).some((row) => row.id === item.id) ? 'ready' : '';
}

function buildTree() {
  return [
    { id: 'root', title: 'Root', status: 'doing', siblingIndex: 0 },
    { id: 'a', parentId: 'root', title: 'First', status: 'done', siblingIndex: 0 },
    { id: 'b', parentId: 'root', title: 'Second', status: 'ready', siblingIndex: 1 },
    { id: 'c', parentId: 'root', title: 'Third', status: 'ready', siblingIndex: 2 },
    { id: 'p', title: 'Parallel', status: 'ready', runMode: 'parallel', siblingIndex: 1 },
    { id: 'p1', parentId: 'p', title: 'P one', status: 'ready', siblingIndex: 0 },
    { id: 'p2', parentId: 'p', title: 'P two', status: 'ready', siblingIndex: 1 },
    { id: 'x', title: 'Blocked by reason', status: 'ready', blockedReason: 'needs input', siblingIndex: 2 },
    { id: 'idea', title: 'Only an idea', status: 'idea', siblingIndex: 3 },
  ];
}

test('cached row marks match the uncached reference for every item', () => {
  const items = buildTree();
  for (const item of items) {
    assert.equal(readTodoRowMark(items, item), referenceMark(items, item), item.id);
  }
});

test('sequential siblings: only the next open sibling is ready, later ones are blocked', () => {
  const items = buildTree();
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(readTodoRowMark(items, byId.get('b')), 'ready');
  assert.equal(readTodoRowMark(items, byId.get('c')), 'blocked');
  assert.equal(readTodoRowBlockKind(items, byId.get('c')), 'dependency');
  assert.equal(readTodoRowBlockKind(items, byId.get('x')), 'action');
});

test('the cache is keyed by the list: a new array is recomputed, not served stale', () => {
  const first = buildTree();
  const target = first.find((item) => item.id === 'b');
  assert.equal(readTodoRowMark(first, target), 'ready');
  const second = buildTree().map((item) => (item.id === 'a' ? { ...item, status: 'doing' } : item));
  const next = second.find((item) => item.id === 'b');
  assert.equal(readTodoRowMark(second, next), referenceMark(second, next));
  assert.equal(readTodoRowMark(second, next), 'blocked');
  // The first list keeps its own answer.
  assert.equal(readTodoRowMark(first, target), 'ready');
});

test('search matches title or id and keeps ancestors reachable', () => {
  const items = buildTree();
  assert.equal(filterTodoItemsBySearch(items, '  ').length, items.length);
  const hit = filterTodoItemsBySearch(items, 'second').map((item) => item.id);
  assert.deepEqual(hit.sort(), ['b', 'root']);
  const byId = filterTodoItemsBySearch(items, 'P2'.toLowerCase()).map((item) => item.id);
  assert.deepEqual(byId, ['p', 'p2']);
  assert.deepEqual(filterTodoItemsBySearch(items, 'no such task'), []);
});

test('list payload slimming keeps full editor history and drops integration evidence', () => {
  const long = 'x'.repeat(1000);
  const item = {
    id: 't',
    title: 'Task',
    changelog: [
      { at: '2026-10-01T00:00:00Z', kind: 'note', text: 'short' },
      { at: '2026-10-02T00:00:00Z', kind: 'implement', text: long },
    ],
    integration: {
      state: 'integrated',
      branch: 'b',
      evidence: { targetCommit: 'abc' },
      changedFiles: ['a.js', 'b.js'],
    },
    integrationSummary: { state: 'integrated' },
  };
  const slim = slimTodoForList(item);
  assert.equal(slim.changelog.length, 2);
  assert.equal(slim.changelog[0].text, 'short');
  assert.equal(slim.changelog[1].text, item.changelog[1].text);
  assert.equal('evidence' in slim.integration, false);
  assert.equal('changedFiles' in slim.integration, false);
  assert.equal(slim.integration.state, 'integrated');
  assert.equal(slim.integration.branch, 'b');
  assert.deepEqual(slim.integrationSummary, { state: 'integrated' });
  // The stored object is never mutated.
  assert.equal(item.changelog[1].text.length, 1000);
  assert.ok('evidence' in item.integration);
});

test('list slimming tolerates items without changelog or integration', () => {
  assert.deepEqual(slimTodoForList({ id: 'x' }), { id: 'x' });
  assert.equal(slimTodoForList(null), null);
});

test('in-place edits of an item invalidate the cached marks', () => {
  const items = buildTree();
  const second = items.find((item) => item.id === 'b');
  assert.equal(readTodoRowMark(items, second), 'ready');
  items.find((item) => item.id === 'a').status = 'doing';
  assert.equal(readTodoRowMark(items, second), 'blocked');
  second.blockedReason = 'waiting';
  assert.equal(readTodoRowBlockKind(items, second), 'action');
});

test('status filter counts the visible subtree under matching roots', () => {
  const items = [{ id: 'root', status: 'doing' }, { id: 'leaf', parentId: 'root', status: 'ready' }];
  assert.equal(filterTodoItemsByRootStatus(items, new Set(['ready'])).length, 0);
  assert.equal(filterTodoItemsByRootStatus(items, new Set(['doing'])).length, 2);
});
