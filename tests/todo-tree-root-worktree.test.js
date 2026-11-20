/**
 * Root-keyed manual trees: a worktree adopted from a finished stage keeps that
 * stage's directory and branch, and an integration result recorded on the root
 * while later stages are still open must be confirmable.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { adoptDescendantWorktree, ensureWorktree, updateWorktreeState } from '../lib/worktree-manager.js';
import { confirmWorkspaceTodoIntegration } from '../lib/workspace-watcher-integration.js';
import { createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

function makeSuite(t) {
  const dataDir = tempDir('cretli-root-wt-data-');
  const baseDir = tempDir('cretli-root-wt-base-');
  const repo = createTempRepo().dir;
  t.after(() => {
    for (const dir of [dataDir, baseDir, repo]) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dataDir, baseDir, repo };
}

test('a root start reuses a worktree adopted from a descendant instead of refusing it as re-pointed', (t) => {
  const { dataDir, baseDir, repo } = makeSuite(t);
  const config = worktreeConfig(baseDir);
  const registryOptions = { dataDir };
  const root = addTodo(dataDir, repo, { title: 'root', status: 'ready' }).item;
  const leaf = addTodo(dataDir, repo, { title: 'stage', status: 'ready', parentId: root.id }).item;

  const created = ensureWorktree({ todoId: leaf.id, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  updateWorktreeState({ todoId: leaf.id, registryOptions, executionState: 'active' });
  const adopted = adoptDescendantWorktree({
    rootTodoId: root.id,
    candidateTodoIds: [root.id, leaf.id],
    registryOptions,
    hasActiveAgent: () => false,
  });
  assert.equal(adopted.adopted, true, adopted.reason);

  const reused = ensureWorktree({ todoId: root.id, workspaceFolder: repo, mode: 'worktree', config, registryOptions });
  assert.equal(reused.reused, true);
  assert.equal(reused.record.worktreePath, created.record.worktreePath);
  assert.equal(reused.record.branch, created.record.branch);
});

test('a frozen record whose layout really changed is still refused', (t) => {
  const { dataDir, baseDir, repo } = makeSuite(t);
  const registryOptions = { dataDir };
  const todo = addTodo(dataDir, repo, { title: 'task', status: 'ready' }).item;
  ensureWorktree({ todoId: todo.id, workspaceFolder: repo, mode: 'worktree', config: worktreeConfig(baseDir), registryOptions });
  const moved = { ...worktreeConfig(baseDir), namespace: 'elsewhere' };
  assert.throws(
    () => ensureWorktree({ todoId: todo.id, workspaceFolder: repo, mode: 'worktree', config: moved, registryOptions }),
    (error) => /** @type {any} */ (error).code === 'WORKTREE_REGISTRY_CONFLICT',
  );
});

test('confirming a root result while later stages are open integrates it without closing the parent', async (t) => {
  const { dataDir, repo } = makeSuite(t);
  const root = addTodo(dataDir, repo, { title: 'root', status: 'ready', runMode: 'sequential' }).item;
  addTodo(dataDir, repo, { title: 'stage 1', status: 'done', parentId: root.id, siblingIndex: 0 });
  const open = addTodo(dataDir, repo, { title: 'stage 2', status: 'ready', parentId: root.id, siblingIndex: 1 }).item;
  updateTodo(dataDir, repo, root.id, { status: 'doing', integration: { state: 'ready', materialRevision: 'material-1' } });

  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  const confirmed = await confirmWorkspaceTodoIntegration({
    todoId: root.id,
    workspaceFolder: repo,
    dataDir,
    expectedUpdatedAt: getTodoById(dataDir, repo, root.id).updatedAt,
    proof: {
      targetBranch: 'main',
      targetCommit: head,
      sourceCommit: head,
      materialRevision: 'material-1',
      changeRef: 'stage 1 result',
      changeAttested: true,
    },
  });
  assert.equal(confirmed.ok, true, `${confirmed.reason} ${confirmed.detail || ''}`);
  const after = getTodoById(dataDir, repo, root.id);
  assert.equal(after.integration.state, 'integrated');
  assert.notEqual(after.status, 'done');
  assert.equal(getTodoById(dataDir, repo, open.id).status, 'ready');
});
