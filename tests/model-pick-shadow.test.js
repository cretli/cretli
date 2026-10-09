/**
 * Stage 4 of `2584cd05`: explainable shadow scoring for `model_pick`.
 *
 * Pins the leaf contract: the observer adds `shadow_top` / `explanation` /
 * `agreement` without changing the selection, keeps eligibility parity, stays
 * fully network-free, treats an unmatched identity as neutral, never charges a
 * subscription/local/unknown pair an API price, never blends review verdict
 * pass-rate into quality, and reports the (dormant) rollout gate math.
 */

import { removeIsolatedDataDir, ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  SHADOW_COST_ADJUSTMENT_MAX,
  applyShadowLayer,
  blendedPricePerMillion,
  loadModelPickShadowConfig,
  reviewPassRateInfluencesScore,
  scoreShadowCandidates,
} from '../lib/model-pick-shadow.js';
import {
  SHADOW_MEASUREMENT_SCHEMA_VERSION,
  buildShadowCycleCostFact,
} from '../lib/model-pick-shadow-facts.js';
import {
  buildShadowAgreementReport,
  evaluateShadowRolloutGate,
  evaluateShadowWindow,
  wilsonInterval,
  wilsonLowerBound,
  wilsonLowerBoundDifference,
  wilsonUpperBound,
} from '../lib/model-pick-shadow-gates.js';
import {
  MODEL_PICK_SHADOW_CONFIG_DEFAULTS,
  MODEL_PICK_SHADOW_PRICE_FRESH_MS,
  composeModelPickShadowSegment,
  normalizeModelPickShadowConfig,
} from '../lib/model-pick-policy.js';
import { pickAndPersistModelForPurpose, pickModelForPurpose } from '../lib/model-pick-service.js';
import {
  loadModelPickShadowComparisons,
  persistModelPickShadowComparison,
  resetModelPickShadowComparisons,
} from '../lib/model-pick-decisions.js';
import {
  resetOpenRouterPricingCacheMemory,
  writeOpenRouterPricingCache,
} from '../lib/openrouter/openrouter-pricing-cache.js';
import { selectModelPick } from '../lib/model-role-profiles.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const codexHarnesses = [{ id: 'codex', enabled: true, ready: true, can_delegate: true }];
const codexModels = {
  codex: {
    favorites_configured: true,
    items: [
      { id: 'gpt-5.6-sol' },
      { id: 'gpt-6.1-sol' },
    ],
  },
};

/**
 * @param {string} model
 * @param {{ prompt?: string, completion?: string, fetchedAt?: string }} [pricing]
 * @returns {object}
 */
function endpointEntry(model, pricing = {}) {
  const fetchedAt = pricing.fetchedAt || new Date(NOW).toISOString();
  return {
    modelId: model,
    name: model,
    pricing: {
      prompt: pricing.prompt ?? '0.000001',
      completion: pricing.completion ?? '0.000002',
    },
    kind: 'estimate',
    source: 'openrouter-catalog',
    source_class: 'endpoint_catalog',
    source_version: 'openrouter-model-pricing-2026-10-08',
    billing_class: 'api_metered',
    attribution: 'test endpoint catalog',
    fetched_at: fetchedAt,
    observed_at: fetchedAt,
    stale_after_ms: Date.parse(fetchedAt),
  };
}

function matchedIdentity({ harness, model }) {
  return {
    aliasStatus: 'matched',
    aliasReason: 'exact-match',
    provider: 'openai',
    externalModelId: model,
    harness,
    model,
  };
}

function unmatchedIdentity({ harness, model }) {
  return {
    aliasStatus: 'unmatched',
    aliasReason: 'no-exact-alias',
    provider: null,
    externalModelId: null,
    harness,
    model,
  };
}

