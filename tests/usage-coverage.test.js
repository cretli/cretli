import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUsageCoverage, USAGE_COVERAGE_MIN_SAMPLE } from '../lib/usage/usage-coverage.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const OLD = '2026-11-10T10:00:00Z';
const RECENT = '2026-11-22T10:00:00Z';

const attempt = (attemptId, finishedAt = OLD, extra = {}) => ({ attemptId, status: 'completed', finishedAt, transport: 'claude', ...extra });
const deleg = (id, workRole, attempts, extra = {}) => ({ id, workRole, assignment: workRole === 'review_code' ? 'review' : 'implement', attempts, executor: { transport: 'claude' }, ...extra });
const run = (delegationId, attemptId, completeness, extra = {}) => ({ eventType: 'run', delegationId, attemptId, runId: `${delegationId}-${attemptId}-${extra.n || 0}`, completeness, ...extra });
const cell = (cov, harness, role) => cov.rows.find((r) => r.harness === harness && r.role === role);

test('every supported pair has a row, including no_traffic ones', () => {
  const cov = buildUsageCoverage({ now: NOW });
  for (const harness of ['sdk', 'opencode', 'qwen', 'claude']) {
    for (const role of ['plan', 'implement', 'review', 'fix', 'orchestrator']) {
      assert.equal(cell(cov, harness, role).quality, 'no_traffic');
    }
  }
});

test('two attempts of one delegation are two attempts', () => {
  const cov = buildUsageCoverage({
    now: NOW,
    delegations: [deleg('d1', 'implement', [attempt('a1')], { attemptId: 'a2', status: 'completed', finishedAt: OLD })],
    events: [run('d1', 'a1', 'complete'), run('d1', 'a2', 'missing')],
  });
  const row = cell(cov, 'claude', 'implement');
  assert.equal([row.attempts, row.eligible, row.measured].join(), '2,2,1');
  assert.equal(row.coverage, 0.5);
});

test('an attempt with two runs is measured only when every run is measured', () => {
  const cov = buildUsageCoverage({
    now: NOW,
    delegations: [deleg('d1', 'fix', [attempt('a1')])],
    events: [run('d1', 'a1', 'complete', { n: 1 }), run('d1', 'a1', 'missing', { n: 2, usageMissingReason: 'cancel_before_usage' })],
  });
  const row = cell(cov, 'claude', 'fix');
  assert.equal(row.withRunEvent, 1);
  assert.equal(row.measured, 0);
  assert.deepEqual(row.missingReasons, { cancel_before_usage: 1 });
});

test('partial counts as measured; replayed logical event counts once', () => {
  const dup = run('d1', 'a1', 'partial', { runId: 'r1' });
  const cov = buildUsageCoverage({
    now: NOW,
    delegations: [deleg('d1', 'plan', [attempt('a1')])],
    events: [dup, { ...dup }, { ...dup, completeness: 'missing' }],
  });
  const row = cell(cov, 'claude', 'plan');
  assert.equal(row.eligible, 1);
  assert.equal(row.measured, 1);
});

test('noOutput attempts are excluded from the denominator', () => {
  const cov = buildUsageCoverage({ now: NOW, delegations: [deleg('d1', 'implement', [attempt('a1')])], events: [] });
  const row = cell(cov, 'claude', 'implement');
  assert.equal([row.attempts, row.noOutput, row.eligible, row.coverage].join(), '1,1,0,');
});

test('output without a run event is eligible and unmeasured', () => {
  const cov = buildUsageCoverage({
    now: NOW,
    delegations: [deleg('d1', 'implement', [attempt('a1')])],
    events: [{ eventType: 'delta', delegationId: 'd1', attemptId: 'a1' }],
  });
  const row = cell(cov, 'claude', 'implement');
  assert.deepEqual(row.missingReasons, { no_run_event: 1 });
  assert.equal(row.eligible, 1);
});

test('late correction inside 24h is visible (read-model reads the corrected run); pending excluded', () => {
  const delegations = [deleg('d1', 'review_code', [attempt('a1', RECENT)])];
  const missing = buildUsageCoverage({ now: NOW, delegations, events: [run('d1', 'a1', 'missing')] });
  assert.equal(cell(missing, 'claude', 'review').pending, 1);
  assert.equal(cell(missing, 'claude', 'review').eligible, 0);
  const corrected = buildUsageCoverage({ now: NOW, delegations, events: [run('d1', 'a1', 'partial')] });
  assert.equal(cell(corrected, 'claude', 'review').measured, 1);
});

test('after the grace window a missing run stays unmeasured (stale, not corrected by the read model)', () => {
  const events = [run('d1', 'a1', 'missing')];
  const cov = buildUsageCoverage({ now: NOW, delegations: [deleg('d1', 'implement', [attempt('a1', OLD)])], events });
  const row = cell(cov, 'claude', 'implement');
  assert.equal(row.pending, 0);
  assert.equal(row.eligible, 1);
  assert.equal(row.measured, 0);
  // The read model never mutates or adds runs.
  assert.equal(events.length, 1);
  assert.equal(events[0].completeness, 'missing');
});

