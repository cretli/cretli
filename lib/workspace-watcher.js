/**
 * Workspace Watcher — deterministic snapshots, decisions and lease-owned ticks.
 *
 * One watcher row per workspace. The service:
 *   1. `snapshotWorkspaceWatcher` collects todo readiness and chat/delegation occupancy,
 *   2. `decideWorkspaceWatcherAction` is a pure decision over that snapshot,
 *   3. `tickWorkspaceWatcher` acquires the lease, snapshots, decides and
 *      writes the decision log,
 *   4. `runWorkspaceWatcherHeartbeat` runs the tick for every `observe` row.
 *
 * `off` does nothing, `observe` records and notifies, and autopilot starts
 * are handled separately by workspace-watcher-cycle.js. Events are debounced;
 * lib/delegation-runtime-worker.js provides the heartbeat safety net.
 */

import { computeTodoReviewSnapshotFromRows as computeTodoReviewSnapshotForTodo } from './todo-review-sync.js';
import { filterTodosByEnabledPhases } from './watcher-phases.js';
import {
  countRunningLeavesByTree,
  evaluateWorkspaceWatcherSafetyValve,
  explainWorkspaceWatcherRejections,
  pickDominantRejection,
  rankWorkspaceWatcherCandidates,
} from './workspace-watcher-scheduler.js';
import {
  collectWorkspaceWatcherExternalOwners,
  findWorkspaceWatcherExternalTreeOwner,
} from './workspace-watcher-tree-owner.js';
import { delegationController } from './delegation-control.js';
import { randomUUID } from 'node:crypto';
import { getProcessInstance } from './recovery/recovery-shutdown.ts';
import {
  hasWorkspaceWatcherLeafRestartEvidence,
  isWorkspaceWatcherCycleRestartInterrupted,
} from './workspace-watcher-restart-evidence.js';
import { resolveDataPath } from './runtime-paths.js';
import { listDelegationsForWorkspace, loadDelegationsReadonly } from './persist/delegations-persist.js';
import { withTodosWatcherNudgeSuppressed } from './persist/todos-persist.js';
import { listTodos, updateTodo } from './persist/todos-store.js';
import { loadChats } from './persist/chats-persist.js';
import { listReadyTodoLeaves, isTodoBranchBlocked } from './todo-tree.js';
import { buildLiveWorktreePredicate, buildWorktreeRecordReader } from './todo-worktree-manual.js';
import { isTodoAwaitingIntegration } from './todo-integration-state.js';
import { isActiveDelegationStatus, isDelegationSlotOccupied } from './delegation-status.js';
import { logDelegationEvent } from './delegation-log.js';
import { pruneWorktreeResults } from './worktree-tree-leaf.js';
import { normalizeDelegationWorkspaceKey } from './delegation-workspace-guard.js';
import { getChatRunState, lookupChatRunRequest, probeChatRunLiveness } from './chat-run-service.js';
import { listHarnessUsageLimits, listHarnessUsageLimitsForWorkspace } from './harness-usage-limits.js';
import { getServerCodeFreshnessDetail } from './server-code-freshness-worker.js';
import { broadcastPush, hasPushSubscriptions, isPushAvailable } from './push.js';
import { broadcastWorkspaceWatcherChanged } from './workspace-watcher-live.js';
import {
  appendWorkspaceWatcherNotice,
  ensurePinnedChat,
} from './workspace-watcher-pinned-chat.js';
import {
  WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS,
  WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES,
  WORKSPACE_WATCHER_NOTIFY_CHANNELS,
  WORKSPACE_WATCHER_MAX_DECISIONS,
  WORKSPACE_WATCHER_TICK_MODES,
  acquireWorkspaceWatcherLease,
  getActiveScoutScans,
  getWorkspaceWatcher,
  getWorkspaceWatcherActiveCycles,
  loadWorkspaceWatchers,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceFolder,
  withWorkspaceWatchersFileLock,
  workspaceWatcherClosedCycleChatIds,
  workspaceWatcherCycleChatIds,
} from './persist/workspace-watchers-persist.js';
import {
  evaluateWorkspaceWatcherGuardrails,
  evaluateWorkspaceWatcherLoop,
  isWorkspaceWatcherTodoInBlockedBackoff,
  readWorkspaceWatcherTodoFindings,
  WORKSPACE_WATCHER_DEAD_CONTAINER,
  findWorkspaceWatcherDeadContainers,
  deadContainerSignature,
  planDeadContainerAutoReady,
} from './workspace-watcher-guardrails.js';
import { WORKSPACE_WATCHER_PARKED_REASON } from './workspace-watcher-blocked-reason.js';
import {
  buildWorkspaceWatcherCycleClosePatch,
  buildWorkspaceWatcherCycleMetricCloseInput,
  hasActiveWorkspaceWatcherCycleChildren,
  isReportedBlockedCycle,
  loadPrimaryTodoForWorkspaceWatcherCycle,
  reconcileWorkspaceWatcherReviewWaits,
  recordReviewGateWarning,
  releaseWorkspaceWatcherCycleTodoClaim,
  resolveDeferredWorkspaceWatcherReports,
  resolveReportedTodoIdsForCycle,
  resolveWorkspaceWatcherCycleBlockedReasonCode,
  resolveWorkspaceWatcherCycleCloseOutcome,
  resolveWorkspaceWatcherCycleReviewGate,
  resolveWorkspaceWatcherCycleTodoOutcomesForClose,
} from './workspace-watcher-cycle-close.js';
import { getWorktreeIntegrationRecord } from './workspace-watcher-integration.js';
import { isWorktreeRecordLive } from './worktree/worktree-record-live.ts';
import { finalizeWorkspaceWatcherCycleMetric, finalizeDueWorkspaceWatcherCycleUsage, finalizeDueWorkspaceWatcherCycleUsageChunked } from './workspace-watcher-cycle-metrics.js';
import { archiveIdleScoutChats, expireStaleActiveScoutScan, reconcileScoutScans } from './workspace-watcher-scout.js';
import { archiveChatFamily } from './chat-archive-policy.js';
import { sweepClosedWorkspaceWatcherCycles } from './workspace-watcher-archive-sweep.js';
import { readMcpOrchestratorRunErrorCode } from './mcp/mcp-orchestrator-contract.js';
import { recordJobTiming, timeJobAsync } from './periodic-job-runner.js';
import {
  WORKSPACE_TODO_EXECUTION_SOURCES,
  classifyWorkspaceDoingTodos,
  summarizeWorkspaceTodoRecovery,
} from './workspace-watcher-recovery.js';
import {
  observeWorkspaceTodoUnknownEscalations,
  recoverWorkspaceWatcherTodo,
} from './workspace-watcher-todo-recover.js';
import {
  normalizeWorkspaceWatcherPool,
  partitionWorkspaceWatcherCyclesByPool,
  isWorkspaceWatcherLeafBehindWorktreeAncestor,
  workspaceWatcherPoolLimit,
  workspaceWatcherPoolWaitReason,
  workspaceWatcherPoolTodoIndex,
  workspaceWatcherTodoIdPool,
  workspaceWatcherTodoPool,
} from './workspace-watcher-pool.js';

export const WORKSPACE_WATCHER_DECISION_DEDUPE_MS = 60_000;
export const WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS = 10 * 60_000;
/**
 * Claim lease duration written at claim time. Nothing renews this TTL; an expiry
 * alone never releases work (liveness is decided only by executor probes).
 */
export const WORKSPACE_TODO_CLAIM_TTL_MS = 30_000;

/**
 * True when a tick patch carries nothing but the lease renewal and the
 * heartbeat timestamp.
 *
 * @param {Record<string, unknown>} patch
 */
function isHeartbeatOnlyPatch(patch) {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => key === 'lease' || key === 'lastTickAt');
}

/**
 * Fire-and-forget push for a watcher decision. Mirrors the guard rails of
 * `notifyAgentFinished`: it bails out before touching any store when push is
 * unavailable or nobody is subscribed, and it never throws into the tick that
 * called it. The observe path uses it for the "idle, there is work" episode and
 * the autopilot path reuses it for start/cycle failures.
 *
 * @param {{
 *   workspaceFolder?: string,
 *   title?: string,
 *   body?: string,
 *   tag?: string,
 *   url?: string,
 * }} input
 * @param {{
 *   isPushAvailable?: () => boolean,
 *   hasPushSubscriptions?: () => boolean,
 *   broadcastPush?: (payload: Record<string, any>) => Promise<unknown>,
 * }} [deps]
 * @returns {boolean} whether a push was scheduled
 */
export function notifyWorkspaceWatcherDecision(input = {}, deps = {}) {
  const available = typeof deps.isPushAvailable === 'function' ? deps.isPushAvailable : isPushAvailable;
  if (!available()) return false;
  const subscribed = typeof deps.hasPushSubscriptions === 'function'
    ? deps.hasPushSubscriptions
    : hasPushSubscriptions;
  if (!subscribed()) return false;
  const broadcast = typeof deps.broadcastPush === 'function' ? deps.broadcastPush : broadcastPush;
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const title = String(input.title ?? 'Cretli — workspace watcher');
  const body = String(input.body ?? '').trim();
  if (!body) return false;
  void (async () => {
    try {
      await broadcast({
        title,
        body,
        tag: String(input.tag ?? `cretli-watcher-${workspaceFolder || 'workspace'}`),
        data: { url: input.url || '/', workspaceFolder },
      });
    } catch {
      // A push failure must never break the heartbeat tick.
    }
  })();
  return true;
}

/** Shared lease identity for heartbeat, manual tick, and autopilot cycle starts. */
export const WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN = `workspace-watcher-driver-${process.pid}-${randomUUID()}`;

/**
 * Short, log-safe view of the chats that make liveness "unknown", so a `Why?`
 * line names the blocker instead of just a count. Kept small — the decision
 * log is bounded by `WORKSPACE_WATCHER_MAX_DECISIONS`.
 *
 * @param {unknown} unknownChats
 * @param {number} [limit]
 * @returns {Array<{ chatId: string, reason: string }>}
 */
function summarizeUnknownChats(unknownChats, limit = 3) {
  if (!Array.isArray(unknownChats)) return [];
  const capped = Math.max(0, Math.floor(Number(limit) || 0));
  return unknownChats.slice(0, capped).map((row) => ({
    chatId: String(row?.chatId ?? '').trim(),
    reason: String(row?.reason ?? '').trim() || 'unknown',
  }));
}

/**
 * Backend code freshness for the cycle diagnostics.
 *
 * Only a measured `stale` result is stamped. An unstarted detector (this process
 * is not the one that boots the worker) or an unreadable filesystem is `unknown`,
 * and unknown must never show up as a finding or drive any remediation — the same
 * rule the other detectors follow. Stamping the decision is what makes a cycle
 * that misbehaves on a server running old code readable in the "Why?" log instead
 * of a bug report.
 *
 * @param {() => { state?: string, changedCount?: number | null }} [readCodeFreshness]
 * @returns {{ backendCodeStale?: true, backendCodeChangedFiles?: number }}
 */
export function backendCodeFreshnessDecisionStamp(readCodeFreshness) {
  const read = typeof readCodeFreshness === 'function' ? readCodeFreshness : getServerCodeFreshnessDetail;
  let detail = null;
  try {
    detail = read();
  } catch {
    return {};
  }
  if (!detail || typeof detail !== 'object' || String(detail.state) !== 'stale') return {};
  const changedFiles = Number(detail.changedCount);
  if (!Number.isFinite(changedFiles) || changedFiles <= 0) return {};
  return {
    backendCodeStale: true,
    backendCodeChangedFiles: Math.floor(changedFiles),
  };
}

/**
 * One-line, human-readable decision summary for the pinned chat feed.
 *
 * @param {Record<string, any>} decision
 * @returns {string}
 */
export function describeWorkspaceWatcherDecision(decision = {}) {
  const kind = String(decision.kind || 'unknown');
  const reason = String(decision.reason || '').trim();
  const ready = Math.max(0, Math.floor(Number(decision.readyTodoCount) || 0));
  const active = Math.max(0, Math.floor(Number(decision.activeAgentCount) || 0));
  const scout = Math.max(0, Math.floor(Number(decision.scoutAgentCount) || 0));
  const todoId = String(decision.nextTodoId || '').trim();
  // A pool-specific wait names its pool in the same parenthesis as the reason:
  // `cycle_active` alone cannot tell a full worktree pool from a full project
  // one, and the two need a different fix from the operator.
  const pool = normalizeWorkspaceWatcherPool(decision.pool);
  const parts = [`Decision: ${kind}${reason ? ` (${reason}${pool ? `:${pool}` : ''})` : ''}`];
  if (ready) parts.push(`${ready} ready`);
  if (active) parts.push(`${active} active`);
  if (scout) parts.push(`${scout} scout`);
  if (decision.backendCodeStale === true) {
    parts.push(`backend changed since start (${Math.max(1, Math.floor(Number(decision.backendCodeChangedFiles) || 0))} file(s)), restart may be required`);
  }
  const unknownChats = Array.isArray(decision.unknownChats) ? decision.unknownChats : [];
  if (unknownChats.length) {
    const total = Math.max(unknownChats.length, Math.max(0, Math.floor(Number(decision.unknownAgentCount) || 0)));
    const shown = unknownChats
      .map((row) => `${String(row?.chatId || '').slice(0, 8) || '?'}:${String(row?.reason || 'unknown')}`)
      .join(', ');
    const more = Math.max(0, total - unknownChats.length);
    parts.push(`unknown ${total} (${shown}${more > 0 ? ` +${more}` : ''})`);
  }
  if (todoId) parts.push(`next ${todoId.slice(0, 8)}`);
  const slotHolders = Array.isArray(decision.slotHolders) ? decision.slotHolders : [];
  if (slotHolders.length) {
    const shown = slotHolders.map((token) => formatSlotHolderLabel(token)).filter(Boolean).join(', ');
    if (shown) parts.push(`held by ${shown}`);
  }
  const slotChats = Array.isArray(decision.slotChats) ? decision.slotChats : [];
  if (!slotHolders.length && slotChats.length) {
    const shown = slotChats
      .map((row) => String(row?.chatId || row?.cycleId || '').trim().slice(0, 8))
      .filter(Boolean)
      .join(', ');
    if (shown) parts.push(`held by ${shown}`);
  }
  return parts.join(' · ');
}

/**
 * Short label for a busy-slot token. Chat ids keep an 8-character prefix;
 * `delegation:<id>` keeps the prefix so the line stays distinguishable.
 *
 * @param {unknown} token
 * @returns {string}
 */
