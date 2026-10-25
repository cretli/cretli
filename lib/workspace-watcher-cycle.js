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

import { resolveEffectivePhases, todoPhaseChain } from './watcher-phases.js';
import { randomUUID } from 'node:crypto';
import { getProcessInstance } from './recovery/recovery-shutdown.ts';
import {
  isWorkspaceWatcherCycleRestartInterrupted,
} from './workspace-watcher-restart-evidence.js';
import { resolveDataPath } from './runtime-paths.js';
import { areWorkspaceWatcherStartsEnabled } from './workspace-watcher-runtime-control.js';
import { addChat, loadChats } from './persist/chats-persist.js';
import { markDelegationAutomaticController } from './delegation-start-context.js';
import { loadDelegationsReadonly, reassignDelegationController } from './persist/delegations-persist.js';
import { VERIFY_PENDING_MAX_AGE_MS } from './delegation-implement-verify-gate.js';
import { archiveChatFamily } from './chat-archive-policy.js';
import { sweepClosedWorkspaceWatcherCycles } from './workspace-watcher-archive-sweep.js';
import { loadTodosData, updateTodo } from './persist/todos-persist.js';
import { listWorkspaceMemory } from './persist/workspace-memory-persist.js';
import { collectTodoAncestorIds, readTodoParentId } from './todo-tree.js';
import {
  isWorkspaceWatcherOrchestratorChat,
  resolveWorkspaceWatcherReserveOwnerAbort,
} from './workspace-watcher-tree-owner.js';
import { buildLiveWorktreePredicate } from './todo-worktree-manual.js';
import { logDelegationEvent } from './delegation-log.js';
import { isParallelLeafWorktreeEnabled, refreshStaleTreeBeforeLeaf } from './worktree-tree-leaf.js';
import { getWorktreeRecord } from './persist/worktree-registry-persist.js';
import { addRunEndListener } from './usage/run-end-snapshot.js';
import { isBootReconciliationComplete } from './delegation-lifecycle.js';
import { cancelChatRun, lookupChatRunRequest, probeChatRunLiveness, startChatRun } from './chat-run-service.js';
import { listHarnessUsageLimits, listHarnessUsageLimitsForWorkspace } from './harness-usage-limits.js';
import { isWorkspaceWatcherOrchestratorModelUsageLimited, resolveWorkspaceWatcherOrchestrator } from './workspace-watcher-orchestrator.js';
import { buildWorkspaceWatcherCyclePromptPlan } from './workspace-watcher-prompt.js';
import { resolveReviewerPoliciesForPrompt } from './reviewer-policy.js';
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
  withWorkspaceWatchersFileLock,
  WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME,
  WORKSPACE_WATCHER_CYCLE_OUTCOMES,
  WORKSPACE_WATCHER_CYCLE_START_DEADLINE_MS,
  WORKSPACE_WATCHER_MAX_REPORTS,
  WORKSPACE_WATCHER_MAX_CYCLE_CHATS,
  WORKSPACE_WATCHER_MAX_DECISIONS,
  WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES,
  workspaceWatcherCycleChatIds,
} from './persist/workspace-watchers-persist.js';
import {
  buildWorkspaceWatcherCycleClosePatch,
  buildTreeIntegrationWaitDecision,
  buildWorkspaceWatcherCycleMetricCloseInput,
  hasActiveWorkspaceWatcherCycleChildren,
  listRunningImplementChildren,
  listAdoptableLeafDelegations,
  isReportedBlockedCycle,
  loadPrimaryTodoForWorkspaceWatcherCycle,
  applyParallelLeafMerge,
  applyWorkspaceWatcherBlockedEscalation,
  normalizeWorkspaceWatcherBlockedReportCode,
  normalizeWorkspaceWatcherBlockedReportDate,
  recordReviewGateWarning,
  resolveParallelLeafWorktree,
  releaseWorkspaceWatcherCycleTodoClaim,
  resolveDeferredWorkspaceWatcherReports,
  resolveReportedTodoIdsForCycle,
  resolveWorkspaceWatcherCycleBlockedReasonCode,
  resolveWorkspaceWatcherCycleReviewGate,
  resolveWorkspaceWatcherCycleCloseOutcome,
  resolveWorkspaceWatcherCycleTodoOutcomesForClose,
} from './workspace-watcher-cycle-close.js';
import {
  beginWorkspaceWatcherCycleMetric,
  finalizeWorkspaceWatcherCycleMetric,
  markWorkspaceWatcherCycleMetricRunning,
  stampWorkspaceWatcherCycleMetricRequest,
} from './workspace-watcher-cycle-metrics.js';
import { evaluateWorkspaceWatcherSafetyValve, workspaceWatcherTreeKey } from './workspace-watcher-scheduler.js';
import { MCP_ORCHESTRATOR_ERROR_CODE_LIST, readMcpOrchestratorRunErrorCode } from './mcp/mcp-orchestrator-contract.js';
import {
  buildWorkspaceWatcherPlanReviewResolver,
  claimWorkspaceTodo,
  describeWorkspaceWatcherDecision,
  isWorkspaceWatcherActiveCycleChatAlive,
  notifyWorkspaceWatcherDecision,
  releaseStaleWorkspaceTodoClaimsThrottled,
  shouldRecordDecision,
  tickWorkspaceWatcher,
  WORKSPACE_WATCHER_DECISION_DEDUPE_MS,
  WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS,
  WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN,
} from './workspace-watcher.js';
import {
  computeWorkspaceWatcherBackoffUntil,
  applyWorkspaceWatcherInfraClassification,
  WORKSPACE_WATCHER_STOP_ORCHESTRATOR_INFRA_STREAK,
  nextWorkspaceWatcherBlockedBackoff,
  evaluateWorkspaceWatcherGuardrails,
  workspaceWatcherUtcDayKey,
} from './workspace-watcher-guardrails.js';
import { isServerShuttingDown } from './update-gate.js';
import {
  workspaceWatcherTodoPool,
  workspaceWatcherPoolTodoIndex,
  workspaceWatcherStartPoolGate,
} from './workspace-watcher-pool.js';
import { isWorktreeRecordLive } from './worktree/worktree-record.ts';
import {
  buildWorktreeActiveAgentCheck,
  describeWorktreePreparationError,
  prepareWorkspaceWatcherExecution,
} from './workspace-watcher-worktree.js';
import {
  getWorktreeIntegrationRecord,
  markTodoIntegrationReady,
  markTreeWorktreeLeafDone,
  resolveTreeWorktreeLeaf,
  buildWorktreeIntegrationResult,
  collectWorktreeIntegrationDiff,
} from './workspace-watcher-integration.js';
import { buildCycleReviewEvidence } from './todo-review-cycle-evidence.js';
import { automaticallyIntegrateWorkspaceTodo } from './workspace-watcher-integration.js';
import { canChatControlDelegation } from './delegation-control.js';

/** True when any live cycle already lists `todoId` among its todos. */
function workspaceWatcherCyclesHoldTodo(cycles, todoId) {
  return (Array.isArray(cycles) ? cycles : []).some((c) => (
    Array.isArray(c?.todoIds) && c.todoIds.map(String).includes(String(todoId))
  ));
}

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
 * @param {Record<string, any> | null | undefined} row
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
 * @param {{ todoId?: unknown, planTargetId?: unknown, items?: Record<string, any>[] }} [input]
 * @returns {string[]}
 */
