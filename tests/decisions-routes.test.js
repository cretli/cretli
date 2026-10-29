import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-dir.js';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import { createWidgetInstallation, createWidgetAccessToken } from '../lib/widget/widget-installations.ts';
import { addTodo, getTodo, updateTodo } from '../lib/persist/todos-store.js';
import { createDecision, listPendingDecisions, closeDecisionStores } from '../lib/decisions/decision-store.js';
import { registerDecisionsRoutes } from '../lib/routes/decisions-routes.js';
import { subscribeChatListUpdates, unsubscribeChatListUpdates } from '../lib/chat-list-updates.js';

const cwd = makeTempDir('cretli-decisions-');
setPassword('decision-test-password');
const session = createSession();
const agentSession = createSession({ agentSession: true });
const cookie = (token) => `cr_session=${encodeURIComponent(token)}`;
const humanHeaders = { cookie: cookie(session), [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(session) };
const app = express();
app.use(express.json());
app.use(requireAuth);
const lease = { ms: 60_000 };
registerDecisionsRoutes(app, { dataDir, getCurrentCwd: () => cwd, get claimLeaseMs() { return lease.ms; } });
const server = await new Promise((resolve) => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDecisionStores();
});
const base = `http://127.0.0.1:${server.address().port}`;
async function request(method, url, headers = {}, body) {
  const response = await fetch(base + url, {
    method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
function payload(card, optionId = 'approve', extra = {}) {
  return { optionId, expectedRevision: card.revision, ...extra };
}

test('server classification cannot be lowered and timeout recommendation is refused', async () => {
  const options = [
    { id: 'approve', label: 'Approve', effect: 'Approve', risk: 'low', reversible: true },
    { id: 'reject', label: 'Reject', effect: 'Reject' },
  ];
  const input = { kind: 'plan_approval', risk: 'low', reversible: true, subject: { todoId: 'classification', updatedAt: '1' }, workspaceFolder: cwd,
    title: 'Plan', dedupeKey: 'classification', options };
  const card = await createDecision(dataDir, input);
  assert.equal(card.risk, 'high');
  assert.equal(card.humanOnly, true);
  assert.equal(card.reversible, false);
  assert.equal(card.options[0].risk, 'high');
  assert.equal(card.options[0].reversible, false);
  assert.equal((await createDecision(dataDir, input)).id, card.id);
  assert.equal((await listPendingDecisions(dataDir, cwd)).items.filter((item) => item.dedupeKey === 'classification').length, 1);
  const replacement = await createDecision(dataDir, { ...input, subject: { todoId: 'classification', updatedAt: '2' } });
  assert.notEqual(replacement.id, card.id);
  assert.equal((await listPendingDecisions(dataDir, cwd)).items.filter((item) => item.dedupeKey === 'classification').length, 1);
  for (const kind of ['plan_approval', 'integration', 'policy_upgrade', 'needs_human']) {
    await assert.rejects(() => createDecision(dataDir, { ...input, kind, dedupeKey: kind, onTimeout: 'recommended' }), /Recommended timeout/);
  }
});

test('human channel codes, stale CAS, and plan approval share the todo update path', async () => {
  const created = await addTodo(dataDir, cwd, { title: 'Review plan' });
  const todo = created.item;
  await updateTodo(dataDir, cwd, todo.id, { plan: { markdown: 'Approved plan', updatedAt: new Date().toISOString() } });
  const listed = await request('GET', '/api/decisions', humanHeaders);
  assert.equal(listed.status, 200);
  const card = listed.body.items.find((item) => item.subject.todoId === todo.id);
  assert.ok(card);
  assert.equal(card.kind, 'plan_approval');
  const id = card.id;
  const url = `/api/decisions/${id}`;
  assert.equal((await request('POST', url, {}, payload(card))).status, 401);
  assert.equal((await request('POST', url, { cookie: cookie(session) }, payload(card))).status, 403);
  assert.equal((await request('POST', url, { cookie: cookie(session), [AUTH_CSRF_HEADER]: 'wrong' }, payload(card))).status, 403);
  const mcp = mintMcpIntegrationToken({ sessionId: 'test', chatId: 'test', workspaceFolder: cwd, harness: 'test', incarnation: 'test' });
  assert.equal((await request('POST', url, { authorization: `Bearer ${mcp}` }, payload(card))).status, 403);
  const widget = createWidgetInstallation({ name: 'Decision test', workspaceFolder: cwd, workspaceFile: null, model: null,
    allowedOrigins: ['https://example.com'], permissions: [], enabled: true });
  const widgetToken = createWidgetAccessToken({ installationId: widget.id, origin: 'https://example.com', pageSessionId: 'test' });
  assert.equal((await request('POST', url, { authorization: `Bearer ${widgetToken}` }, payload(card))).status, 403);
  assert.equal((await request('POST', url, { cookie: cookie(agentSession), [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(agentSession) }, payload(card))).status, 403);
  assert.equal((await request('POST', url, humanHeaders, payload(card, 'unknown'))).status, 400);
  const approved = await request('POST', url, humanHeaders, payload(card, 'approve', { decidedBy: { kind: 'agent' } }));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(approved.body.decision.decidedBy, { kind: 'human-session' });
  assert.ok((await getTodo(dataDir, cwd, todo.id)).plan.approvedAt);
  assert.equal((await request('POST', url, humanHeaders, payload(card))).status, 409);
  const audit = fs.readFileSync(path.join(dataDir, 'approvals', 'decisions-audit.jsonl'), 'utf8');
  assert.match(audit, /"kind":"plan_approval"/);
  assert.equal(fs.existsSync(path.join(dataDir, 'approvals', 'approval-audit.jsonl')), false);

  const second = await addTodo(dataDir, cwd, { title: 'Stale plan' });
  await updateTodo(dataDir, cwd, second.item.id, { plan: { markdown: 'Draft', updatedAt: new Date().toISOString() } });
  const next = await request('GET', '/api/decisions', humanHeaders);
  const stale = next.body.items.find((item) => item.subject.todoId === second.item.id);
  assert.ok(stale);
  await updateTodo(dataDir, cwd, second.item.id, { body: 'Changed after card creation' });
  const conflict = await request('POST', `/api/decisions/${stale.id}`, humanHeaders, payload(stale));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CONFLICT');
  const afterStale = await request('GET', '/api/decisions', humanHeaders);
  assert.ok(!afterStale.body.items.some((item) => item.id === stale.id));
});

test('decisionsChanged carries revision to session websocket clients', async () => {
  const messages = [];
  const ws = { readyState: 1, bufferedAmount: 0, once() {}, send(message) { messages.push(JSON.parse(message)); } };
  subscribeChatListUpdates(ws, { kind: 'session' });
  try {
    await createDecision(dataDir, { kind: 'question', subject: { todoId: 'ws', updatedAt: '1' }, workspaceFolder: cwd,
      title: 'Question', dedupeKey: 'ws', options: [{ id: 'a', label: 'A', effect: 'A' }, { id: 'b', label: 'B', effect: 'B' }] });
    assert.ok(messages.some((message) => message.type === 'decisionsChanged' && Number.isSafeInteger(message.revision)));
  } finally { unsubscribeChatListUpdates(ws); }
});

test('integration card rejects through the existing integration service and becomes stale', async () => {
  const created = await addTodo(dataDir, cwd, { title: 'Integrate change', status: 'ready' });
  await updateTodo(dataDir, cwd, created.item.id, { status: 'doing', integration: { state: 'ready' } });
  const listed = await request('GET', '/api/decisions', humanHeaders);
  const card = listed.body.items.find((item) => item.subject.todoId === created.item.id && item.kind === 'integration');
  assert.ok(card);
  assert.deepEqual(card.options.map((option) => option.id), ['confirm', 'reject', 'no_code']);
  const resolved = await request('POST', `/api/decisions/${card.id}`, humanHeaders, payload(card, 'reject'));
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const todo = await getTodo(dataDir, cwd, created.item.id);
  assert.equal(todo.status, 'ready');
  assert.equal(todo.integration.state, 'rejected');
  const current = await request('GET', '/api/decisions', humanHeaders);
  assert.ok(!current.body.items.some((item) => item.id === card.id));
});

test('no-code integration decision passes the human attestation through the service', async () => {
  const created = await addTodo(dataDir, cwd, { title: 'No code integration', status: 'ready' });
  const emptyPatch = path.join(cwd, 'empty-result.patch');
  fs.writeFileSync(emptyPatch, '');
  await updateTodo(dataDir, cwd, created.item.id, { status: 'done', integration: { state: 'ready', resultPath: emptyPatch } });
  const listed = await request('GET', '/api/decisions', humanHeaders);
  const card = listed.body.items.find((item) => item.subject.todoId === created.item.id && item.kind === 'integration');
  assert.ok(card);
  const result = await request('POST', `/api/decisions/${card.id}`, humanHeaders, payload(card, 'no_code'));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const todo = await getTodo(dataDir, cwd, created.item.id);
  assert.equal(todo.integration.changeScope, 'none');
  assert.equal(todo.integration.noCodeReason, 'No code changes required.');
});

test('rejecting a plan records the reason and waits for a new plan revision', async () => {
  const created = await addTodo(dataDir, cwd, { title: 'Revise plan' });
  await updateTodo(dataDir, cwd, created.item.id, { plan: { markdown: 'First draft', updatedAt: new Date().toISOString() } });
  const before = await request('GET', '/api/decisions', humanHeaders);
  const card = before.body.items.find((item) => item.subject.todoId === created.item.id);
  const rejected = await request('POST', `/api/decisions/${card.id}`, humanHeaders,
    { ...payload(card, 'reject'), reason: 'Please clarify rollback.' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const todo = await getTodo(dataDir, cwd, created.item.id);
  assert.equal(todo.plan.approvedAt, undefined);
  assert.ok(todo.changelog.some((event) => String(event.text).includes('Please clarify rollback.')));
  const unchanged = await request('GET', '/api/decisions', humanHeaders);
  assert.ok(!unchanged.body.items.some((item) => item.subject.todoId === created.item.id));
  await updateTodo(dataDir, cwd, created.item.id, { plan: { markdown: 'Second draft', updatedAt: new Date().toISOString() } });
  const revised = await request('GET', '/api/decisions', humanHeaders);
  assert.ok(revised.body.items.some((item) => item.subject.todoId === created.item.id));
});

test('todo change hook publishes a card without a decisions GET', async () => {
  const created = await addTodo(dataDir, cwd, { title: 'Hooked plan' });
  await updateTodo(dataDir, cwd, created.item.id, { plan: { markdown: 'Hook plan', updatedAt: new Date().toISOString() } });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await listPendingDecisions(dataDir, cwd)).items.some((item) => item.subject.todoId === created.item.id)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('todo change did not publish a decision card');
});

test('a chat-subject card survives todo adapter synchronization', async () => {
  const card = await createDecision(dataDir, { kind: 'question', subject: { chatId: 'chat-1', updatedAt: 'chat-rev-1' }, workspaceFolder: cwd,
    title: 'Choose', dedupeKey: 'chat-question', options: [{ id: 'a', label: 'A', effect: 'A' }, { id: 'b', label: 'B', effect: 'B' }] });
  const listed = await request('GET', '/api/decisions', humanHeaders);
  assert.ok(listed.body.items.some((item) => item.id === card.id));
});

test('cards live in the storage worker database and survive a worker restart', async () => {
  const card = await createDecision(dataDir, { kind: 'question', subject: { chatId: 'chat-persist', updatedAt: 'rev-1' }, workspaceFolder: cwd,
    title: 'Persist', dedupeKey: 'persist-question', options: [{ id: 'a', label: 'A', effect: 'A' }, { id: 'b', label: 'B', effect: 'B' }] });
  assert.ok(fs.existsSync(path.join(dataDir, 'decisions', 'decisions.sqlite')));
  assert.equal(fs.existsSync(path.join(dataDir, 'decisions', 'decisions.json')), false);
  await closeDecisionStores();
  const reopened = await listPendingDecisions(dataDir, cwd);
  assert.ok(reopened.items.some((item) => item.id === card.id));
  assert.ok(Number.isSafeInteger(reopened.revision) && reopened.revision > 0);
});

test('parallel POSTs on one card run the effect once and the losers get 409', async () => {
  const created = await addTodo(dataDir, cwd, { title: 'Race plan' });
  await updateTodo(dataDir, cwd, created.item.id, { plan: { markdown: 'Race', updatedAt: new Date().toISOString() } });
  const listed = await request('GET', '/api/decisions', humanHeaders);
  const card = listed.body.items.find((item) => item.subject.todoId === created.item.id);
  assert.ok(card);
  const results = await Promise.all(Array.from({ length: 5 }, () => request('POST', `/api/decisions/${card.id}`, humanHeaders, payload(card, 'reject', { reason: 'race-marker' }))));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
  const todo = await getTodo(dataDir, cwd, created.item.id);
  assert.equal(todo.changelog.filter((event) => String(event.text).includes('race-marker')).length, 1);
});

test('a stale effect leaves the claim as stale', async () => {
  const { changeDecision, listDecisions } = await import('../lib/decisions/decision-store.js');
  const orphan = await createDecision(dataDir, { kind: 'question', subject: { chatId: 'chat-claim', updatedAt: 'c1' }, workspaceFolder: cwd,
    title: 'Claim', dedupeKey: 'claim-question', options: [{ id: 'a', label: 'A', effect: 'A' }, { id: 'b', label: 'B', effect: 'B' }] });
  // No adapter resolves a chat subject, so the effect reports stale and the claim must not stay in `deciding`.
  const refused = await request('POST', `/api/decisions/${orphan.id}`, humanHeaders, payload(orphan, 'a'));
  assert.equal(refused.status, 409);
  assert.equal((await listDecisions(dataDir, cwd)).find((item) => item.id === orphan.id).status, 'stale');

});

test('an active claim survives GET sync and a worker restart; only an explicit human reopen after the lease releases it', async () => {
  const { changeDecision, listDecisions } = await import('../lib/decisions/decision-store.js');
  const created = await addTodo(dataDir, cwd, { title: 'Stranded claim plan' });
  await updateTodo(dataDir, cwd, created.item.id, { plan: { markdown: 'Strand', updatedAt: new Date().toISOString() } });
  const card = (await request('GET', '/api/decisions', humanHeaders)).body.items.find((item) => item.subject.todoId === created.item.id);
  const claimed = await changeDecision(dataDir, card.id, card.revision, 'deciding', { claimedAt: new Date().toISOString() });
  assert.equal(claimed.status, 'deciding');
  const status = async () => (await listDecisions(dataDir, cwd)).find((item) => item.id === card.id).status;
  // Concurrent GETs while the effect would be running must not touch the claim.
  await Promise.all([1, 2, 3].map(() => request('GET', '/api/decisions', humanHeaders)));
  assert.equal(await status(), 'deciding');
  // The claim is persistent: a different server process (modelled by a fresh worker) sees it and does not reset it.
  await closeDecisionStores();
  await request('GET', '/api/decisions', humanHeaders);
  assert.equal(await status(), 'deciding');
  const reopen = (headers = humanHeaders) => request('POST', `/api/decisions/${card.id}/reopen`, headers, { expectedRevision: claimed.revision });
  assert.equal((await reopen({})).status, 401);
  assert.equal((await reopen({ cookie: cookie(agentSession), [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(agentSession) })).status, 403);
  assert.equal((await reopen()).status, 409, 'still inside the lease');
  lease.ms = 0;
  try {
    const reopened = await reopen();
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  } finally { lease.ms = 60_000; }
  assert.equal(await status(), 'pending');
});
