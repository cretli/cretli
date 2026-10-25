/**
 * Per-leaf material baseline and checkpoints for scoped review diffs.
 *
 * Worktree execution: after an independent code review PASS the server commits
 * a leaf checkpoint on the prepared worktree branch only. Project execution:
 * no commits — a path→content-hash manifest at leaf start defines the diff.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getTodoById as getTodoByIdTyped, loadTodosData, updateTodo as updateTodoTyped } from './persist/todos-persist.js';
import { normalizeTodoReview } from './persist/todos-persist.js';
import { readTodoParentId } from './todo-tree.js';
import { readLiveWorktreeRecord, resolveManualTodoExecutionMode, resolveManualTodoRoot } from './todo-worktree-manual.js';
import { createWorktreeLeafCheckpointAsync, isGitRepository, listDirtyWorktreePaths, listDirtyWorktreePathsAsync, listWorktreeStatusEntries, resolveHeadCommitAsync, runGit, runGitAsync } from './worktree/git-worktree.ts';
import { logDelegationEvent } from './delegation-log.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { isImplementationWorkDelegationRow } from './delegation-work-role.js';
import { getWorkspaceWatcher as getWorkspaceWatcherTyped } from './persist/workspace-watchers-persist.js';

// The persist layer types its rows narrowly; widen them so leaf-material fields type-check.
const getTodoById = /** @type {(...args: any[]) => any} */ (getTodoByIdTyped);
const updateTodo = /** @type {(...args: any[]) => any} */ (updateTodoTyped);
const getWorkspaceWatcher = /** @type {(...args: any[]) => any} */ (getWorkspaceWatcherTyped);

const MANIFEST_HASH_BYTES = 16;
/** Worktree leaf checkpoints must target a prepared todo branch, never main/target. */
export const LEAF_CHECKPOINT_BRANCH_INFIX = '/todo/';

/**
 * @returns {number}
 */
function readManifestMaxPaths() {
  const raw = Number(process.env.CRETLI_LEAF_MATERIAL_MANIFEST_MAX_PATHS ?? 50_000);
  if (!Number.isFinite(raw) || raw <= 0) return 50_000;
  return Math.min(Math.floor(raw), 500_000);
}

/**
 * @param {Record<string, any> | null | undefined} rootTodo
 * @returns {boolean}
 */
function isExplicitProjectExecution(rootTodo) {
  return String(rootTodo?.executionMode ?? '').trim().toLowerCase() === 'project';
}

/**
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @param {Record<string, any> | null | undefined} policyOverride
 * @returns {Record<string, any> | null}
 */
function resolveWatcherPolicyForLeafMaterial(dataDir, workspaceFolder, policyOverride) {
  if (policyOverride && typeof policyOverride === 'object') return policyOverride;
  return getWorkspaceWatcher(workspaceFolder, { dataDir })?.policy ?? null;
}

/**
 * @returns {boolean}
 */
