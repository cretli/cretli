import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { callTool } from '../lib/mcp/mcp-runtime.js';
import { createBuiltinCretliServer } from '../lib/mcp/mcp-config.js';
import {
  delegationWaitNextStep,
  clampDelegationWaitTimeoutMs,
  CRETILI_BRIDGE_HTTP_TIMEOUT_MS,
  DELEGATION_WAIT_DEFAULT_MS,
  DELEGATION_WAIT_MAX_MS,
  DELEGATION_WAIT_EXTENDED_MAX_MS,
  DELEGATION_WAIT_EXTENDED_HARNESSES,
  delegationWaitMaxMsForHarness,
  isDelegationWaitSettled,
} from '../lib/mcp/builtin/delegation-wait.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  hasOpenSdkRunTools,
  noteSdkRunToolActivity,
  resetSdkRunToolActivity,
} from '../lib/sdk/sdk-run-tool-activity.ts';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.ts';

import { loadDelegationWorkflows, upsertDelegationWorkflow } from '../lib/persist/delegation-workflows-persist.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');

assert.equal(clampDelegationWaitTimeoutMs(undefined), DELEGATION_WAIT_DEFAULT_MS);
assert.equal(clampDelegationWaitTimeoutMs(30000), DELEGATION_WAIT_MAX_MS);
assert.ok(DELEGATION_WAIT_MAX_MS < CRETILI_BRIDGE_HTTP_TIMEOUT_MS);
assert.equal(DELEGATION_WAIT_DEFAULT_MS, 25000);
assert.equal(DELEGATION_WAIT_EXTENDED_MAX_MS, 55000);
assert.deepEqual([...DELEGATION_WAIT_EXTENDED_HARNESSES], ['claude', 'codex']);
// Allowlisted harness may exceed 30 s; everything else is capped at 25 s.
assert.equal(clampDelegationWaitTimeoutMs(50000, delegationWaitMaxMsForHarness('x', ['x'])), 50000);
assert.equal(clampDelegationWaitTimeoutMs(90000, delegationWaitMaxMsForHarness('x', ['x'])), 55000);
assert.equal(clampDelegationWaitTimeoutMs(50000, delegationWaitMaxMsForHarness('y', ['x'])), 25000);
assert.equal(clampDelegationWaitTimeoutMs(50000, delegationWaitMaxMsForHarness('', ['x'])), 25000);
assert.equal(clampDelegationWaitTimeoutMs(undefined, delegationWaitMaxMsForHarness('y', ['x'])), 25000);

const parent = addChat(crypto.randomUUID(), 'wait-parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
  agentTransport: 'testfake',
  sdkMode: 'agent',
});
const foreign = addChat(crypto.randomUUID(), 'wait-foreign', null, ISOLATED_DATA_DIR, 'testfake/test', {
  agentTransport: 'testfake',
  sdkMode: 'agent',
});

function makeJob(status, extra = {}) {
  const row = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: crypto.randomUUID(),
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: extra.assignment || 'review',
  });
  updateDelegationRecord(row.id, { status, runStoppingAt: extra.runStoppingAt || '', ...extra.patch });
  return getDelegationById(row.id);
}

const client = createInProcessMcpClient({
  harness: 'testfake',
  chatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
});
const handlers = createCretliMcpToolHandlers(client, {
  chatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
  mode: 'agent',
});

