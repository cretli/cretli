/**
 * Contract test for the shared scoring/usage fact schema (stage 1 of `2584cd05`).
 *
 * Covers the acceptance criteria: exact alias match, unmatched alias, alias
 * conflicts, the fact schema/enums, the USD/billing-class gate and the source
 * precedence rules. Also guards that the new modules never join names by
 * substring and never build a candidate set.
 *
 * Run: node tests/model-fact-schema.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALIAS_REASONS,
  ALIAS_STATUSES,
  DEFAULT_MODEL_IDENTITY_ALIASES,
  MODEL_IDENTITY_SCHEMA_VERSION,
  buildModelIdentityIndex,
  modelIdentityKey,
  resolveModelIdentity,
} from '../lib/model-facts/identity.js';
import {
  SCORING_FACT_BILLING_CLASSES,
  SCORING_FACT_CANDIDATE_GATE,
  SCORING_FACT_KINDS,
  SCORING_FACT_SCHEMA_VERSION,
  SCORING_FACT_SOURCE_CLASSES,
  compareScoringFacts,
  createScoringFact,
  describeScoringFactPrecedence,
  factInfluencesRanking,
  factMayCarryUsd,
  factUsdValue,
  normalizeBillingClass,
  normalizeScoringFactKind,
  normalizeSourceClass,
  resolvePreferredFact,
  selectPreferredFacts,
} from '../lib/model-facts/schema.js';
import * as factSchema from '../lib/model-facts/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

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

/** Two custom aliases used by the conflict and variant tests. */
const CUSTOM_ALIASES = [
  {
    harness: 'codex',
    model: 'model-a',
    variantNeutral: true,
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    externalModelId: 'model-a',
    evidence: 'test',
  },
  {
    harness: 'codex',
    model: 'model-b',
    variant: 'low',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    externalModelId: 'model-b-low',
    evidence: 'test',
  },
];

// ---------------------------------------------------------------------------
// 1. Exact alias match
// ---------------------------------------------------------------------------

check('exact match resolves provider endpoint and external model id', () => {
  const resolved = resolveModelIdentity({ harness: 'codex', model: 'gpt-5.6-sol' });
  assert.equal(resolved.aliasStatus, 'matched');
  assert.equal(resolved.aliasReason, 'exact-match');
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.endpoint, 'https://api.openai.com/v1');
  assert.equal(resolved.externalModelId, 'gpt-5.6-sol');
  assert.deepEqual(resolved.conflicts, []);
});

check('exact match is case- and whitespace-insensitive per key part', () => {
  const resolved = resolveModelIdentity({ harness: ' Codex ', model: ' GPT-5.6-SOL ' });
  assert.equal(resolved.aliasStatus, 'matched');
  assert.equal(resolved.externalModelId, 'gpt-5.6-sol');
  assert.equal(resolved.identityKey, modelIdentityKey('codex', 'gpt-5.6-sol'));
});

check('declared variant-neutral row covers an effort variant exactly once', () => {
  const resolved = resolveModelIdentity({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    variant: 'effort=high',
  });
  assert.equal(resolved.aliasStatus, 'matched');
  assert.equal(resolved.aliasReason, 'exact-variant-neutral');
  assert.equal(resolved.externalModelId, 'gpt-5.6-sol');
});

check('same model on another harness is an unmatched separate pair', () => {
  const resolved = resolveModelIdentity({ harness: 'sdk', model: 'gpt-5.6-sol' });
  assert.equal(resolved.aliasStatus, 'unmatched');
  assert.equal(resolved.aliasReason, 'no-exact-alias');
  assert.equal(resolved.endpoint, null);
});

