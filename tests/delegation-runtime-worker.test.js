import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationService,
  finishDelegation,
  hasInFlightDelegationStart,
  setDelegationCrashHook,
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
import { getDelegationById, updateDelegationRecord, getDelegationsDataPath } from '../lib/persist/delegations-persist.js';
import { createMailboxMessage, updateMailboxMessage, getMailboxMessageById } from '../lib/persist/delegation-mailbox-persist.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import { registerMockChatRunAdapter, patchMockChatRun } from '../lib/chat-run/mock-adapter.js';
import {
  DELEGATION_STARTING_TIMEOUT_MS,
  MAILBOX_DISPATCHING_TIMEOUT_MS,
} from '../lib/delegation-status.js';

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

console.log('delegation-runtime-worker.test.js OK');
