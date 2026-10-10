/**
 * Workspace Watcher — one durable autopilot cycle (stage B/C).
 *
 * The watcher is a cheap deterministic guard. When it decides that a cycle may
 * start it does not run the work itself: it spawns one short-lived orchestrator
 * chat that plans or delegates implementation/review according to the
 * cretli-multi-harness skill, then ends. The durable contract is:
 *
 *   - one row carries at most `policy.maxParallel` entries in `activeCycles`
 *     (`activeCycle` is only the v1 downgrade mirror of slot 0),
 *   - the cycle/chat/request identity is written *before* the chat run starts,
 *     so a restart replays/reconciles instead of spawning a duplicate,
 *   - a ready todo is claimed with a CAS (never overwriting doing/done),
 *   - every failure rolls the cycle back and moves the workspace into backoff,
 *   - the plan gate drafts a plan and then waits for a real human approval; it
 *     never sets `plan.approvedAt` and never loops plan cycles.
 *
 * This module is the only place that writes an autopilot cycle. It imports the
 * guard service (not the other way around) so there is no import cycle.
 */

import { randomUUID } from 'node:crypto';
import { resolveDataPath } from './runtime-paths.js';
import { areWorkspaceWatcherStartsEnabled } from './workspace-watcher-runtime-control.js';
import { addChat } from './persist/chats-persist.js';
import { loadDelegations } from './persist/delegations-persist.js';
import { archiveChatFamily } from './chat-archive-policy.js';
import { sweepClosedWorkspaceWatcherCycles } from './workspace-watcher-archive-sweep.js';
import { loadTodosData, updateTodo } from './persist/todos-persist.js';
import { listWorkspaceMemory } from './persist/workspace-memory-persist.js';
import { collectTodoAncestorIds, readTodoParentId } from './todo-tree.js';
import { logDelegationEvent } from './delegation-log.js';
import { cancelChatRun, lookupChatRunRequest, probeChatRunLiveness, startChatRun } from './chat-run-service.js';
import { listHarnessUsageLimits } from './harness-usage-limits.js';
import { isWorkspaceWatcherOrchestratorModelUsageLimited, resolveWorkspaceWatcherOrchestrator } from './workspace-watcher-orchestrator.js';
import { buildWorkspaceWatcherCyclePromptPlan } from './workspace-watcher-prompt.js';
import { broadcastWorkspaceWatcherChanged } from './workspace-watcher-live.js';
import { appendWorkspaceWatcherNotice } from './workspace-watcher-pinned-chat.js';
import {
  acquireWorkspaceWatcherLease,
  appendWorkspaceWatcherCycle,
  findWorkspaceWatcherCycle,
  findWorkspaceWatcherCycleBySlot,
  getWorkspaceWatcher,
  getWorkspaceWatcherActiveCycles,
  loadWorkspaceWatchers,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceFolder,
  releaseWorkspaceWatcherLease,
  removeWorkspaceWatcherCycle,
  replaceWorkspaceWatcherCycle,
  WORKSPACE_WATCHER_CYCLE_OUTCOMES,
  WORKSPACE_WATCHER_CYCLE_START_DEADLINE_MS,
  WORKSPACE_WATCHER_MAX_REPORTS,
  WORKSPACE_WATCHER_MAX_DECISIONS,
  workspaceWatcherCycleChatIds,
} from './persist/workspace-watchers-persist.js';
import {
  buildWorkspaceWatcherCycleClosePatch,
  buildWorkspaceWatcherCycleMetricCloseInput,
  hasActiveWorkspaceWatcherCycleChildren,
  loadPrimaryTodoForWorkspaceWatcherCycle,
  releaseWorkspaceWatcherCycleTodoClaim,
  resolveDeferredWorkspaceWatcherReports,
  resolveReportedTodoIdsForCycle,
  resolveWorkspaceWatcherCycleBlockedReasonCode,
  resolveWorkspaceWatcherCycleCloseOutcome,
  resolveWorkspaceWatcherCycleTodoOutcomesForClose,
} from './workspace-watcher-cycle-close.js';
import {
  beginWorkspaceWatcherCycleMetric,
  finalizeWorkspaceWatcherCycleMetric,
  markWorkspaceWatcherCycleMetricRunning,
  stampWorkspaceWatcherCycleMetricRequest,
} from './workspace-watcher-cycle-metrics.js';
import { MCP_ORCHESTRATOR_ERROR_CODE_LIST, readMcpOrchestratorRunErrorCode } from './mcp/mcp-orchestrator-contract.js';
import {
  claimWorkspaceTodo,
  describeWorkspaceWatcherDecision,
  isWorkspaceWatcherActiveCycleChatAlive,
  notifyWorkspaceWatcherDecision,
  releaseStaleWorkspaceTodoClaims,
  tickWorkspaceWatcher,
  WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS,
  WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN,
} from './workspace-watcher.js';
import {
  computeWorkspaceWatcherBackoffUntil,
  evaluateWorkspaceWatcherGuardrails,
  workspaceWatcherUtcDayKey,
} from './workspace-watcher-guardrails.js';
import { isWorktreeRecordLive } from './worktree/worktree-record.js';
import {
  describeWorktreePreparationError,
  prepareWorkspaceWatcherExecution,
} from './workspace-watcher-worktree.js';
import {
  getWorktreeIntegrationRecord,
  markTodoIntegrationReady,
  prepareWorktreeIntegrationResult,
} from './workspace-watcher-integration.js';

/** Startable decisions: a fresh cycle, or a planning-only cycle behind the gate. */
export const WORKSPACE_WATCHER_STARTABLE_KINDS = Object.freeze(['start_cycle', 'plan_gate']);

/**
 * How long a vanished orchestrator room must stay gone before autopilot
 * reconcile closes the cycle. Long enough for a child report to wake the
 * parent, short enough that a dead slot cannot pin `maxParallel` all day.
 */
export const WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS = 2 * 60 * 1000;

const ROOM_GONE_PROBE_REASONS = new Set(['state_missing', 'adapter_missing']);

/** @deprecated Use WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN */
const CYCLE_LEASE_TOKEN = WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN;

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
function describeError(error) {
  if (error && typeof error === 'object') {
    const code = String(/** @type {{ code?: unknown }} */ (error).code || '').trim();
    return { code: code || 'WORKSPACE_WATCHER_CYCLE', message: error instanceof Error ? error.message : String(error) };
  }
  return { code: 'WORKSPACE_WATCHER_CYCLE', message: String(error ?? 'unknown error') };
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function dataDirOf(options = {}) {
  // The tick resolves an empty dir to the process data directory. The start
  // must use that same directory, or it reads an empty todo file and reports
  // `todo_missing` for a leaf the tick just found.
  return String(options.dataDir ?? '').trim() || resolveDataPath();
}

/**
 * How many cycles one row may drive at the same time. `maxParallel` is capped on
 * write; this keeps an unnormalized row (a tick snapshot, a test fixture) at a
 * sane floor of 1 instead of 0, which would refuse every start.
 *
 * @param {object | null | undefined} row
 * @returns {number}
 */
function maxParallelOf(row) {
  return Math.max(1, Number(row?.policy?.maxParallel) || 1);
}

/**
 * Ordered identifiers the memory section should treat as "this cycle's" scope:
 * the picked todo, its ancestors, then the plan target (a subtree root) and its
 * ancestors. A missing record or a parent cycle ends the walk instead of
 * throwing, so a damaged tree never blocks a cycle.
 *
 * @param {{ todoId?: unknown, planTargetId?: unknown, items?: object[] }} [input]
 * @returns {string[]}
 */
export function collectWorkspaceWatcherPromptTodoIds(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const item of items) {
    const id = String(item?.id || '').trim();
    if (id && !byId.has(id)) byId.set(id, item);
  }
  /** @type {string[]} */
  const ids = [];
  const seen = new Set();
  /**
   * @param {unknown} raw
   * @returns {void}
   */
  const add = (raw) => {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  /**
   * @param {unknown} startId
   * @returns {void}
   */
  const addChain = (startId) => {
    let currentId = String(startId || '').trim();
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      add(currentId);
      const item = byId.get(currentId);
      if (!item) break;
      currentId = readTodoParentId(item);
    }
  };
  addChain(input.todoId);
  const planTargetId = String(input.planTargetId || '').trim();
  if (planTargetId) addChain(planTargetId);
  return ids;
}

export { resolveWorkspaceWatcherOrchestrator } from './workspace-watcher-orchestrator.js';
export { buildWorkspaceWatcherCyclePrompt } from './workspace-watcher-prompt.js';

/**
 * @param {{
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   watcherFolder?: string,
 *   now?: number,
 *   token?: string,
 * }} input
 * @returns {void}
 */