// Hints are pure and conservative; the parent still reads and advances the loop.
for (const [input, expected] of [
  [{ verdict: 'PASS', assignment: 'implement', verifyStatus: 'passed' }, 'start_review'],
  [{ verdict: 'PASS', workRole: 'fix', verifyStatus: 'not_applicable' }, 'start_review'],
  [{ verdict: 'PASS', assignment: 'implement', verifyRequired: false }, 'read_report'],
  [{ verdict: 'PASS', workRole: 'review_code', verifyStatus: 'passed' }, 'none'],
  [{ verdict: 'FAIL', workRole: 'review_code' }, 'start_fix'],
  [{ verdict: 'PASS', assignment: 'implement', verifyRequired: true }, 'read_report'],
  [{ verdict: 'PASS', assignment: 'implement', verifyStatus: 'pending' }, 'read_report'],
  [{ verdict: 'PASS', assignment: 'review', verifyStatus: 'passed' }, 'none'],
  [{ verdict: 'FAIL', assignment: 'review' }, 'start_fix'],
  [{ verdict: 'conflict', assignment: 'review' }, 'start_fix'],
  [{ verdict: 'FAIL', assignment: 'implement' }, 'read_report'],
  [{ verdict: 'BLOCKED', assignment: 'review' }, 'read_report'],
  [{ verdict: 'unspecified', assignment: 'review' }, 'read_report'],
  [{ verdict: 'PASS', assignment: 'implement', verifyStatus: 'failed', newFailureCount: 1 }, 'start_fix'],
  [{ verdict: 'PASS', assignment: 'implement', verifyStatus: 'failed', newFailureCount: 0 }, 'read_report'],
]) assert.equal(delegationWaitNextStep(input), expected);

