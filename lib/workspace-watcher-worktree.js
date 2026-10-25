/**
 * Worktree preparation for a Workspace Watcher cycle (contract §4, §5, §7).
 *
 * The watcher stays the only writer of a cycle; this module turns a claimed
 * leaf into an execution folder:
 *   - resolve the per-leaf override against the watcher policy default (O1 is
 *     still OPEN, so the resolver never walks ancestors);
 *   - for `worktree` mode create/reuse the persistent worktree at its frozen
 *     base, run the explicit prepare action, then mark the execution `active`;
 *   - for `project` mode keep the logical workspace.
 *
 * Fail-closed rules: a missing worktree layout, a dirty logical tree, a
 * foreign/orphaned worktree and a failed prepare all refuse the start. There is
 * no silent fallback to `project` and no secret/data copy.
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveWorktreeMode } from './worktree/worktree-mode.ts';
import { getWorktreeRecord, readWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { saveExecutionSettings } from './persist/execution-settings-persist.js';
import { applyExecutionSettingsToPolicy } from './execution-settings.js';
import {
  DEFAULT_WORKTREE_MAX_BEHIND,
  ensureWorktreeAsync,
  readWorktreeFreshnessFacts,
  releaseWorktree,
  saveWorktreeCarryPatch,
  updateWorktreeState,
  verifyWorktreeRecord,
} from './worktree-manager.js';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree/worktree-errors.ts';
import {
  TREE_MERGE_CONFLICT_CODE,
  ensureLeafWorktree,
  isParallelLeafWorktreeEnabled,
  syncLeafWithTree,
} from './worktree-tree-leaf.js';
import { mutateWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { logDelegationEvent } from './delegation-log.js';
import { backfillWorktreeLayout, isWorktreeLayoutComplete } from './execution-settings-suggest.js';
import { isWorktreeRecordLive } from './worktree/worktree-record.ts';
import {
  assertWorktreeDiskSpace,
  hasCurrentInstalledDeps,
  hashLockfile,
  isSharedDepsEnabled,
  provisionSharedDeps,
  publishSharedDeps,
  writeInstalledDepsHash,
} from './worktree-deps.js';

/**
 * Pure freshness decision for a live worktree.
 *   - `keep`: within the threshold (or threshold disabled with 0);
 *   - `release`: stale and holds no unintegrated work, so a fresh worktree is
 *     created on the next start;
 *   - `notify_carry`: stale but holds work; never released, the operator is told
 *     to integrate or move it and a patch is saved to the carry location.
 *
 * @param {{ behind?: number, unintegrated?: boolean, active?: boolean }} state
 * @param {{ maxBehind?: number }} [options] `0` disables the check
 * @returns {{ action: 'keep' | 'release' | 'notify_carry', reason: string }}
 */
export function decideWorktreeFreshness(state = {}, options = {}) {
  const raw = Number(options.maxBehind);
  const max = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_WORKTREE_MAX_BEHIND;
  const behind = Number.isFinite(Number(state.behind)) ? Number(state.behind) : 0;
  if (max === 0 || behind <= max) return { action: 'keep', reason: 'fresh' };
  if (state.active === true) return { action: 'keep', reason: 'agent_active' };
  return state.unintegrated === true
    ? { action: 'notify_carry', reason: 'stale_with_work' }
    : { action: 'release', reason: 'stale_clean' };
}

/**
 * Build the "agent running in this worktree" check from a chat liveness probe,
 * mirroring the release/cleanup routes: a worktree is busy while any chat linked
 * to its record has a live run, and an unknown probe result counts as busy.
 * `excludeChatId` is the chat starting this execution (it is not a competitor).
 *
 * @param {((arg: { chatId: string }) => any) | null | undefined} probe
 * @param {string} [excludeChatId]
 * @returns {(record: Record<string, any>) => boolean}
 */