check('a non-neutral row matches only its literal variant', () => {
  const options = { aliases: CUSTOM_ALIASES };
  assert.equal(resolveModelIdentity({ harness: 'codex', model: 'model-b', variant: 'low' }, options).aliasStatus, 'matched');
  assert.equal(resolveModelIdentity({ harness: 'codex', model: 'model-b' }, options).aliasStatus, 'unmatched');
  const high = resolveModelIdentity({ harness: 'codex', model: 'model-b', variant: 'high' }, options);
  assert.equal(high.aliasStatus, 'unmatched');
  assert.equal(high.aliasReason, 'no-exact-alias');
});

check('default table is wired to real codex catalog ids', () => {
  assert.equal(DEFAULT_MODEL_IDENTITY_ALIASES.length >= 1, true);
  for (const row of DEFAULT_MODEL_IDENTITY_ALIASES) {
    assert.equal(typeof row.evidence, 'string');
    assert.equal(row.evidence.length > 0, true);
  }
});

// ---------------------------------------------------------------------------
// 2. Unmatched alias
// ---------------------------------------------------------------------------

check('an unknown model resolves to unmatched with no endpoint', () => {
  const resolved = resolveModelIdentity({ harness: 'codex', model: 'not-a-real-model' });
  assert.equal(resolved.aliasStatus, 'unmatched');
  assert.equal(resolved.aliasReason, 'no-exact-alias');
  assert.equal(resolved.provider, null);
  assert.equal(resolved.externalModelId, null);
});

check('missing harness or model resolves to unmatched/missing-identity', () => {
  assert.equal(resolveModelIdentity({ harness: 'codex' }).aliasReason, 'missing-identity');
  assert.equal(resolveModelIdentity({ model: 'gpt-5.6-sol' }).aliasReason, 'missing-identity');
  assert.equal(resolveModelIdentity({}).aliasStatus, 'unmatched');
});

check('an unmatched alias never influences ranking', () => {
  const fact = createScoringFact({
    harness: 'codex',
    model: 'not-a-real-model',
    kind: 'actual',
    metric: 'quality',
    source: 'swe-rebench',
  });
  assert.equal(fact.alias_status, 'unmatched');
  assert.equal(fact.ranking_eligible, false);
  assert.equal(factInfluencesRanking(fact), false);
  const result = selectPreferredFacts([fact]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.ignored.length, 1);
  assert.equal(result.ignored[0].reason, 'unmatched-alias');
});

// ---------------------------------------------------------------------------
// 3. Conflicting aliases
// ---------------------------------------------------------------------------

check('two different mappings for one key resolve to conflicting-alias', () => {
  const aliases = [
    ...CUSTOM_ALIASES,
    {
      harness: 'codex',
      model: 'model-a',
      variantNeutral: true,
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      externalModelId: 'model-a-anthropic',
      evidence: 'test',
    },
  ];
  const resolved = resolveModelIdentity({ harness: 'codex', model: 'model-a' }, { aliases });
  assert.equal(resolved.aliasStatus, 'unmatched');
  assert.equal(resolved.aliasReason, 'conflicting-alias');
  assert.equal(resolved.provider, null);
  assert.equal(resolved.conflicts.length, 2);
  const endpoints = resolved.conflicts.map((row) => row.endpoint).sort();
  assert.deepEqual(endpoints, [
    'https://api.anthropic.com/v1',
    'https://api.openai.com/v1',
  ]);
});

check('duplicate identical rows collapse instead of conflicting', () => {
  const aliases = [...CUSTOM_ALIASES, { ...CUSTOM_ALIASES[0] }];
  const index = buildModelIdentityIndex(aliases);
  const resolved = index.resolve({ harness: 'codex', model: 'model-a' });
  assert.equal(resolved.aliasStatus, 'matched');
  assert.equal(resolved.conflicts.length, 0);
});

check('a conflicting alias is dropped from ranking', () => {
  const aliases = [
    ...CUSTOM_ALIASES,
    {
      harness: 'codex',
      model: 'model-a',
      variantNeutral: true,
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      externalModelId: 'model-a-anthropic',
      evidence: 'test',
    },
  ];
  const fact = createScoringFact(
    { harness: 'codex', model: 'model-a', kind: 'estimate', metric: 'usd', source: 'x' },
    { aliases },
  );
  assert.equal(fact.alias_status, 'unmatched');
  assert.equal(fact.alias_reason, 'conflicting-alias');
  assert.equal(selectPreferredFacts([fact]).selected.length, 0);
});

