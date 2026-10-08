/**
 * Workspace Watcher end-to-end acceptance suite (task 8).
 *
 * Drives the real autopilot runtime end to end against the shared in-process
 * mock chat-run adapter and the real persist stores (watchers, todos, chats):
 *
 *   1. three ready todos run one cycle at a time to completion,
 *   2. a failed cycle blocks only its own todo and fresh work keeps moving,
 *   3. a restart mid-cycle reconciles exactly once, with no duplicate cycle or
 *      claim, and the next cycle starts cleanly,
 *   4. two processes cannot both drive a workspace (singleton lease),
 *   5. `off` and `observe` never start an agent.
 *
 * Every case uses a per-case `dataDir` for the watcher/todo stores. Chats land in
 * the process-wide isolated data dir and are scoped per workspace by the
 * snapshot, never in a contributor's real `data/`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import {
  reconcileWorkspaceWatchersOnBoot,
  runWorkspaceWatcherHeartbeat,
  tickWorkspaceWatcher,
} from '../lib/workspace-watcher.js';
import {
  reportWorkspaceWatcherCycle,
  runWorkspaceWatcherAutopilot,
} from '../lib/workspace-watcher-cycle.js';
import {
  getMockChatRun,
  getMockChatRunStartCount,
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';
import { probeChatRunLiveness } from '../lib/chat-run-service.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-e2e-'));
const T0 = Date.parse('2026-03-01T10:00:00.000Z');

let failed = 0;
/** @type {Array<() => Promise<void>>} */
const cases = [];

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
function runCase(name, fn) {
  cases.push(async () => {
    try {
      await fn();
      console.log('OK:', name);
    } catch (err) {
      failed += 1;
      console.error('FAIL:', name);
      console.error(err && err.stack ? err.stack : String(err));
    }
  });
}

/**
 * @param {string} name
 * @returns {string}
 */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
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

/**
 * A watcher row with autopilot policy loose enough to start a cycle.
 *
 * @param {string} cwd
 * @param {string} dataDir
 * @param {object} [policy]
 * @returns {object}
 */
function setAutopilot(cwd, dataDir, policy = {}) {
  return upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 50,
      maxParallel: 1,
      maxConsecutiveFailures: 3,
      ...policy,
    },
  }, { dataDir });
}

/**
 * The mock adapter is registered for the raw harness id and for the built-in
 * transport a `mock` harness id normalizes to.
 */
function startMockAdapters() {
  resetMockChatRuns();
  registerMockChatRunAdapter('mock');
  registerMockChatRunAdapter('sdk');
}

/**
 * Real chat-run transport, deterministic orchestrator pick.
 *
 * @returns {object}
 */
function orchestratorDeps(extra = {}) {
  return {
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'e2e' }),
    addChat: (session, title, wf, folder, model, extras) => addChat(session, title, wf, folder, model, {
      ...(extras || {}),
      localHarnessTransport: true,
    }),
    ...extra,
  };
}

/**
 * Run one autopilot pass for a single-workspace data dir.
 *
 * @param {string} dataDir
 * @param {number} now
 * @param {string} token
 * @returns {Promise<object>}
 */
function autopilot(dataDir, now, token) {
  return runWorkspaceWatcherAutopilot({ dataDir, now, token, deps: orchestratorDeps() });
}

/**
 * Simulate the cycle orchestrator finishing: mark the todo (optional), report
 * the outcome and let the mock run leave the busy state.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {object} cycle
 * @param {{ done?: boolean, outcome?: string, now?: number }} [options]
 * @returns {object}
 */
function finishCycle(dataDir, cwd, cycle, options = {}) {
  const todoId = String(cycle.todoIds[0] || '');
  if (options.done !== false) {
    const current = getTodoById(dataDir, cwd, todoId);
    updateTodo(dataDir, cwd, todoId, { status: 'done', expectedUpdatedAt: current.updatedAt });
  }
  const report = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: options.now,
    sourceChatId: cycle.chatId,
    outcome: options.outcome || 'success',
    cycleId: cycle.cycleId,
    todoIds: cycle.todoIds,
  });
  // A real orchestrator chat ends after it reports; free the mock slot so the
  // snapshot no longer counts it as occupancy.
  patchMockChatRun(cycle.chatId, { busy: false });
  return report;
}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error('timed out waiting for condition')); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

