/**
 * Atomic per-todo recovery for Workspace Watcher `doing` rows.
 *
 * Manual UI, MCP and autopilot reconcile all call {@link recoverWorkspaceWatcherTodo}.
 * Automatic release never promotes `unknown` to `recoverable` because of a probe
 * error or an expired lease. The one age-based exception is an ownerless `doing`
 * leaf (`orphan_doing_idle`): no claim, chat, worktree, delegation or Watcher
 * cycle and idle past `policy.orphanDoingMinMs` (default 30 min, `0` disables).
 */

import { DELEGATION_RUNTIME_TICK_MS } from './delegation-status.js';
import { lookupChatRunRequest, probeChatRunLiveness } from './chat-run-service.js';
import { loadChats } from './persist/chats-persist.js';
import { commitWatcherTodoCommand, getTodo, listTodos } from './persist/todos-store.js';
import {
  getWorkspaceWatcher,
  getWorkspaceWatcherActiveCycles,
  loadWorkspaceWatchersDocument,
  upsertWorkspaceWatcher,
} from './persist/workspace-watchers-persist.js';
import { readTodoParentId } from './todo-tree.js';
import { resolveDataPath } from './runtime-paths.js';

/** Max attempts when the watcher row moves between the snapshot and the commit. */
const RELEASE_COMMIT_ATTEMPTS = 5;
const RETRY_RELEASE = Symbol('retry-release');

/**
 * Committed watcher row plus the document revision it was read at. Both come
 * from one synchronous read, so the pair is consistent. A workspace with no row
 * yet gets an empty one: the versioned command needs a row to check against.
 *
 * @param {string} workspaceFolder
 * @param {string} dataDir
 * @returns {{ row: Record<string, any>, revision: number }}
 */
function readWatcherSnapshot(workspaceFolder, dataDir) {
  let row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  if (!row) row = upsertWorkspaceWatcher(workspaceFolder, {}, { dataDir });
  const revision = Number(loadWorkspaceWatchersDocument({ dataDir }).revision);
  return { row, revision: Number.isInteger(revision) && revision >= 0 ? revision : 0 };
}

/**
 * Translate a rejected `commitWatcherTodoCommand` into the lock-outcome codes
 * the release paths already map to API outcomes. A todo CAS miss first checks
 * whether an identical request already landed (idempotent replay).
 *
 * @param {string} reason
 * @param {{ dataDir: string, workspaceFolder: string, todoId: string, idempotencyKey: string, replayField: string }} ctx
 * @returns {Promise<{ code: string, replay?: boolean } | typeof RETRY_RELEASE>}
 */