/** Pure-test identity: harness name selects matched vs unmatched. */
function identityOf(input) {
  return input.harness === 'matched' ? matchedIdentity(input) : unmatchedIdentity(input);
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {number} score
 * @param {object | null} [observed]
 * @returns {object}
 */
function candidate(harness, model, score, observed = null) {
  return {
    harness,
    model,
    label: model,
    provider: 'openai',
    cost_tier: 2,
    quality_tier: 3,
    speed_tier: 3,
    score,
    observed,
  };
}

const priceMap = {
  cheap: endpointEntry('cheap', { prompt: '0.000001', completion: '0.000002' }),
  pricey: endpointEntry('pricey', { prompt: '0.000010', completion: '0.000020' }),
};
const purePriceFor = (_candidate, identity) => priceMap[identity.externalModelId] || null;

// ---------------------------------------------------------------------------
// Policy config + version segment
// ---------------------------------------------------------------------------

assert.equal(MODEL_PICK_SHADOW_CONFIG_DEFAULTS.mode, 'shadow', 'shadow is an observer ON by default');
assert.equal(MODEL_PICK_SHADOW_CONFIG_DEFAULTS.promotion, false, 'promotion is OFF by default');
assert.deepEqual(normalizeModelPickShadowConfig(false), { ...MODEL_PICK_SHADOW_CONFIG_DEFAULTS, mode: 'off' });
assert.equal(normalizeModelPickShadowConfig('off').mode, 'off');
assert.equal(normalizeModelPickShadowConfig({ shadow: { mode: 'off' } }).mode, 'off');
assert.equal(normalizeModelPickShadowConfig({ mode: 'bogus' }).mode, 'shadow', 'unknown mode falls back to observe');
// Floors/ceilings cannot be weakened by an operator file.
assert.equal(normalizeModelPickShadowConfig({ minDays: 1 }).minDays, 14);
assert.equal(normalizeModelPickShadowConfig({ minCalls: 1 }).minCalls, 200, 'call window is a floor, never weakened');
assert.equal(normalizeModelPickShadowConfig({ maxOverheadMs: 1000 }).maxOverheadMs, 20);
assert.equal(normalizeModelPickShadowConfig({ reviewAgreementFloor: 0.1 }).reviewAgreementFloor, 0.7);
assert.equal(normalizeModelPickShadowConfig({ priceFreshMs: 30 * DAY_MS }).priceFreshMs, MODEL_PICK_SHADOW_PRICE_FRESH_MS);
assert.equal(normalizeModelPickShadowConfig({ promotion: true }).promotion, true);

assert.equal(composeModelPickShadowSegment({ mode: 'off' }), '');
const shadowSegment = composeModelPickShadowSegment({ mode: 'shadow' });
assert.ok(shadowSegment.startsWith('shadow+shadow-policy-'), shadowSegment);
assert.ok(composeModelPickShadowSegment({ mode: 'shadow', promotion: true }).includes('+promoted+'));

const configFile = path.join(ISOLATED_DATA_DIR, 'shadow-config.json');
fs.writeFileSync(configFile, JSON.stringify({ shadow: { mode: 'off', promotion: true } }), 'utf8');
assert.equal(loadModelPickShadowConfig({ filePath: configFile }).mode, 'off');
assert.equal(loadModelPickShadowConfig({ filePath: configFile }).promotion, true);
assert.equal(loadModelPickShadowConfig({ filePath: path.join(ISOLATED_DATA_DIR, 'missing.json') }).mode, 'shadow');

// ---------------------------------------------------------------------------
// Wilson math + window + rollout gate (dormant)
// ---------------------------------------------------------------------------

const interval = wilsonInterval(20, 20);
assert.ok(Math.abs(interval.lower - 0.8388748419471806) < 1e-9, `wilson(20,20).lower=${interval.lower}`);
assert.ok(Math.abs(wilsonUpperBound(20, 20) - 1) < 1e-9);
assert.equal(wilsonLowerBound(0, 10), 0, 'zero successes has a zero lower bound');
assert.equal(wilsonLowerBound(1, 0), null, 'no sample is not a bound');
const sameShare = wilsonLowerBoundDifference({ successes: 50, n: 100 }, { successes: 50, n: 100 });
assert.ok(sameShare < 0, 'identical shares still have a negative lower bound of the difference');
const betterShare = wilsonLowerBoundDifference({ successes: 80, n: 100 }, { successes: 50, n: 100 });
assert.ok(Math.abs(betterShare - 0.1690840146822274) < 1e-9, `difference=${betterShare}`);
assert.equal(wilsonLowerBoundDifference({ successes: 0, n: 0 }, { successes: 1, n: 1 }), null);

const halfWindow = evaluateShadowWindow({ firstAt: new Date(NOW - 15 * DAY_MS).toISOString(), now: NOW, calls: 250 });
assert.equal(halfWindow.days_satisfied, true);
assert.equal(halfWindow.calls_satisfied, true);
assert.equal(halfWindow.satisfied, true);
assert.equal(evaluateShadowWindow({ firstAt: new Date(NOW - 13 * DAY_MS).toISOString(), now: NOW, calls: 250 }).satisfied, false, 'days gate');
assert.equal(evaluateShadowWindow({ firstAt: new Date(NOW - 15 * DAY_MS).toISOString(), now: NOW, calls: 199 }).satisfied, false, 'calls gate');
assert.equal(evaluateShadowWindow({ firstAt: null, now: NOW, calls: 5000 }).satisfied, false, 'no first call means no window');

const strongArm = {
  promotionEnabled: true,
  decidedCycles: 25,
  passRate: { successes: 80, n: 100 },
  baselinePassRate: { successes: 50, n: 100 },
  infraFailRate: 0.1,
  baselineInfraFailRate: 0.1,
  usdPerSuccess: 1,
  baselineUsdPerSuccess: 1,
};
const dormantGate = evaluateShadowRolloutGate({ ...strongArm, promotionEnabled: false });
assert.equal(dormantGate.dormant, true);
assert.equal(dormantGate.eligible, false);
assert.equal(dormantGate.metrics_eligible, true, 'numbers are computed even while promotion is off');
assert.ok(dormantGate.reasons.includes('promotion-disabled'));
assert.equal(evaluateShadowRolloutGate(strongArm).eligible, true, 'metrics + promotion flag can qualify');
assert.equal(evaluateShadowRolloutGate({ ...strongArm, decidedCycles: 19 }).metrics_eligible, false, 'decided-cycle floor');
assert.equal(
  evaluateShadowRolloutGate({ ...strongArm, passRate: { successes: 52, n: 100 } }).metrics_eligible,
  false,
  'a thin pass-rate edge must not clear a non-negative Wilson lower bound',
);
assert.equal(
  evaluateShadowRolloutGate({ ...strongArm, infraFailRate: 0.16 }).metrics_eligible,
  false,
  'infra-fail increase above 5pp blocks',
);
assert.equal(
  evaluateShadowRolloutGate({ ...strongArm, usdPerSuccess: 1.2, passRate: { successes: 55, n: 100 } }).metrics_eligible,
  false,
  'cost growth without a 10pp pass-rate gain blocks',
);
assert.equal(
  evaluateShadowRolloutGate({ ...strongArm, usdPerSuccess: 1.2 }).metrics_eligible,
  true,
  'cost growth with a >=10pp pass-rate gain is allowed',
);
assert.equal(evaluateShadowRolloutGate({ ...strongArm, billingClass: 'subscription_quota' }).metrics_eligible, false);
assert.equal(evaluateShadowRolloutGate({ ...strongArm, role: 'review' }).metrics_eligible, false, 'the first rollout is implement-only');

// ---------------------------------------------------------------------------
// Agreement report + stop flags
// ---------------------------------------------------------------------------

const lowAgreement = buildShadowAgreementReport({ review: { n: 10, agree: 5 } });
assert.equal(lowAgreement.byRole.review.agreement_rate, 0.5);
assert.equal(lowAgreement.stop_flags.review_agreement_below_floor, true);
assert.equal(lowAgreement.stop_flags.stop, true);
const healthyAgreement = buildShadowAgreementReport({ review: { n: 10, agree: 8 }, implement: { n: 4, agree: 4 } });
assert.equal(healthyAgreement.stop_flags.review_agreement_below_floor, false);
assert.equal(healthyAgreement.stop_flags.stop, false);
assert.equal(healthyAgreement.overall.n, 14);
assert.equal(
  buildShadowAgreementReport({ implement: { n: 2, agree: 2 } }, { reviewPassRateInfluencesScore: true }).stop_flags.stop,
  true,
  'a review pass-rate influence is a stop flag even without a review row',
);

// ---------------------------------------------------------------------------
// Pure scorer: selected unchanged (W1), eligibility parity (W10), unmatched
// neutral (W4), price gates (W5/W7), review quality (W6), n=0 (W12)
// ---------------------------------------------------------------------------

const pureCandidates = [
  candidate('matched', 'cheap', 0.5, { n: 4, median_min: 2, median_tokens_per_sec: 50 }),
  candidate('matched', 'pricey', 0.5, { n: 4, median_min: 5, median_tokens_per_sec: 10 }),
  candidate('unmatched', 'mystery', 0.5, { n: 4, median_min: 3, median_tokens_per_sec: 30 }),
];
const pureBefore = JSON.parse(JSON.stringify(pureCandidates));
const pureResult = scoreShadowCandidates({
  role: 'implement',
  selected: pureCandidates[0],
  candidates: pureCandidates,
  now: NOW,
  config: { mode: 'shadow' },
  priceFor: purePriceFor,
  identityOf,
});
assert.deepEqual(pureCandidates, pureBefore, 'the scorer must not mutate the candidate set');
assert.deepEqual(
  pureResult.explanation.contributions.map((row) => row.candidateId),
  pureCandidates.map((row) => `${row.harness}/${row.model}`),
  'eligibility parity: the observer consumes the exact eligible set',
);
assert.equal(pureResult.explanation.eligibility_parity, true);
assert.equal(pureResult.explanation.selected_unchanged, true);
assert.equal(pureResult.agreement.agree, true, 'the cheap+fast candidate wins the shadow and agrees');

const unmatchedRow = pureResult.scores.find((row) => row.candidateId === 'unmatched/mystery');
assert.equal(unmatchedRow.applied, false);
assert.equal(unmatchedRow.skipped_reason, 'unmatched-alias');
assert.equal(unmatchedRow.cost_adjustment, 0, 'unmatched is never punished or rewarded');
assert.equal(unmatchedRow.time_adjustment, 0);
assert.equal(unmatchedRow.shadow_score, 0.5, 'unmatched keeps the base score');

// Even when a price is offered for the unmatched pair, the identity gate wins.
const unmatchedWithPrice = scoreShadowCandidates({
  role: 'implement',
  selected: pureCandidates[2],
  candidates: [pureCandidates[2]],
  now: NOW,
  config: { mode: 'shadow' },
  priceFor: () => endpointEntry('mystery', { prompt: '0.01', completion: '0.01' }),
  identityOf,
});
assert.equal(unmatchedWithPrice.scores[0].cost_adjustment, 0);
assert.equal(unmatchedWithPrice.scores[0].applied, false);

const cheapRow = pureResult.scores.find((row) => row.candidateId === 'matched/cheap');
const priceyRow = pureResult.scores.find((row) => row.candidateId === 'matched/pricey');
assert.ok(cheapRow.cost_adjustment > 0, 'the cheaper fresh api_metered pair gains a bounded cost nudge');
assert.ok(priceyRow.cost_adjustment < 0);
assert.equal(cheapRow.cost_adjustment, SHADOW_COST_ADJUSTMENT_MAX / 2);
assert.equal(priceyRow.cost_adjustment, -SHADOW_COST_ADJUSTMENT_MAX / 2);
assert.ok(cheapRow.time_adjustment > 0, 'the faster fresh pair gains a bounded time nudge');
assert.ok(priceyRow.time_adjustment < 0);
assert.equal(cheapRow.time.metric, 'throughput');
assert.equal(cheapRow.time.source, 'model-pick-history');
assert.equal(cheapRow.time.kind, 'estimate');

for (const billingClass of ['subscription_quota', 'local', 'unknown']) {
  const gated = scoreShadowCandidates({
    role: 'implement',
    selected: pureCandidates[0],
    candidates: [pureCandidates[0]],
    now: NOW,
    config: { mode: 'shadow' },
    priceFor: purePriceFor,
    identityOf,
    billingClassOf: () => billingClass,
  });
  assert.equal(gated.scores[0].applied, false, `${billingClass} must not use an API price`);
  assert.equal(gated.scores[0].skipped_reason, `billing-class-${billingClass}`);
  assert.equal(gated.scores[0].cost_adjustment, 0);
  assert.equal(gated.scores[0].time_adjustment, 0);
}

// Review: verdict pass_rate never enters the shadow score.
const reviewHigh = candidate('matched', 'cheap', 0.5, { n: 10, pass_rate: 0.9, quality: 4.6, median_min: 2 });
const reviewLow = candidate('matched', 'cheap', 0.5, { n: 10, pass_rate: 0.1, quality: 1.4, median_min: 2 });
const reviewHighShadow = scoreShadowCandidates({
  role: 'review', selected: reviewHigh, candidates: [reviewHigh], now: NOW, config: { mode: 'shadow' }, priceFor: purePriceFor, identityOf,
});
const reviewLowShadow = scoreShadowCandidates({
  role: 'review', selected: reviewLow, candidates: [reviewLow], now: NOW, config: { mode: 'shadow' }, priceFor: purePriceFor, identityOf,
});
assert.equal(reviewHighShadow.scores[0].shadow_score, reviewLowShadow.scores[0].shadow_score);
assert.equal(reviewHighShadow.scores[0].quality_source, 'existing-observed-blend');
assert.equal(reviewHighShadow.explanation.review_pass_rate_in_quality_score, false);
assert.equal(reviewPassRateInfluencesScore('review', [{ quality_source: 'pass_rate' }]), true);
assert.equal(reviewPassRateInfluencesScore('implement', [{ quality_source: 'pass_rate' }]), false);
assert.equal(reviewPassRateInfluencesScore('review', [{ quality_source: 'existing-observed-blend' }]), false);

// n=0: the existing blend is untouched by the observer.
const zeroCandidate = candidate('matched', 'cheap', 0.42, null);
const zeroShadow = scoreShadowCandidates({
  role: 'implement', selected: zeroCandidate, candidates: [zeroCandidate], now: NOW, config: { mode: 'shadow' }, priceFor: () => null, identityOf,
});
assert.equal(zeroShadow.scores[0].base_score, 0.42);
assert.equal(zeroShadow.scores[0].shadow_score, 0.42, 'n=0 quality is preserved');

// Price helper: no numeric price is null, not zero.
assert.equal(blendedPricePerMillion(null), null);
assert.equal(blendedPricePerMillion({}), null);
assert.equal(blendedPricePerMillion({ prompt: '0.000001' }), 1);
assert.equal(blendedPricePerMillion({ prompt: '0.000001', completion: '0.000003' }), 2);

// Stale price: reported with its age, but never applied.
const staleShadow = scoreShadowCandidates({
  role: 'implement',
  selected: pureCandidates[0],
  candidates: [pureCandidates[0]],
  now: NOW,
  config: { mode: 'shadow' },
  priceFor: () => endpointEntry('cheap', { fetchedAt: new Date(NOW - 8 * DAY_MS).toISOString() }),
  identityOf,
});
assert.equal(staleShadow.scores[0].applied, false);
assert.equal(staleShadow.scores[0].skipped_reason, 'stale-price');
assert.ok(staleShadow.scores[0].price.age_ms > MODEL_PICK_SHADOW_PRICE_FRESH_MS);
assert.equal(staleShadow.scores[0].price.stale, true);
assert.equal(staleShadow.scores[0].cost_adjustment, 0);

// ---------------------------------------------------------------------------
// Service wiring: selected unchanged ON vs OFF, shadow fields present
// ---------------------------------------------------------------------------

const serviceBase = {
  role: 'implement',
  harnesses: codexHarnesses,
  modelsByHarness: codexModels,
  now: NOW,
  explore: false,
};

const withoutShadow = pickModelForPurpose({ ...serviceBase, shadow: false });
const withShadow = pickModelForPurpose({ ...serviceBase, shadowConfig: { mode: 'shadow' } });
assert.equal(withoutShadow.ok, true);
assert.equal(withShadow.ok, true);
assert.deepEqual(withShadow.pick, withoutShadow.pick, 'selected pick is identical with the observer on');
assert.deepEqual(withShadow.picks, withoutShadow.picks, 'fanout picks are identical');
assert.deepEqual(withShadow.candidates, withoutShadow.candidates, 'candidate order/scores are identical');
assert.equal(withoutShadow.shadow_top, undefined, 'shadow off adds nothing');
assert.ok(withShadow.shadow_top, 'shadow on adds shadow_top');
assert.ok(withShadow.shadow_explanation, 'shadow on adds an explanation');
assert.equal(withShadow.shadow_explanation.candidate_count, withShadow.candidates.length);

// The observer never mutates the picker output it is applied to.
const layeredSource = selectModelPick({ ...serviceBase });
const layeredBefore = JSON.parse(JSON.stringify(layeredSource.candidates));
applyShadowLayer(layeredSource, { role: 'implement', now: NOW, config: { mode: 'shadow' }, priceFor: purePriceFor, identityOf });
assert.deepEqual(layeredSource.candidates, layeredBefore, 'applyShadowLayer must not mutate candidates');

// ---------------------------------------------------------------------------
// Stage 7: the measurement input path is additive and provenance-labelled
// ---------------------------------------------------------------------------

const measuredFacts = [
  buildShadowCycleCostFact({ harness: 'codex', model: 'gpt-5.6-sol', provider: 'openai', usd: 4, cohortId: 'c1', partialCoverage: true, billedTokens: 1000000, attempts: 2, failures: 1, fixes: 1, observedAt: new Date(NOW).toISOString() }),
  buildShadowCycleCostFact({ harness: 'codex', model: 'gpt-6.1-sol', provider: 'openai', usd: 1, cohortId: 'c2', billedTokens: 1000000, observedAt: new Date(NOW).toISOString() }),
];
const measuredOn = pickModelForPurpose({ ...serviceBase, shadowMeasurementFacts: measuredFacts });
const measuredOff = pickModelForPurpose({ ...serviceBase, shadow: false });
assert.deepEqual(measuredOn.pick, measuredOff.pick, 'the measured cost never changes the selected pick');
assert.deepEqual(measuredOn.picks, measuredOff.picks);
assert.deepEqual(measuredOn.candidates, measuredOff.candidates, 'the eligible set is identical with measurements');
assert.equal(measuredOn.shadow_explanation.measurement_schema, SHADOW_MEASUREMENT_SCHEMA_VERSION);
assert.equal(measuredOn.shadow_explanation.eligibility_parity, true);
assert.ok(measuredOn.shadow_explanation.measurement_coverage.by_signal.cost.estimate >= 1, 'measured cost is labelled estimate');
const measuredSol = measuredOn.shadow_explanation.contributions.find((row) => row.candidateId === 'codex/gpt-5.6-sol');
assert.equal(measuredSol.cost_source, 'measurement');
assert.equal(measuredSol.cost_signal.cohort_id, 'c1');
assert.equal(measuredSol.cost_signal.partial_coverage, true);
assert.equal(measuredOn.shadow_explanation.review_pass_rate_in_quality_score, false);

// ---------------------------------------------------------------------------
// Integration: fresh/stale pricing from the stage-3 cache, zero network,
// agreement persisted, policy version segmented
// ---------------------------------------------------------------------------

const pickFile = path.join(ISOLATED_DATA_DIR, 'shadow-picks.json');
const shadowFile = path.join(ISOLATED_DATA_DIR, 'shadow-agreement.json');
resetModelPickShadowComparisons({ file: shadowFile, removeFile: true });
resetOpenRouterPricingCacheMemory();

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('network is forbidden inside model_pick');
};
try {
  writeOpenRouterPricingCache([
    { id: 'gpt-5.6-sol', name: 'sol', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'gpt-6.1-sol', name: 'sol-2', pricing: { prompt: '0.000010', completion: '0.000020' } },
  ], { now: NOW - (8 * DAY_MS) });
  const stalePick = pickModelForPurpose({ ...serviceBase });
  const staleSol = stalePick.shadow_explanation.contributions
    .find((row) => row.identity.external_model_id === 'gpt-5.6-sol');
  assert.equal(staleSol.applied, false);
  assert.equal(staleSol.skipped_reason, 'stale-price');
  assert.ok(staleSol.price.age_ms > MODEL_PICK_SHADOW_PRICE_FRESH_MS, 'stale cache works and carries its age');

  writeOpenRouterPricingCache([
    { id: 'gpt-5.6-sol', name: 'sol', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'gpt-6.1-sol', name: 'sol-2', pricing: { prompt: '0.000010', completion: '0.000020' } },
  ], { now: NOW });
  const freshPick = pickModelForPurpose({ ...serviceBase });
  const freshSol = freshPick.shadow_explanation.contributions
    .find((row) => row.identity.external_model_id === 'gpt-5.6-sol');
  const freshSol2 = freshPick.shadow_explanation.contributions
    .find((row) => row.identity.external_model_id === 'gpt-6.1-sol');
  assert.equal(freshSol.applied, true, 'fresh api_metered price is applied');
  assert.ok(freshSol.cost_adjustment > 0);
  assert.ok(freshSol2.cost_adjustment < 0);
  assert.equal(freshSol.price.kind, 'estimate');
  assert.equal(freshSol.price.source, 'openrouter-catalog');
  assert.equal(freshSol.price.source_class, 'endpoint_catalog');
  assert.equal(freshSol.price.billing_class, 'api_metered');

  const persisted = pickAndPersistModelForPurpose({ ...serviceBase, file: pickFile, shadowFile });
  assert.ok(String(persisted.policyVersion).includes(';shadow=shadow+shadow-policy-'), persisted.policyVersion);
  const agreementWindow = loadModelPickShadowComparisons({ file: shadowFile });
  assert.equal(agreementWindow.report.byRole.implement.n, 1);
  assert.equal(agreementWindow.entries.length, 1);
  assert.equal(agreementWindow.entries[0].role, 'implement');
  assert.equal(typeof agreementWindow.report.byRole.implement.agreement_rate, 'number');
  assert.equal(agreementWindow.window.calls, 1);
  assert.equal(agreementWindow.window.min_days, 14);
  assert.equal(agreementWindow.window.min_calls, 200);
  assert.equal(agreementWindow.window.satisfied, false, 'one call is far from the observation window');

  const noShadowPersisted = pickAndPersistModelForPurpose({ ...serviceBase, shadow: false, file: pickFile, shadowFile });
  assert.ok(!String(noShadowPersisted.policyVersion).includes(';shadow='), 'shadow off keeps the historical version');
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls, 0, 'the whole pick path with the observer on makes zero network requests');

