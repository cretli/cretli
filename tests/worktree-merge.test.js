/**
 * Git-level worktree merge: preflight, outcome verification, the worktree list
 * read model and the report -> integration confirmation path.
 *
 * Every repository lives under os.tmpdir(); nothing touches the real repo.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import { getWorktreeRecord } from '../lib/persist/worktree-registry-persist.js';
import { ensureWorktree } from '../lib/worktree-manager.js';
import {
  buildSmartMergeRequest,
  reportSmartMergeOutcome,
} from '../lib/workspace-watcher-integration.js';
import {
  GIT_BRANCH_MERGE_MODE,
  preflightGitBranchMerge,
  verifyGitBranchMerge,
} from '../lib/worktree-merge.js';
import { listWorkspaceWorktrees, readWorktreeDiff } from '../lib/worktree-list.js';
import { createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const NO_ACTIVITY = { collectWorkspaceGitActivity: () => ({ busy: false, runningChats: 0, runningDelegations: 0, watcherCycles: 0 }) };

/**
 * @param {string} name
 * @returns {{ dataDir: string, baseDir: string, repo: string, todo: object, record: object, cleanup: () => void }}
 */
function makeSuite(name) {
  const dataDir = tempDir(`cretli-wm-data-${name}-`);
  const baseDir = tempDir(`cretli-wm-base-${name}-`);
  const repo = createTempRepo().dir;
  const todo = addTodo(dataDir, repo, { title: `merge ${name}`, status: 'doing', executionMode: 'worktree' }).item;
  const created = ensureWorktree({
    todoId: todo.id,
    workspaceFolder: repo,
    mode: 'worktree',
    config: worktreeConfig(baseDir),
    registryOptions: { dataDir },
  });
  fs.writeFileSync(path.join(created.record.worktreePath, 'feature.txt'), 'feature\n');
  return {
    dataDir,
    baseDir,
    repo,
    todo,
    record: getWorktreeRecord(todo.id, { dataDir }),
    cleanup: () => {
      for (const dir of [dataDir, baseDir, repo]) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Do what the merge agent is asked to do: commit in the worktree, merge in the main tree.
 *
 * @param {{ repo: string, record: object }} suite
 */
function runAgentMerge(suite) {
  git(suite.record.worktreePath, ['add', '-A']);
  git(suite.record.worktreePath, ['commit', '-qm', 'task work']);
  git(suite.repo, ['merge', '--no-ff', '-m', 'merge task', suite.record.branch]);
}

test('preflight passes on a clean main tree and reports uncommitted worktree files', (t) => {
  const suite = makeSuite('pre-ok');
  t.after(suite.cleanup);
  const result = preflightGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, deps: NO_ACTIVITY });
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.equal(result.targetBranch, 'main');
  assert.equal(result.branch, suite.record.branch);
  assert.equal(result.ahead, false);
  assert.equal(result.uncommittedFiles, 1);
});

test('preflight blocks a dirty main tree, listing the files', (t) => {
  const suite = makeSuite('pre-dirty');
  t.after(suite.cleanup);
  fs.writeFileSync(path.join(suite.repo, 'local.txt'), 'wip\n');
  const result = preflightGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, deps: NO_ACTIVITY });
  assert.equal(result.ok, false);
  const blocker = result.blockers.find((row) => row.code === 'dirty_workspace');
  assert.ok(blocker);
  assert.deepEqual(blocker.paths, ['local.txt']);
});

test('preflight blocks while work is live in the main tree', (t) => {
  const suite = makeSuite('pre-busy');
  t.after(suite.cleanup);
  const busy = { collectWorkspaceGitActivity: () => ({ busy: true, runningChats: 1, runningDelegations: 0, watcherCycles: 0 }) };
  const result = preflightGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, deps: busy });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((row) => row.code === 'workspace_busy'));
});

test('preflight blocks a detached HEAD', (t) => {
  const suite = makeSuite('pre-state');
  t.after(suite.cleanup);
  git(suite.repo, ['checkout', '-q', '--detach']);
  const detached = preflightGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, deps: NO_ACTIVITY });
  assert.ok(detached.blockers.some((row) => row.code === 'detached_head'));
});

test('verification refuses a worktree that was never committed', (t) => {
  const suite = makeSuite('verify-uncommitted');
  t.after(suite.cleanup);
  const result = verifyGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, targetBranch: 'main' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nothing_committed');
});

test('verification refuses a committed branch that is not merged yet', (t) => {
  const suite = makeSuite('verify-not-merged');
  t.after(suite.cleanup);
  git(suite.record.worktreePath, ['add', '-A']);
  git(suite.record.worktreePath, ['commit', '-qm', 'task work']);
  const result = verifyGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, targetBranch: 'main' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_merged');
});

test('verification accepts a merged branch and returns the proof commits', (t) => {
  const suite = makeSuite('verify-ok');
  t.after(suite.cleanup);
  runAgentMerge(suite);
  const result = verifyGitBranchMerge({ workspaceFolder: suite.repo, record: suite.record, targetBranch: 'main' });
  assert.equal(result.ok, true);
  assert.equal(result.targetCommit, git(suite.repo, ['rev-parse', 'main']).trim());
  assert.equal(result.sourceCommit, git(suite.repo, ['rev-parse', suite.record.branch]).trim());
});

