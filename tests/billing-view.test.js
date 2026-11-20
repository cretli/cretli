import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildBillingViewModel, buildHistory, buildSnapshotInput, buildTransactionInput,
  classifyBalanceState, renderBillingView as _renderBillingView, renderHarnessBillingView as _renderHarnessBillingView,
} from '../app_front/features/usage/billingView.js';
import { createBillingController } from '../app_front/features/usage/billingController.js';
import { createAccount, recordSnapshot, recordTransaction, readLedgerView } from '../lib/credit-ledger/credit-ledger-store.ts';
import { readBalanceForecastReport } from '../lib/credit-ledger/balance-forecast.ts';
import { buildHarnessLinks } from '../lib/credit-ledger/harness-links.ts';
import { en } from '../app_front/i18n/en.js';
import { templateToString as _str } from './helpers/lit-template-string.js';
const renderBillingHtml = (...args) => _str(_renderBillingView(...args));
const renderHarnessBillingHtml = (...args) => _str(_renderHarnessBillingView(...args));

const t = (key, vars = {}) => {
  const value = key.split('.').reduce((o, k) => o?.[k], en) ?? key;
  return String(value).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
};
const NOW = Date.parse('2026-03-20T12:00:00Z');
const day = (d, h = 12) => `2026-03-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;

function ledgerDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-view-'));
  return path.join(dir, 'credit-ledger.json');
}
function snap(filePath, accountId, currency, total, at, extra = {}) {
  recordSnapshot({ filePath, input: { accountId, currency, totalBalance: total, observedAt: at, source: 'provider-api', completeness: 'complete', ...extra } });
}
function model(filePath, links = [], now = NOW) {
  const ledger = { ok: true, ...readLedgerView({ filePath }) };
  const forecast = { ok: true, ...readBalanceForecastReport({ filePath, now, dataDir: path.dirname(filePath) }) };
  return buildBillingViewModel({ ledger, forecast, links });
}

test('state classification: zero / unknown / unavailable / stale / inconsistent / ok', () => {
  const base = { status: 'ok', balance: '5', available: null, stale: false };
  assert.equal(classifyBalanceState({ ...base, balance: '0.00' }), 'zero');
  assert.equal(classifyBalanceState({ ...base, balance: null }), 'unknown');
  assert.equal(classifyBalanceState({ ...base, available: false }), 'unavailable');
  assert.equal(classifyBalanceState({ ...base, stale: true }), 'stale');
  assert.equal(classifyBalanceState({ ...base, status: 'inconsistent' }), 'inconsistent');
  assert.equal(classifyBalanceState(base), 'ok');
});

test('real ledger: account without readings is unknown and shows no exhaustion date', () => {
  const f = ledgerDir();
  createAccount({ filePath: f, label: 'Empty', walletCurrency: 'USD' });
  const m = model(f);
  assert.equal(m.accounts[0].rows[0].state, 'unknown');
  const html = renderBillingHtml(m, { t });
  assert.match(html, /Balance unknown/);
  assert.match(html, /No exhaustion date/);
  assert.doesNotMatch(html, /Projected exhaustion/);
});

test('real ledger: zero, unavailable, stale and both currencies are rendered separately', () => {
  const f = ledgerDir();
  const usd = createAccount({ filePath: f, label: 'USD wallet', walletCurrency: 'USD' }).account;
  const cny = createAccount({ filePath: f, label: 'CNY wallet', walletCurrency: 'CNY' }).account;
  snap(f, usd.id, 'USD', '0.00', day(19));
  snap(f, cny.id, 'CNY', '12.50', day(1), { isAvailable: false });
  const m = model(f);
  const byLabel = Object.fromEntries(m.accounts.map((a) => [a.label, a.rows[0]]));
  assert.equal(byLabel['USD wallet'].state, 'zero');
  assert.equal(byLabel['CNY wallet'].state, 'unavailable');
  const html = renderBillingHtml(m, { t });
  assert.match(html, /0\.00 USD/);
  assert.match(html, /12\.50 CNY/);
  assert.match(html, /No local pricing/);
  const stale = model(f, [], NOW + 5 * 24 * 3600 * 1000);
  assert.equal(stale.accounts.find((a) => a.label === 'USD wallet').rows[0].state, 'stale');
  assert.match(renderBillingHtml(stale, { t }), /Older balance/);
});

test('real ledger: negative spend without a top-up is inconsistent and gives no date', () => {
  const f = ledgerDir();
  const a = createAccount({ filePath: f, label: 'W', walletCurrency: 'USD' }).account;
  snap(f, a.id, 'USD', '5.00', day(10));
  snap(f, a.id, 'USD', '9.00', day(19));
  const row = model(f).accounts[0].rows[0];
  assert.equal(row.status, 'inconsistent');
  assert.equal(row.state, 'inconsistent');
  assert.equal(row.exhaustion, null);
});

test('verified spend shows an exhaustion date with its basis; incomplete history is flagged', () => {
  const f = ledgerDir();
  const a = createAccount({ filePath: f, label: 'W', walletCurrency: 'USD' }).account;
  snap(f, a.id, 'USD', '20.00', day(12));
  snap(f, a.id, 'USD', '10.00', day(19), { completeness: 'partial' });
  const row = model(f).accounts[0].rows[0];
  assert.ok(row.flags.incompleteHistory);
  const full = ledgerDir();
  const b = createAccount({ filePath: full, label: 'F', walletCurrency: 'USD' }).account;
  snap(full, b.id, 'USD', '20.00', day(12));
  snap(full, b.id, 'USD', '10.00', day(19));
  const ok = model(full).accounts[0].rows[0];
  assert.equal(ok.state, 'ok');
  assert.ok(ok.exhaustion);
  assert.match(renderBillingHtml(model(full), { t }), /Projected exhaustion.*7d pace/);
  assert.equal(row.exhaustion?.windowId ?? null, row.exhaustion ? '7d' : null);
});

test('uncertain expiry: date-only expiry is flagged', () => {
  const f = ledgerDir();
  const a = createAccount({ filePath: f, label: 'W', walletCurrency: 'USD' }).account;
  snap(f, a.id, 'USD', '5.00', day(19));
  recordTransaction({ filePath: f, input: { accountId: a.id, type: 'grant', source: 'manual', occurredAt: day(2), credit: { amount: '5' }, expiresAt: '2026-04-30' } });
  const row = model(f).accounts[0].rows[0];
  assert.ok(row.flags.uncertainExpiry);
  assert.match(renderBillingHtml(model(f), { t }), /Expiry uncertain/);
});

test('shared wallet is listed once; harness block does not repeat it per binding', () => {
  const f = ledgerDir();
  const a = createAccount({ filePath: f, label: 'Shared', walletCurrency: 'USD', idempotencyKey: 'billing-account:ba1' }).account;
  snap(f, a.id, 'USD', '7.00', day(19));
  const links = buildHarnessLinks({
    billingAccounts: [{ accountId: 'ba1', label: 'DS', bindings: [{ harness: 'deepseek', profileKey: 'a' }, { harness: 'deepseek', profileKey: 'b' }, { harness: 'opencode', profileKey: 'default' }] }],
    ledgerAccounts: [a],
  });
  assert.equal(links.length, 3);
  const m = model(f, links);
  assert.equal(m.accounts.length, 1);
  assert.equal(m.accounts[0].harnesses.length, 3);
  const html = renderHarnessBillingHtml('deepseek', m, { t });
  assert.equal((html.match(/<li>Shared/g) || []).length, 1);
  assert.equal(renderHarnessBillingHtml('qwen', m, { t }), '');
  assert.match(html, /data-billing-open/);
});

test('duplicates: hints group both rows and withdraw is offered', () => {
  const f = ledgerDir();
  const a = createAccount({ filePath: f, label: 'W', walletCurrency: 'USD' }).account;
  const input = { accountId: a.id, type: 'topup', source: 'manual', occurredAt: day(3), credit: { amount: '10' } };
  recordTransaction({ filePath: f, input });
  recordTransaction({ filePath: f, input: { ...input, source: 'screen' } });
  const history = buildHistory(readLedgerView({ filePath: f }).transactions);
  assert.equal(history.duplicateGroups.length, 1);
  assert.equal(history.active.filter((x) => x.isPossibleDuplicate).length, 2);
  assert.match(renderBillingHtml(model(f), { t }), /data-billing-action="withdraw"/);
});

test('form validation: transaction and snapshot', () => {
  const ok = buildTransactionInput({ accountId: 'a', type: 'topup', amount: '10.5', occurredAt: '2026-03-01', source: 'manual' });
  assert.ok(ok.ok);
  assert.equal(ok.input.credit.amount, '10.5');
  assert.deepEqual(buildTransactionInput({ type: 'topup', amount: '-1', occurredAt: '2026-03-01', source: 'x' }).errors, ['credit_amount_negative']);
  assert.ok(buildTransactionInput({ type: 'adjustment', amount: '-1', occurredAt: '2026-03-01', source: 'x' }).ok);
  assert.ok(buildTransactionInput({ type: 'topup', amount: 'abc', occurredAt: 'nope', source: '' }).errors.length >= 3);
  assert.deepEqual(buildTransactionInput({ type: 'topup', amount: '1', occurredAt: '2026-03-01', source: 's', paymentAmount: '2', paymentCurrency: 'x' }).errors, ['payment_currency_invalid']);
  const snapOk = buildSnapshotInput({ accountId: 'a', currency: 'cny', totalBalance: '3', observedAt: day(1), isAvailable: 'no' });
  assert.equal(snapOk.input.currency, 'CNY');
  assert.equal(snapOk.input.isAvailable, false);
  assert.equal(snapOk.input.source, 'manual');
  assert.ok(buildSnapshotInput({ currency: 'USD', totalBalance: '', observedAt: day(1) }).errors.includes('total_balance_invalid'));
});

function liveController(filePath) {
  const painted = [];
  const status = [];
  const api = {
    getLedger: async () => ({ ok: true, ...readLedgerView({ filePath }) }),
    getForecast: async () => ({ ok: true, ...readBalanceForecastReport({ filePath, now: NOW, dataDir: path.dirname(filePath) }) }),
    getLinks: async () => ({ ok: true, links: [] }),
    mutate: async (method, p, revision, body) => {
      try {
        const m = await import('../lib/credit-ledger/credit-ledger-store.ts');
        const id = decodeURIComponent(p.split('/')[2] || '');
        if (method === 'POST' && p === '/accounts') return { ok: true, ...m.createAccount({ filePath, expectedRevision: revision, ...body }) };
        if (method === 'POST' && p === '/transactions') return { ok: true, ...m.recordTransaction({ filePath, expectedRevision: revision, input: body }) };
        if (method === 'POST' && p === '/snapshots') return { ok: true, ...m.recordSnapshot({ filePath, expectedRevision: revision, input: body }) };
        if (method === 'PUT') return { ok: true, ...m.supersedeTransaction({ filePath, expectedRevision: revision, id, input: body }) };
        if (method === 'DELETE') return { ok: true, ...m.tombstoneTransaction({ filePath, expectedRevision: revision, id, reason: body.reason }) };
      } catch (err) { return { ok: false, error: err.code }; }
      return { ok: false, error: 'unknown' };
    },
  };
  const c = createBillingController({ api, t, paint: (view, m) => painted.push({ html: _str(view), m }), setStatus: (msg, tone) => status.push({ msg, tone }) });
  return { c, painted, status };
}

test('flows: add account, save reading, add + correct transaction, repaint without reload', async () => {
  const f = ledgerDir();
  const { c, painted, status } = liveController(f);
  await c.refresh();
  assert.match(painted.at(-1).html, /No billing accounts yet/);
  assert.equal((await c.saveAccount({ label: '', walletCurrency: 'USD' })).ok, false);
  assert.equal((await c.saveAccount({ label: 'Main', walletCurrency: 'cny' })).ok, true);
  const m1 = painted.at(-1).m;
  assert.equal(m1.accounts[0].walletCurrency, 'CNY');
  const accountId = m1.accounts[0].id;
  assert.equal((await c.saveSnapshot({ accountId, currency: 'CNY', totalBalance: '12.5', observedAt: day(19), source: 'manual', completeness: 'complete' })).ok, true);
  assert.match(painted.at(-1).html, /12\.5 CNY/);
  const form = { accountId, type: 'topup', amount: '10', occurredAt: day(18), source: 'manual', idempotencyKey: 'k1' };
  assert.equal((await c.saveTransaction('create', form)).ok, true);
  const tx = painted.at(-1).m.accounts[0].transactions[0];
  assert.equal(tx.credit.value, '10');
  assert.equal((await c.saveTransaction('correct', { ...form, amount: '11' }, tx.id)).ok, true);
  const after = painted.at(-1).m.accounts[0].transactions;
  assert.equal(after.length, 1);
  assert.equal(after[0].credit.value, '11');
  assert.equal(after[0].revisions, 1);
  assert.match(painted.at(-1).html, /corrected ×1/);
  assert.equal((await c.saveTransaction('create', { ...form, amount: 'x' })).ok, false);
  assert.equal(status.at(-1).tone, 'error');
});

test('flow: stale revision reloads the view instead of overwriting', async () => {
  const f = ledgerDir();
  const { c, painted, status } = liveController(f);
  await c.refresh();
  await c.saveAccount({ label: 'A', walletCurrency: 'USD' });
  createAccount({ filePath: f, label: 'Other tab', walletCurrency: 'USD' });
  const before = painted.length;
  assert.equal((await c.saveAccount({ label: 'B', walletCurrency: 'USD' })).ok, false);
  assert.match(status.at(-1).msg, /changed elsewhere/);
  assert.ok(painted.length > before);
  assert.equal(painted.at(-1).m.accounts.length, 2);
});

test('flow: withdrawing a duplicate removes it from the active history', async () => {
  const f = ledgerDir();
  const a = createAccount({ filePath: f, label: 'W', walletCurrency: 'USD' }).account;
  const input = { accountId: a.id, type: 'topup', source: 'manual', occurredAt: day(3), credit: { amount: '10' } };
  recordTransaction({ filePath: f, input });
  const dup = recordTransaction({ filePath: f, input: { ...input, source: 'screen' } }).transaction;
  const { c, painted } = liveController(f);
  await c.refresh();
  assert.equal(await c.withdrawDuplicate(dup.id), true);
  const txs = painted.at(-1).m.accounts[0].transactions;
  assert.equal(txs.length, 1);
  assert.equal(txs[0].isPossibleDuplicate, false);
});

test('out-of-order refresh: an older slow response never overwrites a newer one', async () => {
  const f = ledgerDir();
  createAccount({ filePath: f, label: 'One', walletCurrency: 'USD' });
  const painted = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const c = createBillingController({
    api: {
      getLedger: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return { ok: true, ...readLedgerView({ filePath: f }), revision: calls };
      },
      getForecast: async () => ({ ok: true, forecasts: [] }),
      getLinks: async () => ({ ok: true, links: [] }),
      mutate: async () => ({ ok: true }),
    },
    t, paint: (html, m) => painted.push(m),
  });
  const slow = c.refresh();
  await c.refresh();
  release();
  await slow;
  assert.equal(painted.length, 1);
  assert.equal(c.getState().revision, 2);
});

test('i18n: every billing key used by the view exists in both dictionaries', async () => {
  const { pl } = await import('../app_front/i18n/pl.js');
  assert.deepEqual(Object.keys(en.billing).sort(), Object.keys(pl.billing).sort());
  const src = fs.readFileSync(new URL('../app_front/features/usage/billingView.js', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../app_front/features/usage/billingPanel.js', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/'billing\.([A-Za-z_]+)'/g)].map((m) => m[1]));
  for (const key of used) assert.ok(en.billing[key] !== undefined, `billing.${key} missing`);
});

test('A1: negative adjustment renders a minus sign, positive adjustment a plus sign', () => {
  const f = ledgerDir();
  const a = createAccount({ filePath: f, label: 'Adj', walletCurrency: 'USD' }).account;
  const base = { accountId: a.id, type: 'adjustment', occurredAt: day(18), source: 'manual' };
  recordTransaction({ filePath: f, input: { ...base, credit: { amount: '-5.00' }, idempotencyKey: 'adj-neg' } });
  recordTransaction({ filePath: f, input: { ...base, credit: { amount: '3.00' }, idempotencyKey: 'adj-pos' } });
  const html = renderBillingHtml(model(f), { t });
  assert.match(html, /−5\.00 USD/);
  assert.match(html, /\+3\.00 USD/);
  assert.doesNotMatch(html, /\+−|\+-|−−/);
});

test('A2: shared-wallet harness names are not dead href="#" anchors', () => {
  const f = ledgerDir();
  createAccount({ filePath: f, label: 'W', walletCurrency: 'USD' });
  const html = renderBillingHtml(model(f), { t });
  assert.doesNotMatch(html, /<a [^>]*data-billing-harness/);
});

test('A3: invalid wallet currency is rejected client-side with the wallet error', async () => {
  const f = ledgerDir();
  const { c, status } = liveController(f);
  await c.refresh();
  assert.equal((await c.saveAccount({ label: 'Main', walletCurrency: 'US D!' })).ok, false);
  assert.equal(status.at(-1).tone, 'error');
  assert.equal(status.at(-1).msg, en.billing.error_wallet_currency_invalid);
  assert.equal((await c.saveAccount({ label: 'Main', walletCurrency: '' })).ok, false);
});

test('A4: a stale balance never shows an exhaustion date', () => {
  const f = ledgerDir();
  const a = createAccount({ filePath: f, label: 'S', walletCurrency: 'USD' }).account;
  snap(f, a.id, 'USD', '20.00', day(12));
  snap(f, a.id, 'USD', '10.00', day(19));
  assert.ok(model(f).accounts[0].rows[0].exhaustion);
  const later = Date.parse('2026-06-20T12:00:00Z');
  const stale = model(f, [], later);
  const row = stale.accounts[0].rows[0];
  assert.notEqual(row.state, 'ok');
  assert.equal(row.exhaustion, null);
  const html = renderBillingHtml(stale, { t });
  assert.doesNotMatch(html, /Projected exhaustion/);
  assert.match(html, /No exhaustion date/);
});

test('last provider attempt line renders for success and error, absent without attempt', () => {
  const filePath = ledgerDir();
  const acc = createAccount({ filePath, label: 'DeepSeek API', walletCurrency: 'USD', idempotencyKey: 'ds-attempt' }).account;
  const links = [{ harness: 'deepseek', profileKey: 'default', ledgerAccountId: acc.id }];
  const html = (attempt) => {
    const m = buildBillingViewModel({ ledger: readLedgerView({ filePath, now: NOW }), forecast: null, links, providerAttempt: attempt });
    return renderBillingHtml(m, { t }) + renderHarnessBillingHtml('deepseek', m, { t });
  };
  const okHtml = html({ at: '2026-03-20T11:00:00Z', ok: true, kind: 'ok' });
  assert.match(okHtml, /data-billing-last-attempt/);
  assert.match(okHtml, /Last attempt:.*succeeded/);
  const errHtml = html({ at: '2026-03-20T11:00:00Z', ok: false, kind: 'unauthorized' });
  assert.match(errHtml, /Last attempt:.*failed \(unauthorized\)/);
  assert.doesNotMatch(html(null), /data-billing-last-attempt/);
});

test('buildHistory: 2000 transactions with supersedes chains, one Map, same result as the reference', () => {
  const rows = [];
  for (let i = 0; i < 2000; i += 1) {
    // Chains of length 4: every 4th row is the original, the rest supersede the previous one.
    rows.push({ id: `t${i}`, supersedes: i % 4 === 0 ? undefined : `t${i - 1}`, occurredAt: { at: day(1 + (i % 28), i % 24) } });
  }
  rows.push({ id: 'tomb', supersedes: 't3', tombstone: true, occurredAt: { date: '2026-03-02' } });
  const RealMap = globalThis.Map;
  let constructed = 0;
  globalThis.Map = class extends RealMap {
    constructor(...args) { super(...args); constructed += 1; }
  };
  let result;
  const started = Date.now();
  try { result = buildHistory(rows); } finally { globalThis.Map = RealMap; }
  assert.equal(constructed, 1);
  assert.ok(Date.now() - started < 2000);
  // Reference: the chain depth computed by walking supersedes links.
  const byId = new RealMap(rows.map((r) => [r.id, r]));
  const depthOf = (tx) => { let d = 0; let cur = tx; while (cur?.supersedes && d < 50) { d += 1; cur = byId.get(cur.supersedes); } return d; };
  assert.ok(result.active.length > 0);
  for (const tx of result.active) assert.equal(tx.revisions, depthOf(byId.get(tx.id)));
  assert.equal(result.corrected, 1500);
  assert.equal(result.withdrawn, 1);
});

test('billing fetch cache: five harness cards share one request triple, a save invalidates it', async () => {
  const { createBillingFetchCache } = await import('../app_front/features/usage/billingCache.js');
  const calls = { ledger: 0, forecast: 0, links: 0 };
  const cache = createBillingFetchCache({
    getLedger: async () => { calls.ledger += 1; return { ok: true }; },
    getForecast: async () => { calls.forecast += 1; return {}; },
    getLinks: async () => { calls.links += 1; return { ok: true, links: [] }; },
  });
  await Promise.all([1, 2, 3, 4, 5].map(() => cache.get()));
  assert.deepEqual(calls, { ledger: 1, forecast: 1, links: 1 });
  await cache.get();
  assert.deepEqual(calls, { ledger: 1, forecast: 1, links: 1 });
  cache.invalidate();
  await Promise.all([1, 2, 3, 4, 5].map(() => cache.get()));
  assert.deepEqual(calls, { ledger: 2, forecast: 2, links: 2 });
});

test('billing fetch cache: invalidation during a flight and failures are not cached', async () => {
  const { createBillingFetchCache } = await import('../app_front/features/usage/billingCache.js');
  let n = 0;
  let fail = true;
  const cache = createBillingFetchCache({
    getLedger: async () => { n += 1; if (fail) throw new Error('boom'); return { n }; },
    getForecast: async () => ({}),
    getLinks: async () => ({}),
  });
  await assert.rejects(cache.get());
  fail = false;
  const inflight = cache.get();
  cache.invalidate();
  await inflight;
  await cache.get();
  assert.equal(n, 3);
});

test('billing panel: harness cards read through the cache and saves invalidate it', () => {
  const src = fs.readFileSync(new URL('../app_front/features/usage/billingPanel.js', import.meta.url), 'utf8');
  assert.match(src, /harnessBillingCache\.get\(\)/);
  assert.match(src, /mutate: saveCreditLedger/);
  assert.match(src, /invalidatingAfter\(mutateCreditLedger\)/);
});