function formatSlotHolderLabel(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('delegation:')) {
    const id = raw.slice('delegation:'.length).trim();
    return id ? `delegation:${id.slice(0, 8)}` : 'delegation';
  }
  return raw.slice(0, 8);
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
function describeError(error) {
  if (error && typeof error === 'object') {
    const code = String(/** @type {{ code?: unknown }} */ (error).code || '').trim();
    const message = error instanceof Error ? error.message : String(error);
    return { code: code || 'WORKSPACE_WATCHER_TICK', message };
  }
  return { code: 'WORKSPACE_WATCHER_TICK', message: String(error ?? 'unknown error') };
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function resolveDataDir(options = {}) {
  const configured = String(options.dataDir ?? '').trim();
  return configured || resolveDataPath();
}

/**
 * Chats attributed to this workspace by normalized folder match. The snapshot
 * probes these objects in place so it does not re-read chats.json per id.
 *
 * @param {string} workspaceMatchKey
 * @returns {Record<string, any>[]}
 */
function listWorkspaceChatsForSnapshot(workspaceMatchKey) {
  return loadChats().filter((chat) => chat?.watcherPinned !== true
    && delegationWorkspaceMatchKey(chat?.workspaceFolder) === workspaceMatchKey
    && String(chat?.id ?? '').trim());
}

/**
 * Chat row lookup for the recovery classifier (it only reads `archived`).
 *
 * @param {string} chatId
 * @returns {Record<string, any> | null}
 */
function loadWorkspaceWatcherChatRow(chatId) {
  const id = String(chatId ?? '').trim();
  if (!id) return null;
  return loadChats().find((chat) => String(chat?.id ?? '') === id) || null;
}

/**
 * Default snapshot inputs; tests may override any of them.
 *
 * @param {string} [dataDir]
 * @returns {Record<string, any>}
 */
export function defaultWorkspaceWatcherSnapshotDeps(dataDir) {
  const dir = String(dataDir ?? '').trim();
  return {
    loadTodosData: listTodos,
    listReadyTodoLeaves,
    isTodoBranchBlocked,
    getChatRunState,
    loadDelegations: () => loadDelegationsReadonly(dir ? { dataDir: dir } : {}),
    listDelegationsForWorkspace: (folder) => listDelegationsForWorkspace(folder, dir ? { dataDir: dir } : {}),
    isActiveDelegationStatus,
    // A terminal job with an unconfirmed stop (`runStoppingAt`) still holds its
    // parent slot, so the snapshot must count it as occupancy too.
    isDelegationSlotOccupied,
    // Used to count live agents that are not delegations (a human chat, a todo
    // agent, the orchestrator itself), so `maxParallel` reflects real occupancy.
    // Scout chats are split out afterwards and never consume that todo slot.
    listWorkspaceChats: listWorkspaceChatsForSnapshot,
    listWorkspaceChatIds: (workspaceMatchKey) => listWorkspaceChatsForSnapshot(workspaceMatchKey)
      .map((chat) => String(chat.id).trim())
      .filter(Boolean),
    // A chat whose adapter cannot confirm liveness is only counted as "unknown"
    // when the snapshot has a trace of work for it (a todo claim or an occupied
    // delegation slot). A cold chat with no room and no trace is idle, so closed
    // or archived chats never block an autopilot cycle; a real adapter error or a
    // trace-backed cold chat still blocks, so a possibly-running agent is never
    // crowded out.
    probeChatRunLiveness,
  };
}

/**
 * @param {unknown} folder
 * @returns {string}
 */
function delegationWorkspaceMatchKey(folder) {
  const canonical = normalizeDelegationWorkspaceKey(folder);
  if (!canonical) return normalizeWorkspaceFolder(folder);
  return normalizeWorkspaceFolder(canonical);
}

/**
 * @param {string} dataDir
 * @param {string} [workspaceFolder]
 * @returns {Record<string, any>[]}
 */
function safeListHarnessUsageLimitsForTick(dataDir, workspaceFolder) {
  try {
    if (String(workspaceFolder || '').trim()) {
      return listHarnessUsageLimitsForWorkspace({ dataDir, workspaceFolder });
    }
    return listHarnessUsageLimits(dataDir);
  } catch {
    return [];
  }
}

const SCOUT_CHAT_TITLE_PREFIX = '[Scout]';

/**
 * Parent ids of every live Scout scan on the row. Title matching still catches
 * a review child after the scan record is cleared; these ids catch a renamed
 * parent. Iterates the whole `activeScoutScans` collection so a parallel scan
 * is never dropped from the occupancy snapshot.
 *
 * @param {Record<string, any> | null | undefined} watcher
 * @returns {string[]}
 */
export function workspaceWatcherScoutParentChatIds(watcher) {
  /** @type {string[]} */
  const ids = [];
  for (const scan of getActiveScoutScans(watcher)) {
    const id = String(scan?.chatId ?? '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * @param {unknown} title
 * @returns {boolean}
 */
function isScoutChatTitle(title) {
  return String(title ?? '').trim().startsWith(SCOUT_CHAT_TITLE_PREFIX);
}

/**
 * Scout scan chat, its review children, and any chat titled as Scout.
 * Delegation links are walked a few times so a review that itself delegated
 * stays in the scout bucket.
 *
 * @param {{
 *   scoutParentChatIds?: string[],
 *   chatRows?: Record<string, any>[],
 *   delegations?: Record<string, any>[],
 * }} input
 * @returns {Set<string>}
 */
function collectScoutOwnedChatIds(input) {
  const owned = new Set(
    (Array.isArray(input.scoutParentChatIds) ? input.scoutParentChatIds : [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
  );
  for (const row of input.chatRows || []) {
    const id = String(row?.id ?? '').trim();
    if (id && isScoutChatTitle(row?.title)) owned.add(id);
  }
  const delegations = Array.isArray(input.delegations) ? input.delegations : [];
  let changed = true;
  let guard = 0;
  while (changed && guard < 8) {
    changed = false;
    guard += 1;
    for (const row of delegations) {
      const parent = String(delegationController(row) ?? '').trim();
      const child = String(row?.childChatId ?? '').trim();
      const id = String(row?.id ?? '').trim();
      const linked = (parent && owned.has(parent)) || (child && owned.has(child));
      if (!linked) continue;
      if (parent && !owned.has(parent)) {
        owned.add(parent);
        changed = true;
      }
      if (child && !owned.has(child)) {
        owned.add(child);
        changed = true;
      }
      if (id) owned.add(`delegation:${id}`);
    }
  }
  return owned;
}

/**
 * Link every busy token (a chat id, or `delegation:<id>` for a delegation whose
 * child chat is not known yet) to the `doing` todo it actually works on.
 *
 * Precedence when several links reach the same token, most specific first:
 *   1. the delegation's own `leafId`, because that slot exists only while the
 *      delegated leaf runs;
 *   2. the primary todo of the watcher cycle that owns the chat (`todoIds[0]`,
 *      the same record the cycle close treats as the cycle's todo);
 *   3. the todo whose claim names the chat (`claimedByChatId`).
 * A candidate whose todo row is missing or no longer `doing` is skipped instead
 * of blocking the link, so a lower-precedence source can still match and an
 * untraceable token stays unlinked for the caller to place conservatively.
 *
 * @param {{
 *   items?: Record<string, any>[],
 *   activeDelegations?: Record<string, any>[],
 *   cycles?: Record<string, any>[],
 * }} [input]
 * @returns {Map<string, Record<string, any>>} token -> doing todo row
 */
function linkBusyTokensToDoingTodos(input = {}) {
  /** @type {Map<string, Record<string, any>>} */
  const doingById = new Map();
  for (const row of Array.isArray(input.items) ? input.items : []) {
    const todoId = String(row?.id ?? '').trim();
    if (todoId && String(row?.status ?? '') === 'doing') doingById.set(todoId, row);
  }
  /** @type {Map<string, Record<string, any>>} */
  const links = new Map();
  const link = (rawToken, rawTodoId) => {
    const token = String(rawToken ?? '').trim();
    const todo = doingById.get(String(rawTodoId ?? '').trim());
    if (!token || !todo || links.has(token)) return;
    links.set(token, todo);
  };
  for (const row of Array.isArray(input.activeDelegations) ? input.activeDelegations : []) {
    const delegationId = String(row?.id ?? '').trim();
    if (delegationId) link(`delegation:${delegationId}`, row?.leafId);
    link(row?.childChatId, row?.leafId);
  }
  for (const cycle of Array.isArray(input.cycles) ? input.cycles : []) {
    const primaryTodoId = Array.isArray(cycle?.todoIds) ? cycle.todoIds[0] : '';
    link(cycle?.chatId, primaryTodoId);
  }
  for (const [todoId, row] of doingById) {
    link(row?.claimedByChatId, todoId);
  }
  return links;
}

/**
 * Split the busy tokens into the two execution folders so the decision gate can
 * cap each pool on its own. Every token goes to exactly one pool, which is what
 * keeps `worktreeAgentCount + projectAgentCount === activeAgentCount`.
 *
 * An unlinked token lands in the project pool: the logical project folder is
 * the conservative guess for a chat that orchestrates its own work, holds a
 * claim whose todo row is gone, or otherwise cannot be traced to a leaf.
 * `workspaceWatcherTodoPool` gives the effective mode, so a leaf with `inherit`
 * follows the watcher policy default and never walks ancestors, and a stored
 * value the resolver refuses is `project` too — the snapshot must stay usable,
 * so nothing is pushed to `errors` for it: a recorded store error makes every
 * watcher decision bail out.
 *
 * @param {{
 *   busyTokens?: Iterable<unknown>,
 *   items?: Record<string, any>[],
 *   activeDelegations?: Record<string, any>[],
 *   cycles?: Record<string, any>[],
 *   policy?: Record<string, any> | null,
 * }} [input]
 * @returns {{ worktreeBusyTokens: string[], projectBusyTokens: string[] }}
 */
function splitBusyTokensIntoExecutionPools(input = {}) {
  const links = linkBusyTokensToDoingTodos(input);
  /** @type {string[]} */
  const worktreeBusyTokens = [];
  /** @type {string[]} */
  const projectBusyTokens = [];
  for (const rawToken of input.busyTokens || []) {
    const token = String(rawToken ?? '').trim();
    if (!token) continue;
    const todo = links.get(token);
    const pool = todo ? workspaceWatcherTodoPool(todo, input.policy) : 'project';
    (pool === 'worktree' ? worktreeBusyTokens : projectBusyTokens).push(token);
  }
  return { worktreeBusyTokens, projectBusyTokens };
}

/**
 * Deterministic snapshot of one workspace. Store failures are captured per
 * source so a corrupt todo store cannot stop the heartbeat.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   now?: number,
 *   excludeChatIds?: string[],
 *   excludeDelegationParentChatIds?: string[],
 *   closedCycleChatIds?: string[],
 *   scoutParentChatIds?: string[],
 *   deps?: Partial<ReturnType<typeof defaultWorkspaceWatcherSnapshotDeps>>,
 * }} [options]
 * @returns {Promise<{
 *   workspaceFolder: string,
 *   at: string,
 *   readyTodoIds: string[],
 *   readyTodoCount: number,
 *   readyLeaves: Record<string, any>[],
 *   doingTodoIds: string[],
 *   doingStates: Array<{ todoId: string, state: string, reason: string, source: string, evidence: string, chatId: string, runId: string, cycleId: string, delegationId: string, attemptId: string, revision: string, claimed: boolean }>,
 *   recovery: Record<string, number>,
 *   doingTodoCount: number,
 *   blockedTodoIds: string[],
 *   blockedTodoCount: number,
 *   waitingChatIds: string[],
 *   waitingChatCount: number,
 *   recentErrors: Record<string, any>[],
 *   activeDelegationIds: string[],
 *   activeChatIds: string[],
 *   busyTokens: string[],
 *   worktreeBusyTokens: string[],
 *   projectBusyTokens: string[],
 *   unknownChatIds: string[],
 *   unknownChats: Array<{ chatId: string, reason: string }>,
 *   activeAgentCount: number,
 *   worktreeAgentCount: number,
 *   projectAgentCount: number,
 *   scoutAgentCount: number,
 *   unknownAgentCount: number,
 *   externalOwners: import('./workspace-watcher-tree-owner.js').WorkspaceWatcherExternalOwners,
 *   hasReadyWork: boolean,
 *   errors: Array<{ scope: string, code: string, message: string }>,
 * }>}
 */
export async function snapshotWorkspaceWatcher(options = {}) {
  const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
  const workspaceMatchKey = delegationWorkspaceMatchKey(options.workspaceFolder);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const dataDir = resolveDataDir(options);
  const deps = { ...defaultWorkspaceWatcherSnapshotDeps(dataDir), ...(options.deps || {}) };
  /** @type {Array<{ scope: string, code: string, message: string }>} */
  const errors = [];
  /** @type {string[]} */
  let readyTodoIds = [];
  /** @type {Record<string, any>[]} */
  let readyLeaves = [];
  /** @type {Record<string, any>[]} */
  let items = [];
  let doingTodoIds = [];
  let blockedTodoIds = [];
  const waitingChatIds = new Set();
  const excludedCycleChildChatIds = new Set();
  const recentErrors = [];
  /** @type {string[]} */
  let activeDelegationIds = [];
  /**
   * The active delegations themselves, not only their ids: the execution-pool
   * split needs the leaf each one runs and the slot it occupies.
   * @type {Record<string, any>[]}
   */
  let activeDelegations = [];
  /** @type {Record<string, any>[]} */
  let workspaceDelegations = [];
  /** @type {Record<string, any>[]} */
  let loadedChatRows = [];
  /** @type {string[]} */
  let delegationTokens = [];
  /** @type {string[]} */
  let activeChatIds = [];
  /** @type {string[]} */
  let unknownChatIds = [];
  /** @type {Array<{ chatId: string, reason: string }>} */
  const unknownChats = [];
  /**
   * Chats the snapshot already has positive evidence are doing work: a todo
   * claimed by that chat, or a delegation slot that parent/child occupies.
   * Absence of an in-memory room is *not* proof a run ended, but it is not a
   * trace of work either — so an unconfirmable chat only counts as "unknown"
   * when one of these ids points at it. Otherwise it is treated as idle.
   */
  const inFlightChatIds = new Set();
  /** Chats that hold an active delegation slot (as parent or child). */
  const delegationSlotChatIds = new Set();
  const excludedChats = new Set(
    (Array.isArray(options.excludeChatIds) ? options.excludeChatIds : [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
  );
  const closedCycleChats = new Set(
    (Array.isArray(options.closedCycleChatIds) ? options.closedCycleChatIds : [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
  );

  try {
    const doc = await deps.loadTodosData(dataDir, workspaceFolder);
    items = Array.isArray(doc?.items) ? doc.items : [];
    readyLeaves = deps.listReadyTodoLeaves(items) || [];
    doingTodoIds = items.filter((row) => row.status === 'doing').map((row) => String(row.id));
    blockedTodoIds = items.filter((row) => row.status !== 'done' && deps.isTodoBranchBlocked(items, row))
      .map((row) => String(row.id));
    readyTodoIds = readyLeaves
      .map((row) => String(row?.id ?? '').trim())
      .filter(Boolean);
    for (const row of items) {
      if (String(row?.status ?? '') === 'done') continue;
      const claimChatId = String(row?.claimedByChatId ?? '').trim();
      if (claimChatId) inFlightChatIds.add(claimChatId);
    }
  } catch (error) {
    errors.push({ scope: 'todos', ...describeError(error) });
  }

  try {
    const occupancyCheck = typeof deps.isDelegationSlotOccupied === 'function'
      ? deps.isDelegationSlotOccupied
      : isDelegationSlotOccupied;
    // The watcher's own cycle children are excluded from the occupancy count:
    // the singleton cycle contract already owns them, and counting them would
    // make the watcher wait on work it started itself.
    const excludedParents = new Set(
      (Array.isArray(options.excludeDelegationParentChatIds) ? options.excludeDelegationParentChatIds : [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean),
    );
    const callerSuppliedDelegations = typeof options.deps?.loadDelegations === 'function';
    workspaceDelegations = callerSuppliedDelegations || typeof deps.listDelegationsForWorkspace !== 'function'
      ? (deps.loadDelegations() || []).filter((row) =>
        delegationWorkspaceMatchKey(row?.workspaceFolder) === workspaceMatchKey)
      : (deps.listDelegationsForWorkspace(options.workspaceFolder) || []);
    for (const row of workspaceDelegations) {
      if (excludedParents.has(String(delegationController(row) || '')) && row.childChatId) {
        excludedCycleChildChatIds.add(String(row.childChatId));
      }
      if (!excludedParents.has(String(delegationController(row) || ''))
        && String(row.status) === 'waiting_for_input' && row.childChatId) waitingChatIds.add(String(row.childChatId));
      for (const error of Array.isArray(row.errors) ? row.errors : []) {
        recentErrors.push({ ...error, delegationId: String(row.id || '') });
      }
    }
    activeDelegations = workspaceDelegations
      .filter((row) => {
        if (excludedParents.has(String(delegationController(row) ?? '').trim())) return false;
        const occupied = occupancyCheck(row, now) === true
          || deps.isActiveDelegationStatus(row?.status) === true;
        if (!occupied) return false;
        return delegationWorkspaceMatchKey(row?.workspaceFolder) === workspaceMatchKey;
      });
    activeDelegationIds = activeDelegations
      .map((row) => String(row?.id ?? '').trim())
      .filter(Boolean);
    // An active delegation occupies exactly the slot its child chat occupies,
    // so its child chat id joins the busy-agent set rather than adding twice. A
    // delegation whose child chat is not known yet still occupies a slot, so it
    // contributes a synthetic delegation token instead of disappearing.
    delegationTokens = activeDelegations
      .map((row) => {
        const childChatId = String(row?.childChatId ?? '').trim();
        const id = String(row?.id ?? '').trim();
        if (childChatId) return childChatId;
        return id ? `delegation:${id}` : '';
      })
      .filter(Boolean);
    // A delegation occupies both its parent and its child chat slots, so an
    // unconfirmable chat that is one of them is real work, not a cold room.
    for (const row of activeDelegations) {
      const parentChatId = String(delegationController(row) ?? '').trim();
      const childChatId = String(row?.childChatId ?? '').trim();
      if (parentChatId) inFlightChatIds.add(parentChatId);
      if (childChatId) inFlightChatIds.add(childChatId);
      if (parentChatId) delegationSlotChatIds.add(parentChatId);
      if (childChatId) delegationSlotChatIds.add(childChatId);
    }
  } catch (error) {
    errors.push({ scope: 'delegations', ...describeError(error) });
  }

  try {
    // A caller-supplied id list stays id-only so existing tests keep their
    // probe contract. The default path passes the already loaded chat row.
    const listedByCaller = typeof options.deps?.listWorkspaceChatIds === 'function';
    const chatRows = listedByCaller
      ? (options.deps.listWorkspaceChatIds(workspaceMatchKey) || []).map((chatId) => ({
        id: String(chatId ?? '').trim(),
      }))
      : (typeof deps.listWorkspaceChats === 'function'
        ? (deps.listWorkspaceChats(workspaceMatchKey) || [])
        : []);
    loadedChatRows = chatRows;
    // Excluded chats (the watcher's own cycle and its delegated children) never
    // count as a work trace, so drop them before the probe loop reads the set.
    for (const id of excludedCycleChildChatIds) {
      inFlightChatIds.delete(id);
      excludedChats.add(id);
    }
    const probe = deps.probeChatRunLiveness || probeChatRunLiveness;
    for (const row of chatRows) {
      const id = String(row?.id ?? '').trim();
      if (!id) continue;
      if (excludedChats.has(id)) continue;
      const probeInput = listedByCaller ? { chatId: id } : { chatId: id, chat: row };
      const live = probe(probeInput);
      if (live.known === true) {
        // A finished cycle's orchestrator can stay busy for the tail of its own
        // run. That is not an external agent: with no todo claim and no active
        // delegation it must not fill maxParallel. Unknown liveness below is
        // unchanged, so an adapter error still blocks.
        const closedTail = closedCycleChats.has(id) && !inFlightChatIds.has(id);
        if (live.busy === true && !closedTail) activeChatIds.push(id);
        if (deps.getChatRunState(probeInput)?.waitingForInput === true) waitingChatIds.add(id);
        continue;
      }
      const reason = String(live?.reason ?? '').trim();
      // A chat that no longer exists is fully resolved, not a possible running
      // agent — skip it. A chat whose room is simply absent (`state_missing`) or
      // whose adapter is gone (`adapter_missing`) is idle unless a work trace
      // claims it; every other unconfirmed reason is an adapter error that must
      // stay conservative so a possibly-running agent is never crowded out.
      if (reason === 'chat_missing') continue;
      const benign = reason === 'state_missing' || reason === 'adapter_missing';
      if (benign && !inFlightChatIds.has(id)) continue;
      // A closed cycle chat with no room and no delegation slot is not running:
      // its todo claim is a leftover of the closed cycle (for example one closed
      // as interrupted by a server restart, whose todo was then continued in
      // another chat), not a trace of live work.
      if (benign && closedCycleChats.has(id) && !delegationSlotChatIds.has(id)) continue;
      // A work trace points at this chat, but the recovery registry proves its
      // run was accepted by a process that is gone and is not being resumed:
      // the orphan is dead, not a possibly-running agent. A chat held by an
      // active delegation keeps its slot and is never treated this way.
      if (benign && !delegationSlotChatIds.has(id) && hasWorkspaceWatcherLeafRestartEvidence(id)) continue;
      unknownChats.push({ chatId: id, reason: reason || 'unknown' });
    }
  } catch (error) {
    errors.push({ scope: 'chats', ...describeError(error) });
  }

  // Scout research (the scan chat and its review children) has its own parallel
  // budget. Those occupants are removed from the todo `maxParallel` set so a
  // running scout cannot stall a ready todo.
  const scoutOwned = collectScoutOwnedChatIds({
    scoutParentChatIds: options.scoutParentChatIds,
    chatRows: loadedChatRows,
    delegations: workspaceDelegations,
  });
  const isScoutOccupant = (token) => scoutOwned.has(String(token ?? '').trim());
  const workChatIds = activeChatIds.filter((id) => !isScoutOccupant(id));
  const scoutChatIds = activeChatIds.filter((id) => isScoutOccupant(id));
  const workDelegationTokens = delegationTokens.filter((token) => !isScoutOccupant(token));
  const scoutDelegationTokens = delegationTokens.filter((token) => isScoutOccupant(token));
  const workUnknownChats = unknownChats.filter((row) => !isScoutOccupant(row.chatId));
  const scoutUnknownChats = unknownChats.filter((row) => isScoutOccupant(row.chatId));
  activeChatIds = workChatIds;
  activeDelegationIds = activeDelegationIds.filter((id) => !isScoutOccupant(`delegation:${id}`));
  unknownChats.length = 0;
  unknownChats.push(...workUnknownChats);

  // Dedupe across sources: a running delegation is also a running chat, so the
  // busy-agent set is the union of delegation slots and live chats. A synthetic
  // `delegation:<id>` token keeps a delegation without a child chat counted.
  const busyTokens = new Set([...workChatIds, ...workDelegationTokens]);
  const scoutTokens = new Set([
    ...scoutChatIds,
    ...scoutDelegationTokens,
    ...scoutUnknownChats.map((row) => row.chatId),
  ]);
  unknownChatIds = [...new Set(workUnknownChats.map((row) => row.chatId))];

  // One watcher-row read feeds both the execution-pool split and the recovery
  // model below: the policy default resolves a leaf's `inherit`, and
  // `activeCycles` links an orchestrator chat to the todos of its cycle.
  let watcherRow = null;
  let watcherRowLoaded = false;
  try {
    watcherRow = getWorkspaceWatcher(workspaceFolder, { dataDir });
    watcherRowLoaded = true;
  } catch (error) {
    errors.push({ scope: 'recovery', ...describeError(error) });
  }
  const activeCycles = getWorkspaceWatcherActiveCycles(watcherRow);

  // Trees a chat outside the watcher is driving right now (manual orchestrator,
  // leaf chat with its own loop). The pick skips their leaves so an autopilot
  // cycle never shares a tree and a worktree with that chat.
  const externalOwners = collectWorkspaceWatcherExternalOwners({
    activeChatIds,
    activeDelegations,
    chatRows: loadedChatRows,
    excludeChatIds: [...excludedChats, ...closedCycleChats],
    now,
  });

  const { worktreeBusyTokens, projectBusyTokens } = splitBusyTokensIntoExecutionPools({
    busyTokens,
    items,
    activeDelegations,
    cycles: activeCycles,
    policy: watcherRow?.policy,
  });

  // Recovery read model: what every `doing` row waits for and what proves it.
  // Computed, never persisted, and never a substitute for the todo status.
  /** @type {ReturnType<typeof classifyWorkspaceDoingTodos>} */
  let doingStates = [];
  if (watcherRowLoaded) {
    try {
      const recoverIdleOpenChat = watcherRow?.policy?.recoverIdleOpenChat === true;
      doingStates = classifyWorkspaceDoingTodos({
        items,
        delegations: workspaceDelegations,
        cycles: activeCycles,
        probe: deps.probeChatRunLiveness || probeChatRunLiveness,
        isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
        getChat: typeof deps.getChat === 'function' ? deps.getChat : loadWorkspaceWatcherChatRow,
        now,
        recoverIdleOpenChat,
        hasLiveWorktree: buildLiveWorktreePredicate(dataDir),
        closedCycles: watcherRow?.cycleChats,
        readWorktreeRecord: buildWorktreeRecordReader(dataDir),
        reviewWaits: watcherRow?.reviewWaits,
        reviewPolicy: watcherRow?.policy,
      });
    } catch (error) {
      errors.push({ scope: 'recovery', ...describeError(error) });
    }
  }

  // A chat that only waits for a human (a `doing` todo in `user_action`, e.g. an
  // open worktree) does no work, so a missing run state after a restart must not
  // read as an agent of unknown liveness. A chat holding a delegation slot keeps
  // its guard: that slot is real work whatever the todo state says.
  const userActionChatIds = new Set(
    doingStates
      .filter((row) => row?.state === 'user_action')
      .map((row) => String(row.chatId ?? '').trim())
      .filter(Boolean),
  );
  if (userActionChatIds.size) {
    const keep = unknownChats.filter((row) => (
      !userActionChatIds.has(row.chatId)
      || delegationSlotChatIds.has(row.chatId)
      || row.reason !== 'state_missing'
    ));
    unknownChats.length = 0;
    unknownChats.push(...keep);
    unknownChatIds = [...new Set(unknownChats.map((row) => row.chatId))];
  }
  const unknownTokens = new Set(unknownChatIds);

  return {
    workspaceFolder,
    at: new Date(now).toISOString(),
    readyTodoIds,
    readyTodoCount: readyTodoIds.length,
    readyLeaves,
    items,
    doingTodoIds,
    doingTodoCount: doingTodoIds.length,
    doingStates,
    recovery: summarizeWorkspaceTodoRecovery(doingStates),
    blockedTodoIds,
    blockedTodoCount: blockedTodoIds.length,
    waitingChatIds: [...waitingChatIds],
    waitingChatCount: waitingChatIds.size,
    recentErrors: recentErrors.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 20),
    activeDelegationIds,
    activeChatIds,
    busyTokens: [...busyTokens],
    worktreeBusyTokens,
    projectBusyTokens,
    unknownChatIds,
    unknownChats,
    activeAgentCount: busyTokens.size,
    worktreeAgentCount: worktreeBusyTokens.length,
    projectAgentCount: projectBusyTokens.length,
    scoutAgentCount: scoutTokens.size,
    unknownAgentCount: unknownTokens.size,
    externalOwners,
    hasReadyWork: readyTodoIds.length > 0,
    errors,
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toFailureCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * A ready leaf whose failure count reached this ceiling is skipped so a
 * repeatedly-failing todo does not crowd out fresh work. Only a count limit —
 * the cooldown/backoff *timing* is a later stage, so an unset ceiling means
 * "never skip on failures" and this stays out of the backoff design.
 *
 * @param {Record<string, any>} watcher
 * @param {unknown} [override]
 * @returns {number}
 */
function resolveMaxFailures(watcher, override) {
  if (Number.isFinite(override)) return Number(override);
  const fromPolicy = Number(watcher?.policy?.maxConsecutiveFailures);
  // `0` is an explicit "never skip on failures" (unlimited); a positive number
  // is the ceiling. The normalizer stores 3 by default, so an untouched policy
  // caps at 3 consecutive failures, and a watcher built by hand without the
  // field stays unlimited so the pure decision tests keep their meaning.
  if (fromPolicy === 0) return Number.POSITIVE_INFINITY;
  if (Number.isFinite(fromPolicy) && fromPolicy > 0) return fromPolicy;
  return Number.POSITIVE_INFINITY;
}

/**
 * The ordered eligible set behind the pick: every rule that can disqualify a
 * leaf is applied here and the sort is the pick order, so a caller that needs
 * more than the first candidate (the decision gate re-picks across execution
 * pools) never re-implements a rule and never changes which leaf wins.
 *
 * @param {{
 *   items?: Record<string, any>[],
 *   readyLeaves?: Record<string, any>[],
 *   failures?: Record<string, unknown>,
 *   maxFailures?: number,
 *   maxSameFindings?: number,
 *   findings?: { byTodo?: Record<string, { hash?: string, streak?: number }> },
 *   allowedHarnesses?: string[],
 *   policy?: Record<string, any> | null,
 *   blockedBackoff?: Record<string, { count?: number, until?: string }>,
 *   lastServedByTree?: Record<string, number>,
 *   externalOwners?: import('./workspace-watcher-tree-owner.js').WorkspaceWatcherExternalOwners | null,
 *   now?: number,
 * }} [input]
 * @returns {Record<string, any>[]}
 */
function collectEligibleWorkspaceReadyTodos(input = {}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const leaves = Array.isArray(input.readyLeaves)
    ? input.readyLeaves
    : listReadyTodoLeaves(items);
  const failures = input.failures && typeof input.failures === 'object'
    ? /** @type {Record<string, unknown>} */ (input.failures)
    : {};
  const maxFailures = Number.isFinite(input.maxFailures) ? Number(input.maxFailures) : 3;
  const maxSameFindings = Math.max(0, Math.floor(Number(input.maxSameFindings) || 0));
  const findings = input.findings && typeof input.findings === 'object' ? input.findings : {};
  const harnesses = Array.isArray(input.allowedHarnesses) ? input.allowedHarnesses : [];
  const assigned = (row) => Boolean(row.assignee?.harness && (!harnesses.length || harnesses.includes(row.assignee.harness)));
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const classify = (row) => classifyWorkspaceReadyCandidate(row, { ...input, items, failures, maxFailures, maxSameFindings, findings, now });
  const eligible = leaves
    .filter((row) => String(row?.id ?? '').trim())
    .filter((row) => !classify(row))
    .sort((a, b) => {
      const assignment = Number(assigned(b)) - Number(assigned(a));
      if (assignment) return assignment;
      // `siblingIndex` is a position inside one parent: comparing it across
      // trees starved late leaves of a big parallel group (index 8+) behind
      // every index 0..7 leaf of every other tree. Across parents the oldest
      // update wins.
      if (String(a.parentId ?? '') === String(b.parentId ?? '')) {
        const siblingOrder = (a.siblingIndex || 0) - (b.siblingIndex || 0);
        if (siblingOrder) return siblingOrder;
      }
      const aKey = String(a.updatedAt ?? a.createdAt ?? '');
      const bKey = String(b.updatedAt ?? b.createdAt ?? '');
      if (aKey !== bKey) return aKey < bKey ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  // Scheduler layer: priority class, then fair share between trees.
  return rankWorkspaceWatcherCandidates(eligible, {
    items,
    lastServedByTree: input.lastServedByTree,
    runningByTree: countRunningLeavesByTree(items),
    preferred: assigned,
  });
}

/**
 * The first filter that rejects a ready leaf, or '' when it is eligible. One
 * source for both the eligible set and the per-candidate "Why?" reasons.
 *
 * @param {Record<string, any>} row
 * @param {Record<string, any>} input collectEligible input plus resolved defaults
 * @returns {string}
 */
function classifyWorkspaceReadyCandidate(row, input) {
  const items = input.items;
  if (isTodoAwaitingIntegration(row)) return 'awaiting_integration';
  // Phase scope: a todo whose next phase is disabled is skipped, not picked.
  if (input.policy) {
    const phase = filterTodosByEnabledPhases([row], { items, policy: input.policy }).skipped[0]?.phase;
    if (phase) return `phase_disabled:${phase}`;
    if (isWorkspaceWatcherLeafBehindWorktreeAncestor(row, items, input.policy)) return 'ancestor_requires_worktree';
  }
  if (isWorkspaceWatcherTodoInBlockedBackoff(input.blockedBackoff, row.id, input.now)) return 'blocked_backoff';
  // A tree another chat is driving belongs to that chat, not to autopilot.
  if (findWorkspaceWatcherExternalTreeOwner(row, items, input.externalOwners)) return 'tree_owned_by_live_orchestrator';
  if (toFailureCount(input.failures[String(row.id)]) >= input.maxFailures) return 'failure_ceiling';
  if (input.maxSameFindings > 0) {
    const entry = readWorkspaceWatcherTodoFindings(input.findings, String(row.id));
    if (entry.hash && entry.streak >= input.maxSameFindings) return 'same_findings';
  }
  return '';
}

/**
 * Pure "next todo" pick. `listReadyTodoLeaves` already drops done/doing nodes
 * and every blocked leaf (unapproved parent plan, or a sequential group whose
 * earlier sibling is not done), so an already-claimed (doing) todo never
 * surfaces here. Prefer a compatible assignment, then sibling position and
 * oldest update, tie-breaking on id. Skip leaves at the failure ceiling.
 *
 * @param {{
 *   items?: Record<string, any>[],
 *   readyLeaves?: Record<string, any>[],
 *   failures?: Record<string, unknown>,
 *   maxFailures?: number,
 *   maxSameFindings?: number,
 *   findings?: { byTodo?: Record<string, { hash?: string, streak?: number }> },
 *   allowedHarnesses?: string[],
 * }} [input]
 * @returns {Record<string, any> | null}
 */
export function pickNextWorkspaceReadyTodo(input = {}) {
  return collectEligibleWorkspaceReadyTodos(input)[0] || null;
}

/**
 * Tokens that occupy `maxParallel`: live chat ids and `delegation:<id>` for a
 * delegation whose child chat is not known yet.
 *
 * @param {unknown} tokens
 * @returns {string[]}
 */
function slotHolderTokens(tokens) {
  /** @type {string[]} */
  const out = [];
  for (const token of Array.isArray(tokens) ? tokens : []) {
    const id = String(token ?? '').trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * @param {Record<string, any>} snapshot
 * @returns {string[]}
 */
function busySlotHolders(snapshot) {
  return slotHolderTokens(snapshot?.busyTokens);
}

/**
 * Occupancy of one pool from agents outside the watcher. A snapshot built by
 * hand without the pool counts reads as 0, so an older caller never sees a pool
 * gate it cannot explain.
 *
 * @param {'worktree' | 'project'} pool
 * @param {Record<string, any>} snapshot
 * @returns {number}
 */
function workspaceWatcherPoolOccupancy(pool, snapshot) {
  return Math.max(0, Number(pool === 'worktree'
    ? snapshot?.worktreeAgentCount
    : snapshot?.projectAgentCount) || 0);
}

/**
 * This row's live cycles per pool, as the decision needs them: plain counts,
 * because the pure decision must not know what a cycle slot looks like. The tick
 * recomputes it inside the write lock, so a start that another path reserved a
 * moment ago is visible before this row names its next todo.
 *
 * @param {Record<string, any> | null | undefined} row
 * @param {Map<string, Record<string, any>>} todos
 * @returns {{ worktree: number, project: number }}
 */
function workspaceWatcherActiveCycleCounts(row, todos) {
  const partition = partitionWorkspaceWatcherCyclesByPool({
    cycles: getWorkspaceWatcherActiveCycles(row),
    todos,
    policy: row?.policy,
  });
  return { worktree: partition.worktree.length, project: partition.project.length };
}

/**
 * @param {unknown} counts
 * @returns {{ worktree: number, project: number }}
 */
function normalizeActiveCycleCounts(counts) {
  const source = counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : {};
  return {
    worktree: Math.max(0, Number(source.worktree) || 0),
    project: Math.max(0, Number(source.project) || 0),
  };
}

/**
 * @param {'worktree' | 'project'} pool
 * @param {Record<string, any>} snapshot
 * @returns {string[]}
 */
function workspaceWatcherPoolSlotHolders(pool, snapshot) {
  return slotHolderTokens(pool === 'worktree'
    ? snapshot?.worktreeBusyTokens
    : snapshot?.projectBusyTokens);
}

/**
 * Pure decision. In `observe` it only produces an observation; in `autopilot`
 * it also applies the guardrails and reports whether a cycle may start.
 *
 * @param {{
 *   watcher?: Record<string, any>,
 *   snapshot?: Record<string, any>,
 *   now?: number,
 *   activeUsageLimits?: Record<string, any>[],
 *   activeCycleCounts?: { worktree?: number, project?: number },
 *   load?: Record<string, any> | null,
 *   planReviewResolver?: ((todo: Record<string, any>) => { state?: string, stateReason?: string } | null) | null,
 * }} [input]
 * @returns {{
 *   kind: 'off' | 'paused' | 'stopped' | 'wait_active' | 'idle_no_work' | 'snapshot_error'
 *     | 'observe_ready' | 'start_cycle' | 'plan_gate' | 'wait_quiet_hours'
 *     | 'wait_budget' | 'wait_cooldown' | 'backoff' | 'wait_same_findings' | 'wait_harness_usage'
 *     | 'wait_plan_approval',
 *   reason: string,
 *   shouldNotify: boolean,
 *   planOnly?: boolean,
 *   readyTodoCount: number,
 *   activeAgentCount: number,
 *   scoutAgentCount: number,
 *   unknownAgentCount: number,
 *   maxParallel: number,
 *   nextTodoId: string,
 *   pool?: 'worktree' | 'project',
 *   slotHolders?: string[],
 *   slotChats?: Array<{ chatId: string, cycleId: string }>,
 * }}
 */
export function decideWorkspaceWatcherAction(input = {}) {
  const watcher = input.watcher || {};
  const snapshot = input.snapshot || {};
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const readyTodoCount = Math.max(0, Number(snapshot.readyTodoCount) || 0);
  const activeAgentCount = Math.max(0, Number(snapshot.activeAgentCount) || 0);
  const scoutAgentCount = Math.max(0, Number(snapshot.scoutAgentCount) || 0);
  const unknownAgentCount = Math.max(0, Number(snapshot.unknownAgentCount) || 0);
  const maxParallel = Math.max(1, Number(watcher?.policy?.maxParallel) || 1);
  const snapshotErrors = Array.isArray(snapshot.errors) ? snapshot.errors : [];
  const mode = String(watcher.mode || '');
  const tickable = WORKSPACE_WATCHER_TICK_MODES.includes(mode) && watcher.enabled !== false;
  const details = {
    readyTodoCount,
    activeAgentCount,
    scoutAgentCount,
    unknownAgentCount,
    maxParallel,
    nextTodoId: '',
  };
  const activeCycleCount = getWorkspaceWatcherActiveCycles(watcher).length;

  if (!tickable) {
    return { kind: 'off', reason: 'mode_off', shouldNotify: false, ...details };
  }
  if (watcher.paused === true) {
    // Global pause: halt without losing state. The cycle driver refuses to
    // start on `paused`, and no park/stop side effect fires while paused.
    return { kind: 'paused', reason: 'paused', shouldNotify: false, ...details };
  }
  if (String(watcher.stopReason || '').trim()) {
    return { kind: 'stopped', reason: 'stop_reason', shouldNotify: false, ...details };
  }
  if (snapshotErrors.length > 0) {
    return { kind: 'snapshot_error', reason: 'snapshot_unavailable', shouldNotify: false, ...details };
  }
  // The persistence format keeps at most this many cycle slots. This hard cap
  // is independent of the S1 valve: allowing another start would make the row
  // normalizer discard the newly reserved cycle.
  if (activeCycleCount >= WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES) {
    return { kind: 'wait_active', reason: 'hard_cap', shouldNotify: false, ...details };
  }
  // Safety valve, not a limit: `maxParallel` only postpones a start while S1
  // reports danger (or cannot report at all). Running work is never touched.
  const valve = evaluateWorkspaceWatcherSafetyValve({ count: activeAgentCount, maxParallel, load: input.load });
  if (valve.reached) {
    const slotHolders = busySlotHolders(snapshot);
    return {
      kind: 'wait_active',
      reason: valve.reason,
      shouldNotify: false,
      ...details,
      ...(slotHolders.length ? { slotHolders } : {}),
    };
  }
  // Any number of unknown-liveness chats is one safety slot: it only holds the
  // Watcher back when that single slot fills the remaining capacity, so with
  // maxParallel > 1 other slots keep starting.
  if (unknownAgentCount > 0 && activeAgentCount + 1 >= maxParallel) {
    return { kind: 'wait_active', reason: 'unknown_liveness', shouldNotify: false, ...details };
  }
  if (readyTodoCount === 0) {
    // Leaves held back by a parallel sibling's scope never reach the ready list;
    // name that instead of a generic "nothing ready".
    const scopeHeld = explainWorkspaceWatcherRejections({
      items: Array.isArray(snapshot.items) ? snapshot.items : [],
      readyLeaves: [],
      classify: () => '',
    });
    if (scopeHeld.length > 0) {
      return {
        kind: 'idle_no_work',
        reason: pickDominantRejection(scopeHeld),
        shouldNotify: false,
        ...details,
        rejections: scopeHeld.slice(0, 20),
      };
    }
    return { kind: 'idle_no_work', reason: 'no_ready_work', shouldNotify: false, ...details };
  }
  const policy = watcher.policy || {};
  const eligible = collectEligibleWorkspaceReadyTodos({
    items: Array.isArray(snapshot.items) ? snapshot.items : [],
    readyLeaves: Array.isArray(snapshot.readyLeaves) ? snapshot.readyLeaves : [],
    failures: watcher.failures,
    maxFailures: resolveMaxFailures(watcher),
    maxSameFindings: policy.maxSameFindings,
    findings: watcher.findings,
    allowedHarnesses: policy.allowedHarnesses,
    policy,
    blockedBackoff: watcher.blockedBackoff,
    lastServedByTree: watcher.lastServedByTree,
    externalOwners: snapshot.externalOwners,
    now,
  });
  let picked = eligible[0] || null;
  // Own cycles are excluded from snapshot tokens, so both sources add to
  // the same cap. Try the other pool before reporting a candidate's pool full.
  if (picked) {
    const cycleCounts = normalizeActiveCycleCounts(input.activeCycleCounts);
    const candidatePool = workspaceWatcherTodoPool(picked, policy);
    const poolFullByAgents = (pool) => {
      const limit = workspaceWatcherPoolLimit(pool, policy);
      return limit > 0 && workspaceWatcherPoolOccupancy(pool, snapshot) >= limit;
    };
    const poolIsFull = (pool) => {
      const limit = workspaceWatcherPoolLimit(pool, policy);
      return limit > 0 && workspaceWatcherPoolOccupancy(pool, snapshot) + cycleCounts[pool] >= limit;
    };
    if (poolIsFull(candidatePool)) {
      const fallback = eligible
        .find((row) => !poolIsFull(workspaceWatcherTodoPool(row, policy))) || null;
      if (!fallback) {
        // Deterministic cause, agents first: whenever the outside occupancy
        // alone explains the wait it keeps the pool's own reason, so a decision
        // is identical when no cycle counts are passed at all. Only a pool held
        // full by this row's own cycles is reported as `cycle_active`, and it
        // names the pool because the global cap was ruled out above.
        if (poolFullByAgents(candidatePool)) {
          const slotHolders = workspaceWatcherPoolSlotHolders(candidatePool, snapshot);
          return {
            kind: 'wait_active',
            reason: workspaceWatcherPoolWaitReason(candidatePool),
            shouldNotify: false,
            ...details,
            ...(slotHolders.length ? { slotHolders } : {}),
          };
        }
        return {
          kind: 'wait_active',
          reason: 'cycle_active',
          shouldNotify: false,
          ...details,
          pool: candidatePool,
        };
      }
      picked = fallback;
    }
  }
  const nextTodoId = picked ? String(picked.id) : '';
  if (mode === 'observe') {
    return {
      kind: 'observe_ready',
      reason: 'idle_has_work',
      shouldNotify: true,
      ...details,
      nextTodoId,
    };
  }
  // Autopilot: every ready candidate is above the failure ceiling, so there is
  // nothing eligible to start right now.
  if (!picked) {
    // Name the cause when a watcher-side rule (not the failure ceiling) holds
    // the whole ready set back, so "Why?" does not read as a generic idle.
    const readyLeaves = Array.isArray(snapshot.readyLeaves) ? snapshot.readyLeaves : [];
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const maxFailures = resolveMaxFailures(watcher);
    const rejections = explainWorkspaceWatcherRejections({
      items,
      readyLeaves,
      classify: (row) => classifyWorkspaceReadyCandidate(row, {
        items,
        policy,
        failures: watcher.failures && typeof watcher.failures === 'object' ? watcher.failures : {},
        maxFailures,
        maxSameFindings: Math.max(0, Math.floor(Number(policy.maxSameFindings) || 0)),
        findings: watcher.findings && typeof watcher.findings === 'object' ? watcher.findings : {},
        blockedBackoff: watcher.blockedBackoff,
        externalOwners: snapshot.externalOwners,
        now,
      }),
    });
    // The label is the filter that rejected most candidates, so one backed-off
    // leaf cannot name a pool that something else blocks; every rejection is
    // listed in `rejections`.
    const reason = pickDominantRejection(rejections) || 'no_eligible_work';
    return {
      kind: 'idle_no_work',
      reason,
      shouldNotify: false,
      ...details,
      ...(rejections.length ? { rejections: rejections.slice(0, 20) } : {}),
    };
  }
  const guard = evaluateWorkspaceWatcherGuardrails({
    watcher,
    pickedTodo: picked,
    items: Array.isArray(snapshot.items) ? snapshot.items : [],
    now,
    activeUsageLimits: Array.isArray(input.activeUsageLimits) ? input.activeUsageLimits : [],
    planReviewResolver: input.planReviewResolver,
  });
  if (!guard.allowed) {
    return {
      kind: guard.kind,
      reason: guard.reason,
      shouldNotify: false,
      planOnly: false,
      ...details,
      nextTodoId,
    };
  }
  return {
    kind: guard.planOnly ? 'plan_gate' : 'start_cycle',
    reason: guard.reason,
    shouldNotify: false,
    planOnly: guard.planOnly === true,
    ...(guard.planTargetId ? { planTargetId: guard.planTargetId } : {}),
    ...(guard.planRereview ? { planRereview: guard.planRereview } : {}),
    ...details,
    nextTodoId,
  };
}

/**
 * Reads a todo's plan-review state (`stale` / `plan_edited_after_review`, ...)
 * from the delegation records. Best-effort: any failure answers `null`, so the
 * gate falls back to plain "wait for the human".
 *
 * @param {{ workspaceFolder?: string, dataDir?: string }} input
 * @returns {(todo: Record<string, any>) => { state?: string, stateReason?: string } | null}
 */
export function buildWorkspaceWatcherPlanReviewResolver(input = {}) {
  const workspaceFolder = String(input.workspaceFolder ?? '').trim();
  const dataDir = String(input.dataDir ?? '').trim();
  return (todo) => {
    try {
      const snapshot = computeTodoReviewSnapshotForTodo({
        todo, workspaceFolder, ...(dataDir ? { dataDir } : {}),
      });
      return snapshot?.plan || null;
    } catch (error) {
      // Only data/IO errors fall back to "wait for the human"; a programming
      // error (missing symbol, wrong type) must surface, not disable the gate.
      if (error instanceof ReferenceError || error instanceof TypeError) throw error;
      return null;
    }
  };
}

/**
 * @param {Record<string, any>} watcher
 * @param {Record<string, any>} decision
 * @param {number} now
 * @param {number} dedupeMs
 * @returns {boolean}
 */
export function shouldRecordDecision(watcher, decision, now, dedupeMs) {
  const decisions = Array.isArray(watcher?.decisions) ? watcher.decisions : [];
  const last = decisions.at(-1);
  const idleNoWork = decision?.kind === 'idle_no_work' && decision?.reason === 'no_ready_work';
  const lastWasIdleNoWork = last?.kind === 'idle_no_work' && last?.reason === 'no_ready_work';
  const counters = ['readyTodoCount', 'activeAgentCount', 'scoutAgentCount', 'unknownAgentCount'];
  const idleStateChanged = !last || last.kind !== decision.kind || last.reason !== decision.reason
    || counters.some((key) => Number(last[key] || 0) !== Number(decision[key] || 0));
  if ((idleNoWork || lastWasIdleNoWork) && idleStateChanged) return true;
  if (idleNoWork) {
    if (dedupeMs <= 0) return true;
    const at = Date.parse(String(last.at || ''));
    if (!Number.isFinite(at)) return true;
    return now - at >= dedupeMs;
  }
  let matching = null;
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    const entry = decisions[i];
    if (!entry || entry.kind !== decision.kind || entry.reason !== decision.reason) continue;
    matching = entry;
    break;
  }
  if (!matching) return true;
  if (dedupeMs <= 0) return true;
  const at = Date.parse(String(matching.at || ''));
  if (!Number.isFinite(at)) return true;
  return now - at >= dedupeMs;
}

/**
 * Park every stuck ready todo (failure ceiling or repeated findings) as blocked
 * with a changelog note, and stop the watcher when no eligible todo remains.
 * Pure over the injected inputs: it reports the side effects the tick must
 * apply, and never touches a store itself.
 *
 * Only an idle autopilot row parks. A paused row, a stopped row, or a row with
 * an active cycle returns an empty plan, so parking never disturbs in-flight
 * work and never fights the operator's explicit stop.
 *
 * @param {{
 *   mode?: string,
 *   row?: Record<string, any>,
 *   snapshot?: Record<string, any>,
 *   decision?: Record<string, any>,
 * }} [input]
 * @returns {{
 *   parkTodoIds: string[],
 *   stopReason: string,
 *   clearFindingsTodoIds: string[],
 * }}
 */
export function planWorkspaceWatcherLoopGuard(input = {}) {
  const empty = { parkTodoIds: [], stopReason: '', clearFindingsTodoIds: [] };
  if (String(input.mode || '') !== 'autopilot') return empty;
  const row = input.row || {};
  if (row.paused === true) return empty;
  if (String(row.stopReason || '').trim()) return empty;
  // Any cycle in flight means the row is not idle: parking a todo the watcher is
  // already driving would fight its own claim. Not a `maxParallel` test — a
  // partially busy row must stay unparked exactly like a fully busy one.
  if (getWorkspaceWatcherActiveCycles(row).length > 0) return empty;
  const loop = evaluateWorkspaceWatcherLoop({
    watcher: row,
    snapshot: input.snapshot || {},
    candidateTodoId: String(input.decision?.nextTodoId || '').trim(),
  });
  if (!loop.blockTodoIds.length) return empty;
  return {
    parkTodoIds: loop.blockTodoIds,
    stopReason: loop.stopReason || '',
    clearFindingsTodoIds: Array.isArray(loop.clearFindingsTodoIds) ? loop.clearFindingsTodoIds : [],
  };
}

/**
 * Diff the durable `notified` map against the current state so each category is
 * pushed once per change and never spammed while a state persists. Covers the
 * "stopped" (any stopReason, manual or loop) and "waiting for plan approval"
 * episodes; the "blocked" push is emitted per todo by
 * `markWorkspaceWatcherTodoBlocked`, which is already transition-deduped.
 *
 * @param {Record<string, any>} row
 * @param {Record<string, any>} decision
 * @param {string} [appliedStopReason] stop reason just set this tick by the loop guard
 * @returns {{ nextNotified: Record<string, string> | null, messages: Array<{ kind: string, body: string }> }}
 */
function planWorkspaceWatcherStateNotify(row, decision, appliedStopReason = '') {
  const current = row.notified && typeof row.notified === 'object' ? row.notified : {};
  const next = { ...current };
  const messages = [];

  const stopSig = String(row.stopReason || appliedStopReason || '').trim();
  if (stopSig) {
    if (next.stopped !== stopSig) {
      messages.push({ kind: 'stopped', body: `Workspace watcher stopped (${stopSig}).` });
      next.stopped = stopSig;
    }
  } else if (next.stopped) {
    next.stopped = '';
  }

  const planSig = String(decision?.kind || '') === 'wait_plan_approval'
    ? String(decision?.nextTodoId || '').trim()
    : '';
  if (planSig) {
    if (next.plan_approval !== planSig) {
      const todoLabel = planSig ? planSig.slice(0, 8) : '?';
      messages.push({ kind: 'plan_approval', body: `Waiting for plan approval (todo ${todoLabel}).` });
      next.plan_approval = planSig;
    }
  } else if (next.plan_approval) {
    next.plan_approval = '';
  }

  const changed = WORKSPACE_WATCHER_NOTIFY_CHANNELS.some(
    (channel) => (next[channel] || '') !== (current[channel] || ''),
  );
  return { nextNotified: changed ? next : null, messages };
}

/**
 * Flip one stuck todo to blocked (a `blockedReason` is what the tree treats as
 * blocked) with a changelog entry, and push once for the transition. Idempotent:
 * a todo that is already blocked or finished, or that moved under another
 * writer's hands (CAS miss), is left untouched and never re-notified.
 *
 * @param {{
 *   dataDir?: string,
 *   workspaceFolder?: string,
 *   todoId?: string,
 *   at?: string,
 *   chatId?: string,
 *   reasonText?: string,
 *   notify?: typeof notifyWorkspaceWatcherDecision,
 *   notifyDeps?: Record<string, any>,
 * }} [input]
 * @returns {Promise<boolean>} whether the todo was newly blocked (and thus pushed)
 */
export async function markWorkspaceWatcherTodoBlocked(input = {}) {
  const workspaceFolder = String(input.workspaceFolder ?? '');
  const todoId = String(input.todoId ?? '').trim();
  if (!workspaceFolder.trim() || !todoId) return false;
  const dataDir = resolveDataDir(input);
  const reasonText = String(input.reasonText
    || WORKSPACE_WATCHER_PARKED_REASON).trim();
  let marked = false;
  try {
    const doc = await listTodos(dataDir, workspaceFolder);
    const current = (Array.isArray(doc?.items) ? doc.items : [])
      .find((row) => String(row?.id || '') === todoId) || null;
    if (current && String(current.status || '') !== 'done' && !String(current.blockedReason || '').trim()) {
      // The legacy backend reads the suppression flag synchronously inside the
      // call, so wrapping only the call (not the await) keeps it scoped.
      await withTodosWatcherNudgeSuppressed(() => updateTodo(dataDir, workspaceFolder, todoId, {
        status: current.status,
        strictStatus: true,
        blockedReason: reasonText,
        expectedUpdatedAt: current.updatedAt,
        appendChangelog: { kind: 'note', chatId: String(input.chatId || '') || undefined, text: reasonText },
      }));
      marked = true;
    }
  } catch {
    // A todo that moved on (CAS miss) or a store error is not ours to block.
    return false;
  }
  if (marked) {
    const notify = typeof input.notify === 'function'
      ? input.notify
      : notifyWorkspaceWatcherDecision;
    notify({
      workspaceFolder,
      title: 'Cretli — workspace watcher',
      body: `Blocked todo ${todoId.slice(0, 8)} after a progress loop: ${reasonText}`,
      tag: `cretli-watcher-blocked-${workspaceFolder}-${todoId}`,
      url: '/?panel=todos',
    }, input.notifyDeps || {});
    void appendWorkspaceWatcherNotice({
      workspaceFolder,
      dataDir,
      action: 'blocked',
      level: 'error',
      text: `Blocked todo ${todoId.slice(0, 8)} after a progress loop: ${reasonText}`,
      todoId,
      chatId: input.chatId,
      at: input.at,
      deps: input.noticeDeps || {},
    });
  }
  return marked;
}

/**
 * @param {Record<string, any>[]} cycles
 * @returns {Array<{ chatId: string, cycleId: string }>}
 */
function cycleSlotChats(cycles) {
  return cycles.map((cycle) => ({
    chatId: String(cycle?.chatId || '').trim(),
    cycleId: String(cycle?.cycleId || '').trim(),
  })).filter((entry) => entry.chatId || entry.cycleId);
}

/**
 * A startable decision must not be logged as `start_cycle` while this row's own
 * slots are already full. External agents stay on `max_parallel`; this reason
 * names the cycles that are holding the cap.
 *
 * Two refusals, in this order: the global `maxParallel` cap over every cycle —
 * today's exact decision shape — then the cap of the pool the picked todo
 * belongs to, reported with the same `cycle_active` reason plus a `pool` marker
 * and naming only that pool's cycles, so the "Why?" log never blames a project
 * cycle for a full worktree pool. The `pool` key appears on that new decision
 * only. A `wait_active`/`cycle_active` the pure decision produced itself already
 * carries the marker but cannot know any chat id (it only receives counts), so
 * its slots are filled here from the row.
 *
 * @param {Record<string, any>} row
 * @param {Record<string, any>} decision
 * @param {Map<string, Record<string, any>>} [todos] todo id -> row, for the pool classification
 * @returns {Record<string, any>}
 */
function decisionForOccupiedWatcherSlots(row, decision, todos) {
  const kind = String(decision?.kind || '');
  const cycles = getWorkspaceWatcherActiveCycles(row);
  const poolTodos = todos instanceof Map ? todos : workspaceWatcherPoolTodoIndex([]);
  if (cycles.length >= WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES) {
    return {
      ...decision,
      kind: 'wait_active',
      reason: 'hard_cap',
      shouldNotify: false,
      planOnly: false,
      slotChats: cycleSlotChats(cycles),
    };
  }
  if (kind === 'wait_active' && decision?.reason === 'cycle_active') {
    const pool = normalizeWorkspaceWatcherPool(decision.pool);
    if (!pool) return decision;
    const partition = partitionWorkspaceWatcherCyclesByPool({
      cycles,
      todos: poolTodos,
      policy: row?.policy,
    });
    return { ...decision, slotChats: cycleSlotChats(pool === 'worktree' ? partition.worktree : partition.project) };
  }
  if (kind !== 'start_cycle' && kind !== 'plan_gate') return decision;
  const maxParallel = Math.max(1, Number(row?.policy?.maxParallel) || 1);
  const valve = evaluateWorkspaceWatcherSafetyValve({ count: cycles.length, maxParallel });
  if (!valve.reached) {
    const partition = partitionWorkspaceWatcherCyclesByPool({
      cycles,
      todos: poolTodos,
      policy: row?.policy,
    });
    const pool = workspaceWatcherTodoIdPool(decision.nextTodoId, {
      todos: poolTodos,
      policy: row?.policy,
    });
    const poolCycles = pool === 'worktree' ? partition.worktree : partition.project;
    const limit = workspaceWatcherPoolLimit(pool, row?.policy);
    if (limit <= 0 || poolCycles.length < limit) return decision;
    return {
      ...decision,
      kind: 'wait_active',
      reason: 'cycle_active',
      shouldNotify: false,
      planOnly: false,
      pool,
      slotChats: cycleSlotChats(poolCycles),
    };
  }
  return {
    ...decision,
    kind: 'wait_active',
    reason: 'cycle_active',
    shouldNotify: false,
    planOnly: false,
    slotChats: cycleSlotChats(cycles),
  };
}

/**
 * One observe-only tick for a single workspace. `off` (and a missing row)
 * performs no write at all, so the default is a true no-op.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   now?: number,
 *   ownerPid?: number,
 *   token?: string,
 *   ttlMs?: number,
 *   throttleLeaseRenewal?: boolean,
 *   decisionDedupeMs?: number,
 *   deps?: Partial<ReturnType<typeof defaultWorkspaceWatcherSnapshotDeps>>,
 * }} [options]
 * @returns {Promise<{
 *   workspaceFolder: string,
 *   action: string,
 *   reason: string,
 *   shouldNotify: boolean,
 *   wrote: boolean,
 *   recorded: boolean,
 *   parked?: unknown[],
 *   decision?: Record<string, any>,
 *   snapshot?: Record<string, any>,
 *   watcher?: Record<string, any>,
 * }>}
 */
export async function tickWorkspaceWatcher(options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
  const dataDir = resolveDataDir(options);
  const existing = getWorkspaceWatcher(workspaceFolder, { dataDir });
  if (!existing) {
    return {
      workspaceFolder,
      action: 'no_watcher',
      reason: 'no_watcher',
      shouldNotify: false,
      wrote: false,
      recorded: false,
    };
  }
  if (!WORKSPACE_WATCHER_TICK_MODES.includes(String(existing.mode || ''))) {
    const reason = existing.mode === 'autopilot' ? 'mode_autopilot_inert' : 'mode_off';
    return {
      workspaceFolder,
      action: 'off',
      reason,
      shouldNotify: false,
      wrote: false,
      recorded: false,
    };
  }

  const cycleChatIds = workspaceWatcherCycleChatIds(existing);
  const closedCycleChatIds = workspaceWatcherClosedCycleChatIds(existing);
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    now,
    // Every live cycle's orchestrator is the watcher itself, so none of them may
    // count toward `maxParallel`; its child delegations are the other side of
    // the same exclusion. Closed-cycle orchestrators stay visible to the probe
    // but their idle-tail occupancy is dropped inside the snapshot.
    excludeChatIds: [...(options.excludeChatIds || []), ...cycleChatIds],
    excludeDelegationParentChatIds: [...(options.excludeDelegationParentChatIds || []), ...cycleChatIds],
    closedCycleChatIds: [...(options.closedCycleChatIds || []), ...closedCycleChatIds],
    scoutParentChatIds: workspaceWatcherScoutParentChatIds(existing),
    deps: options.deps,
  });
  const usageLimits = typeof options.deps?.listHarnessUsageLimits === 'function'
    ? (options.deps.listHarnessUsageLimits(dataDir) || [])
    : safeListHarnessUsageLimitsForTick(dataDir, workspaceFolder);
  // Pool classification reads todo rows, and a live cycle's own todo is `doing`,
  // so it is never in `readyLeaves`: the snapshot's full item list is the source
  // here, with the ready leaves as the fallback for the todo about to start. The
  // cycle chats are excluded from the snapshot tokens above, so the per-pool
  // cycle counts are the only way this row's own work reaches the pool gate.
  const poolTodos = workspaceWatcherPoolTodoIndex([snapshot.items, snapshot.readyLeaves]);
  const planReviewResolver = typeof options.deps?.planReviewResolver === 'function'
    ? options.deps.planReviewResolver
    : buildWorkspaceWatcherPlanReviewResolver({ workspaceFolder, dataDir });
  let decision = decisionForOccupiedWatcherSlots(
    existing,
    decideWorkspaceWatcherAction({
      watcher: existing,
      snapshot,
      now,
      activeUsageLimits: usageLimits,
      activeCycleCounts: workspaceWatcherActiveCycleCounts(existing, poolTodos),
      planReviewResolver,
    }),
    poolTodos,
  );
  if (decision.kind === 'snapshot_error') {
    logDelegationEvent('workspace-watcher-snapshot-error', {}, {
      workspaceFolder,
      errors: snapshot.errors,
    });
  }
  const configuredDedupeMs = Number.isFinite(options.decisionDedupeMs)
    ? Number(options.decisionDedupeMs)
    : null;
  const at = new Date(now).toISOString();
  const token = String(options.token ?? '').trim() || WORKSPACE_WATCHER_DRIVER_LEASE_TOKEN;
  const ttlMs = options.ttlMs;
  const ownerPid = options.ownerPid;
  let recorded = false;
  // Set inside the write lock, read after it commits. A push is only scheduled
  // once the `idleNotifiedAt` flag is durable, so two racing ticks (or a tick
  // that crashes before the send) can never emit the same episode twice.
  let pendingNotify = false;
  /** @type {string[]} */
  let pendingPark = [];
  /** @type {Array<{ kind: string, body: string }>} */
  let pendingStateMessages = [];
  /** @type {Array<{ containerId: string, childId: string }>} */
  let pendingAutoReady = [];
  let abortedReason = 'lease_held';
  // Set when the tick was a pure heartbeat that was deliberately not persisted.
  let heartbeatSkipped = false;
  const mutateResult = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    if (!WORKSPACE_WATCHER_TICK_MODES.includes(String(row.mode || '')) || row.enabled === false) {
      abortedReason = 'mode_off';
      return null;
    }
    const leaseAttempt = acquireWorkspaceWatcherLease(row, {
      ownerPid,
      token,
      ttlMs,
      now,
    });
    if (!leaseAttempt.acquired) return null;
    // Re-decided against the freshly locked row, whose cycles may have been
    // reserved by another path since the snapshot was taken — hence the counts
    // recomputed from `row`, not reused from `existing`.
    decision = decisionForOccupiedWatcherSlots(
      row,
      decideWorkspaceWatcherAction({
        watcher: row,
        snapshot,
        now,
        activeUsageLimits: usageLimits,
        activeCycleCounts: workspaceWatcherActiveCycleCounts(row, poolTodos),
        planReviewResolver,
      }),
      poolTodos,
    );
    Object.assign(decision, backendCodeFreshnessDecisionStamp(options.deps?.readCodeFreshness));
    const dedupeMs = configuredDedupeMs ?? (
      decision.kind === 'idle_no_work' && decision.reason === 'no_ready_work'
        ? WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS
        : WORKSPACE_WATCHER_DECISION_DEDUPE_MS
    );
    recorded = shouldRecordDecision(row, decision, now, dedupeMs);
    /** @type {Record<string, unknown>} */
    const patch = {
      lease: leaseAttempt.lease,
      lastTickAt: at,
    };
    if (recorded) {
      const unknownChatsSummary = summarizeUnknownChats(snapshot.unknownChats);
      decision.unknownChats = unknownChatsSummary;
      patch.decisions = [
        ...row.decisions,
        {
          at,
          kind: decision.kind,
          reason: decision.reason,
          readyTodoCount: decision.readyTodoCount,
          activeAgentCount: decision.activeAgentCount,
          scoutAgentCount: decision.scoutAgentCount,
          unknownAgentCount: decision.unknownAgentCount,
          shouldNotify: decision.shouldNotify,
          nextTodoId: decision.nextTodoId,
          unknownChats: unknownChatsSummary,
          slotChats: decision.slotChats,
          slotHolders: decision.slotHolders,
          pool: decision.pool,
          // Count only, never paths: the decision log is durable and shared.
          ...(decision.backendCodeStale === true
            ? {
              backendCodeStale: true,
              backendCodeChangedFiles: decision.backendCodeChangedFiles,
            }
            : {}),
        },
      ];
    }
    // Idle-with-work episode: notify once, then hold the flag until the episode
    // ends (busy, no work, or a store error), when it is cleared so a later
    // episode notifies again.
    if (decision.shouldNotify) {
      if (!row.idleNotifiedAt) {
        pendingNotify = true;
        patch.idleNotifiedAt = at;
      }
    } else if (row.idleNotifiedAt) {
      patch.idleNotifiedAt = '';
    }
    // Loop guard: park every stuck ready todo and, when nothing eligible is
    // left, park the watcher itself in `stopReason`. The blocked flips happen
    // after this lock commits (the todos store has its own lock, never nested).
    const loop = planWorkspaceWatcherLoopGuard({ mode: row.mode, row, snapshot, decision });
    let appliedStopReason = '';
    if (loop.parkTodoIds.length) {
      pendingPark = loop.parkTodoIds;
      if (loop.clearFindingsTodoIds.length) {
        const byTodo = { ...(row.findings?.byTodo || {}) };
        for (const todoId of loop.clearFindingsTodoIds) delete byTodo[todoId];
        patch.findings = { byTodo };
      }
      if (loop.stopReason) {
        patch.stopReason = loop.stopReason;
        appliedStopReason = loop.stopReason;
      }
    }
    const stateNotify = planWorkspaceWatcherStateNotify(row, decision, appliedStopReason);
    // Dead container: `doing` parent whose open children are all `idea`. One
    // "Why?" entry and one push per episode (container + child-set signature).
    const deadContainers = findWorkspaceWatcherDeadContainers(snapshot.items);
    const deadSig = deadContainerSignature(deadContainers);
    const notifiedNext = { ...(stateNotify.nextNotified || row.notified || {}) };
    if (deadSig) {
      if (notifiedNext.dead_container !== deadSig) {
        notifiedNext.dead_container = deadSig;
        const lines = deadContainers.map((c) => `${c.id.slice(0, 8)} "${c.title}" -> ${c.idleChildren.map((k) => `"${k.title}"`).join(', ')}`);
        stateNotify.messages.push({
          kind: 'dead_container',
          body: `Doing container has only idea children: ${lines.join('; ')}`,
        });
        patch.decisions = [
          ...(patch.decisions || row.decisions),
          {
            at,
            kind: WORKSPACE_WATCHER_DEAD_CONTAINER,
            reason: WORKSPACE_WATCHER_DEAD_CONTAINER,
            readyTodoCount: decision.readyTodoCount,
            activeAgentCount: decision.activeAgentCount,
            scoutAgentCount: decision.scoutAgentCount,
            unknownAgentCount: decision.unknownAgentCount,
            shouldNotify: false,
            nextTodoId: deadContainers[0].id,
          },
        ];
        stateNotify.nextNotified = notifiedNext;
      }
      pendingAutoReady = planDeadContainerAutoReady(snapshot.items, row.policy);
    } else if (notifiedNext.dead_container) {
      notifiedNext.dead_container = '';
      stateNotify.nextNotified = notifiedNext;
    }
    if (stateNotify.nextNotified) patch.notified = stateNotify.nextNotified;
    pendingStateMessages = stateNotify.messages;
    // Lease-renewal throttle: a tick that only renews its own still-healthy
    // lease and moves `lastTickAt` is not persisted. The write is skipped only
    // while more than half of the TTL remains on the stored lease, so the lease
    // never lapses between persisted renewals and another process still cannot
    // take over a live lease. Any other patch key (decision, park, notify flag,
    // findings, ...) persists immediately.
    // Post-commit side effects (parks, auto-ready, pushes) also keep the tick
    // on the normal path.
    const hasSideEffects = pendingPark.length > 0 || pendingAutoReady.length > 0
      || pendingNotify || pendingStateMessages.length > 0;
    // `throttleLeaseRenewal: false` (degraded runtime fallback) keeps the
    // per-tick heartbeat write.
    if (options.throttleLeaseRenewal !== false && leaseAttempt.renewed && !hasSideEffects && isHeartbeatOnlyPatch(patch)) {
      const storedExpiry = Date.parse(String(row.lease?.expiresAt || ''));
      const effectiveTtl = Number.isFinite(ttlMs) && Number(ttlMs) > 0
        ? Number(ttlMs)
        : WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS;
      if (Number.isFinite(storedExpiry) && storedExpiry - now > effectiveTtl / 2) {
        heartbeatSkipped = true;
        return false;
      }
    }
    return patch;
  }, { dataDir, createIfMissing: false });

  if (mutateResult.ok) {
    const notify = typeof options.notify === 'function'
      ? options.notify
      : notifyWorkspaceWatcherDecision;
    // Park stuck todos first so a "stopped, nothing eligible" push describes
    // the state the operator finds, not a mid-park one.
    for (const todoId of pendingPark) {
      await markWorkspaceWatcherTodoBlocked({
        dataDir,
        workspaceFolder,
        todoId,
        at,
        notify: options.notify,
        notifyDeps: options.notifyDeps,
      });
    }
    for (const { childId, containerId } of pendingAutoReady) {
      try {
        const doc = await listTodos(dataDir, workspaceFolder);
        const child = (Array.isArray(doc?.items) ? doc.items : [])
          .find((r) => String(r?.id || '') === childId);
        if (child && String(child.status || '') === 'idea') {
          await withTodosWatcherNudgeSuppressed(() => updateTodo(dataDir, workspaceFolder, childId, {
            status: 'ready',
            expectedUpdatedAt: child.updatedAt,
            appendChangelog: { kind: 'note', text: `Watcher: auto-ready (dead container ${containerId.slice(0, 8)})` },
          }));
        }
      } catch {
        // CAS miss or store error: the next tick re-evaluates.
      }
    }
    if (pendingNotify) {
      const count = decision.readyTodoCount;
      notify({
        workspaceFolder,
        title: 'Cretli — workspace watcher',
        body: `Workspace is idle with ${count} ready todo${count === 1 ? '' : 's'}.`,
        tag: `cretli-watcher-${workspaceFolder}`,
        url: '/?panel=todos',
      }, options.notifyDeps || {});
    }
    for (const message of pendingStateMessages) {
      notify({
        workspaceFolder,
        title: 'Cretli — workspace watcher',
        body: message.body,
        tag: `cretli-watcher-${message.kind}-${workspaceFolder}`,
        url: '/?panel=todos',
      }, options.notifyDeps || {});
    }
    // Live feed into the durable pinned chat. Decisions are already deduped by
    // `shouldRecordDecision`, so the feed carries signal, not a per-tick spam.
    const noticeDeps = options.noticeDeps || {};
    if (recorded) {
      void appendWorkspaceWatcherNotice({
        workspaceFolder,
        dataDir,
        action: 'decision',
        level: decision.kind === 'snapshot_error' ? 'error' : 'info',
        text: describeWorkspaceWatcherDecision(decision),
        todoId: decision.nextTodoId,
        at,
        deps: noticeDeps,
      });
    }
    if (pendingNotify) {
      void appendWorkspaceWatcherNotice({
        workspaceFolder,
        dataDir,
        action: 'idle_with_work',
        level: 'warn',
        text: `Workspace is idle with ${decision.readyTodoCount} ready todo${decision.readyTodoCount === 1 ? '' : 's'}.`,
        at,
        deps: noticeDeps,
      });
    }
    for (const message of pendingStateMessages) {
      void appendWorkspaceWatcherNotice({
        workspaceFolder,
        dataDir,
        action: message.kind,
        level: 'warn',
        text: message.body,
        todoId: message.kind === 'plan_approval' ? decision.nextTodoId : '',
        at,
        deps: noticeDeps,
      });
    }
    // A new decision line or a park changes what the "Why?" log and the todo
    // top bar show, so push it on the existing chat-list channel. A plain
    // heartbeat (only `lastTickAt` moved) stays silent.
    if (recorded || pendingPark.length > 0) {
      broadcastWorkspaceWatcherChanged({ workspaceFolder });
    }
  }
  if (!mutateResult.ok && heartbeatSkipped) {
    return {
      workspaceFolder,
      action: decision.kind,
      reason: decision.reason,
      shouldNotify: decision.shouldNotify,
      wrote: false,
      recorded: false,
      parked: pendingPark,
      decision,
      snapshot,
      watcher: existing,
    };
  }
  if (!mutateResult.ok) {
    if (mutateResult.reason === 'aborted') {
      return {
        workspaceFolder,
        action: abortedReason === 'mode_off' ? 'off' : 'lease_held',
        reason: abortedReason,
        shouldNotify: false,
        wrote: false,
        recorded: false,
        snapshot,
      };
    }
    return {
      workspaceFolder,
      action: mutateResult.reason === 'no_row' ? 'no_watcher' : 'cas_conflict',
      reason: mutateResult.reason || 'cas_conflict',
      shouldNotify: false,
      wrote: false,
      recorded: false,
      snapshot,
      decision,
    };
  }
  return {
    workspaceFolder,
    action: decision.kind,
    reason: decision.reason,
    shouldNotify: decision.shouldNotify,
    wrote: true,
    recorded,
    parked: pendingPark,
    decision,
    snapshot,
    watcher: mutateResult.row,
  };
}

/**
 * Heartbeat: run the tick for every `observe` row. `off` rows are skipped and
 * never written. Any per-workspace failure is captured, never rethrown, so a
 * broken watcher file cannot degrade the delegation runtime worker.
 *
 * @param {{
 *   dataDir?: string,
 *   workspaceFolders?: string[],
 *   now?: number,
 *   ownerPid?: number,
 *   token?: string,
 *   ttlMs?: number,
 *   throttleLeaseRenewal?: boolean,
 *   decisionDedupeMs?: number,
 *   deps?: Partial<ReturnType<typeof defaultWorkspaceWatcherSnapshotDeps>>,
 * }} [options]
 * @returns {Promise<{
 *   at: string,
 *   scanned: number,
 *   observed: number,
 *   wrote: number,
 *   decisions: Array<{ workspaceFolder: string, kind: string, reason: string, shouldNotify: boolean }>,
 *   errors: Array<{ workspaceFolder: string, code: string, message: string }>,
 * }>}
 */
export async function runWorkspaceWatcherHeartbeat(options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const dataDir = resolveDataDir(options);
  /** @type {{ at: string, scanned: number, observed: number, wrote: number, decisions: Array<{ workspaceFolder: string, kind: string, reason: string, shouldNotify: boolean }>, errors: Array<{ workspaceFolder: string, code: string, message: string }> }} */
  const result = {
    at: new Date(now).toISOString(),
    scanned: 0,
    observed: 0,
    wrote: 0,
    decisions: [],
    errors: [],
  };

  /** @type {Record<string, any>[]} */
  let rows = [];
  try {
    rows = loadWorkspaceWatchers({ dataDir });
  } catch (error) {
    result.errors.push({ workspaceFolder: '', ...describeError(error) });
    return result;
  }

  const allowedFolders = Array.isArray(options.workspaceFolders)
    ? new Set(options.workspaceFolders.map(normalizeWorkspaceFolder)) : null;
  for (const row of rows) {
    if (allowedFolders && !allowedFolders.has(normalizeWorkspaceFolder(row.workspaceFolder))) continue;
    result.scanned += 1;
    // Autopilot rows are driven by the async cycle runtime, not by this
    // observe-only pass, so they are not double-ticked here.
    if (String(row.mode || '') !== 'observe') continue;
    result.observed += 1;
    try {
      const tick = await tickWorkspaceWatcher({
        workspaceFolder: row.workspaceFolder,
        dataDir,
        now,
        ownerPid: options.ownerPid,
        token: options.token,
        ttlMs: options.ttlMs,
        decisionDedupeMs: options.decisionDedupeMs,
        throttleLeaseRenewal: options.throttleLeaseRenewal,
        deps: options.deps,
        notify: options.notify,
        notifyDeps: options.notifyDeps,
      });
      if (tick.wrote) result.wrote += 1;
      if (tick.recorded) {
        result.decisions.push({
          workspaceFolder: row.workspaceFolder,
          kind: tick.action,
          reason: tick.reason,
          shouldNotify: tick.shouldNotify,
        });
      }
      const probe = options.probeChatRunLiveness
        || options.deps?.probeChatRunLiveness
        || probeChatRunLiveness;
      observeWorkspaceTodoUnknownEscalations({
        dataDir,
        workspaceFolder: row.workspaceFolder,
        now,
        probeChatRunLiveness: probe,
        notify: options.notify || notifyWorkspaceWatcherDecision,
        notifyDeps: options.notifyDeps,
      });
    } catch (error) {
      result.errors.push({ workspaceFolder: row.workspaceFolder, ...describeError(error) });
    }
  }
  return result;
}

/**
 * Whether an active-cycle chat is still running. Unknown adapter state keeps
 * the cycle so we do not drop work on a restart ambiguity.
 *
 * A missing room (`state_missing` / `adapter_missing` on both the run-scoped
 * probe and the chat-scoped probe) is still "alive" here. Claim release and
 * boot reconcile depend on that. Autopilot reconcile applies its own grace
 * before it treats that pair as a dead orchestrator.
 *
 * @param {{ chatId?: string, runId?: string }} activeCycle
 * @param {(input: { chatId?: string, runId?: string }) => { known: boolean, busy: boolean, reason: string }} probe
 * @returns {boolean}
 */
export function isWorkspaceWatcherActiveCycleChatAlive(activeCycle, probe, now = Date.now()) {
  const chatId = String(activeCycle?.chatId ?? '').trim();
  if (!chatId) return false;
  const phase = String(activeCycle?.phase ?? '').trim().toLowerCase();
  const startDeadlineAt = Date.parse(String(activeCycle?.startDeadlineAt ?? '').trim());
  if (phase === 'starting' && Number.isFinite(startDeadlineAt) && now < startDeadlineAt) {
    return true;
  }
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
      // Durable acceptance without adapterRunId must not skip the chat-scoped
      // probe: only proven idle ends the cycle. The `starting` deadline already
      // returned true at the function head, so no extra check is needed here.
    }
  }
  const live = probe({ chatId, runId: runId || undefined });
  if (live.known === true && live.busy === true) return true;
  if (live.reason === 'chat_missing') return false;
  if (live.known === true && live.busy === false) return false;
  if (phase === 'starting' && Number.isFinite(startDeadlineAt) && now < startDeadlineAt) return true;
  return true;
}

/**
 * Stable identity of one active cycle. Reconcile compares it again inside the
 * write lock, so a cycle that was replaced after the liveness probe is never
 * cleared by a decision that was made about its predecessor.
 *
 * @param {{ chatId?: string, runId?: string, startedAt?: string, todoIds?: string[] } | null | undefined} cycle
 * @returns {string | null}
 */
function workspaceWatcherCycleIdentity(cycle) {
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) return null;
  const chatId = String(cycle.chatId ?? '').trim();
  const runId = String(cycle.runId ?? '').trim();
  const startedAt = String(cycle.startedAt ?? '').trim();
  const todoIds = (Array.isArray(cycle.todoIds) ? cycle.todoIds : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean)
    .sort();
  if (!chatId && !runId && !startedAt && !todoIds.length) return null;
  return JSON.stringify([chatId, runId, startedAt, todoIds]);
}

/**
 * Find the slot this reconcile decision was made about, inside the write lock.
 * `cycleId` is the durable handle; a v1 row without one falls back to the
 * identity hash so a replaced cycle is still answered with "not my cycle".
 *
 * @param {Record<string, any>} current
 * @param {Record<string, any>} expected
 * @param {string} expectedIdentity
 * @returns {Record<string, any> | null}
 */
function findReconciledCycleSlot(current, expected, expectedIdentity) {
  const expectedCycleId = String(expected?.cycleId ?? '').trim();
  return getWorkspaceWatcherActiveCycles(current).find((candidate) => (
    expectedCycleId
      ? candidate.cycleId === expectedCycleId
      : workspaceWatcherCycleIdentity(candidate) === expectedIdentity
  )) || null;
}

/**
 * Clear every interrupted cycle of one row, independently: a dead slot is
 * dropped while a live neighbour keeps its claim and the row lease.
 *
 * @param {Record<string, any>} row
 * @param {{
 *   probe: (input: { chatId?: string, runId?: string }) => { known: boolean, busy: boolean, reason: string },
 *   at: string,
 *   options: { dataDir?: string, now?: number, probeChatRunLiveness?: typeof probeChatRunLiveness },
 * }} context
 * @returns {boolean}
 */
function reconcileWorkspaceWatcherRow(row, context) {
  const workspaceFolder = String(row.workspaceFolder ?? '').trim();
  if (!workspaceFolder) return false;
  const cycles = getWorkspaceWatcherActiveCycles(row);
  if (!cycles.length) return false;
  let cleared = 0;
  for (const cycle of cycles) {
    if (reconcileWorkspaceWatcherCycleSlot(row, cycle, context)) cleared += 1;
  }
  return cleared > 0;
}

/**
 * Clear one interrupted cycle. The mutator re-checks the cycle identity it was
 * asked about and only releases the lease that was observed together with that
 * cycle, so a race after the probe cannot drop a newer cycle or its lease. A
 * cycle without a `chatId` cannot be probed and is treated as not alive.
 *
 * @param {Record<string, any>} row
 * @param {Record<string, any>} cycle
 * @param {Record<string, any>} context
 * @returns {boolean}
 */
function reconcileWorkspaceWatcherCycleSlot(row, cycle, context) {
  if (!cycle) return false;
  return withWorkspaceWatchersFileLock(
    () => reconcileWorkspaceWatcherCycleSlotLocked(row, cycle, context),
    { dataDir: context.options?.dataDir },
  );
}

/**
 * @param {Record<string, any>} row
 * @param {Record<string, any>} cycle
 * @param {Record<string, any>} context
 * @returns {boolean}
 */
function reconcileWorkspaceWatcherCycleSlotLocked(row, cycle, context) {
  const workspaceFolder = String(row.workspaceFolder ?? '').trim();
  if (!workspaceFolder) return false;
  const expectedCycle = workspaceWatcherCycleIdentity(cycle);
  const chatId = String(cycle.chatId ?? '').trim();
  const now = Number.isFinite(context.options?.now) ? Number(context.options.now) : Date.now();
  // Leaf R11 B: a slot reserved by a dead process and absent from the adapters
  // is not "unknown" — nothing of it survives a restart. Live-instance and
  // legacy (token-less) slots keep the conservative liveness rule.
  const currentInstanceId = String(context.options?.instanceId || '').trim() || getProcessInstance().instanceId;
  // Evaluated once per slot (each call may cost several adapter probes) and
  // reused for both the liveness shortcut and the close outcome below.
  const deadInstance = isWorkspaceWatcherCycleRestartInterrupted({
    cycle,
    probe: context.probe,
    currentInstanceId,
  });
  // A cycle whose orchestrator already reported `blocked` is terminal: older
  // builds deferred its close behind live children and left it hanging, so
  // boot reconcile closes it regardless of liveness or children.
  const reportedBlocked = isReportedBlockedCycle(cycle);
  if (!reportedBlocked && chatId && !deadInstance && isWorkspaceWatcherActiveCycleChatAlive(cycle, context.probe, now)) return false;
  const delegations = typeof context.loadDelegations === 'function'
    ? context.loadDelegations()
    : loadDelegationsReadonly(context.options?.dataDir ? { dataDir: context.options.dataDir } : {});
  if (!reportedBlocked && chatId && hasActiveWorkspaceWatcherCycleChildren(chatId, delegations)) return false;
  const dataDir = context.options?.dataDir;
  const todo = loadPrimaryTodoForWorkspaceWatcherCycle({ workspaceFolder, dataDir, cycle, row });
  const leafOutcomes = resolveWorkspaceWatcherCycleTodoOutcomesForClose({
    cycle,
    workspaceFolder,
    dataDir,
    reportedTodoIds: resolveReportedTodoIdsForCycle(row, cycle),
  });
  const todoId = String(cycle.todoIds?.[0] ?? '').trim();
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
    at: context.at,
  });
  const { closeOutcome, countIncompleteFailure, closeReason } = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle,
    row,
    todo,
    reportedOutcomeRaw: cycle.reportedOutcome,
    mcpErrorCode: readMcpOrchestratorRunErrorCode(cycle, context.probe),
    leafOutcomes,
    reviewGateUnsatisfied: reviewGate.unsatisfied,
    restartInterrupted: deadInstance,
  });
  let applied = false;
  /** @type {Record<string, any> | null} */
  let closedCycle = null;
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row: current }) => {
    const currentCycle = findReconciledCycleSlot(current, cycle, expectedCycle);
    if (!currentCycle) return false;
    if (workspaceWatcherCycleIdentity(currentCycle) !== expectedCycle) return false;
    const latestDelegations = typeof context.loadDelegations === 'function'
      ? context.loadDelegations()
      : loadDelegationsReadonly(context.options?.dataDir ? { dataDir: context.options.dataDir } : {});
    if (!reportedBlocked && chatId && hasActiveWorkspaceWatcherCycleChildren(chatId, latestDelegations)) return false;
    const reports = resolveDeferredWorkspaceWatcherReports(current.reports, currentCycle);
    applied = true;
    closedCycle = currentCycle;
    return buildWorkspaceWatcherCycleClosePatch({
      row: reports !== current.reports ? { ...current, reports } : current,
      cycle: currentCycle,
      outcome: closeOutcome,
      todoIds: currentCycle.todoIds,
      reports,
      now,
      at: context.at,
      decisionReason: closeReason,
      closeSource: 'reconcile',
      todo,
      workspaceFolder,
      dataDir,
      reviewWaits: reviewGate.reviewWaits || undefined,
      extraDecisions: reviewGate.extraDecisions,
    });
  }, context.options);
  if (result.ok !== true || !applied) return false;
  finalizeWorkspaceWatcherCycleMetric({
    ...buildWorkspaceWatcherCycleMetricCloseInput({
      cycle: closedCycle || cycle,
      workspaceFolder,
      closedAt: String(context.at || new Date(now).toISOString()),
      closeSource: 'reconcile',
      closeReason: closeReason,
      closeOutcome,
      reportedTodoIds: resolveReportedTodoIdsForCycle(row, cycle),
      leafOutcomes,
      blockedReasonCode: resolveWorkspaceWatcherCycleBlockedReasonCode({
        closeOutcome,
        closeReason,
        planOnly: (closedCycle || cycle)?.planOnly === true,
        planSaved: leafOutcomes?.planSaved === true,
        stopReason: row?.stopReason,
        todoOutcomes: leafOutcomes?.todoOutcomes,
      }),
      todo,
    }),
    dataDir,
    now,
  }, context.options);
  if (reviewGate.warn && todoId) {
    recordReviewGateWarning({ workspaceFolder, dataDir, todoId, chatId, state: reviewGate.gate?.state });
  }
  if (todoId && chatId && (reportedBlocked || !hasActiveWorkspaceWatcherCycleChildren(chatId, delegations))) {
    releaseWorkspaceWatcherCycleTodoClaim({
      workspaceFolder,
      todoId,
      chatId,
      cycleId: String(cycle.cycleId || ''),
      attemptId: String(todo?.execution?.attemptId || ''),
      dataDir,
      now,
    });
  }
  if (countIncompleteFailure && todoId) {
    notifyWorkspaceWatcherDecision({
      workspaceFolder,
      title: 'Cretli — workspace watcher',
      body: `Cycle ended without completing todo ${todoId.slice(0, 8)}. Failures increased; the todo may be skipped after repeated attempts.`,
      tag: `cretli-watcher-${workspaceFolder}`,
      url: '/?panel=todos',
    });
  }
  logDelegationEvent('workspace-watcher-cycle-closed', {}, {
    workspaceFolder,
    cycleId: String(cycle.cycleId || ''),
    chatId,
    source: 'boot_reconcile',
  });
  // Archive the orchestrator chat so stale cycles don't clutter the sidebar —
  // through the shared canArchive gate: terminal delegated children first, then
  // the parent, and nothing while a child still holds a slot or the parent is
  // pinned/unknown-idle. The gate re-checks cycle children at write time, so a
  // slot claimed after this reconcile read still blocks the archive.
  if (chatId) {
    try {
      archiveChatFamily(chatId, { now, deps: context.options?.orchestratorArchiveDeps || {} });
    } catch { /* best-effort */ }
  }
  return true;
}

/**
 * Diagnosis: the "database is locked" seen by concurrent boot reconciles comes
 * from the watcher store (workspace-watchers-persist.js), which deliberately
 * sets `PRAGMA busy_timeout = 0`; waiting is done by the `lockTimeoutMs` file
 * lock around writers. That lock only serialises writers that take it, so a
 * reconcile pass on instance A can still hit SQLite's immediate SQLITE_BUSY while
 * instance B holds the write transaction outside that wait window. The row pass
 * is idempotent, so a bounded retry with short jittered backoff is safe.
 */
const SQLITE_BUSY_MAX_ATTEMPTS = 5;

/** @param {unknown} error */
function isSqliteBusyError(error) {
  const code = String(/** @type {{ code?: unknown }} */ (error)?.code || '');
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /SQLITE_BUSY|SQLITE_LOCKED/i.test(code) || /database is locked|SQLITE_BUSY/i.test(message);
}

/**
 * @template T
 * @param {() => T} fn
 * @param {{ attempts?: number, sleepMs?: (ms: number) => void }} [opts]
 * @returns {T}
 */
export function retryOnSqliteBusy(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts || SQLITE_BUSY_MAX_ATTEMPTS);
  const sleep = opts.sleepMs || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (attempt >= attempts || !isSqliteBusyError(error)) throw error;
      sleep(10 + Math.floor(Math.random() * 40));
    }
  }
}

