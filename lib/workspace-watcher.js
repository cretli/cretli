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

import { randomUUID } from 'node:crypto';
import { resolveDataPath } from './runtime-paths.js';
import { listDelegationsForWorkspace, loadDelegations } from './persist/delegations-persist.js';
import { loadTodosData, updateTodo, withTodosWatcherNudgeSuppressed } from './persist/todos-persist.js';
import { loadChats } from './persist/chats-persist.js';
import { listReadyTodoLeaves, isTodoBranchBlocked } from './todo-tree.js';
import { isActiveDelegationStatus, isDelegationSlotOccupied } from './delegation-status.js';
import { logDelegationEvent } from './delegation-log.js';
import { normalizeDelegationWorkspaceKey } from './delegation-workspace-guard.js';
import { getChatRunState, lookupChatRunRequest, probeChatRunLiveness } from './chat-run-service.js';
import { listHarnessUsageLimits } from './harness-usage-limits.js';
import { broadcastPush, hasPushSubscriptions, isPushAvailable } from './push.js';
import { broadcastWorkspaceWatcherChanged } from './workspace-watcher-live.js';
import {
  appendWorkspaceWatcherNotice,
  ensurePinnedChat,
} from './workspace-watcher-pinned-chat.js';
import {
  WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS,
  WORKSPACE_WATCHER_NOTIFY_CHANNELS,
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
  readWorkspaceWatcherTodoFindings,
} from './workspace-watcher-guardrails.js';
import {
  buildWorkspaceWatcherCycleClosePatch,
  hasActiveWorkspaceWatcherCycleChildren,
  loadPrimaryTodoForWorkspaceWatcherCycle,
  releaseWorkspaceWatcherCycleTodoClaim,
  resolveDeferredWorkspaceWatcherReports,
  resolveWorkspaceWatcherCycleCloseOutcome,
} from './workspace-watcher-cycle-close.js';
import { archiveIdleScoutChats, expireStaleActiveScoutScan, reconcileScoutScans } from './workspace-watcher-scout.js';
import { archiveChatFamily } from './chat-archive-policy.js';
import { sweepClosedWorkspaceWatcherCycles } from './workspace-watcher-archive-sweep.js';
import { readMcpOrchestratorRunErrorCode } from './mcp/mcp-orchestrator-contract.js';
import {
  WORKSPACE_TODO_EXECUTION_SOURCES,
  classifyWorkspaceDoingTodos,
  summarizeWorkspaceTodoRecovery,
} from './workspace-watcher-recovery.js';
import {
  observeWorkspaceTodoUnknownEscalations,
  recoverWorkspaceWatcherTodo,
} from './workspace-watcher-todo-recover.js';

export const WORKSPACE_WATCHER_DECISION_DEDUPE_MS = 60_000;
/**
 * Claim lease duration written at claim time. Nothing renews this TTL; an expiry
 * alone never releases work (liveness is decided only by executor probes).
 */
export const WORKSPACE_TODO_CLAIM_TTL_MS = 30_000;

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
 *   broadcastPush?: (payload: object) => Promise<unknown>,
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
 * One-line, human-readable decision summary for the pinned chat feed.
 *
 * @param {object} decision
 * @returns {string}
 */
