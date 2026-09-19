import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationService,
  finishDelegation,
  flushDelegationOutbox,
  setDelegationCrashHook,
} from '../lib/delegation-service.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { registerMockChatRunAdapter, patchMockChatRun } from '../lib/chat-run/mock-adapter.js';
import { stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';

stopDelegationRuntimeWorker();
registerMockChatRunAdapter('opencode');
const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});
const parent = (title) => addChat(crypto.randomUUID(), title, null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const start = (p) => service.createAndStart({
  parentChatId: p.id,
  sourceKind: 'text',
  taskText: 'outbox concurrency',
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});

function extraMailboxItem(attemptId, suffix) {
  return {
    id: crypto.randomUUID(),
    type: 'mailbox',
    event: 'finished',
    attemptId,
    tryCount: 0,
    nextAttemptAt: '',
    deliveredAt: '',
    lastError: '',
    snapshot: { attemptId, report: suffix },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

{
  let release = () => {};
  let waiting = false;
  setDelegationCrashHook(async (phase) => {
    if (phase !== 'before-mailbox') return;
    waiting = true;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  const job = (await start(parent('append during flush'))).delegation;
  finishDelegation(job, { status: 'completed', report: 'first', enqueueParentReply: true });
  const extra = extraMailboxItem(getDelegationById(job.id).attemptId, 'concurrent');
  const flushP = flushDelegationOutbox(getDelegationById(job.id));
  await waitFor(() => waiting);
  updateDelegationRecord(job.id, { outboxAppend: [extra] });
  release();
  await flushP;
  setDelegationCrashHook(null);
  const after = getDelegationById(job.id);
  assert.equal(after.outbox.some((row) => row.id === extra.id), true);
  const originalMailbox = after.outbox.find((row) => row.type === 'mailbox' && row.id !== extra.id);
  assert.ok(originalMailbox);
  assert.equal(String(originalMailbox.deliveredAt || '').trim() !== '', true);
}

{
  let release = () => {};
  let waiting = false;
  setDelegationCrashHook(async (phase) => {
    if (phase !== 'before-mailbox') return;
    waiting = true;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  const job = (await start(parent('retry during flush'))).delegation;
  finishDelegation(job, { status: 'completed', report: 'attempt-a', enqueueParentReply: true });
  const firstAttempt = getDelegationById(job.id).attemptId;
  const firstMailbox = getDelegationById(job.id).outbox.find((row) => row.type === 'mailbox');
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  const flushP = flushDelegationOutbox(getDelegationById(job.id));
  await waitFor(() => waiting);
  const retried = await service.retry(job.id);
  assert.equal(retried.ok, true);
  release();
  await flushP;
  setDelegationCrashHook(null);
  const after = getDelegationById(job.id);
  assert.equal(after.attemptId !== firstAttempt, true);
  assert.equal(after.outbox.some((row) => row.id === firstMailbox.id), true);
  const firstStored = after.outbox.find((row) => row.id === firstMailbox.id);
  assert.equal(String(firstStored.deliveredAt || '').trim() !== '', true);
}

{
  const releases = [];
  setDelegationCrashHook(async (phase) => {
    if (phase !== 'before-mailbox') return;
    await new Promise((resolve) => {
      releases.push(resolve);
    });
  });
  const job = (await start(parent('parallel flush'))).delegation;
  finishDelegation(job, { status: 'completed', report: 'parallel', enqueueParentReply: true });
  const extra = extraMailboxItem(getDelegationById(job.id).attemptId, 'second');
  const first = flushDelegationOutbox(getDelegationById(job.id));
  await waitFor(() => releases.length === 1);
  updateDelegationRecord(job.id, { outboxAppend: [extra] });
  const second = flushDelegationOutbox(getDelegationById(job.id));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(releases.length, 1);
  releases[0]();
  await first;
  await waitFor(() => releases.length === 2);
  releases[1]();
  await second;
  setDelegationCrashHook(null);
  const after = getDelegationById(job.id);
  assert.equal(after.outbox.some((row) => row.id === extra.id), true);
}

{
  const job = (await start(parent('item patch'))).delegation;
  finishDelegation(job, { status: 'completed', report: 'patch', enqueueParentReply: true });
  const current = getDelegationById(job.id);
  const mailbox = current.outbox.find((row) => row.type === 'mailbox');
  const extra = extraMailboxItem(current.attemptId, 'kept');
  updateDelegationRecord(job.id, { outboxAppend: [extra] });
  const patched = updateDelegationRecord(job.id, {
    outboxItemPatch: {
      id: mailbox.id,
      expectedAttemptId: mailbox.attemptId,
      patch: { deliveredAt: '2026-09-18T10:00:00.000Z', lastError: '' },
    },
  });
  assert.equal(patched.outbox.some((row) => row.id === extra.id), true);
  const stored = patched.outbox.find((row) => row.id === mailbox.id);
  assert.equal(stored.deliveredAt, '2026-09-18T10:00:00.000Z');
}

console.log('delegation-outbox-concurrency.test.js OK');
