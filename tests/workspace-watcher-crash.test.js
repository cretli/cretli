/**
 * Workspace Watcher SIGKILL scenarios (leaf R19b of R19, acceptance from R11).
 *
 * A real child process starts REAL watcher cycles (`startWorkspaceWatcherCycle`)
 * against a fixture data dir with a mock orchestrator/start adapter, freezes and
 * is killed with SIGKILL. A second child plays the restarted server: a new OS
 * process, hence a NEW `getProcessInstance().instanceId`, running the real boot
 * reconcile (`reconcileWorkspaceWatchersOnBoot`) with the real liveness probe
 * (the chat is not in any adapter registry, so the room is proven absent).
 * The parent then inspects the durable watcher row and todos.
 *
 * No real model is used. Findings (current behaviour pinned here):
 * - W2 while a cycle is held by live children, the dead process's lease is
 *   still owned, so a new start for the freed slot answers `lease_held` until
 *   the lease TTL or the held cycle closes.
 * - W3 a `startChatRun` rejection classified as `rollback` (e.g. recipient_busy)
 *   still counts a failure, arms backoff and keeps the cycle budget, unlike the
 *   other rollback paths that pass `countFailure:false, rollbackReserve:true`
 *   (lib/workspace-watcher-cycle.js, catch branch of `startWorkspaceWatcherCycle`).
 * - W4 two instances running the boot reconcile concurrently can hit a SQLite
 *   lock ("database is locked"); the per-row pass retries it a bounded number
 *   of times, and each slot is still closed exactly once (lib/workspace-watcher.js
 *   `reconcileWorkspaceWatchersOnBoot` catch around the per-row pass).
 * - W1 a dead-instance cycle with a still-active child delegation is held
 *   (`cycle_children_active`) until the children are terminal; the shared rule
 *   does not override the children gate (lib/workspace-watcher-cycle.js
 *   `reconcileWorkspaceWatcherCycleSlot`).
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getTodoById } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import {
  createCrashDataDir,
  spawnRecoveryBarrier,
  spawnRecoveryCrashChild,
  supportsSigkill,
} from './helpers/recovery-crash-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD_URL = pathToFileURL(path.join(HERE, 'helpers', 'workspace-watcher-crash-child.js')).href;
const SKIP = supportsSigkill() ? false : 'SIGKILL is not supported on this platform';
const TEST_TIMEOUT_MS = 30_000;
const SCRIPT = `await import(${JSON.stringify(CHILD_URL)});`;

function childEnv(dataDir, extra) {
  return {
    CRETLI_DATA_DIR: dataDir,
    CURSOR_REMOTE_DATA_DIR: dataDir,
    CRETLI_TEST_DATA_DIR: dataDir,
    CURSOR_REMOTE_TEST_DATA_DIR: dataDir,
    ...extra,
  };
}

function spawnStage(dataDir, stage, extra = {}) {
  return spawnRecoveryCrashChild({
    script: SCRIPT,
    dataDir,
    timeoutMs: 20_000,
    env: childEnv(dataDir, { CW_STAGE: stage, ...extra }),
  });
}

function readResult(child) {
  const line = child.stdout().split('\n').find((row) => row.startsWith('RESULT '));
  return line ? JSON.parse(line.slice('RESULT '.length)) : null;
}

/** Run the fixture server until its kill point, then SIGKILL it. */
async function killServer(dataDir, scenario) {
  const child = await spawnStage(dataDir, 'server', { CW_SCENARIO: scenario });
  try {
    const exit = await child.kill();
    assert.equal(exit.signal, 'SIGKILL', `server was killed with SIGKILL in ${scenario}`);
  } finally {
    await child.dispose();
  }
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture.json'), 'utf8'));
}

/** Restart: a new process with a new instance token runs the boot reconcile. */
async function restart(dataDir, extra = {}) {
  const child = await spawnStage(dataDir, 'boot', extra);
  try {
    await child.waitForExit(20_000);
    const result = readResult(child);
    assert.ok(result, `boot child reported a result\n${child.stderr()}`);
    return result;
  } finally {
    await child.dispose();
  }
}

function rowOf(dataDir, ws) {
  return getWorkspaceWatcher(ws.cwd, { dataDir });
}

function todoOf(dataDir, ws, index) {
  return getTodoById(dataDir, ws.cwd, ws.todos[index].id);
}

