import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { makeTempDir } from './helpers/temp-dir.js';
import { setPassword, createSession, getCsrfTokenForSessionToken, AUTH_CSRF_HEADER, requireAuth } from '../lib/auth.js';
import { closeDecisionStores, getDecision } from '../lib/decisions/decision-store.js';
import { createOperatorProposalCard } from '../lib/decisions/operator-proposal.js';
import { registerDecisionsRoutes } from '../lib/routes/decisions-routes.js';
import { addTodo, getTodo, updateTodo } from '../lib/persist/todos-store.js';
import { listOperatorNotes } from '../lib/persist/operator-journal-persist.js';

const cwd = makeTempDir('cretli-operator-proposal-');
setPassword('op-proposal-test');
const session = createSession();
const agent = createSession({ agentSession: true });
const headers = (token) => ({ cookie: `cr_session=${encodeURIComponent(token)}`, [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(token) });
const app = express();
app.use(express.json());
app.use(requireAuth);
registerDecisionsRoutes(app, { dataDir, getCurrentCwd: () => cwd });
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await new Promise((resolve) => server.close(resolve)); await closeDecisionStores(); });
const decide = async (card, optionId, token = session) => {
  const response = await fetch(`${base}/api/decisions/${card.id}`, {
    method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({ optionId, expectedRevision: card.revision }),
  });
  return { status: response.status, body: await response.json() };
};
const todo = async (extra = {}) => (await addTodo(dataDir, cwd, { title: 'Leaf', status: 'ready', body: 'Leaf.\n', ...extra })).item;
const defer = (item) => createOperatorProposalCard(dataDir, { workspaceFolder: cwd, todoId: item.id, action: 'defer_todo', params: { reason: 'later' } });

test('an agent session cannot resolve an operator_proposal card (403)', async () => {
  const card = await defer(await todo());
  assert.equal(card.kind, 'operator_proposal');
  assert.equal(card.humanOnly, false);
  const result = await decide(card, 'approve', agent);
  assert.equal(result.status, 403);
  assert.equal((await getDecision(dataDir, card.id)).status, 'pending');
});

test('human approval applies the action with audit and journal, no duplicates for one matter', async () => {
  const item = await todo();
  const card = await defer(item);
  assert.equal((await defer(item)).id, card.id);
  const result = await decide(card, 'approve');
  assert.equal(result.status, 200);
  assert.equal(result.body.decision.status, 'decided');
  const saved = await getTodo(dataDir, cwd, item.id);
  assert.equal(saved.status, 'deferred');
  assert.ok(listOperatorNotes(cwd).some((n) => n.todoId === item.id && /applied: defer_todo/.test(n.text)));
});

test('rejection changes nothing and is recorded in the journal', async () => {
  const item = await todo();
  const card = await defer(item);
  const result = await decide(card, 'reject');
  assert.equal(result.status, 200);
  assert.equal((await getTodo(dataDir, cwd, item.id)).status, 'ready');
  assert.ok(listOperatorNotes(cwd).some((n) => n.todoId === item.id && /rejected: defer_todo/.test(n.text)));
});

test('a changed todo revision makes the card stale with no effect', async () => {
  const item = await todo();
  const card = await defer(item);
  await updateTodo(dataDir, cwd, item.id, { title: 'Changed', expectedUpdatedAt: item.updatedAt });
  const result = await decide(card, 'approve');
  assert.ok([409].includes(result.status));
  assert.equal((await getDecision(dataDir, card.id)).status, 'stale');
  assert.equal((await getTodo(dataDir, cwd, item.id)).status, 'ready');
});

test('unsupported and human-only actions are rejected', async () => {
  const item = await todo();
  for (const action of ['delete_todo', 'approve_plan', 'confirm_integration', 'policy_upgrade']) {
    await assert.rejects(createOperatorProposalCard(dataDir, { workspaceFolder: cwd, todoId: item.id, action, params: {} }), { code: 'VALIDATION' });
  }
});

// --- Round 2 regressions -------------------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { storeWorkspaceWatcherScopeRequest } from '../lib/workspace-watcher-cycle-close.js';
import { requestDecision } from '../lib/decisions/decision-request.js';
import { canAutoDecide, AUTONOMY_EXCLUDED_KINDS, readAutonomyState } from '../lib/decisions/decision-autonomy.js';
import { issueDecisionToken } from '../lib/decisions/decision-push.js';
import { createDecision } from '../lib/decisions/decision-store.js';

const propose = (item, action, params) => createOperatorProposalCard(dataDir, { workspaceFolder: cwd, todoId: item.id, action, params });
const scopeLeaf = async () => {
  const item = await todo({ body: 'Leaf.\n\n## Leaf scope\n- `lib/a.js`\n' });
  await storeWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: cwd, todoId: item.id, files: ['lib/b.js', 'lib/c.js'], reason: 'r' });
  return getTodo(dataDir, cwd, item.id);
};

