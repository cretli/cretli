import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from '../../../tests/helpers/isolated-data-dir.js';
import '../../../tests/helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseDeepSeekBalanceResponse,
  readDeepSeekBalanceStatus,
  refreshDeepSeekBalance,
  resetDeepSeekBalanceAttemptState,
  DEEPSEEK_BALANCE_FRESHNESS_MS,
} from '../deepseek-balance.js';
import {
  clearHarnessUsageLimit,
  clearInsufficientBalanceLimit,
  getHarnessUsageLimit,
  listHarnessUsageLimits,
  noteHarnessUsageLimit,
} from '../../../lib/harness-usage-limits.js';
import { loadLedger } from '../../../lib/credit-ledger/credit-ledger-store.ts';
import { shouldRetryDeepSeekRunWithoutSession } from '../deepseek-run-outcome.js';

assert.ok(ISOLATED_DATA_DIR);
const dir = mkdtempSync(path.join(tmpdir(), 'ds-balance-'));
const ledgerPath = path.join(dir, 'credit-ledger.json');
const KEY = 'sk-test-secret-1234567890';
process.env.DEEPSEEK_API_KEY = KEY;
let t = 1_800_000_000_000;
const step = () => { t += 10 * 60 * 1000; return t; };

const okBody = (isAvailable = true) => ({
  is_available: isAvailable,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    { currency: 'USD', total_balance: '0.50', granted_balance: '0.00', topped_up_balance: '0.50' },
  ],
});
const fakeFetch = (status, body, headers = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});
const run = (fetchImpl, extra = {}) => refreshDeepSeekBalance({
  reason: 'manual', ledgerPath, dataDir: dir, now: step(), fetchImpl, ...extra,
});
const noteBalance = (accountId, extra = {}) => noteHarnessUsageLimit({
  harness: 'deepseek', message: 'Insufficient Balance', dataDir: dir, ...(accountId ? { accountId } : {}), ...extra,
});

