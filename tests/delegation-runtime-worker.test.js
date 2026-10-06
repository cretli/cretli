import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationService,
  finishDelegation,
  hasInFlightDelegationStart,
  inspectDelegationSlot,
  reconcileDelegationsOnBoot,
  releaseDelegationRunSlot,
  setDelegationCrashHook,
  delegationService,
} from '../lib/delegation-service.js';
import {
  tickDelegationRuntime,
  stopDelegationRuntimeWorker,
  startDelegationRuntimeWorker,
  getDelegationRuntimeHealth,
  resetDelegationRuntimeHealth,
  isDelegationRuntimeWorkerRunning,
  isDelegationRuntimeTickInFlight,
} from '../lib/delegation-runtime-worker.js';
import { getDelegationById, updateDelegationRecord, createDelegationRecord, getDelegationsDataPath } from '../lib/persist/delegations-persist.js';
import { createMailboxMessage, updateMailboxMessage, getMailboxMessageById } from '../lib/persist/delegation-mailbox-persist.js';
import { registerChatRunAdapter, probeChatRunLiveness } from '../lib/chat-run-service.js';
import { registerMockChatRunAdapter, patchMockChatRun, hangNextMockChatRunCancel } from '../lib/chat-run/mock-adapter.js';
import {
  DELEGATION_CANCELLING_TIMEOUT_MS,
  DELEGATION_RUNNING_ORPHAN_GRACE_MS,
  DELEGATION_STARTING_TIMEOUT_MS,
  MAILBOX_DISPATCHING_TIMEOUT_MS,
} from '../lib/delegation-status.js';
import {
  applyDelegationWorkflowPatch,
  getDelegationWorkflow,
  inspectDelegationWorkflowStart,
  isDelegationWorkflowDeadlinePassed,
  listDelegationWorkflowsPastDeadline,
} from '../lib/delegation-workflow.js';
import { formatTodoRef } from '../lib/todo-ref.js';

stopDelegationRuntimeWorker();
registerMockChatRunAdapter('opencode');
const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});
const parent = (title) => addChat(crypto.randomUUID(), title, null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const start = (p) => service.createAndStart({
  parentChatId: p.id,
  sourceKind: 'text',
  taskText: 'worker probe',
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});

{
  const job = (await start(parent('starting timeout'))).delegation;
  updateDelegationRecord(job.id, {
    status: 'starting',
    lastTransitionAt: new Date(Date.now() - DELEGATION_STARTING_TIMEOUT_MS - 1000).toISOString(),
  });
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.equal(getDelegationById(job.id).status, 'interrupted');
  assert.equal(getDelegationById(job.id).interruptCode, 'starting_timeout');
}

{
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => null,
    cancel: async () => {},
    start: async () => {
      await gate;
      return { accepted: true, runId: 'held' };
    },
  });
  const pending = start(parent('in-flight start'));
  let row = null;
  for (let i = 0; i < 50 && !row; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    row = (await import('../lib/persist/delegations-persist.js')).loadDelegations()
      .find((item) => item.status === 'starting' && hasInFlightDelegationStart(item.id));
  }
  assert.ok(row);
  assert.equal(hasInFlightDelegationStart(row.id), true);
  const old = new Date(Date.now() - DELEGATION_STARTING_TIMEOUT_MS - 1000).toISOString();
  updateDelegationRecord(row.id, { lastTransitionAt: old, status: 'starting' });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.equal(getDelegationById(row.id).status, 'starting');
  release();
  await pending;
}

registerMockChatRunAdapter('opencode');
{
  const job = (await start(parent('outbox backoff'))).delegation;
  finishDelegation(job, { status: 'completed', report: 'done', enqueueParentReply: true });
  const current = getDelegationById(job.id);
  const mailbox = current.outbox.find((row) => row.type === 'mailbox');
  const future = new Date(Date.now() + 60_000).toISOString();
  updateDelegationRecord(job.id, {
    outbox: current.outbox.map((row) => (
      row.id === mailbox.id ? { ...row, deliveredAt: '', nextAttemptAt: future, tryCount: 1 } : row
    )),
  });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  const after = getDelegationById(job.id);
  const stored = after.outbox.find((row) => row.id === mailbox.id);
  assert.equal(String(stored.deliveredAt || '').trim(), '');
}

