import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { addChat, loadChats, updateChat } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents, loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { writeChatPlanFile, readChatPlanDocument } from '../lib/chat-plan-persist.js';
import { hashDelegationContent } from '../lib/delegation-request.js';
import { collectDelegationReportsForPrompt, markDelegationReportReadByParent } from '../lib/delegation-report-context.js';
import { createDelegationService, finishDelegation, reconcileDelegationsOnBoot } from '../lib/delegation-service.js';
import {
  createMailboxMessage,
  findMailboxReplyForDelegation,
  getMailboxDataPath,
  listQueuedMailboxForRecipient,
  loadMailboxMessages,
} from '../lib/persist/delegation-mailbox-persist.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { DELEGATION_RUNNING_ORPHAN_GRACE_MS } from '../lib/delegation-status.js';
import { drainChatMailbox, ensureDelegationParentMailboxReply, listChatMailbox, retryMailboxMessage, sendDelegationReply } from '../lib/delegation-mailbox.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { startChatRun } from '../lib/chat-run-service.js';
import fs from 'node:fs';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
  getMockChatRun,
  getMockChatRunStartCount,
  patchMockChatRun,
  setMockChatRunFailStart,
} from '../lib/chat-run/mock-adapter.js';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
registerMockChatRunAdapter('sdk');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-mailbox-ws-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});

function createParent(title, transport = 'opencode') {
  return addChat(`sess-${title}-${Math.random().toString(16).slice(2)}`, title, null, project, 'planner-model', {
    agentTransport: transport,
    sdkMode: 'plan',
  });
}

function seedUserMessage(chatId, text) {
  const createdAt = '2026-01-02T10:00:00.000Z';
  const result = appendChatHistoryEvents(chatId, '', [
    { rec: { kind: 'localUser', text, createdAt } },
  ]);
  assert.equal(result.ok, true);
  return result.appended[0];
}

const parent = createParent('Planner mailbox');
const seeded = seedUserMessage(parent.id, 'Raise the toolbar and keep the footer pinned.');
const taskHash = hashDelegationContent('Raise the toolbar and keep the footer pinned.');
const started = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  sourceKind: 'message',
  historySeq: seeded.seq,
  contentHash: taskHash,
  executionMode: 'plan',
  idempotencyKey: 'msg-1',
});
assert.equal(started.ok, true);
assert.equal(started.delegation.sourceKind, 'message');
assert.match(started.delegation.sourceText, /toolbar/);
assert.equal(started.delegation.parentChatId, parent.id);
assert.equal(started.delegation.assignment, 'review');
assert.equal(started.delegation.executionMode, 'agent');
assert.equal(getMockChatRun(started.delegation.childChatId)?.mode, 'agent');
const child = loadChats().find((row) => row.id === started.delegation.childChatId);
assert.ok(child);
assert.equal(child.delegationParentChatId, parent.id);
assert.equal(child.agentTransport, 'sdk');
assert.match(getMockChatRun(child.id)?.prompt || '', /TASK/);
assert.ok((getMockChatRun(child.id)?.prompt || '').includes(parent.id));

const replayed = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  sourceKind: 'message',
  historySeq: seeded.seq,
  contentHash: taskHash,
  executionMode: 'plan',
  idempotencyKey: 'msg-1',
});
assert.equal(replayed.ok, true);
assert.equal(replayed.delegation.id, started.delegation.id);
assert.equal(loadChats().filter((row) => row.delegationParentChatId === parent.id).length, 1);

const idemConflict = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'opencode', model: 'other' },
  sourceKind: 'message',
  historySeq: seeded.seq,
  contentHash: taskHash,
  executionMode: 'plan',
  idempotencyKey: 'msg-1',
});
assert.equal(idemConflict.ok, false);
assert.equal(idemConflict.code, 'idempotency_conflict');

