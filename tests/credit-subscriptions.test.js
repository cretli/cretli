import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { registerCreditLedgerRoutes } from '../lib/routes/credit-ledger-routes.js';
import { appendHarnessPlanLimitHistory } from '../lib/usage/plan-limit-history.ts';
import { priceUsage } from '../lib/usage/usage-rates.js';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import { loadLedger } from '../lib/credit-ledger/credit-ledger-store.ts';
import {
  buildCostSeparation,
  buildPaymentSchedule,
  confirmSubscriptionPayment,
  createSubscription,
  cycleOccurrence,
  isCycleDate,
  loadSubscriptions,
  parseDay,
  readSubscriptionsView,
  suggestAccounts,
  todayInZone,
  transitionSubscription,
  updateSubscription,
} from '../lib/credit-ledger/subscriptions.ts';

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-subs-'));
  return { dir, ledgerPath: path.join(dir, 'credit-ledger.json') };
}
const base = (extra = {}) => ({
  label: 'Claude Max', provider: 'claude', plan: 'Max', price: { amount: '100.00', currency: 'USD' },
  cycle: { interval: 'month', anchorDate: '2026-01-31' }, harness: 'claude', source: 'manual', ...extra,
});
const err = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('calendar: only real days parse, no rollover', () => {
  assert.ok(parseDay('2024-02-29'));
  assert.equal(parseDay('2026-02-29'), null);
  assert.equal(parseDay('2026-04-31'), null);
  assert.equal(parseDay('2026-13-01'), null);
  assert.equal(parseDay('2026-1-01'), null);
});

test('monthly cycle: month-end anchor clamps and returns to the anchor day', () => {
  const got = [0, 1, 2, 3, 12].map((n) => cycleOccurrence('2026-01-31', 'month', n));
  assert.deepEqual(got, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2027-01-31']);
  // Leap year February.
  assert.equal(cycleOccurrence('2024-01-31', 'month', 1), '2024-02-29');
  assert.equal(cycleOccurrence('2026-01-15', 'month', 11), '2026-12-15');
  assert.equal(cycleOccurrence('2026-01-15', 'month', 12), '2027-01-15');
});

test('yearly cycle: Feb 29 anchor falls back to Feb 28 and returns in leap years', () => {
  const got = [0, 1, 2, 3, 4].map((n) => cycleOccurrence('2024-02-29', 'year', n));
  assert.deepEqual(got, ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  assert.equal(cycleOccurrence('2026-03-10', 'year', 1), '2027-03-10');
});

test('isCycleDate accepts only real occurrences', () => {
  assert.equal(isCycleDate('2026-01-31', 'month', '2026-02-28'), true);
  assert.equal(isCycleDate('2026-01-31', 'month', '2026-02-27'), false);
  assert.equal(isCycleDate('2026-01-31', 'month', '2025-12-31'), false);
  assert.equal(isCycleDate('2024-02-29', 'year', '2025-02-28'), true);
  assert.equal(isCycleDate('2024-02-29', 'year', '2025-03-01'), false);
});

test('schedule: next payment is planned, today counts, a past unconfirmed date awaits confirmation', () => {
  const sub = { state: 'active', endsAt: null, payments: [], cycle: { interval: 'month', anchorDate: '2026-01-31' } };
  assert.deepEqual(buildPaymentSchedule(sub, '2026-02-28').nextPayment, { dueDate: '2026-02-28', state: 'planned', confirmed: false });
  const mid = buildPaymentSchedule(sub, '2026-03-05');
  assert.equal(mid.nextPayment.dueDate, '2026-03-31');
  assert.equal(mid.awaitingConfirmation.dueDate, '2026-02-28');
  assert.equal(mid.awaitingConfirmation.confirmed, false);
  const before = buildPaymentSchedule(sub, '2025-12-01');
  assert.equal(before.nextPayment.dueDate, '2026-01-31');
  assert.equal(before.awaitingConfirmation, null);
  // Yearly leap anchor, queried after the leap day.
  const yearly = { ...sub, cycle: { interval: 'year', anchorDate: '2024-02-29' } };
  assert.equal(buildPaymentSchedule(yearly, '2026-03-01').nextPayment.dueDate, '2027-02-28');
});

test('payment: planned date never becomes paid without evidence, and is not a ledger transaction', () => {
  const c = ctx();
  const { subscription } = createSubscription({ ledgerPath: c.ledgerPath, input: base() });
  const confirm = (input) => confirmSubscriptionPayment({ ledgerPath: c.ledgerPath, id: subscription.id, input });
  const paid = { amount: '100.00', currency: 'USD' };
  assert.equal(err(() => confirm({ dueDate: '2026-02-28', paidAt: '2026-02-28', paid, source: 'manual' })), 'payment_evidence_required');
  assert.equal(err(() => confirm({ dueDate: '2026-02-27', paidAt: '2026-02-27', paid, source: 'manual', providerTransactionId: 'p1' })), 'due_date_not_in_cycle');
  assert.equal(err(() => confirm({ dueDate: '2026-02-28', paidAt: '2026-02-28', source: 'manual', providerTransactionId: 'p1' })), 'paid_amount_invalid');
  assert.equal(loadSubscriptions(c.ledgerPath).subscriptions[0].payments.length, 0);

  const ok = confirm({ dueDate: '2026-02-28', paidAt: '2026-03-01', paid, source: 'screenshot', providerTransactionId: 'p1' });
  assert.equal(ok.payment.dueDate, '2026-02-28');
  // Same due date again is a no-op; a reused provider id for another date is refused.
  assert.equal(confirm({ dueDate: '2026-02-28', paidAt: '2026-03-01', paid, source: 'manual', providerTransactionId: 'p1' }).deduplicated, 'due_date');
  assert.equal(err(() => confirm({ dueDate: '2026-03-31', paidAt: '2026-03-31', paid, source: 'manual', providerTransactionId: 'p1' })), 'provider_transaction_reused');
  // Cash never touches the prepaid ledger.
  assert.equal(loadLedger(c.ledgerPath).transactions.length, 0);
  // A confirmed date is skipped as "next".
  const view = readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf: '2026-02-28T08:00:00Z', timeZone: 'UTC', dataDir: c.dir });
  assert.equal(view.subscriptions[0].nextPayment.dueDate, '2026-03-31');
  assert.deepEqual(view.cash, { USD: '100.00' });
});