export function collectWorkspaceWatcherPromptTodoIds(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  /** @type {Map<string, Record<string, any>>} */
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
 * @param {Record<string, any> | null | undefined} watcher
 * @returns {boolean}
 */
function preserveOrchestratorRollbackPacing(watcher) {
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  return Math.max(0, Number(policy.cooldownMs) || 0) > 0;
}

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
      // Refunding the daily budget must not erase cooldown pacing: the reservation
      // already stamped `lastCycleAt`, and callers that set
      // `preservePacingOnRollback` keep it for guardrails cooldown.
      if (options.preservePacingOnRollback !== true) {
        patch.lastCycleAt = String(options.previousLastCycleAt ?? '').trim();
      }
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
 *   planRereview?: { holderId: string, planKey: string, markerKey: string } | null,
 *   now: number,
 *   usageLimits: Record<string, any>[],
 *   deps?: Record<string, any>,
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
      if (input.planRereview) {
        // Undo only this start's version marker; the standing request stays.
        delete planRequests[input.planRereview.markerKey];
      } else if (input.planOnly) {
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
        planReviewResolver: typeof input.deps?.planReviewResolver === 'function'
          ? input.deps.planReviewResolver
          : buildWorkspaceWatcherPlanReviewResolver({ workspaceFolder: input.workspaceFolder, dataDir: input.dataDir }),
      });
      if (!guard.allowed) {
        abortReason = guard.reason || 'policy_blocked';
        return null;
      }
      if (guard.planOnly !== input.planOnly || Boolean(guard.planRereview) !== Boolean(input.planRereview)) {
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
 * Hot-loop guard for transient start refusals (`recipient_busy`,
 * `adapter_unavailable`). A transient refusal rolls the claim and the budget
 * back without counting a failure or arming backoff, so a refusal that never
 * clears would be retried on every tick forever. After this many consecutive
 * transient refusals for the same todo the next one is counted as an ordinary
 * failure (failure counter + exponential backoff), and the streak restarts.
 * The streak is in-memory only (a restart gives the todo a fresh streak) and is
 * cleared by any successful start or any hard start error.
 */
export const WORKSPACE_WATCHER_MAX_TRANSIENT_START_REFUSALS = 5;

/** @type {Map<string, number>} `${workspaceFolder}\0${todoId}` → consecutive transient refusals */
const transientStartRefusalStreaks = new Map();

const TRANSIENT_START_REFUSAL_CODES = ['recipient_busy', 'adapter_unavailable'];

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isWorkspaceWatcherTransientStartRefusal(error) {
  const code = String(error && typeof error === 'object' && 'code' in error ? error.code : '').trim();
  return TRANSIENT_START_REFUSAL_CODES.includes(code);
}

/** Test hook: forget every transient-refusal streak. */
export function resetWorkspaceWatcherTransientStartRefusals() {
  transientStartRefusalStreaks.clear();
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
 *   tick?: Record<string, any>,
 *   deps?: Record<string, any>,
 * }} [options]
 * @returns {Promise<{ started: boolean, reason: string, cycle?: Record<string, any>, error?: Record<string, any> }>}
 */
