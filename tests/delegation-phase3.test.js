import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationService,
  finishDelegation,
  inspectDelegationSlot,
  releaseDelegationRunSlot,
} from '../lib/delegation-service.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import {
  sendDelegationReply,
  retryMailboxMessage,
} from '../lib/delegation-mailbox.js';
import { createMailboxMessage, loadMailboxMessages, updateMailboxMessage } from '../lib/persist/delegation-mailbox-persist.js';
import {
  getMockChatRun,
  getMockChatRunStartCount,
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
  setMockChatRunFailCancel,
} from '../lib/chat-run/mock-adapter.js';
import { toCretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from '../lib/mcp/builtin/errors.js';
import { pageDelegationRows, describeDelegationMailbox } from '../lib/delegation-query.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { countDelegationAttempts } from '../lib/delegation-attempt.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});

function parent(title) {
  return addChat(crypto.randomUUID(), title, null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
}

function start(p, text = 'Phase 3 task') {
  return service.createAndStart({
    parentChatId: p.id,
    sourceKind: 'text',
    taskText: text,
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
}

function releaseJob(resultOrRow) {
  const job = resultOrRow?.delegation || resultOrRow;
  if (!job?.id) return;
  finishDelegation(job, { status: 'completed', report: 'released' });
  if (job.childChatId) {
    patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  }
  releaseDelegationRunSlot(getDelegationById(job.id) || job);
}

{
  const p = parent('Final report slot');
  const started = await start(p);
  assert.equal(started.ok, true);
  const job = started.delegation;
  const startCountBefore = getMockChatRunStartCount();
  const final = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'Executor report',
    replyKind: 'final_report',
    idempotencyKey: 'final-1',
    attemptId: job.attemptId,
    runId: job.runId,
  });
  assert.equal(final.ok, true, JSON.stringify(final));
  const afterFinal = getDelegationById(job.id);
  assert.equal(afterFinal.status, 'completed');
  assert.equal(afterFinal.acknowledgedAt, '');
  assert.equal(afterFinal.unverified, true);
  assert.equal(afterFinal.taskOutcome, 'unspecified');
  const slot = inspectDelegationSlot(afterFinal);
  const mock = getMockChatRun(job.childChatId);
  if (mock?.busy) {
    assert.equal(slot.occupied, true);
    assert.equal(slot.reason, 'run_stopping');
  } else {
    assert.equal(slot.occupied, false);
  }
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  const released = releaseDelegationRunSlot(getDelegationById(job.id));
  assert.equal(inspectDelegationSlot(released).occupied, false);
  const second = await start(p, 'Next job');
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.delegation.id, job.id);
  assert.equal(getMockChatRunStartCount() > startCountBefore, true);
  releaseJob(second);
}

{
  const p = parent('Busy parent');
  const first = await start(p);
  assert.equal(first.ok, true);
  const blocked = await start(p, 'Should not start');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'active_delegation_exists');
  assert.ok(
    ['job_in_progress', 'unknown', 'run_stopping', 'stale_running'].includes(blocked.reason),
    blocked.reason,
  );
  assert.equal(blocked.delegationId, first.delegation.id);
  assert.equal(blocked.attemptId, first.delegation.attemptId);
  releaseJob(first);
}

{
  const p = parent('Old final after retry');
  const first = await start(p);
  const oldAttempt = first.delegation.attemptId;
  const oldRun = first.delegation.runId;
  finishDelegation(first.delegation, { status: 'completed', report: 'one' });
  patchMockChatRun(first.delegation.childChatId, { busy: false, waitingForInput: false });
  const retried = await service.retry(first.delegation.id);
  assert.equal(retried.ok, true);
  const newAttempt = retried.delegation.attemptId;
  assert.notEqual(newAttempt, oldAttempt);
  const late = await sendDelegationReply({
    fromChatId: first.delegation.childChatId,
    body: 'stale final',
    replyKind: 'final_report',
    idempotencyKey: 'stale-final',
    attemptId: oldAttempt,
    runId: oldRun,
  });
  assert.equal(late.ok === false || getDelegationById(first.delegation.id).attemptId === newAttempt, true);
  assert.equal(getDelegationById(first.delegation.id).attemptId, newAttempt);
  assert.notEqual(getDelegationById(first.delegation.id).report, 'stale final');
  releaseJob(retried);
}

{
  const p = parent('Idempotency');
  const job = (await start(p)).delegation;
  const a = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'same',
    replyKind: 'final_report',
    idempotencyKey: 'k-final',
    attemptId: job.attemptId,
    runId: job.runId,
  });
  const replay = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'same',
    replyKind: 'final_report',
    idempotencyKey: 'k-final',
    attemptId: job.attemptId,
    runId: job.runId,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.id, a.message.id);
  const changed = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'changed',
    replyKind: 'final_report',
    idempotencyKey: 'k-final',
    attemptId: job.attemptId,
    runId: job.runId,
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'idempotency_conflict');
  const otherKey = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'same',
    replyKind: 'final_report',
    idempotencyKey: 'k-final-2',
    attemptId: job.attemptId,
    runId: job.runId,
  });
  assert.equal(otherKey.replayed, true);
  const otherFinal = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'other final',
    replyKind: 'final_report',
    idempotencyKey: 'k-final-3',
    attemptId: job.attemptId,
    runId: job.runId,
  });
  assert.equal(otherFinal.ok, false);
  assert.equal(otherFinal.code, 'idempotency_conflict');
  releaseJob(job);
}

