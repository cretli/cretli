/**
 * Shared workspace-watcher cycle close logic for runtime reconcile and boot
 * reconcile. Lives outside workspace-watcher.js and workspace-watcher-cycle.js
 * so neither module imports the other for close accounting.
 */

import { delegationController } from './delegation-control.js';
import { loadTodosData, updateTodo, withTodosWatcherNudgeSuppressed } from './persist/todos-persist.js';
import { isDelegationSlotOccupied } from './delegation-status.js';
import { isImplementationWorkDelegationRow } from './delegation-work-role.js';
import { readDelegationWorkflowLeafIdFromRow } from './delegation-workflow-leaf.js';
import {
  getWorkspaceWatcher,
  getWorkspaceWatcherActiveCycles,
  mutateWorkspaceWatcherRow,
  releaseWorkspaceWatcherLease,
  removeWorkspaceWatcherCycle,
  WORKSPACE_WATCHER_CYCLE_CLOSE_OUTCOMES,
  WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME,
  WORKSPACE_WATCHER_CYCLE_OUTCOMES,
  WORKSPACE_WATCHER_MAX_CYCLE_CHATS,
} from './persist/workspace-watchers-persist.js';
import { isWorkspaceWatcherInfraFailure } from './workspace-watcher-scheduler.js';
import {
  applyWorkspaceWatcherInfraClassification,
  classifyWorkspaceWatcherCycleInfraCause,
  computeWorkspaceWatcherBackoffUntil,
  nextWorkspaceWatcherBlockedBackoff,
} from './workspace-watcher-guardrails.js';
import { workspaceWatcherFailureCeilingReason } from './workspace-watcher-blocked-reason.js';
import {
  REVIEW_MISSING_REASON,
  buildReviewGateBlockedReason,
  evaluateReviewGate,
  isReviewGateBlockedReason,
  isReviewMarkerHoldingDoing,
  nextReviewWaitsAfterClose,
  resolveReviewGateMaterialRevision,
  resolveReviewGateMaxAttempts,
  resolveReviewGateMode,
} from './workspace-watcher-review-gate.js';
import { isTodoAwaitingIntegration } from './todo-integration-state.js';
import { getWorktreeRecord, mutateWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { isWorktreeRecordLive } from './worktree/worktree-record.ts';
import { mergeLeafIntoTree, removeWorktreeInBackground, TREE_MERGE_CONFLICT_CODE, TREE_MERGE_FAILED_CODE } from './worktree-tree-leaf.js';
import { updateWorktreeState } from './worktree-manager.js';
import { logDelegationEvent } from './delegation-log.js';
import { loadDelegations } from './persist/delegations-persist.js';
import { loadDelegationWorkflows } from './persist/delegation-workflows-persist.js';
import { buildWorkspaceWatcherCycleAttribution } from './workspace-watcher-cycle-attribution.js';
import { collectCycleUsageSources } from './workspace-watcher-cycle-metrics.js';
import {
  buildCycleUsageMembership,
  classifyCycleUsageEvent,
} from './workspace-watcher-cycle-usage.js';

/**
 * Verified per-leaf outcome vocabulary, mirrored from the metrics store so the
 * close logic and the normalizer can never drift.
 *
 * @type {readonly string[]}
 */
export const WORKSPACE_WATCHER_TODO_LEAF_OUTCOMES = Object.freeze(['attempted', 'completed', 'blocked', 'unknown']);

/**
 * Whether a cycle's plan-only deliverable exists on a todo. `planSaved` is
 * intentionally weaker than `hasPendingWorkspaceWatcherPlanDraft`: an approved
 * plan is still a saved plan, and a plan-only cycle's verified success means
 * the plan artifact was written — not that the todo reached `done`.
 *
 * @param {Record<string, any> | null} todo
 * @returns {boolean}
 */
export function hasWorkspaceWatcherPlanArtifact(todo) {
  const row = todo && typeof todo === 'object' ? todo : null;
  return Boolean(row && String(row.plan?.markdown ?? '').trim());
}

/**
 * A plan-only cycle whose draft is still waiting for a human is not a stalled
 * cycle: the gate is closed on purpose. Used both by the incomplete-progress
 * test and by the close patch, so the stored plan request survives its own
 * failure counter instead of being deleted.
 *
 * @param {Record<string, any> | null} todo
 * @returns {boolean}
 */
export function hasPendingWorkspaceWatcherPlanDraft(todo) {
  const row = todo && typeof todo === 'object' ? todo : null;
  if (!row) return false;
  const hasMarkdown = String(row.plan?.markdown ?? '').trim().length > 0;
  const approvedAt = String(row.plan?.approvedAt ?? '').trim();
  return hasMarkdown && !approvedAt;
}

/**
 * @param {{ cycle: Record<string, any>, todo: Record<string, any> | null, watcher: Record<string, any> | null }} input
 * @returns {boolean}
 */
export function shouldCountWorkspaceWatcherCycleIncomplete(input) {
  const todo = input.todo;
  if (!todo || typeof todo !== 'object') return false;
  if (String(todo.status || '') === 'done') return false;
  // A worktree PASS keeps the todo `doing` on purpose; integration readiness is
  // a verified success, not unfinished work (contract §8.3).
  if (isTodoAwaitingIntegration(todo)) return false;
  const cycle = input.cycle || {};
  if (cycle.planOnly === true) {
    if (hasPendingWorkspaceWatcherPlanDraft(todo)) return false;
    const status = String(todo.status || '');
    return status === 'doing' || status === 'ready';
  }
  const watcher = input.watcher || {};
  const policy = watcher.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const todoId = String(todo.id || '').trim();
  if (policy.requirePlanApproval !== false && todoId) {
    const approvedAt = String(todo.plan?.approvedAt ?? '').trim();
    const planRequests = watcher.planRequests && typeof watcher.planRequests === 'object'
      ? watcher.planRequests
      : {};
    if (!approvedAt && String(planRequests[todoId] ?? '').trim()) {
      return false;
    }
  }
  return String(todo.status || '') === 'doing' || String(todo.status || '') === 'ready';
}

/**
 * How long a recorded automatic host verify (`verifyPending`) keeps a cycle
 * alive. The marker is cleared when the verify settles; the bound only covers a
 * marker orphaned by a crash or restart mid-verify.
 */
export const WORKSPACE_WATCHER_VERIFY_PENDING_MAX_MS = 45 * 60 * 1000;

/**
 * @param {{ verifyPending?: { since?: string } | null }} row
 * @param {number} nowMs
 * @returns {boolean}
 */
function hasFreshVerifyPending(row, nowMs) {
  const since = Date.parse(String(row?.verifyPending?.since || ''));
  return Number.isFinite(since) && nowMs - since < WORKSPACE_WATCHER_VERIFY_PENDING_MAX_MS;
}

/**
 * A cycle whose orchestrator already reported `blocked` (terminal: waiting on a human).
 *
 * @param {Record<string, any> | null | undefined} cycle
 * @returns {boolean}
 */
export function isReportedBlockedCycle(cycle) {
  return String(cycle?.reportedOutcome || '').trim().toLowerCase() === 'blocked';
}

/**
 * A cycle still has work in flight while a child holds a delegation slot or
 * while the automatic host verify of a finished implement/fix is running: the
 * orchestrator legitimately ends its turn to wait for that verify before it can
 * start the review, and closing the cycle then would record a false
 * `missing_report` failure.
 *
 * @param {string} chatId
 * @param {Record<string, any>[]} [delegations]
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function hasActiveWorkspaceWatcherCycleChildren(chatId, delegations, nowMs = Date.now()) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  return (Array.isArray(delegations) ? delegations : []).some((row) => (
    String(delegationController(row) || '') === id
    && (isDelegationSlotOccupied(row) || hasFreshVerifyPending(row, nowMs))
  ));
}

/**
 * The implement/fix children of a cycle's orchestrator chat that still hold the
 * write slot. A `blocked` report while one runs would free the cycle (and its
 * todo) while the child keeps the single write slot busy, so later cycles could
 * not start an implement at all.
 *
 * @param {string} chatId
 * @param {Record<string, any>[]} [delegations]
 * @returns {Record<string, any>[]}
 */
export function listRunningImplementChildren(chatId, delegations) {
  const id = String(chatId || '').trim();
  if (!id) return [];
  return (Array.isArray(delegations) ? delegations : []).filter((row) => (
    String(delegationController(row) || '') === id
    && isImplementationWorkDelegationRow(row)
    && isDelegationSlotOccupied(row)
  ));
}

/**
 * Running implement/fix delegations of the same leaf and workspace that were
 * left behind by an earlier cycle's chat. A new cycle adopts them instead of
 * trying a second `delegation_start` (which the single write slot would refuse).
 *
 * @param {{ todoId: string, chatId: string, workspaceFolder?: string, delegations?: Record<string, any>[] }} input
 * @returns {Record<string, any>[]}
 */
export function listAdoptableLeafDelegations(input) {
  const todoId = String(input?.todoId || '').trim();
  const chatId = String(input?.chatId || '').trim();
  if (!todoId || !chatId) return [];
  const folder = String(input?.workspaceFolder || '').trim();
  return (Array.isArray(input?.delegations) ? input.delegations : []).filter((row) => (
    String(delegationController(row) || '') !== chatId
    && isImplementationWorkDelegationRow(row)
    && isDelegationSlotOccupied(row)
    && readDelegationWorkflowLeafIdFromRow(row) === todoId
    && (!folder || !row.workspaceFolder || String(row.workspaceFolder) === folder)
  ));
}

/**
 * Resolve the durable close outcome from a stored report and the verified leaf
 * state.
 *
 * A cycle that ends without a durable report is never a success, not even when
 * the todo happens to be done (the one exception is a restart-interrupted
 * dead-instance cycle whose todo is already done, which closes as success): an orchestrator that finished its work but could
 * not call `watcher_update` (the incident this closes the hole for) left the
 * watcher with nothing to audit. `mcpErrorCode` is the concrete failure of the
 * orchestrator run, already filtered by the caller; when it is present it
 * outranks the generic `missing_report` reason.
 *
 * A reported `success` is only kept when the workspace confirms it: a missing
 * todo or an unreadable todo store is `unknown`, which is a failure, never a
 * success. For a plan-only cycle the verified success is a saved plan on the
 * plan target (the leaf itself stays in progress), so an unsaved plan is a
 * failure even when the model reported success.
 *
 * @param {{
 *   cycle: Record<string, any>,
 *   row: Record<string, any>,
 *   todo: Record<string, any> | null,
 *   reportedOutcomeRaw?: string,
 *   mcpErrorCode?: string,
 *   leafOutcomes?: Record<string, any> | null,
 *   planTodo?: Record<string, any> | null,
 *   integrationReady?: boolean,
 *   treeWorktreeWait?: boolean,
 *   reviewGateUnsatisfied?: boolean,
 *   reviewUnknown?: boolean,
 *   restartInterrupted?: boolean,
 * }} input
 * @returns {{ closeOutcome: string, countIncompleteFailure: boolean, closeReason: string }}
 */
export function resolveWorkspaceWatcherCycleCloseOutcome(input) {
  const cycle = input.cycle || {};
  const row = input.row || {};
  const reportedOutcome = WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(String(input.reportedOutcomeRaw || ''))
    ? String(input.reportedOutcomeRaw)
    : '';
  // `restartInterrupted` is computed from restart evidence by the caller (slot
  // instance token). Without a report it is neutral: the cycle did not fail,
  // the process died under it. A reported outcome always wins, and any other
  // orphan keeps the failure path below.
  const todoDone = String(input.todo?.status || '') === 'done';
  // A todo already `done` was finished before the process died, so it closes
  // as success instead of interrupted_restart (and keeps no failure history).
  if (input.restartInterrupted === true && !reportedOutcome && todoDone) {
    return { closeOutcome: 'success', countIncompleteFailure: false, closeReason: 'cycle_success' };
  }
  if (input.restartInterrupted === true && !reportedOutcome) {
    return {
      closeOutcome: WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME,
      countIncompleteFailure: false,
      closeReason: WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME,
    };
  }
  const todo = input.todo;
  const leafOutcomes = input.leafOutcomes && typeof input.leafOutcomes === 'object' ? input.leafOutcomes : null;
  const planOnly = cycle.planOnly === true;
  if (reportedOutcome === 'success') {
    const primaryOutcome = leafOutcomes ? String(leafOutcomes.primaryOutcome || '') : '';
    // Reported success without a verifiable workspace state (missing todo or a
    // read failure) must not be promoted to a durable success.
    if (primaryOutcome === 'unknown') {
      return {
        closeOutcome: 'failure',
        countIncompleteFailure: true,
        closeReason: 'cycle_incomplete',
      };
    }
    if (!leafOutcomes && !todo) {
      return {
        closeOutcome: 'failure',
        countIncompleteFailure: true,
        closeReason: 'cycle_incomplete',
      };
    }
    if (planOnly) {
      const planSaved = leafOutcomes
        ? leafOutcomes.planSaved === true
        : hasWorkspaceWatcherPlanArtifact(input.planTodo || todo);
      if (!planSaved) {
        return {
          closeOutcome: 'failure',
          countIncompleteFailure: true,
          closeReason: 'cycle_incomplete',
        };
      }
      return {
        closeOutcome: 'success',
        countIncompleteFailure: false,
        closeReason: 'cycle_success',
      };
    }
    // Review gate (enforce): an unreviewed leaf is waiting for a human-grade
    // review, not a failure — it must not reach `cycle_incomplete`.
    if (input.reviewGateUnsatisfied === true) {
      return {
        closeOutcome: 'blocked',
        countIncompleteFailure: false,
        closeReason: REVIEW_MISSING_REASON,
      };
    }
    if (input.integrationReady === true) {
      return {
        closeOutcome: 'success',
        countIncompleteFailure: false,
        closeReason: 'cycle_success',
      };
    }
    // A leaf in a shared tree worktree has no integration result of its own:
    // its PASS closes the cycle and the work waits for root-level integration.
    // Only an independent review PASS qualifies; any other state falls through.
    if (input.treeWorktreeWait === true && String(todo?.review?.code?.state || '') === 'passed') {
      return {
        closeOutcome: 'success',
        countIncompleteFailure: false,
        closeReason: 'cycle_success',
      };
    }
    // A reported success whose code review stayed `unknown` (verify missing,
    // infra BLOCKED, ...) is a review wait, not a failure: do not count it.
    if (input.reviewUnknown === true || String(todo?.review?.code?.state || '') === 'unknown') {
      return {
        closeOutcome: 'blocked',
        countIncompleteFailure: false,
        closeReason: REVIEW_MISSING_REASON,
      };
    }
    const incomplete = shouldCountWorkspaceWatcherCycleIncomplete({ cycle, todo, watcher: row });
    if (incomplete) {
      return {
        closeOutcome: 'failure',
        countIncompleteFailure: true,
        closeReason: 'cycle_incomplete',
      };
    }
    return {
      closeOutcome: 'success',
      countIncompleteFailure: false,
      closeReason: 'cycle_success',
    };
  }
  // A reported `blocked` keeps its own cause (`cycle_blocked` -> reported_blocked)
  // and the blocked backoff, even on a gated leaf without a passing review: the
  // report may name a non-review cause (e.g. no access) that must not be masked
  // as `review_missing`. Only a reported success, or a cycle that ended without
  // any report, is turned into a review wait by the gate above.
  if (reportedOutcome) {
    return {
      closeOutcome: reportedOutcome,
      countIncompleteFailure: reportedOutcome !== 'success',
      closeReason: `cycle_${reportedOutcome}`,
    };
  }
  const mcpErrorCode = String(input.mcpErrorCode || '').trim();
  return {
    closeOutcome: 'failure',
    countIncompleteFailure: true,
    closeReason: mcpErrorCode || 'missing_report',
  };
}

/**
 * @param {{
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   cycle: Record<string, any>,
 *   row: Record<string, any>,
 * }} input
 * @returns {Record<string, any> | null}
 */
export function loadPrimaryTodoForWorkspaceWatcherCycle(input) {
  const todoId = String(input.cycle?.todoIds?.[0] || '').trim();
  return loadWorkspaceWatcherTodoById({
    workspaceFolder: input.workspaceFolder,
    dataDir: input.dataDir,
    todoId,
  });
}

/**
 * @param {{ workspaceFolder?: string, dataDir?: string, todoId?: string }} input
 * @returns {Record<string, any> | null}
 */
export function loadWorkspaceWatcherTodoById(input) {
  const todoId = String(input.todoId || '').trim();
  if (!todoId || !input.workspaceFolder) return null;
  try {
    const doc = loadTodosData(input.dataDir, input.workspaceFolder);
    return (Array.isArray(doc?.items) ? doc.items : []).find((row) => row?.id === todoId) || null;
  } catch {
    return null;
  }
}

/**
 * Plan-only cycles may store the draft on the subtree root (`planTargetId`)
 * while the cycle todo id remains the picked leaf.
 *
 * @param {{
 *   cycle?: Record<string, any>,
 *   todo?: Record<string, any> | null,
 *   workspaceFolder?: string,
 *   dataDir?: string,
 * }} input
 * @returns {Record<string, any> | null}
 */
export function resolvePlanDraftTodoForCycleClose(input) {
  const cycle = input.cycle && typeof input.cycle === 'object' ? input.cycle : {};
  const primaryTodoId = String(cycle.todoIds?.[0] || '').trim();
  const planTargetId = String(cycle.planTargetId || '').trim() || primaryTodoId;
  if (!planTargetId || planTargetId === primaryTodoId) {
    return input.todo && typeof input.todo === 'object' ? input.todo : null;
  }
  return loadWorkspaceWatcherTodoById({
    workspaceFolder: input.workspaceFolder,
    dataDir: input.dataDir,
    todoId: planTargetId,
  });
}

/**
 * Read one todo together with the *reason* it could not be resolved. The
 * difference matters at close: a missing todo and an unreadable store are both
 * "not verified", but the metric records which one so a transient store failure
 * is not mistaken for deleted work.
 *
 * @param {{ workspaceFolder?: string, dataDir?: string, todoId?: string }} input
 * @returns {{ found: boolean, todo: Record<string, any> | null, readError: string | null }}
 */
export function readWorkspaceWatcherTodo(input = {}) {
  const todoId = String(input.todoId || '').trim();
  if (!todoId) return { found: false, todo: null, readError: null };
  if (!input.workspaceFolder) return { found: false, todo: null, readError: 'no_workspace' };
  try {
    const doc = loadTodosData(input.dataDir, input.workspaceFolder);
    const todo = (Array.isArray(doc?.items) ? doc.items : [])
      .find((row) => String(row?.id || '') === todoId) || null;
    return { found: Boolean(todo), todo, readError: null };
  } catch (error) {
    return {
      found: false,
      todo: null,
      readError: error instanceof Error ? error.message : String(error ?? 'read_error'),
    };
  }
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function uniqueIds(raw) {
  /** @type {string[]} */
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const id = String(value ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Snapshot the verified outcome of every TODO leaf a cycle touched, from the
 * workspace state at close.
 *
 * Claimed ids and reported ids stay separate. A reported id that does not exist
 * in the workspace is recorded as `unknown` (never `completed`) and listed in
 * `unknownReportedTodoIds`. A missing todo or a read error is `unknown`, so a
 * model report alone can never manufacture a completion.
 *
 * `planSaved` is the plan-only deliverable flag: for a plan-only cycle the
 * verified success is a written plan, not a `done` todo.
 *
 * @param {{
 *   cycle?: Record<string, any>,
 *   claimedTodoIds?: string[],
 *   reportedTodoIds?: string[],
 *   loadTodo?: (todoId: string) => { found: boolean, todo: Record<string, any> | null, readError?: string | null },
 * }} [input]
 * @returns {{
 *   claimedTodoIds: string[],
 *   reportedTodoIds: string[],
 *   unknownReportedTodoIds: string[],
 *   completedTodoIds: string[],
 *   attemptedTodoIds: string[],
 *   blockedTodoIds: string[],
 *   todoOutcomes: Record<string, any>[],
 *   primaryOutcome: string,
 *   primaryStatus: string,
 *   planSaved: boolean,
 *   reliable: boolean,
 * }}
 */
export function resolveWorkspaceWatcherCycleTodoOutcomes(input = {}) {
  const cycle = input.cycle && typeof input.cycle === 'object' ? input.cycle : {};
  const planOnly = cycle.planOnly === true;
  const claimedTodoIds = uniqueIds([
    ...(Array.isArray(input.claimedTodoIds) ? input.claimedTodoIds : []),
    ...(Array.isArray(cycle.claimedTodoIds) ? cycle.claimedTodoIds : []),
    ...(Array.isArray(cycle.todoIds) ? cycle.todoIds : []),
  ]);
  const reportedTodoIds = uniqueIds(input.reportedTodoIds);
  const planTargetId = String(cycle.planTargetId || '').trim();
  const claimedSet = new Set(claimedTodoIds);
  const reportedSet = new Set(reportedTodoIds);
  const inspect = uniqueIds([...claimedTodoIds, planTargetId, ...reportedTodoIds].filter(Boolean));
  const loadTodo = typeof input.loadTodo === 'function' ? input.loadTodo : null;
  /** @type {Record<string, any>[]} */
  const todoOutcomes = [];
  /** @type {string[]} */
  const reportedValidated = [];
  /** @type {string[]} */
  const unknownReportedTodoIds = [];
  for (const todoId of inspect) {
    const claimed = claimedSet.has(todoId);
    const reported = reportedSet.has(todoId);
    const planTarget = Boolean(planTargetId) && todoId === planTargetId;
    const resolved = loadTodo ? loadTodo(todoId) : null;
    const found = Boolean(resolved && resolved.found && resolved.todo && typeof resolved.todo === 'object');
    const readError = resolved && resolved.readError ? String(resolved.readError) : null;
    const status = found ? (String(resolved.todo.status || '').trim() || 'unknown') : 'unknown';
    const planSaved = found && planOnly && hasWorkspaceWatcherPlanArtifact(resolved.todo);
    let outcome;
    if (!found) outcome = 'unknown';
    else if (planOnly) outcome = planSaved || status === 'done' ? 'completed' : (status === 'doing' ? 'attempted' : 'blocked');
    else if (status === 'done') outcome = 'completed';
    else if (status === 'doing') outcome = 'attempted';
    else if (status === 'ready') outcome = 'blocked';
    else outcome = 'unknown';
    todoOutcomes.push({ todoId, claimed, reported, planTarget, outcome, status, planSaved, readError });
    if (reported) {
      if (found) reportedValidated.push(todoId);
      else unknownReportedTodoIds.push(todoId);
    }
  }
  const ofOutcome = (value) => todoOutcomes
    .filter((entry) => entry.outcome === value && (entry.claimed || entry.reported))
    .map((entry) => entry.todoId);
  const primary = todoOutcomes.find((entry) => entry.claimed) || todoOutcomes[0] || null;
  return {
    claimedTodoIds,
    reportedTodoIds: reportedValidated,
    unknownReportedTodoIds,
    completedTodoIds: ofOutcome('completed'),
    attemptedTodoIds: ofOutcome('attempted'),
    blockedTodoIds: ofOutcome('blocked'),
    todoOutcomes,
    primaryOutcome: primary ? primary.outcome : 'unknown',
    primaryStatus: primary ? primary.status : 'unknown',
    planSaved: todoOutcomes.some((entry) => entry.planSaved === true),
    reliable: Boolean(primary && primary.outcome !== 'unknown'),
  };
}

/**
 * Resolve the leaf outcomes against the real workspace, reading each todo at
 * most once per close. Kept as a thin binder over the pure resolver so tests can
 * exercise the pure shape without a store.
 *
 * @param {{
 *   cycle?: Record<string, any>,
 *   workspaceFolder?: string,
 *   dataDir?: string,
 *   reportedTodoIds?: string[],
 * }} [input]
 * @returns {ReturnType<typeof resolveWorkspaceWatcherCycleTodoOutcomes>}
 */
export function resolveWorkspaceWatcherCycleTodoOutcomesForClose(input = {}) {
  /** @type {Map<string, { found: boolean, todo: Record<string, any> | null, readError: string | null }>} */
  const cache = new Map();
  const loadTodo = (todoId) => {
    if (cache.has(todoId)) return cache.get(todoId);
    const resolved = readWorkspaceWatcherTodo({
      workspaceFolder: input.workspaceFolder,
      dataDir: input.dataDir,
      todoId,
    });
    cache.set(todoId, resolved);
    return resolved;
  };
  return resolveWorkspaceWatcherCycleTodoOutcomes({
    cycle: input.cycle,
    reportedTodoIds: input.reportedTodoIds,
    loadTodo,
  });
}

/**
 * The reported todo ids a deferred report left on the row for a cycle. Used by
 * the reconcile paths, where the live slot is closed later from the stored
 * report instead of from a fresh `report` call.
 *
 * @param {Record<string, any> | null | undefined} row
 * @param {Record<string, any> | null | undefined} cycle
 * @returns {string[]}
 */
export function resolveReportedTodoIdsForCycle(row, cycle) {
  const reports = Array.isArray(row?.reports) ? row.reports : [];
  if (!reports.length) return [];
  const reportId = String(cycle?.reportId || '').trim();
  const cycleId = String(cycle?.cycleId || '').trim();
  const entry = reports.find((candidate) => (
    (reportId && String(candidate?.reportId || '') === reportId)
    || (cycleId && String(candidate?.cycleId || '') === cycleId)
  ));
  return entry && Array.isArray(entry.todoIds)
    ? entry.todoIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
}

/**
 * Structured codes an orchestrator may attach to a `blocked` report. The code
 * comes from an LLM, so it is validated here and never trusted: anything
 * outside this list is treated as unspecified.
 */
export const WORKSPACE_WATCHER_BLOCKED_REPORT_CODES = Object.freeze([
  'waits_for_date', 'needs_human', 'needs_rescope', 'env_infra',
]);

/** Consecutive blocked reports with the same non-infra code that park the todo. */
export const WORKSPACE_WATCHER_BLOCKED_REASON_STREAK_LIMIT = 2;

/**
 * @param {unknown} raw
 * @returns {string} a known code, or '' (unspecified)
 */
export function normalizeWorkspaceWatcherBlockedReportCode(raw) {
  const code = String(raw ?? '').trim().toLowerCase();
  return WORKSPACE_WATCHER_BLOCKED_REPORT_CODES.includes(code) ? code : '';
}

/**
 * Validate a `waits_for_date` date: ISO `YYYY-MM-DD` (optionally with a time),
 * a real calendar date, strictly after `now`. Returns the normalized ISO string
 * or '' when it is not usable.
 *
 * @param {unknown} raw
 * @param {number} now
 * @returns {string}
 */
export function normalizeWorkspaceWatcherBlockedReportDate(raw, now) {
  const text = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(text)) return '';
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || ms <= now) return '';
  // Reject overflowed dates such as 2026-02-31 that Date.parse rolls over.
  if (new Date(ms).toISOString().slice(0, 10) !== text.slice(0, 10) && text.length === 10) return '';
  return text;
}

/**
 * Decide what a blocked report does to the per-todo streak of consecutive
 * non-infra blocks, which lives next to (not inside) `blockedBackoff`.
 * Pure: state in, decision out.
 *
 * A `waits_for_date` report without a usable future date, an `env_infra`
 * report, an unknown code and any non-blocked outcome all reset the streak.
 *
 * @param {{
 *   previous?: { code?: string, count?: number } | null,
 *   outcome: string,
 *   code?: unknown,
 *   date?: unknown,
 *   now?: number,
 * }} input
 * @returns {{
 *   next: { code: string, count: number } | null,
 *   escalation: { action: 'defer', until: string } | { action: 'idea' } | null,
 * }}
 */
export function evaluateWorkspaceWatcherBlockedReasonStreak(input) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const none = { next: null, escalation: null };
  if (input.outcome !== 'blocked') return none;
  const code = normalizeWorkspaceWatcherBlockedReportCode(input.code);
  if (!code || code === 'env_infra') return none;
  const until = code === 'waits_for_date'
    ? normalizeWorkspaceWatcherBlockedReportDate(input.date, now)
    : '';
  if (code === 'waits_for_date' && !until) return none;
  const prev = input.previous;
  const count = prev && prev.code === code && Number(prev.count) > 0 ? Number(prev.count) + 1 : 1;
  if (count < WORKSPACE_WATCHER_BLOCKED_REASON_STREAK_LIMIT) return { next: { code, count }, escalation: null };
  return {
    next: null,
    escalation: code === 'waits_for_date' ? { action: 'defer', until } : { action: 'idea' },
  };
}

/**
 * Park a todo after a blocked-reason streak: `deferred` (with `deferredUntil`)
 * or back to `idea` with the report text recorded. Best-effort: a todo that
 * moved on is left alone.
 *
 * @param {{
 *   workspaceFolder: string, todoId: string, chatId?: string, dataDir?: string,
 *   escalation: { action: string, until?: string }, message?: string, code?: string,
 * }} input
 * @returns {boolean}
 */
export function applyWorkspaceWatcherBlockedEscalation(input) {
  try {
    return withTodosWatcherNudgeSuppressed(() => {
      const doc = loadTodosData(input.dataDir, input.workspaceFolder);
      const current = (Array.isArray(doc?.items) ? doc.items : [])
        .find((row) => String(row?.id || '') === String(input.todoId || '')) || null;
      if (!current) return false;
      // Only the released state is ours to park: the claim release returned the
      // todo to `ready`. `doing`, a claim held by anyone, or a live lease means
      // another run owns it now, so it stays untouched.
      if (current.status !== 'ready') return false;
      if (String(current.claimedByChatId || '').trim()) return false;
      const leaseUntil = Date.parse(String(current.claimLeaseUntil || ''));
      if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) return false;
      const text = String(input.message || '').trim();
      const defer = input.escalation.action === 'defer';
      updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
        status: defer ? 'deferred' : 'idea',
        strictStatus: true,
        claimedByChatId: null,
        claimedAt: null,
        claimLeaseUntil: null,
        ...(defer ? { deferredUntil: input.escalation.until, deferredReason: text || 'waits_for_date' } : {}),
        blockedReason: defer ? null : (text || String(input.code || 'needs_human')),
        expectedUpdatedAt: current.updatedAt,
        appendChangelog: {
          kind: 'note',
          chatId: input.chatId,
          text: defer
            ? `Workspace Watcher deferred this todo until ${input.escalation.until} after ${WORKSPACE_WATCHER_BLOCKED_REASON_STREAK_LIMIT} consecutive blocked reports (waits_for_date). ${text}`.trim()
            : `Workspace Watcher moved this todo to idea after ${WORKSPACE_WATCHER_BLOCKED_REASON_STREAK_LIMIT} consecutive blocked reports (${input.code}). ${text}`.trim(),
        },
      });
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Find the stored report of a cycle (by report id, else cycle id).
 *
 * @param {Record<string, any>[] | undefined} reports
 * @param {Record<string, any> | null | undefined} cycle
 * @returns {Record<string, any> | null}
 */
function findCycleReport(reports, cycle) {
  const reportId = String(cycle?.reportId || '').trim();
  const cycleId = String(cycle?.cycleId || '').trim();
  return (Array.isArray(reports) ? reports : []).find((entry) => (
    (reportId && String(entry?.reportId || '') === reportId)
    || (cycleId && String(entry?.cycleId || '') === cycleId)
  )) || null;
}

/**
 * Map a closed cycle to a structured blocked-reason code. Only structured inputs
 * are read — the `planOnly` flag, the close decision reason, the watcher stop
 * reason and the per-leaf resolutions. The free-text report message is never
 * parsed. Returns null when the close was not blocked/failed.
 *
 * @param {{
 *   closeOutcome?: string | null,
 *   closeReason?: string,
 *   planOnly?: boolean,
 *   planSaved?: boolean,
 *   stopReason?: string,
 *   todoOutcomes?: Record<string, any>[],
 * }} [input]
 * @returns {string | null}
 */
export function resolveWorkspaceWatcherCycleBlockedReasonCode(input = {}) {
  const closeOutcome = String(input.closeOutcome || '').trim();
  const leafOutcomes = Array.isArray(input.todoOutcomes) ? input.todoOutcomes : [];
  const anyBlocked = leafOutcomes.some((entry) => entry?.outcome === 'blocked');
  if (closeOutcome !== 'blocked' && closeOutcome !== 'failure' && !anyBlocked) return null;
  if (input.planOnly === true) return input.planSaved === true ? null : 'plan_not_saved';
  if (leafOutcomes.some((entry) => entry?.outcome === 'unknown' && entry?.readError)) return 'todo_read_error';
  if (leafOutcomes.some((entry) => entry?.outcome === 'unknown')) return 'todo_missing';
  if (String(input.stopReason || '').trim()) return 'watcher_stopped';
  const closeReason = String(input.closeReason || '').trim();
  if (closeReason === 'phase_disabled') return 'phase_disabled';
  if (closeReason === REVIEW_MISSING_REASON) return 'review_missing';
  if (closeReason === 'missing_report') return 'missing_report';
  if (closeReason === 'cycle_incomplete') return 'cycle_incomplete';
  if (closeReason === 'cycle_room_gone') return 'cycle_room_gone';
  if (closeReason) return 'reported_blocked';
  return 'unknown';
}

/**
 * Shared patch that closes exactly one cycle.
 *
 * `cycleCount` semantics: it is a monotonic row counter incremented once per
 * cycle closed through this patch (a real report or reconcile). It does NOT
 * count reservations rolled back before running (`clearCycleRow`), it is not
 * per-todo, and it is not a window: the durable per-cycle history lives in the
 * separate cycle-metrics store. Do not use it as a denominator for a success or
 * coverage rate — use the bounded `cycleChats` window for display and the
 * metrics store for ratios.
 *
 * @param {{
 *   row: Record<string, any>,
 *   cycle: Record<string, any>,
 *   outcome?: string,
 *   todoIds?: string[],
 *   reports?: Record<string, any>[],
 *   now?: number,
 *   at?: string,
 *   decisionReason?: string,
 *   closeSource?: string,
 *   todo?: Record<string, any> | null,
 *   workspaceFolder?: string,
 *   dataDir?: string,
 *   reviewWaits?: Record<string, Record<string, any>>,
 *   extraDecisions?: Record<string, any>[],
 *   onBlockedEscalation?: (escalation: Record<string, any>) => void,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildWorkspaceWatcherCycleClosePatch(input) {
  const row = input.row || {};
  const cycle = input.cycle || {};
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const at = String(input.at || new Date(now).toISOString());
  const outcome = WORKSPACE_WATCHER_CYCLE_CLOSE_OUTCOMES.includes(String(input.outcome))
    ? String(input.outcome)
    : 'failure';
  // A restart interruption is neutral: no failure counter, no backoff, and the
  // todo keeps the failure history it had before the cycle.
  const interrupted = outcome === WORKSPACE_WATCHER_CYCLE_INTERRUPTED_OUTCOME;
  const decisionReason = String(input.decisionReason || '').trim() || outcome;
  // 'blocked' means waiting for human action (e.g. plan approval) — not a
  // genuine failure; only 'failure' increments the failure counter and backoff.
  // Infrastructure failures (MCP not ready, a missing report while the event
  // loop is saturated) are the platform's fault: they close the cycle but leave
  // the leaf's failure counter and backoff exactly as they were.
  const failed = outcome === 'failure';
  const infraFailure = failed && isWorkspaceWatcherInfraFailure(decisionReason);
  const todoIds = (Array.isArray(input.todoIds) && input.todoIds.length ? input.todoIds : (cycle.todoIds || []))
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const primaryTodoId = todoIds[0] || '';
  // Circuit breaker: classify by cause and real run duration (cycle.runEnd),
  // not by how long the cycle took to close.
  const infra = classifyWorkspaceWatcherCycleInfraCause({
    outcome,
    closeReason: decisionReason,
    cycle,
  });
  const infraCounted = failed && infra.streak === 'count';
  const remaining = removeWorkspaceWatcherCycle(row, cycle);
  /** @type {Record<string, unknown>} */
  const patch = {
    ...remaining,
    cycleCount: (row.cycleCount || 0) + 1,
    // One lease covers every slot: closing a cycle while another is still live
    // must not hand the workspace to a second driver. Only the last close frees
    // it, which is byte-for-byte the v1 behaviour when maxParallel is 1.
    lease: remaining.activeCycles.length === 0
      ? releaseWorkspaceWatcherLease(row, { token: String(row.lease?.token || '') })
      : row.lease,
  };
  if (Array.isArray(input.reports)) patch.reports = input.reports;
  // Marker is written in the same mutation as the close (contract §4.2 step 1).
  if (input.reviewWaits && typeof input.reviewWaits === 'object') patch.reviewWaits = input.reviewWaits;
  if (primaryTodoId) {
    // A restart-interrupted cycle is not the leaf's fault: failure counters,
    // backoff and the blocked streak stay exactly as they were.
    if (!interrupted && !infraFailure) {
      const failures = { ...(row.failures || {}) };
      // A review_missing close keeps the counter as it was: attempts live in the
      // `reviewWaits` marker and a review wait must never park a leaf by itself.
      const reviewMissingClose = outcome === 'blocked' && decisionReason === REVIEW_MISSING_REASON;
      // An infrastructure failure before work is not the todo's fault: it keeps
      // the counter as it was (and never parks the todo).
      if (!infraCounted) {
        if (failed) failures[primaryTodoId] = (failures[primaryTodoId] || 0) + 1;
        else if (!reviewMissingClose) delete failures[primaryTodoId];
      }
      patch.failures = failures;
      // A blocked close earns the leaf its own growing delay; any other outcome
      // ends the streak. A plan-only cycle is exempt: it is blocked on a plan
      // approval, and the approval itself must be able to restart the leaf.
      const blockedBackoff = { ...(row.blockedBackoff || {}) };
      // A disabled phase is a configuration block, not a stall: no growing delay.
      const phaseDisabledClose = outcome === 'blocked' && decisionReason === 'phase_disabled';
      if (outcome === 'blocked' && cycle.planOnly !== true && !phaseDisabledClose && !reviewMissingClose) {
        blockedBackoff[primaryTodoId] = nextWorkspaceWatcherBlockedBackoff({
          previous: blockedBackoff[primaryTodoId],
          policy: row.policy,
          now,
        });
      } else {
        delete blockedBackoff[primaryTodoId];
      }
      patch.blockedBackoff = blockedBackoff;
      // Streak of consecutive blocked reports with the same non-infra code. It
      // counts only genuine orchestrator blocks (not plan-only, disabled-phase
      // or review-wait closes) and is reset by any other outcome.
      const reasonStreak = { ...(row.blockedReasonStreak || {}) };
      const countable = outcome === 'blocked' && cycle.planOnly !== true && !phaseDisabledClose && !reviewMissingClose;
      const reportEntry = countable ? findCycleReport(input.reports || row.reports, cycle) : null;
      const verdict = evaluateWorkspaceWatcherBlockedReasonStreak({
        previous: reasonStreak[primaryTodoId],
        outcome: countable ? 'blocked' : outcome,
        code: reportEntry?.reasonCode,
        date: reportEntry?.reasonDate,
        now,
      });
      if (verdict.next) reasonStreak[primaryTodoId] = verdict.next;
      else delete reasonStreak[primaryTodoId];
      patch.blockedReasonStreak = reasonStreak;
      if (verdict.escalation && typeof input.onBlockedEscalation === 'function') {
        input.onBlockedEscalation({ ...verdict.escalation, todoId: primaryTodoId, code: reportEntry?.reasonCode });
      }
      patch.backoffUntil = infraCounted
        ? String(row.backoffUntil || '')
        : failed
        ? computeWorkspaceWatcherBackoffUntil({
          failures,
          now,
          baseMs: row.policy?.backoffBaseMs,
          capMs: row.policy?.backoffCapMs,
        })
        : '';
    }
    if ((failed || interrupted) && cycle.planOnly === true) {
      const planDraftTodo = resolvePlanDraftTodoForCycleClose({
        cycle,
        todo: input.todo,
        workspaceFolder: input.workspaceFolder,
        dataDir: input.dataDir,
      });
      if (!hasPendingWorkspaceWatcherPlanDraft(planDraftTodo)) {
        // A plan cycle that produced nothing usable releases its pending request.
        // One that stored a draft awaiting a human keeps it: the failure counts
        // the missing report, it does not cancel the approval the operator still
        // has in front of them.
        const planRequests = { ...(row.planRequests || {}) };
        // planTargetId is set when planApprovalScope:'root' stored the request
        // under the subtree root rather than the leaf.
        const planRequestKey = String(cycle.planTargetId || '').trim() || primaryTodoId;
        delete planRequests[planRequestKey];
        patch.planRequests = planRequests;
      }
    }
  }
  /** @type {Record<string, any>[]} */
  let infraDecisions = [];
  if (!interrupted) {
    const applied = applyWorkspaceWatcherInfraClassification({
      row,
      harness: String(cycle.requestedHarness || cycle.harness || ''),
      model: String(cycle.requestedModel || ''),
      runKey: String(cycle.runId || cycle.cycleId || ''),
      classification: infra,
      now,
      at,
    });
    Object.assign(patch, applied.patch);
    infraDecisions = applied.decisions;
  }
  if (cycle.chatId) {
    const entry = {
      id: String(cycle.chatId),
      cycleId: String(cycle.cycleId || ''),
      todoIds,
      // Mirror the live slot's reservation instant so the dashboard Gantt can
      // render a real duration. `at` below stays the close time. A legacy or
      // hand-written slot without `startedAt` yields '' and the UI shows the
      // cycle as "no duration" rather than a zero-length bar.
      startedAt: String(cycle.startedAt || ''),
      at,
      outcome,
      harness: String(cycle.harness || ''),
      // Orchestrator identity for the bounded API. `mode` is derived from the
      // authoritative `planOnly`; requested fields stay null when the cycle
      // predates the identity store (never inferred from the current policy).
      mode: String(cycle.mode || '').trim() || (cycle.planOnly === true ? 'plan' : 'implement'),
      requestedHarness: cycle.requestedHarness == null ? null : String(cycle.requestedHarness).trim() || null,
      requestedModel: cycle.requestedModel == null ? null : String(cycle.requestedModel).trim() || null,
      requestedSource: cycle.requestedSource == null ? null : String(cycle.requestedSource).trim() || null,
      closeSource: String(input.closeSource || '').trim() || null,
      closeReason: decisionReason,
      model: String(cycle.requestedModel || '').trim().toLowerCase(),
      cause: infra.cause,
      runDurationMs: infra.runDurationMs,
    };
    const existing = Array.isArray(row.cycleChats) ? row.cycleChats : [];
    if (!existing.some((chat) => String(chat?.id || '') === entry.id)) {
      patch.cycleChats = [...existing, entry].slice(-WORKSPACE_WATCHER_MAX_CYCLE_CHATS);
    }
  }
  patch.decisions = [
    ...(row.decisions || []),
    ...(Array.isArray(input.extraDecisions) ? input.extraDecisions : []),
    ...infraDecisions,
    {
      at,
      kind: interrupted ? 'cycle_interrupted' : (failed ? 'cycle_failed' : 'cycle_completed'),
      reason: decisionReason,
      readyTodoCount: 0,
      activeAgentCount: 0,
      shouldNotify: failed,
      nextTodoId: primaryTodoId,
    },
  ];
  return patch;
}

/**
 * "Why?" decision for a leaf that is done but waits for its tree's integration.
 *
 * @param {{ at: string, todoId: string, rootId?: string }} input
 * @returns {Record<string, any>}
 */
export function buildTreeIntegrationWaitDecision(input) {
  return {
    at: input.at,
    kind: 'waiting_for_tree_integration',
    reason: 'waiting_for_tree_integration',
    readyTodoCount: 0,
    activeAgentCount: 0,
    shouldNotify: false,
    nextTodoId: String(input.todoId || ''),
  };
}

/**
 * Best-effort durable attribution for a cycle close: rounds per leaf read from
 * the durable workflow store and child composition from the delegation store.
 * Any read failure degrades to unknown/empty data instead of aborting the close.
 *
 * @param {{ cycle?: Record<string, any>, claimedTodoIds?: string[] }} [input]
 * @returns {Record<string, any>}
 */
export function resolveWorkspaceWatcherCycleAttributionForClose(input = {}) {
  const cycle = input.cycle && typeof input.cycle === 'object' ? input.cycle : {};
  const claimedTodoIds = Array.isArray(input.claimedTodoIds)
    ? input.claimedTodoIds.map((id) => String(id ?? '').trim()).filter(Boolean)
    : [];
  let workflowRows = [];
  let delegations = [];
  try {
    workflowRows = loadDelegationWorkflows();
  } catch {
    workflowRows = [];
  }
  try {
    delegations = loadDelegations();
  } catch {
    delegations = [];
  }
  const metricCycle = {
    cycleId: String(cycle.cycleId || '').trim(),
    orchestratorChatId: String(cycle.chatId || cycle.orchestratorChatId || '').trim(),
    orchestratorRunId: String(cycle.runId || cycle.orchestratorRunId || '').trim(),
    closedAt: String(input.closedAt || cycle.closedAt || '').trim(),
    startedAt: String(cycle.startedAt || '').trim(),
  };
  let events = [];
  try {
    const sources = collectCycleUsageSources(metricCycle, {
      now: Date.now(),
      dataDir: input.dataDir,
    });
    const membership = buildCycleUsageMembership(metricCycle, delegations);
    events = sources.events.filter((event) => (
      classifyCycleUsageEvent(event, metricCycle, membership).scope === 'child'
    ));
  } catch {
    events = [];
  }
  return buildWorkspaceWatcherCycleAttribution({
    cycle: { ...cycle, todoIds: claimedTodoIds },
    workflowRows,
    delegations,
    events,
  });
}

/**
 * Build the durable cycle-metrics close payload from a live/closed slot. Shared
 * by the runtime report, the runtime reconcile and the boot reconcile so the
 * three close paths record the same fields. `closeOutcome` is null for an abort
 * (a reservation rolled back before running); the metrics normalizer keeps that
 * as unknown instead of inventing a success.
 *
 * `reportedOutcome` is the model's claim and `closeOutcome` the verified result;
 * they stay separate fields on purpose. The per-leaf snapshot (`todoOutcomes`)
 * and the plan-only deliverable flag come from `leafOutcomes`, computed against
 * the workspace at close.
 *
 * @param {{
 *   cycle: Record<string, any>,
 *   workspaceFolder?: string,
 *   closedAt?: string,
 *   closeSource?: string,
 *   closeReason?: string,
 *   closeOutcome?: string | null,
 *   reportedOutcome?: string | null,
 *   reportedTodoIds?: string[],
 *   leafOutcomes?: Record<string, any> | null,
 *   todoStatusAtClose?: string,
 *   blockedReasonCode?: string | null,
 *   stopReason?: string,
 *   todo?: Record<string, any> | null,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildWorkspaceWatcherCycleMetricCloseInput(input) {
  const cycle = input.cycle && typeof input.cycle === 'object' ? input.cycle : {};
  const todo = input.todo && typeof input.todo === 'object' ? input.todo : null;
  const leafOutcomes = input.leafOutcomes && typeof input.leafOutcomes === 'object' ? input.leafOutcomes : null;
  const claimedTodoIds = (Array.isArray(cycle.todoIds) ? cycle.todoIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  const reportedOutcome = input.reportedOutcome !== undefined
    ? (String(input.reportedOutcome || '').trim() || null)
    : (String(cycle.reportedOutcome || '').trim() || null);
  const todoStatusAtClose = String(
    input.todoStatusAtClose
    ?? (leafOutcomes ? leafOutcomes.primaryStatus : null)
    ?? (todo ? String(todo.status || '').trim() : ''),
  ).trim() || 'unknown';
  const planOnly = cycle.planOnly === true;
  const planSaved = leafOutcomes ? leafOutcomes.planSaved === true : hasWorkspaceWatcherPlanArtifact(todo);
  const attribution = resolveWorkspaceWatcherCycleAttributionForClose({
    cycle,
    claimedTodoIds: leafOutcomes?.claimedTodoIds ?? claimedTodoIds,
    closedAt: input.closedAt,
    dataDir: input.dataDir,
  });
  return {
    cycleId: String(cycle.cycleId || '').trim(),
    workspaceFolder: String(input.workspaceFolder || '').trim(),
    mode: String(cycle.mode || '').trim() || (planOnly ? 'plan' : 'implement'),
    orchestratorChatId: String(cycle.chatId || '').trim() || null,
    orchestratorRunId: String(cycle.runId || '').trim() || null,
    harness: String(cycle.harness || '').trim() || null,
    todoIds: claimedTodoIds,
    claimedTodoIds: leafOutcomes?.claimedTodoIds ?? claimedTodoIds,
    // The workspace-validated list wins over the raw report, so a foreign
    // reported id is never persisted as if it named real work.
    reportedTodoIds: leafOutcomes?.reportedTodoIds ?? input.reportedTodoIds ?? [],
    unknownReportedTodoIds: leafOutcomes?.unknownReportedTodoIds ?? [],
    completedTodoIds: leafOutcomes?.completedTodoIds ?? [],
    todoOutcomes: leafOutcomes?.todoOutcomes ?? [],
    attribution,
    planOnly,
    planSaved,
    blockedReasonCode: input.blockedReasonCode ?? null,
    startedAt: String(cycle.startedAt || '').trim(),
    closedAt: String(input.closedAt || '').trim(),
    closeSource: input.closeSource,
    closeReason: input.closeReason,
    reportedOutcome,
    closeOutcome: input.closeOutcome ?? null,
    todoStatusAtClose,
    reachedRunning: String(cycle.phase || '').trim() === 'running' || Boolean(String(cycle.runId || '').trim()),
  };
}

/**
 * Release the claim one cycle holds on its todo. The release is fenced twice:
 * by the claiming chat, and — when the caller knows its `cycleId` — by the
 * attempt the todo currently records, so a late release from an older attempt
 * cannot free (or reset) work a newer attempt already owns.
 *
 * @param {{ workspaceFolder: string, todoId: string, chatId: string, cycleId?: string, attemptId?: string, dataDir?: string, now?: number }} input
 * @returns {boolean} whether the claim was actually released
 */
export function releaseWorkspaceWatcherCycleTodoClaim(input) {
  try {
    return withTodosWatcherNudgeSuppressed(() => {
      const doc = loadTodosData(input.dataDir, input.workspaceFolder);
      const current = (Array.isArray(doc?.items) ? doc.items : [])
        .find((row) => String(row?.id || '') === String(input.todoId || '')) || null;
      if (!current) return false;
      if (String(current.claimedByChatId || '') !== String(input.chatId || '')) return false;
      const expectedAttemptId = String(input.attemptId || '').trim();
      const currentAttemptId = String(current.execution?.attemptId || '').trim();
      const expectedCycleId = String(input.cycleId || '').trim();
      const currentCycleId = String(current.execution?.cycleId || '').trim();
      if (currentAttemptId) {
        if (expectedAttemptId) {
          if (expectedAttemptId !== currentAttemptId) return false;
        } else if (!(expectedCycleId && expectedCycleId === currentCycleId)) {
          return false;
        }
      }
      if (expectedCycleId && expectedCycleId !== currentCycleId) {
        if (currentCycleId || currentAttemptId) return false;
      }
      // Integration-ready leaves stay `doing`: the review PASS closed the
      // execution, but only a human integration (or rejection) may move them
      // (contract §8.3, S11/S13). Release the claim without touching the status.
      if (isTodoAwaitingIntegration(current)) {
        updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
          claimedByChatId: null,
          claimedAt: null,
          expectedUpdatedAt: current.updatedAt,
        });
        return true;
      }
      if (String(current.status || '') === 'done') {
        updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
          claimedByChatId: null,
          claimedAt: null,
          expectedUpdatedAt: current.updatedAt,
        });
        return true;
      }
      if (String(current.status || '') !== 'doing') return false;
      const watcher = getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir });
      // Review gate (contract §4.2 steps 2-3): a worktree leaf, or a leaf past
      // the attempt cap, keeps `doing`; only the claim is released and the
      // label is written afterwards without a status (a status would clear it).
      const reviewMarker = watcher?.reviewWaits?.[input.todoId];
      if (isReviewMarkerHoldingDoing(reviewMarker, watcher?.policy)) {
        const released = updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
          claimedByChatId: null,
          claimedAt: null,
          expectedUpdatedAt: current.updatedAt,
        });
        applyReviewGateLabel({
          workspaceFolder: input.workspaceFolder,
          dataDir: input.dataDir,
          todoId: input.todoId,
          marker: reviewMarker,
          policy: watcher?.policy,
          chatId: input.chatId,
          todo: released && typeof released === 'object' ? released : null,
        });
        return true;
      }
      const failures = watcher?.failures?.[input.todoId] || 0;
      const ceiling = watcher?.policy?.maxConsecutiveFailures || 0;
      updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
        status: 'ready',
        strictStatus: true,
        claimedByChatId: null,
        claimedAt: null,
        claimLeaseUntil: null,
        expectedUpdatedAt: current.updatedAt,
        blockedReason: ceiling > 0 && failures >= ceiling
          ? workspaceWatcherFailureCeilingReason(failures, ceiling) : null,
        appendChangelog: ceiling > 0 && failures >= ceiling ? {
          kind: 'note', chatId: input.chatId,
          text: `Workspace Watcher skipped this todo after ${failures} failed cycles (limit ${ceiling}). Resolve the blocker and retry manually or adjust the watcher failure limit.`,
        } : undefined,
      });
      return true;
    });
  } catch {
    // A todo that moved on (done/doing by someone else) is not ours to reset.
    return false;
  }
}

