/**
 * Report persistence across a reused reviewer chat: the final report and
 * verdict of the ACTIVE attempt/run must land on the active delegation, survive
 * a reload of the persist module, and never cross between two consecutive
 * delegations that share one child chat. Local stubs only.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { resolveDelegationRecordVerdict } from '../lib/delegation-verdict.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { createDelegationService, finishDelegation, releaseDelegationRunSlot } from '../lib/delegation-service.js';
import { sendDelegationReply } from '../lib/delegation-mailbox.js';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { registerMockChatRunAdapter, resetMockChatRuns, patchMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import { confirmDurableFinish } from './helpers/delegation-durable-finish.js';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
stopDelegationRuntimeWorker();

const workspace = ISOLATED_DATA_DIR;
const service = createDelegationService({
  workspaceDirForAgent: () => workspace,
  dataDir: workspace,
  isModelAvailable: () => true,
});
const parent = addChat(randomUUID(), 'reuse-parent', null, workspace, 'testfake/test', {
  agentTransport: 'testfake',
  sdkMode: 'agent',
});
saveDelegationSettings(workspace, {
  reviewer_policy: { plan: { selection: 'auto', session: 'leaf' } },
}, { dataDir: workspace });

async function start(text, overrides = {}) {
  const result = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: text,
    executor: { transport: 'testfake', model: 'testfake/test' },
    idempotencyKey: randomUUID(),
    executionMode: 'agent',
    assignment: 'review',
    reviewSubject: 'plan',
    returnWhenStarting: false,
    ...overrides,
  });
  assert.equal(result.ok, true, result.error || 'start failed');
  return result.delegation;
}

/** Re-read the record through a freshly imported persist module (process reload). */
async function reloadRow(id) {
  const fresh = await import(`../lib/persist/delegations-persist.js?reload=${randomUUID()}`);
  return fresh.getDelegationById(id);
}

function report(verdict) {
  return `Checked everything.\nTASK: review\nVERDICT: ${verdict}`;
}

// Round 1 finishes normally and its chat is reused for round 2.
const first = await start('round one');
patchMockChatRun(first.childChatId, { busy: false });
await confirmDurableFinish(finishDelegation(first, { status: 'completed', report: report('FAIL') }));
updateChat(first.childChatId, { opencodeSessionId: 'oc-session-reuse' });
const second = await start('round two', { resumeSessionOf: first.id });
  assert.equal(second.childChatId, first.childChatId);
  assert.notEqual(second.attemptId, first.attemptId);
patchMockChatRun(second.childChatId, { busy: false });

// 1) Reply carrying a STALE session attempt/run (MCP snapshot of round 1) must
// persist on the active round-2 record once the bridge token proves round 2;
// without any proven identity (fallback C) a multi-attempt chat fails closed.
{
  const blind = await sendDelegationReply({
    fromChatId: second.childChatId,
    body: report('PASS'),
    replyKind: 'final_report',
    taskOutcome: 'success',
    sessionAttemptId: first.attemptId,
    sessionRunId: first.runId,
    idempotencyKey: `reuse-blind-${second.id}`,
  });
  assert.equal(blind.ok, false);
  assert.equal(blind.code, 'stale_session_provenance');
  const reply = await sendDelegationReply({
    fromChatId: second.childChatId,
    body: report('PASS'),
    replyKind: 'final_report',
    taskOutcome: 'success',
    attemptId: undefined,
    runId: undefined,
    sessionAttemptId: first.attemptId,
    sessionRunId: first.runId,
    callAttemptId: second.attemptId,
    callDelegationId: second.id,
    idempotencyKey: `reuse-stale-${second.id}`,
  });
  assert.equal(reply.ok, true, reply.error || JSON.stringify(reply));
  const row = await reloadRow(second.id);
  assert.equal(row.status, 'completed');
  assert.equal(row.reportVerdict, 'PASS');
  assert.match(row.report, /VERDICT: PASS/);
  assert.equal(row.finalReportAttemptId, second.attemptId);
  const released = releaseDelegationRunSlot(row);
  assert.equal(released.runStoppingAt || '', '');
  assert.equal((await reloadRow(second.id)).status, 'completed');
  const old = await reloadRow(first.id);
  assert.equal(old.reportVerdict, 'FAIL');
  assert.match(old.report, /VERDICT: FAIL/);
}

// 2) Late/empty terminal event after the accepted reply never wipes the report.
{
  const room = {
    chatId: second.childChatId,
    delegationId: second.id,
    delegationAttemptId: second.attemptId,
    _currentRunAssistantText: '',
  };
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: second.runId });
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'error', lastErrorMessage: 'Aborted', runId: second.runId });
  const row = await reloadRow(second.id);
  assert.equal(row.reportVerdict, 'PASS');
  assert.match(row.report, /VERDICT: PASS/);
  assert.equal(row.status, 'completed');
}

// 3) Third round: finish BEFORE reply, then a reply carrying round 2's stale
// session ids fills the active row without touching the earlier rounds.
patchMockChatRun(second.childChatId, { busy: false });
await confirmDurableFinish(getDelegationById(second.id));
updateChat(second.childChatId, { opencodeSessionId: 'oc-session-reuse' });
const third = await start('round three', { resumeSessionOf: second.id });
assert.equal(third.childChatId, second.childChatId);
{
  const room = {
    chatId: third.childChatId,
    delegationId: third.id,
    delegationAttemptId: third.attemptId,
    _currentRunAssistantText: '',
  };
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: third.runId });
  const late = await sendDelegationReply({
    fromChatId: third.childChatId,
    body: report('FAIL'),
    replyKind: 'final_report',
    taskOutcome: 'failure',
    sessionAttemptId: second.attemptId,
    sessionRunId: second.runId,
    callAttemptId: third.attemptId,
    callDelegationId: third.id,
    idempotencyKey: `reuse-late-${third.id}`,
  });
  assert.equal(late.ok, true, late.error || JSON.stringify(late));
  const row = await reloadRow(third.id);
  assert.equal(row.reportVerdict, 'FAIL');
  assert.match(row.report, /VERDICT: FAIL/);
  assert.equal((await reloadRow(second.id)).reportVerdict, 'PASS');
  assert.equal((await reloadRow(first.id)).reportVerdict, 'FAIL');
}

// 4) Without live adapter state, a delayed old-session call has no trustworthy
// provenance and must fail closed rather than mutate the fourth round.
{
  const fourth = await start('round four');
  resetMockChatRuns();
  const stale = await sendDelegationReply({
    fromChatId: fourth.childChatId,
    body: report('PASS'),
    replyKind: 'final_report',
    sessionAttemptId: third.attemptId,
    sessionRunId: third.runId,
    idempotencyKey: `reuse-no-live-${fourth.id}`,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_session_provenance');
  const row = await reloadRow(fourth.id);
  assert.equal(row.report, '');
  assert.equal(resolveDelegationRecordVerdict(row), 'unspecified');
}

// 4) A genuinely missing report never becomes PASS or success.
{
  const solo = await start('no report at all');
  patchMockChatRun(solo.childChatId, { busy: false });
  const room = {
    chatId: solo.childChatId,
    delegationId: solo.id,
    delegationAttemptId: solo.attemptId,
    _currentRunAssistantText: '',
  };
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: solo.runId });
const row = await reloadRow(solo.id);
  assert.equal(resolveDelegationRecordVerdict(row), 'unspecified');
  assert.notEqual(row.taskOutcome, 'success');
}

console.log('delegation-report-reuse.test.js OK');