function clearCycleRow(input, cycleId, failureTodoId, baseMs, capMs, options = {}) {
  const dropPlanRequest = options.dropPlanRequest === true;
  const countFailure = options.countFailure !== false;
  const rollbackReserve = options.rollbackReserve === true;
  // planRequestKey is set when planApprovalScope:'root' stored the request under
  // a different id (the subtree root) than the picked leaf (failureTodoId).
  const planRequestKey = String(options.planRequestKey || '').trim() || failureTodoId;
  mutateWorkspaceWatcherRow(input.watcherFolder || input.workspaceFolder, ({ row }) => {
    const cycle = findWorkspaceWatcherCycle(row, { cycleId });
    if (!cycle) return false;
    const remaining = removeWorkspaceWatcherCycle(row, cycle);
    const patch = { ...remaining };
    const token = String(input.token || '').trim();
    // Only the last slot hands the workspace lease back. Rolling back one cycle
    // while a neighbour is still live must not let a second driver in.
    if (remaining.activeCycles.length === 0 && token && String(row.lease?.token || '') === token) {
      patch.lease = releaseWorkspaceWatcherLease(row, { token });
    }
    if (dropPlanRequest && planRequestKey) {
      const planRequests = { ...(row.planRequests || {}) };
      delete planRequests[planRequestKey];
      patch.planRequests = planRequests;
    }
    if (rollbackReserve) {
      const previousCycles = options.previousCycles && typeof options.previousCycles === 'object'
        ? options.previousCycles
        : { day: '', count: 0 };
      patch.cycles = {
        day: String(previousCycles.day ?? '').trim(),
        count: Math.max(0, Math.floor(Number(previousCycles.count) || 0)),
      };
      patch.lastCycleAt = String(options.previousLastCycleAt ?? '').trim();
    }
    if (failureTodoId && countFailure) {
      const failures = { ...row.failures, [failureTodoId]: (row.failures?.[failureTodoId] || 0) + 1 };
      patch.failures = failures;
      patch.backoffUntil = computeWorkspaceWatcherBackoffUntil({
        failures,
        now: input.now,
        baseMs,
        capMs,
      });
    }
    return patch;
  }, { dataDir: input.dataDir, createIfMissing: false });
  // The reservation is gone: close its metrics record as an abort. This is
  // telemetry — a failure is swallowed/logged by the wrapper and never changes
  // the rollback that already happened.
  finalizeWorkspaceWatcherCycleMetric({
    cycleId,
    workspaceFolder: input.watcherFolder || input.workspaceFolder,
    dataDir: input.dataDir,
    closedAt: new Date(Number.isFinite(input.now) ? input.now : Date.now()).toISOString(),
    closeSource: 'abort',
    closeOutcome: null,
    closeReason: String(options.metricCloseReason || '').trim() || 'start_aborted',
    todoStatusAtClose: 'unknown',
  }, options.metricsDeps);
}

/**
 * @param {{
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   cycleId: string,
 *   token: string,
 *   todoId: string,
 *   planOnly: boolean,
 *   now: number,
 *   usageLimits: object[],
 *   deps?: object,
 * }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function recheckWorkspaceWatcherCycleStartEligibility(input) {
  let abortReason = '';
  const result = mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row }) => {
    if (String(row.mode || '') !== 'autopilot') {
      abortReason = 'not_autopilot';
      return null;
    }
    if (row.enabled === false) {
      abortReason = 'disabled';
      return null;
    }
    if (row.paused === true) {
      abortReason = 'paused';
      return null;
    }
    if (String(row.stopReason || '').trim()) {
      abortReason = 'stopped';
      return null;
    }
    if (String(row.lease?.token || '') !== String(input.token || '')) {
      abortReason = 'lease_lost';
      return null;
    }
    const cycle = findWorkspaceWatcherCycle(row, { cycleId: input.cycleId });
    if (!cycle) {
      abortReason = 'cycle_changed';
      return null;
    }
    const loadTodosFn = typeof input.deps?.loadTodosData === 'function'
      ? input.deps.loadTodosData
      : loadTodosData;
    const doc = loadTodosFn(input.dataDir, input.workspaceFolder);
    const todo = (Array.isArray(doc?.items) ? doc.items : [])
      .find((row) => String(row?.id || '') === input.todoId) || null;
    if (!todo || !String(todo.updatedAt || '').trim()) {
      abortReason = 'todo_missing';
      return null;
    }
    if (String(todo.status || '') !== 'doing') {
      abortReason = 'todo_not_doing';
      return null;
    }
    if (String(todo.claimedByChatId || '') !== String(cycle.chatId || '')) {
      abortReason = 'claim_lost';
      return null;
    }
    const allowed = row.policy?.allowedHarnesses || [];
    if (allowed.length && !allowed.includes(input.orchestrator?.harness)) {
      abortReason = 'orchestrator_harness_not_allowed';
      return null;
    }
    if (isWorkspaceWatcherOrchestratorModelUsageLimited(input.orchestrator?.harness, input.orchestrator?.model, input.usageLimits)) {
      abortReason = 'orchestrator_usage_limited';
      return null;
    }
    {
      // This reservation already consumed one cycle and stamped lastCycleAt.
      // Re-evaluate the current policy without counting this very start twice.
      const planRequests = { ...row.planRequests };
      if (input.planOnly) {
        const planKey = String(input.planTargetId || '').trim() || input.todoId;
        delete planRequests[planKey];
      }
      const guard = evaluateWorkspaceWatcherGuardrails({
        watcher: {
          ...row, planRequests, lastCycleAt: input.previousLastCycleAt || '',
          cycles: { ...row.cycles, count: Math.max(0, (row.cycles?.count || 0) - 1) },
        },
        pickedTodo: todo,
        items: Array.isArray(doc?.items) ? doc.items : [],
        now: input.now,
        activeUsageLimits: input.usageLimits,
      });
      if (!guard.allowed) {
        abortReason = guard.reason || 'policy_blocked';
        return null;
      }
      if (guard.planOnly !== input.planOnly) {
        abortReason = 'policy_changed';
        return null;
      }
    }
    return false;
  }, { dataDir: input.dataDir, createIfMissing: false });
  if (abortReason) return { ok: false, reason: abortReason };
  if (result.ok) return { ok: true, reason: '' };
  if (result.reason === 'skipped') return { ok: true, reason: '' };
  return { ok: false, reason: result.reason || 'recheck_failed' };
}

/**
 * @param {{
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   cycleId: string,
 *   token: string,
 *   ttlMs: number,
 *   onTick?: () => void,
 * }} input
 * @returns {() => void}
 */
export function startWorkspaceWatcherStartingLeaseRenewal(input) {
  const renewMs = Math.max(5000, Math.min(Math.floor(input.ttlMs / 3), 30_000));
  const timer = setInterval(() => {
    try {
    if (typeof input.onTick === 'function') input.onTick();
    mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row }) => {
      const cycle = findWorkspaceWatcherCycle(row, { cycleId: input.cycleId });
      if (!cycle) return false;
      if (String(row.lease?.token || '') !== String(input.token || '')) return false;
      const leaseAttempt = acquireWorkspaceWatcherLease(row, {
        token: input.token,
        ttlMs: input.ttlMs,
        now: Date.now(),
      });
      if (!leaseAttempt.acquired) return false;
      if (String(cycle.phase || '') !== 'starting') {
        return { lease: leaseAttempt.lease };
      }
      return {
        lease: leaseAttempt.lease,
        ...replaceWorkspaceWatcherCycle(row, { cycleId: input.cycleId }, {
          ...cycle,
          startDeadlineAt: new Date(Date.now() + WORKSPACE_WATCHER_CYCLE_START_DEADLINE_MS).toISOString(),
        }),
      };
    }, { dataDir: input.dataDir, createIfMissing: false });
    } catch (error) {
      logDelegationEvent('workspace-watcher-lease-renewal-failed', {}, {
        workspaceFolder: input.workspaceFolder, cycleId: input.cycleId, ...describeError(error),
      });
    }
  }, renewMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/**
 * @param {unknown} error
 * @param {{ accepted?: boolean, runId?: string } | null} startResult
 * @returns {'rollback' | 'uncertain'}
 */
export function classifyWorkspaceWatcherCycleStartFailure(error, startResult) {
  const code = String(error && typeof error === 'object' && 'code' in error ? error.code : '').trim();
  if (['recipient_busy', 'adapter_unavailable', 'chat_not_found', 'prompt_required'].includes(code)) return 'rollback';
  if (startResult?.accepted === true || startResult?.uncertain === true) return 'uncertain';
  return 'rollback';
}

/**
 * Start one autopilot cycle from a tick that decided it may. Returns a small
 * result object; it never throws for a normal guard/claim refusal.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   now?: number,
 *   tick?: object,
 *   deps?: object,
 * }} [options]
 * @returns {Promise<{ started: boolean, reason: string, cycle?: object, error?: object }>}
 */