export function isLeafMaterialCheckpointEnabled() {
  const raw = String(process.env.CRETLI_LEAF_MATERIAL_CHECKPOINT ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

/**
 * @param {unknown} raw
 * @returns {Record<string, any> | null}
 */
export function normalizeTodoLeafMaterial(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const mode = String(source.mode || '').trim();
  if (mode !== 'worktree' && mode !== 'project') return null;
  /** @type {Record<string, unknown>} */
  const out = { mode };
  const baseCommit = String(source.baseCommit || '').trim();
  if (baseCommit) out.baseCommit = baseCommit;
  if (source.baseManifest && typeof source.baseManifest === 'object' && !Array.isArray(source.baseManifest)) {
    /** @type {Record<string, string>} */
    const manifest = {};
    for (const [key, value] of Object.entries(source.baseManifest)) {
      const pathKey = String(key || '').trim();
      const hash = String(value || '').trim();
      if (pathKey && hash) manifest[pathKey] = hash;
    }
    if (Object.keys(manifest).length > 0) out.baseManifest = manifest;
  }
  const baseCapturedAt = String(source.baseCapturedAt || '').trim();
  if (baseCapturedAt) out.baseCapturedAt = baseCapturedAt;
  if (source.lastCheckpoint && typeof source.lastCheckpoint === 'object') {
    const ck = /** @type {Record<string, unknown>} */ (source.lastCheckpoint);
    /** @type {Record<string, unknown>} */
    const lastCheckpoint = {};
    const at = String(ck.at || '').trim();
    if (at) lastCheckpoint.at = at;
    const commit = String(ck.commit || '').trim();
    if (commit) lastCheckpoint.commit = commit;
    const error = String(ck.error || '').trim();
    if (error) lastCheckpoint.error = error;
    if (ck.manifest && typeof ck.manifest === 'object' && !Array.isArray(ck.manifest)) {
      /** @type {Record<string, string>} */
      const manifest = {};
      for (const [key, value] of Object.entries(ck.manifest)) {
        const pathKey = String(key || '').trim();
        const hash = String(value || '').trim();
        if (pathKey && hash) manifest[pathKey] = hash;
      }
      if (Object.keys(manifest).length > 0) lastCheckpoint.manifest = manifest;
    }
    const manifestCapture = normalizeLeafManifestCaptureMeta(ck.manifestCapture);
    if (manifestCapture) lastCheckpoint.manifestCapture = manifestCapture;
    if (Object.keys(lastCheckpoint).length > 0) out.lastCheckpoint = lastCheckpoint;
  }
  if (Array.isArray(source.partialPaths)) {
    const partialPaths = source.partialPaths
      .map((row) => String(row || '').trim())
      .filter(Boolean)
      .slice(0, 500);
    if (partialPaths.length > 0) out.partialPaths = partialPaths;
  }
  if (source.siblingCheckpointGap && typeof source.siblingCheckpointGap === 'object' && !Array.isArray(source.siblingCheckpointGap)) {
    const gap = /** @type {Record<string, unknown>} */ (source.siblingCheckpointGap);
    const reason = String(gap.reason || '').trim();
    const siblingId = String(gap.siblingId || '').trim();
    if (reason) {
      /** @type {Record<string, string>} */
      const siblingCheckpointGap = { reason };
      if (siblingId) siblingCheckpointGap.siblingId = siblingId;
      out.siblingCheckpointGap = siblingCheckpointGap;
    }
  }
  const baseManifestCapture = normalizeLeafManifestCaptureMeta(source.baseManifestCapture);
  if (baseManifestCapture) out.baseManifestCapture = baseManifestCapture;
  if (source.worktreeRecordMissing === true) out.worktreeRecordMissing = true;
  return out;
}

/**
 * @param {unknown} raw
 * @returns {{ incomplete: boolean, totalPaths: number, maxPaths: number, capturedPaths: number } | null}
 */
function normalizeLeafManifestCaptureMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const incomplete = source.incomplete === true;
  const totalPaths = Number(source.totalPaths);
  const maxPaths = Number(source.maxPaths);
  const capturedPaths = Number(source.capturedPaths);
  if (!incomplete && !Number.isFinite(totalPaths) && !Number.isFinite(maxPaths)) return null;
  /** @type {{ incomplete: boolean, totalPaths: number, maxPaths: number, capturedPaths: number }} */
  const out = {
    incomplete,
    totalPaths: Number.isFinite(totalPaths) && totalPaths >= 0 ? Math.floor(totalPaths) : 0,
    maxPaths: Number.isFinite(maxPaths) && maxPaths > 0 ? Math.floor(maxPaths) : readManifestMaxPaths(),
    capturedPaths: Number.isFinite(capturedPaths) && capturedPaths >= 0 ? Math.floor(capturedPaths) : 0,
  };
  if (!out.incomplete && out.capturedPaths >= out.totalPaths && out.totalPaths > 0) return null;
  return out;
}

/**
 * Deterministic content fingerprint without following symlinked directories.
 *
 * @param {string} absPath
 * @param {string} repoRoot
 * @param {string} relPath
 * @returns {string}
 */
function hashPathForLeafManifest(absPath, repoRoot, relPath) {
  if (!fs.existsSync(absPath)) return 'deleted';
  let st;
  try {
    st = fs.lstatSync(absPath);
  } catch (error) {
    const code = error instanceof Error ? /** @type {any} */ (error).code : 'lstat_failed';
    return `err:${String(code || 'lstat_failed').slice(0, 24)}`;
  }
  if (st.isSymbolicLink()) {
    try {
      const target = fs.readlinkSync(absPath);
      return createHash('sha256').update(`symlink:${target}`, 'utf8').digest('hex').slice(0, MANIFEST_HASH_BYTES);
    } catch (error) {
      const code = error instanceof Error ? /** @type {any} */ (error).code : 'readlink_failed';
      return `err:${String(code || 'readlink_failed').slice(0, 24)}`;
    }
  }
  if (st.isDirectory()) {
    return createHash('sha256').update(`dir:${st.mode}:${st.size}`, 'utf8').digest('hex').slice(0, MANIFEST_HASH_BYTES);
  }
  if (!st.isFile()) {
    return createHash('sha256').update(`node:${st.mode}:${st.size}`, 'utf8').digest('hex').slice(0, MANIFEST_HASH_BYTES);
  }
  try {
    const buf = fs.readFileSync(absPath);
    return createHash('sha256').update(buf).digest('hex').slice(0, MANIFEST_HASH_BYTES);
  } catch (error) {
    const gitHash = runGit(['hash-object', relPath], repoRoot, { allowFailure: true }).stdout.trim();
    if (gitHash) return gitHash.slice(0, MANIFEST_HASH_BYTES);
    const code = error instanceof Error ? /** @type {any} */ (error).code : 'read_failed';
    return `err:${String(code || 'read_failed').slice(0, 24)}`;
  }
}

/**
 * @param {string} cwd
 * @returns {{ manifest: Record<string, string>, capture: { incomplete: boolean, totalPaths: number, maxPaths: number, capturedPaths: number } }}
 */
export function captureProjectLeafManifestWithMeta(cwd) {
  const root = path.resolve(String(cwd || '').trim() || process.cwd());
  const ls = runGit(['ls-files', '-z'], root, { allowFailure: true }).stdout.split('\0').filter(Boolean);
  const paths = new Set(ls);
  for (const entry of listWorktreeStatusEntries(root)) paths.add(entry.path);
  const sorted = [...paths].sort();
  const maxPaths = readManifestMaxPaths();
  const capped = sorted.length > maxPaths;
  const selected = capped ? sorted.slice(0, maxPaths) : sorted;
  if (capped) {
    logDelegationEvent('leaf-material-manifest-truncated', {}, { workspaceFolder: root, pathCount: sorted.length, maxPaths });
  }
  /** @type {Record<string, string>} */
  const manifest = {};
  for (const rel of selected) {
    manifest[rel] = hashPathForLeafManifest(path.join(root, rel), root, rel);
  }
  return {
    manifest,
    capture: {
      incomplete: capped,
      totalPaths: sorted.length,
      maxPaths,
      capturedPaths: selected.length,
    },
  };
}

/**
 * @param {string} cwd
 * @returns {Record<string, string>}
 */
export function captureProjectLeafManifest(cwd) {
  return captureProjectLeafManifestWithMeta(cwd).manifest;
}

/**
 * Guard leaf checkpoint git mutations to prepared todo worktree branches only.
 *
 * @param {string} worktreePath
 * @param {string} branch
 */
export function assertSafeLeafCheckpointWorktree(worktreePath, branch) {
  const branchName = String(branch ?? '').trim();
  if (!branchName.includes(LEAF_CHECKPOINT_BRANCH_INFIX)) {
    throw new Error('checkpoint_branch_prefix_rejected');
  }
  const cwd = path.resolve(String(worktreePath ?? '').trim());
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error('checkpoint_worktree_missing');
  }
  const headRef = runGit(['symbolic-ref', '--short', 'HEAD'], cwd, { allowFailure: true }).stdout.trim();
  if (!headRef || headRef !== branchName) {
    throw new Error('checkpoint_head_branch_mismatch');
  }
}

