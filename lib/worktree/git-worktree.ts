/**
 * Low-level Git reads for the worktree flow (contract §5, §6, §9, §11).
 *
 * Everything here is read-only except the explicit `gitWorktreeAdd` and
 * `gitWorktreeRemove` calls. No commit, push, merge, rebase, reset, clean or
 * force branch deletion lives in this module (S15).
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree-errors.ts';

export const GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunGitOptions {
  allowFailure?: boolean;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface WorktreeStatusEntry {
  path: string;
  status: string;
  untracked: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
  bare: boolean;
  gitdir: string;
}

export interface WorktreeChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

function buildGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Never prompt on a missing credential; a refusal must stay a refusal.
    GIT_TERMINAL_PROMPT: '0',
    // Status/list must not take optional locks; keep reads side-effect free.
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

function describeExecError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? 'unknown error');
  const source = error as { stderr?: unknown; message?: unknown };
  const stderr = Buffer.isBuffer(source.stderr) ? source.stderr.toString('utf8') : String(source.stderr ?? '');
  const message = stderr.trim() || String(source.message ?? '').trim();
  return message || 'unknown error';
}

/**
 * True when Git refused to open a repository because a different uid owns it
 * ("dubious ownership"). Cretli scopes safe.directory per command, so this
 * only happens when that scoping missed the real checkout root.
 */
export function isGitOwnershipRefusal(text: unknown): boolean {
  return /dubious ownership|unsafe repository/i.test(String(text ?? ''));
}

/**
 * Find the canonical checkout root without asking Git to open an untrusted repo.
 * A .git file also marks linked worktrees and submodules. Trust is scoped to
 * this exact checkout for one command, including when cwd is a nested folder.
 */
export function resolveGitSafeDirectory(cwd: string): string {
  const canonicalCwd = fs.realpathSync(cwd);
  let directory = canonicalCwd;
  while (!fs.existsSync(path.join(directory, '.git'))) {
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const safeDirectory = fs.existsSync(path.join(directory, '.git')) ? directory : canonicalCwd;
  // Git normalizes paths before interpreting a trailing /* as recursive trust.
  if (path.basename(safeDirectory) === '*') {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      'Cannot trust a checkout named "*": Git interprets its safe.directory as a wildcard. Rename the checkout directory.',
    );
  }
  return safeDirectory;
}

/** Git calls slower than this are logged once so event-loop stalls can be attributed. */
export const SLOW_GIT_LOG_MS = 1000;

/**
 * Log one line for a slow git call: subcommand name only (no path or message
 * arguments, which may carry secrets), duration and the cwd basename.
 */
export function logSlowGitCall(args: string[], cwd: string, durationMs: number, mode: 'sync' | 'async' | 'stdin' = 'sync'): void {
  if (!(durationMs > SLOW_GIT_LOG_MS)) return;
  let subcommand = '';
  for (let i = 0; i < args.length; i += 1) {
    // Global options that take a value (`-c key=value`, `-C path`) may carry secrets.
    if (args[i] === '-c' || args[i] === '-C') { i += 1; continue; }
    if (args[i].startsWith('-')) continue;
    subcommand = args[i];
    break;
  }
  const cwdName = path.basename(String(cwd ?? '')) || String(cwd ?? '');
  console.warn(`[slow-git] git ${subcommand} ${mode} took ${Math.round(durationMs)}ms in ${cwdName}`);
}

function buildGitInvocation(args: string[], cwd: string, options: RunGitOptions) {
  const safeDirectory = resolveGitSafeDirectory(cwd);
  return {
    argv: ['-c', `safe.directory=${safeDirectory}`, ...args],
    execOptions: {
      cwd,
      encoding: 'utf8' as const,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      env: { ...buildGitEnv(), ...(options.env || {}) },
    },
  };
}

