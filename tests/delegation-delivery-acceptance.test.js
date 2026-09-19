import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { createDelegationRecord, getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createDelegationService, finishDelegation, flushDelegationOutbox, publishDelegationStatus } from '../lib/delegation-service.js';
import { tickDelegationRuntime } from '../lib/delegation-runtime-worker.js';
import { registerMockChatRunAdapter, patchMockChatRun } from '../lib/chat-run/mock-adapter.js';
import { DELEGATION_CANCELLING_TIMEOUT_MS } from '../lib/delegation-status.js';

registerMockChatRunAdapter('opencode');
const service = createDelegationService({ isModelAvailable: () => true });
function makeJob() {
  const parent = addChat(crypto.randomUUID(), 'Acceptance', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode', sdkMode: 'agent',
  });
  return service.createAndStart({ parentChatId: parent.id, sourceKind: 'text', taskText: 'Acceptance',
    executor: { transport: 'opencode', model: 'opencode/test' }, idempotencyKey: crypto.randomUUID() });
}

// Acknowledgement changes the history card without a status transition.
{
  const { delegation: job } = await makeJob();
  finishDelegation(job, { status: 'completed', report: 'Done' });
  const acknowledged = service.acknowledge(job.id).delegation;
  const cards = () => loadChatHistory(job.parentChatId).events
    .filter((row) => row.rec.variant === 'delegation').map((row) => JSON.parse(row.rec.payload));
  assert.equal(cards().at(-1).event, 'acknowledged');
  assert.equal(cards().at(-1).unverified, false);
  const count = cards().length;
  publishDelegationStatus(acknowledged, 'acknowledged');
  assert.equal(cards().length, count, 'Same acknowledgement must remain idempotent');
}

// A rejected history append must keep its intent pending and back off.
{
  const job = createDelegationRecord({ parentChatId: 'invalid/chat', childChatId: crypto.randomUUID(), status: 'running' });
  finishDelegation(job, { status: 'completed', report: 'Retain me' });
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

// Timeout cannot claim cancellation while the executor remains busy.
{
  const { delegation: job } = await makeJob();
  const now = Date.now();
  updateDelegationRecord(job.id, { status: 'cancelling',
    lastTransitionAt: new Date(now - DELEGATION_CANCELLING_TIMEOUT_MS - 100).toISOString() });
  await tickDelegationRuntime({ now, drainMailbox: false });
  const busy = getDelegationById(job.id);
  assert.equal(busy.status, 'cancelling');
  assert.ok(busy.errors.some((entry) => entry.code === 'cancel_timeout'));
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  await tickDelegationRuntime({ now: now + 1, drainMailbox: false });
  assert.equal(getDelegationById(job.id).status, 'cancelled');
}

console.log('delegation-delivery-acceptance.test.js OK');