/**
 * @param {string} cwd
 * @param {Record<string, string>} baseManifest
 * @returns {{ changedPaths: string[], current: Record<string, string> }}
 */
export function diffProjectLeafManifest(cwd, baseManifest) {
  const current = captureProjectLeafManifest(cwd);
  const base = baseManifest && typeof baseManifest === 'object' ? baseManifest : {};
  const allPaths = new Set([...Object.keys(base), ...Object.keys(current)]);
  const changedPaths = [];
  for (const filePath of allPaths) {
    if (base[filePath] !== current[filePath]) changedPaths.push(filePath);
  }
  changedPaths.sort();
  return { changedPaths, current };
}

/**
 * @param {string} worktreePath
 * @param {string} baseCommit
 * @returns {string}
 */
export function readWorktreeLeafMaterialRevision(worktreePath, baseCommit) {
  const base = String(baseCommit || '').trim();
  const folder = String(worktreePath || '').trim();
  if (!folder || !base) return '';
  try {
    const head = runGit(['rev-parse', '--short=12', 'HEAD'], folder, { allowFailure: true }).stdout.trim();
    if (!head) return '';
    const diffNames = runGit(['diff', '--name-only', base, 'HEAD'], folder, { allowFailure: true }).stdout
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean);
    const dirty = listDirtyWorktreePaths(folder);
    const scope = [...new Set([...diffNames, ...dirty])].sort().join('\n');
    const stamp = createHash('sha256').update(scope, 'utf8').digest('hex').slice(0, 8);
    const baseShort = base.slice(0, 7);
    return `${head}~${baseShort}+${stamp}`;
  } catch {
    return '';
  }
}

/**
 * @param {string} cwd
 * @param {Record<string, string>} baseManifest
 * @returns {string}
 */
export function readProjectLeafMaterialRevision(cwd, baseManifest) {
  const { changedPaths } = diffProjectLeafManifest(cwd, baseManifest || {});
  if (changedPaths.length === 0) return 'proj+clean';
  const stamp = createHash('sha256').update(changedPaths.join('\n'), 'utf8').digest('hex').slice(0, 12);
  return `proj+${stamp}`;
}

/**
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} leaf
 * @returns {string}
 */
/**
 * When a prior sibling is already `done` but its async checkpoint has not landed
 * yet, wait for it (or write it) so the next leaf inherits the correct base.
 *
 * @param {{ dataDir: string, workspaceFolder: string, items: Record<string, any>[], leaf: Record<string, any> }} input
 * @returns {Promise<Record<string, any>[]>}
 */
async function flushPreviousSiblingLeafCheckpoint(input) {
  const parentId = readTodoParentId(input.leaf) || '';
  const myIndex = Number.isInteger(input.leaf?.siblingIndex) ? Number(input.leaf.siblingIndex) : Number.MAX_SAFE_INTEGER;
  const previous = (Array.isArray(input.items) ? input.items : [])
    .filter((row) => readTodoParentId(row) === parentId)
    .filter((row) => String(row?.id || '') !== String(input.leaf?.id || ''))
    .filter((row) => (Number.isInteger(row?.siblingIndex) ? Number(row.siblingIndex) : 0) < myIndex)
    .filter((row) => String(row?.status || '') === 'done')
    .sort((a, b) => (Number(b.siblingIndex) || 0) - (Number(a.siblingIndex) || 0))[0];
  if (!previous) return input.items;
  const material = normalizeTodoLeafMaterial(previous.leafMaterial);
  const hasCheckpoint = Boolean(
    String(material?.lastCheckpoint?.commit || '').trim()
    || (material?.lastCheckpoint?.manifest && typeof material.lastCheckpoint.manifest === 'object'),
  );
  if (hasCheckpoint) return input.items;
  if (!isLeafEligibleForCheckpoint(previous)) return input.items;
  await writeLeafMaterialCheckpoint({
    dataDir: input.dataDir,
    workspaceFolder: input.workspaceFolder,
    leafId: String(previous.id || '').trim(),
  });
  return loadTodosData(input.dataDir, input.workspaceFolder).items;
}

