import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { loadChatHistory } from '../lib/persist/chat-history-persist.js';
import {
  createDelegationService,
  finishDelegation,
  flushDelegationOutbox,
  publishDelegationStatus,
  releaseDelegationRunSlot,
  setDelegationCrashHook,
} from '../lib/delegation-service.js';
import {
  createDelegationRecord,
  getDelegationById,
  getDelegationsDataPath,
  loadDelegations,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { sendDelegationReply, ensureDelegationParentMailboxReply } from '../lib/delegation-mailbox.js';
import { loadMailboxMessages } from '../lib/persist/delegation-mailbox-persist.js';
import { registerMockChatRunAdapter, patchMockChatRun } from '../lib/chat-run/mock-adapter.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { buildDelegationCardModel } from '../lib/delegation-card-model.js';
import { DELEGATION_PLAN_CONTEXT_LIMIT } from '../lib/delegation-prompt.js';

registerMockChatRunAdapter('opencode');
let available = true;
const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => available,
});
const parent = (title) => addChat(crypto.randomUUID(), title, null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const start = (p, text = 'Audit task') => service.createAndStart({
  parentChatId: p.id,
  sourceKind: 'text',
  taskText: text,
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});

const p = parent('Mailbox');
const first = await start(p);
assert.equal(first.ok, true);
const d = first.delegation;
const reply1 = await sendDelegationReply({ fromChatId: d.childChatId, body: 'Progress only', idempotencyKey: 'reply-a' });
const reply2 = await sendDelegationReply({ fromChatId: d.childChatId, body: 'Final result', idempotencyKey: 'reply-b' });
assert.notEqual(reply2.message.id, reply1.message.id);
assert.equal(reply2.message.body, 'Final result');
const replaySame = await sendDelegationReply({ fromChatId: d.childChatId, body: 'Progress only', idempotencyKey: 'reply-a' });
assert.equal(replaySame.replayed, true);
assert.equal(replaySame.message.id, reply1.message.id);
const replayConflict = await sendDelegationReply({ fromChatId: d.childChatId, body: 'Changed', idempotencyKey: 'reply-a' });
assert.equal(replayConflict.ok, false);
assert.equal(replayConflict.code, 'idempotency_conflict');

finishDelegation(d, { status: 'completed', report: 'Attempt one' });
service.acknowledge(d.id);
patchMockChatRun(d.childChatId, { busy: false, waitingForInput: false });
const retried = await service.retry(d.id);
assert.equal(retried.ok, true);
assert.equal(retried.delegation.unverified, true);
assert.equal(retried.delegation.acknowledgedAt, '');
finishDelegation(retried.delegation, { status: 'completed', report: 'Attempt two', enqueueParentReply: true });
await flushDelegationOutbox(getDelegationById(d.id));
const replies = loadMailboxMessages().filter((x) => x.delegationId === d.id);
assert.equal(replies.some((row) => row.body === 'Progress only'), true);
assert.equal(replies.some((row) => row.body.includes('Attempt two') || row.replyKind === 'final_report'), true);
const afterB = getDelegationById(d.id);
assert.equal(afterB.unverified, true);
const card = buildDelegationCardModel(afterB);
assert.equal(card.showUnverified, true);
assert.equal(card.canRetry, true);
assert.ok(card.attemptNumber >= 2);

const longParent = parent('Long input');
const long = await start(longParent, 'x'.repeat(DELEGATION_PLAN_CONTEXT_LIMIT + 1));
assert.equal(long.ok, false);
assert.equal(long.code, 'plan_too_large');
assert.equal(loadDelegations().some((x) => x.parentChatId === longParent.id), false);
const afterLong = await start(longParent);
assert.equal(afterLong.ok, true);
finishDelegation(afterLong.delegation, { status: 'completed', report: 'ok' });
patchMockChatRun(afterLong.delegation.childChatId, { busy: false, waitingForInput: false });
releaseDelegationRunSlot(getDelegationById(afterLong.delegation.id));

const waitingParent = parent('Waiting');
const waitingJob = (await start(waitingParent)).delegation;
for (const status of ['waiting_for_input', 'running', 'waiting_for_input']) {
  const row = updateDelegationRecord(waitingJob.id, { status });
  publishDelegationStatus(row, status);
}
const cards = loadChatHistory(waitingParent.id).events
  .filter((x) => x.rec?.variant === 'delegation')
  .map((x) => JSON.parse(x.rec.payload));
assert.equal(cards.filter((row) => row.event === 'waiting_for_input').length >= 2, true);
assert.equal(getDelegationById(waitingJob.id).status, 'waiting_for_input');
assert.equal(cards.at(-1).status, 'waiting_for_input');

const policyParent = parent('Policy');
const policyJob = (await start(policyParent)).delegation;
finishDelegation(policyJob, { status: 'failed', error: 'example' });
patchMockChatRun(policyJob.childChatId, { busy: false });
updateChat(policyParent.id, { sdkMode: 'ask' });
available = false;
const bypass = await service.retry(policyJob.id);
assert.equal(bypass.ok, false);
assert.equal(bypass.code === 'ask_mode_denied' || bypass.code === 'model_unavailable', true);
available = true;

const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });
async function invoke(method, route, id, workspaceFolder) {
  let status = 200;
  let body;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  await routes.get(`${method} ${route}`)({
    params: { id },
    body: { workspaceFolder },
    query: {},
  }, res);
  return { status, body };
}
const ownFolder = ISOLATED_DATA_DIR;
const readOwn = await invoke('GET', '/api/delegations/:id', d.id, ownFolder);
const ackOwn = await invoke('POST', '/api/delegations/:id/ack', d.id, ownFolder);
assert.equal(readOwn.status, 200);
assert.equal(ackOwn.status, 200);
const read = await invoke('GET', '/api/delegations/:id', d.id, '/another-workspace');
const ack = await invoke('POST', '/api/delegations/:id/ack', d.id, '/another-workspace');
const retryDenied = await invoke('POST', '/api/delegations/:id/retry', d.id, '/another-workspace');
assert.equal(read.status, 403);
assert.equal(ack.status, 403);
assert.equal(retryDenied.status, 403);