// ---------------------------------------------------------------------------
// W11: stop flags persisted from real comparisons
// ---------------------------------------------------------------------------

const stopFile = path.join(ISOLATED_DATA_DIR, 'shadow-stop.json');
resetModelPickShadowComparisons({ file: stopFile, removeFile: true });
for (let i = 0; i < 10; i += 1) {
  persistModelPickShadowComparison({
    role: 'review',
    agreement: { role: 'review', selected: 'codex/gpt-5.6-luna', shadow_top: 'codex/gpt-6-astra', agree: i < 5 },
    file: stopFile,
  });
}
const stopWindow = loadModelPickShadowComparisons({ file: stopFile });
assert.equal(stopWindow.report.byRole.review.n, 10);
assert.equal(stopWindow.report.byRole.review.agreement_rate, 0.5);
assert.equal(stopWindow.report.stop_flags.review_agreement_below_floor, true);
assert.equal(stopWindow.report.stop_flags.stop, true);
const stopWithInfluence = loadModelPickShadowComparisons({ file: stopFile, reviewPassRateInfluencesScore: true });
assert.equal(stopWithInfluence.report.stop_flags.review_pass_rate_in_quality_score, true);

// ---------------------------------------------------------------------------
// W12: infra/quota and security filters are unchanged with the observer on
// ---------------------------------------------------------------------------