const activeConflict = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  sourceKind: 'message',
  historySeq: seeded.seq,
  contentHash: taskHash,
  assignment: 'implement',
  executionMode: 'agent',
  idempotencyKey: 'msg-other-key',
});
assert.equal(activeConflict.ok, false);
assert.equal(activeConflict.code, 'active_delegation_exists');
assert.equal(activeConflict.id, started.delegation.id);

const snapshotOnly = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  sourceKind: 'message',
  textSnapshot: 'invented text',
  idempotencyKey: 'msg-snap',
});
assert.equal(snapshotOnly.ok, false);
assert.equal(snapshotOnly.code, 'source_required');

const changedHash = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  sourceKind: 'message',
  historySeq: seeded.seq,
  contentHash: '0'.repeat(64),
  idempotencyKey: 'msg-changed',
});
assert.equal(changedHash.ok, false);
assert.equal(changedHash.code, 'source_changed');

updateChat(child.id, { forkParentChatId: null });
const regrouped = loadChats().find((row) => row.id === child.id);
assert.equal(regrouped.forkParentChatId, undefined);
assert.equal(regrouped.delegationParentChatId, parent.id);

const reply = await sendDelegationReply({
  fromChatId: child.id,
  body: 'Toolbar is raised. Tests passed.',
  historySeq: 0,
  idempotencyKey: 'reply-1',
});
assert.equal(reply.ok, true);
assert.equal(reply.message.toChatId, parent.id);
assert.equal(reply.message.kind, 'reply');
assert.equal(reply.message.status, 'delivered');
assert.match(getMockChatRun(parent.id)?.prompt || '', /CHILD REPLY/);
assert.equal(parent.sdkMode, 'plan');
assert.equal(loadChats().find((row) => row.id === parent.id)?.sdkMode, 'plan');

const replyAgain = await sendDelegationReply({
  fromChatId: child.id,
  body: 'duplicate',
  idempotencyKey: 'reply-1',
});
assert.equal(replyAgain.ok, false);
assert.equal(replyAgain.code, 'idempotency_conflict');
assert.equal(listChatMailbox(parent.id).filter((row) => row.kind === 'reply').length, 1);

const parentBusy = createParent('Busy parent');
const seededBusy = seedUserMessage(parentBusy.id, 'Do the other task.');
await startChatRun({ chatId: parentBusy.id, prompt: 'already working', mode: 'plan' });
const childBusyJob = await service.createAndStart({
  parentChatId: parentBusy.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  sourceKind: 'message',
  historySeq: seededBusy.seq,
  textSnapshot: 'Do the other task.',
  idempotencyKey: 'msg-busy',
});
assert.equal(childBusyJob.ok, true);
const queuedReply = await sendDelegationReply({
  fromChatId: childBusyJob.delegation.childChatId,
  body: 'Child finished while parent was busy.',
  idempotencyKey: 'reply-busy',
});
assert.equal(queuedReply.message.status, 'queued');
assert.equal(queuedReply.message.delivery, 'queued_for_idle');
assert.equal(listQueuedMailboxForRecipient(parentBusy.id).length, 1);

patchMockChatRun(parentBusy.id, { busy: false, waitingForInput: false });
const drained = await drainChatMailbox(parentBusy.id);
assert.equal(drained[0]?.status, 'delivered');
assert.equal(listQueuedMailboxForRecipient(parentBusy.id).length, 0);

const parentWait = createParent('Waiting parent');
const seededWait = seedUserMessage(parentWait.id, 'Wait task.');
const waitJob = await service.createAndStart({
  parentChatId: parentWait.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  sourceKind: 'message',
  historySeq: seededWait.seq,
  textSnapshot: 'Wait task.',
  idempotencyKey: 'msg-wait',
});
await startChatRun({ chatId: parentWait.id, prompt: 'need input', mode: 'plan' });
patchMockChatRun(parentWait.id, { waitingForInput: true, busy: true });
const waitingReply = await sendDelegationReply({
  fromChatId: waitJob.delegation.childChatId,
  body: 'Should stay queued while parent waits for the user.',
  idempotencyKey: 'reply-wait',
});
assert.equal(waitingReply.message.status, 'queued');
noteDelegationRoomEvent({ chatId: parentWait.id }, { type: 'sdkRunFinished', status: 'completed' });
assert.equal(listQueuedMailboxForRecipient(parentWait.id).length, 1);
patchMockChatRun(parentWait.id, { waitingForInput: false, busy: false });
await drainChatMailbox(parentWait.id);
assert.equal(listQueuedMailboxForRecipient(parentWait.id).length, 0);