async function withScenario(body) {
  const dataDir = createCrashDataDir();
  try {
    await body(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('3 cycles in flight, SIGKILL, restart: 0 failures, 0 backoff, interrupted_restart, new cycles start in one turn', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir) => {
    const fixture = await killServer(dataDir, 'three');
    const [ws] = fixture.workspaces;
    assert.deepEqual(fixture.starts.map((entry) => entry.started), [true, true, true]);
    const before = rowOf(dataDir, ws);
    assert.equal(before.activeCycles.length, 3, 'three slots were open at kill time');
    const killedInstance = before.activeCycles[0].instanceId;
    assert.ok(killedInstance, 'slots carry the instance token of the killed process');

    const after = await restart(dataDir, { CW_THEN_START: '1' });
    assert.notEqual(after.instanceId, killedInstance, 'the restart is a new instance');
    assert.equal(after.errors, 0);
    const row = rowOf(dataDir, ws);
    assert.deepEqual(row.failures, {});
    assert.ok(!row.backoffUntil, 'no backoff armed');
    const closed = row.cycleChats.filter((entry) => entry.outcome === 'interrupted_restart');
    assert.equal(closed.length, 3, 'all three orphan slots closed as interrupted_restart');
    assert.ok(row.decisions.every((decision) => decision.kind !== 'cycle_failed'));
    assert.deepEqual(after.starts.map((entry) => entry.started), [true, true, true],
      'new cycles start within the same reconcile turn (no wait_active on dead slots)');
    assert.equal(row.activeCycles.length, 3, 'the new cycles hold the three slots');
    assert.ok(row.activeCycles.every((cycle) => cycle.instanceId === after.instanceId));
    const claims = ws.todos.map((_, index) => todoOf(dataDir, ws, index).claimedByChatId);
    assert.equal(new Set(claims).size, 3, 'each todo is claimed by exactly one new chat');
  }));

test('restart keeps pre-existing non-zero failures and backoff exactly', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir) => {
    const fixture = await killServer(dataDir, 'preset');
    const [ws] = fixture.workspaces;
    const before = rowOf(dataDir, ws);
    assert.deepEqual(before.failures, { [ws.todos[0].id]: 2 });
    assert.ok(before.backoffUntil);

    await restart(dataDir);
    const row = rowOf(dataDir, ws);
    assert.deepEqual(row.failures, before.failures, 'failures neither incremented nor cleared');
    assert.equal(row.backoffUntil, before.backoffUntil, 'backoff neither extended nor cleared');
    assert.equal(row.cycleChats.filter((entry) => entry.outcome === 'interrupted_restart').length, 3);
    assert.equal(row.activeCycles.length, 0);
  }));

test('starting, planOnly and child-delegation cycles close per the shared rule without double-claiming', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir) => {
    const fixture = await killServer(dataDir, 'mixed');
    const [wsPlan, wsImpl] = fixture.workspaces;
    const implBefore = rowOf(dataDir, wsImpl);
    assert.deepEqual(implBefore.activeCycles.map((cycle) => cycle.phase).sort(), ['running', 'starting']);
    const startingCycle = implBefore.activeCycles.find((cycle) => cycle.phase === 'starting');
    assert.ok(startingCycle.startDeadlineAt, 'the starting slot is inside its start deadline');
    assert.equal(rowOf(dataDir, wsPlan).activeCycles[0].planOnly, true);

    // Delegation boot has not settled the child yet: the running cycle with a
    // live child is held (W1); the starting and planOnly cycles close neutrally.
    const first = await restart(dataDir, { CW_THEN_START: '1' });
    assert.equal(first.errors, 0);
    const plan = rowOf(dataDir, wsPlan);
    const planBefore = fixture.starts[0];
    assert.equal(plan.cycleChats.find((entry) => entry.cycleId === planBefore.cycleId).outcome, 'interrupted_restart');
    assert.ok(plan.activeCycles.every((cycle) => cycle.cycleId !== planBefore.cycleId), 'the orphan plan slot is closed');
    assert.ok(plan.activeCycles.length <= 1, 'the plan todo is claimed at most once');
    assert.deepEqual(plan.failures, {});
    assert.ok(!todoOf(dataDir, wsPlan, 0).plan?.approvedAt, 'the watcher never approves a plan');

    const impl = rowOf(dataDir, wsImpl);
    assert.deepEqual(impl.failures, {});
    assert.ok(!impl.backoffUntil);
    const heldTodo = todoOf(dataDir, wsImpl, 0);
    const startingTodo = todoOf(dataDir, wsImpl, 1);
    const heldCycle = impl.activeCycles.find((cycle) => cycle.todoIds[0] === wsImpl.todos[0].id);
    assert.ok(heldCycle, 'W1: the cycle with a live child delegation is held');
    assert.equal(heldCycle.instanceId, implBefore.activeCycles.find((cycle) => cycle.phase === 'running').instanceId,
      'the held slot was not re-claimed by the new instance');
    assert.equal(heldTodo.status, 'doing');
    assert.equal(heldTodo.claimedByChatId, heldCycle.chatId, 'claim untouched while children run');
    assert.equal(impl.cycleChats.filter((entry) => entry.outcome === 'interrupted_restart').length, 1,
      'the starting cycle closed neutrally');
    const restarted = impl.activeCycles.filter((cycle) => cycle.todoIds[0] === wsImpl.todos[1].id);
    assert.equal(restarted.length, 0, 'W2: the freed slot cannot start while the dead lease is held');
    assert.ok(first.starts.some((entry) => entry.reason === 'lease_held'), JSON.stringify(first.starts));
    assert.equal(startingTodo.status, 'ready', 'the starting todo is claimable again and claimed by nobody');
    assert.ok(!startingTodo.claimedByChatId);
    assert.equal(first.starts.filter((entry) => entry.started && entry.chatId !== wsPlan.todos[0].id).length,
      first.starts.filter((entry) => entry.started).length);
    assert.equal(
      first.starts.some((entry) => entry.started && entry.chatId === heldCycle.chatId),
      false,
      'no second cycle was started for the held todo'
    );

    // Once the children are terminal (what delegation boot reconcile records),
    // the held cycle also closes as interrupted_restart.
    const second = await restart(dataDir, { CW_CHILDREN: 'done' });
    assert.equal(second.errors, 0);
    const settled = rowOf(dataDir, wsImpl);
    assert.deepEqual(settled.failures, {});
    assert.ok(!settled.backoffUntil);
    const outcomes = settled.cycleChats.map((entry) => entry.outcome);
    assert.ok(outcomes.filter((outcome) => outcome === 'interrupted_restart').length >= 2, `outcomes: ${outcomes}`);
  }));

