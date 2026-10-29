/**
 * Child-process body for the Workspace Watcher SIGKILL scenarios (leaf R19b).
 *
 * `tests/workspace-watcher-crash.test.js` spawns this module through the
 * isolated crash harness (own data dir, real SIGKILL). The child drives the REAL
 * `startWorkspaceWatcherCycle`, `reconcileWorkspaceWatchersOnBoot` and
 * `reconcileWorkspaceWatcherCycle` against a fixture data dir. Only the model
 * side is mocked: orchestrator resolution and `startChatRun`. Each process gets
 * its own `getProcessInstance().instanceId`, so a restart is a genuine new
 * instance token, not an injected one.
 *
 * Environment:
 * - `CW_STAGE`    `server` | `boot` | `live` | `race_boot` | `race_start` | `seed_ready`
 * - `CW_SCENARIO` (`server`) `three` | `preset` | `mixed` | `launch_orch` | `launch_run` | `launch_hot` | `launch_hard`
 * - `CW_CHILDREN` (`boot`) `done` marks the fixture child delegations interrupted
 *                 first (what delegation boot reconcile would have written)
 * - `CW_THEN_START` (`boot`) `1` tries to start a cycle for every ready todo
 */

import fs from 'node:fs';
import path from 'node:path';

import { addTodo, getTodoById, loadTodosData, updateTodo } from '../../lib/persist/todos-persist.js';
import {
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../../lib/persist/workspace-watchers-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../../lib/persist/delegations-persist.js';
import { reconcileWorkspaceWatchersOnBoot } from '../../lib/workspace-watcher.js';
import {
  reconcileWorkspaceWatcherCycle,
  startWorkspaceWatcherCycle,
  WORKSPACE_WATCHER_MAX_TRANSIENT_START_REFUSALS,
} from '../../lib/workspace-watcher-cycle.js';
import { getProcessInstance } from '../../lib/recovery/recovery-shutdown.ts';

const env = process.env;
const dataDir = env.RECOVERY_CRASH_DATA_DIR;
const FIXTURE = path.join(dataDir, 'fixture.json');
const SCENARIO = env.CW_SCENARIO || '';
const POLICY = { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 50, maxParallel: 3 };

// Keep the loop alive while a start promise is frozen on purpose.
setInterval(() => {}, 1000);

function ready() {
  fs.writeSync(1, 'READY\n');
}

function emit(tag, value) {
  fs.writeSync(1, `${tag} ${JSON.stringify(value)}\n`);
}

function freezeSync() {
  ready();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(cell, 0, 0, 1000);
}

function freezeAsync() {
  ready();
  return new Promise(() => {});
}

function readFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function seedWorkspace(name, count, policy = POLICY) {
  const cwd = path.join(dataDir, `ws-${name}`);
  fs.mkdirSync(cwd, { recursive: true });
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot', policy }, { dataDir });
  const todos = [];
  for (let i = 0; i < count; i += 1) {
    const item = addTodo(dataDir, cwd, { title: `${name}-${i}`, status: 'ready' }).item;
    todos.push({ id: item.id, title: item.title });
  }
  return { cwd, todos };
}

function mockDeps(overrides = {}) {
  return {
    addChat: (_session, title, _wf, _folder, _model, extras) => ({ id: extras.id, title }),
    startChatRun: async () => ({ runId: `run-${Math.random().toString(36).slice(2, 8)}`, accepted: true }),
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    ...overrides,
  };
}

async function startCycle(cwd, todoId, { planOnly = false, token = 'crash-lease', deps = mockDeps() } = {}) {
  const todo = getTodoById(dataDir, cwd, todoId);
  const result = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: Date.now(),
    token,
    deps,
    tick: {
      watcher: getWorkspaceWatcher(cwd, { dataDir }),
      decision: { kind: planOnly ? 'plan_gate' : 'start_cycle', planOnly, nextTodoId: todoId },
      snapshot: { readyLeaves: [{ id: todoId, updatedAt: todo.updatedAt, title: todo.title }] },
    },
  });
  return { started: result.started, reason: result.reason, cycleId: result.cycle?.cycleId || '', chatId: result.cycle?.chatId || '' };
}

