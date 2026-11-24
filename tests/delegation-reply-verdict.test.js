import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { addChat } from '../lib/persist/chats-legacy-store.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { loadMailboxMessages } from '../lib/persist/delegation-mailbox-persist.js';
import { sendDelegationReply } from '../lib/delegation-mailbox.js';
import { createDelegationService, inspectDelegationSlot, DELEGATION_CHILD_STOP_GRACE_MS } from '../lib/delegation-service.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { registerMockChatRunAdapter, patchMockChatRun, getMockChatRun } from '../lib/chat-run/mock-adapter.ts';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { applyDelegationReplyVerdict, parseDelegationVerdict } from '../lib/delegation-verdict.js';

registerMockChatRunAdapter('testfake');
const service = createDelegationService({ workspaceDirForAgent: () => ISOLATED_DATA_DIR, isModelAvailable: () => true });
async function start() {
  const parent = addChat(crypto.randomUUID(), 'verdict-parent', null, ISOLATED_DATA_DIR, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
  const result = await service.createAndStart({ parentChatId: parent.id, sourceKind: 'text', taskText: 'Review this change.', executor: { transport: 'testfake', model: 'testfake/test' }, idempotencyKey: crypto.randomUUID() });
  assert.equal(result.ok, true);
  // Exercise the reply contract independently of model certification policy.
  updateDelegationRecord(result.delegation.id, { assignment: 'review' });
  return getDelegationById(result.delegation.id);
}
const request = (job, extra = {}) => ({ fromChatId: job.childChatId, delegationId: job.id, attemptId: job.attemptId, runId: job.runId, replyKind: 'final_report', body: 'Review completed; no blocking findings.', idempotencyKey: crypto.randomUUID(), taskOutcome: 'success', ...extra });
const finalMessages = (job) => loadMailboxMessages().filter((row) => row.delegationId === job.id && row.replyKind === 'final_report');

const job = await start();
const firstRequest = request(job, { idempotencyKey: 'missing-first' });
const first = await sendDelegationReply(firstRequest);
assert.equal(first.code, 'review_verdict_required');
assert.match(first.error, /new idempotency_key/);
assert.equal(getDelegationById(job.id).status, 'running');
assert.equal(getDelegationById(job.id).report, '');
assert.equal(finalMessages(job).length, 0);
assert.equal(getDelegationById(job.id).reviewReplyRejections.length, 1);
assert.deepEqual(await sendDelegationReply(firstRequest), first);
assert.equal(getDelegationById(job.id).reviewReplyRejections.length, 1);
assert.equal((await sendDelegationReply({ ...firstRequest, body: 'Changed body' })).code, 'idempotency_conflict');
assert.equal((await sendDelegationReply({ ...firstRequest, verdict: 'PASS' })).code, 'idempotency_conflict');

// A fresh process must replay the durable decision without spending the budget.
const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  import './tests/fixtures/fake-transport.js';
  import { sendDelegationReply } from './lib/delegation-mailbox.js';
  import { registerMockChatRunAdapter, patchMockChatRun } from './lib/chat-run/mock-adapter.ts';
  registerMockChatRunAdapter('testfake');
  patchMockChatRun(${JSON.stringify(job.childChatId)}, { busy: true, runId: ${JSON.stringify(job.runId)}, attemptId: ${JSON.stringify(job.attemptId)} });
  process.stdout.write(JSON.stringify(await sendDelegationReply(${JSON.stringify(firstRequest)})));
`], { encoding: 'utf8' }));
assert.deepEqual(restarted, first);
assert.equal(getDelegationById(job.id).reviewReplyRejections.length, 1);
const second = await sendDelegationReply(request(job, { verdict: 'FAIL', body: 'Review findings.\nVERDICT: PASS' }));
assert.equal(second.code, 'review_verdict_required');
assert.equal(getDelegationById(job.id).reviewReplyRejections.length, 2);
assert.equal(finalMessages(job).length, 0);
const thirdRequest = request(job, { verdict: 'FAIL', body: 'Review findings.\nVERDICT: PASS' });
const third = await sendDelegationReply(thirdRequest);
assert.equal(third.ok, true);
const exhausted = getDelegationById(job.id);
assert.equal(exhausted.status, 'failed');
assert.match(exhausted.error, /adapter_no_verdict/);
assert.equal(exhausted.reportVerdict, 'conflict');
assert.equal(exhausted.taskOutcome, 'unspecified');
assert.equal(finalMessages(job).length, 1);
assert.equal((await sendDelegationReply(thirdRequest)).replayed, true);
assert.deepEqual(await sendDelegationReply(firstRequest), first);
await new Promise((resolve) => setTimeout(resolve, DELEGATION_CHILD_STOP_GRACE_MS + 100));
assert.equal(getMockChatRun(job.childChatId)?.busy, false);
assert.equal(inspectDelegationSlot(getDelegationById(job.id)).occupied, false);
assert.equal(parseDelegationVerdict(applyDelegationReplyVerdict('TASK: review VERDICT: FAIL', 'PASS')), 'conflict');
assert.equal(applyDelegationReplyVerdict('Reviewed.\nVERDICT: PASS', 'PASS'), 'Reviewed.\nVERDICT: PASS');

// MCP -> in-process client -> mailbox -> finish persistence, field only.
const valid = await start();
const handlers = createCretliMcpToolHandlers(createInProcessMcpClient({ harness: 'testfake', chatId: valid.childChatId, workspaceFolder: ISOLATED_DATA_DIR }), { chatId: valid.childChatId, workspaceFolder: ISOLATED_DATA_DIR, mode: 'agent' });
const validReply = await handlers.delegation_reply({ message_text: 'All acceptance criteria verified.', verdict: 'PASS', reply_kind: 'final_report', idempotency_key: 'field-only', attempt_id: valid.attemptId, run_id: valid.runId });
assert.notEqual(validReply.isError, true);
assert.equal(getDelegationById(valid.id).reportVerdict, 'PASS');
assert.equal(getDelegationById(valid.id).status, 'completed');
assert.equal(getDelegationById(valid.id).reviewReplyRejections.length, 0);

// The actual HTTP handler must preserve the field too.
const routes = new Map();
registerDelegationsRoutes({ get: (path, fn) => routes.set(`GET ${path}`, fn), post: (path, fn) => routes.set(`POST ${path}`, fn) }, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });
const routed = await start();
let payload;
let status;
await routes.get('POST /api/chats/:id/mailbox/reply')({ params: { id: routed.childChatId }, query: {}, body: { workspaceFolder: ISOLATED_DATA_DIR, body: 'Review found a defect.', verdict: 'FAIL', replyKind: 'final_report', idempotencyKey: 'route-field', attemptId: routed.attemptId, runId: routed.runId } }, { status(value) { status = value; return this; }, json(value) { payload = value; return this; } });
assert.equal(payload.ok, true);
assert.equal(status, 201);
assert.equal(getDelegationById(routed.id).reportVerdict, 'FAIL');

const legacy = await start();
assert.equal((await sendDelegationReply(request(legacy, { body: 'Reviewed.\nVERDICT: BLOCKED' }))).ok, true);
assert.equal(getDelegationById(legacy.id).reportVerdict, 'BLOCKED');
const invalid = await start();
assert.equal((await sendDelegationReply(request(invalid, { verdict: 'UNKNOWN' }))).code, 'invalid_verdict');
assert.equal(getDelegationById(invalid.id).reviewReplyRejections.length, 0);

// Adapter termination after a rejection still has its usual follow-up/finish path.
const stopped = await start();
assert.equal((await sendDelegationReply(request(stopped))).code, 'review_verdict_required');
const report = 'Review observations without a verdict. '.repeat(20);
const room = { chatId: stopped.childChatId, delegationId: stopped.id, delegationAttemptId: stopped.attemptId, harness: 'claude', sdkMode: 'agent', _currentRunAssistantText: report };
// Model the supported harness's normal follow-up after the rejected tool call.
patchMockChatRun(stopped.childChatId, { busy: false });
await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: stopped.runId });
assert.equal(getDelegationById(stopped.id).status, 'running');
assert.equal(room.pendingPrompts.length, 1);
assert.equal(finalMessages(stopped).length, 0);
room._currentRunAssistantText = 'Still no verdict.';
await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: stopped.runId });
assert.equal(getDelegationById(stopped.id).status, 'failed');
assert.match(getDelegationById(stopped.id).error, /adapter_no_verdict/);
assert.equal(finalMessages(stopped).length, 1);
assert.equal(inspectDelegationSlot(getDelegationById(stopped.id)).occupied, false);

const plain = await start();
const plainRequest = request(plain, { body: 'Done.' });
const parallel = await Promise.all([sendDelegationReply(plainRequest), sendDelegationReply(plainRequest)]);
assert.deepEqual(parallel[0], parallel[1]);
assert.equal(getDelegationById(plain.id).reviewReplyRejections.length, 1);
assert.equal((await sendDelegationReply(request(plain, { body: 'Done.' }))).code, 'review_verdict_required');
assert.equal((await sendDelegationReply(request(plain, { body: 'Done.' }))).ok, true);
assert.match(getDelegationById(plain.id).error, /adapter_no_verdict/);
assert.equal(getDelegationById(plain.id).status, 'failed');
// Reusing a reviewer chat for another attempt starts a fresh correction budget.
const retry = await start();
const oldRequest = request(retry, { idempotencyKey: 'attempt-local-key' });
assert.equal((await sendDelegationReply(oldRequest)).code, 'review_verdict_required');
const nextAttempt = crypto.randomUUID();
updateDelegationRecord(retry.id, { attemptId: nextAttempt });
patchMockChatRun(retry.childChatId, { attemptId: nextAttempt });
assert.equal((await sendDelegationReply({ ...oldRequest, attemptId: nextAttempt })).code, 'review_verdict_required');
assert.equal(getDelegationById(retry.id).reviewReplyRejections.filter((row) => row.attemptId === nextAttempt).length, 1);

// Concurrent rejections with DIFFERENT keys must not lose a budget entry. The
// read of reviewReplyRejections and the write are synchronous (no await between
// them), so interleaving is impossible in one process; this pins that contract.
const racing = await start();
const raced = await Promise.all(Array.from({ length: 6 }, (_, i) => sendDelegationReply(request(racing, { idempotencyKey: `race-key-${i}` }))));
assert.equal(raced.filter((row) => row.code === 'review_verdict_required').length, 2, 'exactly two rejections are granted');
const racedRows = getDelegationById(racing.id).reviewReplyRejections;
assert.equal(racedRows.length, 2, 'no rejection entry is lost or exceeds the budget');
assert.equal(new Set(racedRows.map((row) => row.idempotencyKey)).size, 2);

// No correction is requested once the adapter is idle, or for implement work.
const idle = await start();
patchMockChatRun(idle.childChatId, { busy: false });
assert.equal((await sendDelegationReply(request(idle))).ok, true);
assert.equal(getDelegationById(idle.id).reviewReplyRejections.length, 0);
const implement = await start();
updateDelegationRecord(implement.id, { assignment: 'implement' });
assert.equal((await sendDelegationReply(request(implement))).ok, true);
assert.equal(getDelegationById(implement.id).status, 'completed');
assert.equal(getDelegationById(implement.id).reviewReplyRejections.length, 0);
console.log('delegation-reply-verdict.test.js OK');