export async function startWorkspaceWatcherCycle(options = {}) {
  const dataDir = dataDirOf(options);
  if (!areWorkspaceWatcherStartsEnabled({ dataDir })) {
    return { started: false, reason: 'global_starts_disabled' };
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
  const tick = options.tick || {};
  const decision = tick.decision || {};
  if (!WORKSPACE_WATCHER_STARTABLE_KINDS.includes(String(decision.kind || ''))) {
    return { started: false, reason: 'not_startable' };
  }
  const todoId = String(decision.nextTodoId || '').trim();
  if (!todoId) return { started: false, reason: 'no_todo' };
  // With planApprovalScope:'root', the plan is generated for the subtree root,
  // not the picked leaf. planTargetId is set only when they differ.
  const planTargetId = String(decision.planTargetId || '').trim() || todoId;
  const watcher = tick.watcher || getWorkspaceWatcher(workspaceFolder, { dataDir });
  if (!watcher) return { started: false, reason: 'no_watcher' };
  if (String(watcher.mode || '') !== 'autopilot') return { started: false, reason: 'not_autopilot' };
  // Every slot is a cycle of this same workspace, so the cap is `maxParallel`
  // (external agents are a separate gate inside `decideWorkspaceWatcherAction`).
  if (getWorkspaceWatcherActiveCycles(watcher).length >= maxParallelOf(watcher)) {
    return { started: false, reason: 'cycle_active' };
  }

  // Resolve the picked leaf up front. A leaf without `updatedAt` cannot be
  // claimed with a CAS, so refuse instead of risking an unconditional write
  // over a todo that may have become doing/done in the meantime.
  const picked = (Array.isArray(tick.snapshot?.readyLeaves) ? tick.snapshot.readyLeaves : [])
    .find((row) => String(row?.id || '') === todoId) || null;
  if (!picked || !String(picked.updatedAt || '').trim()) {
    return { started: false, reason: picked ? 'stale_todo' : 'todo_not_ready' };
  }

  const deps = options.deps || {};
  const usageLimits = Array.isArray(deps.activeUsageLimits)
    ? deps.activeUsageLimits
    : safeListUsageLimits(dataDir);
  const token = String(options.token || '').trim() || CYCLE_LEASE_TOKEN;
  const cycleId = randomUUID();
  const chatId = randomUUID();
  const at = new Date(now).toISOString();
  const planOnly = decision.planOnly === true || decision.kind === 'plan_gate';
  const ttlMs = WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS;
  const backoffBaseMs = watcher?.policy?.backoffBaseMs;
  const backoffCapMs = watcher?.policy?.backoffCapMs;

  /** @type {string} */
  let reserveAbort = '';
  let previousLastCycleAt = '';
  /** @type {{ day: string, count: number }} */
  let previousCycles = { day: '', count: 0 };
  const reserve = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    if (!areWorkspaceWatcherStartsEnabled({ dataDir })) {
      reserveAbort = 'global_starts_disabled';
      return null;
    }
    const leaseAttempt = acquireWorkspaceWatcherLease(row, { token, ttlMs, now });
    if (!leaseAttempt.acquired) {
      reserveAbort = 'lease_held';
      return null;
    }
    if (getWorkspaceWatcherActiveCycles(row).length >= maxParallelOf(row)) {
      reserveAbort = 'cycle_active';
      return null;
    }
    if (String(row.mode || '') !== 'autopilot') {
      reserveAbort = 'not_autopilot';
      return null;
    }
    if (row.enabled === false) {
      reserveAbort = 'disabled';
      return null;
    }
    if (row.paused === true) {
      reserveAbort = 'paused';
      return null;
    }
    if (String(row.stopReason || '').trim()) {
      reserveAbort = 'stopped';
      return null;
    }
    const liveDoc = loadTodosData(dataDir, workspaceFolder);
    const liveTodo = (Array.isArray(liveDoc?.items) ? liveDoc.items : [])
      .find((row) => String(row?.id || '') === todoId) || null;
    if (!liveTodo || String(liveTodo.status || '') !== 'ready') {
      reserveAbort = liveTodo ? 'todo_not_ready' : 'todo_missing';
      return null;
    }
    if (String(liveTodo.updatedAt || '') !== String(picked.updatedAt || '')) {
      reserveAbort = 'stale_todo';
      return null;
    }
    const guard = evaluateWorkspaceWatcherGuardrails({
      watcher: row,
      pickedTodo: liveTodo,
      items: Array.isArray(liveDoc?.items) ? liveDoc.items : [],
      now,
      activeUsageLimits: usageLimits,
    });
    if (!guard.allowed) {
      reserveAbort = guard.reason || 'policy_blocked';
      return null;
    }
    if (guard.planOnly !== planOnly) {
      reserveAbort = 'plan_gate_mismatch';
      return null;
    }
    // Budget uses the UTC day, so the reset is deterministic across restarts.
    previousLastCycleAt = row.lastCycleAt || '';
    previousCycles = {
      day: String(row.cycles?.day ?? '').trim(),
      count: Math.max(0, Math.floor(Number(row.cycles?.count) || 0)),
    };
    const day = workspaceWatcherUtcDayKey(now);
    const cycles = String(row.cycles?.day || '') === day
      ? { day, count: (row.cycles?.count || 0) + 1 }
      : { day, count: 1 };
    /** @type {Record<string, string>} */
    const planRequests = { ...(row.planRequests || {}) };
    if (planOnly) planRequests[planTargetId] = at;
    return {
      lease: leaseAttempt.lease,
      ...appendWorkspaceWatcherCycle(row, {
        cycleId,
        todoIds: [todoId],
        startedAt: at,
        chatId,
        runId: '',
        phase: 'starting',
        startDeadlineAt: new Date(now + WORKSPACE_WATCHER_CYCLE_START_DEADLINE_MS).toISOString(),
        planOnly,
        mode: planOnly ? 'plan' : 'implement',
        ...(planOnly && planTargetId !== todoId ? { planTargetId } : {}),
      }),
      lastCycleAt: at,
      cycles,
      planRequests,
    };
  }, { dataDir, createIfMissing: false });

  if (!reserve.ok) {
    return { started: false, reason: reserveAbort || reserve.reason || 'reserve_failed' };
  }

  // Create the durable metrics record at reservation, before the model is even
  // resolved, so a start that never leaves `starting` is still counted. A store
  // failure is isolated by the wrapper and never aborts the cycle.
  beginWorkspaceWatcherCycleMetric({
    cycleId,
    workspaceFolder,
    dataDir,
    mode: planOnly ? 'plan' : 'implement',
    planOnly,
    orchestratorChatId: chatId,
    todoIds: [todoId],
    startedAt: at,
    phase: 'starting',
    now,
  }, deps);

  const claim = claimWorkspaceTodo({
    workspaceFolder,
    todoId,
    claimedByChatId: chatId,
    expectedUpdatedAt: picked.updatedAt,
    cycleId,
    dataDir,
    now,
  });
  if (!claim.claimed) {
    clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
      dropPlanRequest: planOnly, planRequestKey: planTargetId,
      countFailure: false,
      rollbackReserve: true,
      previousLastCycleAt,
      previousCycles,
    });
    logDelegationEvent('workspace-watcher-cycle-claim-failed', {}, {
      workspaceFolder,
      todoId,
      reason: claim.reason,
    });
    return { started: false, reason: `claim_${claim.reason || 'failed'}`, error: claim.error };
  }

  // `orchestratorChatId` stays a single field ("the last known orchestrator").
  // Per-cycle authorization uses `activeCycles[].chatId`, never this mirror.
  mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    if (!findWorkspaceWatcherCycle(row, { cycleId })) return false;
    return { orchestratorChatId: chatId };
  }, { dataDir, createIfMissing: false });
  // The claimed todo and its ancestors point at this cycle's orchestrator so a
  // later reader knows which (short-lived) chat owns the subtree.
  stampCycleOrchestratorOnTodoTree({ workspaceFolder, dataDir, todoId, chatId });

  const addChatFn = typeof deps.addChat === 'function' ? deps.addChat : addChat;
  const startRunFn = typeof deps.startChatRun === 'function' ? deps.startChatRun : startChatRun;
  const resolveOrchestrator = typeof deps.resolveWorkspaceWatcherOrchestrator === 'function'
    ? deps.resolveWorkspaceWatcherOrchestrator
    : resolveWorkspaceWatcherOrchestrator;
  const cancelRunFn = typeof deps.cancelChatRun === 'function' ? deps.cancelChatRun : cancelChatRun;
  const startRenewal = typeof deps.startStartingLeaseRenewal === 'function'
    ? deps.startStartingLeaseRenewal
    : startWorkspaceWatcherStartingLeaseRenewal;
  let stopRenewal = () => {};
  /** @type {{ accepted?: boolean, runId?: string } | null} */
  let startResult = null;
  let startAttempted = false;

  try {
    stopRenewal = startRenewal({
      workspaceFolder,
      dataDir,
      cycleId,
      token,
      ttlMs,
    });
    let orchestrator;
    try {
      orchestrator = await resolveOrchestrator({ watcher, workspaceFolder, activeUsageLimits: usageLimits, deps });
    } catch (error) {
      const described = describeError(error);
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planTargetId,
        countFailure: false,
        rollbackReserve: true,
        previousLastCycleAt,
        previousCycles,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      return { started: false, reason: 'orchestrator_error', error: described };
    }
    if (orchestrator.ok && orchestrator.modelSelection) {
      mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
        decisions: [...row.decisions, {
          at,
          kind: 'orchestrator_model_selected',
          reason: `${orchestrator.source || 'unknown'}${orchestrator.modelSelection.selected?.reason ? ` — ${orchestrator.modelSelection.selected.reason}` : ''}`,
          readyTodoCount: 0,
          activeAgentCount: 0,
          shouldNotify: false,
          nextTodoId: todoId,
          modelSelection: orchestrator.modelSelection,
        }].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
      }), { dataDir, createIfMissing: false });
    }
    if (orchestrator.ok) {
      // The pair is known now (reservation happened before the pick). Stamp it
      // so even a start that aborts before `running` records what was requested.
      stampWorkspaceWatcherCycleMetricRequest({
        cycleId,
        workspaceFolder,
        dataDir,
        requestedHarness: orchestrator.harness || null,
        requestedModel: orchestrator.model || null,
        requestedSource: orchestrator.source || null,
        now,
      }, deps);
    }
    if (!orchestrator.ok) {
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planTargetId,
        countFailure: false,
        rollbackReserve: true,
        previousLastCycleAt,
        previousCycles,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
        decisions: [
          ...row.decisions,
          {
            at,
            kind: 'orchestrator_blocked',
            reason: orchestrator.reason,
            readyTodoCount: 0,
            activeAgentCount: 0,
            shouldNotify: true,
            nextTodoId: todoId,
          },
        ],
      }), { dataDir, createIfMissing: false });
      const notify = typeof deps.notify === 'function' ? deps.notify : notifyWorkspaceWatcherDecision;
      notify({
        workspaceFolder,
        title: 'Cretli — workspace watcher',
        body: `No orchestrator model is available (${orchestrator.reason}). Check favorites, allow-list, and usage limits.`,
        tag: `cretli-watcher-${workspaceFolder}`,
        url: '/?panel=todos',
      }, deps.notifyDeps || {});
      logDelegationEvent('workspace-watcher-orchestrator-blocked', {}, {
        workspaceFolder,
        todoId,
        reason: orchestrator.reason,
      });
      appendWorkspaceWatcherNotice({
        workspaceFolder,
        dataDir,
        action: 'alert',
        level: 'error',
        text: `No orchestrator model is available (${orchestrator.reason}). Check favorites, allow-list, and usage limits.`,
        todoId,
        at,
        deps: deps.noticeDeps || {},
      });
      return { started: false, reason: 'orchestrator_unavailable', error: { code: orchestrator.reason, message: orchestrator.reason } };
    }
    const recheck = recheckWorkspaceWatcherCycleStartEligibility({
      workspaceFolder,
      dataDir,
      cycleId,
      token,
      todoId,
      planTargetId,
      planOnly,
      now: Number.isFinite(options.now) ? now : Date.now(),
      usageLimits: Array.isArray(deps.activeUsageLimits) ? usageLimits : safeListUsageLimits(dataDir),
      previousLastCycleAt,
      orchestrator,
      deps,
    });
    if (!recheck.ok) {
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planTargetId,
        countFailure: false,
        rollbackReserve: true,
        previousLastCycleAt,
        previousCycles,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      logDelegationEvent('workspace-watcher-cycle-aborted', {}, {
        workspaceFolder,
        todoId,
        cycleId,
        reason: recheck.reason,
      });
      return { started: false, reason: `aborted_${recheck.reason}` };
    }
    // Execution folder: resolve the per-leaf override against the watcher
    // default, create/reuse the worktree and run the explicit prepare step. A
    // failure here is a preflight failure — roll back the claim/reservation, keep
    // any created worktree, and never fall back to the project folder (S6/S10).
    const loadTodosFn = typeof deps.loadTodosData === 'function' ? deps.loadTodosData : loadTodosData;
    const modeItems = loadTodosFn(dataDir, workspaceFolder)?.items || [];
    const liveTodoForMode = modeItems.find((row) => String(row?.id || '') === todoId) || picked;
    let preparedExecution = { mode: 'project', executionFolder: workspaceFolder, record: null };
    try {
      preparedExecution = await prepareWorkspaceWatcherExecution({
        todoId,
        workspaceFolder,
        todo: liveTodoForMode,
        policy: watcher?.policy,
        dataDir,
        cycleId,
        chatId,
        planOnly,
        // Derive and persist a missing layout from the workspace itself so an
        // autopilot cycle is not dead-ended on unconfigured per-workspace settings.
        allowSuggestedLayout: true,
        // D1: a manual start keys the tree by its ROOT. When an ancestor already
        // holds a live worktree, refuse instead of creating a second one.
        lineageTodoIds: collectTodoAncestorIds(modeItems, todoId),
        deps,
      });
    } catch (error) {
      const described = describeWorktreePreparationError(error);
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planTargetId,
        countFailure: false,
        rollbackReserve: true,
        previousLastCycleAt,
        previousCycles,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
        decisions: [...row.decisions, {
          at,
          kind: 'worktree_prepare_failed',
          reason: described.message,
          readyTodoCount: 0,
          activeAgentCount: 0,
          shouldNotify: true,
          nextTodoId: todoId,
        }].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
      }), { dataDir, createIfMissing: false });
      logDelegationEvent('workspace-watcher-worktree-prepare-failed', {}, {
        workspaceFolder,
        todoId,
        cycleId,
        ...described,
      });
      const notify = typeof deps.notify === 'function' ? deps.notify : notifyWorkspaceWatcherDecision;
      notify({
        workspaceFolder,
        title: 'Cretli — workspace watcher',
        body: `Could not prepare the worktree for "${picked?.title || todoId}": ${described.message}`,
        tag: `cretli-watcher-${workspaceFolder}`,
        url: '/?panel=todos',
      }, deps.notifyDeps || {});
      appendWorkspaceWatcherNotice({
        workspaceFolder,
        dataDir,
        action: 'alert',
        level: 'error',
        text: `Could not prepare the worktree for "${picked?.title || todoId}": ${described.message}`,
        todoId,
        at,
        deps: deps.noticeDeps || {},
      });
      return { started: false, reason: 'worktree_prepare_failed', error: described };
    }
    // Durable facts from earlier cycles. A damaged memory file must never block
    // a cycle, so a read failure degrades to "no memory" instead of aborting.
    let memory = [];
    try {
      memory = listWorkspaceMemory(workspaceFolder, { dataDir, now });
    } catch {
      memory = [];
    }
    // Relevance scope for the memory section: the picked todo, its ancestors and
    // the plan target (subtree root) + its ancestors, in that order.
    let promptTodoItems = [];
    try {
      promptTodoItems = loadTodosFn(dataDir, workspaceFolder)?.items || [];
    } catch {
      promptTodoItems = [];
    }
    const promptTodoIds = collectWorkspaceWatcherPromptTodoIds({
      todoId,
      planTargetId,
      items: promptTodoItems,
    });
    // A test/ops seam for the whole-prompt budget; production uses the default.
    const promptCharBudget = Number.isFinite(Number(deps.promptCharBudget)) && Number(deps.promptCharBudget) > 0
      ? Math.floor(Number(deps.promptCharBudget))
      : undefined;
    const promptPlan = buildWorkspaceWatcherCyclePromptPlan({
      workspaceFolder,
      watcher,
      decision: { ...decision, planOnly, planTargetId: planTargetId !== todoId ? planTargetId : undefined },
      todo: picked,
      orchestrator: { harness: orchestrator.harness, model: orchestrator.model, source: orchestrator.source },
      activeUsageLimits: usageLimits,
      previousChats: watcher.cycleChats,
      memory,
      todoIds: promptTodoIds,
      maxChars: promptCharBudget,
      cycleId,
      chatId,
      executionMode: preparedExecution.mode,
    });
    if (promptPlan.tooLong) {
      // The full contract cannot be shortened. Refuse the start before the chat
      // exists: roll the reservation and the claim back without counting a
      // failure or arming backoff, and leave a durable reason behind.
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planTargetId,
        countFailure: false,
        rollbackReserve: true,
        previousLastCycleAt,
        previousCycles,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
        decisions: [...row.decisions, {
          at,
          kind: 'prompt_too_long',
          reason: `prompt contract ${promptPlan.contractChars} > budget ${promptPlan.maxChars}`,
          readyTodoCount: 0,
          activeAgentCount: 0,
          shouldNotify: true,
          nextTodoId: todoId,
        }].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
      }), { dataDir, createIfMissing: false });
      logDelegationEvent('workspace-watcher-prompt-too-long', {}, {
        workspaceFolder,
        todoId,
        cycleId,
        contractChars: promptPlan.contractChars,
        maxChars: promptPlan.maxChars,
      });
      appendWorkspaceWatcherNotice({
        workspaceFolder,
        dataDir,
        action: 'alert',
        level: 'error',
        text: `Cycle not started: the orchestration contract needs ${promptPlan.contractChars} chars but the prompt budget is ${promptPlan.maxChars}. Shorten the workspace path or todo metadata.`,
        todoId,
        at,
        deps: deps.noticeDeps || {},
      });
      return {
        started: false,
        reason: 'prompt_too_long',
        error: {
          code: 'prompt_too_long',
          message: `prompt contract is ${promptPlan.contractChars} chars, budget ${promptPlan.maxChars}`,
        },
      };
    }
    const prompt = promptPlan.prompt;
    // Model resolution is asynchronous. Re-check the durable global gate at
    // the final launch boundary so a maintenance toggle can drain cleanly.
    if (!areWorkspaceWatcherStartsEnabled({ dataDir })) {
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly,
        planRequestKey: planTargetId,
        countFailure: false,
        rollbackReserve: true,
        previousLastCycleAt,
        previousCycles,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      return { started: false, reason: 'global_starts_disabled' };
    }
    const transport = orchestrator.harness || undefined;
    // A cycle's orchestrator chat is created through `addChat`, which broadcasts its own
    // `chatsChanged { reason: 'create' }` frame. The watcher's live frame only announces
    // watcher state, so the client can ignore it without reloading the chat list.
    const created = addChatFn(cycleId, `[Watcher] ${String(picked?.title || 'Cycle').slice(0, 100)}`,
      options.workspaceFile || null, workspaceFolder, orchestrator.model || undefined, {
        id: chatId,
        agentTransport: transport,
        sdkMode: 'agent',
        todoId,
        pickPurpose: 'watcher-orchestrator',
        // Freeze the prepared execution folder on the orchestrator chat so its
        // delegated implement/review/fix children inherit the same worktree.
        ...(preparedExecution.mode === 'worktree'
          ? { executionFolder: preparedExecution.executionFolder || undefined }
          : {}),
      });
    startAttempted = true;
    startResult = await startRunFn({
      chatId: created?.id || chatId,
      prompt,
      mode: 'agent',
      requestId: cycleId,
      displayText: prompt,
      deps: {
        ...(deps.chatRunDeps || {}),
        watcherCycleId: cycleId,
        watcherPlanOnly: planOnly,
      },
    });
    const runId = String(startResult?.runId || '').trim();
    const finalized = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
      const cycle = findWorkspaceWatcherCycle(row, { cycleId });
      if (!cycle) return false;
      if (row.lease?.token !== token || row.mode !== 'autopilot' || row.enabled === false || String(row.stopReason || '').trim()) return false;
      return replaceWorkspaceWatcherCycle(row, { cycleId }, {
        ...cycle,
        runId,
        phase: 'running',
        startDeadlineAt: '',
        // Record the orchestrator harness that actually ran the cycle so the
        // closed cycleChats entry (and thus the dashboard detail) can show it.
        harness: String(orchestrator.harness || ''),
        requestedHarness: orchestrator.harness == null ? null : String(orchestrator.harness).trim() || null,
        requestedModel: orchestrator.model == null ? null : String(orchestrator.model).trim() || null,
        requestedSource: orchestrator.source == null ? null : String(orchestrator.source).trim() || null,
      });
    }, { dataDir, createIfMissing: false });
    const liveCycle = finalized.ok ? findWorkspaceWatcherCycle(finalized.row, { cycleId }) : null;
    if (finalized.ok && liveCycle) {
      markWorkspaceWatcherCycleMetricRunning({
        cycleId,
        workspaceFolder,
        dataDir,
        orchestratorRunId: runId || null,
        harness: String(orchestrator.harness || '').trim() || null,
        now,
      }, deps);
    }
    if (!finalized.ok || !liveCycle) {
      if (runId) {
        await cancelRunFn({ chatId, runId }).catch(() => {});
      }
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planTargetId,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      return { started: false, reason: 'cycle_vanished' };
    }
    logDelegationEvent('workspace-watcher-cycle-started', {}, {
      workspaceFolder,
      todoId,
      cycleId,
      chatId,
      runId,
      planOnly,
    });
    appendWorkspaceWatcherNotice({
      workspaceFolder,
      dataDir,
      action: planOnly ? 'plan_gate' : 'cycle_start',
      level: 'info',
      text: `${planOnly ? 'Plan cycle' : 'Cycle'} started for todo ${todoId.slice(0, 8)}${picked?.title ? ` — ${picked.title}` : ''}.`,
      todoId,
      cycleId,
      chatId,
      at,
      deps: deps.noticeDeps || {},
    });
    broadcastWorkspaceWatcherChanged({ workspaceFolder });
    return {
      started: true,
      reason: planOnly ? 'plan_cycle_started' : 'cycle_started',
      cycle: liveCycle,
    };
  } catch (error) {
    const described = describeError(error);
    if (startAttempted && !startResult) {
      const lookup = typeof deps.lookupChatRunRequest === 'function' ? deps.lookupChatRunRequest : lookupChatRunRequest;
      const probe = typeof deps.probeChatRunLiveness === 'function' ? deps.probeChatRunLiveness : probeChatRunLiveness;
      try {
        const found = lookup({ chatId, requestId: cycleId });
        if (found?.accepted === true) startResult = found;
        else {
          const live = probe({ chatId });
          if (live?.busy === true) startResult = { accepted: true };
          else if (live?.known !== true && live?.reason !== 'chat_missing') startResult = { uncertain: true };
        }
      } catch {
        // A failed lookup cannot prove the adapter rejected the start.
        startResult = { uncertain: true };
      }
    }
    const classify = typeof deps.classifyStartFailure === 'function'
      ? deps.classifyStartFailure
      : classifyWorkspaceWatcherCycleStartFailure;
    if (classify(error, startResult) === 'uncertain') {
      const runId = String(startResult?.runId ?? '').trim();
      mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
        const cycle = findWorkspaceWatcherCycle(row, { cycleId });
        if (!cycle) return false;
        return {
          ...replaceWorkspaceWatcherCycle(row, { cycleId }, {
            ...cycle,
            runId: runId || cycle.runId || '',
            phase: 'starting',
          }),
          stopReason: String(row.stopReason || '').trim() || 'cycle_start_uncertain',
        };
      }, { dataDir, createIfMissing: false });
      logDelegationEvent('workspace-watcher-cycle-start-uncertain', {}, {
        workspaceFolder,
        todoId,
        cycleId,
        runId,
        ...described,
      });
      return { started: false, reason: 'start_uncertain', error: described };
    }
    clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
      dropPlanRequest: planOnly, planRequestKey: planTargetId,
    });
    releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
    logDelegationEvent('workspace-watcher-cycle-start-failed', {}, {
      workspaceFolder,
      todoId,
      cycleId,
      ...described,
    });
    const notify = typeof deps.notify === 'function' ? deps.notify : notifyWorkspaceWatcherDecision;
    notify({
      workspaceFolder,
      title: 'Cretli — workspace watcher',
      body: `Could not start the autopilot cycle for "${picked?.title || todoId}": ${described.message}`,
      tag: `cretli-watcher-${workspaceFolder}`,
      url: '/?panel=todos',
    }, deps.notifyDeps || {});
    appendWorkspaceWatcherNotice({
      workspaceFolder,
      dataDir,
      action: 'alert',
      level: 'error',
      text: `Could not start the autopilot cycle for "${picked?.title || todoId}": ${described.message}`,
      todoId,
      at,
      deps: deps.noticeDeps || {},
    });
    return { started: false, reason: 'start_failed', error: described };
  } finally {
    stopRenewal();
  }
}