check('incomplete alias rows grant no identity', () => {
  const aliases = [{ harness: 'codex', model: 'model-x', provider: 'openai' }];
  const index = buildModelIdentityIndex(aliases);
  assert.equal(index.rows.length, 0);
  assert.equal(index.resolve({ harness: 'codex', model: 'model-x' }).aliasStatus, 'unmatched');
});

// ---------------------------------------------------------------------------
// 4. Fact schema and enums
// ---------------------------------------------------------------------------

check('schema, kind and billing enums are versioned and stable', () => {
  assert.equal(SCORING_FACT_SCHEMA_VERSION, 'scoring-fact-2026-10-08');
  assert.equal(MODEL_IDENTITY_SCHEMA_VERSION, 'model-identity-2026-10-08');
  assert.deepEqual([...SCORING_FACT_KINDS], ['actual', 'estimate', 'plan_usage', 'benchmark']);
  assert.deepEqual([...SCORING_FACT_BILLING_CLASSES], [
    'api_metered',
    'subscription_quota',
    'local',
    'unknown',
  ]);
  assert.deepEqual([...SCORING_FACT_SOURCE_CLASSES], [
    'provider_actual',
    'ledger_estimate',
    'endpoint_catalog',
    'heuristic',
  ]);
  assert.deepEqual([...ALIAS_STATUSES], ['matched', 'unmatched']);
  assert.equal(ALIAS_REASONS.length > 0, true);
});

check('unknown enum values fall back safely', () => {
  assert.equal(normalizeScoringFactKind('nonsense'), 'estimate');
  assert.equal(normalizeBillingClass('nonsense'), 'unknown');
  assert.equal(normalizeSourceClass('nonsense'), 'heuristic');
});

check('createScoringFact stamps provenance, version and alias status', () => {
  const fact = createScoringFact({
    kind: 'actual',
    metric: 'latency_ms',
    source: 'delegation-metrics',
    sourceClass: 'ledger_estimate',
    sourceVersion: 'ledger-3',
    observedAt: '2026-10-01T10:00:00.000Z',
    fetchedAt: '2026-10-02T10:00:00.000Z',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    variant: 'effort=high',
    confidence: 2,
    billingClass: 'api_metered',
    value: 1234,
  });
  assert.equal(fact.schema_version, SCORING_FACT_SCHEMA_VERSION);
  assert.equal(fact.kind, 'actual');
  assert.equal(fact.metric, 'latency_ms');
  assert.equal(fact.unit, 'ms');
  assert.equal(fact.source_version, 'ledger-3');
  assert.equal(fact.observed_at, '2026-10-01T10:00:00.000Z');
  assert.equal(fact.fetched_at, '2026-10-02T10:00:00.000Z');
  assert.equal(fact.confidence, 1);
  assert.equal(fact.billing_class, 'api_metered');
  assert.equal(fact.alias_status, 'matched');
  assert.equal(fact.ranking_eligible, true);
  assert.equal(fact.provider_endpoint, 'https://api.openai.com/v1');
  assert.equal(fact.external_model_id, 'gpt-5.6-sol');
  assert.equal(fact.value, 1234);
});

check('a caller cannot assert alias_status; the registry decides', () => {
  const fact = createScoringFact({
    harness: 'sdk',
    model: 'gpt-5.6-sol',
    aliasStatus: 'matched',
    rankingEligible: true,
  });
  assert.equal(fact.alias_status, 'unmatched');
  assert.equal(fact.ranking_eligible, false);
});

check('fetched_at defaults to observed_at and confidence per kind', () => {
  const fact = createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'estimate',
    metric: 'usd',
    observedAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(fact.fetched_at, '2026-10-01T00:00:00.000Z');
  assert.equal(fact.confidence, 0.5);
  assert.equal(fact.unit, 'usd');
});

