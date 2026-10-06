/**
 * Shared control surface for the Workspace Watcher.
 *
 * The REST routes and the in-process MCP client both funnel through these
 * functions, so the settings UI, the stdio MCP client and a local agent see the
 * exact same semantics (including the "reads never create a row" rule).
 */

import { resolveDataPath } from './runtime-paths.js';
import {
  WORKSPACE_WATCHER_MODES,
  getWorkspaceWatcher,
  getWorkspaceWatcherActiveCycles,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceWatcherRow,
  removeWorkspaceWatcher,
  upsertWorkspaceWatcher,
  workspaceWatcherClosedCycleChatIds,
  workspaceWatcherCycleChatIds,
  workspaceWatcherOrchestratorChatIds,
} from './persist/workspace-watchers-persist.js';
import {
  claimNextWorkspaceTodo,
  releaseStaleWorkspaceTodoClaims,
  snapshotWorkspaceWatcher,
  tickWorkspaceWatcher,
  workspaceWatcherScoutParentChatIds,
  WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN,
} from './workspace-watcher.js';
import { evaluateWorkspaceWatcherGuardrails, readWorkspaceWatcherTodoFindings } from './workspace-watcher-guardrails.js';
import {
  reconcileWorkspaceWatcherCycle,
  reportWorkspaceWatcherCycle as reportWorkspaceWatcherCycleService,
  runWorkspaceWatcherAutopilot,
  startWorkspaceWatcherCycle,
} from './workspace-watcher-cycle.js';
import { listHarnessUsageLimits } from './harness-usage-limits.js';
import { loadTodosData, updateTodo, withTodosWatcherNudgeSuppressed } from './persist/todos-persist.js';
import { broadcastWorkspaceWatcherChanged } from './workspace-watcher-live.js';
import { ensurePinnedChat } from './workspace-watcher-pinned-chat.js';
import { loadChats } from './persist/chats-persist.js';
import {
  computeScoutSchedule,
  runWorkspaceWatcherScout,
  runWorkspaceWatcherScoutAction,
} from './workspace-watcher-scout.js';

/**
 * @param {object} current
 * @param {object} patch
 * @returns {object}
 */
function mergePolicy(current, patch) {
  const next = { ...(current || {}), ...(patch || {}) };
  if (patch?.quietHours && typeof patch.quietHours === 'object') {
    next.quietHours = { ...(current?.quietHours || {}), ...patch.quietHours };
  }
  if (patch?.orchestrator && typeof patch.orchestrator === 'object') {
    next.orchestrator = { ...(current?.orchestrator || {}), ...patch.orchestrator };
  }
  return next;
}

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
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {object}
 */
export function getWorkspaceWatcherView(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir })
    || normalizeWorkspaceWatcherRow({ workspaceFolder });
  const usageLimits = safeUsageLimits(dataDir);
  const cycleChatIds = workspaceWatcherCycleChatIds(watcher);
  const closedCycleChatIds = workspaceWatcherClosedCycleChatIds(watcher);
  const snapshot = snapshotWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    excludeChatIds: cycleChatIds,
    excludeDelegationParentChatIds: cycleChatIds,
    closedCycleChatIds,
    scoutParentChatIds: workspaceWatcherScoutParentChatIds(watcher),
  });
  return {
    workspaceFolder,
    watcher,
    snapshot,
    guardrails: evaluateWorkspaceWatcherGuardrails({ watcher, pickedTodo: null, activeUsageLimits: usageLimits }),
    // Operator-facing Scout schedule (next scan, budget, live blocker). Additive:
    // every existing consumer keeps reading `watcher`/`snapshot`/`guardrails`.
    scout: computeScoutSchedule({
      watcher,
      now: Number.isFinite(input.now) ? Number(input.now) : Date.now(),
      scoutAgentCount: snapshot.scoutAgentCount,
    }),
    usageLimits,
  };
}

