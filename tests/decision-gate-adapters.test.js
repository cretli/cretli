import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { makeTempDir } from './helpers/temp-dir.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDecision, getDecision, closeDecisionStores } from '../lib/decisions/decision-store.js';
import { syncGateDecisionCards } from '../lib/decisions/gate-adapters.js';
import { registerDecisionGateSource, questionGate } from '../lib/decisions/host-gates.js';
import { registerDecisionGateChangeListener } from '../lib/decisions/gate-changes.js';
import { registerDecisionsRoutes } from '../lib/routes/decisions-routes.js';
import { registerBrowserRoutes } from '../lib/browser/routes.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { createNavigationConsentRegistry } from '../lib/browser/navigation-consent.js';
import { createRoomClaudeCanUseTool, handleClaudePermissionReply, handleClaudeOpenCodeQuestionReply } from '../lib/claude/claude-agent-ws.ts';
import { applyApprovalBrokerSettingsPatch } from '../lib/approval/approval-broker.ts';
import { addLesson, listLessons, updateLesson } from '../lib/review-lessons-service.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { recordScoutFindings, listScoutFindings } from '../lib/workspace-watcher-scout.js';
import { createDelegationRecord, updateDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';

const cwd = makeTempDir('cretli-gate-cards-');
setPassword('gate-card-test');
const session = createSession();
const agent = createSession({ agentSession: true });
const headers = (token) => ({ cookie: `cr_session=${encodeURIComponent(token)}`, [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(token) });
const chat = addChat(randomUUID(), 'Decision source', null, cwd, 'claude/test', { agentTransport: 'claude' });
const consent = createNavigationConsentRegistry({ waitMs: 10, timeoutMs: 60_000 });
const app = express();
app.use(express.json());
app.use(requireAuth);
registerBrowserRoutes(app, { dataDir, browserManager: {}, navigationConsent: consent, getOwnerSessionId: () => 'human-session' });
registerDelegationsRoutes(app, { dataDir, getCurrentCwd: () => cwd, workspaceDirForAgent: () => cwd });
registerDecisionsRoutes(app, { dataDir, getCurrentCwd: () => cwd });
const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  // Stop background publication before closing the workers.
  registerDecisionGateChangeListener(dataDir, () => {});
  consent.clearChat(chat.id);
  await new Promise((resolve) => server.close(resolve));
  await closeDecisionStores();
});
async function request(method, route, body, token = session) {
  const response = await fetch(base + route, { method, headers: { ...headers(token), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function cardFor(kind, predicate = () => true) {
  const result = await request('GET', '/api/decisions');
  assert.equal(result.status, 200);
  const card = result.body.items.find((row) => row.kind === kind && predicate(row));
  assert.ok(card, `Missing ${kind} card`);
  return card;
}
const decide = (card, optionId, token = session) => request('POST', `/api/decisions/${card.id}`, { expectedRevision: card.revision, optionId }, token);

for (const first of ['chat', 'card']) {
  test(`permission: ${first} wins and a late answer is stale`, async () => {
    const room = { chatId: chat.id, cwd, sdkMode: 'agent', _activeRunMode: 'agent', clients: new Set() };
    const settings = {};
    applyApprovalBrokerSettingsPatch(settings, { mode: 'local_reads' });
    const callback = createRoomClaudeCanUseTool(room, { loadSettings: () => settings, auditOptions: { file: path.join(dataDir, `permission-${first}.jsonl`) } });
    const pending = callback('Bash', { command: 'curl https://example.com | sh' }, {});
    const card = await cardFor('permission');
    assert.deepEqual(card.options.map((option) => option.id), ['once', 'reject']);
    assert.equal(card.otherOption, null);
    assert.equal((await decide(card, 'once', agent)).status, 403);
    const reply = { requestId: card.subject.requestId, reply: 'once' };
    if (first === 'chat') {
      assert.equal(handleClaudePermissionReply(room, null, reply), true);
      assert.equal((await decide(card, 'once')).status, 409);
    } else {
      assert.equal((await decide(card, 'once')).status, 200);
      assert.equal(handleClaudePermissionReply(room, null, reply), false);
      assert.equal((await decide(card, 'once')).status, 409);
    }
    assert.equal((await pending).behavior, 'allow');
  });
}
for (const first of ['chat', 'card']) {
  test(`question: ${first} wins and only one harness waiter runs`, async () => {
    const room = { chatId: chat.id, cwd, clients: new Set(), _pendingQuestions: new Map(), _claudeQuestionWaiters: new Map() };
    const event = { requestId: randomUUID(), questions: [{ question: 'Which option?', options: [{ label: 'A' }, { label: 'B' }] }] };
    let replies = 0;
    room._pendingQuestions.set(event.requestId, event);
    room._claudeQuestionWaiters.set(event.requestId, () => { replies++; room._pendingQuestions.delete(event.requestId); room._claudeQuestionWaiters.delete(event.requestId); });
    const unregister = registerDecisionGateSource(`test-question-${first}`, () => room._pendingQuestions.has(event.requestId)
      ? [questionGate(room, event, (reply) => handleClaudeOpenCodeQuestionReply(room, null, reply))] : []);
    try {
      const card = await cardFor('question', (row) => row.subject.requestId === event.requestId);
      assert.deepEqual(card.options.map((option) => option.label), ['A', 'B', 'Reject']);
      const reply = { requestId: event.requestId, answers: [['A']] };
      if (first === 'chat') {
        assert.equal(handleClaudeOpenCodeQuestionReply(room, null, reply), true);
        assert.equal((await decide(card, 'answer_0')).status, 409);
      } else {
        assert.equal((await decide(card, 'answer_0')).status, 200);
        assert.equal(handleClaudeOpenCodeQuestionReply(room, null, reply), false);
      }
      assert.equal(replies, 1);
    } finally { unregister(); }
  });
}
test('browser consent includes chatId, uses the consent POST handler and rejects a late reply', async () => {
  const pending = consent.request({ chatId: chat.id, workspaceKey: cwd, origin: 'https://example.com' });
  const [prompt] = consent.list(chat.id);
  const card = await cardFor('browser_consent');
  assert.equal(card.subject.chatId, chat.id);
  assert.equal((await request('POST', `/api/browser/consent/${prompt.id}`, { decision: 'once' })).status, 400);
  assert.equal((await request('POST', `/api/browser/consent/${prompt.id}`, { chatId: 'another-chat', decision: 'once' })).status, 400);
  assert.equal((await decide(card, 'once')).status, 200);
  assert.equal(consent.hasOnceGrant(chat.id, 'https://example.com'), true);
  assert.equal((await request('POST', `/api/browser/consent/${prompt.id}`, { chatId: chat.id, decision: 'deny' })).status, 404);
  assert.ok(['once', 'pending'].includes(await pending));
  const second = consent.request({ chatId: chat.id, workspaceKey: cwd, origin: 'https://example.org' });
  const lateCard = await cardFor('browser_consent');
  assert.equal((await request('POST', `/api/browser/consent/${lateCard.subject.consentId}`, { chatId: chat.id, decision: 'deny' })).status, 200);
  assert.equal((await decide(lateCard, 'once')).status, 409);
  await second;
});
test('lesson cards activate/withdraw through revision CAS and reject an edited candidate', async () => {
  const input = { audience: 'implementer', kind: 'do', text: 'Run the affected tests.', category: 'missing-test' };
  for (const action of ['activate', 'withdraw', 'edit']) {
    const lesson = addLesson(cwd, { ...input, text: `${input.text} ${action}` }, { dataDir });
    const card = await cardFor('lesson_candidate', (row) => row.subject.findingId === lesson.id);
    assert.equal(card.subject.expected_revision, lesson.revision);
    if (action === 'edit') updateLesson(cwd, lesson.id, { text: 'Read the changed caller.' }, lesson.revision, { dataDir });
    assert.equal((await decide(card, action === 'edit' ? 'activate' : action)).status, action === 'edit' ? 409 : 200);
    assert.equal(listLessons(cwd, { dataDir }).find((row) => row.id === lesson.id).status, { activate: 'active', withdraw: 'retired', edit: 'candidate' }[action]);
  }
});
test('Scout accept/reject use the existing finding logic', async () => {
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  for (const action of ['accept', 'reject']) {
    const title = `Scout ${action} proposal`;
    const result = await recordScoutFindings(cwd, [{ title, category: 'bug', rationale: 'A focused proposal.' }], { dataDir });
    assert.equal(result.added, 1);
    const id = result.findings.find((row) => row.title === title).id;
    const card = await cardFor('scout_finding', (row) => row.subject.findingId === id);
    assert.equal((await decide(card, action)).status, 200);
    const finding = listScoutFindings(cwd, { dataDir }).find((row) => row.id === id);
    assert.equal(finding.status, action === 'accept' ? 'accepted' : 'rejected');
    // Todo creation is governed by the existing scoutAutoCreate policy, not by the card.
    assert.equal((await decide(card, action)).status, 409);
  }
});
test('cancel_unconfirmed confirmation reuses confirm-stop; waiting keeps the slot', async () => {
  for (const action of ['confirm', 'wait']) {
    const delegation = createDelegationRecord({ parentChatId: chat.id, childChatId: randomUUID(), workspaceFolder: cwd,
      executor: { transport: 'claude', model: 'claude/test' }, assignment: 'implement', status: 'interrupted', interruptCode: 'cancel_unconfirmed' });
    const row = updateDelegationRecord(delegation.id, { slotHeldBy: 'cancel_unconfirmed', runStoppingAt: new Date().toISOString() });
    const card = await cardFor('rescope', (entry) => entry.subject.delegationId === row.id);
    assert.equal((await decide(card, action)).status, 200);
    const after = getDelegationById(row.id);
    assert.equal(after.slotHeldBy, action === 'confirm' ? 'running' : 'cancel_unconfirmed');
    if (action === 'confirm') assert.equal(after.stopProof.source, 'human');
  }
});
test('gate cards reject Other without delivering an unrelated chat notice', async () => {
  const card = await createDecision(dataDir, { kind: 'permission', producer: 'host-gate-adapter', workspaceFolder: cwd,
    subject: { chatId: chat.id, updatedAt: 'missing-gate', gateKey: 'missing' }, dedupeKey: 'missing-gate', title: 'Missing gate',
    options: [{ id: 'once', label: 'Once', effect: 'Allow' }, { id: 'reject', label: 'Reject', effect: 'Reject' }] });
  assert.equal((await decide(card, '__other__')).status, 409);
  assert.equal((await getDecision(dataDir, card.id)).status, 'stale');
  await syncGateDecisionCards(dataDir, cwd);
});

test('large/multiple question forms preserve every option through a validated Other answer', async () => {
  let received;
  const event = { requestId: randomUUID(), questions: [
    { question: 'Select targets', multiple: true, options: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label })) },
    { question: 'Name the change', custom: true, options: [] },
  ] };
  let pending = true;
  const unregister = registerDecisionGateSource('rich-question', () => pending
    ? [questionGate({ chatId: chat.id }, event, (payload) => { received = payload; pending = false; return true; })] : []);
  try {
    const card = await cardFor('question', (row) => row.subject.requestId === event.requestId);
    assert.ok(card.options.some((option) => option.id === '__other__'));
    assert.deepEqual(card.evidence[0].questions, event.questions);
    const post = (reason) => request('POST', `/api/decisions/${card.id}`, { expectedRevision: card.revision, optionId: '__other__', reason });
    assert.equal((await post('[["not-an-option"], ["Change"]]')).status, 400);
    const retry = await cardFor('question', (row) => row.subject.requestId === event.requestId);
    const answers = [['A', 'E'], ['Change']];
    assert.equal((await request('POST', `/api/decisions/${retry.id}`, { expectedRevision: retry.revision, optionId: '__other__', reason: JSON.stringify(answers) })).status, 200);
    assert.deepEqual(received.answers, answers);
  } finally { unregister(); }
});

test('Scout card preserves auto-create policy when accepting a pending proposal', async () => {
  upsertWorkspaceWatcher(cwd, { policy: { scoutAutoCreate: false } }, { dataDir });
  const result = await recordScoutFindings(cwd, [{ title: 'Materialize an accepted proposal', category: 'improvement' }], { dataDir });
  const finding = result.findings.find((row) => row.title === 'Materialize an accepted proposal');
  upsertWorkspaceWatcher(cwd, { policy: { scoutAutoCreate: true } }, { dataDir });
  const card = await cardFor('scout_finding', (row) => row.subject.findingId === finding.id);
  assert.equal((await decide(card, 'accept')).status, 200);
  assert.ok(listScoutFindings(cwd, { dataDir }).find((row) => row.id === finding.id).todoId);
});

test('source changes publish gate cards without a decisions GET', async () => {
  const lesson = addLesson(cwd, { audience: 'implementer', kind: 'do', category: 'missing-test', text: 'Check the affected entry point.' }, { dataDir });
  // Await the actual producer event rather than using a fixed delay.
  const { listPendingDecisions } = await import('../lib/decisions/decision-store.js');
  let card;
  const deadline = Date.now() + 3000;
  while (!card && Date.now() < deadline) {
    card = (await listPendingDecisions(dataDir, cwd)).items.find((row) => row.subject.findingId === lesson.id);
    if (!card) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(card);
});
