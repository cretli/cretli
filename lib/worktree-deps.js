/**
 * Cheap worktrees: shared dependency store, disk-space guard, cleanup of
 * finished worktrees and a size/integration report.
 *
 * Shared store: `node_modules` is cached per sha256 of `package-lock.json`
 * under `<worktree root>/.shared-deps/<hash>/node_modules`. The first worktree
 * with a given lock runs the declared prepare command and publishes its
 * `node_modules` into the store; every later worktree with the same lock gets
 * a reflink (copy-on-write) or hardlink clone and skips the prepare command.
 * A hardlink clone costs directory entries and symlinks only (tens of MB), not
 * the full tree.
 *
 * Nothing here runs git directly except through `runGit`/`gitWorktreeRemove`.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { listTodos } from './persist/todos-store.js';
import { removeWorktree } from './worktree-manager.js';
import { summarizeTodoIntegration } from './todo-integration-read.js';
import { listWorktreeStatusEntries } from './worktree/git-worktree.ts';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree/worktree-errors.ts';

export const SHARED_DEPS_DIR = '.shared-deps';
export const DEFAULT_MIN_FREE_GB = 20;
const COMPLETE_MARKER = '.complete';
const GIB = 1024 ** 3;

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {string} file
 * @returns {string} sha256 hex of the file, or '' when unreadable
 */
