import { evaluateWorkspaceWatcherSafetyValve } from './workspace-watcher-scheduler.js';
/**
 * Shared control surface for the Workspace Watcher.
 *
 * The REST routes and the in-process MCP client both funnel through these
 * functions, so the settings UI, the stdio MCP client and a local agent see the
 * exact same semantics (including the "reads never create a row" rule).
 */

import { validatePhasesInput } from './watcher-phases.js';
import { resolveDataPath } from './runtime-paths.js';
import {
  SCOUT_GENERAL_PROFILE_ID,
  WORKSPACE_SCOUT_PROFILE_MAX_NAME_LENGTH,
  WORKSPACE_WATCHER_MAX_STOP_REASON_LENGTH,
  WORKSPACE_WATCHER_MODES,
  defaultWorkspaceScoutProfile,
  getActiveScoutScans,
  getWorkspaceScoutProfile,
  getWorkspaceWatcher,
  getWorkspaceWatcherActiveCycles,
  listWorkspaceScoutProfiles,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceScoutScanHistory,
  normalizeWorkspaceWatcherRow,
  removeWorkspaceWatcher,
  upsertWorkspaceScoutProfile,
  upsertWorkspaceWatcher,
  workspaceWatcherClosedCycleChatIds,
  workspaceWatcherCycleChatIds,
  workspaceWatcherOrchestratorChatIds,
} from './persist/workspace-watchers-persist.js';
import {
  claimNextWorkspaceTodo,
  decideWorkspaceWatcherAction,
  releaseStaleWorkspaceTodoClaims,
  snapshotWorkspaceWatcher,
  tickWorkspaceWatcher,
  workspaceWatcherScoutParentChatIds,
  WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN,
} from './workspace-watcher.js';
import {
  enrichWorkspaceTodoRecoveryView,
  recoverWorkspaceWatcherTodo,
  releaseDoingWorkspaceWatcherTodo,
} from './workspace-watcher-todo-recover.js';
import {
  computeWatcherSchedule,
  evaluateWorkspaceWatcherGuardrails,
  readWorkspaceWatcherTodoFindings,
  workspaceWatcherUtcDayKey,
} from './workspace-watcher-guardrails.js';
import { isWorkspaceWatcherBlockedReason } from './workspace-watcher-blocked-reason.js';
import {
  partitionWorkspaceWatcherCyclesByPool,
  workspaceWatcherPoolTodoIndex,
  workspaceWatcherStartPoolGate,
} from './workspace-watcher-pool.js';
import {
  reconcileWorkspaceWatcherCycle,
  reportWorkspaceWatcherCycle as reportWorkspaceWatcherCycleService,
  runWorkspaceWatcherAutopilot,
  startWorkspaceWatcherCycle,
} from './workspace-watcher-cycle.js';
import { listHarnessUsageLimits, listHarnessUsageLimitsForWorkspace } from './harness-usage-limits.js';
import { withTodosWatcherNudgeSuppressed } from './persist/todos-persist.js';
import { getRevision as getTodosRevision, listTodos, updateTodo } from './persist/todos-store.js';
import { broadcastWorkspaceWatcherChanged } from './workspace-watcher-live.js';
import { backfillWorktreeLayout } from './execution-settings-suggest.js';
import { resolveExecutionSettingsView } from './execution-settings.js';
import { saveExecutionSettings } from './persist/execution-settings-persist.js';
import { ensurePinnedChat } from './workspace-watcher-pinned-chat.js';
import { loadChats } from './persist/chats-persist.js';
import { isBootReconciliationComplete } from './delegation-lifecycle.js';
import {
  buildScoutPreview,
  computeScoutProfileNextRunAt,
  computeScoutSchedule,
  decideScoutRun,
  resolveScoutScheduleState,
  runWorkspaceWatcherScout,
  runWorkspaceWatcherScoutAction,
} from './workspace-watcher-scout.js';
import { countOccupiedScoutScans, isScoutScanOccupied } from './workspace-scout-occupancy.js';
import { getServerInstanceId } from './sdk/sdk-instance-id.ts';
import {
  listScoutTemplates,
  materializeProfileFromTemplate,
  restoreProfileInstructionsFromTemplate,
} from './workspace-scout-templates.js';

/**
 * Strict input check for the review-gate policy fields. The normalizer coerces
 * unknown values to defaults on read; a write that names one is a caller bug.
 *
 * @param {Record<string, unknown>} policy
 * @returns {string}
 */
function validateReviewGatePolicyInput(policy) {
  if (policy.requireReviewForDone !== undefined
    && !['off', 'warn', 'enforce'].includes(String(policy.requireReviewForDone))) {
    return 'policy.requireReviewForDone must be one of: off, warn, enforce';
  }
  if (policy.requireIndependentReview !== undefined && typeof policy.requireIndependentReview !== 'boolean') {
    return 'policy.requireIndependentReview must be a boolean';
  }
  if (policy.reviewGateMaxAttempts !== undefined) {
    const value = Number(policy.reviewGateMaxAttempts);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return 'policy.reviewGateMaxAttempts must be an integer between 1 and 5';
    }
  }
  return '';
}

/**
 * @param {Record<string, any>} current
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
function mergePolicy(current, patch) {
  const next = { ...(current || {}), ...(patch || {}) };
  if (patch?.quietHours && typeof patch.quietHours === 'object') {
    next.quietHours = { ...(current?.quietHours || {}), ...patch.quietHours };
  }
  if (patch?.orchestrator && typeof patch.orchestrator === 'object') {
    next.orchestrator = { ...(current?.orchestrator || {}), ...patch.orchestrator };
  }
  if (patch?.worktree && typeof patch.worktree === 'object') {
    next.worktree = { ...(current?.worktree || {}), ...patch.worktree };
  }
  return next;
}

const WORKTREE_LAYOUT_KEYS = Object.freeze(['root', 'namespace', 'branchPrefix', 'directoryPrefix']);

/**
 * Fill a missing worktree layout from the workspace-derived suggestion so an
 * operator can enable worktree mode with one click instead of inventing a path.
 * Only the four required layout fields are backfilled; `prepareCommand` stays
 * exactly as the caller sent it, so clearing it is never undone. A workspace
 * without a Git repository keeps its policy unchanged and fails later with the
 * usual readable refusal.
 *
 * @param {Record<string, any>} policy
 * @param {string} workspaceFolder
 * @returns {Record<string, any>}
 */