{
  const chat = parent('dispatch timeout');
  const message = createMailboxMessage({
    fromChatId: chat.id,
    toChatId: chat.id,
    kind: 'reply',
    body: 'hello',
    status: 'dispatching',
  });
  updateMailboxMessage(message.id, {
    status: 'dispatching',
    delivery: 'dispatching',
    dispatchingAt: new Date(Date.now() - MAILBOX_DISPATCHING_TIMEOUT_MS - 1000).toISOString(),
  });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  const after = getMailboxMessageById(message.id);
  assert.equal(after.status, 'uncertain');
  assert.equal(after.delivery, 'uncertain');
}

{
  const missing = createMailboxMessage({
    fromChatId: crypto.randomUUID(),
    toChatId: crypto.randomUUID(),
    kind: 'reply',
    body: 'no recipient',
    status: 'queued',
  });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: true });
  const after = getMailboxMessageById(missing.id);
  assert.equal(after.status === 'failed' || after.status === 'queued', true);
  assert.notEqual(after.status, 'delivered');
}

{
  const job = (await start(parent('orphan running'))).delegation;
  const idleAt = new Date(Date.now() - DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000).toISOString();
  updateDelegationRecord(job.id, {
    status: 'running',
    lastTransitionAt: idleAt,
    idleObservedAt: idleAt,
  });
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  const actual = getDelegationById(job.id);
  assert.equal(actual.status, 'interrupted');
  assert.equal(actual.interruptCode, 'running_orphan');
  assert.equal(String(actual.runStoppingAt || '').trim(), '');
}

{
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => {
      throw new Error('adapter down');
    },
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'down' }),
  });
  const child = parent('adapter unknown child');
  const job = createDelegationRecord({
    parentChatId: parent('adapter unknown parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
  });
  updateDelegationRecord(job.id, {
    status: 'running',
    lastTransitionAt: new Date(Date.now() - DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000).toISOString(),
  });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.equal(getDelegationById(job.id).status, 'running');
  registerMockChatRunAdapter('opencode');
}

{
  startDelegationRuntimeWorker({ intervalMs: 20 });
  startDelegationRuntimeWorker({ intervalMs: 20 });
  assert.equal(isDelegationRuntimeWorkerRunning(), true);
  stopDelegationRuntimeWorker();
  assert.equal(isDelegationRuntimeWorkerRunning(), false);
  startDelegationRuntimeWorker({ intervalMs: 20 });
  assert.equal(isDelegationRuntimeWorkerRunning(), true);
  stopDelegationRuntimeWorker();
  assert.equal(isDelegationRuntimeWorkerRunning(), false);
}

{
  const storePath = getDelegationsDataPath();
  const beforeCorrupt = fs.readFileSync(storePath, 'utf8');
  const rejections = [];
  const onReject = (reason) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onReject);
  resetDelegationRuntimeHealth();
  fs.writeFileSync(storePath, '{BROKEN');
  try {
    startDelegationRuntimeWorker({ intervalMs: 15 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const health = getDelegationRuntimeHealth();
    assert.equal(rejections.length, 0);
    assert.equal(health.degraded, true);
    assert.equal(health.code, 'DELEGATIONS_CORRUPT');
    assert.equal(fs.readFileSync(storePath, 'utf8'), '{BROKEN');
  } finally {
    stopDelegationRuntimeWorker();
    process.off('unhandledRejection', onReject);
    fs.writeFileSync(storePath, beforeCorrupt);
    resetDelegationRuntimeHealth();
  }
}

{
  let hookRuns = 0;
  let release = () => {};
  setDelegationCrashHook(async (phase) => {
    if (phase !== 'before-mailbox') return;
    hookRuns += 1;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  const job = (await start(parent('no overlapping ticks'))).delegation;
  finishDelegation(job, { status: 'completed', report: 'done', enqueueParentReply: true });
  resetDelegationRuntimeHealth();
  startDelegationRuntimeWorker({ intervalMs: 15 });
  const startedAt = Date.now();
  while (hookRuns === 0 && Date.now() - startedAt < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(hookRuns, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hookRuns, 1);
  assert.equal(isDelegationRuntimeTickInFlight(), true);
  release();
  const releasedAt = Date.now();
  while (isDelegationRuntimeTickInFlight() && Date.now() - releasedAt < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  stopDelegationRuntimeWorker();
  setDelegationCrashHook(null);
}

{
  const child = parent('probe existing chat');
  registerMockChatRunAdapter('opencode');
  const missingAdapterChat = addChat(crypto.randomUUID(), 'no adapter', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'missing-transport',
    sdkMode: 'agent',
  });
  const missingAdapter = probeChatRunLiveness({ chatId: missingAdapterChat.id, runId: 'r1' });
  assert.equal(missingAdapter.known, false);
  assert.equal(missingAdapter.busy, false);
  assert.equal(missingAdapter.reason, 'adapter_missing');

  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => null,
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'null-state' }),
  });
  const nullState = probeChatRunLiveness({ chatId: child.id, runId: 'wanted' });
  assert.equal(nullState.known, false);
  assert.equal(nullState.busy, false);
  assert.equal(nullState.reason, 'state_missing');

  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => ({ runId: 'other', busy: false, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'other' }),
  });
  const mismatch = probeChatRunLiveness({ chatId: child.id, runId: 'wanted' });
  assert.equal(mismatch.known, false);
  assert.equal(mismatch.reason, 'run_mismatch');
  registerMockChatRunAdapter('opencode');
}