export function hashLockfile(file) {
  try {
    // Native addons and postinstall output depend on the platform, CPU and Node
    // ABI, so they are part of the store key next to the lock contents.
    const env = `${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}\0`;
    return crypto.createHash('sha256').update(env).update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * @param {Record<string, any> | null | undefined} config worktree layout block
 * @returns {boolean}
 */
export function isSharedDepsEnabled(config) {
  if (config && config.sharedDeps === false) return false;
  // Only a plain `npm ci` is replaceable by a cached node_modules; any other
  // prepare command may do more than install and always runs.
  const cmd = Array.isArray(config?.prepareCommand) ? config.prepareCommand.map(String) : [];
  if (!['npm', 'npm.cmd'].includes(cmd[0]) || cmd[1] !== 'ci') return false;
  return process.env.CRETLI_WORKTREE_SHARED_DEPS !== '0';
}

/**
 * @param {string} root worktree root
 * @param {string} hash
 * @returns {string}
 */
export function sharedDepsEntryDir(root, hash) {
  return path.join(root, SHARED_DEPS_DIR, hash);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {Function} [execFileFn]
 * @returns {Promise<boolean>} true on exit 0
 */
function runOk(cmd, args, execFileFn) {
  const run = typeof execFileFn === 'function' ? execFileFn : execFile;
  return new Promise((resolve) => {
    run(cmd, args, { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }, (error) => resolve(!error));
  });
}

/** File inside `<worktree>/node_modules` naming the lockfile hash it was installed for. */
export const INSTALLED_HASH_MARKER = '.cretli-lock-hash';

/**
 * Record which lockfile hash `<worktree>/node_modules` matches. Best-effort.
 *
 * @param {string} worktreePath
 * @param {string} hash
 * @returns {void}
 */
export function writeInstalledDepsHash(worktreePath, hash) {
  if (!hash) return;
  try {
    fs.writeFileSync(path.join(worktreePath, 'node_modules', INSTALLED_HASH_MARKER), `${hash}\n`);
  } catch {
    // A missing marker only costs one extra prepare on the next reuse.
  }
}

/**
 * True when `<worktree>/node_modules` was installed or provisioned for the
 * worktree's current lockfile. A reused worktree in that state must not rerun
 * the prepare command: `npm ci` deletes the hardlinked tree and writes a full
 * copy (~2.3 GB) on every retry, fix round or restart re-queue.
 *
 * @param {string} worktreePath
 * @returns {boolean}
 */
export function hasCurrentInstalledDeps(worktreePath) {
  const hash = hashLockfile(path.join(worktreePath, 'package-lock.json'));
  if (!hash) return false;
  try {
    return fs.readFileSync(path.join(worktreePath, 'node_modules', INSTALLED_HASH_MARKER), 'utf8').trim() === hash;
  } catch {
    return false;
  }
}

/**
 * Clone `src` to `dest` with copy-on-write, falling back to hardlinks.
 * Removes `dest` after a failed attempt so the next strategy starts clean.
 *
 * @param {string} src
 * @param {string} dest
 * @param {{ cpFn?: (src: string, dest: string, mode: 'reflink' | 'hardlink') => Promise<boolean> }} [deps]
 * @returns {Promise<'reflink' | 'hardlink' | null>}
 */
export async function cloneDirectory(src, dest, deps = {}) {
  const cp = typeof deps.cpFn === 'function'
    ? deps.cpFn
    : (from, to, mode) => runOk('cp', mode === 'reflink' ? ['-a', '--reflink=always', from, to] : ['-al', from, to]);
  for (const mode of /** @type {const} */ (['reflink', 'hardlink'])) {
    if (await cp(src, dest, mode)) return mode;
    fs.rmSync(dest, { recursive: true, force: true });
  }
  return null;
}

/**
 * Populate `<worktree>/node_modules` from the shared store when an entry for
 * the worktree's lockfile exists.
 *
 * @param {{ worktreePath: string, config: Record<string, any>, deps?: Record<string, any> }} input
 * @returns {Promise<{ provisioned: boolean, hash: string, reason?: string, method?: string }>}
 */
export async function provisionSharedDeps(input) {
  const hash = hashLockfile(path.join(input.worktreePath, 'package-lock.json'));
  if (!hash) return { provisioned: false, hash: '', reason: 'no_lockfile' };
  const target = path.join(input.worktreePath, 'node_modules');
  if (fs.existsSync(target)) return { provisioned: false, hash, reason: 'already_present' };
  const entry = sharedDepsEntryDir(input.config.root, hash);
  const source = path.join(entry, 'node_modules');
  if (!fs.existsSync(path.join(entry, COMPLETE_MARKER)) || !fs.existsSync(source)) {
    return { provisioned: false, hash, reason: 'store_miss' };
  }
  const method = await cloneDirectory(source, target, input.deps);
  if (!method) return { provisioned: false, hash, reason: 'clone_failed' };
  writeInstalledDepsHash(input.worktreePath, hash);
  return { provisioned: true, hash, method };
}

/**
 * Publish a freshly prepared `node_modules` into the store (hardlink clone, so
 * the store costs almost nothing extra). Best-effort and atomic: the entry is
 * built under a temp name and renamed; the `.complete` marker is written last.
 *
 * @param {{ worktreePath: string, config: Record<string, any>, deps?: Record<string, any> }} input
 * @returns {Promise<{ published: boolean, hash: string, reason?: string }>}
 */
export async function publishSharedDeps(input) {
  const hash = hashLockfile(path.join(input.worktreePath, 'package-lock.json'));
  if (!hash) return { published: false, hash: '', reason: 'no_lockfile' };
  const source = path.join(input.worktreePath, 'node_modules');
  if (!fs.existsSync(source)) return { published: false, hash, reason: 'no_node_modules' };
  const entry = sharedDepsEntryDir(input.config.root, hash);
  if (fs.existsSync(path.join(entry, COMPLETE_MARKER))) return { published: false, hash, reason: 'exists' };
  const tmp = `${entry}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    // Hardlink only: a full copy of the tree would defeat the purpose.
    const cp = typeof input.deps?.cpFn === 'function'
      ? input.deps.cpFn
      : (from, to) => runOk('cp', ['-al', from, to]);
    if (!(await cp(source, path.join(tmp, 'node_modules'), 'hardlink'))) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { published: false, hash, reason: 'clone_failed' };
    }
    fs.writeFileSync(path.join(tmp, COMPLETE_MARKER), `${new Date().toISOString()}\n`);
    // Never remove an existing entry: a concurrent publisher may have just
    // completed it and readers may be cloning from it. A stale incomplete
    // entry (no marker) is replaced by renaming it aside first.
    if (fs.existsSync(entry) && !fs.existsSync(path.join(entry, COMPLETE_MARKER))) {
      fs.rmSync(entry, { recursive: true, force: true });
    }
    try {
      fs.renameSync(tmp, entry);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      fs.rmSync(tmp, { recursive: true, force: true });
      if ((code === 'EEXIST' || code === 'ENOTEMPTY') && fs.existsSync(path.join(entry, COMPLETE_MARKER))) {
        return { published: false, hash, reason: 'exists' };
      }
      throw error;
    }
    return { published: true, hash };
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { published: false, hash, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Free space (bytes) of the filesystem holding `target` (nearest existing
 * ancestor). Returns null when it cannot be measured.
 *
 * @param {string} target
 * @param {(p: string) => { bavail: number | bigint, bsize: number | bigint }} [statfs]
 * @returns {number | null}
 */
export function readFreeBytes(target, statfs = (p) => fs.statfsSync(p)) {
  let cur = path.resolve(target);
  for (let i = 0; i < 64; i += 1) {
    try {
      const s = statfs(cur);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
  return null;
}

/**
 * Minimum free space (GB) required to create a new worktree. `0` disables.
 *
 * @param {Record<string, any> | null | undefined} config
 * @returns {number}
 */
export function resolveMinFreeGb(config) {
  const raw = config?.minFreeGb ?? process.env.CRETLI_WORKTREE_MIN_FREE_GB;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MIN_FREE_GB;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_FREE_GB;
}

/**
 * Refuse a new worktree when free disk space is below the configured floor.
 * An unmeasurable disk never blocks (fail open: this is a convenience guard).
 *
 * @param {{ root: string, config?: Record<string, any> | null, statfs?: (p: string) => { bavail: number | bigint, bsize: number | bigint } }} input
 * @returns {{ ok: boolean, freeGb: number | null, minFreeGb: number }}
 * @throws {WorktreeError} DISK_LOW
 */
export function assertWorktreeDiskSpace(input) {
  const minFreeGb = resolveMinFreeGb(input.config);
  if (minFreeGb <= 0) return { ok: true, freeGb: null, minFreeGb };
  const free = readFreeBytes(input.root, input.statfs);
  if (free === null) return { ok: true, freeGb: null, minFreeGb };
  const freeGb = Math.round((free / GIB) * 10) / 10;
  if (free < minFreeGb * GIB) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.DISK_LOW,
      `Not enough free disk space for a new worktree: ${freeGb} GB free under ${input.root}, need at least ${minFreeGb} GB (worktree.minFreeGb). Clean up finished worktrees first.`,
      { details: { freeGb, minFreeGb, root: input.root } },
    );
  }
  return { ok: true, freeGb, minFreeGb };
}

/**
 * Allocated bytes of a directory tree. Hardlinked files are counted once per
 * inode within one call, so a shared `node_modules` clone reports its real
 * marginal cost relative to what was already counted.
 *
 * @param {string} dir
 * @param {Set<string>} [seen] inode keys already counted
 * @returns {number}
 */
export function directorySizeBytes(dir, seen = new Set()) {
  let total = 0;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length) {
    const cur = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        total += st.blocks * 512;
      } else {
        if (st.nlink > 1) {
          const key = `${st.dev}:${st.ino}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        total += st.blocks * 512;
      }
    }
  }
  return total;
}