/**
 * @param {string} dataDir
 * @returns {object[]}
 */
function safeListUsageLimits(dataDir) {
  try {
    return listHarnessUsageLimits(dataDir);
  } catch {
    return [];
  }
}

/**
 * Stamp the orchestrator chat on the claimed todo and every ancestor so the
 * subtree knows which short-lived chat drives this cycle. Best-effort: an item
 * that moved on (CAS miss) is left untouched and never aborts the start.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, todoId: string, chatId: string }} input
 * @returns {void}
 */
export function stampCycleOrchestratorOnTodoTree(input) {
  const chatId = String(input?.chatId || '').trim();
  const todoId = String(input?.todoId || '').trim();
  if (!chatId || !todoId) return;
  try {
    const doc = loadTodosData(input.dataDir, input.workspaceFolder);
    const items = Array.isArray(doc?.items) ? doc.items : [];
    const byId = new Map(items.map((row) => [String(row?.id || ''), row]));
    const seen = new Set();
    let current = byId.get(todoId) || null;
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      if (String(current.orchestratorChatId || '') !== chatId) {
        try {
          updateTodo(input.dataDir, input.workspaceFolder, String(current.id), {
            orchestratorChatId: chatId,
            expectedUpdatedAt: current.updatedAt,
          });
        } catch {
          // A concurrent edit owns the item; the claim itself is unaffected.
        }
      }
      const parentId = readTodoParentId(current);
      current = parentId ? byId.get(String(parentId)) || null : null;
    }
  } catch {
    // Todo bookkeeping must never abort a cycle start.
  }
}