try {
  // schema
  assert.equal(parseDeepSeekBalanceResponse({ is_available: 'yes', balance_infos: [] }).ok, false);
  assert.equal(parseDeepSeekBalanceResponse({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: 1 }] }).ok, false);
  assert.equal(parseDeepSeekBalanceResponse({ is_available: true, balance_infos: 'x' }).ok, false);
  const parsed = parseDeepSeekBalanceResponse(okBody());
  assert.equal(parsed.balances[0].totalBalance, '110.00');
  assert.equal(parsed.balances.length, 2);

  // success: per-currency snapshots, exact strings, is_available=false with positive balance
  let r = await run(fakeFetch(200, okBody(false), { 'x-request-id': 'req-1' }));
  assert.equal(r.ok, true);
  assert.equal(r.isAvailable, false);
  assert.equal(r.requestId, 'req-1');
  assert.equal(r.snapshots, 2);
  let status = readDeepSeekBalanceStatus({ accountId: r.accountId, ledgerPath, now: t });
  assert.equal(status.isAvailable, false);
  assert.equal(status.stale, false);
  assert.deepEqual(status.balances.map((b) => [b.currency, b.totalBalance, b.grantedBalance, b.toppedUpBalance]).sort(),
    [['CNY', '110.00', '10.00', '100.00'], ['USD', '0.50', '0.00', '0.50']]);
  const accountId = r.accountId;

  // failures keep the last reading and write no snapshot
  const before = loadLedger(ledgerPath).snapshots.length;
  for (const [code, kind] of [[401, 'auth'], [429, 'rate_limited'], [503, 'server']]) {
    r = await run(fakeFetch(code, {}, { 'x-request-id': 'rid' }));
    assert.equal(r.ok, false);
    assert.equal(r.kind, kind);
    assert.equal(r.requestId, 'rid');
  }
  r = await run(async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; });
  assert.equal(r.kind, 'timeout');
  r = await run(fakeFetch(200, { is_available: true }));
  assert.equal(r.kind, 'invalid_schema');
  assert.equal(loadLedger(ledgerPath).snapshots.length, before);
  assert.equal(readDeepSeekBalanceStatus({ accountId, ledgerPath, now: t }).balances.length, 2);
  assert.ok(!JSON.stringify(r).includes(KEY));

  // staleness threshold
  status = readDeepSeekBalanceStatus({ accountId, ledgerPath, now: t + DEEPSEEK_BALANCE_FRESHNESS_MS + 3_600_000 * 24 });
  assert.equal(status.stale, true);
  assert.equal(status.balances.length, 2);

  // throttle + backoff for automatic reasons
  resetDeepSeekBalanceAttemptState();
  r = await refreshDeepSeekBalance({ reason: 'topup', ledgerPath, dataDir: dir, now: t += 1000, fetchImpl: fakeFetch(500, {}) });
  assert.equal(r.kind, 'server');
  r = await refreshDeepSeekBalance({ reason: 'topup', ledgerPath, dataDir: dir, now: t += 120_000, fetchImpl: fakeFetch(200, okBody()) });
  assert.equal(r.kind, 'backoff');
  assert.equal(r.skipped, true);
  resetDeepSeekBalanceAttemptState();

  // limits: coexistence and selective unlock
  noteHarnessUsageLimit({ harness: 'deepseek', model: 'deepseek-chat', message: 'rate limit exceeded: too many requests', dataDir: dir, code: 'rate_limit_rejected', source: 'error-text' });
  noteHarnessUsageLimit({ harness: 'opencode', message: 'Insufficient Balance', dataDir: dir, accountId });
  noteBalance(accountId);
  const codes = () => listHarnessUsageLimits(dir).map((x) => `${x.harness}:${x.model || '*'}:${x.code}`).sort();
  assert.equal(codes().length, 3);
  // wrong account / missing id unlock nothing
  assert.equal(clearInsufficientBalanceLimit({ harness: 'deepseek', accountId: 'other', dataDir: dir }), 0);
  assert.equal(clearInsufficientBalanceLimit({ harness: 'deepseek', dataDir: dir }), 0);
  // is_available=false does not unlock
  r = await run(fakeFetch(200, okBody(false)));
  assert.equal(r.unlocked, 0);
  assert.ok(getHarnessUsageLimit({ harness: 'deepseek', model: 'deepseek-reasoner', dataDir: dir, usageOnly: true }));
  // fresh is_available=true unlocks only the matching balance lock
  r = await run(fakeFetch(200, okBody(true)));
  assert.equal(r.unlocked, 1);
  assert.deepEqual(codes(), ['deepseek:deepseek-chat:rate_limit_rejected', 'opencode:*:insufficient_balance']);

  // legacy row without account association is not auto-cleared
  noteBalance('');
  r = await run(fakeFetch(200, okBody(true)));
  assert.equal(r.unlocked, 0);
  assert.ok(codes().includes('deepseek:*:insufficient_balance'));
  // manual unlock API still works unchanged
  assert.ok(clearHarnessUsageLimit('deepseek', undefined, dir) >= 1);

  // key change: new fingerprint, lock tied to the old account is not unlocked by the new one
  noteBalance(accountId);
  process.env.DEEPSEEK_API_KEY = 'sk-other-key-abcdefghij';
  r = await run(fakeFetch(200, okBody(true)));
  if (r.ok) {
    assert.notEqual(r.accountId, accountId);
    assert.equal(r.unlocked, 0);
    assert.ok(codes().includes('deepseek:*:insufficient_balance'));
  } else {
    assert.equal(r.kind, 'identity_pending');
  }
  process.env.DEEPSEEK_API_KEY = KEY;

  // no retry on balance failure text
  const result = { events: [{ type: 'turn/end', payload: { reason: { kind: 'error', message: 'Insufficient Balance' } } }] };
  assert.equal(shouldRetryDeepSeekRunWithoutSession(result, 'sess-1'), false);
  console.log('deepseek-balance tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
  removeIsolatedDataDir();
}
