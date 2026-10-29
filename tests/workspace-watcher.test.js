import './helpers/isolated-data-dir.js';
import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { flushWorkspaceWatcherNotices } from '../lib/workspace-watcher-pinned-chat.js';
import {
  WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES,
  WORKSPACE_WATCHER_MAX_DECISIONS,
  WORKSPACE_WATCHER_MAX_PARALLEL,
  WORKSPACE_WATCHERS_LOCK_TIMEOUT_MS,
  WorkspaceWatchersCorruptError,
  WorkspaceWatchersLockError,
  acquireWorkspaceWatcherLease,
  appendWorkspaceWatcherCycle,
  appendWorkspaceWatcherDecision,
  defaultWorkspaceWatcherPolicy,
  getWorkspaceWatcher,
  getWorkspaceWatcherActiveCycles,
  getWorkspaceWatchersDataPath,
  isWorkspaceWatcherLeaseActive,
  loadWorkspaceWatchers,
  loadWorkspaceWatchersDocument,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceFolder,
  normalizeWorkspaceWatcherDecision,
  normalizeWorkspaceWatcherRow,
  releaseWorkspaceWatcherLease,
  removeWorkspaceWatcher,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  decideWorkspaceWatcherAction,
  describeWorkspaceWatcherDecision,
  isWorkspaceWatcherActiveCycleChatAlive,
  isWorkspaceTodoClaimAlive,
  markWorkspaceWatcherTodoBlocked,
  pickNextWorkspaceReadyTodo,
  planWorkspaceWatcherLoopGuard,
  claimWorkspaceTodo,
  claimNextWorkspaceTodo,
  releaseStaleWorkspaceTodoClaims,
  reconcileWorkspaceWatchersOnBoot,
  runWorkspaceWatcherHeartbeat,
  shouldRecordDecision,
  snapshotWorkspaceWatcher,
  tickWorkspaceWatcher,
  WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS,
} from '../lib/workspace-watcher.js';
import {
  computeWatcherSchedule,
  computeWorkspaceWatcherBackoffUntil,
  evaluateWorkspaceWatcherGuardrails,
  evaluateWorkspaceWatcherLoop,
  isWorkspaceWatcherQuietHours,
  nextWorkspaceWatcherQuietHoursEndMs,
  workspaceWatcherUtcDayKey,
} from '../lib/workspace-watcher-guardrails.js';
import {
  buildWorkspaceWatcherCyclePrompt,
  hasActiveWorkspaceWatcherCycleChildren,
  reconcileWorkspaceWatcherCycle,
  resolveWorkspaceWatcherOrchestrator,
  runWorkspaceWatcherAutopilot,
  shouldCountWorkspaceWatcherCycleIncomplete,
  startWorkspaceWatcherCycle,
  WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS,
} from '../lib/workspace-watcher-cycle.js';
import { buildWorkspaceWatcherCycleClosePatch } from '../lib/workspace-watcher-cycle-close.js';
import {
  isWorkspaceWatcherOrchestratorModelUsageLimited,
  resolveWorkspaceWatcherOrchestrator as resolveOrchestratorDirect,
} from '../lib/workspace-watcher-orchestrator.js';
import { runWorkspaceWatcherTick, resolveWatcherClaimOwner } from '../lib/workspace-watcher-control.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { registerKernelChatRunAdapter } from '../lib/chat-run/kernel-adapter.ts';
import { unregisterChatRunAdapter } from '../lib/chat-run-service.js';
import { openRecoveryStore, closeRecoveryStore } from '../lib/recovery/recovery-store.ts';
import { beginRunLaunch, recordExecutorAck } from '../lib/recovery/recovery-lifecycle.ts';
import { addTodo, getTodoById, updateTodo, loadTodosData } from '../lib/persist/todos-persist.js';
import { listReadyTodoLeaves } from '../lib/todo-tree.js';
import {
  getDelegationRuntimeWorkerStats,
  resetDelegationRuntimeHealth,
  tickDelegationRuntime,
} from '../lib/delegation-runtime-worker.js';
import { bootDelegationRuntime, shutdownDelegationRuntime } from '../lib/delegation-runtime-boot.js';
import {
  getDelegationLifecycleSnapshot,
  resetDelegationLifecycleForTest,
} from '../lib/delegation-lifecycle.js';
import {
  createDelegationRecord,
  getDelegationsDataPath,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';

// The degradation cases below corrupt the on-disk JSON delegation store and
// expect the runtime to notice. A host that selects the SQLite delegation store
// (the Cretli runtime exports CRETLI_DELEGATION_STORE=sqlite) would ignore that
// file, so the cases would assert the wrong backend. Pin the JSON store this
// file was written against; the backend is resolved on every call, not cached
// at import time.
process.env.CRETLI_DELEGATION_STORE = 'json';

let failed = 0;

/**
 * Cases share process-global state: the delegation runtime health, the watcher
 * notice serialization chain, the isolated data directory and the persist-layer
 * caches. `runCase` therefore only registers a case; the runner at the bottom of
 * this file executes every registered case one at a time, in declaration order.
 * Starting every case eagerly and awaiting the collected promises afterwards
 * does not serialize anything: an already-started promise keeps running while
 * the next case's synchronous prefix executes, so two cases can corrupt or
 * replace the same persist file at the same time.
 *
 * @type {{ name: string, fn: () => unknown }[]}
 */
const cases = [];

function reportFailure(name, err) {
  failed += 1;
  console.error('FAIL:', name);
  console.error(err && err.stack ? err.stack : String(err));
}

/**
 * @param {string} name
 * @param {() => unknown} fn
 */
function runCase(name, fn) {
  cases.push({ name, fn });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-'));
const workspaceA = path.join(tmpRoot, 'workspace-a');
const workspaceB = path.join(tmpRoot, 'workspace-b');

/**
 * @param {string} name
 * @returns {string}
 */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @type {number | null} */
let reapedDeadPid = null;

/**
 * A pid that already exited and was reaped, so lock state naming it is
 * provably owned by a dead process.
 *
 * @returns {number}
 */
function deadPid() {
  if (reapedDeadPid == null) {
    const died = spawnSync(process.execPath, ['-e', '']);
    reapedDeadPid = Number(died.pid) || 1;
  }
  return reapedDeadPid;
}

/**
 * Linux starttime (/proc/<pid>/stat field 22) of this process, empty if the
 * host does not expose it.
 *
 * @returns {string}
 */
function selfProcessStart() {
  try {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return '';
    return String(stat.slice(close + 2).split(' ')[19] || '').trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} dataDir
 * @returns {string[]}
 */
function watcherLockArtifacts(dataDir) {
  try {
    return fs.readdirSync(dataDir)
      .filter((name) => /^workspace-watchers\.lock/.test(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Records every attempt to delete or move watcher lock state through the fs
 * API. Lock state that a writer recovers by removing a file is the defect
 * class this guards: between reading an owner token and unlinking the lock,
 * the directory can already belong to a fresh owner.
 *
 * @returns {{ paths: string[], restore: () => void }}
 */
function watchLockStateDeletions() {
  const paths = [];
  const names = ['rmSync', 'unlinkSync', 'rmdirSync', 'renameSync'];
  const originals = names.map((name) => [name, fs[name]]);
  for (const [name, original] of originals) {
    fs[name] = function recording(...args) {
      const target = String(args[0] ?? '');
      if (/workspace-watchers[^/]*(\.lock|\.sqlite)/.test(target)) paths.push(`${name}:${target}`);
      return original.apply(fs, args);
    };
  }
  return {
    paths,
    restore() {
      for (const [name, original] of originals) fs[name] = original;
    },
  };
}

/**
 * @param {string} dataDir
 * @param {number} holdMs
 * @returns {{ child: import('node:child_process').ChildProcess, ready: Promise<void>, exited: Promise, stop: () => Promise }}
 */
function startLockChild(dataDir, holdMs, witnessPath = '', releasePath = '') {
  const helperPath = fileURLToPath(new URL('./helpers/workspace-watcher-lock-child.js', import.meta.url));
  const child = spawn(process.execPath, [helperPath, dataDir, 'hold', String(holdMs), witnessPath, releasePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { err += String(chunk); });
  const exited = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (out.includes('LOCKED')) { resolve(); return; }
      if (child.exitCode != null) {
        reject(new Error(`lock child died before taking the lock (code=${child.exitCode}): ${err || out}`));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`lock child never took the lock: ${err || out}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
  return {
    child,
    ready,
    exited,
    async stop() {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      return exited;
    },
  };
}

/**
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
function observeDeps(overrides = {}) {
  return {
    loadTodosData: () => ({ items: [{ id: 'todo-1' }] }),
    listReadyTodoLeaves: (items) => items,
    loadDelegations: () => [],
    isActiveDelegationStatus: () => false,
    ...overrides,
  };
}

runCase('normalizeWorkspaceFolder: trims, collapses slashes and keeps a root', () => {
  assert.equal(normalizeWorkspaceFolder(''), '');
  assert.equal(normalizeWorkspaceFolder(null), '');
  assert.equal(normalizeWorkspaceFolder('  /a/b/  '), '/a/b');
  assert.equal(normalizeWorkspaceFolder('C:\\work\\repo\\'), 'C:/work/repo');
  assert.equal(normalizeWorkspaceFolder('//a//b//'), '/a/b');
  assert.equal(normalizeWorkspaceFolder('/'), '/');
});

runCase('default row: mode off, inert lease, policy and empty decision log', () => {
  const row = normalizeWorkspaceWatcherRow({ workspaceFolder: workspaceA });
  assert.equal(row.mode, 'off');
  assert.equal(row.enabled, false);
  assert.deepEqual(row.policy, defaultWorkspaceWatcherPolicy());
  assert.equal(row.policy.maxParallel, 1);
  assert.equal(row.policy.requirePlanApproval, true);
  assert.deepEqual(row.lease, { ownerPid: 0, token: '', expiresAt: '' });
  assert.deepEqual(row.decisions, []);
  assert.equal(row.stopReason, '');
  assert.equal(normalizeWorkspaceWatcherRow({}), null);
});

runCase('upsert + load round-trip keyed by normalized workspace folder', () => {
  const dataDir = freshDataDir('persist-roundtrip');
  const saved = upsertWorkspaceWatcher(`${workspaceA}/`, { mode: 'observe', orchestratorChatId: 'chat-1' }, { dataDir });
  assert.equal(saved.workspaceFolder, workspaceA);
  assert.equal(saved.mode, 'observe');
  assert.equal(saved.enabled, true);

  const loaded = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(loaded.orchestratorChatId, 'chat-1');
  assert.equal(loadWorkspaceWatchers({ dataDir }).length, 1);

  const doc = JSON.parse(fs.readFileSync(getWorkspaceWatchersDataPath({ dataDir }), 'utf8'));
  assert.equal(doc.v, 2);
  assert.ok(doc.items[workspaceA], 'row is keyed by the normalized folder');
});

runCase('mode aliases: enabled=true means observe; autopilot is stored but inert', () => {
  const dataDir = freshDataDir('persist-modes');
  assert.equal(upsertWorkspaceWatcher(workspaceA, { enabled: true }, { dataDir }).mode, 'observe');
  const autopilot = upsertWorkspaceWatcher(workspaceA, { mode: 'autopilot' }, { dataDir });
  assert.equal(autopilot.mode, 'autopilot');
  assert.equal(autopilot.enabled, true);
  assert.equal(upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir }).mode, 'observe');
  assert.equal(upsertWorkspaceWatcher(workspaceA, { mode: 'nope' }, { dataDir }).mode, 'off');
});

runCase('autopilot is active: tick applies the plan gate; observe heartbeat leaves it to the async driver', async () => {
  const dataDir = freshDataDir('autopilot-active');
  upsertWorkspaceWatcher(workspaceA, { mode: 'autopilot' }, { dataDir });
  const tick = await tickWorkspaceWatcher({ workspaceFolder: workspaceA, dataDir, deps: observeDeps() });
  assert.equal(tick.action, 'plan_gate');
  assert.equal(tick.reason, 'plan_missing');
  assert.equal(tick.wrote, true);
  assert.equal(tick.decision.planOnly, true);
  const hb = await runWorkspaceWatcherHeartbeat({ dataDir, token: 'hb', deps: observeDeps() });
  assert.equal(hb.scanned, 1);
  assert.equal(hb.observed, 0);
  assert.equal(hb.wrote, 0);
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy: { maxParallel: 1 }, stopReason: '' },
    snapshot: { readyTodoCount: 2, activeAgentCount: 0, errors: [] },
  });
  assert.equal(decision.kind, 'idle_no_work');
  assert.equal(decision.reason, 'no_eligible_work');
});

runCase('store mutations bump monotonic document revision (CAS token)', () => {
  const dataDir = freshDataDir('persist-revision');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const afterUpsert = loadWorkspaceWatchersDocument({ dataDir });
  assert.equal(afterUpsert.revision, 1);
  appendWorkspaceWatcherDecision(workspaceA, {
    at: new Date().toISOString(),
    kind: 'k1',
    reason: 'r',
  }, { dataDir });
  assert.equal(loadWorkspaceWatchersDocument({ dataDir }).revision, 2);
  upsertWorkspaceWatcher(workspaceA, { orchestratorChatId: 'chat-2' }, { dataDir });
  assert.equal(loadWorkspaceWatchersDocument({ dataDir }).revision, 3);
  removeWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(loadWorkspaceWatchersDocument({ dataDir }).revision, 4);
});

runCase('mutate retries when an nested upsert bumps the CAS revision', () => {
  const dataDir = freshDataDir('persist-cas-mutations');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  let attempts = 0;
  const result = mutateWorkspaceWatcherRow(workspaceA, () => {
    attempts += 1;
    if (attempts === 1) {
      upsertWorkspaceWatcher(workspaceA, { orchestratorChatId: 'bump' }, { dataDir });
    }
    return { orchestratorChatId: 'inner-win' };
  }, { dataDir, maxAttempts: 3 });
  assert.equal(result.ok, true);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).orchestratorChatId, 'inner-win');
  assert.ok(loadWorkspaceWatchersDocument({ dataDir }).revision >= 2);
});

runCase('reconcile clears dead activeCycle, releases lease and closes with shared accounting', async () => {
  const dataDir = freshDataDir('reconcile-cycle');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycle: { chatId: 'child-chat', todoIds: ['todo-1'], startedAt: new Date(t0).toISOString() },
    lease: { ownerPid: 99, token: 'boot-token', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  const probe = () => ({ known: true, busy: false, reason: 'idle' });
  assert.equal(isWorkspaceWatcherActiveCycleChatAlive({ chatId: 'child-chat' }, probe), false);
  const result = await reconcileWorkspaceWatchersOnBoot({ dataDir, now: t0, probeChatRunLiveness: probe });
  assert.equal(result.reconciled, 1);
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.cycleCount, 1);
  assert.deepEqual(row.lease, { ownerPid: 0, token: '', expiresAt: '' });
  assert.equal(row.decisions.at(-1).kind, 'cycle_failed');
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
});

runCase('reconcile keeps activeCycle when chat liveness is unknown', async () => {
  const dataDir = freshDataDir('reconcile-unknown');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycle: { chatId: 'child-chat', todoIds: ['todo-1'], startedAt: new Date().toISOString() },
  }, { dataDir });
  const probe = () => ({ known: false, busy: false, reason: 'adapter_missing' });
  assert.equal(isWorkspaceWatcherActiveCycleChatAlive({ chatId: 'child-chat' }, probe), true);
  const result = await reconcileWorkspaceWatchersOnBoot({ dataDir, probeChatRunLiveness: probe });
  assert.equal(result.reconciled, 0);
  assert.ok(getWorkspaceWatcher(workspaceA, { dataDir }).activeCycle);
});

runCase('reconcile isolates a corrupt watcher store and never rewrites it', async () => {
  const dataDir = freshDataDir('reconcile-corrupt');
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const corrupt = '{ not json';
  fs.writeFileSync(file, corrupt, 'utf8');
  const result = await reconcileWorkspaceWatchersOnBoot({
    dataDir,
    probeChatRunLiveness: () => {
      throw new Error('probe must not run without a readable store');
    },
  });
  assert.equal(result.reconciled, 0);
  assert.deepEqual(result.workspaces, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'WORKSPACE_WATCHERS_CORRUPT');
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'corrupt bytes stay untouched');
});

runCase('snapshot exposes a recovery state and its evidence for every doing todo', async () => {
  const dataDir = freshDataDir('snapshot-recovery');
  const probes = {
    'busy-chat': { known: true, busy: true, reason: 'busy' },
    'cold-chat': { known: false, busy: false, reason: 'state_missing' },
    'closed-chat': { known: true, busy: false, reason: 'idle' },
  };
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    deps: {
      loadTodosData: () => ({
        items: [
          { id: 'parent', status: 'doing', updatedAt: 'r0' },
          { id: 'running', status: 'doing', parentId: 'parent', claimedByChatId: 'busy-chat', updatedAt: 'r1' },
          { id: 'cold', status: 'doing', parentId: 'parent', claimedByChatId: 'cold-chat', updatedAt: 'r2' },
          { id: 'closed', status: 'doing', orchestratorChatId: 'closed-chat', updatedAt: 'r3' },
          { id: 'manual', status: 'doing', linkedChatIds: ['busy-chat'], updatedAt: 'r4' },
          { id: 'flagged', status: 'doing', blockedReason: 'Needs a decision', updatedAt: 'r5' },
          { id: 'waiting', status: 'ready', updatedAt: 'r6' },
        ],
      }),
      loadDelegations: () => [],
      listWorkspaceChatIds: () => [],
      probeChatRunLiveness: (input) => probes[input.chatId] || { known: false, busy: false, reason: 'chat_missing' },
      getChat: () => ({ archived: true }),
    },
  });
  const byId = Object.fromEntries(snapshot.doingStates.map((row) => [row.todoId, row]));
  assert.deepEqual(Object.keys(byId).sort(), ['closed', 'cold', 'flagged', 'manual', 'parent', 'running'], 'only doing rows are classified');
  assert.deepEqual([byId.parent.state, byId.parent.evidence], ['dependency', 'children']);
  assert.deepEqual([byId.running.state, byId.running.source, byId.running.chatId], ['active', 'watcher_claim', 'busy-chat']);
  assert.deepEqual([byId.cold.state, byId.cold.reason], ['unknown', 'state_missing']);
  assert.deepEqual([byId.closed.state, byId.closed.reason, byId.closed.source], ['recoverable', 'idle_archived_chat', 'orchestrator_chat']);
  assert.deepEqual([byId.manual.state, byId.manual.reason, byId.manual.chatId], ['unknown', 'missing_identity', ''], 'a linked chat is not an executor');
  assert.deepEqual([byId.flagged.state, byId.flagged.evidence], ['user_action', 'blockedReason']);
  assert.deepEqual(snapshot.recovery, { active: 1, dependency: 1, user_action: 1, recoverable: 1, unknown: 2 });
  assert.equal(snapshot.doingTodoCount, 6, 'the durable status list is unchanged');
});

runCase('boot reconcile resumes an unclaimed doing leaf only in autopilot and only on proof', async () => {
  const dataDir = freshDataDir('reconcile-unclaimed');
  const autoCwd = makeWorkspace('reconcile-unclaimed-auto');
  const observeCwd = makeWorkspace('reconcile-unclaimed-observe');
  const seed = (cwd, chatId) => {
    const item = addTodo(dataDir, cwd, { title: `owned by ${chatId}`, status: 'ready', orchestratorChatId: chatId }).item;
    updateTodo(dataDir, cwd, item.id, { status: 'doing' });
    return item.id;
  };
  upsertWorkspaceWatcher(autoCwd, { mode: 'autopilot' }, { dataDir });
  upsertWorkspaceWatcher(observeCwd, { mode: 'observe' }, { dataDir });
  const goneId = seed(autoCwd, 'deleted-chat');
  const coldId = seed(autoCwd, 'cold-chat');
  const erroredId = seed(autoCwd, 'errored-chat');
  const observedId = seed(observeCwd, 'deleted-chat');
  const reasons = { 'deleted-chat': 'chat_missing', 'cold-chat': 'state_missing', 'errored-chat': 'adapter_error' };
  const result = await reconcileWorkspaceWatchersOnBoot({
    dataDir,
    probeChatRunLiveness: (input) => ({ known: false, busy: false, reason: reasons[input.chatId] || 'adapter_missing' }),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(getTodoById(dataDir, autoCwd, goneId).status, 'ready', 'a deleted executor chat frees the leaf on the first pass');
  assert.equal(getTodoById(dataDir, autoCwd, coldId).status, 'doing', 'state_missing after a restart is not proof');
  assert.equal(getTodoById(dataDir, autoCwd, erroredId).status, 'doing', 'an adapter error is not proof');
  assert.equal(getTodoById(dataDir, observeCwd, observedId).status, 'doing', 'observe never changes a todo');
});

runCase('reconcile clears an activeCycle without chatId without probing', async () => {
  const dataDir = freshDataDir('reconcile-no-chat');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycle: { todoIds: ['todo-1'], startedAt: new Date(t0).toISOString() },
    lease: { ownerPid: 9, token: 'cycle-lease', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  let probeCalls = 0;
  const result = await reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: t0,
    probeChatRunLiveness: () => {
      probeCalls += 1;
      return { known: true, busy: false, reason: 'idle' };
    },
  });
  assert.equal(result.reconciled, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(probeCalls, 0, 'nothing to probe without a chatId');
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.cycleCount, 1);
  assert.deepEqual(row.lease, { ownerPid: 0, token: '', expiresAt: '' });
  assert.equal(row.decisions.at(-1).kind, 'cycle_failed');
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
});

runCase('boot bulk archive routes a closed orchestrator through the shared canArchive gate', async () => {
  const dataDir = freshDataDir('boot-archive-gate');
  const t0 = Date.parse('2026-03-03T12:00:00.000Z');
  const oldAt = new Date(t0 - 60 * 60_000).toISOString();
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    cycleChats: [{ id: 'orch-closed', cycleId: 'c1', at: oldAt, outcome: 'success' }],
  }, { dataDir });
  const scoutDeps = {
    loadChats: () => [],
    updateChat: () => {},
    listDelegationsForController: () => [],
    isChatRunConfirmedIdle: () => true,
    isDelegationSlotOccupied: () => false,
  };
  const archived = [];
  await reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: t0,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    scoutArchiveDeps: scoutDeps,
    orchestratorArchiveDeps: {
      loadChats: () => [
        { id: 'orch-closed', updatedAt: oldAt },
        { id: 'orch-child', updatedAt: oldAt, pickPurpose: 'implement' },
      ],
      updateChat: (id) => { archived.push(String(id)); },
      listDelegationsForController: (pid) => (pid === 'orch-closed'
        ? [{ parentChatId: 'orch-closed', childChatId: 'orch-child', status: 'completed' }]
        : []),
      isChatRunConfirmedIdle: () => true,
      isDelegationSlotOccupied: () => false,
      hasActiveWorkspaceWatcherCycleChildren: () => false,
    },
  });
  assert.deepEqual(archived, ['orch-child', 'orch-closed'],
    'the closed orchestrator archives its terminal child before itself via the shared gate');

  // Same closed orchestrator, but its child still holds a slot: the gate must
  // refuse the whole portfolio, so nothing is archived.
  const refused = [];
  await reconcileWorkspaceWatchersOnBoot({
    dataDir: freshDataDir('boot-archive-gate-refused'),
    now: t0,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    scoutArchiveDeps: scoutDeps,
    orchestratorArchiveDeps: {
      loadChats: () => [
        { id: 'orch-closed', updatedAt: oldAt },
        { id: 'orch-child', updatedAt: oldAt, pickPurpose: 'implement' },
      ],
      updateChat: (id) => { refused.push(String(id)); },
      listDelegationsForController: (pid) => (pid === 'orch-closed'
        ? [{ parentChatId: 'orch-closed', childChatId: 'orch-child', status: 'completed' }]
        : []),
      isChatRunConfirmedIdle: () => true,
      isDelegationSlotOccupied: () => true,
      hasActiveWorkspaceWatcherCycleChildren: () => false,
    },
  });
  assert.deepEqual(refused, [], 'a slot-holding child blocks the closed orchestrator from being hidden');
});

/**
 * Archive-gate deps for the live sweep tests: fake chat/delegation stores that
 * only record `updateChat` calls, so each case opts into exactly the signal it
 * asserts on.
 *
 * @param {{ chats?: object[], rows?: Record<string, object[]>, archived: string[] }} input
 * @param {object} [extra]
 * @returns {object}
 */
function sweepArchiveDeps(input, extra = {}) {
  const chats = input.chats || [];
  const rows = input.rows || {};
  return {
    loadChats: () => chats,
    updateChat: (id) => { input.archived.push(String(id)); },
    listDelegationsForController: (parentId) => rows[String(parentId)] || [],
    isChatRunConfirmedIdle: () => true,
    isDelegationSlotOccupied: () => false,
    hasActiveWorkspaceWatcherCycleChildren: () => false,
    ...extra,
  };
}

runCase('live autopilot sweep archives a closed orchestrator family past the grace', async () => {
  const dataDir = freshDataDir('autopilot-archive-sweep');
  const cwd = makeWorkspace('autopilot-archive-sweep');
  const t0 = Date.parse('2026-03-03T12:00:00.000Z');
  const oldAt = new Date(t0 - 60 * 60_000).toISOString();
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 10, maxParallel: 5 },
    cycleChats: [{ id: 'orch-sweep', cycleId: 'c-sweep', at: oldAt, outcome: 'success' }],
  }, { dataDir });
  const archived = [];
  await runWorkspaceWatcherAutopilot({
    dataDir,
    now: t0,
    token: 'sweep',
    deps: {
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap' }),
      addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
      startChatRun: async () => ({ accepted: true, runId: 'sweep-run' }),
      probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    },
    orchestratorArchiveDeps: sweepArchiveDeps({
      chats: [
        { id: 'orch-sweep', updatedAt: oldAt },
        { id: 'orch-sweep-child', updatedAt: oldAt, pickPurpose: 'implement' },
      ],
      rows: {
        'orch-sweep': [{ parentChatId: 'orch-sweep', childChatId: 'orch-sweep-child', status: 'completed' }],
      },
      archived,
    }),
  });
  assert.deepEqual(archived, ['orch-sweep-child', 'orch-sweep'],
    'the periodic pass archives the terminal child before the closed orchestrator');
  const afterRow = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal((afterRow.activeCycles || []).length, 0, 'the sweep never opens a cycle slot');
  assert.equal(afterRow.cycles?.count || 0, 0, 'the sweep never consumes the daily cycle budget');
});

runCase('live autopilot sweep keeps a family inside the grace, pinned or slot-held', async () => {
  const t0 = Date.parse('2026-03-03T12:00:00.000Z');
  const childRow = {
    'orch-sweep': [{ parentChatId: 'orch-sweep', childChatId: 'orch-sweep-child', status: 'completed' }],
  };
  const childChats = (orchUpdatedAt, extra = {}) => [
    { id: 'orch-sweep', updatedAt: orchUpdatedAt, ...extra },
    { id: 'orch-sweep-child', updatedAt: new Date(t0 - 60 * 60_000).toISOString(), pickPurpose: 'implement' },
  ];

  // (a) orchestrator still inside the 15-minute idle grace.
  const graceDir = freshDataDir('autopilot-sweep-grace');
  const graceCwd = makeWorkspace('autopilot-sweep-grace');
  const graceAt = new Date(t0 - 60_000).toISOString();
  upsertWorkspaceWatcher(graceCwd, {
    mode: 'autopilot',
    cycleChats: [{ id: 'orch-sweep', cycleId: 'c-grace', at: graceAt, outcome: 'success' }],
  }, { dataDir: graceDir });
  const graceArchived = [];
  await runWorkspaceWatcherAutopilot({
    dataDir: graceDir,
    now: t0,
    token: 'sweep-grace',
    deps: { probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }) },
    orchestratorArchiveDeps: sweepArchiveDeps({
      chats: childChats(graceAt),
      rows: childRow,
      archived: graceArchived,
    }),
  });
  assert.deepEqual(graceArchived, [], 'a freshly closed cycle is not archived before the grace');

  // (b) orchestrator is pinned.
  const pinDir = freshDataDir('autopilot-sweep-pinned');
  const pinCwd = makeWorkspace('autopilot-sweep-pinned');
  const oldAt = new Date(t0 - 60 * 60_000).toISOString();
  upsertWorkspaceWatcher(pinCwd, {
    mode: 'autopilot',
    cycleChats: [{ id: 'orch-sweep', cycleId: 'c-pin', at: oldAt, outcome: 'success' }],
  }, { dataDir: pinDir });
  const pinArchived = [];
  await runWorkspaceWatcherAutopilot({
    dataDir: pinDir,
    now: t0,
    token: 'sweep-pin',
    deps: { probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }) },
    orchestratorArchiveDeps: sweepArchiveDeps({
      chats: childChats(oldAt, { watcherPinned: true }),
      rows: childRow,
      archived: pinArchived,
    }),
  });
  assert.deepEqual(pinArchived, [], 'a pinned orchestrator keeps its whole family visible');

  // (c) the delegated child still holds a run slot.
  const slotDir = freshDataDir('autopilot-sweep-slot');
  const slotCwd = makeWorkspace('autopilot-sweep-slot');
  upsertWorkspaceWatcher(slotCwd, {
    mode: 'autopilot',
    cycleChats: [{ id: 'orch-sweep', cycleId: 'c-slot', at: oldAt, outcome: 'success' }],
  }, { dataDir: slotDir });
  const slotArchived = [];
  await runWorkspaceWatcherAutopilot({
    dataDir: slotDir,
    now: t0,
    token: 'sweep-slot',
    deps: { probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }) },
    orchestratorArchiveDeps: sweepArchiveDeps({
      chats: childChats(oldAt),
      rows: childRow,
      archived: slotArchived,
    }, { isDelegationSlotOccupied: () => true }),
  });
  assert.deepEqual(slotArchived, [], 'a slot-holding child blocks the live sweep too');

  // (d) the entry still orchestrates a live cycle, so the sweep must skip it.
  const liveDir = freshDataDir('autopilot-sweep-live');
  const liveCwd = makeWorkspace('autopilot-sweep-live');
  upsertWorkspaceWatcher(liveCwd, {
    mode: 'autopilot',
    activeCycle: { cycleId: 'c-live', chatId: 'orch-sweep', todoIds: ['todo-live'], startedAt: oldAt, phase: 'running' },
    cycleChats: [{ id: 'orch-sweep', cycleId: 'c-live', at: oldAt, outcome: 'success' }],
  }, { dataDir: liveDir });
  const liveArchived = [];
  await runWorkspaceWatcherAutopilot({
    dataDir: liveDir,
    now: t0,
    token: 'sweep-live',
    deps: { probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }) },
    orchestratorArchiveDeps: sweepArchiveDeps({
      chats: childChats(oldAt),
      rows: childRow,
      archived: liveArchived,
    }),
  });
  assert.deepEqual(liveArchived, [], 'a chat with a live cycle slot on any row is never swept');
});

runCase('reconcile leaves a newer cycle that replaced the probed one', async () => {
  const dataDir = freshDataDir('reconcile-race-cycle');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycle: { chatId: 'old-chat', todoIds: ['todo-1'], startedAt: new Date(t0).toISOString() },
    lease: { ownerPid: 7, token: 'old-lease', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  const probe = () => {
    // A concurrent process starts the next cycle while we are probing.
    upsertWorkspaceWatcher(workspaceA, {
      activeCycle: { chatId: 'new-chat', todoIds: ['todo-2'], startedAt: new Date(t0 + 5).toISOString() },
      lease: { ownerPid: 11, token: 'new-lease', expiresAt: new Date(t0 + 60_000).toISOString() },
    }, { dataDir });
    return { known: true, busy: false, reason: 'idle' };
  };
  const result = await reconcileWorkspaceWatchersOnBoot({ dataDir, now: t0, probeChatRunLiveness: probe });
  assert.equal(result.reconciled, 0, 'the newer cycle is not reported as reconciled');
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycle.chatId, 'new-chat');
  assert.equal(row.lease.token, 'new-lease');
  assert.equal(row.stopReason, '');
  assert.deepEqual(row.decisions, []);
});

runCase('normalizeWorkspaceWatcherRow migrates legacy activeCycle into activeCycles', () => {
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: workspaceA,
    activeCycle: {
      cycleId: 'legacy-cycle',
      chatId: 'legacy-chat',
      todoIds: ['todo-legacy'],
      startedAt: new Date().toISOString(),
    },
  });
  assert.ok(row);
  assert.equal(getWorkspaceWatcherActiveCycles(row).length, 1);
  assert.equal(row.activeCycle?.cycleId, 'legacy-cycle');
  assert.equal(row.activeCycles[0].chatId, 'legacy-chat');
});

runCase('v1 activeCycle patch replaces the singleton instead of appending', () => {
  const dataDir = freshDataDir('v1-active-cycle-replace');
  upsertWorkspaceWatcher(workspaceA, {
    activeCycles: [{
      cycleId: 'old',
      chatId: 'old-chat',
      todoIds: ['todo-1'],
      startedAt: '2026-01-01T00:00:00.000Z',
    }],
    lease: { ownerPid: 1, token: 'keep', expiresAt: '2026-01-01T01:00:00.000Z' },
  }, { dataDir });
  upsertWorkspaceWatcher(workspaceA, {
    activeCycle: {
      cycleId: 'new',
      chatId: 'new-chat',
      todoIds: ['todo-2'],
      startedAt: '2026-01-01T00:00:05.000Z',
    },
  }, { dataDir });
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycles.length, 1);
  assert.equal(row.activeCycles[0].chatId, 'new-chat');
  assert.equal(row.lease.token, 'keep');
});

runCase('cycle close keeps the row lease while a sibling cycle stays live', () => {
  const dataDir = freshDataDir('lease-sibling-cycle');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const lease = { ownerPid: 7, token: 'shared-lease', expiresAt: new Date(t0 + 60_000).toISOString() };
  const cycleA = {
    cycleId: 'cycle-a',
    chatId: 'chat-a',
    todoIds: ['todo-a'],
    startedAt: new Date(t0).toISOString(),
  };
  const cycleB = {
    cycleId: 'cycle-b',
    chatId: 'chat-b',
    todoIds: ['todo-b'],
    startedAt: new Date(t0 + 1).toISOString(),
  };
  upsertWorkspaceWatcher(workspaceA, { activeCycles: [cycleA, cycleB], lease }, { dataDir });
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  const closePatch = buildWorkspaceWatcherCycleClosePatch({
    row,
    cycle: cycleA,
    outcome: 'success',
    now: t0,
  });
  mutateWorkspaceWatcherRow(workspaceA, () => closePatch, { dataDir });
  const after = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(after.activeCycles.length, 1);
  assert.equal(after.activeCycles[0].cycleId, 'cycle-b');
  assert.deepEqual(after.lease, lease);
});

runCase('boot reconcile drops only the dead slot and keeps a live sibling with its lease', async () => {
  const dataDir = freshDataDir('multi-slot-reconcile');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycles: [
      { cycleId: 'dead', chatId: 'dead-chat', todoIds: ['todo-dead'], startedAt: new Date(t0).toISOString() },
      { cycleId: 'live', chatId: 'live-chat', todoIds: ['todo-live'], startedAt: new Date(t0 + 1).toISOString() },
    ],
    lease: { ownerPid: 7, token: 'sibling-lease', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  const probe = ({ chatId }) => (chatId === 'live-chat'
    ? { known: true, busy: true, reason: 'busy' }
    : { known: true, busy: false, reason: 'idle' });
  const result = await reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: t0 + 1000,
    probeChatRunLiveness: probe,
    loadDelegations: () => [],
  });
  assert.equal(result.reconciled, 1, 'the workspace is reconciled once for its single dead slot');
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycles.length, 1, 'exactly the dead slot is removed');
  assert.equal(row.activeCycles[0].cycleId, 'live');
  assert.equal(row.activeCycle.cycleId, 'live', 'the v1 mirror follows the surviving slot');
  assert.equal(row.lease.token, 'sibling-lease', 'a live sibling keeps the shared row lease');
});

runCase('policy normalization caps maxParallel at 10 (99 -> 10)', () => {
  const normalized = normalizeWorkspaceWatcherRow({
    workspaceFolder: workspaceA,
    policy: { maxParallel: 99 },
  });
  assert.equal(normalized.policy.maxParallel, 10);
  const dataDir = freshDataDir('max-parallel-cap');
  const saved = upsertWorkspaceWatcher(workspaceA, { policy: { maxParallel: 99 } }, { dataDir });
  assert.equal(saved.policy.maxParallel, WORKSPACE_WATCHER_MAX_PARALLEL);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).policy.maxParallel, 10);
  assert.equal(defaultWorkspaceWatcherPolicy().scoutMaxParallel, 1);
  assert.equal(normalizeWorkspaceWatcherRow({
    workspaceFolder: workspaceA,
    policy: { scoutMaxParallel: 99 },
  }).policy.scoutMaxParallel, 10);
  assert.equal(WORKSPACE_WATCHER_MAX_ACTIVE_CYCLES, 10);
});

runCase('per-pool limits maxParallelWorktree/maxParallelProject normalize to 0..10', () => {
  const POOL_KEYS = ['maxParallelWorktree', 'maxParallelProject'];
  const normalize = (policy) => normalizeWorkspaceWatcherRow({
    workspaceFolder: workspaceA,
    policy,
  }).policy;

  // Full backward compatibility: a legacy row that never stored either field
  // gets `0` (= the pool inherits `maxParallel`), and `0` is the default too, so
  // the only difference from the old policy shape is these two added keys.
  for (const key of POOL_KEYS) {
    assert.equal(normalize({})[key], 0, `${key} backfills a missing field to 0`);
  }
  assert.deepEqual(
    Object.keys(normalize({})).sort(),
    Object.keys(defaultWorkspaceWatcherPolicy()).sort(),
  );
  assert.equal(defaultWorkspaceWatcherPolicy().maxParallelWorktree, 0);
  assert.equal(defaultWorkspaceWatcherPolicy().maxParallelProject, 0);

  for (const key of POOL_KEYS) {
    // Accepted boundaries.
    assert.equal(normalize({ [key]: 0 })[key], 0);
    assert.equal(normalize({ [key]: 1 })[key], 1);
    assert.equal(normalize({ [key]: 10 })[key], 10);
    // Above range clamps to the same hard ceiling as `maxParallel`, never raises
    // it and never stores an unbounded value.
    assert.equal(normalize({ [key]: 99 })[key], WORKSPACE_WATCHER_MAX_PARALLEL);
    // Out-of-range below the floor and non-numeric values fall back to the
    // default 0, the same normalization style as `maxParallel`.
    assert.equal(normalize({ [key]: -3 })[key], 0);
    assert.equal(normalize({ [key]: 'many' })[key], 0);
    assert.equal(normalize({ [key]: NaN })[key], 0);
    assert.equal(normalize({ [key]: null })[key], 0);
    assert.equal(normalize({ [key]: undefined })[key], 0);
    // Integers only.
    assert.equal(normalize({ [key]: 3.7 })[key], 3);
    // Neither field narrows or overrides `maxParallel`, which keeps its own
    // 1..10 range and its 1 default.
    assert.equal(normalize({ [key]: 5 }).maxParallel, 1);
    assert.equal(normalize({ [key]: 5, maxParallel: 99 }).maxParallel, 10);
    assert.equal(normalize({ [key]: 5, maxParallel: 0 }).maxParallel, 1);
  }
});

runCase('per-pool limits round-trip through save/load and survive a partial patch', () => {
  const dataDir = freshDataDir('per-pool-parallel-roundtrip');
  const saved = upsertWorkspaceWatcher(workspaceA, {
    policy: { maxParallel: 4, maxParallelWorktree: 3, maxParallelProject: 2 },
  }, { dataDir });
  assert.equal(saved.policy.maxParallel, 4);
  assert.equal(saved.policy.maxParallelWorktree, 3);
  assert.equal(saved.policy.maxParallelProject, 2);

  const loaded = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(loaded.policy.maxParallelWorktree, 3);
  assert.equal(loaded.policy.maxParallelProject, 2);

  // Re-normalizing the stored row is a no-op, so the values are stable across a
  // read→write cycle instead of drifting toward the default.
  const renormalized = normalizeWorkspaceWatcherRow(loaded);
  assert.equal(renormalized.policy.maxParallelWorktree, 3);
  assert.equal(renormalized.policy.maxParallelProject, 2);

  // Patching one pool keeps the other and the cap (the control layer shallow-
  // merges the policy patch before normalization).
  const patched = upsertWorkspaceWatcher(workspaceA, {
    policy: { ...loaded.policy, maxParallelProject: 0 },
  }, { dataDir });
  assert.equal(patched.policy.maxParallelWorktree, 3, 'the untouched pool keeps its limit');
  assert.equal(patched.policy.maxParallelProject, 0, 'an explicit 0 narrows nothing');
  assert.equal(patched.policy.maxParallel, 4);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).policy.maxParallelWorktree, 3);

  // Out-of-range values are clamped on the way in, not stored raw.
  const clamped = upsertWorkspaceWatcher(workspaceA, {
    policy: { maxParallelWorktree: 99, maxParallelProject: -1 },
  }, { dataDir });
  assert.equal(clamped.policy.maxParallelWorktree, WORKSPACE_WATCHER_MAX_PARALLEL);
  assert.equal(clamped.policy.maxParallelProject, 0);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).policy.maxParallelWorktree, 10);
});

runCase('cooldown default is 30s end-to-end and an explicit 60s row is preserved', () => {
  // The written contract is 30s: both the factory default and the normalizer
  // fallback must agree so a brand-new row and a Reset→Save land on the same value.
  assert.equal(defaultWorkspaceWatcherPolicy().cooldownMs, 30_000);
  const created = normalizeWorkspaceWatcherRow({ workspaceFolder: workspaceA });
  assert.equal(created.policy.cooldownMs, 30_000);

  // Already-explicit stored values are never migrated: a legacy 60s row survives
  // normalization and a persist round-trip unchanged.
  const legacy = normalizeWorkspaceWatcherRow({
    workspaceFolder: workspaceA,
    policy: { cooldownMs: 60_000 },
  });
  assert.equal(legacy.policy.cooldownMs, 60_000);
  const dataDir = freshDataDir('cooldown-preserve');
  const saved = upsertWorkspaceWatcher(workspaceA, { policy: { cooldownMs: 60_000 } }, { dataDir });
  assert.equal(saved.policy.cooldownMs, 60_000);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).policy.cooldownMs, 60_000);
});

runCase('resolveWatcherClaimOwner ignores a stale orchestratorChatId while a live cycle exists', async () => {
  const dataDir = freshDataDir('claim-owner-multi');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'autopilot',
    orchestratorChatId: 'stale-chat',
    activeCycles: [{ cycleId: 'c1', chatId: 'live-chat', todoIds: [], startedAt: '2026-01-01T00:00:00.000Z' }],
  }, { dataDir });
  const denied = await resolveWatcherClaimOwner({
    dataDir,
    workspaceFolder: workspaceA,
    sourceChatId: 'stale-chat',
    requestedClaimChatId: 'someone-else',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'claim_owner_forbidden');
  const allowed = await resolveWatcherClaimOwner({
    dataDir,
    workspaceFolder: workspaceA,
    sourceChatId: 'live-chat',
    requestedClaimChatId: 'someone-else',
  });
  assert.equal(allowed.ok, true);
  // An idle row (no live slot) still trusts the "last known" mirror.
  upsertWorkspaceWatcher(workspaceA, { activeCycles: [], activeCycle: null }, { dataDir });
  const idle = await resolveWatcherClaimOwner({
    dataDir,
    workspaceFolder: workspaceA,
    sourceChatId: 'stale-chat',
    requestedClaimChatId: 'someone-else',
  });
  assert.equal(idle.ok, true);
});

runCase('reconcile keeps a lease taken after the probe while clearing the same cycle', async () => {
  const dataDir = freshDataDir('reconcile-race-lease');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycle: { chatId: 'same-chat', todoIds: ['todo-1'], startedAt: new Date(t0).toISOString() },
    lease: { ownerPid: 7, token: 'probe-lease', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  const probe = () => {
    // Another process renews a different lease for the very same cycle.
    upsertWorkspaceWatcher(workspaceA, {
      lease: { ownerPid: 42, token: 'fresh-lease', expiresAt: new Date(t0 + 60_000).toISOString() },
    }, { dataDir });
    return { known: true, busy: false, reason: 'idle' };
  };
  const result = await reconcileWorkspaceWatchersOnBoot({ dataDir, now: t0, probeChatRunLiveness: probe });
  assert.equal(result.reconciled, 1);
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.deepEqual(row.lease, { ownerPid: 0, token: '', expiresAt: '' });
  assert.equal(row.cycleCount, 1);
});

runCase('document lock: the store never deletes lock state it recovered', () => {
  const dataDir = freshDataDir('persist-lock-no-steal');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const lockDir = `${getWorkspaceWatchersDataPath({ dataDir })}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  // Lock state naming a provably dead owner: a file lock has to recover it,
  // and recovering it by removing it is exactly how a fresh owner gets robbed.
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: deadPid(), token: 'legacy-claim', pidStart: '' }),
    'utf8',
  );

  const deletions = watchLockStateDeletions();
  let saved = null;
  try {
    saved = upsertWorkspaceWatcher(workspaceB, { mode: 'observe' }, { dataDir, lockTimeoutMs: 3_000 });
  } finally {
    deletions.restore();
  }
  assert.equal(saved.mode, 'observe');
  assert.deepEqual(deletions.paths, [], `the store removed lock state: ${deletions.paths.join(', ')}`);
  assert.ok(fs.existsSync(lockDir), 'leftover lock state stays for the operator, nothing is stolen');
  assert.ok(
    watcherLockArtifacts(dataDir).some((name) => name.endsWith('.sqlite')),
    `the lock lives in a kernel-protected database, found: ${watcherLockArtifacts(dataDir).join(', ')}`,
  );
  assert.ok(WORKSPACE_WATCHERS_LOCK_TIMEOUT_MS > 0, 'a waiter gives up with an error, not by breaking the lock');
});

runCase('document lock: lock state on disk does not gate the document', () => {
  const dataDir = freshDataDir('persist-lock-inert');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const lockDir = `${getWorkspaceWatchersDataPath({ dataDir })}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, token: 'not-the-lock', pidStart: selfProcessStart() }),
    'utf8',
  );
  const saved = upsertWorkspaceWatcher(workspaceB, { mode: 'observe' }, { dataDir, lockTimeoutMs: 200 });
  assert.equal(saved.mode, 'observe', 'the real lock is the database write lock, not a directory');
  assert.ok(fs.existsSync(lockDir));
});

runCase('document lock: a live holder in another process is waited out, never stolen', async () => {
  const dataDir = freshDataDir('persist-lock-holder');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const witnessPath = path.join(dataDir, 'lock-order.txt');
  const releasePath = path.join(dataDir, 'release-holder');
  const holder = startLockChild(dataDir, 700, witnessPath, releasePath);
  try {
    await holder.ready;
    assert.throws(
      () => mutateWorkspaceWatcherRow(workspaceA, () => ({ orchestratorChatId: 'thief' }), {
        dataDir,
        lockTimeoutMs: 0,
      }),
      (err) => err instanceof WorkspaceWatchersLockError && err.code === 'WORKSPACE_WATCHERS_LOCKED',
    );
    assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).orchestratorChatId, '');
    // A separate process releases the holder while our synchronous waiter is blocked.
    const releaser = spawn(process.execPath, ['-e',
      'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "release"), 50)', releasePath],
    { stdio: 'ignore' });
    releaser.on('error', () => holder.child.kill('SIGKILL'));
    const waited = mutateWorkspaceWatcherRow(workspaceA, () => {
      fs.appendFileSync(witnessPath, 'waiter-enter\n');
      return { orchestratorChatId: 'waited' };
    }, {
      dataDir,
      lockTimeoutMs: 10_000,
    });
    assert.equal(waited.ok, true, `a waiter must be served after the holder releases: ${waited.reason}`);
    assert.deepEqual(fs.readFileSync(witnessPath, 'utf8').trim().split('\n'),
      ['holder-enter', 'holder-exit', 'waiter-enter'],
      'the waiter must enter only after the holder leaves its critical section');
    assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).orchestratorChatId, 'waited');
    const released = await holder.exited;
    assert.equal(released.code, 0, `holder did not release cleanly: ${released.err || released.out}`);
  } finally {
    await holder.stop();
  }
});

runCase('document lock: a holder killed inside the critical section releases it', async () => {
  const dataDir = freshDataDir('persist-lock-crash');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const before = fs.readFileSync(file, 'utf8');
  const holder = startLockChild(dataDir, 600_000);
  try {
    await holder.ready;
    assert.throws(
      () => mutateWorkspaceWatcherRow(workspaceA, () => ({ orchestratorChatId: 'too-soon' }), {
        dataDir,
        lockTimeoutMs: 0,
      }),
      (err) => err instanceof WorkspaceWatchersLockError,
    );
    holder.child.kill('SIGKILL');
    const crashed = await holder.exited;
    assert.equal(crashed.code, null, 'the holder was killed mid-critical-section');
    const deletions = watchLockStateDeletions();
    let recovered = null;
    try {
      recovered = mutateWorkspaceWatcherRow(workspaceA, () => ({ orchestratorChatId: 'recovered' }), {
        dataDir,
        lockTimeoutMs: 3_000,
      });
    } finally {
      deletions.restore();
    }
    assert.deepEqual(deletions.paths, [], `crash recovery removed lock state: ${deletions.paths.join(', ')}`);
    assert.equal(recovered.ok, true, `the crashed holder kept the store locked: ${recovered.reason}`);
    assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).orchestratorChatId, 'recovered');
    assert.notEqual(fs.readFileSync(file, 'utf8'), before, 'the store is writable again after the crash');
  } finally {
    await holder.stop();
  }
});

runCase('document lock: mutual exclusion is a kernel lock, with no file reclaim left', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../lib/persist/workspace-watchers-persist.js', import.meta.url)),
    'utf8',
  );
  assert.ok(source.includes('BEGIN IMMEDIATE'), 'the store lock is a SQLite write transaction');
  for (const needle of ['owner.json', 'rmSync', 'unlinkSync', 'rmdirSync', 'StaleWatcherLock', 'isWatcherLockStale']) {
    assert.ok(!source.includes(needle), `the store lock still uses the reclaimable file primitive: ${needle}`);
  }
  const casStart = source.indexOf('function compareAndSaveWorkspaceWatchersDocument');
  assert.ok(casStart >= 0, 'the compare-and-save helper is still the only document writer');
  const writeAt = source.indexOf('writeJsonAtomic(', casStart);
  assert.ok(writeAt > casStart);
  const section = source.slice(casStart, writeAt);
  assert.ok(section.includes('withWorkspaceWatchersFileLock'), 'CAS check and write share one critical section');
  assert.ok(section.includes('fs.readFileSync'), 'the on-disk revision is re-read inside that section');
  for (const name of ['mutateWorkspaceWatcherRow', 'mutateWorkspaceWatchersDocument']) {
    const start = source.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, `${name} is still exported`);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.ok(body.includes('withWorkspaceWatchersFileLock'), `${name} does not run under the store lock`);
  }
});

runCase('a damaged record key is flattened before it reaches an error message', () => {
  const dataDir = freshDataDir('persist-corrupt-key');
  const file = getWorkspaceWatchersDataPath({ dataDir });
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    updatedAt: '',
    revision: 1,
    items: { [`/ws\nfake] entry [${'x'.repeat(300)}`]: 7 },
  }), 'utf8');
  assert.throws(
    () => loadWorkspaceWatchersDocument({ dataDir }),
    (err) => err instanceof WorkspaceWatchersCorruptError
      && !err.message.includes('\n')
      && !err.message.includes('\r')
      && !err.message.includes('x'.repeat(200))
      && err.message.length < 400,
    'an untrusted key must not be echoed into a log line',
  );
});

runCase('runtime worker heartbeat runs during degraded backoff skip', async () => {
  const folder = path.join(tmpRoot, 'runtime-degraded-backoff');
  const dataDir = getWorkspaceWatchersDataPath().replace(/\/workspace-watchers\.json$/, '');
  upsertWorkspaceWatcher(folder, { mode: 'observe' }, { dataDir });
  const delegPath = getDelegationsDataPath();
  const backup = fs.existsSync(delegPath) ? fs.readFileSync(delegPath, 'utf8') : null;
  fs.writeFileSync(delegPath, '{ not-json', 'utf8');
  resetDelegationRuntimeHealth();
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  const stats = getDelegationRuntimeWorkerStats();
  assert.equal(stats.degraded, true);
  assert.ok(stats.nextRetryAt > Date.now());
  const rowBefore = getWorkspaceWatcher(folder, { dataDir });
  assert.ok(rowBefore.lastTickAt, 'first tick heartbeat despite store failure');
  const lastTickAt = rowBefore.lastTickAt;
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  const rowAfter = getWorkspaceWatcher(folder, { dataDir });
  assert.notEqual(rowAfter.lastTickAt, lastTickAt, 'heartbeat runs on degraded early return');
  if (backup != null) {
    fs.writeFileSync(delegPath, backup, 'utf8');
  } else if (fs.existsSync(delegPath)) {
    fs.unlinkSync(delegPath);
  }
  resetDelegationRuntimeHealth();
});

runCase('decision log is bounded to WORKSPACE_WATCHER_MAX_DECISIONS', () => {
  const dataDir = freshDataDir('persist-decisions');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  for (let i = 0; i < WORKSPACE_WATCHER_MAX_DECISIONS + 5; i += 1) {
    appendWorkspaceWatcherDecision(workspaceA, {
      at: new Date(1_700_000_000_000 + i).toISOString(),
      kind: `k${i}`,
      reason: 'r',
    }, { dataDir });
  }
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.decisions.length, WORKSPACE_WATCHER_MAX_DECISIONS);
  assert.equal(row.decisions[row.decisions.length - 1].kind, `k${WORKSPACE_WATCHER_MAX_DECISIONS + 4}`);
});

runCase('lease: active lease blocks another token, same token renews, expiry frees it', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const first = acquireWorkspaceWatcherLease({}, { ownerPid: 1, token: 'a', ttlMs: 1000, now });
  assert.equal(first.acquired, true);
  assert.equal(first.renewed, false);
  assert.equal(isWorkspaceWatcherLeaseActive(first.lease, now + 500), true);

  const other = acquireWorkspaceWatcherLease({ lease: first.lease }, { ownerPid: 2, token: 'b', ttlMs: 1000, now: now + 500 });
  assert.equal(other.acquired, false);
  assert.equal(other.lease.token, 'a');

  const renew = acquireWorkspaceWatcherLease({ lease: first.lease }, { ownerPid: 1, token: 'a', ttlMs: 1000, now: now + 500 });
  assert.equal(renew.acquired, true);
  assert.equal(renew.renewed, true);

  const expired = acquireWorkspaceWatcherLease({ lease: first.lease }, { ownerPid: 2, token: 'b', ttlMs: 1000, now: now + 5000 });
  assert.equal(expired.acquired, true);
  assert.equal(expired.lease.token, 'b');

  const released = releaseWorkspaceWatcherLease({ lease: expired.lease }, { token: 'b' });
  assert.deepEqual(released, { ownerPid: 0, token: '', expiresAt: '' });
  const untouched = releaseWorkspaceWatcherLease({ lease: expired.lease }, { token: 'someone-else' });
  assert.equal(untouched.token, 'b');
});

runCase('corrupt store throws WorkspaceWatchersCorruptError without rewriting the file', () => {
  const dataDir = freshDataDir('persist-corrupt');
  const file = getWorkspaceWatchersDataPath({ dataDir });
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.throws(
    () => loadWorkspaceWatchers({ dataDir }),
    (err) => err instanceof WorkspaceWatchersCorruptError && err.code === 'WORKSPACE_WATCHERS_CORRUPT',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

runCase('an unreadable record is corruption, not a row the next save drops', async () => {
  const dataDir = freshDataDir('persist-partial-record');
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const raw = JSON.stringify({
    v: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 7,
    items: {
      [workspaceA]: { workspaceFolder: workspaceA, mode: 'observe', cycleCount: 3 },
      '/workspace/not-an-object': 42,
    },
  });
  fs.writeFileSync(file, raw, 'utf8');

  assert.throws(
    () => loadWorkspaceWatchersDocument({ dataDir }),
    (err) => err instanceof WorkspaceWatchersCorruptError && err.code === 'WORKSPACE_WATCHERS_CORRUPT',
    'a record the store cannot represent must be reported, never skipped',
  );
  assert.throws(
    () => loadWorkspaceWatchers({ dataDir }),
    (err) => err instanceof WorkspaceWatchersCorruptError,
  );
  assert.throws(
    () => upsertWorkspaceWatcher(workspaceB, { mode: 'observe' }, { dataDir }),
    (err) => err instanceof WorkspaceWatchersCorruptError,
    'a write that would drop the unreadable record is refused',
  );
  const boot = await reconcileWorkspaceWatchersOnBoot({
    dataDir,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
  });
  assert.equal(boot.reconciled, 0);
  assert.equal(boot.errors.length, 1);
  assert.equal(boot.errors[0].code, 'WORKSPACE_WATCHERS_CORRUPT');

  assert.equal(fs.readFileSync(file, 'utf8'), raw, 'nothing was rewritten over the damaged document');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.items['/workspace/not-an-object'], 42);
  assert.equal(onDisk.revision, 7);
});

runCase('a record with no usable workspace folder is reported, not skipped', () => {
  const dataDir = freshDataDir('persist-unkeyed-record');
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const raw = JSON.stringify({
    v: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 4,
    items: {
      [workspaceA]: { workspaceFolder: workspaceA, mode: 'observe', cycleCount: 2 },
      '   ': { mode: 'observe', cycleCount: 11 },
    },
  });
  fs.writeFileSync(file, raw, 'utf8');
  assert.throws(
    () => loadWorkspaceWatchersDocument({ dataDir }),
    (err) => err instanceof WorkspaceWatchersCorruptError && /not watcher rows/.test(err.message),
  );
  assert.throws(
    () => removeWorkspaceWatcher(workspaceA, { dataDir }),
    (err) => err instanceof WorkspaceWatchersCorruptError,
    'a remove cannot run over a document whose other record it cannot represent',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

runCase('two records collapsing to one workspace folder are corruption, not an overwrite', () => {
  const dataDir = freshDataDir('persist-duplicate-record');
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const raw = JSON.stringify({
    v: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 2,
    items: {
      [workspaceA]: { workspaceFolder: workspaceA, mode: 'observe', cycleCount: 1 },
      [`${workspaceA}/`]: { workspaceFolder: `${workspaceA}/`, mode: 'off', cycleCount: 9 },
    },
  });
  fs.writeFileSync(file, raw, 'utf8');
  assert.throws(
    () => loadWorkspaceWatchersDocument({ dataDir }),
    (err) => err instanceof WorkspaceWatchersCorruptError,
    'the last record must not silently win over the first one',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

runCase('removeWorkspaceWatcher deletes only the requested row', () => {
  const dataDir = freshDataDir('persist-remove');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  upsertWorkspaceWatcher(workspaceB, { mode: 'observe' }, { dataDir });
  assert.equal(removeWorkspaceWatcher(workspaceA, { dataDir }), true);
  assert.equal(removeWorkspaceWatcher(workspaceA, { dataDir }), false);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }), null);
  assert.ok(getWorkspaceWatcher(workspaceB, { dataDir }));
});

runCase('snapshot collects ready todos and active delegations for the workspace', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    deps: observeDeps({
      loadDelegations: () => [
        { id: 'd1', status: 'running', workspaceFolder: `${workspaceA}/` },
        { id: 'd2', status: 'running', workspaceFolder: workspaceB },
        { id: 'd3', status: 'completed', workspaceFolder: workspaceA },
      ],
      isActiveDelegationStatus: (status) => status === 'running',
    }),
  });
  assert.equal(snapshot.workspaceFolder, workspaceA);
  assert.deepEqual(snapshot.readyTodoIds, ['todo-1']);
  assert.equal(snapshot.readyTodoCount, 1);
  assert.deepEqual(snapshot.activeDelegationIds, ['d1']);
  assert.equal(snapshot.activeAgentCount, 1);
  assert.equal(snapshot.hasReadyWork, true);
  assert.deepEqual(snapshot.errors, []);
});

runCase('snapshot probes loaded chat rows once instead of re-reading chats.json per id', async () => {
  const chats = [
    { id: 'a', workspaceFolder: workspaceA, agentTransport: 'sdk' },
    { id: 'b', workspaceFolder: workspaceA, agentTransport: 'sdk' },
    { id: 'c', workspaceFolder: workspaceA, agentTransport: 'sdk' },
  ];
  const probed = [];
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    deps: {
      loadTodosData: () => ({ items: [] }),
      listReadyTodoLeaves: () => [],
      loadDelegations: () => [],
      isActiveDelegationStatus: () => false,
      listWorkspaceChats: () => chats,
      probeChatRunLiveness: (input) => {
        probed.push(input);
        return {
          known: true,
          busy: input.chatId === 'b',
          reason: input.chatId === 'b' ? 'busy' : 'idle',
        };
      },
      getChatRunState: (input) => ({ waitingForInput: input.chat?.id === 'a' }),
    },
  });
  assert.equal(probed.length, 3);
  assert.ok(probed.every((input) => input.chat && input.chat.id === input.chatId));
  assert.deepEqual(snapshot.activeChatIds, ['b']);
  assert.deepEqual(snapshot.waitingChatIds, ['a']);
});

runCase('snapshot exposes doing, blocked, waiting and recent errors without mixing workspaces', async () => {
  const snapshot = await snapshotWorkspaceWatcher({ workspaceFolder: workspaceA, deps: {
    loadTodosData: () => ({ items: [
      { id: 'root', status: 'doing' },
      { id: 'first', parentId: 'root', siblingIndex: 0, status: 'doing' },
      { id: 'later', parentId: 'root', siblingIndex: 1, status: 'ready' },
    ] }),
    listWorkspaceChatIds: () => ['waiting', 'busy'],
    probeChatRunLiveness: () => ({ known: true, busy: true }),
    getChatRunState: ({ chatId }) => ({ waitingForInput: chatId === 'waiting' }),
    loadDelegations: () => [
      { id: 'wait', workspaceFolder: workspaceA, status: 'waiting_for_input', childChatId: 'waiting' },
      { id: 'failed', workspaceFolder: workspaceA, status: 'failed', errors: [{ at: '2026-01-01', code: 'adapter_error' }] },
      { id: 'foreign', workspaceFolder: workspaceB, status: 'failed', errors: [{ code: 'foreign_error' }] },
    ],
  } });
  assert.deepEqual(snapshot.doingTodoIds, ['root', 'first']);
  assert.deepEqual(snapshot.blockedTodoIds, ['later']);
  assert.deepEqual(snapshot.readyTodoIds, []);
  assert.deepEqual(snapshot.waitingChatIds, ['waiting']);
  assert.equal(snapshot.activeAgentCount, 2, 'a waiting delegated chat only occupies one slot');
  assert.equal(snapshot.recentErrors.length, 1);
  assert.equal(snapshot.recentErrors[0].delegationId, 'failed');
  assert.equal(decideWorkspaceWatcherAction({ watcher: { mode: 'autopilot' }, snapshot }).kind, 'wait_active');
});

runCase('snapshot excludes the watcher own cycle chat and its children', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    deps: observeDeps({
      isActiveDelegationStatus: (status) => status === 'running',
      listWorkspaceChatIds: () => ['own-chat', 'own-child-chat'],
      probeChatRunLiveness: () => ({ known: true, busy: true }),
      loadDelegations: () => [
        { id: 'own-child', status: 'running', workspaceFolder: workspaceA, parentChatId: 'own-chat', childChatId: 'own-child-chat' },
        { id: 'other', status: 'running', workspaceFolder: workspaceA, parentChatId: 'other-parent' },
      ],
    }),
    excludeChatIds: ['own-chat'],
    excludeDelegationParentChatIds: ['own-chat'],
  });
  assert.deepEqual(snapshot.activeDelegationIds, ['other']);
  assert.equal(snapshot.activeAgentCount, 1);
});

runCase('snapshot keeps a live scout and its review out of the todo parallel slot', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    scoutParentChatIds: ['scout-parent'],
    deps: {
      loadTodosData: () => ({ items: [{ id: 'ready', status: 'ready' }] }),
      listReadyTodoLeaves: () => [{ id: 'ready', status: 'ready' }],
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [{
        id: 'scout-review',
        status: 'running',
        workspaceFolder: workspaceA,
        parentChatId: 'scout-parent',
        childChatId: 'scout-child',
      }],
      isActiveDelegationStatus: (status) => status === 'running',
      listWorkspaceChats: () => [
        { id: 'scout-parent', title: '[Scout] acme.example', workspaceFolder: workspaceA },
        { id: 'scout-child', title: 'review', workspaceFolder: workspaceA },
        { id: 'human', title: 'SDK chat', workspaceFolder: workspaceA },
      ],
      probeChatRunLiveness: ({ chatId }) => ({
        known: true,
        busy: chatId === 'scout-parent' || chatId === 'scout-child',
        reason: chatId === 'human' ? 'idle' : 'busy',
      }),
      getChatRunState: () => ({ waitingForInput: false }),
    },
  });
  assert.equal(snapshot.scoutAgentCount, 2);
  assert.equal(snapshot.activeAgentCount, 0);
  assert.deepEqual(snapshot.activeDelegationIds, []);
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy: { maxParallel: 1, requirePlanApproval: false }, stopReason: '' },
    snapshot,
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'ready');
  assert.match(describeWorkspaceWatcherDecision(decision), /2 scout/);
});

runCase('tick cannot resurrect or notify a watcher removed or disabled during its snapshot', async () => {
  for (const action of ['delete', 'off']) {
    const dataDir = freshDataDir(`tick-fence-${action}`);
    upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
    let notifications = 0;
    const result = await tickWorkspaceWatcher({ workspaceFolder: workspaceA, dataDir, notify: () => { notifications += 1; }, deps: observeDeps({
      loadTodosData: () => {
        if (action === 'delete') removeWorkspaceWatcher(workspaceA, { dataDir });
        else upsertWorkspaceWatcher(workspaceA, { mode: 'off' }, { dataDir });
        return { items: [{ id: 'ready' }] };
      },
    }) });
    assert.equal(result.wrote, false);
    assert.equal(notifications, 0);
    assert.equal(result.action, action === 'delete' ? 'no_watcher' : 'off');
    if (action === 'delete') assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }), null);
    else assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).lastTickAt, '');
  }
});

runCase('event heartbeat only snapshots its requested workspace', async () => {
  const dataDir = freshDataDir('scoped-heartbeat');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  upsertWorkspaceWatcher(workspaceB, { mode: 'observe' }, { dataDir });
  const result = await runWorkspaceWatcherHeartbeat({ dataDir, workspaceFolders: [`${workspaceA}/`], now: Date.parse('2026-01-01T00:00:00Z'), deps: observeDeps() });
  assert.equal(result.observed, 1);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).decisions.length, 1);
  assert.equal(getWorkspaceWatcher(workspaceB, { dataDir }).decisions.length, 0);
});

runCase('unknown chat liveness blocks a new cycle and observe notifications', () => {
  const snapshot = { readyTodoCount: 1, activeAgentCount: 0, unknownAgentCount: 1, readyLeaves: [{ id: 'ready' }] };
  for (const mode of ['autopilot', 'observe']) {
    const decision = decideWorkspaceWatcherAction({ watcher: { mode }, snapshot });
    assert.equal(decision.kind, 'wait_active');
    assert.equal(decision.reason, 'unknown_liveness');
    assert.equal(decision.shouldNotify, false);
  }
});

runCase('snapshot: a cold chat with no work trace is idle, not unknown, and the cycle proceeds', async () => {
  const chats = ['hist-a', 'hist-b', 'hist-archived'];
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    deps: {
      loadTodosData: () => ({ items: [{ id: 'ready', status: 'ready' }] }),
      listReadyTodoLeaves: () => [{ id: 'ready', status: 'ready' }],
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      listWorkspaceChatIds: () => chats,
      probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
    },
  });
  assert.equal(snapshot.unknownAgentCount, 0, 'a room that is simply absent is not proof of a running agent');
  assert.deepEqual(snapshot.unknownChatIds, []);
  assert.deepEqual(snapshot.unknownChats, []);
  assert.equal(snapshot.activeAgentCount, 0);
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy: { maxParallel: 5, requirePlanApproval: false }, stopReason: '' },
    snapshot,
  });
  assert.equal(decision.unknownAgentCount, 0);
  assert.notEqual(decision.reason, 'unknown_liveness', 'no cold-room chat blocks the cycle');
  assert.notEqual(decision.kind, 'wait_active', 'the ready todo is allowed to move');
});

runCase('snapshot: a cold chat that still holds a todo claim is unknown with its reason', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    deps: {
      loadTodosData: () => ({ items: [{ id: 't', status: 'doing', claimedByChatId: 'claim-chat' }] }),
      listReadyTodoLeaves: () => [],
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      listWorkspaceChatIds: () => ['claim-chat'],
      probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
    },
  });
  assert.equal(snapshot.unknownAgentCount, 1, 'an abandoned-looking claim still guards the todo');
  assert.deepEqual(snapshot.unknownChats, [{ chatId: 'claim-chat', reason: 'state_missing' }]);
});

runCase('snapshot: a cold chat traced by an occupied delegation slot is unknown (running and runStoppingAt)', async () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const cases = [
    { label: 'active running child', row: { id: 'd-run', status: 'running', workspaceFolder: workspaceA, parentChatId: 'run-parent', childChatId: 'run-child' } },
    { label: 'terminal but runStoppingAt unconfirmed', row: { id: 'd-stop', status: 'completed', workspaceFolder: workspaceA, parentChatId: 'stop-parent', childChatId: 'stop-child', runStoppingAt: new Date(now - 1000).toISOString() } },
  ];
  for (const { label, row } of cases) {
    const snapshot = await snapshotWorkspaceWatcher({
      workspaceFolder: workspaceA,
      now,
      deps: {
        loadTodosData: () => ({ items: [] }),
        listReadyTodoLeaves: () => [],
        isTodoBranchBlocked: () => false,
        loadDelegations: () => [row],
        listWorkspaceChatIds: () => [row.parentChatId, row.childChatId],
        probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
      },
    });
    assert.equal(snapshot.unknownAgentCount, 2, `${label}: both the parent and the child stay guarded`);
    const ids = snapshot.unknownChats.map((c) => c.chatId).sort();
    assert.deepEqual(ids, [row.childChatId, row.parentChatId].sort(), label);
  }
});

runCase('snapshot: a real adapter error is unknown even with no work trace', async () => {
  for (const reason of ['adapter_error', 'probe_failed', 'run_mismatch', 'weird_liveness']) {
    const snapshot = await snapshotWorkspaceWatcher({
      workspaceFolder: workspaceA,
      deps: {
        loadTodosData: () => ({ items: [] }),
        listReadyTodoLeaves: () => [],
        isTodoBranchBlocked: () => false,
        loadDelegations: () => [],
        listWorkspaceChatIds: () => ['err-chat'],
        probeChatRunLiveness: () => ({ known: false, busy: false, reason }),
      },
    });
    assert.equal(snapshot.unknownAgentCount, 1, `${reason}: an adapter that cannot answer is conservative`);
    assert.deepEqual(snapshot.unknownChats, [{ chatId: 'err-chat', reason }]);
  }
});

runCase('snapshot: adapter_missing without a trace is idle and chat_missing is skipped', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    deps: {
      loadTodosData: () => ({ items: [] }),
      listReadyTodoLeaves: () => [],
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      listWorkspaceChatIds: () => ['no-adapter', 'gone-chat'],
      probeChatRunLiveness: ({ chatId }) => (chatId === 'gone-chat'
        ? { known: false, busy: false, reason: 'chat_missing' }
        : { known: false, busy: false, reason: 'adapter_missing' }),
    },
  });
  assert.equal(snapshot.unknownAgentCount, 0, 'a missing adapter or a deleted chat is not a running agent');
  assert.deepEqual(snapshot.unknownChatIds, []);
});

runCase('tick records unknownChats and the Why? names the blocking chat', async () => {
  const dataDir = freshDataDir('unknown-chats-why');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const tick = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    token: 'why-token',
    deps: {
      loadTodosData: () => ({ items: [{ id: 't', status: 'doing', claimedByChatId: 'claim-chat' }] }),
      listReadyTodoLeaves: () => [],
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      listWorkspaceChatIds: () => ['claim-chat'],
      probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
    },
  });
  assert.equal(tick.action, 'wait_active');
  assert.equal(tick.decision.reason, 'unknown_liveness');
  assert.deepEqual(tick.snapshot.unknownChats, [{ chatId: 'claim-chat', reason: 'state_missing' }]);
  // The decision summary that feeds the pinned-chat "Why?" names the blocker.
  assert.deepEqual(tick.decision.unknownChats, [{ chatId: 'claim-chat', reason: 'state_missing' }]);
  const stored = getWorkspaceWatcher(workspaceA, { dataDir });
  const lastStored = stored?.decisions?.[stored.decisions.length - 1];
  assert.ok(lastStored, 'tick persists a decision row');
  assert.deepEqual(lastStored.unknownChats, [{ chatId: 'claim-chat', reason: 'state_missing' }]);
  assert.equal(lastStored.unknownAgentCount, 1);
  const summary = describeWorkspaceWatcherDecision({ ...tick.decision });
  assert.ok(summary.includes('unknown'), 'the summary mentions unknown chats');
  assert.ok(summary.includes('claim-chat'.slice(0, 8)), 'the summary names the blocking chat id');
  assert.ok(summary.includes('state_missing'), 'the summary names the liveness reason');
});

runCase('normalizeWorkspaceWatcherDecision keeps unknownChats for the decision log', () => {
  const normalized = normalizeWorkspaceWatcherDecision({
    at: '2026-10-04T10:00:00.000Z',
    kind: 'wait_active',
    reason: 'unknown_liveness',
    unknownAgentCount: 2,
    unknownChats: [
      { chatId: 'a', reason: 'state_missing' },
      { chatId: 'b', reason: 'probe_failed' },
      { chatId: '', reason: 'ignored' },
      { chatId: 'c', reason: 'extra' },
    ],
  });
  assert.ok(normalized);
  assert.equal(normalized.unknownAgentCount, 2);
  assert.deepEqual(normalized.unknownChats, [
    { chatId: 'a', reason: 'state_missing' },
    { chatId: 'b', reason: 'probe_failed' },
    { chatId: 'c', reason: 'extra' },
  ]);
  const roundTrip = normalizeWorkspaceWatcherDecision(normalized);
  assert.deepEqual(roundTrip?.unknownChats, normalized.unknownChats);
  const sparse = normalizeWorkspaceWatcherDecision({
    at: '2026-10-04T10:00:00.000Z',
    kind: 'start_cycle',
    reason: 'idle',
    unknownChats: [],
  });
  assert.ok(sparse);
  assert.equal(sparse.unknownAgentCount, undefined);
  assert.equal(sparse.unknownChats, undefined);
});

runCase('a busy closed-cycle orchestrator does not fill maxParallel when it holds no claim', async () => {
  const dataDir = freshDataDir('closed-orch-slot');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    cycleChats: [{
      id: 'orch-closed',
      cycleId: 'cycle-1',
      at: '2026-10-05T11:40:28.807Z',
      outcome: 'success',
    }],
  }, { dataDir });
  const tick = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    token: 'closed-orch',
    deps: {
      loadTodosData: () => ({ items: [{ id: 'todo-ready', status: 'ready' }] }),
      listReadyTodoLeaves: (items) => items,
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      isActiveDelegationStatus: () => false,
      listWorkspaceChatIds: () => ['orch-closed'],
      probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
      getChatRunState: () => ({ waitingForInput: false }),
    },
  });
  assert.equal(tick.snapshot.activeAgentCount, 0);
  assert.equal(tick.decision.kind, 'observe_ready');
  assert.notEqual(tick.decision.reason, 'max_parallel');
});

runCase('an external busy chat still blocks maxParallel and the decision names the holder', async () => {
  const dataDir = freshDataDir('external-busy-slot');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    cycleChats: [{
      id: 'orch-closed',
      cycleId: 'cycle-1',
      at: '2026-10-05T11:40:28.807Z',
      outcome: 'success',
    }],
  }, { dataDir });
  const tick = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    token: 'external-busy',
    deps: {
      loadTodosData: () => ({ items: [{ id: 'todo-ready', status: 'ready' }] }),
      listReadyTodoLeaves: (items) => items,
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      isActiveDelegationStatus: () => false,
      listWorkspaceChatIds: () => ['orch-closed', 'human-busy'],
      probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
      getChatRunState: () => ({ waitingForInput: false }),
    },
  });
  assert.equal(tick.decision.kind, 'wait_active');
  assert.equal(tick.decision.reason, 'max_parallel');
  assert.deepEqual(tick.snapshot.busyTokens, ['human-busy']);
  assert.deepEqual(tick.decision.slotHolders, ['human-busy']);
  const stored = getWorkspaceWatcher(workspaceA, { dataDir });
  const last = stored?.decisions?.at(-1);
  assert.deepEqual(last?.slotHolders, ['human-busy']);
  assert.match(describeWorkspaceWatcherDecision(last), /held by human-bu/);
});

runCase('a closed-cycle orchestrator that still holds a claim counts as busy', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    closedCycleChatIds: ['orch-closed'],
    deps: {
      loadTodosData: () => ({ items: [{ id: 't', status: 'doing', claimedByChatId: 'orch-closed' }] }),
      listReadyTodoLeaves: () => [],
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      isActiveDelegationStatus: () => false,
      listWorkspaceChatIds: () => ['orch-closed'],
      probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
      getChatRunState: () => ({ waitingForInput: false }),
    },
  });
  assert.equal(snapshot.activeAgentCount, 1);
  assert.deepEqual(snapshot.busyTokens, ['orch-closed']);
});

runCase('a closed cycle chat with no room and only a leftover todo claim does not block', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    closedCycleChatIds: ['orch-closed'],
    deps: {
      loadTodosData: () => ({ items: [
        { id: 't', status: 'doing', claimedByChatId: 'orch-closed' },
        { id: 'todo-ready', status: 'ready' },
      ] }),
      listReadyTodoLeaves: (items) => items.filter((row) => row.status === 'ready'),
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      isActiveDelegationStatus: () => false,
      listWorkspaceChatIds: () => ['orch-closed'],
      probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
      getChatRunState: () => ({ waitingForInput: false }),
    },
  });
  assert.equal(snapshot.unknownAgentCount, 0, 'the restart-interrupted cycle chat is not live work');
});

runCase('a closed cycle chat with no room but an active delegation slot still blocks', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    closedCycleChatIds: ['orch-closed'],
    deps: {
      loadTodosData: () => ({ items: [{ id: 't', status: 'doing', claimedByChatId: 'orch-closed' }] }),
      listReadyTodoLeaves: () => [],
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [{ id: 'd1', parentChatId: 'orch-closed', childChatId: 'child-1', status: 'running', workspaceFolder: workspaceA }],
      isActiveDelegationStatus: (status) => status === 'running',
      listWorkspaceChatIds: () => ['orch-closed'],
      probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }),
      getChatRunState: () => ({ waitingForInput: false }),
    },
  });
  assert.equal(snapshot.unknownAgentCount, 1);
});

runCase('unknown liveness of a closed-cycle orchestrator still blocks', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    closedCycleChatIds: ['orch-closed'],
    deps: {
      loadTodosData: () => ({ items: [{ id: 'todo-ready', status: 'ready' }] }),
      listReadyTodoLeaves: (items) => items,
      isTodoBranchBlocked: () => false,
      loadDelegations: () => [],
      isActiveDelegationStatus: () => false,
      listWorkspaceChatIds: () => ['orch-closed'],
      probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_error' }),
      getChatRunState: () => ({ waitingForInput: false }),
    },
  });
  assert.equal(snapshot.unknownAgentCount, 1);
  assert.equal(snapshot.activeAgentCount, 0);
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'observe', enabled: true, policy: { maxParallel: 1 } },
    snapshot,
  });
  assert.equal(decision.kind, 'wait_active');
  assert.equal(decision.reason, 'unknown_liveness');
});

runCase('max_parallel keeps delegation slot holders through normalization', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'observe', enabled: true, policy: { maxParallel: 1 } },
    snapshot: {
      readyTodoCount: 2,
      activeAgentCount: 1,
      busyTokens: ['delegation:abcdef12-3456-7890', 'human-chat-id'],
      errors: [],
    },
  });
  assert.equal(decision.reason, 'max_parallel');
  assert.deepEqual(decision.slotHolders, ['delegation:abcdef12-3456-7890', 'human-chat-id']);
  const normalized = normalizeWorkspaceWatcherDecision({
    at: '2026-10-05T11:40:28.000Z',
    ...decision,
  });
  assert.deepEqual(normalized?.slotHolders, decision.slotHolders);
  assert.match(
    describeWorkspaceWatcherDecision(normalized),
    /held by delegation:abcdef12, human-ch/,
  );
  const empty = normalizeWorkspaceWatcherDecision({
    at: '2026-10-05T11:40:28.000Z',
    kind: 'wait_active',
    reason: 'max_parallel',
    slotHolders: [],
  });
  assert.equal(empty?.slotHolders, undefined);
});

runCase('snapshot captures store failures instead of throwing', async () => {
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    deps: observeDeps({
      loadTodosData: () => { throw new Error('todos boom'); },
      loadDelegations: () => { throw new Error('delegations boom'); },
    }),
  });
  assert.equal(snapshot.readyTodoCount, 0);
  assert.equal(snapshot.activeAgentCount, 0);
  assert.deepEqual(snapshot.errors.map((e) => e.scope).sort(), ['delegations', 'todos']);
});

/**
 * Occupancy deps for the execution-pool cases: nothing but the todo rows and the
 * chat list the case passes in, so a pool assertion can only come from those.
 *
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
function poolDeps(overrides = {}) {
  return {
    loadTodosData: () => ({ items: [] }),
    listReadyTodoLeaves: () => [],
    isTodoBranchBlocked: () => false,
    loadDelegations: () => [],
    isActiveDelegationStatus: () => false,
    listWorkspaceChatIds: () => [],
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    getChatRunState: () => ({ waitingForInput: false }),
    ...overrides,
  };
}

runCase('snapshot splits busy tokens into the worktree and project execution pools', async () => {
  const dataDir = freshDataDir('pool-split-mixed');
  // The cycle slot names the orchestrator chat and the todos it drives, so the
  // orchestrator token resolves against the cycle's primary todo (`todoIds[0]`).
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'autopilot',
    enabled: true,
    activeCycles: [{
      cycleId: 'c1',
      chatId: 'orch',
      todoIds: ['t-cycle-wt', 't-cycle-extra'],
      startedAt: '2026-01-01T00:00:00.000Z',
    }],
  }, { dataDir });
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    scoutParentChatIds: ['scout-parent'],
    deps: poolDeps({
      loadTodosData: () => ({ items: [
        { id: 't-wt-claim', status: 'doing', executionMode: 'worktree', claimedByChatId: 'wt-chat' },
        { id: 't-pj-claim', status: 'doing', executionMode: 'project', claimedByChatId: 'pj-chat' },
        { id: 't-wt-leaf', status: 'doing', executionMode: 'worktree' },
        { id: 't-pj-leaf', status: 'doing', executionMode: 'project' },
        { id: 't-wt-nochild', status: 'doing', executionMode: 'worktree' },
        { id: 't-cycle-wt', status: 'doing', executionMode: 'worktree' },
        { id: 't-cycle-extra', status: 'doing', executionMode: 'project' },
        // A leaf closed while its delegated child still runs cannot be traced to
        // a `doing` todo, so that token is placed conservatively.
        { id: 't-ghost', status: 'ready', executionMode: 'worktree' },
        // Unknown liveness holds a worktree claim and must stay out of both pools.
        { id: 't-cold', status: 'doing', executionMode: 'worktree', claimedByChatId: 'cold-chat' },
      ] }),
      listReadyTodoLeaves: () => [{ id: 't-ghost', status: 'ready' }],
      loadDelegations: () => [
        { id: 'd-wt', status: 'running', workspaceFolder: workspaceA, leafId: 't-wt-leaf', parentChatId: 'orch', childChatId: 'wt-child' },
        { id: 'd-nochild', status: 'running', workspaceFolder: workspaceA, leafId: 't-wt-nochild' },
        { id: 'd-pj', status: 'running', workspaceFolder: workspaceA, leafId: 't-pj-leaf', parentChatId: 'orch', childChatId: 'pj-child' },
        { id: 'd-ghost', status: 'running', workspaceFolder: workspaceA, leafId: 't-ghost', childChatId: 'ghost-chat' },
        { id: 'd-scout', status: 'running', workspaceFolder: workspaceA, parentChatId: 'scout-parent', childChatId: 'scout-child' },
      ],
      isActiveDelegationStatus: (status) => status === 'running',
      listWorkspaceChatIds: () => [
        'wt-chat', 'orch', 'pj-chat', 'wt-child', 'pj-child', 'ghost-chat', 'human',
        'scout-parent', 'scout-child', 'cold-chat',
      ],
      probeChatRunLiveness: ({ chatId }) => (chatId === 'cold-chat'
        ? { known: false, busy: false, reason: 'adapter_error' }
        : { known: true, busy: true, reason: 'busy' }),
    }),
  });
  // `busyTokens` keeps its own contract: live chats in store order first, then
  // the synthetic token of the delegation that has no child chat yet.
  assert.deepEqual(snapshot.busyTokens, [
    'wt-chat', 'orch', 'pj-chat', 'wt-child', 'pj-child', 'ghost-chat', 'human', 'delegation:d-nochild',
  ]);
  assert.deepEqual(snapshot.worktreeBusyTokens, ['wt-chat', 'orch', 'wt-child', 'delegation:d-nochild']);
  assert.deepEqual(snapshot.projectBusyTokens, ['pj-chat', 'pj-child', 'ghost-chat', 'human']);
  assert.equal(snapshot.worktreeAgentCount, 4);
  assert.equal(snapshot.projectAgentCount, 4);
  assert.equal(snapshot.activeAgentCount, 8);
  assert.equal(snapshot.scoutAgentCount, 2, 'scout tokens consume neither todo pool');
  assert.equal(snapshot.unknownAgentCount, 1);
  assert.deepEqual(snapshot.unknownChatIds, ['cold-chat']);
  assert.deepEqual(snapshot.errors, []);
});

runCase('snapshot resolves a leaf through the watcher policy default, never an ancestor walk', async () => {
  const cases = [
    { label: 'inherit + policy worktree', todo: { executionMode: 'inherit' }, policy: { executionMode: 'worktree' }, pool: 'worktree' },
    { label: 'missing mode + policy worktree', todo: {}, policy: { executionMode: 'worktree' }, pool: 'worktree' },
    { label: 'inherit + default policy', todo: { executionMode: 'inherit' }, policy: {}, pool: 'project' },
    { label: 'inherit + explicit project policy', todo: { executionMode: 'inherit' }, policy: { executionMode: 'project' }, pool: 'project' },
    // No watcher row at all: the resolver has no default, so the conservative
    // project folder wins (`maxParallel` still caps the total).
    { label: 'inherit + no watcher row', todo: { executionMode: 'inherit' }, row: false, pool: 'project' },
    // The resolver refuses a stored value it does not know. The snapshot stays
    // usable (no `errors` row, which would block every decision) and the token
    // lands in the project pool.
    { label: 'invalid leaf mode falls back to project', todo: { executionMode: 'sideways' }, policy: { executionMode: 'worktree' }, pool: 'project' },
  ];
  for (const [index, testCase] of cases.entries()) {
    const dataDir = freshDataDir(`pool-split-inherit-${index}`);
    if (testCase.row !== false) upsertWorkspaceWatcher(workspaceA, { policy: testCase.policy }, { dataDir });
    const snapshot = await snapshotWorkspaceWatcher({
      workspaceFolder: workspaceA,
      dataDir,
      deps: poolDeps({
        loadTodosData: () => ({ items: [{ id: 't-inherit', status: 'doing', claimedByChatId: 'inh-chat', ...testCase.todo }] }),
        listWorkspaceChatIds: () => ['inh-chat'],
      }),
    });
    const expected = { worktree: ['inh-chat'], project: [] }[testCase.pool];
    const other = { worktree: [], project: ['inh-chat'] }[testCase.pool];
    assert.deepEqual(snapshot.worktreeBusyTokens, expected, testCase.label);
    assert.deepEqual(snapshot.projectBusyTokens, other, testCase.label);
    assert.deepEqual(snapshot.errors, [], testCase.label);
    assert.equal(snapshot.worktreeAgentCount + snapshot.projectAgentCount, snapshot.activeAgentCount, testCase.label);
  }
});

runCase('snapshot pool counts always add up to the busy tokens exactly once', async () => {
  const scenarios = [
    {
      label: 'empty workspace',
      deps: poolDeps(),
    },
    {
      label: 'claim, scout and unknown liveness',
      deps: poolDeps({
        loadTodosData: () => ({ items: [
          { id: 't-wt', status: 'doing', executionMode: 'worktree', claimedByChatId: 'wt-chat' },
          { id: 't-pj', status: 'doing', executionMode: 'project', claimedByChatId: 'own-chat' },
          { id: 't-cold', status: 'doing', executionMode: 'worktree', claimedByChatId: 'cold-chat' },
        ] }),
        listWorkspaceChatIds: () => ['wt-chat', 'own-chat', 'scout-chat', 'cold-chat'],
        probeChatRunLiveness: ({ chatId }) => (chatId === 'cold-chat'
          ? { known: false, busy: false, reason: 'adapter_error' }
          : { known: true, busy: true, reason: 'busy' }),
      }),
      scoutParentChatIds: ['scout-chat'],
    },
    {
      label: 'delegation slots only',
      deps: poolDeps({
        loadTodosData: () => ({ items: [
          { id: 't-wt', status: 'doing', executionMode: 'worktree' },
          { id: 't-pj', status: 'doing', executionMode: 'project' },
        ] }),
        loadDelegations: () => [
          { id: 'd-a', status: 'running', workspaceFolder: workspaceA, leafId: 't-wt' },
          { id: 'd-b', status: 'running', workspaceFolder: workspaceA, leafId: 't-pj', childChatId: 'pj-child' },
          { id: 'd-c', status: 'running', workspaceFolder: workspaceA, childChatId: 'no-leaf-child' },
        ],
        isActiveDelegationStatus: (status) => status === 'running',
        listWorkspaceChatIds: () => ['pj-child', 'no-leaf-child'],
      }),
    },
    {
      label: 'tokens without any todo link',
      deps: poolDeps({ listWorkspaceChatIds: () => ['human-a', 'human-b'] }),
    },
  ];
  for (const scenario of scenarios) {
    const dataDir = freshDataDir(`pool-split-invariant-${scenario.label.replace(/\W+/g, '-')}`);
    const snapshot = await snapshotWorkspaceWatcher({
      workspaceFolder: workspaceA,
      dataDir,
      scoutParentChatIds: scenario.scoutParentChatIds,
      deps: scenario.deps,
    });
    const pooled = [...snapshot.worktreeBusyTokens, ...snapshot.projectBusyTokens];
    assert.equal(
      snapshot.worktreeAgentCount + snapshot.projectAgentCount,
      snapshot.activeAgentCount,
      scenario.label,
    );
    assert.equal(new Set(pooled).size, pooled.length, `${scenario.label}: no token in both pools`);
    assert.deepEqual(pooled.sort(), [...snapshot.busyTokens].sort(), scenario.label);
    assert.deepEqual(snapshot.unknownChatIds.filter((id) => pooled.includes(id)), [], scenario.label);
  }
});

runCase('pool split keeps the scout scenario fields unchanged', async () => {
  // Same fixture as 'snapshot keeps a live scout and its review out of the todo
  // parallel slot': the new pools are additive and must not move an older field.
  const dataDir = freshDataDir('pool-split-regression-scout');
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    scoutParentChatIds: ['scout-parent'],
    deps: poolDeps({
      loadTodosData: () => ({ items: [{ id: 'ready', status: 'ready' }] }),
      listReadyTodoLeaves: () => [{ id: 'ready', status: 'ready' }],
      loadDelegations: () => [{
        id: 'scout-review',
        status: 'running',
        workspaceFolder: workspaceA,
        parentChatId: 'scout-parent',
        childChatId: 'scout-child',
      }],
      isActiveDelegationStatus: (status) => status === 'running',
      listWorkspaceChatIds: () => ['scout-parent', 'scout-child', 'human'],
      probeChatRunLiveness: ({ chatId }) => ({
        known: true,
        busy: chatId !== 'human',
        reason: chatId === 'human' ? 'idle' : 'busy',
      }),
    }),
  });
  assert.deepEqual(snapshot.busyTokens, []);
  assert.equal(snapshot.activeAgentCount, 0);
  assert.equal(snapshot.scoutAgentCount, 2);
  assert.equal(snapshot.unknownAgentCount, 0);
  assert.deepEqual(snapshot.activeDelegationIds, []);
  assert.deepEqual(snapshot.worktreeBusyTokens, []);
  assert.deepEqual(snapshot.projectBusyTokens, []);
  assert.equal(snapshot.worktreeAgentCount, 0);
  assert.equal(snapshot.projectAgentCount, 0);
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy: { maxParallel: 1, requirePlanApproval: false }, stopReason: '' },
    snapshot,
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'ready');
});

runCase('pool split keeps a claim-backed busy token in the project pool by default', async () => {
  // Same fixture as 'a closed-cycle orchestrator that still holds a claim counts
  // as busy', with an untouched policy: `inherit` resolves to `project`.
  const dataDir = freshDataDir('pool-split-regression-claim');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    closedCycleChatIds: ['orch-closed'],
    deps: poolDeps({
      loadTodosData: () => ({ items: [{ id: 't', status: 'doing', claimedByChatId: 'orch-closed' }] }),
      listWorkspaceChatIds: () => ['orch-closed'],
    }),
  });
  assert.deepEqual(snapshot.busyTokens, ['orch-closed']);
  assert.equal(snapshot.activeAgentCount, 1);
  assert.deepEqual(snapshot.projectBusyTokens, ['orch-closed']);
  assert.deepEqual(snapshot.worktreeBusyTokens, []);
  assert.equal(snapshot.projectAgentCount, 1);
  assert.equal(snapshot.worktreeAgentCount, 0);
});

runCase('decide: off, stopped, wait, idle and observe_ready', () => {
  const baseWatcher = { mode: 'observe', enabled: true, policy: { maxParallel: 2 }, stopReason: '' };
  const idleSnapshot = { readyTodoCount: 1, activeAgentCount: 0, errors: [] };
  assert.equal(decideWorkspaceWatcherAction({ watcher: { mode: 'off' }, snapshot: idleSnapshot }).kind, 'off');
  assert.equal(decideWorkspaceWatcherAction({ watcher: { ...baseWatcher, stopReason: 'deadline' }, snapshot: idleSnapshot }).kind, 'stopped');
  assert.equal(decideWorkspaceWatcherAction({ watcher: baseWatcher, snapshot: { readyTodoCount: 1, activeAgentCount: 2, errors: [] } }).kind, 'wait_active');
  assert.equal(decideWorkspaceWatcherAction({ watcher: baseWatcher, snapshot: { readyTodoCount: 0, activeAgentCount: 0, errors: [] } }).kind, 'idle_no_work');

  const ready = decideWorkspaceWatcherAction({ watcher: baseWatcher, snapshot: idleSnapshot });
  assert.equal(ready.kind, 'observe_ready');
  assert.equal(ready.reason, 'idle_has_work');
  assert.equal(ready.shouldNotify, true);
});

runCase('decide: snapshot errors block observe_ready and idle_no_work', () => {
  const watcher = { mode: 'observe', enabled: true, policy: { maxParallel: 2 }, stopReason: '' };
  const withReadyWork = {
    readyTodoCount: 3,
    activeAgentCount: 0,
    errors: [{ scope: 'todos', code: 'ERR', message: 'todos boom' }],
  };
  const decision = decideWorkspaceWatcherAction({ watcher, snapshot: withReadyWork });
  assert.equal(decision.kind, 'snapshot_error');
  assert.equal(decision.reason, 'snapshot_unavailable');
  assert.equal(decision.shouldNotify, false);
});

/**
 * Hand-built snapshot for the per-pool gate: the decision reads only the pool
 * counts and token lists a snapshot carries, so each case states the occupancy it
 * means to test instead of depending on the snapshot's token split. `busyTokens`
 * is the union of both pools, the invariant the real snapshot keeps.
 *
 * @param {{
 *   readyLeaves: object[],
 *   worktree?: number,
 *   project?: number,
 *   worktreeTokens?: string[],
 *   projectTokens?: string[],
 * }} input
 * @returns {object}
 */
function poolSnapshot(input) {
  const worktree = input.worktree || 0;
  const project = input.project || 0;
  const worktreeTokens = input.worktreeTokens || [];
  const projectTokens = input.projectTokens || [];
  return {
    readyTodoCount: input.readyLeaves.length,
    readyLeaves: input.readyLeaves,
    activeAgentCount: worktree + project,
    worktreeAgentCount: worktree,
    projectAgentCount: project,
    worktreeBusyTokens: worktreeTokens,
    projectBusyTokens: projectTokens,
    busyTokens: [...worktreeTokens, ...projectTokens],
    unknownAgentCount: 0,
    errors: [],
  };
}

/**
 * Watcher row for the same cases. `maxParallel` stays above every pool figure so
 * a pool outcome is never the global cap in disguise, and the failure ceiling is
 * finite so an eligibility case can actually disqualify a leaf.
 *
 * @param {object} [policy]
 * @param {object} [extras]
 * @returns {object}
 */
function poolWatcher(policy = {}, extras = {}) {
  return {
    mode: 'autopilot',
    enabled: true,
    stopReason: '',
    policy: { maxParallel: 4, requirePlanApproval: false, maxConsecutiveFailures: 2, ...policy },
    ...extras,
  };
}

const WT_LEAF = { id: 'wt', status: 'ready', siblingIndex: 0, executionMode: 'worktree' };
const PJ_LEAF = { id: 'pj', status: 'ready', siblingIndex: 1, executionMode: 'project' };

runCase('decide: a full worktree pool waits with worktree_parallel and names its holders', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelWorktree: 2 }),
    snapshot: poolSnapshot({
      readyLeaves: [WT_LEAF],
      worktree: 2,
      worktreeTokens: ['wt-chat', 'delegation:wt-d', 'wt-chat'],
      // A project holder occupies the global cap but not the worktree pool, so it
      // must stay out of the reported slots.
      project: 1,
      projectTokens: ['pj-chat'],
    }),
  });
  assert.equal(decision.kind, 'wait_active');
  assert.equal(decision.reason, 'worktree_parallel');
  assert.equal(decision.shouldNotify, false);
  assert.equal(decision.nextTodoId, '', 'a candidate nobody may start is not carried as the next todo');
  assert.deepEqual(decision.slotHolders, ['wt-chat', 'delegation:wt-d'], 'only the saturated pool holds slots');
});

runCase('decide: a full project pool waits with project_parallel and names its holders', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelProject: 1 }),
    snapshot: poolSnapshot({
      readyLeaves: [PJ_LEAF],
      project: 1,
      projectTokens: ['pj-chat'],
      worktree: 1,
      worktreeTokens: ['wt-chat'],
    }),
  });
  assert.equal(decision.kind, 'wait_active');
  assert.equal(decision.reason, 'project_parallel');
  assert.deepEqual(decision.slotHolders, ['pj-chat']);
});

runCase('decide: both pools below their limits start the first-picked candidate', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelWorktree: 2, maxParallelProject: 2 }),
    snapshot: poolSnapshot({ readyLeaves: [WT_LEAF, PJ_LEAF], worktree: 1, project: 1 }),
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'wt');
  assert.equal(decision.slotHolders, undefined);
});

runCase('decide: a full worktree pool falls through to an eligible project todo', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelWorktree: 2 }),
    snapshot: poolSnapshot({
      readyLeaves: [WT_LEAF, PJ_LEAF],
      worktree: 2,
      worktreeTokens: ['wt-a', 'wt-b'],
      project: 0,
    }),
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'pj', 'the other pool keeps working instead of starving');
});

runCase('decide: a full project pool falls through to an eligible worktree todo', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelProject: 1 }),
    snapshot: poolSnapshot({
      readyLeaves: [
        { ...PJ_LEAF, siblingIndex: 0 },
        { ...WT_LEAF, siblingIndex: 1 },
      ],
      project: 1,
      projectTokens: ['pj-a'],
      worktree: 0,
    }),
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'wt');
});

runCase('decide: the pool fallback keeps the pick order and every eligibility rule', () => {
  // `pj-blocked` sorts ahead of `pj-free` and is disqualified twice over: the
  // failure ceiling and the integration wait. The fallback may only step over the
  // saturated pool, never over a leaf the plain pick would have skipped.
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelWorktree: 1 }, { failures: { 'pj-blocked': 2 } }),
    snapshot: poolSnapshot({
      readyLeaves: [
        WT_LEAF,
        { id: 'pj-blocked', status: 'ready', siblingIndex: 1, executionMode: 'project' },
        { id: 'pj-integration', status: 'ready', siblingIndex: 2, executionMode: 'project', integration: { state: 'ready' } },
        { id: 'pj-free', status: 'ready', siblingIndex: 3, executionMode: 'project' },
      ],
      worktree: 1,
      worktreeTokens: ['wt-a'],
    }),
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'pj-free');
});

runCase('decide: pool occupancy never blocks a candidate from the other pool', () => {
  // The worktree pool has room while the project pool is three-over-its-limit,
  // and the global cap (4) still has one slot, so the worktree leaf starts.
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelWorktree: 1, maxParallelProject: 1 }),
    snapshot: poolSnapshot({
      readyLeaves: [WT_LEAF],
      worktree: 0,
      project: 3,
      projectTokens: ['pj-a', 'pj-b', 'pj-c'],
    }),
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'wt');
});

runCase('decide: the global cap and unknown liveness still outrank the pool gate', () => {
  const capped = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallel: 2, maxParallelWorktree: 1 }),
    snapshot: poolSnapshot({
      readyLeaves: [WT_LEAF, PJ_LEAF],
      worktree: 2,
      worktreeTokens: ['wt-a', 'wt-b'],
    }),
  });
  assert.equal(capped.reason, 'max_parallel', 'the sum of both pools is still the first gate');
  assert.deepEqual(capped.slotHolders, ['wt-a', 'wt-b']);

  const unknown = decideWorkspaceWatcherAction({
    // The unknown occupies one slot, so 1 active + 1 unknown fills maxParallel 2.
    watcher: poolWatcher({ maxParallel: 2, maxParallelWorktree: 1 }),
    snapshot: {
      ...poolSnapshot({ readyLeaves: [WT_LEAF, PJ_LEAF], worktree: 1, worktreeTokens: ['wt-a'] }),
      unknownAgentCount: 1,
    },
  });
  assert.equal(unknown.kind, 'wait_active');
  assert.equal(unknown.reason, 'unknown_liveness', 'the liveness guard stays global, not per pool');
  assert.equal(unknown.slotHolders, undefined);
});

runCase('decide: an inherit todo is gated by the pool its policy default resolves to', () => {
  const leaves = [{ id: 'inherited', status: 'ready', siblingIndex: 0, executionMode: 'inherit' }];
  const snapshot = poolSnapshot({ readyLeaves: leaves, worktree: 1, worktreeTokens: ['wt-chat'] });
  const gated = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ executionMode: 'worktree', maxParallelWorktree: 1 }),
    snapshot,
  });
  assert.equal(gated.reason, 'worktree_parallel', 'the leaf inherits the worktree pool from the policy');
  const unlimed = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ executionMode: 'worktree' }),
    snapshot,
  });
  assert.equal(unlimed.kind, 'start_cycle');
  assert.equal(unlimed.nextTodoId, 'inherited');
});

runCase('decide: an unusable executionMode falls back to the project pool without erroring', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelProject: 1 }),
    snapshot: poolSnapshot({
      readyLeaves: [{ id: 'weird', status: 'ready', siblingIndex: 0, executionMode: 'sideways' }],
      project: 1,
      projectTokens: ['pj-chat'],
    }),
  });
  assert.equal(decision.kind, 'wait_active');
  assert.equal(decision.reason, 'project_parallel', 'the same conservative pool as the snapshot split');
});

runCase('decide: a snapshot without pool counts behaves as zero occupancy', () => {
  for (const counts of [
    {},
    { worktreeAgentCount: undefined, projectAgentCount: undefined },
    { worktreeAgentCount: 'many', projectAgentCount: NaN },
    { worktreeAgentCount: -3, projectAgentCount: -1 },
  ]) {
    const decision = decideWorkspaceWatcherAction({
      watcher: poolWatcher({ maxParallelWorktree: 1, maxParallelProject: 1 }),
      snapshot: {
        readyTodoCount: 1,
        activeAgentCount: 0,
        readyLeaves: [WT_LEAF],
        errors: [],
        ...counts,
      },
    });
    assert.equal(decision.kind, 'start_cycle');
    assert.equal(decision.nextTodoId, 'wt');
  }
});

runCase('decide: worktree occupancy from a real snapshot gates only the worktree leaf', async () => {
  const dataDir = freshDataDir('pool-gate-live-snapshot');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'autopilot',
    enabled: true,
    policy: { maxParallel: 3, maxParallelWorktree: 1, requirePlanApproval: false, cooldownMs: 0 },
  }, { dataDir });
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    deps: poolDeps({
      loadTodosData: () => ({ items: [
        { id: 't-wt-busy', status: 'doing', executionMode: 'worktree', claimedByChatId: 'wt-agent' },
        { id: 't-wt-ready', status: 'ready', siblingIndex: 0, executionMode: 'worktree' },
        { id: 't-pj-ready', status: 'ready', siblingIndex: 1, executionMode: 'project' },
      ] }),
      listReadyTodoLeaves: () => [
        { id: 't-wt-ready', status: 'ready', siblingIndex: 0, executionMode: 'worktree' },
        { id: 't-pj-ready', status: 'ready', siblingIndex: 1, executionMode: 'project' },
      ],
      listWorkspaceChatIds: () => ['wt-agent'],
    }),
  });
  // The busy claim is traced to its worktree leaf, so the pool the decision reads
  // is the one the snapshot split produced — not a figure this case invented.
  assert.deepEqual(snapshot.worktreeBusyTokens, ['wt-agent']);
  assert.deepEqual(snapshot.projectBusyTokens, []);
  assert.equal(snapshot.activeAgentCount, 1, 'the global cap leaves two slots free');
  const decision = decideWorkspaceWatcherAction({
    watcher: getWorkspaceWatcher(workspaceA, { dataDir }),
    snapshot,
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 't-pj-ready', 'the saturated pool is skipped, not waited on');
});

runCase('decide: zero pool limits leave every decision unchanged', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const scenarios = [
    {
      label: 'off',
      watcher: { mode: 'off' },
      snapshot: { readyTodoCount: 1, activeAgentCount: 0, errors: [] },
    },
    {
      label: 'paused',
      watcher: { mode: 'autopilot', enabled: true, paused: true, policy: { maxParallel: 2 }, stopReason: '' },
      snapshot: { readyTodoCount: 1, activeAgentCount: 0, errors: [] },
    },
    {
      label: 'stopped',
      watcher: { mode: 'autopilot', enabled: true, policy: { maxParallel: 2 }, stopReason: 'deadline' },
      snapshot: { readyTodoCount: 1, activeAgentCount: 0, errors: [] },
    },
    {
      label: 'snapshot_error',
      watcher: { mode: 'observe', enabled: true, policy: { maxParallel: 2 }, stopReason: '' },
      snapshot: { readyTodoCount: 3, activeAgentCount: 0, errors: [{ scope: 'todos', code: 'ERR', message: 'todos boom' }] },
    },
    {
      label: 'max_parallel',
      watcher: { mode: 'observe', enabled: true, policy: { maxParallel: 2 }, stopReason: '' },
      snapshot: { readyTodoCount: 1, activeAgentCount: 2, errors: [], busyTokens: ['a', 'b', 'b'] },
    },
    {
      label: 'unknown_liveness',
      watcher: { mode: 'autopilot' },
      snapshot: { readyTodoCount: 1, activeAgentCount: 0, unknownAgentCount: 1, readyLeaves: [{ id: 'ready' }] },
    },
    {
      label: 'no_ready_work',
      watcher: { mode: 'observe', enabled: true, policy: { maxParallel: 2 }, stopReason: '' },
      snapshot: { readyTodoCount: 0, activeAgentCount: 0, errors: [] },
    },
    {
      label: 'observe_ready',
      watcher: { mode: 'observe', enabled: true, policy: { maxParallel: 2 }, stopReason: '' },
      snapshot: { readyTodoCount: 1, activeAgentCount: 0, errors: [], readyLeaves: [{ id: 'ready' }] },
    },
    {
      label: 'no_eligible_work',
      watcher: poolWatcher({ maxConsecutiveFailures: 1 }, { failures: { wt: 1 } }),
      snapshot: poolSnapshot({ readyLeaves: [WT_LEAF] }),
    },
    {
      label: 'start_cycle',
      watcher: poolWatcher(),
      snapshot: poolSnapshot({ readyLeaves: [WT_LEAF, PJ_LEAF] }),
    },
    {
      label: 'pools_full_yet_unlimited',
      watcher: poolWatcher(),
      snapshot: poolSnapshot({
        readyLeaves: [WT_LEAF, PJ_LEAF],
        worktree: 2,
        project: 1,
        worktreeTokens: ['wt-a', 'wt-b'],
        projectTokens: ['pj-a'],
      }),
    },
    {
      label: 'plan_gate',
      watcher: poolWatcher({ requirePlanApproval: true }),
      snapshot: poolSnapshot({ readyLeaves: [WT_LEAF] }),
    },
  ];
  for (const scenario of scenarios) {
    const baseline = decideWorkspaceWatcherAction({ watcher: scenario.watcher, snapshot: scenario.snapshot, now });
    const zeroLimits = decideWorkspaceWatcherAction({
      watcher: {
        ...scenario.watcher,
        policy: { ...(scenario.watcher.policy || {}), maxParallelWorktree: 0, maxParallelProject: 0 },
      },
      snapshot: scenario.snapshot,
      now,
    });
    assert.deepEqual(zeroLimits, baseline, `${scenario.label}: explicit 0 limits change nothing`);
  }
});

runCase('decide: a pool saturated by cycles waits with cycle_active and names the pool', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelWorktree: 2 }),
    snapshot: poolSnapshot({ readyLeaves: [WT_LEAF] }),
    activeCycleCounts: { worktree: 2, project: 0 },
  });
  assert.equal(decision.kind, 'wait_active');
  assert.equal(decision.reason, 'cycle_active', 'this row is waiting on its own cycles, not on outside agents');
  assert.equal(decision.pool, 'worktree');
  assert.equal(decision.nextTodoId, '');
  assert.equal(decision.slotHolders, undefined, 'a cycle slot is never reported as an external holder');
});

runCase('decide: cycles filling one pool never block a candidate of the other pool', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelWorktree: 1, maxParallelProject: 1 }),
    snapshot: poolSnapshot({ readyLeaves: [WT_LEAF, PJ_LEAF] }),
    activeCycleCounts: { worktree: 1, project: 0 },
  });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 'pj', 'the worktree cycles do not starve the project pool');
  assert.equal(decision.pool, undefined, 'the marker belongs to a refused wait only');
});

runCase('decide: external occupancy keeps the pool reason when both sources fill a pool', () => {
  // Both the snapshot's worktree agents and the row's worktree cycles are at the
  // ceiling. The cause is picked deterministically — agents first — so the wait
  // keeps the pool's own reason whenever outside occupancy alone explains it.
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ maxParallelWorktree: 1 }),
    snapshot: poolSnapshot({ readyLeaves: [WT_LEAF], worktree: 1, worktreeTokens: ['wt-chat'] }),
    activeCycleCounts: { worktree: 1, project: 0 },
  });
  assert.equal(decision.kind, 'wait_active');
  assert.equal(decision.reason, 'worktree_parallel');
  assert.deepEqual(decision.slotHolders, ['wt-chat']);
  assert.equal(decision.pool, undefined);
});

runCase('decide: cycles gate an inherit leaf through the policy default, like any other pool check', () => {
  const decision = decideWorkspaceWatcherAction({
    watcher: poolWatcher({ executionMode: 'worktree', maxParallelWorktree: 1 }),
    snapshot: poolSnapshot({ readyLeaves: [{ id: 'inherited', status: 'ready', siblingIndex: 0, executionMode: 'inherit' }] }),
    activeCycleCounts: { worktree: 1 },
  });
  assert.equal(decision.reason, 'cycle_active');
  assert.equal(decision.pool, 'worktree');
});

runCase('decide: absent, zero or unusable cycle counts read as no cycles at all', () => {
  for (const counts of [
    undefined,
    null,
    'worktree',
    {},
    { worktree: 0, project: 0 },
    { worktree: 'many', project: NaN },
    { worktree: -3, project: -1 },
  ]) {
    const decision = decideWorkspaceWatcherAction({
      watcher: poolWatcher({ maxParallelWorktree: 1, maxParallelProject: 1 }),
      snapshot: poolSnapshot({ readyLeaves: [WT_LEAF] }),
      activeCycleCounts: counts,
    });
    assert.equal(decision.kind, 'start_cycle', JSON.stringify(counts));
    assert.equal(decision.nextTodoId, 'wt', JSON.stringify(counts));
  }
});

runCase('decide: cycle counts change no decision while no pool limit is configured', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const scenarios = [
    {
      label: 'start_cycle',
      watcher: poolWatcher(),
      snapshot: poolSnapshot({ readyLeaves: [WT_LEAF, PJ_LEAF] }),
    },
    {
      label: 'plan_gate',
      watcher: poolWatcher({ requirePlanApproval: true }),
      snapshot: poolSnapshot({ readyLeaves: [WT_LEAF] }),
    },
    {
      label: 'max_parallel',
      watcher: poolWatcher({ maxParallel: 2 }),
      snapshot: poolSnapshot({ readyLeaves: [WT_LEAF], worktree: 2, worktreeTokens: ['a', 'b'] }),
    },
    {
      label: 'pool_agent_wait',
      watcher: poolWatcher({ maxParallelWorktree: 1 }),
      snapshot: poolSnapshot({ readyLeaves: [WT_LEAF], worktree: 1, worktreeTokens: ['a'] }),
    },
    {
      label: 'no_ready_work',
      watcher: poolWatcher(),
      snapshot: poolSnapshot({ readyLeaves: [] }),
    },
  ];
  for (const scenario of scenarios) {
    const without = decideWorkspaceWatcherAction({ watcher: scenario.watcher, snapshot: scenario.snapshot, now });
    const withCycles = decideWorkspaceWatcherAction({
      watcher: scenario.watcher,
      snapshot: scenario.snapshot,
      now,
      // Both pools read as far over any ceiling the policy could hold: with no
      // limit configured this must be indistinguishable from no cycles at all.
      activeCycleCounts: { worktree: 10, project: 10 },
    });
    assert.deepEqual(withCycles, without, `${scenario.label}: unconfigured pools ignore cycle counts`);
  }
});

runCase('tick records snapshot_error when todos store fails', async () => {
  const dataDir = freshDataDir('tick-snapshot-error');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const tick = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    token: 'err-token',
    deps: observeDeps({
      loadTodosData: () => { throw new Error('todos boom'); },
    }),
  });
  assert.equal(tick.action, 'snapshot_error');
  assert.equal(tick.shouldNotify, false);
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.decisions.at(-1).kind, 'snapshot_error');
});

runCase('document CAS rejects stale lease takeover across parallel writers', () => {
  const dataDir = freshDataDir('persist-cas');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  upsertWorkspaceWatcher(workspaceA, {
    lease: { ownerPid: 42, token: 'foreign', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  const first = mutateWorkspaceWatcherRow(workspaceA, ({ row }) => {
    const lease = acquireWorkspaceWatcherLease(row, { token: 'writer-a', ttlMs: 60_000, now: t0 });
    if (!lease.acquired) return null;
    return { lease: lease.lease, lastTickAt: new Date(t0).toISOString() };
  }, { dataDir });
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'aborted');
  const second = mutateWorkspaceWatcherRow(workspaceA, ({ row }) => {
    const lease = acquireWorkspaceWatcherLease(row, { token: 'foreign', ttlMs: 60_000, now: t0 });
    if (!lease.acquired) return null;
    return { lease: lease.lease, lastTickAt: new Date(t0 + 1000).toISOString() };
  }, { dataDir });
  assert.equal(second.ok, true);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).lease.token, 'foreign');
  upsertWorkspaceWatcher(workspaceA, { orchestratorChatId: 'bump' }, { dataDir });
  const result = mutateWorkspaceWatcherRow(workspaceA, () => ({ orchestratorChatId: 'cas-win' }), { dataDir });
  assert.equal(result.ok, true);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).orchestratorChatId, 'cas-win');
});

runCase('snapshot matches delegations via canonical workspace paths', async () => {
  const link = path.join(tmpRoot, 'canonical-link');
  const target = path.join(tmpRoot, 'canonical-target');
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.symlinkSync(target, link, 'dir');
  } catch {
    console.log('SKIP: symlink unavailable for canonical workspace test');
    return;
  }
  const snapshot = await snapshotWorkspaceWatcher({
    workspaceFolder: link,
    deps: observeDeps({
      loadDelegations: () => [{ id: 'd-link', status: 'running', workspaceFolder: target }],
      isActiveDelegationStatus: (status) => status === 'running',
    }),
  });
  assert.deepEqual(snapshot.activeDelegationIds, ['d-link']);
});

runCase('tick in off mode does not write the store', async () => {
  const dataDir = freshDataDir('tick-off');
  upsertWorkspaceWatcher(workspaceA, { mode: 'off' }, { dataDir });
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const before = fs.readFileSync(file, 'utf8');
  const tick = await tickWorkspaceWatcher({ workspaceFolder: workspaceA, dataDir, now: Date.now(), deps: observeDeps() });
  assert.equal(tick.action, 'off');
  assert.equal(tick.wrote, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).lastTickAt, '');
});

runCase('tick in observe mode records one deduped decision and keeps the lease', async () => {
  const dataDir = freshDataDir('tick-observe');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');

  const first = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    now: t0,
    token: 'test-token',
    decisionDedupeMs: 60_000,
    deps: observeDeps(),
  });
  assert.equal(first.action, 'observe_ready');
  assert.equal(first.recorded, true);
  assert.equal(first.shouldNotify, true);

  const second = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    now: t0 + 1000,
    token: 'test-token',
    decisionDedupeMs: 60_000,
    deps: observeDeps(),
  });
  assert.equal(second.recorded, false, 'same decision within dedupe window is not spammed');

  const third = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    now: t0 + 120_000,
    token: 'test-token',
    decisionDedupeMs: 60_000,
    deps: observeDeps(),
  });
  assert.equal(third.recorded, true);

  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.decisions.length, 2);
  assert.equal(row.lease.token, 'test-token');
  assert.ok(row.lastTickAt);
});

runCase('idle no-work decisions dedupe for ten minutes but record state changes immediately', () => {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const idle = {
    kind: 'idle_no_work',
    reason: 'no_ready_work',
    readyTodoCount: 0,
    activeAgentCount: 0,
    scoutAgentCount: 0,
    unknownAgentCount: 0,
  };
  const watcher = { decisions: [{ at: new Date(t0).toISOString(), ...idle }] };

  assert.equal(
    shouldRecordDecision(watcher, idle, t0 + WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS - 1, WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS),
    false,
    'an identical idle decision stays deduped for the full ten-minute window',
  );
  assert.equal(
    shouldRecordDecision(watcher, idle, t0 + WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS, WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS),
    true,
    'the idle decision is refreshed after ten minutes',
  );
  assert.equal(
    shouldRecordDecision(watcher, { ...idle, reason: 'phase_disabled:implement' }, t0 + 1, WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS),
    true,
    'a reason change is recorded immediately',
  );
  for (const counter of ['readyTodoCount', 'activeAgentCount', 'scoutAgentCount', 'unknownAgentCount']) {
    assert.equal(
      shouldRecordDecision(watcher, { ...idle, [counter]: 1 }, t0 + 1, WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS),
      true,
      `${counter} change is recorded immediately`,
    );
  }

  const priorReason = { at: new Date(t0 - 1000).toISOString(), ...idle, reason: 'phase_disabled:implement' };
  assert.equal(
    shouldRecordDecision(
      { decisions: [priorReason, watcher.decisions[0]] },
      { ...idle, reason: priorReason.reason },
      t0 + 1,
      WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS,
    ),
    true,
    'leaving idle no-work records a reason change even when that reason appeared recently',
  );

  const priorKind = { at: new Date(t0 - 1000).toISOString(), ...idle, kind: 'wait_active', reason: 'max_parallel' };
  assert.equal(
    shouldRecordDecision(
      { decisions: [priorKind, watcher.decisions[0]] },
      priorKind,
      t0 + 1,
      WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS,
    ),
    true,
    'leaving idle no-work records a kind change even when that decision appeared recently',
  );
});

runCase('tick uses the ten-minute idle no-work cadence by default', async () => {
  const dataDir = freshDataDir('tick-idle-no-work-dedupe');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const deps = observeDeps({
    loadTodosData: () => ({ items: [] }),
    listReadyTodoLeaves: () => [],
  });
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');

  const first = await tickWorkspaceWatcher({ workspaceFolder: workspaceA, dataDir, now: t0, token: 'idle-token', deps });
  const beforeWindow = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    now: t0 + WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS - 1,
    token: 'idle-token',
    deps,
  });
  const atWindow = await tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    now: t0 + WORKSPACE_WATCHER_IDLE_NO_WORK_DEDUPE_MS,
    token: 'idle-token',
    deps,
  });

  assert.equal(first.recorded, true);
  assert.equal(beforeWindow.recorded, false);
  assert.equal(atWindow.recorded, true);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).decisions.length, 2);
});

runCase('tick yields to a foreign live lease', async () => {
  const dataDir = freshDataDir('tick-lease');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  acquireWorkspaceWatcherLease({}, { token: 'other', ttlMs: 60_000, now: t0 });
  upsertWorkspaceWatcher(workspaceA, {
    lease: { ownerPid: 999, token: 'other', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  const tick = await tickWorkspaceWatcher({ workspaceFolder: workspaceA, dataDir, now: t0, token: 'mine', deps: observeDeps() });
  assert.equal(tick.action, 'lease_held');
  assert.equal(tick.wrote, false);
});

runCase('heartbeat scans all rows, touches only observe and never throws on corrupt store', async () => {
  const dataDir = freshDataDir('heartbeat');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  upsertWorkspaceWatcher(workspaceB, { mode: 'off' }, { dataDir });
  const result = await runWorkspaceWatcherHeartbeat({ dataDir, now: Date.now(), token: 'hb', deps: observeDeps() });
  assert.equal(result.scanned, 2);
  assert.equal(result.observed, 1);
  assert.equal(result.wrote, 1);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].workspaceFolder, workspaceA);
  assert.equal(result.decisions[0].kind, 'observe_ready');
  assert.equal(result.errors.length, 0);
  assert.equal(getWorkspaceWatcher(workspaceB, { dataDir }).lastTickAt, '');

  const corruptDir = freshDataDir('heartbeat-corrupt');
  fs.writeFileSync(getWorkspaceWatchersDataPath({ dataDir: corruptDir }), '{ bad', 'utf8');
  const corrupt = await runWorkspaceWatcherHeartbeat({ dataDir: corruptDir, now: Date.now(), token: 'hb' });
  assert.equal(corrupt.scanned, 0);
  assert.equal(corrupt.errors.length, 1);
  assert.equal(corrupt.errors[0].code, 'WORKSPACE_WATCHERS_CORRUPT');
});

runCase('runtime worker heartbeat runs when delegation store tick fails', async () => {
  const folder = path.join(tmpRoot, 'runtime-degraded-watcher');
  upsertWorkspaceWatcher(folder, { mode: 'observe' });
  const delegPath = getDelegationsDataPath();
  const backup = fs.existsSync(delegPath) ? fs.readFileSync(delegPath, 'utf8') : null;
  fs.writeFileSync(delegPath, '{ not-json', 'utf8');
  resetDelegationRuntimeHealth();
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  const row = getWorkspaceWatcher(folder);
  assert.ok(row.lastTickAt, 'watcher heartbeat ran despite delegation store failure');
  if (backup != null) {
    fs.writeFileSync(delegPath, backup, 'utf8');
  } else if (fs.existsSync(delegPath)) {
    fs.unlinkSync(delegPath);
  }
  resetDelegationRuntimeHealth();
});

runCase('delegation-runtime-worker heartbeat drives observe rows (integration)', async () => {
  resetDelegationRuntimeHealth();
  const folder = path.join(tmpRoot, 'worker-integration');
  const dataDir = freshDataDir('worker-integration');
  upsertWorkspaceWatcher(folder, { mode: 'observe' }, { dataDir });
  await tickDelegationRuntime({
    now: Date.now(),
    drainMailbox: false,
    workspaceWatcher: {
      dataDir,
      deps: observeDeps({
        loadTodosData: () => ({ items: [] }),
        listReadyTodoLeaves: () => [],
      }),
    },
  });
  const row = getWorkspaceWatcher(folder, { dataDir });
  assert.ok(row.lastTickAt, 'runtime worker tick ran the watcher heartbeat');
  assert.ok(row.decisions.length >= 1);
  assert.equal(row.decisions.at(-1).kind, 'idle_no_work');
  assert.equal(ISOLATED_DATA_DIR, getWorkspaceWatchersDataPath().replace(/\/workspace-watchers\.json$/, ''));
});

runCase('cross-process CAS: parallel children lose no updates and no lease is stolen', async () => {
  const dataDir = freshDataDir('persist-cross-process');
  const shared = path.join(tmpRoot, 'cas-shared');
  const witnessPath = path.join(dataDir, 'critical-section-witness.log');
  const criticalMs = 3;
  const childCount = 3;
  const iterations = 20;
  const ownWorkspaces = Array.from({ length: childCount }, (_, i) => path.join(tmpRoot, `cas-own-${i}`));
  upsertWorkspaceWatcher(shared, { mode: 'observe' }, { dataDir });
  for (const own of ownWorkspaces) upsertWorkspaceWatcher(own, { mode: 'observe' }, { dataDir });

  const helperPath = fileURLToPath(new URL('./helpers/workspace-watcher-cas-child.js', import.meta.url));
  const startAt = Date.now() + 700;
  const results = await Promise.all(ownWorkspaces.map((own, index) => new Promise((resolve) => {
    const child = spawn(process.execPath, [
      helperPath,
      dataDir,
      String(index),
      String(iterations),
      String(startAt),
      shared,
      own,
      witnessPath,
      String(criticalMs),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => resolve({ index, code, out, err }));
  })));

  for (const result of results) {
    assert.equal(result.code, 0, `child ${result.index} exited with ${result.code}: ${result.err || result.out}`);
  }
  const stats = results.map((result) => JSON.parse(result.out.trim().split('\n').at(-1)));
  assert.equal(new Set(stats.map((s) => s.pid)).size, childCount, 'children run as separate processes');
  for (const stat of stats) {
    assert.equal(stat.failures.length, 0, `child ${stat.childIndex}: ${JSON.stringify(stat.failures)}`);
    assert.equal(stat.iterations, iterations);
  }

  const sharedRow = getWorkspaceWatcher(shared, { dataDir });
  assert.equal(
    sharedRow.cycleCount,
    childCount * iterations,
    'every concurrent increment survived — no lost update on the shared row',
  );
  assert.ok(
    stats.some((stat) => `child-${stat.childIndex}` === sharedRow.lease.token),
    'the shared lease belongs to exactly one child',
  );
  assert.ok(
    stats.reduce((sum, stat) => sum + stat.leaseAborts, 0) > 0,
    'a live foreign lease was refused instead of being stolen',
  );
  for (let i = 0; i < childCount; i += 1) {
    const row = getWorkspaceWatcher(ownWorkspaces[i], { dataDir });
    assert.equal(row.decisions.length, iterations, `own row ${i} kept every write`);
    assert.equal(row.lease.token, `child-${i}`);
    assert.ok(row.lease.expiresAt);
  }
  const doc = loadWorkspaceWatchersDocument({ dataDir });
  assert.ok(
    doc.revision >= 4 + childCount * iterations * 3,
    `revision ${doc.revision} reflects every committed write`,
  );

  // The children bracket their timed critical section with markers written
  // inside the store lock, so two processes sharing it would interleave.
  const witness = fs.readFileSync(witnessPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(witness.length, childCount * iterations * 2, 'every critical section logged enter and exit');
  let inside = null;
  witness.forEach((line, index) => {
    const [marker, child, ownerPid] = line.split(' ');
    const who = `${child}@${ownerPid}`;
    if (marker === 'E') {
      assert.equal(inside, null, `overlapping critical sections at ${index + 1}: ${inside} then ${who}`);
      inside = who;
      return;
    }
    assert.equal(marker, 'X', `witness line ${index + 1} is not an exit: ${line}`);
    assert.equal(inside, who, `a process exited a critical section it never entered (${index + 1})`);
    inside = null;
  });
  assert.equal(inside, null, 'a child left the store lock held');
});

runCase('delegation boot stays ready when the optional watcher store is corrupt', async () => {
  // Earlier cases corrupt the delegations store on purpose and restore it at the
  // end; drop a leftover so this boot isolates the watcher-store failure only.
  const delegPath = getDelegationsDataPath();
  if (fs.existsSync(delegPath)) {
    try {
      JSON.parse(fs.readFileSync(delegPath, 'utf8'));
    } catch {
      fs.rmSync(delegPath, { force: true });
    }
  }
  const file = getWorkspaceWatchersDataPath();
  const corrupt = '{ boot must isolate me';
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.writeFileSync(file, corrupt, 'utf8');
  resetDelegationLifecycleForTest();
  try {
    await bootDelegationRuntime({ intervalMs: 60 });
    const snapshot = getDelegationLifecycleSnapshot();
    assert.equal(snapshot.state, 'ready', `boot degraded: ${JSON.stringify(snapshot.error)}`);
    assert.equal(snapshot.acceptingWork, true);
    assert.equal(snapshot.error, null);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      corrupt,
      'boot never rewrites the corrupt watcher store',
    );
  } finally {
    await shutdownDelegationRuntime({ timeoutMs: 4000 });
    resetDelegationLifecycleForTest();
    if (backup != null) fs.writeFileSync(file, backup, 'utf8');
    else fs.rmSync(file, { force: true });
  }
});

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

runCase('delegation boot repairs a missing todo.review snapshot', async () => {
  const workspace = fs.mkdtempSync(path.join(tmpRoot, 'boot-review-'));
  const todo = addTodo(ISOLATED_DATA_DIR, workspace, { title: 'Boot review', status: 'doing' }).item;
  const impl = createDelegationRecord({
    parentChatId: 'boot-review-parent',
    workspaceFolder: workspace,
    executor: { transport: 'opencode', model: 'gpt-5' },
    assignment: 'implement',
    executionMode: 'agent',
    leafId: todo.id,
    queuedAt: '2026-01-01T00:00:01.000Z',
  });
  updateDelegationRecord(impl.id, {
    status: 'completed',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
  });
  const review = createDelegationRecord({
    parentChatId: 'boot-review-parent',
    workspaceFolder: workspace,
    executor: { transport: 'opencode', model: 'deepseek-chat' },
    assignment: 'review',
    executionMode: 'agent',
    leafId: todo.id,
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
    queuedAt: '2026-01-01T00:00:02.000Z',
  });
  updateDelegationRecord(review.id, {
    status: 'completed',
    startedAt: '2026-01-01T00:00:02.000Z',
    finishedAt: '2026-01-01T00:00:03.000Z',
    report: 'VERDICT: PASS',
    reportVerdict: 'PASS',
  });
  assert.equal(
    loadTodosData(ISOLATED_DATA_DIR, workspace).items.find((row) => row.id === todo.id).review,
    undefined,
    'precondition: the crash left no snapshot',
  );
  resetDelegationLifecycleForTest();
  try {
    await bootDelegationRuntime({ intervalMs: 60 });
    const row = loadTodosData(ISOLATED_DATA_DIR, workspace).items.find((entry) => entry.id === todo.id);
    assert.equal(row.review.code.state, 'passed');
    assert.equal(row.review.code.reviewers[0].attemptId, review.attemptId);
  } finally {
    await shutdownDelegationRuntime({ timeoutMs: 4000 });
    resetDelegationLifecycleForTest();
  }
});

/**
 * A real workspace directory used as both the watcher key and the todo-store
 * cwd (which hashes realpath), so claim/release operate on one consistent store.
 *
 * @param {string} name
 * @returns {string}
 */
function makeWorkspace(name) {
  const dir = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} title
 * @param {object} [extra]
 * @returns {object}
 */
function addReadyTodo(dataDir, cwd, title, extra = {}) {
  return addTodo(dataDir, cwd, { title, status: 'ready', ...extra }).item;
}

runCase('pick: oldest ready leaf wins; doing/blocked excluded; failure ceiling skips', () => {
  const items = [
    { id: 'b', status: 'ready', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'a', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c', status: 'doing', createdAt: '2025-12-31T00:00:00.000Z' },
  ];
  assert.equal(pickNextWorkspaceReadyTodo({ items })?.id, 'a', 'oldest ready leaf');
  assert.equal(pickNextWorkspaceReadyTodo({ items, failures: { a: 2 }, maxFailures: 2 })?.id, 'b', 'a at ceiling is skipped');
  assert.equal(pickNextWorkspaceReadyTodo({ items, failures: { a: 2, b: 5 }, maxFailures: 2 }), null, 'all capped -> none');
});

runCase('pick: sibling position orders siblings only, not leaves of other trees', () => {
  const big = { id: 'big', status: 'doing', runMode: 'parallel', plan: { markdown: 'x', approvedAt: 'y' } };
  const other = { id: 'other', status: 'doing', runMode: 'parallel', plan: { markdown: 'x', approvedAt: 'y' } };
  const late = { id: 'late', parentId: 'big', siblingIndex: 9, status: 'ready', updatedAt: '2026-01-01T00:00:00.000Z' };
  const early = { id: 'early', parentId: 'big', siblingIndex: 2, status: 'ready', updatedAt: '2026-01-03T00:00:00.000Z' };
  const fresh = { id: 'fresh', parentId: 'other', siblingIndex: 0, status: 'ready', updatedAt: '2026-01-02T00:00:00.000Z' };
  // `late` (oldest) is no longer starved by `fresh` at index 0 of another tree.
  assert.equal(pickNextWorkspaceReadyTodo({ items: [big, other, late, fresh] })?.id, 'late');
  // Inside `big` the earlier sibling still goes first, even when it is newer.
  assert.equal(pickNextWorkspaceReadyTodo({ items: [big, late, early] })?.id, 'early');
});

runCase('pick: sequential order overrides recency (earlier sibling first)', () => {
  const parent = { id: 'p', status: 'ready', runMode: 'sequential', plan: { markdown: 'x', approvedAt: 'y' } };
  const s1 = { id: 's1', parentId: 'p', siblingIndex: 0, status: 'ready', createdAt: '2026-01-02T00:00:00.000Z' };
  const s2 = { id: 's2', parentId: 'p', siblingIndex: 1, status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' };
  // s2 is older but sits behind an unfinished earlier sibling in a sequential group.
  assert.equal(pickNextWorkspaceReadyTodo({ items: [parent, s1, s2] })?.id, 's1');
  assert.equal(pickNextWorkspaceReadyTodo({ items: [parent, { ...s1, status: 'done' }, s2] })?.id, 's2');
});

runCase('claim liveness: idle/missing chat expires, busy or unknown keeps it', () => {
  const busy = () => ({ known: true, busy: true, reason: 'busy' });
  const idle = () => ({ known: true, busy: false, reason: 'idle' });
  const missing = () => ({ known: false, busy: false, reason: 'chat_missing' });
  const unknown = () => ({ known: false, busy: false, reason: 'adapter_missing' });
  assert.equal(isWorkspaceTodoClaimAlive({ claimedByChatId: '' }, busy), false, 'no claim token');
  assert.equal(isWorkspaceTodoClaimAlive({ claimedByChatId: 'c' }, busy), true);
  assert.equal(isWorkspaceTodoClaimAlive({ claimedByChatId: 'c' }, idle), false);
  assert.equal(isWorkspaceTodoClaimAlive({ claimedByChatId: 'c' }, missing), false);
  assert.equal(isWorkspaceTodoClaimAlive({ claimedByChatId: 'c' }, unknown), true, 'unknown state keeps the claim');
});

runCase('claimNextWorkspaceTodo: ready -> doing with claim fields; second pick finds none', async () => {
  const dataDir = freshDataDir('claim-basic');
  const cwd = makeWorkspace('claim-basic');
  const todo = addReadyTodo(dataDir, cwd, 'work');
  const alive = () => ({ known: true, busy: true, reason: 'busy' });
  const claim = await claimNextWorkspaceTodo({
    dataDir, workspaceFolder: cwd, claimedByChatId: 'chat-A', now: T0, probeChatRunLiveness: alive,
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.reason, 'claimed');
  assert.equal(claim.todoId, todo.id);
  assert.equal(claim.item.status, 'doing');
  assert.equal(claim.item.claimedByChatId, 'chat-A');
  assert.ok(claim.item.claimedAt);
  const reloaded = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reloaded.status, 'doing');
  assert.equal(reloaded.claimedByChatId, 'chat-A');
  const second = await claimNextWorkspaceTodo({
    dataDir, workspaceFolder: cwd, claimedByChatId: 'chat-B', now: T0, probeChatRunLiveness: alive,
  });
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'no_ready_work');
});

runCase('claimNextWorkspaceTodo: rejects a claim with no claimer or workspace', async () => {
  const dataDir = freshDataDir('claim-guards');
  const cwd = makeWorkspace('claim-guards');
  addReadyTodo(dataDir, cwd, 'guarded');
  assert.equal((await claimNextWorkspaceTodo({ dataDir, workspaceFolder: cwd, claimedByChatId: '' })).reason, 'no_claimer');
  assert.equal((await claimNextWorkspaceTodo({ dataDir, workspaceFolder: '', claimedByChatId: 'chat-A' })).reason, 'no_workspace');
});

/**
 * Block until the wall clock advances, so a store write made after this is
 * guaranteed to carry a different `updatedAt` than a token captured before it.
 * The CAS assertion below depends on that difference.
 *
 * @param {number} ms
 */
function sleepPastMsBoundary(ms) {
  const until = Date.now() + Math.max(1, ms);
  while (Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}

runCase('claimWorkspaceTodo: two claims on one stale token, only the first wins', async () => {
  const dataDir = freshDataDir('claim-cas');
  const cwd = makeWorkspace('claim-cas');
  const todo = addReadyTodo(dataDir, cwd, 'contended');
  sleepPastMsBoundary(3);
  const token = getTodoById(dataDir, cwd, todo.id).updatedAt;
  const first = await claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'chat-A', expectedUpdatedAt: token, now: T0 });
  const second = await claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'chat-B', expectedUpdatedAt: token, now: T0 + 1 });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'cas_conflict');
  const reloaded = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reloaded.claimedByChatId, 'chat-A');
  assert.equal(reloaded.status, 'doing');
});

runCase('releaseStaleWorkspaceTodoClaims: one delegation read per pass without recoveries', async () => {
  const dataDir = freshDataDir('claim-release-reads');
  const cwd = makeWorkspace('claim-release-reads');
  const todo = addReadyTodo(dataDir, cwd, 'busy');
  await claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'live-chat', now: T0 });
  let reads = 0;
  const result = await releaseStaleWorkspaceTodoClaims({
    dataDir,
    workspaceFolder: cwd,
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    loadDelegations: () => { reads += 1; return []; },
  });
  assert.deepEqual(result.released, []);
  assert.equal(reads, 1, 'classify, the escalation scan and the claim sweep share one read');
});

runCase('releaseStaleWorkspaceTodoClaims: keeps busy/unknown, releases a confirmed-dead claim', async () => {
  const dataDir = freshDataDir('claim-release');
  const cwd = makeWorkspace('claim-release');
  const todo = addReadyTodo(dataDir, cwd, 'abandoned');
  await claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'dead-chat', now: T0 });
  assert.deepEqual((await releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: cwd, probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  })).released, [], 'busy chat keeps the claim');
  assert.deepEqual((await releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: cwd, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }),
  })).released, [], 'unknown state keeps the claim');
  const released = await releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: cwd, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
  });
  assert.deepEqual(released.released, [todo.id]);
  const reloaded = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reloaded.status, 'ready');
  assert.equal(reloaded.claimedByChatId, undefined);
  assert.equal(reloaded.claimedAt, undefined);
});

runCase('releaseStaleWorkspaceTodoClaims: never touches doing items without a claim', async () => {
  const dataDir = freshDataDir('claim-no-token');
  const cwd = makeWorkspace('claim-no-token');
  const todo = addReadyTodo(dataDir, cwd, 'manual');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', strictStatus: true });
  const result = await releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: cwd, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
  });
  assert.deepEqual(result.released, []);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing');
});

runCase('claimNextWorkspaceTodo: releases a dead claim then claims for the new chat', async () => {
  const dataDir = freshDataDir('claim-reclaim');
  const cwd = makeWorkspace('claim-reclaim');
  const todo = addReadyTodo(dataDir, cwd, 'reclaim');
  await claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'dead', now: T0 });
  const claim = await claimNextWorkspaceTodo({
    dataDir,
    workspaceFolder: cwd,
    claimedByChatId: 'chat-C',
    now: T0 + 10,
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.item.claimedByChatId, 'chat-C');
});

runCase('observe tick logs nextTodoId but never claims or changes the todo', async () => {
  const dataDir = freshDataDir('observe-no-claim');
  const cwd = makeWorkspace('observe-no-claim');
  const todo = addReadyTodo(dataDir, cwd, 'observed');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  const deps = observeDeps({
    loadTodosData: () => loadTodosData(dataDir, cwd),
    listReadyTodoLeaves: (items) => listReadyTodoLeaves(items),
  });
  const tick = await tickWorkspaceWatcher({
    workspaceFolder: cwd, dataDir, now: T0, token: 'obs', decisionDedupeMs: 0, deps,
  });
  assert.equal(tick.action, 'observe_ready');
  assert.equal(tick.decision.nextTodoId, todo.id);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.decisions.at(-1).nextTodoId, todo.id);
  const reloaded = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reloaded.status, 'ready', 'observe must not claim');
  assert.equal(reloaded.claimedByChatId, undefined);
});

runCase('guardrails: quiet hours wrap through UTC midnight', () => {
  const quiet = { start: '22:00', end: '06:00' };
  assert.equal(isWorkspaceWatcherQuietHours(quiet, Date.parse('2026-01-01T23:00:00.000Z')), true);
  assert.equal(isWorkspaceWatcherQuietHours(quiet, Date.parse('2026-01-01T05:30:00.000Z')), true);
  assert.equal(isWorkspaceWatcherQuietHours(quiet, Date.parse('2026-01-01T12:00:00.000Z')), false);
  assert.equal(isWorkspaceWatcherQuietHours({ start: '', end: '' }, Date.now()), false);
  assert.equal(workspaceWatcherUtcDayKey(Date.parse('2026-01-01T23:59:59.000Z')), '2026-01-01');
});

runCase('guardrails: budget, cooldown, backoff, same findings and the plan gate', () => {
  const now = T0;
  const approved = { id: 'todo-1', plan: { approvedAt: '2026-01-01T00:00:00.000Z' } };
  const basePolicy = {
    maxParallel: 1,
    maxCyclesPerDay: 2,
    cooldownMs: 60_000,
    backoffBaseMs: 60_000,
    backoffCapMs: 3_600_000,
    maxSameFindings: 2,
    requirePlanApproval: true,
    allowedHarnesses: [],
    quietHours: { start: '', end: '' },
  };
  const baseWatcher = {
    policy: basePolicy,
    cycles: { day: workspaceWatcherUtcDayKey(now), count: 2 },
    lastCycleAt: '',
    backoffUntil: '',
    findings: { byTodo: {} },
    planRequests: {},
  };
  assert.equal(evaluateWorkspaceWatcherGuardrails({ watcher: baseWatcher, pickedTodo: approved, now }).kind, 'wait_budget');

  const cooled = { ...baseWatcher, cycles: { day: '', count: 0 }, lastCycleAt: new Date(now - 1000).toISOString() };
  assert.equal(evaluateWorkspaceWatcherGuardrails({ watcher: cooled, pickedTodo: approved, now }).kind, 'wait_cooldown');

  const backed = { ...baseWatcher, cycles: { day: '', count: 0 }, lastCycleAt: '', backoffUntil: new Date(now + 1000).toISOString() };
  assert.equal(evaluateWorkspaceWatcherGuardrails({ watcher: backed, pickedTodo: approved, now }).kind, 'backoff');

  const repeated = {
    ...baseWatcher,
    cycles: { day: '', count: 0 },
    lastCycleAt: '',
    backoffUntil: '',
    findings: { byTodo: { 'todo-1': { hash: 'h', streak: 2 } } },
  };
  assert.equal(evaluateWorkspaceWatcherGuardrails({ watcher: repeated, pickedTodo: approved, now }).kind, 'wait_same_findings');

  const quiet = {
    ...baseWatcher,
    cycles: { day: '', count: 0 },
    lastCycleAt: '',
    backoffUntil: '',
    findings: { byTodo: {} },
    policy: { ...basePolicy, quietHours: { start: '00:00', end: '23:59' } },
  };
  assert.equal(evaluateWorkspaceWatcherGuardrails({ watcher: quiet, pickedTodo: approved, now }).kind, 'wait_quiet_hours');

  const unplanned = { ...baseWatcher, cycles: { day: '', count: 0 }, lastCycleAt: '', backoffUntil: '', findings: { byTodo: {} } };
  const first = evaluateWorkspaceWatcherGuardrails({ watcher: unplanned, pickedTodo: { id: 'todo-1', plan: {} }, now });
  assert.equal(first.allowed, true);
  assert.equal(first.kind, 'plan_gate');
  assert.equal(first.planOnly, true);
  const second = evaluateWorkspaceWatcherGuardrails({
    watcher: { ...unplanned, planRequests: { 'todo-1': new Date(now).toISOString() } },
    pickedTodo: { id: 'todo-1', plan: {} },
    now,
  });
  assert.equal(second.allowed, false);
  assert.equal(second.kind, 'wait_plan_approval');
  assert.equal(second.planOnly, false);

  const parent = {
    id: 'parent',
    status: 'ready',
    body: '## Cel\nModule plan',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const leaf = { id: 'leaf', parentId: 'parent', status: 'ready', body: 'Implement the entity' };
  const accepted = evaluateWorkspaceWatcherGuardrails({
    watcher: unplanned,
    pickedTodo: leaf,
    items: [parent, leaf],
    now,
  });
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.planOnly, false);
  assert.equal(accepted.reason, 'ready');
  const draftParent = { ...parent, status: 'idea', updatedAt: '' };
  const draft = evaluateWorkspaceWatcherGuardrails({
    watcher: unplanned,
    pickedTodo: leaf,
    items: [draftParent, leaf],
    now,
  });
  assert.equal(draft.allowed, true);
  assert.equal(draft.planOnly, true);
  assert.equal(draft.reason, 'plan_not_approved');

  const root = {
    id: 'root',
    status: 'doing',
    plan: { markdown: '# module plan', approvedAt: '2026-01-01T00:00:00.000Z' },
  };
  const phase = {
    id: 'phase',
    parentId: 'root',
    status: 'ready',
    plan: { markdown: '# phase draft' },
  };
  const draftedLeaf = {
    id: 'leaf',
    parentId: 'phase',
    status: 'ready',
    plan: { markdown: '# leaf draft' },
  };
  const inherited = evaluateWorkspaceWatcherGuardrails({
    watcher: { ...unplanned, planRequests: { leaf: new Date(now).toISOString() } },
    pickedTodo: draftedLeaf,
    items: [root, phase, draftedLeaf],
    now,
  });
  assert.equal(inherited.allowed, true);
  assert.equal(inherited.planOnly, false);
  assert.equal(inherited.kind, 'allowed');

  const harnessLimited = {
    ...baseWatcher,
    cycles: { day: '', count: 0 },
    lastCycleAt: '',
    backoffUntil: '',
    policy: { ...basePolicy, allowedHarnesses: ['h1', 'h2'] },
  };
  const limits = [
    { harness: 'h1', model: '', resetAt: new Date(now + 60_000).toISOString() },
    { harness: 'h2', model: '', resetAt: new Date(now + 60_000).toISOString() },
  ];
  assert.equal(
    evaluateWorkspaceWatcherGuardrails({ watcher: harnessLimited, pickedTodo: approved, now, activeUsageLimits: limits }).kind,
    'wait_harness_usage',
  );
});

runCase('computeWatcherSchedule reports the last/next cycle and the live blocker', () => {
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  const policy = {
    maxParallel: 1,
    maxCyclesPerDay: 4,
    cooldownMs: 60_000,
    quietHours: { start: '', end: '' },
    allowedHarnesses: [],
  };
  const base = { mode: 'autopilot', policy, lastCycleAt: '', backoffUntil: '', cycles: { day: '', count: 0 } };

  // Autopilot off → no schedule at all.
  const off = computeWatcherSchedule({ watcher: { ...base, mode: 'off' }, now });
  assert.equal(off.enabled, false);
  assert.equal(off.nextCycleAt, 0);
  assert.equal(off.blockedReason, 'mode_not_active');
  assert.equal(off.due, false);

  // Never run → due now.
  const due = computeWatcherSchedule({ watcher: base, now });
  assert.equal(due.enabled, true);
  assert.equal(due.nextCycleAt, now);
  assert.equal(due.due, true);
  assert.equal(due.remainingToday, 4);
  assert.equal(due.allowed, true);

  // Cooldown pushes the next cycle out.
  const cooled = computeWatcherSchedule({
    watcher: { ...base, lastCycleAt: new Date(now - 10_000).toISOString() },
    now,
  });
  assert.equal(cooled.nextCycleAt, now - 10_000 + 60_000);
  assert.equal(cooled.blockedReason, 'cooldown');

  // A spent daily budget pushes the next cycle to the UTC-day rollover.
  const spent = computeWatcherSchedule({
    watcher: { ...base, cycles: { day: '2026-02-02', count: 4 } },
    now,
  });
  assert.equal(spent.remainingToday, 0);
  assert.equal(spent.nextCycleAt, Date.parse('2026-02-03T00:00:00.000Z'));
  assert.equal(spent.blockedReason, 'daily_budget');

  // Quiet hours win over a shorter cooldown; the next cycle lands at the end.
  const quiet = computeWatcherSchedule({
    watcher: {
      ...base,
      lastCycleAt: new Date(now - 10_000).toISOString(),
      policy: { ...policy, quietHours: { start: '11:00', end: '14:00' } },
    },
    now,
  });
  assert.equal(quiet.blockedReason, 'quiet_hours');
  assert.equal(quiet.nextCycleAt, Date.parse('2026-02-02T14:00:00.000Z'));

  // A live parallel blocker is reported without inventing an ETA.
  const busy = computeWatcherSchedule({ watcher: base, now, activeCycleCount: 1 });
  assert.equal(busy.running, 1);
  assert.equal(busy.blockedReason, 'max_parallel');
  assert.equal(busy.nextCycleAt, now);

  // Paused/stopped is a deliberate halt: no next cycle.
  const paused = computeWatcherSchedule({ watcher: { ...base, paused: true }, now });
  assert.equal(paused.nextCycleAt, 0);
  assert.equal(paused.blockedReason, 'paused');
  const stopped = computeWatcherSchedule({ watcher: { ...base, stopReason: 'loop_no_eligible_work' }, now });
  assert.equal(stopped.nextCycleAt, 0);
  assert.equal(stopped.blockedReason, 'stop_reason');
});

runCase('computeWatcherSchedule: all allowed harnesses limited -> nextCycleAt is the earliest reset', () => {
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  const policy = {
    maxParallel: 1, maxCyclesPerDay: 0, cooldownMs: 0, quietHours: { start: '', end: '' },
    allowedHarnesses: ['claude', 'codex'],
  };
  const watcher = { mode: 'autopilot', policy, lastCycleAt: '', backoffUntil: '', cycles: { day: '', count: 0 } };
  const early = Date.parse('2026-02-02T14:00:00.000Z');
  const late = Date.parse('2026-02-02T17:00:00.000Z');
  const limits = [
    { harness: 'claude', model: '', resetAt: new Date(late).toISOString() },
    { harness: 'codex', model: '', resetAt: new Date(early).toISOString() },
  ];
  const limited = computeWatcherSchedule({ watcher, now, activeUsageLimits: limits });
  assert.equal(limited.blockedReason, 'harness_usage_limited');
  assert.equal(limited.nextCycleAt, early);
  assert.equal(limited.due, false);
  // One harness free -> no wait, the ETA stays "now".
  const free = computeWatcherSchedule({ watcher, now, activeUsageLimits: [limits[0]] });
  assert.equal(free.nextCycleAt, now);
});

runCase('nextWorkspaceWatcherQuietHoursEndMs mirrors the active quiet window', () => {
  const now = Date.parse('2026-02-02T23:30:00.000Z');
  assert.equal(
    nextWorkspaceWatcherQuietHoursEndMs({ start: '22:00', end: '06:00' }, now),
    Date.parse('2026-02-03T06:00:00.000Z'),
  );
  assert.equal(nextWorkspaceWatcherQuietHoursEndMs({ start: '22:00', end: '06:00' }, Date.parse('2026-02-02T12:00:00.000Z')), null);
  assert.equal(nextWorkspaceWatcherQuietHoursEndMs({ start: '', end: '' }, now), null);
});

runCase('guardrails: backoff grows exponentially and is capped', () => {
  const now = T0;
  const one = Date.parse(computeWorkspaceWatcherBackoffUntil({ failures: { a: 1 }, now, baseMs: 1000, capMs: 100_000 }));
  const two = Date.parse(computeWorkspaceWatcherBackoffUntil({ failures: { a: 2 }, now, baseMs: 1000, capMs: 100_000 }));
  const capped = Date.parse(computeWorkspaceWatcherBackoffUntil({ failures: { a: 99 }, now, baseMs: 1000, capMs: 5000 }));
  assert.equal(one - now, 1000);
  assert.equal(two - now, 2000);
  assert.equal(capped - now, 5000);
  assert.equal(computeWorkspaceWatcherBackoffUntil({ failures: {}, now }), '');
});

runCase('decide autopilot: start_cycle only when idle with approved work', () => {
  const watcher = {
    mode: 'autopilot',
    enabled: true,
    stopReason: '',
    policy: { maxParallel: 1, maxCyclesPerDay: 5, cooldownMs: 0, requirePlanApproval: false, allowedHarnesses: [] },
    cycles: { day: '', count: 0 },
    lastCycleAt: '',
    backoffUntil: '',
    findings: {},
    planRequests: {},
    failures: {},
  };
  const snapshot = {
    readyTodoCount: 1,
    activeAgentCount: 0,
    errors: [],
    readyLeaves: [{ id: 't1', createdAt: '2026-01-01T00:00:00.000Z' }],
  };
  const decision = decideWorkspaceWatcherAction({ watcher, snapshot, now: T0 });
  assert.equal(decision.kind, 'start_cycle');
  assert.equal(decision.nextTodoId, 't1');
  assert.equal(decision.shouldNotify, false);
  const blocked = decideWorkspaceWatcherAction({
    watcher: { ...watcher, policy: { ...watcher.policy, requirePlanApproval: true } },
    snapshot: { ...snapshot, readyLeaves: [{ id: 't1', createdAt: '2026-01-01T00:00:00.000Z', plan: {} }] },
    now: T0,
  });
  assert.equal(blocked.kind, 'plan_gate');
  assert.equal(blocked.planOnly, true);
});

runCase('cycle prompt: plan-only never approves; implement delegates with model_pick', () => {
  const watcher = { policy: { pickRoles: ['plan', 'implement', 'review'], allowedHarnesses: [] } };
  const planPrompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: '/w',
    watcher,
    decision: { kind: 'plan_gate', planOnly: true },
    todo: { id: 't1', title: 'Plan me' },
    orchestrator: { harness: 'mock', model: 'm', source: 'policy' },
  });
  assert.match(planPrompt, /NEVER set plan\.approvedAt/);
  assert.match(planPrompt, /PLAN ONLY/);
  const implementPrompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: '/w',
    watcher,
    decision: { kind: 'start_cycle', planOnly: false },
    todo: { id: 't1', title: 'Do me' },
    orchestrator: { harness: 'mock', model: 'm', source: 'policy' },
  });
  assert.match(implementPrompt, /delegation_start/);
  assert.match(implementPrompt, /Forward the `pickId` returned by `model_pick` as `pick_id`/);
  assert.match(implementPrompt, /Never re-pick or match the proposal by time/);
  assert.doesNotMatch(implementPrompt, /NEVER set plan\.approvedAt/);
  assert.match(implementPrompt, /Never commit, push/);
  assert.match(implementPrompt, /mark this todo done/);
  assert.match(implementPrompt, /wait for human approval/);
  const ungatedPrompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: '/w', watcher: { policy: { requirePlanApproval: false } },
    decision: { kind: 'start_cycle' }, todo: { id: 't1' }, orchestrator: {},
  });
  assert.match(ungatedPrompt, /proceed directly to implementation/);
  assert.match(ungatedPrompt, /Forward the `pickId` returned by `model_pick` as `pick_id`/);
  assert.doesNotMatch(ungatedPrompt, /wait for.*approval/);
});

runCase('orchestrator resolution: explicit policy wins, otherwise implement pick', async () => {
  const catalog = [{ id: 'deepseek', enabled: true, ready: true, can_delegate: true }];
  const listModels = async () => ({ items: [{ id: 'x' }] });
  const explicit = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { orchestrator: { harness: 'deepseek', model: 'x' } } },
    deps: { listHarnessCatalog: async () => catalog, listHarnessModels: listModels },
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.harness, 'deepseek');
  assert.equal(explicit.model, 'x');
  assert.equal(explicit.source, 'policy');
  const picked = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { orchestrator: { harness: '', model: '' }, allowedHarnesses: [] } },
    deps: {
      listHarnessCatalog: async () => [{ id: 'mock', enabled: true, ready: true, can_delegate: true }],
      listHarnessModels: async () => ({ items: [{ id: 'cheap' }] }),
      selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
      mcpCapabilityProbe: () => ({ ok: true }),
    },
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.harness, 'mock');
  assert.equal(picked.model, 'cheap');
  assert.equal(picked.source, 'implement_pick');
});

runCase('orchestrator resolution: no catalog candidate blocks instead of default transport', async () => {
  const blocked = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { allowedHarnesses: ['only-harness'] } },
    deps: {
      listHarnessCatalog: async () => [{ id: 'other', enabled: true, ready: true, can_delegate: true }],
      listHarnessModels: async () => ({ items: [{ id: 'm1' }] }),
      selectModelPick: () => ({ ok: false, error: 'MODEL_UNAVAILABLE' }),
    },
  });
  assert.equal(blocked.ok, false);
});

runCase('startWorkspaceWatcherCycle: maxParallel 2 allows two concurrent cycles', async () => {
  const dataDir = freshDataDir('cycle-parallel');
  const cwd = makeWorkspace('cycle-parallel');
  const first = addReadyTodo(dataDir, cwd, 'parallel one');
  const second = addReadyTodo(dataDir, cwd, 'parallel two');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5, maxParallel: 2 },
  }, { dataDir });
  let chatSeq = 0;
  const deps = {
    addChat: (_session, title, _wf, _folder, _model, extras) => {
      chatSeq += 1;
      return { id: extras.id, title };
    },
    startChatRun: async () => ({ runId: `run-${chatSeq}`, accepted: true }),
    // Deterministic orchestrator seam: the ambient harness catalog / usage
    // ledger must not decide whether this cycle can start.
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  };
  const tick1 = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: first.id },
    snapshot: { readyLeaves: [{ id: first.id, updatedAt: getTodoById(dataDir, cwd, first.id).updatedAt, title: first.title }] },
  };
  const leaseToken = 'parallel-lease';
  const firstStart = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick: tick1, token: leaseToken, deps });
  assert.equal(firstStart.started, true);
  const tick2 = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: second.id },
    snapshot: { readyLeaves: [{ id: second.id, updatedAt: getTodoById(dataDir, cwd, second.id).updatedAt, title: second.title }] },
  };
  const secondStart = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0 + 1000, tick: tick2, token: leaseToken, deps });
  assert.equal(secondStart.started, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(getWorkspaceWatcherActiveCycles(row).length, 2);
  assert.equal(row.activeCycle.cycleId, row.activeCycles[0].cycleId, 'slot 0 mirrors activeCycle');
  assert.equal(getTodoById(dataDir, cwd, second.id).status, 'doing');
});

runCase('startWorkspaceWatcherCycle: claims a ready todo once and blocks a duplicate', async () => {
  const dataDir = freshDataDir('cycle-start');
  const cwd = makeWorkspace('cycle-start');
  const first = addReadyTodo(dataDir, cwd, 'first');
  const second = addReadyTodo(dataDir, cwd, 'second');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5, maxParallel: 1 },
  }, { dataDir });
  const chatCalls = [];
  const runCalls = [];
  const deps = {
    addChat: (_session, title, _wf, _folder, _model, extras) => {
      chatCalls.push(extras.id);
      return { id: extras.id, title };
    },
    startChatRun: async (input) => {
      runCalls.push(input);
      return { runId: 'run-1', accepted: true };
    },
    // Deterministic orchestrator seam: the ambient harness catalog / usage
    // ledger must not decide whether this cycle can start.
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  };
  const watcher = getWorkspaceWatcher(cwd, { dataDir });
  const tick = {
    watcher,
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: first.id },
    snapshot: { readyLeaves: [{ id: first.id, updatedAt: getTodoById(dataDir, cwd, first.id).updatedAt, title: first.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, token: 'cyc', deps });
  assert.equal(started.started, true);
  assert.equal(chatCalls.length, 1);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].requestId, started.cycle.cycleId);
  assert.equal(runCalls[0].chatId, started.cycle.chatId);
  assert.equal(getTodoById(dataDir, cwd, first.id).status, 'doing');
  assert.equal(getTodoById(dataDir, cwd, first.id).claimedByChatId, started.cycle.chatId);
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle);

  // A second ready todo + a stale tick must still refuse: one cycle at a time.
  const tick2 = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: second.id },
    snapshot: { readyLeaves: [{ id: second.id, updatedAt: getTodoById(dataDir, cwd, second.id).updatedAt, title: second.title }] },
  };
  const duplicate = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0 + 1000, tick: tick2, token: 'cyc2', deps });
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.reason, 'cycle_active');
  assert.equal(chatCalls.length, 1);
  assert.equal(getTodoById(dataDir, cwd, second.id).status, 'ready');
});

runCase('startWorkspaceWatcherCycle: omitted dataDir still finds the todo in the process data directory', async () => {
  const dataDir = ISOLATED_DATA_DIR;
  const cwd = makeWorkspace('cycle-default-datadir');
  const todo = addReadyTodo(dataDir, cwd, 'leaf');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  const started = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    now: T0,
    token: 'default-dir',
    tick: {
      watcher: getWorkspaceWatcher(cwd, { dataDir }),
      decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
      snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt }] },
    },
    deps: {
      addChat: (_session, title, _wf, _folder, _model, extras) => ({ id: extras.id, title }),
      startChatRun: async () => ({ runId: 'run-default-dir', accepted: true }),
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
      selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
      probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    },
  });
  assert.notEqual(started.reason, 'todo_missing');
  assert.equal(started.started, true);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing');
});

runCase('startWorkspaceWatcherCycle: a failed start rolls back the cycle and releases the claim', async () => {
  const dataDir = freshDataDir('cycle-rollback');
  const cwd = makeWorkspace('cycle-rollback');
  const todo = addReadyTodo(dataDir, cwd, 'doomed');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  const deps = {
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => {
      // A hard error: transient codes (recipient_busy, adapter_unavailable) are rolled back without a failure.
      const error = new Error('chat gone');
      error.code = 'chat_not_found';
      throw error;
    },
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
    notify: () => false,
  };
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, token: 'roll', deps });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'start_failed');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.failures[todo.id], undefined, 'a start infra failure never raises the todo counter');
  assert.ok(row.infraBackoffUntil, 'a failed start arms the infra backoff');
  const reloaded = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reloaded.status, 'ready', 'the reservation claim is released');
  assert.equal(reloaded.claimedByChatId, undefined);
});

runCase('plan gate cycle records a plan request and never auto-approves', async () => {
  const dataDir = freshDataDir('cycle-plangate');
  const cwd = makeWorkspace('cycle-plangate');
  const todo = addReadyTodo(dataDir, cwd, 'needs plan');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: true, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  const deps = {
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => ({ runId: 'plan-run', accepted: true }),
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    startStartingLeaseRenewal: () => () => {},
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  };
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'plan_gate', planOnly: true, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title, plan: {} }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, token: 'pg', deps });
  assert.equal(started.started, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.ok(row.planRequests[todo.id], 'the plan request is durable');
  assert.equal(getTodoById(dataDir, cwd, todo.id).plan?.approvedAt, undefined, 'the watcher never approves a plan');
  // The same todo is not planned again until the request is cleared/approved.
  const tick2 = {
    watcher: row,
    decision: { kind: 'plan_gate', planOnly: true, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title }] },
  };
  const again = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0 + 1, tick: tick2, token: 'pg2', deps });
  assert.equal(again.reason, 'cycle_active', 'the first plan cycle still owns the slot');
});

runCase('reconcileWorkspaceWatcherCycle: keeps busy/child-active cycles and closes an idle childless one', async () => {
  const dataDir = freshDataDir('cycle-reconcile');
  const cwd = makeWorkspace('cycle-reconcile');
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot' }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: { cycleId: 'c1', todoIds: [], startedAt: new Date(T0).toISOString(), chatId: 'chat-x', runId: '' },
    lease: acquireWorkspaceWatcherLease(row, { token: 't', ttlMs: 60_000, now: T0 }).lease,
  }), { dataDir });
  const busy = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: { probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }), loadDelegations: () => [] },
  });
  assert.equal(busy.closed, false);
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle);
  const children = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [{ id: 'd1', parentChatId: 'chat-x', status: 'running' }],
    },
  });
  assert.equal(children.closed, false);
  assert.equal(children.reason, 'cycle_children_active');
  assert.equal(hasActiveWorkspaceWatcherCycleChildren('chat-x', [{ parentChatId: 'chat-x', status: 'running' }]), true);
  const closed = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [{ id: 'd1', parentChatId: 'chat-x', status: 'completed' }],
    },
  });
  assert.equal(closed.closed, true);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, null);
});

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {object} cycle
 * @param {number} [now]
 */
function seedWatcherCycle(dataDir, cwd, cycle, now = T0, token = 'room-gone') {
  if (!getWorkspaceWatcher(cwd, { dataDir })) {
    upsertWorkspaceWatcher(cwd, {
      mode: 'autopilot',
      policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 50, maxParallel: 1 },
    }, { dataDir });
  }
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: {
      phase: 'running',
      runId: 'run-1',
      startedAt: new Date(now).toISOString(),
      ...cycle,
    },
    lease: acquireWorkspaceWatcherLease(row, { token, ttlMs: 60_000, now }).lease,
  }), { dataDir });
}

/**
 * @param {string} reason
 * @returns {(input: { runId?: string }) => { known: boolean, busy: boolean, reason: string }}
 */
function roomGoneProbe(reason) {
  return () => ({ known: false, busy: false, reason });
}

runCase('reconcile closes a vanished room after grace when the todo is done', async () => {
  // Notices queue behind earlier in-flight ones; drain so the injected append runs synchronously.
  await flushWorkspaceWatcherNotices();
  const dataDir = freshDataDir('room-gone-done');
  const cwd = makeWorkspace('room-gone-done');
  const todo = addReadyTodo(dataDir, cwd, 'finished');
  updateTodo(dataDir, cwd, todo.id, {
    status: 'done',
    expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
  });
  seedWatcherCycle(dataDir, cwd, {
    cycleId: 'gone-done',
    chatId: 'chat-gone',
    runId: 'run-gone',
    todoIds: [todo.id],
    roomGoneSince: new Date(T0 - WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS).toISOString(),
  });
  const probe = roomGoneProbe('state_missing');
  assert.equal(isWorkspaceWatcherActiveCycleChatAlive({ chatId: 'chat-gone', runId: 'run-gone' }, probe, T0), true);
  const notices = [];
  const closed = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: {
      probeChatRunLiveness: probe,
      loadDelegations: () => [],
      noticeDeps: {
        loadChats: () => [{ id: 'pin', watcherPinned: true, workspaceFolder: cwd }],
        appendChatNotice: (_id, text) => {
          notices.push(String(text));
          return { ok: true, appended: [{ seq: notices.length }] };
        },
      },
    },
  });
  assert.equal(closed.closed, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.deepEqual(row.lease, { ownerPid: 0, token: '', expiresAt: '' });
  assert.equal(row.failures[todo.id], 1);
  assert.equal(row.cycleChats.at(-1).outcome, 'failure');
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
  // `reconcileWorkspaceWatcherCycle` appends the notice fire-and-forget; wait
  // for the serialization chain so the assertion does not race that append.
  await flushWorkspaceWatcherNotices();
  assert.ok(notices.some((text) => text.includes('ended without progress')));
});

runCase('reconcile closes a vanished room as failure when the todo is still doing', async () => {
  const dataDir = freshDataDir('room-gone-doing');
  const cwd = makeWorkspace('room-gone-doing');
  const todo = addReadyTodo(dataDir, cwd, 'still doing');
  updateTodo(dataDir, cwd, todo.id, {
    status: 'doing',
    claimedByChatId: 'chat-gone',
    expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
  });
  seedWatcherCycle(dataDir, cwd, {
    cycleId: 'gone-doing',
    chatId: 'chat-gone',
    runId: 'run-gone',
    todoIds: [todo.id],
    roomGoneSince: new Date(T0 - WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS).toISOString(),
  });
  const closed = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: { probeChatRunLiveness: roomGoneProbe('state_missing'), loadDelegations: () => [], notify: () => false },
  });
  assert.equal(closed.closed, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todo.id], 1);
  assert.equal(row.cycleChats.at(-1).outcome, 'failure');
  assert.equal(row.decisions.at(-1).kind, 'cycle_failed');
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
  const released = getTodoById(dataDir, cwd, todo.id);
  assert.equal(released.status, 'ready');
  assert.equal(released.claimedByChatId, undefined);
});

runCase('reconcile closes a vanished room on adapter_missing after grace', async () => {
  const dataDir = freshDataDir('room-gone-adapter');
  const cwd = makeWorkspace('room-gone-adapter');
  const todo = addReadyTodo(dataDir, cwd, 'adapter gone');
  updateTodo(dataDir, cwd, todo.id, {
    status: 'done',
    expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
  });
  seedWatcherCycle(dataDir, cwd, {
    cycleId: 'gone-adapter',
    chatId: 'chat-adapter',
    runId: 'run-adapter',
    todoIds: [todo.id],
    roomGoneSince: new Date(T0 - WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS).toISOString(),
  });
  const closed = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: { probeChatRunLiveness: roomGoneProbe('adapter_missing'), loadDelegations: () => [] },
  });
  assert.equal(closed.closed, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.failures[todo.id], 1);
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
});

runCase('reconcile keeps a cycle when only the run-scoped probe misses the room', async () => {
  const dataDir = freshDataDir('room-gone-other-run');
  const cwd = makeWorkspace('room-gone-other-run');
  seedWatcherCycle(dataDir, cwd, {
    cycleId: 'other-run',
    chatId: 'chat-live',
    runId: 'run-old',
    todoIds: ['todo-live'],
  });
  const kept = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: {
      probeChatRunLiveness: (input) => (input.runId
        ? { known: false, busy: false, reason: 'state_missing' }
        : { known: true, busy: true, reason: 'busy' }),
      loadDelegations: () => [],
    },
  });
  assert.equal(kept.closed, false);
  assert.equal(kept.reason, 'cycle_alive');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle.chatId, 'chat-live');
  assert.equal(row.activeCycle.roomGoneSince, undefined);
});

runCase('reconcile keeps a cycle on adapter_error, run_mismatch and probe_failed', async () => {
  for (const reason of ['adapter_error', 'run_mismatch', 'probe_failed']) {
    const dataDir = freshDataDir(`room-gone-${reason}`);
    const cwd = makeWorkspace(`room-gone-${reason}`);
    seedWatcherCycle(dataDir, cwd, {
      cycleId: `cycle-${reason}`,
      chatId: `chat-${reason}`,
      runId: `run-${reason}`,
      todoIds: ['todo-x'],
    });
    const kept = await reconcileWorkspaceWatcherCycle({
      workspaceFolder: cwd,
      dataDir,
      now: T0 + WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS,
      deps: { probeChatRunLiveness: roomGoneProbe(reason), loadDelegations: () => [] },
    });
    assert.equal(kept.closed, false, reason);
    assert.equal(kept.reason, 'cycle_alive', reason);
    assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, reason);
  }
});

runCase('reconcile keeps a vanished room while a child delegation is active', async () => {
  const dataDir = freshDataDir('room-gone-child');
  const cwd = makeWorkspace('room-gone-child');
  seedWatcherCycle(dataDir, cwd, {
    cycleId: 'gone-child',
    chatId: 'chat-parent',
    runId: 'run-parent',
    todoIds: ['todo-child'],
    roomGoneSince: new Date(T0 - WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS).toISOString(),
  });
  const kept = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: {
      probeChatRunLiveness: roomGoneProbe('state_missing'),
      loadDelegations: () => [{ id: 'd1', parentChatId: 'chat-parent', status: 'running' }],
    },
  });
  assert.equal(kept.closed, false);
  assert.equal(kept.reason, 'cycle_children_active');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle.chatId, 'chat-parent');
  assert.equal(row.activeCycle.roomGoneSince, undefined);
});

runCase('reconcile waits out the room-gone grace, then closes', async () => {
  const dataDir = freshDataDir('room-gone-grace');
  const cwd = makeWorkspace('room-gone-grace');
  const todo = addReadyTodo(dataDir, cwd, 'grace');
  updateTodo(dataDir, cwd, todo.id, {
    status: 'done',
    expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
  });
  seedWatcherCycle(dataDir, cwd, {
    cycleId: 'gone-grace',
    chatId: 'chat-grace',
    runId: 'run-grace',
    todoIds: [todo.id],
  });
  const deps = { probeChatRunLiveness: roomGoneProbe('state_missing'), loadDelegations: () => [] };
  const early = await reconcileWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, deps });
  assert.equal(early.closed, false);
  assert.equal(early.reason, 'cycle_room_gone_grace');
  const stamped = getWorkspaceWatcher(cwd, { dataDir }).activeCycle;
  assert.equal(stamped.roomGoneSince, new Date(T0).toISOString());
  const still = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS - 1,
    deps,
  });
  assert.equal(still.closed, false);
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle);
  const closed = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS,
    deps,
  });
  assert.equal(closed.closed, true);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, null);
});

runCase('reconcile keeps a starting cycle inside its deadline when the room is missing', async () => {
  const dataDir = freshDataDir('room-gone-starting');
  const cwd = makeWorkspace('room-gone-starting');
  seedWatcherCycle(dataDir, cwd, {
    cycleId: 'starting',
    chatId: 'chat-starting',
    runId: '',
    phase: 'starting',
    startDeadlineAt: new Date(T0 + 60_000).toISOString(),
    todoIds: ['todo-start'],
  });
  const kept = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: { probeChatRunLiveness: roomGoneProbe('state_missing'), loadDelegations: () => [] },
  });
  assert.equal(kept.closed, false);
  assert.equal(kept.reason, 'cycle_alive');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle.phase, 'starting');
  assert.equal(row.activeCycle.roomGoneSince, undefined);
});

runCase('a full cycle slot records wait_active/cycle_active instead of start_cycle', async () => {
  const dataDir = freshDataDir('slot-full-decision');
  const cwd = makeWorkspace('slot-full-decision');
  addReadyTodo(dataDir, cwd, 'next ready');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 50, maxParallel: 1 },
  }, { dataDir });
  seedWatcherCycle(dataDir, cwd, {
    cycleId: 'holding',
    chatId: 'holder-chat-id',
    runId: 'run-held',
    todoIds: ['already-held'],
  }, T0, 'slot-full');
  const pass = await runWorkspaceWatcherAutopilot({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    token: 'slot-full',
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
      loadDelegations: () => [],
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'test' }),
      startChatRun: async () => { throw new Error('must not start while the slot is full'); },
    },
  });
  assert.equal(pass.started, 0);
  assert.equal(pass.closed, 0);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.ok(row.decisions.every((entry) => entry.kind !== 'start_cycle'));
  const last = row.decisions.at(-1);
  assert.equal(last.kind, 'wait_active');
  assert.equal(last.reason, 'cycle_active');
  assert.equal(last.slotChats[0].chatId, 'holder-chat-id');
  const summary = describeWorkspaceWatcherDecision(last);
  assert.match(summary, /cycle_active/);
  assert.match(summary, /holder-c/);
});

/**
 * Live cycle slot in the shape a real start leaves behind: `running` with a run
 * id, its orchestrator chat and the todos it claimed. Written through the same
 * append path the reservation uses, so the pool gate reads a production row
 * rather than a fixture of a test's own invention.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {{ cycleId: string, chatId: string, todoIds: string[] }} cycle
 * @param {number} [now]
 * @returns {void}
 */
function seedLiveCycle(dataDir, cwd, cycle, now = T0) {
  mutateWorkspaceWatcherRow(cwd, ({ row }) => appendWorkspaceWatcherCycle(row, {
    ...cycle,
    startedAt: new Date(now).toISOString(),
    runId: `run-${cycle.cycleId}`,
    phase: 'running',
  }), { dataDir });
}

/**
 * Claim a ready todo for a cycle's orchestrator chat, as a live cycle leaves it:
 * `doing` with a claim, so the row is absent from `readyLeaves` and only the
 * snapshot's item list can classify which pool that cycle occupies.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {object} todo
 * @param {string} chatId
 * @returns {void}
 */
function claimTodoForCycle(dataDir, cwd, todo, chatId) {
  updateTodo(dataDir, cwd, todo.id, {
    status: 'doing',
    claimedByChatId: chatId,
    expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
  });
}

/**
 * Deps for the per-pool start cases: an orchestrator pair that always resolves,
 * so a refusal can only come from a gate and never from the ambient catalog.
 *
 * @param {string[]} chatCalls collects the orchestrator chats a start created
 */
function poolStartDeps(chatCalls) {
  return {
    addChat: (_session, title, _wf, _folder, _model, extras) => {
      chatCalls.push(extras.id);
      return { id: extras.id, title };
    },
    startChatRun: async () => ({ runId: 'run-pool', accepted: true }),
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    loadDelegations: () => [],
    notify: () => false,
  };
}

/**
 * Tick object for `startWorkspaceWatcherCycle` with the same two todo lists the
 * real tick hands a start.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} todoId
 * @param {object} [watcherOverride] a row to use instead of the live store row
 * @returns {object}
 */
function poolTick(dataDir, cwd, todoId, watcherOverride = null) {
  const items = loadTodosData(dataDir, cwd).items || [];
  return {
    watcher: watcherOverride || getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todoId },
    snapshot: {
      items,
      readyLeaves: items.filter((row) => String(row.status || '') === 'ready'),
    },
  };
}

/**
 * @param {object} policy
 * @returns {object} the watcher row the pool cases drive
 */
function poolCycleWatcher(policy) {
  return { mode: 'autopilot', policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 50, ...policy } };
}

/**
 * Rewrite a stored row exactly as an install predating the pool fields would
 * have it: the policy carries neither `maxParallelWorktree` nor
 * `maxParallelProject`, a shape `normalizeWorkspaceWatcherPolicy` can never
 * produce on a write and therefore the only honest legacy fixture.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @returns {void}
 */
function stripPoolFieldsFromStore(dataDir, cwd) {
  const doc = loadWorkspaceWatchersDocument({ dataDir });
  const key = normalizeWorkspaceFolder(cwd);
  const row = doc.items[key];
  assert.ok(row && row.policy, `fixture row missing for ${key}`);
  delete row.policy.maxParallelWorktree;
  delete row.policy.maxParallelProject;
  fs.writeFileSync(getWorkspaceWatchersDataPath({ dataDir }), `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {Record<string, unknown>} patch
 * @returns {void}
 */
function patchWatcherPolicy(dataDir, cwd, patch) {
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    policy: { ...row.policy, ...patch },
  }), { dataDir });
}

runCase('startWorkspaceWatcherCycle: a full worktree cycle pool refuses a worktree leaf and admits a project leaf', async () => {
  const dataDir = freshDataDir('start-pool-worktree');
  const cwd = makeWorkspace('start-pool-worktree');
  const inFlight = addReadyTodo(dataDir, cwd, 'worktree in flight', { executionMode: 'worktree' });
  claimTodoForCycle(dataDir, cwd, inFlight, 'wt-orch');
  const nextWorktree = addReadyTodo(dataDir, cwd, 'second worktree leaf', { executionMode: 'worktree' });
  const nextProject = addReadyTodo(dataDir, cwd, 'project leaf', { executionMode: 'project' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({
    // The global cap leaves room, so the only thing that can refuse the second
    // worktree leaf is the pool ceiling of one worktree cycle.
    maxParallel: 2,
    maxParallelWorktree: 1,
  }), { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'wt-cycle', chatId: 'wt-orch', todoIds: [inFlight.id] });
  const chats = [];
  const deps = poolStartDeps(chats);
  const refused = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, tick: poolTick(dataDir, cwd, nextWorktree.id), token: 'pool-wt-1', deps,
  });
  assert.equal(refused.started, false);
  assert.equal(refused.reason, 'cycle_active');
  assert.equal(chats.length, 0, 'a pool refusal never creates an orchestrator chat');
  assert.equal(getTodoById(dataDir, cwd, nextWorktree.id).status, 'ready', 'and never claims the leaf');
  const allowed = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0 + 1000, tick: poolTick(dataDir, cwd, nextProject.id), token: 'pool-wt-2', deps,
  });
  assert.equal(allowed.started, true, JSON.stringify(allowed));
  assert.deepEqual(allowed.cycle.todoIds, [nextProject.id], 'the project pool still had room');
});

runCase('startWorkspaceWatcherCycle: a full project cycle pool refuses a project leaf and admits a worktree leaf', async () => {
  const dataDir = freshDataDir('start-pool-project');
  const cwd = makeWorkspace('start-pool-project');
  const inFlight = addReadyTodo(dataDir, cwd, 'project in flight', { executionMode: 'project' });
  claimTodoForCycle(dataDir, cwd, inFlight, 'pj-orch');
  const nextProject = addReadyTodo(dataDir, cwd, 'second project leaf', { executionMode: 'project' });
  const nextWorktree = addReadyTodo(dataDir, cwd, 'worktree leaf', { executionMode: 'worktree' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({ maxParallel: 2, maxParallelProject: 1 }), { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'pj-cycle', chatId: 'pj-orch', todoIds: [inFlight.id] });
  const chats = [];
  const deps = poolStartDeps(chats);
  const refused = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, tick: poolTick(dataDir, cwd, nextProject.id), token: 'pool-pj-1', deps,
  });
  assert.equal(refused.started, false);
  assert.equal(refused.reason, 'cycle_active');
  assert.equal(getTodoById(dataDir, cwd, nextProject.id).status, 'ready');
  // The worktree leaf gets past the pool gate. This suite has no worktree layout
  // configured, so it stops in preparation — a different gate, and the proof that
  // the saturated project pool did not hold it.
  const worktree = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0 + 1000, tick: poolTick(dataDir, cwd, nextWorktree.id), token: 'pool-pj-2', deps,
  });
  assert.notEqual(worktree.reason, 'cycle_active', 'the project cycles do not bound the worktree pool');
  assert.equal(getWorkspaceWatcherActiveCycles(getWorkspaceWatcher(cwd, { dataDir })).length, 1, 'no slot was reserved');
  assert.equal(chats.length, 0);
});