/**
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} leaf
 * @returns {{ reason: string, siblingId: string } | null}
 */
function readSiblingCheckpointHandoffGap(items, leaf) {
  const parentId = readTodoParentId(leaf) || '';
  const myIndex = Number.isInteger(leaf?.siblingIndex) ? Number(leaf.siblingIndex) : Number.MAX_SAFE_INTEGER;
  const previous = (Array.isArray(items) ? items : [])
    .filter((row) => readTodoParentId(row) === parentId)
    .filter((row) => String(row?.id || '') !== String(leaf?.id || ''))
    .filter((row) => (Number.isInteger(row?.siblingIndex) ? Number(row.siblingIndex) : 0) < myIndex)
    .filter((row) => String(row?.status || '') === 'done')
    .sort((a, b) => (Number(b.siblingIndex) || 0) - (Number(a.siblingIndex) || 0))[0];
  if (!previous) return null;
  const material = normalizeTodoLeafMaterial(previous.leafMaterial);
  const hasCheckpoint = Boolean(
    String(material?.lastCheckpoint?.commit || '').trim()
    || (material?.lastCheckpoint?.manifest && typeof material.lastCheckpoint.manifest === 'object'),
  );
  if (hasCheckpoint) return null;
  if (!isLeafEligibleForCheckpoint(previous)) {
    return { reason: 'previous_sibling_done_without_verified_pass', siblingId: String(previous.id || '').trim() };
  }
  const err = String(material?.lastCheckpoint?.error || '').trim();
  if (err) {
    return { reason: 'previous_sibling_checkpoint_failed', siblingId: String(previous.id || '').trim() };
  }
  return { reason: 'previous_sibling_checkpoint_missing', siblingId: String(previous.id || '').trim() };
}

function readPreviousSiblingCheckpointCommit(/** @type {any} */ items, /** @type {any} */ leaf) {
  const parentId = readTodoParentId(leaf) || '';
  const myIndex = Number.isInteger(leaf?.siblingIndex) ? Number(leaf.siblingIndex) : Number.MAX_SAFE_INTEGER;
  const candidates = (Array.isArray(items) ? items : [])
    .filter((row) => readTodoParentId(row) === parentId)
    .filter((row) => String(row?.id || '') !== String(leaf?.id || ''))
    .filter((row) => (Number.isInteger(row?.siblingIndex) ? Number(row.siblingIndex) : 0) < myIndex)
    .sort((a, b) => (Number(b.siblingIndex) || 0) - (Number(a.siblingIndex) || 0));
  for (const row of candidates) {
    if (String(row?.status || '') !== 'done') continue;
    const material = normalizeTodoLeafMaterial(row?.leafMaterial);
    const commit = String(material?.lastCheckpoint?.commit || '').trim();
    if (commit) return commit;
  }
  return '';
}

/**
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} leaf
 * @returns {Record<string, string>}
 */
function readPreviousSiblingCheckpointManifest(items, leaf) {
  const parentId = readTodoParentId(leaf) || '';
  const myIndex = Number.isInteger(leaf?.siblingIndex) ? Number(leaf.siblingIndex) : Number.MAX_SAFE_INTEGER;
  const candidates = (Array.isArray(items) ? items : [])
    .filter((row) => readTodoParentId(row) === parentId)
    .filter((row) => String(row?.id || '') !== String(leaf?.id || ''))
    .filter((row) => (Number.isInteger(row?.siblingIndex) ? Number(row.siblingIndex) : 0) < myIndex)
    .sort((a, b) => (Number(b.siblingIndex) || 0) - (Number(a.siblingIndex) || 0));
  for (const row of candidates) {
    if (String(row?.status || '') !== 'done') continue;
    const material = normalizeTodoLeafMaterial(row?.leafMaterial);
    const manifest = material?.lastCheckpoint?.manifest;
    if (manifest && typeof manifest === 'object') return /** @type {Record<string, string>} */ (manifest);
  }
  return {};
}

/**
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} leaf
 * @returns {{ incomplete: boolean, totalPaths: number, maxPaths: number, capturedPaths: number } | null}
 */
