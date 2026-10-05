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

/**
 * @param {{ cycle: object, todo: object | null, watcher: object | null }} input
 * @returns {boolean}
 */
export function shouldCountWorkspaceWatcherCycleIncomplete(input) {
  const todo = input.todo;
  if (!todo || typeof todo !== 'object') return false;
  if (String(todo.status || '') === 'done') return false;
  const cycle = input.cycle || {};
  if (cycle.planOnly === true) {
    const hasMarkdown = String(todo.plan?.markdown ?? '').trim().length > 0;
    const approvedAt = String(todo.plan?.approvedAt ?? '').trim();
    if (hasMarkdown && !approvedAt) return false;
    if (!hasMarkdown) return ['doing', 'ready'].includes(String(todo.status || ''));
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
 * Resolve the durable close outcome from a stored report and todo progress.
 *
 * @param {{
 *   cycle: object,
 *   row: object,
 *   todo: object | null,
 *   reportedOutcomeRaw?: string,
 * }} input
 * @returns {{ closeOutcome: string, countIncompleteFailure: boolean }}
 */
export function resolveWorkspaceWatcherCycleCloseOutcome(input) {
  const cycle = input.cycle || {};
  const row = input.row || {};
  const reportedOutcome = WORKSPACE_WATCHER_CYCLE_OUTCOMES.includes(String(input.reportedOutcomeRaw || ''))
    ? String(input.reportedOutcomeRaw)
    : '';
  const todo = input.todo;
  if (reportedOutcome === 'success') {
    const incomplete = shouldCountWorkspaceWatcherCycleIncomplete({ cycle, todo, watcher: row });
    if (incomplete) {
      return { closeOutcome: 'failure', countIncompleteFailure: true };
    }
    return { closeOutcome: 'success', countIncompleteFailure: false };
  }
  if (reportedOutcome) {
    return {
      closeOutcome: reportedOutcome,
      countIncompleteFailure: reportedOutcome !== 'success',
    };
  }
  const countIncompleteFailure = todo
    ? shouldCountWorkspaceWatcherCycleIncomplete({ cycle, todo, watcher: row })
    : false;
  return {
    closeOutcome: countIncompleteFailure ? 'failure' : 'success',
    countIncompleteFailure,
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
  if (!todoId || !input.workspaceFolder) return null;
  try {
    const doc = loadTodosData(input.dataDir, input.workspaceFolder);
    return (Array.isArray(doc?.items) ? doc.items : []).find((row) => row?.id === todoId) || null;
  } catch {
    return null;
  }
}

/**
 * Shared patch that closes exactly one cycle.
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
      const planRequests = { ...(row.planRequests || {}) };
      // planTargetId is set when planApprovalScope:'root' stored the request
      // under the subtree root rather than the leaf.
      const planRequestKey = String(cycle.planTargetId || '').trim() || primaryTodoId;
      delete planRequests[planRequestKey];
      patch.planRequests = planRequests;
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
 * @param {{ workspaceFolder: string, todoId: string, chatId: string, dataDir?: string, now?: number }} input
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
          ? `Workspace Watcher failure ceiling reached (${failures}/${ceiling}). Retry manually after resolving the blocker.` : null,
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
