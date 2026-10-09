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

import { execFile } from 'node:child_process';
import { resolveWorktreeMode } from './worktree/worktree-mode.js';
import { getWorktreeRecord, readWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { upsertWorkspaceWatcher } from './persist/workspace-watchers-persist.js';
import { ensureWorktree, updateWorktreeState, verifyWorktreeRecord } from './worktree-manager.js';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree/worktree-errors.js';
import { backfillWorktreeLayout, isWorktreeLayoutComplete } from './execution-settings-suggest.js';
import { broadcastWorkspaceWatcherChanged } from './workspace-watcher-live.js';

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
 * @param {{ todo?: object | null, policy?: object | null }} [input]
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
 * @param {object | null | undefined} policy
 * @returns {object | null}
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
 * @param {{ policy?: object | null, workspaceFolder?: string, dataDir?: string }} input
 * @returns {object | null | undefined} the effective policy (unchanged when nothing was derived)
 */
export function ensureWorktreeLayoutForStart(input = {}) {
  const { policy, changed } = backfillWorktreeLayout(input.policy, input.workspaceFolder);
  if (!changed) return input.policy;
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  try {
    const row = upsertWorkspaceWatcher(workspaceFolder, { policy }, worktreeRegistryOptions(input.dataDir));
    broadcastWorkspaceWatcherChanged({ workspaceFolder });
    return row?.policy && typeof row.policy === 'object' ? row.policy : policy;
  } catch {
    return policy;
  }
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
          { cause: error, details: { command: command[0], stdout: out, stderr: err } },
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
 * @param {{ record: object, config: object, deps?: object }} input
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
 * @param {{ todoId: string, registryOptions: object, lineageTodoIds?: unknown }} input
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
    return Boolean(record && !record.cleanedAt);
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
 *   todo?: object | null,
 *   policy?: object | null,
 *   dataDir?: string,
 *   cycleId?: string,
 *   chatId?: string,
 *   planOnly?: boolean,
 *   lockKey?: string,
 *   lineageTodoIds?: string[],
 *   allowSuggestedLayout?: boolean,
 *   deps?: object,
 * }} input
 * @returns {Promise<{ mode: 'worktree' | 'project', executionFolder: string, record: object | null, resolution: object, created?: boolean, reused?: boolean, recovered?: boolean, frozen?: boolean }>}
 */
export function prepareWorkspaceWatcherExecution(input = {}) {
  const lockKey = String(input.lockKey ?? input.todoId ?? '').trim() || 'default';
  return withWorktreePrepareLock(lockKey, () => prepareWorkspaceWatcherExecutionInner(input));
}

/**
 * @param {object} input
 * @returns {Promise<{ mode: 'worktree' | 'project', executionFolder: string, record: object | null, resolution: object, created?: boolean, reused?: boolean, recovered?: boolean, frozen?: boolean }>}
 */
async function prepareWorkspaceWatcherExecutionInner(input = {}) {
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const todoId = String(input.todoId ?? '').trim();
  const registryOptions = worktreeRegistryOptions(input.dataDir);
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
  const existing = getWorktreeRecord(todoId, registryOptions);
  const existingLive = Boolean(existing && !existing.cleanedAt);
  if (!existingLive && resolution.mode === 'project') {
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
  /** @type {{ created?: boolean, reused?: boolean, recovered?: boolean }} */
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
    const ensure = typeof input?.deps?.ensureWorktree === 'function' ? input.deps.ensureWorktree : ensureWorktree;
    const result = ensure({ todoId, workspaceFolder, mode: 'worktree', config, registryOptions, dirtyPolicy: input.dirtyPolicy || 'block' });
    record = result.record;
    outcome = { created: result.created, reused: result.reused, recovered: result.recovered };
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
 * @param {object} record
 * @returns {object}
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
 * @param {object} record
 * @param {object} input
 * @param {{ dataDir?: string }} registryOptions
 * @returns {Promise<{ mode: 'worktree', executionFolder: string, record: object }>}
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
    await runWorktreePrepare({ record, config: input.policy?.worktree || {}, deps: input.deps || {} });
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
