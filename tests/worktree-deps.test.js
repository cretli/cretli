/**
 * Cheap worktrees: shared node_modules store, disk guard, cleanup and report.
 * All repositories live under os.tmpdir(); no network or real `npm ci`.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addTodo, updateTodo } from '../lib/persist/todos-persist.js';
import { getWorktreeRecord } from '../lib/persist/worktree-registry-persist.js';
import { prepareWorkspaceWatcherExecution } from '../lib/workspace-watcher-worktree.js';
import { updateWorktreeState } from '../lib/worktree-manager.js';
import {
  assertWorktreeDiskSpace,
  buildWorktreeReport,
  classifyWorktreeForCleanup,
  cleanupWorktrees,
  directorySizeBytes,
  hashLockfile,
  resolveMinFreeGb,
} from '../lib/worktree-deps.js';
import { WORKTREE_ERROR_CODES, WorktreeError } from '../lib/worktree/worktree-errors.ts';
import { createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const GIB = 1024 ** 3;

function makeSuite(name) {
  const dataDir = tempDir(`cretli-wtd-data-${name}-`);
  const baseDir = tempDir(`cretli-wtd-base-${name}-`);
  const repo = createTempRepo().dir;
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 3 }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, ['add', 'package-lock.json', '.gitignore']);
  git(repo, ['commit', '-qm', 'lock']);
  return {
    dataDir, baseDir, repo,
    cleanup: () => { for (const d of [dataDir, baseDir, repo]) fs.rmSync(d, { recursive: true, force: true }); },
  };
}

/** Prepare run that fakes `npm ci` by writing a node_modules with many files. */
function fakeNpmDeps(counter) {
  return {
    execFileFn: (_cmd, _args, _opts, cb) => cb(null, '', ''),
    runPrepareCommand: async ({ cwd }) => {
      counter.runs += 1;
      const dir = path.join(cwd, 'node_modules', 'pkg');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(dir, `f${i}.js`), 'x'.repeat(64 * 1024));
    },
  };
}

function prep(suite, todoId, deps, extraConfig = {}) {
  return prepareWorkspaceWatcherExecution({
    todoId,
    workspaceFolder: suite.repo,
    todo: { executionMode: 'worktree' },
    policy: {
      executionMode: 'worktree',
      worktree: { ...worktreeConfig(suite.baseDir), prepareCommand: ['npm', 'ci'], minFreeGb: 0, ...extraConfig },
    },
    dataDir: suite.dataDir,
    deps,
  });
}

test('shared deps: second worktree with the same lock skips prepare and hardlinks node_modules', async (t) => {
  const suite = makeSuite('shared');
  t.after(suite.cleanup);
  const counter = { runs: 0 };
  const deps = fakeNpmDeps(counter);
  const a = await prep(suite, '11111111-1111-1111-1111-111111111111', deps);
  const b = await prep(suite, '22222222-2222-2222-2222-222222222222', deps);
  assert.equal(counter.runs, 1, 'prepare runs only for the first lock');
  const fileA = path.join(a.record.worktreePath, 'node_modules/pkg/f0.js');
  const fileB = path.join(b.record.worktreePath, 'node_modules/pkg/f0.js');
  assert.equal(fs.statSync(fileA).ino, fs.statSync(fileB).ino, 'files are hardlinked, not copied');
  const seen = new Set();
  directorySizeBytes(a.record.worktreePath, seen);
  const marginal = directorySizeBytes(b.record.worktreePath, seen);
  assert.ok(marginal < 200 * 1024 * 1024, 'marginal growth stays under 200 MB');
  assert.ok(marginal < 1024 * 1024, 'and here only directories/metadata');
});

test('shared deps: reusing a worktree keeps its hardlinked node_modules (no second npm ci)', async (t) => {
  const suite = makeSuite('reuse');
  t.after(suite.cleanup);
  const counter = { runs: 0 };
  const deps = fakeNpmDeps(counter);
  const todoA = '77777777-7777-7777-7777-777777777777';
  const todoB = '88888888-8888-8888-8888-888888888888';
  await prep(suite, todoA, deps);
  const b = await prep(suite, todoB, deps);
  const file = path.join(b.record.worktreePath, 'node_modules/pkg/f0.js');
  const inode = fs.statSync(file).ino;
  // A retry, fix round or restart re-queue prepares the same worktree again.
  const again = await prep(suite, todoB, deps);
  assert.equal(again.record.worktreePath, b.record.worktreePath);
  assert.equal(counter.runs, 1, 'prepare ran only for the first worktree');
  assert.equal(fs.statSync(file).ino, inode, 'the hardlinked tree was not replaced by a copy');
  // The first worktree (prepared by npm ci) is also up to date on reuse.
  await prep(suite, todoA, deps);
  assert.equal(counter.runs, 1);
});

