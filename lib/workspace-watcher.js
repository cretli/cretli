/**
 * Workspace Watcher — stage A (deterministic guard, no LLM).
 *
 * One watcher row per workspace. The service:
 *   1. `snapshotWorkspaceWatcher` collects ready todos and active delegations,
 *   2. `decideWorkspaceWatcherAction` is a pure decision over that snapshot,
 *   3. `tickWorkspaceWatcher` acquires the lease, snapshots, decides and
 *      writes the decision log,
 *   4. `runWorkspaceWatcherHeartbeat` runs the tick for every `observe` row.
 *
 * Stage A never starts an agent: `off` does nothing at all, and `observe`
 * only records "idle, there is work" so it cannot spawn duplicates. The
 * heartbeat is driven by `lib/delegation-runtime-worker.js`.
 */

import { randomUUID } from 'node:crypto';
import { resolveDataPath } from './runtime-paths.js';
import { loadDelegations } from './persist/delegations-persist.js';
import { loadTodosData, updateTodo } from './persist/todos-persist.js';
import { listReadyTodoLeaves } from './todo-tree.js';
import { isActiveDelegationStatus } from './delegation-status.js';
import { logDelegationEvent } from './delegation-log.js';
import { normalizeDelegationWorkspaceKey } from './delegation-workspace-guard.js';
import { probeChatRunLiveness } from './chat-run-service.js';
import {
  WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS,
  WORKSPACE_WATCHER_TICK_MODES,
  acquireWorkspaceWatcherLease,
  getWorkspaceWatcher,
  loadWorkspaceWatchers,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceFolder,
  normalizeWorkspaceWatcherLease,
  releaseWorkspaceWatcherLease,
} from './persist/workspace-watchers-persist.js';

export const WORKSPACE_WATCHER_DECISION_DEDUPE_MS = 60_000;

/** Stable per-process lease identity so repeated ticks renew, not fight. */
const PROCESS_LEASE_TOKEN = `pid-${process.pid}-${randomUUID()}`;

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
 * Default snapshot inputs; tests may override any of them.
 *
 * @returns {{
 *   loadTodosData: typeof loadTodosData,
 *   listReadyTodoLeaves: typeof listReadyTodoLeaves,
 *   loadDelegations: typeof loadDelegations,
 *   isActiveDelegationStatus: typeof isActiveDelegationStatus,
 * }}
 */
