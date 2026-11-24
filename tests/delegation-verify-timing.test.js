/**
 * Host review-verify timing: per-execution ledger (replay != rerun), bound of 10,
 * persistence through normalizeVerifyResult and read-side aggregation.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChatAsync } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById, normalizeVerifyRuns } from '../lib/persist/delegations-persist.js';
import { recordDelegationVerifyResult } from '../lib/delegation-service.js';
import { buildHostVerifyUsage, buildUsageCoverage } from '../lib/usage/usage-coverage.ts';

const repo = createTempRepo();
test.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
fs.mkdirSync(path.join(repo.dir, 'tests'), { recursive: true });
fs.writeFileSync(path.join(repo.dir, 'tests/delegation-contract.test.js'), 'v1');

async function makeRow() {
  const parent = await addChatAsync(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
  return createDelegationRecord({
    parentChatId: parent.id, workspaceFolder: repo.dir, executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement', workRole: 'implement', status: 'completed', leafId: crypto.randomUUID(), finishedAt: new Date().toISOString(),
  });
}
const timing = (startedAt, durationMs = 1000) => ({ startedAt, finishedAt: startedAt, durationMs, concurrency: 2, sumStepMs: 1800, cached: 1 });
const rec = (row, startedAt, extra = {}) => recordDelegationVerifyResult({
  delegationId: row.id, attemptId: row.attemptId,
  result: { ok: true, output: 'ok', results: [{ id: 'delegation-contract', ok: true, durationMs: 1, outputTail: '' }], timing: timing(startedAt) },
  source: 'auto_after_implement', queueWaitMs: 250, ...extra,
});

test('timing and queue wait survive normalizeVerifyResult and are ledgered once per execution', async () => {
  const row = await makeRow();
  const saved = await rec(row, '2026-11-22T10:00:00.000Z');
  assert.equal(saved.verifyResult.timing.durationMs, 1000);
  assert.equal(saved.verifyResult.queueWaitMs, 250);
  assert.equal(saved.verifyRuns.length, 1);
  // Replay (restart re-delivering the same execution): equivalent result, no new entry.
  await rec(row, '2026-11-22T10:00:00.000Z');
  assert.equal(getDelegationById(row.id).verifyRuns.length, 1);
});

test('a rerun with an equivalent result is a new execution and a new entry', async () => {
  const row = await makeRow();
  await rec(row, '2026-11-22T10:00:00.000Z');
  await rec(row, '2026-11-22T10:05:00.000Z');
  const runs = getDelegationById(row.id).verifyRuns;
  assert.equal(runs.length, 2);
  assert.notEqual(runs[0].executionId, runs[1].executionId);
});

test('verifyRuns is bounded to the 10 newest', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ executionId: `e${i}`, outcome: 'passed', timing: timing('2026-11-22T10:00:00Z') }));
  const out = normalizeVerifyRuns(many);
  assert.equal(out.length, 10);
  assert.equal(out[0].executionId, 'e4');
  assert.equal(out[9].executionId, 'e13');
  assert.equal(normalizeVerifyRuns([...many, many[13]]).length, 10, 'duplicate id is not added');
});

test('hostVerify aggregates runs in the window per harness x role x source, without tokens', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const base = { id: 'd', workRole: 'implement', assignment: 'implement', executor: { transport: 'claude' } };
  const run = (id, outcome, extra = {}) => ({ executionId: id, outcome, recordedAt: '2026-11-22T10:00:00Z', source: 'auto_after_implement', timing: timing('2026-11-22T10:00:00Z', 2000), queueWaitMs: 100, ...extra });
  const delegations = [{ ...base, verifyRuns: [run('e1', 'passed'), run('e1', 'passed'), run('e2', 'failed'), run('e3', 'passed', { stale: true }), run('old', 'passed', { recordedAt: '2026-10-01T00:00:00Z' })] }];
  const hv = buildHostVerifyUsage(delegations, now - 86_400_000, now);
  assert.equal(hv.tokens, null);
  assert.equal(hv.usd, null);
  assert.equal(hv.note, 'host_time_only');
  const r = hv.rows[0];
  assert.deepEqual([r.runs, r.passed, r.failed, r.stale, r.wallMs, r.stepMs, r.cachedSteps, r.queueWaitMs], [3, 1, 1, 1, 6000, 5400, 3, 300]);
  assert.equal(buildUsageCoverage({ now, delegations }).hostVerify.rows.length, 1);
});