/**
 * HTTP view for settings. Drops the full todo documents (`items`, `readyLeaves`)
 * that the tick and MCP still read from {@link getWorkspaceWatcherView}.
 * Counts and id lists stay.
 *
 * @param {object} view
 * @returns {object}
 */
export function toWorkspaceWatcherHttpView(view) {
  const snapshot = view?.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return view;
  const httpSnapshot = { ...snapshot };
  delete httpSnapshot.items;
  delete httpSnapshot.readyLeaves;
  return { ...view, snapshot: httpSnapshot };
}

/**
 * Patch mode/enabled/stopReason/policy without dropping nested policy fields.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, patch?: object }} input
 * @returns {object}
 */
export function applyWorkspaceWatcherPatch(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const body = input.patch && typeof input.patch === 'object' ? input.patch : {};
  if (body.mode != null && !WORKSPACE_WATCHER_MODES.includes(String(body.mode).trim().toLowerCase())) {
    const error = new Error(`mode must be one of: ${WORKSPACE_WATCHER_MODES.join(', ')}`);
    error.code = 'VALIDATION';
    throw error;
  }
  const existing = getWorkspaceWatcher(workspaceFolder, { dataDir })
    || normalizeWorkspaceWatcherRow({ workspaceFolder });
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (body.mode != null) patch.mode = body.mode;
  if (body.enabled != null) patch.enabled = body.enabled;
  if (body.paused != null) patch.paused = body.paused === true;
  if (body.stopReason != null) patch.stopReason = body.stopReason;
  // Allow explicit reset of loop-guard state: pass `failures: {}` to clear all
  // failure counts, `backoffUntil: ''` to release the backoff timer.
  if (body.failures != null && typeof body.failures === 'object') patch.failures = body.failures;
  if (body.backoffUntil != null) patch.backoffUntil = String(body.backoffUntil);
  if (body.policy && typeof body.policy === 'object') {
    patch.policy = mergePolicy(existing.policy, body.policy);
  }
  const watcher = upsertWorkspaceWatcher(workspaceFolder, patch, { dataDir });
  // Enabling autopilot materializes the durable pinned chat on first use, so the
  // operator has somewhere to watch the very first cycle. A read-only PATCH
  // (policy/pause) never creates it; `ensurePinnedChat` is idempotent.
  const wantsAutopilot = String(watcher?.mode || '') === 'autopilot';
  if (wantsAutopilot) {
    try {
      ensurePinnedChat({ workspaceFolder, dataDir });
    } catch {
      // The pinned chat is an observability convenience; a chat-store failure
      // must not fail the watcher configuration write.
    }
  }
  broadcastWorkspaceWatcherChanged({ workspaceFolder });
  return getWorkspaceWatcher(workspaceFolder, { dataDir }) || watcher;
}

/**
 * Clear a loop-guard stop (`loop_no_eligible_work` or `loop_same_findings`):
 * resets the failure counters and backoff timer, then clears `blockedReason` on
 * every todo that was parked by the loop guard so the watcher can pick them up
 * again on the next tick.
 *
 * A plain `clear-stop` only wipes `stopReason`, which causes the watcher to
 * immediately re-stop because the failure ceiling is still hit. This function
 * does the full three-step reset so the operator does not have to do it manually.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {{ watcher: object, unblockedTodoIds: string[] }}
 */