export {
  buildWorkspaceWatcherCycleClosePatch,
  hasActiveWorkspaceWatcherCycleChildren,
  shouldCountWorkspaceWatcherCycleIncomplete,
} from './workspace-watcher-cycle-close.js';

/**
 * Record the durable outcome of one cycle and close it when no child delegation
 * still holds the slot.
 *
 * Identity is enforced here: only the chat that owns the active cycle may
 * report it, a foreign chat is rejected, and the same report (same reportId, or
 * the same cycleId after close) is an idempotent replay. A report that arrives
 * while a child delegation is still live is recorded on the active cycle but
 * does not close it, so the live child never loses its todo claim; reconcile
 * closes it later using the recorded outcome.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   sourceChatId?: string,
 *   outcome?: string,
 *   todoIds?: string[],
 *   cycleId?: string,
 *   reportId?: string,
 *   message?: string,
 *   now?: number,
 *   deps?: object,
 * }} [options]
 * @returns {{ ok: boolean, reason: string, report?: object, deferred?: boolean, replayed?: boolean, closed?: boolean }}
 */
export function reportWorkspaceWatcherCycle(options = {}) {
  const dataDir = dataDirOf(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
  if (!workspaceFolder) return { ok: false, reason: 'no_workspace' };
  const sourceChatId = String(options.sourceChatId || '').trim();
  if (!sourceChatId) return { ok: false, reason: 'no_chat' };
  const outcome = String(options.outcome || '').trim().toLowerCase();
  if (!WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(outcome)) {
    return { ok: false, reason: 'invalid_outcome' };
  }
  const requestedCycleId = String(options.cycleId || '').trim();
  const requestedReportId = String(options.reportId || '').trim();
  const requestedTodoIds = Array.isArray(options.todoIds)
    ? options.todoIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const deps = options.deps || {};
  const loadDelegationsFn = typeof deps.loadDelegations === 'function' ? deps.loadDelegations : loadDelegations;

  let abortReason = '';
  let replayed = false;
  let deferred = false;
  let closed = false;
  /** @type {object | null} */
  let reportEntry = null;
  /** @type {object | null} */
  let closedCycle = null;
  /** @type {object | null} */
  let closedTodo = null;
  /** @type {object | null} */
  let closedLeafOutcomes = null;
  let closedOutcome = null;
  let closedReason = '';

  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    const cycles = getWorkspaceWatcherActiveCycles(row);
    const reports = Array.isArray(row.reports) ? row.reports : [];
    if (!cycles.length) {
      const past = reports.find((entry) => (
        (requestedReportId && String(entry?.reportId || '') === requestedReportId)
        || (requestedCycleId && String(entry?.cycleId || '') === requestedCycleId)
      ));
      if (past) {
        replayed = true;
        reportEntry = past;
        return false;
      }
      abortReason = 'no_cycle';
      return null;
    }
    // Ownership first: the reporting chat must own one of the live slots. This
    // is the per-cycle form of the v1 "only the active cycle's orchestrator may
    // report", so a sibling cycle can never be closed by the wrong chat.
    const owned = findWorkspaceWatcherCycle(row, { chatId: sourceChatId });
    if (!owned) {
      abortReason = 'not_orchestrator';
      return null;
    }
    const cycle = requestedCycleId && String(owned.cycleId || '') !== requestedCycleId
      ? null
      : owned;
    if (!cycle) {
      abortReason = 'cycle_mismatch';
      return null;
    }
    const reportId = requestedReportId || `cycle:${String(cycle.cycleId || '')}`;
    const existing = reports.find((entry) => String(entry?.reportId || '') === reportId);
    if (existing && existing.deferred !== true) {
      replayed = true;
      reportEntry = existing;
      return false;
    }
    const todoIds = requestedTodoIds.length ? requestedTodoIds : (cycle.todoIds || []).map(String);
    const at = new Date(now).toISOString();
    const childActive = hasActiveWorkspaceWatcherCycleChildren(String(cycle.chatId || ''), loadDelegationsFn());
    reportEntry = {
      reportId,
      cycleId: String(cycle.cycleId || ''),
      chatId: sourceChatId,
      outcome,
      todoIds,
      at,
      deferred: childActive,
      message: String(options.message || '').trim().slice(0, 500),
    };
    const nextReports = existing
      ? reports.map((entry) => (String(entry?.reportId || '') === reportId ? reportEntry : entry))
      : [...reports, reportEntry];
    const boundedReports = nextReports.slice(-WORKSPACE_WATCHER_MAX_REPORTS);
    if (childActive) {
      deferred = true;
      return {
        reports: boundedReports,
        ...replaceWorkspaceWatcherCycle(row, { cycleId: cycle.cycleId, chatId: cycle.chatId }, {
          ...cycle,
          reportedOutcome: outcome,
          reportedAt: at,
          reportId,
        }),
      };
    }
    const todo = loadPrimaryTodoForWorkspaceWatcherCycle({ workspaceFolder, dataDir, cycle, row });
    const primaryTodoId = String(cycle.todoIds?.[0] || '').trim();
    // A verified worktree PASS keeps the todo `doing` and records the diff
    // instead of returning it to the ready pool (contract §8.3, S11–S14). The
    // close outcome is told about it so an integration-ready leaf is not
    // mistaken for an incomplete cycle; the result is persisted below.
    let integrationCandidate = false;
    if (String(outcome) === 'success' && cycle.planOnly !== true && primaryTodoId) {
      try {
        const record = getWorktreeIntegrationRecord(primaryTodoId, dataDir);
        integrationCandidate = Boolean(
          record
          && isWorktreeRecordLive(record)
          && record.creationState === 'ready'
          && record.executionState === 'active',
        );
      } catch {
        integrationCandidate = false;
      }
    }
    const leafOutcomes = resolveWorkspaceWatcherCycleTodoOutcomesForClose({
      cycle,
      workspaceFolder,
      dataDir,
      reportedTodoIds: todoIds,
    });
    const { closeOutcome, closeReason } = resolveWorkspaceWatcherCycleCloseOutcome({
      cycle,
      row,
      todo,
      reportedOutcomeRaw: outcome,
      leafOutcomes,
      integrationReady: integrationCandidate,
    });
    let finalOutcome = closeOutcome;
    let finalReason = closeReason;
    if (finalOutcome === 'success' && integrationCandidate && primaryTodoId) {
      try {
        const record = getWorktreeIntegrationRecord(primaryTodoId, dataDir);
        const prepared = prepareWorktreeIntegrationResult({
          todoId: primaryTodoId,
          cycleId: String(cycle.cycleId || ''),
          workspaceFolder,
          dataDir,
          record,
          outcome,
          reportedOutcome: outcome,
          reviewOutcome: 'PASS',
          reviewVerified: true,
          testOutcome: 'passed',
          testEvidence: 'Workspace Watcher cycle close',
          now: at,
          deps,
        });
        markTodoIntegrationReady({
          todoId: primaryTodoId,
          workspaceFolder,
          cycleId: String(cycle.cycleId || ''),
          result: prepared,
          dataDir,
          now: at,
        });
      } catch (error) {
        // The result could not be recorded, so this must not close as a PASS
        // (S18). The worktree is preserved for a retry.
        finalOutcome = 'failure';
        finalReason = 'integration_result_failed';
        logDelegationEvent('workspace-watcher-integration-result-failed', {}, {
          workspaceFolder,
          todoId: primaryTodoId,
          cycleId: String(cycle.cycleId || ''),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    closed = true;
    closedCycle = cycle;
    closedTodo = todo;
    closedLeafOutcomes = leafOutcomes;
    closedOutcome = finalOutcome;
    closedReason = finalReason;
    return buildWorkspaceWatcherCycleClosePatch({
      row: { ...row, reports: boundedReports },
      cycle,
      outcome: finalOutcome,
      decisionReason: finalReason,
      todoIds,
      reports: boundedReports,
      now,
      at,
      closeSource: 'report',
      workspaceFolder,
      dataDir,
      todo,
    });
  }, { dataDir, createIfMissing: false });

  if (replayed) return { ok: true, reason: 'replayed', replayed: true, report: reportEntry };
  if (abortReason) return { ok: false, reason: abortReason };
  if (deferred) return { ok: true, reason: 'deferred_children_active', deferred: true, report: reportEntry };
  if (closed && result.ok) {
    // Durable per-cycle metric. Idempotent by cycleId, so a replay (already
    // handled above) or a duplicate close can never create a second record.
    finalizeWorkspaceWatcherCycleMetric({
      ...buildWorkspaceWatcherCycleMetricCloseInput({
        cycle: closedCycle || {},
        workspaceFolder,
        closedAt: String(reportEntry?.at || new Date(now).toISOString()),
        closeSource: 'report',
        closeReason: String(closedReason || closedOutcome || outcome || '').trim() || 'missing_report',
        closeOutcome: closedOutcome,
        reportedOutcome: outcome,
        reportedTodoIds: reportEntry?.todoIds,
        leafOutcomes: closedLeafOutcomes,
        blockedReasonCode: resolveWorkspaceWatcherCycleBlockedReasonCode({
          closeOutcome: closedOutcome,
          closeReason: closedReason,
          planOnly: closedCycle?.planOnly === true,
          planSaved: closedLeafOutcomes?.planSaved === true,
          todoOutcomes: closedLeafOutcomes?.todoOutcomes,
        }),
        todo: closedTodo,
      }),
      dataDir,
      now,
    }, deps);
    // The cycle is over and its children are terminal, so the claim it created
    // may be released. `releaseWorkspaceWatcherCycleTodoClaim` only touches the
    // todo when this chat still owns the claim, so a newer owner is never disturbed.
    const primaryTodoId = String(reportEntry?.todoIds?.[0] || '').trim();
    if (primaryTodoId) {
      const reportTodo = loadPrimaryTodoForWorkspaceWatcherCycle({
        workspaceFolder,
        dataDir,
        cycle: { cycleId: reportEntry?.cycleId, chatId: sourceChatId, todoIds: reportEntry?.todoIds },
        row: getWorkspaceWatcher(workspaceFolder, { dataDir }),
      });
      releaseWorkspaceWatcherCycleTodoClaim({
        workspaceFolder,
        todoId: primaryTodoId,
        chatId: sourceChatId,
        cycleId: String(reportEntry?.cycleId || ''),
        attemptId: String(reportTodo?.execution?.attemptId || ''),
        dataDir,
        now,
      });
    }
    logDelegationEvent('workspace-watcher-cycle-reported', {}, {
      workspaceFolder,
      cycleId: reportEntry?.cycleId,
      outcome,
      todoIds: reportEntry?.todoIds,
    });
    const primaryTodo = String(reportEntry?.todoIds?.[0] || '').trim();
    const noticeAction = outcome === 'success'
      ? 'todo_done'
      : outcome === 'blocked' ? 'cycle_blocked' : 'cycle_failure';
    const noticeLevel = outcome === 'success'
      ? 'success'
      : outcome === 'blocked' ? 'warn' : 'error';
    appendWorkspaceWatcherNotice({
      workspaceFolder,
      dataDir,
      action: noticeAction,
      level: noticeLevel,
      text: outcome === 'success'
        ? `Todo ${primaryTodo.slice(0, 8)} completed.`
        : `Cycle ${reportEntry?.cycleId ? String(reportEntry.cycleId).slice(0, 8) : ''} reported ${outcome}${primaryTodo ? ` for todo ${primaryTodo.slice(0, 8)}` : ''}${reportEntry?.message ? `: ${reportEntry.message}` : ''}.`,
      todoId: primaryTodo,
      cycleId: reportEntry?.cycleId,
      chatId: sourceChatId,
      at: reportEntry?.at,
      deps: deps.noticeDeps || {},
    });
    broadcastWorkspaceWatcherChanged({ workspaceFolder });
    // Archive the orchestrator chat so finished cycles don't clutter the
    // sidebar — but only through the shared canArchive gate, which also
    // archives its terminal delegated children first and refuses the whole
    // portfolio while any child still holds a slot or the parent is pinned.
    if (sourceChatId) {
      try { archiveChatFamily(sourceChatId, { now, deps }); } catch { /* best-effort */ }
    }
    return { ok: true, reason: 'reported', closed: true, report: reportEntry };
  }
  return { ok: false, reason: result.reason || 'report_failed' };
}

/**
 * Close dead cycles of one workspace, each independently: a live sibling keeps
 * its claim, its lease and its slot. Returns the first closed cycle.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   now?: number,
 *   deps?: object,
 * }} [options]
 * @returns {{ closed: boolean, reason: string, cycle?: object, closedCount?: number }}
 */
export function reconcileWorkspaceWatcherCycle(options = {}) {
  const dataDir = dataDirOf(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
  const deps = options.deps || {};
  const initial = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const cycles = getWorkspaceWatcherActiveCycles(initial);
  if (!cycles.length) return { closed: false, reason: 'no_cycle' };
  const probe = typeof deps.probeChatRunLiveness === 'function' ? deps.probeChatRunLiveness : probeChatRunLiveness;
  const childChats = typeof deps.loadDelegations === 'function' ? deps.loadDelegations() : loadDelegations();
  const slots = cycles.slice();
  /** @type {object | null} */
  let firstClosed = null;
  let closedCount = 0;
  let lastReason = 'no_cycle';
  for (const expected of slots) {
    // Re-read per slot: closing one cycle rewrites the row (lease, failures,
    // backoff, plan requests) that the next slot's outcome is judged against.
    const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
    const cycle = row ? findWorkspaceWatcherCycleBySlot(row, expected) : null;
    if (!cycle) continue;
    const one = reconcileWorkspaceWatcherCycleSlot({
      workspaceFolder, dataDir, now, deps, probe, childChats, row, cycle,
    });
    lastReason = one.reason;
    if (!one.closed) continue;
    closedCount += 1;
    if (!firstClosed) firstClosed = one.cycle;
  }
  if (!closedCount) return { closed: false, reason: lastReason };
  return { closed: true, reason: 'cycle_closed', cycle: firstClosed, closedCount };
}

/**
 * `known: false` with a reason that means the room itself is absent.
 * `adapter_error`, `run_mismatch` and `probe_failed` are not in this set.
 *
 * @param {object | null | undefined} live
 * @returns {boolean}
 */
function isRoomGoneProbe(live) {
  return Boolean(live)
    && live.known === false
    && ROOM_GONE_PROBE_REASONS.has(String(live.reason || ''));
}

/**
 * The orchestrator room is gone only when the run-scoped probe and a second
 * probe without `runId` both say so. A run-scoped `state_missing` alone can
 * mean the room is busy on a newer run.
 *
 * @param {object} cycle
 * @param {Function} probe
 * @returns {boolean}
 */
function isWorkspaceWatcherCycleRoomGone(cycle, probe) {
  const chatId = String(cycle?.chatId || '').trim();
  if (!chatId || typeof probe !== 'function') return false;
  const runId = String(cycle?.runId || '').trim();
  const withRun = probe({ chatId, ...(runId ? { runId } : {}) });
  if (!isRoomGoneProbe(withRun)) return false;
  const withoutRun = probe({ chatId });
  return isRoomGoneProbe(withoutRun);
}

/**
 * Starting phase still inside its deadline is not a dead room, even when the
 * adapter has not published state yet.
 *
 * @param {object} cycle
 * @param {number} now
 * @returns {boolean}
 */
function isWorkspaceWatcherCycleStartProtected(cycle, now) {
  const phase = String(cycle?.phase || '').trim().toLowerCase();
  const startDeadlineAt = Date.parse(String(cycle?.startDeadlineAt || '').trim());
  return phase === 'starting' && Number.isFinite(startDeadlineAt) && now < startDeadlineAt;
}

/**
 * @param {object} cycle
 * @param {number} now
 * @returns {boolean}
 */
function isWorkspaceWatcherRoomGoneGraceElapsed(cycle, now) {
  const since = Date.parse(String(cycle?.roomGoneSince || '').trim());
  if (!Number.isFinite(since)) return false;
  return now - since >= WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS;
}

/**
 * Remember the first observation that the room is gone. A later reconcile
 * closes only after {@link WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS}.
 *
 * @param {{ workspaceFolder: string, dataDir: string, now: number, cycle: object, probe: Function }} input
 * @returns {void}
 */
function stampWorkspaceWatcherRoomGone(input) {
  const at = new Date(input.now).toISOString();
  mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row: current }) => {
    const currentCycle = findWorkspaceWatcherCycleBySlot(current, input.cycle);
    if (!currentCycle) return false;
    if (String(currentCycle.roomGoneSince || '').trim()) return false;
    if (!isWorkspaceWatcherCycleRoomGone(currentCycle, input.probe)) return false;
    return replaceWorkspaceWatcherCycle(
      current,
      { cycleId: currentCycle.cycleId, chatId: currentCycle.chatId },
      { ...currentCycle, roomGoneSince: at },
    );
  }, { dataDir: input.dataDir, createIfMissing: false });
}

/**
 * Drop a stale grace stamp so the next absence starts the window again.
 *
 * @param {{ workspaceFolder: string, dataDir: string, cycle: object }} input
 * @returns {void}
 */
function clearWorkspaceWatcherRoomGone(input) {
  mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row: current }) => {
    const currentCycle = findWorkspaceWatcherCycleBySlot(current, input.cycle);
    if (!currentCycle || !String(currentCycle.roomGoneSince || '').trim()) return false;
    const nextCycle = { ...currentCycle };
    delete nextCycle.roomGoneSince;
    return replaceWorkspaceWatcherCycle(
      current,
      { cycleId: currentCycle.cycleId, chatId: currentCycle.chatId },
      nextCycle,
    );
  }, { dataDir: input.dataDir, createIfMissing: false });
}

