import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationService,
  finishDelegation,
  flushDelegationOutbox,
} from '../lib/delegation-service.js';
import { getDelegationById, loadDelegations } from '../lib/persist/delegations-persist.js';
import { loadMailboxMessages } from '../lib/persist/delegation-mailbox-persist.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import { registerMockChatRunAdapter, patchMockChatRun, getMockChatRun } from '../lib/chat-run/mock-adapter.js';

registerMockChatRunAdapter('opencode');
const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});
const parent = (title) => addChat(crypto.randomUUID(), title, null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const start = (p, text = 'probe') => service.createAndStart({
  parentChatId: p.id,
  sourceKind: 'text',
  taskText: text,
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});

function registerGatedStart(transport = 'opencode') {
  let releaseStart = () => {};
  let signalEntered = () => {};
  let busy = false;
  let cancels = 0;
  let accepted = false;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const gate = new Promise((resolve) => { releaseStart = resolve; });
  registerChatRunAdapter({
    transport,
    getState: () => (busy ? { busy: true, runId: 'late-run' } : null),
    cancel: async () => {
      cancels += 1;
      busy = false;
    },
    start: async () => {
      signalEntered();
      await gate;
      busy = true;
      accepted = true;
      return { accepted: true, runId: 'late-run' };
    },
  });
  return {
    entered,
    releaseStart: () => releaseStart(),
    stats: () => ({ busy, cancels, accepted }),
  };
}

{
  const gate = registerGatedStart();
  const pending = start(parent('R1 start cancel'));
  await gate.entered;
  const row = loadDelegations().at(-1);
  const cancelled = await service.cancel(row.id);
  assert.equal(cancelled.delegation.status === 'cancelling' || cancelled.pending === true, true);
  gate.releaseStart();
  const started = await pending;
  const finalRow = getDelegationById(row.id);
  assert.equal(finalRow.status, 'cancelled');
  assert.equal(gate.stats().busy, false);
  assert.equal(gate.stats().cancels >= 1, true);
  assert.equal(started.delegation.status, 'cancelled');
}

registerMockChatRunAdapter('opencode');
{
  const firstParent = parent('R1 retry cancel');
  const created = await start(firstParent);
  finishDelegation(created.delegation, { status: 'failed', error: 'first' });
  patchMockChatRun(created.delegation.childChatId, { busy: false, waitingForInput: false });
  const gate = registerGatedStart();
  const pending = service.retry(created.delegation.id);
  await gate.entered;
  const cancelled = await service.cancel(created.delegation.id);
  assert.equal(cancelled.ok, true);
  gate.releaseStart();
  await pending;
  const finalRow = getDelegationById(created.delegation.id);
  assert.equal(finalRow.status, 'cancelled');
  assert.equal(gate.stats().busy, false);
}

registerMockChatRunAdapter('opencode');
{
  const matrixParent = parent('R1 matrix running cancel');
  const created = await start(matrixParent);
  assert.equal(created.delegation.status, 'running');
  const cancelled = await service.cancel(created.delegation.id);
  assert.equal(cancelled.delegation.status, 'cancelled');
  assert.equal(getMockChatRun(created.delegation.childChatId)?.busy, false);
}

{
  const a = (await start(parent('R2 outbox snapshot'))).delegation;
  finishDelegation(a, { status: 'completed', report: 'REPORT A', enqueueParentReply: true });
  patchMockChatRun(a.childChatId, { busy: false });
  await service.retry(a.id);
  await flushDelegationOutbox(getDelegationById(a.id));
  const record = getDelegationById(a.id);
  const oldIntent = record.outbox.find((x) => x.type === 'mailbox' && x.attemptId === a.attemptId);
  assert.ok(oldIntent);
  assert.ok(String(oldIntent.deliveredAt || '').trim());
  const replies = loadMailboxMessages().filter((x) => x.delegationId === a.id);
  assert.equal(replies.some((row) => String(row.body || '').includes('REPORT A')), true);
  assert.equal(String(oldIntent.snapshot?.report || '').includes('REPORT A'), true);
}

{
  const job = (await start(parent('R2 null not delivered'))).delegation;
  finishDelegation(job, { status: 'cancelled' });
  const before = getDelegationById(job.id);
  const mailboxIntent = {
    id: crypto.randomUUID(),
    type: 'mailbox',
    event: 'parent_reply',
    attemptId: before.attemptId,
    createdAt: new Date().toISOString(),
    deliveredAt: '',
    snapshot: {
      status: 'cancelled',
      report: '',
      attemptId: before.attemptId,
      parentChatId: before.parentChatId,
      childChatId: before.childChatId,
    },
  };
  const { updateDelegationRecord } = await import('../lib/persist/delegations-persist.js');
  updateDelegationRecord(job.id, { outboxAppend: [mailboxIntent] });
  await flushDelegationOutbox(getDelegationById(job.id));
  const after = getDelegationById(job.id);
  const stored = after.outbox.find((row) => row.id === mailboxIntent.id);
  assert.equal(String(stored.deliveredAt || '').trim(), '');
  assert.equal(Number(stored.tryCount) >= 1, true);
}

console.log('delegation-review-followup.test.js OK');
