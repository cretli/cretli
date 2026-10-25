/**
 * Variant B: per-leaf worktrees branched from the tree branch, merged back
 * after PASS under a tree lock, with background cleanup.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ensureWorktree, verifyWorktreeRecord } from '../lib/worktree-manager.js';
import { getWorktreeRecord } from '../lib/persist/worktree-registry-persist.js';
import {
  ensureLeafWorktree,
  refreshStaleTreeBeforeLeaf,
  isParallelLeafWorktreeEnabled,
  mergeLeafIntoTree,
  pruneWorktreeResults,
  removeWorktreeInBackground,
  syncLeafWithTree,
  TREE_MERGE_CONFLICT_CODE,
} from '../lib/worktree-tree-leaf.js';
import { updateWorktreeState } from '../lib/worktree-manager.js';
import { resolveDelegationWorkspaceWriteConflict } from '../lib/delegation-workspace-guard.js';
import { createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

function setup(name) {
  const dataDir = tempDir(`cretli-tl-data-${name}-`);
  const baseDir = tempDir(`cretli-tl-base-${name}-`);
  const repo = createTempRepo().dir;
  const config = worktreeConfig(baseDir);
  const registryOptions = { dataDir };
  const tree = ensureWorktree({ todoId: 'root1', workspaceFolder: repo, mode: 'worktree', config, registryOptions }).record;
  return { dataDir, baseDir, repo, config, registryOptions, tree };
}

test('policy: parallel + worktree tree or explicit setting enables leaf worktrees', () => {
  assert.equal(isParallelLeafWorktreeEnabled({ tree: { runMode: 'parallel', executionMode: 'worktree' } }), true);
  assert.equal(isParallelLeafWorktreeEnabled({ tree: { runMode: 'sequential', executionMode: 'worktree' } }), false);
  assert.equal(isParallelLeafWorktreeEnabled({ tree: { runMode: 'sequential' }, policy: { parallelLeafWorktrees: true } }), true);
  assert.equal(isParallelLeafWorktreeEnabled({ tree: { runMode: 'parallel', executionMode: 'worktree' }, policy: { parallelLeafWorktrees: false } }), false);
});

test('stale clean tree is archived and refreshed only after an idle preflight', async () => {
  const calls = [];
  const out = await refreshStaleTreeBeforeLeaf({
    treeRecord: { todoId: 'root1', executionState: 'execution_closed' },
    maxBehind: 10,
    hasActiveAgent: () => false,
    readFacts: async () => ({ behind: 11, dirtyPaths: 0, aheadCommits: 0, unintegrated: false }),
    archive: async () => ({ archiveRef: 'refs/cretli/archive/worktree/root1/old' }),
    resolveHead: async () => 'c'.repeat(40),
    skipRecordUpdate: true,
    reset: async () => { calls.push('reset'); },
  });
  assert.equal(out.refreshed, true);
  assert.equal(out.reason, 'refreshed');
  assert.deepEqual(calls, ['reset']);
});

test('stale tree with unintegrated work is archived as a carry and never reset', async () => {
  const calls = [];
  const out = await refreshStaleTreeBeforeLeaf({
    treeRecord: { todoId: 'root1', executionState: 'execution_closed' },
    maxBehind: 10,
    hasActiveAgent: () => false,
    readFacts: async () => ({ behind: 11, dirtyPaths: 1, aheadCommits: 0, unintegrated: true }),
    archive: async () => ({ archiveRef: 'refs/cretli/archive/worktree/root1/old' }),
    saveCarry: async () => '/carry/root1.patch',
    reset: async () => { calls.push('reset'); },
  });
  assert.equal(out.refreshed, false);
  assert.equal(out.reason, 'unresolved_checkpoint');
  assert.equal(out.patchPath, '/carry/root1.patch');
  assert.deepEqual(calls, []);
});

test('refresh resets to the current repository HEAD (not the worktree HEAD) and re-bases the record', async () => {
  const resets = [];
  const out = await refreshStaleTreeBeforeLeaf({
    treeRecord: { todoId: 'root1', executionState: 'execution_closed', repoRoot: '/r' },
    maxBehind: 1,
    hasActiveAgent: () => false,
    readFacts: async () => ({ behind: 5, dirtyPaths: 0, aheadCommits: 0, unintegrated: false }),
    archive: async () => ({ archiveRef: 'refs/x' }),
    resolveHead: async () => 'a'.repeat(40),
    reset: async (_r, commit) => { resets.push(commit); },
    skipRecordUpdate: true,
  });
  assert.deepEqual(resets, ['a'.repeat(40)]);
  assert.equal(out.baseCommit, 'a'.repeat(40));
});

test('refresh is serialized with leaf creation under the per-tree lock', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const tree = { todoId: 'rootL', executionState: 'execution_closed', repoRoot: '/r', worktreePath: '/w', branch: 'b' };
  const refresh = refreshStaleTreeBeforeLeaf({
    treeRecord: tree,
    maxBehind: 1,
    hasActiveAgent: () => false,
    readFacts: async () => { order.push('facts'); await gate; return { behind: 5, dirtyPaths: 0, aheadCommits: 0, unintegrated: false }; },
    archive: async () => ({ archiveRef: 'refs/x' }),
    resolveHead: async () => 'b'.repeat(40),
    reset: async () => { order.push('reset'); },
    skipRecordUpdate: true,
  });
  const leaf = ensureLeafWorktree({
    leafTodoId: 'leafL', treeRecord: tree, config: {},
    ensure: async () => { order.push('leaf'); return { record: {}, created: true }; },
  }).catch(() => order.push('leaf-failed'));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(order, ['facts']);
  release();
  await Promise.all([refresh, leaf]);
  assert.equal(order[1], 'reset');
});

test('work that arrived during the wait blocks the reset (facts read inside the lock)', async () => {
  const calls = [];
  const out = await refreshStaleTreeBeforeLeaf({
    treeRecord: { todoId: 'rootW', executionState: 'execution_closed' },
    maxBehind: 1,
    hasActiveAgent: () => false,
    readFacts: async () => ({ behind: 5, dirtyPaths: 0, aheadCommits: 2, unintegrated: true }),
    archive: async () => ({ archiveRef: 'refs/x' }),
    saveCarry: async () => null,
    reset: async () => { calls.push('reset'); },
  });
  assert.equal(out.reason, 'unresolved_checkpoint');
  assert.deepEqual(calls, []);
});

test('tree refresh fails closed without an active-agent check', async () => {
  const out = await refreshStaleTreeBeforeLeaf({
    treeRecord: { todoId: 'root1', executionState: 'execution_closed' },
    readFacts: async () => ({ behind: 999 }),
  });
  assert.equal(out.reason, 'agent_check_unavailable');
});

test('3 leaves with disjoint scopes: parallel worktrees, merge into tree, single integration diff', async () => {
  const s = setup('three');
  const leaves = await Promise.all(['a', 'b', 'c'].map((id) => ensureLeafWorktree({
    leafTodoId: `leaf-${id}`, treeRecord: s.tree, config: s.config, registryOptions: s.registryOptions,
  })));
  const paths = new Set(leaves.map((l) => l.record.worktreePath));
  assert.equal(paths.size, 3);
  for (const l of leaves) {
    assert.equal(l.record.treeTodoId, 'root1');
    assert.equal(l.record.baseCommit, git(s.tree.worktreePath, ['rev-parse', s.tree.branch]).trim());
    assert.ok(l.createMs >= 0);
  }
  // Distinct execution folders: the workspace write slot does not serialize them.
  const active = leaves.slice(0, 2).map((l, i) => ({ id: `d${i}`, status: 'running', assignment: 'implement', parentChatId: `p${i}`, executionFolder: l.record.worktreePath, workspaceFolder: s.repo }));
  const conflict = resolveDelegationWorkspaceWriteConflict({ active, workspaceFolder: s.repo, executionFolder: leaves[2].record.worktreePath, parentChatId: 'p9', incomingAssignment: 'implement' });
  assert.equal(conflict.ok, true);

  leaves.forEach((l, i) => fs.writeFileSync(path.join(l.record.worktreePath, `file-${i}.txt`), `leaf ${i}\n`));
  const results = await Promise.all(leaves.map((l) => mergeLeafIntoTree({ leafRecord: l.record, treeRecord: s.tree })));
  assert.deepEqual(results.map((r) => r.status), ['merged', 'merged', 'merged']);
  for (let i = 0; i < 3; i += 1) assert.ok(fs.existsSync(path.join(s.tree.worktreePath, `file-${i}.txt`)));
  assert.equal(git(s.tree.worktreePath, ['status', '--porcelain']).trim(), '');
  // One integration patch for the whole tree against the frozen tree base.
  const diff = git(s.tree.worktreePath, ['diff', '--name-only', s.tree.baseCommit, 'HEAD']).trim().split('\n').sort();
  assert.deepEqual(diff, ['file-0.txt', 'file-1.txt', 'file-2.txt']);

  // Cleanup returns quickly and deletes in the background.
  const cleaned = await removeWorktreeInBackground({ todoId: 'leaf-a', registryOptions: s.registryOptions, deleteBranch: true });
  assert.equal(cleaned.removed, true);
  assert.equal(fs.existsSync(leaves[0].record.worktreePath), false);
  const freed = await cleaned.done;
  assert.ok(freed.freedBytes > 0);
  assert.equal(fs.existsSync(cleaned.trashPath), false);
  assert.ok(getWorktreeRecord('leaf-a', s.registryOptions).cleanedAt);
  assert.equal(git(s.repo, ['branch', '--list', 'cretli/todo/leaf-a']).trim(), '');
});

test('merge conflict is aborted cleanly and returns to the leaf for a fix round', async () => {
  const s = setup('conflict');
  const a = await ensureLeafWorktree({ leafTodoId: 'leaf-a', treeRecord: s.tree, config: s.config, registryOptions: s.registryOptions });
  const b = await ensureLeafWorktree({ leafTodoId: 'leaf-b', treeRecord: s.tree, config: s.config, registryOptions: s.registryOptions });
  fs.writeFileSync(path.join(a.record.worktreePath, 'README.md'), 'from a\n');
  fs.writeFileSync(path.join(b.record.worktreePath, 'README.md'), 'from b\n');
  assert.equal((await mergeLeafIntoTree({ leafRecord: a.record, treeRecord: s.tree })).status, 'merged');
  const second = await mergeLeafIntoTree({ leafRecord: b.record, treeRecord: s.tree });
  assert.equal(second.status, 'conflict');
  assert.deepEqual(second.conflicts, ['README.md']);
  assert.equal(git(s.tree.worktreePath, ['status', '--porcelain']).trim(), '', 'tree worktree is left clean');
  assert.equal(fs.readFileSync(path.join(s.tree.worktreePath, 'README.md'), 'utf8'), 'from a\n');
  // Fix round: the leaf picks up the current tree branch, resolves, and merges.
  const sync = await syncLeafWithTree({ leafRecord: b.record, treeRecord: s.tree });
  assert.equal(sync.clean, false);
  assert.deepEqual(sync.conflicts, ['README.md']);
  fs.writeFileSync(path.join(b.record.worktreePath, 'README.md'), 'from a and b\n');
  const retry = await mergeLeafIntoTree({ leafRecord: b.record, treeRecord: s.tree });
  assert.equal(retry.status, 'merged');
  assert.equal(fs.readFileSync(path.join(s.tree.worktreePath, 'README.md'), 'utf8'), 'from a and b\n');
});

test('cleanup refuses an active worktree; retention prunes old results only', async () => {
  const s = setup('clean');
  const a = await ensureLeafWorktree({ leafTodoId: 'leaf-a', treeRecord: s.tree, config: s.config, registryOptions: s.registryOptions });
  updateWorktreeState({ todoId: 'leaf-a', registryOptions: s.registryOptions, executionState: 'active' });
  await assert.rejects(removeWorktreeInBackground({ todoId: 'leaf-a', registryOptions: s.registryOptions }), /active/);
  assert.ok(fs.existsSync(a.record.worktreePath));
  const results = path.join(s.dataDir, 'worktree-results');
  fs.mkdirSync(path.join(results, 'old'), { recursive: true });
  fs.mkdirSync(path.join(results, 'fresh'), { recursive: true });
  fs.writeFileSync(path.join(results, 'old', 'p.patch'), 'x'.repeat(100));
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(path.join(results, 'old'), past, past);
  const pruned = pruneWorktreeResults({ dataDir: s.dataDir });
  assert.deepEqual(pruned.removed, ['old']);
  assert.ok(fs.existsSync(path.join(results, 'fresh')));
});

// ---- Watcher wiring: prepare -> merge -> cleanup, and conflict -> fix round ----

import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import { applyParallelLeafMerge, resolveParallelLeafWorktree } from '../lib/workspace-watcher-cycle-close.js';

function wiring(name) {
  const s = setup(name);
  const root = addTodo(s.dataDir, s.repo, { title: 'root', status: 'doing' }).item;
  const tree = ensureWorktree({ todoId: root.id, workspaceFolder: s.repo, mode: 'worktree', config: s.config, registryOptions: s.registryOptions }).record;
  return { ...s, root, tree };
}

async function leafFor(s, title) {
  const todo = addTodo(s.dataDir, s.repo, { title, status: 'doing', parentId: s.root.id }).item;
  const leaf = await ensureLeafWorktree({ leafTodoId: todo.id, treeRecord: s.tree, config: s.config, registryOptions: s.registryOptions });
  return { todo, leaf: leaf.record };
}

test('wiring: resolveParallelLeafWorktree only returns per-leaf worktrees', async () => {
  const s = wiring('resolve');
  const { todo } = await leafFor(s, 'a');
  assert.equal(resolveParallelLeafWorktree({ todoId: todo.id, dataDir: s.dataDir }).tree.todoId, s.root.id);
  assert.equal(resolveParallelLeafWorktree({ todoId: s.root.id, dataDir: s.dataDir }), null);
  assert.equal(resolveParallelLeafWorktree({ todoId: 'nope', dataDir: s.dataDir }), null);
});

test('wiring: PASS -> merge into tree -> leaf done and its worktree removed in background', async () => {
  const s = wiring('merge');
  const { todo, leaf } = await leafFor(s, 'a');
  fs.writeFileSync(path.join(leaf.worktreePath, 'a.txt'), 'a\n');
  const out = await applyParallelLeafMerge({ workspaceFolder: s.repo, dataDir: s.dataDir, todoId: todo.id, at: new Date().toISOString() });
  assert.equal(out.status, 'merged');
  assert.equal(out.decision.kind, 'leaf_merged_into_tree');
  assert.ok(fs.existsSync(path.join(s.tree.worktreePath, 'a.txt')));
  const row = getTodoById(s.dataDir, s.repo, todo.id);
  assert.equal(row.status, 'done');
  assert.match(JSON.stringify(row.changelog), /Merged into the tree worktree/);
  const freed = await out.freed;
  assert.ok(freed.freedBytes > 0);
  assert.equal(fs.existsSync(leaf.worktreePath), false);
  assert.ok(getWorktreeRecord(todo.id, s.registryOptions).cleanedAt);
});

test('wiring: conflict returns the leaf to ready and marks its record for a fix round', async () => {
  const s = wiring('conflict');
  const a = await leafFor(s, 'a');
  const b = await leafFor(s, 'b');
  fs.writeFileSync(path.join(a.leaf.worktreePath, 'README.md'), 'from a\n');
  fs.writeFileSync(path.join(b.leaf.worktreePath, 'README.md'), 'from b\n');
  const at = new Date().toISOString();
  assert.equal((await applyParallelLeafMerge({ workspaceFolder: s.repo, dataDir: s.dataDir, todoId: a.todo.id, at })).status, 'merged');
  const out = await applyParallelLeafMerge({ workspaceFolder: s.repo, dataDir: s.dataDir, todoId: b.todo.id, at });
  assert.equal(out.status, 'conflict');
  assert.deepEqual(out.conflicts, ['README.md']);
  assert.equal(getTodoById(s.dataDir, s.repo, b.todo.id).status, 'ready');
  const record = getWorktreeRecord(b.todo.id, s.registryOptions);
  assert.equal(record.lastError.code, TREE_MERGE_CONFLICT_CODE);
  assert.ok(fs.existsSync(record.worktreePath), 'leaf worktree kept for the fix round');
});

test('F1: tree and leaf records still verify after merge commits; a foreign commit is external_change', async () => {
  const s = wiring('verify');
  const a = await leafFor(s, 'a');
  const b = await leafFor(s, 'b');
  fs.writeFileSync(path.join(a.leaf.worktreePath, 'README.md'), 'from a\n');
  fs.writeFileSync(path.join(b.leaf.worktreePath, 'README.md'), 'from b\n');
  await mergeLeafIntoTree({ leafRecord: a.leaf, treeRecord: s.tree });
  assert.equal((await mergeLeafIntoTree({ leafRecord: b.leaf, treeRecord: s.tree })).status, 'conflict');
  assert.equal(verifyWorktreeRecord(getWorktreeRecord(s.root.id, s.registryOptions)).status, 'verified');
  await syncLeafWithTree({ leafRecord: b.leaf, treeRecord: s.tree });
  fs.writeFileSync(path.join(b.leaf.worktreePath, 'README.md'), 'ab\n');
  assert.equal((await mergeLeafIntoTree({ leafRecord: b.leaf, treeRecord: s.tree })).status, 'merged');
  assert.equal(verifyWorktreeRecord(getWorktreeRecord(b.todo.id, s.registryOptions)).status, 'verified');
  assert.equal(verifyWorktreeRecord(getWorktreeRecord(s.root.id, s.registryOptions)).status, 'verified');
  fs.writeFileSync(path.join(s.tree.worktreePath, 'foreign.txt'), 'x\n');
  git(s.tree.worktreePath, ['add', '-A']);
  git(s.tree.worktreePath, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-m', 'foreign change']);
  assert.equal(verifyWorktreeRecord(getWorktreeRecord(s.root.id, s.registryOptions)).status, 'external_change');
});

test('F2: a thrown merge keeps the leaf worktree, marks the record and blocks the todo', async () => {
  const s = wiring('throw');
  const { todo, leaf } = await leafFor(s, 'a');
  fs.writeFileSync(path.join(leaf.worktreePath, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(s.tree.worktreePath, 'dirty.txt'), 'dirty\n');
  const out = await applyParallelLeafMerge({ workspaceFolder: s.repo, dataDir: s.dataDir, todoId: todo.id, at: new Date().toISOString() });
  assert.equal(out.status, 'failed');
  assert.equal(out.decision.kind, 'leaf_merge_failed');
  assert.ok(fs.existsSync(leaf.worktreePath));
  assert.equal(getWorktreeRecord(todo.id, s.registryOptions).lastError.code, 'TREE_MERGE_FAILED');
  const row = getTodoById(s.dataDir, s.repo, todo.id);
  assert.match(row.blockedReason, /Merge into the tree worktree failed/);
});

test('real git: refresh moves the tree branch to the repository HEAD, archives the old tip and updates baseCommit', async () => {
  const s = setup('refresh-real');
  const oldBase = s.tree.baseCommit;
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(s.repo, 'newer.txt'), 'x');
  git(['add', '-A'], s.repo);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'newer'], s.repo);
  const head = git(['rev-parse', 'HEAD'], s.repo);
  const out = await refreshStaleTreeBeforeLeaf({
    treeRecord: s.tree,
    maxBehind: 1,
    force: true,
    registryOptions: s.registryOptions,
    hasActiveAgent: () => false,
  });
  assert.equal(out.reason, 'refreshed');
  assert.equal(git(['rev-parse', 'HEAD'], s.tree.worktreePath), head);
  assert.equal(git(['rev-parse', out.archiveRef], s.repo), oldBase);
  assert.equal(getWorktreeRecord('root1', s.registryOptions).baseCommit, head);
});
