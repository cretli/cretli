import assert from 'node:assert/strict';
import test from 'node:test';
import { pickNextWorkspaceReadyTodo } from '../lib/workspace-watcher.js';

const tree = (/** @type {any} */ first) => [
  { id: 'p', title: 'Parent', status: 'ready' },
  { id: 'a', parentId: 'p', siblingIndex: 0, status: 'idea', updatedAt: '2026-01-01T00:00:00Z', ...first },
  { id: 'b', parentId: 'p', siblingIndex: 1, status: 'ready', updatedAt: '2026-01-02T00:00:00Z' },
];

test('pick: an open idea sibling blocks the next leaf by default', () => {
  assert.equal(pickNextWorkspaceReadyTodo({ items: tree({}) }), null);
});

test('pick: a nonBlocking idea sibling is skipped and the next leaf is chosen', () => {
  assert.equal(pickNextWorkspaceReadyTodo({ items: tree({ nonBlocking: true }) })?.id, 'b');
});

test('pick: the nonBlocking idea itself is never picked (only ready leaves)', () => {
  const items = tree({ nonBlocking: true });
  items[2].status = 'done';
  assert.equal(pickNextWorkspaceReadyTodo({ items }), null);
});