/**
 * Async variant of {@link retryOnSqliteBusy}: the attempt may await the todos
 * facade. Retries use a timer instead of blocking the event loop.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, sleepMs?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function retryOnSqliteBusyAsync(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts || SQLITE_BUSY_MAX_ATTEMPTS);
  const sleep = opts.sleepMs || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isSqliteBusyError(error)) throw error;
      await sleep(10 + Math.floor(Math.random() * 40));
    }
  }
}

/**
 * After restart, clear stale active cycles and release leases when the cycle
 * chat is confirmed idle or missing.
 *
 * The watcher store is optional: a corrupt or unreadable `workspace-watchers.json`
 * is reported in `errors` and never rethrown, so a damaged watcher file cannot
 * degrade the delegation boot. The corrupt bytes are left untouched — the
 * operator decides whether to repair them.
 *
 * @param {{
 *   dataDir?: string,
 *   now?: number,
 *   probeChatRunLiveness?: typeof probeChatRunLiveness,
 *   scoutArchiveDeps?: Record<string, any>,
 *   orchestratorArchiveDeps?: Record<string, any>,
 *   deferCycleUsage?: boolean,
 * }} [options]
 * @returns {Promise<{ reconciled: number, workspaces: string[], errors: Array<{ workspaceFolder: string, code: string, message: string }>, finalizeCycleUsage?: () => Promise<Record<string, any> | null> }>}
 */
