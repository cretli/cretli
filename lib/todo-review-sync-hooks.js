/**
 * Runtime write path for the server-owned `todo.review` snapshot
 * (`docs/todo-review-contract.md` §2.4, §4.2, §10.4-§10.5, U5).
 *
 * The pure computation lives in `lib/todo-review-sync.js`; this module is the
 * only place that turns a durable delegation event into a persisted snapshot:
 *
 * - it resolves the affected leaf in the LOGICAL workspace (`workspaceFolder`,
 *   never `executionFolder`) from a full id, a unique prefix, or an inherited
 *   `parent.todoId`;
 * - it recomputes the snapshot from `listDelegationsForWorkspace` and writes it
 *   through the dedicated `writeTodoReview` (lock + generation + decisionKey);
 * - a job without a resolved leaf writes nothing, an unknown/ambiguous prefix
 *   logs and writes nothing, and a deleted todo is a silent no-op;
 * - every failure is caught and re-armed in an in-process retry queue, so a
 *   failed sync is retried later instead of breaking the delegation transition
 *   or being lost;
 * - `repairTodoReviewSnapshotsOnBoot` reconciles every workspace leaf that has
 *   review-relevant delegations (or a stored snapshot) after a restart, so the
 *   durable snapshots match the delegation records again.
 *
 * The sync never scans git: the diagnostic `material.revision` stays empty here
 * and is only filled by callers that already hold a revision. It also never runs
 * on outbox/history/diagnostic writes — only the explicit lifecycle hooks in
 * `lib/delegation-service.js` call it.
 */

import { delegationController } from './delegation-control.js';
import { loadChats } from './persist/chats-persist.js';
import { listDelegationsForWorkspace, loadDelegationsReadonly } from './persist/delegations-persist.js';
import { closeTodoLeafIfEligible, getTodo, listTodos as loadTodosData, writeTodoReview, writeTodoReviewBatch } from './persist/todos-store.js';
import { readDelegationWorkflowLeafIdFromRow } from './delegation-workflow-leaf.js';
import { normalizeTodoRefId } from './todo-ref.js';
import {
  computeTodoReviewSnapshotForTodo,
  evaluateTodoLeafAutoClose,
  resolveLiveCodeReviewerPolicy,
  isTodoLeafAutoCloseEnabled,
} from './todo-review-sync.js';
import { buildLiveWorktreePredicate } from './todo-worktree-manual.js';
import { emitTodoReviewChanged } from './todo-review-live.js';
import { resolveDataPath } from './runtime-paths.js';
import { logDelegationEvent } from './delegation-log.js';
import { getWorkspaceWatcher } from './persist/workspace-watchers-persist.js';
import { resolveReviewGateMode } from './workspace-watcher-review-gate.js';
import { clearReviewGateMarker } from './workspace-watcher-review-gate-guard.js';

/** Minimum prefix length accepted by the todo id contract (`lib/todo-ref.js`). */
const TODO_ID_PREFIX_MIN_LENGTH = 8;
/** A candidate at/above this length is treated as a full uuid, not a prefix. */
const FULL_TODO_ID_LENGTH = 36;

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeWorkspaceFolder(value) {
  return readString(value);
}

/**
 * Match one normalized leaf candidate against the workspace's todo ids.
 *
 * @param {Array<{ id?: unknown }>} items
 * @param {string} candidate normalized candidate (lower case)
 * @returns {{ todoId: string, matched: boolean, ambiguous: boolean }}
 */
function matchLeafCandidate(items, candidate) {
  if (!candidate) return { todoId: '', matched: false, ambiguous: false };
  const list = Array.isArray(items) ? items : [];
  const exact = list.find((item) => readString(item?.id).toLowerCase() === candidate);
  if (exact) return { todoId: readString(exact.id), matched: true, ambiguous: false };
  if (candidate.length < TODO_ID_PREFIX_MIN_LENGTH) return { todoId: '', matched: false, ambiguous: false };
  const matches = list.filter((item) => readString(item?.id).toLowerCase().startsWith(candidate));
  if (matches.length === 1) return { todoId: readString(matches[0].id), matched: true, ambiguous: false };
  return { todoId: '', matched: false, ambiguous: matches.length > 1 };
}

