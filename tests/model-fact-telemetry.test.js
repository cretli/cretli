/**
 * Contract test for the stage-2 local model+harness telemetry
 * (`lib/model-facts/telemetry.js`).
 *
 * Covers the acceptance criteria: a measurement is never confused between
 * `actual` / `estimate` / `plan_usage`; a quota or infra failure never lowers
 * task quality; a subscription/local/unknown pair never receives an API USD
 * value; an unmatched identity gets no USD estimate; and cache read/write land
 * in their own disjoint buckets without double counting.
 *
 * Run: node tests/model-fact-telemetry.test.js
 */

import assert from 'node:assert/strict';
import {
  TELEMETRY_INFRA_PENALTY_RATIO,
  TELEMETRY_SHRINKAGE_HALF_LIFE,
  TELEMETRY_SUBSCRIPTION_HARNESSES,
  TELEMETRY_TOKEN_METRICS,
  billingClassAllowsUsd,
  buildLimitLink,
  buildModelHarnessTelemetry,
  buildPlanUsageFact,
  buildTaskQualityTelemetry,
  buildTokenFacts,
  buildUsdEstimateFact,
  normalizeTelemetryRunClass,
  planUsageRef,
  resolveTelemetryBillingClass,
} from '../lib/model-facts/telemetry.js';
import {
  INFRA_SCORE_PENALTY_RATIO,
  OBSERVED_BLEND_HALF_LIFE,
} from '../lib/model-role-profiles.js';
import {
  SCORING_FACT_SCHEMA_VERSION,
  factMayCarryUsd,
  factUsdValue,
} from '../lib/model-facts/schema.js';
import { billedTotalTokens } from '../lib/usage/usage-contract.js';

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

const CODEX = { harness: 'codex', model: 'gpt-5.6-sol' };

/** One extra alias so OpenRouter endpoint pricing can be a matched pair. */
const OPENROUTER_ALIASES = [
  {
    harness: 'openrouter',
    model: 'openai/gpt-4o',
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1',
    externalModelId: 'openai/gpt-4o',
    evidence: 'test',
  },
];

// ---------------------------------------------------------------------------
// 1. Billing class
// ---------------------------------------------------------------------------

check('an explicit billing class wins over every inferred signal', () => {
  assert.equal(resolveTelemetryBillingClass({
    billingClass: 'subscription_quota',
    harness: 'codex',
    provider: 'openai',
    reportedUsd: 3,
  }), 'subscription_quota');
  assert.equal(resolveTelemetryBillingClass({ billing_class: 'local', harness: 'codex' }), 'local');
  assert.equal(resolveTelemetryBillingClass({ billingClass: 'api_metered', harness: 'sdk' }), 'api_metered');
});

check('prepaid and local signals classify as subscription_quota / local', () => {
  assert.equal(resolveTelemetryBillingClass({ billingMode: 'subscription', harness: 'claude' }), 'subscription_quota');
  assert.equal(resolveTelemetryBillingClass({ harness: 'sdk' }), 'subscription_quota');
  assert.equal(resolveTelemetryBillingClass({ provider: 'cursor' }), 'subscription_quota');
  assert.equal(resolveTelemetryBillingClass({ local: true }), 'local');
  assert.equal(resolveTelemetryBillingClass({ provider: 'ollama' }), 'local');
});

check('metered providers and a provider-reported charge classify as api_metered', () => {
  assert.equal(resolveTelemetryBillingClass({ provider: 'openai' }), 'api_metered');
  assert.equal(resolveTelemetryBillingClass({ provider: 'azure' }), 'api_metered');
  assert.equal(resolveTelemetryBillingClass({ provider: 'openrouter' }), 'api_metered');
  assert.equal(resolveTelemetryBillingClass({ harness: 'codex', reportedUsd: 0 }), 'api_metered');
});

check('an unknown relationship stays unknown and may not carry USD', () => {
  assert.equal(resolveTelemetryBillingClass({ harness: 'claude', provider: 'other' }), 'unknown');
  assert.equal(resolveTelemetryBillingClass({}), 'unknown');
  assert.equal(billingClassAllowsUsd('unknown'), false);
  assert.equal(billingClassAllowsUsd('subscription_quota'), false);
  assert.equal(billingClassAllowsUsd('local'), false);
  assert.equal(billingClassAllowsUsd('api_metered'), true);
});

