import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  WORKSPACE_WATCHER_MAX_DECISIONS,
  WORKSPACE_WATCHERS_LOCK_TIMEOUT_MS,
  WorkspaceWatchersCorruptError,
  WorkspaceWatchersLockError,
  acquireWorkspaceWatcherLease,
  appendWorkspaceWatcherDecision,
  defaultWorkspaceWatcherPolicy,
  getWorkspaceWatcher,
  getWorkspaceWatchersDataPath,
  isWorkspaceWatcherLeaseActive,
  loadWorkspaceWatchers,
  loadWorkspaceWatchersDocument,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceFolder,
  normalizeWorkspaceWatcherRow,
  releaseWorkspaceWatcherLease,
  removeWorkspaceWatcher,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  decideWorkspaceWatcherAction,
  isWorkspaceWatcherActiveCycleChatAlive,
  isWorkspaceTodoClaimAlive,
  pickNextWorkspaceReadyTodo,
  claimWorkspaceTodo,
  claimNextWorkspaceTodo,
  releaseStaleWorkspaceTodoClaims,
  reconcileWorkspaceWatchersOnBoot,
  runWorkspaceWatcherHeartbeat,
  snapshotWorkspaceWatcher,
  tickWorkspaceWatcher,
} from '../lib/workspace-watcher.js';
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
import { getDelegationsDataPath } from '../lib/persist/delegations-persist.js';

let failed = 0;

/** @type {Promise<void>[]} */
const pendingCases = [];

function reportFailure(name, err) {
  failed += 1;
  console.error('FAIL:', name);
  console.error(err && err.stack ? err.stack : String(err));
}