/**
 * Mark a deferred report as resolved when the cycle closes.
 *
 * @param {Record<string, any>[] | undefined} reports
 * @param {Record<string, any>} cycle
 * @returns {Record<string, any>[] | undefined}
 */
export function resolveDeferredWorkspaceWatcherReports(reports, cycle) {
  if (!Array.isArray(reports) || !cycle?.reportId) return reports;
  return reports.map((entry) => (
    String(entry?.reportId || '') === String(cycle.reportId)
      ? { ...entry, deferred: false }
      : entry
  ));
}

/**
 * Write the review-gate label (`review_missing` / `review_gate_exhausted`) on a
 * held leaf. No `status` in the patch on purpose: any status clears
 * `blockedReason`. Idempotent; never touches an integration-ready leaf.
 *
 * @param {{
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   todoId: string,
 *   marker: Record<string, any>,
 *   policy?: Record<string, any> | null,
 *   chatId?: string,
 *   todo?: Record<string, any> | null,
 * }} input
 * @returns {boolean}
 */
export function applyReviewGateLabel(input) {
  try {
    const doc = loadTodosData(input.dataDir, input.workspaceFolder);
    const current = (Array.isArray(doc?.items) ? doc.items : [])
      .find((row) => String(row?.id || '') === String(input.todoId || '')) || input.todo || null;
    if (!current) return false;
    if (isTodoAwaitingIntegration(current) || String(current.status || '') === 'done') return false;
    const label = buildReviewGateBlockedReason(input.marker, input.policy);
    if (String(current.blockedReason || '') === label) return false;
    updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
      blockedReason: label,
      expectedUpdatedAt: current.updatedAt,
      appendChangelog: {
        kind: 'note',
        chatId: String(input.chatId || ''),
        text: `Workspace Watcher review gate: ${label}`,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Evaluate the review gate for one cycle close (C1/C3/C4 share this). Pure
 * apart from reading the policy; the caller persists the returned markers.
 *
 * `enforce` + unsatisfied -> marker `attempts + 1` and `blocked`/`review_missing`;
 * `warn` + unsatisfied -> a decision/changelog record only; a satisfied gate
 * drops an existing marker. Anything else (off, plan-only, not a reported
 * success, leaf already done or integration-ready) is a no-op.
 *
 * @param {{
 *   row: Record<string, any>,
 *   cycle: Record<string, any>,
 *   todo: Record<string, any> | null,
 *   reportedOutcome?: string,
 *   worktree?: boolean,
 *   at: string,
 * }} input
 * @returns {{
 *   applies: boolean,
 *   mode: string,
 *   satisfied: boolean,
 *   unsatisfied: boolean,
 *   warn: boolean,
 *   gate: Record<string, any> | null,
 *   reviewWaits: Record<string, Record<string, any>> | null,
 *   entry: Record<string, any> | null,
 *   exhausted: boolean,
 *   extraDecisions: Record<string, any>[],
 * }}
 */
export function resolveWorkspaceWatcherCycleReviewGate(input) {
  const none = {
    applies: false, mode: 'off', satisfied: true, unsatisfied: false, warn: false, gate: null,
    reviewWaits: null, entry: null, exhausted: false, extraDecisions: [],
  };
  const row = input.row || {};
  const policy = row.policy || {};
  const mode = resolveReviewGateMode(policy);
  const cycle = input.cycle || {};
  const todo = input.todo && typeof input.todo === 'object' ? input.todo : null;
  const todoId = String(cycle.todoIds?.[0] || '').trim();
  if (mode === 'off' || cycle.planOnly === true || !todo || !todoId) return { ...none, mode };
  const reported = String(input.reportedOutcome || '');
  if (!['success', 'blocked', 'failure'].includes(reported)) return { ...none, mode };
  const existing = row.reviewWaits && typeof row.reviewWaits === 'object' ? row.reviewWaits : {};
  if (String(todo.status || '') === 'done') {
    // A leaf closed `done` after a qualifying PASS ends its review wait.
    if (mode === 'enforce' && existing[todoId] && evaluateReviewGate({ todo, policy }).satisfied) {
      const next = { ...existing };
      delete next[todoId];
      return { ...none, mode, applies: true, reviewWaits: next };
    }
    return { ...none, mode };
  }
  if (isTodoAwaitingIntegration(todo)) return { ...none, mode };
  const gate = evaluateReviewGate({ todo, policy });
  if (gate.satisfied) {
    if (mode !== 'enforce' || !existing[todoId]) {
      return { ...none, mode, applies: true, gate };
    }
    const next = { ...existing };
    delete next[todoId];
    return { ...none, mode, applies: true, gate, reviewWaits: next };
  }
  // A reported `blocked` keeps its own cause and blocked backoff in every mode:
  // the report may name a non-review reason (e.g. no access), so the gate neither
  // writes a review wait nor consumes an attempt for it.
  if (reported === 'blocked') return { ...none, mode, applies: true, gate };
  if (mode === 'warn') {
    // warn never reinterprets a failure report.
    if (reported !== 'success') return { ...none, mode, applies: true, gate };
    return {
      ...none,
      mode,
      applies: true,
      satisfied: false,
      warn: true,
      gate,
      extraDecisions: [{
        at: input.at,
        kind: 'review_gate_warn',
        reason: REVIEW_MISSING_REASON,
        readyTodoCount: 0,
        activeAgentCount: 0,
        shouldNotify: false,
        nextTodoId: todoId,
      }],
    };
  }
  const next = nextReviewWaitsAfterClose({
    reviewWaits: existing,
    todoId,
    gate,
    materialRevision: resolveReviewGateMaterialRevision(todo),
    worktree: input.worktree === true,
    maxAttempts: resolveReviewGateMaxAttempts(policy),
    at: input.at,
  });
  return {
    ...none,
    mode,
    applies: true,
    satisfied: false,
    unsatisfied: true,
    gate,
    reviewWaits: next.reviewWaits,
    entry: next.entry,
    exhausted: next.exhausted,
    extraDecisions: [{
      at: input.at,
      kind: 'review_gate_blocked',
      reason: next.exhausted ? 'review_gate_exhausted' : REVIEW_MISSING_REASON,
      readyTodoCount: 0,
      activeAgentCount: 0,
      shouldNotify: false,
      nextTodoId: todoId,
    }],
  };
}

/**
 * Record a `warn` finding on the todo (changelog). The decision entry is part of
 * the close patch / written by the REST guard; this is the todo-side note.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, todoId: string, chatId?: string, state?: string }} input
 * @returns {void}
 */
export function recordReviewGateWarning(input) {
  try {
    const doc = loadTodosData(input.dataDir, input.workspaceFolder);
    const current = (Array.isArray(doc?.items) ? doc.items : [])
      .find((row) => String(row?.id || '') === String(input.todoId || '')) || null;
    if (!current) return;
    updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
      expectedUpdatedAt: current.updatedAt,
      appendChangelog: {
        kind: 'note',
        chatId: String(input.chatId || ''),
        text: `Workspace Watcher review gate (warn): ${REVIEW_MISSING_REASON} — code review state "${String(input.state || 'none')}" does not satisfy the gate.`,
      },
    });
  } catch {
    // Best-effort audit note.
  }
}

/**
 * Idempotent repair of review-gate markers (boot reconcile). Prunes entries
 * whose todo is missing or `done`, re-applies the held-leaf label, and releases
 * a claim left by a chat that no live cycle owns (a crash between the marker
 * write and the release, contract §4.2). An integration-ready leaf is never
 * touched.
 *
 * @param {{ workspaceFolder: string, dataDir?: string }} input
 * @returns {{ pruned: string[], labeled: string[], released: string[] }}
 */
export function reconcileWorkspaceWatcherReviewWaits(input) {
  const out = { pruned: [], labeled: [], released: [] };
  const row = getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir });
  const waits = row?.reviewWaits && typeof row.reviewWaits === 'object' ? row.reviewWaits : {};
  const ids = Object.keys(waits);
  if (!row || !ids.length) return out;
  let items = [];
  try {
    const doc = loadTodosData(input.dataDir, input.workspaceFolder);
    items = Array.isArray(doc?.items) ? doc.items : [];
  } catch {
    return out;
  }
  const liveChats = new Set(getWorkspaceWatcherActiveCycles(row).map((cycle) => String(cycle?.chatId || '')));
  for (const todoId of ids) {
    const todo = items.find((item) => String(item?.id || '') === todoId) || null;
    if (!todo || String(todo.status || '') === 'done') {
      out.pruned.push(todoId);
      continue;
    }
    if (isTodoAwaitingIntegration(todo)) continue;
    const claimant = String(todo.claimedByChatId || '').trim();
    if (claimant && !liveChats.has(claimant)) {
      const released = releaseWorkspaceWatcherCycleTodoClaim({
        workspaceFolder: input.workspaceFolder,
        todoId,
        chatId: claimant,
        dataDir: input.dataDir,
      });
      if (released) out.released.push(todoId);
    }
    if (String(todo.status || '') === 'doing' && !claimant
      && isReviewMarkerHoldingDoing(waits[todoId], row.policy)
      && !isReviewGateBlockedReason(todo.blockedReason)) {
      if (applyReviewGateLabel({
        workspaceFolder: input.workspaceFolder,
        dataDir: input.dataDir,
        todoId,
        marker: waits[todoId],
        policy: row.policy,
      })) out.labeled.push(todoId);
    }
  }
  if (out.pruned.length) {
    mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row: current }) => {
      const next = { ...(current.reviewWaits || {}) };
      for (const id of out.pruned) delete next[id];
      return { reviewWaits: next };
    }, { dataDir: input.dataDir, createIfMissing: false });
  }
  return out;
}