runCase('startWorkspaceWatcherCycle: a cycle belongs to the pool of the todo it claimed first', async () => {
  const dataDir = freshDataDir('start-pool-first-todo');
  const cwd = makeWorkspace('start-pool-first-todo');
  // One cycle that drives a project leaf and, later in its subtree, a worktree
  // leaf. Only `todoIds[0]` is the cycle's pool: the pool never moves mid-cycle.
  const claimedProject = addReadyTodo(dataDir, cwd, 'claimed project', { executionMode: 'project' });
  const alsoWorktree = addReadyTodo(dataDir, cwd, 'subtree worktree', { executionMode: 'worktree' });
  claimTodoForCycle(dataDir, cwd, claimedProject, 'mixed-orch');
  claimTodoForCycle(dataDir, cwd, alsoWorktree, 'mixed-orch');
  const nextWorktree = addReadyTodo(dataDir, cwd, 'another worktree leaf', { executionMode: 'worktree' });
  const nextProject = addReadyTodo(dataDir, cwd, 'another project leaf', { executionMode: 'project' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({
    maxParallel: 3,
    maxParallelWorktree: 1,
    maxParallelProject: 1,
  }), { dataDir });
  seedLiveCycle(dataDir, cwd, {
    cycleId: 'mixed-cycle',
    chatId: 'mixed-orch',
    todoIds: [claimedProject.id, alsoWorktree.id],
  });
  const chats = [];
  const deps = poolStartDeps(chats);
  const worktree = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, tick: poolTick(dataDir, cwd, nextWorktree.id), token: 'mixed-wt', deps,
  });
  assert.notEqual(worktree.reason, 'cycle_active', 'the worktree todo of that cycle is not the claimed one');
  const project = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0 + 1000, tick: poolTick(dataDir, cwd, nextProject.id), token: 'mixed-pj', deps,
  });
  assert.equal(project.started, false);
  assert.equal(project.reason, 'cycle_active', 'the mixed cycle occupies the project pool');
});