test('extend_scope executes for a requested subset and is audited in decisions-audit.jsonl', async () => {
  const item = await scopeLeaf();
  const card = await propose(item, 'extend_scope', { files: ['lib/b.js'] });
  const result = await decide(card, 'approve');
  assert.equal(result.status, 200);
  const saved = await getTodo(dataDir, cwd, item.id);
  assert.match(saved.body, /lib\/b\.js/);
  assert.match(saved.body, /Scope request/);
  const audit = fs.readFileSync(path.join(dataDir, 'approvals', 'decisions-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(audit.some((row) => row.id === card.id && row.kind === 'operator_proposal' && row.optionId === 'approve'));
});

test('malformed or empty files are refused at creation and never widen scope', async () => {
  const item = await scopeLeaf();
  for (const files of ['lib/b.js', [], [1], ['  ']]) {
    await assert.rejects(propose(item, 'extend_scope', { files }), { code: 'VALIDATION' });
  }
  // A forged stored subject is refused at execution as well: stale, no effect.
  const forged = await createDecision(dataDir, {
    kind: 'operator_proposal', workspaceFolder: cwd, producer: 'test', recommended: 'approve', why: 'x', allowOther: false,
    options: [{ id: 'approve', label: 'a', effect: 'a' }, { id: 'reject', label: 'r', effect: 'r' }],
    subject: { todoId: item.id, updatedAt: item.updatedAt, action: 'extend_scope', params: { files: [] } },
    title: 'forged', dedupeKey: `forged:${item.id}`,
  });
  const result = await decide(forged, 'approve');
  assert.equal(result.status, 409);
  assert.equal((await getDecision(dataDir, forged.id)).status, 'stale');
  assert.doesNotMatch((await getTodo(dataDir, cwd, item.id)).body, /## Leaf scope[\s\S]*lib\/b\.js[\s\S]*## Scope request/);
});

test('extend_scope without an open scope request ends stale, not pending', async () => {
  const item = await todo();
  const card = await propose(item, 'extend_scope', {});
  assert.equal((await decide(card, 'approve')).status, 409);
  assert.equal((await getDecision(dataDir, card.id)).status, 'stale');
});

test('mark_ready_for_integration appends a changelog mark only', async () => {
  const item = await todo();
  const card = await propose(item, 'mark_ready_for_integration', { reason: 'looks done' });
  assert.equal((await decide(card, 'approve')).status, 200);
  const saved = await getTodo(dataDir, cwd, item.id);
  assert.equal(saved.status, 'ready');
  assert.ok(saved.changelog.some((e) => /Marked ready for integration/.test(e.text)));
});

test('reject of an out-of-date card is stale and is not journaled', async () => {
  const item = await todo();
  const card = await defer(item);
  await updateTodo(dataDir, cwd, item.id, { title: 'Changed', expectedUpdatedAt: item.updatedAt });
  assert.equal((await decide(card, 'reject')).status, 409);
  assert.equal((await getDecision(dataDir, card.id)).status, 'stale');
  assert.ok(!listOperatorNotes(cwd, { dataDir }).some((n) => n.todoId === item.id && /rejected/.test(n.text)));
});

test('journal notes go to the adapter dataDir', async () => {
  const item = await todo();
  await decide(await defer(item), 'reject');
  assert.ok(listOperatorNotes(cwd, { dataDir }).some((n) => n.todoId === item.id && /rejected: defer_todo/.test(n.text)));
});

test('defer_todo params are validated', async () => {
  const item = await todo();
  await assert.rejects(propose(item, 'defer_todo', {}), { code: 'VALIDATION' });
  await assert.rejects(propose(item, 'defer_todo', { reason: 'x', until: 'not a date' }), { code: 'VALIDATION' });
});

test('generic decision_request cannot create an operator_proposal card', async () => {
  await assert.rejects(requestDecision(dataDir, {
    kind: 'operator_proposal', workspaceFolder: cwd, chatId: 'c1', idempotencyKey: 'k', title: 't', recommended: 'a', why: 'w',
    options: [{ id: 'a', label: 'a', effect: 'a' }, { id: 'b', label: 'b', effect: 'b' }],
  }), { code: 'OUT_OF_SCOPE' });
});

test('autonomy and push exclusions', async () => {
  const card = await defer(await todo());
  assert.ok(AUTONOMY_EXCLUDED_KINDS.includes('operator_proposal'));
  assert.equal(canAutoDecide(card, { autoDecideKinds: ['operator_proposal'] }), false);
  assert.equal(issueDecisionToken(card, 'https://push.example/endpoint'), null);
  assert.ok(!readAutonomyState(dataDir).policy.autoDecideKinds.includes('operator_proposal'));
});
