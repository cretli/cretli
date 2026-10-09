/**
 * Temporary Git repositories for worktree tests.
 *
 * Every repo lives under `os.tmpdir()`; no test touches the real repository or
 * its `data/`. Commits use env-provided identities so they never read a user's
 * global Git config.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Cretli Test',
  GIT_AUTHOR_EMAIL: 'cretli-test@example.com',
  GIT_COMMITTER_NAME: 'Cretli Test',
  GIT_COMMITTER_EMAIL: 'cretli-test@example.com',
};

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [options]
 * @returns {string}
 */
export function git(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...GIT_IDENTITY },
    });
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

/**
 * @param {string} prefix
 * @returns {string}
 */
export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A repo with one commit on `main`.
 *
 * @param {{ file?: string, content?: string }} [options]
 * @returns {{ dir: string, baseCommit: string }}
 */
export function createTempRepo(options = {}) {
  const dir = tempDir('cretli-wt-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  const file = options.file || 'README.md';
  fs.writeFileSync(path.join(dir, file), options.content ?? '# temp\n');
  git(dir, ['add', file]);
  git(dir, ['commit', '-qm', 'init']);
  return { dir, baseCommit: git(dir, ['rev-parse', 'HEAD']).trim() };
}

/**
 * Commit one extra file so HEAD moves.
 *
 * @param {string} repoDir
 * @param {string} name
 * @param {string} [content]
 * @returns {string}
 */
export function commitFile(repoDir, name, content = 'x\n') {
  fs.writeFileSync(path.join(repoDir, name), content);
  git(repoDir, ['add', name]);
  git(repoDir, ['commit', '-qm', `add ${name}`]);
  return git(repoDir, ['rev-parse', 'HEAD']).trim();
}

/**
 * A per-test worktree layout config whose root is outside the repo.
 *
 * @param {string} baseDir
 * @returns {{ root: string, namespace: string, branchPrefix: string, directoryPrefix: string }}
 */
export function worktreeConfig(baseDir) {
  const root = path.join(baseDir, 'worktrees');
  fs.mkdirSync(root, { recursive: true });
  return { root, namespace: 'ws', branchPrefix: 'cretli/todo/', directoryPrefix: 't-' };
}