/**
 * Resolve the leaf a delegation row affects, inside its logical workspace.
 *
 * Resolution order (`docs/todo-review-contract.md` §2.4):
 *   1. the row's own `leafId`/`todoId` (full id or unique prefix);
 *   2. otherwise the parent chat's `todoId`;
 *   3. a prefix never resolves by chat and never escapes the workspace.
 *
 * @param {{
 *   row?: any,
 *   workspaceFolder?: string,
 *   parentTodoId?: string,
 *   dataDir?: string,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   reason: 'resolved'|'no_workspace'|'no_leaf'|'deleted'|'not_found'|'ambiguous'|'read_error',
 *   todoId: string,
 *   workspaceFolder: string,
 *   items?: Array<{ id?: unknown }>,
 * }>}
 */
export async function resolveTodoReviewLeafTarget(input = {}) {
  const row = input.row && typeof input.row === 'object' ? input.row : {};
  const workspaceFolder = normalizeWorkspaceFolder(input.workspaceFolder || row.workspaceFolder);
  if (!workspaceFolder) {
    return { ok: false, reason: 'no_workspace', todoId: '', workspaceFolder: '' };
  }
  let parentTodoId = readString(input.parentTodoId);
  // Hot path: a row that already names its leaf never needs the chat store.
  if (!readDelegationWorkflowLeafIdFromRow(row) && !parentTodoId && readString(delegationController(row))) {
    try {
      const parent = /** @type {any} */ (loadChats().find((chat) => readString(chat?.id) === readString(delegationController(row))));
      parentTodoId = readString(parent?.todoId);
    } catch {
      parentTodoId = '';
    }
  }
  const candidate = readDelegationWorkflowLeafIdFromRow(row) || normalizeTodoRefId(parentTodoId);
  if (!candidate) {
    return { ok: false, reason: 'no_leaf', todoId: '', workspaceFolder };
  }
  const dataDir = readString(input.dataDir) || resolveDataPath();
  let items;
  try {
    items = (await loadTodosData(dataDir, workspaceFolder)).items;
  } catch {
    return { ok: false, reason: 'read_error', todoId: '', workspaceFolder };
  }
  const list = Array.isArray(items) ? items : [];
  const { todoId, matched, ambiguous } = matchLeafCandidate(list, candidate);
  if (matched) return { ok: true, reason: 'resolved', todoId, workspaceFolder, items: list };
  // A full recorded id that no longer exists is a deleted todo: silent no-op.
  if (candidate.length >= FULL_TODO_ID_LENGTH) {
    return { ok: false, reason: 'deleted', todoId: '', workspaceFolder };
  }
  return { ok: false, reason: ambiguous ? 'ambiguous' : 'not_found', todoId: '', workspaceFolder };
}

/**
 * @typedef {{ workspaceFolder: string, todoId: string, dataDir: string }} TodoReviewSyncTarget
 */

/**
 * @typedef {{
 *   key: string,
 *   target?: TodoReviewSyncTarget,
 *   row?: any,
 *   options?: { dataDir?: string, workspaceFolder?: string, parentTodoId?: string },
 * }} PendingRetry
 */

/** Retry cap per target; after it the sync is given up until the next event. */
const MAX_RETRY_ATTEMPTS = 8;
/** Upper bound of the exponential backoff delay. */
const MAX_RETRY_DELAY_MS = 60000;

/** @type {Map<string, PendingRetry>} */
const pendingRetries = new Map();
/** Consecutive failed attempts per retry key; survives a flush. */
/** @type {Map<string, number>} */
const retryAttempts = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let retryTimer = null;
let retryDelayMs = 1000;

/**
 * Override the in-process retry base delay (tests) or a deployment knob. A
 * negative or non-finite value is ignored.
 *
 * @param {number} ms
 * @returns {void}
 */
