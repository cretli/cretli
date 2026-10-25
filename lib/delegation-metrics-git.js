/**
 * Git snapshot for per-delegation metrics. Kept out of `delegation-metrics.js`
 * because that module is imported by the browser bundle.
 */

import { parseNumstat } from './delegation-metrics.js';
import { runGit } from './worktree/git-worktree.ts';

/**
 * Snapshot the working tree so a later diff can attribute exactly this run's
 * edits, ignoring the other people's changes already sitting in the shared
 * tree. Returns `null` when git is unavailable or the folder is not a repo.
 *
 * @param {string} cwd
 * @returns {{ files: Record<string, { added: number | null, removed: number | null }>, untracked: string[] } | null}
 */
export function captureGitSnapshot(cwd) {
  const folder = String(cwd || '').trim();
  if (!folder) return null;
  try {
    // runGit trusts this checkout only, so a foreign-owned repo still resolves.
    const inside = runGit(['rev-parse', '--is-inside-work-tree'], folder).stdout.trim();
    if (inside !== 'true') return null;
    // `--numstat` against HEAD captures every tracked change (staged + unstaged)
    // relative to the last commit, which is the shared baseline the run edits on.
    const numstat = runGit(['diff', 'HEAD', '--no-renames', '--numstat'], folder, { maxBuffer: 8 * 1024 * 1024 }).stdout;
    const untrackedOut = runGit(['ls-files', '--others', '--exclude-standard'], folder, { maxBuffer: 8 * 1024 * 1024 }).stdout;
    const untracked = String(untrackedOut || '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean);
    return { files: parseNumstat(numstat), untracked };
  } catch {
    return null;
  }
}