export async function startWorkspaceWatcherCycle(options = {}) {
  // R9: no cycle may start once shutdown began.
  if (isServerShuttingDown()) return { started: false, reason: 'server_shutting_down' };
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
  // A plan RE-review round reuses the plan-only cycle shape but must never drop
  // the standing plan request on failure: that would reopen plan generation.
  const planRereview = decision.planRereview && typeof decision.planRereview === 'object'
    ? decision.planRereview
    : null;
  const watcher = tick.watcher || getWorkspaceWatcher(workspaceFolder, { dataDir });
  if (!watcher) return { started: false, reason: 'no_watcher' };
  if (String(watcher.mode || '') !== 'autopilot') return { started: false, reason: 'not_autopilot' };
  // Every slot is a cycle of this same workspace, so the cap is `maxParallel`
  // (external agents are a separate gate inside `decideWorkspaceWatcherAction`).
  const activeCycles = getWorkspaceWatcherActiveCycles(watcher);
  if (activeCycles.length >= WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES) {
    return { started: false, reason: 'hard_cap' };
  }
  if (evaluateWorkspaceWatcherSafetyValve({
    count: activeCycles.length + Math.max(0, Number(tick.snapshot?.activeAgentCount) || 0),
    maxParallel: maxParallelOf(watcher),
  }).reached) {
    return { started: false, reason: 'cycle_active' };
  }
  // Then the cap of the pool this todo executes in. The global cap is asked
  // first, so the sum of both pools can never exceed `maxParallel`. The cycle's
  // pool is the one of the todo it claims at start (`todoIds[0]`), never the
  // pool of a todo the cycle picks up later.
  const poolTodos = workspaceWatcherPoolTodoIndex([tick.snapshot?.items, tick.snapshot?.readyLeaves]);
  const poolGate = workspaceWatcherStartPoolGate({
    todoId,
    cycles: activeCycles,
    todos: poolTodos,
    policy: watcher.policy,
    snapshot: tick.snapshot,
  });
  if (poolGate.full) return { started: false, reason: 'cycle_active' };
  if (workspaceWatcherCyclesHoldTodo(activeCycles, todoId)) {
    return { started: false, reason: 'todo_in_active_cycle' };
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
  const planReviewResolver = typeof deps.planReviewResolver === 'function'
    ? deps.planReviewResolver
    : buildWorkspaceWatcherPlanReviewResolver({ workspaceFolder, dataDir });
  const usageLimits = Array.isArray(deps.activeUsageLimits)
    ? deps.activeUsageLimits
    : safeListUsageLimits(dataDir, workspaceFolder);
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
    if (getWorkspaceWatcherActiveCycles(row).length >= WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES) {
      reserveAbort = 'hard_cap';
      return null;
    }
    if (evaluateWorkspaceWatcherSafetyValve({
      count: getWorkspaceWatcherActiveCycles(row).length + Math.max(0, Number(tick.snapshot?.activeAgentCount) || 0),
      maxParallel: maxParallelOf(row),
    }).reached) {
      reserveAbort = 'cycle_active';
      return null;
    }
    // Same gate as the pre-check, re-asked against the row inside the write lock:
    // two starts racing for the last slot of one pool must not both pass, and
    // only the cycles of the pool being entered are counted.
    if (workspaceWatcherStartPoolGate({
      todoId,
      cycles: getWorkspaceWatcherActiveCycles(row),
      todos: poolTodos,
      policy: row.policy,
      snapshot: tick.snapshot,
    }).full) {
      reserveAbort = 'cycle_active';
      return null;
    }
    // Hard check under the write lock: a todo already owned by a live cycle
    // never gets a second orchestrator.
    if (workspaceWatcherCyclesHoldTodo(getWorkspaceWatcherActiveCycles(row), todoId)) {
      reserveAbort = 'todo_in_active_cycle';
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
    // The pick already skipped externally owned trees; re-ask against the live
    // rows so an orchestrator stamped after the snapshot still wins the race.
    const ownerAbort = resolveWorkspaceWatcherReserveOwnerAbort(liveTodo, liveDoc?.items, tick.snapshot?.externalOwners);
    if (ownerAbort) {
      reserveAbort = ownerAbort;
      return null;
    }
    const guard = evaluateWorkspaceWatcherGuardrails({
      watcher: row,
      pickedTodo: liveTodo,
      items: Array.isArray(liveDoc?.items) ? liveDoc.items : [],
      now,
      activeUsageLimits: usageLimits,
      planReviewResolver,
    });
    if (!guard.allowed) {
      reserveAbort = guard.reason || 'policy_blocked';
      return null;
    }
    if (guard.planOnly !== planOnly) {
      reserveAbort = 'plan_gate_mismatch';
      return null;
    }
    // A re-review start must still be a re-review against the live row, and a
    // plain plan start must not turn into one (and vice versa).
    if (Boolean(guard.planRereview) !== Boolean(planRereview)
      || (planRereview && guard.planRereview.planKey !== planRereview.planKey)) {
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
    if (planRereview) {
      // Record the plan version this round was started for; the standing
      // request stays as is, so the gate keeps waiting for the human.
      planRequests[guard.planRereview.markerKey] = guard.planRereview.planKey;
    } else if (planOnly) {
      planRequests[planTargetId] = at;
    }
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
        instanceId: String(deps.instanceId || '').trim() || getProcessInstance().instanceId,
        mode: planOnly ? 'plan' : 'implement',
        // Charge the cycle to its claimed task's pool, including planning.
        // Planning can use the project folder without moving the task's slot.
        executionMode: workspaceWatcherTodoPool(liveTodo, row.policy),
        ...(planOnly && planTargetId !== todoId ? { planTargetId } : {}),
      }),
      lastCycleAt: at,
      cycles,
      planRequests,
      // Fair share: remember when this todo tree was last served so the next
      // pick rotates to the tree that waited longest.
      lastServedByTree: {
        ...(row.lastServedByTree || {}),
        [workspaceWatcherTreeKey(Array.isArray(liveDoc?.items) ? liveDoc.items : [], liveTodo)]: now,
      },
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
      dropPlanRequest: planOnly, planRequestKey: planRereview ? planRereview.markerKey : planTargetId,
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
  /** @type {Record<string, any> | null} */
  let resolvedOrchestrator = null;

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
      orchestrator = await resolveOrchestrator({ watcher, workspaceFolder, activeUsageLimits: usageLimits, deps, now });
      resolvedOrchestrator = orchestrator.ok ? orchestrator : null;
    } catch (error) {
      const described = describeError(error);
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planRereview ? planRereview.markerKey : planTargetId,
        countFailure: false,
        rollbackReserve: true,
        preservePacingOnRollback: preserveOrchestratorRollbackPacing(watcher),
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
        dropPlanRequest: planOnly, planRequestKey: planRereview ? planRereview.markerKey : planTargetId,
        countFailure: false,
        rollbackReserve: true,
        preservePacingOnRollback: preserveOrchestratorRollbackPacing(watcher),
        previousLastCycleAt,
        previousCycles,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      const blockedReason = String(orchestrator.reason || '').trim() || 'unavailable';
      if (blockedReason === WORKSPACE_WATCHER_STOP_ORCHESTRATOR_INFRA_STREAK || blockedReason === 'orchestrator_infra_cooldown') {
        // Never swap silently: park the autopilot with a readable reason.
        stopForOrchestratorInfraStreak({
          workspaceFolder,
          dataDir,
          at,
          detail: blockedReason === 'orchestrator_infra_cooldown'
            ? `The explicit orchestrator ${orchestrator.cooldown?.harness}/${orchestrator.cooldown?.model || '*'} is cooling down until ${orchestrator.cooldown?.until} (${orchestrator.cooldown?.cause}); not replaced automatically`
            : 'Every orchestrator candidate is cooling down after repeated infrastructure failures',
        });
        return { started: false, reason: 'orchestrator_unavailable', error: { code: blockedReason, message: blockedReason } };
      }
      const blockedDecision = { kind: 'orchestrator_blocked', reason: blockedReason };
      const rowAfterRollback = getWorkspaceWatcher(workspaceFolder, { dataDir });
      const dedupeMs = Number.isFinite(deps.decisionDedupeMs)
        ? Math.max(0, Number(deps.decisionDedupeMs))
        : WORKSPACE_WATCHER_DECISION_DEDUPE_MS;
      const recordedBlocked = shouldRecordDecision(rowAfterRollback, blockedDecision, now, dedupeMs);
      if (recordedBlocked) {
        mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
          decisions: [
            ...row.decisions,
            {
              at,
              kind: 'orchestrator_blocked',
              reason: blockedReason,
              readyTodoCount: 0,
              activeAgentCount: 0,
              shouldNotify: true,
              nextTodoId: todoId,
            },
          ].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
        }), { dataDir, createIfMissing: false });
        const notify = typeof deps.notify === 'function' ? deps.notify : notifyWorkspaceWatcherDecision;
        notify({
          workspaceFolder,
          title: 'Cretli — workspace watcher',
          body: `No orchestrator model is available (${blockedReason}). Check favorites, allow-list, and usage limits.`,
          tag: `cretli-watcher-${workspaceFolder}`,
          url: '/?panel=todos',
        }, deps.notifyDeps || {});
        void appendWorkspaceWatcherNotice({
          workspaceFolder,
          dataDir,
          action: 'alert',
          level: 'error',
          text: `No orchestrator model is available (${blockedReason}). Check favorites, allow-list, and usage limits.`,
          todoId,
          at,
          deps: deps.noticeDeps || {},
        });
      }
      logDelegationEvent('workspace-watcher-orchestrator-blocked', {}, {
        workspaceFolder,
        todoId,
        reason: blockedReason,
      });
      return { started: false, reason: 'orchestrator_unavailable', error: { code: blockedReason, message: blockedReason } };
    }
    const recheck = recheckWorkspaceWatcherCycleStartEligibility({
      workspaceFolder,
      dataDir,
      cycleId,
      token,
      todoId,
      planTargetId,
      planOnly,
      planRereview,
      now: Number.isFinite(options.now) ? now : Date.now(),
      usageLimits: Array.isArray(deps.activeUsageLimits) ? usageLimits : safeListUsageLimits(dataDir, workspaceFolder),
      previousLastCycleAt,
      orchestrator,
      deps,
    });
    if (!recheck.ok) {
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planRereview ? planRereview.markerKey : planTargetId,
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
    // The whole tree shares one worktree: when an ancestor (a manual root)
    // already holds a live record, the leaf runs in it instead of mixing keys.
    const ancestorIds = collectTodoAncestorIds(modeItems, todoId);
    const isLiveWorktree = planOnly ? () => false : buildLiveWorktreePredicate(dataDir);
    const sharedAncestorId = ancestorIds.find((id) => isLiveWorktree(id)) || '';
    try {
      const treeTodo = sharedAncestorId ? modeItems.find((row) => String(row?.id || '') === sharedAncestorId) : null;
      const parallelLeafTree = Boolean(sharedAncestorId) && isParallelLeafWorktreeEnabled({ tree: treeTodo, policy: reserve.row?.policy });
      if (parallelLeafTree) {
        const treeRecord = getWorktreeRecord(sharedAncestorId, { dataDir });
        const freshness = await refreshStaleTreeBeforeLeaf({
          treeRecord,
          maxBehind: reserve.row?.policy?.worktree?.maxBehindCommits,
          registryOptions: { dataDir },
          hasActiveAgent: buildWorktreeActiveAgentCheck(
            typeof deps.probeChatRunLiveness === 'function' ? deps.probeChatRunLiveness : probeChatRunLiveness,
            chatId,
          ),
        });
        if (freshness.reason === 'unresolved_checkpoint') {
          throw new Error(`Tree worktree ${sharedAncestorId} has an archived unresolved checkpoint (${freshness.archiveRef}); integrate or reject it before starting a leaf.`);
        }
        if (freshness.reason === 'agent_check_unavailable' || freshness.reason === 'agent_active' || freshness.reason === 'tree_busy') {
          throw new Error(`Tree worktree ${sharedAncestorId} is not safe to refresh (${freshness.reason}).`);
        }
      }
      preparedExecution = await prepareWorkspaceWatcherExecution({
        todoId: sharedAncestorId && !parallelLeafTree ? sharedAncestorId : todoId,
        reuseActivePrepare: Boolean(sharedAncestorId) && !parallelLeafTree,
        parallelTreeTodoId: parallelLeafTree ? sharedAncestorId : '',
        parallelTreeTodo: parallelLeafTree ? treeTodo : null,
        workspaceFolder,
        todo: { ...liveTodoForMode, executionMode: findWorkspaceWatcherCycle(reserve.row, { cycleId })?.executionMode || liveTodoForMode.executionMode },
        policy: reserve.row?.policy,
        dataDir,
        cycleId,
        chatId,
        planOnly,
        // Derive and persist a missing layout from the workspace itself so an
        // autopilot cycle is not dead-ended on unconfigured per-workspace settings.
        allowSuggestedLayout: true,
        hasActiveAgent: buildWorktreeActiveAgentCheck(
          typeof deps.probeChatRunLiveness === 'function' ? deps.probeChatRunLiveness : probeChatRunLiveness,
          chatId,
        ),
        // D1: a manual start keys the tree by its ROOT. When an ancestor already
        // holds a live worktree, refuse instead of creating a second one.
        lineageTodoIds: sharedAncestorId ? [] : ancestorIds,
        deps,
      });
    } catch (error) {
      const described = describeWorktreePreparationError(error);
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planRereview ? planRereview.markerKey : planTargetId,
        countFailure: false,
        rollbackReserve: true,
        previousLastCycleAt,
        previousCycles,
      });
      releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
      mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
        // A preflight failure is not a cycle failure (contract §5.2), but the
        // cause (a dirty tree, a missing layout) outlives a tick: without a
        // per-todo delay the same leaf is re-picked, re-notified and re-logged
        // on every tick and hides the other ready leaves behind it.
        blockedBackoff: {
          ...(row.blockedBackoff || {}),
          [todoId]: nextWorkspaceWatcherBlockedBackoff({
            previous: row.blockedBackoff?.[todoId],
            policy: row.policy,
            now,
          }),
        },
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
      void appendWorkspaceWatcherNotice({
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
    // Opt-in reviewer pool: empty (prompt unchanged) unless the workspace enables
    // the switch with a complete pair. Resolved here, outside the pure prompt
    // builder, exactly like the todos-routes start prompts.
    // Same per-subject resolver as the manual TODO paths (parity), keyed by this
    // cycle's orchestrator chat so a learned pair is found.
    const { policies: reviewerPolicies, workPolicies, reviewerPool, reviewerPoolStrict } = resolveReviewerPoliciesForPrompt(workspaceFolder, { dataDir, parentChatId: chatId });
    // A running implement/fix of this leaf left behind by an earlier cycle holds
    // the single write slot: hand it to this cycle's chat so the orchestrator can
    // wait on it (delegation_wait is controller-scoped) instead of a refused start.
    const adoptedDelegations = adoptRunningLeafDelegations({ todoId, chatId, workspaceFolder, dataDir, deps });
    const promptPlan = buildWorkspaceWatcherCyclePromptPlan({
      workspaceFolder,
      watcher,
      decision: { ...decision, planOnly, planTargetId: planTargetId !== todoId ? planTargetId : undefined, planRereview: planRereview || undefined },
      todo: picked,
      reviewerPool,
      reviewerPoolStrict,
      reviewerPolicies,
      workPolicies,
      phases: (() => {
        try {
          const items = loadTodosData(dataDir, workspaceFolder)?.items;
          return resolveEffectivePhases(watcher?.policy, todoPhaseChain(items, picked));
        } catch {
          return resolveEffectivePhases(watcher?.policy, [picked]);
        }
      })(),
      orchestrator: { harness: orchestrator.harness, model: orchestrator.model, source: orchestrator.source },
      activeUsageLimits: usageLimits,
      previousChats: watcher.cycleChats,
      memory,
      todoIds: promptTodoIds,
      maxChars: promptCharBudget,
      cycleId,
      chatId,
      executionMode: preparedExecution.mode,
      adoptedDelegations,
    });
    if (promptPlan.tooLong) {
      // The full contract cannot be shortened. Refuse the start before the chat
      // exists: roll the reservation and the claim back without counting a
      // failure or arming backoff, and leave a durable reason behind.
      clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
        dropPlanRequest: planOnly, planRequestKey: planRereview ? planRereview.markerKey : planTargetId,
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
      void appendWorkspaceWatcherNotice({
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
        planRequestKey: planRereview ? planRereview.markerKey : planTargetId,
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
    markDelegationAutomaticController(created?.id || chatId, 'watcher_cycle', { dataDir });
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
        dropPlanRequest: planOnly && !planRereview, planRequestKey: planTargetId,
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
    void appendWorkspaceWatcherNotice({
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
    transientStartRefusalStreaks.delete(`${workspaceFolder}\0${todoId}`);
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
    const streakKey = `${workspaceFolder}\0${todoId}`;
    let forgiveTransient = false;
    if (isWorkspaceWatcherTransientStartRefusal(error)) {
      const streak = (transientStartRefusalStreaks.get(streakKey) || 0) + 1;
      if (streak >= WORKSPACE_WATCHER_MAX_TRANSIENT_START_REFUSALS) {
        // Hot-loop guard: a refusal that never clears becomes a real failure.
        transientStartRefusalStreaks.delete(streakKey);
      } else {
        transientStartRefusalStreaks.set(streakKey, streak);
        forgiveTransient = true;
      }
    } else {
      transientStartRefusalStreaks.delete(streakKey);
    }
    // A start error after the pair was resolved is an infrastructure failure
    // before work: it enters the history and the breaker and never raises the
    // todo counter; `infraBackoffUntil` delays the next attempt.
    const startInfra = !forgiveTransient && resolvedOrchestrator !== null;
    clearCycleRow({ workspaceFolder, dataDir, now, token }, cycleId, todoId, backoffBaseMs, backoffCapMs, {
      dropPlanRequest: planOnly && !planRereview, planRequestKey: planTargetId,
      ...(startInfra ? { countFailure: false } : {}),
      ...(forgiveTransient ? {
        countFailure: false,
        rollbackReserve: true,
        previousLastCycleAt,
        previousCycles,
      } : {}),
    });
    releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId, dataDir, now });
    if (startInfra) {
      recordWorkspaceWatcherCycleStartInfraFailure({
        workspaceFolder,
        dataDir,
        cycleId,
        chatId,
        todoId,
        startedAt: at,
        harness: String(resolvedOrchestrator.harness || ''),
        model: String(resolvedOrchestrator.model || ''),
        errorCode: String(described.code || '').trim(),
        now,
      });
    }
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
    void appendWorkspaceWatcherNotice({
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
 * Stamp the real orchestrator run-end facts (from a run-end snapshot) on the
 * live cycle slot, so the close classifies by cause and real run duration
 * instead of the (later) cycle close time. First snapshot wins.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, cycleId?: string, chatId?: string, snapshot: Record<string, any>, now?: number }} input
 * @returns {boolean} whether a live slot was stamped
 */
export function recordWorkspaceWatcherCycleRunEnd(input) {
  const snapshot = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot : {};
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  let stamped = false;
  mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row }) => {
    const cycle = findWorkspaceWatcherCycle(row, { cycleId: input.cycleId, chatId: input.chatId });
    if (!cycle || cycle.runEnd) return false;
    stamped = true;
    return replaceWorkspaceWatcherCycle(row, { cycleId: cycle.cycleId }, {
      ...cycle,
      runEnd: {
        status: snapshot.status,
        durationMs: snapshot.durationKnown === false ? null : snapshot.durationMs,
        errorCode: snapshot.errorCode,
        errorSource: snapshot.errorSource,
        outputSeen: snapshot.outputSeen === true,
        errorStage: snapshot.errorStage,
        at: new Date(now).toISOString(),
      },
    });
  }, { dataDir: input.dataDir, createIfMissing: false });
  return stamped;
}

/**
 * Production hook: forward the run-end snapshot of a Watcher cycle's
 * orchestrator chat to its live slot. No-op for any other chat.
 *
 * @param {Record<string, any>} snapshot
 * @param {Record<string, any>} input captureRunEnd input (room, dataDir)
 * @returns {boolean}
 */
export function forwardRunEndToWorkspaceWatcherCycle(snapshot, input = {}) {
  const chatId = String(input.room?.chatId || '').trim();
  if (!chatId) return false;
  const options = input.dataDir ? { dataDir: input.dataDir } : {};
  for (const row of loadWorkspaceWatchers(options)) {
    if (!findWorkspaceWatcherCycle(row, { chatId })) continue;
    return recordWorkspaceWatcherCycleRunEnd({ workspaceFolder: row.workspaceFolder, dataDir: input.dataDir, chatId, snapshot });
  }
  return false;
}
addRunEndListener(forwardRunEndToWorkspaceWatcherCycle);

/**
 * A start error after the orchestrator pair was resolved never produced a
 * history entry. Record it as an infrastructure failure before work: history
 * entry, streak/backoff/cooldown, no todo failure.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, cycleId: string, chatId: string, todoId: string, startedAt: string, harness: string, model: string, errorCode?: string, now: number }} input
 */
export function recordWorkspaceWatcherCycleStartInfraFailure(input) {
  const at = new Date(input.now).toISOString();
  const code = String(input.errorCode || 'start_error').trim().toLowerCase();
  mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row }) => {
    const applied = applyWorkspaceWatcherInfraClassification({
      row,
      harness: input.harness,
      model: input.model,
      runKey: input.cycleId,
      classification: { cause: `infra:${code}`, streak: 'count' },
      now: input.now,
      at,
    });
    const entry = {
      id: input.chatId,
      cycleId: input.cycleId,
      todoIds: [input.todoId],
      startedAt: input.startedAt,
      at,
      outcome: 'failure',
      harness: input.harness,
      closeSource: 'abort',
      closeReason: 'start_failed',
      model: String(input.model || '').toLowerCase(),
      cause: `infra:${code}`,
      runDurationMs: null,
    };
    const existing = Array.isArray(row.cycleChats) ? row.cycleChats : [];
    return {
      ...applied.patch,
      cycleChats: existing.some((chat) => chat?.id === entry.id) ? existing : [...existing, entry].slice(-WORKSPACE_WATCHER_MAX_CYCLE_CHATS),
      decisions: [...row.decisions, ...applied.decisions].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
    };
  }, { dataDir: input.dataDir, createIfMissing: false });
}