function failGit(error: unknown, args: string[], cwd: string, allowFailure: boolean): GitResult {
  const source = error as { status?: unknown; stdout?: unknown; stderr?: unknown; code?: unknown };
  // execFile (async) reports the exit code as `code`; execFileSync as `status`.
  const rawStatus = Number.isInteger(source?.status) ? source.status : source?.code;
  const status = Number.isInteger(rawStatus) ? Number(rawStatus) : 1;
  const stdout = Buffer.isBuffer(source?.stdout) ? source.stdout.toString('utf8') : String(source?.stdout ?? '');
  const stderr = Buffer.isBuffer(source?.stderr) ? source.stderr.toString('utf8') : String(source?.stderr ?? '');
  if (allowFailure) return { status, stdout, stderr };
  if (error instanceof WorktreeError) throw error;
  throw new WorktreeError(
    isGitOwnershipRefusal(stderr) ? WORKTREE_ERROR_CODES.GIT_OWNERSHIP : WORKTREE_ERROR_CODES.GIT_FAILED,
    `git ${args.join(' ')} failed in ${cwd}: ${describeExecError(error)}`,
    { cause: error, details: { args, cwd, status } },
  );
}

/**
 * Run a Git command in `cwd`. Synchronous: blocks the event loop, so server
 * paths must use {@link runGitAsync}; this stays for scripts and sync callers.
 */
export function runGit(args: string[], cwd: string, options: RunGitOptions = {}): GitResult {
  const allowFailure = options.allowFailure === true;
  const startedAt = Date.now();
  try {
    const { argv, execOptions } = buildGitInvocation(args, cwd, options);
    const stdout = execFileSync('git', argv, {
      ...execOptions, // argv carries `-c safe.directory=<checkout>` (buildGitInvocation)
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: String(stdout ?? ''), stderr: '' };
  } catch (error) {
    return failGit(error, args, cwd, allowFailure);
  } finally {
    logSlowGitCall(args, cwd, Date.now() - startedAt, 'sync');
  }
}

/**
 * Non-blocking twin of {@link runGit}: same arguments, result and error
 * contract, but the event loop keeps running while Git works. `input` is
 * written to stdin when given.
 */
export async function runGitAsync(
  args: string[],
  cwd: string,
  options: RunGitOptions & { input?: string | Buffer } = {},
): Promise<GitResult> {
  const allowFailure = options.allowFailure === true;
  const startedAt = Date.now();
  try {
    const { argv, execOptions } = buildGitInvocation(args, cwd, options);
    return await new Promise<GitResult>((resolve, reject) => {
      const child = execFile('git', argv, execOptions, (error, stdout, stderr) => { // argv carries `-c safe.directory=<checkout>`
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ status: 0, stdout: String(stdout ?? ''), stderr: '' });
      });
      // Swallow EPIPE when git exits before reading all of stdin; the exit code reports the failure.
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.input);
    });
  } catch (error) {
    return failGit(error, args, cwd, allowFailure);
  } finally {
    logSlowGitCall(args, cwd, Date.now() - startedAt, 'async');
  }
}

function requireDir(dir: unknown): string {
  const value = String(dir ?? '').trim();
  if (!value) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.NOT_GIT, 'A workspace folder is required.');
  }
  return value;
}

export function isGitRepository(dir: unknown): boolean {
  const cwd = requireDir(dir);
  if (!fs.existsSync(cwd)) return false;
  const result = runGit(['rev-parse', '--is-inside-work-tree'], cwd, { allowFailure: true });
  return result.status === 0 && result.stdout.trim() === 'true';
}

/**
 * Repository root for a folder, including when the folder is itself a linked
 * worktree (its `--show-toplevel` is the worktree path, not the main checkout).
 */
export function resolveRepositoryRoot(dir: unknown): string {
  const cwd = requireDir(dir);
  return parseRepositoryRoot(runGit(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true }), cwd);
}

function parseRepositoryRoot(result: GitResult, cwd: string): string {
  if (result.status !== 0 && isGitOwnershipRefusal(result.stderr)) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_OWNERSHIP,
      `Git refused the repository at ${cwd} because another user owns it: ${result.stderr.trim()}`,
      { details: { workspaceFolder: cwd } },
    );
  }
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