function readPreviousSiblingCheckpointManifestCapture(items, leaf) {
  const parentId = readTodoParentId(leaf) || '';
  const myIndex = Number.isInteger(leaf?.siblingIndex) ? Number(leaf.siblingIndex) : Number.MAX_SAFE_INTEGER;
  const candidates = (Array.isArray(items) ? items : [])
    .filter((row) => readTodoParentId(row) === parentId)
    .filter((row) => String(row?.id || '') !== String(leaf?.id || ''))
    .filter((row) => (Number.isInteger(row?.siblingIndex) ? Number(row.siblingIndex) : 0) < myIndex)
    .sort((a, b) => (Number(b.siblingIndex) || 0) - (Number(a.siblingIndex) || 0));
  for (const row of candidates) {
    if (String(row?.status || '') !== 'done') continue;
    const material = normalizeTodoLeafMaterial(row?.leafMaterial);
    const capture = material?.lastCheckpoint?.manifestCapture;
    if (capture && typeof capture === 'object') {
      return /** @type {{ incomplete: boolean, totalPaths: number, maxPaths: number, capturedPaths: number }} */ (capture);
    }
    const baseCapture = material?.baseManifestCapture;
    if (baseCapture && typeof baseCapture === 'object' && baseCapture.incomplete) {
      return /** @type {{ incomplete: boolean, totalPaths: number, maxPaths: number, capturedPaths: number }} */ (baseCapture);
    }
  }
  return null;
}

/**
 * @param {{ dataDir: string, workspaceFolder: string, leafId: string, policy?: Record<string, any> | null }} input
 * @returns {{ mode: 'worktree' | 'project', executionFolder: string, worktreeRecord?: Record<string, any> | null, worktreeRecordMissing?: boolean }}
 */