runCase('startWorkspaceWatcherCycle: a cycle whose todo row is gone counts toward the project pool', async () => {
  const dataDir = freshDataDir('start-pool-unresolved');
  const cwd = makeWorkspace('start-pool-unresolved');
  const nextProject = addReadyTodo(dataDir, cwd, 'project leaf', { executionMode: 'project' });
  const nextWorktree = addReadyTodo(dataDir, cwd, 'worktree leaf', { executionMode: 'worktree' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({ maxParallel: 2, maxParallelProject: 1 }), { dataDir });
  // A deleted todo, so no row can ever resolve the slot's folder.
  seedLiveCycle(dataDir, cwd, { cycleId: 'orphan', chatId: 'orphan-orch', todoIds: ['gone-todo'] });
  const chats = [];
  const deps = poolStartDeps(chats);
  const project = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, tick: poolTick(dataDir, cwd, nextProject.id), token: 'orphan-pj', deps,
  });
  assert.equal(project.started, false);
  assert.equal(project.reason, 'cycle_active', 'an untraceable cycle is charged to the conservative pool');
  const worktree = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0 + 1000, tick: poolTick(dataDir, cwd, nextWorktree.id), token: 'orphan-wt', deps,
  });
  assert.notEqual(worktree.reason, 'cycle_active', 'and never blocks the other pool');
  assert.equal(chats.length, 0, 'no orchestrator chat for a leaf stopped by the pool gate');
});

