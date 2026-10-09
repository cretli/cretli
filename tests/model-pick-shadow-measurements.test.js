/**
 * Stage 7 of `2584cd05`: the fact → shadow measurement input path.
 *
 * Pins the integration contract added on top of the stage-4 observer:
 * - every cost/speed signal is labelled measured vs estimate/heuristic with
 *   kind, source_class, source_version, age, confidence and coverage;
 * - unmatched alias / missing price / missing measurement stay neutral (a
 *   missing cost is `null`, never USD 0);
 * - only a matched `api_metered` pair may have its cost moved by data;
 * - actual and estimate stay distinct and a plan_usage reading is never USD;
 * - cache buckets stay disjoint and sum to `billed_tokens`;
 * - review verdict pass-rate never enters a quality score;
 * - the selected pick and the eligible set are unchanged with the observer on;
 * - zero network in the pick path and bounded (p99 <= 20 ms) overhead.
 *
 * Run: node tests/model-pick-shadow-measurements.test.js
 */

import { removeIsolatedDataDir, ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  SHADOW_MEASUREMENT_SCHEMA_VERSION,
  buildObservedMeasurementFacts,
  buildObservedMeasurementFactsForCandidates,
  buildShadowCycleCostFact,
  buildShadowMeasurement,
  buildShadowMeasurementIndex,
  summarizeMeasurementCoverage,
} from '../lib/model-pick-shadow-facts.js';
import {
  SHADOW_COST_ADJUSTMENT_MAX,
  scoreShadowCandidates,
} from '../lib/model-pick-shadow.js';
import {
  factMayCarryUsd,
  factUsdValue,
  selectPreferredFacts,
} from '../lib/model-facts/schema.js';
import {
  buildPlanUsageFact,
  buildTaskQualityTelemetry,
  buildTokenFacts,
} from '../lib/model-facts/telemetry.js';
import { resolveModelIdentity } from '../lib/model-facts/identity.js';
import { billedTotalTokens } from '../lib/usage/usage-contract.js';
import { pickModelForPurpose } from '../lib/model-pick-service.js';
import {
  loadModelPickShadowComparisons,
  persistModelPickShadowComparison,
  resetModelPickShadowComparisons,
} from '../lib/model-pick-decisions.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SOL = { harness: 'codex', model: 'gpt-5.6-sol' };
const SOL2 = { harness: 'codex', model: 'gpt-6.1-sol' };