test('shared deps: a reused worktree whose lockfile changed runs prepare again', async (t) => {
  const suite = makeSuite('reuse-lock');
  t.after(suite.cleanup);
  const counter = { runs: 0 };
  const deps = fakeNpmDeps(counter);
  const todo = '99999999-9999-9999-9999-999999999999';
  const first = await prep(suite, todo, deps);
  fs.writeFileSync(path.join(first.record.worktreePath, 'package-lock.json'), JSON.stringify({ name: 'z', lockfileVersion: 3 }));
  await prep(suite, todo, deps);
  assert.equal(counter.runs, 2, 'stale node_modules for the new lock is reinstalled');
});

test('shared deps: a different lockfile misses the store and runs prepare again', async (t) => {
  const suite = makeSuite('lockdiff');
  t.after(suite.cleanup);
  const counter = { runs: 0 };
  const deps = fakeNpmDeps(counter);
  await prep(suite, '33333333-3333-3333-3333-333333333333', deps);
  fs.writeFileSync(path.join(suite.repo, 'package-lock.json'), JSON.stringify({ name: 'y', lockfileVersion: 3 }));
  git(suite.repo, ['commit', '-qam', 'new lock']);
  await prep(suite, '44444444-4444-4444-4444-444444444444', deps);
  assert.equal(counter.runs, 2);
});

test('shared deps: sharedDeps:false and non-npm-ci commands always run prepare', async (t) => {
  const suite = makeSuite('optout');
  t.after(suite.cleanup);
  const counter = { runs: 0 };
  const deps = fakeNpmDeps(counter);
  await prep(suite, '55555555-5555-5555-5555-555555555555', deps, { sharedDeps: false });
  await prep(suite, '66666666-6666-6666-6666-666666666666', deps, { sharedDeps: false });
  assert.equal(counter.runs, 2);
  assert.equal(fs.existsSync(path.join(suite.baseDir, 'worktrees', '.shared-deps')), false);
});

test('disk guard refuses a new worktree below the floor and writes no record', async (t) => {
  const suite = makeSuite('disk');
  t.after(suite.cleanup);
  const todoId = '77777777-7777-7777-7777-777777777777';
  await assert.rejects(
    () => prep(suite, todoId, { ...fakeNpmDeps({ runs: 0 }), statfs: () => ({ bavail: 5, bsize: GIB }) }, { minFreeGb: 20 }),
    (e) => e instanceof WorktreeError && e.code === WORKTREE_ERROR_CODES.DISK_LOW && /5 GB free/.test(e.message),
  );
  assert.equal(getWorktreeRecord(todoId, { dataDir: suite.dataDir }), null);
});

test('assertWorktreeDiskSpace: ok above floor, disabled by 0, defaults to 20', () => {
  const statfs = () => ({ bavail: 30, bsize: GIB });
  assert.equal(assertWorktreeDiskSpace({ root: '/', config: {}, statfs }).ok, true);
  assert.equal(resolveMinFreeGb({}), 20);
  assert.equal(resolveMinFreeGb({ minFreeGb: 0 }), 0);
  assert.throws(() => assertWorktreeDiskSpace({ root: '/', config: { minFreeGb: 50 }, statfs }), /need at least 50 GB/);
  assert.equal(assertWorktreeDiskSpace({ root: '/', config: { minFreeGb: 0 }, statfs: () => ({ bavail: 0, bsize: 1 }) }).ok, true);
});

test('hashLockfile is content-keyed', (t) => {
  const dir = tempDir('cretli-wtd-hash-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'package-lock.json');
  fs.writeFileSync(f, 'a');
  const h1 = hashLockfile(f);
  fs.writeFileSync(f, 'b');
  assert.notEqual(h1, hashLockfile(f));
  assert.equal(hashLockfile(path.join(dir, 'missing')), '');
});

test('classifyWorktreeForCleanup keeps unintegrated and active, removes decided ones', () => {
  const base = { executionState: 'execution_closed', creationState: 'ready', integrationState: 'pending' };
  assert.equal(classifyWorktreeForCleanup({ ...base, integrationState: 'integrated' }, null).category, 'removable');
  assert.equal(classifyWorktreeForCleanup({ ...base, integrationState: 'rejected' }, null).reason, 'rejected');
  assert.equal(classifyWorktreeForCleanup(base, { status: 'doing', integration: { state: 'ready' } }).reason, 'awaiting_integration');
  assert.equal(classifyWorktreeForCleanup(base, null).category, 'keep');
  assert.equal(classifyWorktreeForCleanup({ ...base, executionState: 'active', integrationState: 'integrated' }, null).category, 'keep');
});

test('cleanup is dry-run by default, removes integrated/rejected, keeps the rest', async (t) => {
  const suite = makeSuite('cleanup');
  t.after(suite.cleanup);
  const deps = fakeNpmDeps({ runs: 0 });
  const ids = {
    integrated: 'aaaaaaa1-0000-0000-0000-000000000001',
    rejected: 'aaaaaaa2-0000-0000-0000-000000000002',
    pending: 'aaaaaaa3-0000-0000-0000-000000000003',
  };
  const opts = { dataDir: suite.dataDir };
  for (const id of Object.values(ids)) {
    await prep(suite, id, deps);
    updateWorktreeState({ todoId: id, registryOptions: opts, executionState: 'execution_closed' });
  }
  updateWorktreeState({ todoId: ids.integrated, registryOptions: opts, integrationState: 'integrated' });
  updateWorktreeState({ todoId: ids.rejected, registryOptions: opts, integrationState: 'rejected' });

  const report = buildWorktreeReport({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  assert.equal(report.rows.length, 3);
  assert.deepEqual(report.rows.filter((r) => r.category === 'removable').map((r) => r.todoId).sort(), [ids.integrated, ids.rejected].sort());
  assert.ok(report.rows.every((r) => r.sizeBytes > 0));

  const dry = cleanupWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.candidates.length, 2);
  assert.equal(dry.removed.length, 0);
  for (const id of Object.values(ids)) {
    assert.equal(fs.existsSync(getWorktreeRecord(id, opts).worktreePath), true, 'dry-run removes nothing');
  }

  const real = cleanupWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo, apply: true });
  assert.equal(real.removed.length, 2, JSON.stringify(real.failed));
  assert.deepEqual(real.kept.map((r) => r.todoId), [ids.pending]);
  assert.equal(fs.existsSync(getWorktreeRecord(ids.integrated, opts).worktreePath), false);
  assert.equal(fs.existsSync(getWorktreeRecord(ids.pending, opts).worktreePath), true);
  assert.ok(getWorktreeRecord(ids.integrated, opts).cleanedAt);
});