runCase('E2E: three ready todos run sequentially through the mock adapter', async () => {
  startMockAdapters();
  const dataDir = freshDataDir('e2e-sequential');
  const cwd = makeWorkspace('e2e-sequential');
  const todos = ['one', 'two', 'three'].map((title) => addReadyTodo(dataDir, cwd, title));
  setAutopilot(cwd, dataDir, { maxParallel: 1, maxConsecutiveFailures: 3 });

  /** @type {string[]} */
  const picked = [];
  let now = T0;
  for (let i = 0; i < 3; i += 1) {
    const pass = await autopilot(dataDir, now, 'e2e-seq');
    assert.equal(pass.started, 1, `pass ${i} must start exactly one cycle (${pass.errors?.[0]?.message || ''})`);
    assert.equal(pass.cycles.length, 1);
    const cycle = pass.cycles[0];
    assert.equal(cycle.todoIds.length, 1);
    picked.push(String(cycle.todoIds[0]));

    // While the cycle is active a second pass must not start a duplicate.
    const during = await autopilot(dataDir, now + 500, 'e2e-seq');
    assert.equal(during.started, 0, 'an active cycle is never duplicated');
    assert.equal(getMockChatRunStartCount(), i + 1, 'no extra chat run started');
    const run = getMockChatRun(cycle.chatId);
    assert.ok(run, 'the mock adapter owns the orchestrator run');
    assert.match(run.prompt, /delegation_start/);

    const report = finishCycle(dataDir, cwd, cycle, { now: now + 1000 });
    assert.equal(report.closed, true, `cycle ${i} must close: ${report.reason}`);
    now += 120_000;
  }

  const after = await autopilot(dataDir, now, 'e2e-seq');
  assert.equal(after.started, 0, 'no ready work is left');
  for (const todo of todos) {
    assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'done', `${todo.title} is done`);
  }
  assert.equal(new Set(picked).size, 3, 'each todo was picked exactly once');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).cycleCount, 3);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, null);
});

runCase('E2E: a failed cycle blocks only its todo and fresh work continues', async () => {
  startMockAdapters();
  const dataDir = freshDataDir('e2e-failure');
  const cwd = makeWorkspace('e2e-failure');
  const todos = ['one', 'two', 'three'].map((title) => addReadyTodo(dataDir, cwd, title));
  setAutopilot(cwd, dataDir, { maxParallel: 1, maxConsecutiveFailures: 1 });

  let now = T0;
  const first = await autopilot(dataDir, now, 'e2e-fail');
  assert.equal(first.started, 1);
  const failedId = String(first.cycles[0].todoIds[0]);
  const failedReport = finishCycle(dataDir, cwd, first.cycles[0], {
    done: false,
    outcome: 'failure',
    now: now + 1000,
  });
  assert.equal(failedReport.closed, true, failedReport.reason);

  const blocked = getTodoById(dataDir, cwd, failedId);
  assert.equal(blocked.status, 'ready', 'a blocked todo stays ready, not done');
  assert.match(String(blocked.blockedReason || ''), /failure ceiling/i);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).failures[failedId], 1);

  // Outlast the per-watcher failure backoff window, then the fresh leaves run.
  now += 300_000;
  for (let i = 0; i < 2; i += 1) {
    const pass = await autopilot(dataDir, now, 'e2e-fail');
    assert.equal(pass.started, 1, `fresh cycle ${i} must start`);
    const cycle = pass.cycles[0];
    assert.notEqual(String(cycle.todoIds[0]), failedId, 'the blocked todo is not re-picked');
    const report = finishCycle(dataDir, cwd, cycle, { now: now + 1000 });
    assert.equal(report.closed, true, report.reason);
    now += 300_000;
  }

  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycleCount, 3);
  assert.equal(row.activeCycle, null);
  assert.equal(row.failures[failedId], 1, 'only the failed todo keeps a failure');
  const blockedTodos = todos.filter((todo) => {
    const item = getTodoById(dataDir, cwd, todo.id);
    return item.status !== 'done' && String(item.blockedReason || '').trim();
  });
  assert.equal(blockedTodos.length, 1, 'exactly one todo is blocked');
  assert.equal(blockedTodos[0].id, failedId);
  const doneTodos = todos.filter((todo) => getTodoById(dataDir, cwd, todo.id).status === 'done');
  assert.equal(doneTodos.length, 2, 'the two fresh todos completed');
});