/**
 * Close one cycle when its orchestrator chat is confirmed idle/missing and its
 * child delegations are terminal. Returns the closed cycle, or null.
 *
 * @param {{
 *   workspaceFolder: string,
 *   dataDir: string,
 *   now: number,
 *   deps: object,
 *   probe: Function,
 *   childChats: object[],
 *   row: object,
 *   cycle: object,
 * }} input
 * @returns {{ closed: boolean, reason: string, cycle?: object }}
 */
function reconcileWorkspaceWatcherCycleSlot(input) {
  const { workspaceFolder, dataDir, now, deps, probe, childChats, row, cycle } = input;
  const chatId = String(cycle.chatId || '').trim();
  const startProtected = chatId && isWorkspaceWatcherCycleStartProtected(cycle, now);
  const roomGone = !startProtected && chatId && isWorkspaceWatcherCycleRoomGone(cycle, probe);
  const childrenActive = chatId && hasActiveWorkspaceWatcherCycleChildren(chatId, childChats);
  if (roomGone && childrenActive) {
    if (cycle.roomGoneSince) clearWorkspaceWatcherRoomGone({ workspaceFolder, dataDir, cycle });
    return { closed: false, reason: 'cycle_children_active' };
  }
  if (roomGone && !isWorkspaceWatcherRoomGoneGraceElapsed(cycle, now)) {
    if (!cycle.roomGoneSince) stampWorkspaceWatcherRoomGone({ workspaceFolder, dataDir, now, cycle, probe });
    return { closed: false, reason: 'cycle_room_gone_grace' };
  }
  if (!roomGone && cycle.roomGoneSince) {
    clearWorkspaceWatcherRoomGone({ workspaceFolder, dataDir, cycle });
  }
  const alive = !roomGone && chatId
    ? isWorkspaceWatcherActiveCycleChatAlive(cycle, probe, now)
    : false;
  if (alive || startProtected) return { closed: false, reason: 'cycle_alive' };
  if (childrenActive) return { closed: false, reason: 'cycle_children_active' };

  const expectedCycleId = String(cycle.cycleId || '');
  const expectedChatId = chatId;
  const expectedStartedAt = String(cycle.startedAt || '');
  let closedReason = 'completed';
  const todoId = String(cycle.todoIds?.[0] || '').trim();
  const todo = loadPrimaryTodoForWorkspaceWatcherCycle({ workspaceFolder, dataDir, cycle, row });
  const leafOutcomes = resolveWorkspaceWatcherCycleTodoOutcomesForClose({
    cycle,
    workspaceFolder,
    dataDir,
    reportedTodoIds: resolveReportedTodoIdsForCycle(row, cycle),
  });
  const { closeOutcome, countIncompleteFailure, closeReason } = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle,
    row,
    todo,
    reportedOutcomeRaw: cycle.reportedOutcome,
    mcpErrorCode: readMcpOrchestratorRunErrorCode(cycle, probe),
    leafOutcomes,
  });
  /** @type {object | null} */
  let closedCycle = null;
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row: current }) => {
    const currentCycle = findWorkspaceWatcherCycleBySlot(current, cycle);
    if (!currentCycle) return false;
    if (String(currentCycle.cycleId || '') !== expectedCycleId) return false;
    if (String(currentCycle.chatId || '') !== expectedChatId) return false;
    if (String(currentCycle.startedAt || '') !== expectedStartedAt) return false;
    // Re-check inside the lock. A room that came back, or a grace stamp that
    // is not old enough yet, must not be closed by a probe from before the lock.
    const stillStartProtected = expectedChatId && isWorkspaceWatcherCycleStartProtected(currentCycle, now);
    const stillRoomGone = !stillStartProtected && expectedChatId && isWorkspaceWatcherCycleRoomGone(currentCycle, probe);
    if (stillStartProtected) {
      closedReason = 'cycle_alive';
      return false;
    }
    const latestDelegations = typeof deps.loadDelegations === 'function'
      ? deps.loadDelegations()
      : loadDelegations();
    if (expectedChatId && hasActiveWorkspaceWatcherCycleChildren(expectedChatId, latestDelegations)) {
      closedReason = 'cycle_children_active';
      return false;
    }
    if (stillRoomGone && !isWorkspaceWatcherRoomGoneGraceElapsed(currentCycle, now)) {
      closedReason = 'cycle_room_gone_grace';
      return false;
    }
    if (!stillRoomGone && expectedChatId && isWorkspaceWatcherActiveCycleChatAlive(currentCycle, probe, now)) {
      closedReason = 'cycle_alive';
      return false;
    }
    const reports = resolveDeferredWorkspaceWatcherReports(current.reports, currentCycle);
    // A missing report (or the concrete MCP failure behind it) is the actionable
    // cause, so `cycle_room_gone` (how the slot was detected dead) must not mask
    // it in the durable decision.
    if (closeReason === 'missing_report' || closeReason === 'cycle_incomplete' || MCP_ORCHESTRATOR_ERROR_CODE_LIST.includes(closeReason)) closedReason = closeReason;
    else if (stillRoomGone) closedReason = 'cycle_room_gone';
    else if (countIncompleteFailure) closedReason = 'cycle_no_progress';
    else closedReason = String(cycle.reportedOutcome || '').trim() ? `cycle_${cycle.reportedOutcome}` : 'completed';
    closedCycle = currentCycle;
    return buildWorkspaceWatcherCycleClosePatch({
      row: current,
      cycle: currentCycle,
      outcome: closeOutcome,
      todoIds: currentCycle.todoIds,
      reports,
      now,
      at: new Date(now).toISOString(),
      decisionReason: closedReason,
      closeSource: 'reconcile',
      todo,
      workspaceFolder,
      dataDir,
    });
  }, { dataDir, createIfMissing: false });

  if (!result.ok) {
    return { closed: false, reason: result.reason || closedReason };
  }
  finalizeWorkspaceWatcherCycleMetric({
    ...buildWorkspaceWatcherCycleMetricCloseInput({
      cycle: closedCycle || cycle,
      workspaceFolder,
      closedAt: new Date(now).toISOString(),
      closeSource: 'reconcile',
      closeReason: closedReason,
      closeOutcome,
      reportedTodoIds: resolveReportedTodoIdsForCycle(row, cycle),
      leafOutcomes,
      blockedReasonCode: resolveWorkspaceWatcherCycleBlockedReasonCode({
        closeOutcome,
        closeReason: closedReason,
        planOnly: (closedCycle || cycle)?.planOnly === true,
        planSaved: leafOutcomes?.planSaved === true,
        stopReason: row?.stopReason,
        todoOutcomes: leafOutcomes?.todoOutcomes,
      }),
      todo,
    }),
    dataDir,
    now,
  }, deps);
  if (countIncompleteFailure && todoId) {
    const notify = typeof deps.notify === 'function' ? deps.notify : notifyWorkspaceWatcherDecision;
    notify({
      workspaceFolder,
      title: 'Cretli — workspace watcher',
      body: `Cycle ended without completing todo ${todoId.slice(0, 8)}. Failures increased; the todo may be skipped after repeated attempts.`,
      tag: `cretli-watcher-${workspaceFolder}`,
      url: '/?panel=todos',
    }, deps.notifyDeps || {});
  }
  if (todoId && chatId && !hasActiveWorkspaceWatcherCycleChildren(chatId, childChats)) {
    releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId: expectedCycleId, dataDir, now });
  }
  logDelegationEvent('workspace-watcher-cycle-closed', {}, {
    workspaceFolder,
    cycleId: expectedCycleId,
    chatId: expectedChatId,
    reason: closedReason,
  });
  const roomGoneNote = closedReason === 'cycle_room_gone' ? ' (cycle_room_gone)' : '';
  appendWorkspaceWatcherNotice({
    workspaceFolder,
    dataDir,
    action: countIncompleteFailure ? 'cycle_failure' : 'cycle_stop',
    level: countIncompleteFailure ? 'error' : 'info',
    text: countIncompleteFailure
      ? `Cycle for todo ${todoId.slice(0, 8)} ended without progress${roomGoneNote}; failures increased.`
      : `Cycle ${expectedCycleId.slice(0, 8)} closed (${closedReason})${todoId ? ` for todo ${todoId.slice(0, 8)}` : ''}.`,
    todoId,
    cycleId: expectedCycleId,
    chatId: expectedChatId,
    at: new Date(now).toISOString(),
    deps: deps.noticeDeps || {},
  });
  broadcastWorkspaceWatcherChanged({ workspaceFolder });
  // Archive the orchestrator chat so finished cycles don't clutter the
  // sidebar — through the shared gate only: terminal delegated children first,
  // then the parent, and nothing while a child still holds a run slot.
  if (expectedChatId) {
    try { archiveChatFamily(expectedChatId, { now, deps }); } catch { /* best-effort */ }
  }
  return { closed: true, reason: 'cycle_closed', cycle };
}

