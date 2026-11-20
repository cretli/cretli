/**
 * Row-menu rules for integrating a parent whose subtasks own separate
 * worktrees: the subtree action lists eligible leaves in tree order, and the
 * parent is never offered verify / confirm while a child result is un-merged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canConfirmIntegrationFromMenu,
  hasAwaitingDescendantWorktree,
  listSubtreeIntegrateIds,
} from '../app_front/features/todo/services/todoIntegrationRules.js';

const leafWorktree = (id, integrationState = 'ready') => ({ live: true, ownerTodoId: id, integrationState });

function tree() {
  return [
    { id: 'root', status: 'done', integrationSummary: { state: 'awaiting' } },
    { id: 'c2', parentId: 'root', siblingIndex: 1, status: 'done', worktree: leafWorktree('c2'), batchEligibility: { mode: 'smart-merge' } },
    { id: 'c1', parentId: 'root', siblingIndex: 0, status: 'done', worktree: leafWorktree('c1'), batchEligibility: { mode: 'smart-merge' } },
    { id: 'c3', parentId: 'root', siblingIndex: 2, status: 'done', batchEligibility: { mode: 'none', reason: 'already_integrated' } },
  ];
}

test('subtree action lists eligible leaves in tree order', () => {
  const items = tree();
  assert.deepEqual(listSubtreeIntegrateIds(items, items[0]), ['c1', 'c2']);
  assert.deepEqual(listSubtreeIntegrateIds(items, items[2]), [], 'a leaf has no subtree action');
});

test('a parent that owns the live worktree keeps the plain smart merge instead', () => {
  const items = tree().map((row) => ({ ...row, worktree: leafWorktree('root') }));
  assert.deepEqual(listSubtreeIntegrateIds(items, items[0]), []);
});

test('verify / confirm are hidden on a parent until child worktrees are integrated', () => {
  const items = tree();
  assert.equal(hasAwaitingDescendantWorktree(items, items[0]), true);
  assert.equal(canConfirmIntegrationFromMenu(items[0], items), false);
  const merged = items.map((row) => (row.worktree ? { ...row, worktree: leafWorktree(row.id, 'integrated') } : row));
  assert.equal(hasAwaitingDescendantWorktree(merged, merged[0]), false);
  assert.equal(canConfirmIntegrationFromMenu(merged[0], merged), true);
  // Without the list the old single-item rule still applies.
  assert.equal(canConfirmIntegrationFromMenu(items[0]), true);
});
