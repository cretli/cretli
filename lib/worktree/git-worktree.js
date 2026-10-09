/**
 * Low-level Git reads for the worktree flow (contract §5, §6, §9, §11).
 *
 * Everything here is read-only except the explicit `gitWorktreeAdd` and
 * `gitWorktreeRemove` calls. No commit, push, merge, rebase, reset, clean or
 * force branch deletion lives in this module (S15).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree-errors.js';

export const GIT_TIMEOUT_MS = 30_000;

/**
 * @returns {NodeJS.ProcessEnv}
 */
function buildGitEnv() {
  return {
    ...process.env,
    // Never prompt on a missing credential; a refusal must stay a refusal.
    GIT_TERMINAL_PROMPT: '0',
    // Status/list must not take optional locks; keep reads side-effect free.
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeExecError(error) {
  if (!error || typeof error !== 'object') return String(error ?? 'unknown error');
  const source = /** @type {{ stderr?: unknown, message?: unknown }} */ (error);
  const stderr = Buffer.isBuffer(source.stderr) ? source.stderr.toString('utf8') : String(source.stderr ?? '');
  const message = stderr.trim() || String(source.message ?? '').trim();
  return message || 'unknown error';
}

/**
 * Run a Git command in `cwd`.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ allowFailure?: boolean, timeoutMs?: number }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function runGit(args, cwd, options = {}) {
  const allowFailure = options.allowFailure === true;
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      env: buildGitEnv(),
    });
    return { status: 0, stdout: String(stdout ?? ''), stderr: '' };
  } catch (error) {
    const source = /** @type {{ status?: unknown, stdout?: unknown, stderr?: unknown }} */ (error);
    const status = Number.isInteger(source?.status) ? Number(source.status) : 1;
    const stdout = Buffer.isBuffer(source?.stdout) ? source.stdout.toString('utf8') : String(source?.stdout ?? '');
    const stderr = Buffer.isBuffer(source?.stderr) ? source.stderr.toString('utf8') : String(source?.stderr ?? '');
    if (allowFailure) return { status, stdout, stderr };
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `git ${args.join(' ')} failed in ${cwd}: ${describeExecError(error)}`,
      { cause: error, details: { args, cwd, status } },
    );
  }
}

/**
 * @param {unknown} dir
 * @returns {string}
 */
function requireDir(dir) {
  const value = String(dir ?? '').trim();
  if (!value) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.NOT_GIT, 'A workspace folder is required.');
  }
  return value;
}

/**
 * @param {unknown} dir
 * @returns {boolean}
 */
export function isGitRepository(dir) {
  const cwd = requireDir(dir);
  if (!fs.existsSync(cwd)) return false;
  const result = runGit(['rev-parse', '--is-inside-work-tree'], cwd, { allowFailure: true });
  return result.status === 0 && result.stdout.trim() === 'true';
}

/**
 * Repository root for a folder, including when the folder is itself a linked
 * worktree (its `--show-toplevel` is the worktree path, not the main checkout).
 *
 * @param {unknown} dir
 * @returns {string}
 */