/**
 * Park the autopilot when every orchestrator candidate sits in a cooldown. The
 * existing `stopped` notification fires from the new `stopReason`.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, detail: string, at: string }} input
 */
function stopForOrchestratorInfraStreak(input) {
  mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row }) => ({
    stopReason: String(row.stopReason || '').trim() || WORKSPACE_WATCHER_STOP_ORCHESTRATOR_INFRA_STREAK,
    decisions: [...row.decisions, {
      at: input.at,
      kind: 'orchestrator_infra_stop',
      reason: input.detail,
      readyTodoCount: 0,
      activeAgentCount: 0,
      shouldNotify: false,
      nextTodoId: '',
    }].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
  }), { dataDir: input.dataDir, createIfMissing: false });
}

/**
 * @param {string} dataDir
 * @param {string} [workspaceFolder]
 * @returns {Record<string, any>[]}
 */
function safeListUsageLimits(dataDir, workspaceFolder) {
  try {
    if (String(workspaceFolder || '').trim()) {
      return listHarnessUsageLimitsForWorkspace({ dataDir, workspaceFolder });
    }
    return listHarnessUsageLimits(dataDir);
  } catch {
    return [];
  }
}

/**
 * Chat row lookup that reads the chat store at most once.
 *
 * @returns {(chatId: string) => Record<string, any> | null}
 */