export function buildWorktreeActiveAgentCheck(probe, excludeChatId = '') {
  const chatBusy = (chatId) => {
    if (typeof probe !== 'function' || !chatId) return true;
    try {
      const result = probe({ chatId });
      if (result?.known === true) return result.busy !== false;
      return !['chat_missing', 'state_missing', 'adapter_missing'].includes(result?.reason);
    } catch {
      return true;
    }
  };
  return (record) => (Array.isArray(record?.chats) ? record.chats : [])
    .filter((id) => id && id !== excludeChatId)
    .some(chatBusy);
}

/**
 * Assess one live worktree record and apply the decision: release a stale clean
 * one, or save a carry patch for a stale one with work. Returns the decision
 * plus what was done; the caller emits the "integrate or move" notification.
 *
 * @param {Record<string, any>} record
 * @param {{ maxBehind?: number, hasActiveAgent?: (record: object) => boolean, registryOptions?: { dataDir?: string }, deps?: Record<string, any> }} [options]
 * @returns {Promise<{ action: string, reason: string, behind: number, released?: boolean, patchPath?: string | null }>}
 */
export async function applyWorktreeFreshness(record, options = {}) {
  const readFacts = options.deps?.readFacts || readWorktreeFreshnessFacts;
  const facts = await readFacts(record);
  // Fail closed: without a real liveness check the worktree is treated as in use.
  const hasActiveAgent = typeof options.hasActiveAgent === 'function' ? options.hasActiveAgent : () => true;
  let active;
  try {
    active = hasActiveAgent(record) !== false;
  } catch {
    active = true;
  }
  const decision = decideWorktreeFreshness({ ...facts, active }, options);
  const base = { ...decision, behind: facts.behind };
  if (decision.action === 'release') {
    const release = options.deps?.release || releaseWorktree;
    const out = release({ todoId: record.todoId, registryOptions: options.registryOptions, hasActiveAgent });
    return { ...base, released: out.released === true };
  }
  if (decision.action === 'notify_carry') {
    const save = options.deps?.saveCarry || saveWorktreeCarryPatch;
    let patchPath = null;
    try {
      patchPath = await save(record, options.registryOptions);
    } catch {
      // Best-effort: the notification still fires without a patch.
    }
    return { ...base, patchPath };
  }
  return base;
}

const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
const PREPARE_OUTPUT_LIMIT = 4000;

/**
 * Per-key serialization of worktree preparation. The registry lock already
 * covers the durable write, but creation + prepare command can take minutes;
 * serializing in-process prevents two starts for the same tree from racing a
 * `git worktree add` and a long prepare step. Single-process only — the
 * multi-instance contract stays the registry lock.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const prepareLocks = new Map();

/**
 * Run `fn` after every previously queued task for `key` settles. Exported so
 * the manual route and the watcher cycle share the same gate without changing
 * the key each of them uses.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withWorktreePrepareLock(key, fn) {
  const lockKey = String(key ?? '').trim() || 'default';
  const previous = prepareLocks.get(lockKey) || Promise.resolve();
  const next = previous.then(() => fn(), () => fn());
  // Keep the chain alive but never reject the stored tail (a failure belongs to
  // the caller's promise only).
  prepareLocks.set(lockKey, next.then(() => undefined, () => undefined));
  return next;
}

/** Test-only seam: drop every queued lock so suites stay isolated. */
export function clearWorktreePrepareLocks() {
  prepareLocks.clear();
}

/**
 * Resolve the leaf's requested mode against the watcher policy default.
 *
 * @param {{ todo?: Record<string, any> | null, policy?: Record<string, any> | null }} [input]
 * @returns {{ mode: 'worktree' | 'project', source: 'leaf' | 'policy' }}
 */
export function resolveWorkspaceWatcherExecutionMode(input = {}) {
  return resolveWorktreeMode({
    leafMode: input.todo?.executionMode,
    policyDefault: input.policy?.executionMode,
  });
}

/**
 * The worktree layout block from the watcher policy, or null when absent.
 *
 * @param {Record<string, any> | null | undefined} policy
 * @returns {Record<string, any> | null}
 */
