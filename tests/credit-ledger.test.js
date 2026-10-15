import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAccount, loadLedger, readLedgerView, recordSnapshot, recordTransaction,
  supersedeTransaction, tombstoneTransaction, detachReferences, LedgerError,
} from '../lib/credit-ledger/credit-ledger-store.js';

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credit-ledger-'));
  const filePath = path.join(dir, 'credit-ledger.json');
  const { account } = createAccount({ filePath, label: 'Main', walletCurrency: 'CREDITS' });
  return { filePath, accountId: account.id };
}
const topup = (c, extra = {}) => ({
  accountId: c.accountId, type: 'topup', source: 'manual',
  occurredAt: '2026-01-02T10:00:00Z', credit: { amount: '0.10' }, ...extra,
});

test('decimal precision: 0.1 + 0.2 is exactly 0.30', () => {
  const c = ctx();
  recordTransaction({ filePath: c.filePath, input: topup(c, { providerTransactionId: 'a', credit: { amount: '0.1' } }) });
  recordTransaction({ filePath: c.filePath, input: topup(c, { providerTransactionId: 'b', credit: { amount: '0.2' } }) });
  const v = readLedgerView({ filePath: c.filePath });
  assert.equal(v.views.accounts[0].creditBalances.CREDITS.posted, '0.3');
  assert.throws(() => recordTransaction({ filePath: c.filePath, input: topup(c, { credit: { amount: 0.1 } }) }), LedgerError);
});

test('payment currency is separate from credits; currencies never summed', () => {
  const c = ctx();
  recordTransaction({ filePath: c.filePath, input: topup(c, { providerTransactionId: 'p1', credit: { amount: '10' }, payment: { amount: '9.99', currency: 'USD' } }) });
  recordTransaction({ filePath: c.filePath, input: topup(c, { providerTransactionId: 'p2', credit: { amount: '5' }, payment: { amount: '20.00', currency: 'PLN' } }) });
  const a = readLedgerView({ filePath: c.filePath }).views.accounts[0];
  assert.equal(a.creditBalances.CREDITS.posted, '15');
  assert.deepEqual(a.paymentTotals, { USD: '9.99', PLN: '20.00' });
  assert.throws(() => recordTransaction({ filePath: c.filePath, input: topup(c, { credit: { amount: '1', currency: 'USD' } }) }), /credit_currency_mismatch/);
});

test('correction and tombstone keep history; views use active versions', () => {
  const c = ctx();
  const { transaction } = recordTransaction({ filePath: c.filePath, input: topup(c, { providerTransactionId: 'x', credit: { amount: '10.00' } }) });
  const fixed = supersedeTransaction({ filePath: c.filePath, id: transaction.id, input: { credit: { amount: '12.00' } } });
  assert.equal(fixed.transaction.supersedes, transaction.id);
  let v = readLedgerView({ filePath: c.filePath });
  assert.equal(v.views.accounts[0].creditBalances.CREDITS.posted, '12.00');
  tombstoneTransaction({ filePath: c.filePath, id: fixed.transaction.id, reason: 'mistake' });
  v = readLedgerView({ filePath: c.filePath });
  assert.equal(v.views.accounts[0].creditBalances.CREDITS, undefined);
  assert.equal(v.transactions.length, 3);
});

test('concurrent writes with the same provider id store one row', async () => {
  const c = ctx();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() =>
    recordTransaction({ filePath: c.filePath, input: topup(c, { providerTransactionId: 'same', idempotencyKey: `k${i}` }) }))));
  assert.equal(results.filter((r) => !r.deduplicated).length, 1);
  assert.equal(loadLedger(c.filePath).transactions.length, 1);
});

test('date-only stays day precision without invented midnight; snapshot flagged uncertain', () => {
  const c = ctx();
  const { transaction } = recordTransaction({ filePath: c.filePath, input: topup(c, { occurredAt: { value: '2026-03-04', sourceZone: 'Europe/Warsaw' } }) });
  assert.equal(transaction.occurredAt.precision, 'day');
  assert.equal(transaction.occurredAt.at, null);
  assert.equal(transaction.expiresAt, null);
  const { snapshot } = recordSnapshot({ filePath: c.filePath, input: {
    accountId: c.accountId, source: 'ocr', observedAt: '2026-03-04', totalBalance: '3.5', completeness: 'partial' } });
  assert.equal(snapshot.boundaryUncertain, true);
  // The snapshot is an observation: the balance stays the transaction-derived 0.10.
  assert.equal(readLedgerView({ filePath: c.filePath }).views.accounts[0].creditBalances.CREDITS.posted, '0.10');
});

test('same provider id with a new idempotency key deduplicates; amount match only flags', () => {
  const c = ctx();
  const first = recordTransaction({ filePath: c.filePath, input: topup(c, { providerTransactionId: 'T1', idempotencyKey: 'k1' }) });
  const again = recordTransaction({ filePath: c.filePath, input: topup(c, { providerTransactionId: 'T1', idempotencyKey: 'k2' }) });
  assert.equal(again.transaction.id, first.transaction.id);
  assert.equal(again.deduplicated, 'provider_transaction_id');
  const similar = recordTransaction({ filePath: c.filePath, input: topup(c) });
  assert.equal(similar.deduplicated, null);
  assert.deepEqual(similar.transaction.possibleDuplicateOf, [first.transaction.id]);
  assert.throws(() => recordTransaction({ filePath: c.filePath, input: topup(c, { idempotencyKey: 'k1', credit: { amount: '99' } }) }), /idempotency_key_reused/);
  const img = recordTransaction({ filePath: c.filePath, input: topup(c, { imageHash: 'h', credit: { amount: '7' } }) });
  assert.equal(recordTransaction({ filePath: c.filePath, input: topup(c, { imageHash: 'h', credit: { amount: '7' } }) }).transaction.id, img.transaction.id);
});

test('retention and restart: history survives reload; stale revision rejected; chat removal keeps tx', () => {
  const c = ctx();
  const { transaction, revision } = recordTransaction({ filePath: c.filePath, input: topup(c, { chatRef: 'chat-1', providerTransactionId: 'r' }) });
  detachReferences({ filePath: c.filePath, chatId: 'chat-1' });
  const doc = loadLedger(c.filePath);
  assert.equal(doc.transactions.length, 2);
  assert.equal(readLedgerView({ filePath: c.filePath }).views.accounts[0].creditBalances.CREDITS.posted, '0.10');
  assert.ok(doc.transactions.some((t) => t.id === transaction.id));
  assert.throws(() => recordTransaction({ filePath: c.filePath, expectedRevision: revision, input: topup(c, { credit: { amount: '3' } }) }), /revision_conflict/);
  assert.equal(fs.readdirSync(path.dirname(c.filePath)).filter((f) => f.endsWith('.tmp')).length, 0);
});
