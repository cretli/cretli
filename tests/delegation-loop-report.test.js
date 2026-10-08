/**
 * Pure read-model for delegation loop leaves.
 */
import assert from 'node:assert/strict';
import { buildDelegationLoopReport, formatDelegationLoopSummaryLine } from '../lib/delegation-loop-report.js';

const parentChatId = 'parent-loop-a';
const leafPass = 'leaf-pass-fix';
const leafStop = 'leaf-many-rounds';
const now = Date.parse('2026-10-07T12:00:00.000Z');
const t0 = new Date(now - 60 * 60 * 1000).toISOString();
const t1 = new Date(now - 50 * 60 * 1000).toISOString();
const t2 = new Date(now - 40 * 60 * 1000).toISOString();
const t3 = new Date(now - 30 * 60 * 1000).toISOString();
const t4 = new Date(now - 20 * 60 * 1000).toISOString();

/** @param {object} partial */
function row(partial) {
  return {
    parentChatId,
    workspaceFolder: '/tmp/loop',
    status: 'completed',
    executionMode: 'agent',
    executor: { transport: 'opencode', model: 'glm-5' },
    ...partial,
  };
}

const passFixRows = [
  row({
    id: 'imp-1',
    leafId: leafPass,
    assignment: 'implement',
    pickRole: 'implement',
    createdAt: t0,
    startedAt: t0,
    finishedAt: t1,
    report: 'TASK: implement\nVERDICT: PASS',
  }),
  row({
    id: 'rev-fail',
    leafId: leafPass,
    assignment: 'review',
    pickRole: 'review',
    createdAt: t1,
    startedAt: t1,
    finishedAt: t2,
    report: 'TASK: review\nVERDICT: FAIL',
  }),
  row({
    id: 'fix-1',
    leafId: leafPass,
    assignment: 'implement',
    pickRole: 'fix',
    createdAt: t2,
    startedAt: t2,
    finishedAt: t3,
    report: 'TASK: implement\nVERDICT: PASS',
  }),
  row({
    id: 'rev-pass',
    leafId: leafPass,
    assignment: 'review',
    pickRole: 'review',
    createdAt: t3,
    startedAt: t3,
    finishedAt: t4,
    report: 'TASK: review\nVERDICT: PASS',
    verifyRequired: true,
    verifyResult: { status: 'passed', exitCode: 0 },
  }),
];

const stopRows = [];
for (let i = 0; i < 4; i += 1) {
  stopRows.push(row({
    id: `stop-imp-${i}`,
    leafId: leafStop,
    assignment: 'implement',
    pickRole: i === 0 ? 'implement' : 'fix',
    createdAt: new Date(now - (120 - i * 10) * 60 * 1000).toISOString(),
    startedAt: new Date(now - (120 - i * 10) * 60 * 1000).toISOString(),
    finishedAt: new Date(now - (115 - i * 10) * 60 * 1000).toISOString(),
    report: 'TASK: implement\nVERDICT: PASS',
  }));
  stopRows.push(row({
    id: `stop-rev-${i}`,
    leafId: leafStop,
    assignment: 'review',
    pickRole: 'review',
    createdAt: new Date(now - (114 - i * 10) * 60 * 1000).toISOString(),
    startedAt: new Date(now - (114 - i * 10) * 60 * 1000).toISOString(),
    finishedAt: new Date(now - (110 - i * 10) * 60 * 1000).toISOString(),
    report: 'TASK: review\nVERDICT: FAIL',
  }));
}

const allRows = [...passFixRows, ...stopRows];
const report = buildDelegationLoopReport({
  rows: allRows,
  now,
  workflows: [{
    parentChatId,
    leafId: leafStop,
    stopReason: 'same_findings',
    round: 4,
    maxRounds: 4,
    consecutiveSameFail: 2,
  }],
  readUsageEvents: () => [],
});

assert.equal(report.length, 2);
const passLeaf = report.find((entry) => entry.leafId === leafPass);
const stopLeaf = report.find((entry) => entry.leafId === leafStop);
assert.ok(passLeaf);
assert.ok(stopLeaf);
assert.equal(passLeaf.rounds, 2);
assert.equal(passLeaf.verdicts.join(','), 'PASS,FAIL,PASS,PASS');
assert.equal(passLeaf.roles.implement[0].model, 'glm-5');
assert.equal(passLeaf.verify.required, true);
assert.equal(passLeaf.verify.recorded, true);
assert.equal(passLeaf.verify.passed, true);
assert.ok(passLeaf.cost.wallTimeMs > 0);
assert.equal(passLeaf.cost.costKnown, false);
assert.equal(stopLeaf.rounds, 4);
assert.equal(stopLeaf.stopReason, 'same_findings');
assert.equal(stopLeaf.highRounds, true);
assert.equal(stopLeaf.stopped, true);

const leafNoReview = 'leaf-no-review';
const noReviewRows = [
  row({
    id: 'imp-only',
    leafId: leafNoReview,
    assignment: 'implement',
    pickRole: 'implement',
    createdAt: t0,
    startedAt: t0,
    finishedAt: t1,
    report: 'TASK: implement\nVERDICT: PASS',
  }),
];
const noReviewReport = buildDelegationLoopReport({
  rows: noReviewRows,
  now,
  readUsageEvents: () => [],
});
const noReviewLeaf = noReviewReport.find((entry) => entry.leafId === leafNoReview);
assert.ok(noReviewLeaf);
assert.equal(noReviewLeaf.verify.required, false);
assert.equal(noReviewLeaf.verify.recorded, false);
assert.equal(noReviewLeaf.verify.passed, false);

const filtered = buildDelegationLoopReport({ rows: allRows, leafId: leafPass, now, readUsageEvents: () => [] });
assert.equal(filtered.length, 1);
assert.equal(filtered[0].leafId, leafPass);

const line = formatDelegationLoopSummaryLine(passLeaf);
assert.match(line, /^loop leaf=/);
assert.match(line, /verify=passed/);

console.log('delegation-loop-report.test.js OK');