const lockoutHistory = {
  observed: {
    'codex/gpt-5.6-luna': { n: 5, infra_fail_rate: 0, pass_rate: 0.5, quality: 3 },
    'codex/gpt-6-astra': { n: 5, infra_fail_rate: 0, pass_rate: 0.5, quality: 3 },
  },
  prior: { infra_fail_rate: 0 },
  lockouts: [{ harness: 'codex', model: 'gpt-5.6-luna', resetAt: new Date(NOW + 3600_000).toISOString() }],
  planLimits: [],
};
const reviewModels = {
  codex: {
    favorites_configured: true,
    items: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-astra' }],
  },
};
const lockedOn = pickModelForPurpose({ role: 'review', harnesses: codexHarnesses, modelsByHarness: reviewModels, history: lockoutHistory, now: NOW, explore: false });
const lockedOff = pickModelForPurpose({ role: 'review', harnesses: codexHarnesses, modelsByHarness: reviewModels, history: lockoutHistory, now: NOW, explore: false, shadow: false });
assert.ok(!lockedOn.candidates.some((row) => row.model === 'gpt-5.6-luna'), 'lockout still drops the pair with the observer on');
assert.deepEqual(lockedOn.candidates, lockedOff.candidates, 'lockout filtering is identical');
assert.deepEqual(lockedOn.pick, lockedOff.pick);