export function resolveHeadCommit(repoRoot: string): string {
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
 */
export function resolveCommit(ref: unknown, repoRoot: string): string | null {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  const result = runGit(['rev-parse', '--verify', '--quiet', `${value}^{commit}`], repoRoot, { allowFailure: true });
  const sha = result.stdout.trim();
  return result.status === 0 && sha ? sha : null;
}

/**
 * True when the working tree has no staged, unstaged or untracked changes.
 */
export function isWorkingTreeClean(dir: string): boolean {
  const result = runGit(['status', '--porcelain'], dir, { allowFailure: true });
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not read the Git status of ${dir}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  return result.stdout.trim() === '';
}

/** Return all non-ignored dirty paths using Git's NUL-safe status format. */
export function listDirtyWorktreePaths(dir: string): string[] {
  return listWorktreeStatusEntries(dir).map((entry) => entry.path);
}

/** Create a pinned snapshot commit through a temporary index without touching the caller's index. */
export function createDirtyTreeSnapshot(
  repoRoot: string,
  todoId: unknown,
): { commit: string; headCommit: string; ref: string } {
  const headCommit = resolveHeadCommit(repoRoot);
  const indexPath = path.join(os.tmpdir(), `cretli-index-${randomUUID()}`);
  const ref = `refs/cretli/snapshots/${String(todoId).replace(/[^a-zA-Z0-9-]/g, '-')}`;
  const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const execute = (args: string[]): string => runGit(args, repoRoot, { env }).stdout;
  try {
    execute(['read-tree', headCommit]);
    execute(['add', '-A', '--', '.']);
    const tree = execute(['write-tree']).trim();
    const parent = headCommit ? ['-p', headCommit] : [];
    const authorName = runGit(['config', 'user.name'], repoRoot, { allowFailure: true }).stdout.trim() || 'Cretli';
    const authorEmail = runGit(['config', 'user.email'], repoRoot, { allowFailure: true }).stdout.trim() || 'cretli@localhost';
    const commit = runGit(['commit-tree', tree, ...parent, '-m', `Cretli snapshot for ${todoId}`], repoRoot, {
      env: { ...env, GIT_AUTHOR_NAME: authorName, GIT_COMMITTER_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_EMAIL: authorEmail },
    }).stdout.trim();
    runGit(['update-ref', ref, commit], repoRoot);
    return { commit, headCommit, ref };
  } finally {
    try { fs.unlinkSync(indexPath); } catch {}
    try { fs.unlinkSync(`${indexPath}.lock`); } catch {}
  }
}

/**
 * Capture the current worktree working tree as a commit on `branch` without
 * touching any other branch (including the main checkout). Uses the same
 * temporary-index technique as {@link createDirtyTreeSnapshot}.
 *
 * `branch` is the short branch name (e.g. cretli/todo/<id>).
 */
export function createWorktreeLeafCheckpoint(
  worktreePath: string,
  todoId: unknown,
  branch: unknown,
): { commit: string; parent: string; branch: string } {
  const cwd = requireDir(worktreePath);
  const branchName = String(branch ?? '').trim();
  if (!branchName) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'A worktree branch name is required for a leaf checkpoint.');
  }
  const repoRoot = resolveRepositoryRoot(cwd);
  const parent = resolveHeadCommit(cwd);
  const indexPath = path.join(os.tmpdir(), `cretli-leaf-ckpt-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const execute = (args: string[]): string => runGit(args, cwd, { env }).stdout;
  try {
    execute(['read-tree', parent]);
    execute(['add', '-A', '--', '.']);
    const tree = execute(['write-tree']).trim();
    const authorName = runGit(['config', 'user.name'], cwd, { allowFailure: true }).stdout.trim() || 'Cretli';
    const authorEmail = runGit(['config', 'user.email'], cwd, { allowFailure: true }).stdout.trim() || 'cretli@localhost';
    const commit = runGit(['commit-tree', tree, '-p', parent, '-m', `Cretli leaf checkpoint for ${todoId}`], cwd, {
      env: { ...env, GIT_AUTHOR_NAME: authorName, GIT_COMMITTER_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_EMAIL: authorEmail },
    }).stdout.trim();
    runGit(['update-ref', `refs/heads/${branchName}`, commit], repoRoot);
    runGit(['reset', '--hard', commit], cwd);
    return { commit, parent, branch: branchName };
  } finally {
    try { fs.unlinkSync(indexPath); } catch {}
    try { fs.unlinkSync(`${indexPath}.lock`); } catch {}
  }
}

/** Remove a Cretli-owned snapshot ref. */
export function removeDirtyTreeSnapshotRef(repoRoot: string, ref: unknown): boolean {
  const value = String(ref ?? '').trim();
  if (!value.startsWith('refs/cretli/snapshots/')) return false;
  const result = runGit(['update-ref', '-d', value], repoRoot, { allowFailure: true });
  return result.status === 0;
}

/**
 * Paths left with conflict stages in a temporary index after a failed three-way
 * apply. Best effort: a missing index or a Git error yields no paths, so the
 * caller must treat an empty list as "unknown", never as "no conflict".
 */
function readUnmergedPaths(workspaceFolder: string, env: NodeJS.ProcessEnv): string[] {
  return parseUnmergedPaths(runGit(['ls-files', '-u', '-z', '--'], workspaceFolder, { allowFailure: true, env }));
}

function parseUnmergedPaths(result: GitResult): string[] {
  if (result.status !== 0 || !result.stdout) return [];
  const paths = new Set<string>();
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    // "<mode> <sha> <stage>\t<path>"
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const filePath = record.slice(tab + 1);
    if (filePath) paths.add(filePath);
  }
  return [...paths];
}

/** Apply a reviewed patch to the logical tree while keeping the user's index isolated. */
export function applyWorktreeExecutionPatch(
  params: { workspaceFolder?: unknown; baseCommit?: unknown; patchPath?: unknown } | null | undefined,
): { applied: true; baseCommit: string } {
  const workspaceFolder = requireDir(params?.workspaceFolder);
  const baseCommit = String(params?.baseCommit ?? '').trim();
  const patchPath = String(params?.patchPath ?? '').trim();
  if (!baseCommit || !patchPath || !fs.existsSync(patchPath)) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'A valid worktree base and patch file are required for integration.');
  }
  if (resolveCommit(baseCommit, workspaceFolder) !== baseCommit) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'The frozen worktree base is no longer available in the logical repository.');
  }
  const temporaryIndex = path.join(os.tmpdir(), `cretli-apply-index-${randomUUID()}`);
  const mergedPatchPath = path.join(os.tmpdir(), `cretli-merged-patch-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    const currentHead = resolveHeadCommit(workspaceFolder);
    runGit(['read-tree', currentHead], workspaceFolder, { env });
    runGit(['add', '-A', '--', '.'], workspaceFolder, { env });
    const beforeTree = runGit(['write-tree'], workspaceFolder, { env }).stdout.trim();
    const merge = runGit(['apply', '--3way', '--cached', patchPath], workspaceFolder, { allowFailure: true, env });
    if (merge.status !== 0) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.INTEGRATION_CONFLICT, 'The worktree patch conflicts with changes made in the logical workspace. Resolve the conflict manually and retry.', { details: { gitError: merge.stderr.trim() || merge.stdout.trim(), conflicts: readUnmergedPaths(workspaceFolder, env) } });
    }
    const afterTree = runGit(['write-tree'], workspaceFolder, { env }).stdout.trim();
    const mergedPatch = runGit(['diff', '--binary', beforeTree, afterTree, '--'], workspaceFolder);
    if (!mergedPatch.stdout) return { applied: true, baseCommit };
    fs.writeFileSync(mergedPatchPath, mergedPatch.stdout);
    const check = runGit(['apply', '--check', mergedPatchPath], workspaceFolder, { allowFailure: true });
    if (check.status !== 0) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.INTEGRATION_CONFLICT, 'The merged worktree patch no longer applies to the logical workspace. No files were changed.', { details: { gitError: check.stderr.trim() || check.stdout.trim() } });
    }
    const applied = runGit(['apply', mergedPatchPath], workspaceFolder, { allowFailure: true });
    if (applied.status !== 0) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.INTEGRATION_CONFLICT, 'The merged worktree patch could not be applied. Inspect the logical workspace before retrying.', { details: { gitError: applied.stderr.trim() || applied.stdout.trim() } });
    }
    return { applied: true, baseCommit };
  } finally {
    try { fs.unlinkSync(temporaryIndex); } catch {}
    try { fs.unlinkSync(`${temporaryIndex}.lock`); } catch {}
    try { fs.unlinkSync(mergedPatchPath); } catch {}
  }
}

