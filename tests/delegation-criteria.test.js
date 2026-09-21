import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents, loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { buildChatPlanRelativePath } from '../lib/chat-plan-path.js';
import {
  createDelegationService,
  finishDelegation,
  flushDelegationOutbox,
  releaseDelegationRunSlot,
  setDelegationCrashHook,
} from '../lib/delegation-service.js';
import { getDelegationById, loadDelegations } from '../lib/persist/delegations-persist.js';
import { loadMailboxMessages } from '../lib/persist/delegation-mailbox-persist.js';
import { registerMockChatRunAdapter, patchMockChatRun } from '../lib/chat-run/mock-adapter.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { DELEGATION_PLAN_CONTEXT_LIMIT } from '../lib/delegation-prompt.js';
import { hashDelegationContent } from '../lib/delegation-request.js';

registerMockChatRunAdapter('opencode');
let available = true;
const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  isModelAvailable: () => available,
});
const parent = (title, extras = {}) => addChat(crypto.randomUUID(), title, null, ISOLATED_DATA_DIR, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
  ...extras,
});
const startText = (p, text = 'Audit task') => service.createAndStart({
  parentChatId: p.id,
  sourceKind: 'text',
  taskText: text,
  executor: { transport: 'opencode', model: 'opencode/test' },
  idempotencyKey: crypto.randomUUID(),
});
function releaseJob(result) {
  const job = result?.delegation || result;
  if (!job?.id) return;
  finishDelegation(job, { status: 'completed', report: 'released' });
  if (job.childChatId) {
    patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
  }
  releaseDelegationRunSlot(getDelegationById(job.id) || job);
}
function writeRawPlan(chatId, body) {
  const rel = buildChatPlanRelativePath(chatId);
  const abs = path.join(ISOLATED_DATA_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

{
  const atLimit = await startText(parent('text limit'), 'x'.repeat(DELEGATION_PLAN_CONTEXT_LIMIT));
  assert.equal(atLimit.ok, true);
  const over = await startText(parent('text over'), 'x'.repeat(DELEGATION_PLAN_CONTEXT_LIMIT + 1));
  assert.equal(over.ok, false);
  assert.equal(over.code, 'plan_too_large');
  releaseJob(atLimit);
}

{
  const p = parent('plan limits');
  writeRawPlan(p.id, 'y'.repeat(DELEGATION_PLAN_CONTEXT_LIMIT));
  const atLimit = await service.createAndStart({
    parentChatId: p.id,
    sourceKind: 'plan',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(atLimit.ok, true);
  const p2 = parent('plan over');
  writeRawPlan(p2.id, 'y'.repeat(DELEGATION_PLAN_CONTEXT_LIMIT + 1));
  const over = await service.createAndStart({
    parentChatId: p2.id,
    sourceKind: 'plan',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'plan_too_large');
  releaseJob(atLimit);
}

{
  const p = parent('message limits');
  const atText = 'z'.repeat(DELEGATION_PLAN_CONTEXT_LIMIT);
  const overText = 'z'.repeat(DELEGATION_PLAN_CONTEXT_LIMIT + 1);
  const atHist = appendChatHistoryEvents(p.id, '', [{ rec: { kind: 'localUser', text: atText } }]);
  const atSeq = atHist.appended?.[0]?.seq || loadChatHistory(p.id).events.at(-1).seq;
  const atLimit = await service.createAndStart({
    parentChatId: p.id,
    sourceKind: 'message',
    historySeq: atSeq,
    contentHash: hashDelegationContent(atText),
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(atLimit.ok, true);
  const p2 = parent('message over');
  const overHist = appendChatHistoryEvents(p2.id, '', [{ rec: { kind: 'localUser', text: overText } }]);
  const overSeq = overHist.appended?.[0]?.seq || loadChatHistory(p2.id).events.at(-1).seq;
  const over = await service.createAndStart({
    parentChatId: p2.id,
    sourceKind: 'message',
    historySeq: overSeq,
    contentHash: hashDelegationContent(overText),
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'plan_too_large');
  releaseJob(atLimit);
}

{
  const p = parent('ask only');
  const job = (await startText(p)).delegation;
  finishDelegation(job, { status: 'failed', error: 'x' });
  patchMockChatRun(job.childChatId, { busy: false });
  updateChat(p.id, { sdkMode: 'ask' });
  const denied = await service.retry(job.id);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'ask_mode_denied');
  releaseJob(job);
}

{
  const p = parent('model only');
  const job = (await startText(p)).delegation;
  finishDelegation(job, { status: 'failed', error: 'x' });
  patchMockChatRun(job.childChatId, { busy: false });
  available = false;
  const denied = await service.retry(job.id);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'model_unavailable');
  available = true;
  releaseJob(job);
}

{
  const p = parent('stale attempt');
  const first = (await startText(p)).delegation;
  finishDelegation(first, { status: 'completed', report: 'A report', enqueueParentReply: true });
  patchMockChatRun(first.childChatId, { busy: false });
  const retried = await service.retry(first.id);
  assert.equal(retried.ok, true);
  await flushDelegationOutbox(getDelegationById(first.id));
  const after = getDelegationById(first.id);
  assert.equal(after.attemptId !== first.attemptId, true);
  assert.equal(String(after.reportDeliveredAt || '').trim(), '');
  const replies = loadMailboxMessages().filter((row) => row.delegationId === first.id);
  assert.equal(replies.some((row) => row.delegationAttemptId === first.attemptId), true);
  releaseJob(retried);
}

{
  setDelegationCrashHook((phase) => {
    if (phase === 'after-prompt-accept') throw new Error('crash-after-accept');
  });
  const crashed = await startText(parent('crash after accept'));
  assert.equal(crashed.ok, false);
  assert.equal(crashed.delegation.status, 'failed');
  setDelegationCrashHook(null);
  releaseJob(crashed);
}

{
  setDelegationCrashHook((phase) => {
    if (phase === 'before-mailbox') throw new Error('crash-before-mailbox');
  });
  const job = (await startText(parent('crash before mailbox'))).delegation;
  let threw = false;
  try {
    finishDelegation(job, { status: 'completed', report: 'saved', enqueueParentReply: true });
    await flushDelegationOutbox(getDelegationById(job.id));
  } catch (err) {
    threw = String(err?.message || '').includes('crash-before-mailbox');
  }
  assert.equal(threw, true);
  const row = getDelegationById(job.id);
  assert.equal(row.status, 'completed');
  const mailbox = row.outbox.find((item) => item.type === 'mailbox');
  assert.equal(String(mailbox?.deliveredAt || '').trim(), '');
  setDelegationCrashHook(null);
  await flushDelegationOutbox(getDelegationById(job.id));
  const delivered = getDelegationById(job.id).outbox.find((item) => item.type === 'mailbox');
  assert.ok(String(delivered.deliveredAt || '').trim());
  releaseJob({ delegation: job });
}

{
  setDelegationCrashHook((phase) => {
    if (phase === 'outbox:history') throw new Error('crash-history');
  });
  const job = (await startText(parent('crash history'))).delegation;
  finishDelegation(job, { status: 'completed', report: 'hist' });
  let threw = false;
  try {
    await flushDelegationOutbox(getDelegationById(job.id));
  } catch (err) {
    threw = String(err?.message || '').includes('crash-history');
  }
  const row = getDelegationById(job.id);
  const historyItem = row.outbox.find((item) => item.type === 'history');
  if (threw) {
    assert.equal(row.status, 'completed');
  }
  setDelegationCrashHook(null);
  await flushDelegationOutbox(getDelegationById(job.id));
  const cards = loadChatHistory(job.parentChatId).events.filter((x) => x.rec?.variant === 'delegation');
  assert.equal(cards.length >= 1, true);
  assert.ok(historyItem);
  releaseJob({ delegation: job });
}

const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });
async function invoke(method, route, id, extras = {}) {
  let status = 200;
  let body;
  const res = {
    status(s) { status = s; return this; },
    json(b) { body = b; return this; },
  };
  await routes.get(`${method} ${route}`)({
    params: { id },
    body: { workspaceFolder: extras.workspaceFolder, workspaceFile: extras.workspaceFile },
    query: {},
    widgetAccess: extras.widgetAccess,
  }, res);
  return { status, body };
}

{
  const own = parent('scope widget', { widgetInstallationId: 'inst-own' });
  const job = (await startText(own)).delegation;
  const ops = [
    ['GET', '/api/delegations/:id'],
    ['POST', '/api/delegations/:id/cancel'],
    ['POST', '/api/delegations/:id/ack'],
    ['POST', '/api/delegations/:id/retry'],
  ];
  const ownFolder = ISOLATED_DATA_DIR;
  for (const [method, route] of ops) {
    const ok = await invoke(method, route, job.id, { workspaceFolder: ownFolder });
    assert.equal(ok.status === 200 || ok.status === 201 || ok.status === 202, true, `${method} own`);
    const foreign = await invoke(method, route, job.id, { workspaceFolder: '/another-workspace' });
    assert.equal(foreign.status, 403, `${method} foreign workspace`);
    const widgetOk = await invoke(method, route, job.id, {
      widgetAccess: { installationId: 'inst-own' },
    });
    assert.equal(widgetOk.status === 200 || widgetOk.status === 201 || widgetOk.status === 202 || widgetOk.status === 409, true, `${method} own widget`);
    const widgetDeny = await invoke(method, route, job.id, {
      widgetAccess: { installationId: 'inst-other' },
    });
    assert.equal(widgetDeny.status, 404, `${method} other widget`);
  }
  const listOwn = await invoke('GET', '/api/chats/:id/delegations', own.id, { workspaceFolder: ownFolder });
  assert.equal(listOwn.status, 200);
  const listForeign = await invoke('GET', '/api/chats/:id/delegations', own.id, { workspaceFolder: '/another-workspace' });
  assert.equal(listForeign.status, 403);
  const mailboxOwn = await invoke('GET', '/api/chats/:id/mailbox', own.id, { workspaceFolder: ownFolder });
  assert.equal(mailboxOwn.status, 200);
  const mailboxForeign = await invoke('GET', '/api/chats/:id/mailbox', own.id, { workspaceFolder: '/another-workspace' });
  assert.equal(mailboxForeign.status, 403);
  releaseJob({ delegation: job });
}

assert.equal(loadDelegations().length > 0, true);
console.log('delegation-criteria.test.js OK');