export function resolveRepositoryRoot(dir) {
  const cwd = requireDir(dir);
  const result = runGit(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true });
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.NOT_GIT,
      `Workspace folder is not inside a Git repository: ${cwd}.`,
      { details: { workspaceFolder: cwd } },
    );
  }
  const root = result.stdout.trim();
  if (!root) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.NOT_GIT, `Could not resolve the Git repository root for ${cwd}.`);
  }
  return path.resolve(root);
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function resolveHeadCommit(repoRoot) {
  const result = runGit(['rev-parse', '--verify', 'HEAD'], repoRoot, { allowFailure: true });
  const sha = result.stdout.trim();
  if (result.status !== 0 || !sha) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not read HEAD in ${repoRoot}; commit something before using worktree mode.`,
    );
  }
  return sha;
}

/**
 * Resolve any commit-ish to a full SHA, or null when it does not exist.
 *
 * @param {string} repoRoot
 * @param {unknown} ref
 * @returns {string | null}
 */
export function resolveCommit(ref, repoRoot) {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  const result = runGit(['rev-parse', '--verify', '--quiet', `${value}^{commit}`], repoRoot, { allowFailure: true });
  const sha = result.stdout.trim();
  return result.status === 0 && sha ? sha : null;
}

/**
 * True when the working tree has no staged, unstaged or untracked changes.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isWorkingTreeClean(dir) {
  const result = runGit(['status', '--porcelain'], dir, { allowFailure: true });
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not read the Git status of ${dir}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  return result.stdout.trim() === '';
}

/**
 * Parse `git status --porcelain -z -uall` into entries. NUL separation keeps
 * paths with spaces or quotes intact; a rename/copy record carries the source
 * path in the following NUL field, which is skipped.
 *
 * @param {string} worktreePath
 * @returns {Array<{ path: string, status: string, untracked: boolean }>}
 */
export function listWorktreeStatusEntries(worktreePath) {
  const result = runGit(['status', '--porcelain', '-z', '-uall'], worktreePath, { allowFailure: true });
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not read the Git status of ${worktreePath}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  const fields = result.stdout.split('\0');
  /** @type {Array<{ path: string, status: string, untracked: boolean }>} */
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record) continue;
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) continue;
    if (code[0] === 'R' || code[0] === 'C') i += 1; // skip the rename/copy source
    const status = code === '??' ? 'A' : (code[1] !== ' ' && code[1] !== '?' ? code[1] : code[0]);
    entries.push({ path: filePath, status: status || 'M', untracked: code === '??' });
  }
  return entries;
}

/**
 * @param {string} worktreePath
 * @param {string} baseCommit
 * @returns {Map<string, { additions: number|null, deletions: number|null }>}
 */
function readNumstat(worktreePath, baseCommit) {
  const result = runGit(['diff', '--numstat', baseCommit, '--'], worktreePath, { allowFailure: true });
  /** @type {Map<string, { additions: number|null, deletions: number|null }>} */
  const stats = new Map();
  if (result.status !== 0) return stats;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const first = line.indexOf('\t');
    const second = line.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const additions = line.slice(0, first).trim();
    const deletions = line.slice(first + 1, second).trim();
    const filePath = line.slice(second + 1);
    stats.set(filePath, {
      additions: /^\d+$/.test(additions) ? Number(additions) : null,
      deletions: /^\d+$/.test(deletions) ? Number(deletions) : null,
    });
  }
  return stats;
}

/**
 * Count lines of an untracked file for the diff stat. Binary content yields
 * null so the caller can report it as a binary addition.
 *
 * @param {string} worktreePath
 * @param {string} relativePath
 * @returns {number | null}
 */
function countUntrackedLines(worktreePath, relativePath) {
  try {
    const buffer = fs.readFileSync(path.join(worktreePath, relativePath));
    if (buffer.includes(0)) return null;
    const text = buffer.toString('utf8');
    if (!text) return 0;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  } catch {
    return null;
  }
}

/**
 * Build the manual-integration diff for a worktree: tracked changes against the
 * frozen base plus every untracked file. Read-only; it never stages, commits or
 * resets anything. Untracked files are emitted as `--no-index` diffs because
 * `git diff <base>` alone omits them (contract S14 requires new files).
 *
 * @param {{ worktreePath: string, baseCommit: string }} params
 * @returns {{ changedFiles: object[], diffStat: { files: number, insertions: number, deletions: number }, patch: string }}
 */
export function collectWorktreeExecutionDiff(params) {
  const worktreePath = requireDir(params?.worktreePath);
  const baseCommit = String(params?.baseCommit ?? '').trim();
  if (!baseCommit) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'A base commit is required to build the worktree diff.');
  }
  const statuses = listWorktreeStatusEntries(worktreePath);
  const numstat = readNumstat(worktreePath, baseCommit);
  /** @type {object[]} */
  const changedFiles = [];
  let insertions = 0;
  let deletions = 0;
  for (const entry of statuses) {
    const stat = entry.untracked
      ? { additions: countUntrackedLines(worktreePath, entry.path), deletions: 0 }
      : (numstat.get(entry.path) || { additions: null, deletions: null });
    changedFiles.push({ path: entry.path, status: entry.status, additions: stat.additions, deletions: stat.deletions });
    if (Number.isFinite(stat.additions)) insertions += stat.additions;
    if (Number.isFinite(stat.deletions)) deletions += stat.deletions;
  }
  const tracked = runGit(['diff', '--binary', baseCommit, '--'], worktreePath, { allowFailure: true });
  if (tracked.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not build the worktree diff for ${worktreePath}: ${tracked.stderr.trim() || 'unknown error'}`,
    );
  }
  const chunks = [tracked.stdout];
  for (const entry of statuses.filter((row) => row.untracked)) {
    // `--no-index` exits 1 when the files differ; that is the expected result.
    const untracked = runGit(['diff', '--no-index', '--binary', '--', '/dev/null', entry.path], worktreePath, { allowFailure: true });
    if (untracked.stdout) chunks.push(untracked.stdout);
  }
  return {
    changedFiles,
    diffStat: { files: changedFiles.length, insertions, deletions },
    patch: chunks.filter(Boolean).join(''),
  };
}