test('a genuine no-progress cycle in the live process is still failure plus backoff', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir) => {
    const child = await spawnStage(dataDir, 'live');
    try {
      await child.waitForExit(20_000);
      assert.deepEqual(readResult(child), { closed: true, reason: 'cycle_closed' });
    } finally {
      await child.dispose();
    }
    const fixture = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture.json'), 'utf8'));
    const [ws] = fixture.workspaces;
    const row = rowOf(dataDir, ws);
    assert.equal(row.failures[ws.todos[0].id], 1);
    assert.ok(row.backoffUntil, 'backoff armed');
    assert.equal(row.cycleChats[0].outcome, 'failure');
    assert.notEqual(row.cycleChats[0].outcome, 'interrupted_restart');
  }));

for (const [scenario, expectedReason] of [['launch_orch', 'orchestrator_unavailable'], ['launch_run', 'start_failed']]) {
  test(`launch error (${scenario}) rolls back the claim, leaves no slot, and survives a restart`, { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
    withScenario(async (dataDir) => {
      const fixture = await killServer(dataDir, scenario);
      const [ws] = fixture.workspaces;
      assert.equal(fixture.starts[0].started, false);
      assert.equal(fixture.starts[0].reason, expectedReason);
      const snapshot = () => {
        const row = rowOf(dataDir, ws);
        const todo = todoOf(dataDir, ws, 0);
        return {
          activeCycles: row.activeCycles.length,
          failures: row.failures,
          backoffUntil: row.backoffUntil || '',
          cycles: row.cycles || null,
          todoStatus: todo.status,
          claimed: todo.claimedByChatId || '',
        };
      };
      const beforeRestart = snapshot();
      assert.equal(beforeRestart.activeCycles, 0, 'no slot is left behind');
      assert.equal(beforeRestart.todoStatus, 'ready', 'the claim was rolled back');
      assert.equal(beforeRestart.claimed, '');
      if (scenario === 'launch_orch') {
        assert.deepEqual(beforeRestart.failures, {}, 'a rollback is not a failure');
        assert.equal(beforeRestart.cycles?.count || 0, fixture.before.cycles?.count || 0, 'the cycle budget was rolled back');
      } else {
        // A transient refusal (recipient_busy) is rolled back like a launch error:
        // no failure, no backoff, budget refunded.
        assert.deepEqual(beforeRestart.failures, {}, 'a transient refusal is not a failure');
        assert.ok(!beforeRestart.backoffUntil, 'no backoff is armed');
        assert.equal(beforeRestart.cycles?.count || 0, fixture.before.cycles?.count || 0, 'the cycle budget was rolled back');
      }
      await restart(dataDir);
      assert.deepEqual(snapshot(), beforeRestart, 'restart neither re-opens nor re-counts the rolled-back start');
    }));
}

test('hot-loop guard: the Nth consecutive transient refusal counts as a failure', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir) => {
    const fixture = await killServer(dataDir, 'launch_hot');
    const [ws] = fixture.workspaces;
    const id = ws.todos[0].id;
    const attempts = fixture.hot;
    assert.ok(attempts.length >= 2);
    for (const attempt of attempts.slice(0, -1)) {
      assert.deepEqual(attempt.failures, {}, 'early transient refusals are not failures');
      assert.equal(attempt.backoffUntil, '');
      assert.equal(attempt.count, fixture.before.cycles?.count || 0, 'budget refunded');
    }
    const last = attempts[attempts.length - 1];
    assert.deepEqual(last.failures, {}, 'the tripped guard is an infra failure: no todo failure');
    assert.equal(last.backoffUntil, '');
    assert.ok(last.infraBackoffUntil, 'infra backoff armed once the guard trips');
    void id;
    assert.equal(rowOf(dataDir, ws).activeCycles.length, 0);
    assert.equal(todoOf(dataDir, ws, 0).status, 'ready');
  }));