// Review *flash* exclusion is unchanged.
const flashModels = {
  codex: {
    favorites_configured: true,
    items: [{ id: 'gemini-flash' }, { id: 'gpt-5.6-luna' }],
  },
};
const flashOn = pickModelForPurpose({ role: 'review', harnesses: codexHarnesses, modelsByHarness: flashModels, now: NOW, explore: false });
const flashOff = pickModelForPurpose({ role: 'review', harnesses: codexHarnesses, modelsByHarness: flashModels, now: NOW, explore: false, shadow: false });
assert.ok(!flashOn.candidates.some((row) => /flash/i.test(row.model)), 'flash stays out of review with the observer on');
assert.deepEqual(flashOn.candidates, flashOff.candidates);

// High-infra demotion is unchanged.
const infraHistory = {
  observed: {
    'codex/gpt-5.6-luna': { n: 5, infra_fail_rate: 0.8, pass_rate: 0.5, quality: 3 },
    'codex/gpt-6-astra': { n: 5, infra_fail_rate: 0.0, pass_rate: 0.5, quality: 3 },
  },
  prior: { infra_fail_rate: 0 },
  lockouts: [],
  planLimits: [],
};
const infraOn = pickModelForPurpose({ role: 'review', harnesses: codexHarnesses, modelsByHarness: reviewModels, history: infraHistory, now: NOW, explore: false });
const infraOff = pickModelForPurpose({ role: 'review', harnesses: codexHarnesses, modelsByHarness: reviewModels, history: infraHistory, now: NOW, explore: false, shadow: false });
assert.deepEqual(infraOn.candidates, infraOff.candidates, 'high-infra ordering is identical');
assert.equal(infraOn.candidates[infraOn.candidates.length - 1].model, 'gpt-5.6-luna', 'high-infra pair stays demoted');

