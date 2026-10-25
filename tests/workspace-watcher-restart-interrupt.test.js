/**
 * Workspace Watcher restart interruption (leaf R11 A-C, planOnly, cleanup).
 *
 * A cycle interrupted by a server restart closes as the neutral
 * `interrupted_restart`: no failure, no backoff, the todo is claimable again.
 * A cycle that really ran in the live process and made no progress is still a
 * failure with backoff. Restart evidence comes from the slot instance token only,
 * never from "any orphan".
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import {
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { reconcileWorkspaceWatchersOnBoot, tickWorkspaceWatcher } from '../lib/workspace-watcher.js';
import { reconcileWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';
import {
  isWorkspaceWatcherCycleRestartInterrupted,
  resolveWorkspaceWatcherCycleRestartEvidence,
} from '../lib/workspace-watcher-restart-evidence.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-restart-'));
const T0 = Date.parse('2026-10-07T08:20:00.000Z');
const OLD = 'instance-old';
const NEW = 'instance-new';
const goneProbe = () => ({ known: false, busy: false, reason: 'state_missing' });
const idleProbe = () => ({ known: true, busy: false, reason: 'idle' });
const unknownProbe = () => ({ known: false, busy: false, reason: 'adapter_error' });

let failed = 0;
const cases = [];
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

function setup(name, { count = 1, planOnly = false, instanceId = OLD, failures = {} } = {}) {
  const dataDir = path.join(tmpRoot, `data-${name}`);
  const cwd = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { maxParallel: 3, cooldownMs: 0, maxCyclesPerDay: 50, requirePlanApproval: false },
  }, { dataDir });
  const todos = [];
  const cycles = [];
  for (let i = 0; i < count; i += 1) {
    const todo = addTodo(dataDir, cwd, { title: `t${i}`, status: 'ready' }).item;
    const chatId = `chat-${name}-${i}`;
    updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: chatId, claimedAt: new Date(T0).toISOString(), claimLeaseUntil: new Date(T0 + 600_000).toISOString() });
    todos.push(todo);
    cycles.push({
      cycleId: `cycle-${name}-${i}`, todoIds: [todo.id], startedAt: new Date(T0 - 60_000).toISOString(),
      chatId, runId: `run-${i}`, phase: 'running', planOnly, instanceId,
    });
  }
  mutateWorkspaceWatcherRow(cwd, () => ({ activeCycles: cycles, failures }), { dataDir });
  return { dataDir, cwd, todos, cycles };
}

const bootOpts = (dataDir, extra = {}) => ({
  dataDir, now: T0, instanceId: NEW, probeChatRunLiveness: goneProbe,
  scoutArchiveDeps: {}, orchestratorArchiveDeps: {}, ...extra,
});

runCase('3 cycles in flight + restart: 0 failures, 0 backoff, slots freed, new cycles can start', () => {
  const { dataDir, cwd, todos } = setup('three', { count: 3 });
  reconcileWorkspaceWatchersOnBoot(bootOpts(dataDir));
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycles.length, 0);
  assert.deepEqual(row.failures, {});
  assert.ok(!row.backoffUntil);
  assert.deepEqual(row.cycleChats.map((c) => c.outcome), ['interrupted_restart', 'interrupted_restart', 'interrupted_restart']);
  assert.ok(row.decisions.every((d) => d.kind !== 'cycle_failed'));
  for (const todo of todos) {
    const t = getTodoById(dataDir, cwd, todo.id);
    assert.equal(t.status, 'ready');
    assert.ok(!t.claimedByChatId && !t.claimedAt && !t.claimLeaseUntil, 'claim and lease released');
  }
  const tick = tickWorkspaceWatcher({ workspaceFolder: cwd, dataDir, now: T0 + 1000, token: 'after-restart' });
  assert.notEqual(tick.decision.kind, 'wait_active');
  assert.notEqual(tick.decision.kind, 'backoff');
});

runCase('interrupted close keeps the existing failure history untouched', () => {
  const { dataDir, cwd, todos } = setup('history', { failures: {} });
  mutateWorkspaceWatcherRow(cwd, () => ({ failures: { [todos[0].id]: 1 }, backoffUntil: '' }), { dataDir });
  reconcileWorkspaceWatchersOnBoot(bootOpts(dataDir));
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todos[0].id], 1, 'neither incremented nor cleared');
  assert.ok(!row.backoffUntil);
});

runCase('live-instance cycle that ended without a report is still failure + backoff', () => {
  const { dataDir, cwd, todos } = setup('real-fail', { instanceId: NEW });
  reconcileWorkspaceWatchersOnBoot(bootOpts(dataDir, { probeChatRunLiveness: idleProbe }));
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todos[0].id], 1);
  assert.ok(row.backoffUntil, 'backoff armed');
  assert.equal(row.cycleChats[0].outcome, 'failure');
});

runCase('legacy slot without an instance token stays failure', () => {
  const { dataDir, cwd, todos } = setup('legacy', { instanceId: '' });
  reconcileWorkspaceWatchersOnBoot(bootOpts(dataDir, { probeChatRunLiveness: idleProbe }));
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todos[0].id], 1);
  assert.ok(row.backoffUntil);
});

runCase('a token-less slot is never interrupted (no instance token evidence)', () => {
  const evidence = resolveWorkspaceWatcherCycleRestartEvidence({
    cycle: { cycleId: 'c', instanceId: '' },
    currentInstanceId: NEW,
  });
  assert.equal(evidence.interrupted, false);
  const foreign = resolveWorkspaceWatcherCycleRestartEvidence({ cycle: { cycleId: 'c', instanceId: OLD }, currentInstanceId: NEW });
  assert.equal(foreign.interrupted, true);
  assert.equal(foreign.source, 'instance_token');
  const reported = resolveWorkspaceWatcherCycleRestartEvidence({
    cycle: { cycleId: 'c', instanceId: OLD, reportedOutcome: 'failure' },
    currentInstanceId: NEW,
  });
  assert.equal(reported.interrupted, false, 'a reported outcome is never reclassified');
});

runCase('dead-instance cycle whose todo is already done closes as success', () => {
  const { dataDir, cwd, todos } = setup('todo-done');
  updateTodo(dataDir, cwd, todos[0].id, { status: 'done' });
  reconcileWorkspaceWatchersOnBoot(bootOpts(dataDir));
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycles.length, 0);
  assert.ok(!row.failures[todos[0].id]);
  assert.equal(row.cycleChats[0].outcome, 'success');
  assert.notEqual(row.cycleChats[0].outcome, 'interrupted_restart');
});

runCase('dead-instance slot is freed at runtime without the room-gone grace', () => {
  const { dataDir, cwd, todos } = setup('runtime-dead', { count: 2 });
  const deps = { instanceId: NEW, probeChatRunLiveness: goneProbe, loadDelegations: () => [] };
  const result = reconcileWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, deps });
  assert.equal(result.closed, true);
  assert.equal(result.closedCount, 2);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycles.length, 0);
  assert.deepEqual(row.failures, {});
  assert.ok(!row.backoffUntil);
  assert.equal(getTodoById(dataDir, cwd, todos[0].id).status, 'ready');
});

runCase('live-instance slot with a gone room still waits for the grace', () => {
  const { dataDir, cwd } = setup('runtime-live-gone', { instanceId: NEW });
  const deps = { instanceId: NEW, probeChatRunLiveness: goneProbe, loadDelegations: () => [] };
  const result = reconcileWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, deps });
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'cycle_room_gone_grace');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycles.length, 1);
});

runCase('unknown liveness still holds the slot (live and dead instance alike)', () => {
  for (const instanceId of [NEW, OLD]) {
    const { dataDir, cwd } = setup(`unknown-${instanceId}`, { instanceId });
    const deps = { instanceId: NEW, probeChatRunLiveness: unknownProbe, loadDelegations: () => [] };
    const result = reconcileWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, deps });
    assert.equal(result.closed, false, `instance ${instanceId}`);
    assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycles.length, 1);
  }
});

runCase('starting-phase dead-instance slot is not protected by its start deadline', () => {
  const { dataDir, cwd } = setup('starting');
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycles: row.activeCycles.map((c) => ({ ...c, phase: 'starting', runId: '', startDeadlineAt: new Date(T0 + 600_000).toISOString() })),
  }), { dataDir });
  const deps = { instanceId: NEW, probeChatRunLiveness: goneProbe, loadDelegations: () => [] };
  assert.equal(reconcileWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, deps }).closed, true);
});

runCase('planOnly cycle interrupted by restart: neutral, todo ready, plan never approved, request released', () => {
  const { dataDir, cwd, todos } = setup('plan', { planOnly: true });
  mutateWorkspaceWatcherRow(cwd, () => ({ planRequests: { [todos[0].id]: new Date(T0).toISOString() } }), { dataDir });
  reconcileWorkspaceWatchersOnBoot(bootOpts(dataDir));
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(row.failures, {});
  assert.ok(!row.backoffUntil);
  assert.equal(row.cycleChats[0].outcome, 'interrupted_restart');
  assert.equal(row.planRequests[todos[0].id], undefined, 'pending plan request released');
  const todo = getTodoById(dataDir, cwd, todos[0].id);
  assert.equal(todo.status, 'ready');
  assert.ok(!todo.claimedByChatId);
  assert.ok(!todo.plan?.approvedAt, 'the watcher never approves a plan');
});

runCase('one shared restart-interrupted rule: {foreign,same,no token} x {dead,busy,unknown} probe', () => {
  const probes = {
    dead: goneProbe,
    idle: idleProbe,
    busy: () => ({ known: true, busy: true, reason: 'busy' }),
    unknown: unknownProbe,
  };
  const tokens = { foreign: OLD, same: NEW, none: '' };
  for (const [tokenName, instanceId] of Object.entries(tokens)) {
    for (const [probeName, probe] of Object.entries(probes)) {
      const cycle = { cycleId: 'c1', chatId: 'chat-1', ...(instanceId ? { instanceId } : {}) };
      const expected = tokenName === 'foreign' && (probeName === 'dead' || probeName === 'idle');
      const actual = isWorkspaceWatcherCycleRestartInterrupted({ cycle, probe, currentInstanceId: NEW });
      assert.equal(actual, expected, `${tokenName} token + ${probeName} probe`);
    }
  }
});

runCase('boot reconcile evaluates restart evidence once per slot (no second helper evaluation)', () => {
  const countingProbe = (counter) => (...args) => { counter.n += 1; return goneProbe(...args); };
  const single = { n: 0 };
  isWorkspaceWatcherCycleRestartInterrupted({
    cycle: { cycleId: 'c1', chatId: 'chat-1', instanceId: OLD },
    probe: countingProbe(single),
    currentInstanceId: NEW,
  });
  assert.ok(single.n > 0, 'the helper probes the adapters');
  const { dataDir, cwd } = setup('count');
  const reconcile = { n: 0 };
  reconcileWorkspaceWatchersOnBoot(bootOpts(dataDir, { probeChatRunLiveness: countingProbe(reconcile) }));
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).cycleChats[0].outcome, 'interrupted_restart');
  // One extra probe is the unrelated MCP run-error-code read; a second helper
  // evaluation would add `single.n` more.
  assert.ok(
    reconcile.n <= single.n + 1,
    `one slot probed ${reconcile.n} times, one helper call probes ${single.n}`,
  );
});

for (const run of cases) {
  // eslint-disable-next-line no-await-in-loop -- cases share the isolated stores
  await run();
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} restart-interrupt test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace watcher restart-interrupt tests passed');