async function mapReleaseCommandFailure(reason, ctx) {
  if (reason === 'watcher_conflict' || reason === 'no_row') return RETRY_RELEASE;
  if (reason === 'todo_not_found') return { code: 'not_found' };
  if (reason === 'todo_conflict') {
    const fresh = await getTodo(ctx.dataDir, ctx.workspaceFolder, ctx.todoId);
    if (!fresh) return { code: 'not_found' };
    if (ctx.idempotencyKey && String(fresh.execution?.[ctx.replayField] ?? '') === ctx.idempotencyKey) {
      return { code: 'released', replay: true };
    }
    return { code: 'conflict' };
  }
  return { code: reason };
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
function describeError(error) {
  const err = error && typeof error === 'object' ? /** @type {Error & { code?: string }} */ (error) : null;
  const code = String(err?.code ?? 'ERROR').trim() || 'ERROR';
  const message = String(err?.message ?? error ?? 'Unknown error').trim() || 'Unknown error';
  return { code, message };
}
import {
  classifyWorkspaceDoingTodo,
  classifyWorkspaceDoingTodos,
} from './workspace-watcher-recovery.js';
import { evaluateWorkspaceWatcherGuardrails } from './workspace-watcher-guardrails.js';
import { workspaceWatcherFailureCeilingReason } from './workspace-watcher-blocked-reason.js';
import { buildLiveWorktreePredicate, buildWorktreeRecordReader } from './todo-worktree-manual.js';

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function resolveDataDir(options = {}) {
  const configured = String(options.dataDir ?? '').trim();
  return configured || resolveDataPath();
}

/**
 * @param {string} chatId
 * @returns {Record<string, any> | null}
 */
function loadWorkspaceWatcherChatRow(chatId) {
  const id = String(chatId ?? '').trim();
  if (!id) return null;
  return loadChats().find((chat) => String(chat?.id ?? '') === id) || null;
}

/**
 * @param {Record<string, any> | null | undefined} watcher
 * @returns {boolean}
 */
function canWorkspaceWatcherRecoverUnclaimed(watcher) {
  if (!watcher || String(watcher.mode || '') !== 'autopilot') return false;
  if (watcher.enabled === false || watcher.paused === true) return false;
  return !String(watcher.stopReason || '').trim();
}

/**
 * Whether unknown-state escalation may notify the operator (detect/report only).
 * Allowed in `observe` and `autopilot`; `off` never runs this path on heartbeat.
 * Does not apply cycle-start guardrails (quiet hours, daily budget, plan gate).
 *
 * @param {Record<string, any> | null | undefined} watcher
 * @returns {boolean}
 */
export function canWorkspaceWatcherReportUnknownEscalation(watcher) {
  if (!watcher || typeof watcher !== 'object') return false;
  const mode = String(watcher.mode || '').trim();
  if (mode !== 'observe' && mode !== 'autopilot') return false;
  if (watcher.enabled === false || watcher.paused === true) return false;
  return !String(watcher.stopReason || '').trim();
}

/**
 * Whether recovery side effects (release notify) may run under current watcher gates.
 *
 * @param {Record<string, any> | null | undefined} watcher
 * @param {Record<string, any> | null | undefined} pickedTodo
 * @param {Record<string, any>[]} items
 * @param {number} now
 * @param {Record<string, any>[]} [activeUsageLimits]
 * @param {{ requireAutopilot?: boolean }} [options]
 * @returns {boolean}
 */
function canWorkspaceWatcherRecoveryProceed(
  watcher,
  pickedTodo,
  items,
  now,
  activeUsageLimits = [],
  options = {},
) {
  const requireAutopilot = options.requireAutopilot === true;
  if (requireAutopilot) {
    if (!canWorkspaceWatcherRecoverUnclaimed(watcher)) return false;
  } else if (watcher && typeof watcher === 'object') {
    if (watcher.paused === true) return false;
    if (String(watcher.stopReason || '').trim()) return false;
  }
  const guard = evaluateWorkspaceWatcherGuardrails({
    watcher: watcher && typeof watcher === 'object' ? watcher : {},
    pickedTodo,
    items,
    now,
    activeUsageLimits,
  });
  return guard.allowed === true;
}

/**
 * @param {{ chatId?: string, runId?: string, phase?: string, startDeadlineAt?: string, cycleId?: string }} activeCycle
 * @param {(input: { chatId?: string, runId?: string }) => { known: boolean, busy: boolean, reason: string }} probe
 * @param {number} [now]
 * @returns {boolean}
 */
function isWorkspaceWatcherActiveCycleChatAlive(activeCycle, probe, now = Date.now()) {
  const chatId = String(activeCycle?.chatId ?? '').trim();
  if (!chatId) return false;
  const phase = String(activeCycle?.phase ?? '').trim().toLowerCase();
  const startDeadlineAt = Date.parse(String(activeCycle?.startDeadlineAt ?? '').trim());
  if (phase === 'starting' && Number.isFinite(startDeadlineAt) && now < startDeadlineAt) return true;
  const cycleId = String(activeCycle?.cycleId ?? '').trim();
  let runId = String(activeCycle?.runId ?? '').trim();
  if (phase === 'starting' && cycleId) {
    const found = lookupChatRunRequest({ chatId, requestId: cycleId });
    if (found?.accepted === true) {
      const acceptedRunId = String(found.runId ?? '').trim();
      if (acceptedRunId) runId = acceptedRunId;
      if (runId) {
        const live = probe({ chatId, runId });
        if (live.known === true && live.busy === true) return true;
        if (live.known === true && live.busy === false) return false;
      }
    }
  }
  const live = probe({ chatId, runId: runId || undefined });
  if (live.known === true && live.busy === true) return true;
  if (live.reason === 'chat_missing') return false;
  if (live.known === true && live.busy === false) return false;
  if (phase === 'starting' && Number.isFinite(startDeadlineAt) && now < startDeadlineAt) return true;
  return true;
}

/** Heartbeat tick interval (`DELEGATION_RUNTIME_TICK_MS`, 5s). */
export const WORKSPACE_TODO_RECOVERY_TICK_MS = DELEGATION_RUNTIME_TICK_MS;

/** `user_action` reasons that manual unknown release must never bypass. */
export const MANUAL_UNKNOWN_RELEASE_BLOCKED_USER_ACTION_REASONS = Object.freeze([
  'review_failed',
  'integration_ready',
  'worktree_open',
  'blocked_reason',
  'delegation_blocked',
]);

/**
 * Whether an operator may force-release a `doing` leaf without recoverable proof.
 *
 * @param {Record<string, any> | null | undefined} state
 * @returns {boolean}
 */
export function canManualReleaseDoingTodo(state) {
  if (!state || typeof state !== 'object') return false;
  const recoveryState = String(state.state ?? '').trim();
  if (recoveryState === 'unknown') return true;
  if (recoveryState !== 'user_action') return false;
  const reason = String(state.reason ?? '').trim();
  if (!reason) return false;
  return !MANUAL_UNKNOWN_RELEASE_BLOCKED_USER_ACTION_REASONS.includes(reason);
}

/**
 * @param {string} workspaceFolder
 * @param {string} todoId
 * @param {string} dataDir
 */
function clearUnknownTodoEscalation(workspaceFolder, todoId, dataDir) {
  const id = String(todoId ?? '').trim();
  if (!id) return;
  let watcher;
  try {
    watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  } catch {
    return;
  }
  const prev = watcher?.unknownTodoEscalations && typeof watcher.unknownTodoEscalations === 'object'
    ? watcher.unknownTodoEscalations
    : null;
  if (!prev || !Object.prototype.hasOwnProperty.call(prev, id)) return;
  const next = { ...prev };
  delete next[id];
  try {
    upsertWorkspaceWatcher(workspaceFolder, { unknownTodoEscalations: next }, { dataDir });
  } catch { /* best-effort */ }
}

/**
 * Unknown-state human escalation after this many consecutive reconcile observations
 * at the worker tick cadence (6 × 5s = 30s). Named policy mirror:
 * `policy.unknownEscalationObservations` (default 6).
 */
export const WORKSPACE_TODO_UNKNOWN_ESCALATION_OBSERVATIONS = 6;

/**
 * @param {Record<string, any>} state
 * @returns {string}
 */
export function workspaceTodoRecoverySignature(state) {
  return [
    String(state?.state ?? '').trim(),
    String(state?.reason ?? '').trim(),
    String(state?.evidence ?? '').trim(),
  ].join('|');
}

/**
 * @param {Record<string, any>[]} items
 * @param {string} todoId
 * @returns {boolean}
 */
function isWorkspaceTodoLeaf(items, todoId) {
  const id = String(todoId ?? '').trim();
  if (!id) return false;
  const childParentIds = new Set(
    (Array.isArray(items) ? items : []).map((row) => readTodoParentId(row)).filter(Boolean),
  );
  return !childParentIds.has(id);
}

/**
 * @param {Record<string, any>} input
 * @returns {ReturnType<typeof classifyWorkspaceDoingTodo> | null}
 */
function classifyOneTodo(input) {
  const items = Array.isArray(input.items) ? input.items : [];
  const todoId = String(input.todoId ?? '').trim();
  const item = items.find((row) => String(row?.id ?? '') === todoId);
  if (!item) return null;
  const index = new Map(items.filter((row) => row?.id).map((row) => [String(row.id), row]));
  const childParentIds = new Set(items.map((row) => readTodoParentId(row)).filter(Boolean));
  return classifyWorkspaceDoingTodo({
    item,
    items,
    index,
    childParentIds,
    delegations: input.delegations,
    cycles: input.cycles,
    probe: input.probe,
    isCycleChatAlive: input.isCycleChatAlive,
    getChat: input.getChat,
    now: input.now,
    recoverIdleOpenChat: input.recoverIdleOpenChat === true,
    hasLiveWorktree: input.hasLiveWorktree,
    closedCycles: /** @type {any} */ (input).closedCycles,
    readWorktreeRecord: /** @type {any} */ (input).readWorktreeRecord,
    reviewWaits: input.reviewWaits,
    reviewPolicy: input.reviewPolicy,
  });
}

/**
 * @param {{
 *   workspaceFolder?: string,
 *   dataDir?: string,
 *   now?: number,
 *   probeChatRunLiveness?: typeof probeChatRunLiveness,
 *   getChat?: (chatId: string) => Record<string, any> | null,
 *   loadDelegations?: () => Record<string, any>[],
 *   notify?: (input: Record<string, any>) => boolean,
 * }} [options]
 * @returns {Promise<{ escalated: string[], cleared: string[] }>}
 */
export async function observeWorkspaceTodoUnknownEscalations(options = {}) {
  const workspaceFolder = String(options.workspaceFolder ?? '').trim();
  if (!workspaceFolder) return { escalated: [], cleared: [] };
  const dataDir = resolveDataDir(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  const getChat = typeof options.getChat === 'function' ? options.getChat : loadWorkspaceWatcherChatRow;
  /** @type {string[]} */
  const escalated = [];
  /** @type {string[]} */
  const cleared = [];
  let watcher;
  try {
    watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  } catch {
    return { escalated, cleared };
  }
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const threshold = Math.max(
    1,
    Number(policy.unknownEscalationObservations) || WORKSPACE_TODO_UNKNOWN_ESCALATION_OBSERVATIONS,
  );
  let items = [];
  let states = [];
  try {
    items = (await listTodos(dataDir, workspaceFolder))?.items || [];
    states = classifyWorkspaceDoingTodos({
      items,
      delegations: typeof options.loadDelegations === 'function' ? options.loadDelegations() : [],
      cycles: getWorkspaceWatcherActiveCycles(watcher),
      probe,
      isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
      getChat,
      now,
      recoverIdleOpenChat: policy.recoverIdleOpenChat === true,
      hasLiveWorktree: buildLiveWorktreePredicate(dataDir),
      closedCycles: watcher?.cycleChats,
      readWorktreeRecord: buildWorktreeRecordReader(dataDir),
      reviewWaits: watcher?.reviewWaits,
      reviewPolicy: policy,
    });
  } catch {
    return { escalated, cleared };
  }
  const unknownById = new Map(
    states.filter((row) => row.state === 'unknown').map((row) => [row.todoId, row]),
  );
  const prev = watcher.unknownTodoEscalations && typeof watcher.unknownTodoEscalations === 'object'
    ? watcher.unknownTodoEscalations
    : {};
  /** @type {Record<string, { signature: string, count: number, escalatedSignature: string }>} */
  const next = {};
  for (const [todoId, state] of unknownById) {
    const signature = workspaceTodoRecoverySignature(state);
    const prior = prev[todoId] && typeof prev[todoId] === 'object' ? prev[todoId] : null;
    const sameSig = prior && String(prior.signature || '') === signature;
    const count = sameSig ? Math.min(threshold + 1, (Number(prior.count) || 0) + 1) : 1;
    const escalatedSignature = sameSig ? String(prior.escalatedSignature || '') : '';
    let nextEscalated = escalatedSignature;
    if (count >= threshold && escalatedSignature !== signature) {
      const mayReport = canWorkspaceWatcherReportUnknownEscalation(watcher);
      if (mayReport) {
        nextEscalated = signature;
        escalated.push(todoId);
        const notify = typeof options.notify === 'function' ? options.notify : null;
        if (notify) {
          notify({
            workspaceFolder,
            title: 'Cretli — todo recovery unknown',
            body: `Todo ${todoId.slice(0, 8)} stays unknown (${state.reason}). Check executor chat ${String(state.chatId || '').slice(0, 8) || 'n/a'}.`,
            tag: `cretli-watcher-unknown-${todoId.slice(0, 8)}`,
          });
        }
      }
    }
    next[todoId] = { signature, count, escalatedSignature: nextEscalated };
  }
  for (const todoId of Object.keys(prev)) {
    if (!unknownById.has(todoId)) cleared.push(todoId);
  }
  const changed = escalated.length > 0 || cleared.length > 0
    || JSON.stringify(next) !== JSON.stringify(prev);
  if (changed) {
    try {
      upsertWorkspaceWatcher(workspaceFolder, { unknownTodoEscalations: next }, { dataDir });
    } catch { /* best-effort */ }
  }
  return { escalated, cleared };
}

/**
 * Release one recoverable `doing` leaf back to `ready` with CAS fencing.
 *
 * Recovery failures (CAS conflict, superseded attempt) do **not** increment
 * `watcher.failures`; only a finished watcher cycle with outcome `failure` does.
 *
 * @param {{
 *   workspaceFolder?: string,
 *   todoId?: string,
 *   expectedUpdatedAt?: string,
 *   idempotencyKey?: string,
 *   source?: 'manual' | 'autopilot',
 *   dataDir?: string,
 *   now?: number,
 *   probeChatRunLiveness?: typeof probeChatRunLiveness,
 *   getChat?: (chatId: string) => Record<string, any> | null,
 *   loadDelegations?: () => Record<string, any>[],
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome: string,
 *   startsNewExecution?: boolean,
 *   todoId?: string,
 *   item?: Record<string, any> | null,
 *   state?: Record<string, any> | null,
 *   error?: Record<string, any>,
 *   replayed?: boolean,
 * }>}
 */
export async function recoverWorkspaceWatcherTodo(options = {}) {
  const todoId = String(options.todoId ?? '').trim();
  for (let attempt = 0; attempt < RELEASE_COMMIT_ATTEMPTS; attempt += 1) {
    const result = await recoverWorkspaceWatcherTodoOnce(options);
    if (result !== RETRY_RELEASE) return result;
  }
  // The watcher row kept moving under every attempt: the caller re-reads and retries.
  return { ok: false, outcome: 'conflict', todoId, error: { code: 'CONFLICT', message: 'Watcher state kept changing' } };
}

/**
 * One recover attempt. Returns {@link RETRY_RELEASE} when the watcher row moved
 * between the snapshot the decision was computed from and the commit.
 *
 * @param {Record<string, any>} options
 * @returns {Promise<any>}
 */
async function recoverWorkspaceWatcherTodoOnce(options) {
  const workspaceFolder = String(options.workspaceFolder ?? '').trim();
  const todoId = String(options.todoId ?? '').trim();
  const expectedUpdatedAt = String(options.expectedUpdatedAt ?? '').trim();
  const idempotencyKey = String(options.idempotencyKey ?? '').trim();
  const source = String(options.source ?? 'manual').trim().toLowerCase() === 'autopilot' ? 'autopilot' : 'manual';
  if (!workspaceFolder) return { ok: false, outcome: 'api-error', error: { code: 'VALIDATION', message: 'workspace required' } };
  if (!todoId) return { ok: false, outcome: 'api-error', error: { code: 'VALIDATION', message: 'todo id required' } };
  if (!expectedUpdatedAt) {
    return { ok: false, outcome: 'api-error', error: { code: 'VALIDATION', message: 'expectedUpdatedAt required' } };
  }
  const dataDir = resolveDataDir(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  const getChat = typeof options.getChat === 'function' ? options.getChat : loadWorkspaceWatcherChatRow;
  let items = [];
  try {
    items = (await listTodos(dataDir, workspaceFolder))?.items || [];
  } catch (error) {
    return { ok: false, outcome: 'api-error', error: describeError(error) };
  }
  // No await between this snapshot and the commit below: the command's CAS on
  // the row version proves the decision was computed from the committed row.
  let snapshot;
  try {
    snapshot = readWatcherSnapshot(workspaceFolder, dataDir);
  } catch (error) {
    return { ok: false, outcome: 'api-error', error: describeError(error) };
  }
  const watcher = snapshot.row;
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  if (!isWorkspaceTodoLeaf(items, todoId)) {
    return { ok: false, outcome: 'blocked', todoId, error: { code: 'NOT_LEAF', message: 'Only leaf todos can be recovered' } };
  }
  const item = items.find((row) => String(row?.id ?? '') === todoId) || null;
  if (!item) return { ok: false, outcome: 'api-error', todoId, error: { code: 'NOT_FOUND', message: 'Todo not found' } };
  // Idempotent replay is checked BEFORE the CAS token: a retry after the
  // release already landed carries a stale revision by definition, so the key
  // match must answer success instead of a conflict.
  if (idempotencyKey && String(item.execution?.lastRecoverIdempotencyKey ?? '') === idempotencyKey) {
    return { ok: true, outcome: 'released', todoId, item, startsNewExecution: true, replayed: true };
  }
  if (String(item.updatedAt ?? '') !== expectedUpdatedAt) {
    return { ok: false, outcome: 'conflict', todoId, error: { code: 'CONFLICT', message: 'Stale todo revision' } };
  }
  const delegations = typeof options.loadDelegations === 'function' ? options.loadDelegations() : [];
  const cycles = getWorkspaceWatcherActiveCycles(watcher);
  const state = classifyOneTodo({
    items,
    todoId,
    delegations,
    cycles,
    probe,
    isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
    getChat,
    now,
    recoverIdleOpenChat: policy.recoverIdleOpenChat === true,
    hasLiveWorktree: buildLiveWorktreePredicate(dataDir),
    closedCycles: /** @type {any} */ (watcher)?.cycleChats,
    readWorktreeRecord: buildWorktreeRecordReader(dataDir),
    reviewWaits: watcher?.reviewWaits,
    reviewPolicy: policy,
  });
  if (!state) return { ok: false, outcome: 'api-error', todoId, error: { code: 'NOT_FOUND', message: 'Todo not found' } };
  if (state.state === 'active') {
    return { ok: false, outcome: 'already-active', todoId, state };
  }
  if (state.state === 'dependency') {
    return { ok: false, outcome: 'blocked', todoId, state };
  }
  if (state.state === 'unknown') {
    return { ok: false, outcome: 'unknown', todoId, state };
  }
  if (state.state === 'user_action') {
    return { ok: false, outcome: 'user-action', todoId, state };
  }
  if (state.state !== 'recoverable') {
    return { ok: false, outcome: 'blocked', todoId, state };
  }
  const recoverUnclaimed = canWorkspaceWatcherRecoverUnclaimed(watcher);
  if (!state.claimed && !recoverUnclaimed) {
    return { ok: false, outcome: 'blocked', todoId, state, error: { code: 'WATCHER_NOT_AUTOPILOT', message: 'Unclaimed recovery requires autopilot' } };
  }
  if (!canWorkspaceWatcherRecoveryProceed(
    watcher,
    item,
    items,
    now,
    [],
    { requireAutopilot: !state.claimed },
  )) {
    return {
      ok: false,
      outcome: 'blocked',
      todoId,
      state,
      error: { code: 'WATCHER_GUARDRAILS', message: 'Watcher guardrails block recovery' },
    };
  }
  const failures = watcher?.failures && typeof watcher.failures === 'object' ? watcher.failures : {};
  const ceiling = Number(policy.maxConsecutiveFailures) || 0;
  const failureCount = Number(failures[todoId]) || 0;
  const ceilingReached = ceiling > 0 && failureCount >= ceiling;
  try {
    /** @type {{ code: string, replay?: boolean }} */
    let decided = { code: 'skipped' };
    const outcome = await commitWatcherTodoCommand(dataDir, workspaceFolder, {
      todoId,
      expectedTodoUpdatedAt: expectedUpdatedAt,
      expectedWatcherUpdatedAt: String(watcher.updatedAt ?? ''),
      expectedWatcherRevision: snapshot.revision,
      // Runs synchronously under the watcher lock (40) with the todo write on
      // the same lock hold (50); the row and items are the committed state.
      decide: ({ row, todo: current, items: freshItems }) => {
        // Replay under the lock: a concurrent identical recover that won the
        // race already stored the key; answer success instead of a CAS conflict.
        if (idempotencyKey && String(current.execution?.lastRecoverIdempotencyKey ?? '') === idempotencyKey) {
          decided = { code: 'released', replay: true };
          return false;
        }
        const freshState = classifyOneTodo({
          items: freshItems,
          todoId,
          delegations,
          cycles: getWorkspaceWatcherActiveCycles(row),
          probe,
          isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
          getChat,
          now,
          recoverIdleOpenChat: policy.recoverIdleOpenChat === true,
          hasLiveWorktree: buildLiveWorktreePredicate(dataDir),
          closedCycles: /** @type {any} */ (row)?.cycleChats,
          readWorktreeRecord: buildWorktreeRecordReader(dataDir),
          reviewWaits: row?.reviewWaits,
          reviewPolicy: policy,
        });
        if (!freshState || freshState.revision !== state.revision || freshState.attemptId !== state.attemptId) {
          decided = { code: 'superseded' };
          return false;
        }
        if (freshState.state === 'active') {
          decided = { code: 'already-active' };
          return false;
        }
        if (freshState.state !== 'recoverable') {
          decided = { code: `now_${freshState.state}` };
          return false;
        }
        const { previous: _older, ...attempt } = current.execution || {};
        const releasedAt = new Date(now).toISOString();
        const note = ceilingReached
          ? `Workspace Watcher blocked abandoned work after ${failureCount} failed cycles.`
          : (state.claimed ? '' : `Workspace Watcher released abandoned work (${source}): ${state.reason}.`);
        decided = { code: 'released' };
        return {
          todoPatch: {
            status: 'ready',
            strictStatus: true,
            claimedByChatId: null,
            claimedAt: null,
            ...(attempt.attemptId ? {
              execution: {
                ...attempt,
                phase: 'released',
                releasedAt,
                releaseReason: state.reason,
                lastRecoverIdempotencyKey: idempotencyKey || undefined,
                lastRecoverSource: source,
              },
            } : {}),
            ...(ceilingReached ? {
              blockedReason: workspaceWatcherFailureCeilingReason(failureCount, ceiling),
            } : {}),
            ...(note ? { appendChangelog: { kind: 'note', text: note } } : {}),
          },
        };
      },
    });
    /** @type {{ code: string, replay?: boolean }} */
    let lockOutcome;
    if (outcome.ok) lockOutcome = { code: 'released' };
    else if (outcome.reason === 'skipped') lockOutcome = decided;
    else {
      const mapped = await mapReleaseCommandFailure(outcome.reason, {
        dataDir, workspaceFolder, todoId, idempotencyKey, replayField: 'lastRecoverIdempotencyKey',
      });
      if (mapped === RETRY_RELEASE) return RETRY_RELEASE;
      lockOutcome = mapped;
    }
    if (lockOutcome.code === 'released') {
      const updated = (await getTodo(dataDir, workspaceFolder, todoId)) || null;
      return { ok: true, outcome: 'released', todoId, item: updated, startsNewExecution: true, state, replayed: lockOutcome.replay === true };
    }
    if (lockOutcome.code === 'conflict' || lockOutcome.code === 'superseded') {
      return { ok: false, outcome: 'conflict', todoId, state };
    }
    if (lockOutcome.code === 'already-active') {
      return { ok: false, outcome: 'already-active', todoId, state };
    }
    if (String(lockOutcome.code || '').startsWith('now_')) {
      const sub = String(lockOutcome.code).slice(4);
      if (sub === 'unknown') return { ok: false, outcome: 'unknown', todoId, state };
      if (sub === 'user_action') return { ok: false, outcome: 'user-action', todoId, state };
      return { ok: false, outcome: 'blocked', todoId, state };
    }
    return { ok: false, outcome: 'api-error', todoId, error: { code: String(lockOutcome.code || 'FAILED'), message: 'Recovery failed' } };
  } catch (error) {
    const described = describeError(error);
    if (described.code === 'CONFLICT') return { ok: false, outcome: 'conflict', todoId, state, error: described };
    return { ok: false, outcome: 'api-error', todoId, state, error: described };
  }
}

/**
 * Operator-confirmed release for `unknown` (and selected `user_action`) `doing` leaves.
 * Does not bypass integration/worktree guards and never promotes `unknown` automatically.
 *
 * @param {{
 *   workspaceFolder?: string,
 *   todoId?: string,
 *   expectedUpdatedAt?: string,
 *   confirmUnknownRelease?: boolean,
 *   confirm?: boolean,
 *   operatorMessage?: string,
 *   message?: string,
 *   idempotencyKey?: string,
 *   source?: 'manual' | 'autopilot',
 *   dataDir?: string,
 *   now?: number,
 *   probeChatRunLiveness?: typeof probeChatRunLiveness,
 *   getChat?: (chatId: string) => Record<string, any> | null,
 *   loadDelegations?: () => Record<string, any>[],
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   outcome: string,
 *   startsNewExecution?: boolean,
 *   replayed?: boolean,
 *   todoId?: string,
 *   item?: Record<string, any> | null,
 *   state?: Record<string, any> | null,
 *   error?: Record<string, any>,
 * }>}
 */
export async function releaseDoingWorkspaceWatcherTodo(options = {}) {
  const todoId = String(options.todoId ?? '').trim();
  for (let attempt = 0; attempt < RELEASE_COMMIT_ATTEMPTS; attempt += 1) {
    const result = await releaseDoingWorkspaceWatcherTodoOnce(options);
    if (result !== RETRY_RELEASE) return result;
  }
  // The watcher row kept moving under every attempt: the caller re-reads and retries.
  return { ok: false, outcome: 'conflict', todoId, error: { code: 'CONFLICT', message: 'Watcher state kept changing' } };
}

/**
 * One release attempt. Returns {@link RETRY_RELEASE} when the watcher row moved
 * between the snapshot the decision was computed from and the commit.
 *
 * @param {Record<string, any>} options
 * @returns {Promise<any>}
 */
async function releaseDoingWorkspaceWatcherTodoOnce(options) {
  const workspaceFolder = String(options.workspaceFolder ?? '').trim();
  const todoId = String(options.todoId ?? '').trim();
  const expectedUpdatedAt = String(options.expectedUpdatedAt ?? '').trim();
  const idempotencyKey = String(options.idempotencyKey ?? '').trim();
  const confirmed = options.confirmUnknownRelease === true || options.confirm === true;
  const operatorMessage = String(options.operatorMessage ?? options.message ?? '').trim();
  const source = String(options.source ?? 'manual').trim().toLowerCase() === 'autopilot' ? 'autopilot' : 'manual';
  if (!workspaceFolder) {
    return { ok: false, outcome: 'api-error', error: { code: 'VALIDATION', message: 'workspace required' } };
  }
  if (!todoId) {
    return { ok: false, outcome: 'api-error', error: { code: 'VALIDATION', message: 'todo id required' } };
  }
  if (!expectedUpdatedAt) {
    return { ok: false, outcome: 'api-error', error: { code: 'VALIDATION', message: 'expectedUpdatedAt required' } };
  }
  if (!confirmed) {
    return {
      ok: false,
      outcome: 'api-error',
      error: { code: 'VALIDATION', message: 'confirmUnknownRelease required' },
    };
  }
  const dataDir = resolveDataDir(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  const getChat = typeof options.getChat === 'function' ? options.getChat : loadWorkspaceWatcherChatRow;
  let items = [];
  try {
    items = (await listTodos(dataDir, workspaceFolder))?.items || [];
  } catch (error) {
    return { ok: false, outcome: 'api-error', error: describeError(error) };
  }
  if (!isWorkspaceTodoLeaf(items, todoId)) {
    return { ok: false, outcome: 'blocked', todoId, error: { code: 'NOT_LEAF', message: 'Only leaf todos can be released' } };
  }
  const item = items.find((row) => String(row?.id ?? '') === todoId) || null;
  if (!item) return { ok: false, outcome: 'api-error', todoId, error: { code: 'NOT_FOUND', message: 'Todo not found' } };
  // Idempotent replay is checked BEFORE the CAS token: a retry after the
  // release already landed carries a stale revision by definition, so the key
  // match must answer success instead of a conflict.
  if (idempotencyKey && String(item.execution?.lastManualUnknownReleaseKey ?? '') === idempotencyKey) {
    return { ok: true, outcome: 'released', todoId, item, startsNewExecution: true, replayed: true };
  }
  // Only a `doing` row can be released. This gate runs before classify and
  // before any updateTodo write, so a ready/done/idea todo is refused without
  // touching the recovery read model at all.
  if (String(item.status ?? '') !== 'doing') {
    return { ok: false, outcome: 'not-doing', todoId, error: { code: 'NOT_DOING', message: 'Only doing todos can be released' } };
  }
  if (String(item.updatedAt ?? '') !== expectedUpdatedAt) {
    return { ok: false, outcome: 'conflict', todoId, error: { code: 'CONFLICT', message: 'Stale todo revision' } };
  }
  const delegations = typeof options.loadDelegations === 'function' ? options.loadDelegations() : [];
  // No await between this snapshot and the commit below: the command's CAS on
  // the row version proves the decision was computed from the committed row.
  let snapshot;
  try {
    snapshot = readWatcherSnapshot(workspaceFolder, dataDir);
  } catch (error) {
    return { ok: false, outcome: 'api-error', error: describeError(error) };
  }
  const watcher = snapshot.row;
  const cycles = getWorkspaceWatcherActiveCycles(watcher);
  const state = classifyOneTodo({
    items,
    todoId,
    delegations,
    cycles,
    probe,
    isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
    getChat,
    now,
    recoverIdleOpenChat: false,
    hasLiveWorktree: buildLiveWorktreePredicate(dataDir),
    closedCycles: /** @type {any} */ (watcher)?.cycleChats,
    readWorktreeRecord: buildWorktreeRecordReader(dataDir),
  });
  if (!state) {
    return { ok: false, outcome: 'api-error', todoId, error: { code: 'NOT_FOUND', message: 'Todo not found' } };
  }
  if (state.state === 'active') {
    return { ok: false, outcome: 'already-active', todoId, state };
  }
  if (state.state === 'dependency') {
    return { ok: false, outcome: 'blocked', todoId, state };
  }
  if (state.state === 'recoverable') {
    return {
      ok: false,
      outcome: 'recoverable',
      todoId,
      state,
      error: { code: 'USE_RECOVER', message: 'Todo is recoverable — use recover instead of manual unknown release' },
    };
  }
  if (!canManualReleaseDoingTodo(state)) {
    const outcome = state.state === 'user_action' ? 'user-action' : 'blocked';
    return { ok: false, outcome, todoId, state };
  }
  try {
    /** @type {{ code: string, replay?: boolean }} */
    let decided = { code: 'skipped' };
    const outcome = await commitWatcherTodoCommand(dataDir, workspaceFolder, {
      todoId,
      expectedTodoUpdatedAt: expectedUpdatedAt,
      expectedWatcherUpdatedAt: String(watcher.updatedAt ?? ''),
      expectedWatcherRevision: snapshot.revision,
      // Runs synchronously under the watcher lock (40) with the todo write on
      // the same lock hold (50); the row and items are the committed state.
      decide: ({ row, todo: current, items: freshItems }) => {
        // Replay under the lock: a concurrent identical release that won the
        // race already stored the key; answer success instead of a CAS conflict.
        if (idempotencyKey && String(current.execution?.lastManualUnknownReleaseKey ?? '') === idempotencyKey) {
          decided = { code: 'released', replay: true };
          return false;
        }
        if (String(current.status ?? '') !== 'doing') {
          decided = { code: 'not_doing' };
          return false;
        }
        const freshState = classifyOneTodo({
          items: freshItems,
          todoId,
          delegations,
          cycles: getWorkspaceWatcherActiveCycles(row),
          probe,
          isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
          getChat,
          now,
          recoverIdleOpenChat: false,
          hasLiveWorktree: buildLiveWorktreePredicate(dataDir),
          closedCycles: /** @type {any} */ (row)?.cycleChats,
          readWorktreeRecord: buildWorktreeRecordReader(dataDir),
        });
        if (!freshState || freshState.revision !== state.revision || freshState.attemptId !== state.attemptId) {
          decided = { code: 'superseded' };
          return false;
        }
        if (freshState.state === 'active') {
          decided = { code: 'already-active' };
          return false;
        }
        if (freshState.state === 'recoverable') {
          decided = { code: 'now_recoverable' };
          return false;
        }
        if (!canManualReleaseDoingTodo(freshState)) {
          decided = { code: `now_${freshState.state}` };
          return false;
        }
        const { previous: _older, ...attempt } = current.execution || {};
        const releasedAt = new Date(now).toISOString();
        const releaseReason = `manual_unknown_release:${freshState.reason || 'unknown'}`;
        const noteParts = [
          `Operator released stuck todo from ${freshState.state} recovery (${freshState.reason || 'unknown'}).`,
        ];
        if (operatorMessage) noteParts.push(operatorMessage);
        decided = { code: 'released' };
        return {
          todoPatch: {
            status: 'ready',
            strictStatus: true,
            claimedByChatId: null,
            claimedAt: null,
            ...(attempt.attemptId ? {
              execution: {
                ...attempt,
                phase: 'released',
                releasedAt,
                releaseReason,
                lastManualUnknownReleaseKey: idempotencyKey || undefined,
                lastRecoverSource: source,
              },
            } : {}),
            appendChangelog: { kind: 'note', text: noteParts.join(' ') },
          },
        };
      },
    });
    /** @type {{ code: string, replay?: boolean }} */
    let lockOutcome;
    if (outcome.ok) lockOutcome = { code: 'released' };
    else if (outcome.reason === 'skipped') lockOutcome = decided;
    else {
      const mapped = await mapReleaseCommandFailure(outcome.reason, {
        dataDir, workspaceFolder, todoId, idempotencyKey, replayField: 'lastManualUnknownReleaseKey',
      });
      if (mapped === RETRY_RELEASE) return RETRY_RELEASE;
      lockOutcome = mapped;
    }
    if (lockOutcome.code === 'released') {
      clearUnknownTodoEscalation(workspaceFolder, todoId, dataDir);
      const updated = (await getTodo(dataDir, workspaceFolder, todoId)) || null;
      return { ok: true, outcome: 'released', todoId, item: updated, startsNewExecution: true, state, replayed: lockOutcome.replay === true };
    }
    if (lockOutcome.code === 'conflict' || lockOutcome.code === 'superseded') {
      return { ok: false, outcome: 'conflict', todoId, state };
    }
    if (lockOutcome.code === 'already-active') {
      return { ok: false, outcome: 'already-active', todoId, state };
    }
    if (lockOutcome.code === 'not_doing') {
      return { ok: false, outcome: 'not-doing', todoId, state, error: { code: 'NOT_DOING', message: 'Only doing todos can be released' } };
    }
    if (lockOutcome.code === 'now_recoverable') {
      return {
        ok: false,
        outcome: 'recoverable',
        todoId,
        state,
        error: { code: 'USE_RECOVER', message: 'Todo is recoverable — use recover instead of manual unknown release' },
      };
    }
    if (String(lockOutcome.code || '').startsWith('now_')) {
      const sub = String(lockOutcome.code).slice(4);
      if (sub === 'user_action') return { ok: false, outcome: 'user-action', todoId, state };
      return { ok: false, outcome: 'blocked', todoId, state };
    }
    return { ok: false, outcome: 'api-error', todoId, error: { code: String(lockOutcome.code || 'FAILED'), message: 'Release failed' } };
  } catch (error) {
    const described = describeError(error);
    if (described.code === 'CONFLICT') return { ok: false, outcome: 'conflict', todoId, state, error: described };
    return { ok: false, outcome: 'api-error', todoId, state, error: described };
  }
}

export function enrichWorkspaceTodoRecoveryView(state, item) {
  const execution = item?.execution && typeof item.execution === 'object' ? item.execution : {};
  const lastConfirmedAt = String(
    execution.releasedAt
    || execution.claimedAt
    || item?.claimedAt
    || item?.updatedAt
    || '',
  ).trim();
  const recoveryInProgress = state?.state === 'active'
    || (String(item?.status ?? '') === 'doing' && String(execution.phase ?? '').toLowerCase() === 'starting');
  return {
    ...state,
    lastConfirmedAt,
    recoveryInProgress,
    displayState: recoveryInProgress && state?.state !== 'active' ? 'recovery_in_progress' : state?.state,
  };
}
