import fs from 'node:fs/promises';
import path from 'node:path';
import { runGitAsync } from '../worktree/git-worktree.ts';

const DEFAULT_BUDGET_MS = 10_000;
const MAX_FILES = 2000;
const STAT_BATCH = 64;

/**
 * Lists working-tree files that differ from HEAD but exactly equal the blob of the
 * same path in one of the previous `limit` commits (a checkout left at an older version).
 * Only changed and untracked files are inspected; unchanged files are never reported.
 * Every Git call is asynchronous and shares one time budget (`budgetMs`) and an optional
 * `signal`; when either runs out, or too many files are candidates, the scan stops and the
 * partial result carries `truncated: true`.
 * @param {string} workspaceFolder
 * @param {number} [limit]
 * @param {{ budgetMs?: number, signal?: AbortSignal, stat?: typeof fs.stat }} [options] `stat` is a test seam
 */
export async function findStaleWorktreeFiles(workspaceFolder, limit = 20, { budgetMs = DEFAULT_BUDGET_MS, signal, stat = fs.stat } = {}) {
  const deadline = Date.now() + budgetMs;
  try {
    const { head, inspectedCommits, stale, truncated } = await scan(workspaceFolder, limit, deadline, signal, stat);
    return { head, inspectedCommits, files: stale, truncated };
  } catch (err) {
    if (err?.code !== 'STALE_SCAN_BUDGET') throw err;
    return { head: '', inspectedCommits: 0, files: [], truncated: true };
  }
}

async function scan(workspaceFolder, limit, deadline, signal, stat) {
  const count = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 20));
  const exhausted = () => signal?.aborted || Date.now() >= deadline;
  const checkBudget = () => {
    if (exhausted()) throw Object.assign(new Error('stale scan budget exhausted'), { code: 'STALE_SCAN_BUDGET' });
  };
  /** Settles with `work`, or rejects as soon as the deadline passes or the signal aborts. */
  const withinBudget = (work) => new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('stale scan budget exhausted'), { code: 'STALE_SCAN_BUDGET' }));
    if (exhausted()) { fail(); return; }
    const timer = setTimeout(fail, Math.max(1, deadline - Date.now()));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', fail); };
    signal?.addEventListener('abort', fail, { once: true });
    work.then((value) => { cleanup(); resolve(value); }, (err) => { cleanup(); reject(err); });
  });
  const git = async (args, input) => {
    checkBudget();
    try {
      // The signal and the remaining time are handed to the child so it is killed on abort or deadline.
      return (await runGitAsync(args, workspaceFolder, {
        env: { GIT_LITERAL_PATHSPECS: '0' }, timeoutMs: Math.max(1, deadline - Date.now()), signal,
        ...(input === undefined ? {} : { input }),
      })).stdout;
    } catch (err) {
      // A killed child (timeout or abort) becomes a partial result rather than a failure.
      if (exhausted()) throw Object.assign(err, { code: 'STALE_SCAN_BUDGET' });
      throw err;
    }
  };
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const commits = (await git(['rev-list', '-n', String(count + 1), 'HEAD'])).trim().split('\n').filter(Boolean);
  const older = commits.slice(1);
  const candidates = new Set([
    ...(await git(['diff', '--name-only', '-z', 'HEAD'])).split('\0'),
    ...(await git(['ls-files', '-o', '--exclude-standard', '-z'])).split('\0'),
  ]);
  // Newline paths cannot be passed through the line-based batch protocols.
  let named = [...candidates].filter((file) => file && !file.includes('\n'));
  const truncated = named.length > MAX_FILES;
  if (truncated) named = named.slice(0, MAX_FILES);
  // Stat in bounded batches so the deadline and signal are honoured between them.
  const isFile = [];
  for (let i = 0; i < named.length; i += STAT_BATCH) {
    checkBudget();
    isFile.push(...await withinBudget(Promise.all(named.slice(i, i + STAT_BATCH)
      .map((file) => stat(path.join(workspaceFolder, file)).then((st) => st.isFile(), () => false)))));
  }
  checkBudget();
  const files = named.filter((_, i) => isFile[i]);
  if (!files.length || !older.length) return { head, inspectedCommits: commits.length, stale: [], truncated };
  // One process hashes every candidate (clean filters applied, so the hash matches what `git add` would store).
  const hashes = (await git(['hash-object', '--stdin-paths'], files.map((f) => path.join(workspaceFolder, f)).join('\n') + '\n'))
    .trim().split('\n');
  // One process resolves every path in every older commit.
  const queries = files.flatMap((file) => older.map((commit) => `${commit}:${file}`));
  const resolved = (await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], queries.join('\n') + '\n')).split('\n');
  const stale = [];
  files.forEach((file, i) => {
    const matches = older.filter((commit, j) => resolved[i * older.length + j] === `${hashes[i]} blob`);
    if (matches.length) stale.push({ path: file, blob: hashes[i], olderCommits: matches });
  });
  // A scan that ran out of budget during the last call or this computation must not be reported as complete.
  checkBudget();
  return { head, inspectedCommits: commits.length, stale, truncated };
}