runCase('E2E: restart mid-cycle reconciles once without a duplicate cycle or claim', async () => {
  startMockAdapters();
  const dataDir = freshDataDir('e2e-restart');
  const cwd = makeWorkspace('e2e-restart');
  const todo = addReadyTodo(dataDir, cwd, 'restart work');
  setAutopilot(cwd, dataDir, { maxParallel: 1, maxConsecutiveFailures: 3 });

  const pass = await autopilot(dataDir, T0, 'e2e-restart');
  assert.equal(pass.started, 1);
  const cycle = pass.cycles[0];

  // Crash: the in-memory adapter state is gone, the durable stores survive.
  resetMockChatRuns();

  // Boot reconcile probes the orchestrator chat and finds it confirmed idle.
  const idleProbe = () => ({ known: true, busy: false, reason: 'idle' });
  const first = reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0 + 1000,
    probeChatRunLiveness: idleProbe,
  });
  assert.equal(first.reconciled, 1, `one cycle reconciled: ${JSON.stringify(first.errors)}`);

  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null, 'the interrupted cycle is closed');
  assert.equal(row.cycleCount, 1, 'the interrupted cycle is accounted exactly once');
  assert.deepEqual(row.lease, { ownerPid: 0, token: '', expiresAt: '' }, 'the lease is released');

  const reopened = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reopened.status, 'ready', 'the claim is released back to ready');
  assert.equal(String(reopened.claimedByChatId || ''), '');

  // A second reconcile must be a no-op: no duplicate cycle, no second failure.
  const second = reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0 + 2000,
    probeChatRunLiveness: idleProbe,
  });
  assert.equal(second.reconciled, 0, 'reconcile is idempotent');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).cycleCount, 1);

  // The autopilot resumes with exactly one new cycle, not a duplicate.
  const deps = orchestratorDeps({ probeChatRunLiveness: idleProbe });
  const resumed = await runWorkspaceWatcherAutopilot({
    dataDir,
    now: T0 + 300_000,
    token: 'e2e-restart',
    deps,
  });
  assert.equal(resumed.started, 1, 'exactly one new cycle after reconcile');
  assert.equal(resumed.cycles.length, 1);
  assert.equal(getMockChatRunStartCount(), 1, 'exactly one new orchestrator run');
  const resumedRow = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(resumedRow.cycleCount, 1, 'cycleCount only moves on close');
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing', 'the new cycle holds the claim');
});