export function clearWorkspaceWatcherLoopStop(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim() || resolveDataPath();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const existing = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const todoIdsToUnblock = Object.keys(existing?.failures || {});
  // Clear stopReason, all failure counts, and the backoff timer.
  const watcher = upsertWorkspaceWatcher(workspaceFolder, {
    stopReason: '',
    failures: {},
    backoffUntil: '',
  }, { dataDir });
  // Unblock any todos that were parked by the loop guard (those still carrying a
  // failure-ceiling blockedReason). We try best-effort: a CAS miss (the todo
  // moved on) is silently ignored.
  const unblockedTodoIds = [];
  for (const todoId of todoIdsToUnblock) {
    try {
      withTodosWatcherNudgeSuppressed(() => {
        const doc = loadTodosData(dataDir, workspaceFolder);
        const todo = (Array.isArray(doc?.items) ? doc.items : [])
          .find((row) => String(row?.id || '') === todoId);
        if (!todo) return;
        const reason = String(todo.blockedReason || '').trim();
        if (!reason) return;
        updateTodo(dataDir, workspaceFolder, todoId, {
          status: todo.status,
          strictStatus: true,
          blockedReason: '',
          expectedUpdatedAt: todo.updatedAt,
        });
        unblockedTodoIds.push(todoId);
      });
    } catch {
      // CAS miss or store error — leave the todo as-is.
    }
  }
  broadcastWorkspaceWatcherChanged({ workspaceFolder });
  return { watcher: getWorkspaceWatcher(workspaceFolder, { dataDir }) || watcher, unblockedTodoIds };
}

/**
 * Read the pinned chat id for a workspace without creating anything.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {{ workspaceFolder: string, chatId: string, chat: object | null }}
 */
export function getWorkspaceWatcherPinnedChat(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const chatId = String(watcher?.pinnedChatId || '').trim();
  const chat = chatId ? loadChats().find((entry) => entry?.id === chatId) || null : null;
  return { workspaceFolder, chatId: chat ? chatId : '', chat };
}

/**
 * Idempotently ensure the pinned chat exists and return it.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {object}
 */
export function ensureWorkspaceWatcherPinnedChat(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const result = ensurePinnedChat({ workspaceFolder, dataDir });
  broadcastWorkspaceWatcherChanged({ workspaceFolder });
  return result;
}

/**
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {boolean}
 */
export function deleteWorkspaceWatcher(input = {}) {
  return removeWorkspaceWatcher(String(input.workspaceFolder ?? '').trim(), {
    dataDir: String(input.dataDir ?? '').trim(),
  });
}

/**
 * One explicit tick; an autopilot row may also start one cycle.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {Promise<{ tick: object, started: object | null }>}
 */
export async function runWorkspaceWatcherTick(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const token = String(input.token ?? '').trim() || WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN;
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
  reconcileWorkspaceWatcherCycle({ workspaceFolder, dataDir, now, deps });
  releaseStaleWorkspaceTodoClaims({
    workspaceFolder,
    dataDir,
    probeChatRunLiveness: deps.probeChatRunLiveness,
  });
  const tick = tickWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    now,
    token,
    deps,
    notify: deps.notify,
    notifyDeps: deps.notifyDeps,
  });
  let started = null;
  const startable = ['start_cycle', 'plan_gate'].includes(String(tick.decision?.kind || ''));
  if (!startable) return { tick, started };
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  if (!watcher || String(watcher.mode || '') !== 'autopilot' || watcher.enabled === false) {
    return { tick, started: { started: false, reason: 'not_autopilot' } };
  }
  if (watcher.paused === true) {
    return { tick, started: { started: false, reason: 'paused' } };
  }
  if (String(watcher.stopReason || '').trim()) {
    return { tick, started: { started: false, reason: 'stopped' } };
  }
  const usageLimits = safeUsageLimits(dataDir);
  const picked = (Array.isArray(tick.snapshot?.readyLeaves) ? tick.snapshot.readyLeaves : [])
    .find((row) => String(row?.id || '') === String(tick.decision?.nextTodoId || '')) || null;
  const guard = evaluateWorkspaceWatcherGuardrails({
    watcher,
    pickedTodo: picked,
    items: Array.isArray(tick.snapshot?.items) ? tick.snapshot.items : [],
    now,
    activeUsageLimits: usageLimits,
  });
  if (!guard.allowed) {
    return { tick, started: { started: false, reason: guard.reason || 'guardrail_blocked' } };
  }
  if (getWorkspaceWatcherActiveCycles(watcher).length >= Math.max(1, Number(watcher.policy?.maxParallel) || 1)) {
    return { tick, started: { started: false, reason: 'cycle_active' } };
  }
  started = await startWorkspaceWatcherCycle({
    workspaceFolder,
    dataDir,
    now,
    tick,
    token,
    deps,
  });
  return { tick, started };
}