// ---------------------------------------------------------------------------
// 5. Billing class and USD gate
// ---------------------------------------------------------------------------

check('only matched api_metered facts may carry usd', () => {
  const metered = createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'estimate',
    metric: 'usd',
    sourceClass: 'ledger_estimate',
    billingClass: 'api_metered',
    value: 0.25,
  });
  assert.equal(factMayCarryUsd(metered), true);
  assert.equal(factUsdValue(metered), 0.25);

  const subscription = createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'actual',
    metric: 'usd',
    sourceClass: 'provider_actual',
    billingClass: 'subscription_quota',
    value: 12,
  });
  assert.equal(factMayCarryUsd(subscription), false);
  assert.equal(factUsdValue(subscription), null);
  const result = selectPreferredFacts([subscription]);
  assert.equal(result.selected.length, 0);
  assert.equal(result.ignored[0].reason, 'billing-class-not-metered');

  const local = createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'actual',
    metric: 'usd',
    billingClass: 'local',
    value: 1,
  });
  assert.equal(factMayCarryUsd(local), false);
});

check('plan_usage is never usd even when metered', () => {
  const plan = createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'plan_usage',
    metric: 'usd',
    billingClass: 'api_metered',
    value: 99,
  });
  assert.equal(factMayCarryUsd(plan), false);
  assert.equal(factUsdValue(plan), null);
});

check('a plan_usage usd fact is dropped by the billing gate', () => {
  const usd = createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'actual',
    metric: 'usd',
    sourceClass: 'provider_actual',
    billingClass: 'api_metered',
    value: 3,
  });
  const plan = createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'plan_usage',
    metric: 'usd',
    billingClass: 'subscription_quota',
    value: 40,
  });
  const result = selectPreferredFacts([usd, plan]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].kind, 'actual');
  assert.equal(result.ignored[0].reason, 'billing-class-not-metered');
});

// ---------------------------------------------------------------------------
// 6. Source precedence
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} overrides
 * @returns {ReturnType<typeof createScoringFact>}
 */
function factFor(overrides) {
  return createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'estimate',
    metric: 'usd',
    billingClass: 'api_metered',
    source: 'source',
    sourceClass: 'heuristic',
    value: 1,
    ...overrides,
  });
}

check('provider actual beats a newer ledger estimate', () => {
  const actual = factFor({
    kind: 'actual',
    sourceClass: 'provider_actual',
    source: 'provider-invoice',
    observedAt: '2026-01-01T00:00:00.000Z',
    value: 5,
  });
  const ledger = factFor({
    sourceClass: 'ledger_estimate',
    source: 'usage-ledger',
    observedAt: '2026-10-01T00:00:00.000Z',
    value: 1,
  });
  const winner = selectPreferredFacts([ledger, actual]).selected[0];
  assert.equal(winner.source, 'provider-invoice');
  assert.equal(compareScoringFacts(actual, ledger) < 0, true);
});

check('ledger estimate beats an endpoint catalog price', () => {
  const ledger = factFor({ sourceClass: 'ledger_estimate', source: 'usage-ledger' });
  const catalog = factFor({ sourceClass: 'endpoint_catalog', source: 'openrouter-catalog' });
  assert.equal(selectPreferredFacts([catalog, ledger]).selected[0].source, 'usage-ledger');
});

check('endpoint catalog price beats a heuristic', () => {
  const catalog = factFor({ sourceClass: 'endpoint_catalog', source: 'openrouter-catalog' });
  const heuristic = factFor({ sourceClass: 'heuristic', source: 'static' });
  assert.equal(selectPreferredFacts([heuristic, catalog]).selected[0].source, 'openrouter-catalog');
});