runCase('startWorkspaceWatcherCycle: a start that passes the pre-check is aborted when the pool filled inside the lock', async () => {
  const dataDir = freshDataDir('start-pool-in-lock');
  const cwd = makeWorkspace('start-pool-in-lock');
  const inFlight = addReadyTodo(dataDir, cwd, 'worktree in flight', { executionMode: 'worktree' });
  claimTodoForCycle(dataDir, cwd, inFlight, 'wt-orch');
  const nextWorktree = addReadyTodo(dataDir, cwd, 'second worktree leaf', { executionMode: 'worktree' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({ maxParallel: 2, maxParallelWorktree: 1 }), { dataDir });
  // The stale row is the pre-check's view: no cycle yet. The store gets the
  // second worktree cycle before the reservation runs, exactly like a start that
  // raced this one, so only the in-lock re-check can refuse it.
  const staleWatcher = getWorkspaceWatcher(cwd, { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'wt-race', chatId: 'wt-orch', todoIds: [inFlight.id] });
  const chats = [];
  const deps = poolStartDeps(chats);
  const started = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    tick: poolTick(dataDir, cwd, nextWorktree.id, staleWatcher),
    token: 'race-lease',
    deps,
  });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'cycle_active');
  assert.equal(chats.length, 0, 'the reservation never reached the orchestrator');
  assert.equal(getTodoById(dataDir, cwd, nextWorktree.id).status, 'ready');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(getWorkspaceWatcherActiveCycles(row).map((cycle) => cycle.cycleId), ['wt-race'], 'no phantom slot');
});