export async function reconcileWorkspaceWatchersOnBoot(options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  const at = new Date(now).toISOString();
  const functionStartedAt = Date.now();
  /** Logs a boot step that blocks the event loop for more than 500 ms. */
  const timed = (step, workspaceFolder, fn) => {
    const startedAt = Date.now();
    try { return fn(); } finally {
      const ms = Date.now() - startedAt;
      if (ms > 500) logDelegationEvent('workspace-watcher-reconcile-slow-step', {}, { step, workspaceFolder, ms });
    }
  };
  /** Async twin of `timed` for steps that await the todos facade. */
  const timedAsync = async (step, workspaceFolder, fn) => {
    const startedAt = Date.now();
    try { return await fn(); } finally {
      const ms = Date.now() - startedAt;
      if (ms > 500) logDelegationEvent('workspace-watcher-reconcile-slow-step', {}, { step, workspaceFolder, ms });
    }
  };
  /** @type {string[]} */
  const workspaces = [];
  /** @type {Array<{ workspaceFolder: string, code: string, message: string }>} */
  const errors = [];
  /** @type {Record<string, any>[]} */
  let rows;
  try {
    rows = timed('load-rows', '', () => loadWorkspaceWatchers(options));
  } catch (error) {
    const described = describeError(error);
    errors.push({ workspaceFolder: '', ...described });
    logDelegationEvent('workspace-watcher-reconcile-error', {}, { scope: 'load', ...described });
    return { reconciled: 0, workspaces, errors };
  }
  const loadDelegationsFn = typeof options.loadDelegations === 'function'
    ? options.loadDelegations
    : () => loadDelegationsReadonly(options?.dataDir ? { dataDir: options.dataDir } : {});
  for (const row of rows) {
    try {
      await retryOnSqliteBusyAsync(async () => {
        if (timed('row', row.workspaceFolder, () => reconcileWorkspaceWatcherRow(row, {
          probe,
          at,
          options,
          loadDelegations: loadDelegationsFn,
        })) && !workspaces.includes(row.workspaceFolder)) {
          // A retried attempt must not list the same workspace twice.
          workspaces.push(row.workspaceFolder);
        }
        // Repair review-gate markers (prune, label, orphan claim) idempotently.
        timed('review-waits', row.workspaceFolder, () => reconcileWorkspaceWatcherReviewWaits({
          workspaceFolder: row.workspaceFolder,
          dataDir: options.dataDir,
        }));
        // A restart can leave a todo claimed by a chat that no longer exists.
        // Only autopilot rows own watcher claims, so this is scoped to them.
        if (String(row.mode || '') === 'autopilot') {
          await timedAsync('stale-claims', row.workspaceFolder, () => releaseStaleWorkspaceTodoClaims({
            workspaceFolder: row.workspaceFolder,
            dataDir: options.dataDir,
            probeChatRunLiveness: probe,
          }));
        }
        // Settle durable Scout attempts against real liveness before the archive
        // sweep: a crashed reservation refunds once, a confirmed-idle launched
        // scan releases, and busy/unknown stays occupied across the restart.
        timed('scout-scans', row.workspaceFolder, () => reconcileScoutScans(row.workspaceFolder, {
          dataDir: options.dataDir,
          now,
          deps: {
            probeChatRunLiveness: probe,
            ...(options.scoutReconcileDeps || {}),
          },
        }));
        // Clear expired never-launched reservations so boot does not leave stale
        // `activeScoutScans` records until the next heartbeat.
        timed('scout-expire', row.workspaceFolder, () => expireStaleActiveScoutScan(row.workspaceFolder, { dataDir: options.dataDir, now }));
        // A restart re-applies the idle-Scout archive sweep without running a
        // scan. It stays conservative: a post-restart run state that the adapter
        // cannot confirm idle is not archived, so nothing still-busy is hidden.
        timed('scout-archive', row.workspaceFolder, () => archiveIdleScoutChats(row.workspaceFolder, {
          now,
          deps: options.scoutArchiveDeps || {},
        }));
      });
    } catch (error) {
      const described = describeError(error);
      errors.push({ workspaceFolder: row.workspaceFolder, ...described });
      logDelegationEvent('workspace-watcher-reconcile-error', {}, {
        workspaceFolder: row.workspaceFolder,
        ...described,
      });
    }
  }
  // Archive any orchestrator chats from already-closed cycles. Finished cycles
  // are logged in cycleChats; active cycles list their chatId in activeCycles.
  // Anything in cycleChats but not in activeCycles is done and should be hidden.
  // Shared with the live autopilot pass so boot and runtime stay in lockstep.
  try {
    timed('closed-cycle-sweep', '', () => sweepClosedWorkspaceWatcherCycles({
      dataDir: options.dataDir,
      now,
      rows,
      deps: options.orchestratorArchiveDeps || {},
    }));
  } catch { /* best-effort bulk archive */ }
  // Retention of integrated/rejected worktree results (24 h), freed space logged.
  try {
    const pruned = timed('prune-worktree-results', '', () => pruneWorktreeResults({ dataDir: resolveDataDir(options), now }));
    if (pruned.removed.length) logDelegationEvent('worktree-results-pruned', {}, { removed: pruned.removed.length, freedBytes: pruned.freedBytes });
  } catch { /* best-effort retention */ }
  // Finalize the usage of closed cycles whose 24 h grace has elapsed. This also
  // recovers a process that restarted during finalization: the write is a
  // one-shot idempotent record, so a retry either completes it or replays it.
  // With `deferCycleUsage` the caller runs it later in the background (chunked,
  // after runtime-ready) through the returned `finalizeCycleUsage`.
  const usageOptions = {
    dataDir: options.dataDir,
    now,
    events: options.cycleUsageEvents,
    delegations: options.cycleUsageDelegations,
    graceMs: options.cycleUsageGraceMs,
    retentionMs: options.cycleUsageRetentionMs,
  };
  const finalizeCycleUsage = async () => {
    const startedAt = Date.now();
    try {
      const result = await finalizeDueWorkspaceWatcherCycleUsageChunked(usageOptions, options.cycleUsageDeps || {});
      logDelegationEvent('workspace-watcher-cycle-usage-background', {}, { ...result, ms: Date.now() - startedAt });
      return result;
    } catch { return null; /* best-effort usage finalization */ }
  };
  if (!options.deferCycleUsage) {
    try {
      timed('cycle-usage-finalize', '', () => finalizeDueWorkspaceWatcherCycleUsage(usageOptions, options.cycleUsageDeps || {}));
    } catch { /* best-effort usage finalization */ }
  }
  const totalMs = Date.now() - functionStartedAt;
  if (totalMs > 500) logDelegationEvent('workspace-watcher-reconcile-total', {}, { rows: rows.length, ms: totalMs });
  return { reconciled: workspaces.length, workspaces, errors, finalizeCycleUsage };
}

