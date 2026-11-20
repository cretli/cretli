import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, beforeEach } from 'node:test';
import { refreshDeepSeekBalance, resetDeepSeekBalanceAttemptState } from '../harnesses/deepseek/deepseek-balance.js';
import { importLedgerEntry } from '../lib/credit-ledger/screen-import.ts';
import { readBalanceForecastReport } from '../lib/credit-ledger/balance-forecast.ts';
import { loadLedger, readLedgerView, supersedeTransaction } from '../lib/credit-ledger/credit-ledger-store.ts';
import { listHarnessUsageLimits, noteHarnessUsageLimit } from '../lib/harness-usage-limits.js';
import { scoreShadowCandidates } from '../lib/model-pick-shadow.js';
import { recordUsage } from '../lib/usage/usage-ledger.ts';
import { readUsageEvents } from '../lib/persist/usage-persist.js';
import { fingerprintBillingCredential } from '../lib/usage/billing-account-fingerprint.ts';
import { loadBillingAccountHmacSecret } from '../lib/usage/billing-account-secret.ts';
import { applyBillingAccountToUsagePartial, confirmBillingAccountFingerprint } from '../lib/usage/billing-account-registry.ts';
import { createUsageEvent } from '../lib/usage/usage-event.js';

const tempDirs = [];
const savedKey = process.env.DEEPSEEK_API_KEY;
// Restore the env and attempt state after every test, also when an assertion failed.
beforeEach(() => resetDeepSeekBalanceAttemptState());
afterEach(() => {
  if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = savedKey;
});
after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  removeIsolatedDataDir();
});
assert.ok(ISOLATED_DATA_DIR);

// Fictional data and a mocked provider API only: no network, no real key.
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const KEY_A = 'sk-fictional-key-aaaaaaaaaa';
const KEY_B = 'sk-fictional-key-bbbbbbbbbb';
const SHOT_A = `${crypto.randomUUID()}.jpg`;
const SHOT_B = `${crypto.randomUUID()}.jpg`;

function body(total, granted = '0.00') {
  return {
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: total,
      granted_balance: granted,
      topped_up_balance: (Number(total) - Number(granted)).toFixed(2),
    }],
  };
}
const fetchWith = (status, json) => async () => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json,
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-billing-e2e-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'uploads'));
  return { dir, ledgerPath: path.join(dir, 'credit-ledger.json'), uploadsDir: path.join(dir, 'uploads') };
}
const refresh = (c, now, fetchImpl, reason = 'manual') => refreshDeepSeekBalance({
  reason, ledgerPath: c.ledgerPath, dataDir: c.dir, now, fetchImpl,
});

test('balance 100 + top-up 20 - usage 30 - expiry 5 = balance 85 and spend 30 (screen import, restart, correction, duplicate)', async () => {
  const c = setup();
  process.env.DEEPSEEK_API_KEY = KEY_A;
  const first = await refresh(c, T0, fetchWith(200, body('100.00', '5.00')));
  assert.equal(first.ok, true);
  const accountId = first.accountId;
  const ledgerAccount = loadLedger(c.ledgerPath).accounts[0];

  // Screen import: a screenshot-derived top-up is saved as one transaction.
  fs.writeFileSync(path.join(c.uploadsDir, SHOT_A), 'fake-image-bytes');
  const importInput = (extra = {}) => ({
    kind: 'transaction', save: true, accountId: ledgerAccount.id, type: 'topup',
    occurredAt: new Date(T0 + 2 * DAY).toISOString(), credit: { amount: '20.00', currency: 'CNY' },
    attachmentRef: SHOT_A, idempotencyKey: 'screen-topup-1', ...extra,
  });
  const saved = importLedgerEntry({ ledgerPath: c.ledgerPath, uploadsDir: c.uploadsDir, input: importInput() });
  assert.equal(saved.status, 'saved', JSON.stringify(saved));
  // Same screenshot re-sent: deduplicated, still one transaction.
  const again = importLedgerEntry({ ledgerPath: c.ledgerPath, uploadsDir: c.uploadsDir, input: importInput() });
  assert.ok(again.deduplicated);
  // The same top-up on another screenshot stays a draft until acknowledged.
  fs.writeFileSync(path.join(c.uploadsDir, SHOT_B), 'other-bytes');
  const dup = importLedgerEntry({
    ledgerPath: c.ledgerPath, uploadsDir: c.uploadsDir,
    input: importInput({ attachmentRef: SHOT_B, idempotencyKey: 'screen-topup-2' }),
  });
  assert.equal(dup.reason, 'possible_duplicate');

  // Expiry of 5 credits (manual entry, negative wallet change).
  const expiry = importLedgerEntry({
    ledgerPath: c.ledgerPath, uploadsDir: c.uploadsDir,
    input: {
      kind: 'transaction', save: true, accountId: ledgerAccount.id, type: 'expiry',
      occurredAt: new Date(T0 + 3 * DAY).toISOString(), credit: { amount: '5.00', currency: 'CNY' }, idempotencyKey: 'exp-1',
    },
  });
  assert.equal(expiry.status, 'saved');
  assert.equal(loadLedger(c.ledgerPath).transactions.length, 2);

  // Restart: attempt state is process memory, the key fingerprint lives on disk.
  resetDeepSeekBalanceAttemptState();
  const second = await refresh(c, T0 + 7 * DAY, fetchWith(200, body('85.00')));
  assert.equal(second.ok, true);
  assert.equal(second.accountId, accountId, 'same key after restart keeps the same account series');

  const report = readBalanceForecastReport({ filePath: c.ledgerPath, dataDir: c.dir, now: T0 + 7 * DAY });
  const fc = report.forecasts.find((f) => f.currency === 'CNY');
  assert.equal(fc.latestBalance, '85.00');
  assert.equal(fc.windows['7d'].spend, '30.00');
  assert.equal(fc.windows['7d'].flows.topups, '20.00');
  assert.equal(fc.windows['7d'].flows.expiries, '5.00');
  assert.ok(fc.remainingMs > 0);

  // Correction: the top-up amount is amended; history keeps both versions.
  supersedeTransaction({ filePath: c.ledgerPath, id: saved.id, input: { credit: { amount: '25.00' } } });
  const view = readLedgerView({ filePath: c.ledgerPath });
  assert.equal(view.transactions.filter((t) => t.type === 'topup').length, 2);
  const corrected = readBalanceForecastReport({ filePath: c.ledgerPath, dataDir: c.dir, now: T0 + 7 * DAY });
  assert.equal(corrected.forecasts.find((f) => f.currency === 'CNY').windows['7d'].spend, '35.00');
});

