/**
 * Temporary detached checkout of a case's pre-fix commit, so the eval review
 * cannot read the already-fixed code. git is injected (callers pass `runGit`
 * from lib/worktree/git-worktree.ts).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {{ repo: string, commit: string, runGit: (args: string[], cwd: string, options?: any) => { stdout: string, status?: number } }} input
 * @returns {{ folder: string, cleanup: () => void }}
 */
export function createPreFixCheckout({ repo, commit, runGit }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-eval-'));
  const folder = path.join(root, 'wt');
  const cleanup = () => {
    runGit(['worktree', 'remove', '--force', folder], repo, { allowFailure: true });
    fs.rmSync(root, { recursive: true, force: true });
    runGit(['worktree', 'prune'], repo, { allowFailure: true });
  };
  try {
    runGit(['worktree', 'add', '--detach', folder, commit], repo);
  } catch (err) {
    cleanup();
    throw err;
  }
  return { folder, cleanup };
}
