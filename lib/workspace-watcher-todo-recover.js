/**
 * Atomic per-todo recovery for Workspace Watcher `doing` rows.
 *
 * Manual UI, MCP and autopilot reconcile all call {@link recoverWorkspaceWatcherTodo}.
 * Automatic release never promotes `unknown` to `recoverable`.
 */

import { DELEGATION_RUNTIME_TICK_MS } from './delegation-status.js';
import { lookupChatRunRequest, probeChatRunLiveness } from './chat-run-service.js';
import { loadChats } from './persist/chats-persist.js';
import { loadTodosData, updateTodo, withTodosWatcherNudgeSuppressed } from './persist/todos-persist.js';
import {
  getWorkspaceWatcher,
  getWorkspaceWatcherActiveCycles,
  upsertWorkspaceWatcher,
  withWorkspaceWatchersFileLock,
} from './persist/workspace-watchers-persist.js';
import { readTodoParentId } from './todo-tree.js';
import { resolveDataPath } from './runtime-paths.js';

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
 * @returns {object | null}
 */
function loadWorkspaceWatcherChatRow(chatId) {
  const id = String(chatId ?? '').trim();
  if (!id) return null;
  return loadChats().find((chat) => String(chat?.id ?? '') === id) || null;
}

/**
 * @param {object | null | undefined} watcher
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
 * @param {object | null | undefined} watcher
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
 * @param {object | null | undefined} watcher
 * @param {object | null | undefined} pickedTodo
 * @param {object[]} items
 * @param {number} now
 * @param {object[]} [activeUsageLimits]
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

/**
 * Unknown-state human escalation after this many consecutive reconcile observations
 * at the worker tick cadence (6 × 5s = 30s). Named policy mirror:
 * `policy.unknownEscalationObservations` (default 6).
 */
export const WORKSPACE_TODO_UNKNOWN_ESCALATION_OBSERVATIONS = 6;

/**
 * @param {object} state
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
 * @param {object[]} items
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
 * @param {object} input
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
  });
}

/**
 * @param {{
 *   workspaceFolder?: string,
 *   dataDir?: string,
 *   now?: number,
 *   probeChatRunLiveness?: typeof probeChatRunLiveness,
 *   getChat?: (chatId: string) => object | null,
 *   loadDelegations?: () => object[],
 *   notify?: (input: object) => boolean,
 * }} [options]
 * @returns {{ escalated: string[], cleared: string[] }}
 */
export function observeWorkspaceTodoUnknownEscalations(options = {}) {
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
    items = loadTodosData(dataDir, workspaceFolder)?.items || [];
    states = classifyWorkspaceDoingTodos({
      items,
      delegations: typeof options.loadDelegations === 'function' ? options.loadDelegations() : [],
      cycles: getWorkspaceWatcherActiveCycles(watcher),
      probe,
      isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
      getChat,
      now,
      recoverIdleOpenChat: policy.recoverIdleOpenChat === true,
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
 *   getChat?: (chatId: string) => object | null,
 *   loadDelegations?: () => object[],
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   outcome: string,
 *   startsNewExecution?: boolean,
 *   todoId?: string,
 *   item?: object | null,
 *   state?: object | null,
 *   error?: object,
 * }}
 */
export function recoverWorkspaceWatcherTodo(options = {}) {
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
  let watcher;
  try {
    watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  } catch (error) {
    return { ok: false, outcome: 'api-error', error: describeError(error) };
  }
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  let items = [];
  try {
    items = loadTodosData(dataDir, workspaceFolder)?.items || [];
  } catch (error) {
    return { ok: false, outcome: 'api-error', error: describeError(error) };
  }
  if (!isWorkspaceTodoLeaf(items, todoId)) {
    return { ok: false, outcome: 'blocked', todoId, error: { code: 'NOT_LEAF', message: 'Only leaf todos can be recovered' } };
  }
  const item = items.find((row) => String(row?.id ?? '') === todoId) || null;
  if (!item) return { ok: false, outcome: 'api-error', todoId, error: { code: 'NOT_FOUND', message: 'Todo not found' } };
  if (String(item.updatedAt ?? '') !== expectedUpdatedAt) {
    return { ok: false, outcome: 'conflict', todoId, error: { code: 'CONFLICT', message: 'Stale todo revision' } };
  }
  if (idempotencyKey && String(item.execution?.lastRecoverIdempotencyKey ?? '') === idempotencyKey) {
    return { ok: true, outcome: 'released', todoId, item, startsNewExecution: true };
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
    const lockOutcome = withWorkspaceWatchersFileLock(() => {
      const freshItems = loadTodosData(dataDir, workspaceFolder)?.items || [];
      const current = freshItems.find((row) => String(row?.id ?? '') === todoId) || null;
      if (!current) return { code: 'not_found' };
      if (String(current.updatedAt ?? '') !== expectedUpdatedAt) return { code: 'conflict' };
      const freshState = classifyOneTodo({
        items: freshItems,
        todoId,
        delegations,
        cycles: getWorkspaceWatcherActiveCycles(getWorkspaceWatcher(workspaceFolder, { dataDir })),
        probe,
        isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
        getChat,
        now,
        recoverIdleOpenChat: policy.recoverIdleOpenChat === true,
      });
      if (!freshState || freshState.revision !== state.revision || freshState.attemptId !== state.attemptId) {
        return { code: 'superseded' };
      }
      if (freshState.state === 'active') return { code: 'already-active' };
      if (freshState.state !== 'recoverable') return { code: `now_${freshState.state}` };
      const { previous: _older, ...attempt } = current.execution || {};
      const releasedAt = new Date(now).toISOString();
      const note = ceilingReached
        ? `Workspace Watcher blocked abandoned work after ${failureCount} failed cycles.`
        : (state.claimed ? '' : `Workspace Watcher released abandoned work (${source}): ${state.reason}.`);
      withTodosWatcherNudgeSuppressed(() => {
        updateTodo(dataDir, workspaceFolder, todoId, {
          status: 'ready',
          strictStatus: true,
          claimedByChatId: null,
          claimedAt: null,
          expectedUpdatedAt,
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
            blockedReason: `Workspace Watcher failure ceiling reached (${failureCount}/${ceiling}). Retry manually after resolving the blocker.`,
          } : {}),
          ...(note ? { appendChangelog: { kind: 'note', text: note } } : {}),
        });
      });
      return { code: 'released' };
    }, { dataDir });
    if (lockOutcome.code === 'released') {
      const updated = loadTodosData(dataDir, workspaceFolder)?.items?.find((row) => row.id === todoId) || null;
      return { ok: true, outcome: 'released', todoId, item: updated, startsNewExecution: true, state };
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
 * @param {object} state
 * @param {object} [item]
 * @returns {object}
 */
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