runCase('startWorkspaceWatcherCycle: the global cap still wins once both pools are configured above it', async () => {
  const dataDir = freshDataDir('start-pool-global-cap');
  const cwd = makeWorkspace('start-pool-global-cap');
  const firstWt = addReadyTodo(dataDir, cwd, 'worktree one', { executionMode: 'worktree' });
  const secondWt = addReadyTodo(dataDir, cwd, 'worktree two', { executionMode: 'worktree' });
  claimTodoForCycle(dataDir, cwd, firstWt, 'wt-1');
  claimTodoForCycle(dataDir, cwd, secondWt, 'wt-2');
  const nextProject = addReadyTodo(dataDir, cwd, 'project leaf', { executionMode: 'project' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({
    maxParallel: 2,
    maxParallelWorktree: 2,
    maxParallelProject: 2,
  }), { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'wt-a', chatId: 'wt-1', todoIds: [firstWt.id] });
  seedLiveCycle(dataDir, cwd, { cycleId: 'wt-b', chatId: 'wt-2', todoIds: [secondWt.id] });
  const chats = [];
  const deps = poolStartDeps(chats);
  const refused = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, tick: poolTick(dataDir, cwd, nextProject.id), token: 'global-cap', deps,
  });
  assert.equal(refused.started, false);
  assert.equal(refused.reason, 'cycle_active');
  assert.equal(chats.length, 0);
  // Raising only the global cap admits the same leaf, which proves the refusal
  // above came from `maxParallel` and not from the project pool.
  patchWatcherPolicy(dataDir, cwd, { maxParallel: 3 });
  const room = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0 + 1000, tick: poolTick(dataDir, cwd, nextProject.id), token: 'global-room', deps,
  });
  assert.equal(room.started, true, JSON.stringify(room));
});

