/**
 * Workspace Watcher restart evidence for a `doing` leaf's executor chat.
 *
 * A leaf whose executor run was accepted by another process instance (token
 * stored on the recovery run), whose room is absent in this process and which
 * the recovery registry does not resume or queue, is `recoverable` with
 * evidence `restart_instance` and is released. Anything weaker (resume queued,
 * adapter error, same instance, legacy run without a token) stays `unknown`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { getWorktreeRecord, mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { closeRecoveryStore, openRecoveryStore } from '../lib/recovery/recovery-store.ts';
import { beginRunLaunch } from '../lib/recovery/recovery-lifecycle.ts';
import { toRecoveryRequestId } from '../lib/chat-run/chat-run-recovery.ts';
import { getProcessInstance } from '../lib/recovery/recovery-shutdown.ts';
import { releaseStaleWorkspaceTodoClaims, snapshotWorkspaceWatcher, tickWorkspaceWatcher } from '../lib/workspace-watcher.js';
import { classifyWorkspaceDoingTodos } from '../lib/workspace-watcher-recovery.js';
import { hasWorkspaceWatcherLeafRestartEvidence } from '../lib/workspace-watcher-restart-evidence.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-restart-leaf-'));
const store = openRecoveryStore({ dataDir: path.join(tmpRoot, 'recovery') });
const T0 = Date.parse('2026-10-22T12:10:00.000Z');
const OLD = 'instance-old';
const goneProbe = () => ({ known: false, busy: false, reason: 'state_missing' });
const errorProbe = () => ({ known: false, busy: false, reason: 'adapter_error' });

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

let seq = 0;
/** A chat-family run in the recovery registry accepted by `instanceToken`. */
function recordRun(chatId, { instanceToken = OLD, prompt = '' } = {}) {
  seq += 1;
  return beginRunLaunch({
    family: 'chat',
    owner: 'chat-run-service',
    requestId: toRecoveryRequestId(`leaf-${seq}-${chatId}`),
    chatId,
    harness: 'claude',
    instanceToken,
    ...(prompt ? { prompt } : {}),
  }, store);
}

function setup(name, { mode = 'autopilot', claimed = true } = {}) {
  const dataDir = path.join(tmpRoot, `data-${name}`);
  const cwd = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  upsertWorkspaceWatcher(cwd, {
    mode,
    policy: { maxParallel: 3, cooldownMs: 0, maxCyclesPerDay: 50, requirePlanApproval: false },
  }, { dataDir });
  const chatId = `chat-${name}`;
  const orphan = addTodo(dataDir, cwd, { title: 'orphan', status: 'ready' }).item;
  updateTodo(dataDir, cwd, orphan.id, {
    status: 'doing',
    ...(claimed
      ? { claimedByChatId: chatId, claimedAt: new Date(T0).toISOString(), claimLeaseUntil: new Date(T0 - 1000).toISOString() }
      : { chatId }),
  });
  const ready = addTodo(dataDir, cwd, { title: 'next', status: 'ready' }).item;
  return { dataDir, cwd, chatId, orphan, ready };
}

const release = (ctx, probe) => releaseStaleWorkspaceTodoClaims({
  workspaceFolder: ctx.cwd,
  dataDir: ctx.dataDir,
  now: T0,
  probeChatRunLiveness: probe,
  loadDelegations: () => [],
});

function classify(ctx, probe) {
  const states = classifyWorkspaceDoingTodos({
    items: [getTodoById(ctx.dataDir, ctx.cwd, ctx.orphan.id)],
    delegations: [],
    cycles: [],
    probe,
    isCycleChatAlive: () => true,
    now: T0,
  });
  return states[0];
}

