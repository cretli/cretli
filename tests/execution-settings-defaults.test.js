/**
 * Worktree layout defaults on PATCH.
 *
 * Turning worktree mode on must be a one-click action: the server backfills the
 * four required layout fields from the workspace-derived suggestion, so the
 * operator never has to invent a path. A supplied value always wins and
 * `prepareCommand` is never invented.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyWorkspaceWatcherPatch } from '../lib/workspace-watcher-control.js';
import { createTempRepo, tempDir } from './helpers/temp-git-repo.js';

/**
 * @param {string} workspaceFolder
 * @param {object} policy
 * @returns {object}
 */
function patchPolicy(workspaceFolder, policy) {
  const dataDir = tempDir('cretli-wt-defaults-data-');
  try {
    return applyWorkspaceWatcherPatch({ dataDir, workspaceFolder, patch: { policy } });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('enabling worktree mode backfills the layout from the workspace', (t) => {
  const repo = createTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo.dir, 'package-lock.json'), '{}\n');

  const watcher = patchPolicy(repo.dir, { executionMode: 'worktree' });
  assert.equal(watcher.policy.executionMode, 'worktree');
  assert.equal(watcher.policy.worktree.namespace, path.basename(repo.dir));
  assert.equal(watcher.policy.worktree.root, path.join(path.dirname(fs.realpathSync(repo.dir)), '.cretli-worktrees'));
  assert.equal(watcher.policy.worktree.branchPrefix, `${path.basename(repo.dir)}/todo/`);
  assert.equal(watcher.policy.worktree.directoryPrefix, 't-');
  // `prepareCommand` is the caller's decision; the backfill never invents it.
  assert.deepEqual(watcher.policy.worktree.prepareCommand, []);
});

test('a supplied layout value is never overwritten by the default', (t) => {
  const repo = createTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  const watcher = patchPolicy(repo.dir, {
    executionMode: 'worktree',
    worktree: { root: '/tmp/my-worktrees', namespace: 'mine' },
  });
  assert.equal(watcher.policy.worktree.root, '/tmp/my-worktrees');
  assert.equal(watcher.policy.worktree.namespace, 'mine');
  // Missing fields are still completed so the layout is usable.
  assert.equal(watcher.policy.worktree.branchPrefix, 'mine/todo/');
  assert.equal(watcher.policy.worktree.directoryPrefix, 't-');
});

test('a non-Git workspace keeps the layout untouched instead of inventing one', (t) => {
  const plain = tempDir('cretli-wt-defaults-nogit-');
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));

  const watcher = patchPolicy(plain, { executionMode: 'worktree' });
  assert.equal(watcher.policy.worktree.root, '');
  assert.equal(watcher.policy.worktree.namespace, '');
});

test('project mode is left alone', (t) => {
  const repo = createTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

  const watcher = patchPolicy(repo.dir, { executionMode: 'project' });
  assert.equal(watcher.policy.worktree.root, '');
  assert.equal(watcher.policy.worktree.namespace, '');
});
