/**
 * Review delegations run the child in SDK agent mode (read-capable tool
 * surface) while the prompt keeps the reviewer role. Records saved before the
 * assignment field existed must upgrade on retry instead of resuming Plan
 * mode, and an idempotent replay must not create a second job.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { getDelegationById, listDelegationsForParent, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
  getMockChatRun,
  patchMockChatRun,
} from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-review-upgrade-ws-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
  dataDir: project,
});

function createParent(id, title) {
  return addChat(id, title, null, project, 'planner-model', {
    agentTransport: 'opencode',
    sdkMode: 'plan',
  });
}

const parent = createParent('sess-review-upgrade', 'Planner review upgrade');
const created = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  sourceKind: 'text',
  taskText: 'Verify the delegation review path.',
  executionMode: 'plan',
  idempotencyKey: 'review-upgrade-key',
});
assert.equal(created.ok, true);
assert.equal(created.delegation.assignment, 'review');
assert.equal(created.delegation.executionMode, 'agent');
assert.equal(getMockChatRun(created.delegation.childChatId)?.mode, 'agent');
assert.match(getMockChatRun(created.delegation.childChatId)?.prompt || '', /You are the reviewer/);

// Backdate the persisted record the way it looked before the assignment field.
updateDelegationRecord(created.delegation.id, { executionMode: 'plan', assignment: '' });
finishDelegation(getDelegationById(created.delegation.id), { status: 'completed', report: 'old done' });
patchMockChatRun(created.delegation.childChatId, { busy: false, waitingForInput: false });

const retried = await service.retry(created.delegation.id);
assert.equal(retried.ok, true);
assert.equal(retried.delegation.assignment, 'review');
assert.equal(retried.delegation.executionMode, 'agent');
assert.equal(getMockChatRun(created.delegation.childChatId)?.mode, 'agent');
assert.match(getMockChatRun(created.delegation.childChatId)?.prompt || '', /You are the reviewer/);

// An idempotent replay without assignment/execution_mode still matches while the
// parent stays in Plan and must not start a second job.
const parent2 = createParent('sess-review-idem', 'Planner review idem');
const first = await service.createAndStart({
  parentChatId: parent2.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  sourceKind: 'text',
  taskText: 'Idempotent review.',
  executionMode: 'plan',
  idempotencyKey: 'review-idem-key',
});
assert.equal(first.ok, true);
const replay = await service.createAndStart({
  parentChatId: parent2.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  sourceKind: 'text',
  taskText: 'Idempotent review.',
  idempotencyKey: 'review-idem-key',
});
assert.equal(replay.ok, true);
assert.equal(replay.replayed, true);
assert.equal(replay.delegation.id, first.delegation.id);
assert.equal(listDelegationsForParent(parent2.id).length, 1);

// An explicit implement assignment in Plan mode is not silently turned into a
// review: the caller asked for the child to stay in Plan.
const parent3 = createParent('sess-review-explicit', 'Planner explicit implement');
const explicit = await service.createAndStart({
  parentChatId: parent3.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  sourceKind: 'text',
  taskText: 'Implement even though the parent is in Plan.',
  executionMode: 'plan',
  assignment: 'implement',
  idempotencyKey: 'implement-plan-key',
});
assert.equal(explicit.ok, true);
assert.equal(explicit.delegation.assignment, 'implement');
assert.equal(explicit.delegation.executionMode, 'plan');
assert.equal(getMockChatRun(explicit.delegation.childChatId)?.mode, 'plan');
assert.doesNotMatch(getMockChatRun(explicit.delegation.childChatId)?.prompt || '', /You are the reviewer/);

console.log('delegation-review-upgrade.test.js OK');