function createCachedChatLookup() {
  /** @type {Map<string, Record<string, any>> | null} */
  let byId = null;
  return (chatId) => {
    if (!byId) {
      try {
        byId = new Map(loadChats().map((chat) => [String(chat?.id || ''), chat]));
      } catch {
        byId = new Map();
      }
    }
    return byId.get(String(chatId || '')) || null;
  };
}

/**
 * Stamp the orchestrator chat on the claimed todo and every ancestor so the
 * subtree knows which short-lived chat drives this cycle. Best-effort: an item
 * that moved on (CAS miss) is left untouched and never aborts the start.
 *
 * An ancestor stamped by a chat outside the watcher (a manual orchestrator)
 * keeps that stamp: it authorizes that chat's delegations on the whole tree,
 * and the cycle is already authorized by the stamp on its own leaf.
 *
 * @param {{
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   todoId: string,
 *   chatId: string,
 *   getChat?: (chatId: string) => Record<string, any> | null,
 * }} input
 * @returns {void}
 */
export function stampCycleOrchestratorOnTodoTree(input) {
  const chatId = String(input?.chatId || '').trim();
  const todoId = String(input?.todoId || '').trim();
  if (!chatId || !todoId) return;
  const getChat = typeof input.getChat === 'function' ? input.getChat : createCachedChatLookup();
  const isForeignOwner = (ownerId) => {
    if (!ownerId || ownerId === chatId) return false;
    const chat = getChat(ownerId);
    return Boolean(chat) && !String(chat.archivedAt || '').trim() && !isWorkspaceWatcherOrchestratorChat(chat);
  };
  try {
    const doc = loadTodosData(input.dataDir, input.workspaceFolder);
    const items = Array.isArray(doc?.items) ? doc.items : [];
    const byId = new Map(items.map((row) => [String(row?.id || ''), row]));
    const seen = new Set();
    let current = byId.get(todoId) || null;
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      const owner = String(current.orchestratorChatId || '').trim();
      const keepForeign = String(current.id) !== todoId && isForeignOwner(owner);
      if (owner !== chatId && !keepForeign) {
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

/**
 * Move running implement/fix delegations of `todoId` from earlier cycle chats to
 * the new cycle's chat. Best effort: a failure leaves the delegation with its old
 * controller and the cycle simply starts without an adoption hint.
 *
 * @param {{ todoId: string, chatId: string, workspaceFolder: string, dataDir?: string, deps?: Record<string, any> }} input
 * @returns {{ id: string, status: string }[]}
 */
export function adoptRunningLeafDelegations(input) {
  const deps = input.deps || {};
  try {
    const load = typeof deps.loadDelegations === 'function'
      ? deps.loadDelegations
      : () => loadDelegationsReadonly(input.dataDir ? { dataDir: input.dataDir } : {});
    const rows = listAdoptableLeafDelegations({
      todoId: input.todoId, chatId: input.chatId, workspaceFolder: input.workspaceFolder, delegations: load(),
    });
    if (!rows.length) return [];
    const reassign = typeof deps.reassignDelegationController === 'function'
      ? deps.reassignDelegationController
      : reassignDelegationController;
    reassign(rows.map((row) => row.id), input.chatId);
    return rows.map((row) => ({ id: String(row.id), status: String(row.status || 'running') }));
  } catch {
    return [];
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
 *   deps?: Record<string, any>,
 * }} [options]
 * @returns {Promise<{ ok: boolean, reason: string, report?: Record<string, any>, deferred?: boolean, replayed?: boolean, closed?: boolean, leafMerge?: Record<string, any> }>}
 */
export async function reportWorkspaceWatcherCycle(options = {}) {
  // The worktree diff is collected before the lock: the locked section below is
  // synchronous and must not shell out to Git on the event loop.
  const prefetchedDiff = await prefetchCycleIntegrationDiff(options);
  // One outer (re-entrant) lock so marker write -> claim release -> label
  // happen as one unit (review gate contract §4.2).
  const closeResult = withWorkspaceWatchersFileLock(
    () => reportWorkspaceWatcherCycleLocked(options, prefetchedDiff),
    { dataDir: dataDirOf(options) },
  );
  // A PASSed parallel leaf is merged into its tree worktree after the Watcher
  // lock is released: Git and the directory delete must not hold it.
  const mergeTodoId = String(prefetchedDiff.pendingLeafMergeTodoId || '');
  if (mergeTodoId && closeResult.ok && closeResult.closed) {
    const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
    const dataDir = dataDirOf(options);
    try {
      const merged = await applyParallelLeafMerge({
        workspaceFolder, dataDir, todoId: mergeTodoId, at: new Date().toISOString(), deps: options.deps,
      });
      if (merged) {
        mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
          decisions: [...row.decisions, merged.decision].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
        }), { dataDir, createIfMissing: false });
        closeResult.leafMerge = { status: merged.status, conflicts: merged.conflicts || [] };
      }
    } catch (error) {
      logDelegationEvent('workspace-watcher-leaf-merge-failed', {}, {
        workspaceFolder, todoId: mergeTodoId, message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return closeResult;
}

/**
 * Best-effort pre-read of the closing cycle's primary leaf: when a success
 * report is about to record an integration result for a live worktree, collect
 * its diff asynchronously. The locked section decides whether to use it; an
 * unused diff costs only the read, a failed collection is rethrown there so it
 * still closes as `integration_result_failed`.
 *
 * @param {Record<string, any>} options
 * @returns {Promise<{ diff: Record<string, any> | null, error: unknown, pendingLeafMergeTodoId?: string }>}
 */
async function prefetchCycleIntegrationDiff(options) {
  const empty = { diff: null, error: null };
  try {
    if (String(options.outcome || '').trim().toLowerCase() !== 'success') return empty;
    const dataDir = dataDirOf(options);
    const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
    const sourceChatId = String(options.sourceChatId || '').trim();
    if (!workspaceFolder || !sourceChatId) return empty;
    const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
    const cycle = row ? findWorkspaceWatcherCycle(row, { chatId: sourceChatId }) : null;
    const primaryTodoId = String(cycle?.todoIds?.[0] || '').trim();
    if (!cycle || cycle.planOnly === true || !primaryTodoId) return empty;
    const record = getWorktreeIntegrationRecord(primaryTodoId, dataDir);
    if (!record || !isWorktreeRecordLive(record) || record.creationState !== 'ready' || record.executionState !== 'active') return empty;
    try {
      return { diff: await collectWorktreeIntegrationDiff({ record, deps: options.deps }), error: null };
    } catch (error) {
      return { diff: null, error };
    }
  } catch {
    return empty;
  }
}

/**
 * @param {Record<string, any>} options
 * @returns {{ ok: boolean, reason: string, report?: Record<string, any>, deferred?: boolean, replayed?: boolean, closed?: boolean, leafMerge?: Record<string, any> }}
 */
function reportWorkspaceWatcherCycleLocked(options = {}, prefetchedDiff = { diff: null, error: null }) {
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
  const loadDelegationsFn = typeof deps.loadDelegations === 'function' ? deps.loadDelegations : loadDelegationsReadonly;

  let abortReason = '';
  let abortMessage = '';
  let replayed = false;
  let deferred = false;
  let closed = false;
  /** @type {Record<string, any> | null} */
  let reportEntry = null;
  /** @type {Record<string, any> | null} */
  let closedCycle = null;
  /** @type {Record<string, any> | null} */
  let closedTodo = null;
  /** @type {Record<string, any> | null} */
  let closedLeafOutcomes = null;
  let closedOutcome = null;
  let closedReason = '';
  /** @type {Record<string, any> | null} */
  let closedReviewGate = null;
  /** @type {Record<string, any> | null} */
  let blockedEscalation = null;

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
    // A `blocked` report is terminal: the orchestrator is waiting on a human, so
    // deferring the close until children finish would leave the slot (and its
    // todo) in `activeCycles` indefinitely and let the todo start a second cycle.
    // Exception: a `blocked` report caused only by a host verify that is still
    // running is not a human wait. The cycle stays open (nothing recorded as
    // blocked, no todo backoff) so the orchestrator resumes at review once the
    // verify finishes instead of the whole cycle restarting from scratch.
    const verifyOnlyBlock = outcome === 'blocked'
      && isVerifyPendingBlockMessage(options.message)
      && hasCycleChildWithPendingVerify(String(cycle.chatId || ''), loadDelegationsFn());
    // A `blocked` report is refused while this chat's own implement/fix child
    // still runs: the cycle must wait for it (or its own limit) instead.
    if (outcome === 'blocked' && !verifyOnlyBlock) {
      const running = listRunningImplementChildren(String(cycle.chatId || ''), loadDelegationsFn());
      if (running.length) {
        abortReason = 'child_running';
        abortMessage = `Cannot report "blocked": your delegation ${String(running[0].id || '').slice(0, 8)} is still running. Keep calling \`delegation_wait\` until it is terminal (or its own limit), read the report, then report.`;
        return null;
      }
    }
    const childActive = verifyOnlyBlock
      || (outcome !== 'blocked'
        && hasActiveWorkspaceWatcherCycleChildren(String(cycle.chatId || ''), loadDelegationsFn()));
    reportEntry = {
      reportId,
      cycleId: String(cycle.cycleId || ''),
      chatId: sourceChatId,
      outcome,
      todoIds,
      at,
      deferred: childActive,
      message: String(options.message || '').trim().slice(0, 500),
      ...(outcome === 'blocked' && normalizeWorkspaceWatcherBlockedReportCode(options.reasonCode)
        ? { reasonCode: normalizeWorkspaceWatcherBlockedReportCode(options.reasonCode) } : {}),
      ...(outcome === 'blocked' && normalizeWorkspaceWatcherBlockedReportDate(options.reasonDate, now)
        ? { reasonDate: normalizeWorkspaceWatcherBlockedReportDate(options.reasonDate, now) } : {}),
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
          ...(verifyOnlyBlock ? {} : { reportedOutcome: outcome }),
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
    let worktreeLeaf = false;
    if (cycle.planOnly !== true && primaryTodoId) {
      try {
        worktreeLeaf = isWorktreeRecordLive(getWorktreeIntegrationRecord(primaryTodoId, dataDir));
      } catch {
        worktreeLeaf = false;
      }
    }
    // Review gate first (contract §2.1b): it must precede the integration
    // result and feed `integrationCandidate`.
    const reviewGate = resolveWorkspaceWatcherCycleReviewGate({
      row,
      cycle,
      todo,
      reportedOutcome: outcome,
      worktree: worktreeLeaf,
      at,
    });
    // A leaf with its own worktree branched from the tree branch is not
    // integrated per leaf: after the lock is released it is merged into the tree
    // worktree (applyParallelLeafMerge).
    const parallelLeaf = String(outcome) === 'success' && cycle.planOnly !== true && primaryTodoId && !reviewGate.unsatisfied
      ? resolveParallelLeafWorktree({ todoId: primaryTodoId, dataDir })
      : null;
    if (parallelLeaf) prefetchedDiff.pendingLeafMergeTodoId = primaryTodoId;
    if (String(outcome) === 'success' && cycle.planOnly !== true && primaryTodoId && !reviewGate.unsatisfied && !parallelLeaf) {
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
    // A leaf working in its tree's shared worktree has no per-leaf integration
    // result; a verified PASS closes it as done and the work waits there for
    // root-level integration.
    const treeLeaf = String(outcome) === 'success' && cycle.planOnly !== true && primaryTodoId
      && !reviewGate.unsatisfied && !integrationCandidate && (!worktreeLeaf || parallelLeaf)
      ? (parallelLeaf
        ? { rootId: parallelLeaf.tree.todoId, record: parallelLeaf.tree }
        : resolveTreeWorktreeLeaf({ workspaceFolder, dataDir, todoId: primaryTodoId }))
      : null;
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
      treeWorktreeWait: Boolean(treeLeaf),
      reviewGateUnsatisfied: reviewGate.unsatisfied,
    });
    let finalOutcome = closeOutcome;
    let finalReason = closeReason;
    let treeWaitDecisions = [];
    if (treeLeaf && parallelLeaf && !(finalOutcome === 'success' && finalReason === 'cycle_success')) {
      prefetchedDiff.pendingLeafMergeTodoId = '';
    }
    if (treeLeaf && !parallelLeaf && finalOutcome === 'success' && finalReason === 'cycle_success') {
      if (markTreeWorktreeLeafDone({
        workspaceFolder, dataDir, todoId: primaryTodoId, rootId: treeLeaf.rootId, cycleId: String(cycle.cycleId || ''),
      })) {
        treeWaitDecisions = [buildTreeIntegrationWaitDecision({ at, todoId: primaryTodoId, rootId: treeLeaf.rootId })];
      }
    }
    // Reserved structured prefix: a blocked report naming a disabled phase.
    if (finalOutcome === 'blocked' && /^phase_disabled:/i.test(String(options.message || '').trim())) {
      finalReason = 'phase_disabled';
    }
    if (finalOutcome === 'success' && integrationCandidate && primaryTodoId) {
      try {
        const record = getWorktreeIntegrationRecord(primaryTodoId, dataDir);
        // Derive the review artifact of THIS cycle from its own delegations
        // (`docs/todo-review-contract.md` §8.1-§8.2). No hardcoded PASS: a cycle
        // without a fresh independent PASS + satisfied verify records honest
        // `unknown`/`verified:false` evidence even though it closes as success.
        const reviewEvidence = buildCycleReviewEvidence({
          cycleId: String(cycle.cycleId || ''),
          parentChatId: String(cycle.chatId || ''),
          leafId: primaryTodoId,
          rows: loadDelegationsFn(),
          now,
          workspaceFolder,
          dataDir,
        });
        if (prefetchedDiff.error) throw prefetchedDiff.error;
        if (!prefetchedDiff.diff) throw new Error('worktree diff was not prefetched for this cycle');
        const prepared = buildWorktreeIntegrationResult({
          todoId: primaryTodoId,
          cycleId: String(cycle.cycleId || ''),
          workspaceFolder,
          dataDir,
          record,
          outcome,
          reportedOutcome: outcome,
          reviewOutcome: reviewEvidence.outcome,
          reviewVerified: reviewEvidence.verified,
          reviewEvidence,
          testOutcome: 'passed',
          testEvidence: 'Workspace Watcher cycle close',
          now: at,
          deps,
        }, prefetchedDiff.diff);
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
    closedReviewGate = reviewGate;
    return buildWorkspaceWatcherCycleClosePatch({
      row: { ...row, reports: boundedReports },
      cycle,
      outcome: finalOutcome,
      decisionReason: finalReason,
      reviewWaits: reviewGate.reviewWaits || undefined,
      extraDecisions: [...(reviewGate.extraDecisions || []), ...treeWaitDecisions],
      todoIds,
      reports: boundedReports,
      now,
      at,
      closeSource: 'report',
      workspaceFolder,
      dataDir,
      todo,
      onBlockedEscalation: (escalation) => { blockedEscalation = escalation; },
    });
  }, { dataDir, createIfMissing: false });

  if (replayed) return { ok: true, reason: 'replayed', replayed: true, report: reportEntry };
  if (abortReason) return { ok: false, reason: abortReason, ...(abortMessage ? { message: abortMessage } : {}) };
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
    if (closedReviewGate?.warn && primaryTodoId) {
      recordReviewGateWarning({
        workspaceFolder,
        dataDir,
        todoId: primaryTodoId,
        chatId: sourceChatId,
        state: closedReviewGate.gate?.state,
      });
    }
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
    // After the claim release (which returns the todo to `ready`): a streak of
    // identical non-infra blocks parks the todo and tells the operator why.
    if (blockedEscalation && primaryTodoId && applyWorkspaceWatcherBlockedEscalation({
      workspaceFolder,
      dataDir,
      todoId: primaryTodoId,
      chatId: sourceChatId,
      escalation: blockedEscalation,
      message: reportEntry?.message,
      code: blockedEscalation.code,
    })) {
      void appendWorkspaceWatcherNotice({
        workspaceFolder,
        dataDir,
        action: 'cycle_blocked',
        level: 'warn',
        text: blockedEscalation.action === 'defer'
          ? `Todo ${primaryTodoId.slice(0, 8)} deferred until ${blockedEscalation.until}: ${reportEntry?.message || 'waits_for_date'}`
          : `Todo ${primaryTodoId.slice(0, 8)} moved to idea (${blockedEscalation.code}): ${reportEntry?.message || ''}`,
        todoId: primaryTodoId,
        cycleId: reportEntry?.cycleId,
        chatId: sourceChatId,
        at: reportEntry?.at,
        deps: deps.noticeDeps || {},
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
    void appendWorkspaceWatcherNotice({
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
 * Per-tick memo of the delegation rows. `reset()` drops the copy after a step
 * that may have changed rows.
 *
 * @param {(() => Record<string, any>[]) | undefined} loader
 * @param {string} dataDir
 * @returns {{ load: () => Record<string, any>[], reset: () => void }}
 */
export function createTickDelegationsMemo(loader, dataDir) {
  /** @type {Record<string, any>[] | null} */
  let rows = null;
  return {
    load: () => {
      if (!rows) rows = (typeof loader === 'function' ? loader() : loadDelegationsReadonly(dataDir ? { dataDir } : {})) || [];
      return rows;
    },
    reset: () => { rows = null; },
  };
}

/**
 * Close dead cycles of one workspace, each independently: a live sibling keeps
 * its claim, its lease and its slot. Returns the first closed cycle.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   now?: number,
 *   deps?: Record<string, any>,
 * }} [options]
 * @returns {{ closed: boolean, reason: string, cycle?: Record<string, any>, closedCount?: number }}
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
  const childChats = typeof deps.loadDelegations === 'function' ? deps.loadDelegations() : loadDelegationsReadonly();
  const slots = cycles.slice();
  /** @type {Record<string, any> | null} */
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
 * @param {Record<string, any> | null | undefined} live
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
 * @param {Record<string, any>} cycle
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
 * @param {Record<string, any>} cycle
 * @param {number} now
 * @returns {boolean}
 */
function isWorkspaceWatcherCycleStartProtected(cycle, now) {
  const phase = String(cycle?.phase || '').trim().toLowerCase();
  const startDeadlineAt = Date.parse(String(cycle?.startDeadlineAt || '').trim());
  return phase === 'starting' && Number.isFinite(startDeadlineAt) && now < startDeadlineAt;
}

/**
 * @param {Record<string, any>} cycle
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
 * @param {{ workspaceFolder: string, dataDir: string, now: number, cycle: Record<string, any>, probe: Function }} input
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
 * @param {{ workspaceFolder: string, dataDir: string, cycle: Record<string, any> }} input
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
 * Whether a slot belongs to a dead process and is absent from the adapters: its
 * instance token differs from the current one and the probe proves the room is
 * gone or idle. `busy`, `adapter_error` and other unknowns are NOT absent.
 *
 * @param {Record<string, any>} cycle
 * @param {Function} probe
 * @param {string} currentInstanceId
 * @returns {boolean}
 */
function isWorkspaceWatcherCycleDeadInstance(cycle, probe, currentInstanceId) {
  return isWorkspaceWatcherCycleRestartInterrupted({ cycle, probe, currentInstanceId });
}

/**
 * Close one cycle when its orchestrator chat is confirmed idle/missing and its
 * child delegations are terminal. Returns the closed cycle, or null.
 *
 * @param {{
 *   workspaceFolder: string,
 *   dataDir: string,
 *   now: number,
 *   deps: Record<string, any>,
 *   probe: Function,
 *   childChats: Record<string, any>[],
 *   row: Record<string, any>,
 *   cycle: Record<string, any>,
 * }} input
 * @returns {{ closed: boolean, reason: string, cycle?: Record<string, any> }}
 */
function reconcileWorkspaceWatcherCycleSlot(input) {
  return withWorkspaceWatchersFileLock(
    () => reconcileWorkspaceWatcherCycleSlotLocked(input),
    { dataDir: input.dataDir },
  );
}

/**
 * @param {Record<string, any>} input
 * @returns {{ closed: boolean, reason: string, cycle?: Record<string, any> }}
 */
function reconcileWorkspaceWatcherCycleSlotLocked(input) {
  const { workspaceFolder, dataDir, now, deps, probe, childChats, row, cycle } = input;
  const chatId = String(cycle.chatId || '').trim();
  const currentInstanceId = String(deps.instanceId || '').trim() || getProcessInstance().instanceId;
  // Dead-instance slot (leaf R11 B): reserved by another process and absent from
  // every adapter. The start deadline and the room-gone grace exist to survive
  // adapter lag in a LIVE process; here nothing can come back, so the slot must
  // not hold `maxParallel` for them. An `unknown` probe of a live-instance slot
  // never takes this path.
  const deadInstance = isWorkspaceWatcherCycleDeadInstance(cycle, probe, currentInstanceId);
  const startProtected = !deadInstance && chatId && isWorkspaceWatcherCycleStartProtected(cycle, now);
  const roomGone = !startProtected && chatId && isWorkspaceWatcherCycleRoomGone(cycle, probe);
  // A cycle whose orchestrator already reported `blocked` is terminal (it waits
  // on a human). Older builds deferred such a close behind live children, which
  // left the slot in `activeCycles` until lease expiry; reconcile now closes it
  // regardless of liveness or children.
  const reportedBlocked = isReportedBlockedCycle(cycle) && !startProtected;
  const childrenActive = !reportedBlocked && chatId && hasActiveWorkspaceWatcherCycleChildren(chatId, childChats);
  if (roomGone && childrenActive) {
    if (cycle.roomGoneSince) clearWorkspaceWatcherRoomGone({ workspaceFolder, dataDir, cycle });
    return { closed: false, reason: 'cycle_children_active' };
  }
  if (!reportedBlocked && roomGone && !deadInstance && !isWorkspaceWatcherRoomGoneGraceElapsed(cycle, now)) {
    if (!cycle.roomGoneSince) stampWorkspaceWatcherRoomGone({ workspaceFolder, dataDir, now, cycle, probe });
    return { closed: false, reason: 'cycle_room_gone_grace' };
  }
  if (!roomGone && cycle.roomGoneSince) {
    clearWorkspaceWatcherRoomGone({ workspaceFolder, dataDir, cycle });
  }
  const alive = !reportedBlocked && !roomGone && !deadInstance && chatId
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
  let worktreeLeaf = false;
  try {
    worktreeLeaf = Boolean(todoId) && isWorktreeRecordLive(getWorktreeIntegrationRecord(todoId, dataDir));
  } catch {
    worktreeLeaf = false;
  }
  const reviewGate = resolveWorkspaceWatcherCycleReviewGate({
    row,
    cycle,
    todo,
    reportedOutcome: String(cycle.reportedOutcome || ''),
    worktree: worktreeLeaf,
    at: new Date(now).toISOString(),
  });
  const { closeOutcome, countIncompleteFailure, closeReason } = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle,
    row,
    todo,
    reportedOutcomeRaw: cycle.reportedOutcome,
    mcpErrorCode: readMcpOrchestratorRunErrorCode(cycle, probe),
    leafOutcomes,
    reviewGateUnsatisfied: reviewGate.unsatisfied,
    restartInterrupted: deadInstance, // computed once per slot; each evaluation may cost several adapter probes
  });
  /** @type {Record<string, any> | null} */
  let closedCycle = null;
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row: current }) => {
    const currentCycle = findWorkspaceWatcherCycleBySlot(current, cycle);
    if (!currentCycle) return false;
    if (String(currentCycle.cycleId || '') !== expectedCycleId) return false;
    if (String(currentCycle.chatId || '') !== expectedChatId) return false;
    if (String(currentCycle.startedAt || '') !== expectedStartedAt) return false;
    // Re-check inside the lock. A room that came back, or a grace stamp that
    // is not old enough yet, must not be closed by a probe from before the lock.
    const stillDead = isWorkspaceWatcherCycleDeadInstance(currentCycle, probe, currentInstanceId);
    const stillStartProtected = !stillDead && expectedChatId && isWorkspaceWatcherCycleStartProtected(currentCycle, now);
    const stillRoomGone = !stillStartProtected && expectedChatId && isWorkspaceWatcherCycleRoomGone(currentCycle, probe);
    if (stillStartProtected) {
      closedReason = 'cycle_alive';
      return false;
    }
    const latestDelegations = typeof deps.loadDelegations === 'function'
      ? deps.loadDelegations()
      : loadDelegationsReadonly();
    const blockedNow = isReportedBlockedCycle(currentCycle) && !stillStartProtected;
    if (!blockedNow && expectedChatId && hasActiveWorkspaceWatcherCycleChildren(expectedChatId, latestDelegations)) {
      closedReason = 'cycle_children_active';
      return false;
    }
    if (!blockedNow && stillRoomGone && !stillDead && !isWorkspaceWatcherRoomGoneGraceElapsed(currentCycle, now)) {
      closedReason = 'cycle_room_gone_grace';
      return false;
    }
    if (!blockedNow && !stillRoomGone && !stillDead && expectedChatId && isWorkspaceWatcherActiveCycleChatAlive(currentCycle, probe, now)) {
      closedReason = 'cycle_alive';
      return false;
    }
    const reports = resolveDeferredWorkspaceWatcherReports(current.reports, currentCycle);
    // A missing report (or the concrete MCP failure behind it) is the actionable
    // cause, so `cycle_room_gone` (how the slot was detected dead) must not mask
    // it in the durable decision.
    if (closeOutcome === WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME) closedReason = closeReason;
    else if (closeReason === 'review_missing') closedReason = closeReason;
    else if (closeReason === 'missing_report' || closeReason === 'cycle_incomplete' || MCP_ORCHESTRATOR_ERROR_CODE_LIST.includes(closeReason)) closedReason = closeReason;
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
      reviewWaits: reviewGate.reviewWaits || undefined,
      extraDecisions: reviewGate.extraDecisions,
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
  if (reviewGate.warn && todoId) {
    recordReviewGateWarning({ workspaceFolder, dataDir, todoId, chatId, state: reviewGate.gate?.state });
  }
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
  if (todoId && chatId && (reportedBlocked || !hasActiveWorkspaceWatcherCycleChildren(chatId, childChats))) {
    releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder, todoId, chatId, cycleId: expectedCycleId, dataDir, now });
  }
  logDelegationEvent('workspace-watcher-cycle-closed', {}, {
    workspaceFolder,
    cycleId: expectedCycleId,
    chatId: expectedChatId,
    reason: closedReason,
  });
  const roomGoneNote = closedReason === 'cycle_room_gone' ? ' (cycle_room_gone)' : '';
  void appendWorkspaceWatcherNotice({
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
  void appendWorkspaceWatcherNotice({
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
 *   deps?: Record<string, any>,
 *   orchestratorArchiveDeps?: Record<string, any>,
 *   workspaceFolders?: string[],
 * }} [options]
 * @returns {Promise<{ at: string, scanned: number, started: number, closed: number, errors: Record<string, any>[], cycles: Record<string, any>[], skipped?: boolean, reason?: string }>}
 */
export async function runWorkspaceWatcherAutopilot(options = {}) {
  const dataDir = dataDirOf(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const deps = options.deps || {};
  const token = String(options.token || '').trim() || CYCLE_LEASE_TOKEN;
  const result = { at: new Date(now).toISOString(), scanned: 0, started: 0, closed: 0, errors: [], cycles: [] };
  // Boot readiness gate: an autopilot pass must never snapshot or start a cycle
  // before boot reconciliation finished. The worker is started only on the
  // ready path, but manual/MCP callers reach this function directly, so the
  // gate lives here too.
  if (!isBootReconciliationComplete()) {
    result.skipped = true;
    result.reason = 'boot_not_ready';
    return result;
  }

  /** @type {Record<string, any>[]} */
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
      // One delegation read per row and tick: reconcile and the stale-claim
      // sweep each loaded all rows (~4.5k). The tick body is synchronous up to
      // the cycle start, so the shared copy cannot go stale in between.
      const tickDelegations = createTickDelegationsMemo(deps.loadDelegations, dataDir);
      const reconcile = reconcileWorkspaceWatcherCycle({
        workspaceFolder: row.workspaceFolder,
        dataDir,
        now,
        deps: { ...deps, loadDelegations: tickDelegations.load },
      });
      if (reconcile.closed) {
        result.closed += 1;
        tickDelegations.reset();
      }
      // Scan the durable queue as well as newly closed cycles: throttled leaves
      // remain eligible after a process restart or an operator policy change.
      const integrationWatcher = getWorkspaceWatcher(row.workspaceFolder, { dataDir }) || row;
      if (integrationWatcher.policy?.autoIntegrate === true && !integrationWatcher.paused) {
        const candidates = loadTodosData(dataDir, row.workspaceFolder).items
          .filter((todo) => todo.integration?.state === 'ready' && !todo.integration?.appliedAt);
        for (const todo of candidates) {
          const automatic = await automaticallyIntegrateWorkspaceTodo({
            policy: integrationWatcher.policy, workspaceFolder: row.workspaceFolder, todoId: todo.id, dataDir,
          });
          if (!automatic.ok) result.errors.push({ workspaceFolder: row.workspaceFolder, todoId: todo.id, reason: automatic.reason });
        }
      }
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
      // Throttled to one sweep per 60 s per workspace: a claim held by a dead
      // orchestrator can therefore stay hidden for up to 60 s before a cycle
      // starts. Accepted trade-off; boot reconcile, claim and control paths
      // call the unthrottled sweep and release immediately.
      releaseStaleWorkspaceTodoClaimsThrottled({
        workspaceFolder: row.workspaceFolder,
        dataDir,
        probeChatRunLiveness: deps.probeChatRunLiveness,
        loadDelegations: tickDelegations.load,
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

/**
 * @param {unknown} message
 * @returns {boolean}
 */
export function isVerifyPendingBlockMessage(message) {
  return /verify[_\s-]*(pending|running|in[_\s-]*flight)/i.test(String(message || ''));
}

/**
 * True when a delegation of the cycle chat still has an automatic host verify
 * in flight (marker younger than the gate's max age).
 *
 * @param {string} chatId
 * @param {Record<string, any>[]} delegations
 * @returns {boolean}
 */
export function hasCycleChildWithPendingVerify(chatId, delegations) {
  if (!chatId || !Array.isArray(delegations)) return false;
  const now = Date.now();
  return delegations.some((row) => {
    if (!canChatControlDelegation(row, chatId)) return false;
    const since = Date.parse(String(row?.verifyPending?.since || ''));
    return Number.isFinite(since) && now - since < VERIFY_PENDING_MAX_AGE_MS;
  });
}