for (const claimed of [true, false]) {
  runCase(`(a) ${claimed ? 'claimed' : 'unclaimed'} leaf, run accepted by another instance, room absent -> recoverable + released`, () => {
    const ctx = setup(`a-${claimed}`, { claimed });
    recordRun(ctx.chatId);
    const result = release(ctx, goneProbe);
    assert.deepEqual(result.released, [ctx.orphan.id]);
    const state = result.states.find((row) => row.todoId === ctx.orphan.id);
    assert.equal(state.state, 'recoverable');
    assert.equal(state.evidence, 'restart_instance');
    assert.equal(state.reason, 'state_missing');
    const after = getTodoById(ctx.dataDir, ctx.cwd, ctx.orphan.id);
    assert.equal(after.status, 'ready');
    assert.ok(!after.claimedByChatId);
  });
}

runCase('(b) same case with the run queued for recovery resume stays unknown and is not released', () => {
  const ctx = setup('b');
  const launched = recordRun(ctx.chatId, { prompt: 'resume me' });
  assert.equal(launched.queueEntry?.state, 'queued');
  assert.equal(hasWorkspaceWatcherLeafRestartEvidence(ctx.chatId), false);
  const result = release(ctx, goneProbe);
  assert.deepEqual(result.released, []);
  const state = result.states.find((row) => row.todoId === ctx.orphan.id);
  assert.equal(state.state, 'unknown');
  assert.equal(state.evidence, 'chat_run_probe');
  assert.equal(getTodoById(ctx.dataDir, ctx.cwd, ctx.orphan.id).status, 'doing');
});

runCase('(c) adapter error stays unknown even with restart evidence in the registry', () => {
  const ctx = setup('c');
  recordRun(ctx.chatId);
  const result = release(ctx, errorProbe);
  assert.deepEqual(result.released, []);
  const state = result.states.find((row) => row.todoId === ctx.orphan.id);
  assert.equal(state.state, 'unknown');
  assert.equal(state.reason, 'adapter_error');
  assert.equal(getTodoById(ctx.dataDir, ctx.cwd, ctx.orphan.id).status, 'doing');
});

runCase('no evidence: same instance, legacy token-less run, no run at all, terminal/waiting run', () => {
  const current = getProcessInstance().instanceId;
  const cases2 = {
    same: () => recordRun('chat-ev-same', { instanceToken: current }),
    legacy: () => recordRun('chat-ev-legacy', { instanceToken: '' }),
    none: () => null,
  };
  for (const [name, make] of Object.entries(cases2)) {
    make();
    assert.equal(hasWorkspaceWatcherLeafRestartEvidence(`chat-ev-${name}`), false, name);
  }
  assert.equal(hasWorkspaceWatcherLeafRestartEvidence('chat-ev-unknown-chat'), false);
  // A foreign run in a non-restart state is not evidence either.
  const waiting = recordRun('chat-ev-state');
  assert.equal(hasWorkspaceWatcherLeafRestartEvidence('chat-ev-state'), true, 'starting + foreign token is evidence');
  assert.equal(hasWorkspaceWatcherLeafRestartEvidence('chat-ev-state', { listRuns: () => [{ ...waiting.run, state: 'waiting' }] }), false);
  assert.equal(hasWorkspaceWatcherLeafRestartEvidence('chat-ev-state', { listRuns: () => [{ ...waiting.run, state: 'recovering' }] }), false);
  assert.equal(hasWorkspaceWatcherLeafRestartEvidence('chat-ev-state', { listRuns: () => [{ ...waiting.run, state: 'cancelled' }] }), false);
  assert.equal(hasWorkspaceWatcherLeafRestartEvidence('chat-ev-state', { listRuns: () => [{ ...waiting.run, resumeActor: 'automatic' }] }), false);
  assert.equal(hasWorkspaceWatcherLeafRestartEvidence('chat-ev-state', { listRuns: () => { throw new Error('store closed'); } }), false);
});

runCase('a busy or known-idle room is never restart-orphan evidence; blocked leaf is not released', () => {
  const ctx = setup('busy');
  recordRun(ctx.chatId);
  assert.equal(classify(ctx, () => ({ known: true, busy: true, reason: 'busy' })).state, 'active');
  const blocked = setup('blocked');
  recordRun(blocked.chatId);
  updateTodo(blocked.dataDir, blocked.cwd, blocked.orphan.id, { blockedReason: 'needs a human' });
  assert.equal(classify(blocked, goneProbe).state, 'user_action');
});