/**
 * @param {Record<string, any>} record
 * @param {Record<string, any> | null} todo
 * @returns {{ category: 'removable' | 'keep', reason: string, integration: string }}
 */
export function classifyWorktreeForCleanup(record, todo) {
  const summary = todo ? summarizeTodoIntegration(todo) : null;
  const integration = summary
    ? (summary.detail === 'no_code_changes' ? 'no_code_changes' : summary.detail === 'rejected' ? 'rejected' : summary.state)
    : 'unknown';
  if (record.executionState === 'active' || record.executionState === 'preparing') {
    return { category: 'keep', reason: 'execution_active', integration };
  }
  if (record.creationState === 'reserved') return { category: 'keep', reason: 'creating', integration };
  if (record.integrationState === 'integrated' || integration === 'integrated') {
    return { category: 'removable', reason: 'integrated', integration };
  }
  if (integration === 'no_code_changes' && todo?.status === 'done') {
    return { category: 'removable', reason: 'no_code_changes', integration };
  }
  if (record.integrationState === 'rejected' || integration === 'rejected') {
    return { category: 'removable', reason: 'rejected', integration };
  }
  return { category: 'keep', reason: integration === 'awaiting' ? 'awaiting_integration' : 'unintegrated', integration };
}

/**
 * Loads the registry records and todos of one workspace.
 *
 * @param {{ dataDir?: string, workspaceFolder: string }} input
 * @returns {Promise<{ records: Record<string, any>[], todoById: Map<string, Record<string, any>> }>}
 */
async function loadWorkspaceState(input) {
  const registry = readWorktreeRegistry(input.dataDir ? { dataDir: input.dataDir } : {});
  const ws = path.resolve(readString(input.workspaceFolder));
  const records = Object.values(registry.items || {})
    .filter((r) => path.resolve(readString(r.workspaceFolder)) === ws && !r.cleanedAt);
  let todos = [];
  try {
    todos = (await listTodos(input.dataDir, input.workspaceFolder)).items || [];
  } catch {
    todos = [];
  }
  return { records, todoById: new Map(todos.map((t) => [String(t.id), t])) };
}