const findingsReport = '```findings-json\n' + JSON.stringify({ findings: [
  { id: 'F1', priority: 'P1', summary: 'First' },
  { id: 'F2', priority: 'P2', summary: 'Second' },
  { id: 'F3', priority: 'P2', summary: 'Third' },
] }) + '\n```\nTASK: review\nVERDICT: FAIL';
const summaryJob = makeJob('completed', { patch: {
  report: findingsReport,
  verifyResult: { status: 'passed', newFailures: [] },
} });
upsertDelegationWorkflow({ parentChatId: parent.id, role: 'review', round: 2, lastVerdict: 'FAIL' });
assert.equal(DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_wait').readOnly, true);
const recordBefore = structuredClone(getDelegationById(summaryJob.id));
const workflowBefore = structuredClone(loadDelegationWorkflows());
const savedFlag = process.env.CRETLI_REVIEW_FINDINGS_BLOCK;
try {
  process.env.CRETLI_REVIEW_FINDINGS_BLOCK = '1';
  const result = await handlers.delegation_wait({ ids: [summaryJob.id], timeout_ms: 0 });
  const item = result.structuredContent.items[0];
  assert.equal(item.verdict, 'FAIL');
  assert.equal(item.verify_status, 'passed');
  assert.deepEqual(item.findings_by_priority, { P1: 1, P2: 2, P3: 0 });
  assert.equal(item.next_step, 'start_fix');
  assert.match(result.content[0].text, /verify_status=passed.*findings_by_priority=.*next_step=start_fix/);
  process.env.CRETLI_REVIEW_FINDINGS_BLOCK = '0';
  const disabled = await handlers.delegation_wait({ ids: [summaryJob.id], timeout_ms: 0 });
  assert.equal(disabled.structuredContent.items[0].findings_by_priority, null);
} finally {
  if (savedFlag === undefined) delete process.env.CRETLI_REVIEW_FINDINGS_BLOCK;
  else process.env.CRETLI_REVIEW_FINDINGS_BLOCK = savedFlag;
}
assert.deepEqual(getDelegationById(summaryJob.id), recordBefore);
assert.deepEqual(loadDelegationWorkflows(), workflowBefore);
for (const [assignment, report, verifyResult, expected] of [
  ['implement', 'VERDICT: PASS', { status: 'passed' }, 'start_review'],
  ['implement', 'VERDICT: PASS', null, 'read_report'],
  ['review', 'VERDICT: PASS', { status: 'passed' }, 'none'],
  ['review', 'VERDICT: BLOCKED', null, 'read_report'],
  ['review', 'VERDICT: FAIL', null, 'start_fix'],
  ['review', 'No verdict', null, 'read_report'],
  ['review', '```findings-json\ninvalid\n```\nVERDICT: PASS', null, 'none'],
]) {
  const job = makeJob('completed', { assignment, patch: { report, verifyResult } });
  const result = await handlers.delegation_wait({ ids: [job.id], timeout_ms: 0 });
  assert.equal(result.structuredContent.items[0].next_step, expected);
  assert.equal(result.structuredContent.items[0].findings_by_priority, null);
}

const waitingInput = makeJob('waiting_for_input');
const waitingWait = await handlers.delegation_wait({ ids: [waitingInput.id], timeout_ms: 0 });
assert.equal(waitingWait.structuredContent.status, 'pending');
for (const key of ['verify_status', 'findings_by_priority', 'next_step']) assert.equal(waitingWait.structuredContent.items[0][key], null);
assert.equal(waitingWait.structuredContent.items[0].slot_occupied, true);
assert.equal(waitingWait.structuredContent.items[0].status, 'waiting_for_input');

const oneRunning = makeJob('running');
const onePending = await handlers.delegation_wait({ ids: [oneRunning.id], timeout_ms: 0 });
assert.equal(onePending.isError, false);
assert.equal(onePending.structuredContent.status, 'pending');
assert.equal(onePending.structuredContent.items[0].slot_occupied, true);
assert.doesNotMatch(onePending.content[0].text, /\nreport:/);

updateDelegationRecord(oneRunning.id, { status: 'completed', runStoppingAt: '' });
const oneDone = await handlers.delegation_wait({ ids: [oneRunning.id], timeout_ms: 0 });
assert.equal(oneDone.structuredContent.status, 'done');
assert.equal(oneDone.structuredContent.items[0].slot_occupied, false);

const reviewA = makeJob('running');
const reviewB = makeJob('running');
const fanoutPending = await handlers.delegation_wait({
  ids: [reviewA.id, reviewB.id],
  until: 'all',
  timeout_ms: 0,
});
assert.equal(fanoutPending.structuredContent.status, 'pending');
updateDelegationRecord(reviewA.id, { status: 'completed', runStoppingAt: '' });
const anyDone = await handlers.delegation_wait({
  ids: [reviewA.id, reviewB.id],
  until: 'any',
  timeout_ms: 0,
});
assert.equal(anyDone.structuredContent.status, 'done');
updateDelegationRecord(reviewB.id, { status: 'completed', runStoppingAt: '' });
const allDone = await handlers.delegation_wait({
  ids: [reviewA.id, reviewB.id],
  until: 'all',
  timeout_ms: 0,
});
assert.equal(allDone.structuredContent.status, 'done');

const stopping = makeJob('completed', { runStoppingAt: new Date().toISOString() });
assert.equal(isDelegationWaitSettled(stopping), false);
const stoppingWait = await handlers.delegation_wait({ ids: [stopping.id], timeout_ms: 0 });
assert.equal(stoppingWait.structuredContent.status, 'pending');
assert.equal(stoppingWait.structuredContent.items[0].run_stopping, true);
assert.equal(stoppingWait.structuredContent.items[0].slot_occupied, true);
updateDelegationRecord(stopping.id, { runStoppingAt: '' });
const stoppingCleared = await handlers.delegation_wait({ ids: [stopping.id], timeout_ms: 0 });
assert.equal(stoppingCleared.structuredContent.status, 'done');

const timed = makeJob('running');
const t0 = Date.now();
const timedOut = await handlers.delegation_wait({ ids: [timed.id], timeout_ms: 40 });
assert.equal(timedOut.structuredContent.status, 'pending');
assert.ok(Date.now() - t0 < 1500);
assert.equal(timedOut.structuredContent.timeout_ms, 40);

const abortJob = makeJob('running');
const ac = new AbortController();
setTimeout(() => ac.abort(), 10);
const aborted = await handlers.delegation_wait({ ids: [abortJob.id], timeout_ms: 20000 }, { signal: ac.signal });
assert.equal(aborted.isError, true);
assert.match(aborted.content[0].text, /MCP call cancelled/);

const other = createDelegationRecord({
  parentChatId: foreign.id,
  childChatId: crypto.randomUUID(),
  workspaceFolder: ISOLATED_DATA_DIR,
  executor: { transport: 'testfake', model: 'testfake/test' },
  assignment: 'review',
});
const foreignWait = await handlers.delegation_wait({ ids: [other.id], timeout_ms: 0 });
assert.equal(foreignWait.isError, true);
assert.match(foreignWait.content[0].text, /OUT_OF_SCOPE/);

const missing = await handlers.delegation_wait({ ids: [crypto.randomUUID()], timeout_ms: 0 });
assert.equal(missing.isError, true);
assert.match(missing.content[0].text, /NOT_FOUND/);

const siblingA = makeJob('running');
const siblingB = makeJob('running');
updateDelegationRecord(siblingA.id, { status: 'cancelled', runStoppingAt: '' });
const afterOneCancel = await handlers.delegation_wait({
  ids: [siblingA.id, siblingB.id],
  until: 'all',
  timeout_ms: 0,
});
assert.equal(afterOneCancel.structuredContent.status, 'pending');
const anyAfterCancel = await handlers.delegation_wait({
  ids: [siblingA.id, siblingB.id],
  until: 'any',
  timeout_ms: 0,
});
assert.equal(anyAfterCancel.structuredContent.status, 'done');

addChat(crypto.randomUUID(), 'wait-child', null, ISOLATED_DATA_DIR, 'testfake/test', {
  id: reviewA.childChatId,
  agentTransport: 'testfake',
  sdkMode: 'agent',
});
const childClient = createInProcessMcpClient({
  harness: 'testfake',
  chatId: reviewA.childChatId,
  workspaceFolder: ISOLATED_DATA_DIR,
});
const childHandlers = createCretliMcpToolHandlers(childClient, {
  chatId: reviewA.childChatId,
  workspaceFolder: ISOLATED_DATA_DIR,
  mode: 'agent',
});
const childWait = await childHandlers.delegation_wait({ ids: [reviewB.id], timeout_ms: 0 });
assert.equal(childWait.isError, true);
assert.match(childWait.content[0].text, /OUT_OF_SCOPE/);

// Exercise the real handler and HTTP client's timeout over the old 30 s budget.
// All three requests run concurrently, so this regression costs about 50 s.
const bridgeJobs = new Map(['claude', 'codex', 'testfake'].map((harness) => [makeJob('running').id, harness]));
const bridge = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  const harness = bridgeJobs.get(input.arguments.ids[0]);
  assert.equal(input.name, 'mcp__cretli_builtincretl__delegation_wait');
  const bridgeHandlers = createCretliMcpToolHandlers(client, {
    chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR, mode: 'agent', harness,
  });
  const result = await bridgeHandlers.delegation_wait(input.arguments);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
});
await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
try {
  await Promise.all([...bridgeJobs].map(async ([jobId, harness]) => {
    const remote = new CretliApiClient({
      baseUrl: `http://127.0.0.1:${bridge.address().port}`,
      bearerToken: 'test-token',
    });
    const startedAt = Date.now();
    const result = await remote.callMcpBridgeTool(
      'mcp__cretli_builtincretl__delegation_wait', { ids: [jobId], timeout_ms: 50000 },
    );
    const elapsed = Date.now() - startedAt;
    const expected = harness === 'testfake' ? 25000 : 50000;
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, 'pending');
    assert.equal(result.structuredContent.timeout_ms, expected);
    assert.ok(elapsed >= expected, `${harness} returned early: ${elapsed} ms`);
    assert.ok(elapsed < expected + 10000, `${harness} exceeded its budget: ${elapsed} ms`);
  }));
} finally {
  await new Promise((resolve) => bridge.close(resolve));
}

const builtin = createBuiltinCretliServer();
const runtimeAbort = new AbortController();
runtimeAbort.abort();
const runtimeCancelled = await callTool(
  { chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR, mode: 'agent', builtinClient: client },
  builtin,
  'delegation_wait',
  { ids: [timed.id], timeout_ms: 20000 },
  runtimeAbort.signal,
);
assert.equal(runtimeCancelled.ok, false);
assert.match(String(runtimeCancelled.error || runtimeCancelled.output), /cancelled/i);

const planWait = await callTool(
  { chatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR, mode: 'plan', builtinClient: client },
  builtin,
  'delegation_wait',
  { ids: [stopping.id], timeout_ms: 0 },
);
assert.equal(planWait.ok, true);

const room = {};
resetSdkRunToolActivity(room);
noteSdkRunToolActivity(room, {
  type: 'tool_use',
  id: 'wait-1',
  name: 'delegation_wait',
});
assert.equal(hasOpenSdkRunTools(room), true);
noteSdkRunToolActivity(room, { type: 'tool_result', id: 'wait-1' });
assert.equal(hasOpenSdkRunTools(room), false);

console.log('delegation-wait.test.js OK');