runCase('(d) after a restart the watcher decision starts work instead of wait_active/unknown_liveness', () => {
  const ctx = setup('d', { mode: 'observe' });
  const deps = {
    listWorkspaceChatIds: () => [ctx.chatId],
    probeChatRunLiveness: goneProbe,
    loadDelegations: () => [],
  };
  // Without registry evidence the orphan keeps blocking (today's behaviour);
  // one unknown fills the single slot of a maxParallel 1 watcher.
  upsertWorkspaceWatcher(ctx.cwd, { policy: { maxParallel: 1 } }, { dataDir: ctx.dataDir });
  const blocked = tickWorkspaceWatcher({ workspaceFolder: ctx.cwd, dataDir: ctx.dataDir, now: T0, token: 'before', deps });
  assert.equal(blocked.decision.kind, 'wait_active');
  assert.equal(blocked.decision.reason, 'unknown_liveness');
  // The run was accepted by the previous process: the orphan is not a live agent.
  recordRun(ctx.chatId);
  const snapshot = snapshotWorkspaceWatcher({ workspaceFolder: ctx.cwd, dataDir: ctx.dataDir, now: T0, deps });
  assert.equal(snapshot.unknownAgentCount, 0);
  assert.deepEqual(snapshot.unknownChatIds, []);
  const tick = tickWorkspaceWatcher({ workspaceFolder: ctx.cwd, dataDir: ctx.dataDir, now: T0 + 1000, token: 'before', deps });
  assert.notEqual(tick.decision.kind, 'wait_active');
  assert.equal(tick.decision.kind, 'observe_ready');
});

/** Persist a live worktree record (and optionally closed Watcher cycles) for the leaf. */
function seedWorktree(ctx, { recordCycles = [], cycleChats = [] } = {}) {
  mutateWorktreeRegistry((doc) => {
    doc.items[ctx.orphan.id] = {
      todoId: ctx.orphan.id,
      workspaceFolder: ctx.cwd,
      worktreePath: path.join(ctx.cwd, '.wt', ctx.orphan.id),
      branch: `cretli/todo/${ctx.orphan.id}`,
      baseCommit: 'abc123',
      creationState: 'ready',
      executionState: 'active',
      cycles: recordCycles,
    };
    return doc;
  }, { dataDir: ctx.dataDir });
  upsertWorkspaceWatcher(ctx.cwd, { cycleChats }, { dataDir: ctx.dataDir });
  return getWorktreeRecord(ctx.orphan.id, { dataDir: ctx.dataDir });
}

const interrupted = (ctx, cycleId) => ({
  id: ctx.chatId, cycleId, todoIds: [ctx.orphan.id], at: '2026-10-22T14:00:00.000Z', outcome: 'failure', closeReason: 'interrupted_restart',
});

runCase('(e) watcher worktree leaf after interrupted_restart -> recoverable, real release keeps the worktree record', () => {
  const ctx = setup('e');
  const before = seedWorktree(ctx, { recordCycles: ['cyc-e'], cycleChats: [interrupted(ctx, 'cyc-e')] });
  assert.ok(before, 'record seeded');
  const result = release(ctx, goneProbe);
  const state = result.states.find((row) => row.todoId === ctx.orphan.id);
  assert.equal(state.state, 'recoverable');
  assert.equal(state.reason, 'restart_interrupted_worktree');
  assert.deepEqual(result.released, [ctx.orphan.id]);
  const after = getTodoById(ctx.dataDir, ctx.cwd, ctx.orphan.id);
  assert.equal(after.status, 'ready');
  assert.ok(!after.claimedByChatId);
  assert.deepEqual(getWorktreeRecord(ctx.orphan.id, { dataDir: ctx.dataDir }), before, 'worktree record untouched');
});

