import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classifyVerifiedBy, buildVerifiedByTrailer, parseVerifiedByTrailer, readLatestLeafVerifiedByTrailer } from '../lib/verified-by-trailer.js';
import { createWorktreeLeafCheckpoint } from '../lib/worktree/git-worktree.ts';
import { installGitHooks } from '../scripts/install-git-hooks.js';
import { createTempRepo, git } from './helpers/temp-git-repo.js';

test('trailer mapping imports without resolving the data directory', () => {
  const env = { ...process.env, CRETLI_TEST: '1' };
  delete env.CRETLI_DATA_DIR;
  delete env.CURSOR_REMOTE_DATA_DIR;
  const code = "await import('./lib/verified-by-trailer.js');";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.resolve('.'), env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});


test('verify results map to none, unit, and injected e2e classifications', () => {
  const e2e = new Set(['browser-flow']);
  assert.equal(classifyVerifiedBy(null, e2e), 'none');
  assert.equal(classifyVerifiedBy({ status: 'failed', ids: ['unit'] }, e2e), 'none');
  assert.equal(classifyVerifiedBy({ status: 'passed', stale: true, ids: ['unit'] }, e2e), 'none');
  assert.equal(classifyVerifiedBy({ status: 'passed', ids: ['unit'] }, e2e), 'unit');
  assert.equal(classifyVerifiedBy({ status: 'passed', ids: ['browser-flow'] }, e2e), 'e2e');
  assert.deepEqual(parseVerifiedByTrailer(buildVerifiedByTrailer({ status: 'passed', ids: ['unit-a', 'unit-b'] })), {
    verifiedBy: 'unit', ids: ['unit-a', 'unit-b'],
  });
});

test('delegation loader failures resolve to a none trailer', async () => {
  const trailer = await readLatestLeafVerifiedByTrailer({
    workspaceFolder: '/tmp/example', dataDir: '/tmp/data', leafId: 'leaf',
    loadDelegations: async () => { throw new Error('persistence unavailable'); },
  });
  assert.equal(trailer, 'Verified-by: none');
});

test('worktree checkpoint keeps its subject and includes the verification trailer', (t) => {
  const repo = createTempRepo({ file: 'app.js', content: 'export const value = 1;\n' }).dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const branch = 'cretli/todo/example';
  git(repo, ['branch', branch]);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 2;\n');
  const result = createWorktreeLeafCheckpoint(repo, 'example', branch, 'Verified-by: unit\nVerified-ids: focused-test');
  const message = git(repo, ['show', '-s', '--format=%B', result.commit]);
  assert.match(message, /^Cretli leaf checkpoint for example/m);
  assert.match(message, /Verified-by: unit/);
  assert.match(message, /Verified-ids: focused-test/);
});

test('commit hook supports off, observe, enforce, and a third-attempt override', (t) => {
  for (const mode of ['off', 'observe', 'enforce']) {
    const repo = createTempRepo({ file: 'app.js', content: 'export const value = 1;\n' }).dir;
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
    const hook = path.join(repo, '.git', 'hooks', 'commit-msg');
    fs.copyFileSync(path.resolve('scripts/git-hooks/commit-msg'), hook);
    fs.chmodSync(hook, 0o755);
    git(repo, ['config', 'cretli.verifiedByGate', mode]);
    fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 2;\n');
    git(repo, ['add', 'app.js']);
    if (mode === 'off') {
      git(repo, ['commit', '-m', 'change']);
      assert.equal(fs.existsSync(path.join(repo, '.git/cretli-verified-by.log')), false);
    } else if (mode === 'observe') {
      git(repo, ['commit', '-m', 'change']);
      assert.match(fs.readFileSync(path.join(repo, '.git/cretli-verified-by.log'), 'utf8'), /"action":"observe"/);
    } else {
      const initialTree = git(repo, ['write-tree']).trim();
      const unit = path.join(repo, 'unit-message');
      fs.writeFileSync(unit, 'Verified-by: unit\n');
      const unitResult = spawnSync('git', ['-c', `core.hooksPath=${path.join(repo, '.git/hooks')}`, 'commit', '--allow-empty', '-F', unit], { cwd: repo, encoding: 'utf8' });
      assert.equal(unitResult.status, 0, unitResult.stderr);
      assert.equal(git(repo, ['write-tree']).trim(), initialTree);
      fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 3;\n');
      git(repo, ['add', 'app.js']);
      const logPath = path.join(repo, '.git/cretli-verified-by.log');
      const none = path.join(repo, 'none-message');
      fs.writeFileSync(none, 'Verified-by: none\n');
      const noneResult = spawnSync('git', ['commit', '-F', none], { cwd: repo, encoding: 'utf8' });
      assert.equal(noneResult.status, 1);
      assert.equal(fs.existsSync(logPath), false);
      assert.throws(() => git(repo, ['commit', '-m', 'second']));
      assert.equal(fs.existsSync(logPath), false);
      const thirdResult = spawnSync('git', ['commit', '-m', 'third'], { cwd: repo, encoding: 'utf8' });
      assert.equal(thirdResult.status, 0, thirdResult.stderr);
      assert.match(fs.readFileSync(logPath, 'utf8'), /"action":"override"/);
    }
  }
});

