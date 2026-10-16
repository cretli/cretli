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