/**
 * @param {string} repoRoot
 * @param {string} branch
 * @returns {boolean}
 */
export function branchExists(repoRoot, branch) {
  const name = String(branch ?? '').trim();
  if (!name) return false;
  const result = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoRoot, { allowFailure: true });
  return result.status === 0;
}

/**
 * Branches whose short name starts with `prefix`, for orphan detection.
 *
 * @param {string} repoRoot
 * @param {string} prefix
 * @returns {string[]}
 */
export function listBranchesWithPrefix(repoRoot, prefix) {
  const value = String(prefix ?? '');
  const result = runGit(['branch', '--list', '--format=%(refname:short)'], repoRoot, { allowFailure: true });
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not list branches for ${repoRoot}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name && (value ? name.startsWith(value) : true));
}

/**
 * Parse `git worktree list --porcelain` into records.
 *
 * @param {string} repoRoot
 * @returns {Array<{ path: string, head: string, branch: string, detached: boolean, bare: boolean, gitdir: string }>}
 */
export function listGitWorktrees(repoRoot) {
  const result = runGit(['worktree', 'list', '--porcelain'], repoRoot, { allowFailure: true });
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not list Git worktrees for ${repoRoot}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  /** @type {Array<{ path: string, head: string, branch: string, detached: boolean, bare: boolean, gitdir: string }>} */
  const worktrees = [];
  /** @type {Partial<{ path: string, head: string, branch: string, detached: boolean, bare: boolean, gitdir: string }>} */
  let current = null;
  const flush = () => {
    if (current && current.path) {
      worktrees.push({
        path: path.resolve(current.path),
        head: current.head || '',
        branch: current.branch || '',
        detached: current.detached === true,
        bare: current.bare === true,
        gitdir: current.gitdir ? path.resolve(current.gitdir) : '',
      });
    }
    current = null;
  };
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    if (!current) current = {};
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') current.path = value;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'gitdir') current.gitdir = value;
  }
  flush();
  return worktrees;
}

/**
 * Git administrative directory of a linked worktree, or null when the path is
 * not a worktree.
 *
 * @param {string} worktreePath
 * @returns {string | null}
 */
export function resolveWorktreeGitDir(worktreePath) {
  const cwd = String(worktreePath ?? '').trim();
  if (!cwd || !fs.existsSync(cwd)) return null;
  const result = runGit(['rev-parse', '--absolute-git-dir'], cwd, { allowFailure: true });
  const gitDir = result.stdout.trim();
  return result.status === 0 && gitDir ? path.resolve(gitDir) : null;
}

/**
 * Create the linked worktree at `baseCommit`, reusing `branch` when it already
 * exists for a resumable reservation. Never resets or checks out over work.
 *
 * @param {{ repoRoot: string, worktreePath: string, branch: string, baseCommit: string, branchExists: boolean }} params
 * @returns {void}
 */
export function gitWorktreeAdd(params) {
  const { repoRoot, worktreePath, branch, baseCommit, branchExists: useExistingBranch } = params;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const args = useExistingBranch
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseCommit];
  runGit(args, repoRoot);
}

/**
 * Remove a linked worktree. `force` is only ever passed after an explicit human
 * discard confirmation; the default removal lets Git refuse dirty worktrees.
 *
 * @param {{ repoRoot: string, worktreePath: string, force?: boolean }} params
 * @returns {{ removed: boolean, message: string }}
 */
export function gitWorktreeRemove(params) {
  const args = ['worktree', 'remove'];
  if (params.force) args.push('--force');
  args.push(params.worktreePath);
  const result = runGit(args, params.repoRoot, { allowFailure: true });
  if (result.status !== 0) {
    return { removed: false, message: result.stderr.trim() || result.stdout.trim() || 'git worktree remove failed' };
  }
  return { removed: true, message: '' };
}