/**
 * The live per-leaf worktree record of a parallel-leaf tree, or null when the
 * leaf runs in the shared tree worktree (today's behaviour).
 *
 * @param {{ todoId: string, dataDir?: string }} input
 * @returns {{ leaf: Record<string, any>, tree: Record<string, any> } | null}
 */
export function resolveParallelLeafWorktree(input) {
  try {
    const opts = input.dataDir ? { dataDir: input.dataDir } : {};
    const leaf = getWorktreeRecord(input.todoId, opts);
    if (!leaf || !leaf.treeTodoId || !isWorktreeRecordLive(leaf)) return null;
    const tree = getWorktreeRecord(leaf.treeTodoId, opts);
    return tree && isWorktreeRecordLive(tree) ? { leaf, tree } : null;
  } catch {
    return null;
  }
}

/**
 * After a leaf review PASS in a parallel-leaf tree: merge the leaf into the
 * tree worktree (serialized per tree) and settle the todo. Runs OUTSIDE the
 * Watcher lock because it shells out to Git. `merged` closes the leaf and
 * removes its worktree in the background; `conflict` returns the leaf to
 * `ready` and marks its record so the next cycle starts with a fix round on the
 * current tree branch.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, todoId: string, at: string, deps?: Record<string, any> }} input
 * @returns {Promise<{ status: string, conflicts?: string[], message: string, decision: Record<string, any>, freed?: Promise<{ freedBytes: number }> } | null>}
 */