let checks = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function check(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {number} score
 * @param {object | null} [observed]
 * @returns {object}
 */
function candidate(harness, model, score, observed = null) {
  return { harness, model, label: model, provider: 'openai', score, observed };
}

const priceMap = {
  'gpt-5.6-sol': {
    modelId: 'gpt-5.6-sol',
    pricing: { prompt: '0.000001', completion: '0.000002' },
    kind: 'estimate',
    source: 'openrouter-catalog',
    source_class: 'endpoint_catalog',
    source_version: 'openrouter-model-pricing-2026-10-08',
    billing_class: 'api_metered',
    fetched_at: new Date(NOW).toISOString(),
    observed_at: new Date(NOW).toISOString(),
    stale_after_ms: NOW,
  },
  'gpt-6.1-sol': {
    modelId: 'gpt-6.1-sol',
    pricing: { prompt: '0.000010', completion: '0.000020' },
    kind: 'estimate',
    source: 'openrouter-catalog',
    source_class: 'endpoint_catalog',
    source_version: 'openrouter-model-pricing-2026-10-08',
    billing_class: 'api_metered',
    fetched_at: new Date(NOW).toISOString(),
    observed_at: new Date(NOW).toISOString(),
    stale_after_ms: NOW,
  },
};
const priceFor = (_candidate, identity) => priceMap[identity.externalModelId] || null;

/**
 * @param {{ harness: string, model: string }} pair
 * @returns {object}
 */
function throughputFact(pair, value) {
  return buildObservedMeasurementFacts({
    ...pair,
    observed: { median_tokens_per_sec: value, n: 5, n_quality: 5, passed: 4, quality: 4.2 },
  }).find((fact) => fact.metric === 'throughput');
}

/**
 * @param {object} pair
 * @param {{ usd?: number, cohortId?: string, partialCoverage?: boolean, billedTokens?: number, reported?: boolean, attempts?: number, failures?: number, fixes?: number }} [input]
 * @returns {object | null}
 */
function costFact(pair, input = {}) {
  return buildShadowCycleCostFact({
    ...pair,
    provider: 'openai',
    usd: input.usd ?? 0.5,
    cohortId: input.cohortId ?? 'cohort-1',
    partialCoverage: input.partialCoverage === true,
    billedTokens: input.billedTokens ?? 500000,
    reported: input.reported === true,
    attempts: input.attempts ?? 2,
    failures: input.failures ?? 1,
    fixes: input.fixes ?? 1,
    observedAt: new Date(NOW).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// 1. Measured vs heuristic labelling + provenance/coverage
// ---------------------------------------------------------------------------

check('a measured ledger cost is labelled estimate with full provenance and coverage', () => {
  const fact = costFact(SOL, { usd: 1.5, cohortId: 'cycle-7', partialCoverage: true, attempts: 3, failures: 1, fixes: 2, billedTokens: 500000 });
  assert.ok(fact, 'an api_metered cohort cost builds a fact');
  const measurement = buildShadowMeasurement({
    candidateId: 'codex/gpt-5.6-sol',
    identity: resolveModelIdentity(SOL),
    billingClass: 'api_metered',
    facts: [fact, throughputFact(SOL, 40)],
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.schema_version, SHADOW_MEASUREMENT_SCHEMA_VERSION);
  assert.equal(measurement.matched, true);
  assert.equal(measurement.coverage.cost, 'estimate');
  assert.equal(measurement.cost.origin, 'estimate');
  assert.equal(measurement.cost.measured, false);
  assert.equal(measurement.cost.kind, 'estimate');
  assert.equal(measurement.cost.source_class, 'ledger_estimate');
  assert.equal(measurement.cost.source_version, 'usage-ledger-2026-10-08');
  assert.equal(typeof measurement.cost.observed_at, 'string');
  assert.equal(measurement.cost.age_ms, 0);
  assert.equal(measurement.cost.fresh, true);
  assert.equal(measurement.cost.confidence, 0.5, 'an estimate confidence is stated, not implied');
  assert.equal(measurement.cost.cohort_id, 'cycle-7', 'the cohort is explicit');
  assert.equal(measurement.cost.partial_coverage, true);
  assert.equal(measurement.cost.attempts, 3);
  assert.equal(measurement.cost.failures, 1);
  assert.equal(measurement.cost.fixes, 2);
  assert.equal(measurement.cost.normalized_per_million_usd, 3, 'per-cycle cost converts to the price basis');
  assert.equal(measurement.cost.derived_per_million, true);
  assert.equal(measurement.coverage.time, 'estimate');
  assert.equal(measurement.time.metric, 'throughput');
  assert.equal(measurement.time.origin, 'estimate');
});

check('a provider actual is labelled measured and keeps its kind', () => {
  const actual = costFact(SOL, { usd: 2, reported: true });
  assert.equal(actual.kind, 'actual');
  const measurement = buildShadowMeasurement({
    identity: resolveModelIdentity(SOL),
    billingClass: 'api_metered',
    facts: [actual],
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.coverage.cost, 'measured');
  assert.equal(measurement.cost.measured, true);
  assert.equal(measurement.cost.kind, 'actual');
  assert.equal(measurement.cost.source_class, 'provider_actual');
  assert.equal(measurement.cost.origin, 'measured');
});

check('an absent signal stays missing and never invents a value', () => {
  const measurement = buildShadowMeasurement({
    identity: resolveModelIdentity(SOL),
    billingClass: 'api_metered',
    facts: [],
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.coverage.cost, 'missing');
  assert.equal(measurement.coverage.time, 'missing');
  assert.equal(measurement.cost, null, 'a missing cost is null, not 0');
  assert.equal(measurement.time, null);
  const coverage = summarizeMeasurementCoverage([measurement]);
  assert.equal(coverage.by_signal.cost.missing, 1);
  assert.equal(coverage.by_signal.cost.heuristic, 0);
});

check('the observed history block is labelled as a provenance-carrying estimate', () => {
  const facts = buildObservedMeasurementFacts({
    ...SOL,
    observed: { median_tokens_per_sec: 33, n: 4, n_quality: 4, passed: 3, quality: 4 },
  }, { role: 'implement' });
  assert.ok(facts.length >= 1);
  const throughput = facts.find((fact) => fact.metric === 'throughput');
  assert.equal(throughput.source, 'model-pick-history');
  assert.equal(throughput.source_class, 'ledger_estimate');
  assert.equal(throughput.source_version, 'model-pick-history-2026-10-08');
});

// ---------------------------------------------------------------------------
// 2. Unmatched alias is neutral
// ---------------------------------------------------------------------------

check('an unmatched alias gets no cost and no time even when facts and a price exist', () => {
  const unmatched = { harness: 'codex', model: 'mystery-model' };
  const identity = resolveModelIdentity(unmatched);
  assert.equal(identity.aliasStatus, 'unmatched');
  const result = scoreShadowCandidates({
    role: 'implement',
    selected: candidate('codex', 'mystery-model', 0.5, { median_tokens_per_sec: 99 }),
    candidates: [candidate('codex', 'mystery-model', 0.5, { median_tokens_per_sec: 99 })],
    now: NOW,
    config: { mode: 'shadow' },
    priceFor: () => priceMap['gpt-5.6-sol'],
    measurementFacts: [costFact(SOL), throughputFact(SOL, 99)],
  });
  const row = result.scores[0];
  assert.equal(row.applied, false);
  assert.equal(row.skipped_reason, 'unmatched-alias');
  assert.equal(row.cost_adjustment, 0);
  assert.equal(row.time_adjustment, 0);
  assert.equal(row.cost_signal, null);
  assert.equal(row.measurement.matched, false);
  assert.equal(row.measurement.coverage.cost, 'missing');
});

// ---------------------------------------------------------------------------
// 3. A missing price is not USD = 0
// ---------------------------------------------------------------------------

check('a matched pair without a price keeps a null cost and a neutral adjustment', () => {
  const result = scoreShadowCandidates({
    role: 'implement',
    selected: candidate('codex', 'gpt-5.6-sol', 0.5),
    candidates: [candidate('codex', 'gpt-5.6-sol', 0.5)],
    now: NOW,
    config: { mode: 'shadow' },
    priceFor: () => null,
  });
  const row = result.scores[0];
  assert.equal(row.price, null);
  assert.equal(row.cost_signal, null);
  assert.equal(row.cost_source, 'missing');
  assert.equal(row.cost_adjustment, 0);
  assert.equal(result.explanation.cost_sources.missing, 1);
});

check('a measured cost without a token basis is reported but not scored', () => {
  const fact = buildShadowCycleCostFact({
    ...SOL,
    provider: 'openai',
    usd: 0.5,
    cohortId: 'c1',
    billedTokens: null,
  });
  const measurement = buildShadowMeasurement({
    identity: resolveModelIdentity(SOL),
    billingClass: 'api_metered',
    facts: [fact],
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.cost.normalized_per_million_usd, null);
  assert.equal(measurement.cost.basis_convertible, false);
  const result = scoreShadowCandidates({
    role: 'implement',
    selected: candidate('codex', 'gpt-5.6-sol', 0.5),
    candidates: [candidate('codex', 'gpt-5.6-sol', 0.5)],
    now: NOW,
    config: { mode: 'shadow' },
    priceFor: () => null,
    measurementFacts: [fact],
  });
  assert.equal(result.scores[0].cost_source, 'missing', 'an unconvertible basis never guesses a scale');
  assert.equal(result.scores[0].cost_adjustment, 0);
});

// ---------------------------------------------------------------------------
// 4. Only api_metered receives a price; subscription/local/unknown do not
// ---------------------------------------------------------------------------

check('a subscription harness never builds an API USD fact', () => {
  assert.equal(buildShadowCycleCostFact({ harness: 'sdk', model: 'gpt-5.6-sol', usd: 9 }), null);
  assert.equal(buildShadowCycleCostFact({ harness: 'codex', model: 'gpt-5.6-sol', provider: 'cursor', usd: 9 }), null);
  assert.equal(buildShadowCycleCostFact({ harness: 'codex', model: 'gpt-5.6-sol', local: true, usd: 9 }), null);
});

check('a subscription/local/unknown candidate never has its cost moved', () => {
  for (const billingClass of ['subscription_quota', 'local', 'unknown']) {
    const result = scoreShadowCandidates({
      role: 'implement',
      selected: candidate('codex', 'gpt-5.6-sol', 0.5),
      candidates: [candidate('codex', 'gpt-5.6-sol', 0.5)],
      now: NOW,
      config: { mode: 'shadow' },
      priceFor,
      billingClassOf: () => billingClass,
      measurementFacts: [costFact(SOL), throughputFact(SOL, 50)],
    });
    const row = result.scores[0];
    assert.equal(row.cost_signal, null, `${billingClass} must not receive an API cost`);
    assert.equal(row.cost_adjustment, 0);
    assert.equal(row.time_adjustment, 0);
    assert.equal(row.applied, false);
  }
});

check('a hand-crafted non-metered usd fact is dropped by stage-1 precedence', () => {
  const rogue = {
    ...costFact(SOL),
    billing_class: 'subscription_quota',
    ranking_eligible: true,
    alias_status: 'matched',
  };
  const { selected, ignored } = selectPreferredFacts([rogue]);
  assert.equal(selected.length, 0);
  assert.ok(ignored.some((row) => row.reason === 'billing-class-not-metered'));
  assert.equal(factMayCarryUsd(rogue), false);
  assert.equal(factUsdValue(rogue), null);
  const measurement = buildShadowMeasurement({
    identity: resolveModelIdentity(SOL),
    billingClass: 'subscription_quota',
    facts: [rogue],
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.cost, null, 'a subscription quota is never USD 0 either');
});

// ---------------------------------------------------------------------------
// 5. Actual vs estimate separation and plan_usage units
// ---------------------------------------------------------------------------

check('an actual charge beats an estimate for the same pair without being relabelled', () => {
  const estimate = costFact(SOL, { usd: 1 });
  const actual = costFact(SOL, { usd: 7, reported: true });
  const { selected } = selectPreferredFacts([estimate, actual]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].kind, 'actual');
  assert.equal(selected[0].value, 7);
  const measurement = buildShadowMeasurement({
    identity: resolveModelIdentity(SOL),
    billingClass: 'api_metered',
    facts: [estimate, actual],
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.cost.kind, 'actual');
  assert.equal(measurement.cost.value_usd, 7);
  assert.equal(measurement.coverage.cost, 'measured');
});

check('a plan_usage reading is separate data and is never converted to USD', () => {
  const plan = buildPlanUsageFact({
    harness: 'sdk',
    model: 'gpt-5.6-sol',
    utilization: 73,
    rateLimitType: 'weekly',
    resetsAt: '2026-10-15T00:00:00.000Z',
    observedAt: new Date(NOW).toISOString(),
  });
  assert.ok(plan);
  assert.equal(plan.kind, 'plan_usage');
  assert.equal(factMayCarryUsd(plan), false);
  assert.equal(factUsdValue(plan), null);
  const measurement = buildShadowMeasurement({
    identity: resolveModelIdentity({ harness: 'sdk', model: 'gpt-5.6-sol' }),
    billingClass: 'subscription_quota',
    facts: [plan],
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.cost, null);
  assert.equal(measurement.coverage.plan_usage, 'measured');
  assert.equal(measurement.plan_usage.utilization, 73);
  assert.equal(measurement.plan_usage.kind, 'plan_usage');
});

// ---------------------------------------------------------------------------
// 6. Cache token buckets stay disjoint
// ---------------------------------------------------------------------------

check('token facts reconcile into disjoint buckets that sum to billed_tokens', () => {
  const tokens = { textInput: 1000, cachedInput: 400, cacheWrite: 50, textOutput: 250, reasoning: 30 };
  const result = buildTokenFacts({
    ...SOL,
    at: new Date(NOW).toISOString(),
    provenance: 'reported',
    tokens,
  });
  const billed = billedTotalTokens(tokens, 'codex');
  assert.equal(result.billed_tokens, 1700);
  assert.equal(billed, 1700);
  const measurement = buildShadowMeasurement({
    identity: resolveModelIdentity(SOL),
    billingClass: 'api_metered',
    facts: result.facts,
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.tokens.uncached_input, 1000);
  assert.equal(measurement.tokens.cache_read, 400);
  assert.equal(measurement.tokens.cache_write, 50);
  assert.equal(measurement.tokens.output, 220);
  assert.equal(measurement.tokens.reasoning, 30);
  assert.equal(measurement.tokens.billed_tokens, billed);
  const bucketSum = measurement.tokens.uncached_input
    + measurement.tokens.cache_read
    + measurement.tokens.cache_write
    + measurement.tokens.output
    + measurement.tokens.reasoning;
  assert.equal(bucketSum, billed, 'no cache or reasoning token is counted twice');
  assert.equal(measurement.coverage.tokens, 'measured');
});

check('a bag whose input already includes cache subtracts nothing twice', () => {
  const tokens = { textInput: 1200, cachedInput: 900, cacheWrite: 50, textOutput: 80, reasoning: 20 };
  const result = buildTokenFacts({
    harness: 'sdk',
    model: 'gpt-5.6-sol',
    at: new Date(NOW).toISOString(),
    provenance: 'reported',
    tokens,
  });
  const measurement = buildShadowMeasurement({
    identity: resolveModelIdentity({ harness: 'sdk', model: 'gpt-5.6-sol' }),
    billingClass: 'subscription_quota',
    facts: result.facts,
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(measurement.tokens.uncached_input, 250, 'the inclusive input counter is reduced once');
  assert.equal(measurement.tokens.billed_tokens, billedTotalTokens(tokens, 'sdk'));
});

// ---------------------------------------------------------------------------
// 7. Review quality never comes from the verdict pass rate
// ---------------------------------------------------------------------------

check('review pass_rate facts stay diagnostic and do not move the shadow score', () => {
  const high = buildTaskQualityTelemetry({ ...SOL, role: 'review', n: 10, decided: 10, passed: 9, observedAt: new Date(NOW).toISOString() });
  const low = buildTaskQualityTelemetry({ ...SOL, role: 'review', n: 10, decided: 10, passed: 1, observedAt: new Date(NOW).toISOString() });
  assert.equal(high.quality_ranking_eligible, false);
  assert.equal(low.quality_ranking_eligible, false);
  assert.notEqual(high.quality, low.quality, 'the raw rate exists for visibility');
  const base = {
    role: 'review',
    selected: candidate('codex', 'gpt-5.6-sol', 0.5),
    candidates: [candidate('codex', 'gpt-5.6-sol', 0.5)],
    now: NOW,
    config: { mode: 'shadow' },
    priceFor,
  };
  const highResult = scoreShadowCandidates({ ...base, measurementFacts: high.facts });
  const lowResult = scoreShadowCandidates({ ...base, measurementFacts: low.facts });
  assert.equal(highResult.scores[0].shadow_score, lowResult.scores[0].shadow_score);
  assert.equal(highResult.explanation.review_pass_rate_in_quality_score, false);
  assert.equal(highResult.scores[0].measurement.quality.used_in_score, false);
  assert.equal(highResult.scores[0].measurement.quality.ranking_eligible, false);
  assert.equal(highResult.scores[0].measurement.quality.review_verdict_excluded, true);
});

// ---------------------------------------------------------------------------
// 8. Indexing + coverage summary
// ---------------------------------------------------------------------------

check('facts are indexed once by identity and coverage is summarised', () => {
  const facts = [costFact(SOL), throughputFact(SOL, 10), costFact(SOL2), throughputFact(SOL2, 20)];
  const packets = buildShadowMeasurementIndex({
    candidates: [candidate('codex', 'gpt-5.6-sol', 0.5), candidate('codex', 'gpt-6.1-sol', 0.5)],
    facts,
    identityOf: (input) => resolveModelIdentity(input),
    now: NOW,
    freshMs: DAY_MS,
  });
  assert.equal(packets.size, 2);
  assert.equal(packets.get('codex/gpt-5.6-sol').cost.cohort_id, 'cohort-1');
  const coverage = summarizeMeasurementCoverage([...packets.values()]);
  assert.equal(coverage.total, 2);
  assert.equal(coverage.by_signal.cost.estimate, 2);
  assert.equal(coverage.by_signal.time.estimate, 2);
});

// ---------------------------------------------------------------------------
// 9. Selection/parity unchanged with the measurement input on
// ---------------------------------------------------------------------------

const codexHarnesses = [{ id: 'codex', enabled: true, ready: true, can_delegate: true }];
const codexModels = {
  codex: {
    favorites_configured: true,
    items: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }],
  },
};

check('the pick/picks/candidates and policyVersion are identical with measurements injected', () => {
  const base = {
    role: 'implement',
    harnesses: codexHarnesses,
    modelsByHarness: codexModels,
    now: NOW,
    explore: false,
  };
  const facts = [
    costFact(SOL, { usd: 5, cohortId: 'sol-cycle', partialCoverage: true }),
    costFact(SOL2, { usd: 0.5, cohortId: 'sol2-cycle' }),
    throughputFact(SOL, 5),
    throughputFact(SOL2, 50),
  ];
  const off = pickModelForPurpose({ ...base, shadow: false });
  const on = pickModelForPurpose({ ...base, shadowMeasurementFacts: facts });
  assert.deepEqual(on.pick, off.pick, 'the selected pick is unchanged');
  assert.deepEqual(on.picks, off.picks, 'fanout picks are unchanged');
  assert.deepEqual(on.candidates, off.candidates, 'candidate order and scores are unchanged');
  assert.ok(on.shadow_top, 'the observer still produced a shadow top');
  assert.equal(on.shadow_explanation.eligibility_parity, true);
  assert.equal(on.shadow_explanation.selected_unchanged, true);
  assert.equal(on.shadow_agreement.role, 'implement');
  // The measured cost moved the shadow cost score, not the pick.
  const sol = on.shadow_explanation.contributions.find((row) => row.candidateId === 'codex/gpt-5.6-sol');
  const sol2 = on.shadow_explanation.contributions.find((row) => row.candidateId === 'codex/gpt-6.1-sol');
  assert.equal(sol.cost_source, 'measurement');
  assert.ok(sol.cost_adjustment < sol2.cost_adjustment, 'the cheaper measured cycle is preferred in the shadow');
  assert.equal(sol.measurement.cost.cohort_id, 'sol-cycle');
  assert.equal(sol.measurement.cost.partial_coverage, true);
});

check('the default measurement path labels observed speed without changing the pick', () => {
  const base = {
    role: 'implement',
    harnesses: codexHarnesses,
    modelsByHarness: codexModels,
    now: NOW,
    explore: false,
    history: {
      observed: {
        'codex/gpt-5.6-sol': { n: 4, n_quality: 4, passed: 3, quality: 4, median_min: 3, median_tokens_per_sec: 30 },
        'codex/gpt-6.1-sol': { n: 4, n_quality: 4, passed: 3, quality: 4, median_min: 3, median_tokens_per_sec: 10 },
      },
      prior: { infra_fail_rate: 0 },
      lockouts: [],
      planLimits: [],
    },
  };
  const off = pickModelForPurpose({ ...base, shadow: false });
  const on = pickModelForPurpose({ ...base });
  assert.deepEqual(on.candidates, off.candidates);
  const sol = on.shadow_explanation.contributions.find((row) => row.candidateId === 'codex/gpt-5.6-sol');
  assert.equal(sol.time.source, 'model-pick-history');
  assert.equal(sol.time.origin, 'estimate');
  assert.equal(sol.measurement.coverage.time, 'estimate');
});

// ---------------------------------------------------------------------------
// 10. No network inside the pick path
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('network is forbidden inside model_pick');
};
try {
  const facts = [costFact(SOL), throughputFact(SOL, 20)];
  scoreShadowCandidates({
    role: 'implement',
    selected: candidate('codex', 'gpt-5.6-sol', 0.5),
    candidates: [candidate('codex', 'gpt-5.6-sol', 0.5)],
    now: NOW,
    config: { mode: 'shadow' },
    priceFor,
    measurementFacts: facts,
  });
  pickModelForPurpose({
    role: 'implement',
    harnesses: codexHarnesses,
    modelsByHarness: codexModels,
    now: NOW,
    explore: false,
    shadowMeasurementFacts: facts,
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls, 0, 'the measurement path makes zero network requests');

// ---------------------------------------------------------------------------
// 11. Bounded overhead: p99 <= 20 ms with a bounded fact list
// ---------------------------------------------------------------------------

check('the measurement path stays within the p99 overhead budget', () => {
  const candidates = [];
  const facts = [];
  for (let i = 0; i < 12; i += 1) {
    candidates.push(candidate('codex', i % 2 === 0 ? 'gpt-5.6-sol' : 'gpt-6.1-sol', 0.5 - (i * 0.001), {
      median_min: 2 + i,
      median_tokens_per_sec: 50 - i,
    }));
    facts.push(throughputFact(i % 2 === 0 ? SOL : SOL2, 50 - i));
    facts.push(costFact(i % 2 === 0 ? SOL : SOL2, { usd: 1 + i, cohortId: `c${i}` }));
  }
  for (let warm = 0; warm < 20; warm += 1) {
    scoreShadowCandidates({ role: 'implement', selected: candidates[0], candidates, now: NOW, config: { mode: 'shadow' }, priceFor, measurementFacts: facts });
  }
  const samples = [];
  for (let i = 0; i < 300; i += 1) {
    const started = performance.now();
    scoreShadowCandidates({ role: 'implement', selected: candidates[0], candidates, now: NOW, config: { mode: 'shadow' }, priceFor, measurementFacts: facts });
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p99 = samples[Math.min(samples.length - 1, Math.ceil(0.99 * samples.length) - 1)];
  assert.ok(p99 <= 20, `measurement shadow p99 ${p99.toFixed(3)}ms must be <= 20ms`);
});

// ---------------------------------------------------------------------------
// 12. Normaliser bound is unchanged
// ---------------------------------------------------------------------------

check('a two-candidate measured cost split respects the cost nudge bound', () => {
  const result = scoreShadowCandidates({
    role: 'implement',
    selected: candidate('codex', 'gpt-5.6-sol', 0.5),
    candidates: [candidate('codex', 'gpt-5.6-sol', 0.5), candidate('codex', 'gpt-6.1-sol', 0.5)],
    now: NOW,
    config: { mode: 'shadow' },
    priceFor: () => null,
    measurementFacts: [
      costFact(SOL, { usd: 1, billedTokens: 1000000 }),
      costFact(SOL2, { usd: 10, billedTokens: 1000000 }),
    ],
  });
  const cheap = result.scores.find((row) => row.candidateId === 'codex/gpt-5.6-sol');
  const pricey = result.scores.find((row) => row.candidateId === 'codex/gpt-6.1-sol');
  assert.equal(cheap.cost_adjustment, SHADOW_COST_ADJUSTMENT_MAX / 2);
  assert.equal(pricey.cost_adjustment, -SHADOW_COST_ADJUSTMENT_MAX / 2);
});

check('buildObservedMeasurementFactsForCandidates is a bounded pure builder', () => {
  const facts = buildObservedMeasurementFactsForCandidates([
    candidate('codex', 'gpt-5.6-sol', 0.5, { median_tokens_per_sec: 12, n: 2, n_quality: 2, passed: 1, quality: 3 }),
    candidate('codex', 'gpt-6.1-sol', 0.5, null),
  ], { role: 'implement' });
  assert.ok(facts.length >= 1);
  for (const fact of facts) assert.equal(fact.identity_key.startsWith('codex'), true);
});

// ---------------------------------------------------------------------------
// 13. A normalization change restarts the agreement window
// ---------------------------------------------------------------------------

check('a new shadow segment restarts the agreement window instead of mixing', () => {
  const file = path.join(ISOLATED_DATA_DIR, 'shadow-segment.json');
  resetModelPickShadowComparisons({ file, removeFile: true });
  persistModelPickShadowComparison({ role: 'implement', agreement: { role: 'implement', agree: true }, segment: 'shadow+a', file, now: NOW });
  persistModelPickShadowComparison({ role: 'implement', agreement: { role: 'implement', agree: true }, segment: 'shadow+a', file, now: NOW + 1000 });
  const sameSegment = loadModelPickShadowComparisons({ file, segment: 'shadow+a' });
  assert.equal(sameSegment.report.byRole.implement.n, 2);
  assert.equal(sameSegment.segment_match, true);
  // The stage-7 measurement input is a new normalization: the old counters must
  // not be read as evidence for it.
  const switched = persistModelPickShadowComparison({
    role: 'implement',
    agreement: { role: 'implement', agree: false },
    segment: 'shadow+b',
    file,
    now: NOW + 2000,
  });
  assert.equal(switched.segment, 'shadow+b');
  const freshWindow = loadModelPickShadowComparisons({ file, segment: 'shadow+b' });
  assert.equal(freshWindow.report.byRole.implement.n, 1, 'the previous segment counters are dropped');
  assert.equal(freshWindow.entries.length, 1);
  assert.equal(freshWindow.segment_match, true);
  assert.equal(loadModelPickShadowComparisons({ file, segment: 'shadow+a' }).segment_match, false);
});

removeIsolatedDataDir();
console.log(`model-pick-shadow-measurements: ${checks} checks passed`);
