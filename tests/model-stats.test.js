/**
 * Canonical model stats contract (`lib/model-stats.js`).
 *
 * The builder composes the existing job aggregate and the delegation cycle
 * summaries. These tests pin the guarantees the contract makes: job, reviewed
 * cycle, cost and latency denominators stay separate; an absent historical field
 * is `null`/`unknown` (never a measured zero); `task_type`/`effort` are not
 * inferred; `fix` shares the implement aggregate; and the builder is pure and
 * never changes the picker/ranking.
 */

import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_STATS_CONTRACT_VERSION,
  MODEL_STATS_COHORT_KEY_PARTS,
  MODEL_STATS_LOW_SAMPLE_N,
  MODEL_STATS_MAX_COHORTS,
  buildCanonicalModelStats,
  buildModelStatsCohortKey,
} from '../lib/model-stats.js';
import {
  MODEL_PICK_POLICY_VERSION,
  MODEL_PICK_REVIEW_PROTOCOL_VERSION,
} from '../lib/model-pick-policy.js';
import { summarizeDelegationOutcomes } from '../lib/model-pick-history.js';
import { buildModelDiagnostics } from '../lib/model-diagnostics.js';
import {
  DEFAULT_MODEL_ROLE_PROFILES,
  DEFAULT_ROLE_SCORE_WEIGHTS,
  selectModelPick,
} from '../lib/model-role-profiles.js';

const NOW = Date.parse('2026-10-06T00:00:00.000Z');
const PARENT = 'canonical-parent';