export function setTodoReviewSyncRetryDelay(ms) {
  const value = Number(ms);
  if (Number.isFinite(value) && value >= 0) retryDelayMs = Math.floor(value);
}

/**
 * @param {TodoReviewSyncTarget} target
 * @returns {string}
 */
function retryKey(target) {
  return `${target.workspaceFolder}\u0000${target.todoId}\u0000${target.dataDir}`;
}

/**
 * Queue a retry with bounded exponential backoff (base delay doubling, capped
 * at one minute, at most `MAX_RETRY_ATTEMPTS` tries). Entries are keyed, so a
 * burst of failures coalesces into one retry. The timer is unref'd so it never
 * keeps the process alive on its own.
 *
 * @param {PendingRetry} entry
 * @returns {boolean} false when the retry budget is exhausted
 */
function armRetry(entry) {
  const attempts = (retryAttempts.get(entry.key) || 0) + 1;
  if (attempts > MAX_RETRY_ATTEMPTS) {
    retryAttempts.delete(entry.key);
    pendingRetries.delete(entry.key);
    logDelegationEvent('todo-review-sync-retry-exhausted', {}, {
      todoId: entry.target?.todoId || '',
      delegationId: readString(entry.row?.id),
      attempts: MAX_RETRY_ATTEMPTS,
    });
    return false;
  }
  retryAttempts.set(entry.key, attempts);
  pendingRetries.set(entry.key, entry);
  if (retryTimer) return true;
  const delay = Math.min(retryDelayMs * 2 ** (attempts - 1), Math.max(MAX_RETRY_DELAY_MS, retryDelayMs));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushTodoReviewSyncRetries();
  }, delay);
  if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
  return true;
}

/**
 * @param {TodoReviewSyncTarget} target
 * @returns {void}
 */
function scheduleTodoReviewSyncRetry(target) {
  armRetry({ key: retryKey(target), target });
}

/**
 * Re-arm a delegation-level sync that failed before a leaf could be resolved.
 *
 * @param {Record<string, any>} row
 * @param {{ dataDir?: string, workspaceFolder?: string, parentTodoId?: string }} options
 * @returns {void}
 */
function scheduleDelegationSyncRetry(row, options) {
  const id = readString(row?.id);
  if (!id) return;
  armRetry({
    key: `delegation\u0000${id}\u0000${readString(options.dataDir)}`,
    row,
    options: {
      dataDir: options.dataDir,
      workspaceFolder: options.workspaceFolder,
      parentTodoId: options.parentTodoId,
    },
  });
}

/**
 * Run every queued retry now. A retry that fails again re-arms itself with a
 * longer delay until the attempt cap, so the loop is bounded.
 *
 * @returns {Promise<{ retried: number, ok: number, failed: number }>}
 */
