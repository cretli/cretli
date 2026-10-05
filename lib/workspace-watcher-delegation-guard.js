/**
 * Hard gates for delegations started from a Workspace Watcher orchestrator chat.
 */

import { loadChats } from './persist/chats-persist.js';
import { findWorkspaceWatcherCycle, getWorkspaceWatcher } from './persist/workspace-watchers-persist.js';
import { loadTodosData } from './persist/todos-persist.js';
import { listHarnessUsageLimits } from './harness-usage-limits.js';
import { resolveWatcherGatePlan } from './workspace-watcher-guardrails.js';

/**
 * @param {string} dataDir
 * @returns {object[]}
 */
function safeUsageLimits(dataDir) {
  try {
    return listHarnessUsageLimits(dataDir);
  } catch {
    return [];
  }
}

/**
 * @param {{
 *   parentChatId: string,
 *   executor?: { transport?: string, model?: string },
 *   assignment?: string,
 *   dataDir?: string,
 * }} input
 * @returns {{ ok: true } | { ok: false, status: number, error: string, code: string }}
 */
export function validateWorkspaceWatcherParentDelegation(input) {
  const parentChatId = String(input?.parentChatId || '').trim();
  if (!parentChatId) return { ok: true };
  const parent = loadChats().find((row) => row.id === parentChatId);
  if (!parent) return { ok: true };
  const workspaceFolder = String(parent.workspaceFolder || '').trim();
  if (!workspaceFolder) return { ok: true };
  const dataDir = String(input?.dataDir ?? '').trim();
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  // Per-slot authorization: the gate applies to the cycle this chat actually
  // owns. A parent that owns no slot is not a watcher orchestrator, so the guard
  // stays open exactly as it did when the row's single cycle belonged to someone
  // else. `planOnly` and the todo allow-list are read from that slot only, so a
  // plan-only sibling can never block another cycle's implementation.
  const cycle = findWorkspaceWatcherCycle(watcher, { chatId: parentChatId });
  if (!cycle) return { ok: true };
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const transport = String(input?.executor?.transport || '').trim();
  const model = String(input?.executor?.model || '').trim();
  const allowed = Array.isArray(policy.allowedHarnesses)
    ? policy.allowedHarnesses.map((h) => String(h ?? '').trim()).filter(Boolean)
    : [];
  if (allowed.length > 0 && transport && !allowed.includes(transport)) {
    return {
      ok: false,
      status: 403,
      error: `Harness "${transport}" is outside the workspace watcher allow-list.`,
      code: 'watcher_harness_denied',
    };
  }
  for (const row of safeUsageLimits(dataDir)) {
    const limitHarness = String(row?.harness ?? '').trim();
    const limitModel = String(row?.model ?? '').trim();
    if (!limitHarness || limitHarness !== transport) continue;
    if (!limitModel || limitModel === model) {
      return {
        ok: false,
        status: 429,
        error: `Harness "${transport}" is under an active usage limit for this workspace watcher.`,
        code: 'watcher_usage_limit',
      };
    }
  }
  const assignment = String(input?.assignment || '').trim().toLowerCase();
  if (cycle.planOnly === true && assignment !== 'plan' && assignment !== 'review') {
    return {
      ok: false,
      status: 403,
      error: 'This watcher cycle is plan-only; implementation delegations are blocked until the plan is approved.',
      code: 'watcher_plan_only',
    };
  }
  if (policy.requirePlanApproval !== false && (assignment === 'implement' || assignment === 'fix')) {
    const todoId = String(cycle.todoIds?.[0] || parent.todoId || '').trim();
    if (todoId) {
      const doc = loadTodosData(dataDir, workspaceFolder);
      const items = Array.isArray(doc?.items) ? doc.items : [];
      const todo = items.find((row) => row?.id === todoId) || null;
      const approvedAt = resolveWatcherGatePlan(items, todo).approvedAt;
      if (!approvedAt) {
        return {
          ok: false,
          status: 403,
          error: 'Todo plan is not approved; the watcher blocks implementation delegations.',
          code: 'watcher_plan_not_approved',
        };
      }
    }
  }
  return { ok: true };
}
