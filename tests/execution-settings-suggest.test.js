/**
 * Server-computed worktree suggestion for the Settings form.
 *
 * The suggestion must always point outside the repository, derive a safe
 * single-segment namespace and pick a prepare command from the lockfile that is
 * actually present. It is read-only: a non-Git folder yields no suggestion.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { suggestExecutionSettings } from '../lib/execution-settings-suggest.js';
import { createTempRepo, git, tempDir } from './helpers/temp-git-repo.js';

test('a non-Git folder yields no suggestion instead of throwing', (t) => {
  const dir = tempDir('cretli-suggest-nogit-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const suggestion = suggestExecutionSettings(dir);
  assert.equal(suggestion.available, false);
  assert.equal(suggestion.worktree.root, '');
  assert.equal(suggestion.worktree.namespace, '');
  assert.deepEqual(suggestion.worktree.prepareCommand, []);
});

test('the suggestion derives an outside root, namespace and branch scheme', (t) => {
  const { dir } = createTempRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');

  const suggestion = suggestExecutionSettings(dir);
  assert.equal(suggestion.available, true);
  assert.equal(suggestion.repoRoot, fs.realpathSync(dir));
  assert.equal(suggestion.executionMode, 'project');
  assert.equal(suggestion.worktree.root, path.join(path.dirname(suggestion.repoRoot), '.cretli-worktrees'));
  assert.equal(suggestion.worktree.namespace, path.basename(suggestion.repoRoot));
  assert.equal(suggestion.worktree.branchPrefix, `${path.basename(suggestion.repoRoot)}/todo/`);
  assert.equal(suggestion.worktree.directoryPrefix, 't-');
  assert.deepEqual(suggestion.worktree.prepareCommand, ['npm', 'ci']);
  // Settled S8: the suggested root must never sit inside the repository.
  assert.equal(suggestion.worktree.root.startsWith(`${suggestion.repoRoot}${path.sep}`), false);
});

test('the prepare command follows the lockfile that is present', (t) => {
  const pnpm = createTempRepo();
  const yarn = createTempRepo();
  const plain = createTempRepo();
  t.after(() => {
    for (const repo of [pnpm, yarn, plain]) fs.rmSync(repo.dir, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(pnpm.dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  assert.deepEqual(
    suggestExecutionSettings(pnpm.dir).worktree.prepareCommand,
    ['pnpm', 'install', '--frozen-lockfile'],
  );

  fs.writeFileSync(path.join(yarn.dir, 'yarn.lock'), '# yarn\n');
  assert.deepEqual(
    suggestExecutionSettings(yarn.dir).worktree.prepareCommand,
    ['yarn', 'install', '--frozen-lockfile'],
  );

  // No lockfile and no package.json: nothing to prepare.
  fs.writeFileSync(path.join(plain.dir, 'composer.json'), '{}\n');
  assert.deepEqual(suggestExecutionSettings(plain.dir).worktree.prepareCommand, []);
});

test('a Node project without a lockfile falls back to npm install', (t) => {
  const { dir } = createTempRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "x" }\n');
  assert.deepEqual(suggestExecutionSettings(dir).worktree.prepareCommand, ['npm', 'install']);
});

test('a subfolder of a repository suggests the repository root layout', (t) => {
  const { dir } = createTempRepo();
  const sub = path.join(dir, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const suggestion = suggestExecutionSettings(sub);
  assert.equal(suggestion.repoRoot, fs.realpathSync(dir));
  assert.equal(suggestion.worktree.root, path.join(path.dirname(fs.realpathSync(dir)), '.cretli-worktrees'));
});

test('a namespace that is not a safe path segment is sanitized', (t) => {
  const parent = tempDir('cretli-suggest-space-');
  const repoDir = path.join(parent, 'my project');
  fs.mkdirSync(repoDir, { recursive: true });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  git(repoDir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# x\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-qm', 'init']);

  const suggestion = suggestExecutionSettings(repoDir);
  assert.equal(suggestion.worktree.namespace, 'my-project');
  assert.equal(suggestion.worktree.branchPrefix, 'my-project/todo/');
});
