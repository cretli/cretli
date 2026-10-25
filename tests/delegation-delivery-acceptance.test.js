import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import {
  createDelegationService,
  finishDelegation,
  flushDelegationOutbox,
  hasInFlightDelegationStart,
  publishDelegationStatus, settleDelegationHistoryTasks } from '../lib/delegation-service.js';
import { resolveCancellingDeadline } from '../lib/delegation-cancelling-deadline.js';
import { tickDelegationRuntime } from '../lib/delegation-runtime-worker.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import { registerMockChatRunAdapter, patchMockChatRun, getMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import { DELEGATION_CANCELLING_TIMEOUT_MS } from '../lib/delegation-status.js';

registerMockChatRunAdapter('testfake');
const service = createDelegationService({ isModelAvailable: () => true });
function makeJob() {
  const parent = addChat(crypto.randomUUID(), 'Acceptance', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake', sdkMode: 'agent',
  });
  return service.createAndStart({ parentChatId: parent.id, sourceKind: 'text', taskText: 'Acceptance',
    executor: { transport: 'testfake', model: 'testfake/test' }, idempotencyKey: crypto.randomUUID() });
}

// Acknowledgement changes the history card without a status transition.
{
  const { delegation: job } = await makeJob();
  finishDelegation(job, { status: 'completed', report: 'Done' });
await settleDelegationHistoryTasks();
  const acknowledged = (await service.acknowledge(job.id)).delegation;
  const cards = () => loadChatHistory(job.parentChatId).events
    .filter((row) => row.rec.variant === 'delegation').map((row) => JSON.parse(row.rec.payload));
  assert.equal(cards().at(-1).event, 'acknowledged');
  assert.equal(cards().at(-1).unverified, false);
  const count = cards().length;
  await publishDelegationStatus(acknowledged, 'acknowledged');
  assert.equal(cards().length, count, 'Same acknowledgement must remain idempotent');
}

// A rejected history append must keep its intent pending and back off.
{
  const job = createDelegationRecord({ parentChatId: 'invalid/chat', childChatId: crypto.randomUUID(), status: 'running' });
  finishDelegation(job, { status: 'completed', report: 'Retain me' });
await settleDelegationHistoryTasks();
  await flushDelegationOutbox(job);
  let item = getDelegationById(job.id).outbox.find((row) => row.type === 'history');
  assert.equal(item.deliveredAt, '');
  assert.equal(item.tryCount, 1);
  const due = Date.parse(item.nextAttemptAt);
  await flushDelegationOutbox(job, { now: due - 1 });
  assert.equal(getDelegationById(job.id).outbox[0].tryCount, 1);
  await flushDelegationOutbox(job, { now: due + 1 });
  item = getDelegationById(job.id).outbox[0];
  assert.equal(item.tryCount, 2);
  assert.equal(item.deliveredAt, '');
}

// Timeout while the executor remains busy escalates to cancel_unconfirmed.
{
  registerChatRunAdapter({
    transport: 'stuck-cancel-test',
    capabilities: { canCancel: true },
    getState: () => ({ runId: 'r-stuck', busy: true, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'r-stuck' }),
  });
  const job = createDelegationRecord({
    parentChatId: 'parent-stuck',
    childChatId: 'child-stuck',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'stuck-cancel-test', model: 'stuck-cancel-test/x' },
    assignment: 'implement',
    status: 'cancelling',
    runId: 'r-stuck',
  });
  const now = Date.now();
  updateDelegationRecord(job.id, {
    lastTransitionAt: new Date(now - DELEGATION_CANCELLING_TIMEOUT_MS - 100).toISOString(),
  });
  resolveCancellingDeadline(getDelegationById(job.id), now, {
    busy: true,
    known: true,
    appendCancelTimeoutError: true,
  }, { finishDelegation, hasInFlightDelegationStart });
  const busy = getDelegationById(job.id);
  assert.equal(busy.status, 'interrupted');
  assert.equal(busy.interruptCode, 'cancel_unconfirmed');
  assert.equal(busy.slotHeldBy, 'cancel_unconfirmed');
  assert.ok(busy.errors.some((entry) => entry.code === 'cancel_timeout'));
}

// Late cancel after escalation must not auto-release the held slot.
{
  registerChatRunAdapter({
    transport: 'late-cancel-accept',
    capabilities: { canCancel: true },
    getState: () => ({ runId: 'r-late', busy: false, waitingForInput: false }),
    cancel: async () => {},
    start: async () => ({ accepted: true, runId: 'r-late' }),
  });
  const job = createDelegationRecord({
    parentChatId: 'parent-late',
    childChatId: 'child-late',
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'late-cancel-accept', model: 'late-cancel-accept/x' },
    assignment: 'implement',
    status: 'interrupted',
    interruptCode: 'cancel_unconfirmed',
    runId: 'r-late',
  });
  updateDelegationRecord(job.id, {
    slotHeldBy: 'cancel_unconfirmed',
    runStoppingAt: new Date().toISOString(),
  });
  await service.cancel(job.id);
  const afterLateCancel = getDelegationById(job.id);
  assert.equal(afterLateCancel.slotHeldBy, 'cancel_unconfirmed');
  assert.equal(String(afterLateCancel.stopProof?.kind || ''), '');
}

// Past the timeout, a confirmed-idle executor finishes with stopProof (shared deadline).
{
  const childChatId = crypto.randomUUID();
  const job = createDelegationRecord({
    parentChatId: 'parent-idle-cancel',
    childChatId,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'cancelling',
    runId: crypto.randomUUID(),
  });
  const now = Date.now();
  updateDelegationRecord(job.id, {
    lastTransitionAt: new Date(now - DELEGATION_CANCELLING_TIMEOUT_MS - 100).toISOString(),
  });
  patchMockChatRun(childChatId, { busy: false, waitingForInput: false });
  resolveCancellingDeadline(getDelegationById(job.id), now, {
    busy: false,
    known: true,
  }, { finishDelegation, hasInFlightDelegationStart });
  const released = getDelegationById(job.id);
  assert.equal(released.status, 'cancelled');
  assert.equal(String(released.stopProof?.kind || ''), 'run_idle');
}

console.log('delegation-delivery-acceptance.test.js OK');
