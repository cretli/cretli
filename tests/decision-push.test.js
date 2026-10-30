import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import {
  buildDecisionPushPayload, consumeDecisionToken, deviceAllowsDecisionPush, issueDecisionToken,
  notifyDecisionCard, resetDecisionTokens, resolveYesNoOptions, NEVER_TOKEN_KINDS,
} from '../lib/decisions/decision-push.js';
import { createDecision, getDecision, closeDecisionStores } from '../lib/decisions/decision-store.js';
import { registerDecisionsRoutes } from '../lib/routes/decisions-routes.js';

after(() => closeDecisionStores());
const opts = [{ id: 'a', label: 'A', effect: 'a' }, { id: 'b', label: 'B', effect: 'b' }];
const lowCard = (over = {}) => ({
  id: 'c1', kind: 'question', status: 'pending', revision: 1, risk: 'low', reversible: true,
  humanOnly: false, options: opts, recommended: 'a', title: 'T', ...over,
});

test('actions and token only for low/reversible/non-humanOnly; never for gate kinds', () => {
  assert.deepEqual(resolveYesNoOptions(lowCard()), { yes: 'a', no: 'b' });
  for (const kind of NEVER_TOKEN_KINDS) {
    assert.equal(resolveYesNoOptions(lowCard({ kind })), null, kind);
    assert.equal(issueDecisionToken(lowCard({ kind }), 'ep'), null, kind);
    const payload = buildDecisionPushPayload(lowCard({ kind }), null);
    assert.equal(payload.actions, undefined);
    assert.match(payload.data.url, /decision=c1/);
  }
  assert.equal(resolveYesNoOptions(lowCard({ risk: 'medium' })), null);
  assert.equal(resolveYesNoOptions(lowCard({ reversible: false })), null);
  assert.equal(resolveYesNoOptions(lowCard({ humanOnly: true })), null);
  const withToken = buildDecisionPushPayload(lowCard(), issueDecisionToken(lowCard(), 'ep'));
  assert.deepEqual(withToken.actions.map((a) => a.action), ['yes', 'no']);
});

test('token is single use, TTL-bound, subscription-bound', () => {
  resetDecisionTokens();
  const t = issueDecisionToken(lowCard(), 'ep1', 1000);
  assert.equal(consumeDecisionToken(t, { choice: 'yes', endpoint: 'ep2', now: 1001 }).reason, 'wrong_subscription');
  assert.equal(consumeDecisionToken(`${t}x`, { choice: 'yes', endpoint: 'ep1' }).reason, 'invalid_token');
  const ok = consumeDecisionToken(t, { choice: 'no', endpoint: 'ep1', now: 1002 });
  assert.equal(ok.optionId, 'b');
  assert.equal(consumeDecisionToken(t, { choice: 'no', endpoint: 'ep1', now: 1003 }).reason, 'used_or_unknown');
  const old = issueDecisionToken(lowCard(), 'ep1', 0);
  assert.equal(consumeDecisionToken(old, { choice: 'yes', endpoint: 'ep1', now: 11 * 60 * 1000 }).reason, 'expired');
});

test('quiet hours and per-device preferences are respected', async () => {
  const quiet = { preferences: { quietHours: { enabled: true, start: '22:00', end: '07:00' } } };
  assert.equal(deviceAllowsDecisionPush(quiet, lowCard(), new Date(2026, 0, 1, 23, 0)), false);
  assert.equal(deviceAllowsDecisionPush(quiet, lowCard(), new Date(2026, 0, 1, 12, 0)), true);
  assert.equal(deviceAllowsDecisionPush({ preferences: { enabled: false } }, lowCard()), false);
  assert.equal(deviceAllowsDecisionPush({ preferences: { events: { question: false } } }, lowCard()), false);
  resetDecisionTokens();
  const sent = [];
  const res = await notifyDecisionCard(lowCard(), {
    now: new Date(2026, 0, 1, 12, 0),
    listSubscriptions: () => [{ endpoint: 'e1' }, { endpoint: 'e2', preferences: { enabled: false } }],
    send: async (ep, p) => { sent.push([ep, p]); return { ok: true }; },
  });
  assert.deepEqual(res, { sent: 1, skipped: 1 });
  assert.equal(sent[0][0], 'e1');
  assert.ok(sent[0][1].data.decisionToken);
});

async function boot() {
  const app = express();
  app.use(express.json());
  registerDecisionsRoutes(app, { dataDir, getCurrentCwd: () => '/ws' });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, post: (u, b) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }), get: (u) => fetch(base + u) };
}
async function lowRisk(key, kind = 'question') {
  // Classification can't be lowered by producers, so create then force-low via a stored card shape.
  const card = await createDecision(dataDir, {
    kind, workspaceFolder: '/ws', subject: { chatId: 'chat-x', updatedAt: key }, title: 'T', options: opts,
    recommended: 'a', why: 'w', dedupeKey: key,
  });
  return card;
}

test('endpoint: stale revision rejected, no token in API, audit records push channel', async () => {
  resetDecisionTokens();
  const { server, post, get } = await boot();
  try {
    const card = await lowRisk('k1');
    const forced = { ...card, risk: 'low', reversible: true, humanOnly: false };
    const token = issueDecisionToken(forced, 'ep');
    // GET /api/decisions never exposes a token field.
    const list = JSON.stringify(await (await get('/api/decisions')).json());
    assert.ok(!/token/i.test(list));
    assert.ok(!list.includes(token));
    // Wrong subscription is rejected.
    assert.equal((await post('/api/decisions/resolve-by-token', { token, choice: 'yes', endpoint: 'other' })).status, 403);
    // Token for a revision that no longer matches the card is rejected as stale.
    const stale = issueDecisionToken({ ...forced, revision: card.revision + 5 }, 'ep');
    assert.equal((await post('/api/decisions/resolve-by-token', { token: stale, choice: 'yes', endpoint: 'ep' })).status, 409);
    // Choice outside yes/no is rejected.
    const t3 = issueDecisionToken(forced, 'ep');
    assert.equal((await post('/api/decisions/resolve-by-token', { token: t3, choice: 'a', endpoint: 'ep' })).status, 400);
    const res = await post('/api/decisions/resolve-by-token', { token: t3, choice: 'yes', endpoint: 'ep' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await getDecision(dataDir, card.id)).decidedBy.kind, 'push');
    const audit = fs.readFileSync(path.join(dataDir, 'approvals', 'decisions-audit.jsonl'), 'utf8');
    assert.match(audit, /"kind":"push"/);
    // Reuse is rejected.
    assert.equal((await post('/api/decisions/resolve-by-token', { token: t3, choice: 'yes', endpoint: 'ep' })).status, 403);
  } finally { server.close(); }
});

test('agent-facing request response carries no token field', async () => {
  const { requestDecision } = await import('../lib/decisions/decision-request.js');
  const out = await requestDecision(dataDir, {
    chatId: 'chat-m', workspaceFolder: '/ws', idempotencyKey: 'm1', title: 'T', options: opts, recommended: 'a', why: 'w',
  });
  assert.ok(!/token/i.test(JSON.stringify(out)));
});