function runCase(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingCases.push(result.then(() => console.log('OK:', name), (err) => reportFailure(name, err)));
      return;
    }
    console.log('OK:', name);
  } catch (err) {
    reportFailure(name, err);
  }
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
function startLockChild(dataDir, holdMs) {
  const helperPath = fileURLToPath(new URL('./helpers/workspace-watcher-lock-child.js', import.meta.url));
  const child = spawn(process.execPath, [helperPath, dataDir, 'hold', String(holdMs)], {
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
  assert.equal(doc.v, 1);
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

runCase('autopilot tick and heartbeat do not write the store', () => {
  const dataDir = freshDataDir('autopilot-inert');
  upsertWorkspaceWatcher(workspaceA, { mode: 'autopilot' }, { dataDir });
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const before = fs.readFileSync(file, 'utf8');
  const tick = tickWorkspaceWatcher({ workspaceFolder: workspaceA, dataDir, deps: observeDeps() });
  assert.equal(tick.reason, 'mode_autopilot_inert');
  assert.equal(tick.wrote, false);
  const hb = runWorkspaceWatcherHeartbeat({ dataDir, token: 'hb', deps: observeDeps() });
  assert.equal(hb.scanned, 1);
  assert.equal(hb.observed, 0);
  assert.equal(hb.wrote, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy: { maxParallel: 1 }, stopReason: '' },
    snapshot: { readyTodoCount: 2, activeAgentCount: 0, errors: [] },
  });
  assert.equal(decision.reason, 'mode_autopilot_inert');
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

runCase('reconcile clears dead activeCycle, releases lease and logs interruption', () => {
  const dataDir = freshDataDir('reconcile-cycle');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycle: { chatId: 'child-chat', todoIds: ['todo-1'], startedAt: new Date(t0).toISOString() },
    lease: { ownerPid: 99, token: 'boot-token', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  const probe = () => ({ known: true, busy: false, reason: 'idle' });
  assert.equal(isWorkspaceWatcherActiveCycleChatAlive({ chatId: 'child-chat' }, probe), false);
  const result = reconcileWorkspaceWatchersOnBoot({ dataDir, now: t0, probeChatRunLiveness: probe });
  assert.equal(result.reconciled, 1);
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.stopReason, 'cycle_interrupted');
  assert.deepEqual(row.lease, { ownerPid: 0, token: '', expiresAt: '' });
  assert.equal(row.decisions.at(-1).kind, 'cycle_interrupted');
});

runCase('reconcile keeps activeCycle when chat liveness is unknown', () => {
  const dataDir = freshDataDir('reconcile-unknown');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycle: { chatId: 'child-chat', todoIds: ['todo-1'], startedAt: new Date().toISOString() },
  }, { dataDir });
  const probe = () => ({ known: false, busy: false, reason: 'adapter_missing' });
  assert.equal(isWorkspaceWatcherActiveCycleChatAlive({ chatId: 'child-chat' }, probe), true);
  const result = reconcileWorkspaceWatchersOnBoot({ dataDir, probeChatRunLiveness: probe });
  assert.equal(result.reconciled, 0);
  assert.ok(getWorkspaceWatcher(workspaceA, { dataDir }).activeCycle);
});

runCase('reconcile isolates a corrupt watcher store and never rewrites it', () => {
  const dataDir = freshDataDir('reconcile-corrupt');
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const corrupt = '{ not json';
  fs.writeFileSync(file, corrupt, 'utf8');
  const result = reconcileWorkspaceWatchersOnBoot({
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

runCase('reconcile clears an activeCycle without chatId without probing', () => {
  const dataDir = freshDataDir('reconcile-no-chat');
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  upsertWorkspaceWatcher(workspaceA, {
    mode: 'observe',
    activeCycle: { todoIds: ['todo-1'], startedAt: new Date(t0).toISOString() },
    lease: { ownerPid: 9, token: 'cycle-lease', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  let probeCalls = 0;
  const result = reconcileWorkspaceWatchersOnBoot({
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
  assert.deepEqual(row.lease, { ownerPid: 0, token: '', expiresAt: '' });
  assert.equal(row.stopReason, 'cycle_interrupted');
  assert.equal(row.decisions.at(-1).kind, 'cycle_interrupted');
  assert.equal(row.decisions.at(-1).reason, 'active_cycle_missing_chat');
});

runCase('reconcile leaves a newer cycle that replaced the probed one', () => {
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
  const result = reconcileWorkspaceWatchersOnBoot({ dataDir, now: t0, probeChatRunLiveness: probe });
  assert.equal(result.reconciled, 0, 'the newer cycle is not reported as reconciled');
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycle.chatId, 'new-chat');
  assert.equal(row.lease.token, 'new-lease');
  assert.equal(row.stopReason, '');
  assert.deepEqual(row.decisions, []);
});

runCase('reconcile keeps a lease taken after the probe while clearing the same cycle', () => {
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
  const result = reconcileWorkspaceWatchersOnBoot({ dataDir, now: t0, probeChatRunLiveness: probe });
  assert.equal(result.reconciled, 1);
  const row = getWorkspaceWatcher(workspaceA, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.lease.token, 'fresh-lease', 'a lease that is not the probed one survives');
  assert.equal(row.stopReason, 'cycle_interrupted');
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
  const holder = startLockChild(dataDir, 700);
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
    const started = Date.now();
    const waited = mutateWorkspaceWatcherRow(workspaceA, () => ({ orchestratorChatId: 'waited' }), {
      dataDir,
      lockTimeoutMs: 10_000,
    });
    const elapsed = Date.now() - started;
    assert.equal(waited.ok, true, `a waiter must be served after the holder releases: ${waited.reason}`);
    assert.ok(
      elapsed >= 100,
      `the second writer entered the critical section while the holder was inside (${elapsed}ms)`,
    );
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

runCase('an unreadable record is corruption, not a row the next save drops', () => {
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
  const boot = reconcileWorkspaceWatchersOnBoot({
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

runCase('snapshot collects ready todos and active delegations for the workspace', () => {
  const snapshot = snapshotWorkspaceWatcher({
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

runCase('snapshot captures store failures instead of throwing', () => {
  const snapshot = snapshotWorkspaceWatcher({
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

runCase('tick records snapshot_error when todos store fails', () => {
  const dataDir = freshDataDir('tick-snapshot-error');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const tick = tickWorkspaceWatcher({
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

runCase('snapshot matches delegations via canonical workspace paths', () => {
  const link = path.join(tmpRoot, 'canonical-link');
  const target = path.join(tmpRoot, 'canonical-target');
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.symlinkSync(target, link, 'dir');
  } catch {
    console.log('SKIP: symlink unavailable for canonical workspace test');
    return;
  }
  const snapshot = snapshotWorkspaceWatcher({
    workspaceFolder: link,
    deps: observeDeps({
      loadDelegations: () => [{ id: 'd-link', status: 'running', workspaceFolder: target }],
      isActiveDelegationStatus: (status) => status === 'running',
    }),
  });
  assert.deepEqual(snapshot.activeDelegationIds, ['d-link']);
});

runCase('tick in off mode does not write the store', () => {
  const dataDir = freshDataDir('tick-off');
  upsertWorkspaceWatcher(workspaceA, { mode: 'off' }, { dataDir });
  const file = getWorkspaceWatchersDataPath({ dataDir });
  const before = fs.readFileSync(file, 'utf8');
  const tick = tickWorkspaceWatcher({ workspaceFolder: workspaceA, dataDir, now: Date.now(), deps: observeDeps() });
  assert.equal(tick.action, 'off');
  assert.equal(tick.wrote, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(getWorkspaceWatcher(workspaceA, { dataDir }).lastTickAt, '');
});

runCase('tick in observe mode records one deduped decision and keeps the lease', () => {
  const dataDir = freshDataDir('tick-observe');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');

  const first = tickWorkspaceWatcher({
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

  const second = tickWorkspaceWatcher({
    workspaceFolder: workspaceA,
    dataDir,
    now: t0 + 1000,
    token: 'test-token',
    decisionDedupeMs: 60_000,
    deps: observeDeps(),
  });
  assert.equal(second.recorded, false, 'same decision within dedupe window is not spammed');

  const third = tickWorkspaceWatcher({
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

runCase('tick yields to a foreign live lease', () => {
  const dataDir = freshDataDir('tick-lease');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  acquireWorkspaceWatcherLease({}, { token: 'other', ttlMs: 60_000, now: t0 });
  upsertWorkspaceWatcher(workspaceA, {
    lease: { ownerPid: 999, token: 'other', expiresAt: new Date(t0 + 60_000).toISOString() },
  }, { dataDir });
  const tick = tickWorkspaceWatcher({ workspaceFolder: workspaceA, dataDir, now: t0, token: 'mine', deps: observeDeps() });
  assert.equal(tick.action, 'lease_held');
  assert.equal(tick.wrote, false);
});

runCase('heartbeat scans all rows, touches only observe and never throws on corrupt store', () => {
  const dataDir = freshDataDir('heartbeat');
  upsertWorkspaceWatcher(workspaceA, { mode: 'observe' }, { dataDir });
  upsertWorkspaceWatcher(workspaceB, { mode: 'off' }, { dataDir });
  const result = runWorkspaceWatcherHeartbeat({ dataDir, now: Date.now(), token: 'hb', deps: observeDeps() });
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
  const corrupt = runWorkspaceWatcherHeartbeat({ dataDir: corruptDir, now: Date.now(), token: 'hb' });
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
  // runCase starts every async case eagerly, so wait for the earlier cases
  // before touching state they share (the isolated data dir).
  const earlierCases = [...pendingCases];
  await Promise.all(earlierCases);
  // Those cases corrupt the delegations store on purpose and restore it at the
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

runCase('claimNextWorkspaceTodo: ready -> doing with claim fields; second pick finds none', () => {
  const dataDir = freshDataDir('claim-basic');
  const cwd = makeWorkspace('claim-basic');
  const todo = addReadyTodo(dataDir, cwd, 'work');
  const alive = () => ({ known: true, busy: true, reason: 'busy' });
  const claim = claimNextWorkspaceTodo({
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
  const second = claimNextWorkspaceTodo({
    dataDir, workspaceFolder: cwd, claimedByChatId: 'chat-B', now: T0, probeChatRunLiveness: alive,
  });
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'no_ready_work');
});

runCase('claimNextWorkspaceTodo: rejects a claim with no claimer or workspace', () => {
  const dataDir = freshDataDir('claim-guards');
  const cwd = makeWorkspace('claim-guards');
  addReadyTodo(dataDir, cwd, 'guarded');
  assert.equal(claimNextWorkspaceTodo({ dataDir, workspaceFolder: cwd, claimedByChatId: '' }).reason, 'no_claimer');
  assert.equal(claimNextWorkspaceTodo({ dataDir, workspaceFolder: '', claimedByChatId: 'chat-A' }).reason, 'no_workspace');
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

runCase('claimWorkspaceTodo: two claims on one stale token, only the first wins', () => {
  const dataDir = freshDataDir('claim-cas');
  const cwd = makeWorkspace('claim-cas');
  const todo = addReadyTodo(dataDir, cwd, 'contended');
  sleepPastMsBoundary(3);
  const token = getTodoById(dataDir, cwd, todo.id).updatedAt;
  const first = claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'chat-A', expectedUpdatedAt: token, now: T0 });
  const second = claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'chat-B', expectedUpdatedAt: token, now: T0 + 1 });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'cas_conflict');
  const reloaded = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reloaded.claimedByChatId, 'chat-A');
  assert.equal(reloaded.status, 'doing');
});

runCase('releaseStaleWorkspaceTodoClaims: keeps busy/unknown, releases a confirmed-dead claim', () => {
  const dataDir = freshDataDir('claim-release');
  const cwd = makeWorkspace('claim-release');
  const todo = addReadyTodo(dataDir, cwd, 'abandoned');
  claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'dead-chat', now: T0 });
  assert.deepEqual(releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: cwd, probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  }).released, [], 'busy chat keeps the claim');
  assert.deepEqual(releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: cwd, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }),
  }).released, [], 'unknown state keeps the claim');
  const released = releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: cwd, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
  });
  assert.deepEqual(released.released, [todo.id]);
  const reloaded = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reloaded.status, 'ready');
  assert.equal(reloaded.claimedByChatId, undefined);
  assert.equal(reloaded.claimedAt, undefined);
});

runCase('releaseStaleWorkspaceTodoClaims: never touches doing items without a claim', () => {
  const dataDir = freshDataDir('claim-no-token');
  const cwd = makeWorkspace('claim-no-token');
  const todo = addReadyTodo(dataDir, cwd, 'manual');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', strictStatus: true });
  const result = releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: cwd, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
  });
  assert.deepEqual(result.released, []);
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing');
});

runCase('claimNextWorkspaceTodo: releases a dead claim then claims for the new chat', () => {
  const dataDir = freshDataDir('claim-reclaim');
  const cwd = makeWorkspace('claim-reclaim');
  const todo = addReadyTodo(dataDir, cwd, 'reclaim');
  claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'dead', now: T0 });
  const claim = claimNextWorkspaceTodo({
    dataDir,
    workspaceFolder: cwd,
    claimedByChatId: 'chat-C',
    now: T0 + 10,
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.item.claimedByChatId, 'chat-C');
});

runCase('observe tick logs nextTodoId but never claims or changes the todo', () => {
  const dataDir = freshDataDir('observe-no-claim');
  const cwd = makeWorkspace('observe-no-claim');
  const todo = addReadyTodo(dataDir, cwd, 'observed');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  const deps = observeDeps({
    loadTodosData: () => loadTodosData(dataDir, cwd),
    listReadyTodoLeaves: (items) => listReadyTodoLeaves(items),
  });
  const tick = tickWorkspaceWatcher({
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

for (const pending of pendingCases) {
  // eslint-disable-next-line no-await-in-loop -- async cases touch shared persist files
  await pending;
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} workspace watcher test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace watcher tests passed');