runCase('tick: a full worktree cycle pool starts the eligible project todo instead of waiting', async () => {
  const dataDir = freshDataDir('tick-pool-anti-starvation');
  const cwd = makeWorkspace('tick-pool-anti-starvation');
  const inFlight = addReadyTodo(dataDir, cwd, 'worktree in flight', { executionMode: 'worktree' });
  claimTodoForCycle(dataDir, cwd, inFlight, 'wt-orch');
  // First in pick order and in the saturated pool, so the tick has to step over
  // it rather than wait behind it.
  const nextWorktree = addReadyTodo(dataDir, cwd, 'blocked worktree leaf', { executionMode: 'worktree', siblingIndex: 0 });
  const nextProject = addReadyTodo(dataDir, cwd, 'eligible project leaf', { executionMode: 'project', siblingIndex: 1 });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({ maxParallel: 3, maxParallelWorktree: 1 }), { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'wt-cycle', chatId: 'wt-orch', todoIds: [inFlight.id] }, T0 - 5000);
  const chats = [];
  const pass = await runWorkspaceWatcherAutopilot({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    token: 'anti-starve',
    deps: poolStartDeps(chats),
  });
  assert.equal(pass.started, 1, JSON.stringify(pass.errors || []));
  assert.deepEqual(pass.cycles[0].todoIds, [nextProject.id], 'the other pool keeps working');
  assert.equal(pass.cycles[0].mode, 'implement');
  assert.equal(getTodoById(dataDir, cwd, nextProject.id).status, 'doing');
  assert.equal(getTodoById(dataDir, cwd, nextWorktree.id).status, 'ready', 'the saturated pool is untouched');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  const last = row.decisions.at(-1);
  assert.equal(last.kind, 'start_cycle');
  assert.equal(last.nextTodoId, nextProject.id);
  assert.equal(last.pool, undefined);
});

