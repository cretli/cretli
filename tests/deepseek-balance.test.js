import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(path.join(ISOLATED_DATA_DIR, 'ds-attempt-'));
const ledgerPath = path.join(dir, 'credit-ledger.json');
process.env.DEEPSEEK_API_KEY = 'sk-test-secret-1234567890';
const modUrl = pathToFileURL(path.resolve('harnesses/deepseek/deepseek-balance.js')).href;
const fail = async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) });
const good = async () => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.00', granted_balance: '0', topped_up_balance: '1.00' }] }),
});

test('last attempt survives a module reload', async () => {
  const a = await import(`${modUrl}?a=1`);
  assert.equal(a.readDeepSeekLastAttempt({ dataDir: dir }), null);
  const t0 = Date.parse('2026-03-20T12:00:00Z');
  const bad = await a.refreshDeepSeekBalance({ reason: 'manual', ledgerPath, dataDir: dir, now: t0, fetchImpl: fail });
  assert.equal(bad.ok, false);
  const seen = a.readDeepSeekLastAttempt({ accountId: bad.accountId, dataDir: dir });
  assert.deepEqual(seen, { at: '2026-03-20T12:00:00.000Z', ok: false, kind: bad.kind });

  // Fresh module instance = empty in-memory state, as after a process restart.
  const b = await import(`${modUrl}?b=2`);
  assert.deepEqual(b.readDeepSeekLastAttempt({ accountId: bad.accountId, dataDir: dir }), seen);
  const ok = await b.refreshDeepSeekBalance({ reason: 'manual', ledgerPath, dataDir: dir, now: t0 + 60_000, fetchImpl: good });
  assert.equal(ok.ok, true);
  const after = b.readDeepSeekLastAttempt({ accountId: bad.accountId, dataDir: dir });
  assert.equal(after.ok, true);
  assert.equal(after.kind, 'ok');
  const thr = await b.refreshDeepSeekBalance({ reason: 'manual', ledgerPath, dataDir: dir, now: t0 + 61_000, fetchImpl: good });
  assert.equal(thr.kind, 'throttled');
  assert.equal(b.readDeepSeekLastAttempt({ accountId: bad.accountId, dataDir: dir }).kind, 'throttled');
});