test('balance view survives with no rates and no history: only the forecast is limited', async () => {
  const c = setup();
  process.env.DEEPSEEK_API_KEY = KEY_A;
  await refresh(c, T0, fetchWith(200, body('42.00')));
  const fc = readBalanceForecastReport({ filePath: c.ledgerPath, dataDir: c.dir, now: T0 + 1000 })
    .forecasts.find((f) => f.currency === 'CNY');
  assert.equal(fc.latestBalance, '42.00');
  assert.equal(fc.remainingMs ?? null, null);
});

test('key rotation: pending identity, then new_account gets its own balance series', async () => {
  const c = setup();
  process.env.DEEPSEEK_API_KEY = KEY_A;
  const a = await refresh(c, T0, fetchWith(200, body('10.00')));
  assert.equal(a.ok, true);
  process.env.DEEPSEEK_API_KEY = KEY_B;
  const b = await refresh(c, T0 + DAY, fetchWith(200, body('99.00')));
  assert.deepEqual([b.ok, b.kind], [false, 'identity_pending']);
  const before = loadLedger(c.ledgerPath);
  assert.equal(before.snapshots.length, 1, 'a pending identity writes no snapshot');

  // The operator confirms the rotated key as a NEW account.
  const { secret, secretId } = loadBillingAccountHmacSecret({ filePath: path.join(c.dir, 'billing-account-hmac-secret.json') });
  const fp = fingerprintBillingCredential({ secret, provider: 'deepseek', endpoint: 'https://api.deepseek.com', credentialMaterial: KEY_B });
  const split = confirmBillingAccountFingerprint(a.accountId, fp, {
    filePath: path.join(c.dir, 'billing-accounts.json'), hmac: { secret, secretId }, decision: 'new_account',
  });
  assert.equal(split.decision, 'new_account');
  assert.notEqual(split.account.accountId, a.accountId);

  const b2 = await refresh(c, T0 + 2 * DAY, fetchWith(200, body('99.00')));
  assert.equal(b2.ok, true);
  assert.equal(b2.accountId, split.account.accountId);
  const doc = loadLedger(c.ledgerPath);
  const ledgerA = doc.accounts.find((x) => x.idempotencyKey.includes(a.accountId));
  const ledgerB = doc.accounts.find((x) => x.idempotencyKey.includes(b2.accountId));
  assert.ok(ledgerA && ledgerB && ledgerA.id !== ledgerB.id, 'two ledger accounts');
  const seriesOf = (acc) => doc.snapshots.filter((s) => s.accountId === acc.id && s.series === 'deepseek-api');
  assert.deepEqual(seriesOf(ledgerA).map((s) => s.totalBalance.value), ['10.00'], 'old series unchanged');
  assert.deepEqual(seriesOf(ledgerB).map((s) => s.totalBalance.value), ['99.00'], 'new series has the new balance');
});