runCase('tick: with no other pool to fall through to, the wait names the saturated pool and only its cycles', async () => {
  const dataDir = freshDataDir('tick-pool-cycle-wait');
  const cwd = makeWorkspace('tick-pool-cycle-wait');
  const wtInFlight = addReadyTodo(dataDir, cwd, 'worktree in flight', { executionMode: 'worktree' });
  const pjInFlight = addReadyTodo(dataDir, cwd, 'project in flight', { executionMode: 'project' });
  claimTodoForCycle(dataDir, cwd, wtInFlight, 'wt-orch');
  claimTodoForCycle(dataDir, cwd, pjInFlight, 'pj-orch');
  const readyWorktree = addReadyTodo(dataDir, cwd, 'only ready leaf', { executionMode: 'worktree' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({
    maxParallel: 3,
    maxParallelWorktree: 1,
    maxParallelProject: 1,
  }), { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'wt-cycle', chatId: 'wt-orch', todoIds: [wtInFlight.id] });
  seedLiveCycle(dataDir, cwd, { cycleId: 'pj-cycle', chatId: 'pj-orch', todoIds: [pjInFlight.id] });
  const tick = await tickWorkspaceWatcher({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    token: 'pool-wait',
    deps: poolStartDeps([]),
  });
  assert.equal(tick.decision.kind, 'wait_active');
  assert.equal(tick.decision.reason, 'cycle_active');
  assert.equal(tick.decision.pool, 'worktree');
  assert.deepEqual(tick.decision.slotChats, [{ chatId: 'wt-orch', cycleId: 'wt-cycle' }], 'only the saturated pool holds slots');
  assert.equal(tick.decision.slotHolders, undefined);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  const last = row.decisions.at(-1);
  assert.equal(last.pool, 'worktree', 'the marker survives the store round-trip');
  assert.deepEqual(last.slotChats, [{ chatId: 'wt-orch', cycleId: 'wt-cycle' }]);
  assert.match(describeWorkspaceWatcherDecision(last), /cycle_active:worktree/);
  assert.equal(getTodoById(dataDir, cwd, readyWorktree.id).status, 'ready');
});

runCase('tick: a symmetric full project cycle pool names the eligible worktree todo', async () => {
  const dataDir = freshDataDir('tick-pool-project-starvation');
  const cwd = makeWorkspace('tick-pool-project-starvation');
  const pjInFlight = addReadyTodo(dataDir, cwd, 'project in flight', { executionMode: 'project' });
  claimTodoForCycle(dataDir, cwd, pjInFlight, 'pj-orch');
  const readyProject = addReadyTodo(dataDir, cwd, 'blocked project leaf', { executionMode: 'project', siblingIndex: 0 });
  const readyWorktree = addReadyTodo(dataDir, cwd, 'eligible worktree leaf', { executionMode: 'worktree', siblingIndex: 1 });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({ maxParallel: 3, maxParallelProject: 1 }), { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'pj-cycle', chatId: 'pj-orch', todoIds: [pjInFlight.id] }, T0 - 5000);
  const tick = await tickWorkspaceWatcher({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    token: 'symmetric',
    deps: poolStartDeps([]),
  });
  assert.equal(tick.decision.kind, 'start_cycle');
  assert.equal(tick.decision.nextTodoId, readyWorktree.id, 'the first-picked project leaf is stepped over');
  assert.equal(tick.decision.pool, undefined, 'a decision that found room names no pool');
  assert.equal(getTodoById(dataDir, cwd, readyProject.id).status, 'ready');
  const last = getWorkspaceWatcher(cwd, { dataDir }).decisions.at(-1);
  assert.equal(last.kind, 'start_cycle');
  assert.equal(last.nextTodoId, readyWorktree.id);
});

runCase('runWorkspaceWatcherTick: a cycle-saturated pool reaches the driver as a wait, never a start', async () => {
  const dataDir = freshDataDir('control-pool-wait');
  const cwd = makeWorkspace('control-pool-wait');
  const inFlight = addReadyTodo(dataDir, cwd, 'worktree in flight', { executionMode: 'worktree' });
  claimTodoForCycle(dataDir, cwd, inFlight, 'wt-orch');
  addReadyTodo(dataDir, cwd, 'only a worktree leaf is ready', { executionMode: 'worktree' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({ maxParallel: 3, maxParallelWorktree: 1 }), { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'wt-cycle', chatId: 'wt-orch', todoIds: [inFlight.id] });
  const chats = [];
  const run = await runWorkspaceWatcherTick({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    token: 'control-pool',
    deps: poolStartDeps(chats),
  });
  assert.equal(run.tick.decision.kind, 'wait_active');
  assert.equal(run.tick.decision.reason, 'cycle_active');
  assert.equal(run.tick.decision.pool, 'worktree');
  assert.equal(run.started, null, 'the driver never calls a start for a refused pool');
  assert.equal(chats.length, 0);
});

runCase('tick: the global cycle cap keeps its exact decision shape with pools configured', async () => {
  const dataDir = freshDataDir('tick-pool-global-shape');
  const cwd = makeWorkspace('tick-pool-global-shape');
  const wtInFlight = addReadyTodo(dataDir, cwd, 'worktree in flight', { executionMode: 'worktree' });
  const pjInFlight = addReadyTodo(dataDir, cwd, 'project in flight', { executionMode: 'project' });
  claimTodoForCycle(dataDir, cwd, wtInFlight, 'wt-orch');
  claimTodoForCycle(dataDir, cwd, pjInFlight, 'pj-orch');
  addReadyTodo(dataDir, cwd, 'ready leaf', { executionMode: 'project' });
  upsertWorkspaceWatcher(cwd, poolCycleWatcher({
    maxParallel: 2,
    maxParallelWorktree: 2,
    maxParallelProject: 2,
  }), { dataDir });
  seedLiveCycle(dataDir, cwd, { cycleId: 'wt-cycle', chatId: 'wt-orch', todoIds: [wtInFlight.id] });
  seedLiveCycle(dataDir, cwd, { cycleId: 'pj-cycle', chatId: 'pj-orch', todoIds: [pjInFlight.id] });
  const tick = await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0, token: 'global-shape', deps: poolStartDeps([]) });
  assert.equal(tick.decision.reason, 'cycle_active', 'every pool has room, the sum does not');
  assert.equal('pool' in tick.decision, false, 'the global refusal stays exactly the decision it was');
  assert.deepEqual(tick.decision.slotChats, [
    { chatId: 'wt-orch', cycleId: 'wt-cycle' },
    { chatId: 'pj-orch', cycleId: 'pj-cycle' },
  ]);
  const last = getWorkspaceWatcher(cwd, { dataDir }).decisions.at(-1);
  assert.equal('pool' in last, false, 'and the store round-trip does not invent one');
  assert.deepEqual(last.slotChats, tick.decision.slotChats);
});

runCase('a watcher row written before the pool fields existed starts the same cycles as one with 0', async () => {
  // The legacy row is written straight to the store file, so its policy really
  // has no `maxParallelWorktree` / `maxParallelProject` keys at all — the shape
  // every workspace on every install has today.
  const legacyDir = freshDataDir('pool-legacy-row');
  const legacyCwd = makeWorkspace('pool-legacy-row');
  const zeroDir = freshDataDir('pool-zero-row');
  const zeroCwd = makeWorkspace('pool-zero-row');
  const fixtures = [];
  for (const [dataDir, cwd] of [[legacyDir, legacyCwd], [zeroDir, zeroCwd]]) {
    const wtInFlight = addReadyTodo(dataDir, cwd, 'worktree in flight', { executionMode: 'worktree' });
    claimTodoForCycle(dataDir, cwd, wtInFlight, 'wt-orch');
    const wtReady = addReadyTodo(dataDir, cwd, 'second worktree leaf', { executionMode: 'worktree', siblingIndex: 0 });
    const pjReady = addReadyTodo(dataDir, cwd, 'project leaf', { executionMode: 'project', siblingIndex: 1 });
    seedLiveCycle(dataDir, cwd, { cycleId: 'wt-cycle', chatId: 'wt-orch', todoIds: [wtInFlight.id] });
    fixtures.push({ wtReady: wtReady.id, pjReady: pjReady.id });
  }
  upsertWorkspaceWatcher(zeroCwd, poolCycleWatcher({ maxParallel: 2, maxParallelWorktree: 0, maxParallelProject: 0 }), { dataDir: zeroDir });
  upsertWorkspaceWatcher(legacyCwd, poolCycleWatcher({ maxParallel: 2 }), { dataDir: legacyDir });
  stripPoolFieldsFromStore(legacyDir, legacyCwd);
  const legacyFile = fs.readFileSync(getWorkspaceWatchersDataPath({ dataDir: legacyDir }), 'utf8');
  assert.ok(!legacyFile.includes('maxParallelWorktree') && !legacyFile.includes('maxParallelProject'),
    'the fixture really is a row written before these fields existed');
  const results = [];
  for (const [dataDir, cwd, fixture] of [[legacyDir, legacyCwd, fixtures[0]], [zeroDir, zeroCwd, fixtures[1]]]) {
    const chats = [];
    const deps = poolStartDeps(chats);
    // One lease token for both starts: a failed worktree preparation keeps the
    // cycle lease it took, and a second token would read that as another driver.
    const worktree = await startWorkspaceWatcherCycle({
      workspaceFolder: cwd, dataDir, now: T0, tick: poolTick(dataDir, cwd, fixture.wtReady), token: 'legacy-lease', deps,
    });
    const project = await startWorkspaceWatcherCycle({
      workspaceFolder: cwd, dataDir, now: T0 + 1000, tick: poolTick(dataDir, cwd, fixture.pjReady), token: 'legacy-lease', deps,
    });
    results.push({
      startedChats: chats.length,
      worktree: { started: worktree.started, reason: worktree.reason },
      project: { started: project.started, reason: project.reason },
      cycles: getWorkspaceWatcherActiveCycles(getWorkspaceWatcher(cwd, { dataDir })).length,
    });
  }
  assert.deepEqual(results[0], results[1], 'a legacy row behaves as the documented 0 default');
  // Neither leaf is held by a pool gate here: with no separate limit only
  // `maxParallel` bounds the pair, and the worktree leaf can still reach the
  // worktree preparation step this suite has no layout for.
  assert.equal(results[0].worktree.reason, 'worktree_prepare_failed', JSON.stringify(results[0].worktree));
  assert.equal(results[0].project.started, true, JSON.stringify(results[0].project));
});

runCase('startWorkspaceWatcherCycle: orchestrator refusal rolls back daily budget and failure count', async () => {
  const dataDir = freshDataDir('cycle-orchestrator-refusal');
  const cwd = makeWorkspace('cycle-orchestrator-refusal');
  const todo = addReadyTodo(dataDir, cwd, 'orchestrator blocked');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, maxCyclesPerDay: 3, cooldownMs: 0 },
  }, { dataDir });
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', nextTodoId: todo.id },
    snapshot: { readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
  };
  const result = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, deps: {
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: false, reason: 'all_usage_limited', source: 'pick' }),
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => { throw new Error('should not start'); },
  } });
  assert.equal(result.started, false);
  assert.equal(result.reason, 'orchestrator_unavailable');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycles.count, 0);
  assert.equal(row.lastCycleAt, '');
  assert.equal(row.failures?.[todo.id], undefined);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'ready');
});

runCase('startWorkspaceWatcherCycle: orchestrator refusal respects cooldown and dedupes side effects', async () => {
  await flushWorkspaceWatcherNotices();
  const dataDir = freshDataDir('cycle-orchestrator-cooldown');
  const cwd = makeWorkspace('cycle-orchestrator-cooldown');
  const todo = addReadyTodo(dataDir, cwd, 'orchestrator blocked cooldown');
  const cooldownMs = 60_000;
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, maxCyclesPerDay: 3, cooldownMs },
  }, { dataDir });
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', nextTodoId: todo.id },
    snapshot: { readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
  };
  const pushes = [];
  const notices = [];
  const deps = {
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: false, reason: 'all_usage_limited', source: 'pick' }),
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => { throw new Error('should not start'); },
    notify: (payload) => {
      pushes.push(payload);
      return true;
    },
    noticeDeps: {
      loadChats: () => [{ id: 'pin', watcherPinned: true, workspaceFolder: cwd }],
      appendChatNotice: (_id, text) => {
        notices.push(String(text));
        return { ok: true, appended: [{ seq: notices.length }] };
      },
    },
  };
  const first = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, deps });
  assert.equal(first.started, false);
  assert.equal(first.reason, 'orchestrator_unavailable');
  let row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycles.count, 0);
  assert.equal(row.lastCycleAt, new Date(T0).toISOString());
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'ready');
  assert.equal(row.decisions.filter((entry) => entry.kind === 'orchestrator_blocked').length, 1);
  assert.equal(pushes.length, 1);
  // The notice is appended fire-and-forget; await the serialization chain so
  // the assertion observes the queued append instead of racing it.
  await flushWorkspaceWatcherNotices();
  assert.equal(notices.length, 1);

  const secondTick = {
    ...tick,
    watcher: row,
  };
  const second = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 5_000,
    tick: secondTick,
    deps,
  });
  assert.equal(second.started, false);
  assert.notEqual(second.reason, 'orchestrator_unavailable', 'cooldown blocks another reservation attempt');
  row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycles.count, 0);
  assert.equal(row.decisions.filter((entry) => entry.kind === 'orchestrator_blocked').length, 1);
  assert.equal(pushes.length, 1);
  await flushWorkspaceWatcherNotices();
  assert.equal(notices.length, 1);
});

runCase('startWorkspaceWatcherCycle: missing orchestrator pick rolls back without default harness', async () => {
  const dataDir = freshDataDir('cycle-no-orch');
  const cwd = makeWorkspace('cycle-no-orch');
  const todo = addReadyTodo(dataDir, cwd, 'needs model');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  const deps = {
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => ({ runId: 'run-x', accepted: true }),
    listHarnessCatalog: async () => [],
    listHarnessModels: async () => ({ items: [] }),
    selectModelPick: () => ({ ok: false, error: 'MODEL_UNAVAILABLE' }),
    notify: () => false,
  };
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, token: 'no-orch', deps });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'orchestrator_unavailable');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, null);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'ready');
});

runCase('reconcileWorkspaceWatcherCycle: incomplete todo increments failures up to skip', async () => {
  const dataDir = freshDataDir('cycle-incomplete');
  const cwd = makeWorkspace('cycle-incomplete');
  const todo = addReadyTodo(dataDir, cwd, 'stuck');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'chat-orphan', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot', policy: { maxConsecutiveFailures: 3 } }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeCycle: {
      cycleId: 'c-inc',
      todoIds: [todo.id],
      startedAt: new Date(T0).toISOString(),
      chatId: 'chat-done',
      runId: 'run-done',
      phase: 'running',
      planOnly: false,
    },
  }), { dataDir });
  for (let i = 0; i < 3; i += 1) {
    const closed = await reconcileWorkspaceWatcherCycle({
      workspaceFolder: cwd,
      dataDir,
      now: T0 + i * 1000,
      deps: {
        probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
        loadDelegations: () => [],
        notify: () => false,
      },
    });
    assert.equal(closed.closed, true);
    mutateWorkspaceWatcherRow(cwd, () => ({
      activeCycle: {
        cycleId: `c-inc-${i}`,
        todoIds: [todo.id],
        startedAt: new Date(T0 + i * 1000).toISOString(),
        chatId: `chat-done-${i}`,
        runId: `run-${i}`,
        phase: 'running',
        planOnly: false,
      },
    }), { dataDir });
  }
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.ok((row.failures?.[todo.id] || 0) >= 3);
  const snap = await snapshotWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0 });
  const picked = pickNextWorkspaceReadyTodo({ readyLeaves: snap.readyLeaves, failures: row.failures, maxFailures: 3 });
  assert.equal(picked, null, 'todo is skipped after repeated incomplete cycles');
  assert.equal(
    shouldCountWorkspaceWatcherCycleIncomplete({
      cycle: { planOnly: true },
      todo: { id: todo.id, status: 'ready', plan: { markdown: '# draft' } },
      watcher: row,
    }),
    false,
  );
});