/**
 * Whether a todo claim is still backed by a live chat. Reuses the active-cycle
 * liveness rule: a busy or unknown chat keeps the claim, a confirmed-idle or
 * missing chat drops it. A todo without `claimedByChatId` carries no watcher
 * claim, so there is nothing to keep alive.
 *
 * @param {{ claimedByChatId?: string } | null | undefined} claim
 * @param {(input: { chatId?: string, runId?: string }) => { known: boolean, busy: boolean, reason: string }} probe
 * @returns {boolean}
 */
export function isWorkspaceTodoClaimAlive(claim, probe) {
  const chatId = String(claim?.claimedByChatId ?? '').trim();
  if (!chatId) return false;
  return isWorkspaceWatcherActiveCycleChatAlive({ chatId }, probe);
}

/**
 * Atomically claim one todo: flip to `doing` and stamp claimedByChatId +
 * claimedAt under the store's `expectedUpdatedAt` CAS. When two callers race on
 * the same todo, the loser sees a stale token and gets `cas_conflict` instead of
 * silently overwriting the winner.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   todoId?: unknown,
 *   claimedByChatId?: unknown,
 *   expectedUpdatedAt?: unknown,
 *   ttlMs?: number,
 *   dataDir?: string,
 *   now?: number,
 *   cycleId?: unknown,
 *   source?: unknown,
 * }} [options]
 * @returns {Promise<{ claimed: boolean, reason: string, todoId?: string, item?: Record<string, any>|null, error?: Record<string, any>, replay?: boolean }>}
 */