check('freshness breaks ties only inside one source class', () => {
  const older = factFor({ sourceClass: 'ledger_estimate', observedAt: '2026-01-01T00:00:00.000Z', source: 'a' });
  const newer = factFor({ sourceClass: 'ledger_estimate', observedAt: '2026-06-01T00:00:00.000Z', source: 'b' });
  assert.equal(selectPreferredFacts([older, newer]).selected[0].source, 'b');
});

check('confidence and fact_id break remaining ties deterministically', () => {
  const low = factFor({ sourceClass: 'ledger_estimate', confidence: 0.2, source: 'x', factId: 'a' });
  const high = factFor({ sourceClass: 'ledger_estimate', confidence: 0.9, source: 'x', factId: 'b' });
  assert.equal(selectPreferredFacts([low, high]).selected[0].fact_id, 'b');
  const first = factFor({ sourceClass: 'ledger_estimate', source: 'x', factId: 'a' });
  const second = factFor({ sourceClass: 'ledger_estimate', source: 'x', factId: 'b' });
  assert.equal(selectPreferredFacts([second, first]).selected[0].fact_id, 'a');
});

check('an undeclared source class ranks last and normalizes to heuristic', () => {
  const unknown = { source_class: 'not-a-class', source: 'mystery', fact_id: 'm' };
  const heuristic = { source_class: 'heuristic', source: 'static', fact_id: 'h' };
  assert.equal(compareScoringFacts(unknown, heuristic) > 0, true);
  assert.equal(normalizeSourceClass('not-a-class'), 'heuristic');
  const created = factFor({ sourceClass: 'not-a-class', source: 'mystery' });
  assert.equal(created.source_class, 'heuristic');
});

check('resolvePreferredFact returns the winner for one exact group', () => {
  const ledger = factFor({ sourceClass: 'ledger_estimate', source: 'usage-ledger', value: 2 });
  const catalog = factFor({ sourceClass: 'endpoint_catalog', source: 'openrouter-catalog', value: 3 });
  const winner = resolvePreferredFact([catalog, ledger], {
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'estimate',
    metric: 'usd',
  });
  assert.equal(winner.source, 'usage-ledger');
  const missing = resolvePreferredFact([catalog, ledger], {
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'benchmark',
    metric: 'quality',
  });
  assert.equal(missing, null);
});

check('precedence table is documented and ordered', () => {
  const table = describeScoringFactPrecedence();
  assert.deepEqual(table.map((row) => row.sourceClass), [...SCORING_FACT_SOURCE_CLASSES]);
  assert.deepEqual(table.map((row) => row.rank), [0, 1, 2, 3]);
  for (const row of table) assert.equal(row.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// 7. Candidate gate and guard rails
// ---------------------------------------------------------------------------

check('favorites stay the only candidate gate', () => {
  assert.equal(SCORING_FACT_CANDIDATE_GATE, 'favorites');
  const fact = createScoringFact({
    harness: 'codex',
    model: 'gpt-5.6-sol',
    kind: 'estimate',
    metric: 'usd',
  });
  for (const banned of ['candidate', 'candidates', 'eligible', 'selection_slot', 'favorite']) {
    assert.equal(Object.prototype.hasOwnProperty.call(fact, banned), false);
  }
  for (const exportName of ['buildCandidateSet', 'listCandidates', 'selectModelPick', 'filterCandidates']) {
    assert.equal(factSchema[exportName], undefined);
  }
});

check('new modules contain no substring joins or regex name matching', () => {
  const files = [
    path.join(repoRoot, 'lib', 'model-facts', 'identity.js'),
    path.join(repoRoot, 'lib', 'model-facts', 'schema.js'),
  ];
  const bannedCall = /\.(includes|startsWith|endsWith|indexOf|lastIndexOf|substring|substr|search|match)\s*\(/;
  const bannedRegex = /new\s+RegExp/;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(bannedCall.test(source), false, `${file} uses a substring join`);
    assert.equal(bannedRegex.test(source), false, `${file} builds a regex`);
  }
});

console.log(`model-fact-schema: ${checks} checks passed`);
