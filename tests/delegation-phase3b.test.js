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
import { countDelegationAttempts } from '../lib/delegation-attempt.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import {
  drainChatMailbox,
  retryMailboxMessage,
  sendDelegationReply,
} from '../lib/delegation-mailbox.js';
import { createMailboxMessage, loadMailboxMessages } from '../lib/persist/delegation-mailbox-persist.js';
import {
  getMockChatRunStartCount,
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { CRETILI_MCP_TOOL_DEFS } from '../lib/mcp/mcp-builtin-tools.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function start(p, text = 'Phase 3b task') {
  return service.createAndStart({
    parentChatId: p.id,
    sourceKind: 'text',
    taskText: text,
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
}

function invokeRoute(routes, url, req) {
  let status = 200;
  let body;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  return routes.get(url)(req, res).then(() => ({ status, body }));
}

{
  const p = parent('E5 parallel retry-delivery');
  const job = (await start(p)).delegation;
  const failed = createMailboxMessage({
    fromChatId: job.childChatId,
    toChatId: p.id,
    delegationId: job.id,
    delegationAttemptId: job.attemptId,
    kind: 'reply',
    replyKind: 'progress',
    body: 'retry-once',
    status: 'failed',
  });
  const beforeAttempt = String(failed.attemptId || '');
  const beforeRevision = Number(failed.revision || 1);
  const [first, second] = await Promise.all([
    retryMailboxMessage(failed.id),
    retryMailboxMessage(failed.id),
  ]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  const afterParallel = loadMailboxMessages().find((row) => row.id === failed.id);
  assert.ok(afterParallel);
  assert.notEqual(afterParallel.status, 'failed');
  const replay = await retryMailboxMessage(failed.id);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  const afterReplay = loadMailboxMessages().find((row) => row.id === failed.id);
  assert.equal(afterReplay.revision, afterParallel.revision);
  assert.equal(afterReplay.attemptId, afterParallel.attemptId);
  assert.notEqual(afterParallel.attemptId, beforeAttempt);
  assert.equal(Number(afterReplay.revision || 0) > beforeRevision, true);
}

{
  const p = parent('E5 HTTP parallel retry-delivery');
  const job = (await start(p)).delegation;
  const failed = createMailboxMessage({
    fromChatId: job.childChatId,
    toChatId: p.id,
    delegationId: job.id,
    delegationAttemptId: job.attemptId,
    kind: 'reply',
    body: 'http-parallel',
    status: 'failed',
  });
  const routes = new Map();
  registerDelegationsRoutes({
    get: (url, fn) => routes.set(`GET ${url}`, fn),
    post: (url, fn) => routes.set(`POST ${url}`, fn),
  }, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });
  const req = {
    params: { id: job.id },
    body: { mailboxId: failed.id, attemptId: job.attemptId },
    query: { workspaceFolder: ISOLATED_DATA_DIR },
  };
  const [a, b] = await Promise.all([
    invokeRoute(routes, 'POST /api/delegations/:id/retry-delivery', req),
    invokeRoute(routes, 'POST /api/delegations/:id/retry-delivery', req),
  ]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const lostReplay = await invokeRoute(routes, 'POST /api/delegations/:id/retry-delivery', req);
  assert.equal(lostReplay.status, 200);
  const rows = loadMailboxMessages().filter((row) => row.id === failed.id);
  assert.equal(rows.length, 1);
  const mutated = rows.filter((row) => row.status !== 'failed');
  assert.equal(mutated.length, 1);
}

{
  const p = parent('E5 double retry-task');
  const job = (await start(p)).delegation;
  finishDelegation(job, { status: 'failed', error: 'boom' });
  patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  const beforeAttempts = countDelegationAttempts(getDelegationById(job.id));
  const startCount = getMockChatRunStartCount();
  const [first, second] = await Promise.all([
    service.retry(job.id),
    service.retry(job.id),
  ]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(first.delegation.attemptId, second.delegation.attemptId);
  const latest = getDelegationById(job.id);
  assert.equal(countDelegationAttempts(latest), beforeAttempts + 1);
  assert.equal(getMockChatRunStartCount(), startCount + 1);
}

{
  const p = parent('E6 final_report crash before outbox');
  const job = (await start(p)).delegation;
  const attemptId = job.attemptId;
  const runId = job.runId;
  const startCount = getMockChatRunStartCount();
  setDelegationCrashHook((phase) => {
    if (phase === 'after-final-report-before-outbox') {
      throw new Error('crash-final-before-outbox');
    }
  });
  let crashed = false;
  try {
    await sendDelegationReply({
      fromChatId: job.childChatId,
      body: 'durable final before outbox',
      replyKind: 'final_report',
      idempotencyKey: 'e6-final',
      attemptId,
      runId,
    });
  } catch (err) {
    crashed = String(err?.message || '').includes('crash-final-before-outbox');
  }
  setDelegationCrashHook(null);
  assert.equal(crashed, true);
  const afterCrash = getDelegationById(job.id);
  assert.equal(afterCrash.status, 'completed');
  assert.equal(afterCrash.attemptId, attemptId);
  assert.equal(afterCrash.finalReportAttemptId, attemptId);
  assert.equal(afterCrash.report, 'durable final before outbox');
  assert.equal(getMockChatRunStartCount(), startCount);
  await flushDelegationOutbox(afterCrash);
  await drainChatMailbox(p.id);
  const replies = loadMailboxMessages().filter((row) => row.delegationId === job.id);
  assert.equal(replies.some((row) => row.replyKind === 'final_report' && row.body.includes('durable final before outbox')), true);
  const late = await sendDelegationReply({
    fromChatId: job.childChatId,
    body: 'other final',
    replyKind: 'final_report',
    idempotencyKey: 'e6-final-other',
    attemptId,
    runId,
  });
  assert.equal(late.ok === false || late.replayed === true || getDelegationById(job.id).report === 'durable final before outbox', true);
  assert.equal(getDelegationById(job.id).attemptId, attemptId);
  assert.equal(countDelegationAttempts(getDelegationById(job.id)), 1);
}

{
  const reply = CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'delegation_reply');
  assert.ok(reply);
  const props = reply.inputSchema?.properties || {};
  assert.ok(props.attempt_id);
  assert.ok(props.run_id);
  assert.ok(props.task_outcome);
}

{
  const centerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app_front/features/delegations/delegationCenter.js');
  const src = fs.readFileSync(centerPath, 'utf8');
  assert.match(src, /data-mailbox-id=/);
  const clickFn = src.slice(src.indexOf('async function onListClick'));
  const confirmAt = clickFn.indexOf('if (!confirmImpl(confirmMessage(act, row))) return;');
  const postAt = clickFn.indexOf('postDelegationRetryDelivery');
  assert.equal(confirmAt >= 0 && postAt > confirmAt, true);
}

console.log('delegation-phase3b.test.js OK');