export async function claimWorkspaceTodo(options = {}) {
  const workspaceFolder = String(options.workspaceFolder ?? '');
  const todoId = String(options.todoId ?? '').trim();
  const claimedByChatId = String(options.claimedByChatId ?? '').trim();
  if (!workspaceFolder.trim()) return { claimed: false, reason: 'no_workspace' };
  if (!todoId) return { claimed: false, reason: 'no_todo' };
  if (!claimedByChatId) return { claimed: false, reason: 'no_claimer' };
  const dataDir = resolveDataDir(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const expectedUpdatedAt = String(options.expectedUpdatedAt ?? '').trim();
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Math.min(options.ttlMs, 86_400_000) : WORKSPACE_TODO_CLAIM_TTL_MS;
  /** @type {Record<string, unknown>} */
  const patch = {
    status: 'doing',
    strictStatus: true,
    claimedByChatId,
    claimedAt: new Date(now).toISOString(),
    claimLeaseUntil: new Date(now + ttlMs).toISOString(),
  };
  if (expectedUpdatedAt) patch.expectedUpdatedAt = expectedUpdatedAt;
  const cycleId = String(options.cycleId ?? '').trim();
  try {
    // No watcher-document lock here: the claim reads and writes only the todo,
    // and the `expectedUpdatedAt` CAS inside the todo write is its arbiter. A
    // lock held across the awaited facade call would invert the 40 -> 50 order.
    {
      const current = await listTodos(dataDir, workspaceFolder);
      const item = current.items.find((row) => row.id === todoId);
      if (!item) return { claimed: false, reason: 'not_found', todoId };
      // Idempotent replay: the same cycle asking again (a lost response after
      // an accepted claim) gets its own claim back instead of a second attempt.
      if (cycleId && item.status === 'doing' && item.claimedByChatId === claimedByChatId
        && String(item.execution?.cycleId ?? '') === cycleId) {
        return { claimed: true, reason: 'already_claimed', todoId, item, replay: true };
      }
      if (expectedUpdatedAt && item.updatedAt !== expectedUpdatedAt) return { claimed: false, reason: 'cas_conflict', todoId };
      if (item.status !== 'ready') return { claimed: false, reason: 'not_ready', todoId };
      if (item.claimedByChatId) return { claimed: false, reason: 'already_claimed', todoId };
      if (!listReadyTodoLeaves(current.items).some((row) => row.id === todoId)) return { claimed: false, reason: 'blocked', todoId };
      patch.expectedUpdatedAt = item.updatedAt;
      const attemptId = randomUUID();
      const { previous: _older, ...lastAttempt } = item.execution || {};
      patch.execution = {
        attemptId,
        key: `${todoId}:${cycleId || attemptId}`,
        todoRevision: String(item.updatedAt || ''),
        source: String(options.source ?? '').trim() || WORKSPACE_TODO_EXECUTION_SOURCES.WATCHER_CLAIM,
        chatId: claimedByChatId,
        cycleId,
        phase: 'claimed',
        at: patch.claimedAt,
        ...(lastAttempt.attemptId ? { previous: lastAttempt } : {}),
      };
      const doc = await withTodosWatcherNudgeSuppressed(() => updateTodo(dataDir, workspaceFolder, todoId, patch));
      return { claimed: true, reason: 'claimed', todoId, item: doc.items.find((row) => row.id === todoId) || null };
    }
  } catch (error) {
    const described = describeError(error);
    if (described.code === 'CONFLICT') return { claimed: false, reason: 'cas_conflict', todoId };
    if (described.code === 'NOT_FOUND') return { claimed: false, reason: 'not_found', todoId };
    return { claimed: false, reason: 'claim_failed', todoId, error: described };
  }
}

/**
 * Whether the watcher may release `doing` rows that carry no claim. Only an
 * unpaused, unstopped autopilot automates that; `off` and `observe` report.
 *
 * @param {Record<string, any> | null | undefined} watcher
 * @returns {boolean}
 */
function canWorkspaceWatcherRecoverUnclaimed(watcher) {
  if (!watcher || String(watcher.mode || '') !== 'autopilot') return false;
  if (watcher.enabled === false || watcher.paused === true) return false;
  return !String(watcher.stopReason || '').trim();
}

/**
 * Release work whose executor is confirmed gone so a crashed orchestrator
 * cannot hide a todo forever.
 *
 * Every `doing` row is classified (see workspace-watcher-recovery.js) and only
 * a `recoverable` one is released: a confirmed idle/missing executor with no
 * occupied delegation slot. `active`, `dependency`, `user_action` and `unknown`
 * rows are left untouched, so an unknown chat state, a transport error, a
 * missing execution identity or an expired `claimLeaseUntil` never frees work.
 * A `doing` row without a claim is released only by an unpaused autopilot.
 *
 * The release is fenced: the decision is re-validated under the store lock
 * against the todo revision and the attempt id it was made about, and the
 * delegation slots and liveness are probed again there, so a start between the
 * probe and the write cannot be overwritten.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   now?: number,
 *   probeChatRunLiveness?: typeof probeChatRunLiveness,
 *   getChat?: (chatId: string) => Record<string, any> | null,
 *   loadDelegations?: () => Record<string, any>[],
 * }} [options]
 * @returns {Promise<{
 *   released: string[],
 *   errors: Array<Record<string, unknown>>,
 *   states: ReturnType<typeof classifyWorkspaceDoingTodos>,
 *   skipped: Array<{ todoId: string, reason: string }>,
 * }>}
 */
export async function releaseStaleWorkspaceTodoClaims(options = {}) {
  return timeJobAsync('releaseStaleWorkspaceTodoClaims', () => releaseStaleWorkspaceTodoClaimsUntimed(options));
}

/** Minimum gap between periodic stale-claim sweeps per workspace. */
export const RELEASE_STALE_CLAIMS_MIN_INTERVAL_MS = 60_000;
/** @type {Map<string, number>} */
const lastStaleClaimSweepAt = new Map();

/**
 * Decision-log entry for an ownerless `doing` leaf returned to `ready`
 * (the changelog note is written by the recover path itself). Best-effort.
 *
 * @param {string} workspaceFolder
 * @param {string} dataDir
 * @param {string} todoId
 * @param {number} now
 */
function recordOrphanDoingReleaseDecision(workspaceFolder, dataDir, todoId, now) {
  try {
    mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
      decisions: [...row.decisions, {
        at: new Date(now).toISOString(),
        kind: 'orphan_doing_released',
        reason: `Todo ${todoId.slice(0, 8)} was doing with no owner; released to ready.`,
        readyTodoCount: 0,
        activeAgentCount: 0,
        shouldNotify: false,
        nextTodoId: todoId,
      }].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
    }), { dataDir, createIfMissing: false });
  } catch { /* decision log is best-effort */ }
}