runCase('(e3) a worktree leaf already picked up by a new active cycle is not released', () => {
  const ctx = setup('e3');
  // The interrupted cycle is closed; the Watcher has since started a new cycle
  // on the same leaf (same worktree), so the leaf is live work again.
  seedWorktree(ctx, { recordCycles: ['cyc-e3', 'cyc-e3-new'], cycleChats: [interrupted(ctx, 'cyc-e3')] });
  upsertWorkspaceWatcher(ctx.cwd, {
    activeCycles: [{ cycleId: 'cyc-e3-new', chatId: 'new-cycle-chat', todoIds: [ctx.orphan.id], startedAt: '2026-10-22T14:30:00.000Z' }],
  }, { dataDir: ctx.dataDir });
  const result = release(ctx, goneProbe);
  assert.deepEqual(result.released, []);
  const state = result.states.find((row) => row.todoId === ctx.orphan.id);
  assert.notEqual(state?.reason, 'restart_interrupted_worktree');
  // The live cycle shows as active work, not as a worktree waiting for a human.
  assert.equal(state?.state, 'active');
  assert.equal(state?.reason, 'worktree_cycle');
  assert.equal(getTodoById(ctx.dataDir, ctx.cwd, ctx.orphan.id).status, 'doing');
});

runCase('(e2) a blockedReason still holds a worktree leaf as worktree_open', () => {
  const ctx = setup('e2');
  seedWorktree(ctx, { recordCycles: ['cyc-e2'], cycleChats: [interrupted(ctx, 'cyc-e2')] });
  updateTodo(ctx.dataDir, ctx.cwd, ctx.orphan.id, { blockedReason: 'needs a human' });
  const result = release(ctx, goneProbe);
  assert.deepEqual(result.released, []);
  assert.equal(result.states.find((row) => row.todoId === ctx.orphan.id).reason, 'worktree_open');
});

runCase('(f) manual worktree without a Watcher cycle stays user_action/worktree_open', () => {
  const ctx = setup('f');
  seedWorktree(ctx, { recordCycles: [], cycleChats: [] });
  const result = release(ctx, goneProbe);
  assert.deepEqual(result.released, []);
  const state = result.states.find((row) => row.todoId === ctx.orphan.id);
  assert.equal(state.state, 'user_action');
  assert.equal(state.reason, 'worktree_open');
});

runCase('(g) manual worktree + EARLIER interrupted_restart cycle of the same todo stays worktree_open (R1A1-F1)', () => {
  const ctx = setup('g');
  // The earlier Watcher cycle is not among the cycles that used this worktree.
  seedWorktree(ctx, { recordCycles: [], cycleChats: [interrupted(ctx, 'cyc-old')] });
  const result = release(ctx, goneProbe);
  assert.deepEqual(result.released, []);
  const state = result.states.find((row) => row.todoId === ctx.orphan.id);
  assert.equal(state.state, 'user_action');
  assert.equal(state.reason, 'worktree_open');
  assert.equal(getTodoById(ctx.dataDir, ctx.cwd, ctx.orphan.id).status, 'doing');
});

runCase('(h) a newer non-interrupted cycle bound to the worktree wins over an older interrupted one', () => {
  const ctx = setup('h');
  seedWorktree(ctx, {
    recordCycles: ['cyc-1', 'cyc-2'],
    cycleChats: [
      interrupted(ctx, 'cyc-1'),
      { id: 'chat-later', cycleId: 'cyc-2', todoIds: [ctx.orphan.id], at: '2026-10-22T15:00:00.000Z', outcome: 'success', closeReason: '' },
    ],
  });
  const result = release(ctx, goneProbe);
  assert.deepEqual(result.released, []);
  assert.equal(result.states.find((row) => row.todoId === ctx.orphan.id).reason, 'worktree_open');
});

for (const run of cases) {
  // eslint-disable-next-line no-await-in-loop -- cases share the isolated stores
  await run();
}
closeRecoveryStore(store);
fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} restart-leaf test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace watcher restart-leaf tests passed');