function applyWorktreeLayoutDefaults(policy, workspaceFolder) {
  const next = { ...(policy || {}) };
  const worktree = next.worktree && typeof next.worktree === 'object' ? next.worktree : {};
  const wantsWorktree = String(next.executionMode ?? '').trim() === 'worktree'
    || WORKTREE_LAYOUT_KEYS.some((key) => String(worktree[key] ?? '').trim() !== '');
  if (!wantsWorktree) return next;
  // Shared with the start-time backfill so a settings save and a worktree start
  // can never derive a different layout from the same workspace.
  return backfillWorktreeLayout(next, workspaceFolder).policy;
}

/**
 * @param {string} dataDir
 * @param {string} [workspaceFolder]
 * @returns {Record<string, any>[]}
 */
function safeUsageLimits(dataDir, workspaceFolder) {
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
 * Safety TTL for the cached view. Inputs the cheap revision key cannot see
 * (delegations, live chat state, usage limits) are picked up within this window.
 */
export const WORKSPACE_WATCHER_VIEW_CACHE_TTL_MS = 2000;
const VIEW_CACHE_MAX_ENTRIES = 32;

/** @type {Map<string, { key: string, at: number, view: Record<string, any> }>} */
const viewCache = new Map();

/** Drop cached views (all, or one workspace) after a known mutation. */
export function invalidateWorkspaceWatcherViewCache(dataDir, workspaceFolder) {
  if (dataDir === undefined) {
    viewCache.clear();
    return;
  }
  viewCache.delete(`${dataDir}\u0000${String(workspaceFolder ?? '').trim()}`);
}

/**
 * Cheap revision of the committed todos document, asked from the store (no
 * parse, no knowledge of the backing file).
 *
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @returns {Promise<string>}
 */
async function todosRevisionKey(dataDir, workspaceFolder) {
  try {
    return (await getTodosRevision(dataDir, workspaceFolder)) || 'none';
  } catch {
    return 'none';
  }
}

/**
 * Cached read of the watcher view: the heavy snapshot/decision/schedule work is
 * redone only when the watcher row (incl. active cycles) or the todos document
 * changed, or when the safety TTL elapsed. Callers get an isolated copy.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, now?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function getWorkspaceWatcherView(input = {}) {
  // An explicit clock is a deterministic (test) request: never serve cached data.
  if (Number.isFinite(input.now)) return computeWorkspaceWatcherView(input);
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const key = `${row ? JSON.stringify(row) : 'norow'}|${await todosRevisionKey(dataDir, workspaceFolder)}`;
  const cacheId = `${dataDir}\u0000${workspaceFolder}`;
  const nowMs = Date.now();
  const hit = viewCache.get(cacheId);
  if (hit && hit.key === key && nowMs - hit.at < WORKSPACE_WATCHER_VIEW_CACHE_TTL_MS) {
    return structuredClone(hit.view);
  }
  const view = await computeWorkspaceWatcherView(input);
  if (!viewCache.has(cacheId) && viewCache.size >= VIEW_CACHE_MAX_ENTRIES) {
    viewCache.delete(viewCache.keys().next().value);
  }
  viewCache.set(cacheId, { key, at: nowMs, view });
  return structuredClone(view);
}

/**
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {Promise<Record<string, any>>}
 */
async function computeWorkspaceWatcherView(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir })
    || normalizeWorkspaceWatcherRow({ workspaceFolder });
  const usageLimits = safeUsageLimits(dataDir, workspaceFolder);
  const cycleChatIds = workspaceWatcherCycleChatIds(watcher);
  const closedCycleChatIds = workspaceWatcherClosedCycleChatIds(watcher);
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    excludeChatIds: cycleChatIds,
    excludeDelegationParentChatIds: cycleChatIds,
    closedCycleChatIds,
    scoutParentChatIds: workspaceWatcherScoutParentChatIds(watcher),
  });
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const doingStates = (Array.isArray(snapshot.doingStates) ? snapshot.doingStates : []).map((row) => {
    const item = items.find((todo) => String(todo?.id ?? '') === String(row?.todoId ?? '')) || null;
    return enrichWorkspaceTodoRecoveryView(row, item);
  });
  const cyclePools = partitionWorkspaceWatcherCyclesByPool({
    cycles: getWorkspaceWatcherActiveCycles(watcher),
    todos: workspaceWatcherPoolTodoIndex([items]),
    policy: watcher.policy,
  });
  const activeCycleCounts = { worktree: cyclePools.worktree.length, project: cyclePools.project.length };
  const decision = decideWorkspaceWatcherAction({ watcher, snapshot, activeCycleCounts, activeUsageLimits: usageLimits });
  const snapshotWithRecovery = { ...snapshot, doingStates };
  delete snapshotWithRecovery.items;
  return {
    workspaceFolder,
    watcher,
    snapshot: snapshotWithRecovery,
    guardrails: evaluateWorkspaceWatcherGuardrails({ watcher, pickedTodo: null, activeUsageLimits: usageLimits }),
    // Operator-facing cycle schedule (last run, next run, live blocker): the
    // same "when / when next" info Scout already exposes, for the watcher itself.
    schedule: computeWatcherSchedule({
      watcher,
      now: Number.isFinite(input.now) ? Number(input.now) : Date.now(),
      activeCycleCount: snapshot.activeAgentCount + activeCycleCounts.worktree + activeCycleCounts.project,
      worktreeRunning: snapshot.worktreeAgentCount + activeCycleCounts.worktree,
      projectRunning: snapshot.projectAgentCount + activeCycleCounts.project,
      decision,
      activeUsageLimits: usageLimits,
    }),
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

/** Newest decisions kept in the HTTP view; `/api/workspace-watcher/decisions` serves more. */
export const WORKSPACE_WATCHER_HTTP_DECISIONS_LIMIT = 100;

/**
 * Trim the decision log to a recent slice so the poll payload stays small.
 * `decisionsTotal` tells clients how many entries exist server-side.
 *
 * @param {Record<string, any>} view
 * @returns {Record<string, any>}
 */
function boundHttpWatcherDecisions(view) {
  const decisions = view?.watcher?.decisions;
  if (!Array.isArray(decisions) || decisions.length <= WORKSPACE_WATCHER_HTTP_DECISIONS_LIMIT) return view;
  return {
    ...view,
    watcher: {
      ...view.watcher,
      decisions: decisions.slice(-WORKSPACE_WATCHER_HTTP_DECISIONS_LIMIT),
      decisionsTotal: decisions.length,
    },
  };
}

/**
 * HTTP view for settings. Drops the full todo documents (`items`, `readyLeaves`)
 * that the tick and MCP still read from {@link getWorkspaceWatcherView}.
 * Counts and id lists stay.
 *
 * @param {Record<string, any>} view
 * @returns {Record<string, any>}
 */
export function toWorkspaceWatcherHttpView(view) {
  view = boundHttpWatcherDecisions(view);
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
 * @param {{ dataDir?: string, workspaceFolder?: string, patch?: Record<string, any> }} input
 * @returns {Record<string, any>}
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
  if (body.stopReason != null) {
    patch.stopReason = String(body.stopReason ?? '').trim().slice(0, WORKSPACE_WATCHER_MAX_STOP_REASON_LENGTH);
  }
  // Allow explicit reset of loop-guard state: pass `failures: {}` to clear all
  // failure counts, `backoffUntil: ''` to release the backoff timer,
  // `blockedBackoff` (the per-todo map) to release individual todos.
  if (body.failures != null && typeof body.failures === 'object') patch.failures = body.failures;
  if (body.blockedBackoff != null && typeof body.blockedBackoff === 'object') patch.blockedBackoff = body.blockedBackoff;
  if (body.backoffUntil != null) patch.backoffUntil = String(body.backoffUntil);
  if (body.policy && typeof body.policy === 'object') {
    // Enabling worktree mode backfills the layout from the workspace-derived
    // suggestion, so "just turn it on and save" works without typing paths.
    // `policy.executionMode` / `policy.worktree` are aliases for the separate
    // execution-settings store: they are written through there and no longer
    // stored on the watcher row.
    const { executionMode, worktree, ...watcherPolicy } = body.policy;
    const reviewGateError = validateReviewGatePolicyInput(watcherPolicy);
    if (reviewGateError) {
      const error = new Error(reviewGateError);
      error.code = 'VALIDATION';
      throw error;
    }
    if (watcherPolicy.phases !== undefined) {
      const phasesError = validatePhasesInput(watcherPolicy.phases);
      if (phasesError) {
        const error = new Error(phasesError);
        error.code = 'VALIDATION';
        throw error;
      }
      // Partial patches merge over the stored phases instead of resetting them.
      watcherPolicy.phases = { ...(existing.policy?.phases || {}), ...watcherPolicy.phases };
    }
    patch.policy = mergePolicy(existing.policy, watcherPolicy);
    if (executionMode !== undefined || (worktree && typeof worktree === 'object')) {
      const view = resolveExecutionSettingsView({ workspaceFolder, dataDir });
      // Effective legacy layout (non-empty strings only) so the proposal backfill
      // never overrides a legacy root/namespace/prefix that is still in force.
      const legacyWorktree = {};
      const legacySource = existing.policy?.worktree && typeof existing.policy.worktree === 'object' ? existing.policy.worktree : {};
      for (const key of WORKTREE_LAYOUT_KEYS) {
        if (typeof legacySource[key] === 'string' && legacySource[key].trim()) legacyWorktree[key] = legacySource[key].trim();
      }
      if (Array.isArray(legacySource.prepareCommand)) legacyWorktree.prepareCommand = legacySource.prepareCommand;
      const probe = {
        executionMode: executionMode !== undefined ? executionMode : view.effective.executionMode,
        worktree: { ...legacyWorktree, ...(view.saved?.worktree || {}), ...(worktree && typeof worktree === 'object' ? worktree : {}) },
      };
      const filled = applyWorktreeLayoutDefaults(probe, workspaceFolder);
      const execPatch = {};
      if (executionMode !== undefined) execPatch.executionMode = executionMode;
      // Only fields the caller sent or the backfill derived are persisted, so a
      // legacy value is never frozen into the new store by a mode-only patch.
      const wtPatch = { ...(worktree && typeof worktree === 'object' ? worktree : {}) };
      for (const key of WORKTREE_LAYOUT_KEYS) {
        if (wtPatch[key] === undefined && filled.worktree?.[key] && !view.saved?.worktree?.[key] && !legacyWorktree[key]) wtPatch[key] = filled.worktree[key];
      }
      if (Object.keys(wtPatch).length > 0) execPatch.worktree = wtPatch;
      saveExecutionSettings(workspaceFolder, execPatch, { dataDir });
    }
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
 * @returns {Promise<{ watcher: Record<string, any>, unblockedTodoIds: string[] }>}
 */
export async function clearWorkspaceWatcherLoopStop(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim() || resolveDataPath();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const existing = getWorkspaceWatcher(workspaceFolder, { dataDir });
  // Failure counts are the historical source of parked ids, but the findings
  // loop parks a todo WITHOUT touching `failures`. Scan the todos for the
  // watcher's own blocked marker too and union both sets, so a todo parked only
  // by the findings loop is unblocked as well.
  const candidateTodoIds = new Set(Object.keys(existing?.failures || {}));
  try {
    const doc = await listTodos(dataDir, workspaceFolder);
    for (const todo of Array.isArray(doc?.items) ? doc.items : []) {
      const todoId = String(todo?.id || '').trim();
      if (todoId && isWorkspaceWatcherBlockedReason(todo?.blockedReason)) {
        candidateTodoIds.add(todoId);
      }
    }
  } catch {
    // A read failure falls back to the failure-count ids only.
  }
  // Clear stopReason, all failure counts, and the backoff timer.
  const watcher = upsertWorkspaceWatcher(workspaceFolder, {
    stopReason: '',
    failures: {},
    blockedBackoff: {},
    backoffUntil: '',
  }, { dataDir });
  // Unblock any todos that were parked by the loop guard (a failure-ceiling or
  // findings-park blockedReason). We try best-effort: a CAS miss (the todo
  // moved on) is silently ignored.
  const unblockedTodoIds = [];
  for (const todoId of candidateTodoIds) {
    try {
      const doc = await listTodos(dataDir, workspaceFolder);
      const todo = (Array.isArray(doc?.items) ? doc.items : [])
        .find((row) => String(row?.id || '') === todoId);
      if (!todo) continue;
      const reason = String(todo.blockedReason || '').trim();
      if (!reason) continue;
      // The suppression flag is read synchronously by the legacy backend; the
      // await happens outside of it so no unrelated write inherits it.
      await withTodosWatcherNudgeSuppressed(() => updateTodo(dataDir, workspaceFolder, todoId, {
        status: todo.status,
        strictStatus: true,
        blockedReason: '',
        expectedUpdatedAt: todo.updatedAt,
      }));
      unblockedTodoIds.push(todoId);
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
 * @returns {{ workspaceFolder: string, chatId: string, chat: Record<string, any> | null }}
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
 * @returns {Record<string, any>}
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
 * Refused until boot reconciliation finished (leaf R8): a manual or MCP tick
 * must not reconcile claims or start a cycle ahead of the boot sequence.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string }} input
 * @returns {Promise<{ tick: Record<string, any>, started: Record<string, any> | null }>}
 */
export async function runWorkspaceWatcherTick(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const token = String(input.token ?? '').trim() || WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN;
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
  if (!isBootReconciliationComplete()) {
    return {
      tick: {
        wrote: false,
        skipped: true,
        at: new Date(now).toISOString(),
        decision: { kind: 'boot_not_ready', reason: 'boot_not_ready' },
      },
      started: { started: false, reason: 'boot_not_ready' },
    };
  }
  await reconcileWorkspaceWatcherCycle({ workspaceFolder, dataDir, now, deps });
  await releaseStaleWorkspaceTodoClaims({
    workspaceFolder,
    dataDir,
    probeChatRunLiveness: deps.probeChatRunLiveness,
  });
  const tick = await tickWorkspaceWatcher({
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
  const usageLimits = safeUsageLimits(dataDir, workspaceFolder);
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
  const activeCycles = getWorkspaceWatcherActiveCycles(watcher);
  if (evaluateWorkspaceWatcherSafetyValve({
    count: activeCycles.length + Math.max(0, Number(tick.snapshot?.activeAgentCount) || 0),
    maxParallel: Math.max(1, Number(watcher.policy?.maxParallel) || 1),
  }).reached) {
    return { tick, started: { started: false, reason: 'cycle_active' } };
  }
  // The pool ceiling of the todo this start would claim, counted against the
  // same pool's live cycles. Mirrors the two checks inside
  // `startWorkspaceWatcherCycle`; the tick's own decision already stepped over a
  // saturated pool, so this only catches a cycle that appeared after the tick.
  const poolTodos = workspaceWatcherPoolTodoIndex([tick.snapshot?.items, tick.snapshot?.readyLeaves]);
  if (workspaceWatcherStartPoolGate({
    todoId: String(tick.decision?.nextTodoId || ''),
    cycles: activeCycles,
    todos: poolTodos,
    policy: watcher.policy,
    snapshot: tick.snapshot,
  }).full) {
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
 * @returns {Promise<Record<string, any>>}
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
 * @returns {Promise<{ ok: true, claimedByChatId: string } | { ok: false, reason: 'no_claimer' | 'claim_owner_forbidden' }>}
 */
export async function resolveWatcherClaimOwner(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const sourceChatId = String(input.sourceChatId ?? '').trim();
  const requestedClaimChatId = String(input.requestedClaimChatId ?? '').trim();
  const claimedByChatId = requestedClaimChatId || sourceChatId;
  if (!claimedByChatId) {
    return { ok: false, reason: 'no_claimer' };
  }
  if (requestedClaimChatId && sourceChatId && requestedClaimChatId !== sourceChatId) {
    const view = await getWorkspaceWatcherView({ dataDir, workspaceFolder });
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
 * @param {{ dataDir?: string, workspaceFolder?: string, claimedByChatId?: string, maxFailures?: number, ttlMs?: number }} input
 * @returns {Promise<Record<string, any>>}
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
 * Manual or MCP per-todo recovery (shared with autopilot reconcile).
 *
 * @param {{
 *   dataDir?: string,
 *   workspaceFolder?: string,
 *   todoId?: string,
 *   expectedUpdatedAt?: string,
 *   idempotencyKey?: string,
 * }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function recoverWorkspaceWatcherTodoForOperator(input = {}) {
  const result = await recoverWorkspaceWatcherTodo({
    dataDir: String(input.dataDir ?? '').trim(),
    workspaceFolder: String(input.workspaceFolder ?? '').trim(),
    todoId: input.todoId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    idempotencyKey: input.idempotencyKey,
    source: 'manual',
  });
  const view = result.ok || result.outcome === 'already-active' || result.outcome === 'conflict'
    ? await getWorkspaceWatcherView({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder })
    : null;
  return { ...result, view: view ? toWorkspaceWatcherHttpView(view) : null };
}

/**
 * Operator-confirmed release for stuck `unknown` `doing` leaves (REST/MCP/UI).
 *
 * @param {{
 *   dataDir?: string,
 *   workspaceFolder?: string,
 *   todoId?: string,
 *   expectedUpdatedAt?: string,
 *   confirmUnknownRelease?: boolean,
 *   confirm?: boolean,
 *   operatorMessage?: string,
 *   message?: string,
 *   idempotencyKey?: string,
 * }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function releaseDoingWorkspaceWatcherTodoForOperator(input = {}) {
  const result = await releaseDoingWorkspaceWatcherTodo({
    dataDir: String(input.dataDir ?? '').trim(),
    workspaceFolder: String(input.workspaceFolder ?? '').trim(),
    todoId: input.todoId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    confirmUnknownRelease: input.confirmUnknownRelease === true || input.confirm === true,
    operatorMessage: input.operatorMessage ?? input.message,
    idempotencyKey: input.idempotencyKey,
    source: 'manual',
  });
  const view = result.ok || result.outcome === 'already-active' || result.outcome === 'conflict'
    ? await getWorkspaceWatcherView({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder })
    : null;
  return { ...result, view: view ? toWorkspaceWatcherHttpView(view) : null };
}

/**
 * @param {{ dataDir?: string, workspaceFolder?: string, todoId?: string }} input
 * @returns {{ changed: boolean, watcher: Record<string, any> }}
 */
export function resetWorkspaceWatcherPlanRequests(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const todoId = String(input.todoId ?? '').trim();
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    if (!todoId) return { planRequests: {} };
    const planRequests = { ...row.planRequests };
    delete planRequests[todoId];
    // Also forget the plan-review round marker so a new round can be requested.
    delete planRequests[`${todoId}#plan-review`];
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
 * @returns {{ changed: boolean, findings: Record<string, any> | null }}
 */
/**
 * @param {{ dataDir?: string, workspaceFolder?: string, todoId?: string, expectedUpdatedAt?: string, planMarkdown?: string, sourceChatId?: string }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function saveWorkspaceWatcherTodoPlanDraft(input = {}) {
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
  const doc = await updateTodo(dataDir, workspaceFolder, todoId, {
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
 *   outcome?: string, todoIds?: string[], cycleId?: string, reportId?: string, reasonCode?: string, reasonDate?: string,
 *   options?: Record<string, any>[], recommended?: string, why?: string,
 *   message?: string, now?: number,
 * }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function reportWorkspaceWatcherCycle(input = {}) {
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
    reasonCode: input.reasonCode,
    reasonDate: input.reasonDate,
    options: input.options, recommended: input.recommended, why: input.why,
  });
}

/**
 * Scout proposals: list / accept / reject / submit. This is the shared control
 * surface for the REST route, the in-process MCP client and the remote client.
 *
 * @param {Record<string, any>} [input]
 * @returns {Promise<Record<string, any>>}
 */
export async function runWorkspaceWatcherScoutFindings(input = {}) {
  return await runWorkspaceWatcherScoutAction(input);
}

/**
 * Run one Scout scan now for one workspace (manual trigger). It bypasses the
 * schedule only in the sense that it is explicit; it still respects the mode,
 * quiet hours and the per-day scan budget.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, now?: number, scoutId?: string }} [input]
 * @returns {Promise<Record<string, any>>}
 */
export async function runWorkspaceWatcherScoutNow(input = {}) {
  return runWorkspaceWatcherScout({
    dataDir: String(input.dataDir ?? '').trim(),
    workspaceFolder: String(input.workspaceFolder ?? '').trim(),
    now: Number.isFinite(input.now) ? Number(input.now) : undefined,
    scoutId: String(input.scoutId ?? '').trim() || undefined,
    deps: input.deps && typeof input.deps === 'object' ? input.deps : undefined,
    bypassInterval: true,
  });
}

/* -------------------------------------------------------------------------- */
/* Scout profile configuration surface (stage 4a)                             */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} message
 * @returns {Error}
 */
function scoutControlValidationError(message) {
  const error = new Error(message);
  error.code = 'VALIDATION';
  return error;
}

/**
 * @param {string} message
 * @returns {Error}
 */
function scoutControlNotFoundError(message) {
  const error = new Error(message);
  error.code = 'NOT_FOUND';
  return error;
}

/**
 * @param {string} message
 * @returns {Error}
 */
function scoutControlConflictError(message) {
  const error = new Error(message);
  error.code = 'CONFLICT';
  return error;
}

/**
 * @param {unknown} workspaceFolder
 * @returns {string}
 */
function requireScoutWorkspaceFolder(workspaceFolder) {
  const folder = String(workspaceFolder ?? '').trim();
  if (!folder) throw scoutControlValidationError('workspaceFolder is required');
  return folder;
}

/**
 * Map a persist write failure onto a stable control-layer error code. The
 * server-owned profile revision CAS is the only expected conflict; every other
 * rejection (invalid payload, profile ceiling) is a validation error.
 *
 * @param {{ reason?: string, errors?: string[] }} result
 * @returns {never}
 */
function throwScoutProfileWriteFailure(result) {
  const reason = String(result?.reason || '');
  const detail = Array.isArray(result?.errors) ? result.errors.filter(Boolean).join('; ') : '';
  const message = detail || reason || 'scout profile write failed';
  if (reason === 'revision_conflict' || reason === 'cas_conflict') {
    throw scoutControlConflictError(message);
  }
  throw scoutControlValidationError(message);
}

/**
 * @param {Record<string, any>} entry normalized `scoutScanHistory` record
 * @returns {Record<string, any>} public history entry (whitelisted fields, no secrets)
 */
function toPublicScoutHistoryEntry(entry) {
  return {
    scanId: entry.scanId,
    scoutId: entry.scoutId,
    scoutRevision: entry.scoutRevision,
    status: entry.status,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    executor: { harness: entry.executor?.harness || '', model: entry.executor?.model || '' },
    added: entry.added,
    merged: entry.merged,
    dropped: entry.dropped,
    reasons: Array.isArray(entry.reasons) ? [...entry.reasons] : [],
    error: entry.error,
    chatId: entry.chatId,
    runId: entry.runId,
    usage: entry.usage,
  };
}

/**
 * @param {Record<string, any>} entry
 * @returns {number}
 */
function scoutHistorySortKey(entry) {
  const parsed = Date.parse(String(entry?.startedAt || entry?.finishedAt || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A pending proposal belongs to a profile when any server-owned attribution
 * entry names it. Mirrors the `scoutId` filter of `listScoutFindings` so the
 * per-profile count and the findings inbox can never disagree.
 *
 * @param {Record<string, any>} finding
 * @param {string} scoutId
 * @returns {boolean}
 */
function scoutFindingMatchesProfile(finding, scoutId) {
  if (String(finding?.scoutId ?? '').trim() === scoutId) return true;
  const sources = Array.isArray(finding?.sources) ? finding.sources : [];
  return sources.some((source) => String(source?.scoutId ?? '').trim() === scoutId);
}

/**
 * Additive runtime state of one Scout profile (stage 5.1). It is computed from
 * the same helpers the scheduler uses, so the list badge, the per-profile
 * budget and the "Run now" gate cannot drift from the real runner:
 * `resolveScoutScheduleState` for the last/next run and the UTC-day counter,
 * `computeScoutProfileNextRunAt` for the next automatic instant, and a
 * `bypassInterval` (manual) `decideScoutRun` for the reason a click on "Run now"
 * would be refused. `state` never replaces the stored profile fields.
 *
 * @param {Record<string, any> | null | undefined} row watcher row (may be null on a fresh workspace)
 * @param {Record<string, any>} profile normalized Scout profile
 * @param {number} now epoch ms
 * @returns {{
 *   lastRunAt: string, nextRunAt: string, usedToday: number, maxPerDay: number,
 *   remainingToday: number, pendingFindings: number, running: number,
 *   blockedReason: string, archived: boolean,
 * }}
 */
function buildWorkspaceScoutProfileState(row, profile, now) {
  const scoutId = String(profile?.id ?? '').trim();
  const profileState = resolveScoutScheduleState(row, scoutId);
  const day = workspaceWatcherUtcDayKey(now);
  const usedToday = String(profileState.day ?? '').trim() === day
    ? Math.max(0, Math.floor(Number(profileState.count) || 0))
    : 0;
  const maxPerDay = Math.max(0, Math.floor(Number(profile?.limits?.maxPerDay) || 0));
  const nextRunMs = computeScoutProfileNextRunAt({ profile, profileState, now });
  const instanceId = getServerInstanceId();
  const running = getActiveScoutScans(row)
    .filter((scan) => String(scan?.scoutId ?? '').trim() === scoutId
      && isScoutScanOccupied(scan, now, instanceId))
    .length;
  const pendingFindings = (Array.isArray(row?.pendingScoutFindings) ? row.pendingScoutFindings : [])
    .filter((finding) => String(finding?.status ?? '') === 'pending'
      && scoutFindingMatchesProfile(finding, scoutId))
    .length;
  // The manual decision bypasses the interval on purpose: the operator still
  // needs to see whether the profile, its budget or a global gate refuses.
  const decision = decideScoutRun({
    watcher: row,
    profile,
    profileState,
    now,
    scoutAgentCount: countOccupiedScoutScans(row, now, instanceId),
    bypassInterval: true,
  });
  // `decideScoutRun` covers the global gates, but a second start of the same
  // profile is refused later by the scan reservation (`profile_scan_active`).
  // Surface that here too, so a row with `running > 0` explains why "Run now"
  // would not start instead of showing an empty reason.
  const blockedReason = decision.allowed
    ? (running > 0 ? 'profile_scan_active' : '')
    : String(decision.reason ?? '').trim();
  return {
    lastRunAt: String(profileState.lastRunAt ?? '').trim(),
    nextRunAt: nextRunMs > 0 ? new Date(nextRunMs).toISOString() : '',
    usedToday,
    maxPerDay,
    remainingToday: Math.max(0, maxPerDay - usedToday),
    pendingFindings,
    running,
    blockedReason,
    archived: Boolean(String(profile?.archivedAt ?? '').trim()),
  };
}

/**
 * Attach the additive `state` to one profile without mutating the stored shape.
 *
 * @param {Record<string, any> | null | undefined} row
 * @param {Record<string, any>} profile
 * @param {number} now
 * @returns {Record<string, any>}
 */
function withWorkspaceScoutProfileState(row, profile, now) {
  return { ...profile, state: buildWorkspaceScoutProfileState(row, profile, now) };
}

/**
 * List the Scout profiles of one workspace. A workspace with no stored profile
 * reads the deterministic virtual general profile without writing a row. Every
 * returned profile carries the additive runtime `state` (stage 5.1).
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, now?: number }} input
 * @returns {{ workspaceFolder: string, profiles: Record<string, any>[] }}
 */
export function listWorkspaceWatcherScoutProfiles(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const profiles = listWorkspaceScoutProfiles(workspaceFolder, { dataDir })
    .map((profile) => withWorkspaceScoutProfileState(row, profile, now));
  return { workspaceFolder, profiles };
}

/**
 * Read one Scout profile by id. Throws a NOT_FOUND-coded error when absent, so
 * REST and MCP can answer 404 / NOT_FOUND without a second lookup. The result
 * carries the additive runtime `state`.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, scoutId?: string, now?: number }} input
 * @returns {{ workspaceFolder: string, profile: Record<string, any> }}
 */
export function getWorkspaceWatcherScoutProfile(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const scoutId = String(input.scoutId ?? '').trim();
  if (!scoutId) throw scoutControlValidationError('scoutId is required');
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const profile = getWorkspaceScoutProfile(workspaceFolder, scoutId, { dataDir });
  if (!profile) throw scoutControlNotFoundError(`scout profile not found: ${scoutId}`);
  const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  return { workspaceFolder, profile: withWorkspaceScoutProfileState(row, profile, now) };
}

/**
 * Create a Scout profile. The payload never sets `revision`/timestamps, and a
 * fresh id is minted unless the caller supplied one.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, profile?: Record<string, any> }} input
 * @returns {{ workspaceFolder: string, profile: Record<string, any> }}
 */
export function createWorkspaceWatcherScoutProfile(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const profile = input.profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw scoutControlValidationError('profile is required');
  }
  const result = upsertWorkspaceScoutProfile(workspaceFolder, profile, { dataDir });
  if (!result.ok) throwScoutProfileWriteFailure(result);
  return { workspaceFolder, profile: result.profile };
}

/**
 * Update a Scout profile under the revision CAS. A stale `expectedRevision`
 * throws CONFLICT and changes nothing.
 *
 * @param {{
 *   dataDir?: string, workspaceFolder?: string, scoutId?: string,
 *   profile?: Record<string, any>, expectedRevision?: number,
 * }} input
 * @returns {{ workspaceFolder: string, profile: Record<string, any> }}
 */
export function updateWorkspaceWatcherScoutProfile(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const scoutId = String(input.scoutId ?? '').trim();
  if (!scoutId) throw scoutControlValidationError('scoutId is required');
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw scoutControlValidationError('expectedRevision must be a positive integer');
  }
  const profile = input.profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw scoutControlValidationError('profile is required');
  }
  const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const storedProfiles = Array.isArray(row?.scoutProfiles) ? row.scoutProfiles : [];
  const isStored = storedProfiles.some((candidate) => candidate.id === scoutId);
  if (!isStored) {
    if (scoutId !== SCOUT_GENERAL_PROFILE_ID) {
      throw scoutControlNotFoundError(`scout profile not found: ${scoutId}`);
    }
    const virtual = defaultWorkspaceScoutProfile();
    if (expectedRevision !== virtual.revision) {
      throw scoutControlConflictError(
        `oczekiwano revision ${virtual.revision}, otrzymano ${expectedRevision}`,
      );
    }
    const result = upsertWorkspaceScoutProfile(
      workspaceFolder,
      { ...virtual, ...profile, id: scoutId },
      { dataDir, expectedRevision, materializeVirtual: true },
    );
    if (!result.ok) throwScoutProfileWriteFailure(result);
    return { workspaceFolder, profile: result.profile };
  }
  const result = upsertWorkspaceScoutProfile(
    workspaceFolder,
    { ...profile, id: scoutId },
    { dataDir, expectedRevision },
  );
  if (!result.ok) throwScoutProfileWriteFailure(result);
  return { workspaceFolder, profile: result.profile };
}

/**
 * Duplicate a Scout profile: a fresh id, revision 1 and a name suffixed with
 * " (kopia)" that is truncated to stay within the stored name limit. The source
 * profile is left untouched.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, scoutId?: string }} input
 * @returns {{ workspaceFolder: string, sourceId: string, profile: Record<string, any> }}
 */
export function duplicateWorkspaceWatcherScoutProfile(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const scoutId = String(input.scoutId ?? '').trim();
  if (!scoutId) throw scoutControlValidationError('scoutId is required');
  const source = getWorkspaceScoutProfile(workspaceFolder, scoutId, { dataDir });
  if (!source) throw scoutControlNotFoundError(`scout profile not found: ${scoutId}`);
  const suffix = ' (kopia)';
  const baseName = String(source.name || '').trim() || 'Scout';
  const name = `${baseName.slice(0, Math.max(0, WORKSPACE_SCOUT_PROFILE_MAX_NAME_LENGTH - suffix.length))}${suffix}`;
  // The server owns id/revision/timestamps, so a copy only carries the
  // user-editable configuration.
  const copy = { ...source, name };
  delete copy.id;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  const result = upsertWorkspaceScoutProfile(workspaceFolder, copy, { dataDir });
  if (!result.ok) throwScoutProfileWriteFailure(result);
  return { workspaceFolder, sourceId: source.id, profile: result.profile };
}

/**
 * Archive a Scout profile by stamping `archivedAt`; the row stays readable and
 * `get`/`list` keep returning it.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, scoutId?: string, now?: number }} input
 * @returns {{ workspaceFolder: string, profile: Record<string, any> }}
 */
export function archiveWorkspaceWatcherScoutProfile(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const scoutId = String(input.scoutId ?? '').trim();
  if (!scoutId) throw scoutControlValidationError('scoutId is required');
  const existing = getWorkspaceScoutProfile(workspaceFolder, scoutId, { dataDir });
  if (!existing) throw scoutControlNotFoundError(`scout profile not found: ${scoutId}`);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const result = upsertWorkspaceScoutProfile(
    workspaceFolder,
    { ...existing, id: scoutId, archivedAt: new Date(now).toISOString() },
    { dataDir, expectedRevision: existing.revision },
  );
  if (!result.ok) throwScoutProfileWriteFailure(result);
  return { workspaceFolder, profile: result.profile };
}

/**
 * Preview the effective config, prompt and matched files of a profile without
 * starting a model (`modelStarted: false`).
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, scoutId?: string, now?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function previewWorkspaceWatcherScoutProfile(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const scoutId = String(input.scoutId ?? '').trim();
  if (!scoutId) throw scoutControlValidationError('scoutId is required');
  const profile = getWorkspaceScoutProfile(workspaceFolder, scoutId, { dataDir });
  if (!profile) throw scoutControlNotFoundError(`scout profile not found: ${scoutId}`);
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const policy = watcher?.policy || {};
  // Same precedence the runner uses: a non-empty Scout allow-list wins over the
  // historical `allowedHarnesses`, which is only a fallback.
  const allowedHarnesses = Array.isArray(policy.scoutAllowedHarnesses) && policy.scoutAllowedHarnesses.length
    ? policy.scoutAllowedHarnesses
    : (Array.isArray(policy.allowedHarnesses) ? policy.allowedHarnesses : []);
  return {
    workspaceFolder,
    profile,
    ...await buildScoutPreview(profile, {
      workspaceFolder,
      dataDir,
      watcher,
      allowedHarnesses,
      now: Number.isFinite(input.now) ? Number(input.now) : undefined,
    }),
  };
}

/**
 * Read the bounded per-profile scan history. Newest first, filtered by
 * `scoutId` when given. `submitToken` and any other credential are never
 * returned: every entry is rebuilt from a whitelist.
 *
 * `total` is the filtered count BEFORE the `max` cap, so a UI page that fills
 * `max` can say "showing N of M" instead of implying the scan log ended there.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, scoutId?: string, max?: number }} input
 * @returns {{ workspaceFolder: string, scoutId: string, history: Record<string, any>[], total: number }}
 */
export function getWorkspaceWatcherScoutHistory(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const scoutId = String(input.scoutId ?? '').trim();
  const maxRaw = Number(input.max);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 100;
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const entries = normalizeWorkspaceScoutScanHistory(watcher?.scoutScanHistory);
  const filtered = scoutId ? entries.filter((entry) => entry.scoutId === scoutId) : entries;
  const sorted = [...filtered]
    .sort((left, right) => scoutHistorySortKey(right) - scoutHistorySortKey(left));
  const history = sorted.slice(0, max).map(toPublicScoutHistoryEntry);
  return { workspaceFolder, scoutId, history, total: sorted.length };
}

/* -------------------------------------------------------------------------- */
/* Scout templates + draft preview + restore (stage 5.2)                      */
/* -------------------------------------------------------------------------- */

/**
 * Effective allowed harnesses for a workspace: a non-empty Scout allow-list wins
 * over the historical general `allowedHarnesses`, which is only a fallback. Kept
 * identical to `previewWorkspaceWatcherScoutProfile` so the saved-profile preview
 * and the draft preview cannot disagree.
 *
 * @param {Record<string, any> | null | undefined} watcher
 * @returns {string[]}
 */
function resolveScoutAllowedHarnesses(watcher) {
  const policy = watcher?.policy || {};
  if (Array.isArray(policy.scoutAllowedHarnesses) && policy.scoutAllowedHarnesses.length) {
    return policy.scoutAllowedHarnesses;
  }
  return Array.isArray(policy.allowedHarnesses) ? policy.allowedHarnesses : [];
}

/**
 * The versioned built-in Scout template catalog as deep copies. Templates are
 * workspace-independent; the folder is returned only for surface parity.
 *
 * @param {{ workspaceFolder?: string }} [input]
 * @returns {{ workspaceFolder: string, templates: Record<string, any>[] }}
 */
export function listWorkspaceWatcherScoutTemplates(input = {}) {
  return {
    workspaceFolder: String(input.workspaceFolder ?? '').trim(),
    templates: listScoutTemplates(),
  };
}

/**
 * Create a new Scout profile from one template. The materialized profile is a
 * deep copy (never a catalog reference), and the product invariant is enforced
 * even if a caller smuggled automation into `overrides`: `enabled` stays false
 * and the schedule stays manual.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, templateId?: string, overrides?: Record<string, any> }} input
 * @returns {{ workspaceFolder: string, profile: Record<string, any>, templateId: string, templateVersion: string }}
 */
export function createWorkspaceWatcherScoutProfileFromTemplate(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const templateId = String(input.templateId ?? '').trim();
  if (!templateId) throw scoutControlValidationError('templateId is required');
  const overrides = input.overrides && typeof input.overrides === 'object' && !Array.isArray(input.overrides)
    ? input.overrides
    : {};
  const materialized = materializeProfileFromTemplate(templateId, overrides);
  if (!materialized) throw scoutControlValidationError(`unknown scout template: ${templateId}`);
  materialized.enabled = false;
  materialized.schedule = { ...materialized.schedule, mode: 'manual' };
  const result = upsertWorkspaceScoutProfile(workspaceFolder, materialized, { dataDir });
  if (!result.ok) throwScoutProfileWriteFailure(result);
  return {
    workspaceFolder,
    profile: result.profile,
    templateId: String(result.profile?.templateId || templateId),
    templateVersion: String(result.profile?.templateVersion || materialized.templateVersion || ''),
  };
}

/**
 * Preview a DRAFT profile from the editor: effective config, prompt, matched
 * files and blockers, WITHOUT persisting the profile, reserving a scan slot or
 * starting a model (`modelStarted: false`).
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, profile?: Record<string, any>, now?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function previewWorkspaceWatcherScoutProfileDraft(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const profile = input.profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw scoutControlValidationError('profile is required');
  }
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  return {
    workspaceFolder,
    ...await buildScoutPreview(profile, {
      workspaceFolder,
      dataDir,
      watcher,
      allowedHarnesses: resolveScoutAllowedHarnesses(watcher),
      now: Number.isFinite(input.now) ? Number(input.now) : undefined,
    }),
  };
}

/**
 * Compute the task-definition diff between a stored profile and its template
 * WITHOUT writing anything. A profile without a template (or an unknown
 * `templateId`) is a readable validation error.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, scoutId?: string, templateId?: string }} input
 * @returns {{ workspaceFolder: string, scoutId: string, profile: Record<string, any>, diff: Record<string, any>[], templateId: string, templateVersion: string }}
 */
export function previewWorkspaceWatcherScoutRestoreDiff(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const scoutId = String(input.scoutId ?? '').trim();
  if (!scoutId) throw scoutControlValidationError('scoutId is required');
  const profile = getWorkspaceScoutProfile(workspaceFolder, scoutId, { dataDir });
  if (!profile) throw scoutControlNotFoundError(`scout profile not found: ${scoutId}`);
  const templateId = String(input.templateId ?? '').trim() || undefined;
  const restored = restoreProfileInstructionsFromTemplate(profile, { templateId, preview: true });
  if (!restored.ok) {
    throw scoutControlValidationError(`unknown scout template: ${restored.templateId || templateId || ''}`);
  }
  return {
    workspaceFolder,
    scoutId,
    profile,
    diff: restored.diff,
    templateId: restored.templateId,
    templateVersion: restored.templateVersion,
  };
}

/**
 * Apply a template restore under the existing revision CAS. `confirm: true` and
 * a positive `expectedRevision` are mandatory; a stale revision throws CONFLICT
 * and changes nothing. The applied diff is returned so the UI can report it.
 *
 * @param {{
 *   dataDir?: string, workspaceFolder?: string, scoutId?: string,
 *   expectedRevision?: number, confirm?: boolean, templateId?: string,
 * }} input
 * @returns {{ workspaceFolder: string, profile: Record<string, any>, diff: Record<string, any>[], templateId: string, templateVersion: string }}
 */
export function restoreWorkspaceWatcherScoutProfileFromTemplate(input = {}) {
  const dataDir = String(input.dataDir ?? '').trim();
  const workspaceFolder = requireScoutWorkspaceFolder(input.workspaceFolder);
  const scoutId = String(input.scoutId ?? '').trim();
  if (!scoutId) throw scoutControlValidationError('scoutId is required');
  if (input.confirm !== true) {
    throw scoutControlValidationError('confirm: true is required to restore a profile from a template');
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw scoutControlValidationError('expectedRevision must be a positive integer');
  }
  const existing = getWorkspaceScoutProfile(workspaceFolder, scoutId, { dataDir });
  if (!existing) throw scoutControlNotFoundError(`scout profile not found: ${scoutId}`);
  const templateId = String(input.templateId ?? '').trim() || undefined;
  const restored = restoreProfileInstructionsFromTemplate(existing, { templateId, preview: true });
  if (!restored.ok) {
    throw scoutControlValidationError(`unknown scout template: ${restored.templateId || templateId || ''}`);
  }
  const result = upsertWorkspaceScoutProfile(
    workspaceFolder,
    { ...restored.profile, id: scoutId },
    { dataDir, expectedRevision },
  );
  if (!result.ok) throwScoutProfileWriteFailure(result);
  return {
    workspaceFolder,
    profile: result.profile,
    diff: restored.diff,
    templateId: restored.templateId,
    templateVersion: restored.templateVersion,
  };
}