test('states: allowed transitions only, history kept, paused/cancelled stop the schedule', () => {
  const c = ctx();
  const { subscription: s } = createSubscription({ ledgerPath: c.ledgerPath, input: base() });
  const go = (state) => transitionSubscription({ ledgerPath: c.ledgerPath, id: s.id, state });
  assert.equal(go('paused').subscription.state, 'paused');
  assert.equal(err(() => go('paused')), 'state_transition_invalid');
  go('active'); go('past_due');
  assert.equal(readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf: '2026-02-01T00:00:00Z', timeZone: 'UTC', dataDir: c.dir }).subscriptions[0].nextPayment.dueDate, '2026-02-28');
  go('cancelled');
  assert.equal(readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf: '2026-02-01T00:00:00Z', timeZone: 'UTC', dataDir: c.dir }).subscriptions[0].nextPayment, null);
  go('ended');
  assert.equal(err(() => go('active')), 'state_transition_invalid');
  assert.equal(err(() => go('bogus')), 'state_invalid');
  assert.deepEqual(loadSubscriptions(c.ledgerPath).subscriptions[0].stateHistory.map((h) => h.state),
    ['active', 'paused', 'active', 'past_due', 'cancelled', 'ended']);
  assert.equal(err(() => updateSubscription({ ledgerPath: c.ledgerPath, id: s.id, patch: { state: 'active' } })), 'use_dedicated_operation');
});

