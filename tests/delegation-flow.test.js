import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import {
  createDelegationService,
  finishDelegation,
  reconcileDelegationsOnBoot,
} from '../lib/delegation-service.js';
import { isActiveDelegationStatus } from '../lib/delegation-status.js';
import { listDelegationsForParent } from '../lib/persist/delegations-persist.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
  getMockChatRun,
  patchMockChatRun,
  setMockChatRunFailCancel,
} from '../lib/chat-run/mock-adapter.js';
import {
  listUndeliveredDelegationReports,
  markDelegationReportsDelivered,
  collectDelegationReportsForPrompt,
  markDelegationReportsDeliveredByIds,
} from '../lib/delegation-report-context.js';
import { loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { parseDelegationCommand } from '../lib/delegation-command.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-delegation-ws-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: ({ model }) => model !== 'missing-model',
});

assert.equal(parseDelegationCommand('/wykonaj')?.command, 'execute');
assert.equal(parseDelegationCommand('/execute now').extraInstructions, 'now');
assert.equal(parseDelegationCommand('please /wykonaj'), null);
assert.equal(parseDelegationCommand('```\n/wykonaj\n```'), null);

function createParent(title) {
  const chat = addChat(`sess-${title}`, title, null, project, 'planner-model', {
    agentTransport: 'opencode',
    sdkMode: 'plan',
  });
  writeChatPlanFile({
    cwd: project,
    chatId: chat.id,
    title,
    markdown: `# ${title}\n\n- step one\n- step two`,
    sourceTurnId: 'turn-1',
  });
  return chat;
}

const parent = createParent('Planner');
const planDoc = readChatPlanDocument({ cwd: project, chatId: parent.id });
const first = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: planDoc.revision,
  idempotencyKey: 'idem-1',
});
assert.equal(first.ok, true);
assert.ok(first.delegation.childChatId);
assert.match(first.delegation.planMarkdown, /Planner/);
assert.equal(getMockChatRun(first.delegation.childChatId)?.hold, true);

const replayed = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'opencode', model: 'other' },
  planRevision: planDoc.revision,
  idempotencyKey: 'idem-1',
});
assert.equal(replayed.delegation.id, first.delegation.id);
assert.equal(loadChats().filter((row) => row.delegationParentChatId === parent.id).length, 1);

const parent2 = createParent('Planner 2');
const stale = await service.createAndStart({
  parentChatId: parent2.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: 99,
  idempotencyKey: 'idem-stale',
});
assert.equal(stale.ok, false);
assert.equal(stale.code, 'plan_revision_conflict');

const missingModel = await service.createAndStart({
  parentChatId: parent2.id,
  executor: { transport: 'opencode', model: 'missing-model' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent2.id }).revision,
  idempotencyKey: 'idem-missing',
});
assert.equal(missingModel.ok, false);
assert.equal(missingModel.code, 'model_unavailable');

const [left, right] = await Promise.all([
  service.createAndStart({
    parentChatId: parent2.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    planRevision: readChatPlanDocument({ cwd: project, chatId: parent2.id }).revision,
    idempotencyKey: 'idem-race',
  }),
  service.createAndStart({
    parentChatId: parent2.id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    planRevision: readChatPlanDocument({ cwd: project, chatId: parent2.id }).revision,
    idempotencyKey: 'idem-race',
  }),
]);
assert.equal(left.ok && right.ok, true);
assert.equal(left.delegation.id, right.delegation.id);
assert.equal(listDelegationsForParent(parent2.id).length, 1);

const parent3 = createParent('Planner 3');
const started = await service.createAndStart({
  parentChatId: parent3.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent3.id }).revision,
  idempotencyKey: 'idem-ok3',
});
assert.equal(started.ok, true);
finishDelegation(started.delegation, {
  status: 'completed',
  report: 'Raised the toolbar and ran unit tests.',
});
const again = finishDelegation(started.delegation, {
  status: 'completed',
  report: 'duplicate',
});
assert.match(again.report, /Raised the toolbar/);
const history = loadChatHistory(parent3.id);
const delegationEvents = (history?.events || []).filter((row) => row.rec?.variant === 'delegation');
assert.equal(delegationEvents.length >= 1, true);
assert.equal(listUndeliveredDelegationReports(parent3.id).length, 1);
markDelegationReportsDelivered(parent3.id);
assert.equal(listUndeliveredDelegationReports(parent3.id).length, 0);
markDelegationReportsDelivered(parent3.id);
assert.equal(listUndeliveredDelegationReports(parent3.id).length, 0);