runCase('E2E: two processes cannot drive one workspace (singleton lease)', async () => {
  startMockAdapters();
  const dataDir = freshDataDir('e2e-lease');
  const cwd = makeWorkspace('e2e-lease');
  addReadyTodo(dataDir, cwd, 'lease work');
  setAutopilot(cwd, dataDir, { maxParallel: 1 });

  const helper = fileURLToPath(new URL('./helpers/workspace-watcher-lease-child.js', import.meta.url));
  const child = spawn(process.execPath, [helper, dataDir, cwd, '15000', 'child-holder', '8000'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { err += String(chunk); });
  try {
    await waitFor(() => out.includes('LEASED') || child.exitCode != null);
    assert.ok(out.includes('LEASED'), `child must take the lease: ${err || out}`);

    const blocked = await autopilot(dataDir, Date.now(), 'e2e-parent');
    assert.equal(blocked.started, 0, 'a foreign live lease blocks a second watcher');
    assert.equal(getMockChatRunStartCount(), 0, 'the blocked process starts no agent');
    assert.equal(getWorkspaceWatcher(cwd, { dataDir }).lease.token, 'child-holder');
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await new Promise((resolve) => { child.on('close', resolve); });
  }

  const after = await autopilot(dataDir, Date.now() + 9000, 'e2e-parent');
  assert.equal(after.started, 1, 'exactly one watcher starts once the lease expires');
  assert.equal(after.cycles.length, 1);
});

runCase('regression: off and observe never start an agent', async () => {
  startMockAdapters();
  const dataDir = freshDataDir('e2e-inert');
  const offCwd = makeWorkspace('e2e-off');
  addReadyTodo(dataDir, offCwd, 'off work');
  upsertWorkspaceWatcher(offCwd, { mode: 'off' }, { dataDir });

  const observeCwd = makeWorkspace('e2e-observe');
  const observeTodo = addReadyTodo(dataDir, observeCwd, 'observe work');
  upsertWorkspaceWatcher(observeCwd, { mode: 'observe' }, { dataDir });

  const pass = await autopilot(dataDir, T0, 'e2e-inert');
  assert.equal(pass.scanned, 0, 'only autopilot rows are scanned');
  assert.equal(pass.started, 0);
  assert.equal(getMockChatRunStartCount(), 0, 'no chat run started');

  const beat = runWorkspaceWatcherHeartbeat({ dataDir, now: T0, token: 'e2e-inert' });
  assert.ok(beat.decisions.some((row) => row.kind === 'observe_ready'), 'observe logs the ready work');
  assert.equal(getMockChatRunStartCount(), 0, 'observe never starts an agent');
  const observed = getTodoById(dataDir, observeCwd, observeTodo.id);
  assert.equal(observed.status, 'ready');
  assert.equal(String(observed.claimedByChatId || ''), '', 'observe never claims');

  const offTick = tickWorkspaceWatcher({ workspaceFolder: offCwd, dataDir, now: T0, token: 'e2e-inert' });
  assert.equal(offTick.wrote, false, 'an off tick performs no write');
});

runCase('E2E: closed chats whose room is gone do not block an autopilot cycle', async () => {
  startMockAdapters();
  const dataDir = freshDataDir('e2e-cold-chats');
  const cwd = makeWorkspace('e2e-cold-chats');
  setAutopilot(cwd, dataDir);
  const todo = addReadyTodo(dataDir, cwd, 'only ready work');
  // Historical/archived chats whose in-memory room is gone after a restart: the
  // adapter reports `state_missing`. With no todo claim or delegation slot to
  // trace them, they must read as idle so the single ready todo still starts.
  const coldIds = new Set(['e2e-cold-a', 'e2e-cold-b', 'e2e-cold-c']);
  for (const id of coldIds) {
    addChat(`cold-session-${id}`, `cold chat ${id}`, cwd, cwd, 'mock', { id });
  }
  const deps = orchestratorDeps({
    probeChatRunLiveness: (input) => (coldIds.has(String(input.chatId || ''))
      ? { known: false, busy: false, reason: 'state_missing' }
      : probeChatRunLiveness(input)),
  });
  const pass = await runWorkspaceWatcherAutopilot({ dataDir, now: T0, token: 'e2e-cold', deps });
  assert.equal((pass.errors || []).length, 0, `no cycle errors: ${JSON.stringify(pass.errors || [])}`);
  assert.equal(pass.started, 1, 'a cold workspace chat never blocks ready work');
  assert.equal(pass.cycles.length, 1);
  assert.equal(getMockChatRunStartCount(), 1, 'exactly one agent started');
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing', 'the cycle claims the todo');
});

runCase('E2E: a vanished orchestrator room closes after grace and the next todo starts', async () => {
  startMockAdapters();
  const dataDir = freshDataDir('e2e-room-gone');
  const cwd = makeWorkspace('e2e-room-gone');
  setAutopilot(cwd, dataDir);
  const first = addReadyTodo(dataDir, cwd, 'first');
  const second = addReadyTodo(dataDir, cwd, 'second');
  const started = await runWorkspaceWatcherAutopilot({
    dataDir,
    now: T0,
    token: 'e2e-gone',
    deps: orchestratorDeps(),
  });
  assert.equal(started.started, 1, `cycle must start: ${JSON.stringify(started.errors || [])}`);
  const cycle = started.cycles[0];
  const claimedId = String(cycle.todoIds[0] || '');
  const pendingId = [first.id, second.id].find((id) => id !== claimedId);
  const current = getTodoById(dataDir, cwd, claimedId);
  updateTodo(dataDir, cwd, claimedId, { status: 'done', expectedUpdatedAt: current.updatedAt });
  const deps = orchestratorDeps({
    probeChatRunLiveness: (input) => (
      String(input.chatId || '') === cycle.chatId
        ? { known: false, busy: false, reason: 'state_missing' }
        : probeChatRunLiveness(input)
    ),
  });
  const decisionsBefore = getWorkspaceWatcher(cwd, { dataDir }).decisions.length;
  const early = await runWorkspaceWatcherAutopilot({ dataDir, now: T0 + 30_000, token: 'e2e-gone', deps });
  assert.equal(early.closed, 0, 'the vanished room stays inside the grace window');
  assert.equal(early.started, 0, 'a full slot does not start another cycle');
  const added = getWorkspaceWatcher(cwd, { dataDir }).decisions.slice(decisionsBefore);
  assert.ok(added.length > 0, 'the full slot is recorded');
  assert.ok(added.every((entry) => entry.kind !== 'start_cycle'), 'a full slot is not logged as start_cycle');
  assert.equal(added.at(-1).reason, 'cycle_active');
  const later = await runWorkspaceWatcherAutopilot({
    dataDir,
    now: T0 + 30_000 + (2 * 60 * 1000),
    token: 'e2e-gone',
    deps,
  });
  assert.equal(later.closed, 1, 'grace expiry closes the vanished cycle');
  assert.equal(later.started, 1, 'the next ready todo starts once the slot is free');
  assert.equal(getTodoById(dataDir, cwd, pendingId).status, 'doing');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).failures[claimedId], undefined);
});

