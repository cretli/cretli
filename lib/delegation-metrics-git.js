/**
 * Git snapshot for per-delegation metrics. Kept out of `delegation-metrics.js`
 * because that module is imported by the browser bundle.
 */

import { execFileSync } from 'node:child_process';
import { parseNumstat } from './delegation-metrics.js';

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
    const inside = execFileSync('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') return null;
    // `--numstat` against HEAD captures every tracked change (staged + unstaged)
    // relative to the last commit, which is the shared baseline the run edits on.
    const numstat = execFileSync('git', ['-C', folder, 'diff', 'HEAD', '--no-renames', '--numstat'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untrackedOut = execFileSync('git', ['-C', folder, 'ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untracked = String(untrackedOut || '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean);
    return { files: parseNumstat(numstat), untracked };
  } catch {
    return null;
  }
}