const parent4 = createParent('Planner 4');
const running = await service.createAndStart({
  parentChatId: parent4.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent4.id }).revision,
  idempotencyKey: 'idem-cancel',
});
await service.cancel(running.delegation.id);
assert.equal(getMockChatRun(running.delegation.childChatId)?.cancelled, true);
assert.equal(listDelegationsForParent(parent4.id)[0].status, 'cancelled');

const parent5 = createParent('Planner 5');
const waitingJob = await service.createAndStart({
  parentChatId: parent5.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent5.id }).revision,
  idempotencyKey: 'idem-wait',
});
patchMockChatRun(waitingJob.delegation.childChatId, { waitingForInput: true, busy: true });
reconcileDelegationsOnBoot();
assert.notEqual(listDelegationsForParent(parent5.id)[0].status, 'interrupted');

const parent6 = createParent('Planner 6');
const staleJob = await service.createAndStart({
  parentChatId: parent6.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent6.id }).revision,
  idempotencyKey: 'idem-boot',
});
patchMockChatRun(staleJob.delegation.childChatId, { busy: false, waitingForInput: false });
reconcileDelegationsOnBoot();
assert.equal(listDelegationsForParent(parent6.id)[0].status, 'interrupted');
assert.notEqual(listDelegationsForParent(parent5.id)[0].status, 'interrupted');

const parent3Finished = listDelegationsForParent(parent3.id)[0];
assert.ok(String(parent3Finished.historyDeliveredAt || '').trim());
const finishedBeforeRetry = (loadChatHistory(parent3.id)?.events || []).filter((row) => {
  if (row.rec?.variant !== 'delegation') return false;
  const data = JSON.parse(row.rec.payload);
  return data.event === 'finished';
}).length;
updateDelegationRecord(parent3Finished.id, { historyDeliveredAt: '' });
reconcileDelegationsOnBoot();
const parent3AfterRetry = listDelegationsForParent(parent3.id)[0];
assert.ok(String(parent3AfterRetry.historyDeliveredAt || '').trim());
const finishedAfterRetry = (loadChatHistory(parent3.id)?.events || []).filter((row) => {
  if (row.rec?.variant !== 'delegation') return false;
  const data = JSON.parse(row.rec.payload);
  return data.event === 'finished';
}).length;
assert.equal(finishedAfterRetry, finishedBeforeRetry);

const parent7 = createParent('Planner 7');
const firstDone = await service.createAndStart({
  parentChatId: parent7.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent7.id }).revision,
  idempotencyKey: 'idem-retry-a',
});
finishDelegation(firstDone.delegation, { status: 'completed', report: 'first report' });
const secondActive = await service.createAndStart({
  parentChatId: parent7.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent7.id }).revision,
  idempotencyKey: 'idem-retry-b',
});
assert.equal(secondActive.ok, true);
const retryBlocked = await service.retry(firstDone.delegation.id);
assert.equal(retryBlocked.ok, false);
assert.equal(retryBlocked.code, 'parent_busy');
assert.equal(isActiveDelegationStatus(listDelegationsForParent(parent7.id).find((row) => row.id === secondActive.delegation.id)?.status), true);

const parent8 = createParent('Planner 8');
const cancelPending = await service.createAndStart({
  parentChatId: parent8.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent8.id }).revision,
  idempotencyKey: 'idem-cancel-fail',
});
setMockChatRunFailCancel(true);
const cancelResult = await service.cancel(cancelPending.delegation.id);
assert.equal(cancelResult.status, 202);
assert.equal(cancelResult.pending, true);
assert.equal(listDelegationsForParent(parent8.id)[0].status, 'cancelling');
assert.notEqual(listDelegationsForParent(parent8.id)[0].status, 'cancelled');
finishDelegation(listDelegationsForParent(parent8.id)[0], {
  status: 'completed',
  report: 'Executor finished after stop was requested.',
});
assert.equal(listDelegationsForParent(parent8.id)[0].status, 'completed');