export function readWorkspaceWatcherWorktreeLayout(policy) {
  const raw = policy?.worktree;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/**
 * @param {unknown} dataDir
 * @returns {{ dataDir?: string }}
 */
export function worktreeRegistryOptions(dataDir) {
  const dir = String(dataDir ?? '').trim();
  return dir ? { dataDir: dir } : {};
}

/**
 * Complete an incomplete worktree layout from the workspace-derived suggestion
 * and persist it, so the start runs instead of dead-ending on a settings form
 * that is scoped to a different workspace. A stored value always wins; a
 * workspace without a Git repository keeps its policy and still fails closed.
 *
 * The write is best-effort: the derived layout is returned either way, so a
 * persistence failure never turns a usable layout into a refused start.
 *
 * @param {{ policy?: Record<string, any> | null, workspaceFolder?: string, dataDir?: string }} input
 * @returns {Record<string, any> | null | undefined} the effective policy (unchanged when nothing was derived)
 */
export function ensureWorktreeLayoutForStart(input = {}) {
  const { policy, changed } = backfillWorktreeLayout(input.policy, input.workspaceFolder);
  if (!changed) return input.policy;
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  try {
    const layout = {};
    for (const key of ['root', 'namespace', 'branchPrefix', 'directoryPrefix']) layout[key] = policy.worktree?.[key];
    saveExecutionSettings(workspaceFolder, { worktree: layout }, worktreeRegistryOptions(input.dataDir));
  } catch {
    // Best-effort persistence; the derived layout is still used for this start.
  }
  return policy;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function prepareTimeout(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : PREPARE_TIMEOUT_MS;
}

/**
 * Check npm ci lockfile compatibility in the source folder before creating a
 * worktree. The dry run does not install or modify dependencies.
 * @param {{ command: unknown, cwd: string, execFileFn?: Function }} input
 * @returns {Promise<void>}
 */
export function preflightWorktreePrepare(input) {
  const command = Array.isArray(input.command) ? input.command.map((part) => String(part)) : [];
  if (!['npm', 'npm.cmd'].includes(command[0]) || command[1] !== 'ci') return Promise.resolve();
  const args = [...command.slice(2), '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'];
  const run = typeof input.execFileFn === 'function' ? input.execFileFn : execFile;
  return new Promise((resolve, reject) => {
    run(command[0], ['ci', ...args], {
      cwd: input.cwd,
      timeout: PREPARE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (!error) return resolve();
      const out = String(stdout || '').slice(-PREPARE_OUTPUT_LIMIT);
      const err = String(stderr || '').slice(-PREPARE_OUTPUT_LIMIT);
      reject(new WorktreeError(
        WORKTREE_ERROR_CODES.PREPARE_FAILED,
        `Worktree dependency preflight failed: ${error.code || error.message}${err ? ` — ${err.trim()}` : ''}`,
        {
          cause: error,
          details: {
            stage: 'preflight',
            command: [command[0], 'ci', ...args],
            cwd: input.cwd,
            exitCode: error.code || error.message,
            signal: error.signal || '',
            stdout: out,
            stderr: err,
          },
        },
      ));
    });
  });
}

/**
 * Run one declared argv prepare action in the execution folder. A string
 * command is refused: only an explicit argv array is executed, so a
 * shell-quoted value can never be reinterpreted.
 *
 * @param {{ command: unknown, cwd: string, timeoutMs?: number, execFileFn?: Function }} input
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runWorktreePrepareCommand(input) {
  const command = Array.isArray(input.command) ? input.command.map((part) => String(part)) : [];
  if (command.length === 0 || !command[0]) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      'worktree.prepareCommand must be a non-empty argv array (OPEN configuration; nothing was run).',
    );
  }
  const run = typeof input.execFileFn === 'function' ? input.execFileFn : execFile;
  const timeout = prepareTimeout(input.timeoutMs);
  return new Promise((resolve, reject) => {
    run(command[0], command.slice(1), {
      cwd: input.cwd,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      const out = String(stdout || '').slice(-PREPARE_OUTPUT_LIMIT);
      const err = String(stderr || '').slice(-PREPARE_OUTPUT_LIMIT);
      if (error) {
        reject(new WorktreeError(
          WORKTREE_ERROR_CODES.PREPARE_FAILED,
          `Worktree prepare failed (${command[0]}): ${error.code || error.message}${err ? ` — ${err.trim()}` : ''}`,
          {
            cause: error,
            details: {
              command,
              cwd: input.cwd,
              exitCode: error.code || error.message,
              signal: error.signal || '',
              stdout: out,
              stderr: err,
            },
          },
        ));
        return;
      }
      resolve({ code: 0, stdout: out, stderr: err });
    });
  });
}

/**
 * Explicit, idempotent prepare step between worktree creation and the first
 * agent run (§7.1). It never copies secrets or the main `data/` directory; the
 * declared action runs in the worktree and fails the start on a non-zero exit.
 *
 * @param {{ record: Record<string, any>, config: Record<string, any>, deps?: Record<string, any> }} input
 * @returns {Promise<{ ran: boolean, command: string[] }>}
 */
export async function runWorktreePrepare(input) {
  const raw = input?.config?.prepareCommand;
  if (typeof raw === 'string' && raw.trim()) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      'worktree.prepareCommand must be an argv array; a shell string is refused so it is never reinterpreted (nothing was run).',
    );
  }
  const command = Array.isArray(raw) ? raw : [];
  if (command.length === 0) return { ran: false, command: [] };
  const run = typeof input?.deps?.runPrepareCommand === 'function'
    ? input.deps.runPrepareCommand
    : runWorktreePrepareCommand;
  await run({
    command,
    cwd: input.record.worktreePath,
    timeoutMs: input?.deps?.prepareTimeoutMs,
    execFileFn: input?.deps?.execFileFn,
  });
  return { ran: true, command: command.map((part) => String(part)) };
}

