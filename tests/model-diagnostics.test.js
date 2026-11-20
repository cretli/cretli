/**
 * Read-only Settings → Harness model diagnostics.
 *
 * The core guarantee under test is reproduction: for identical inputs the
 * report's chosen model and candidate order are the ones `selectModelPick`
 * produced, and the builder neither writes nor mutates what it was given.
 * Missing telemetry (no jobs, no priced usage, no availability history) must be
 * explicit `unknown`, never a guessed zero; an invalid operator config must be
 * visible instead of silently falling back to defaults.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildModelDiagnostics,
  DIAGNOSTICS_LOW_SAMPLE_N,
} from '../lib/model-diagnostics.js';
import { inspectModelRoleProfilesConfig } from '../lib/model-config-inspect.js';
import {
  DEFAULT_MODEL_ROLE_PROFILES,
  DEFAULT_ROLE_SCORE_WEIGHTS,
  describeModelRoleMatchers,
  selectModelPick,
} from '../lib/model-role-profiles.js';

const NOW = 1_700_000_000_000;

const readySdk = { id: 'sdk', label: 'Cursor SDK', enabled: true, ready: true, available: true, can_delegate: true };

const composer = {
  id: 'composer-2.5',
  label: 'Composer 2.5',
  enabled: true,
  available: true,
  roles: ['implement', 'fix'],
  cost_tier: 2,
  quality_tier: 4,
  speed_tier: 4,
};
const grok = {
  id: 'grok-4.6::effort=high',
  label: 'Grok',
  enabled: true,
  available: true,
  roles: ['plan', 'review', 'fix'],
  cost_tier: 4,
  quality_tier: 5,
  speed_tier: 3,
};

/**
 * One frozen picker snapshot reused by every reproduction test.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function diagnosticsInput(overrides = {}) {
  const harnesses = overrides.harnesses ?? [readySdk];
  const modelsByHarness = overrides.modelsByHarness ?? {
    sdk: { favorites_configured: true, items: [composer, grok] },
  };
  const base = {
    role: 'implement',
    now: NOW,
    harnesses,
    modelsByHarness,
    allModelsByHarness: overrides.allModelsByHarness ?? modelsByHarness,
    history: {
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
    },
    profiles: DEFAULT_MODEL_ROLE_PROFILES,
    weights: DEFAULT_ROLE_SCORE_WEIGHTS,
    rotation: { band: 0.05, mode: 'balanced' },
    adaptive: true,
    outcomes: { window_ms: 2_592_000_000, generated_at: '2026-01-01T00:00:00.000Z', min_jobs: 1, list: [] },
    usageSummary: { byHarness: {}, byModel: {} },
    usageRange: { from: '2026-01-01', to: '2026-01-07' },
    config: null,
    ...overrides,
  };
  return base;
}

test('the report reproduces the selector pick and candidate order for identical inputs', () => {
  const input = diagnosticsInput();
  const direct = selectModelPick({
    role: input.role,
    now: input.now,
    harnesses: input.harnesses,
    modelsByHarness: input.modelsByHarness,
    history: input.history,
    profiles: input.profiles,
    weights: input.weights,
    rotation: input.rotation,
    adaptive: input.adaptive,
  });
  const report = buildModelDiagnostics(input);

  assert.equal(report.ok, true);
  assert.equal(report.selection.ok, true);
  assert.equal(report.selection.pick.model, direct.pick.model);
  assert.equal(report.selection.pick.harness, direct.pick.harness);
  assert.deepEqual(
    report.selection.candidates.map((row) => `${row.harness}/${row.model}`),
    direct.candidates.map((row) => `${row.harness}/${row.model}`),
  );
  assert.equal(report.policy_version, direct.policyVersion);
  assert.equal(report.eligibility_cohort, direct.eligibilityCohort);
});

test('two calls with the same frozen inputs produce a byte-identical report', () => {
  const first = buildModelDiagnostics(diagnosticsInput());
  const second = buildModelDiagnostics(diagnosticsInput());
  assert.deepEqual(first, second);
});

test('an invalid operator config is carried into the report unchanged', () => {
  const config = inspectModelRoleProfilesConfig({ readFile: () => '{ nope' });
  const report = buildModelDiagnostics(diagnosticsInput({ config }));
  assert.equal(report.config.state, 'invalid');
  assert.match(report.config.error, /invalid JSON/);
  assert.ok(report.unknowns.length > 0);
});

test('the builder does not mutate the inputs it receives', () => {
  const input = diagnosticsInput();
  const snapshot = JSON.stringify(input);
  buildModelDiagnostics(input);
  assert.equal(JSON.stringify(input), snapshot, 'diagnostics must stay read-only over its inputs');
});

test('opening diagnostics creates no proposal and persists nothing', () => {
  const report = buildModelDiagnostics(diagnosticsInput());
  // A persisted pick would carry a pickId/expiry; the diagnostics never writes
  // one, so only the already-stored proposal (when injected) is echoed.
  assert.equal(report.persisted, null);
  assert.equal('pickId' in report.selection, false);
  assert.equal('pickExpiresAt' in report.selection, false);
});

test('missing telemetry is explicit unknown, not a measured zero', () => {
  const report = buildModelDiagnostics(diagnosticsInput());
  for (const row of report.models) {
    assert.equal(row.last_use.unknown, true, 'no job history must be unknown');
    assert.equal(row.last_use.at, null);
    const stats = row.stats.by_role.implement;
    assert.equal(stats, null, 'a cohort without terminal jobs has no stats row');
    assert.equal(row.cost.known, false, 'no priced usage must be unknown');
    assert.equal(row.cost.usd, null);
  }
  assert.equal(report.stats.cohorts.length, 0);
  assert.equal(report.stats.window_ms, 2_592_000_000);
  assert.ok(report.unknowns.some((line) => /task-type/.test(line)));
});

test('eligibility reasons come from the picker diagnosis and role matchers', () => {
  const report = buildModelDiagnostics(diagnosticsInput());
  const byModel = new Map(report.models.map((row) => [row.model, row]));
  assert.equal(byModel.get('composer-2.5').eligibility.eligible, true);
  assert.deepEqual(byModel.get('composer-2.5').eligibility.reasons, []);
  assert.equal(byModel.get('composer-2.5').eligibility.source, 'picker-diagnosis');
  // Grok is not an implement favorite, so the picker refused it for the role.
  const grokRow = byModel.get('grok-4.6::effort=high');
  assert.equal(grokRow.eligibility.eligible, false);
  assert.ok(grokRow.eligibility.reasons.includes('role-mismatch'));
});

test('non-favorite and disabled favorites stay visible and are labelled', () => {
  const disabled = { ...composer, id: 'composer-2.5-disabled', enabled: false };
  const input = diagnosticsInput({
    modelsByHarness: { sdk: { favorites_configured: true, items: [composer] } },
    allModelsByHarness: { sdk: { favorites_configured: true, items: [composer, disabled] } },
  });
  const report = buildModelDiagnostics(input);
  const row = report.models.find((model) => model.model === 'composer-2.5-disabled');
  assert.ok(row, 'a disabled favorite must still be listed');
  assert.equal(row.favorite, false);
  assert.equal(row.enabled, false);
  assert.ok(row.eligibility.reasons.includes('not-favorite'));
});

test('a favorite with priced usage reports known cost; unpriced is unknown', () => {
  const withCost = buildModelDiagnostics(diagnosticsInput({
    usageSummary: {
      byHarness: {},
      byModel: { 'composer-2.5': { usd: 1.25, estimatedUsd: 0, unpricedEvents: 0, events: 3, runs: 3 } },
    },
  }));
  const priced = withCost.models.find((row) => row.model === 'composer-2.5');
  assert.equal(priced.cost.known, true);
  assert.equal(priced.cost.usd, 1.25);

  const unpriced = buildModelDiagnostics(diagnosticsInput({
    usageSummary: {
      byHarness: {},
      byModel: { 'composer-2.5': { usd: 0, estimatedUsd: 0, unpricedEvents: 5, events: 5, runs: 5 } },
    },
  }));
  const unknown = unpriced.models.find((row) => row.model === 'composer-2.5');
  assert.equal(unknown.cost.known, false);
  assert.equal(unknown.cost.usd, null);
});

test('quality and reliability are reported separately for a measured cohort', () => {
  const report = buildModelDiagnostics(diagnosticsInput({
    outcomes: {
      window_ms: 2_592_000_000,
      generated_at: '2026-01-01T00:00:00.000Z',
      min_jobs: 1,
      list: [{
        harness: 'sdk',
        model: 'composer-2.5',
        role: 'implement',
        n: 12,
        infra_fails: 3,
        infra_fail_rate: 0.25,
        decided: 6,
        pass_rate: 0.5,
        quality: 3,
        median_min: 4.2,
        p95_min: 9,
        median_tokens_per_sec: 30,
        median_tool_calls: 7,
        median_files_changed: 2,
        rating_avg: 4,
        rating_n: 2,
        rating_avg_scored: 4,
        rating_n_scored: 2,
        last_used_at: '2026-01-01T00:00:00.000Z',
      }],
    },
  }));
  const row = report.models.find((model) => model.model === 'composer-2.5');
  const stats = row.stats.by_role.implement;
  assert.equal(stats.quality.pass_rate, 0.5);
  assert.equal(stats.quality.quality, 3);
  assert.equal(stats.reliability.infra_fail_rate, 0.25);
  assert.equal(stats.reliability.infra_fails, 3);
  assert.equal(stats.sample.n, 12);
  assert.equal(stats.sample.low_sample, false);
  assert.equal(stats.times.median_min, 4.2);
  assert.equal(row.last_use.at, '2026-01-01T00:00:00.000Z');
  assert.equal(row.last_use.unknown, false);
  // `fix` shares the persisted implement aggregate, and it is flagged.
  assert.equal(row.stats.by_role.fix.shares_implement_aggregate, true);
});

test('a low-sample cohort is flagged without inventing a rate', () => {
  const report = buildModelDiagnostics(diagnosticsInput({
    outcomes: {
      window_ms: 2_592_000_000,
      generated_at: '2026-01-01T00:00:00.000Z',
      min_jobs: 1,
      list: [{
        harness: 'sdk',
        model: 'composer-2.5',
        role: 'implement',
        n: 1,
        infra_fails: 0,
        infra_fail_rate: 0,
        decided: 0,
        pass_rate: null,
        quality: null,
        last_used_at: '',
      }],
    },
  }));
  const stats = report.models.find((model) => model.model === 'composer-2.5').stats.by_role.implement;
  assert.equal(stats.sample.n, 1);
  assert.ok(stats.sample.n < DIAGNOSTICS_LOW_SAMPLE_N);
  assert.equal(stats.sample.low_sample, true);
  assert.equal(stats.quality.pass_rate, null);
  assert.match(stats.uncertainty.note, /low-sample/);
});

test('the report exposes a canonical, display-only stats block', () => {
  const report = buildModelDiagnostics(diagnosticsInput({
    outcomes: {
      window_ms: 2_592_000_000,
      generated_at: '2026-01-01T00:00:00.000Z',
      min_jobs: 1,
      list: [],
      roles: {
        plan: {},
        implement: {
          'sdk/composer-2.5': {
            harness: 'sdk',
            model: 'composer-2.5',
            role: 'implement',
            n: 4,
            infra_fails: 0,
            infra_fail_rate: 0,
            decided: 1,
            pass_rate: 1,
            quality: 5,
            duration_n: 4,
            median_min: 4,
            p95_min: 9,
            median_tokens_per_sec: 20,
            tokens_per_sec_n: 4,
            median_tool_calls: 4,
            tool_calls_n: 4,
            median_files_changed: 2,
            files_changed_n: 4,
            last_used_at: '2026-01-01T00:00:00.000Z',
          },
        },
        review: {},
      },
    },
  }));
  const canonical = report.stats.canonical;
  assert.ok(canonical, 'canonical block is present');
  assert.equal(canonical.display_only, true);
  assert.equal(canonical.affects_ranking, false);
  assert.ok(canonical.cohort_key_parts.includes('role'));
  assert.ok(canonical.cohort_key_parts.includes('base_model'));
  assert.ok(canonical.cohort_key_parts.includes('review_protocol_version'));
  const cohort = canonical.cohorts.find((row) => row.base_model === 'composer-2.5');
  assert.ok(cohort, 'cohort for the measured pair');
  assert.equal(cohort.jobs.terminal_jobs, 4);
  assert.equal(cohort.latency.duration.sample_n, 4);
  assert.equal(cohort.versions.review_protocol_version, null);
  assert.ok(cohort.missing_fields.includes('review_protocol_version'));
  assert.deepEqual(canonical.unknowns.not_measured, ['task_type', 'effort']);
});

test('an unset role is a validation error, not a silent default', () => {
  const report = buildModelDiagnostics({ role: 'nope' });
  assert.equal(report.ok, false);
  assert.equal(report.code, 'VALIDATION');
});

test('describeModelRoleMatchers names the policy or operator source of a role', () => {
  const policy = describeModelRoleMatchers('composer-2.5', DEFAULT_MODEL_ROLE_PROFILES);
  assert.equal(policy.implement.eligible, true);
  assert.ok(policy.implement.matched.some((rule) => rule.source === 'policy' && rule.pattern === 'composer'));

  const operatorProfiles = {
    ...DEFAULT_MODEL_ROLE_PROFILES,
    plan: [{ pattern: 'composer', priority: 0, operator: true }],
  };
  const operator = describeModelRoleMatchers('composer-2.5', operatorProfiles);
  assert.equal(operator.plan.eligible, true);
  assert.ok(operator.plan.matched.some((rule) => rule.source === 'operator'));
});

test('inspectModelRoleProfilesConfig distinguishes missing, valid and invalid', () => {
  const missing = inspectModelRoleProfilesConfig({
    readFile: () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  assert.equal(missing.state, 'missing');
  assert.equal(missing.error, null);

  const valid = inspectModelRoleProfilesConfig({
    readFile: () => JSON.stringify({ roles: { plan: [{ pattern: 'grok' }] } }),
  });
  assert.equal(valid.state, 'valid');
  assert.equal(valid.roles.plan.configured, true);
  assert.equal(valid.roles.plan.matcherCount > 0, true);

  const invalid = inspectModelRoleProfilesConfig({ readFile: () => '{ not json' });
  assert.equal(invalid.state, 'invalid');
  assert.match(invalid.error, /invalid JSON/);
  assert.equal(invalid.roles, null);

  const wrongShape = inspectModelRoleProfilesConfig({ readFile: () => JSON.stringify({ roles: { plan: 'grok' } }) });
  assert.equal(wrongShape.state, 'invalid');
  assert.match(wrongShape.error, /roles\.plan/);
});

test('inspectModelRoleProfilesConfig reads a real temp file without writing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cretli-diag-config-'));
  try {
    const file = path.join(dir, 'model-role-profiles.json');
    writeFileSync(file, JSON.stringify({ rotation: 'balanced' }));
    const result = inspectModelRoleProfilesConfig({ filePath: file });
    assert.equal(result.state, 'valid');
    assert.equal(result.rotation.mode, 'balanced');
    rmSync(file);
    const after = inspectModelRoleProfilesConfig({ filePath: file });
    assert.equal(after.state, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