// ---------------------------------------------------------------------------
// 2. Cache buckets without double counting
// ---------------------------------------------------------------------------

check('codex cache read/write land in disjoint buckets', () => {
  const result = buildTokenFacts({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    at: '2026-10-01T00:00:00.000Z',
    provenance: 'reported',
    normalizationVersion: 'norm-2',
    tokens: { textInput: 1000, cachedInput: 400, cacheWrite: 50, textOutput: 250, reasoning: 30 },
  });
  assert.equal(result.buckets.inputWithoutCache, 1000);
  assert.equal(result.buckets.cacheRead, 400);
  assert.equal(result.buckets.cacheWrite, 50);
  assert.equal(result.buckets.outputWithoutReasoning, 220);
  assert.equal(result.buckets.reasoning, 30);
  assert.equal(result.buckets.reasoningDiagnostic, false);
  assert.equal(result.billed_tokens, 1700);
  const byMetric = Object.fromEntries(result.facts.map((fact) => [fact.metric, fact.value]));
  assert.equal(byMetric.cache_read_tokens, 400);
  assert.equal(byMetric.cache_write_tokens, 50);
  assert.equal(byMetric.input_tokens, 1000);
  assert.equal(byMetric.output_tokens, 220);
  assert.equal(byMetric.reasoning_tokens, 30);
  // The summed facts are exactly the billed total: no cache token is repeated.
  const summed = result.facts.reduce((total, fact) => total + Number(fact.value), 0);
  assert.equal(summed, result.billed_tokens);
  assert.equal(result.billed_tokens, billedTotalTokens(
    { textInput: 1000, cachedInput: 400, cacheWrite: 50, textOutput: 250, reasoning: 30 },
    'codex',
  ));
});

check('a bag whose input already includes cache subtracts it exactly once', () => {
  const result = buildTokenFacts({
    harness: 'sdk',
    model: 'gpt-5.6-sol',
    at: '2026-10-01T00:00:00.000Z',
    provenance: 'reported',
    tokens: { textInput: 1200, cachedInput: 900, cacheWrite: 50, textOutput: 80, reasoning: 20 },
  });
  // sdk stores an inclusive input counter, so cache must be removed from it.
  assert.equal(result.buckets.inputWithoutCache, 250);
  assert.equal(result.buckets.cacheRead, 900);
  assert.equal(result.buckets.cacheWrite, 50);
  assert.equal(result.buckets.outputWithoutReasoning, 60);
  assert.equal(result.billed_tokens, 1280);
  const summed = result.facts.reduce((total, fact) => total + Number(fact.value), 0);
  assert.equal(summed, result.billed_tokens);
});

check('a zero cache bucket emits no fact (absent is not zero)', () => {
  const result = buildTokenFacts({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    at: '2026-10-01T00:00:00.000Z',
    tokens: { textInput: 100, cachedInput: 0, cacheWrite: 0, textOutput: 10 },
  });
  const metrics = result.facts.map((fact) => fact.metric);
  assert.equal(metrics.includes('cache_read_tokens'), false);
  assert.equal(metrics.includes('cache_write_tokens'), false);
  for (const metric of metrics) assert.equal(TELEMETRY_TOKEN_METRICS.includes(metric), true);
});

check('token facts sum to billed_tokens with audio, cache and additive reasoning', () => {
  const result = buildTokenFacts({
    harness: 'opencode',
    model: 'qwen3-coder',
    at: '2026-10-01T00:00:00.000Z',
    provenance: 'reported',
    tokens: {
      textInput: 500,
      cachedInput: 300,
      cacheWrite: 40,
      textOutput: 20,
      reasoning: 5,
      audioInput: 11,
      audioOutput: 7,
    },
  });
  // `opencode` treats reasoning as separate (additive), so the reasoning fact
  // is emitted and billed on both sides.
  assert.equal(result.buckets.reasoningDiagnostic, false);
  assert.equal(result.facts.some((fact) => fact.metric === 'reasoning_tokens'), true);
  const summed = result.facts.reduce((total, fact) => total + Number(fact.value), 0);
  assert.equal(summed, result.billed_tokens);
  assert.equal(result.billed_tokens, 883);
});

