import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createTempRepo, git, tempDir } from './helpers/temp-git-repo.js';

const moduleUrl = new URL('../lib/worktree/git-worktree.ts', import.meta.url).href;
const ownershipEnv = {
  ...process.env,
  GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '0',
};

function setup(t) {
  const { dir: repo } = createTempRepo();
  const base = tempDir('cretli-ownership-');
  const worktree = path.join(base, 'worktree');
  git(repo, ['worktree', 'add', '-q', '-b', 'checkpoint', worktree]);
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { repo, base, worktree };
}

function runWithDifferentOwner(cwd, script) {
  const source = `import assert from 'node:assert/strict'; import * as git from ${JSON.stringify(moduleUrl)}; const workspaceFolder = ${JSON.stringify(cwd)}; ${script}`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd,
    env: ownershipEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('worktree Git reads trust only the canonical repository for this command', (t) => {
  const { repo, base, worktree } = setup(t);
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  const alias = path.join(base, 'alias');
  fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const rejected = spawnSync('git', ['status', '--porcelain'], { cwd: repo, env: ownershipEnv, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /dubious ownership/);
  for (const cwd of [repo, nested, alias, worktree]) {
    runWithDifferentOwner(cwd, `
      assert.equal(git.isGitRepository(workspaceFolder), true);
      assert.equal(git.isWorkingTreeClean(workspaceFolder), true);
      assert.ok(git.resolveRepositoryRoot(workspaceFolder));
      assert.deepEqual(git.listDirtyWorktreePaths(workspaceFolder), []);
      assert.equal(git.listGitWorktrees(workspaceFolder).length, 2);
    `);
  }
  const stillRejected = spawnSync('git', ['status', '--porcelain'], { cwd: repo, env: ownershipEnv, encoding: 'utf8' });
  assert.notEqual(stillRejected.status, 0, 'trust must not persist in Git configuration');
});

test('dirty snapshot supports a different owner without changing the caller index or HEAD', (t) => {
  const { repo } = setup(t);
  const originalHead = git(repo, ['rev-parse', 'HEAD']);
  const originalIndex = fs.readFileSync(path.join(repo, '.git', 'index'));
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'snapshot content\n');
  runWithDifferentOwner(repo, `
    const snapshot = git.createDirtyTreeSnapshot(workspaceFolder, 'ownership-test');
    assert.equal(git.runGit(['show', snapshot.commit + ':dirty.txt'], workspaceFolder).stdout, 'snapshot content\\n');
    assert.equal(git.removeDirtyTreeSnapshotRef(workspaceFolder, snapshot.ref), true);
  `);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), originalHead);
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), originalIndex);
  assert.equal(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8'), 'snapshot content\n');
});

test('leaf checkpoint uses scoped trust for linked worktree index and commit commands', (t) => {
  const { repo, worktree } = setup(t);
  const originalHead = git(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(worktree, 'checkpoint.txt'), 'checkpoint content\n');
  runWithDifferentOwner(worktree, `
    const checkpoint = git.createWorktreeLeafCheckpoint(workspaceFolder, 'ownership-test', 'checkpoint');
    assert.equal(git.resolveHeadCommit(workspaceFolder), checkpoint.commit);
    assert.equal(git.isWorkingTreeClean(workspaceFolder), true);
    assert.equal(git.runGit(['show', checkpoint.commit + ':checkpoint.txt'], workspaceFolder).stdout, 'checkpoint content\\n');
  `);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), originalHead);
});

test('a literal star checkout cannot become a wildcard safe directory', { skip: process.platform === 'win32' }, (t) => {
  const base = tempDir('cretli-star-checkout-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, '*');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  runWithDifferentOwner(repo, `
    assert.throws(
      () => git.runGit(['config', '--get-all', 'safe.directory'], workspaceFolder),
      { code: 'WORKTREE_CONFIG_INVALID', message: /wildcard/ },
    );
    assert.notEqual(git.runGit(['status', '--porcelain'], workspaceFolder, { allowFailure: true }).status, 0);
  `);
});
