import assert from 'node:assert/strict';
import {
  enrichCatalogEntryMeta,
  formatCostTierDots,
  groupModelCatalogForSettings,
  resolveModelProviderId,
  sortModelCatalogEntries,
} from '../lib/model-catalog-meta.js';

assert.equal(resolveModelProviderId('claude-opus-4-8', 'Opus 4.8'), 'anthropic');
assert.equal(resolveModelProviderId('gpt-5.2', 'GPT-5.2'), 'openai');
assert.equal(resolveModelProviderId('composer-2.5', 'Composer 2.5'), 'cursor');
assert.equal(formatCostTierDots(3), '$$$');
assert.equal(formatCostTierDots(0), '—');

const enriched = enrichCatalogEntryMeta({
  value: 'claude-opus-4-8::context=300k,effort=high,fast=true',
  label: 'Opus 4.8 — 300K · High · Fast',
  modelId: 'claude-opus-4-8',
  group: 'Opus 4.8',
  params: [
    { id: 'context', value: '300k' },
    { id: 'effort', value: 'high' },
    { id: 'fast', value: 'true' },
  ],
});
assert.equal(enriched.provider, 'anthropic');
assert.ok((enriched.costTier ?? 0) >= 4);
assert.equal(enriched.costLabel, formatCostTierDots(enriched.costTier));

const rows = [
  { value: 'b', label: 'Beta', modelId: 'b', group: 'Beta', provider: 'openai', costTier: 2 },
  { value: 'a', label: 'Alpha', modelId: 'a', group: 'Alpha', provider: 'anthropic', costTier: 4 },
];
assert.equal(sortModelCatalogEntries(rows, 'provider')[0].provider, 'anthropic');
assert.equal(sortModelCatalogEntries(rows, 'alpha')[0].label, 'Alpha');
assert.equal(sortModelCatalogEntries(rows, 'cost-desc')[0].costTier, 4);

const grouped = groupModelCatalogForSettings(rows, 'provider');
assert.equal(grouped.length, 2);
assert.equal(grouped[0].type, 'provider');
assert.equal(grouped[0].provider, 'anthropic');

console.log('All model-catalog-meta tests passed.');