/**
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {Promise<object>}
 */
export async function runWorkspaceWatcherCycleNow(input = {}) {
  return runWorkspaceWatcherAutopilot({
    dataDir: String(input.dataDir ?? '').trim(),
    workspaceFolders: [String(input.workspaceFolder ?? '').trim()],
  });
}

/**
 * Resolve which chat owns a watcher claim when MCP passes source + optional override.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, sourceChatId?: string, requestedClaimChatId?: string }} input
 * @returns {{ ok: true, claimedByChatId: string } | { ok: false, reason: 'no_claimer' | 'claim_owner_forbidden' }}
 */
export function resolveWatcherClaimOwner(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const sourceChatId = String(input.sourceChatId ?? '').trim();
  const requestedClaimChatId = String(input.requestedClaimChatId ?? '').trim();
  const claimedByChatId = requestedClaimChatId || sourceChatId;
  if (!claimedByChatId) {
    return { ok: false, reason: 'no_claimer' };
  }
  if (requestedClaimChatId && sourceChatId && requestedClaimChatId !== sourceChatId) {
    const view = getWorkspaceWatcherView({ dataDir, workspaceFolder });
    // Any live cycle's orchestrator may claim on its own slot's behalf. While a
    // cycle is live only `activeCycles[].chatId` authorizes; `orchestratorChatId`
    // is the idle "last known" owner and must not widen the live set.
    const owners = new Set(workspaceWatcherOrchestratorChatIds(view?.watcher));
    if (!owners.has(sourceChatId)) {
      return { ok: false, reason: 'claim_owner_forbidden' };
    }
  }
  return { ok: true, claimedByChatId };
}

/**
 * @param {{ dataDir?: string, workspaceFolder?: string, claimedByChatId?: string, maxFailures?: number }} input
 * @returns {object}
 */
export function claimNextWorkspaceWatcherTodo(input = {}) {
  return claimNextWorkspaceTodo({
    dataDir: String(input.dataDir ?? '').trim(),
    workspaceFolder: String(input.workspaceFolder ?? '').trim(),
    claimedByChatId: input.claimedByChatId,
    ttlMs: input.ttlMs,
    maxFailures: Number.isFinite(input.maxFailures) ? Number(input.maxFailures) : undefined,
  });
}

/**
 * @param {{ dataDir?: string, workspaceFolder?: string, todoId?: string }} input
 * @returns {{ changed: boolean, watcher: object }}
 */
export function resetWorkspaceWatcherPlanRequests(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const todoId = String(input.todoId ?? '').trim();
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    if (!todoId) return { planRequests: {} };
    const planRequests = { ...row.planRequests };
    delete planRequests[todoId];
    return { planRequests };
  }, { dataDir, createIfMissing: false });
  return {
    changed: result.ok === true,
    watcher: result.row || getWorkspaceWatcher(workspaceFolder, { dataDir })
      || normalizeWorkspaceWatcherRow({ workspaceFolder }),
  };
}

/**
 * @param {{ dataDir?: string, workspaceFolder?: string, hash?: string }} input
 * @returns {{ changed: boolean, findings: object | null }}
 */
/**
 * @param {{ dataDir?: string, workspaceFolder?: string, todoId?: string, expectedUpdatedAt?: string, planMarkdown?: string, sourceChatId?: string }} input
 * @returns {object}
 */
export function saveWorkspaceWatcherTodoPlanDraft(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const todoId = String(input.todoId ?? '').trim();
  const expectedUpdatedAt = String(input.expectedUpdatedAt ?? '').trim();
  const markdown = String(input.planMarkdown ?? '');
  if (!todoId || !expectedUpdatedAt) {
    const error = new Error('todoId and expectedUpdatedAt are required');
    error.code = 'VALIDATION';
    throw error;
  }
  const doc = updateTodo(dataDir, workspaceFolder, todoId, {
    expectedUpdatedAt,
    strictStatus: true,
    plan: {
      markdown,
      sourceChatId: String(input.sourceChatId ?? '').trim() || undefined,
    },
  });
  const item = doc.items.find((row) => row.id === todoId) || null;
  return { item };
}