/**
 * Parse `git status --porcelain -z -uall` into entries. NUL separation keeps
 * paths with spaces or quotes intact; a rename/copy record carries the source
 * path in the following NUL field, which is skipped.
 */
export function listWorktreeStatusEntries(worktreePath: string): WorktreeStatusEntry[] {
  const result = runGit(['status', '--porcelain', '-z', '-uall'], worktreePath, { allowFailure: true });
  return parseStatusResult(result, worktreePath);
}

/** Async twin of {@link listWorktreeStatusEntries}. */
export async function listWorktreeStatusEntriesAsync(worktreePath: string): Promise<WorktreeStatusEntry[]> {
  const result = await runGitAsync(['status', '--porcelain', '-z', '-uall'], worktreePath, { allowFailure: true });
  return parseStatusResult(result, worktreePath);
}

function parseStatusResult(result: GitResult, worktreePath: string): WorktreeStatusEntry[] {
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not read the Git status of ${worktreePath}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  const fields = result.stdout.split('\0');
  const entries: WorktreeStatusEntry[] = [];
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

function readNumstat(
  worktreePath: string,
  baseCommit: string,
): Map<string, { additions: number | null; deletions: number | null }> {
  return parseNumstat(runGit(['diff', '--numstat', baseCommit, '--'], worktreePath, { allowFailure: true }));
}

function parseNumstat(result: GitResult): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
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
 */
function countUntrackedLines(worktreePath: string, relativePath: string): number | null {
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
 */
export function collectWorktreeExecutionDiff(params: { worktreePath: string; baseCommit: string }): {
  changedFiles: WorktreeChangedFile[];
  diffStat: { files: number; insertions: number; deletions: number };
  patch: string;
} {
  const worktreePath = requireDir(params?.worktreePath);
  const baseCommit = String(params?.baseCommit ?? '').trim();
  if (!baseCommit) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'A base commit is required to build the worktree diff.');
  }
  const statuses = listWorktreeStatusEntries(worktreePath);
  const numstat = readNumstat(worktreePath, baseCommit);
  const summary = summarizeChanges(worktreePath, statuses, numstat);
  const tracked = runGit(['diff', '--binary', baseCommit, '--'], worktreePath, { allowFailure: true });
  assertTrackedDiff(tracked, worktreePath);
  const chunks = [tracked.stdout];
  for (const entry of statuses.filter((row) => row.untracked)) {
    // `--no-index` exits 1 when the files differ; that is the expected result.
    const untracked = runGit(['diff', '--no-index', '--binary', '--', '/dev/null', entry.path], worktreePath, { allowFailure: true });
    if (untracked.stdout) chunks.push(untracked.stdout);
  }
  return { ...summary, patch: chunks.filter(Boolean).join('') };
}