export async function flushTodoReviewSyncRetries() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const entries = [...pendingRetries.values()];
  pendingRetries.clear();
  const summary = { retried: entries.length, ok: 0, failed: 0 };
  for (const entry of entries) {
    const result = entry.target
      ? await syncTodoReviewTarget(entry.target, { source: 'retry' })
      : await syncTodoReviewForDelegation(entry.row, { ...entry.options, source: 'retry' });
    if (result.ok) {
      retryAttempts.delete(entry.key);
      summary.ok += 1;
    } else {
      // A delegation-level retry that resolved a leaf hands ownership to the
      // target-level key (re-armed by the target sync); drop the old counter so
      // it is not orphaned. An unresolved read error keeps its own counter.
      if (!entry.target && result.todoId) retryAttempts.delete(entry.key);
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * Drop every queued retry without running it (tests / shutdown isolation).
 *
 * @returns {number} number of dropped targets
 */
export function clearTodoReviewSyncRetries() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const count = pendingRetries.size;
  pendingRetries.clear();
  retryAttempts.clear();
  return count;
}

/**
 * @returns {number}
 */
export function pendingTodoReviewSyncRetryCount() {
  return pendingRetries.size;
}

/**
 * Flag-gated automatic leaf close. Conditions are re-evaluated from the
 * delegation records under the todo write lock; a failure never breaks the sync.
 *
 * @param {{ dataDir: string, workspaceFolder: string, todoId: string, rows?: Record<string, any>[], deps?: { closeLeaf?: Function } }} input
 * @returns {Promise<{ closed: boolean, reason: string }>}
 */
export async function closeTodoLeafAfterReview(input) {
  const closeLeaf = typeof input?.deps?.closeLeaf === 'function'
    ? input.deps.closeLeaf
    : closeTodoLeafIfEligible;
  let registryErrorCode = '';
  try {
    const result = await closeLeaf(input.dataDir, input.workspaceFolder, input.todoId, (/** @type {any} */ { todo, items }) => {
      const rows = Array.isArray(input.rows)
        ? input.rows
        : listDelegationsForWorkspace(input.workspaceFolder, { dataDir: input.dataDir });
      let isLiveWorktree;
      try {
        // Strict: an unreadable registry must refuse, never read as "no worktree".
        isLiveWorktree = buildLiveWorktreePredicate(input.dataDir, { strict: true });
      } catch (error) {
        registryErrorCode = readString(/** @type {any} */ (error)?.code) || 'REGISTRY_UNREADABLE';
        return { eligible: false, reason: 'worktree_registry_unreadable' };
      }
      let requireImplementer = false;
      try {
        requireImplementer = resolveReviewGateMode(
          /** @type {any} */ (getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir }))?.policy,
        ) !== 'off';
      } catch {
        requireImplementer = false;
      }
      const codeReviewerPolicy = resolveLiveCodeReviewerPolicy(input.workspaceFolder, { dataDir: input.dataDir });
      return evaluateTodoLeafAutoClose({ todo, items, rows, isLiveWorktree, requireImplementer, codeReviewerPolicy });
    });
    if (registryErrorCode) {
      logDelegationEvent('todo-leaf-auto-close-failed', {}, {
        todoId: input.todoId,
        code: registryErrorCode,
      });
    }
    // A qualifying PASS ends the review wait (contract §4.1 (1)).
    if (result.closed) clearReviewGateMarker({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder, todoId: input.todoId });
    return { closed: result.closed, reason: result.reason };
  } catch (error) {
    logDelegationEvent('todo-leaf-auto-close-failed', {}, {
      todoId: input.todoId,
      code: readString(/** @type {any} */ (error)?.code) || 'AUTO_CLOSE_ERROR',
    });
    // A throw after the status save must not report a lie: re-read the status.
    try {
      const after = (await loadTodosData(input.dataDir, input.workspaceFolder)).items
        .find((row) => row.id === input.todoId);
      if (after?.status === 'done') return { closed: true, reason: 'error_after_close' };
    } catch { /* fall through */ }
    return { closed: false, reason: 'error' };
  }
}

/**
 * Recompute and persist the snapshot for one already-resolved target.
 *
 * @param {TodoReviewSyncTarget} target
 * @param {{ source?: string, env?: any, deps?: { computeSnapshot?: Function, writeReview?: Function, readTodo?: Function, rows?: any[] } }} [options]
 * @returns {Promise<{ ok: boolean, changed: boolean, reason: string, todoId: string, workspaceFolder: string, generation?: number }>}
 */