check('token facts sum to billed_tokens when reasoning is diagnostic-only', () => {
  const result = buildTokenFacts({
    harness: 'qwen',
    model: 'qwen3-coder',
    at: '2026-10-01T00:00:00.000Z',
    provenance: 'reported',
    tokens: {
      textInput: 1000,
      cachedInput: 400,
      cacheWrite: 50,
      textOutput: 120,
      reasoning: 30,
      audioInput: 3,
      audioOutput: 2,
    },
  });
  // `qwen` reasoning is unknown (diagnostic): it is zeroed on both sides — no
  // fact is emitted and it never enters `billed_tokens`.
  assert.equal(result.buckets.reasoningDiagnostic, true);
  assert.equal(result.buckets.reasoning, 30);
  assert.equal(result.facts.some((fact) => fact.metric === 'reasoning_tokens'), false);
  const summed = result.facts.reduce((total, fact) => total + Number(fact.value), 0);
  assert.equal(summed, result.billed_tokens);
  assert.equal(result.billed_tokens, 1575);
});

// ---------------------------------------------------------------------------
// 3. actual / estimate / plan_usage are never confused
// ---------------------------------------------------------------------------

check('a reported token measurement is an actual, an estimated one is not', () => {
  const reported = buildTokenFacts({
    ...CODEX,
    at: '2026-10-01T00:00:00.000Z',
    provenance: 'reported',
    tokens: { textInput: 10, textOutput: 5 },
  }).facts[0];
  assert.equal(reported.kind, 'actual');
  assert.equal(reported.source_class, 'provider_actual');
  assert.equal(reported.confidence, 1);
  assert.equal(reported.source_version, '');

  const estimated = buildTokenFacts({
    ...CODEX,
    at: '2026-10-01T00:00:00.000Z',
    provenance: 'estimated',
    tokens: { textInput: 10, textOutput: 5 },
  }).facts[0];
  assert.equal(estimated.kind, 'estimate');
  assert.equal(estimated.source_class, 'ledger_estimate');
  assert.equal(estimated.confidence, 0.5);
});

check('a token fact carries source, source version and both timestamps', () => {
  const fact = buildTokenFacts(
    {
      ...CODEX,
      at: '2026-10-01T00:00:00.000Z',
      provenance: 'reported',
      normalizationVersion: 'norm-2',
      tokens: { textInput: 10, textOutput: 5 },
    },
    { source: 'usage-ledger', sourceVersion: 'ledger-3', fetchedAt: '2026-10-02T00:00:00.000Z' },
  ).facts[0];
  assert.equal(fact.source, 'usage-ledger');
  assert.equal(fact.source_version, 'ledger-3');
  assert.equal(fact.observed_at, '2026-10-01T00:00:00.000Z');
  assert.equal(fact.fetched_at, '2026-10-02T00:00:00.000Z');
});