export function defaultWorkspaceWatcherSnapshotDeps(dataDir) {
  const dir = String(dataDir ?? '').trim();
  return {
    loadTodosData,
    listReadyTodoLeaves,
    loadDelegations: () => loadDelegations(dir ? { dataDir: dir } : {}),
    isActiveDelegationStatus,
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
 * Deterministic snapshot of one workspace. Store failures are captured per
 * source so a corrupt todo store cannot stop the heartbeat.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   now?: number,
 *   deps?: Partial<ReturnType<typeof defaultWorkspaceWatcherSnapshotDeps>>,
 * }} [options]
 * @returns {{
 *   workspaceFolder: string,
 *   at: string,
 *   readyTodoIds: string[],
 *   readyTodoCount: number,
 *   readyLeaves: object[],
 *   activeDelegationIds: string[],
 *   activeAgentCount: number,
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
  /** @type {string[]} */
  let activeDelegationIds = [];

  try {
    const doc = deps.loadTodosData(dataDir, workspaceFolder);
    readyLeaves = deps.listReadyTodoLeaves(Array.isArray(doc?.items) ? doc.items : []) || [];
    readyTodoIds = readyLeaves
      .map((row) => String(row?.id ?? '').trim())
      .filter(Boolean);
  } catch (error) {
    errors.push({ scope: 'todos', ...describeError(error) });
  }

  try {
    activeDelegationIds = (deps.loadDelegations() || [])
      .filter((row) => {
        if (!deps.isActiveDelegationStatus(row?.status)) return false;
        return delegationWorkspaceMatchKey(row?.workspaceFolder) === workspaceMatchKey;
      })
      .map((row) => String(row?.id ?? '').trim())
      .filter(Boolean);
  } catch (error) {
    errors.push({ scope: 'delegations', ...describeError(error) });
  }

  return {
    workspaceFolder,
    at: new Date(now).toISOString(),
    readyTodoIds,
    readyTodoCount: readyTodoIds.length,
    readyLeaves,
    activeDelegationIds,
    activeAgentCount: activeDelegationIds.length,
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
  if (Number.isFinite(fromPolicy) && fromPolicy >= 0) return fromPolicy;
  return Number.POSITIVE_INFINITY;
}

/**
 * Pure "next todo" pick. `listReadyTodoLeaves` already drops done/doing nodes
 * and every blocked leaf (unapproved parent plan, or a sequential group whose
 * earlier sibling is not done), so an already-claimed (doing) todo never
 * surfaces here. Among the remaining candidates we take the oldest-created,
 * tie-breaking on id, and skip leaves at or above the failure ceiling.
 *
 * @param {{
 *   items?: object[],
 *   readyLeaves?: object[],
 *   failures?: Record<string, unknown>,
 *   maxFailures?: number,
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
  const maxFailures = Number.isFinite(input.maxFailures) ? Number(input.maxFailures) : Number.POSITIVE_INFINITY;
  const eligible = leaves
    .filter((row) => String(row?.id ?? '').trim())
    .filter((row) => toFailureCount(failures[String(row.id)]) < maxFailures)
    .sort((a, b) => {
      const aKey = String(a.createdAt ?? '');
      const bKey = String(b.createdAt ?? '');
      if (aKey !== bKey) return aKey < bKey ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  return eligible[0] || null;
}

/**
 * Pure decision. Stage A only produces an observation, never a spawn.
 *
 * @param {{ watcher?: object, snapshot?: object }} [input]
 * @returns {{
 *   kind: 'off' | 'stopped' | 'wait_active' | 'idle_no_work' | 'snapshot_error' | 'observe_ready',
 *   reason: string,
 *   shouldNotify: boolean,
 *   readyTodoCount: number,
 *   activeAgentCount: number,
 *   maxParallel: number,
 *   nextTodoId: string,
 * }}
 */
export function decideWorkspaceWatcherAction(input = {}) {
  const watcher = input.watcher || {};
  const snapshot = input.snapshot || {};
  const readyTodoCount = Math.max(0, Number(snapshot.readyTodoCount) || 0);
  const activeAgentCount = Math.max(0, Number(snapshot.activeAgentCount) || 0);
  const maxParallel = Math.max(1, Number(watcher?.policy?.maxParallel) || 1);
  const snapshotErrors = Array.isArray(snapshot.errors) ? snapshot.errors : [];
  const details = { readyTodoCount, activeAgentCount, maxParallel, nextTodoId: '' };

  if (!WORKSPACE_WATCHER_TICK_MODES.includes(String(watcher.mode || '')) || watcher.enabled === false) {
    const reason = String(watcher.mode || '') === 'autopilot' ? 'mode_autopilot_inert' : 'mode_off';
    return { kind: 'off', reason, shouldNotify: false, ...details };
  }
  if (String(watcher.stopReason || '').trim()) {
    return { kind: 'stopped', reason: 'stop_reason', shouldNotify: false, ...details };
  }
  if (snapshotErrors.length > 0) {
    return { kind: 'snapshot_error', reason: 'snapshot_unavailable', shouldNotify: false, ...details };
  }
  if (activeAgentCount >= maxParallel) {
    return { kind: 'wait_active', reason: 'max_parallel', shouldNotify: false, ...details };
  }
  if (readyTodoCount === 0) {
    return { kind: 'idle_no_work', reason: 'no_ready_work', shouldNotify: false, ...details };
  }
  const picked = pickNextWorkspaceReadyTodo({
    readyLeaves: Array.isArray(snapshot.readyLeaves) ? snapshot.readyLeaves : [],
    failures: watcher.failures,
    maxFailures: resolveMaxFailures(watcher),
  });
  return {
    kind: 'observe_ready',
    reason: 'idle_has_work',
    shouldNotify: true,
    ...details,
    nextTodoId: picked ? String(picked.id) : '',
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
  const last = decisions[decisions.length - 1];
  if (!last || last.kind !== decision.kind || last.reason !== decision.reason) return true;
  if (dedupeMs <= 0) return true;
  const at = Date.parse(String(last.at || ''));
  if (!Number.isFinite(at)) return true;
  return now - at >= dedupeMs;
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

  const snapshot = snapshotWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    now,
    deps: options.deps,
  });
  const decision = decideWorkspaceWatcherAction({ watcher: existing, snapshot, now });
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
  const token = String(options.token ?? '').trim() || PROCESS_LEASE_TOKEN;
  const ttlMs = options.ttlMs;
  const ownerPid = options.ownerPid;
  let recorded = false;
  const mutateResult = mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    const leaseAttempt = acquireWorkspaceWatcherLease(row, {
      ownerPid,
      token,
      ttlMs,
      now,
    });
    if (!leaseAttempt.acquired) return null;
    recorded = shouldRecordDecision(row, decision, now, dedupeMs);
    /** @type {Record<string, unknown>} */
    const patch = {
      lease: leaseAttempt.lease,
      lastTickAt: at,
    };
    if (recorded) {
      patch.decisions = [
        ...row.decisions,
        {
          at,
          kind: decision.kind,
          reason: decision.reason,
          readyTodoCount: decision.readyTodoCount,
          activeAgentCount: decision.activeAgentCount,
          shouldNotify: decision.shouldNotify,
          nextTodoId: decision.nextTodoId,
        },
      ];
    }
    return patch;
  }, { dataDir });
  if (!mutateResult.ok) {
    if (mutateResult.reason === 'aborted') {
      return {
        workspaceFolder,
        action: 'lease_held',
        reason: 'lease_held',
        shouldNotify: false,
        wrote: false,
        recorded: false,
        snapshot,
      };
    }
    return {
      workspaceFolder,
      action: 'cas_conflict',
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

  for (const row of rows) {
    result.scanned += 1;
    if (!WORKSPACE_WATCHER_TICK_MODES.includes(String(row.mode || ''))) continue;
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
 * @param {{ chatId?: string, runId?: string }} activeCycle
 * @param {(input: { chatId?: string, runId?: string }) => { known: boolean, busy: boolean, reason: string }} probe
 * @returns {boolean}
 */
export function isWorkspaceWatcherActiveCycleChatAlive(activeCycle, probe) {
  const chatId = String(activeCycle?.chatId ?? '').trim();
  if (!chatId) return false;
  const runId = String(activeCycle?.runId ?? '').trim();
  const live = probe({ chatId, runId: runId || undefined });
  if (live.known === true && live.busy === true) return true;
  if (live.reason === 'chat_missing') return false;
  if (live.known === true && live.busy === false) return false;
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
 * Clear one interrupted cycle. The mutator re-checks the cycle identity it was
 * asked about and only releases the lease that was observed together with that
 * cycle, so a race after the probe cannot drop a newer cycle or its lease. A
 * cycle without a `chatId` cannot be probed and is treated as not alive.
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
  const cycle = row.activeCycle;
  if (!cycle) return false;
  const expectedCycle = workspaceWatcherCycleIdentity(cycle);
  const expectedLeaseToken = String(row.lease?.token ?? '').trim();
  const chatId = String(cycle.chatId ?? '').trim();
  if (chatId && isWorkspaceWatcherActiveCycleChatAlive(cycle, context.probe)) return false;
  const result = mutateWorkspaceWatcherRow(row.workspaceFolder, ({ row: current }) => {
    if (workspaceWatcherCycleIdentity(current.activeCycle) !== expectedCycle) return false;
    const currentLeaseToken = String(current.lease?.token ?? '').trim();
    const lease = currentLeaseToken && currentLeaseToken === expectedLeaseToken
      ? releaseWorkspaceWatcherLease(current, { token: currentLeaseToken })
      : normalizeWorkspaceWatcherLease(current.lease);
    return {
      activeCycle: null,
      lease,
      stopReason: String(current.stopReason || '').trim() || 'cycle_interrupted',
      decisions: [
        ...current.decisions,
        {
          at: context.at,
          kind: 'cycle_interrupted',
          reason: chatId ? 'active_cycle_not_alive' : 'active_cycle_missing_chat',
          readyTodoCount: 0,
          activeAgentCount: 0,
          shouldNotify: false,
        },
      ],
    };
  }, context.options);
  return result.ok === true;
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
  for (const row of rows) {
    try {
      if (reconcileWorkspaceWatcherRow(row, { probe, at, options })) {
        workspaces.push(row.workspaceFolder);
      }
    } catch (error) {
      const described = describeError(error);
      errors.push({ workspaceFolder: row.workspaceFolder, ...described });
      logDelegationEvent('workspace-watcher-reconcile-error', {}, {
        workspaceFolder: row.workspaceFolder,
        ...described,
      });
    }
  }
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
 *   dataDir?: string,
 *   now?: number,
 * }} [options]
 * @returns {{ claimed: boolean, reason: string, todoId?: string, item?: object|null, error?: object }}
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
  /** @type {Record<string, unknown>} */
  const patch = {
    status: 'doing',
    strictStatus: true,
    claimedByChatId,
    claimedAt: new Date(now).toISOString(),
  };
  if (expectedUpdatedAt) patch.expectedUpdatedAt = expectedUpdatedAt;
  try {
    const doc = updateTodo(dataDir, workspaceFolder, todoId, patch);
    const item = (Array.isArray(doc?.items) ? doc.items : []).find((row) => String(row?.id) === todoId) || null;
    return { claimed: true, reason: 'claimed', todoId, item };
  } catch (error) {
    const described = describeError(error);
    if (described.code === 'CONFLICT') return { claimed: false, reason: 'cas_conflict', todoId };
    if (described.code === 'NOT_FOUND') return { claimed: false, reason: 'not_found', todoId };
    return { claimed: false, reason: 'claim_failed', todoId, error: described };
  }
}

/**
 * Release claims whose owning chat is confirmed gone so a crashed orchestrator
 * cannot hide a todo forever. `doing` items without a claim (a human or agent
 * set the status directly) are left alone, and an unknown chat state keeps the
 * claim — we only drop work we can prove was abandoned.
 *
 * @param {{
 *   workspaceFolder?: unknown,
 *   dataDir?: string,
 *   probeChatRunLiveness?: typeof probeChatRunLiveness,
 * }} [options]
 * @returns {{ released: string[], errors: Array<Record<string, unknown>> }}
 */
export function releaseStaleWorkspaceTodoClaims(options = {}) {
  const workspaceFolder = String(options.workspaceFolder ?? '');
  if (!workspaceFolder.trim()) return { released: [], errors: [] };
  const dataDir = resolveDataDir(options);
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  /** @type {string[]} */
  const released = [];
  /** @type {Array<Record<string, unknown>>} */
  const errors = [];
  /** @type {object[]} */
  let items = [];
  try {
    const doc = loadTodosData(dataDir, workspaceFolder);
    items = Array.isArray(doc?.items) ? doc.items : [];
  } catch (error) {
    return { released, errors: [{ scope: 'todos', ...describeError(error) }] };
  }
  for (const row of items) {
    if (row?.status !== 'doing') continue;
    if (!String(row.claimedByChatId ?? '').trim()) continue;
    if (isWorkspaceTodoClaimAlive(row, probe)) continue;
    const todoId = String(row.id ?? '').trim();
    if (!todoId) continue;
    try {
      updateTodo(dataDir, workspaceFolder, todoId, {
        status: 'ready',
        strictStatus: true,
        claimedByChatId: null,
        claimedAt: null,
        expectedUpdatedAt: row.updatedAt,
      });
      released.push(todoId);
    } catch (error) {
      const described = describeError(error);
      // A CAS miss means someone already changed the todo; not ours to release.
      if (described.code === 'CONFLICT') continue;
      errors.push({ todoId, ...described });
    }
  }
  return { released, errors };
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
  const picked = pickNextWorkspaceReadyTodo({ items, failures, maxFailures });
  if (!picked) return { claimed: false, reason: 'no_ready_work' };
  return claimWorkspaceTodo({
    dataDir,
    workspaceFolder,
    todoId: String(picked.id),
    claimedByChatId,
    expectedUpdatedAt: picked.updatedAt,
    now,
  });
}

export { WORKSPACE_WATCHER_DEFAULT_LEASE_TTL_MS, normalizeWorkspaceFolder };