const parentHistory = loadChatHistory(parent.id);
const mailboxEvents = (parentHistory?.events || []).filter((row) => row.rec?.variant === 'mailbox');
assert.equal(mailboxEvents.length >= 1, true);
const firstMailbox = JSON.parse(mailboxEvents[0].rec.payload);
assert.equal(typeof firstMailbox.fromTitle, 'string');
assert.ok(firstMailbox.fromTitle.length > 0);

const busyHistory = loadChatHistory(parentBusy.id);
const busyMailbox = (busyHistory?.events || []).filter((row) => row.rec?.variant === 'mailbox');
assert.equal(busyMailbox.length >= 2, true);
const busyStatuses = busyMailbox.map((row) => JSON.parse(row.rec.payload).status);
assert.equal(busyStatuses.includes('queued'), true);
assert.equal(busyStatuses.includes('delivered'), true);

finishDelegation(started.delegation, { status: 'completed', report: 'child done' });
assert.equal(collectDelegationReportsForPrompt(parent.id).ids.length, 0);

const yesReply = await sendDelegationReply({
  fromChatId: child.id,
  body: 'yes\nimplement',
  idempotencyKey: 'reply-yes',
});
assert.equal(yesReply.ok, true);
assert.equal(loadChats().find((row) => row.id === parent.id)?.sdkMode, 'plan');

const foreign = createParent('Foreign child host');
const spoof = await sendDelegationReply({
  fromChatId: foreign.id,
  body: 'spoof',
  delegationId: started.delegation.id,
  idempotencyKey: 'spoof-child',
});
assert.equal(spoof.ok, false);
assert.equal(spoof.code, 'not_child');

const raceParent = createParent('Race parent');
createMailboxMessage({
  fromChatId: child.id,
  toChatId: raceParent.id,
  kind: 'reply',
  body: 'queued then raced',
  status: 'queued',
});
const [userTurn, drainTurn] = await Promise.all([
  startChatRun({ chatId: raceParent.id, prompt: 'user send', mode: 'plan' }).catch((err) => err),
  drainChatMailbox(raceParent.id),
]);
const userOk = userTurn && !userTurn.code;
const drainDelivered = Array.isArray(drainTurn) && drainTurn.some((row) => row.status === 'delivered');
assert.equal(userOk && drainDelivered, false);
assert.equal(!!(userOk || drainDelivered), true);

const bootQueuedParent = createParent('Boot queued');
const bootMsg = createMailboxMessage({
  fromChatId: child.id,
  toChatId: bootQueuedParent.id,
  kind: 'reply',
  body: 'deliver once after boot',
  status: 'queued',
});
await reconcileDelegationsOnBoot();
assert.equal(listQueuedMailboxForRecipient(bootQueuedParent.id).length, 0);
assert.equal(loadMailboxMessages().find((row) => row.id === bootMsg.id)?.status, 'delivered');

const deliveredKeep = createMailboxMessage({
  fromChatId: child.id,
  toChatId: bootQueuedParent.id,
  kind: 'reply',
  body: 'already delivered',
  status: 'delivered',
  recipientRunId: 'run-keep',
});
const before = loadMailboxMessages().filter((row) => row.toChatId === bootQueuedParent.id && row.status === 'delivered').length;
await reconcileDelegationsOnBoot();
const after = loadMailboxMessages().filter((row) => row.toChatId === bootQueuedParent.id && row.status === 'delivered').length;
assert.equal(after, before);
assert.equal(loadMailboxMessages().find((row) => row.id === deliveredKeep.id)?.recipientRunId, 'run-keep');