/**
 * D1 guard: one tree must not own two live worktrees under different ids.
 *
 * The registry is keyed by todo id. A manual start keys by the ROOT; the
 * Watcher keys by the claimed LEAF. The two keyings are unsupported together,
 * so a start refuses with a 409 (`REGISTRY_CONFLICT`) when any other todo on
 * the same direct line already has a live record. Siblings are not on the line,
 * so two sibling leaves may still run in parallel (the pre-existing Watcher
 * behaviour).
 *
 * @param {{ todoId: string, registryOptions: Record<string, any>, lineageTodoIds?: unknown }} input
 * @returns {void}
 */
function refuseWorktreeMixing(input) {
  const ids = Array.isArray(input.lineageTodoIds)
    ? [...new Set(input.lineageTodoIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
    : [];
  const lineage = ids.filter((id) => id !== input.todoId);
  if (lineage.length === 0) return;
  let registry;
  try {
    registry = readWorktreeRegistry(input.registryOptions);
  } catch (error) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
      `Could not read the worktree registry while checking for mixing: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const conflictId = lineage.find((id) => {
    const record = registry.items?.[id];
    return isWorktreeRecordLive(record);
  });
  if (!conflictId) return;
  throw new WorktreeError(
    WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
    `Worktree mixing is not supported: todo ${conflictId} on the same tree already has a live worktree (manual starts key by the tree root, the Watcher keys by the leaf). Finish or clean up that worktree first.`,
    { details: { conflictTodoId: conflictId } },
  );
}

/**
 * Freeze and prepare the execution folder for one claimed leaf. Serialized per
 * `lockKey` (defaults to `todoId`) so a long prepare cannot race a second start
 * for the same tree.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   todo?: Record<string, any> | null,
 *   policy?: Record<string, any> | null,
 *   dataDir?: string,
 *   cycleId?: string,
 *   chatId?: string,
 *   hasActiveAgent?: Function,
 *   planOnly?: boolean,
 *   lockKey?: string,
 *   lineageTodoIds?: string[],
 *   allowSuggestedLayout?: boolean,
 *   reuseActivePrepare?: boolean,
 *   parallelTreeTodoId?: string,
 *   parallelTreeTodo?: Record<string, any> | null,
 *   deps?: Record<string, any>,
 * }} input
 * @returns {Promise<{ mode: 'worktree' | 'project', executionFolder: string, record: Record<string, any> | null, resolution: Record<string, any>, created?: boolean, reused?: boolean, recovered?: boolean, frozen?: boolean }>}
 */
export function prepareWorkspaceWatcherExecution(input = {}) {
  const lockKey = String(input.lockKey ?? input.todoId ?? '').trim() || 'default';
  return withWorktreePrepareLock(lockKey, () => prepareWorkspaceWatcherExecutionInner(input));
}

/**
 * @param {Record<string, any>} input
 * @returns {Promise<{ mode: 'worktree' | 'project', executionFolder: string, record: Record<string, any> | null, resolution: Record<string, any>, created?: boolean, reused?: boolean, recovered?: boolean, frozen?: boolean }>}
 */
async function prepareWorkspaceWatcherExecutionInner(input = {}) {
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const todoId = String(input.todoId ?? '').trim();
  const registryOptions = worktreeRegistryOptions(input.dataDir);
  // Execution settings live in their own store; overlay them on the legacy
  // watcher policy so the Watcher cycle and the manual start read one source.
  input = { ...input, policy: applyExecutionSettingsToPolicy(input.policy, workspaceFolder, input.dataDir) };
  const resolution = resolveWorkspaceWatcherExecutionMode(input);
  // A plan-only cycle never executes leaf work, so it must not create an empty
  // worktree directory (leaf scope + OPEN O7). It keeps the logical workspace.
  if (input.planOnly === true) {
    return {
      mode: 'project',
      executionFolder: workspaceFolder,
      record: null,
      resolution,
      frozen: false,
    };
  }
  // A worktree that already exists is frozen: a settings or override change
  // must not move an in-flight or retried leaf to another directory (S4). The
  // manager re-verifies the record against Git and refuses a missing/foreign
  // one instead of recreating or adopting it (S9/O4).
  let existing = getWorktreeRecord(todoId, registryOptions);
  let existingLive = isWorktreeRecordLive(existing);
  // A worktree far behind HEAD is released (clean) or flagged for carry (work).
  if (existingLive && existing.creationState === 'ready' && input.skipFreshness !== true) {
    try {
      const fresh = await applyWorktreeFreshness(existing, {
        maxBehind: input.policy?.worktree?.maxBehindCommits,
        // Callers without a liveness check skip nothing: the missing check
        // reads as "agent active" and the worktree is kept.
        hasActiveAgent: typeof input.hasActiveAgent === 'function' ? input.hasActiveAgent : undefined,
        registryOptions,
        deps: input.deps?.freshness,
      });
      if (fresh.action === 'release' && fresh.released) {
        logDelegationEvent('workspace-watcher-worktree-stale-released', {}, { todoId, behind: fresh.behind });
        existing = getWorktreeRecord(todoId, registryOptions);
        existingLive = isWorktreeRecordLive(existing);
      } else if (fresh.action === 'notify_carry') {
        logDelegationEvent('workspace-watcher-worktree-stale-integrate-or-move', {}, { todoId, behind: fresh.behind, patchPath: fresh.patchPath || null });
      }
    } catch {
      // Freshness is advisory; never block a start on it.
    }
  }
  // Parallel-leaf mode: the leaf owns a worktree branched from the live TREE
  // worktree. Anything else keeps the shared-tree behaviour below.
  const parallelTreeId = String(input.parallelTreeTodoId ?? '').trim();
  const parallelTreeRecord = parallelTreeId && parallelTreeId !== todoId
    && isParallelLeafWorktreeEnabled({ tree: input.parallelTreeTodo, policy: input.policy })
    ? getWorktreeRecord(parallelTreeId, registryOptions)
    : null;
  const parallelLeaf = Boolean(parallelTreeRecord
    && isWorktreeRecordLive(parallelTreeRecord)
    && parallelTreeRecord.creationState === 'ready');
  if (!existingLive && resolution.mode === 'project' && !parallelLeaf) {
    return {
      mode: 'project',
      executionFolder: workspaceFolder,
      record: null,
      resolution,
      frozen: false,
    };
  }
  // Mixing check only matters when this start actually involves a worktree.
  refuseWorktreeMixing({ todoId, registryOptions, lineageTodoIds: input.lineageTodoIds });
  // A tree that is already prepared and running only needs its frozen folder.
  // Re-running the prepare command here would block the caller for the whole
  // install and rewrite dependencies under chats that still run in the
  // worktree, so an opted-in restart (a new orchestrator chat for the same
  // tree) verifies the record against Git and returns.
  if (input.reuseActivePrepare === true
    && existingLive
    && existing.creationState === 'ready'
    && existing.executionState === 'active') {
    const record = verifyFrozenWorktreeRecord(existing);
    return {
      mode: 'worktree',
      executionFolder: record.worktreePath,
      record,
      resolution,
      frozen: true,
      created: false,
      reused: true,
      recovered: false,
    };
  }
  // Self-heal an incomplete layout so a worktree-mode start is not dead-ended on
  // a settings form scoped to another workspace. Only an explicit production
  // start opts in (`allowSuggestedLayout`); the low-level default and the frozen
  // reuse path stay fail-closed.
  let effectivePolicy = input.policy;
  if (!existingLive
    && input.allowSuggestedLayout === true
    && !isWorktreeLayoutComplete(readWorkspaceWatcherWorktreeLayout(effectivePolicy))) {
    effectivePolicy = ensureWorktreeLayoutForStart({
      policy: effectivePolicy,
      workspaceFolder,
      dataDir: input.dataDir,
    });
  }
  const config = readWorkspaceWatcherWorktreeLayout(effectivePolicy);
  let record;
  /** @type {{ created?: boolean, reused?: boolean, recovered?: boolean, createMs?: number, syncedWithTree?: { clean: boolean, conflicts: string[] } }} */
  let outcome = {};
  if (existingLive && !config) {
    // Frozen reuse does not depend on the current layout configuration.
    record = verifyFrozenWorktreeRecord(existing);
  } else {
    if (!config) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.CONFIG_INVALID,
        'Watcher policy has no worktree layout; configure policy.worktree before worktree mode can start (OPEN O3).',
      );
    }
    // Disk guard: only a brand-new worktree grows the disk; a live record is reused as is.
    if (!existingLive) {
      const guard = typeof input?.deps?.assertDiskSpace === 'function' ? input.deps.assertDiskSpace : assertWorktreeDiskSpace;
      guard({ root: config.root, config, statfs: input?.deps?.statfs });
    }
    await preflightWorktreePrepare({
      command: config.prepareCommand,
      cwd: workspaceFolder,
      execFileFn: input?.deps?.execFileFn,
    });
    const ensure = typeof input?.deps?.ensureWorktree === 'function' ? input.deps.ensureWorktree : ensureWorktreeAsync;
    if (parallelLeaf && !existingLive) {
      const leaf = await ensureLeafWorktree({ leafTodoId: todoId, treeRecord: parallelTreeRecord, config, registryOptions, ensure });
      record = leaf.record;
      outcome = { created: leaf.created, reused: !leaf.created, recovered: false, createMs: leaf.createMs };
      logDelegationEvent('workspace-watcher-leaf-worktree-created', {}, { todoId, treeTodoId: parallelTreeId, createMs: leaf.createMs });
    } else {
      const result = await ensure({ todoId, workspaceFolder, mode: 'worktree', config, registryOptions, dirtyPolicy: input.dirtyPolicy ?? config.dirtyPolicy ?? 'block' });
      record = result.record;
      outcome = { created: result.created, reused: result.reused, recovered: result.recovered };
      // Fix round after a conflicting merge: bring the current tree branch in.
      if (parallelLeaf && record.lastError?.code === TREE_MERGE_CONFLICT_CODE) {
        const synced = await syncLeafWithTree({ leafRecord: record, treeRecord: parallelTreeRecord });
        mutateWorktreeRegistry((doc) => {
          if (!doc.items[todoId]) return { result: null, changed: false };
          doc.items[todoId].lastError = null;
          return { result: null };
        }, registryOptions);
        outcome.syncedWithTree = synced;
      }
    }
  }
  const prepared = await materializeWorktree(
    record,
    effectivePolicy === input.policy ? input : { ...input, policy: effectivePolicy },
    registryOptions,
  );
  return {
    ...prepared,
    resolution,
    frozen: existingLive,
    ...outcome,
  };
}

/**
 * Re-verify a frozen record against Git without needing the layout config.
 *
 * @param {Record<string, any>} record
 * @returns {Record<string, any>}
 */
function verifyFrozenWorktreeRecord(record) {
  if (record.creationState !== 'ready') {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      `Worktree for ${record.todoId} is still a creation reservation and no layout is configured; resume requires policy.worktree.`,
    );
  }
  const verification = verifyWorktreeRecord(record);
  if (verification.ok) return record;
  const code = verification.status === 'missing'
    ? WORKTREE_ERROR_CODES.MISSING
    : verification.status === 'owner_mismatch'
      ? WORKTREE_ERROR_CODES.OWNER_MISMATCH
      : verification.status === 'external_change'
        ? WORKTREE_ERROR_CODES.EXTERNAL_CHANGE
        : WORKTREE_ERROR_CODES.FOREIGN;
  throw new WorktreeError(code, verification.message, { details: { todoId: record.todoId, status: verification.status } });
}

/**
 * Mark a record `preparing`, run prepare, then `active`. On failure the record
 * falls back to `none`; the worktree itself is preserved for inspection.
 *
 * @param {Record<string, any>} record
 * @param {Record<string, any>} input
 * @param {{ dataDir?: string }} registryOptions
 * @returns {Promise<{ mode: 'worktree', executionFolder: string, record: Record<string, any> }>}
 */
async function materializeWorktree(record, input, registryOptions) {
  const updateState = typeof input?.deps?.updateWorktreeState === 'function'
    ? input.deps.updateWorktreeState
    : updateWorktreeState;
  updateState({
    todoId: record.todoId,
    registryOptions,
    executionState: 'preparing',
    cycleId: input.cycleId,
    chatId: input.chatId,
  });
  try {
    const layout = input.policy?.worktree || {};
    const shared = isSharedDepsEnabled(layout) && layout.root;
    // A store hit replaces the prepare command (usually `npm ci`); a miss runs
    // it and publishes the result for the next worktree with the same lock.
    const hit = shared
      ? await provisionSharedDeps({ worktreePath: record.worktreePath, config: layout, deps: input.deps })
      : { provisioned: false, reason: '' };
    // A reused worktree whose node_modules already matches its lockfile keeps
    // it: rerunning `npm ci` would replace the hardlinked tree with a full copy.
    const upToDate = shared && hit.reason === 'already_present' && hasCurrentInstalledDeps(record.worktreePath);
    if (!hit.provisioned && !upToDate) {
      await runWorktreePrepare({ record, config: layout, deps: input.deps || {} });
      if (shared) {
        writeInstalledDepsHash(record.worktreePath, hashLockfile(path.join(record.worktreePath, 'package-lock.json')));
        if (hit.reason !== 'already_present') {
          await publishSharedDeps({ worktreePath: record.worktreePath, config: layout, deps: input.deps });
        }
      }
    }
  } catch (error) {
    updateState({ todoId: record.todoId, registryOptions, executionState: 'none' });
    throw error;
  }
  const active = updateState({
    todoId: record.todoId,
    registryOptions,
    executionState: 'active',
    cycleId: input.cycleId,
    chatId: input.chatId,
  });
  return { mode: 'worktree', executionFolder: active.worktreePath, record: active };
}

/**
 * Readable one-line reason for a failed worktree preparation.
 *
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
export function describeWorktreePreparationError(error) {
  if (error instanceof WorktreeError) {
    return { code: error.code, message: error.message };
  }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
  return {
    code: code || 'WORKTREE_PREPARE_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}
