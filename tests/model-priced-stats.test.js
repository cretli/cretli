/**
 * Priced statistics per (model, role, level) — plan v10 §2.5-2.6 (L6).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICED_STATS_ATTRIBUTION,
  buildPricePer1m,
  buildPricedModelStats,
  levelOfDelegation,
} from '../lib/model-pick-priced-stats.js';
import { billingClassOfCandidate } from '../lib/model-pick-billing-class.js';
import { TOKEN_RATES_CAPTURED_AT } from '../lib/usage/usage-rates.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const iso = (offsetMin) => new Date(NOW - offsetMin * 60000).toISOString();

function job(id, assignment, harness, model, extra = {}) {
  return {
    id,
    parentChatId: 'chat-1',
    assignment,
    executionMode: 'agent',
    status: 'completed',
    createdAt: iso(60 - Number(id.replace(/\D/g, '') || 0)),
    startedAt: iso(50),
    finishedAt: iso(45),
    executor: { transport: harness, model },
    report: assignment === 'review' ? 'TASK: review\nVERDICT: PASS' : 'TASK: implement\nVERDICT: PASS',
    ...extra,
  };
}

test('billingClassOfCandidate: metered only for api harnesses, never subscription', () => {
  assert.equal(billingClassOfCandidate({ harness: 'openrouter' }), 'api_metered');
  assert.notEqual(billingClassOfCandidate({ harness: 'claude' }), 'api_metered', 'a CLI harness is never metered');
  assert.equal(billingClassOfCandidate({ harness: 'claude' }, { provider: 'anthropic-subscription' }), 'unknown');
  assert.equal(billingClassOfCandidate({ harness: 'nope' }), 'unknown');
});

test('price_per_1m: usd for api_metered exact rate, rcu proxy otherwise', () => {
  const metered = buildPricePer1m({
    harness: 'openrouter',
    model: 'acme/model-x',
    billingClass: 'api_metered',
    openrouterPricingFor: () => ({ prompt: '0.000001', completion: '0.000004', fetched_at: '2026-10-13T00:00:00Z' }),
  });
  assert.equal(metered.unit, 'usd');
  assert.equal(metered.is_money, true);
  assert.equal(metered.input, 1);
  assert.equal(metered.output, 4);
  assert.equal(metered.source, 'openrouter_pricing');
  assert.equal(metered.captured_at, '2026-10-13T00:00:00Z');

  const subscription = buildPricePer1m({ harness: 'claude', model: 'claude-opus-5-5', billingClass: 'subscription_quota' });
  assert.equal(subscription.is_money, false, 'subscription never shows money');
  assert.equal(subscription.unit, 'rcu');
  assert.equal(subscription.source, 'token_rates');
  assert.equal(subscription.captured_at, TOKEN_RATES_CAPTURED_AT);
  assert.equal(subscription.estimated, true);
});

test('levelOfDelegation reads the pick record, falls back to unknown', () => {
  const picks = new Map([['p1', { complexity: { level: 'trivial' } }]]);
  assert.equal(levelOfDelegation({ pickId: 'p1' }, picks), 'trivial');
  assert.equal(levelOfDelegation({ pickId: 'zz' }, picks), 'unknown');
  assert.equal(levelOfDelegation({ complexity: { level: 'demanding' } }, picks), 'demanding');
});

test('stats per (model, role, level): cost_per_pass usd measured vs rcu proxy', () => {
  const rows = [
    job('i1', 'implement', 'openrouter', 'acme/model-x', { pickId: 'p1', metrics: { tokens_in: 1000, tokens_out: 500 } }),
    job('r1', 'review', 'claude', 'claude-opus-5-5', { createdAt: iso(40) }),
    job('i2', 'implement', 'claude', 'claude-sonnet-5-5', { pickId: 'p2', parentChatId: 'chat-2', metrics: { tokens_in: 2000, tokens_out: 800 } }),
    job('r2', 'review', 'opencode', 'opencode/test', { parentChatId: 'chat-2', createdAt: iso(40) }),
  ];
  const stats = buildPricedModelStats({
    rows,
    picks: [{ id: 'p1', complexity: { level: 'trivial' } }, { id: 'p2', complexity: { level: 'demanding' } }],
    usageEvents: [
      { delegationId: 'i1', usd: 0.02, estimated: false, at: iso(30) },
      { delegationId: 'i2', usd: 9, estimated: false, at: iso(30) },
      { delegationId: 'i1', usd: 5, estimated: true, at: iso(29) },
    ],
    openrouterPricingFor: () => ({ prompt: '0.000001', completion: '0.000004', fetched_at: '2026-10-13T00:00:00Z' }),
    now: NOW,
  });
  assert.equal(stats.attribution.url, 'https://artificialanalysis.ai/');
  assert.deepEqual(stats.attribution, PRICED_STATS_ATTRIBUTION);
  const metered = stats.by_level.find((r) => r.model === 'acme/model-x' && r.role === 'implement');
  assert.ok(metered, 'openrouter implement row present');
  assert.equal(metered.level, 'trivial');
  assert.equal(metered.billing_class, 'api_metered');
  assert.equal(metered.cost_per_pass.unit, 'usd');
  assert.equal(metered.cost_per_pass.value, 0.02, 'estimated usd events are excluded');
  assert.equal(metered.cost_per_pass.source, 'usage_ledger');
  assert.ok(metered.cost_per_pass.captured_at);
  assert.equal(metered.price_per_1m.source, 'openrouter_pricing');

  const subscription = stats.by_level.find((r) => r.harness === 'claude' && r.role === 'implement');
  assert.equal(subscription.level, 'demanding');
  assert.equal(subscription.cost.measured_usd, null, 'a subscription pair never reports measured usd');
  assert.equal(subscription.cost_per_pass.unit, 'rcu');
  assert.equal(subscription.cost_per_pass.is_money, false);
  assert.equal(subscription.cost_per_pass.source, 'cost_proxy');

  const review = stats.by_level.find((r) => r.role === 'review' && r.level === 'unknown');
  assert.ok(review, 'review without a pick record lands in the unknown level');
  assert.ok(stats.by_model_role['openrouter/acme/model-x|implement'].price_per_1m);
  assert.ok(stats.by_level.filter((r) => r.billing_class !== 'api_metered').every(
    (r) => r.cost_per_pass?.unit !== 'usd' && r.price_per_1m.unit !== 'usd',
  ), 'only api_metered pairs may carry usd');
});

test('benchmark block carries the Artificial Analysis attribution', () => {
  const snapshots = [{
    sourceId: 'artificial-analysis',
    kind: 'real',
    capturedAt: new Date(NOW - 86400000).toISOString(),
    payload: { entries: [{ modelKey: 'claude-sonnet-5-5', scores: { coding_index: 0.8, intelligence_index: 0.8 } }] },
  }];
  const stats = buildPricedModelStats({
    rows: [job('i1', 'implement', 'claude', 'claude-sonnet-5-5')],
    snapshots,
    now: NOW,
  });
  const row = stats.by_level[0];
  assert.ok(['ok', 'stale', 'missing', 'unmapped', 'no_source'].includes(row.benchmark.status));
  if (row.benchmark.status === 'ok') {
    assert.match(row.benchmark.attribution, /artificialanalysis\.ai/);
  }
});