const dispatchingUnknown = createMailboxMessage({
  fromChatId: child.id,
  toChatId: createParent('Uncertain boot').id,
  kind: 'reply',
  body: 'dispatching without run id',
  status: 'dispatching',
});
await reconcileDelegationsOnBoot();
assert.equal(loadMailboxMessages().find((row) => row.id === dispatchingUnknown.id)?.status, 'uncertain');

const failedRow = createMailboxMessage({
  fromChatId: child.id,
  toChatId: createParent('Retry target').id,
  kind: 'reply',
  body: 'retry me',
  status: 'failed',
  error: 'boom',
});
const retried = await retryMailboxMessage(failedRow.id);
assert.equal(retried.ok, true);
assert.equal(retried.message.status, 'delivered');

const uncertainRetryRow = createMailboxMessage({
  fromChatId: child.id,
  toChatId: createParent('Retry uncertain').id,
  kind: 'reply',
  body: 'retry uncertain',
  status: 'uncertain',
  error: 'Prompt was accepted but the run id was empty.',
});
const retriedUncertain = await retryMailboxMessage(uncertainRetryRow.id);
assert.equal(retriedUncertain.ok, true);
assert.equal(retriedUncertain.message.status, 'delivered');

function createPlanParent(title) {
  const chat = createParent(title);
  writeChatPlanFile({
    cwd: project,
    chatId: chat.id,
    title,
    markdown: `# ${title}\n\n- step one`,
    sourceTurnId: `turn-${title}`,
  });
  return chat;
}

function repliesForDelegation(delegationId) {
  return loadMailboxMessages().filter((row) => {
    return row.kind === 'reply' && row.delegationId === delegationId;
  });
}

const autoParent = createPlanParent('Auto finish parent');
const autoJob = await service.createAndStart({
  parentChatId: autoParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: autoParent.id }).revision,
  idempotencyKey: 'auto-finish-1',
});
assert.equal(autoJob.ok, true);
await noteDelegationRoomEvent({
  chatId: autoJob.delegation.childChatId,
  delegationId: autoJob.delegation.id,
  delegationAttemptId: autoJob.delegation.attemptId,
  _currentRunAssistantText: 'Toolbar done. Tests passed.',
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: autoJob.delegation.runId,
});
assert.equal(repliesForDelegation(autoJob.delegation.id).length, 1);
assert.equal(findMailboxReplyForDelegation(autoJob.delegation.id)?.status, 'delivered');
assert.equal(getMockChatRun(autoParent.id)?.displayText, 'Child reply');
assert.match(getMockChatRun(autoParent.id)?.prompt || '', /Toolbar done/);

const manualParent = createPlanParent('Manual then finish');
const manualJob = await service.createAndStart({
  parentChatId: manualParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: manualParent.id }).revision,
  idempotencyKey: 'manual-then-finish',
});
const manualReply = await sendDelegationReply({
  fromChatId: manualJob.delegation.childChatId,
  body: 'Manual report first.',
  idempotencyKey: 'manual-first',
});
assert.equal(manualReply.ok, true);
await noteDelegationRoomEvent({
  chatId: manualJob.delegation.childChatId,
  delegationId: manualJob.delegation.id,
  delegationAttemptId: manualJob.delegation.attemptId,
  _currentRunAssistantText: 'Would be a second body.',
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: manualJob.delegation.runId,
});
assert.equal(repliesForDelegation(manualJob.delegation.id).length, 2);
assert.equal(findMailboxReplyForDelegation(manualJob.delegation.id)?.id, manualReply.message.id);

