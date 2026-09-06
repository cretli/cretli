import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { addChat, loadChats, updateChat } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents, loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { hashDelegationContent } from '../lib/delegation-request.js';
import { collectDelegationReportsForPrompt } from '../lib/delegation-report-context.js';
import { createDelegationService, finishDelegation, reconcileDelegationsOnBoot } from '../lib/delegation-service.js';
import {
  createMailboxMessage,
  getMailboxDataPath,
  listQueuedMailboxForRecipient,
  loadMailboxMessages,
} from '../lib/persist/delegation-mailbox-persist.js';
import { drainChatMailbox, listChatMailbox, retryMailboxMessage, sendDelegationReply } from '../lib/delegation-mailbox.js';
import { startChatRun } from '../lib/chat-run-service.js';
import fs from 'node:fs';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
  getMockChatRun,
  patchMockChatRun,
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
assert.equal(started.delegation.executionMode, 'plan');
assert.equal(getMockChatRun(started.delegation.childChatId)?.mode, 'plan');
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
  executionMode: 'plan',
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
assert.equal(replyAgain.replayed, true);
assert.equal(replyAgain.message.id, reply.message.id);
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