test('endsAt stops the schedule; price change keeps history', () => {
  const c = ctx();
  const { subscription: s } = createSubscription({ ledgerPath: c.ledgerPath, input: base({ endsAt: '2026-03-15' }) });
  const v = (asOf) => readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf, timeZone: 'UTC', dataDir: c.dir }).subscriptions[0];
  assert.equal(v('2026-03-01T00:00:00Z').nextPayment, null);
  assert.equal(v('2026-02-01T00:00:00Z').nextPayment.dueDate, '2026-02-28');
  const up = updateSubscription({ ledgerPath: c.ledgerPath, id: s.id, patch: { price: { amount: '120.00', currency: 'USD' } } });
  assert.equal(up.subscription.price.value, '120.00');
  assert.equal(up.subscription.priceHistory[0].price.value, '100.00');
});

test('limit reset is independent of the billing cycle and reuses plan-limit history', () => {
  const c = ctx();
  createSubscription({ ledgerPath: c.ledgerPath, input: base() });
  appendHarnessPlanLimitHistory({ dataDir: c.dir, harness: 'claude', rateLimitType: 'five_hour', utilization: 40, resetsAt: '2026-02-10T12:00:00Z', observedAt: '2026-02-10T09:00:00Z' });
  appendHarnessPlanLimitHistory({ dataDir: c.dir, harness: 'claude', rateLimitType: 'five_hour', utilization: 70, resetsAt: '2026-02-10T12:00:00Z', observedAt: '2026-02-10T10:00:00Z' });
  appendHarnessPlanLimitHistory({ dataDir: c.dir, harness: 'codex', rateLimitType: 'five_hour', utilization: 5, observedAt: '2026-02-10T10:00:00Z' });
  const at = (asOf) => readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf, timeZone: 'UTC', dataDir: c.dir }).subscriptions[0];
  const before = at('2026-02-10T11:00:00Z');
  assert.equal(before.limits.length, 1);
  assert.equal(before.limits[0].utilization, 70);
  assert.equal(before.limits[0].resetElapsed, false);
  const after = at('2026-02-10T13:00:00Z');
  assert.equal(after.limits[0].resetElapsed, true);
  // The quota reset moved nothing in the cash schedule.
  assert.equal(before.nextPayment.dueDate, after.nextPayment.dueDate);
  assert.equal(after.payments.length, 0);
});

test('manual limit is used only when the history has no reading for the harness', () => {
  const c = ctx();
  createSubscription({ ledgerPath: c.ledgerPath, input: base({ harness: null, limit: { label: 'weekly', utilization: 12, resetsAt: '2026-02-20T00:00:00Z', observedAt: '2026-02-10T00:00:00Z' } }) });
  const v = readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf: '2026-02-11T00:00:00Z', timeZone: 'UTC', dataDir: c.dir }).subscriptions[0];
  assert.equal(v.limits[0].source, 'manual');
  assert.equal(v.limits[0].utilization, 12);
});

test('no double counting: subscription quota adds no money, API estimates are separate', () => {
  const quota = createUsageEvent({ billingMode: 'subscription', harness: 'claude', provider: 'other' });
  assert.equal(priceUsage(quota).usd, null);
  const c = ctx();
  const { subscription } = createSubscription({ ledgerPath: c.ledgerPath, input: base() });
  confirmSubscriptionPayment({ ledgerPath: c.ledgerPath, id: subscription.id, input: { dueDate: '2026-01-31', paidAt: '2026-01-31', paid: { amount: '100.00', currency: 'USD' }, source: 'manual', providerTransactionId: 'p9' } });
  const sep = buildCostSeparation({
    subscriptions: loadSubscriptions(c.ledgerPath).subscriptions,
    usageEvents: [{ billingClass: 'subscription_quota', usd: null }, { billingClass: 'subscription_quota', usd: 3 }, { billingClass: 'api_metered', usd: 1.5 }, { billingClass: 'unknown' }],
  });
  assert.deepEqual(sep.subscriptionCash, { USD: '100.00' });
  assert.equal(sep.api.estimatedUsd, 1.5);
  assert.equal(sep.subscriptionQuota.events, 2);
  assert.equal(sep.subscriptionQuota.money, null);
  assert.equal(sep.unclassifiedEvents, 1);
});