async function serverStage() {
  const fixture = { workspaces: [], starts: [] };
  const save = () => fs.writeFileSync(FIXTURE, JSON.stringify(fixture));
  if (SCENARIO === 'three' || SCENARIO === 'preset') {
    const ws = seedWorkspace('main', 3);
    fixture.workspaces.push(ws);
    for (const todo of ws.todos) fixture.starts.push(await startCycle(ws.cwd, todo.id));
    if (SCENARIO === 'preset') {
      mutateWorkspaceWatcherRow(ws.cwd, () => ({
        failures: { [ws.todos[0].id]: 2 },
        backoffUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }), { dataDir });
    }
    save();
    return freezeAsync();
  }
  if (SCENARIO === 'mixed') {
    // wsPlan: a planOnly cycle. wsImpl: a running cycle with a live child
    // delegation, plus a cycle frozen in phase `starting` (adapter never answers).
    const wsPlan = seedWorkspace('plan', 1, { ...POLICY, requirePlanApproval: true });
    const wsImpl = seedWorkspace('impl', 2);
    wsPlan.planOnly = true;
    fixture.workspaces.push(wsPlan, wsImpl);
    fixture.starts.push(await startCycle(wsPlan.cwd, wsPlan.todos[0].id, { planOnly: true }));
    const running = await startCycle(wsImpl.cwd, wsImpl.todos[0].id);
    fixture.starts.push(running);
    const child = createDelegationRecord({
      parentChatId: running.chatId,
      childChatId: 'child-chat-live',
      workspaceFolder: wsImpl.cwd,
      status: 'running',
    });
    fixture.childDelegationId = child.id;
    save();
    await startCycle(wsImpl.cwd, wsImpl.todos[1].id, {
      deps: mockDeps({ startChatRun: () => freezeAsync() }),
    });
    return undefined;
  }
  if (['launch_orch', 'launch_run', 'launch_hot', 'launch_hard'].includes(SCENARIO)) {
    const ws = seedWorkspace('main', 1);
    fixture.workspaces.push(ws);
    const before = getWorkspaceWatcher(ws.cwd, { dataDir });
    fixture.before = { cycles: before.cycles || null, lastCycleAt: before.lastCycleAt || '' };
    const deps = SCENARIO === 'launch_orch'
      ? mockDeps({ resolveWorkspaceWatcherOrchestrator: async () => ({ ok: false, reason: 'no_model' }) })
      : mockDeps({
        startChatRun: async () => {
          const error = new Error('adapter rejected');
          error.code = SCENARIO === 'launch_hard' ? 'chat_not_found' : 'recipient_busy';
          throw error;
        },
      });
    if (SCENARIO === 'launch_hot') {
      // Hot-loop guard: record the row after every consecutive transient refusal.
      fixture.hot = [];
      for (let i = 0; i < WORKSPACE_WATCHER_MAX_TRANSIENT_START_REFUSALS; i += 1) {
        fixture.starts.push(await startCycle(ws.cwd, ws.todos[0].id, { deps }));
        const row = getWorkspaceWatcher(ws.cwd, { dataDir });
        fixture.hot.push({ failures: row.failures || {}, backoffUntil: row.backoffUntil || '', infraBackoffUntil: row.infraBackoffUntil || '', count: row.cycles?.count || 0 });
      }
    } else {
      fixture.starts.push(await startCycle(ws.cwd, ws.todos[0].id, { deps }));
    }
    save();
    return freezeAsync();
  }
  throw new Error(`unknown scenario ${SCENARIO}`);
}

function readyTodoIds(cwd) {
  return (loadTodosData(dataDir, cwd)?.items || []).filter((row) => row.status === 'ready').map((row) => row.id);
}

async function bootStage() {
  const fixture = readFixture();
  if (env.CW_CHILDREN === 'done' && fixture.childDelegationId) {
    updateDelegationRecord(fixture.childDelegationId, { status: 'interrupted' });
  }
  const outcome = await reconcileWorkspaceWatchersOnBoot({ dataDir, scoutArchiveDeps: {}, orchestratorArchiveDeps: {} });
  const result = {
    instanceId: getProcessInstance().instanceId,
    reconciled: outcome.reconciled,
    errors: outcome.errors.length,
    starts: [],
  };
  if (env.CW_THEN_START === '1') {
    for (const ws of fixture.workspaces) {
      for (const todoId of readyTodoIds(ws.cwd)) {
        result.starts.push(await startCycle(ws.cwd, todoId, { planOnly: ws.planOnly === true, token: `boot-${process.pid}` }));
      }
    }
  }
  emit('RESULT', result);
  ready();
  process.exit(0);
}

async function liveStage() {
  // A cycle that really ran in THIS process, ended without a report and whose
  // room is idle: the genuine no-progress case, same instance token.
  const ws = seedWorkspace('live', 1);
  const started = await startCycle(ws.cwd, ws.todos[0].id);
  fs.writeFileSync(FIXTURE, JSON.stringify({ workspaces: [ws], starts: [started] }));
  const closed = await reconcileWorkspaceWatcherCycle({
    workspaceFolder: ws.cwd,
    dataDir,
    now: Date.now() + 5 * 60_000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
    },
  });
  emit('RESULT', { closed: closed.closed, reason: closed.reason });
  ready();
  process.exit(0);
}

async function seedReadyStage() {
  const ws = seedWorkspace('main', 1);
  fs.writeFileSync(FIXTURE, JSON.stringify({ workspaces: [ws], starts: [] }));
  ready();
  process.exit(0);
}

async function raceBootStage() {
  const go = env.RECOVERY_CRASH_BARRIER;
  ready();
  while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 5));
  const outcome = await reconcileWatchersOnBootResult();
  emit('RESULT', outcome);
  process.exit(0);
}

async function reconcileWatchersOnBootResult() {
  const outcome = await reconcileWorkspaceWatchersOnBoot({ dataDir, scoutArchiveDeps: {}, orchestratorArchiveDeps: {} });
  return { reconciled: outcome.reconciled, errors: outcome.errors.length, errorDetails: outcome.errors.map((e) => ({ code: e.code, message: e.message })) };
}

async function raceStartStage() {
  const fixture = readFixture();
  const ws = fixture.workspaces[0];
  const go = env.RECOVERY_CRASH_BARRIER;
  ready();
  while (!fs.existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 5));
  const started = await startCycle(ws.cwd, ws.todos[0].id, { token: `race-${process.pid}` });
  emit('RESULT', started);
  process.exit(0);
}

const stages = {
  server: serverStage,
  boot: bootStage,
  live: liveStage,
  seed_ready: seedReadyStage,
  race_boot: raceBootStage,
  race_start: raceStartStage,
};
await stages[env.CW_STAGE]();
