import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';
import { createDelegationService } from '../lib/delegation-service.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');

const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  dataDir: ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});

function start(parentChatId, leafId, model) {
  return service.createAndStart({
    parentChatId,
    sourceKind: 'text',
    taskText: 'independent review',
    executor: { transport: 'testfake', model },
    idempotencyKey: randomUUID(),
    executionMode: 'agent',
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    returnWhenStarting: false,
  });
}

test('createAndStart rejects a same-model code review at once, before the verify wait', async () => {
  const parent = addChat(randomUUID(), 'orch', null, ISOLATED_DATA_DIR, 'testfake/orchestrator', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const leafId = randomUUID();
  const impl = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: randomUUID(),
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status: 'completed',
    leafId,
  });
  // A fresh pending host verify: the verify gate would wait for it.
  updateDelegationRecord(impl.id, { verifyPending: { since: new Date().toISOString(), revision: 'rev-1' } });

  const t0 = Date.now();
  const res = await start(parent.id, leafId, 'testfake/test');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'review_not_independent');
  assert.ok(Date.now() - t0 < 5000, `rejected after ${Date.now() - t0}ms; the verify wait must not run first`);
});

test('createAndStart rejects a code review on the orchestrator base model', async () => {
  const parent = addChat(randomUUID(), 'orch2', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const res = await start(parent.id, randomUUID(), 'testfake/test');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'review_not_independent');
});