/**
 * Size and integration report of every non-cleaned worktree of a workspace.
 *
 * @param {{ dataDir?: string, workspaceFolder: string, withSize?: boolean }} input
 * @returns {Promise<{ rows: Record<string, any>[], totalBytes: number, removableBytes: number }>}
 */
export async function buildWorktreeReport(input) {
  const { records, todoById } = await loadWorkspaceState(input);
  const seen = new Set();
  let totalBytes = 0;
  let removableBytes = 0;
  const rows = records.map((record) => {
    const todo = todoById.get(String(record.todoId)) || null;
    const verdict = classifyWorktreeForCleanup(record, todo);
    const exists = fs.existsSync(record.worktreePath);
    const sizeBytes = exists && input.withSize !== false ? directorySizeBytes(record.worktreePath, seen) : 0;
    let uncommittedFiles = 0;
    let statusFailed = false;
    if (exists) {
      try {
        uncommittedFiles = listWorktreeStatusEntries(record.worktreePath).length;
      } catch {
        statusFailed = true;
      }
    }
    // Unsaved work (modified or untracked files) always wins over the
    // integration verdict; an unreadable status is treated as dirty.
    if (verdict.category === 'removable' && exists && (uncommittedFiles > 0 || statusFailed)) {
      verdict.category = 'keep';
      verdict.reason = statusFailed ? 'status_unavailable' : 'uncommitted_changes';
    }
    totalBytes += sizeBytes;
    if (verdict.category === 'removable') removableBytes += sizeBytes;
    return {
      todoId: record.todoId,
      title: readString(todo?.title),
      branch: record.branch,
      worktreePath: record.worktreePath,
      exists,
      sizeBytes,
      uncommittedFiles,
      integration: verdict.integration,
      category: verdict.category,
      reason: verdict.reason,
    };
  });
  return { rows, totalBytes, removableBytes };
}

/**
 * Remove worktrees of finished todos. Dry-run by default: nothing is touched
 * unless `apply === true`. Worktrees with unintegrated changes are always kept
 * and listed in `kept` so a human can decide.
 *
 * @param {{
 *   dataDir?: string,
 *   workspaceFolder: string,
 *   apply?: boolean,
 *   hasActiveAgent?: (record: Record<string, any>) => boolean,
 *   removeFn?: typeof removeWorktree,
 * }} input
 * @returns {Promise<{
 *   dryRun: boolean,
 *   removed: Record<string, any>[],
 *   candidates: Record<string, any>[],
 *   kept: Record<string, any>[],
 *   failed: Record<string, any>[],
 *   freedBytes: number,
 * }>}
 */
export async function cleanupWorktrees(input) {
  const apply = input.apply === true;
  const report = await buildWorktreeReport({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder });
  const remove = input.removeFn || removeWorktree;
  const hasActiveAgent = typeof input.hasActiveAgent === 'function' ? input.hasActiveAgent : () => false;
  const registryOptions = input.dataDir ? { dataDir: input.dataDir } : {};
  const out = { dryRun: !apply, removed: [], candidates: [], kept: [], failed: [], freedBytes: 0 };
  for (const row of report.rows) {
    if (row.category !== 'removable') {
      out.kept.push(row);
      continue;
    }
    out.candidates.push(row);
    if (!apply) continue;
    try {
      const record = readWorktreeRegistry(registryOptions).items?.[row.todoId];
      const needsAcceptance = Boolean(record) && record.integrationState !== 'integrated';
      // The report already proved the tree has no modified/untracked files, so
      // a plain `git worktree remove` is enough. `forbidForce` guarantees a
      // refusal is never retried with --force, whatever the confirmation says.
      const result = remove({
        todoId: row.todoId,
        registryOptions,
        hasActiveAgent,
        forbidForce: true,
        ...(needsAcceptance
          ? { confirmation: { discard: true, worktreePath: record.worktreePath, branch: record.branch } }
          : {}),
      });
      if (result.removed || result.alreadyMissing || result.alreadyCleaned) {
        out.removed.push(row);
        out.freedBytes += row.sizeBytes;
      } else {
        out.failed.push({ ...row, error: 'not_removed' });
      }
    } catch (error) {
      out.failed.push({ ...row, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