{
  const job = (await start(parent('long run then idle'))).delegation;
  updateDelegationRecord(job.id, {
    status: 'running',
    lastTransitionAt: new Date(Date.now() - DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000).toISOString(),
    idleObservedAt: '',
  });
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  const afterFirst = getDelegationById(job.id);
  assert.equal(afterFirst.status, 'running');
  assert.ok(String(afterFirst.idleObservedAt || '').trim());
}

{
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => null,
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'null-orphan' }),
  });
  const child = parent('null state orphan child');
  const job = createDelegationRecord({
    parentChatId: parent('null state orphan parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
  });
  const old = new Date(Date.now() - DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000).toISOString();
  updateDelegationRecord(job.id, {
    status: 'running',
    lastTransitionAt: old,
    idleObservedAt: old,
    runId: 'wanted',
  });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.equal(getDelegationById(job.id).status, 'running');
  registerMockChatRunAdapter('opencode');
}

{
  const p = parent('runStopping unknown');
  const job = (await start(p)).delegation;
  finishDelegation(job, { status: 'completed', report: 'done' });
  updateDelegationRecord(job.id, { runStoppingAt: new Date().toISOString() });
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => null,
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'gone' }),
  });
  const kept = releaseDelegationRunSlot(getDelegationById(job.id));
  assert.ok(String(kept.runStoppingAt || '').trim());
  assert.equal(inspectDelegationSlot(kept).occupied, true);
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => ({ runId: job.runId, busy: false, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: job.runId }),
  });
  const released = releaseDelegationRunSlot(getDelegationById(job.id));
  assert.equal(String(released.runStoppingAt || '').trim(), '');
  registerMockChatRunAdapter('opencode');
}