type ExecutionDiff = {
  changedFiles: WorktreeChangedFile[];
  diffStat: { files: number; insertions: number; deletions: number };
  patch: string;
};

function summarizeChanges(
  worktreePath: string,
  statuses: WorktreeStatusEntry[],
  numstat: Map<string, { additions: number | null; deletions: number | null }>,
): Omit<ExecutionDiff, 'patch'> {
  const changedFiles: WorktreeChangedFile[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const entry of statuses) {
    const stat = entry.untracked
      ? { additions: countUntrackedLines(worktreePath, entry.path), deletions: 0 }
      : (numstat.get(entry.path) || { additions: null, deletions: null });
    changedFiles.push({ path: entry.path, status: entry.status, additions: stat.additions, deletions: stat.deletions });
    if (Number.isFinite(stat.additions)) insertions += stat.additions as number;
    if (Number.isFinite(stat.deletions)) deletions += stat.deletions as number;
  }
  return { changedFiles, diffStat: { files: changedFiles.length, insertions, deletions } };
}

function assertTrackedDiff(tracked: GitResult, worktreePath: string): void {
  if (tracked.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not build the worktree diff for ${worktreePath}: ${tracked.stderr.trim() || 'unknown error'}`,
    );
  }
}

/** Async twin of {@link collectWorktreeExecutionDiff}. */
export async function collectWorktreeExecutionDiffAsync(params: { worktreePath: string; baseCommit: string }): Promise<ExecutionDiff> {
  const worktreePath = requireDir(params?.worktreePath);
  const baseCommit = String(params?.baseCommit ?? '').trim();
  if (!baseCommit) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'A base commit is required to build the worktree diff.');
  }
  const statuses = await listWorktreeStatusEntriesAsync(worktreePath);
  const numstat = parseNumstat(await runGitAsync(['diff', '--numstat', baseCommit, '--'], worktreePath, { allowFailure: true }));
  const summary = summarizeChanges(worktreePath, statuses, numstat);
  const tracked = await runGitAsync(['diff', '--binary', baseCommit, '--'], worktreePath, { allowFailure: true });
  assertTrackedDiff(tracked, worktreePath);
  const chunks = [tracked.stdout];
  for (const entry of statuses.filter((row) => row.untracked)) {
    const untracked = await runGitAsync(['diff', '--no-index', '--binary', '--', '/dev/null', entry.path], worktreePath, { allowFailure: true });
    if (untracked.stdout) chunks.push(untracked.stdout);
  }
  return { ...summary, patch: chunks.filter(Boolean).join('') };
}

export function branchExists(repoRoot: string, branch: unknown): boolean {
  const name = String(branch ?? '').trim();
  if (!name) return false;
  const result = runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoRoot, { allowFailure: true });
  return result.status === 0;
}

/**
 * Branches whose short name starts with `prefix`, for orphan detection.
 */
export function listBranchesWithPrefix(repoRoot: string, prefix: unknown): string[] {
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
 */
export function listGitWorktrees(repoRoot: string): GitWorktreeInfo[] {
  const result = runGit(['worktree', 'list', '--porcelain'], repoRoot, { allowFailure: true });
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not list Git worktrees for ${repoRoot}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  const worktrees: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> | null = null;
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
 */
export function resolveWorktreeGitDir(worktreePath: unknown): string | null {
  const cwd = String(worktreePath ?? '').trim();
  if (!cwd || !fs.existsSync(cwd)) return null;
  const result = runGit(['rev-parse', '--absolute-git-dir'], cwd, { allowFailure: true });
  const gitDir = result.stdout.trim();
  return result.status === 0 && gitDir ? path.resolve(gitDir) : null;
}

/**
 * Create the linked worktree at `baseCommit`, reusing `branch` when it already
 * exists for a resumable reservation. Never resets or checks out over work.
 */
export function gitWorktreeAdd(params: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  branchExists: boolean;
}): void {
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
 */
export function gitWorktreeRemove(params: {
  repoRoot: string;
  worktreePath: string;
  force?: boolean;
}): { removed: boolean; message: string } {
  const args = ['worktree', 'remove'];
  if (params.force) args.push('--force');
  args.push(params.worktreePath);
  const result = runGit(args, params.repoRoot, { allowFailure: true });
  if (result.status !== 0) {
    return { removed: false, message: result.stderr.trim() || result.stdout.trim() || 'git worktree remove failed' };
  }
  return { removed: true, message: '' };
}

// ---------------------------------------------------------------------------
// Async twins for server-loop callers. Each mirrors its sync counterpart above
// and awaits `runGitAsync`, so a large tree never stalls the event loop.
// ---------------------------------------------------------------------------

export async function resolveRepositoryRootAsync(dir: unknown): Promise<string> {
  const cwd = requireDir(dir);
  const result = await runGitAsync(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true });
  return parseRepositoryRoot(result, cwd);
}

export async function resolveHeadCommitAsync(repoRoot: string): Promise<string> {
  const result = await runGitAsync(['rev-parse', '--verify', 'HEAD'], repoRoot, { allowFailure: true });
  const sha = result.stdout.trim();
  if (result.status !== 0 || !sha) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not read HEAD in ${repoRoot}; commit something before using worktree mode.`,
    );
  }
  return sha;
}