let seq = 0;

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function implementRow(overrides = {}) {
  seq += 1;
  const at = overrides.createdAt || `2026-10-05T10:${String(seq).padStart(2, '0')}:00.000Z`;
  return {
    id: overrides.id || `impl-${seq}`,
    parentChatId: PARENT,
    leafId: 'leaf-1',
    assignment: 'implement',
    executionMode: 'agent',
    status: 'completed',
    createdAt: at,
    startedAt: at,
    finishedAt: new Date(Date.parse(at) + 5 * 60 * 1000).toISOString(),
    executor: { transport: 'sdk', model: 'composer-2.5::effort=high' },
    metrics: { tokens_out_per_sec: 20, tool_calls_n: 4, files_changed: 2 },
    report: '',
    ...overrides,
  };
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function reviewRow(overrides = {}) {
  return implementRow({
    assignment: 'review',
    executionMode: 'agent',
    executor: { transport: 'sdk', model: 'composer-2.5' },
    metrics: undefined,
    report: 'VERDICT: PASS',
    ...overrides,
  });
}

/**
 * Six implement jobs: two accepted cycles, one rejected cycle, two unreviewed
 * closed cycles and one still-running cycle on a *different* model (so it has
 * an open cycle but no terminal job row).
 *
 * @returns {object[]}
 */
function fixtureRows() {
  seq = 0;
  return [
    implementRow({ id: 'impl-1', createdAt: '2026-10-05T09:00:00.000Z' }),
    reviewRow({ id: 'rev-1', report: 'VERDICT: PASS', createdAt: '2026-10-05T09:01:00.000Z' }),
    implementRow({ id: 'impl-2', createdAt: '2026-10-05T09:02:00.000Z' }),
    reviewRow({ id: 'rev-2', report: 'VERDICT: PASS', createdAt: '2026-10-05T09:03:00.000Z' }),
    implementRow({ id: 'impl-3', createdAt: '2026-10-05T09:04:00.000Z' }),
    reviewRow({ id: 'rev-3', report: 'VERDICT: FAIL', createdAt: '2026-10-05T09:05:00.000Z' }),
    implementRow({ id: 'impl-4', createdAt: '2026-10-05T09:06:00.000Z' }),
    implementRow({ id: 'impl-5', createdAt: '2026-10-05T09:07:00.000Z' }),
    implementRow({
      id: 'impl-6',
      createdAt: '2026-10-05T09:08:00.000Z',
      status: 'running',
      finishedAt: '',
      executor: { transport: 'sdk', model: 'lonely-model' },
    }),
  ];
}

const USAGE_EVENTS = [
  { eventType: 'delta', delegationId: 'impl-1', usd: 1, billingClass: 'priced' },
  { eventType: 'delta', delegationId: 'impl-2', usd: 2, billingClass: 'priced' },
  { eventType: 'delta', delegationId: 'impl-3', billingClass: 'subscription_quota' },
  { eventType: 'delta', delegationId: 'impl-4', billingClass: 'unknown' },
  { eventType: 'delta', delegationId: 'impl-5', usd: 0.25, billingClass: 'priced' },
  { eventType: 'delta', delegationId: 'impl-6', usd: 0.5, billingClass: 'priced' },
  { eventType: 'run', delegationId: 'impl-1', usd: 99 },
];

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function canonicalInput(overrides = {}) {
  const rows = overrides.delegations ?? fixtureRows();
  return {
    role: 'implement',
    now: NOW,
    outcomes: overrides.outcomes ?? summarizeDelegationOutcomes({ rows, now: NOW }),
    delegations: rows,
    usageEvents: overrides.usageEvents ?? USAGE_EVENTS,
    ...overrides,
  };
}

test('cohort key and version metadata are explicit and ordered', () => {
  const stats = buildCanonicalModelStats(canonicalInput());
  assert.equal(stats.contract_version, MODEL_STATS_CONTRACT_VERSION);
  assert.deepEqual(stats.cohort_key_parts, [...MODEL_STATS_COHORT_KEY_PARTS]);
  assert.deepEqual(stats.cohort_key_parts, [
    'role', 'harness', 'base_model', 'policy_version', 'review_protocol_version',
  ]);
  assert.equal(stats.versions.policy_version, MODEL_PICK_POLICY_VERSION);
  // Top-level declares the *current* protocol; history never recorded it.
  assert.equal(stats.versions.review_protocol_version, MODEL_PICK_REVIEW_PROTOCOL_VERSION);
  assert.equal(stats.display_only, true);
  assert.equal(stats.affects_ranking, false);

  const cohort = stats.cohorts.find((row) => row.base_model === 'composer-2.5');
  assert.ok(cohort, 'implement cohort exists');
  assert.equal(cohort.versions.review_protocol_version, null, 'history has no recorded protocol');
  assert.ok(cohort.missing_fields.includes('review_protocol_version'));
  assert.equal(cohort.cohort_key, buildModelStatsCohortKey({
    role: 'implement',
    harness: 'sdk',
    baseModel: 'composer-2.5',
    policyVersion: MODEL_PICK_POLICY_VERSION,
    reviewProtocolVersion: null,
  }));
  assert.equal(
    cohort.cohort_key,
    `implement|sdk|composer-2.5|${MODEL_PICK_POLICY_VERSION}|unknown`,
  );
});

test('job, reviewed-cycle, cost and latency denominators are separate', () => {
  const stats = buildCanonicalModelStats(canonicalInput());
  const cohort = stats.cohorts.find((row) => row.base_model === 'composer-2.5');

  // (a) JOBS: 5 terminal implement jobs (the running one is excluded).
  assert.equal(cohort.jobs.terminal_jobs, 5);
  assert.equal(cohort.jobs.infra_fails, 0);
  assert.equal(cohort.jobs.non_infra_jobs, 5);
  assert.equal(cohort.jobs.decided, 3, 'accepted + rejected cycles');

  // (b) CYCLES: a different denominator from jobs.
  assert.equal(cohort.cycles.closed_cycles, 5);
  assert.equal(cohort.cycles.reviewed_cycles, 3);
  assert.equal(cohort.cycles.accepted_by_review, 2);
  assert.equal(cohort.cycles.rejected_by_review, 1);
  assert.equal(cohort.cycles.unreviewed, 2);
  // The only open cycle belongs to the running model, not to this cohort.
  assert.equal(cohort.cycles.open_cycles, 0);
  assert.equal(cohort.cycles.accepted_rate, 0.6667);

  // (c) COST: its own priced/total/unknown/subscription denominator.
  assert.equal(cohort.cost.known, true);
  assert.equal(cohort.cost.usd, 3.25);
  assert.equal(cohort.cost.priced_events, 3);
  assert.equal(cohort.cost.total_events, 5);
  assert.equal(cohort.cost.unknown_events, 1);
  assert.equal(cohort.cost.subscription_events, 1);
  assert.equal(cohort.cost.effective_cost_per_accepted_usd, 3.25 / 2);

  // (d) LATENCY: its own sample counts, independent of jobs/cycles/cost.
  assert.equal(cohort.latency.duration.sample_n, 5);
  assert.equal(cohort.latency.tokens_per_sec.sample_n, 5);
  assert.equal(cohort.latency.tool_calls.sample_n, 5);
  assert.equal(cohort.latency.files_changed.sample_n, 5);
  assert.equal(cohort.latency.duration.median_min, 5);

  // The four blocks measure different things: each count pair differs.
  assert.notEqual(cohort.jobs.terminal_jobs, cohort.cycles.accepted_by_review);
  assert.notEqual(cohort.cycles.accepted_by_review, cohort.cost.priced_events);
  assert.notEqual(cohort.cost.priced_events, cohort.latency.duration.sample_n);
});

test('an open cycle with no terminal job keeps an unknown jobs block, not zero', () => {
  const stats = buildCanonicalModelStats(canonicalInput());
  const lonely = stats.cohorts.find((row) => row.base_model === 'lonely-model');
  assert.ok(lonely, 'the running model has its own cohort');
  assert.equal(lonely.jobs, null, 'no terminal job row is explicit null');
  assert.equal(lonely.cycles.open_cycles, 1);
  assert.ok(lonely.missing_fields.includes('jobs'));
  // The global totals still count the cycle.
  assert.equal(stats.totals.cycles.open_cycles, 1);
});

test('missing cost and latency stay null/unknown, never a measured zero', () => {
  const rows = [
    implementRow({ id: 'impl-nocost', createdAt: '2026-10-05T08:00:00.000Z', metrics: {} }),
  ];
  const stats = buildCanonicalModelStats({
    role: 'implement',
    now: NOW,
    outcomes: summarizeDelegationOutcomes({ rows, now: NOW }),
    delegations: rows,
    usageEvents: [{ eventType: 'delta', delegationId: 'impl-nocost', billingClass: 'subscription_quota' }],
  });
  const cohort = stats.cohorts[0];
  assert.equal(cohort.cost.known, false);
  assert.equal(cohort.cost.usd, null);
  assert.equal(cohort.cost.effective_cost_per_accepted_usd, null);
  assert.ok(cohort.missing_fields.includes('cost.usd'));
  assert.equal(cohort.latency.tokens_per_sec.sample_n, 0);
  assert.equal(cohort.latency.tokens_per_sec.median, null);
  assert.equal(cohort.latency.tool_calls.median, null);
  assert.equal(stats.totals.cost.known, false);
  assert.equal(stats.totals.cost.usd, null);
});

test('task_type and effort are not inferred as cohorts', () => {
  const stats = buildCanonicalModelStats(canonicalInput());
  assert.deepEqual(stats.unknowns.not_measured, ['task_type', 'effort']);
  assert.equal(stats.unknowns.task_type.known, false);
  assert.equal(stats.unknowns.effort.known, false);
  for (const cohort of stats.cohorts) {
    assert.equal('task_type' in cohort, false);
    assert.equal('effort' in cohort, false);
  }
  // The base model strips the effort params: it is not a cohort dimension.
  assert.ok(stats.cohorts.some((row) => row.base_model === 'composer-2.5'));
  assert.equal(stats.cohorts.some((row) => row.base_model.includes('effort')), false);
});

test('fix shares the persisted implement aggregate and is flagged', () => {
  const implement = buildCanonicalModelStats(canonicalInput({ role: 'implement' }));
  const fix = buildCanonicalModelStats(canonicalInput({ role: 'fix' }));
  assert.equal(fix.aggregate_role, 'implement');
  assert.equal(fix.by_role.fix.shares_implement_aggregate, true);
  assert.deepEqual(fix.by_role.fix.jobs, implement.by_role.implement.jobs);
  const fixCohort = fix.cohorts.find((row) => row.base_model === 'composer-2.5');
  const implCohort = implement.cohorts.find((row) => row.base_model === 'composer-2.5');
  assert.equal(fixCohort.role, 'fix');
  assert.equal(fixCohort.shares_implement_aggregate, true);
  assert.deepEqual(fixCohort.jobs, implCohort.jobs);
  assert.notEqual(fixCohort.cohort_key, implCohort.cohort_key);
});

test('uncertainty is display-only and exposes n, prior and the shrink weight', () => {
  const stats = buildCanonicalModelStats(canonicalInput());
  assert.equal(stats.uncertainty.display_only, true);
  assert.equal(stats.uncertainty.affects_ranking, false);
  assert.equal(stats.uncertainty.low_sample_n, MODEL_STATS_LOW_SAMPLE_N);
  assert.equal(stats.uncertainty.shrink.half_life, 10);
  const cohort = stats.cohorts.find((row) => row.base_model === 'composer-2.5');
  assert.equal(cohort.uncertainty.n, 5);
  assert.equal(cohort.uncertainty.low_sample, false);
  assert.equal(cohort.uncertainty.shrink.weight, 0.3333);
});

test('the cohort list is bounded and reports truncation', () => {
  const roles = { plan: {}, implement: {}, review: {} };
  for (let i = 0; i < MODEL_STATS_MAX_COHORTS + 5; i += 1) {
    roles.implement[`sdk/model-${i}`] = {
      harness: 'sdk',
      model: `model-${i}`,
      role: 'implement',
      n: 1,
      infra_fails: 0,
      infra_fail_rate: 0,
      decided: 0,
      pass_rate: null,
      quality: null,
    };
  }
  const stats = buildCanonicalModelStats({
    role: 'implement',
    now: NOW,
    outcomes: { roles },
  });
  assert.equal(stats.cohorts.length, MODEL_STATS_MAX_COHORTS);
  assert.equal(stats.cohorts_total, MODEL_STATS_MAX_COHORTS + 5);
  assert.equal(stats.cohorts_truncated, true);
});

test('buildCanonicalModelStats is pure and does not mutate its inputs', () => {
  const input = canonicalInput();
  const snapshot = JSON.stringify(input);
  const first = buildCanonicalModelStats(input);
  assert.equal(JSON.stringify(input), snapshot, 'inputs must not be mutated');
  const second = buildCanonicalModelStats(input);
  assert.deepEqual(first, second, 'same inputs must give a byte-identical report');
});

test('the canonical block does not change the picker or candidate order', () => {
  const history = {
    roleUsage7d: { harness: {}, model: {}, lastAt: {} },
    chatUsage: { harnesses: {}, models: {} },
    coldStartHarnesses14d: [],
    lockouts: [],
    planLimits: [],
    freshLimitHits: {},
    excludeModels: [],
    hardExcludeModels: [],
    softExcludeModels: [],
    pickIndex: 0,
    prior: { infra_fail_rate: 0 },
    observed: {},
    reviewTestObservations: {},
  };
  const harnesses = [{ id: 'sdk', label: 'SDK', enabled: true, ready: true, available: true, can_delegate: true }];
  const composer = { id: 'composer-2.5', label: 'Composer', enabled: true, available: true, roles: ['implement', 'fix'] };
  const models = { sdk: { favorites_configured: true, items: [composer] } };
  const base = {
    role: 'implement',
    now: NOW,
    harnesses,
    modelsByHarness: models,
    allModelsByHarness: models,
    history,
    profiles: DEFAULT_MODEL_ROLE_PROFILES,
    weights: DEFAULT_ROLE_SCORE_WEIGHTS,
    rotation: { band: 0.05, mode: 'balanced' },
    adaptive: true,
    outcomes: summarizeDelegationOutcomes({ rows: fixtureRows(), now: NOW }),
    config: null,
  };
  const direct = selectModelPick({
    role: base.role,
    now: base.now,
    harnesses,
    modelsByHarness: models,
    history,
    profiles: base.profiles,
    weights: base.weights,
    rotation: base.rotation,
    adaptive: base.adaptive,
  });
  const withoutCanonical = buildModelDiagnostics(base);
  const withCanonical = buildModelDiagnostics({
    ...base,
    delegationRows: fixtureRows(),
    usageEvents: USAGE_EVENTS,
  });
  assert.deepEqual(withCanonical.selection, withoutCanonical.selection);
  assert.deepEqual(
    withCanonical.selection.candidates.map((row) => `${row.harness}/${row.model}`),
    direct.candidates.map((row) => `${row.harness}/${row.model}`),
  );
  assert.equal(withCanonical.stats.canonical.contract_version, MODEL_STATS_CONTRACT_VERSION);
  assert.equal(withCanonical.stats.canonical.cohorts.length > 0, true);
});