{
  const folder = `${ISOLATED_DATA_DIR}/deadline-${crypto.randomUUID()}`;
  fs.mkdirSync(folder, { recursive: true });
  const p = addChat(crypto.randomUUID(), 'deadline cancel idle', null, folder, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const started = await service.createAndStart({
    parentChatId: p.id,
    sourceKind: 'text',
    taskText: 'deadline job',
    assignment: 'implement',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(started.ok, true, started.code || started.error || 'start failed');
  const job = started.delegation;
  const t0 = Date.now();
  applyDelegationWorkflowPatch({
    parentChatId: p.id,
    deadlineAt: new Date(t0 - 1000).toISOString(),
    clearStop: true,
  });
  assert.equal(isDelegationWorkflowDeadlinePassed(listDelegationWorkflowsPastDeadline(t0)[0], t0), true);
  resetDelegationRuntimeHealth();
  await tickDelegationRuntime({ now: t0, drainMailbox: false });
  let latest = getDelegationById(job.id);
  assert.ok(latest.status === 'cancelling' || latest.status === 'cancelled', latest.status);
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  if (latest.status === 'cancelling') {
    await tickDelegationRuntime({ now: t0 + DELEGATION_CANCELLING_TIMEOUT_MS + 1000, drainMailbox: false });
    latest = getDelegationById(job.id);
  }
  const released = releaseDelegationRunSlot(latest);
  assert.equal(released.status, 'cancelled');
  assert.equal(inspectDelegationSlot(getDelegationById(job.id)).occupied, false);
}

{
  const originalCancel = delegationService.cancel;
  const rejections = [];
  const onReject = (reason) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onReject);
  delegationService.cancel = async () => {
    throw new Error('cancel boom');
  };
  try {
    const p = parent('cancel reject');
    await start(p);
    applyDelegationWorkflowPatch({
      parentChatId: p.id,
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
      clearStop: true,
    });
    await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(rejections.length, 0);
  } finally {
    process.off('unhandledRejection', onReject);
    delegationService.cancel = originalCancel;
  }
}

{
  let cancelCalls = 0;
  const originalCancel = delegationService.cancel;
  const releaseCancel = hangNextMockChatRunCancel();
  delegationService.cancel = async (id) => {
    cancelCalls += 1;
    return originalCancel.call(delegationService, id);
  };
  try {
    const hungParent = parent('never-resolving cancel');
    const otherParent = parent('other outbox during hung cancel');
    const other = (await start(otherParent)).delegation;
    finishDelegation(other, { status: 'completed', report: 'done', enqueueParentReply: true });
    const pending = getDelegationById(other.id);
    const mailbox = pending.outbox.find((row) => row.type === 'mailbox');
    assert.ok(mailbox);
    updateDelegationRecord(other.id, {
      outbox: pending.outbox.map((row) => (
        row.id === mailbox.id ? { ...row, deliveredAt: '', nextAttemptAt: '' } : row
      )),
    });
    const hung = (await start(hungParent)).delegation;
    applyDelegationWorkflowPatch({
      parentChatId: hungParent.id,
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
      clearStop: true,
    });
    resetDelegationRuntimeHealth();
    const t0 = Date.now();
    await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `tick blocked on cancel: ${elapsed}ms`);
    assert.equal(isDelegationRuntimeTickInFlight(), false);
    assert.equal(getDelegationById(hung.id).status, 'cancelling');
    assert.equal(cancelCalls, 1);
    const flushed = getDelegationById(other.id).outbox.find((row) => row.id === mailbox.id);
    assert.ok(String(flushed.deliveredAt || '').trim());
    await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
    assert.equal(cancelCalls, 1);
    assert.equal(isDelegationRuntimeTickInFlight(), false);
  } finally {
    releaseCancel();
    delegationService.cancel = originalCancel;
  }
}

{
  let resolveCancel = () => {};
  let enteredCancel = () => {};
  const cancelGate = new Promise((resolve) => { resolveCancel = resolve; });
  const enteredGate = new Promise((resolve) => { enteredCancel = resolve; });
  let state = { runId: 'r1', busy: true, waitingForInput: false };
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => state,
    cancel: async () => {
      enteredCancel();
      await cancelGate;
    },
    start: async () => ({ accepted: true, runId: state.runId }),
  });
  const p = parent('worker stale deadline cancel');
  const child = parent('worker stale deadline child');
  const job = createDelegationRecord({
    parentChatId: p.id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    attemptId: 'a1',
    runId: 'r1',
  });
  applyDelegationWorkflowPatch({
    parentChatId: p.id,
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
    clearStop: true,
  });
  resetDelegationRuntimeHealth();
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  await enteredGate;
  updateDelegationRecord(job.id, { attemptId: 'a2', runId: 'r2', status: 'running' });
  state = { runId: 'r2', busy: false, waitingForInput: false };
  resolveCancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const latest = getDelegationById(job.id);
  assert.equal(latest.attemptId, 'a2');
  assert.equal(latest.status, 'running');
  registerMockChatRunAdapter('opencode');
}

// Worker starting timeout needs a confirmed idle adapter. A null/unknown
// state keeps the occupied slot.
{
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => null,
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'unknown-start' }),
  });
  const child = parent('unknown starting child');
  const job = createDelegationRecord({
    parentChatId: parent('unknown starting parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'starting',
    runId: 'wanted',
  });
  updateDelegationRecord(job.id, {
    lastTransitionAt: new Date(Date.now() - DELEGATION_STARTING_TIMEOUT_MS - 1000).toISOString(),
  });
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.equal(getDelegationById(job.id).status, 'starting');
  registerMockChatRunAdapter('opencode');
}

// Worker orphan grace is counted from the first confirmed idle observation.
{
  const child = parent('grace child');
  const job = createDelegationRecord({
    parentChatId: parent('grace child parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    runId: 'grace-run',
  });
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => ({ runId: 'grace-run', busy: false, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'grace-run' }),
  });
  const armedAt = Date.now();
  await tickDelegationRuntime({ now: armedAt, drainMailbox: false });
  const armed = getDelegationById(job.id);
  assert.equal(armed.status, 'running');
  assert.ok(String(armed.idleObservedAt || '').trim());
  await tickDelegationRuntime({ now: armedAt + DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000, drainMailbox: false });
  assert.equal(getDelegationById(job.id).status, 'running');
  await tickDelegationRuntime({ now: armedAt + DELEGATION_RUNNING_ORPHAN_GRACE_MS + 1000, drainMailbox: false });
  const finished = getDelegationById(job.id);
  assert.equal(finished.status, 'interrupted');
  assert.equal(finished.interruptCode, 'running_orphan');
  registerMockChatRunAdapter('opencode');
}

