import assert from 'node:assert/strict';
import {
  enrichCatalogEntryMeta,
  estimateModelCostTier,
  estimateModelQualityTier,
  estimateModelSpeedTier,
  formatCostTierDots,
  groupModelCatalogForSettings,
  resolveModelProviderId,
  sortModelCatalogEntries,
} from '../lib/model-catalog-meta.js';
import { matchModelScoreRow } from '../lib/model-score-heuristics.js';

assert.equal(resolveModelProviderId('claude-opus-4-8', 'Opus 4.8'), 'anthropic');
assert.equal(resolveModelProviderId('gpt-5.2', 'GPT-5.2'), 'openai');
assert.equal(resolveModelProviderId('deepseek-flash', 'DeepSeek V4.1 Flash'), 'deepseek');
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
assert.ok((enriched.qualityTier ?? 0) >= 4);
assert.ok(Number.isFinite(enriched.speedTier));

assert.equal(estimateModelQualityTier('gpt-6-astra'), 5);
assert.equal(estimateModelCostTier('gpt-6-astra'), 5);
assert.equal(estimateModelQualityTier('deepseek-v4.1-flash'), 4);
assert.equal(matchModelScoreRow('deepseek-v4.1-flash')?.pattern, 'deepseek-flash');
assert.equal(estimateModelQualityTier('claude-haiku-4'), 2);
assert.equal(estimateModelSpeedTier('gemini-flash', []), 5);
assert.ok(estimateModelSpeedTier('composer-2.5', [{ id: 'fast', value: 'true' }]) >= 4);
assert.ok(estimateModelSpeedTier('grok-4.6', [{ id: 'effort', value: 'high' }]) <= 3);

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
