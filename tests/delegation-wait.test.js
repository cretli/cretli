import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
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
  clampDelegationWaitTimeoutMs,
  CRETILI_BRIDGE_HTTP_TIMEOUT_MS,
  DELEGATION_WAIT_DEFAULT_MS,
  DELEGATION_WAIT_MAX_MS,
  isDelegationWaitSettled,
} from '../lib/mcp/builtin/delegation-wait.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  hasOpenSdkRunTools,
  noteSdkRunToolActivity,
  resetSdkRunToolActivity,
} from '../lib/sdk/sdk-run-tool-activity.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

assert.equal(clampDelegationWaitTimeoutMs(undefined), DELEGATION_WAIT_DEFAULT_MS);
assert.equal(clampDelegationWaitTimeoutMs(30000), DELEGATION_WAIT_MAX_MS);
assert.ok(DELEGATION_WAIT_MAX_MS < CRETILI_BRIDGE_HTTP_TIMEOUT_MS);

const parent = addChat(crypto.randomUUID(), 'wait-parent', null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const foreign = addChat(crypto.randomUUID(), 'wait-foreign', null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});

function makeJob(status, extra = {}) {
  const row = createDelegationRecord({
    parentChatId: parent.id,
    childChatId: crypto.randomUUID(),
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: extra.assignment || 'review',
  });
  updateDelegationRecord(row.id, { status, runStoppingAt: extra.runStoppingAt || '', ...extra.patch });
  return getDelegationById(row.id);
}

const client = createInProcessMcpClient({
  harness: 'opencode',
  chatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
});
const handlers = createCretliMcpToolHandlers(client, {
  chatId: parent.id,
  workspaceFolder: ISOLATED_DATA_DIR,
  mode: 'agent',
});

const waitingInput = makeJob('waiting_for_input');
const waitingWait = await handlers.delegation_wait({ ids: [waitingInput.id], timeout_ms: 0 });
assert.equal(waitingWait.structuredContent.status, 'pending');
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
  executor: { transport: 'opencode', model: 'opencode/test' },
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

addChat(crypto.randomUUID(), 'wait-child', null, ISOLATED_DATA_DIR, 'opencode/test', {
  id: reviewA.childChatId,
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const childClient = createInProcessMcpClient({
  harness: 'opencode',
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