registerChatRunAdapter({
  transport: 'opencode',
  getState: () => null,
  cancel: async () => {},
  start: async ({ deps }) => {
    finishDelegation(getDelegationById(deps.delegationId), {
      status: 'failed',
      error: 'Immediate failure',
    });
    return { accepted: true, runId: crypto.randomUUID() };
  },
});
const race = await start(parent('Immediate outcome'));
assert.equal(race.ok, false);
assert.equal(race.delegation.status, 'failed');
assert.equal(race.delegation.error, 'Immediate failure');
registerMockChatRunAdapter('opencode');

const file = getDelegationsDataPath();
const beforeCorrupt = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, '{BROKEN');
let corruptCode = '';
try {
  loadDelegations();
} catch (err) {
  corruptCode = err?.code || '';
}
assert.equal(corruptCode, 'DELEGATIONS_CORRUPT');
assert.equal(fs.readFileSync(file, 'utf8'), '{BROKEN');
let createThrew = false;
try {
  createDelegationRecord({ parentChatId: 'new', childChatId: 'new' });
} catch {
  createThrew = true;
}
assert.equal(createThrew, true);
assert.equal(fs.readFileSync(file, 'utf8'), '{BROKEN');
fs.writeFileSync(file, beforeCorrupt);

setDelegationCrashHook((phase) => {
  if (phase === 'after-result-write') throw new Error('crash-after-result');
});
const crashParent = parent('Crash');
const crashJob = (await start(crashParent)).delegation;
let crashed = false;
try {
  finishDelegation(crashJob, {
    status: 'completed',
    report: 'saved before mailbox',
    enqueueParentReply: true,
  });
} catch (err) {
  crashed = String(err?.message || '').includes('crash-after-result');
}
assert.equal(crashed, true);
const crashedRow = getDelegationById(crashJob.id);
assert.equal(crashedRow.status, 'completed');
setDelegationCrashHook(null);
await flushDelegationOutbox(crashedRow);
const crashReplies = loadMailboxMessages().filter((row) => row.delegationId === crashJob.id);
assert.equal(crashReplies.some((row) => row.replyKind === 'final_report'), true);