test('quality flags: ok needs target and sample; low_coverage; insufficient_sample', () => {
  const n = USAGE_COVERAGE_MIN_SAMPLE;
  const make = (measuredCount) => {
    const delegations = [];
    const events = [];
    for (let i = 0; i < n; i += 1) {
      delegations.push(deleg(`d${i}`, 'implement', [attempt('a1')]));
      events.push(run(`d${i}`, 'a1', i < measuredCount ? 'complete' : 'missing'));
    }
    return cell(buildUsageCoverage({ now: NOW, delegations, events }), 'claude', 'implement');
  };
  assert.equal(make(n).quality, 'ok');
  assert.equal(make(Math.ceil(n * 0.8)).quality, 'ok');
  assert.equal(make(n - 5).quality, 'low_coverage');
  const small = buildUsageCoverage({ now: NOW, delegations: [deleg('d', 'implement', [attempt('a1')])], events: [run('d', 'a1', 'complete')] });
  assert.equal(cell(small, 'claude', 'implement').quality, 'insufficient_sample');
});

test('unsupported harness gets a row without a denominator', () => {
  const cov = buildUsageCoverage({ now: NOW, delegations: [deleg('d1', 'implement', [attempt('a1', OLD, { transport: 'nosuchharness' })])], events: [] });
  const row = cell(cov, 'nosuchharness', 'implement');
  assert.equal(row.quality, 'unsupported');
  assert.equal(row.eligible, 0);
});

test('orchestrator coverage comes from watcher cycles', () => {
  const cov = buildUsageCoverage({
    now: NOW,
    cycles: [{ cycleId: 'c1', harness: 'claude', finishedAt: OLD }, { cycleId: 'c2', harness: 'claude', finishedAt: OLD }],
    events: [{ eventType: 'run', cycleId: 'c1', runId: 'r1', completeness: 'complete' }],
  });
  const row = cell(cov, 'claude', 'orchestrator');
  assert.equal([row.attempts, row.noOutput, row.eligible, row.measured].join(), '2,1,1,1');
});

test('attempts outside the window are ignored', () => {
  const cov = buildUsageCoverage({
    now: NOW,
    fromMs: Date.parse('2026-11-15T00:00:00Z'),
    delegations: [deleg('d1', 'implement', [attempt('a1', OLD)])],
    events: [run('d1', 'a1', 'complete')],
  });
  assert.equal(cell(cov, 'claude', 'implement').attempts, 0);
});

// ---- Window loader: cycle metrics shape and ledger-index overlay ----
import './helpers/isolated-data-dir.js';
import { coverageOf } from '../lib/usage/usage-top-read.ts';
import { normalizeWorkspaceWatcherCycleMetric } from '../lib/persist/workspace-watcher-cycle-metrics-persist.js';
import { deriveRunKey } from '../lib/persist/usage-persist.js';

const win = { fromMs: Date.parse('2026-11-01T00:00:00Z'), toMs: NOW };

test('loader maps real cycle metric records (closedAt, flat harness) into orchestrator rows with outcome labels', () => {
  const metric = normalizeWorkspaceWatcherCycleMetric({
    cycleId: 'c1', harness: 'claude', mode: 'autopilot', startedAt: OLD, closedAt: OLD, closeSource: 'report', closeOutcome: 'interrupted_restart',
  });
  assert.ok(metric?.closedAt, 'fixture must be a normalized metric record');
  const cov = coverageOf({ events: [], delegations: [], window: win }, { now: NOW, loadCycleMetrics: () => [metric], loadRunStates: () => [] });
  const row = cell(cov, 'claude', 'orchestrator');
  assert.equal(row.attempts, 1);
  assert.equal(row.byOutcome.restart, 1);
});

test('late coverage correction is read from the ledger index, not the journal event', () => {
  const delegations = [deleg('d1', 'implement', [attempt('a1')])];
  const event = run('d1', 'a1', 'missing', { harness: 'claude', sourceSessionId: 's1' });
  const states = [{ runKey: deriveRunKey(event), completeness: 'partial', measurementPresent: true }];
  const without = coverageOf({ events: [event], delegations, window: win }, { now: NOW, loadCycleMetrics: () => [], loadRunStates: () => [] });
  assert.equal(cell(without, 'claude', 'implement').measured, 0);
  const overlaid = coverageOf({ events: [event], delegations, window: win }, { now: NOW, loadCycleMetrics: () => [], loadRunStates: () => states });
  assert.equal(cell(overlaid, 'claude', 'implement').measured, 1);
  assert.equal(event.completeness, 'missing', 'the journal event is not mutated');
});