test('suggestions follow services in use and skip those already recorded', () => {
  const s1 = suggestAccounts({ harnesses: ['claude', 'openrouter', 'deepseek'] });
  assert.deepEqual(s1.map((x) => x.service).sort(), ['claude', 'openrouter']);
  assert.equal(s1.find((x) => x.service === 'claude').billingClass, 'subscription_quota');
  const s2 = suggestAccounts({ harnesses: ['claude', 'openrouter'], subscriptions: [{ provider: 'claude', state: 'active' }], billingAccounts: [{ provider: 'openrouter' }] });
  assert.deepEqual(s2, []);
});

test('validation and idempotency', () => {
  const c = ctx();
  assert.equal(err(() => createSubscription({ ledgerPath: c.ledgerPath, input: base({ cycle: { interval: 'week', anchorDate: '2026-01-01' } }) })), 'interval_invalid');
  assert.equal(err(() => createSubscription({ ledgerPath: c.ledgerPath, input: base({ cycle: { interval: 'month', anchorDate: '2026-02-30' } }) })), 'anchor_date_invalid');
  assert.equal(err(() => createSubscription({ ledgerPath: c.ledgerPath, input: base({ price: { amount: '-1', currency: 'USD' } }) })), 'price_amount_invalid');
  const a = createSubscription({ ledgerPath: c.ledgerPath, input: base({ idempotencyKey: 'k' }) });
  const b = createSubscription({ ledgerPath: c.ledgerPath, input: base({ idempotencyKey: 'k' }) });
  assert.equal(b.deduplicated, 'idempotency_key');
  assert.equal(b.subscription.id, a.subscription.id);
  assert.equal(err(() => updateSubscription({ ledgerPath: c.ledgerPath, expectedRevision: 0, id: a.subscription.id, patch: { plan: 'x' } })), 'revision_conflict');
});