{
  const p = parent('Cancel then report');
  const job = (await start(p)).delegation;
  setMockChatRunFailCancel(false);
  const cancelled = await service.cancel(job.id);
  assert.equal(cancelled.ok, true);
  const afterCancel = getDelegationById(job.id);
  const late = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'late final',
    replyKind: 'final_report',
    idempotencyKey: 'late-after-cancel',
    attemptId: job.attemptId,
    runId: job.runId,
  });
  assert.equal(late.ok, true);
  const latest = getDelegationById(job.id);
  if (afterCancel.status === 'cancelled') {
    assert.equal(latest.status, 'cancelled');
  }
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  releaseDelegationRunSlot(getDelegationById(job.id));
}

{
  const mapped = toCretliMcpToolError({
    code: 'still_active',
    message: 'still',
    status: 409,
    delegationId: 'd1',
    attemptId: 'a1',
    reason: 'job_in_progress',
  });
  assert.equal(mapped.code, MCP_BUILTIN_ERROR_CODES.CONFLICT);
  assert.equal(mapped.delegationId, 'd1');
  assert.equal(mapped.attemptId, 'a1');
  const busy = toCretliMcpToolError({ code: 'parent_busy', message: 'busy', status: 409 });
  assert.equal(busy.code, MCP_BUILTIN_ERROR_CODES.CONFLICT);
}

{
  const p = parent('Retry delivery target');
  const job = (await start(p)).delegation;
  const failedA = createMailboxMessage({
    fromChatId: job.childChatId,
    toChatId: p.id,
    delegationId: job.id,
    delegationAttemptId: job.attemptId,
    kind: 'reply',
    replyKind: 'progress',
    body: 'one',
    status: 'failed',
  });
  const failedB = createMailboxMessage({
    fromChatId: job.childChatId,
    toChatId: p.id,
    delegationId: job.id,
    delegationAttemptId: job.attemptId,
    kind: 'reply',
    replyKind: 'progress',
    body: 'two',
    status: 'failed',
  });
  const routes = new Map();
  registerDelegationsRoutes({
    get: (url, fn) => routes.set(`GET ${url}`, fn),
    post: (url, fn) => routes.set(`POST ${url}`, fn),
  }, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });
  let status = 200;
  let body;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  await routes.get('POST /api/delegations/:id/retry-delivery')({
    params: { id: job.id },
    body: {},
    query: { workspaceFolder: ISOLATED_DATA_DIR },
  }, res);
  assert.equal(status, 400);
  assert.equal(body.code, 'mailbox_id_required');
  status = 200;
  body = undefined;
  await routes.get('POST /api/delegations/:id/retry-delivery')({
    params: { id: job.id },
    body: { mailboxId: failedA.id, attemptId: job.attemptId },
    query: { workspaceFolder: ISOLATED_DATA_DIR },
  }, res);
  assert.equal(status, 200);
  assert.equal(body.retried, 1);
  const afterA = loadMailboxMessages().find((row) => row.id === failedA.id);
  const afterB = loadMailboxMessages().find((row) => row.id === failedB.id);
  assert.notEqual(afterA.status, 'failed');
  assert.equal(afterB.status, 'failed');
  status = 200;
  body = undefined;
  await routes.get('POST /api/delegations/:id/retry-delivery')({
    params: { id: job.id },
    body: { mailboxId: 'missing-mailbox', attemptId: job.attemptId },
    query: { workspaceFolder: ISOLATED_DATA_DIR },
  }, res);
  assert.equal(status, 404);
  releaseJob(job);
}

{
  const p = parent('Retry delivery zero');
  const job = (await start(p)).delegation;
  const routes = new Map();
  registerDelegationsRoutes({
    get: (url, fn) => routes.set(`GET ${url}`, fn),
    post: (url, fn) => routes.set(`POST ${url}`, fn),
  }, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });
  let status = 200;
  let body;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  await routes.get('POST /api/delegations/:id/retry-delivery')({
    params: { id: job.id },
    body: {},
    query: { workspaceFolder: ISOLATED_DATA_DIR },
  }, res);
  assert.equal(status, 400);
  assert.equal(body.code, 'mailbox_id_required');
  assert.equal(body.retryableMailboxCount, 0);
  releaseJob(job);
}