/**
 * Periodic-tick variant of {@link releaseStaleWorkspaceTodoClaims}: runs at most
 * once per `minIntervalMs` per workspace (default 60 s) instead of on every
 * watcher tick. Returns null when the sweep was skipped. Direct callers that
 * need an immediate sweep keep using the unthrottled function.
 *
 * @param {Parameters<typeof releaseStaleWorkspaceTodoClaims>[0] & { minIntervalMs?: number }} [options]
 * @returns {Promise<Awaited<ReturnType<typeof releaseStaleWorkspaceTodoClaims>>> | null}
 */
export function releaseStaleWorkspaceTodoClaimsThrottled(options = {}) {
  const key = `${resolveDataDir(options)}\u0000${String(options.workspaceFolder ?? '')}`;
  const at = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? Number(options.minIntervalMs) : RELEASE_STALE_CLAIMS_MIN_INTERVAL_MS;
  const last = lastStaleClaimSweepAt.get(key);
  if (last !== undefined && at >= last && at - last < minIntervalMs) {
    recordJobTiming('releaseStaleWorkspaceTodoClaims', { durationMs: 0, skipped: true });
    return null;
  }
  lastStaleClaimSweepAt.set(key, at);
  return releaseStaleWorkspaceTodoClaims(options);
}

export function resetStaleClaimSweepThrottle() {
  lastStaleClaimSweepAt.clear();
}

