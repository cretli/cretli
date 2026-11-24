import assert from 'node:assert/strict';
import test from 'node:test';
import {
  USAGE_LIFECYCLE_OUTCOMES,
  classifyAttemptLifecycleOutcome as cls,
  classifyCycleLifecycleOutcome,
  countLifecycleOutcomes,
  listAttemptLifecycleOutcomes,
} from '../lib/usage/usage-lifecycle-outcome.ts';
import { buildUsageCoverage } from '../lib/usage/usage-coverage.ts';
import { buildUsageTop } from '../lib/usage/usage-top.ts';

test('precedence: recovered > completed > cancelled > restart > requeued > abandoned', () => {
  assert.equal(cls({ status: 'completed', interruptCode: 'running_orphan' }), 'recovered');
  assert.equal(cls({ status: 'completed', startupRetry: { used: 1 } }), 'recovered');
  assert.equal(cls({ status: 'completed' }), 'completed');
  assert.equal(cls({ status: 'cancelled', interruptCode: 'interrupted_restart' }), 'cancelled');
  assert.equal(cls({ status: 'interrupted', interruptCode: 'interrupted_restart' }, { hasSuccessor: true }), 'restart');
  assert.equal(cls({ status: 'failed' }, { hasSuccessor: true }), 'requeued');
  assert.equal(cls({ status: 'failed' }), 'abandoned');
  assert.equal(cls({ status: 'interrupted', interruptCode: 'starting_timeout' }), 'abandoned');
  assert.equal(cls({ status: 'running' }), '');
});

test('cycle outcome comes from closeOutcome/closeSource', () => {
  assert.equal(classifyCycleLifecycleOutcome({ closeOutcome: 'interrupted_restart' }), 'restart');
  assert.equal(classifyCycleLifecycleOutcome({ closeOutcome: 'success', closeSource: 'abort' }), 'abandoned');
  assert.equal(classifyCycleLifecycleOutcome({ closeOutcome: 'success', closeSource: 'report' }), 'completed');
  assert.equal(classifyCycleLifecycleOutcome({ closeOutcome: 'failure' }), 'abandoned');
  assert.equal(classifyCycleLifecycleOutcome({}), '');
});

const row = {
  id: 'd1', workRole: 'implement', assignment: 'implement', executor: { transport: 'claude' },
  attempts: [{ attemptId: 'a1', status: 'failed', finishedAt: '2026-11-10T10:00:00Z' }],
  attemptId: 'a2', status: 'completed', finishedAt: '2026-11-10T11:00:00Z',
};

test('every attempt gets exactly one label; sum of byOutcome equals the attempts', () => {
  const rows = listAttemptLifecycleOutcomes([row]);
  assert.deepEqual(rows.map((r) => r.outcome), ['requeued', 'completed']);
  const cov = buildUsageCoverage({ now: Date.parse('2026-11-22T00:00:00Z'), delegations: [row], events: [] });
  const r = cov.rows.find((x) => x.harness === 'claude' && x.role === 'implement');
  assert.equal(r.attempts, 2);
  assert.equal(Object.values(r.byOutcome).reduce((a, b) => a + b, 0) + r.unclassified, r.attempts);
  assert.equal(r.byOutcome.requeued, 1);
  assert.deepEqual(Object.keys(r.byOutcome), [...USAGE_LIFECYCLE_OUTCOMES]);
  assert.equal(countLifecycleOutcomes(rows).completed, 1);
});

test('usage_top outcome axis labels events by attempt lifecycle outcome; run outcome is untouched', () => {
  const ev = (attemptId) => ({ eventType: 'delta', outcome: 'ok', delegationId: 'd1', attemptId, tokens: { textInput: 10, textOutput: 0, cachedInput: 0, cacheWrite: 0 } });
  const top = buildUsageTop({ events: [ev('a1'), ev('a2'), { eventType: 'delta', tokens: {} }], delegations: [row], groupBy: 'outcome' });
  assert.deepEqual(top.rows.map((r) => r.key).sort(), ['(unattributed)', 'completed', 'requeued']);
});