runCase('runWorkspaceWatcherTick: manual tick starts a cycle with shared deps', async () => {
  const dataDir = freshDataDir('manual-tick');
  const cwd = makeWorkspace('manual-tick');
  const todo = addReadyTodo(dataDir, cwd, 'tick me');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5, maxParallel: 5 },
  }, { dataDir });
  const deps = {
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async (input) => ({ runId: `run-${input.chatId}`, accepted: true }),
    listHarnessCatalog: async () => [{ id: 'mock', enabled: true, ready: true, can_delegate: true }],
    listHarnessModels: async () => ({ items: [{ id: 'cheap' }] }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    mcpCapabilityProbe: () => ({ ok: true }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  };
  const result = await runWorkspaceWatcherTick({ dataDir, workspaceFolder: cwd, now: T0, deps });
  assert.ok(result.tick.wrote);
  assert.equal(result.started?.started, true);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing');
});

runCase('activeCycle starting phase stays alive until deadline or runId', () => {
  const now = T0;
  const probe = () => ({ known: false, busy: false, reason: 'unknown' });
  const alive = isWorkspaceWatcherActiveCycleChatAlive({
    chatId: 'c1',
    cycleId: 'req-1',
    phase: 'starting',
    startDeadlineAt: new Date(now + 60_000).toISOString(),
    runId: '',
  }, probe, now);
  assert.equal(alive, true);
});

runCase('orchestrator resolution: one limited favorite leaves the other model', async () => {
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const limits = [{ harness: 'mock', model: 'cheap', resetAt }];
  assert.equal(isWorkspaceWatcherOrchestratorModelUsageLimited('mock', 'cheap', limits), true);
  assert.equal(isWorkspaceWatcherOrchestratorModelUsageLimited('mock', 'premium', limits), false);
  const picked = await resolveOrchestratorDirect({
    watcher: { policy: { orchestrator: { harness: 'mock', model: '' } } },
    activeUsageLimits: limits,
    deps: {
      listHarnessCatalog: async () => [{ id: 'mock', enabled: true, ready: true, can_delegate: true }],
      listHarnessModels: async () => ({ items: [{ id: 'cheap' }, { id: 'premium' }] }),
      mcpCapabilityProbe: () => ({ ok: true }),
    },
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.model, 'premium');
});

runCase('activeCycle: starting with runId probes idle instead of staying alive forever', () => {
  const idle = isWorkspaceWatcherActiveCycleChatAlive({
    chatId: 'c1',
    cycleId: 'req-1',
    phase: 'starting',
    startDeadlineAt: new Date(T0 - 60_000).toISOString(),
    runId: 'run-finished',
  }, () => ({ known: true, busy: false, reason: 'idle' }), T0);
  assert.equal(idle, false);
});

runCase('activeCycle: accepted with empty runId still probes after start deadline', () => {
  const store = openRecoveryStore({ dataDir: ISOLATED_DATA_DIR });
  try {
    const chat = addChat('sess-ww-alive', 'Watcher alive probe', null, '/tmp', 'm', {
      agentTransport: 'codex',
      sdkMode: 'agent',
    });
    const launch = beginRunLaunch({
      family: 'chat',
      owner: 'chat-run-service',
      chatId: chat.id,
      harness: 'codex',
    }, store);
    recordExecutorAck({
      logicalRunId: launch.ids.logicalRunId,
      expectedRevision: launch.run.revision,
      source: 'adapter_ack',
      adapterRunId: '',
    }, store);
    registerKernelChatRunAdapter({
      transport: 'codex',
      rooms: new Map(),
      ensureRoom: async () => ({ room: {}, chat }),
      recoveryStore: store,
    });
    const cycleId = launch.ids.requestId;
    let probeCalls = 0;
    const probe = () => {
      probeCalls += 1;
      return { known: true, busy: true, reason: 'busy' };
    };
    const alive = isWorkspaceWatcherActiveCycleChatAlive({
      chatId: chat.id,
      cycleId,
      phase: 'starting',
      startDeadlineAt: new Date(T0 - 60_000).toISOString(),
      runId: '',
    }, probe, T0);
    assert.equal(alive, true);
    assert.ok(probeCalls >= 1, 'chat-scoped probe must run when adapterRunId is empty');
    probeCalls = 0;
    const idleProbe = () => {
      probeCalls += 1;
      return { known: true, busy: false, reason: 'idle' };
    };
    const idle = isWorkspaceWatcherActiveCycleChatAlive({
      chatId: chat.id,
      cycleId,
      phase: 'starting',
      startDeadlineAt: new Date(T0 - 60_000).toISOString(),
      runId: '',
    }, idleProbe, T0);
    assert.equal(idle, false);
    assert.ok(probeCalls >= 1);
  } finally {
    closeRecoveryStore(store);
    unregisterChatRunAdapter('codex');
  }
});

runCase('startWorkspaceWatcherCycle: deferred resolver aborts when watcher disables mid-flight', async () => {
  const dataDir = freshDataDir('cycle-deferred');
  const cwd = makeWorkspace('cycle-deferred');
  const todo = addReadyTodo(dataDir, cwd, 'defer');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  /** @type {(() => void) | null} */
  let releaseResolver = null;
  const resolverGate = new Promise((resolve) => {
    releaseResolver = () => resolve({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' });
  });
  const deps = {
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => ({ runId: 'run-defer', accepted: true }),
    resolveWorkspaceWatcherOrchestrator: () => resolverGate,
    startStartingLeaseRenewal: () => () => {},
  };
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title }] },
  };
  const startedPromise = startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, tick, token: 'defer', deps,
  });
  upsertWorkspaceWatcher(cwd, { enabled: false }, { dataDir });
  releaseResolver?.();
  const started = await startedPromise;
  assert.equal(started.started, false);
  assert.match(started.reason, /^aborted_/);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, null);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'ready');
});

runCase('startWorkspaceWatcherCycle: plan request drops when plan cycle start fails', async () => {
  const dataDir = freshDataDir('cycle-plan-drop');
  const cwd = makeWorkspace('cycle-plan-drop');
  const todo = addReadyTodo(dataDir, cwd, 'plan fail');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: true, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  const deps = {
    addChat: () => ({ id: 'chat-plan' }),
    startChatRun: async () => { throw new Error('adapter down'); },
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    startStartingLeaseRenewal: () => () => {},
  };
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'plan_gate', planOnly: true, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title, plan: {} }] },
  };
  const started = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, tick, token: 'plan-drop', deps,
  });
  assert.equal(started.started, false);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.planRequests?.[todo.id], undefined);
});

runCase('reconcileWorkspaceWatcherCycle: clears claim metadata on done todos', async () => {
  const dataDir = freshDataDir('cycle-done-claim');
  const cwd = makeWorkspace('cycle-done-claim');
  const todo = addReadyTodo(dataDir, cwd, 'finished');
  updateTodo(dataDir, cwd, todo.id, {
    status: 'done',
    claimedByChatId: 'chat-done-cycle',
    expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
  });
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot' }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeCycle: {
      cycleId: 'c-done',
      todoIds: [todo.id],
      startedAt: new Date(T0).toISOString(),
      chatId: 'chat-done-cycle',
      runId: 'run-done',
      phase: 'running',
    },
  }), { dataDir });
  const closed = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
    },
  });
  assert.equal(closed.closed, true);
  assert.equal(getTodoById(dataDir, cwd, todo.id).claimedByChatId, undefined);
});

runCase('workspace watcher autopilot schedule debounces by normalized workspace key', async () => {
  const { scheduleWorkspaceWatcherAutopilot, registerWorkspaceWatcherAutopilotRunner, __resetWorkspaceWatcherAutopilotScheduleForTest, workspaceWatcherAutopilotPendingDebounceCount } = await import('../lib/workspace-watcher-event-schedule.js');
  __resetWorkspaceWatcherAutopilotScheduleForTest();
  let runs = 0;
  registerWorkspaceWatcherAutopilotRunner(async () => { runs += 1; });
  scheduleWorkspaceWatcherAutopilot({ workspaceFolder: '/proj/', debounceMs: 40 });
  scheduleWorkspaceWatcherAutopilot({ workspaceFolder: '/proj', debounceMs: 40 });
  assert.equal(workspaceWatcherAutopilotPendingDebounceCount(), 1);
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(runs, 1);
  __resetWorkspaceWatcherAutopilotScheduleForTest();
});

runCase('runWorkspaceWatcherAutopilot: starts exactly one cycle per workspace tick', async () => {
  const dataDir = freshDataDir('autopilot-driver');
  const cwd = makeWorkspace('autopilot-driver');
  const todo = addReadyTodo(dataDir, cwd, 'autopilot work');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 10, maxParallel: 5 },
  }, { dataDir });
  const runCalls = [];
  const deps = {
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async (input) => {
      runCalls.push(input);
      return { runId: 'auto-run', accepted: true };
    },
    // Deterministic orchestrator seam: the ambient harness catalog / usage
    // ledger must not decide whether this cycle can start.
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  };
  const first = await runWorkspaceWatcherAutopilot({ dataDir, now: T0, token: 'auto', deps });
  assert.equal(first.scanned, 1);
  assert.equal(first.started, 1);
  assert.equal(runCalls.length, 1);
  const second = await runWorkspaceWatcherAutopilot({ dataDir, now: T0 + 1000, token: 'auto', deps });
  assert.equal(second.started, 0, 'an active cycle is never duplicated');
  assert.equal(runCalls.length, 1);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing');
});

runCase('empty plan cycle counts failure, clears the gate and records a skip at its ceiling', async () => {
  const dataDir = freshDataDir('empty-plan-cycle');
  const cwd = makeWorkspace('empty-plan-cycle');
  const todo = addReadyTodo(dataDir, cwd, 'no draft produced');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'empty-plan-chat', expectedUpdatedAt: todo.updatedAt });
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot', policy: { maxConsecutiveFailures: 1 } }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    planRequests: { [todo.id]: new Date(T0).toISOString() },
    activeCycle: { cycleId: 'empty-plan', todoIds: [todo.id], chatId: 'empty-plan-chat', runId: 'empty-plan-run',
      startedAt: new Date(T0).toISOString(), phase: 'running', planOnly: true },
  }), { dataDir });
  const result = await reconcileWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, deps: {
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    loadDelegations: () => [], notify: () => false,
  } });
  assert.equal(result.closed, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todo.id], 1);
  assert.equal(row.planRequests[todo.id], undefined);
  const released = getTodoById(dataDir, cwd, todo.id);
  assert.equal(released.status, 'ready');
  assert.equal(released.claimedByChatId, undefined);
  assert.match(released.changelog.at(-1).text, /skipped this todo after 1 failed/);
  assert.match(released.blockedReason, /failure ceiling/);
  assert.equal(listReadyTodoLeaves([released]).length, 0);
  const afterClose = await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0 + 500, token: 'close-stop' });
  assert.equal(afterClose.decision.kind, 'idle_no_work');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).stopReason, 'loop_no_eligible_work');
});

runCase('cycle starts with default cooldown at the last allowed daily slot', async () => {
  for (const planOnly of [false, true]) {
    const dataDir = freshDataDir(`cycle-default-policy-${planOnly}`);
    const cwd = makeWorkspace(`cycle-default-policy-${planOnly}`);
    const todo = addReadyTodo(dataDir, cwd, 'default policy');
    upsertWorkspaceWatcher(cwd, {
      mode: 'autopilot', policy: { requirePlanApproval: planOnly, maxCyclesPerDay: 1 },
    }, { dataDir });
    let runs = 0;
    const tick = {
      watcher: getWorkspaceWatcher(cwd, { dataDir }),
      decision: { kind: planOnly ? 'plan_gate' : 'start_cycle', planOnly, nextTodoId: todo.id },
      snapshot: { readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
    };
    const result = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, deps: {
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap' }),
      addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
      startChatRun: async () => { runs += 1; return { accepted: true, runId: 'run-default' }; },
    } });
    assert.equal(result.started, true, result.reason);
    assert.equal(runs, 1);
    assert.equal(getWorkspaceWatcher(cwd, { dataDir }).cycles.count, 1);
  }
});

runCase('start failure after adapter acceptance retains the cycle and todo claim', async () => {
  const dataDir = freshDataDir('cycle-accepted-failure');
  const cwd = makeWorkspace('cycle-accepted-failure');
  const todo = addReadyTodo(dataDir, cwd, 'accepted');
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot', policy: { requirePlanApproval: false } }, { dataDir });
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', nextTodoId: todo.id },
    snapshot: { readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
  };
  const result = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, deps: {
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap' }),
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => { throw new Error('response lost after acceptance'); },
    lookupChatRunRequest: () => ({ accepted: true, runId: 'accepted-run' }),
    probeChatRunLiveness: () => ({ known: true, busy: true }),
  } });
  assert.equal(result.reason, 'start_uncertain');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle.runId, 'accepted-run');
  assert.equal(row.stopReason, 'cycle_start_uncertain');
  assert.equal(getTodoById(dataDir, cwd, todo.id).claimedByChatId, row.activeCycle.chatId);
});

runCase('accepted run is cancelled when watcher disables while the start awaits', async () => {
  const dataDir = freshDataDir('cycle-disable-at-start');
  const cwd = makeWorkspace('cycle-disable-at-start');
  const todo = addReadyTodo(dataDir, cwd, 'disable at start');
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot', policy: { requirePlanApproval: false } }, { dataDir });
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', nextTodoId: todo.id },
    snapshot: { readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
  };
  let cancelled = null;
  const result = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, deps: {
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap' }),
    addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
    startChatRun: async () => {
      upsertWorkspaceWatcher(cwd, { enabled: false }, { dataDir });
      return { accepted: true, runId: 'late-run' };
    },
    cancelChatRun: async (input) => { cancelled = input; },
  } });
  assert.equal(result.reason, 'cycle_vanished');
  assert.equal(cancelled.runId, 'late-run');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, null);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'ready');
});

runCase('blocked todo: one changelog entry and one push, never a second block', async () => {
  const dataDir = freshDataDir('blocked-once');
  const cwd = makeWorkspace('blocked-once');
  const todo = addReadyTodo(dataDir, cwd, 'block me');
  const pushes = [];
  const notify = (input) => { pushes.push(String(input.tag || '')); return true; };
  const first = await markWorkspaceWatcherTodoBlocked({
    dataDir, workspaceFolder: cwd, todoId: todo.id, notify, reasonText: 'stuck in a loop',
  });
  assert.equal(first, true);
  const blocked = getTodoById(dataDir, cwd, todo.id);
  assert.equal(blocked.blockedReason, 'stuck in a loop');
  assert.equal(blocked.changelog.at(-1).text, 'stuck in a loop');
  assert.equal(pushes.length, 1);
  const second = await markWorkspaceWatcherTodoBlocked({
    dataDir, workspaceFolder: cwd, todoId: todo.id, notify, reasonText: 'stuck in a loop',
  });
  assert.equal(second, false, 'an already blocked todo is not re-blocked or re-notified');
  assert.equal(pushes.length, 1);
  assert.equal(getTodoById(dataDir, cwd, todo.id).changelog.length, blocked.changelog.length);

  const done = addReadyTodo(dataDir, cwd, 'done todo');
  updateTodo(dataDir, cwd, done.id, { status: 'done', expectedUpdatedAt: done.updatedAt });
  assert.equal(await markWorkspaceWatcherTodoBlocked({
    dataDir, workspaceFolder: cwd, todoId: done.id, notify,
  }), false, 'a finished todo is left alone');
  assert.ok(!getTodoById(dataDir, cwd, done.id).blockedReason);
});

runCase('loop guard: three failed cycles block the todo, keep fresh work, then stop when none remain', async () => {
  const dataDir = freshDataDir('loop-ceiling');
  const cwd = makeWorkspace('loop-ceiling');
  const stuck = addReadyTodo(dataDir, cwd, 'stuck');
  const fresh = addReadyTodo(dataDir, cwd, 'fresh');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 10, maxConsecutiveFailures: 3 },
  }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({ failures: { [stuck.id]: 3 } }), { dataDir });

  const first = await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0, token: 'loop-guard' });
  assert.equal(first.decision.kind, 'start_cycle');
  assert.equal(first.decision.nextTodoId, fresh.id, 'the watcher moves to the fresh todo');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).stopReason, '');
  const parked = getTodoById(dataDir, cwd, stuck.id);
  assert.ok(parked.blockedReason, 'the repeatedly failing todo is parked as blocked');
  assert.equal(parked.changelog.at(-1).kind, 'note');
  assert.match(parked.changelog.at(-1).text, /repeated failed cycles|findings/);
  assert.equal(listReadyTodoLeaves([parked]).length, 0, 'a blocked todo is no longer ready');

  // Now the last remaining ready todo also reaches the ceiling: nothing eligible.
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({ failures: { ...row.failures, [fresh.id]: 3 } }), { dataDir });
  const second = await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0 + 1000, token: 'loop-guard' });
  assert.equal(second.decision.kind, 'idle_no_work');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).stopReason, 'loop_no_eligible_work');
  const freshTodo = getTodoById(dataDir, cwd, fresh.id);
  assert.ok(freshTodo.blockedReason);
  assert.match(freshTodo.changelog.at(-1).text, /repeated failed cycles|findings/);
});

runCase('loop guard: identical findings block the candidate and clear the findings memory', async () => {
  const dataDir = freshDataDir('loop-findings');
  const cwd = makeWorkspace('loop-findings');
  const todo = addReadyTodo(dataDir, cwd, 'loopy');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 10, maxSameFindings: 2 },
  }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    findings: { byTodo: { [todo.id]: { hash: 'same-hash', streak: 2 } } },
  }), { dataDir });
  const tick = await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0, token: 'loop-findings' });
  assert.equal(tick.decision.kind, 'idle_no_work');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.stopReason, 'loop_same_findings');
  assert.equal(row.findings?.byTodo?.[todo.id], undefined, 'the findings memory is cleared for the next todo');
  assert.ok(getTodoById(dataDir, cwd, todo.id).blockedReason);
});

runCase('loop guard: per-todo findings block only the stuck todo when another leaf is ready', async () => {
  const dataDir = freshDataDir('loop-findings-per-todo');
  const cwd = makeWorkspace('loop-findings-per-todo');
  const stuck = addReadyTodo(dataDir, cwd, 'stuck findings');
  const fresh = addReadyTodo(dataDir, cwd, 'fresh work');
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 10, maxSameFindings: 2 },
  }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    findings: { byTodo: { [stuck.id]: { hash: 'same-hash', streak: 2 } } },
  }), { dataDir });
  const tick = await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0, token: 'loop-findings-split' });
  assert.equal(tick.decision.kind, 'start_cycle');
  assert.equal(tick.decision.nextTodoId, fresh.id);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).stopReason, '');
  assert.ok(getTodoById(dataDir, cwd, stuck.id).blockedReason);
  assert.equal(getTodoById(dataDir, cwd, fresh.id).blockedReason, undefined);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).findings?.byTodo?.[stuck.id], undefined);
});

runCase('loop guard plan: parks only stuck leaves and never disturbs paused/stopped/active rows', () => {
  const snapshot = { readyLeaves: [{ id: 'a' }, { id: 'b' }] };
  const row = { mode: 'autopilot', policy: { maxConsecutiveFailures: 3 }, failures: { a: 3 } };
  const loop = evaluateWorkspaceWatcherLoop({ watcher: row, snapshot, candidateTodoId: 'b' });
  assert.deepEqual(loop.blockTodoIds, ['a']);
  assert.equal(loop.hasEligibleWork, true);
  assert.equal(loop.stopReason, '');
  const plan = planWorkspaceWatcherLoopGuard({ mode: 'autopilot', row, snapshot, decision: { nextTodoId: 'b' } });
  assert.deepEqual(plan.parkTodoIds, ['a']);
  assert.equal(plan.stopReason, '');
  assert.deepEqual(planWorkspaceWatcherLoopGuard({
    mode: 'autopilot', row: { ...row, paused: true }, snapshot,
  }).parkTodoIds, []);
  assert.deepEqual(planWorkspaceWatcherLoopGuard({
    mode: 'autopilot', row: { ...row, stopReason: 'manual' }, snapshot,
  }).parkTodoIds, []);
  assert.deepEqual(planWorkspaceWatcherLoopGuard({
    mode: 'autopilot', row: { ...row, activeCycle: { cycleId: 'c' } }, snapshot,
  }).parkTodoIds, []);
  assert.deepEqual(planWorkspaceWatcherLoopGuard({ mode: 'observe', row, snapshot }).parkTodoIds, []);

  const findingsRow = {
    mode: 'autopilot',
    policy: { maxSameFindings: 2 },
    findings: { byTodo: { a: { hash: 'h', streak: 2 } } },
  };
  const findingsLoop = evaluateWorkspaceWatcherLoop({
    watcher: findingsRow,
    snapshot: { readyLeaves: [{ id: 'a' }] },
    candidateTodoId: 'a',
  });
  assert.equal(findingsLoop.findingsLoop, true);
  assert.deepEqual(findingsLoop.clearFindingsTodoIds, ['a']);
  assert.equal(findingsLoop.stopReason, 'loop_same_findings');
});

runCase('backoff: a failure window parks decisions until it expires', () => {
  const base = {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5 },
    cycles: { day: '', count: 0 },
    lastCycleAt: '',
    findings: { byTodo: {} },
  };
  const waiting = decideWorkspaceWatcherAction({
    watcher: { ...base, backoffUntil: new Date(T0 + 60_000).toISOString() },
    snapshot: { readyTodoCount: 1, readyLeaves: [{ id: 't1', plan: { approvedAt: 'x' } }] },
    now: T0,
  });
  assert.equal(waiting.kind, 'backoff');
  assert.equal(waiting.reason, 'failure_backoff');
  const expired = decideWorkspaceWatcherAction({
    watcher: { ...base, backoffUntil: new Date(T0 - 1000).toISOString() },
    snapshot: { readyTodoCount: 1, readyLeaves: [{ id: 't1', plan: { approvedAt: 'x' } }] },
    now: T0,
  });
  assert.equal(expired.kind, 'start_cycle');
});

runCase('global pause halts the autopilot and preserves failures, backoff and findings', async () => {
  const dataDir = freshDataDir('watcher-pause');
  const cwd = makeWorkspace('watcher-pause');
  const todo = addReadyTodo(dataDir, cwd, 'paused work');
  const backoffUntil = new Date(T0 - 1000).toISOString();
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    paused: true,
    failures: { [todo.id]: 2 },
    backoffUntil,
    findings: { byTodo: { [todo.id]: { hash: 'keep-me', streak: 1 } } },
  }), { dataDir });

  const pausedRow = getWorkspaceWatcher(cwd, { dataDir });
  const decision = decideWorkspaceWatcherAction({
    watcher: pausedRow,
    snapshot: { readyTodoCount: 1, readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
    now: T0,
  });
  assert.equal(decision.kind, 'paused');
  assert.equal(evaluateWorkspaceWatcherGuardrails({ watcher: pausedRow }).kind, 'paused');

  const runs = [];
  const autopilot = await runWorkspaceWatcherAutopilot({
    dataDir,
    workspaceFolders: [cwd],
    now: T0,
    token: 'pause',
    deps: {
      addChat: (_s, _t, _wf, _folder, _m, extras) => ({ id: extras.id }),
      startChatRun: async (input) => { runs.push(input); return { accepted: true, runId: 'paused-run' }; },
      selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
      probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
    },
  });
  assert.equal(autopilot.started, 0);
  assert.equal(runs.length, 0, 'a paused watcher never starts a cycle');

  const stillPaused = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(stillPaused.failures, { [todo.id]: 2 });
  assert.equal(stillPaused.backoffUntil, backoffUntil);
  assert.deepEqual(stillPaused.findings, { byTodo: { [todo.id]: { hash: 'keep-me', streak: 1 } } });

  upsertWorkspaceWatcher(cwd, { paused: false }, { dataDir });
  const resumedRow = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(resumedRow.paused, false);
  assert.deepEqual(resumedRow.failures, { [todo.id]: 2 }, 'resuming continues from the preserved counters');
  assert.equal(resumedRow.backoffUntil, backoffUntil);
  const resumed = decideWorkspaceWatcherAction({
    watcher: resumedRow,
    snapshot: { readyTodoCount: 1, readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
    now: T0,
  });
  assert.equal(resumed.kind, 'start_cycle');
});

runCase('notifications: idle-with-work, stopReason and plan approval push once per state change', async () => {
  const seen = [];
  const notify = (input) => { seen.push({ tag: String(input.tag || ''), body: String(input.body || '') }); return true; };

  const idleDir = freshDataDir('watcher-notify-idle');
  const idleCwd = makeWorkspace('watcher-notify-idle');
  const idleKey = normalizeWorkspaceFolder(idleCwd);
  const first = addReadyTodo(idleDir, idleCwd, 'idle work one');
  upsertWorkspaceWatcher(idleCwd, { mode: 'observe' }, { dataDir: idleDir });
  await tickWorkspaceWatcher({ workspaceFolder: idleCwd, dataDir: idleDir, now: T0, token: 'notify-idle', notify });
  await tickWorkspaceWatcher({ workspaceFolder: idleCwd, dataDir: idleDir, now: T0 + 1000, token: 'notify-idle', notify });
  assert.equal(seen.filter((row) => row.tag === `cretli-watcher-${idleKey}`).length, 1, 'one push per idle episode');
  // End the episode (no ready work) then start a new one: a fresh push is expected.
  updateTodo(idleDir, idleCwd, first.id, { status: 'done', expectedUpdatedAt: first.updatedAt });
  await tickWorkspaceWatcher({ workspaceFolder: idleCwd, dataDir: idleDir, now: T0 + 2000, token: 'notify-idle', notify });
  addReadyTodo(idleDir, idleCwd, 'idle work two');
  await tickWorkspaceWatcher({ workspaceFolder: idleCwd, dataDir: idleDir, now: T0 + 3000, token: 'notify-idle', notify });
  assert.equal(seen.filter((row) => row.tag === `cretli-watcher-${idleKey}`).length, 2, 'a new episode notifies again');
  // stopReason notifies once per distinct reason.
  mutateWorkspaceWatcherRow(idleCwd, () => ({ stopReason: 'manual_stop' }), { dataDir: idleDir });
  await tickWorkspaceWatcher({ workspaceFolder: idleCwd, dataDir: idleDir, now: T0 + 4000, token: 'notify-idle', notify });
  await tickWorkspaceWatcher({ workspaceFolder: idleCwd, dataDir: idleDir, now: T0 + 5000, token: 'notify-idle', notify });
  assert.equal(seen.filter((row) => row.tag === `cretli-watcher-stopped-${idleKey}`).length, 1);
  assert.match(seen.find((row) => row.tag === `cretli-watcher-stopped-${idleKey}`).body, /manual_stop/);

  // Waiting for plan approval notifies once while the plan request stays pending.
  const planDir = freshDataDir('watcher-notify-plan');
  const planCwd = makeWorkspace('watcher-notify-plan');
  const planKey = normalizeWorkspaceFolder(planCwd);
  const planTodo = addReadyTodo(planDir, planCwd, 'plan approval');
  upsertWorkspaceWatcher(planCwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: true, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir: planDir });
  mutateWorkspaceWatcherRow(planCwd, () => ({ planRequests: { [planTodo.id]: new Date(T0).toISOString() } }), { dataDir: planDir });
  const t1 = await tickWorkspaceWatcher({ workspaceFolder: planCwd, dataDir: planDir, now: T0, token: 'notify-plan', notify });
  const t2 = await tickWorkspaceWatcher({ workspaceFolder: planCwd, dataDir: planDir, now: T0 + 1000, token: 'notify-plan', notify });
  assert.equal(t1.decision.kind, 'wait_plan_approval');
  assert.equal(t2.decision.kind, 'wait_plan_approval');
  assert.equal(seen.filter((row) => row.tag === `cretli-watcher-plan_approval-${planKey}`).length, 1, 'plan approval is deduped');
});

runCase('deferred todos: next_ready/pick skip them and a deferred plan raises no plan_approval or idle_with_work', async () => {
  const dataDir = freshDataDir('watcher-deferred');
  const cwd = makeWorkspace('watcher-deferred');
  const key = normalizeWorkspaceFolder(cwd);
  const seen = [];
  const notify = (input) => { seen.push(String(input.tag || '')); return true; };
  const deferred = addTodo(dataDir, cwd, { title: 'later', status: 'ready' }).item;
  updateTodo(dataDir, cwd, deferred.id, {
    status: 'deferred',
    plan: { markdown: '## Plan\nunapproved draft' },
  });
  const items = loadTodosData(dataDir, cwd).items;
  assert.equal(items[0].status, 'deferred');
  assert.deepEqual(listReadyTodoLeaves(items), []);
  assert.equal(pickNextWorkspaceReadyTodo({ items }), null);
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: true, cooldownMs: 0, maxCyclesPerDay: 5 },
  }, { dataDir });
  const tick = await tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0, token: 'deferred', notify });
  assert.notEqual(tick.decision.kind, 'start_cycle');
  assert.notEqual(tick.decision.kind, 'wait_plan_approval');
  assert.equal(tick.decision.readyTodoCount, 0);
  assert.equal(seen.filter((tag) => tag === `cretli-watcher-plan_approval-${key}` || tag === `cretli-watcher-${key}`).length, 0);
  // a later sibling is not held back by the deferred one
  const parent = addTodo(dataDir, cwd, { title: 'seq', status: 'ready' }).item;
  const first = addTodo(dataDir, cwd, { title: 'first', status: 'ready', parentId: parent.id }).item;
  const second = addTodo(dataDir, cwd, { title: 'second', status: 'ready', parentId: parent.id }).item;
  updateTodo(dataDir, cwd, first.id, { status: 'deferred' });
  assert.deepEqual(listReadyTodoLeaves(loadTodosData(dataDir, cwd).items).map((row) => row.id), [second.id]);
});

for (const { name, fn } of cases) {
  // Serial execution is the isolation mechanism: cases share process-global
  // state and must never overlap. Let the previous case's fire-and-forget
  // watcher notices settle too, or a later case can assert while an earlier
  // case's notice is still queued behind it.
  await flushWorkspaceWatcherNotices();
  try {
    await fn();
    console.log('OK:', name);
  } catch (err) {
    reportFailure(name, err);
  }
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} workspace watcher test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace watcher tests passed');