test('401 / 403 / 429 / 5xx / 402 are failures: fetch is reached, no snapshot, no unlock; a 200 unlocks only its own limit', async () => {
  const c = setup();
  process.env.DEEPSEEK_API_KEY = KEY_A;
  let tick = 0;
  const clock = () => T0 + (++tick) * DAY; // strictly increasing: never throttled
  const ok = await refresh(c, clock(), fetchWith(200, body('0.00')));
  const accountId = ok.accountId;
  const snapshots = loadLedger(c.ledgerPath).snapshots.length;
  noteHarnessUsageLimit({ harness: 'deepseek', message: 'Insufficient Balance', dataDir: c.dir, accountId });
  // Same harness, other account, different model. An "Insufficient Balance" message would be forced to
  // a harness-wide row (model ''), colliding with the first lock; an explicit code with a plain
  // usage-limit message keeps the model, so the row key (harness:model) differs. Only the accountId
  // filter in clearInsufficientBalanceLimit can then keep this lock when the first account is unblocked.
  noteHarnessUsageLimit({ harness: 'deepseek', model: 'deepseek-reasoner', message: 'usage limit reached', code: 'insufficient_balance', dataDir: c.dir, accountId: 'acct_other' });
  noteHarnessUsageLimit({ harness: 'deepseek', model: 'deepseek-chat', message: 'rate limit exceeded: too many requests', dataDir: c.dir, code: 'rate_limit_rejected', source: 'error-text' });
  const limitsBefore = listHarnessUsageLimits(c.dir).length;
  assert.equal(limitsBefore, 3);
  for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate_limited'], [500, 'server'], [502, 'server'], [402, 'http']]) {
    let calls = 0;
    const r = await refresh(c, clock(), async (...args) => { calls += 1; return fetchWith(status, {})(...args); });
    assert.equal(calls, 1, `status ${status} reached the mocked fetch (not throttled)`);
    assert.equal(r.ok, false);
    assert.equal(r.kind, kind);
    assert.equal(r.status, status);
    assert.equal(r.skipped, undefined);
  }
  assert.equal(loadLedger(c.ledgerPath).snapshots.length, snapshots);
  assert.equal(listHarnessUsageLimits(c.dir).length, limitsBefore, 'failures unlock nothing');
  // A successful reading unlocks only the matching account's balance limit.
  const good = await refresh(c, clock(), fetchWith(200, body('50.00')));
  assert.equal(good.ok, true);
  assert.equal(good.unlocked, 1);
  const left = listHarnessUsageLimits(c.dir);
  assert.equal(left.length, 2);
  assert.equal(left.some((x) => x.accountId === accountId), false);
  const other = left.find((x) => x.accountId === 'acct_other');
  assert.ok(other, 'the other account lock survives');
  assert.equal(other.harness, 'deepseek');
  assert.equal(other.model, 'deepseek-reasoner');
  assert.equal(other.code, 'insufficient_balance');
  assert.equal(left.some((x) => x.code === 'rate_limit_rejected'), true);
});

test('billingClass: account mapping drives the class onto the persisted event; legacy events read as unknown', () => {
  const c = setup();
  const accountsFilePath = path.join(c.dir, 'billing-accounts.json');
  const secretFilePath = path.join(c.dir, 'billing-account-hmac-secret.json');
  const ctx = { dataDir: c.dir, accountsFilePath, secretFilePath, autoRegister: true };
  const partial = applyBillingAccountToUsagePartial({
    harness: 'deepseek', provider: 'deepseek', feature: 'chat', model: 'deepseek-chat',
    billingCredentialMaterial: KEY_A, tokens: { textInput: 10, textOutput: 1 },
  }, ctx);
  assert.ok(partial.accountId, 'account mapping resolved an account');
  assert.equal(partial.billingClass, 'api_metered');
  const priced = recordUsage(partial, ctx);
  assert.equal(priced.billingClass, 'api_metered');
  const events = readUsageEvents({ dataDir: c.dir });
  assert.equal(events.length, 1);
  assert.equal(events[0].billingClass, 'api_metered');
  assert.equal(events[0].accountId, partial.accountId);
  // A legacy entry has no class on disk; consumers treat it as unknown.
  const legacy = createUsageEvent({ harness: 'deepseek', provider: 'deepseek', model: 'deepseek-chat', tokens: { textInput: 10, textOutput: 1 } });
  assert.equal(legacy.billingClass, undefined);
  // Run both events through a real consumer (the shadow scorer) that maps a missing class to unknown.
  const scored = scoreShadowCandidates({
    role: 'implement',
    candidates: [{ harness: 'deepseek', model: 'deepseek-chat', score: 1 }],
    billingClassOf: () => legacy.billingClass,
  });
  assert.equal(scored.scores[0].billing_class, 'unknown');
  const scoredMetered = scoreShadowCandidates({
    role: 'implement',
    candidates: [{ harness: 'deepseek', model: 'deepseek-chat', score: 1 }],
    billingClassOf: () => events[0].billingClass,
  });
  assert.equal(scoredMetered.scores[0].billing_class, 'api_metered');
});