// ---------------------------------------------------------------------------
// Bounded work: p99 overhead <= 20ms over the bounded candidate set
// ---------------------------------------------------------------------------

const boundedCandidates = [];
for (let i = 0; i < 12; i += 1) {
  boundedCandidates.push(candidate('matched', i % 2 === 0 ? 'cheap' : 'pricey', 0.5 - (i * 0.001), {
    n: 10,
    median_min: 2 + i,
    median_tokens_per_sec: 50 - i,
  }));
}
for (let warm = 0; warm < 20; warm += 1) {
  scoreShadowCandidates({ role: 'implement', selected: boundedCandidates[0], candidates: boundedCandidates, now: NOW, config: { mode: 'shadow' }, priceFor: purePriceFor, identityOf });
}
const samples = [];
for (let i = 0; i < 300; i += 1) {
  const started = performance.now();
  scoreShadowCandidates({ role: 'implement', selected: boundedCandidates[0], candidates: boundedCandidates, now: NOW, config: { mode: 'shadow' }, priceFor: purePriceFor, identityOf });
  samples.push(performance.now() - started);
}
samples.sort((left, right) => left - right);
const p99 = samples[Math.min(samples.length - 1, Math.ceil(0.99 * samples.length) - 1)];
assert.ok(p99 <= MODEL_PICK_SHADOW_CONFIG_DEFAULTS.maxOverheadMs, `shadow p99 ${p99.toFixed(3)}ms must be <= 20ms`);

