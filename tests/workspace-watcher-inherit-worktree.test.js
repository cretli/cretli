import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  workspaceWatcherTodoPool,
  isWorkspaceWatcherLeafBehindWorktreeAncestor,
  workspaceWatcherTodoIdPool,
  partitionWorkspaceWatcherCyclesByPool,
  workspaceWatcherStartPoolGate,
} from '../lib/workspace-watcher-pool.js';
import { applyWorkspaceWatcherPatch, getWorkspaceWatcherView } from '../lib/workspace-watcher-control.js';
import { withEffectiveExecutionPolicy } from '../lib/execution-settings.js';
import { getWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { saveExecutionSettings } from '../lib/persist/execution-settings-persist.js';

const root = { id: 'root', executionMode: 'worktree', parentId: '' };
const mid = { id: 'mid', executionMode: 'inherit', parentId: 'root' };
const leaf = { id: 'leaf', executionMode: 'inherit', parentId: 'mid', status: 'ready' };
const items = [root, mid, leaf];

test('an inherit leaf under a worktree ancestor resolves to the worktree pool', () => {
  assert.equal(workspaceWatcherTodoPool(leaf, { executionMode: 'project' }, items), 'worktree');
  assert.equal(isWorkspaceWatcherLeafBehindWorktreeAncestor(leaf, items, { executionMode: 'project' }), false);
});

test('without the parent chain, and for explicit project leaves, nothing changes', () => {
  assert.equal(workspaceWatcherTodoPool(leaf, { executionMode: 'project' }), 'project');
  const explicit = { ...leaf, executionMode: 'project' };
  assert.equal(workspaceWatcherTodoPool(explicit, {}, items), 'project');
  assert.equal(isWorkspaceWatcherLeafBehindWorktreeAncestor(explicit, items, {}), true);
});

test('the watcher view policy follows the saved execution settings', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwatch-exec-'));
  const workspaceFolder = path.join(dataDir, 'my-app');
  fs.mkdirSync(workspaceFolder);
  saveExecutionSettings(workspaceFolder, { executionMode: 'worktree' }, { dataDir });
  applyWorkspaceWatcherPatch({ dataDir, workspaceFolder, patch: { policy: { requirePlanApproval: false } } });
  const view = await getWorkspaceWatcherView({ dataDir, workspaceFolder });
  assert.equal(view.watcher.policy.executionMode, 'worktree');
});

test('pool gate and cycle partition honour ancestor inheritance', () => {
  const todos = new Map(items.map((row) => [row.id, row]));
  const policy = { executionMode: 'project', maxParallel: 4, maxParallelProject: 1, maxParallelWorktree: 2 };
  assert.equal(workspaceWatcherTodoIdPool('leaf', { todos, policy }), 'worktree');
  const cycles = [{ cycleId: 'c1', todoIds: ['leaf'] }];
  const partition = partitionWorkspaceWatcherCyclesByPool({ cycles, todos, policy });
  assert.equal(partition.worktree.length, 1);
  assert.equal(partition.project.length, 0);
  // The single project slot is free, so a project-capped policy must not block the worktree leaf.
  const gate = workspaceWatcherStartPoolGate({ todoId: 'leaf', cycles: [{ cycleId: 'p', todoIds: ['proj'] }], todos: new Map([...todos, ['proj', { id: 'proj', executionMode: 'project' }]]), policy, snapshot: {} });
  assert.equal(gate.full, false);
});

test('the tick picks the worktree pool for an inherit leaf when only saved settings say worktree', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwatch-tick-'));
  const workspaceFolder = path.join(dataDir, 'my-app');
  fs.mkdirSync(workspaceFolder);
  saveExecutionSettings(workspaceFolder, { executionMode: 'worktree' }, { dataDir });
  applyWorkspaceWatcherPatch({ dataDir, workspaceFolder, patch: { mode: 'observe', policy: { executionMode: undefined } } });
  const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const effective = withEffectiveExecutionPolicy(row, workspaceFolder, dataDir);
  assert.equal(effective.policy.executionMode, 'worktree');
  assert.equal(workspaceWatcherTodoPool({ id: 'x', executionMode: 'inherit' }, effective.policy), 'worktree');
  assert.equal(workspaceWatcherTodoPool({ id: 'x', executionMode: 'inherit' }, row.policy), 'project');
});