test('cleanup skips a worktree whose agent is still active', async (t) => {
  const suite = makeSuite('busy');
  t.after(suite.cleanup);
  const id = 'bbbbbbb1-0000-0000-0000-000000000001';
  await prep(suite, id, fakeNpmDeps({ runs: 0 }));
  updateWorktreeState({ todoId: id, registryOptions: { dataDir: suite.dataDir }, executionState: 'execution_closed', integrationState: 'integrated' });
  const result = cleanupWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo, apply: true, hasActiveAgent: () => true });
  assert.equal(result.removed.length, 0);
  assert.equal(result.failed.length, 1);
});

test('cleanup never removes a rejected worktree with modified or untracked files', async (t) => {
  const suite = makeSuite('dirty');
  t.after(suite.cleanup);
  const deps = fakeNpmDeps({ runs: 0 });
  const opts = { dataDir: suite.dataDir };
  const untracked = 'ccccccc1-0000-0000-0000-000000000001';
  const modified = 'ccccccc2-0000-0000-0000-000000000002';
  const clean = 'ccccccc3-0000-0000-0000-000000000003';
  for (const id of [untracked, modified, clean]) {
    const p = await prep(suite, id, deps);
    updateWorktreeState({ todoId: id, registryOptions: opts, executionState: 'execution_closed', integrationState: 'rejected' });
    if (id === untracked) fs.writeFileSync(path.join(p.record.worktreePath, 'wip.txt'), 'unsaved');
    if (id === modified) fs.appendFileSync(path.join(p.record.worktreePath, 'README.md'), 'edit\n');
  }
  const dry = cleanupWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  assert.deepEqual(dry.candidates.map((r) => r.todoId), [clean]);
  assert.deepEqual(dry.kept.map((r) => r.reason), ['uncommitted_changes', 'uncommitted_changes']);
  const real = cleanupWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo, apply: true });
  assert.deepEqual(real.removed.map((r) => r.todoId), [clean], JSON.stringify(real.failed));
  assert.equal(fs.readFileSync(path.join(getWorktreeRecord(untracked, opts).worktreePath, 'wip.txt'), 'utf8'), 'unsaved');
  assert.match(fs.readFileSync(path.join(getWorktreeRecord(modified, opts).worktreePath, 'README.md'), 'utf8'), /edit/);
  assert.equal(fs.existsSync(getWorktreeRecord(clean, opts).worktreePath), false);
});

test('publishSharedDeps tolerates a concurrent publisher and keeps the existing entry', async (t) => {
  const suite = makeSuite('race');
  t.after(suite.cleanup);
  const wt = path.join(suite.baseDir, 'wt');
  fs.mkdirSync(path.join(wt, 'node_modules/p'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(wt, 'node_modules/p/a.js'), '1');
  const config = { root: path.join(suite.baseDir, 'root') };
  const { publishSharedDeps, sharedDepsEntryDir } = await import('../lib/worktree-deps.js');
  const hash = hashLockfile(path.join(wt, 'package-lock.json'));
  const entry = sharedDepsEntryDir(config.root, hash);
  // Simulate another publisher completing the entry while our copy runs.
  const cpFn = async (from, to) => {
    fs.cpSync(from, to, { recursive: true });
    fs.mkdirSync(path.join(entry, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'node_modules', 'winner.js'), 'w');
    fs.writeFileSync(path.join(entry, '.complete'), 'x');
    return true;
  };
  const result = await publishSharedDeps({ worktreePath: wt, config, deps: { cpFn } });
  assert.equal(result.published, false);
  assert.equal(fs.existsSync(path.join(entry, 'node_modules', 'winner.js')), true, 'winner entry untouched');
  assert.deepEqual(fs.readdirSync(config.root).filter((n) => n.includes('.tmp-')), [], 'temp dir discarded');
});