export function resolveLeafMaterialExecutionContext(input) {
  const dataDir = String(input.dataDir || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const leafId = String(input.leafId || '').trim();
  const items = loadTodosData(dataDir, workspaceFolder).items;
  const leaf = items.find((row) => String(row?.id || '') === leafId);
  if (!leaf) return { mode: 'project', executionFolder: workspaceFolder, worktreeRecord: null };
  const { rootId, root } = resolveManualTodoRoot(items, leafId);
  const policy = resolveWatcherPolicyForLeafMaterial(dataDir, workspaceFolder, input.policy);
  const record = readLiveWorktreeRecord(rootId, dataDir);
  let mode = resolveManualTodoExecutionMode({ rootTodo: root, policy }).mode;
  if (!isExplicitProjectExecution(root) && record) {
    mode = 'worktree';
  }
  if (mode !== 'worktree') {
    return { mode: 'project', executionFolder: workspaceFolder, worktreeRecord: null, worktreeRecordMissing: false };
  }
  const worktreeRecordMissing = !record;
  if (worktreeRecordMissing) {
    logDelegationEvent('leaf-material-worktree-record-missing', {}, { todoId: leafId, workspaceFolder });
  }
  return {
    mode: 'worktree',
    executionFolder: String(record?.worktreePath || workspaceFolder).trim() || workspaceFolder,
    worktreeRecord: record,
    worktreeRecordMissing,
  };
}

/**
 * @param {{ dataDir: string, workspaceFolder: string, leafId: string, policy?: Record<string, any> | null }} input
 * @returns {Promise<Record<string, any> | null>}
 */
export async function ensureLeafMaterialBase(input) {
  if (!isLeafMaterialCheckpointEnabled()) return null;
  const dataDir = String(input.dataDir || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const leafId = String(input.leafId || '').trim();
  if (!dataDir || !workspaceFolder || !leafId) return null;
  const todo = getTodoById(dataDir, workspaceFolder, leafId);
  if (!todo) return null;
  const existing = normalizeTodoLeafMaterial(todo.leafMaterial);
  if (existing?.baseCapturedAt) return todo;
  const ctx = resolveLeafMaterialExecutionContext({ dataDir, workspaceFolder, leafId, policy: input.policy });
  // A project-mode leaf in a folder that is not a Git repository has no
  // material to track; skip the baseline instead of failing the start.
  if (ctx.mode === 'project' && !isGitRepository(workspaceFolder)) {
    logDelegationEvent('leaf-material-skipped-not-git', {}, { todoId: leafId, workspaceFolder });
    return null;
  }
  let items = loadTodosData(dataDir, workspaceFolder).items;
  items = await flushPreviousSiblingLeafCheckpoint({ dataDir, workspaceFolder, items, leaf: todo });
  const handoffGap = readSiblingCheckpointHandoffGap(items, todo);
  /** @type {Record<string, unknown>} */
  const leafMaterial = { mode: ctx.mode, baseCapturedAt: new Date().toISOString() };
  if (handoffGap) {
    leafMaterial.siblingCheckpointGap = handoffGap;
    logDelegationEvent('leaf-material-sibling-checkpoint-gap', {}, { todoId: leafId, workspaceFolder, ...handoffGap });
  }
  if (ctx.worktreeRecordMissing) {
    leafMaterial.worktreeRecordMissing = true;
  }
  if (ctx.mode === 'worktree') {
    const previous = readPreviousSiblingCheckpointCommit(items, todo);
    const fallback = String(ctx.worktreeRecord?.baseCommit || '').trim();
    const baseCommit = previous || fallback || await resolveHeadCommitAsync(ctx.executionFolder);
    leafMaterial.baseCommit = baseCommit;
  } else {
    const inherited = readPreviousSiblingCheckpointManifest(items, todo);
    if (Object.keys(inherited).length > 0) {
      leafMaterial.baseManifest = inherited;
      const inheritedCapture = readPreviousSiblingCheckpointManifestCapture(items, todo);
      if (inheritedCapture?.incomplete) leafMaterial.baseManifestCapture = inheritedCapture;
    } else {
      const captured = captureProjectLeafManifestWithMeta(workspaceFolder);
      leafMaterial.baseManifest = captured.manifest;
      if (captured.capture.incomplete) leafMaterial.baseManifestCapture = captured.capture;
    }
  }
  // The awaits above can outlive the first read, so re-read the CAS token. A
  // concurrent run that already captured the base wins.
  const fresh = getTodoById(dataDir, workspaceFolder, leafId);
  if (!fresh) return null;
  if (normalizeTodoLeafMaterial(fresh.leafMaterial)?.baseCapturedAt) return fresh;
  return updateTodo(dataDir, workspaceFolder, leafId, {
    leafMaterial,
    expectedUpdatedAt: fresh.updatedAt,
  }).items.find((/** @type {any} */ row) => row.id === leafId) || null;
}

/**
 * @param {Record<string, any> | null | undefined} todo
 * @returns {boolean}
 */
function isLeafEligibleForCheckpoint(todo) {
  const review = /** @type {any} */ (normalizeTodoReview(todo?.review));
  return review?.code?.state === 'passed';
}

/** In-flight checkpoint writes keyed by workspace + leaf; a second request joins the first. */
const pendingLeafCheckpoints = new Map();

/** Resolves once every checkpoint started so far has finished (tests, shutdown). */
export async function settleLeafCheckpoints() {
  while (pendingLeafCheckpoints.size > 0) {
    await Promise.allSettled([...pendingLeafCheckpoints.values()]);
  }
}

/**
 * Write the leaf checkpoint. The Git work is asynchronous so a big worktree
 * never stalls the server loop; concurrent requests for one leaf share a single
 * write (two resets on one worktree would race).
 *
 * @param {{ dataDir: string, workspaceFolder: string, leafId: string, policy?: Record<string, any> | null }} input
 * @returns {Promise<Record<string, any> | null>}
 */
export function writeLeafMaterialCheckpoint(input) {
  const key = `${String(input.dataDir || '').trim()}\0${String(input.workspaceFolder || '').trim()}\0${String(input.leafId || '').trim()}`;
  const joined = pendingLeafCheckpoints.get(key);
  if (joined) return joined;
  const run = writeLeafMaterialCheckpointUnshared(input).finally(() => {
    if (pendingLeafCheckpoints.get(key) === run) pendingLeafCheckpoints.delete(key);
  });
  pendingLeafCheckpoints.set(key, run);
  return run;
}

/**
 * @param {{ dataDir: string, workspaceFolder: string, leafId: string, policy?: Record<string, any> | null }} input
 * @returns {Promise<Record<string, any> | null>}
 */
async function writeLeafMaterialCheckpointUnshared(input) {
  if (!isLeafMaterialCheckpointEnabled()) return null;
  const dataDir = String(input.dataDir || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const leafId = String(input.leafId || '').trim();
  if (!dataDir || !workspaceFolder || !leafId) return null;
  const todo = getTodoById(dataDir, workspaceFolder, leafId);
  if (!todo || String(todo.status || '') !== 'done') return null;
  if (!isLeafEligibleForCheckpoint(todo)) return null;
  const material = normalizeTodoLeafMaterial(todo.leafMaterial);
  if (!material?.baseCapturedAt) return null;
  const ctx = resolveLeafMaterialExecutionContext({ dataDir, workspaceFolder, leafId, policy: input.policy });
  const now = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const lastCheckpoint = { at: now };
  try {
    if (ctx.mode === 'worktree') {
      const record = ctx.worktreeRecord;
      if (!record?.worktreePath || !record?.branch) {
        throw new Error('missing_worktree_record');
      }
      const registeredPath = path.resolve(String(record.worktreePath || '').trim());
      const executionPath = path.resolve(String(ctx.executionFolder || '').trim());
      if (!registeredPath || registeredPath !== executionPath) {
        throw new Error('checkpoint_worktree_path_mismatch');
      }
      assertSafeLeafCheckpointWorktree(record.worktreePath, record.branch);
      const result = await createWorktreeLeafCheckpointAsync(record.worktreePath, leafId, record.branch);
      lastCheckpoint.commit = result.commit;
      material.lastCheckpoint = lastCheckpoint;
      delete material.partialPaths;
    } else {
      const captured = captureProjectLeafManifestWithMeta(workspaceFolder);
      lastCheckpoint.manifest = captured.manifest;
      if (captured.capture.incomplete) lastCheckpoint.manifestCapture = captured.capture;
      material.lastCheckpoint = lastCheckpoint;
      delete material.partialPaths;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'checkpoint_failed');
    lastCheckpoint.error = message.slice(0, 500);
    material.lastCheckpoint = lastCheckpoint;
    logDelegationEvent('leaf-material-checkpoint-failed', {}, { todoId: leafId, workspaceFolder, message });
  }
  // The Git work above can outlive the first read; merge into the current row
  // so a concurrent edit does not turn the CAS token stale.
  const current = getTodoById(dataDir, workspaceFolder, leafId);
  if (!current || String(current.status || '') !== 'done') return null;
  const currentMaterial = normalizeTodoLeafMaterial(current.leafMaterial) || material;
  currentMaterial.lastCheckpoint = material.lastCheckpoint;
  if (!material.partialPaths) delete currentMaterial.partialPaths;
  return updateTodo(dataDir, workspaceFolder, leafId, {
    leafMaterial: currentMaterial,
    expectedUpdatedAt: current.updatedAt,
  }).items.find((/** @type {any} */ row) => row.id === leafId) || null;
}

/**
 * @param {{ dataDir: string, workspaceFolder: string, leafId: string, executionFolder: string, delegation: Record<string, any> }} input
 * @returns {Promise<void>}
 */
export async function updateLeafMaterialPartialPaths(input) {
  if (!isLeafMaterialCheckpointEnabled()) return;
  const delegation = input.delegation;
  if (!isImplementationWorkDelegationRow(delegation)) return;
  if (!isTerminalDelegationStatus(delegation?.status)) return;
  const status = String(delegation?.status || '').trim();
  const dataDir = String(input.dataDir || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const leafId = String(input.leafId || '').trim();
  if (!dataDir || !workspaceFolder || !leafId) return;
  const todo = getTodoById(dataDir, workspaceFolder, leafId);
  if (!todo) return;
  const material = normalizeTodoLeafMaterial(todo.leafMaterial) || { mode: 'project', baseCapturedAt: new Date().toISOString() };
  if (status === 'completed') {
    if (!Array.isArray(material.partialPaths) || material.partialPaths.length === 0) return;
    delete material.partialPaths;
    updateTodo(dataDir, workspaceFolder, leafId, {
      leafMaterial: material,
      expectedUpdatedAt: todo.updatedAt,
    });
    return;
  }
  if (status !== 'failed' && status !== 'interrupted') return;
  const folder = String(input.executionFolder || workspaceFolder).trim() || workspaceFolder;
  /** @type {any[]} */
  let partialPaths = [];
  if (material.mode === 'worktree' && material.baseCommit) {
    const diffNames = (await runGitAsync(['diff', '--name-only', String(material.baseCommit), 'HEAD'], folder, { allowFailure: true })).stdout
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean);
    partialPaths = [...new Set([...diffNames, ...await listDirtyWorktreePathsAsync(folder)])].sort();
  } else if (material.baseManifest) {
    partialPaths = diffProjectLeafManifest(folder, /** @type {Record<string, string>} */ (material.baseManifest)).changedPaths;
  }
  if (partialPaths.length === 0) return;
  // Re-read after the Git awaits so the CAS token is current.
  const current = getTodoById(dataDir, workspaceFolder, leafId);
  if (!current) return;
  const currentMaterial = normalizeTodoLeafMaterial(current.leafMaterial) || material;
  currentMaterial.partialPaths = partialPaths;
  updateTodo(dataDir, workspaceFolder, leafId, {
    leafMaterial: currentMaterial,
    expectedUpdatedAt: current.updatedAt,
  });
}

/**
 * @param {Record<string, any> | null | undefined} todo
 * @param {string} executionFolder
 * @returns {string}
 */
export function readLeafScopedMaterialRevisionForTodo(todo, executionFolder) {
  const material = normalizeTodoLeafMaterial(todo?.leafMaterial);
  if (!material?.baseCapturedAt) return '';
  const folder = String(executionFolder || '').trim();
  if (!folder) return '';
  if (material.mode === 'worktree' && material.baseCommit) {
    return readWorktreeLeafMaterialRevision(folder, String(material.baseCommit));
  }
  if (material.mode === 'project' && material.baseManifest) {
    return readProjectLeafMaterialRevision(folder, /** @type {Record<string, string>} */ (material.baseManifest));
  }
  return '';
}

/**
 * @param {Record<string, any> | null | undefined} todo
 * @returns {string}
 */
export function buildLeafMaterialPromptBlock(todo) {
  const material = normalizeTodoLeafMaterial(todo?.leafMaterial);
  if (!material?.baseCapturedAt) return '';
  const lines = ['[LEAF MATERIAL BASE]', 'Scope review and fixes to material changed for this leaf only.'];
  const partial = Array.isArray(material.partialPaths) ? material.partialPaths : [];
  if (partial.length > 0) {
    lines.push('Partial leaf work from the last interrupted/failed run (verify before continuing):');
    for (const filePath of partial.slice(0, 80)) lines.push(`- ${filePath}`);
    if (partial.length > 80) lines.push(`… and ${partial.length - 80} more path(s).`);
  }
  if (material.mode === 'worktree' && material.baseCommit) {
    lines.push(`Diff base commit (previous successful leaf checkpoint or worktree prepare base): ${material.baseCommit}`);
    lines.push(`Run \`git diff ${material.baseCommit}\` (and include unstaged/untracked changes) for the leaf delta.`);
  } else   if (material.mode === 'project' && material.baseManifest) {
    if (partial.length === 0) {
      lines.push('Project execution: leaf diff is the set of paths whose content hash changed since the leaf base manifest captured at leaf start (includes pre-existing dirty files in the base, not in the delta).');
    }
    const capture = material.baseManifestCapture && typeof material.baseManifestCapture === 'object'
      ? /** @type {{ incomplete?: boolean, totalPaths?: number, maxPaths?: number, capturedPaths?: number }} */ (material.baseManifestCapture)
      : null;
    if (capture?.incomplete) {
      lines.push(
        `WARNING: Leaf base manifest is incomplete (captured ${capture.capturedPaths ?? '?'} of ${capture.totalPaths ?? '?'} repo paths; cap ${capture.maxPaths ?? '?'}). `
        + 'The leaf delta may omit changed paths outside the captured set — do not treat the diff as exhaustive.',
      );
    }
  }
  if (material.worktreeRecordMissing) {
    lines.push(
      'WARNING: Worktree execution is configured but no live worktree registry record exists for this todo root; '
      + 'leaf material runs against the project folder. Git leaf checkpoints are refused (checkpoint_error=missing_worktree_record) until a worktree is prepared.',
    );
  }
  const gap = material.siblingCheckpointGap && typeof material.siblingCheckpointGap === 'object'
    ? /** @type {{ reason?: string, siblingId?: string }} */ (material.siblingCheckpointGap)
    : null;
  if (gap?.reason) {
    lines.push(`Sibling checkpoint handoff: ${gap.reason}${gap.siblingId ? ` (sibling ${gap.siblingId.slice(0, 8)})` : ''}.`);
  }
  return lines.join('\n');
}

/**
 * @param {Record<string, any> | null | undefined} todo
 * @returns {string}
 */
export function formatTodoLeafMaterialDiagnostics(todo) {
  const material = normalizeTodoLeafMaterial(todo?.leafMaterial);
  if (!material) return 'leaf_material: -';
  const parts = [`mode=${material.mode}`];
  if (material.baseCommit) parts.push(`base=${String(material.baseCommit).slice(0, 12)}`);
  if (material.lastCheckpoint?.commit) parts.push(`checkpoint=${String(material.lastCheckpoint.commit).slice(0, 12)}`);
  if (material.lastCheckpoint?.error) parts.push(`checkpoint_error=${String(material.lastCheckpoint.error).slice(0, 80)}`);
  if (Array.isArray(material.partialPaths) && material.partialPaths.length > 0) {
    parts.push(`partial_files=${material.partialPaths.length}`);
  }
  const gap = material.siblingCheckpointGap && typeof material.siblingCheckpointGap === 'object'
    ? /** @type {{ reason?: string }} */ (material.siblingCheckpointGap)
    : null;
  if (gap?.reason) parts.push(`sibling_gap=${String(gap.reason).slice(0, 48)}`);
  const capture = material.baseManifestCapture && typeof material.baseManifestCapture === 'object'
    ? /** @type {{ incomplete?: boolean, capturedPaths?: number, totalPaths?: number }} */ (material.baseManifestCapture)
    : null;
  if (capture?.incomplete) {
    parts.push(`manifest_incomplete=${capture.capturedPaths ?? 0}/${capture.totalPaths ?? 0}`);
  }
  if (material.worktreeRecordMissing) parts.push('worktree_record_missing=true');
  return `leaf_material: ${parts.join(' ')}`;
}

/**
 * @param {{ dataDir: string, workspaceFolder: string, todo: Record<string, any>, previousStatus: string }} input
 * @returns {void}
 */
/**
 * @param {{ dataDir: string, workspaceFolder: string, leafId: string, clientRevision?: string }} input
 * @returns {string}
 */
export function resolveWorkflowMaterialRevisionForLeaf(input) {
  const leafId = String(input.leafId || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const clientRevision = String(input.clientRevision || '').trim();
  if (!leafId || !workspaceFolder) return clientRevision;
  const dataDir = String(input.dataDir || '').trim();
  const todo = getTodoById(dataDir, workspaceFolder, leafId);
  const ctx = resolveLeafMaterialExecutionContext({ dataDir, workspaceFolder, leafId });
  const scoped = readLeafScopedMaterialRevisionForTodo(todo, ctx.executionFolder);
  return scoped || clientRevision;
}

export function handleTodoLeafMaterialOnStatusChange(/** @type {any} */ input) {
  const todo = input.todo;
  const previousStatus = String(input.previousStatus || '').trim();
  const nextStatus = String(todo?.status || '').trim();
  if (previousStatus === nextStatus) return;
  if (nextStatus !== 'done') return;
  // Fire-and-forget by design: this runs inside a synchronous todo write, and
  // callers that need the result await `settleLeafCheckpoints()` or the shared
  // write via `writeLeafMaterialCheckpoint`.
  writeLeafMaterialCheckpoint({
    dataDir: input.dataDir,
    workspaceFolder: input.workspaceFolder,
    leafId: String(todo.id || '').trim(),
  }).catch((error) => {
    logDelegationEvent('leaf-material-checkpoint-failed', {}, {
      todoId: String(todo.id || '').trim(),
      workspaceFolder: input.workspaceFolder,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}