export async function syncTodoReviewTarget(target, options = {}) {
  const dataDir = readString(target?.dataDir) || resolveDataPath();
  const todoId = readString(target?.todoId);
  const workspaceFolder = normalizeWorkspaceFolder(target?.workspaceFolder);
  if (!todoId || !workspaceFolder) {
    return { ok: true, changed: false, reason: 'no_target', todoId, workspaceFolder };
  }
  const computeSnapshot = typeof options?.deps?.computeSnapshot === 'function'
    ? options.deps.computeSnapshot
    : computeTodoReviewSnapshotForTodo;
  const writeReview = typeof options?.deps?.writeReview === 'function'
    ? options.deps.writeReview
    : writeTodoReview;
  try {
    const todo = await (options?.deps?.readTodo || getTodo)(dataDir, workspaceFolder, todoId);
    if (!todo) return { ok: true, changed: false, reason: 'deleted', todoId, workspaceFolder };
    const snapshot = await computeSnapshot({
      todo: { ...todo, workspaceFolder },
      dataDir,
    });
    const result = await writeReview(dataDir, workspaceFolder, todoId, snapshot, {
      expectedUpdatedAt: todo.updatedAt,
      expectedGeneration: Number(todo.review?.generation) || 0,
    });
    if (isTodoLeafAutoCloseEnabled(options?.env)) {
      await closeTodoLeafAfterReview({ dataDir, workspaceFolder, todoId, rows: options?.deps?.rows });
    }
    if (result.changed === true) {
      // A real snapshot change: announce identifiers on the existing list
      // channel, debounced. An unchanged write stays silent (U7/§10.4).
      emitTodoReviewChanged({ workspaceFolder, todoId });
    }
    retryAttempts.delete(retryKey({ workspaceFolder, todoId, dataDir }));
    return {
      ok: true,
      changed: result.changed === true,
      reason: result.changed === true ? 'changed' : 'unchanged',
      todoId,
      workspaceFolder,
      generation: result.generation,
    };
  } catch (error) {
    const code = readString(/** @type {any} */ (error)?.code) || 'SYNC_ERROR';
    if (code === 'NOT_FOUND') {
      // The todo was deleted between resolution and the write: silent no-op.
      return { ok: true, changed: false, reason: 'deleted', todoId, workspaceFolder };
    }
    logDelegationEvent('todo-review-sync-failed', {}, {
      todoId,
      workspaceFolder,
      code,
      message: error instanceof Error ? error.message : String(error ?? 'sync_failed'),
    });
    scheduleTodoReviewSyncRetry({ workspaceFolder, todoId, dataDir });
    return { ok: false, changed: false, reason: code, todoId, workspaceFolder };
  }
}

/**
 * Hook entry point: resolve the leaf a delegation row affects and persist its
 * recomputed snapshot. Never throws — a broken sync must not break the
 * delegation transition (`docs/todo-review-contract.md` §10.4).
 *
 * @param {Record<string, any>} row delegation record
 * @param {{ dataDir?: string, workspaceFolder?: string, parentTodoId?: string, source?: string }} [options]
 * @returns {Promise<{ ok: boolean, changed: boolean, reason: string, todoId: string, workspaceFolder: string }>}
 */
export async function syncTodoReviewForDelegation(row, options = {}) {
  try {
    const target = await resolveTodoReviewLeafTarget({
      row,
      dataDir: options.dataDir,
      workspaceFolder: options.workspaceFolder,
      parentTodoId: options.parentTodoId,
    });
    if (!target.ok) {
      // A job with no leaf writes nothing and is not an error. A prefix with no
      // unique match, or an unreadable store, is logged; a deleted todo is not.
      if (target.reason === 'not_found' || target.reason === 'ambiguous' || target.reason === 'read_error') {
        logDelegationEvent('todo-review-sync-skipped', {}, {
          delegationId: readString(row?.id),
          leafId: readString(row?.leafId),
          workspaceFolder: target.workspaceFolder,
          reason: target.reason,
        });
      }
      // A transient read error must not lose the sync until the next event.
      // Report it as a failure so a flush keeps the attempt counter (cap and
      // backoff apply) instead of treating the failed read as success.
      const retryable = target.reason === 'read_error';
      if (retryable) scheduleDelegationSyncRetry(row, options);
      return {
        ok: !retryable,
        changed: false,
        reason: target.reason,
        todoId: '',
        workspaceFolder: target.workspaceFolder,
      };
    }
    return await syncTodoReviewTarget(
      { workspaceFolder: target.workspaceFolder, todoId: target.todoId, dataDir: readString(options.dataDir) || resolveDataPath() },
      { source: options.source },
    );
  } catch (error) {
    logDelegationEvent('todo-review-sync-failed', {}, {
      delegationId: readString(row?.id),
      code: readString(/** @type {any} */ (error)?.code) || 'SYNC_ERROR',
      message: error instanceof Error ? error.message : String(error ?? 'sync_failed'),
    });
    scheduleDelegationSyncRetry(row, options);
    return { ok: false, changed: false, reason: 'SYNC_ERROR', todoId: '', workspaceFolder: '' };
  }
}

