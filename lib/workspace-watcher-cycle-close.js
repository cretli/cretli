/**
 * Shared workspace-watcher cycle close logic for runtime reconcile and boot
 * reconcile. Lives outside workspace-watcher.js and workspace-watcher-cycle.js
 * so neither module imports the other for close accounting.
 */

import { loadTodosData, updateTodo, withTodosWatcherNudgeSuppressed } from './persist/todos-persist.js';
import { isDelegationSlotOccupied } from './delegation-status.js';
import {
  getWorkspaceWatcher,
  releaseWorkspaceWatcherLease,
  removeWorkspaceWatcherCycle,
  WORKSPACE_WATCHER_CYCLE_OUTCOMES,
  WORKSPACE_WATCHER_MAX_CYCLE_CHATS,
} from './persist/workspace-watchers-persist.js';
import { computeWorkspaceWatcherBackoffUntil } from './workspace-watcher-guardrails.js';
import { workspaceWatcherFailureCeilingReason } from './workspace-watcher-blocked-reason.js';
import { isTodoAwaitingIntegration } from './todo-integration-state.js';

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
 * @param {object | null} todo
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
 * @param {object | null} todo
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
 * @param {{ cycle: object, todo: object | null, watcher: object | null }} input
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
 * @param {string} chatId
 * @param {object[]} [delegations]
 * @returns {boolean}
 */
export function hasActiveWorkspaceWatcherCycleChildren(chatId, delegations) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  return (Array.isArray(delegations) ? delegations : []).some((row) => (
    String(row?.parentChatId || '') === id && isDelegationSlotOccupied(row)
  ));
}

/**
 * Resolve the durable close outcome from a stored report and the verified leaf
 * state.
 *
 * A cycle that ends without a durable report is never a success, not even when
 * the todo happens to be done: an orchestrator that finished its work but could
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
 *   cycle: object,
 *   row: object,
 *   todo: object | null,
 *   reportedOutcomeRaw?: string,
 *   mcpErrorCode?: string,
 *   leafOutcomes?: object | null,
 *   planTodo?: object | null,
 *   integrationReady?: boolean,
 * }} input
 * @returns {{ closeOutcome: string, countIncompleteFailure: boolean, closeReason: string }}
 */
export function resolveWorkspaceWatcherCycleCloseOutcome(input) {
  const cycle = input.cycle || {};
  const row = input.row || {};
  const reportedOutcome = WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(String(input.reportedOutcomeRaw || ''))
    ? String(input.reportedOutcomeRaw)
    : '';
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
    if (input.integrationReady === true) {
      return {
        closeOutcome: 'success',
        countIncompleteFailure: false,
        closeReason: 'cycle_success',
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
 *   cycle: object,
 *   row: object,
 * }} input
 * @returns {object | null}
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
 * @returns {object | null}
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
 *   cycle?: object,
 *   todo?: object | null,
 *   workspaceFolder?: string,
 *   dataDir?: string,
 * }} input
 * @returns {object | null}
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
 * @returns {{ found: boolean, todo: object | null, readError: string | null }}
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
 *   cycle?: object,
 *   claimedTodoIds?: string[],
 *   reportedTodoIds?: string[],
 *   loadTodo?: (todoId: string) => { found: boolean, todo: object | null, readError?: string | null },
 * }} [input]
 * @returns {{
 *   claimedTodoIds: string[],
 *   reportedTodoIds: string[],
 *   unknownReportedTodoIds: string[],
 *   completedTodoIds: string[],
 *   attemptedTodoIds: string[],
 *   blockedTodoIds: string[],
 *   todoOutcomes: object[],
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
  /** @type {object[]} */
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
 *   cycle?: object,
 *   workspaceFolder?: string,
 *   dataDir?: string,
 *   reportedTodoIds?: string[],
 * }} [input]
 * @returns {ReturnType<typeof resolveWorkspaceWatcherCycleTodoOutcomes>}
 */
export function resolveWorkspaceWatcherCycleTodoOutcomesForClose(input = {}) {
  /** @type {Map<string, { found: boolean, todo: object | null, readError: string | null }>} */
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
 * @param {object | null | undefined} row
 * @param {object | null | undefined} cycle
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
 *   todoOutcomes?: object[],
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
 *   row: object,
 *   cycle: object,
 *   outcome?: string,
 *   todoIds?: string[],
 *   reports?: object[],
 *   now?: number,
 *   at?: string,
 *   decisionReason?: string,
 *   closeSource?: string,
 *   todo?: object | null,
 *   workspaceFolder?: string,
 *   dataDir?: string,
 * }} input
 * @returns {object}
 */