const busyAutoParent = createPlanParent('Busy auto parent');
await startChatRun({ chatId: busyAutoParent.id, prompt: 'parent already working', mode: 'plan' });
const busyAutoJob = await service.createAndStart({
  parentChatId: busyAutoParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: busyAutoParent.id }).revision,
  idempotencyKey: 'busy-auto-finish',
});
await noteDelegationRoomEvent({
  chatId: busyAutoJob.delegation.childChatId,
  delegationId: busyAutoJob.delegation.id,
  delegationAttemptId: busyAutoJob.delegation.attemptId,
  _currentRunAssistantText: 'Child finished while parent was busy.',
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: busyAutoJob.delegation.runId,
});
assert.equal(findMailboxReplyForDelegation(busyAutoJob.delegation.id)?.status, 'queued');
assert.equal(String(getDelegationById(busyAutoJob.delegation.id)?.reportDeliveredAt || ''), '');
assert.equal(collectDelegationReportsForPrompt(busyAutoParent.id).ids.includes(busyAutoJob.delegation.id), false);
patchMockChatRun(busyAutoParent.id, { busy: false, waitingForInput: false });
await drainChatMailbox(busyAutoParent.id);
assert.equal(findMailboxReplyForDelegation(busyAutoJob.delegation.id)?.status, 'delivered');
assert.ok(String(getDelegationById(busyAutoJob.delegation.id)?.reportDeliveredAt || '').trim());
assert.equal(collectDelegationReportsForPrompt(busyAutoParent.id).ids.length, 0);

// A parent that already read the report (delegation_show) must not be woken by
// the queued mailbox final_report with the same body ("ponowna dostawa").
const readReportParent = createPlanParent('Read report already');
await startChatRun({ chatId: readReportParent.id, prompt: 'parent already working', mode: 'plan' });
const readReportJob = await service.createAndStart({
  parentChatId: readReportParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: readReportParent.id }).revision,
  idempotencyKey: 'read-report-finish',
});
await noteDelegationRoomEvent({
  chatId: readReportJob.delegation.childChatId,
  delegationId: readReportJob.delegation.id,
  delegationAttemptId: readReportJob.delegation.attemptId,
  _currentRunAssistantText: 'Report the parent already read.',
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: readReportJob.delegation.runId,
});
assert.equal(findMailboxReplyForDelegation(readReportJob.delegation.id)?.status, 'queued');
assert.equal(markDelegationReportReadByParent(readReportJob.delegation.id), true);
assert.equal(markDelegationReportReadByParent(readReportJob.delegation.id), false);
const startsBeforeSkip = getMockChatRunStartCount();
patchMockChatRun(readReportParent.id, { busy: false, waitingForInput: false });
const drainedRead = await drainChatMailbox(readReportParent.id);
assert.equal(drainedRead[0]?.status, 'delivered');
assert.equal(drainedRead[0]?.delivery, 'skipped_already_delivered');
assert.equal(getMockChatRunStartCount(), startsBeforeSkip);
assert.equal(findMailboxReplyForDelegation(readReportJob.delegation.id)?.status, 'delivered');

const silentParent = createPlanParent('Silent finishDelegation');
const silentJob = await service.createAndStart({
  parentChatId: silentParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: silentParent.id }).revision,
  idempotencyKey: 'silent-finish',
});
finishDelegation(silentJob.delegation, { status: 'completed', report: 'no auto ping from finishDelegation' });
assert.equal(repliesForDelegation(silentJob.delegation.id).length, 0);
assert.equal(collectDelegationReportsForPrompt(silentParent.id).ids.includes(silentJob.delegation.id), true);

const dupParent = createPlanParent('Double sdkRunFinished');
const dupJob = await service.createAndStart({
  parentChatId: dupParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: dupParent.id }).revision,
  idempotencyKey: 'double-finish',
});
const dupRoom = {
  chatId: dupJob.delegation.childChatId,
  delegationId: dupJob.delegation.id,
  delegationAttemptId: dupJob.delegation.attemptId,
  _currentRunAssistantText: 'First completion body.',
};
const dupPayload = {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: dupJob.delegation.runId,
};
await noteDelegationRoomEvent(dupRoom, dupPayload);
await noteDelegationRoomEvent(dupRoom, dupPayload);
assert.equal(repliesForDelegation(dupJob.delegation.id).length, 1);