// Boot: an unknown/throw adapter state keeps an occupied running slot.
{
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => {
      throw new Error('boot adapter down');
    },
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'boot-throw' }),
  });
  const child = parent('boot throw child');
  const job = createDelegationRecord({
    parentChatId: parent('boot throw parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    runId: 'boot-throw',
  });
  updateDelegationRecord(job.id, {
    idleObservedAt: new Date(Date.now() - DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000).toISOString(),
  });
  await reconcileDelegationsOnBoot();
  assert.equal(getDelegationById(job.id).status, 'running');
  registerMockChatRunAdapter('opencode');
}

// Boot: starting with unknown liveness and no run id keeps the occupied slot.
{
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => null,
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'boot-start' }),
  });
  const child = parent('boot start child');
  const job = createDelegationRecord({
    parentChatId: parent('boot start parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'starting',
  });
  await reconcileDelegationsOnBoot();
  const after = getDelegationById(job.id);
  assert.equal(after.status, 'starting');
  registerMockChatRunAdapter('opencode');
}

// Boot: starting with unknown liveness and a run id also keeps the slot.
{
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => null,
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'boot-start-run' }),
  });
  const child = parent('boot start run child');
  const job = createDelegationRecord({
    parentChatId: parent('boot start run parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'starting',
    runId: 'boot-start-run',
  });
  await reconcileDelegationsOnBoot();
  const after = getDelegationById(job.id);
  assert.equal(after.status, 'starting');
  registerMockChatRunAdapter('opencode');
}

// Boot: the starting timeout only fires with a confirmed idle adapter and is
// non-retryable (starting_timeout).
{
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => ({ runId: 'boot-timeout', busy: false, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'boot-timeout' }),
  });
  const child = parent('boot timeout child');
  const job = createDelegationRecord({
    parentChatId: parent('boot timeout parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'starting',
    runId: 'boot-timeout',
  });
  updateDelegationRecord(job.id, {
    lastTransitionAt: new Date(Date.now() - DELEGATION_STARTING_TIMEOUT_MS - 1000).toISOString(),
  });
  await reconcileDelegationsOnBoot();
  const after = getDelegationById(job.id);
  assert.equal(after.status, 'interrupted');
  assert.equal(after.interruptCode, 'starting_timeout');
  registerMockChatRunAdapter('opencode');
}

// A leaf deadline cancels only that leaf's active jobs; sibling leaves and the
// cancel are fenced so the still-expired row is not re-cancelled every tick.
{
  registerMockChatRunAdapter('opencode');
  const p = parent('deadline leaf scope parent');
  const leafA = 'aaaabbbb-0000-1111-2222-333344445555';
  const leafB = 'bbbbcccc-0000-1111-2222-333344445555';
  const jobA = createDelegationRecord({
    parentChatId: p.id,
    childChatId: parent('deadline leaf A child').id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    attemptId: 'leaf-a-attempt',
    runId: 'leaf-a-run',
    sourceText: `${formatTodoRef(leafA)}\nleaf A job`,
  });
  const jobB = createDelegationRecord({
    parentChatId: p.id,
    childChatId: parent('deadline leaf B child').id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    attemptId: 'leaf-b-attempt',
    runId: 'leaf-b-run',
    sourceText: `${formatTodoRef(leafB)}\nleaf B job`,
  });
  applyDelegationWorkflowPatch({
    parentChatId: p.id,
    leafId: leafA,
    deadlineAt: new Date(Date.now() - 1000).toISOString(),
    clearStop: true,
  });
  resetDelegationRuntimeHealth();
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  const aLatest = getDelegationById(jobA.id);
  assert.ok(['cancelling', 'cancelled'].includes(aLatest.status), aLatest.status);
  assert.equal(
    getDelegationById(jobB.id).status,
    'running',
    'sibling leaf must not be cancelled by another leaf deadline',
  );
  await tickDelegationRuntime({ now: Date.now(), drainMailbox: false });
  assert.equal(getDelegationById(jobB.id).status, 'running');
  const rowA = getDelegationWorkflow(p.id, leafA);
  assert.equal(rowA.deadlineCancelKey, rowA.deadlineAt);
  const rowB = getDelegationWorkflow(p.id, leafB);
  assert.equal(rowB, null, 'sibling leaf must not get a deadline row');
  registerMockChatRunAdapter('opencode');
}

console.log('delegation-runtime-worker.test.js OK');