export function buildWorkspaceWatcherCycleClosePatch(input) {
  const row = input.row || {};
  const cycle = input.cycle || {};
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const at = String(input.at || new Date(now).toISOString());
  const outcome = WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(String(input.outcome))
    ? String(input.outcome)
    : 'failure';
  const decisionReason = String(input.decisionReason || '').trim() || outcome;
  // 'blocked' means waiting for human action (e.g. plan approval) — not a
  // genuine failure; only 'failure' increments the failure counter and backoff.
  const failed = outcome === 'failure';
  const todoIds = (Array.isArray(input.todoIds) && input.todoIds.length ? input.todoIds : (cycle.todoIds || []))
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const primaryTodoId = todoIds[0] || '';
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
  if (primaryTodoId) {
    const failures = { ...(row.failures || {}) };
    if (failed) failures[primaryTodoId] = (failures[primaryTodoId] || 0) + 1;
    else delete failures[primaryTodoId];
    patch.failures = failures;
    patch.backoffUntil = failed
      ? computeWorkspaceWatcherBackoffUntil({
        failures,
        now,
        baseMs: row.policy?.backoffBaseMs,
        capMs: row.policy?.backoffCapMs,
      })
      : '';
    if (failed && cycle.planOnly === true) {
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
    };
    const existing = Array.isArray(row.cycleChats) ? row.cycleChats : [];
    if (!existing.some((chat) => String(chat?.id || '') === entry.id)) {
      patch.cycleChats = [...existing, entry].slice(-WORKSPACE_WATCHER_MAX_CYCLE_CHATS);
    }
  }
  patch.decisions = [
    ...(row.decisions || []),
    {
      at,
      kind: failed ? 'cycle_failed' : 'cycle_completed',
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
 *   cycle: object,
 *   workspaceFolder?: string,
 *   closedAt?: string,
 *   closeSource?: string,
 *   closeReason?: string,
 *   closeOutcome?: string | null,
 *   reportedOutcome?: string | null,
 *   reportedTodoIds?: string[],
 *   leafOutcomes?: object | null,
 *   todoStatusAtClose?: string,
 *   blockedReasonCode?: string | null,
 *   stopReason?: string,
 *   todo?: object | null,
 * }} input
 * @returns {object}
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
 * @returns {void}
 */
export function releaseWorkspaceWatcherCycleTodoClaim(input) {
  try {
    withTodosWatcherNudgeSuppressed(() => {
      const doc = loadTodosData(input.dataDir, input.workspaceFolder);
      const current = (Array.isArray(doc?.items) ? doc.items : [])
        .find((row) => String(row?.id || '') === String(input.todoId || '')) || null;
      if (!current) return;
      if (String(current.claimedByChatId || '') !== String(input.chatId || '')) return;
      const expectedAttemptId = String(input.attemptId || '').trim();
      const currentAttemptId = String(current.execution?.attemptId || '').trim();
      const expectedCycleId = String(input.cycleId || '').trim();
      const currentCycleId = String(current.execution?.cycleId || '').trim();
      if (currentAttemptId) {
        if (expectedAttemptId) {
          if (expectedAttemptId !== currentAttemptId) return;
        } else if (!(expectedCycleId && expectedCycleId === currentCycleId)) {
          return;
        }
      }
      if (expectedCycleId && expectedCycleId !== currentCycleId) {
        if (currentCycleId || currentAttemptId) return;
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
        return;
      }
      if (String(current.status || '') === 'done') {
        updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
          claimedByChatId: null,
          claimedAt: null,
          expectedUpdatedAt: current.updatedAt,
        });
        return;
      }
      if (String(current.status || '') !== 'doing') return;
      const watcher = getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir });
      const failures = watcher?.failures?.[input.todoId] || 0;
      const ceiling = watcher?.policy?.maxConsecutiveFailures || 0;
      updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
        status: 'ready',
        strictStatus: true,
        claimedByChatId: null,
        claimedAt: null,
        expectedUpdatedAt: current.updatedAt,
        blockedReason: ceiling > 0 && failures >= ceiling
          ? workspaceWatcherFailureCeilingReason(failures, ceiling) : null,
        appendChangelog: ceiling > 0 && failures >= ceiling ? {
          kind: 'note', chatId: input.chatId,
          text: `Workspace Watcher skipped this todo after ${failures} failed cycles (limit ${ceiling}). Resolve the blocker and retry manually or adjust the watcher failure limit.`,
        } : undefined,
      });
    });
  } catch {
    // A todo that moved on (done/doing by someone else) is not ours to reset.
  }
}

/**
 * Mark a deferred report as resolved when the cycle closes.
 *
 * @param {object[] | undefined} reports
 * @param {object} cycle
 * @returns {object[] | undefined}
 */
export function resolveDeferredWorkspaceWatcherReports(reports, cycle) {
  if (!Array.isArray(reports) || !cycle?.reportId) return reports;
  return reports.map((entry) => (
    String(entry?.reportId || '') === String(cycle.reportId)
      ? { ...entry, deferred: false }
      : entry
  ));
}