const parent9 = createParent('Planner 9');
const reportA = await service.createAndStart({
  parentChatId: parent9.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent9.id }).revision,
  idempotencyKey: 'idem-report-a',
});
finishDelegation(reportA.delegation, { status: 'completed', report: 'alpha' });
const reportB = await service.createAndStart({
  parentChatId: parent9.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent9.id }).revision,
  idempotencyKey: 'idem-report-b',
});
finishDelegation(reportB.delegation, { status: 'completed', report: 'beta' });
const snapshot = collectDelegationReportsForPrompt(parent9.id);
assert.equal(snapshot.ids.length, 2);
const later = await service.createAndStart({
  parentChatId: parent9.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent9.id }).revision,
  idempotencyKey: 'idem-report-c',
});
finishDelegation(later.delegation, { status: 'completed', report: 'gamma during send' });
markDelegationReportsDeliveredByIds(snapshot.ids);
const remaining = listUndeliveredDelegationReports(parent9.id);
assert.equal(remaining.length, 1);
assert.equal(remaining[0].id, later.delegation.id);

const parent10 = createParent('Planner 10');
const waitingPub = await service.createAndStart({
  parentChatId: parent10.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent10.id }).revision,
  idempotencyKey: 'idem-wait-pub',
});
noteDelegationRoomEvent({
  delegationId: waitingPub.delegation.id,
  delegationAttemptId: waitingPub.delegation.attemptId,
}, {
  type: 'sdkEvent',
  runId: waitingPub.delegation.runId,
  event: { type: 'tool_call', name: 'AskQuestion' },
});
assert.equal(listDelegationsForParent(parent10.id)[0].status, 'waiting_for_input');
const waitingEvents = (loadChatHistory(parent10.id)?.events || []).filter((row) => {
  if (row.rec?.variant !== 'delegation') return false;
  const data = JSON.parse(row.rec.payload);
  return data.event === 'waiting_for_input';
});
assert.equal(waitingEvents.length, 1);

const parent11 = createParent('Planner 11');
const ackJob = await service.createAndStart({
  parentChatId: parent11.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent11.id }).revision,
  idempotencyKey: 'idem-ack',
});
noteDelegationRoomEvent({
  delegationId: ackJob.delegation.id,
  delegationAttemptId: ackJob.delegation.attemptId,
}, {
  type: 'sdkEvent',
  runId: ackJob.delegation.runId,
  event: { type: 'tool_call', name: 'AskQuestion' },
});
const openAck = service.acknowledge(ackJob.delegation.id, { reason: 'open_child' });
assert.equal(openAck.ok, true);
assert.ok(openAck.delegation.acknowledgedAt);
finishDelegation(openAck.delegation, { status: 'completed', report: 'done' });
const afterFinish = listDelegationsForParent(parent11.id)[0];
assert.equal(afterFinish.status, 'completed');
assert.equal(afterFinish.acknowledgedAt, '');
const reviewed = service.acknowledge(afterFinish.id, { reason: 'reviewed' });
assert.equal(reviewed.ok, true);
assert.equal(reviewed.delegation.unverified, false);
assert.ok(reviewed.delegation.acknowledgedAt);
const skipOpen = service.acknowledge(afterFinish.id, { reason: 'open_child' });
assert.equal(skipOpen.skipped, true);

const parent12 = createParent('Planner 12');
const deleteJob = await service.createAndStart({
  parentChatId: parent12.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: parent12.id }).revision,
  idempotencyKey: 'idem-delete',
});
const cancelledDelete = await service.cancelForDeletedChat(deleteJob.delegation.childChatId);
assert.equal(cancelledDelete.ok, true);
assert.equal(listDelegationsForParent(parent12.id)[0].status, 'cancelled');

rmSync(project, { recursive: true, force: true });
console.log('delegation-flow.test.js OK');
