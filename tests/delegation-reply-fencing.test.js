import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { sendDelegationReply } from '../lib/delegation-mailbox.js';
import { createDelegationService } from '../lib/delegation-service.js';
import {
  patchMockChatRun,
  registerMockChatRunAdapter,
} from '../lib/chat-run/mock-adapter.ts';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

registerMockChatRunAdapter('testfake');

const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});

const parent = addChat(crypto.randomUUID(), 'fence-parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
  agentTransport: 'testfake',
  sdkMode: 'agent',
});

const started = await service.createAndStart({
  parentChatId: parent.id,
  sourceKind: 'text',
  taskText: 'Fence test task',
  executor: { transport: 'testfake', model: 'testfake/test' },
  idempotencyKey: crypto.randomUUID(),
});
assert.equal(started.ok, true);
const job = started.delegation;
const staleRunId = String(job.runId || '').trim();
assert.ok(staleRunId);

const liveRunId = 'live-executing-run-id';
const liveAttemptId = job.attemptId;
assert.ok(liveAttemptId);
patchMockChatRun(job.childChatId, { runId: liveRunId, attemptId: liveAttemptId, busy: true });

const staleReply = await sendDelegationReply({
  fromChatId: job.childChatId,
  body: 'Report with stale run_id from delegation_show.',
  idempotencyKey: 'fence-stale-run',
  runId: staleRunId,
});
assert.equal(staleReply.ok, false);
assert.equal(staleReply.code, 'run_mismatch');
assert.match(staleReply.error, /run_id does not match the executing run\./);
assert.match(staleReply.error, new RegExp(`run_id=${liveRunId}`));

const childClient = createInProcessMcpClient({
  harness: 'testfake',
  chatId: job.childChatId,
  workspaceFolder: ISOLATED_DATA_DIR,
});
const childHandlers = createCretliMcpToolHandlers(childClient, {
  chatId: job.childChatId,
  workspaceFolder: ISOLATED_DATA_DIR,
  mode: 'agent',
});
const mcpStale = await childHandlers.delegation_reply({
  message_text: 'MCP stale run_id',
  idempotency_key: 'fence-mcp-stale',
  run_id: staleRunId,
});
assert.equal(mcpStale.isError, true);
assert.match(mcpStale.content[0].text, new RegExp(`run_id=${liveRunId}`));

const foreignAttemptId = crypto.randomUUID();
const unknownAttempt = await sendDelegationReply({
  fromChatId: job.childChatId,
  body: 'Report for an unknown attempt.',
  idempotencyKey: 'fence-unknown-attempt',
  attemptId: foreignAttemptId,
  runId: liveRunId,
});
assert.equal(unknownAttempt.ok, false);
assert.equal(unknownAttempt.code, 'attempt_mismatch');
assert.match(unknownAttempt.error, new RegExp(`attempt_id=${liveAttemptId}`));
const mcpUnknownAttempt = await childHandlers.delegation_reply({
  message_text: 'MCP report for an unknown attempt.',
  idempotency_key: 'fence-mcp-unknown-attempt',
  attempt_id: foreignAttemptId,
  run_id: liveRunId,
});
assert.equal(mcpUnknownAttempt.isError, true);
assert.match(mcpUnknownAttempt.content[0].text, /attempt_id does not match the executing attempt/);

const withoutFence = await sendDelegationReply({
  fromChatId: job.childChatId,
  body: 'Report without run_id or attempt_id.',
  idempotencyKey: 'fence-no-ids',
});
assert.equal(withoutFence.ok, true);
assert.ok(withoutFence.message?.id);
const replayed = await sendDelegationReply({
  fromChatId: job.childChatId,
  body: 'Report without run_id or attempt_id.',
  idempotencyKey: 'fence-no-ids',
});
assert.equal(replayed.ok, true);
assert.equal(replayed.replayed, true);
assert.equal(replayed.message.id, withoutFence.message.id);
const conflictingReplay = await sendDelegationReply({
  fromChatId: job.childChatId,
  body: 'Different report using the same key.',
  idempotencyKey: 'fence-no-ids',
});
assert.equal(conflictingReplay.ok, false);
assert.equal(conflictingReplay.code, 'idempotency_conflict');

updateDelegationRecord(job.id, { runId: liveRunId });
const aligned = getDelegationById(job.id);
assert.equal(aligned.runId, liveRunId);

// A known archived attempt can deliver its report without changing the live
// attempt. A supplied run still has to match the executing run.
const archivedAttemptId = crypto.randomUUID();
updateDelegationRecord(job.id, {
  attempts: [{ attemptId: archivedAttemptId, runId: staleRunId, status: 'failed', report: 'Archived evidence.' }],
});
const currentFields = ['attemptId', 'runId', 'status', 'report', 'reportVerdict', 'taskOutcome', 'finalReportAcceptedAt'];
const currentBeforeArchivedReply = getDelegationById(job.id);
for (const [index, runId] of [undefined, liveRunId].entries()) {
  const archivedReply = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'Historical report.\nTASK: review\nVERDICT: FAIL',
    replyKind: 'final_report',
    taskOutcome: 'failure',
    attemptId: archivedAttemptId,
    runId,
    idempotencyKey: `fence-archived-${index}`,
  });
  assert.equal(archivedReply.ok, true, archivedReply.error);
  assert.equal(archivedReply.message.delegationAttemptId, archivedAttemptId);
  const currentAfterArchivedReply = getDelegationById(job.id);
  for (const field of currentFields) {
    assert.equal(currentAfterArchivedReply[field], currentBeforeArchivedReply[field], field);
  }
}
const archivedWithStaleRun = await sendDelegationReply({
  fromChatId: job.childChatId,
  body: 'Historical report with a mismatched executing run.',
  attemptId: archivedAttemptId,
  runId: staleRunId,
  idempotencyKey: 'fence-archived-stale-run',
});
assert.equal(archivedWithStaleRun.ok, false);
assert.equal(archivedWithStaleRun.code, 'run_mismatch');

console.log('delegation-reply-fencing.test.js OK');