{
  const p = parent('Retry delivery one');
  const job = (await start(p)).delegation;
  const only = createMailboxMessage({
    fromChatId: job.childChatId,
    toChatId: p.id,
    delegationId: job.id,
    delegationAttemptId: job.attemptId,
    kind: 'reply',
    replyKind: 'progress',
    body: 'only',
    status: 'failed',
  });
  const routes = new Map();
  registerDelegationsRoutes({
    get: (url, fn) => routes.set(`GET ${url}`, fn),
    post: (url, fn) => routes.set(`POST ${url}`, fn),
  }, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });
  let status = 200;
  let body;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  await routes.get('POST /api/delegations/:id/retry-delivery')({
    params: { id: job.id },
    body: {},
    query: { workspaceFolder: ISOLATED_DATA_DIR },
  }, res);
  assert.equal(status, 400);
  assert.equal(body.code, 'mailbox_id_required');
  assert.equal(body.retryableMailboxCount, 1);
  status = 200;
  body = undefined;
  await routes.get('POST /api/delegations/:id/retry-delivery')({
    params: { id: job.id },
    body: { mailboxId: only.id, attemptId: job.attemptId },
    query: { workspaceFolder: ISOLATED_DATA_DIR },
  }, res);
  assert.equal(status, 200);
  assert.equal(body.retried, 1);
  releaseJob(job);
}

{
  const p = parent('Retry task vs delivery');
  const job = (await start(p)).delegation;
  finishDelegation(job, { status: 'failed', error: 'boom' });
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  const beforeAttempts = countDelegationAttempts(getDelegationById(job.id));
  updateMailboxMessage((createMailboxMessage({
    fromChatId: job.childChatId,
    toChatId: p.id,
    delegationId: job.id,
    delegationAttemptId: job.attemptId,
    kind: 'reply',
    body: 'fail-mail',
    status: 'failed',
  })).id, { status: 'failed' });
  const mail = loadMailboxMessages().find((row) => row.delegationId === job.id && row.status === 'failed');
  await retryMailboxMessage(mail.id);
  assert.equal(countDelegationAttempts(getDelegationById(job.id)), beforeAttempts);
  const startCount = getMockChatRunStartCount();
  const retried = await service.retry(job.id);
  assert.equal(retried.ok, true);
  assert.equal(countDelegationAttempts(retried.delegation), beforeAttempts + 1);
  assert.equal(getMockChatRunStartCount(), startCount + 1);
  releaseJob(retried);
}

{
  const p = parent('Ack no run');
  const job = (await start(p)).delegation;
  finishDelegation(job, { status: 'completed', report: 'done' });
  patchMockChatRun(job.childChatId, { busy: false });
  const startCount = getMockChatRunStartCount();
  const ack = service.acknowledge(job.id, { reason: 'reviewed' });
  assert.equal(ack.ok, true);
  assert.ok(String(ack.delegation.acknowledgedAt || '').trim());
  assert.equal(getMockChatRunStartCount(), startCount);
  const run = getMockChatRun(job.childChatId);
  assert.equal(run?.busy === true, false);
}

{
  const p = parent('Stop ends run');
  const job = (await start(p)).delegation;
  assert.equal(getMockChatRun(job.childChatId)?.busy, true);
  const stopped = await service.cancel(job.id);
  assert.equal(stopped.ok, true);
  assert.equal(getMockChatRun(job.childChatId)?.busy, false);
  const latest = getDelegationById(job.id);
  assert.equal(latest.status === 'cancelled' || latest.status === 'cancelling', true);
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  releaseDelegationRunSlot(getDelegationById(job.id));
}

{
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: `job-${String(index).padStart(3, '0')}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'completed',
  }));
  const first = pageDelegationRows(rows, { limit: 40 });
  assert.equal(first.items.length, 40);
  assert.ok(first.nextCursor);
  const second = pageDelegationRows(rows, { limit: 40, cursor: first.nextCursor });
  assert.equal(second.items.length, 5);
  const ids = new Set([...first.items, ...second.items].map((row) => row.id));
  assert.equal(ids.size, 45);
  const inserted = pageDelegationRows([
    ...rows,
    { id: 'job-new', createdAt: '2026-02-01T00:00:00.000Z', status: 'completed' },
  ], { limit: 40, cursor: first.nextCursor });
  assert.equal(inserted.items.some((row) => row.id === 'job-new'), false);
  assert.equal(inserted.items.some((row) => row.id === 'job-000'), true);
}

{
  const mailbox = describeDelegationMailbox([
    { status: 'queued' },
    { status: 'failed' },
    { status: 'uncertain' },
  ]);
  assert.equal(mailbox.pendingMailbox, true);
  assert.equal(mailbox.failedMailbox, true);
  assert.equal(mailbox.retryableMailboxCount, 2);
}

{
  const unknown = inspectDelegationSlot({
    id: 'u1',
    status: 'running',
    attemptId: 'a',
    childChatId: 'missing-child',
    runId: 'r',
  });
  assert.equal(unknown.occupied, true);
  assert.equal(unknown.reason, 'unknown');
  assert.notEqual(unknown.reason, 'stale_running');
}

console.log('delegation-phase3.test.js OK');