test('routes: owner CRUD with If-Match; widget access forbidden; no purchase routes', async () => {
  const c = ctx();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-widget']) req.widgetAccess = true; next(); });
  registerCreditLedgerRoutes(app, { filePath: c.ledgerPath, billingPath: path.join(c.dir, 'billing-accounts.json') });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/credit-ledger/subscriptions`;
  const send = (u, method, body, rev) => fetch(u, { method, headers: { 'content-type': 'application/json', ...(rev === undefined ? {} : { 'if-match': `"${rev}"` }) }, body: JSON.stringify(body) });
  try {
    assert.equal((await send(url, 'POST', base())).status, 428);
    assert.equal((await fetch(url, { headers: { 'x-widget': '1' } })).status, 403);
    const created = await (await send(url, 'POST', base(), 0)).json();
    assert.equal(created.subscription.state, 'active');
    const listed = await (await fetch(url)).json();
    assert.equal(listed.subscriptions.length, 1);
    assert.equal(listed.revision, created.revision);
    const stale = await send(`${url}/${created.subscription.id}/state`, 'POST', { state: 'paused' }, 0);
    assert.equal(stale.status, 409);
    const paused = await send(`${url}/${created.subscription.id}/state`, 'POST', { state: 'paused' }, created.revision);
    assert.equal(paused.status, 200);
    const noEvidence = await send(`${url}/${created.subscription.id}/payments`, 'POST', { dueDate: '2026-01-31', paidAt: '2026-01-31', paid: { amount: '1', currency: 'USD' }, source: 'm' }, (await paused.json()).revision);
    assert.equal(noEvidence.status, 400);
    assert.equal((await noEvidence.json()).error, 'payment_evidence_required');
    assert.equal((await send(`${url}/${created.subscription.id}/renew`, 'POST', {}, 1)).status, 404);
  } finally { server.close(); }
});

function upload(dir, content = `img-${Math.random()}`) {
  const uploads = path.join(dir, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const name = `${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(uploads, name), content);
  return { uploads, name, hash: crypto.createHash('sha256').update(content).digest('hex') };
}

test('payment evidence: upload reference is verified, a fabricated reference or bare hash is rejected', () => {
  const c = ctx();
  const { subscription } = createSubscription({ ledgerPath: c.ledgerPath, input: base() });
  const paid = { amount: '100.00', currency: 'USD' };
  const confirm = (dueDate, extra, uploadsDir = path.join(c.dir, 'uploads')) => confirmSubscriptionPayment({
    ledgerPath: c.ledgerPath, id: subscription.id, uploadsDir, input: { dueDate, paidAt: dueDate, paid, source: 'screenshot', ...extra },
  });
  const up = upload(c.dir);
  assert.equal(err(() => confirm('2026-02-28', { attachmentRef: 'x.png' })), 'attachment_invalid');
  assert.equal(err(() => confirm('2026-02-28', { attachmentRef: '../../etc/passwd' })), 'attachment_invalid');
  assert.equal(err(() => confirm('2026-02-28', { attachmentRef: `${crypto.randomUUID()}.jpg` })), 'attachment_missing');
  assert.equal(err(() => confirm('2026-02-28', { attachmentRef: up.name }, '')), 'attachment_missing');
  assert.equal(err(() => confirm('2026-02-28', { attachmentRef: up.name, imageHash: 'f'.repeat(64) })), 'image_hash_mismatch');
  assert.equal(err(() => confirm('2026-02-28', { imageHash: up.hash })), 'image_hash_unverifiable');
  assert.equal(loadSubscriptions(c.ledgerPath).subscriptions[0].payments.length, 0);

  // A path to the upload is reduced to its filename; the hash is computed, not trusted.
  const ok = confirm('2026-02-28', { attachmentRef: path.join(c.dir, 'uploads', up.name), imageHash: up.hash });
  assert.equal(ok.payment.attachmentRef, up.name);
  assert.equal(ok.payment.imageHash, up.hash);
  assert.equal(err(() => confirm('2026-03-31', { attachmentRef: up.name })), 'attachment_reused');
});

test('routes: a fabricated attachment reference cannot confirm a payment; a real upload can', async () => {
  const c = ctx();
  const up = upload(c.dir);
  const app = express();
  app.use(express.json());
  registerCreditLedgerRoutes(app, { filePath: c.ledgerPath, uploadsDir: up.uploads, billingPath: path.join(c.dir, 'b.json') });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/credit-ledger/subscriptions`;
  const send = (u, body, rev) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': `"${rev}"` }, body: JSON.stringify(body) });
  try {
    const created = await (await send(url, base(), 0)).json();
    const pay = `${url}/${created.subscription.id}/payments`;
    const body = { dueDate: '2026-01-31', paidAt: '2026-01-31', paid: { amount: '100.00', currency: 'USD' }, source: 'screenshot' };
    const fake = await send(pay, { ...body, attachmentRef: `${crypto.randomUUID()}.jpg` }, created.revision);
    assert.equal(fake.status, 400);
    assert.equal((await fake.json()).error, 'attachment_missing');
    const bare = await send(pay, { ...body, imageHash: up.hash }, created.revision);
    assert.equal((await bare.json()).error, 'image_hash_unverifiable');
    const ok = await send(pay, { ...body, attachmentRef: up.name, imageHash: up.hash }, created.revision);
    assert.equal(ok.status, 201);
  } finally { server.close(); }
});

test('cycle change keeps confirmed payments linked and records cycle history', () => {
  const c = ctx();
  const { subscription: s } = createSubscription({ ledgerPath: c.ledgerPath, input: base({ cycle: { interval: 'month', anchorDate: '2026-01-10' } }) });
  const paid = { amount: '100.00', currency: 'USD' };
  for (const [d, id] of [['2026-01-10', 'a'], ['2026-02-10', 'b']]) {
    confirmSubscriptionPayment({ ledgerPath: c.ledgerPath, id: s.id, input: { dueDate: d, paidAt: d, paid, source: 'manual', providerTransactionId: id } });
  }
  const up = updateSubscription({ ledgerPath: c.ledgerPath, id: s.id, patch: { cycle: { interval: 'month', anchorDate: '2026-01-20' } } });
  assert.deepEqual(up.subscription.payments.map((p) => p.dueDate), ['2026-01-10', '2026-02-10']);
  assert.equal(up.subscription.cycleHistory.length, 1);
  assert.equal(up.subscription.cycleHistory[0].cycle.anchorDate, '2026-01-10');
  assert.equal(up.subscription.cycleHistory[0].cycle.interval, 'month');
  assert.ok(up.subscription.cycleHistory[0].until);
  assert.equal(up.subscription.priceHistory.length, 0);
  const sch = buildPaymentSchedule(up.subscription, up.subscription.cycleHistory[0].until.slice(0, 10));
  assert.equal(sch.awaitingConfirmation, null);
  assert.deepEqual(sch.confirmedPayments.map((p) => p.dueDate), ['2026-01-10', '2026-02-10']);
  // A confirmed future payment may not be orphaned by a cycle change.
  const f = createSubscription({ ledgerPath: c.ledgerPath, input: base({ label: 'F', cycle: { interval: 'month', anchorDate: '2099-01-10' } }) }).subscription;
  confirmSubscriptionPayment({ ledgerPath: c.ledgerPath, id: f.id, input: { dueDate: '2099-02-10', paidAt: '2026-01-01', paid, source: 'manual', providerTransactionId: 'f1' } });
  assert.equal(err(() => updateSubscription({ ledgerPath: c.ledgerPath, id: f.id, patch: { cycle: { interval: 'month', anchorDate: '2099-01-20' } } })), 'cycle_change_conflicts_with_confirmed_payment');
});

test('price change still appends to priceHistory without cycleHistory', () => {
  const c = ctx();
  const { subscription: s } = createSubscription({ ledgerPath: c.ledgerPath, input: base() });
  const up = updateSubscription({ ledgerPath: c.ledgerPath, id: s.id, patch: { price: { amount: '90.00', currency: 'USD' } } });
  assert.equal(up.subscription.priceHistory.length, 1);
  assert.equal(up.subscription.cycleHistory, undefined);
});

test('old-format subscription without cycleHistory loads and updates', () => {
  const c = ctx();
  const { subscription: s } = createSubscription({ ledgerPath: c.ledgerPath, input: base() });
  assert.equal(s.cycleHistory, undefined);
  const up = updateSubscription({ ledgerPath: c.ledgerPath, id: s.id, patch: { cycle: { interval: 'year', anchorDate: '2026-01-31' } } });
  assert.equal(up.subscription.cycleHistory[0].cycle.interval, 'month');
  assert.equal(readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf: '2026-02-01T00:00:00Z', timeZone: 'UTC', dataDir: c.dir }).subscriptions.length, 1);
});

test('owner time zone decides "today": Warsaw is already on the 15th, UTC still on the 14th', () => {
  const asOf = '2026-03-14T23:30:00Z';
  assert.equal(todayInZone(asOf, 'Europe/Warsaw'), '2026-03-15');
  assert.equal(todayInZone(asOf, 'UTC'), '2026-03-14');
  const c = ctx();
  createSubscription({ ledgerPath: c.ledgerPath, input: base({ cycle: { interval: 'month', anchorDate: '2026-03-14' } }) });
  const v = (timeZone) => readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf, timeZone, dataDir: c.dir }).subscriptions[0];
  const utc = v('UTC');
  assert.equal(utc.nextPayment.dueDate, '2026-03-14');
  assert.equal(utc.awaitingConfirmation, null);
  const warsaw = v('Europe/Warsaw');
  assert.equal(warsaw.nextPayment.dueDate, '2026-04-14');
  assert.equal(warsaw.awaitingConfirmation.dueDate, '2026-03-14');
});

test('time zone: missing zone falls back without throwing, invalid zone is a validation error', () => {
  assert.match(todayInZone('2026-03-14T12:00:00Z'), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(todayInZone('2026-03-14T12:00:00Z', ''), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(err(() => todayInZone('2026-03-14T12:00:00Z', 'Mars/Olympus')), 'time_zone_invalid');
  const c = ctx();
  createSubscription({ ledgerPath: c.ledgerPath, input: base() });
  const view = readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf: '2026-03-14T12:00:00Z', dataDir: c.dir });
  assert.equal(view.subscriptions.length, 1);
  assert.equal(err(() => readSubscriptionsView({ ledgerPath: c.ledgerPath, asOf: '2026-03-14T12:00:00Z', timeZone: 'nope', dataDir: c.dir })), 'time_zone_invalid');
});