runCase('E2E: an orphaned doing leaf is recovered and started exactly once', async () => {
  startMockAdapters();
  const dataDir = freshDataDir('e2e-orphan');
  const cwd = makeWorkspace('e2e-orphan');
  setAutopilot(cwd, dataDir);
  // `orphan` was started by a chat that no longer exists (confirmed gone);
  // `legacy` is a manual `doing` row with no execution identity at all.
  const orphan = addReadyTodo(dataDir, cwd, 'orphaned leaf', { orchestratorChatId: 'e2e-deleted-executor' });
  updateTodo(dataDir, cwd, orphan.id, { status: 'doing' });
  const legacy = addReadyTodo(dataDir, cwd, 'legacy manual doing');
  updateTodo(dataDir, cwd, legacy.id, { status: 'doing' });
  const deps = orchestratorDeps();
  const recovered = await runWorkspaceWatcherAutopilot({ dataDir, now: T0, token: 'e2e-orphan', deps });
  assert.equal((recovered.errors || []).length, 0, `no errors: ${JSON.stringify(recovered.errors || [])}`);
  const released = getTodoById(dataDir, cwd, orphan.id);
  assert.equal(released.status, 'ready', 'the confirmed-gone executor frees the leaf in the first pass');
  assert.equal(String(released.claimedByChatId || ''), '');
  assert.equal(getTodoById(dataDir, cwd, legacy.id).status, 'doing', 'a row without identity is never taken over');
  const started = await runWorkspaceWatcherAutopilot({ dataDir, now: T0 + 120_000, token: 'e2e-orphan', deps });
  assert.equal(started.started, 1, `the recovered leaf starts through the normal cycle: ${JSON.stringify(started.errors || [])}`);
  const cycle = started.cycles[0];
  assert.deepEqual(cycle.todoIds, [orphan.id]);
  const claimed = getTodoById(dataDir, cwd, orphan.id);
  assert.equal(claimed.status, 'doing');
  assert.equal(claimed.claimedByChatId, cycle.chatId);
  assert.equal(claimed.execution.cycleId, cycle.cycleId, 'the attempt is keyed by the cycle that started it');
  assert.equal(claimed.execution.key, `${orphan.id}:${cycle.cycleId}`);
  assert.equal(getMockChatRunStartCount(), 1);
  const again = await runWorkspaceWatcherAutopilot({ dataDir, now: T0 + 121_000, token: 'e2e-orphan', deps });
  assert.equal(again.started, 0, 'a live attempt is never duplicated');
  assert.equal(getMockChatRunStartCount(), 1, 'exactly one run for one recovery key');
  assert.equal(getTodoById(dataDir, cwd, orphan.id).execution.attemptId, claimed.execution.attemptId);
  assert.equal(getTodoById(dataDir, cwd, legacy.id).status, 'doing');
  assert.notEqual(getTodoById(dataDir, cwd, orphan.id).status, 'done', 'recovery never completes a todo');
});

for (const run of cases) {
  // eslint-disable-next-line no-await-in-loop -- cases share the isolated chat store
  await run();
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
removeIsolatedDataDir();
if (failed > 0) {
  console.error(`\n${failed} workspace watcher E2E test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace watcher E2E tests passed');