const emptyKindParent = createPlanParent('Empty sourceKind collector');
const emptyKindJob = await service.createAndStart({
  parentChatId: emptyKindParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: emptyKindParent.id }).revision,
  idempotencyKey: 'empty-kind-plan',
});
finishDelegation(emptyKindJob.delegation, { status: 'completed', report: 'legacy empty kind' });
const delegationsPath = path.join(path.dirname(getMailboxDataPath()), 'delegations.json');
const delegationsDoc = JSON.parse(fs.readFileSync(delegationsPath, 'utf8'));
const emptyKindRow = delegationsDoc.items.find((row) => row.id === emptyKindJob.delegation.id);
emptyKindRow.sourceKind = '';
fs.writeFileSync(delegationsPath, JSON.stringify(delegationsDoc));
assert.equal(collectDelegationReportsForPrompt(emptyKindParent.id).ids.includes(emptyKindJob.delegation.id), true);
await ensureDelegationParentMailboxReply(getDelegationById(emptyKindJob.delegation.id));
assert.equal(findMailboxReplyForDelegation(emptyKindJob.delegation.id)?.status, 'delivered');
assert.equal(collectDelegationReportsForPrompt(emptyKindParent.id).ids.includes(emptyKindJob.delegation.id), false);

const failedBoxParent = createPlanParent('Failed mailbox keeps collector');
const failedBoxJob = await service.createAndStart({
  parentChatId: failedBoxParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: failedBoxParent.id }).revision,
  idempotencyKey: 'failed-mailbox-keep',
});
finishDelegation(failedBoxJob.delegation, { status: 'completed', report: 'keep me in collector' });
createMailboxMessage({
  fromChatId: failedBoxJob.delegation.childChatId,
  toChatId: failedBoxParent.id,
  delegationId: failedBoxJob.delegation.id,
  kind: 'reply',
  body: 'delivery failed',
  status: 'failed',
  error: 'Recipient chat was not found.',
});
assert.equal(findMailboxReplyForDelegation(failedBoxJob.delegation.id)?.status, 'failed');
assert.equal(String(getDelegationById(failedBoxJob.delegation.id)?.reportDeliveredAt || ''), '');
assert.equal(collectDelegationReportsForPrompt(failedBoxParent.id).ids.includes(failedBoxJob.delegation.id), true);

const cancelLateParent = createPlanParent('Cancel then late completed');
const cancelLateJob = await service.createAndStart({
  parentChatId: cancelLateParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: cancelLateParent.id }).revision,
  idempotencyKey: 'cancel-late-completed',
});
const cancelledLate = await service.cancel(cancelLateJob.delegation.id);
assert.equal(cancelledLate.delegation.status, 'cancelled');
await noteDelegationRoomEvent({
  chatId: cancelLateJob.delegation.childChatId,
  delegationId: cancelLateJob.delegation.id,
  delegationAttemptId: cancelLateJob.delegation.attemptId,
  _currentRunAssistantText: 'late completed payload',
}, {
  type: 'sdkRunFinished',
  status: 'completed',
  runId: cancelLateJob.delegation.runId,
});
assert.equal(repliesForDelegation(cancelLateJob.delegation.id).length, 0);

const bootInterruptParent = createPlanParent('Boot interrupted ping');
const bootInterruptJob = await service.createAndStart({
  parentChatId: bootInterruptParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: bootInterruptParent.id }).revision,
  idempotencyKey: 'boot-interrupted',
});
patchMockChatRun(bootInterruptJob.delegation.childChatId, { busy: false, waitingForInput: false });
await reconcileDelegationsOnBoot();
// Confirmed idle running jobs get the 60s orphan grace instead of an
// immediate server-restart interrupt.
assert.equal(getDelegationById(bootInterruptJob.delegation.id)?.status, 'running');
assert.ok(String(getDelegationById(bootInterruptJob.delegation.id)?.idleObservedAt || '').trim());
updateDelegationRecord(bootInterruptJob.delegation.id, {
  idleObservedAt: new Date(Date.now() - DELEGATION_RUNNING_ORPHAN_GRACE_MS - 1000).toISOString(),
});
await reconcileDelegationsOnBoot();
assert.equal(getDelegationById(bootInterruptJob.delegation.id)?.status, 'interrupted');
assert.equal(getDelegationById(bootInterruptJob.delegation.id)?.interruptCode, 'running_orphan');
assert.equal(findMailboxReplyForDelegation(bootInterruptJob.delegation.id)?.kind, 'reply');