/** Log a per-todo repair failure and re-arm the retry queue for it. */
function failRepairTodo(target, error) {
  logDelegationEvent('todo-review-sync-failed', {}, {
    todoId: target.todoId,
    workspaceFolder: target.workspaceFolder,
    code: readString(/** @type {any} */ (error)?.code) || 'SYNC_ERROR',
    message: error instanceof Error ? error.message : String(error ?? 'sync_failed'),
  });
  scheduleTodoReviewSyncRetry(target);
}

/**
 * Boot repair (`docs/todo-review-contract.md` §10.5): recompute the snapshot for
 * every workspace leaf that a delegation references, plus every leaf that
 * already carries a stored snapshot, so a crash between writes is healed and a
 * removed delegation no longer leaves a stale `passed`.
 *
 * The pass is idempotent (`writeTodoReview` skips a decision-identical write),
 * never bumps `item.updatedAt` and never throws: a per-workspace or per-leaf
 * failure is logged, counted and re-armed through the retry queue.
 *
 * @param {{ dataDir?: string, log?: ((line: string) => void) | null }} [options] `log: null` silences the timing lines
 * @returns {Promise<{ ok: boolean, workspaces: number, todos: number, repaired: number, failed: number }>}
 */
export async function repairTodoReviewSnapshotsOnBoot(options = {}) {
  const dataDir = readString(options.dataDir) || resolveDataPath();
  const summary = { ok: true, workspaces: 0, todos: 0, repaired: 0, failed: 0 };
  const startedAt = Date.now();
  let mark = startedAt;
  /** Logs the elapsed time of one stage in the `[boot] phase=` style and restarts the stage clock. */
  const stage = (/** @type {string} */ name) => {
    const now = Date.now();
    const ms = now - mark;
    mark = now;
    if (options.log === null) return;
    const log = typeof options.log === 'function' ? options.log : console.log;
    log(`[boot] phase=todo-review-repair-${name} step=${ms}ms total=${now - startedAt}ms`);
  };
  let rows;
  try {
    // Read-only snapshot: the repair never edits delegation rows, and the frozen
    // snapshot is shared with the readers that run right after boot.
    rows = loadDelegationsReadonly({ dataDir });
  } catch (error) {
    logDelegationEvent('todo-review-repair-failed', {}, {
      code: readString(/** @type {any} */ (error)?.code) || 'DELEGATIONS_READ',
      message: error instanceof Error ? error.message : String(error ?? 'read_failed'),
    });
    summary.ok = false;
    summary.failed += 1;
    return summary;
  }
  stage('delegations-loaded');
  const delegations = Array.isArray(rows) ? rows : [];
  /** @type {Map<string, Record<string, any>[]>} */
  const byWorkspace = new Map();
  for (const row of delegations) {
    const workspaceFolder = normalizeWorkspaceFolder(row?.workspaceFolder);
    if (!workspaceFolder) continue;
    const list = byWorkspace.get(workspaceFolder) || [];
    list.push(row);
    byWorkspace.set(workspaceFolder, list);
  }
  // Fallback for legacy rows without a stored `leafId`: the parent chat carries
  // the inherited todo id. Read once so the per-row loop stays cheap.
  /** @type {any[]} */
  let chats = [];
  try {
    chats = loadChats();
  } catch {
    chats = [];
  }
  const todoIdByChat = new Map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const id = readString(chat?.id);
    const todoId = normalizeTodoRefId(chat?.todoId);
    if (id && todoId) todoIdByChat.set(id, todoId);
  }
  stage('chats-loaded');
  for (const [workspaceFolder, workspaceRows] of byWorkspace) {
    let items;
    try {
      items = (await loadTodosData(dataDir, workspaceFolder)).items;
    } catch (error) {
      logDelegationEvent('todo-review-repair-failed', {}, {
        workspaceFolder,
        code: readString(/** @type {any} */ (error)?.code) || 'TODO_READ',
        message: error instanceof Error ? error.message : String(error ?? 'read_failed'),
      });
      summary.failed += 1;
      continue;
    }
    summary.workspaces += 1;
    const list = Array.isArray(items) ? items : [];
    /** @type {Set<string>} */
    const referenced = new Set();
    for (const row of workspaceRows) {
      const direct = readDelegationWorkflowLeafIdFromRow(row);
      const candidate = direct || todoIdByChat.get(readString(delegationController(row))) || '';
      const { todoId, matched } = matchLeafCandidate(list, normalizeTodoRefId(candidate) || candidate);
      if (matched && todoId) referenced.add(todoId);
    }
    // One delegation read per workspace instead of one per todo: the snapshot
    // computation would otherwise re-query and re-parse every workspace row for
    // each leaf. Delegations do not change during the repair (the owner lock is
    // held), so the shared rows are exact.
    /** @type {any[] | null} */
    let wsRows = null;
    try {
      wsRows = listDelegationsForWorkspace(workspaceFolder, { dataDir });
    } catch {
      wsRows = null;
    }
    const syncDeps = wsRows
      ? {
        rows: wsRows,
        computeSnapshot: (/** @type {any} */ input) => computeTodoReviewSnapshotForTodo({ ...input, rows: wsRows }),
      }
      : undefined;
    stage('workspace-prepared');
    // Compute every snapshot in memory, then persist them with ONE todos file
    // write per workspace (and none when nothing changed).
    /** @type {Array<{ id: string, snapshot: Record<string, any>, expectedUpdatedAt: string, expectedGeneration: number }>} */
    const entries = [];
    for (const item of list) {
      const todoId = readString(item?.id);
      if (!todoId) continue;
      // Only leaves with review-relevant delegations, or a stored snapshot, are
      // touched: unrelated todos must not gain a `none` snapshot on every boot.
      if (!referenced.has(todoId) && !/** @type {any} */ (item).review) continue;
      summary.todos += 1;
      try {
        const compute = syncDeps?.computeSnapshot || computeTodoReviewSnapshotForTodo;
        entries.push({ id: todoId, expectedUpdatedAt: item.updatedAt,
          expectedGeneration: Number(item.review?.generation) || 0,
          snapshot: await compute({ todo: { ...item, workspaceFolder }, dataDir }) });
      } catch (error) {
        failRepairTodo({ workspaceFolder, todoId, dataDir }, error);
        summary.failed += 1;
      }
    }
    stage('workspace-computed');
    /** @type {any[]} */
    let results = [];
    if (entries.length) {
      try {
        results = await writeTodoReviewBatch(dataDir, workspaceFolder, entries);
      } catch (error) {
        // The save failed: nothing was persisted, so every entry is retried.
        for (const entry of entries) {
          failRepairTodo({ workspaceFolder, todoId: entry.id, dataDir }, error);
          summary.failed += 1;
        }
        results = [];
      }
    }
    for (const result of results) {
      const todoId = result.id;
      if (result.error) {
        if (readString(result.error?.code) === 'NOT_FOUND') continue;
        failRepairTodo({ workspaceFolder, todoId, dataDir }, result.error);
        summary.failed += 1;
        continue;
      }
      try {
        if (isTodoLeafAutoCloseEnabled(undefined)) {
          await closeTodoLeafAfterReview({ dataDir, workspaceFolder, todoId, rows: wsRows || undefined });
        }
      } catch (error) {
        failRepairTodo({ workspaceFolder, todoId, dataDir }, error);
        summary.failed += 1;
        continue;
      }
      if (result.changed) {
        summary.repaired += 1;
        emitTodoReviewChanged({ workspaceFolder, todoId });
      }
      retryAttempts.delete(retryKey({ workspaceFolder, todoId, dataDir }));
    }
    stage('workspace-written');
  }
  return summary;
}