check('reported USD is actual, rate-table USD stays an estimate', () => {
  const reported = buildUsdEstimateFact({ ...CODEX, reportedUsd: 0.5, at: '2026-10-01T00:00:00.000Z' });
  assert.equal(reported.kind, 'actual');
  assert.equal(reported.source_class, 'provider_actual');
  assert.equal(reported.metric, 'usd');
  assert.equal(reported.unit, 'usd');
  assert.equal(factUsdValue(reported), 0.5);

  const estimated = buildUsdEstimateFact({
    ...CODEX,
    provider: 'openai',
    usd: 0.25,
    at: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(estimated.kind, 'estimate');
  assert.equal(estimated.source_class, 'ledger_estimate');
  assert.equal(factUsdValue(estimated), 0.25);
});

check('a plan reading is plan_usage in plan units and is never USD', () => {
  const plan = buildPlanUsageFact({
    harness: 'claude',
    utilization: 72.5,
    resetsAt: '2026-10-09T00:00:00.000Z',
    observedAt: '2026-10-08T00:00:00.000Z',
  });
  assert.equal(plan.kind, 'plan_usage');
  assert.equal(plan.metric, 'plan_utilization');
  assert.equal(plan.unit, 'percent');
  assert.equal(plan.value, 72.5);
  assert.equal(plan.billing_class, 'subscription_quota');
  assert.equal(factMayCarryUsd(plan), false);
  assert.equal(factUsdValue(plan), null);
});

check('a status-only plan reading stays plan_usage and never becomes money', () => {
  const plan = buildPlanUsageFact({
    harness: 'claude',
    status: 'rejected',
    rateLimitType: 'five_hour',
    observedAt: '2026-10-08T00:00:00.000Z',
  });
  assert.equal(plan.kind, 'plan_usage');
  assert.equal(plan.metric, 'plan_signal');
  assert.equal(plan.unit, 'state');
  assert.equal(plan.value, 'rejected');
  assert.equal(factMayCarryUsd(plan), false);
  assert.equal(buildPlanUsageFact({ harness: 'claude' }), null);
});

// ---------------------------------------------------------------------------
// 4. Subscription never gets an API USD estimate
// ---------------------------------------------------------------------------

check('a subscription plan never receives API USD', () => {
  assert.equal(buildUsdEstimateFact({ ...CODEX, harness: 'sdk', usd: 5 }), null);
  assert.equal(buildUsdEstimateFact({ ...CODEX, provider: 'cursor', usd: 5 }), null);
  assert.equal(buildUsdEstimateFact({
    ...CODEX,
    harness: 'claude',
    billingMode: 'subscription',
    reportedUsd: 5,
  }), null);
  assert.equal(buildUsdEstimateFact({ ...CODEX, billingClass: 'subscription_quota', usd: 5 }), null);
  assert.equal(buildUsdEstimateFact({ ...CODEX, billingClass: 'local', usd: 5 }), null);
  assert.equal(buildUsdEstimateFact({ ...CODEX, billingClass: 'unknown', usd: 5 }), null);
});

check('an OpenRouter endpoint catalog price is metered, not a subscription', () => {
  const fact = buildUsdEstimateFact(
    {
      harness: 'openrouter',
      model: 'openai/gpt-4o',
      provider: 'openrouter',
      usd: 0.42,
      at: '2026-10-01T00:00:00.000Z',
    },
    { aliases: OPENROUTER_ALIASES, sourceClass: 'endpoint_catalog', source: 'openrouter-catalog' },
  );
  assert.equal(fact.billing_class, 'api_metered');
  assert.equal(fact.source_class, 'endpoint_catalog');
  assert.equal(fact.kind, 'estimate');
  assert.equal(factMayCarryUsd(fact), true);
  assert.equal(factUsdValue(fact), 0.42);
});

check('an OpenRouter endpoint price on a prepaid plan still charges nothing', () => {
  assert.equal(buildUsdEstimateFact(
    {
      harness: 'openrouter',
      model: 'openai/gpt-4o',
      provider: 'openrouter',
      billingMode: 'subscription',
      usd: 0.42,
      at: '2026-10-01T00:00:00.000Z',
    },
    { aliases: OPENROUTER_ALIASES, sourceClass: 'endpoint_catalog' },
  ), null);
});

// ---------------------------------------------------------------------------
// 5. Unmatched identity gets no USD estimate
// ---------------------------------------------------------------------------

check('an unmatched identity gets no USD estimate, not USD 0', () => {
  const fact = buildUsdEstimateFact({ harness: 'codex', model: 'not-a-real-model', reportedUsd: 3 });
  assert.equal(fact, null);
  const matched = buildUsdEstimateFact({ ...CODEX, reportedUsd: 3 });
  assert.equal(factMayCarryUsd(matched), true);
  assert.equal(factUsdValue(matched), 3);
});

check('the USD estimate uses the stage-1 identity registry, not the raw name', () => {
  const unmatchedHarness = buildUsdEstimateFact({ harness: 'sdk2', model: 'gpt-5.6-sol', reportedUsd: 3 });
  assert.equal(unmatchedHarness, null);
});

// ---------------------------------------------------------------------------
// 6. Quality vs infra/quota failures
// ---------------------------------------------------------------------------

check('an infra or quota failure never lowers task quality', () => {
  const base = buildTaskQualityTelemetry({
    ...CODEX,
    role: 'implement',
    decided: 4,
    passed: 3,
    n: 5,
    infraFails: 1,
    priorInfra: 0.2,
  });
  const withFailures = buildTaskQualityTelemetry({
    ...CODEX,
    role: 'implement',
    decided: 4,
    passed: 3,
    n: 7,
    infraFails: 2,
    quotaFails: 1,
    priorInfra: 0.2,
  });
  assert.equal(base.quality, withFailures.quality);
  assert.equal(base.quality_rate, withFailures.quality_rate);
  assert.equal(base.n_quality, withFailures.n_quality);
  assert.equal(base.quality, 4);
  assert.equal(withFailures.infra_rate > base.infra_rate, true);
  assert.equal(withFailures.quota_rate > 0, true);
  assert.equal(base.quota_rate, 0);
});

check('quality failures and infra failures are separate facts', () => {
  const result = buildTaskQualityTelemetry({
    ...CODEX,
    role: 'implement',
    decided: 2,
    passed: 1,
    n: 4,
    infraFails: 2,
    sourceVersion: 'stats-1',
    observedAt: '2026-10-01T00:00:00.000Z',
  });
  const byMetric = Object.fromEntries(result.facts.map((fact) => [fact.metric, fact]));
  assert.equal(byMetric.quality.kind, 'estimate');
  assert.equal(byMetric.quality.value, 3);
  // The failure rates are derived from ledger counts, so `kindFromProvenance`
  // makes them estimates even though the counts themselves were reported.
  assert.equal(byMetric.infra_fail_rate.kind, 'estimate');
  assert.equal(byMetric.infra_fail_rate.source_class, 'ledger_estimate');
  assert.equal(byMetric.infra_fail_rate.value, 0.5);
  assert.equal(byMetric.quality.source_version, 'stats-1');
  assert.equal(byMetric.quality.observed_at, '2026-10-01T00:00:00.000Z');
  const quota = Object.fromEntries(buildTaskQualityTelemetry({
    ...CODEX,
    role: 'implement',
    decided: 2,
    passed: 1,
    n: 4,
    infraFails: 1,
    quotaFails: 1,
  }).facts.map((fact) => [fact.metric, fact]));
  assert.equal(quota.infra_fail_rate.kind, 'estimate');
  assert.equal(quota.quota_fail_rate.kind, 'estimate');
  assert.equal(quota.quota_fail_rate.source_class, 'ledger_estimate');
  // No verdict-based pass rate may leak into a quality metric.
  for (const fact of result.facts) assert.equal(fact.metric.includes('verdict'), false);
  assert.equal(result.facts.some((fact) => fact.metric === 'pass_rate'), false);
});

check('review quality is recorded but is not ranking eligible', () => {
  const review = buildTaskQualityTelemetry({ ...CODEX, role: 'review', decided: 4, passed: 4, n: 4 });
  assert.equal(review.quality_ranking_eligible, false);
  const implement = buildTaskQualityTelemetry({ ...CODEX, role: 'implement', decided: 4, passed: 3, n: 4 });
  assert.equal(implement.quality_ranking_eligible, true);
});

// ---------------------------------------------------------------------------
// 7. Shrinkage and infra prior are preserved
// ---------------------------------------------------------------------------

check('the shrink weight and infra prior mirror the existing role profile', () => {
  assert.equal(TELEMETRY_SHRINKAGE_HALF_LIFE, OBSERVED_BLEND_HALF_LIFE);
  assert.equal(TELEMETRY_SHRINKAGE_HALF_LIFE, 10);
  assert.equal(TELEMETRY_INFRA_PENALTY_RATIO, INFRA_SCORE_PENALTY_RATIO);
  assert.equal(TELEMETRY_INFRA_PENALTY_RATIO, 0.5);
  const full = buildTaskQualityTelemetry({
    ...CODEX,
    role: 'implement',
    decided: 10,
    passed: 8,
    n: 20,
    infraFails: 10,
    priorInfra: 0.2,
  });
  // The full task counter (including infra/quota) drives the weight, exactly
  // like `row.n` in `lib/model-role-profiles.js`; using `decided` alone would
  // wrongly pin 0.5 here.
  assert.equal(full.shrink_weight, 20 / (20 + TELEMETRY_SHRINKAGE_HALF_LIFE));
  assert.equal(full.shrink_weight, 2 / 3);
  assert.equal(full.infra_rate, 0.5);
  assert.equal(full.infra_eff, (0.2 * (1 - (20 / 30))) + (0.5 * (20 / 30)));
  const empty = buildTaskQualityTelemetry({ ...CODEX, role: 'implement' });
  assert.equal(empty.shrink_weight, 0);
  assert.equal(empty.infra_eff, 0);
  assert.equal(empty.quality, null);
  assert.equal(empty.facts.length, 0);
});

check('an explicit n of zero wins over the decided/failure fallback', () => {
  // A caller that explicitly reports zero tasks must not be overridden by the
  // decided + infra + quota fallback; the weight and rates stay zero.
  const zero = buildTaskQualityTelemetry({
    ...CODEX,
    role: 'implement',
    n: 0,
    decided: 1,
    passed: 1,
    infraFails: 3,
    priorInfra: 0.4,
  });
  assert.equal(zero.n, 0);
  assert.equal(zero.shrink_weight, 0);
  assert.equal(zero.infra_rate, 0);
  // w = 0 leaves the prior untouched: infra_eff == prior_infra.
  assert.equal(zero.infra_eff, 0.4);
  const fallback = buildTaskQualityTelemetry({
    ...CODEX,
    role: 'implement',
    n: null,
    decided: 10,
    passed: 8,
    infraFails: 10,
    priorInfra: 0.2,
  });
  assert.equal(fallback.n, 20);
  assert.equal(fallback.shrink_weight, 20 / (20 + TELEMETRY_SHRINKAGE_HALF_LIFE));
});

// ---------------------------------------------------------------------------
// 8. Plan usage / limits link and composed record
// ---------------------------------------------------------------------------

check('a plan reading links back to the exact sample it came from', () => {
  const reading = {
    harness: 'claude',
    model: 'claude-sonnet-4',
    utilization: 88,
    resetsAt: '2026-10-09T00:00:00.000Z',
    observedAt: '2026-10-08T00:00:00.000Z',
  };
  const link = buildLimitLink(reading);
  assert.equal(link.kind, 'plan_usage');
  assert.equal(link.ref, planUsageRef(reading));
  assert.equal(link.utilization, 88);
  assert.equal(link.observed_at, '2026-10-08T00:00:00.000Z');
  assert.equal(link.resets_at, '2026-10-09T00:00:00.000Z');
  const fact = buildPlanUsageFact(reading);
  assert.equal(link.fact_id, fact.fact_id);

  const lockout = buildLimitLink({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    resetAt: '2026-10-09T00:00:00.000Z',
    code: 'usage_limit',
  });
  assert.equal(lockout.kind, 'lockout');
  assert.equal(lockout.fact_id, null);
  assert.equal(lockout.ref, 'lockout|codex|gpt-5.6-sol|2026-10-09T00:00:00.000Z|usage_limit');
});

check('a status-only plan row links as plan_usage, never as a lockout', () => {
  // Stage 4 passes a binary lockout record as `input.lockout`, but a plan row
  // that carries an `observedAt`/`rateLimitType` still classifies as plan_usage.
  const reading = {
    harness: 'claude',
    model: 'claude-sonnet-4',
    status: 'rejected',
    rateLimitType: 'five_hour',
    observedAt: '2026-10-08T00:00:00.000Z',
  };
  const link = buildLimitLink(reading);
  assert.equal(link.kind, 'plan_usage');
  const fact = buildPlanUsageFact(reading);
  assert.equal(fact.metric, 'plan_signal');
  assert.equal(link.fact_id, 'plan_usage|claude|claude-sonnet-4|five_hour|none|2026-10-08T00:00:00.000Z');
  assert.equal(link.fact_id, fact.fact_id);
});

check('a binary lockout record links as lockout with an exact ref', () => {
  // Shape of `appendLimitHistory` in `lib/harness-usage-limits.js`: a binary
  // block with `{ resetAt, code }` and no plan-reading fields.
  const link = buildLimitLink({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    resetAt: '2026-10-09T00:00:00.000Z',
    code: 'usage_limit',
  });
  assert.equal(link.kind, 'lockout');
  assert.equal(link.ref, 'lockout|codex|gpt-5.6-sol|2026-10-09T00:00:00.000Z|usage_limit');
  assert.equal(link.fact_id, null);
  assert.equal(link.status, 'usage_limit');
});

check('a composed record carries the plan link, cache facts and USD fact id', () => {
  const record = buildModelHarnessTelemetry({
    ...CODEX,
    usageEvent: {
      ...CODEX,
      at: '2026-10-01T00:00:00.000Z',
      provenance: 'reported',
      reportedUsd: 0.5,
      tokens: { textInput: 100, cachedInput: 20, cacheWrite: 5, textOutput: 10 },
    },
    planReading: {
      harness: 'codex',
      utilization: 80,
      observedAt: '2026-10-01T00:00:00.000Z',
    },
    outcome: { role: 'implement', decided: 2, passed: 2, n: 2 },
    runClass: 'quality',
  });
  assert.equal(record.telemetry_version, 'model-telemetry-2026-10-08');
  assert.equal(record.alias_status, 'matched');
  assert.equal(record.billing_class, 'api_metered');
  assert.equal(record.schema_version, SCORING_FACT_SCHEMA_VERSION);
  // Full fact ids, not existence-only: identity key + kind + metric + source +
  // observed-at.
  assert.equal(
    record.usd_fact_id,
    'codex\u0000gpt-5.6-sol\u0000|actual|usd|usage-ledger|2026-10-01T00:00:00.000Z',
  );
  assert.equal(
    record.plan_usage_fact_id,
    'plan_usage|codex|gpt-5.6-sol|all|none|2026-10-01T00:00:00.000Z',
  );
  assert.equal(record.limit_ref, 'plan_usage|codex|gpt-5.6-sol|all|none|2026-10-01T00:00:00.000Z');
  assert.equal(record.limit_ref, record.plan_usage_fact_id);
  assert.equal(record.quality.quality, 5);
  assert.equal(record.token_buckets.cacheRead, 20);
  assert.equal(record.token_buckets.cacheWrite, 5);
  const metrics = record.facts.map((fact) => fact.metric);
  assert.equal(metrics.includes('cache_read_tokens'), true);
  assert.equal(metrics.includes('cache_write_tokens'), true);
  assert.equal(metrics.includes('usd'), true);
  assert.equal(metrics.includes('plan_utilization'), true);
});

check('a record with no usage event classifies billing from identity only', () => {
  // Temporary classification: with no usage event there is no proof of a
  // charge, so the class falls back to the resolved identity provider alone.
  const record = buildModelHarnessTelemetry({ ...CODEX });
  assert.equal(record.provider, 'openai');
  assert.equal(record.billing_class, 'api_metered');
  assert.equal(record.facts.length, 0);
  assert.equal(record.usd_fact_id, null);
});

check('an unmatched record exposes no USD fact id but keeps the facts', () => {
  const record = buildModelHarnessTelemetry({
    harness: 'codex',
    model: 'not-a-real-model',
    usageEvent: {
      harness: 'codex',
      model: 'not-a-real-model',
      at: '2026-10-01T00:00:00.000Z',
      reportedUsd: 0.5,
      tokens: { textInput: 100, textOutput: 10 },
    },
  });
  assert.equal(record.alias_status, 'unmatched');
  assert.equal(record.usd_fact_id, null);
  assert.equal(record.facts.some((fact) => fact.metric === 'usd'), false);
});

check('run classes stay inside the documented set', () => {
  assert.equal(normalizeTelemetryRunClass('infra'), 'infra');
  assert.equal(normalizeTelemetryRunClass('quota'), 'quota');
  assert.equal(normalizeTelemetryRunClass('cancel'), 'cancel');
  assert.equal(normalizeTelemetryRunClass('nonsense'), 'quality');
  assert.equal(normalizeTelemetryRunClass(undefined), 'quality');
  assert.equal(TELEMETRY_SUBSCRIPTION_HARNESSES.includes('sdk'), true);
});

console.log(`model-fact-telemetry: ${checks} checks passed`);