test('git-branch merge request: refused untouched when blocked, started with a marker when clear', (t) => {
  const suite = makeSuite('request');
  t.after(suite.cleanup);
  fs.writeFileSync(path.join(suite.repo, 'local.txt'), 'wip\n');
  const blocked = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'dirty_workspace');
  assert.equal(getTodoById(suite.dataDir, suite.repo, suite.todo.id).integration, undefined);
  fs.rmSync(path.join(suite.repo, 'local.txt'));
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    instructions: 'prefer small commits', baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.match(started.prompt, /git merge --no-ff/);
  assert.match(started.prompt, /prefer small commits/);
  assert.match(started.prompt, /smart-merge-report-from-agent/);
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.equal(todo.integration.mergeMode, GIT_BRANCH_MERGE_MODE);
  assert.equal(todo.integration.targetBranch, 'main');
  assert.equal(todo.integration.reason, 'smart_merge_running');
});

test('a verified merged report confirms the integration and marks the todo done', (t) => {
  const suite = makeSuite('report-ok');
  t.after(suite.cleanup);
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  runAgentMerge(suite);
  const reported = reportSmartMergeOutcome({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, outcome: 'merged', summary: 'done',
  });
  assert.equal(reported.ok, true, JSON.stringify(reported));
  assert.equal(reported.confirmed, true);
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.equal(todo.status, 'done');
  assert.equal(todo.integration.state, 'integrated');
  assert.equal(todo.integration.evidence.targetBranch, 'main');
  assert.equal(getWorktreeRecord(suite.todo.id, { dataDir: suite.dataDir }).integrationState, 'integrated');
});

test('a merged report that Git cannot prove stays unconfirmed with a reason', (t) => {
  const suite = makeSuite('report-lie');
  t.after(suite.cleanup);
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const reported = reportSmartMergeOutcome({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, outcome: 'merged',
  });
  assert.equal(reported.ok, false);
  assert.equal(reported.reason, 'merge_unverified');
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.notEqual(todo.status, 'done');
  assert.match(todo.integration.reason, /^git_merge_unverified: nothing_committed/);
});

test('a failed report keeps the todo awaiting integration with the reason', (t) => {
  const suite = makeSuite('report-failed');
  t.after(suite.cleanup);
  const started = buildSmartMergeRequest({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, mode: GIT_BRANCH_MERGE_MODE,
    baseUrl: 'https://127.0.0.1:3011', insecureTls: true,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const reported = reportSmartMergeOutcome({
    todoId: suite.todo.id, workspaceFolder: suite.repo, dataDir: suite.dataDir, outcome: 'failed', summary: 'conflict in a.js',
  });
  assert.equal(reported.ok, true);
  const todo = getTodoById(suite.dataDir, suite.repo, suite.todo.id);
  assert.equal(todo.integration.state, 'ready');
  assert.match(todo.integration.reason, /smart_merge_failed: conflict in a\.js/);
});

test('the worktree list reconciles the registry with Git and derives states', (t) => {
  const suite = makeSuite('list');
  t.after(suite.cleanup);
  const listed = listWorkspaceWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  assert.equal(listed.rows.length, 1);
  const [row] = listed.rows;
  assert.equal(row.todoId, suite.todo.id);
  assert.equal(row.branch, suite.record.branch);
  assert.equal(row.exists, true);
  assert.equal(row.state, 'active');
  assert.equal(row.uncommittedFiles, 1);
  assert.equal(row.title, suite.todo.title);
  fs.rmSync(suite.record.worktreePath, { recursive: true, force: true });
  const afterRemoval = listWorkspaceWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  assert.equal(afterRemoval.rows[0].state, 'missing');
  assert.equal(afterRemoval.rows[0].exists, false);
  assert.equal(afterRemoval.rows[0].actions.merge, false);
});

test('the list only exposes records of the requested workspace', (t) => {
  const suite = makeSuite('list-scope');
  t.after(suite.cleanup);
  const other = createTempRepo().dir;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.equal(listWorkspaceWorktrees({ dataDir: suite.dataDir, workspaceFolder: other }).rows.length, 0);
});

test('the diff is read from the record path and refuses a foreign workspace', (t) => {
  const suite = makeSuite('diff');
  t.after(suite.cleanup);
  git(suite.record.worktreePath, ['add', '-A']);
  git(suite.record.worktreePath, ['commit', '-qm', 'task work']);
  const diff = readWorktreeDiff({ dataDir: suite.dataDir, workspaceFolder: suite.repo, todoId: suite.todo.id });
  assert.equal(diff.ok, true);
  assert.match(diff.patch, /feature\.txt/);
  const other = createTempRepo().dir;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.equal(readWorktreeDiff({ dataDir: suite.dataDir, workspaceFolder: other, todoId: suite.todo.id }).reason, 'not_found');
});
