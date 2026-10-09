/**
 * Pure UI model for Settings → Harness model diagnostics.
 *
 * The renderer must show only what the backend returned: the candidate order is
 * preserved, an invalid config is surfaced, and missing telemetry renders as an
 * explicit "unknown" label rather than a zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiagnosticsViewModel,
  renderDiagnosticsHtml,
} from '../app_front/features/harness-health/harnessDiagnosticsModel.js';

/**
 * Minimal translator: returns the key, substituting `{name}` placeholders.
 *
 * @param {string} key
 * @param {object} [values]
 * @returns {string}
 */
function t(key, values = {}) {
  return String(key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
}

const REPORT = {
  ok: true,
  role: 'implement',
  policy_version: 'role-policy-X',
  eligibility_cohort: 'alias-X+role-policy-X',
  generated_at: '2026-01-01T00:00:00.000Z',
  config: { state: 'invalid', error: 'invalid JSON: boom' },
  selection: {
    ok: true,
    pick: { harness: 'sdk', model: 'composer-2.5', reason: 'balanced band' },
    candidates: [
      { harness: 'sdk', model: 'composer-2.5', score: 0.7, in_band: true, reason: 'selected' },
      { harness: 'codex', model: 'gpt-6-astra', score: 0.66, in_band: true, reason: 'alternate' },
    ],
    rotation: { band: 0.05, mode: 'balanced' },
  },
  models: [{
    harness: 'sdk',
    model: 'composer-2.5',
    label: 'Composer 2.5',
    favorite: true,
    enabled: true,
    eligibility: { eligible: true, reasons: [] },
    role_matchers: { implement: { eligible: true, matched: [{ pattern: 'composer', source: 'policy' }] } },
    availability: { available: true, usage_limited: false, locked_out: false, last_known_at: null },
    last_use: { at: null, source: null, unknown: true },
    cost: { known: false, usd: null, unpricedEvents: 0 },
    stats: { by_role: { implement: null } },
  }],
  stats: {
    cohorts: [],
    usage_link: { settings_tab: 'usage', group_by: 'harness' },
  },
  unknowns: ['task-type and effort cohorts are not aggregated'],
};

test('the view model preserves the reproduced candidate order', () => {
  const model = buildDiagnosticsViewModel(REPORT, 'en', 'unknown');
  assert.deepEqual(model.selection.candidates.map((row) => row.key), [
    'sdk/composer-2.5',
    'codex/gpt-6-astra',
  ]);
  assert.equal(model.selection.candidates[0].selected, true);
  assert.equal(model.selection.pickKey, 'sdk/composer-2.5');
});

test('an invalid config is surfaced as an alert, not hidden', () => {
  const model = buildDiagnosticsViewModel(REPORT, 'en', 'unknown');
  assert.equal(model.config.state, 'invalid');
  assert.ok(model.alerts.some((alert) => alert.key === 'configInvalid' && /boom/.test(alert.detail)));
  const html = renderDiagnosticsHtml(model, t);
  assert.match(html, /harnessDiagnostics\.configInvalid/);
  assert.match(html, /invalid JSON: boom/);
});

test('missing telemetry renders as unknown, never zero', () => {
  const model = buildDiagnosticsViewModel(REPORT, 'en', 'unknown');
  assert.equal(model.models[0].lastUseText, 'unknown');
  assert.equal(model.models[0].qualityText, 'unknown');
  assert.equal(model.models[0].sampleText, 'unknown');
  assert.equal(model.models[0].costText, 'unknown');
  const html = renderDiagnosticsHtml(model, t);
  assert.match(html, /unknown/);
  assert.doesNotMatch(html, />0 \/ 0</);
});

test('cost renders as a dollar figure only when the ledger knows it', () => {
  const priced = buildDiagnosticsViewModel({
    ...REPORT,
    models: [{ ...REPORT.models[0], cost: { known: true, usd: 1.5, estimatedUsd: 0.25 } }],
  }, 'en', 'unknown');
  assert.match(priced.models[0].costText, /\$1\.50/);
  assert.match(priced.models[0].costText, /est\./);
});

test('a low-sample cohort is labelled in the rendered table', () => {
  const model = buildDiagnosticsViewModel({
    ...REPORT,
    models: [{
      ...REPORT.models[0],
      stats: {
        by_role: {
          implement: {
            quality: { pass_rate: null, quality: null, decided: 0 },
            reliability: { infra_fail_rate: 0, n: 1 },
            sample: { n: 1, decided: 0, low_sample: true },
          },
        },
      },
    }],
  }, 'en', 'unknown');
  assert.equal(model.models[0].lowSample, true);
  const html = renderDiagnosticsHtml(model, t);
  assert.match(html, /harnessDiagnostics\.lowSample/);
});

const CANONICAL_REPORT = {
  ...REPORT,
  stats: {
    ...REPORT.stats,
    canonical: {
      contract_version: 'model-stats-X',
      display_only: true,
      affects_ranking: false,
      versions: {
        policy_version: 'pick-policy-X',
        review_protocol_version: 'review-protocol-X',
      },
      window: {
        window_ms: 2592000000,
        from: '2026-09-06T00:00:00.000Z',
        to: '2026-10-06T00:00:00.000Z',
      },
      totals: {
        cycles: {
          closed_cycles: 5,
          reviewed_cycles: 3,
          accepted_by_review: 2,
          manual_accepted: 0,
          rejected_by_review: 1,
          undecided: 0,
          unreviewed: 2,
          open_cycles: 1,
          accepted_rate: 0.6667,
        },
        cost: {
          known: true,
          usd: 3.25,
          effective_cost_per_accepted_usd: 1.625,
          priced_events: 3,
          total_events: 5,
          unknown_events: 1,
          subscription_events: 1,
        },
      },
      unknowns: { not_measured: ['task_type', 'effort'] },
      missing_fields: ['review_protocol_version'],
      cohorts: [{
        cohort_key: 'implement|sdk|composer-2.5|pick-policy-X|unknown',
        role: 'implement',
        aggregate_role: 'implement',
        shares_implement_aggregate: false,
        harness: 'sdk',
        base_model: 'composer-2.5',
        versions: { policy_version: 'pick-policy-X', review_protocol_version: null },
        jobs: {
          terminal_jobs: 5,
          non_infra_jobs: 5,
          infra_fails: 0,
          infra_fail_rate: 0,
          decided: 3,
          pass_rate: 0.6667,
        },
        cycles: {
          closed_cycles: 5,
          reviewed_cycles: 3,
          accepted_by_review: 2,
          manual_accepted: 0,
          rejected_by_review: 1,
          undecided: 0,
          unreviewed: 2,
          open_cycles: 1,
          accepted_rate: 0.6667,
        },
        cost: {
          known: false,
          usd: null,
          effective_cost_per_accepted_usd: null,
          priced_events: 0,
          total_events: 2,
          unknown_events: 2,
          subscription_events: 0,
        },
        latency: {
          duration: { sample_n: 5, median_min: 4, p95_min: 9 },
          tokens_per_sec: { sample_n: 5, median: 20 },
          tool_calls: { sample_n: 5, median: 4 },
          files_changed: { sample_n: 5, median: 2 },
        },
        uncertainty: {
          n: 5,
          low_sample: false,
          low_sample_n: 3,
          prior: { infra_fail_rate: 0.1, role: 'implement' },
          shrink: { weight: 0.3333, half_life: 10 },
          display_only: true,
          affects_ranking: false,
        },
        missing_fields: ['review_protocol_version', 'cost.usd'],
        contract_version: 'model-stats-X',
      }],
    },
  },
};

test('the canonical view model keeps the four denominator groups separate', () => {
  const model = buildDiagnosticsViewModel(CANONICAL_REPORT, 'en', 'unknown');
  assert.ok(model.canonical, 'canonical block is present');
  assert.equal(model.canonical.contractVersion, 'model-stats-X');
  assert.equal(model.canonical.policyVersion, 'pick-policy-X');
  assert.equal(model.canonical.reviewProtocolVersion, 'review-protocol-X');
  assert.equal(model.canonical.windowFrom, '2026-09-06T00:00:00.000Z');
  assert.ok(model.canonical.missingFields.includes('review_protocol_version'));
  assert.deepEqual(model.canonical.notMeasured, ['task_type', 'effort']);
  const cohort = model.canonical.cohorts[0];
  assert.equal(cohort.jobs.terminal, 5);
  assert.equal(cohort.cycles.reviewed, 3);
  assert.equal(cohort.cost.known, false, 'an unpriced cohort is unknown, not $0');
  assert.equal(cohort.cost.usd, null);
  assert.equal(cohort.latency.durationN, 5);
  assert.equal(cohort.latency.tokensN, 5);
  assert.equal(cohort.uncertainty.n, 5);
});

test('the canonical section renders metadata, denominators and unknowns', () => {
  const model = buildDiagnosticsViewModel(CANONICAL_REPORT, 'en', 'unknown');
  const html = renderDiagnosticsHtml(model, t);
  assert.match(html, /harnessDiagnostics\.canonicalHeading/);
  assert.match(html, /harnessDiagnostics\.canonicalWindowBadge/);
  assert.match(html, /harnessDiagnostics\.canonicalVersionsBadge/);
  assert.match(html, /harnessDiagnostics\.canonicalReviewProtocolUnknown/);
  assert.match(html, /harnessDiagnostics\.canonicalCyclesCell/);
  assert.match(html, /harnessDiagnostics\.canonicalJobsCell/);
  assert.match(html, /harnessDiagnostics\.canonicalCostUnknown/);
  assert.match(html, /harnessDiagnostics\.canonicalLatencyCell/);
  assert.match(html, /harnessDiagnostics\.canonicalNotMeasured/);
});

test('a report without canonical stats renders exactly as before', () => {
  const model = buildDiagnosticsViewModel(REPORT, 'en', 'unknown');
  assert.equal(model.canonical, null);
  const html = renderDiagnosticsHtml(model, t);
  assert.doesNotMatch(html, /harnessDiagnostics\.canonicalHeading/);
});

test('the endpoint roles are exactly the picker roles', async () => {
  const { HARNESS_DIAGNOSTICS_ROLES } = await import('../app_front/features/harness-health/harnessDiagnostics.js');
  assert.deepEqual([...HARNESS_DIAGNOSTICS_ROLES], ['plan', 'implement', 'review', 'fix']);
});