const START_REFUSAL_DEDUPE_MS = 60_000;

/**
 * A start that returns without a cycle used to vanish. Record the reason on
 * the decision log (at most once a minute) so the Why? view names it.
 *
 * @param {{ workspaceFolder: string, dataDir: string, now: number, todoId: string, reason: string }} input
 * @returns {void}
 */
function noteWorkspaceWatcherStartRefusal(input) {
  const reason = String(input.reason || '').trim();
  if (!reason || reason === 'not_startable' || reason === 'cycle_active') return;
  const at = new Date(input.now).toISOString();
  const saved = mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row }) => {
    const decisions = Array.isArray(row.decisions) ? row.decisions : [];
    let last = null;
    for (let i = decisions.length - 1; i >= 0; i -= 1) {
      const entry = decisions[i];
      if (!entry || entry.kind !== 'start_refused' || entry.reason !== reason) continue;
      last = entry;
      break;
    }
    if (last) {
      const previous = Date.parse(String(last.at || ''));
      if (Number.isFinite(previous) && input.now - previous < START_REFUSAL_DEDUPE_MS) return false;
    }
    return {
      decisions: [...decisions, {
        at,
        kind: 'start_refused',
        reason,
        readyTodoCount: 0,
        activeAgentCount: 0,
        shouldNotify: false,
        nextTodoId: input.todoId,
      }],
    };
  }, { dataDir: input.dataDir, createIfMissing: false });
  if (!saved.ok) return;
  appendWorkspaceWatcherNotice({
    workspaceFolder: input.workspaceFolder,
    dataDir: input.dataDir,
    action: 'decision',
    level: 'warn',
    text: describeWorkspaceWatcherDecision({
      kind: 'start_refused',
      reason,
      nextTodoId: input.todoId,
    }),
    todoId: input.todoId,
    at,
  });
  logDelegationEvent('workspace-watcher-cycle-start-refused', {}, {
    workspaceFolder: input.workspaceFolder,
    todoId: input.todoId,
    reason,
  });
}