{
  let resolveCancel = () => {};
  let enteredCancel = () => {};
  const cancelGate = new Promise((resolve) => { resolveCancel = resolve; });
  const enteredGate = new Promise((resolve) => { enteredCancel = resolve; });
  let state = { runId: 'r1', busy: true, waitingForInput: false };
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => state,
    cancel: async () => {
      enteredCancel();
      await cancelGate;
    },
    start: async () => ({ accepted: true, runId: state.runId }),
  });
  const child = parent('stale-cancel-child');
  const job = createDelegationRecord({
    parentChatId: parent('stale-cancel-parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    attemptId: 'a1',
    runId: 'r1',
  });
  const pending = service.cancel(job.id);
  await enteredGate;
  updateDelegationRecord(job.id, { attemptId: 'a2', runId: 'r2', status: 'running' });
  state = { runId: 'r2', busy: false, waitingForInput: false };
  resolveCancel();
  const result = await pending;
  const latest = getDelegationById(job.id);
  assert.equal(latest.attemptId, 'a2');
  assert.equal(latest.runId, 'r2');
  assert.equal(latest.status, 'running');
  assert.equal(result.stale, true);
  assert.equal(result.skipped, true);
  registerMockChatRunAdapter('opencode');
}

{
  let resolveCancel = () => {};
  let enteredCancel = () => {};
  const cancelGate = new Promise((resolve) => { resolveCancel = resolve; });
  const enteredGate = new Promise((resolve) => { enteredCancel = resolve; });
  let state = { runId: 'r1', busy: true, waitingForInput: false };
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => state,
    cancel: async () => {
      enteredCancel();
      await cancelGate;
    },
    start: async () => ({ accepted: true, runId: state.runId }),
  });
  const child = parent('stale-cancel-busy-child');
  const job = createDelegationRecord({
    parentChatId: parent('stale-cancel-busy-parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    attemptId: 'a1',
    runId: 'r1',
  });
  const pending = service.cancel(job.id);
  await enteredGate;
  updateDelegationRecord(job.id, { attemptId: 'a2', runId: 'r2', status: 'running' });
  state = { runId: 'r2', busy: true, waitingForInput: false };
  resolveCancel();
  await pending;
  assert.equal(getDelegationById(job.id).status, 'running');
  registerMockChatRunAdapter('opencode');
}

{
  let resolveCancel = () => {};
  let enteredCancel = () => {};
  const cancelGate = new Promise((resolve) => { resolveCancel = resolve; });
  const enteredGate = new Promise((resolve) => { enteredCancel = resolve; });
  let state = { runId: 'r1', busy: true, waitingForInput: false };
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => state,
    cancel: async () => {
      enteredCancel();
      await cancelGate;
      throw new Error('cancel failed');
    },
    start: async () => ({ accepted: true, runId: state.runId }),
  });
  const child = parent('stale-cancel-reject-child');
  const job = createDelegationRecord({
    parentChatId: parent('stale-cancel-reject-parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'running',
    attemptId: 'a1',
    runId: 'r1',
  });
  const pending = service.cancel(job.id);
  await enteredGate;
  updateDelegationRecord(job.id, { attemptId: 'a2', runId: 'r2', status: 'running' });
  state = { runId: 'r2', busy: false, waitingForInput: false };
  resolveCancel();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(getDelegationById(job.id).status, 'running');
  registerMockChatRunAdapter('opencode');
}

{
  let resolveCancel = () => {};
  let enteredCancel = () => {};
  const cancelGate = new Promise((resolve) => { resolveCancel = resolve; });
  const enteredGate = new Promise((resolve) => { enteredCancel = resolve; });
  let state = { runId: 'r1', busy: false, waitingForInput: false };
  registerChatRunAdapter({
    transport: 'opencode',
    getState: () => state,
    cancel: async () => {
      enteredCancel();
      await cancelGate;
    },
    start: async () => ({ accepted: true, runId: state.runId }),
  });
  const child = parent('stale-cancel-terminal-child');
  const job = createDelegationRecord({
    parentChatId: parent('stale-cancel-terminal-parent').id,
    childChatId: child.id,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'completed',
    attemptId: 'a1',
    runId: 'r1',
  });
  updateDelegationRecord(job.id, { runStoppingAt: new Date().toISOString(), status: 'completed' });
  const pending = service.cancel(job.id);
  await enteredGate;
  updateDelegationRecord(job.id, {
    attemptId: 'a2',
    runId: 'r2',
    status: 'running',
    runStoppingAt: new Date().toISOString(),
  });
  state = { runId: 'r2', busy: false, waitingForInput: false };
  resolveCancel();
  const result = await pending;
  const latest = getDelegationById(job.id);
  assert.equal(latest.attemptId, 'a2');
  assert.equal(latest.status, 'running');
  assert.ok(String(latest.runStoppingAt || '').trim());
  assert.equal(result.stale, true);
  registerMockChatRunAdapter('opencode');
}

console.log('delegation-audit-fixes.test.js OK');