test('hooks installer preserves pre-push and core.hooksPath and warns about inactive path', (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const hooks = path.join(repo, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
  git(repo, ['config', 'core.hooksPath', '.custom-hooks']);
  const before = git(repo, ['config', '--get', 'core.hooksPath']).trim();
  const warnings = [];
  installGitHooks(repo, path.resolve('scripts/git-hooks/commit-msg'), { warn: (message) => warnings.push(message) });
  assert.equal(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(git(repo, ['config', '--get', 'core.hooksPath']).trim(), before);
  assert.equal(fs.existsSync(path.join(hooks, 'commit-msg')), true);
  assert.match(warnings.join('\n'), /core\.hooksPath/);
});

test('hooks installer refuses a different hook unless forced and backs it up', (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const hooks = path.join(repo, '.git', 'hooks');
  const destination = path.join(hooks, 'commit-msg');
  const existing = '#!/bin/sh\nexit 7\n';
  fs.writeFileSync(destination, existing);
  const source = path.resolve('scripts/git-hooks/commit-msg');
  assert.throws(() => installGitHooks(repo, source), /Refusing to replace existing/);
  assert.equal(fs.readFileSync(destination, 'utf8'), existing);
  installGitHooks(repo, source, { force: true });
  const backup = fs.readdirSync(hooks).find((name) => /^commit-msg\.bak-\d+/.test(name));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(hooks, backup), 'utf8'), existing);
  assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source));
});

test('hooks installer leaves identical hook untouched', (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const hooks = path.join(repo, '.git', 'hooks');
  const source = path.resolve('scripts/git-hooks/commit-msg');
  const destination = path.join(hooks, 'commit-msg');
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o700);
  const before = fs.statSync(destination);
  installGitHooks(repo, source);
  const after = fs.statSync(destination);
  assert.equal(after.mode & 0o777, 0o700);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

function enforceRepo(t) {
  const repo = createTempRepo({ file: 'app.js', content: 'export const value = 1;\n' }).dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const hook = path.join(repo, '.git', 'hooks', 'commit-msg');
  fs.copyFileSync(path.resolve('scripts/git-hooks/commit-msg'), hook);
  fs.chmodSync(hook, 0o755);
  git(repo, ['config', 'cretli.verifiedByGate', 'enforce']);
  return repo;
}

function commitFiles(repo, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
    git(repo, ['add', name]);
  }
  return spawnSync('git', ['commit', '-m', 'change'], { cwd: repo, encoding: 'utf8' });
}

test('commit hook in enforce mode ignores lock files at any depth', (t) => {
  for (const name of ['package-lock.json', 'sub/package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']) {
    const result = commitFiles(enforceRepo(t), { [name]: '{"lockfileVersion":3}\n' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test('commit hook still blocks a lock file staged with code, and similar names', (t) => {
  const mixed = commitFiles(enforceRepo(t), { 'package-lock.json': '{}\n', 'app.js': 'export const value = 2;\n' });
  assert.equal(mixed.status, 1);
  const similar = commitFiles(enforceRepo(t), { 'my-package-lock.json': '{}\n' });
  assert.equal(similar.status, 1);
});
