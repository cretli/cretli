import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import { acquireDelegationOwnerLock } from '../lib/delegation-owner-lock.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { loadChatHistory } from '../lib/persist/chat-history-service.js';
import { registerMockChatRunAdapter, patchMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import {
  createDelegationService,
  inspectDelegationSlot,
} from '../lib/delegation-service.js';
import { shutdownDelegationRuntime } from '../lib/delegation-runtime-boot.js';

registerMockChatRunAdapter('testfake');
acquireDelegationOwnerLock();

const parent = addChat(crypto.randomUUID(), 'shutdown parent', null, process.cwd(), 'testfake/test', {
  agentTransport: 'testfake',
  sdkMode: 'agent',
});
const service = createDelegationService({
  workspaceDirForAgent: () => process.cwd(),
  isModelAvailable: () => true,
});
const started = await service.createAndStart({
  parentChatId: parent.id,
  sourceKind: 'text',
  taskText: 'shutdown acceptance run',
  executor: { transport: 'testfake', model: 'testfake/test' },
  idempotencyKey: crypto.randomUUID(),
});
assert.equal(started.ok, true);
const running = started.delegation;
patchMockChatRun(running.childChatId, { busy: false, waitingForInput: false });
updateDelegationRecord(running.id, {
  status: 'running',
  runStoppingAt: new Date().toISOString(),
});

const cancelling = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: crypto.randomUUID(),
  workspaceFolder: process.cwd(),
  executor: { transport: 'testfake', model: 'testfake/test' },
  status: 'cancelling',
  runId: 'cancelling-run',
});
const durable = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: crypto.randomUUID(),
  workspaceFolder: process.cwd(),
  executor: { transport: 'testfake', model: 'testfake/test' },
  status: 'running',
  runId: 'durable-run',
});
updateDelegationRecord(durable.id, {
  finalReportAttemptId: durable.attemptId,
  finalReportAcceptedAt: new Date().toISOString(),
});
const starting = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: crypto.randomUUID(),
  workspaceFolder: process.cwd(),
  executor: { transport: 'testfake', model: 'testfake/test' },
  status: 'starting',
  runId: '',
});

const firstShutdown = await shutdownDelegationRuntime({ timeoutMs: 1000 });
assert.equal(firstShutdown.ok, true);
const interrupted = getDelegationById(running.id);
assert.equal(interrupted.status, 'interrupted');
assert.equal(interrupted.interruptCode, 'server_restart');
assert.ok(interrupted.finishedAt);
assert.equal(inspectDelegationSlot(interrupted).occupied, false);
assert.deepEqual(
  (interrupted.outbox || []).map((item) => item.type).sort(),
  ['history', 'mailbox'],
);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(((await loadChatHistory(parent.id))?.events || []).some((event) => {
  const payload = JSON.parse(event.rec?.payload || '{}');
  return payload.id === running.id && payload.status === 'interrupted';
}), true);
const interruptedSnapshot = JSON.stringify(getDelegationById(running.id));
assert.equal(getDelegationById(cancelling.id).status, 'cancelling');
assert.equal(getDelegationById(durable.id).status, 'running');
assert.equal(getDelegationById(starting.id).acceptState, 'uncertain');

const secondShutdown = await shutdownDelegationRuntime({ timeoutMs: 1000 });
assert.equal(secondShutdown.ok, true);
assert.equal(JSON.stringify(getDelegationById(running.id)), interruptedSnapshot);

console.log('delegation-shutdown-restart.test.js OK');
