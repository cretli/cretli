/**
 * Workflow normalization happens once per request in the per-cohort report,
 * and the public buildDelegationLoopReport contract is unchanged.
 */
import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import { buildDelegationLoopReport } from '../lib/delegation-loop-report.js';
import { buildDelegationLoopReportByCohort } from '../lib/routes/delegations-routes.js';

const now = Date.parse('2026-10-07T12:00:00.000Z');
const COHORTS = 20;
const WORKFLOWS = 200;

let reads = 0;
/** Raw workflow row whose parentChatId read is counted (normalize reads it once). */
function workflow(i) {
  const applied = {};
  for (let k = 0; k < 4; k += 1) applied[`k${k}`] = `fp${k}`;
  return {
    get parentChatId() { reads += 1; return `parent-${i % COHORTS}`; },
    leafId: `leaf-${i}`,
    role: 'review',
    round: 2,
    lastVerdict: 'FAIL',
    findingsHash: 'h',
    appliedPatches: applied,
    stopReason: i % 7 === 0 ? 'same_findings' : '',
  };
}
const workflows = Array.from({ length: WORKFLOWS }, (_, i) => workflow(i));
const rows = Array.from({ length: WORKFLOWS }, (_, i) => ({
  id: `d-${i}`,
  parentChatId: `parent-${i % COHORTS}`,
  leafId: `leaf-${i}`,
  assignment: 'implement',
  status: 'completed',
  createdAt: new Date(now - 60000).toISOString(),
  finishedAt: new Date(now - 30000).toISOString(),
  executor: { transport: 'sdk', model: 'm' },
}));
const readUsage = () => [];

reads = 0;
const leaves = buildDelegationLoopReportByCohort(rows, [], workflows, readUsage, '', now);
assert.equal(leaves.length, WORKFLOWS);
assert.equal(reads, WORKFLOWS, 'each workflow row normalized once per request');

// Same output as the per-cohort path without a prebuilt index.
const expected = [];
for (const r of rows) {
  expected.push(...buildDelegationLoopReport({ rows: [r], cycles: [], workflows, readUsageEvents: readUsage, now }));
}
const key = (l) => `${l.parentChatId}\0${l.leafId}`;
assert.deepEqual(
  leaves.slice().sort((a, b) => key(a).localeCompare(key(b))),
  expected.sort((a, b) => key(a).localeCompare(key(b))),
);
assert.ok(leaves.some((l) => l.stopReason === 'same_findings'));

// Public API: raw workflows plus parentChatId filter still work.
const filtered = buildDelegationLoopReport({
  rows, cycles: [], workflows, parentChatId: 'parent-3', readUsageEvents: readUsage, now,
});
assert.ok(filtered.length > 0);
assert.ok(filtered.every((l) => l.parentChatId === 'parent-3'));
console.log('delegation-loop-report-workflow-index ok');