/**
 * Run one autopilot pass: reconcile any active cycle, then snapshot + decide +
 * (guarded) start for each autopilot row. Never throws; per-row errors are
 * collected.
 *
 * @param {{
 *   dataDir?: string,
 *   now?: number,
 *   token?: string,
 *   deps?: object,
 *   orchestratorArchiveDeps?: object,
 *   workspaceFolders?: string[],
 * }} [options]
 * @returns {Promise<{ at: string, scanned: number, started: number, closed: number, errors: object[], cycles: object[] }>}
 */
export async function runWorkspaceWatcherAutopilot(options = {}) {
  const dataDir = dataDirOf(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const deps = options.deps || {};
  const token = String(options.token || '').trim() || CYCLE_LEASE_TOKEN;
  const result = { at: new Date(now).toISOString(), scanned: 0, started: 0, closed: 0, errors: [], cycles: [] };

  /** @type {object[]} */
  let rows = [];
  try {
    rows = loadWorkspaceWatchers({ dataDir });
  } catch (error) {
    result.errors.push({ workspaceFolder: '', ...describeError(error) });
    return result;
  }
  const only = Array.isArray(options.workspaceFolders)
    ? new Set(options.workspaceFolders.map((f) => normalizeWorkspaceFolder(f)))
    : null;

  // Live revisit of closed cycles: the report/reconcile gate refuses inside the
  // 15-minute idle grace because the orchestrator's `updatedAt` is ~now when the
  // cycle closes, so this periodic pass (every worker tick) is what actually
  // archives the family once it has been idle past the grace. It only reads the
  // archive gate — no cycle start, no slot, no `maxCyclesPerDay` budget.
  try {
    sweepClosedWorkspaceWatcherCycles({
      dataDir,
      now,
      rows,
      workspaceFolders: options.workspaceFolders,
      deps: options.orchestratorArchiveDeps || {},
    });
  } catch { /* best-effort: the sweep never breaks a tick */ }

  for (const row of rows) {
    if (String(row.mode || '') !== 'autopilot') continue;
    if (only && !only.has(normalizeWorkspaceFolder(row.workspaceFolder))) continue;
    result.scanned += 1;
    try {
      const reconcile = reconcileWorkspaceWatcherCycle({
        workspaceFolder: row.workspaceFolder,
        dataDir,
        now,
        deps,
      });
      if (reconcile.closed) result.closed += 1;
      // Continue reconciling existing cycles while globally draining, but do
      // not create new reservations or start new orchestrator runs.
      if (!areWorkspaceWatcherStartsEnabled({ dataDir })) continue;
      // Re-read: reconcile may have just closed the cycle, and the exclusion set
      // below must reflect the live row, not the pre-reconcile snapshot.
      const current = getWorkspaceWatcher(row.workspaceFolder, { dataDir }) || row;
      const ownCycleChatIds = workspaceWatcherCycleChatIds(current);
      const tick = tickWorkspaceWatcher({
        workspaceFolder: row.workspaceFolder,
        dataDir,
        now,
        token,
        deps,
        excludeChatIds: ownCycleChatIds.length ? ownCycleChatIds : undefined,
        excludeDelegationParentChatIds: ownCycleChatIds.length ? ownCycleChatIds : undefined,
        notify: deps.notify,
        notifyDeps: deps.notifyDeps,
      });
      // Release a claim whose owning chat is confirmed gone *before* starting a
      // new cycle, so a crashed orchestrator cannot hide a todo and this tick
      // never touches the fresh claim it is about to create.
      releaseStaleWorkspaceTodoClaims({
        workspaceFolder: row.workspaceFolder,
        dataDir,
        probeChatRunLiveness: deps.probeChatRunLiveness,
      });
      const decision = tick.decision || {};
      if (!WORKSPACE_WATCHER_STARTABLE_KINDS.includes(String(decision.kind || ''))) continue;
      const started = await startWorkspaceWatcherCycle({
        workspaceFolder: row.workspaceFolder,
        dataDir,
        now,
        tick,
        token,
        deps,
      });
      if (started.started) {
        result.started += 1;
        result.cycles.push({ workspaceFolder: row.workspaceFolder, ...started.cycle });
      } else {
        noteWorkspaceWatcherStartRefusal({
          workspaceFolder: row.workspaceFolder,
          dataDir,
          now,
          todoId: String(decision.nextTodoId || ''),
          reason: String(started.reason || 'start_failed'),
        });
      }
    } catch (error) {
      result.errors.push({ workspaceFolder: row.workspaceFolder, ...describeError(error) });
    }
  }
  return result;
}

export { CYCLE_LEASE_TOKEN };
