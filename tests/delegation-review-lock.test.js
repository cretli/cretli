import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  bindRoomToDelegation,
  noteDelegationRoomEvent,
  syncRoomDelegationAssignment,
} from '../lib/delegation-run-bridge.js';
import { resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.js';

const parent = addChat('sess-review-lock-parent', 'Parent', null, '/tmp', 'model', {
  agentTransport: 'codex',
  sdkMode: 'agent',
});
const child = addChat('sess-review-lock-child', 'Child (review)', null, '/tmp', 'model', {
  agentTransport: 'codex',
  sdkMode: 'agent',
  forkParentChatId: parent.id,
  forkKind: 'delegation',
  delegationParentChatId: parent.id,
  delegationAssignment: 'review',
});
const job = createDelegationRecord({
  parentChatId: parent.id,
  childChatId: child.id,
  status: 'running',
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  taskText: 'Review only.',
});

const room = {
  chatId: child.id,
  delegationAssignment: '',
  sdkMode: 'agent',
};
bindRoomToDelegation(room, {
  delegationId: job.id,
  attemptId: job.attemptId,
  assignment: 'review',
});
assert.equal(room.delegationAssignment, 'review');
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'agent',
    assignment: room.delegationAssignment,
    toolName: 'shell',
    input: { command: 'python3 -c "open(\'x\',\'w\').write(\'a\')"' },
  }).deny,
  true,
);

updateDelegationRecord(job.id, { status: 'completed' });
assert.equal(syncRoomDelegationAssignment(room), '');
assert.equal(room.delegationAssignment, '');
assert.equal(
  loadChats().find((row) => row.id === child.id)?.delegationAssignment,
  undefined,
);
assert.equal(
  resolvePlanModeToolDecision({
    transport: 'codex',
    mode: 'agent',
    assignment: room.delegationAssignment,
    toolName: 'shell',
    input: { command: 'python3 -c "open(\'x\',\'w\').write(\'a\')"' },
  }).deny,
  false,
);

const sticky = {
  chatId: child.id,
  delegationId: job.id,
  delegationAssignment: 'review',
};
noteDelegationRoomEvent(sticky, { type: 'sdkRunFinished', status: 'completed', runId: 'follow-up' });
assert.equal(sticky.delegationAssignment, '');

console.log('delegation-review-lock.test.js OK');