async function releaseStaleWorkspaceTodoClaimsUntimed(options = {}) {
  const workspaceFolder = String(options.workspaceFolder ?? '');
  if (!workspaceFolder.trim()) return { released: [], errors: [], states: [], skipped: [] };
  const dataDir = resolveDataDir(options);
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  /** @type {string[]} */
  const released = [];
  /** @type {Array<Record<string, unknown>>} */
  const errors = [];
  /** @type {Array<{ todoId: string, reason: string }>} */
  const skipped = [];
  // A corrupt or unreadable watcher store is unknown state, not "no cycles":
  // nothing is released and the damaged file is left for the operator.
  /** @type {Record<string, any> | null} */
  let watcher = null;
  try {
    watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  } catch (error) {
    return { released, errors: [{ scope: 'watcher', ...describeError(error) }], states: [], skipped };
  }
  const loadDelegationRows = typeof options.loadDelegations === 'function'
    ? options.loadDelegations
    : () => loadDelegationsReadonly({ dataDir });
  // One delegation read per pass: classify, the unknown-escalation scan and the
  // stale-claim sweep each loaded all rows (~4.5k), which dominated the idle
  // heartbeat. A recovery below can change rows, so it drops the copy.
  /** @type {Record<string, any>[] | null} */
  let delegationRows = null;
  const readDelegations = () => {
    if (!delegationRows) delegationRows = loadDelegationRows() || [];
    return delegationRows;
  };
  const getChat = typeof options.getChat === 'function' ? options.getChat : loadWorkspaceWatcherChatRow;
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const recoverIdleOpenChat = policy.recoverIdleOpenChat === true;
  const classify = (todoItems) => classifyWorkspaceDoingTodos({
    items: todoItems,
    delegations: readDelegations(),
    cycles: getWorkspaceWatcherActiveCycles(getWorkspaceWatcher(workspaceFolder, { dataDir })),
    probe,
    isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
    getChat,
    now,
    recoverIdleOpenChat,
    hasLiveWorktree: buildLiveWorktreePredicate(dataDir),
    closedCycles: /** @type {any} */ (getWorkspaceWatcher(workspaceFolder, { dataDir }))?.cycleChats,
    readWorktreeRecord: buildWorktreeRecordReader(dataDir),
    reviewWaits: getWorkspaceWatcher(workspaceFolder, { dataDir })?.reviewWaits,
    reviewPolicy: policy,
  });
  /** @type {Record<string, any>[]} */
  let items = [];
  /** @type {ReturnType<typeof classifyWorkspaceDoingTodos>} */
  let states = [];
  try {
    const doc = await listTodos(dataDir, workspaceFolder);
    items = Array.isArray(doc?.items) ? doc.items : [];
    states = classify(items);
  } catch (error) {
    return { released, errors: [{ scope: 'todos', ...describeError(error) }], states: [], skipped };
  }
  const recoverUnclaimed = canWorkspaceWatcherRecoverUnclaimed(watcher);
  for (const state of states) {
    if (state.state !== 'recoverable') continue;
    if (!state.claimed && !recoverUnclaimed) {
      skipped.push({ todoId: state.todoId, reason: 'watcher_not_autopilot' });
      continue;
    }
    const todoId = state.todoId;
    const idempotencyKey = `autopilot-release:${state.attemptId || todoId}:${state.revision}`;
    const result = recoverWorkspaceWatcherTodo({
      dataDir,
      workspaceFolder,
      todoId,
      expectedUpdatedAt: state.revision,
      idempotencyKey,
      source: 'autopilot',
      now,
      probeChatRunLiveness: probe,
      getChat,
      loadDelegations: loadDelegationRows,
    });
    delegationRows = null;
    if (result.ok && result.outcome === 'released') {
      released.push(todoId);
      if (state.reason === 'orphan_doing_idle') recordOrphanDoingReleaseDecision(workspaceFolder, dataDir, todoId, now);
    } else skipped.push({ todoId, reason: result.outcome });
    if (result.error && result.outcome === 'api-error') errors.push({ todoId, ...result.error });
  }
  try {
    observeWorkspaceTodoUnknownEscalations({
      dataDir,
      workspaceFolder,
      now,
      probeChatRunLiveness: probe,
      getChat,
      loadDelegations: readDelegations,
      notify: options.notify || notifyWorkspaceWatcherDecision,
      notifyDeps: options.notifyDeps,
    });
  } catch { /* best-effort */ }
  // A claim left on a row that is no longer `doing` (finished, or moved back by
  // hand) holds no work; drop it once its owner is confirmed not alive.
  const delegations = readDelegations();
  const cycles = getWorkspaceWatcherActiveCycles(watcher);
  for (const row of items) {
    if (row.status === 'doing' || !String(row.claimedByChatId ?? '').trim()) continue;
    const todoId = String(row.id ?? '').trim();
    if (!todoId) continue;
    if (row.status !== 'done') {
      const ownerCycle = cycles.find((cycle) => cycle.chatId && cycle.chatId === row.claimedByChatId) || null;
      if (ownerCycle && isWorkspaceWatcherActiveCycleChatAlive(ownerCycle, probe, now)) continue;
      if (delegations.some((child) => delegationController(child) === row.claimedByChatId && isDelegationSlotOccupied(child, now))) continue;
      if (isWorkspaceTodoClaimAlive(row, probe)) continue;
    }
    try {
      await withTodosWatcherNudgeSuppressed(() => updateTodo(dataDir, workspaceFolder, todoId, {
        strictStatus: true,
        claimedByChatId: null,
        claimedAt: null,
        expectedUpdatedAt: row.updatedAt,
      }));
      released.push(todoId);
    } catch (error) {
      const described = describeError(error);
      if (described.code === 'CONFLICT') continue;
      errors.push({ todoId, ...described });
    }
  }
  return { released, errors, states, skipped };
}

/**
 * The explicit "take the next todo" entry point for a workspace. It is a
 * function, not a heartbeat: the observe tick only logs a candidate, so this is
 * the only path that flips a todo to `doing`. Order: expire dead claims, pick
 * the next ready leaf, then claim it atomically under the picked `updatedAt`.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   claimedByChatId?: unknown,
 *   dataDir?: string,
 *   now?: number,
 *   maxFailures?: number,
 *   releaseStaleClaims?: boolean,
 *   probeChatRunLiveness?: typeof probeChatRunLiveness,
 *   cycleId?: unknown,
 * }} [options]
 * @returns {Promise<{ claimed: boolean, reason: string, todoId?: string, item?: Record<string, any>|null, error?: Record<string, any> }>}
 */
export async function claimNextWorkspaceTodo(options = {}) {
  const workspaceFolder = String(options.workspaceFolder ?? '');
  const claimedByChatId = String(options.claimedByChatId ?? '').trim();
  if (!workspaceFolder.trim()) return { claimed: false, reason: 'no_workspace' };
  if (!claimedByChatId) return { claimed: false, reason: 'no_claimer' };
  const dataDir = resolveDataDir(options);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const failures = watcher?.failures && typeof watcher.failures === 'object' ? watcher.failures : {};
  const maxFailures = resolveMaxFailures(watcher, options.maxFailures);
  if (options.releaseStaleClaims !== false) {
    await releaseStaleWorkspaceTodoClaims({
      dataDir,
      workspaceFolder,
      now,
      probeChatRunLiveness: options.probeChatRunLiveness,
    });
  }
  /** @type {Record<string, any>[]} */
  let items = [];
  try {
    const doc = await listTodos(dataDir, workspaceFolder);
    items = Array.isArray(doc?.items) ? doc.items : [];
  } catch (error) {
    return { claimed: false, reason: 'load_failed', error: describeError(error) };
  }
  const picked = pickNextWorkspaceReadyTodo({
    items,
    failures,
    maxFailures,
    allowedHarnesses: watcher?.policy?.allowedHarnesses,
    policy: watcher?.policy,
    blockedBackoff: watcher?.blockedBackoff,
    lastServedByTree: watcher?.lastServedByTree,
    now,
  });
  if (!picked) return { claimed: false, reason: 'no_ready_work' };
  const cycleId = String(options.cycleId ?? '').trim();
  return claimWorkspaceTodo({
    dataDir,
    workspaceFolder,
    todoId: String(picked.id),
    claimedByChatId,
    expectedUpdatedAt: picked.updatedAt,
    now,
    ttlMs: options.ttlMs,
    ...(cycleId ? { cycleId } : {}),
  });
}

export { WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS, normalizeWorkspaceFolder };
// Re-exported here so callers that only know the watcher service can materialize
// the durable per-workspace chat without importing the pinned-chat module.
export { ensurePinnedChat };

/**
 * Manual reset of the orchestrator circuit breaker: drops cooldowns (all, or
 * one harness/model), the infra streaks and `infraBackoffUntil`. Clearing a
 * `stopReason` never does this; the operator resets the cooldown explicitly.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, harness?: string, model?: string, now?: number }} input
 * @returns {Record<string, any> | null}
 */
export function resetWorkspaceWatcherOrchestratorCooldown(input) {
  const harness = String(input.harness || '').trim().toLowerCase();
  const model = String(input.model || '').trim().toLowerCase();
  const at = new Date(Number.isFinite(input.now) ? Number(input.now) : Date.now()).toISOString();
  const result = mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row }) => {
    const matches = (entry) => !harness || (entry.harness === harness && (!model || entry.scope === 'harness' || entry.model === model));
    const streaks = Object.fromEntries(Object.entries(row.infraStreaks || {}).filter(([, entry]) => !matches(entry)));
    return {
      orchestratorCooldowns: (row.orchestratorCooldowns || []).filter((entry) => !matches(entry)),
      infraStreaks: streaks,
      infraBackoffUntil: Object.keys(streaks).length === 0 ? '' : row.infraBackoffUntil,
      decisions: [...row.decisions, {
        at,
        kind: 'orchestrator_cooldown_reset',
        reason: harness ? `manual reset of ${harness}${model ? `/${model}` : ''}` : 'manual reset of all orchestrator cooldowns',
        readyTodoCount: 0,
        activeAgentCount: 0,
        shouldNotify: false,
        nextTodoId: '',
      }].slice(-WORKSPACE_WATCHER_MAX_DECISIONS),
    };
  }, { dataDir: input.dataDir, createIfMissing: false });
  return result.ok ? result.row : null;
}