export async function resolveCommitAsync(ref: unknown, repoRoot: string): Promise<string | null> {
  const value = String(ref ?? '').trim();
  if (!value) return null;
  const result = await runGitAsync(['rev-parse', '--verify', '--quiet', `${value}^{commit}`], repoRoot, { allowFailure: true });
  const sha = result.stdout.trim();
  return result.status === 0 && sha ? sha : null;
}

export async function isWorkingTreeCleanAsync(dir: string): Promise<boolean> {
  const result = await runGitAsync(['status', '--porcelain'], dir, { allowFailure: true });
  if (result.status !== 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.GIT_FAILED,
      `Could not read the Git status of ${dir}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  return result.stdout.trim() === '';
}

export async function listDirtyWorktreePathsAsync(dir: string): Promise<string[]> {
  return (await listWorktreeStatusEntriesAsync(dir)).map((entry) => entry.path);
}

async function readAuthorAsync(cwd: string): Promise<Record<string, string>> {
  const name = (await runGitAsync(['config', 'user.name'], cwd, { allowFailure: true })).stdout.trim() || 'Cretli';
  const email = (await runGitAsync(['config', 'user.email'], cwd, { allowFailure: true })).stdout.trim() || 'cretli@localhost';
  return { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email };
}

export async function createDirtyTreeSnapshotAsync(
  repoRoot: string,
  todoId: unknown,
): Promise<{ commit: string; headCommit: string; ref: string }> {
  const headCommit = await resolveHeadCommitAsync(repoRoot);
  const indexPath = path.join(os.tmpdir(), `cretli-index-${randomUUID()}`);
  const ref = `refs/cretli/snapshots/${String(todoId).replace(/[^a-zA-Z0-9-]/g, '-')}`;
  const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const execute = async (args: string[]): Promise<string> => (await runGitAsync(args, repoRoot, { env })).stdout;
  try {
    await execute(['read-tree', headCommit]);
    await execute(['add', '-A', '--', '.']);
    const tree = (await execute(['write-tree'])).trim();
    const parent = headCommit ? ['-p', headCommit] : [];
    const author = await readAuthorAsync(repoRoot);
    const commit = (await runGitAsync(['commit-tree', tree, ...parent, '-m', `Cretli snapshot for ${todoId}`], repoRoot, {
      env: { ...env, ...author },
    })).stdout.trim();
    await runGitAsync(['update-ref', ref, commit], repoRoot);
    return { commit, headCommit, ref };
  } finally {
    try { fs.unlinkSync(indexPath); } catch {}
    try { fs.unlinkSync(`${indexPath}.lock`); } catch {}
  }
}

export async function createWorktreeLeafCheckpointAsync(
  worktreePath: string,
  todoId: unknown,
  branch: unknown,
): Promise<{ commit: string; parent: string; branch: string }> {
  const cwd = requireDir(worktreePath);
  const branchName = String(branch ?? '').trim();
  if (!branchName) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'A worktree branch name is required for a leaf checkpoint.');
  }
  const repoRoot = await resolveRepositoryRootAsync(cwd);
  const parent = await resolveHeadCommitAsync(cwd);
  const indexPath = path.join(os.tmpdir(), `cretli-leaf-ckpt-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const execute = async (args: string[]): Promise<string> => (await runGitAsync(args, cwd, { env })).stdout;
  try {
    await execute(['read-tree', parent]);
    await execute(['add', '-A', '--', '.']);
    const tree = (await execute(['write-tree'])).trim();
    const author = await readAuthorAsync(cwd);
    const commit = (await runGitAsync(['commit-tree', tree, '-p', parent, '-m', `Cretli leaf checkpoint for ${todoId}`], cwd, {
      env: { ...env, ...author },
    })).stdout.trim();
    await runGitAsync(['update-ref', `refs/heads/${branchName}`, commit], repoRoot);
    await runGitAsync(['reset', '--hard', commit], cwd);
    return { commit, parent, branch: branchName };
  } finally {
    try { fs.unlinkSync(indexPath); } catch {}
    try { fs.unlinkSync(`${indexPath}.lock`); } catch {}
  }
}

export async function removeDirtyTreeSnapshotRefAsync(repoRoot: string, ref: unknown): Promise<boolean> {
  const value = String(ref ?? '').trim();
  if (!value.startsWith('refs/cretli/snapshots/')) return false;
  const result = await runGitAsync(['update-ref', '-d', value], repoRoot, { allowFailure: true });
  return result.status === 0;
}

async function readUnmergedPathsAsync(workspaceFolder: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const result = await runGitAsync(['ls-files', '-u', '-z', '--'], workspaceFolder, { allowFailure: true, env });
  return parseUnmergedPaths(result);
}

/** Async twin of {@link applyWorktreeExecutionPatch}. */
export async function applyWorktreeExecutionPatchAsync(
  params: { workspaceFolder?: unknown; baseCommit?: unknown; patchPath?: unknown } | null | undefined,
): Promise<{ applied: true; baseCommit: string }> {
  const workspaceFolder = requireDir(params?.workspaceFolder);
  const baseCommit = String(params?.baseCommit ?? '').trim();
  const patchPath = String(params?.patchPath ?? '').trim();
  if (!baseCommit || !patchPath || !fs.existsSync(patchPath)) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'A valid worktree base and patch file are required for integration.');
  }
  if ((await resolveCommitAsync(baseCommit, workspaceFolder)) !== baseCommit) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'The frozen worktree base is no longer available in the logical repository.');
  }
  const temporaryIndex = path.join(os.tmpdir(), `cretli-apply-index-${randomUUID()}`);
  const mergedPatchPath = path.join(os.tmpdir(), `cretli-merged-patch-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    const currentHead = await resolveHeadCommitAsync(workspaceFolder);
    await runGitAsync(['read-tree', currentHead], workspaceFolder, { env });
    await runGitAsync(['add', '-A', '--', '.'], workspaceFolder, { env });
    const beforeTree = (await runGitAsync(['write-tree'], workspaceFolder, { env })).stdout.trim();
    const merge = await runGitAsync(['apply', '--3way', '--cached', patchPath], workspaceFolder, { allowFailure: true, env });
    if (merge.status !== 0) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.INTEGRATION_CONFLICT, 'The worktree patch conflicts with changes made in the logical workspace. Resolve the conflict manually and retry.', { details: { gitError: merge.stderr.trim() || merge.stdout.trim(), conflicts: await readUnmergedPathsAsync(workspaceFolder, env) } });
    }
    const afterTree = (await runGitAsync(['write-tree'], workspaceFolder, { env })).stdout.trim();
    const mergedPatch = await runGitAsync(['diff', '--binary', beforeTree, afterTree, '--'], workspaceFolder);
    if (!mergedPatch.stdout) return { applied: true, baseCommit };
    fs.writeFileSync(mergedPatchPath, mergedPatch.stdout);
    const check = await runGitAsync(['apply', '--check', mergedPatchPath], workspaceFolder, { allowFailure: true });
    if (check.status !== 0) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.INTEGRATION_CONFLICT, 'The merged worktree patch no longer applies to the logical workspace. No files were changed.', { details: { gitError: check.stderr.trim() || check.stdout.trim() } });
    }
    const applied = await runGitAsync(['apply', mergedPatchPath], workspaceFolder, { allowFailure: true });
    if (applied.status !== 0) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.INTEGRATION_CONFLICT, 'The merged worktree patch could not be applied. Inspect the logical workspace before retrying.', { details: { gitError: applied.stderr.trim() || applied.stdout.trim() } });
    }
    return { applied: true, baseCommit };
  } finally {
    try { fs.unlinkSync(temporaryIndex); } catch {}
    try { fs.unlinkSync(`${temporaryIndex}.lock`); } catch {}
    try { fs.unlinkSync(mergedPatchPath); } catch {}
  }
}

export async function gitWorktreeAddAsync(params: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  branchExists: boolean;
}): Promise<void> {
  const { repoRoot, worktreePath, branch, baseCommit, branchExists: useExistingBranch } = params;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const args = useExistingBranch
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseCommit];
  await runGitAsync(args, repoRoot);
}

export async function gitWorktreeRemoveAsync(params: {
  repoRoot: string;
  worktreePath: string;
  force?: boolean;
}): Promise<{ removed: boolean; message: string }> {
  const args = ['worktree', 'remove'];
  if (params.force) args.push('--force');
  args.push(params.worktreePath);
  const result = await runGitAsync(args, params.repoRoot, { allowFailure: true });
  if (result.status !== 0) {
    return { removed: false, message: result.stderr.trim() || result.stdout.trim() || 'git worktree remove failed' };
  }
  return { removed: true, message: '' };
}