export async function applyParallelLeafMerge(input) {
  const pair = resolveParallelLeafWorktree({ todoId: input.todoId, dataDir: input.dataDir });
  if (!pair) return null;
  const registryOptions = input.dataDir ? { dataDir: input.dataDir } : {};
  const merge = input.deps?.mergeLeafIntoTree || mergeLeafIntoTree;
  const remove = input.deps?.removeWorktreeInBackground || removeWorktreeInBackground;
  const decide = (kind, reason, notify) => ({
    at: input.at, kind, reason, readyTodoCount: 0, activeAgentCount: 0, shouldNotify: notify, nextTodoId: input.todoId,
  });
  const note = (patch, text) => {
    const current = (loadTodosData(input.dataDir, input.workspaceFolder)?.items || [])
      .find((row) => String(row?.id || '') === input.todoId);
    if (!current) return;
    updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
      ...patch,
      strictStatus: true,
      claimedByChatId: null,
      claimedAt: null,
      expectedUpdatedAt: current.updatedAt,
      appendChangelog: { kind: 'note', text },
    });
  };
  try {
    updateWorktreeState({ todoId: input.todoId, registryOptions, executionState: 'execution_closed' });
  } catch { /* the merge below re-validates the worktree */ }
  let result;
  try {
    result = await merge({ leafRecord: pair.leaf, treeRecord: pair.tree });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDelegationEvent('workspace-watcher-leaf-merge-failed', {}, { todoId: input.todoId, message });
    // Keep the leaf worktree and block the todo (no immediate retry): a thrown
    // merge (e.g. a dirty tree worktree) needs a human or a tree fix first.
    try {
      mutateWorktreeRegistry((doc) => {
        const record = doc.items[input.todoId];
        if (!record) return { changed: false };
        record.lastError = { code: TREE_MERGE_FAILED_CODE, message, at: input.at };
        return {};
      }, registryOptions);
    } catch { /* best effort */ }
    try {
      note({ status: 'ready', blockedReason: `Merge into the tree worktree failed: ${message}` }, `Leaf merge into the tree worktree failed: ${message}. The leaf worktree is kept; the todo is blocked until the tree worktree is fixed.`);
    } catch { /* best effort */ }
    return { status: 'failed', message, decision: decide('leaf_merge_failed', message, true) };
  }
  if (result.status === 'conflict') {
    mutateWorktreeRegistry((doc) => {
      const record = doc.items[input.todoId];
      if (!record) return { changed: false };
      record.lastError = { code: TREE_MERGE_CONFLICT_CODE, message: result.message, at: input.at };
      return {};
    }, registryOptions);
    try { note({ status: 'ready' }, `Merge into tree ${pair.tree.todoId.slice(0, 8)} conflicted in ${(result.conflicts || []).join(', ') || 'unknown paths'}; the next cycle runs a fix round on the current tree branch.`); } catch { /* best effort */ }
    return { status: 'conflict', conflicts: result.conflicts, message: result.message, decision: decide('leaf_merge_conflict', result.message, true) };
  }
  try { note({ status: 'done' }, `Merged into the tree worktree of ${pair.tree.todoId.slice(0, 8)} (${result.status}); work waits there for root-level integration.`); } catch { /* best effort */ }
  let freed;
  try {
    const removed = await remove({ todoId: input.todoId, registryOptions, deleteBranch: true });
    freed = removed.done?.then((info) => {
      logDelegationEvent('workspace-watcher-leaf-worktree-removed', {}, { todoId: input.todoId, freedBytes: info.freedBytes });
      return info;
    });
  } catch (error) {
    logDelegationEvent('workspace-watcher-leaf-worktree-remove-failed', {}, { todoId: input.todoId, message: error instanceof Error ? error.message : String(error) });
  }
  return { status: 'merged', message: result.message, decision: decide('leaf_merged_into_tree', result.message, false), freed };
}