// ---------------------------------------------------------------------------
// MCP tool: additive shadow fields, line rendering untouched
// ---------------------------------------------------------------------------

const handlerClient = {
  async listHarnessCatalog() { return codexHarnesses; },
  async listHarnessModels({ harness }) { return codexModels[harness]; },
};
const handlers = createCretliMcpToolHandlers(handlerClient, { chatId: 'shadow-handler', mode: 'agent' });
const mcpPick = await handlers.model_pick({ role: 'implement' });
assert.equal(mcpPick.isError, false);
assert.ok(mcpPick.structuredContent.shadow_top, 'MCP model_pick exposes shadow_top');
assert.ok(mcpPick.structuredContent.shadow_explanation, 'MCP model_pick exposes shadow_explanation');
assert.equal(mcpPick.structuredContent.shadow_agreement.role, 'implement');
assert.ok(
  !String(mcpPick.content?.[0]?.text || '').includes('shadow'),
  'the rendered pick line is untouched',
);
const mcpNoShadow = await handlers.model_pick({ role: 'implement', shadow: false });
assert.equal(mcpNoShadow.isError, false);
assert.equal(mcpNoShadow.structuredContent.shadow_top, undefined, 'shadow:false returns the pre-shadow shape');

removeIsolatedDataDir();
console.log('model-pick-shadow.test.js OK');