test('a hard start error is an infra failure: infra backoff, no todo failure, budget kept', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir) => {
    const fixture = await killServer(dataDir, 'launch_hard');
    const [ws] = fixture.workspaces;
    const row = rowOf(dataDir, ws);
    assert.deepEqual(row.failures, {});
    assert.ok(row.infraBackoffUntil, 'infra backoff armed');
    assert.equal(row.cycleChats.at(-1).closeReason, 'start_failed');
    assert.equal(row.cycles.count, 1, 'the budget is kept');
    assert.equal(todoOf(dataDir, ws, 0).status, 'ready', 'the claim was rolled back');
  }));

test('two instances reconciling the same store close each slot exactly once', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir) => {
    const fixture = await killServer(dataDir, 'three');
    const [ws] = fixture.workspaces;
    const barrier = await spawnRecoveryBarrier({
      script: SCRIPT,
      dataDir,
      count: 2,
      timeoutMs: 20_000,
      env: childEnv(dataDir, { CW_STAGE: 'race_boot' }),
    });
    try {
      barrier.release();
      await barrier.waitForExit(20_000);
      const results = barrier.handles.map(readResult);
      // W4: the per-row reconcile retries SQLITE_BUSY, so no instance may report
      // a locked error; the exactly-once invariants below must hold.
      const errorDetails = results.flatMap((entry) => entry.errorDetails);
      assert.ok(results.every((entry) => entry), JSON.stringify(results));
      assert.deepEqual(errorDetails, [], JSON.stringify(errorDetails));
      assert.ok(results.every((entry) => entry.errors === 0), JSON.stringify(results));
      assert.ok(results.reduce((sum, entry) => sum + entry.reconciled, 0) >= 1, 'at least one instance reconciled');
      const row = rowOf(dataDir, ws);
      assert.equal(row.activeCycles.length, 0);
      assert.equal(row.cycleChats.length, 3, 'each slot produced exactly one close record');
      assert.equal(new Set(row.cycleChats.map((entry) => entry.cycleId)).size, 3);
      assert.ok(row.cycleChats.every((entry) => entry.outcome === 'interrupted_restart'));
      assert.deepEqual(row.failures, {});
    } finally {
      await barrier.dispose();
    }
  }));

test('two instances racing to start a cycle for the same todo produce exactly one claimer', { skip: SKIP, timeout: TEST_TIMEOUT_MS }, () =>
  withScenario(async (dataDir) => {
    const seed = await spawnStage(dataDir, 'seed_ready');
    await seed.waitForExit(20_000);
    await seed.dispose();
    const [ws] = JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture.json'), 'utf8')).workspaces;
    const barrier = await spawnRecoveryBarrier({
      script: SCRIPT,
      dataDir,
      count: 2,
      timeoutMs: 20_000,
      env: childEnv(dataDir, { CW_STAGE: 'race_start' }),
    });
    try {
      barrier.release();
      await barrier.waitForExit(20_000);
      const results = barrier.handles.map(readResult);
      assert.equal(results.filter((entry) => entry.started).length, 1, JSON.stringify(results));
      const winner = results.find((entry) => entry.started);
      const row = rowOf(dataDir, ws);
      assert.equal(row.activeCycles.length, 1);
      assert.equal(row.activeCycles[0].chatId, winner.chatId);
      assert.equal(todoOf(dataDir, ws, 0).claimedByChatId, winner.chatId);
      assert.equal(row.cycles.count, 1, 'the loser did not consume budget');
    } finally {
      await barrier.dispose();
    }
  }));
