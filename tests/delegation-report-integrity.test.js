import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { acceptDelegationFinalReport, createDelegationService } from '../lib/delegation-service.js';
import {
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  DELEGATION_REPORT_MAX_CHARS,
  assessDelegationReport,
  isIncompleteDelegationReport,
  parseDelegationVerdict,
  resolveDelegationRecordVerdict,
} from '../lib/delegation-verdict.js';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { sendDelegationReply } from '../lib/delegation-mailbox.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';

resetMockChatRuns();
registerMockChatRunAdapter('sdk');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-report-integrity-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});

/** @param {string} title */
function createParent(title) {
  return addChat(`sess-${title}-${Math.random().toString(16).slice(2)}`, title, null, project, 'planner-model', {
    agentTransport: 'sdk',
    sdkMode: 'agent',
  });
}

/**
 * @param {string} title
 */
async function startReview(title) {
  const parent = createParent(title);
  const started = await service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'sdk', model: 'sdk/test' },
    sourceKind: 'text',
    taskText: 'Review the change.',
    assignment: 'review',
    idempotencyKey: `${title}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  assert.equal(started.ok, true, started.error || '');
  assert.equal(started.delegation.assignment, 'review');
  return started;
}

// Predicate stays verdict-first: a long, well-spaced body without a VERDICT is
// incomplete, while a real VERDICT line (even a short one) is complete.
assert.equal(isIncompleteDelegationReport(''), true);
assert.equal(isIncompleteDelegationReport('Checked the workspace and it looks fine to me, nothing to report here.'), true);
assert.equal(isIncompleteDelegationReport('word '.repeat(300)), true);
assert.equal(isIncompleteDelegationReport('Looks good.\nVERDICT: PASS'), false);
assert.equal(isIncompleteDelegationReport('VERDICT: PASS\nVERDICT: FAIL'), true);

// 1) Contract: a review finalized through `acceptDelegationFinalReport` without
// a VERDICT can never be completed/success.
{
  const started = await startReview('direct-review');
  const result = await acceptDelegationFinalReport({
    delegationId: started.delegation.id,
    attemptId: started.delegation.attemptId,
    report: 'Checked all the changed files and they look fine to me, no problems found here.',
    taskOutcome: 'success',
  });
  assert.equal(result.ok, true);
  assert.equal(result.accepted, false);
  assert.equal(result.incomplete, true);
  const row = getDelegationById(started.delegation.id);
  assert.equal(String(row.finalReportAcceptedAt || '').trim(), '');
  assert.equal(row.status, 'failed');
  assert.notEqual(row.taskOutcome, 'success');
  assert.match(String(row.error || ''), /adapter_incomplete/);
  assert.equal(result.reportDegraded, false);
}

// A review with a usable VERDICT still completes as success.
{
  const started = await startReview('direct-review-pass');
  const result = await acceptDelegationFinalReport({
    delegationId: started.delegation.id,
    attemptId: started.delegation.attemptId,
    report: 'Checked the send path.\nTASK: review\nVERDICT: PASS',
    taskOutcome: 'success',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.incomplete, false);
  const row = getDelegationById(started.delegation.id);
  assert.equal(row.status, 'completed');
  assert.equal(row.taskOutcome, 'success');
  assert.equal(row.reportVerdict, 'PASS');
  assert.ok(String(row.finalReportAcceptedAt || '').trim());
}

// 2) A 72-char review report sent as `delegation_reply final_report` is
// rejected: not completed, not success.
{
  const started = await startReview('mail-review-72');
  const report = 'checked '.repeat(9);
  assert.equal(report.length, 72);
  assert.equal(parseDelegationVerdict(report), 'unspecified');
  const reply = await sendDelegationReply({
    fromChatId: started.delegation.childChatId,
    body: report,
    replyKind: 'final_report',
    taskOutcome: 'success',
    attemptId: started.delegation.attemptId,
    runId: started.delegation.runId,
    idempotencyKey: `mail-72-${started.delegation.id}`,
  });
  assert.equal(reply.ok, true, reply.error || '');
  assert.notEqual(String(reply.message?.taskOutcome || ''), 'success');
  const row = getDelegationById(started.delegation.id);
  assert.equal(row.status, 'failed');
  assert.notEqual(row.taskOutcome, 'success');
  assert.match(String(row.error || ''), /adapter_incomplete/);
  assert.equal(String(row.finalReportAcceptedAt || '').trim(), '');
}

// 3) An ~800 KiB token-repetition report is flagged as degraded, bounded, and
// still keeps its usable VERDICT.
{
  const started = await startReview('mail-review-degraded');
  const huge = `${'legacy-paragraph '.repeat(80)}\n`.repeat(700) + '\nTASK: review\nVERDICT: PASS';
  assert.ok(huge.length > 800 * 1024, `fixture should exceed 800 KiB, got ${huge.length}`);
  const reply = await sendDelegationReply({
    fromChatId: started.delegation.childChatId,
    body: huge,
    replyKind: 'final_report',
    taskOutcome: 'success',
    attemptId: started.delegation.attemptId,
    runId: started.delegation.runId,
    idempotencyKey: `mail-big-${started.delegation.id}`,
  });
  assert.equal(reply.ok, true, reply.error || '');
  assert.notEqual(String(reply.message?.taskOutcome || ''), 'success');
  const row = getDelegationById(started.delegation.id);
  assert.equal(row.status, 'failed');
  assert.notEqual(row.taskOutcome, 'success');
  assert.equal(row.reportDegraded, true);
  assert.ok(row.report.length <= DELEGATION_REPORT_MAX_CHARS, `stored report length ${row.report.length}`);
  assert.equal(row.reportVerdict, 'PASS');
  assert.match(String(row.report || ''), /VERDICT: PASS/);
  assert.ok(String(row.report || '').startsWith('[report_degraded'));
  assert.match(String(row.error || ''), /report_degraded/);
  const deliveredBody = String(reply.message?.body || '');
  assert.ok(deliveredBody.length <= DELEGATION_REPORT_MAX_CHARS, `delivered body ${deliveredBody.length}`);
  assert.ok(deliveredBody.startsWith('[report_degraded'));
}

// Normal long review prose (10–20 KiB, varied sentences) is not degraded.
{
  let longReport = '';
  for (let i = 0; i < 240; i += 1) {
    longReport += `Finding ${i} notes module ${i * 3} behaviour under load ${i * 11} and records edge case ${i * 5}. `;
  }
  longReport += '\nTASK: review\nVERDICT: PASS\n';
  assert.ok(longReport.length >= 10 * 1024 && longReport.length <= 20 * 1024, `fixture length ${longReport.length}`);
  const assessed = assessDelegationReport(longReport);
  assert.equal(assessed.degraded, false, `repeatRatio=${assessed.repeatRatio}`);
  const started = await startReview('mail-review-long-ok');
  const reply = await sendDelegationReply({
    fromChatId: started.delegation.childChatId,
    body: longReport,
    replyKind: 'final_report',
    taskOutcome: 'success',
    attemptId: started.delegation.attemptId,
    runId: started.delegation.runId,
    idempotencyKey: `mail-long-${started.delegation.id}`,
  });
  assert.equal(reply.ok, true, reply.error || '');
  assert.equal(String(reply.message?.taskOutcome || ''), 'success');
  const row = getDelegationById(started.delegation.id);
  assert.equal(row.status, 'completed');
  assert.equal(row.taskOutcome, 'success');
  assert.equal(row.reportDegraded, false);
}

// 4) `delegation_show` reads the persisted verdict from the record, even after
// the stored report text no longer carries the line.
{
  const started = await startReview('show-verdict');
  await acceptDelegationFinalReport({
    delegationId: started.delegation.id,
    attemptId: started.delegation.attemptId,
    report: 'Looked at the diff.\nVERDICT: PASS',
    taskOutcome: 'success',
  });
  assert.equal(getDelegationById(started.delegation.id).reportVerdict, 'PASS');
  updateDelegationRecord(started.delegation.id, { report: 'report body without a verdict line' });
  assert.equal(resolveDelegationRecordVerdict(getDelegationById(started.delegation.id)), 'PASS');
  const client = createInProcessMcpClient({
    harness: 'sdk',
    chatId: started.delegation.parentChatId,
    workspaceFolder: project,
  });
  const handlers = createCretliMcpToolHandlers(client, {
    chatId: started.delegation.parentChatId,
    workspaceFolder: project,
    mode: 'agent',
  });
  const shown = await handlers.delegation_show({ delegation_id: started.delegation.id });
  assert.equal(shown.isError, false);
  assert.equal(shown.structuredContent.verdict, 'PASS');
}

// 5) A spurious second `sdkRunFinished` on an already-terminal attempt does not
// add `adapter_after_terminal` to `errors[]`; it is counted for diagnostics.
{
  const started = await startReview('after-terminal');
  const room = {
    chatId: started.delegation.childChatId,
    delegationId: started.delegation.id,
    delegationAttemptId: started.delegation.attemptId,
    _currentRunAssistantText: 'All good.\nVERDICT: PASS',
  };
  await noteDelegationRoomEvent(room, {
    type: 'sdkRunFinished',
    status: 'completed',
    runId: started.delegation.runId,
  });
  const first = getDelegationById(started.delegation.id);
  assert.equal(first.status, 'completed');
  assert.equal((first.errors || []).some((entry) => entry?.code === 'adapter_after_terminal'), false);
  await noteDelegationRoomEvent(room, {
    type: 'sdkRunFinished',
    status: 'error',
    lastErrorMessage: 'Aborted',
    runId: started.delegation.runId,
  });
  const second = getDelegationById(started.delegation.id);
  assert.equal((second.errors || []).some((entry) => entry?.code === 'adapter_after_terminal'), false);
  assert.equal(second.afterTerminalCount, 1);
  assert.equal(second.lastAfterTerminalCode, 'adapter_after_terminal');
}

// 6) `implement` self-verdict semantics are unchanged: a long implement report
// without a VERDICT still completes.
{
  const parent = createParent('implement-no-verdict');
  const started = await service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'sdk', model: 'sdk/test' },
    sourceKind: 'text',
    taskText: 'Implement the change.',
    assignment: 'implement',
    idempotencyKey: `impl-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  });
  assert.equal(started.ok, true, started.error || '');
  const room = {
    chatId: started.delegation.childChatId,
    delegationId: started.delegation.id,
    delegationAttemptId: started.delegation.attemptId,
    _currentRunAssistantText: 'Implemented the requested change and verified the behaviour across every affected module.',
  };
  await noteDelegationRoomEvent(room, {
    type: 'sdkRunFinished',
    status: 'completed',
    runId: started.delegation.runId,
  });
  const row = getDelegationById(started.delegation.id);
  assert.equal(row.status, 'completed');
  assert.equal(row.reportVerdict, 'unspecified');
}

console.log('delegation-report-integrity.test.js OK');
