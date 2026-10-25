import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildReviewLoopStats, countReviewFindings } from '../lib/review-loop-stats.js';

const WS = '/tmp/stats-ws';
const NOW = Date.parse('2026-10-15T12:00:00Z');
let seq = 0;
const row = (leafId, extra) => ({
  id: crypto.randomUUID(),
  assignment: 'review',
  reviewSubject: 'code',
  status: 'completed',
  workspaceFolder: WS,
  parentChatId: 'p1',
  leafId,
  executor: { transport: 'opencode', model: 'm1' },
  finishedAt: new Date(NOW - 1000 * (100 - seq++)).toISOString(),
  ...extra,
});
const report = (verdict, body = '') => `${body}\nVERDICT: ${verdict}`;
const stats = (delegations, workflows = []) => buildReviewLoopStats({ delegations, workflows, now: NOW });
const window30 = (s) => s.workspaces[0].windows['30d'];

// First-pass PASS leaf = 1 round.
{
  const leaf = crypto.randomUUID();
  const w = window30(stats([row(leaf, { report: report('PASS'), reportVerdict: 'PASS' })]));
  assert.equal(w.codeReview.leavesPassed, 1);
  assert.equal(w.codeReview.roundsToPass.max, 1);
  assert.equal(w.codeReview.firstPassRate, 1);
}

// FAIL then PASS = 2 rounds; findings counted.
{
  const leaf = crypto.randomUUID();
  const w = window30(stats([
    row(leaf, { report: report('FAIL', 'F1 (P1) broken\nF2 (P2) nit'), reportVerdict: 'FAIL' }),
    row(leaf, { report: report('PASS'), reportVerdict: 'PASS' }),
  ]));
  assert.equal(w.codeReview.roundsToPass.max, 2);
  assert.equal(w.codeReview.firstPassRate, 0);
  assert.equal(w.findings.total, 2);
  assert.equal(w.findings.P1, 1);
}

// Historical pool rounds stay grouped after the parent PASS cleared the live
// record: round 1 [PASS, FAIL] then round 2 [PASS, PASS] = 2 rounds, no first pass.
{
  const leaf = crypto.randomUUID();
  const a = row(leaf, { report: report('PASS'), reportVerdict: 'PASS' });
  const b = row(leaf, { report: report('FAIL'), reportVerdict: 'FAIL' });
  const c = row(leaf, { report: report('PASS'), reportVerdict: 'PASS' });
  const d = row(leaf, { report: report('PASS'), reportVerdict: 'PASS' });
  const workflow = {
    parentChatId: 'p1',
    leafId: leaf,
    workspaceFolder: WS,
    codeReviewPoolRound: null,
    codeReviewPoolHistory: [
      { key: '0::0', epoch: 1, mode: 'audit', pool: true, started: [a.id, b.id], resolved: 'FAIL' },
      { key: '0::0', epoch: 2, mode: 'closure', pool: true, started: [c.id, d.id], resolved: 'PASS' },
    ],
  };
  const w = window30(stats([a, b, c, d], [workflow]));
  assert.equal(w.codeReview.leavesPassed, 1);
  assert.equal(w.codeReview.roundsToPass.max, 2);
  assert.equal(w.codeReview.firstPassRate, 0);
}

// Plan review over 3 revisions = 3 rounds.
{
  const leaf = crypto.randomUUID();
  const plan = (rev, verdict) => row(leaf, {
    reviewSubject: 'plan', todoPlanRevisionKey: rev, report: report(verdict), reportVerdict: verdict,
  });
  const w = window30(stats([plan('r1', 'FAIL'), plan('r2', 'FAIL'), plan('r3', 'PASS')]));
  assert.equal(w.planReview.todosPassed, 1);
  assert.equal(w.planReview.roundsToPass.max, 3);
}

// Empty store: zeros/nulls, no throw.
{
  const s = stats([]);
  assert.deepEqual(s.workspaces, []);
  const s2 = buildReviewLoopStats({ delegations: undefined, workflows: undefined });
  assert.deepEqual(s2.workspaces, []);
  assert.equal(countReviewFindings('').total, 0);
}

// Pure aggregation never writes to a fixture dir.
{
  const dir = path.join(ISOLATED_DATA_DIR, 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'delegations.json');
  const leaf = crypto.randomUUID();
  fs.writeFileSync(file, JSON.stringify([row(leaf, { report: report('PASS'), reportVerdict: 'PASS' })]));
  fs.chmodSync(file, 0o444);
  fs.chmodSync(dir, 0o555);
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  const w = window30(stats(JSON.parse(before)));
  assert.equal(w.codeReview.leavesPassed, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(dir), ['delegations.json']);
  fs.chmodSync(dir, 0o755);
}

console.log('review-loop-stats tests passed');

// Perf: 1500 leaves x 4 reviews must not scan all rows per leaf, and the
// pre-indexed resolution must equal the full scan.
{
  const { indexDelegationsByLeaf, resolveReviewRounds } = await import('../lib/review-round-resolution.js');
  const big = [];
  for (let i = 0; i < 1500; i += 1) {
    const leaf = crypto.randomUUID();
    for (let j = 0; j < 4; j += 1) {
      const v = j === 3 ? 'PASS' : 'FAIL';
      big.push(row(leaf, { report: report(v, v === 'FAIL' ? 'F1 (P2) nit' : ''), reportVerdict: v }));
    }
  }
  const sample = big[0].leafId;
  const idx = indexDelegationsByLeaf(big);
  assert.deepEqual(
    resolveReviewRounds({ delegations: big, leafDelegations: idx.get(sample), leafId: sample }),
    resolveReviewRounds({ delegations: big, leafId: sample }),
  );
  const started = performance.now();
  const s = stats(big);
  const elapsed = performance.now() - started;
  assert.equal(window30(s).codeReview.leavesPassed, 1500);
  assert.ok(elapsed < 1000, `buildReviewLoopStats took ${elapsed.toFixed(0)} ms`);
  console.log(`review-loop-stats perf: ${elapsed.toFixed(0)} ms for ${big.length} rows`);
}
