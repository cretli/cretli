import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import {
  tickDelegationRuntime,
  getDelegationRuntimeHealth,
  stopDelegationRuntimeWorker,
  resetDelegationRuntimeHealth,
} from '../lib/delegation-runtime-worker.js';
import { enqueueMailboxMessage } from '../lib/delegation-mailbox.js';
import { getMailboxMessageById } from '../lib/persist/delegation-mailbox-persist.js';
import {
  hangNextMockChatRunStart,
  registerMockChatRunAdapter,
  getMockChatRunByRequestId,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';
import { startChatRun } from '../lib/chat-run-service.js';

stopDelegationRuntimeWorker();
resetMockChatRuns();
registerMockChatRunAdapter('opencode');
const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});

{
  const parentA = addChat(crypto.randomUUID(), 'A', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const parentB = addChat(crypto.randomUUID(), 'B', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const release = hangNextMockChatRunStart();
  const hung = enqueueMailboxMessage({
    fromChatId: parentA.id,
    toChatId: parentA.id,
    body: 'hang forever',
    idempotencyKey: crypto.randomUUID(),
  });
  const started = Date.now();
  while (Date.now() - started < 400) {
    await tickDelegationRuntime({ now: Date.now(), drainMailbox: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const independent = await service.createAndStart({
    parentChatId: parentB.id,
    sourceKind: 'text',
    taskText: 'independent B',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(independent.ok, true, 'hung adapter A must not block job B');
  const health = getDelegationRuntimeHealth();
  assert.equal(health.worker.lastTickFinishedAt > 0, true);
  release();
  await hung;
}

{
  resetMockChatRuns();
  registerMockChatRunAdapter('opencode');
  const chat = addChat(crypto.randomUUID(), 'req', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const requestId = crypto.randomUUID();
  const first = await startChatRun({
    chatId: chat.id,
    prompt: 'same request',
    requestId,
  });
  const second = await startChatRun({
    chatId: chat.id,
    prompt: 'same request',
    requestId,
  });
  assert.equal(first.runId, second.runId);
  assert.equal(getMockChatRunByRequestId(requestId).runId, first.runId);
}

{
  const parent = addChat(crypto.randomUUID(), 'late', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const queued = await enqueueMailboxMessage({
    fromChatId: parent.id,
    toChatId: parent.id,
    body: 'will be uncertain',
    idempotencyKey: crypto.randomUUID(),
  });
  const release = hangNextMockChatRunStart();
  const delivering = enqueueMailboxMessage({
    fromChatId: parent.id,
    toChatId: parent.id,
    body: queued.message.body,
    idempotencyKey: queued.message.idempotencyKey,
  });
  void tickDelegationRuntime({ drainMailbox: true });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const { updateMailboxMessage } = await import('../lib/persist/delegation-mailbox-persist.js');
  updateMailboxMessage(queued.message.id, {
    status: 'uncertain',
    delivery: 'uncertain',
    leaseOwner: 'other-owner',
    leaseRevision: '99',
  });
  release();
  await delivering;
  const after = getMailboxMessageById(queued.message.id);
  assert.equal(after.status, 'uncertain');
}

console.log('delegation-phase2-dispatch.test.js OK');
