import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { isIncompleteDelegationReport } from '../lib/delegation-verdict.js';
import { resolveOpenCodeApprovalAction } from '../lib/opencode/opencode-permission.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';

resetMockChatRuns();
registerMockChatRunAdapter('sdk');

assert.equal(isIncompleteDelegationReport(''), true);
assert.equal(isIncompleteDelegationReport('I will start by exploring the workspace.'), true);
assert.equal(
  isIncompleteDelegationReport('I\'llstartbygettingorientedintherepoandlocatingthefilesnamedinthelockedplan.'.repeat(8)),
  true,
);
assert.equal(isIncompleteDelegationReport('Looks good.\nVERDICT: PASS'), false);

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-incomplete-report-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});

async function startReview(title, key) {
  const parent = addChat(`sess-${key}`, title, null, project, 'planner-model', {
    agentTransport: 'sdk',
    sdkMode: 'agent',
  });
  writeChatPlanFile({ cwd: project, chatId: parent.id, markdown: '# Plan\nDo the thing.' });
  const started = await service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'sdk', model: 'sdk/test' },
    assignment: 'review',
    planRevision: readChatPlanDocument({ cwd: project, chatId: parent.id }).revision,
    idempotencyKey: key,
  });
  assert.equal(started.ok, true, started.error || '');
  return started;
}

const started = await startReview('Incomplete report parent', 'incomplete-review-1');
assert.equal(started.delegation.assignment, 'review');
await noteDelegationRoomEvent({
  chatId: started.delegation.childChatId,
  delegationId: started.delegation.id,
  delegationAttemptId: started.delegation.attemptId,
  _currentRunAssistantText: 'I will start by exploring the workspace.',
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: started.delegation.runId,
});
const finished = getDelegationById(started.delegation.id);
assert.equal(finished.status, 'failed');
assert.match(String(finished.error || ''), /adapter_incomplete/);

const passJob = await startReview('Complete review parent', 'incomplete-review-pass');
await noteDelegationRoomEvent({
  chatId: passJob.delegation.childChatId,
  delegationId: passJob.delegation.id,
  delegationAttemptId: passJob.delegation.attemptId,
  _currentRunAssistantText: 'Checked the send path.\nTASK: review\nVERDICT: PASS',
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: passJob.delegation.runId,
});
assert.equal(getDelegationById(passJob.delegation.id).status, 'completed');

const waitingJob = await startReview('Waiting approver parent', 'incomplete-review-wait');
const waitingRoom = {
  chatId: waitingJob.delegation.childChatId,
  delegationId: waitingJob.delegation.id,
  delegationAttemptId: waitingJob.delegation.attemptId,
  _currentRunAssistantText: 'I will start by exploring the workspace.',
  _pendingOpenCodeQuestions: new Map([['q1', { type: 'opencode_question', requestId: 'q1' }]]),
};
await noteDelegationRoomEvent(waitingRoom, {
  type: 'sdkEvent',
  event: { type: 'opencode_question', requestId: 'q1' },
  runId: waitingJob.delegation.runId,
});
assert.equal(getDelegationById(waitingJob.delegation.id).status, 'waiting_for_input');
await noteDelegationRoomEvent(waitingRoom, {
  type: 'sdkRunFinished',
  status: 'error',
  lastErrorMessage: 'session idle',
  runId: waitingJob.delegation.runId,
});
const stillWaiting = getDelegationById(waitingJob.delegation.id);
assert.equal(stillWaiting.status, 'waiting_for_input');
assert.equal(String(stillWaiting.error || ''), '');

updateDelegationRecord(waitingJob.delegation.id, { status: 'running' });
await noteDelegationRoomEvent({
  ...waitingRoom,
  _pendingOpenCodeQuestions: new Map(),
  _currentRunAssistantText: 'I will start by exploring the workspace.',
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: waitingJob.delegation.runId,
});
const incompleteAfterAsk = getDelegationById(waitingJob.delegation.id);
assert.equal(incompleteAfterAsk.status, 'failed');
assert.match(String(incompleteAfterAsk.error || ''), /adapter_incomplete/);

// A broker `ask_user` decision (MVP local policy) must keep the job in
// waiting_for_input, not finish it as adapter_incomplete when the harness goes
// idle while the permission card is still pending.
const brokerDecision = resolveOpenCodeApprovalAction({
  mode: 'local_reads',
  sdkMode: 'agent',
  permissionEvent: { action: 'edit', resources: ['src/app.js'] },
  assignment: 'implement',
  workspaceFolder: process.cwd(),
});
assert.equal(brokerDecision.decision, 'ask_user');
assert.equal(brokerDecision.reply, null);

const brokerJob = await startReview('Broker wait parent', 'incomplete-review-broker-wait');
const brokerRoom = {
  chatId: brokerJob.delegation.childChatId,
  delegationId: brokerJob.delegation.id,
  delegationAttemptId: brokerJob.delegation.attemptId,
  delegationAssignment: 'implement',
  _currentRunAssistantText: '',
  _pendingOpenCodePermissions: new Map([[
    'per_broker_1',
    { type: 'opencode_permission', requestId: 'per_broker_1', action: 'edit' },
  ]]),
};
await noteDelegationRoomEvent(brokerRoom, {
  type: 'sdkEvent',
  event: { type: 'opencode_permission', requestId: 'per_broker_1', action: 'edit' },
  runId: brokerJob.delegation.runId,
});
const brokerWaiting = getDelegationById(brokerJob.delegation.id);
assert.equal(brokerWaiting.status, 'waiting_for_input');
await noteDelegationRoomEvent(brokerRoom, {
  type: 'sdkRunFinished',
  status: 'error',
  lastErrorMessage: 'session idle',
  runId: brokerJob.delegation.runId,
});
const brokerStillWaiting = getDelegationById(brokerJob.delegation.id);
assert.equal(brokerStillWaiting.status, 'waiting_for_input');
assert.equal(String(brokerStillWaiting.error || ''), '');
assert.equal(String(brokerStillWaiting.error || '').includes('adapter_incomplete'), false);

console.log('delegation-adapter-incomplete.test.js OK');