export function recordWorkspaceWatcherFindings(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const hash = String(input.hash ?? input.findingsHash ?? '').trim();
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const todoId = String(
    input.todoId
    ?? input.todo_id
    ?? getWorkspaceWatcherActiveCycles(watcher)[0]?.todoIds?.[0]
    ?? '',
  ).trim();
  if (!todoId) {
    const error = new Error('todoId is required to record workspace watcher findings');
    error.code = 'VALIDATION';
    throw error;
  }
  const summary = String(input.summary ?? input.findingsText ?? input.findings_text ?? '').trim().slice(0, 2000);
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    const byTodo = { ...(row.findings?.byTodo || {}) };
    if (!hash) {
      delete byTodo[todoId];
      return { findings: { byTodo } };
    }
    const previous = readWorkspaceWatcherTodoFindings(row.findings, todoId);
    const streak = previous.hash === hash ? previous.streak + 1 : 1;
    byTodo[todoId] = summary ? { hash, streak, summary } : { hash, streak };
    return { findings: { byTodo } };
  }, { dataDir, createIfMissing: false });
  const findings = result.row?.findings || { byTodo: {} };
  const entry = readWorkspaceWatcherTodoFindings(findings, todoId);
  return {
    changed: result.ok === true,
    findings,
    todoId,
    hash: entry.hash,
    streak: entry.streak,
  };
}

/**
 * Durable outcome of one autopilot cycle. The caller chat must be the active
 * cycle's orchestrator; a foreign chat is rejected and a repeated report is
 * idempotent. Shared by REST, the in-process client and the remote client.
 *
 * @param {{
 *   dataDir?: string, workspaceFolder?: string, sourceChatId?: string,
 *   outcome?: string, todoIds?: string[], cycleId?: string, reportId?: string,
 *   message?: string, now?: number,
 * }} input
 * @returns {object}
 */
export function reportWorkspaceWatcherCycle(input = {}) {
  return reportWorkspaceWatcherCycleService({
    dataDir: String(input.dataDir ?? '').trim(),
    workspaceFolder: String(input.workspaceFolder ?? '').trim(),
    sourceChatId: String(input.sourceChatId ?? '').trim(),
    outcome: String(input.outcome ?? '').trim(),
    todoIds: Array.isArray(input.todoIds) ? input.todoIds : undefined,
    cycleId: String(input.cycleId ?? '').trim(),
    reportId: String(input.reportId ?? '').trim(),
    message: String(input.message ?? ''),
    now: Number.isFinite(input.now) ? Number(input.now) : undefined,
  });
}

/**
 * Scout proposals: list / accept / reject / submit. This is the shared control
 * surface for the REST route, the in-process MCP client and the remote client.
 *
 * @param {object} [input]
 * @returns {object}
 */
export function runWorkspaceWatcherScoutFindings(input = {}) {
  return runWorkspaceWatcherScoutAction(input);
}

/**
 * Run one Scout scan now for one workspace (manual trigger). It bypasses the
 * schedule only in the sense that it is explicit; it still respects the mode,
 * quiet hours and the per-day scan budget.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, now?: number }} [input]
 * @returns {Promise<object>}
 */
export async function runWorkspaceWatcherScoutNow(input = {}) {
  return runWorkspaceWatcherScout({
    dataDir: String(input.dataDir ?? '').trim(),
    workspaceFolder: String(input.workspaceFolder ?? '').trim(),
    now: Number.isFinite(input.now) ? Number(input.now) : undefined,
    deps: input.deps && typeof input.deps === 'object' ? input.deps : undefined,
    bypassInterval: true,
  });
}