const startFailParent = createPlanParent('Start failed no ping');
setMockChatRunFailStart(true);
const startFailJob = await service.createAndStart({
  parentChatId: startFailParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: startFailParent.id }).revision,
  idempotencyKey: 'start-failed-no-ping',
});
assert.equal(startFailJob.ok, false);
assert.equal(startFailJob.code, 'start_failed');
assert.ok(startFailJob.delegation);
assert.equal(repliesForDelegation(startFailJob.delegation.id).length, 0);

const racePingParent = createPlanParent('Race manual and auto');
const racePingJob = await service.createAndStart({
  parentChatId: racePingParent.id,
  executor: { transport: 'sdk', model: 'sdk/test' },
  planRevision: readChatPlanDocument({ cwd: project, chatId: racePingParent.id }).revision,
  idempotencyKey: 'race-manual-auto',
});
finishDelegation(racePingJob.delegation, { status: 'completed', report: 'raced report' });
await Promise.all([
  sendDelegationReply({
    fromChatId: racePingJob.delegation.childChatId,
    body: 'manual race body',
    idempotencyKey: 'race-manual',
  }),
  ensureDelegationParentMailboxReply(getDelegationById(racePingJob.delegation.id)),
]);
assert.equal(repliesForDelegation(racePingJob.delegation.id).length, 2);

const widgetParent = addChat('sess-widget-p', 'Widget parent', null, project, 'm', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
  widgetInstallationId: 'inst-a',
});
const widgetSeed = seedUserMessage(widgetParent.id, 'Widget task');
const widgetJob = await service.createAndStart({
  parentChatId: widgetParent.id,
  executor: { transport: 'opencode', model: 'opencode/test' },
  sourceKind: 'message',
  historySeq: widgetSeed.seq,
  contentHash: hashDelegationContent('Widget task'),
  idempotencyKey: 'widget-msg',
});
assert.equal(widgetJob.ok, true);

const closedOrchestrator = createParent('Closed cycle orchestrator');
updateChat(closedOrchestrator.id, { archived: true });
upsertWorkspaceWatcher(project, {
  mode: 'autopilot',
  cycleChats: [{
    id: closedOrchestrator.id,
    cycleId: 'cycle-closed-1',
    at: '2026-10-05T11:40:28.807Z',
    outcome: 'success',
  }],
});
const staleReply = createMailboxMessage({
  fromChatId: 'child-stale',
  toChatId: closedOrchestrator.id,
  kind: 'reply',
  replyKind: 'final_report',
  body: 'stale review duplicate',
  status: 'queued',
});
const skipped = await drainChatMailbox(closedOrchestrator.id);
assert.equal(skipped.length, 1);
assert.equal(skipped[0].id, staleReply.id);
assert.equal(skipped[0].status, 'delivered');
assert.equal(skipped[0].delivery, 'skipped_cycle_closed');
assert.equal(getMockChatRun(closedOrchestrator.id), null);

let corruptThrew = false;
fs.writeFileSync(getMailboxDataPath(), '{not-json', 'utf8');
try {
  loadMailboxMessages();
} catch (err) {
  corruptThrew = err?.code === 'MAILBOX_CORRUPT';
}
assert.equal(corruptThrew, true);
fs.writeFileSync(getMailboxDataPath(), JSON.stringify({ v: 1, items: [] }), 'utf8');

console.log('delegation-mailbox.test.js OK');
