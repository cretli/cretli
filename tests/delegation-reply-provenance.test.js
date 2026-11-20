/**
 * Per-call reply provenance: a delayed delegation_reply of a previous round in
 * a reused chat, carrying a proven call identity but no explicit ids, must be
 * rejected fail-closed instead of being attributed to the active round. Local
 * stubs only.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { createDelegationService, finishDelegation, releaseDelegationRunSlot } from '../lib/delegation-service.js';
import { sendDelegationReply, listChatMailbox } from '../lib/delegation-mailbox.js';
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
const parent = addChat(randomUUID(), 'provenance-parent', null, workspace, 'testfake/test', {
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

/** The fields show/wait expose about a record's outcome. */
function outcome(row) {
  return {
    status: row.status,
    report: row.report || '',
    verdict: row.reportVerdict || '',
    finalReportAttemptId: row.finalReportAttemptId || '',
  };
}

function report(verdict) {
  return `Checked everything.\nTASK: review\nVERDICT: ${verdict}`;
}

const first = await start('round one');
patchMockChatRun(first.childChatId, { busy: false });
await confirmDurableFinish(finishDelegation(first, { status: 'completed', report: report('FAIL') }));
updateChat(first.childChatId, { opencodeSessionId: 'oc-session-provenance' });
const second = await start('round two', { resumeSessionOf: first.id });
assert.equal(second.childChatId, first.childChatId);
assert.notEqual(second.attemptId, first.attemptId);
patchMockChatRun(second.childChatId, { busy: false });

// 1) A delayed old-round call (proven identity of round one, no explicit ids)
// while round two is active is rejected and attributed to nothing.
{
  const before = outcome(await reloadRow(second.id));
  const mailboxBefore = listChatMailbox(parent.id).length;
  const stale = await sendDelegationReply({
    fromChatId: second.childChatId,
    body: report('PASS'),
    replyKind: 'final_report',
    taskOutcome: 'success',
    sessionAttemptId: second.attemptId,
    sessionRunId: second.runId,
    callAttemptId: first.attemptId,
    callDelegationId: first.id,
    idempotencyKey: `prov-stale-${second.id}`,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_session_provenance');
  assert.equal(stale.attemptId, second.attemptId);
  assert.match(stale.error, new RegExp(`attempt_id=${second.attemptId}`));
  assert.equal(listChatMailbox(parent.id).length, mailboxBefore);
  assert.deepEqual(outcome(await reloadRow(second.id)), before);
  assert.equal((await reloadRow(first.id)).reportVerdict, 'FAIL');
}

// 1b) Same attempt but a foreign delegation id is rejected as well.
{
  const stale = await sendDelegationReply({
    fromChatId: second.childChatId,
    body: report('PASS'),
    replyKind: 'final_report',
    callAttemptId: second.attemptId,
    callDelegationId: first.id,
    idempotencyKey: `prov-stale-deleg-${second.id}`,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_session_provenance');
}

// 2) The active round's own call identity is accepted.
{
  const ok = await sendDelegationReply({
    fromChatId: second.childChatId,
    body: report('PASS'),
    replyKind: 'final_report',
    taskOutcome: 'success',
    callAttemptId: second.attemptId,
    callDelegationId: second.id,
    idempotencyKey: `prov-current-${second.id}`,
  });
  assert.equal(ok.ok, true, ok.error || JSON.stringify(ok));
  const row = await reloadRow(second.id);
  assert.equal(row.status, 'completed');
  assert.equal(row.reportVerdict, 'PASS');
  assert.equal(row.finalReportAttemptId, second.attemptId);
}

// 3) show/wait view is identical before slot release, after it, and after a
// persist reload.
{
  const row = await reloadRow(second.id);
  const beforeRelease = outcome(row);
  releaseDelegationRunSlot(row);
  const afterRelease = outcome(await reloadRow(second.id));
  assert.deepEqual(afterRelease, beforeRelease);
  const { getDelegationById } = await import('../lib/persist/delegations-persist.js');
  assert.deepEqual(outcome(getDelegationById(second.id)), beforeRelease);
  assert.equal((await reloadRow(first.id)).reportVerdict, 'FAIL');
}

// 4) Explicit client ids still win over the call identity: an archived attempt
// id is not rejected by the call fence.
{
  const archived = await sendDelegationReply({
    fromChatId: second.childChatId,
    delegationId: second.id,
    body: 'late progress note',
    replyKind: 'progress',
    attemptId: second.attemptId,
    callAttemptId: first.attemptId,
    callDelegationId: first.id,
    idempotencyKey: `prov-explicit-${second.id}`,
  });
  assert.notEqual(archived.code, 'stale_session_provenance');
}

// 5) Without live adapter state a delayed old-session call still fails closed.
{
  const third = await start('round three');
  resetMockChatRuns();
  const stale = await sendDelegationReply({
    fromChatId: third.childChatId,
    body: report('PASS'),
    replyKind: 'final_report',
    sessionAttemptId: second.attemptId,
    sessionRunId: second.runId,
    idempotencyKey: `prov-no-live-${third.id}`,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_session_provenance');
  assert.equal((await reloadRow(third.id)).report, '');
}

console.log('delegation-reply-provenance: ok');
process.exit(0);