export function describeWorkspaceWatcherDecision(decision = {}) {
  const kind = String(decision.kind || 'unknown');
  const reason = String(decision.reason || '').trim();
  const ready = Math.max(0, Math.floor(Number(decision.readyTodoCount) || 0));
  const active = Math.max(0, Math.floor(Number(decision.activeAgentCount) || 0));
  const scout = Math.max(0, Math.floor(Number(decision.scoutAgentCount) || 0));
  const todoId = String(decision.nextTodoId || '').trim();
  const parts = [`Decision: ${kind}${reason ? ` (${reason})` : ''}`];
  if (ready) parts.push(`${ready} ready`);
  if (active) parts.push(`${active} active`);
  if (scout) parts.push(`${scout} scout`);
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
 * @returns {object[]}
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
 * @returns {object | null}
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
 * @returns {object}
 */
export function defaultWorkspaceWatcherSnapshotDeps(dataDir) {
  const dir = String(dataDir ?? '').trim();
  return {
    loadTodosData,
    listReadyTodoLeaves,
    isTodoBranchBlocked,
    getChatRunState,
    loadDelegations: () => loadDelegations(dir ? { dataDir: dir } : {}),
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
 * @returns {object[]}
 */
function safeListHarnessUsageLimitsForTick(dataDir) {
  try {
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
 * @param {object | null | undefined} watcher
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
 *   chatRows?: object[],
 *   delegations?: object[],
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
      const parent = String(row?.parentChatId ?? '').trim();
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
 * @returns {{
 *   workspaceFolder: string,
 *   at: string,
 *   readyTodoIds: string[],
 *   readyTodoCount: number,
 *   readyLeaves: object[],
 *   doingTodoIds: string[],
 *   doingStates: Array<{ todoId: string, state: string, reason: string, source: string, evidence: string, chatId: string, runId: string, cycleId: string, delegationId: string, attemptId: string, revision: string, claimed: boolean }>,
 *   recovery: Record<string, number>,
 *   doingTodoCount: number,
 *   blockedTodoIds: string[],
 *   blockedTodoCount: number,
 *   waitingChatIds: string[],
 *   waitingChatCount: number,
 *   recentErrors: object[],
 *   activeDelegationIds: string[],
 *   activeChatIds: string[],
 *   busyTokens: string[],
 *   unknownChatIds: string[],
 *   unknownChats: Array<{ chatId: string, reason: string }>,
 *   activeAgentCount: number,
 *   scoutAgentCount: number,
 *   unknownAgentCount: number,
 *   hasReadyWork: boolean,
 *   errors: Array<{ scope: string, code: string, message: string }>,
 * }}
 */
export function snapshotWorkspaceWatcher(options = {}) {
  const workspaceFolder = normalizeWorkspaceFolder(options.workspaceFolder);
  const workspaceMatchKey = delegationWorkspaceMatchKey(options.workspaceFolder);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const dataDir = resolveDataDir(options);
  const deps = { ...defaultWorkspaceWatcherSnapshotDeps(dataDir), ...(options.deps || {}) };
  /** @type {Array<{ scope: string, code: string, message: string }>} */
  const errors = [];
  /** @type {string[]} */
  let readyTodoIds = [];
  /** @type {object[]} */
  let readyLeaves = [];
  /** @type {object[]} */
  let items = [];
  let doingTodoIds = [];
  let blockedTodoIds = [];
  const waitingChatIds = new Set();
  const excludedCycleChildChatIds = new Set();
  const recentErrors = [];
  /** @type {string[]} */
  let activeDelegationIds = [];
  /** @type {object[]} */
  let workspaceDelegations = [];
  /** @type {object[]} */
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
    const doc = deps.loadTodosData(dataDir, workspaceFolder);
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
      if (excludedParents.has(String(row.parentChatId || '')) && row.childChatId) {
        excludedCycleChildChatIds.add(String(row.childChatId));
      }
      if (!excludedParents.has(String(row.parentChatId || ''))
        && String(row.status) === 'waiting_for_input' && row.childChatId) waitingChatIds.add(String(row.childChatId));
      for (const error of Array.isArray(row.errors) ? row.errors : []) {
        recentErrors.push({ ...error, delegationId: String(row.id || '') });
      }
    }
    const activeDelegations = workspaceDelegations
      .filter((row) => {
        if (excludedParents.has(String(row?.parentChatId ?? '').trim())) return false;
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
      const parentChatId = String(row?.parentChatId ?? '').trim();
      const childChatId = String(row?.childChatId ?? '').trim();
      if (parentChatId) inFlightChatIds.add(parentChatId);
      if (childChatId) inFlightChatIds.add(childChatId);
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
  const unknownTokens = new Set(unknownChatIds);

  // Recovery read model: what every `doing` row waits for and what proves it.
  // Computed, never persisted, and never a substitute for the todo status.
  /** @type {ReturnType<typeof classifyWorkspaceDoingTodos>} */
  let doingStates = [];
  try {
    const watcherRow = getWorkspaceWatcher(workspaceFolder, { dataDir });
    const recoverIdleOpenChat = watcherRow?.policy?.recoverIdleOpenChat === true;
    doingStates = classifyWorkspaceDoingTodos({
      items,
      delegations: workspaceDelegations,
      cycles: getWorkspaceWatcherActiveCycles(watcherRow),
      probe: deps.probeChatRunLiveness || probeChatRunLiveness,
      isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
      getChat: typeof deps.getChat === 'function' ? deps.getChat : loadWorkspaceWatcherChatRow,
      now,
      recoverIdleOpenChat,
    });
  } catch (error) {
    errors.push({ scope: 'recovery', ...describeError(error) });
  }

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
    unknownChatIds,
    unknownChats,
    activeAgentCount: busyTokens.size,
    scoutAgentCount: scoutTokens.size,
    unknownAgentCount: unknownTokens.size,
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
 * @param {object} watcher
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
 * Pure "next todo" pick. `listReadyTodoLeaves` already drops done/doing nodes
 * and every blocked leaf (unapproved parent plan, or a sequential group whose
 * earlier sibling is not done), so an already-claimed (doing) todo never
 * surfaces here. Prefer a compatible assignment, then sibling position and
 * oldest update, tie-breaking on id. Skip leaves at the failure ceiling.
 *
 * @param {{
 *   items?: object[],
 *   readyLeaves?: object[],
 *   failures?: Record<string, unknown>,
 *   maxFailures?: number,
 *   maxSameFindings?: number,
 *   findings?: { byTodo?: Record<string, { hash?: string, streak?: number }> },
 *   allowedHarnesses?: string[],
 * }} [input]
 * @returns {object | null}
 */
export function pickNextWorkspaceReadyTodo(input = {}) {
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
  const eligible = leaves
    .filter((row) => String(row?.id ?? '').trim())
    .filter((row) => toFailureCount(failures[String(row.id)]) < maxFailures)
    .filter((row) => {
      if (maxSameFindings <= 0) return true;
      const entry = readWorkspaceWatcherTodoFindings(findings, String(row.id));
      return !(entry.hash && entry.streak >= maxSameFindings);
    })
    .sort((a, b) => {
      const assignment = Number(assigned(b)) - Number(assigned(a));
      if (assignment) return assignment;
      const siblingOrder = (a.siblingIndex || 0) - (b.siblingIndex || 0);
      if (siblingOrder) return siblingOrder;
      const aKey = String(a.updatedAt ?? a.createdAt ?? '');
      const bKey = String(b.updatedAt ?? b.createdAt ?? '');
      if (aKey !== bKey) return aKey < bKey ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  return eligible[0] || null;
}

/**
 * Tokens that occupy `maxParallel`: live chat ids and `delegation:<id>` for a
 * delegation whose child chat is not known yet.
 *
 * @param {object} snapshot
 * @returns {string[]}
 */
function busySlotHolders(snapshot) {
  const tokens = Array.isArray(snapshot?.busyTokens) ? snapshot.busyTokens : [];
  /** @type {string[]} */
  const out = [];
  for (const token of tokens) {
    const id = String(token ?? '').trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Pure decision. In `observe` it only produces an observation; in `autopilot`
 * it also applies the guardrails and reports whether a cycle may start.
 *
 * @param {{ watcher?: object, snapshot?: object, now?: number, activeUsageLimits?: object[] }} [input]
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
  if (activeAgentCount >= maxParallel) {
    const slotHolders = busySlotHolders(snapshot);
    return {
      kind: 'wait_active',
      reason: 'max_parallel',
      shouldNotify: false,
      ...details,
      ...(slotHolders.length ? { slotHolders } : {}),
    };
  }
  if (unknownAgentCount > 0) {
    return { kind: 'wait_active', reason: 'unknown_liveness', shouldNotify: false, ...details };
  }
  if (readyTodoCount === 0) {
    return { kind: 'idle_no_work', reason: 'no_ready_work', shouldNotify: false, ...details };
  }
  const picked = pickNextWorkspaceReadyTodo({
    readyLeaves: Array.isArray(snapshot.readyLeaves) ? snapshot.readyLeaves : [],
    failures: watcher.failures,
    maxFailures: resolveMaxFailures(watcher),
    maxSameFindings: watcher.policy?.maxSameFindings,
    findings: watcher.findings,
    allowedHarnesses: watcher.policy?.allowedHarnesses,
  });
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
    return { kind: 'idle_no_work', reason: 'no_eligible_work', shouldNotify: false, ...details };
  }
  const guard = evaluateWorkspaceWatcherGuardrails({
    watcher,
    pickedTodo: picked,
    items: Array.isArray(snapshot.items) ? snapshot.items : [],
    now,
    activeUsageLimits: Array.isArray(input.activeUsageLimits) ? input.activeUsageLimits : [],
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
    ...details,
    nextTodoId,
  };
}

/**
 * @param {object} watcher
 * @param {object} decision
 * @param {number} now
 * @param {number} dedupeMs
 * @returns {boolean}
 */
function shouldRecordDecision(watcher, decision, now, dedupeMs) {
  const decisions = Array.isArray(watcher?.decisions) ? watcher.decisions : [];
  let last = null;
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    const entry = decisions[i];
    if (!entry || entry.kind !== decision.kind || entry.reason !== decision.reason) continue;
    last = entry;
    break;
  }
  if (!last) return true;
  if (dedupeMs <= 0) return true;
  const at = Date.parse(String(last.at || ''));
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
 *   row?: object,
 *   snapshot?: object,
 *   decision?: object,
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
 * @param {object} row
 * @param {object} decision
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
 *   notifyDeps?: object,
 * }} [input]
 * @returns {boolean} whether the todo was newly blocked (and thus pushed)
 */
export function markWorkspaceWatcherTodoBlocked(input = {}) {
  const workspaceFolder = String(input.workspaceFolder ?? '');
  const todoId = String(input.todoId ?? '').trim();
  if (!workspaceFolder.trim() || !todoId) return false;
  const dataDir = resolveDataDir(input);
  const reasonText = String(input.reasonText
    || 'Workspace Watcher parked this todo after repeated failed cycles or identical review findings.').trim();
  let marked = false;
  try {
    withTodosWatcherNudgeSuppressed(() => {
      const doc = loadTodosData(dataDir, workspaceFolder);
      const current = (Array.isArray(doc?.items) ? doc.items : [])
        .find((row) => String(row?.id || '') === todoId) || null;
      if (!current) return;
      if (String(current.status || '') === 'done') return;
      if (String(current.blockedReason || '').trim()) return;
      updateTodo(dataDir, workspaceFolder, todoId, {
        status: current.status,
        strictStatus: true,
        blockedReason: reasonText,
        expectedUpdatedAt: current.updatedAt,
        appendChangelog: { kind: 'note', chatId: String(input.chatId || '') || undefined, text: reasonText },
      });
      marked = true;
    });
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
    appendWorkspaceWatcherNotice({
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
 * A startable decision must not be logged as `start_cycle` while this row's own
 * slots are already full. External agents stay on `max_parallel`; this reason
 * names the cycles that are holding the cap.
 *
 * @param {object} row
 * @param {object} decision
 * @returns {object}
 */
function decisionForOccupiedWatcherSlots(row, decision) {
  const kind = String(decision?.kind || '');
  if (kind !== 'start_cycle' && kind !== 'plan_gate') return decision;
  const maxParallel = Math.max(1, Number(row?.policy?.maxParallel) || 1);
  const cycles = getWorkspaceWatcherActiveCycles(row);
  if (cycles.length < maxParallel) return decision;
  const slotChats = cycles.map((cycle) => ({
    chatId: String(cycle?.chatId || '').trim(),
    cycleId: String(cycle?.cycleId || '').trim(),
  })).filter((entry) => entry.chatId || entry.cycleId);
  return {
    ...decision,
    kind: 'wait_active',
    reason: 'cycle_active',
    shouldNotify: false,
    planOnly: false,
    slotChats,
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
 *   decisionDedupeMs?: number,
 *   deps?: Partial<ReturnType<typeof defaultWorkspaceWatcherSnapshotDeps>>,
 * }} [options]
 * @returns {{
 *   workspaceFolder: string,
 *   action: string,
 *   reason: string,
 *   shouldNotify: boolean,
 *   wrote: boolean,
 *   recorded: boolean,
 *   decision?: object,
 *   snapshot?: object,
 *   watcher?: object,
 * }}
 */
export function tickWorkspaceWatcher(options = {}) {
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
  const snapshot = snapshotWorkspaceWatcher({
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
    : safeListHarnessUsageLimitsForTick(dataDir);
  let decision = decisionForOccupiedWatcherSlots(
    existing,
    decideWorkspaceWatcherAction({ watcher: existing, snapshot, now, activeUsageLimits: usageLimits }),
  );
  if (decision.kind === 'snapshot_error') {
    logDelegationEvent('workspace-watcher-snapshot-error', {}, {
      workspaceFolder,
      errors: snapshot.errors,
    });
  }
  const dedupeMs = Number.isFinite(options.decisionDedupeMs)
    ? Number(options.decisionDedupeMs)
    : WORKSPACE_WATCHER_DECISION_DEDUPE_MS;
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
  let abortedReason = 'lease_held';
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
    decision = decisionForOccupiedWatcherSlots(
      row,
      decideWorkspaceWatcherAction({ watcher: row, snapshot, now, activeUsageLimits: usageLimits }),
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
    if (stateNotify.nextNotified) patch.notified = stateNotify.nextNotified;
    pendingStateMessages = stateNotify.messages;
    return patch;
  }, { dataDir, createIfMissing: false });

  if (mutateResult.ok) {
    const notify = typeof options.notify === 'function'
      ? options.notify
      : notifyWorkspaceWatcherDecision;
    // Park stuck todos first so a "stopped, nothing eligible" push describes
    // the state the operator finds, not a mid-park one.
    for (const todoId of pendingPark) {
      markWorkspaceWatcherTodoBlocked({
        dataDir,
        workspaceFolder,
        todoId,
        at,
        notify: options.notify,
        notifyDeps: options.notifyDeps,
      });
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
      appendWorkspaceWatcherNotice({
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
      appendWorkspaceWatcherNotice({
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
      appendWorkspaceWatcherNotice({
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
 *   decisionDedupeMs?: number,
 *   deps?: Partial<ReturnType<typeof defaultWorkspaceWatcherSnapshotDeps>>,
 * }} [options]
 * @returns {{
 *   at: string,
 *   scanned: number,
 *   observed: number,
 *   wrote: number,
 *   decisions: Array<{ workspaceFolder: string, kind: string, reason: string, shouldNotify: boolean }>,
 *   errors: Array<{ workspaceFolder: string, code: string, message: string }>,
 * }}
 */
export function runWorkspaceWatcherHeartbeat(options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const dataDir = resolveDataDir(options);
  /** @type {ReturnType<typeof runWorkspaceWatcherHeartbeat>} */
  const result = {
    at: new Date(now).toISOString(),
    scanned: 0,
    observed: 0,
    wrote: 0,
    decisions: [],
    errors: [],
  };

  /** @type {object[]} */
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
      const tick = tickWorkspaceWatcher({
        workspaceFolder: row.workspaceFolder,
        dataDir,
        now,
        ownerPid: options.ownerPid,
        token: options.token,
        ttlMs: options.ttlMs,
        decisionDedupeMs: options.decisionDedupeMs,
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
 * @param {object} current
 * @param {object} expected
 * @param {string} expectedIdentity
 * @returns {object | null}
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
 * @param {object} row
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
 * @param {object} row
 * @param {object} cycle
 * @param {object} context
 * @returns {boolean}
 */
function reconcileWorkspaceWatcherCycleSlot(row, cycle, context) {
  if (!cycle) return false;
  const workspaceFolder = String(row.workspaceFolder ?? '').trim();
  if (!workspaceFolder) return false;
  const expectedCycle = workspaceWatcherCycleIdentity(cycle);
  const chatId = String(cycle.chatId ?? '').trim();
  const now = Number.isFinite(context.options?.now) ? Number(context.options.now) : Date.now();
  if (chatId && isWorkspaceWatcherActiveCycleChatAlive(cycle, context.probe, now)) return false;
  const delegations = typeof context.loadDelegations === 'function'
    ? context.loadDelegations()
    : loadDelegations(context.options?.dataDir ? { dataDir: context.options.dataDir } : {});
  if (chatId && hasActiveWorkspaceWatcherCycleChildren(chatId, delegations)) return false;
  const dataDir = context.options?.dataDir;
  const todo = loadPrimaryTodoForWorkspaceWatcherCycle({ workspaceFolder, dataDir, cycle, row });
  const { closeOutcome, countIncompleteFailure, closeReason } = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle,
    row,
    todo,
    reportedOutcomeRaw: cycle.reportedOutcome,
    mcpErrorCode: readMcpOrchestratorRunErrorCode(cycle, context.probe),
  });
  const todoId = String(cycle.todoIds?.[0] ?? '').trim();
  let applied = false;
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row: current }) => {
    const currentCycle = findReconciledCycleSlot(current, cycle, expectedCycle);
    if (!currentCycle) return false;
    if (workspaceWatcherCycleIdentity(currentCycle) !== expectedCycle) return false;
    const latestDelegations = typeof context.loadDelegations === 'function'
      ? context.loadDelegations()
      : loadDelegations(context.options?.dataDir ? { dataDir: context.options.dataDir } : {});
    if (chatId && hasActiveWorkspaceWatcherCycleChildren(chatId, latestDelegations)) return false;
    const reports = resolveDeferredWorkspaceWatcherReports(current.reports, currentCycle);
    applied = true;
    return buildWorkspaceWatcherCycleClosePatch({
      row: reports !== current.reports ? { ...current, reports } : current,
      cycle: currentCycle,
      outcome: closeOutcome,
      todoIds: currentCycle.todoIds,
      reports,
      now,
      at: context.at,
      decisionReason: closeReason,
      todo,
      workspaceFolder,
      dataDir,
    });
  }, context.options);
  if (result.ok !== true || !applied) return false;
  if (todoId && chatId && !hasActiveWorkspaceWatcherCycleChildren(chatId, delegations)) {
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
 *   scoutArchiveDeps?: object,
 *   orchestratorArchiveDeps?: object,
 * }} [options]
 * @returns {{ reconciled: number, workspaces: string[], errors: Array<{ workspaceFolder: string, code: string, message: string }> }}
 */
export function reconcileWorkspaceWatchersOnBoot(options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  const at = new Date(now).toISOString();
  /** @type {string[]} */
  const workspaces = [];
  /** @type {Array<{ workspaceFolder: string, code: string, message: string }>} */
  const errors = [];
  /** @type {object[]} */
  let rows;
  try {
    rows = loadWorkspaceWatchers(options);
  } catch (error) {
    const described = describeError(error);
    errors.push({ workspaceFolder: '', ...described });
    logDelegationEvent('workspace-watcher-reconcile-error', {}, { scope: 'load', ...described });
    return { reconciled: 0, workspaces, errors };
  }
  const loadDelegationsFn = typeof options.loadDelegations === 'function'
    ? options.loadDelegations
    : () => loadDelegations(options?.dataDir ? { dataDir: options.dataDir } : {});
  for (const row of rows) {
    try {
      if (reconcileWorkspaceWatcherRow(row, {
        probe,
        at,
        options,
        loadDelegations: loadDelegationsFn,
      })) {
        workspaces.push(row.workspaceFolder);
      }
      // A restart can leave a todo claimed by a chat that no longer exists.
      // Only autopilot rows own watcher claims, so this is scoped to them.
      if (String(row.mode || '') === 'autopilot') {
        releaseStaleWorkspaceTodoClaims({
          workspaceFolder: row.workspaceFolder,
          dataDir: options.dataDir,
          probeChatRunLiveness: probe,
        });
      }
      // Settle durable Scout attempts against real liveness before the archive
      // sweep: a crashed reservation refunds once, a confirmed-idle launched
      // scan releases, and busy/unknown stays occupied across the restart.
      reconcileScoutScans(row.workspaceFolder, {
        dataDir: options.dataDir,
        now,
        deps: {
          probeChatRunLiveness: probe,
          ...(options.scoutReconcileDeps || {}),
        },
      });
      // Clear expired never-launched reservations so boot does not leave stale
      // `activeScoutScans` records until the next heartbeat.
      expireStaleActiveScoutScan(row.workspaceFolder, { dataDir: options.dataDir, now });
      // A restart re-applies the idle-Scout archive sweep without running a
      // scan. It stays conservative: a post-restart run state that the adapter
      // cannot confirm idle is not archived, so nothing still-busy is hidden.
      archiveIdleScoutChats(row.workspaceFolder, {
        now,
        deps: options.scoutArchiveDeps || {},
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
    sweepClosedWorkspaceWatcherCycles({
      dataDir: options.dataDir,
      now,
      rows,
      deps: options.orchestratorArchiveDeps || {},
    });
  } catch { /* best-effort bulk archive */ }
  return { reconciled: workspaces.length, workspaces, errors };
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
 * @returns {{ claimed: boolean, reason: string, todoId?: string, item?: object|null, error?: object, replay?: boolean }}
 */
export function claimWorkspaceTodo(options = {}) {
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
    return withWorkspaceWatchersFileLock(() => {
      const current = loadTodosData(dataDir, workspaceFolder);
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
      const doc = withTodosWatcherNudgeSuppressed(() => updateTodo(dataDir, workspaceFolder, todoId, patch));
      return { claimed: true, reason: 'claimed', todoId, item: doc.items.find((row) => row.id === todoId) || null };
    }, { dataDir });
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
 * @param {object | null | undefined} watcher
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
 *   getChat?: (chatId: string) => object | null,
 *   loadDelegations?: () => object[],
 * }} [options]
 * @returns {{
 *   released: string[],
 *   errors: Array<Record<string, unknown>>,
 *   states: ReturnType<typeof classifyWorkspaceDoingTodos>,
 *   skipped: Array<{ todoId: string, reason: string }>,
 * }}
 */
export function releaseStaleWorkspaceTodoClaims(options = {}) {
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
  /** @type {object | null} */
  let watcher = null;
  try {
    watcher = getWorkspaceWatcher(workspaceFolder, { dataDir });
  } catch (error) {
    return { released, errors: [{ scope: 'watcher', ...describeError(error) }], states: [], skipped };
  }
  const readDelegations = typeof options.loadDelegations === 'function'
    ? options.loadDelegations
    : () => loadDelegations({ dataDir });
  const getChat = typeof options.getChat === 'function' ? options.getChat : loadWorkspaceWatcherChatRow;
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const recoverIdleOpenChat = policy.recoverIdleOpenChat === true;
  const classify = () => classifyWorkspaceDoingTodos({
    items: loadTodosData(dataDir, workspaceFolder)?.items,
    delegations: readDelegations(),
    cycles: getWorkspaceWatcherActiveCycles(getWorkspaceWatcher(workspaceFolder, { dataDir })),
    probe,
    isCycleChatAlive: isWorkspaceWatcherActiveCycleChatAlive,
    getChat,
    now,
    recoverIdleOpenChat,
  });
  /** @type {object[]} */
  let items = [];
  /** @type {ReturnType<typeof classifyWorkspaceDoingTodos>} */
  let states = [];
  try {
    const doc = loadTodosData(dataDir, workspaceFolder);
    items = Array.isArray(doc?.items) ? doc.items : [];
    states = classify();
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
      loadDelegations: readDelegations,
    });
    if (result.ok && result.outcome === 'released') released.push(todoId);
    else skipped.push({ todoId, reason: result.outcome });
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
      if (delegations.some((child) => child.parentChatId === row.claimedByChatId && isDelegationSlotOccupied(child, now))) continue;
      if (isWorkspaceTodoClaimAlive(row, probe)) continue;
    }
    try {
      withTodosWatcherNudgeSuppressed(() => {
        updateTodo(dataDir, workspaceFolder, todoId, {
          strictStatus: true,
          claimedByChatId: null,
          claimedAt: null,
          expectedUpdatedAt: row.updatedAt,
        });
      });
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
 * @returns {{ claimed: boolean, reason: string, todoId?: string, item?: object|null, error?: object }}
 */
export function claimNextWorkspaceTodo(options = {}) {
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
    releaseStaleWorkspaceTodoClaims({
      dataDir,
      workspaceFolder,
      now,
      probeChatRunLiveness: options.probeChatRunLiveness,
    });
  }
  /** @type {object[]} */
  let items = [];
  try {
    const doc = loadTodosData(dataDir, workspaceFolder);
    items = Array.isArray(doc?.items) ? doc.items : [];
  } catch (error) {
    return { claimed: false, reason: 'load_failed', error: describeError(error) };
  }
  const picked = pickNextWorkspaceReadyTodo({ items, failures, maxFailures, allowedHarnesses: watcher?.policy?.allowedHarnesses });
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
