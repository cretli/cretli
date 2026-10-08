import assert from 'node:assert/strict';
import {
  MODEL_CATALOG_META_POLICY_VERSION,
  enrichCatalogEntryMeta,
  estimateModelCostTier,
  estimateModelQualityTier,
  estimateModelSpeedTier,
  formatCostTierDots,
  groupModelCatalogForSettings,
  resolveBaseCostTier,
  resolveModelProviderId,
  sortModelCatalogEntries,
} from '../lib/model-catalog-meta.js';
import { matchModelScoreRow } from '../lib/model-score-heuristics.js';
import { MODEL_ALIAS_POLICY_VERSION, UNKNOWN_FAMILY_FALLBACK } from '../lib/model-alias-policy.js';

/** Documented neutral tier for a family the alias policy does not know. */
const UNKNOWN_FAMILY_TIER = UNKNOWN_FAMILY_FALLBACK.tier;

assert.equal(resolveModelProviderId('claude-opus-4-8', 'Opus 4.8'), 'anthropic');
assert.equal(resolveModelProviderId('gpt-5.2', 'GPT-5.2'), 'openai');
assert.equal(resolveModelProviderId('deepseek-flash', 'DeepSeek V4.1 Flash'), 'deepseek');
assert.equal(formatCostTierDots(3), '$$$');
assert.equal(formatCostTierDots(0), '—');
assert.equal(MODEL_CATALOG_META_POLICY_VERSION, MODEL_ALIAS_POLICY_VERSION);

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

// Name boundaries: an id fragment must never grant a family tier. The old
// `/…|max|terra|sol|luna|5\.6/` heuristic called `resolution-7b` and `solar-micro`
// flagship-expensive, and made every id containing `5.6` the top cost tier.
assert.equal(resolveBaseCostTier('resolution-7b'), UNKNOWN_FAMILY_TIER);
assert.equal(resolveBaseCostTier('solar-micro'), UNKNOWN_FAMILY_TIER);
assert.equal(estimateModelQualityTier('astronaut-8b'), UNKNOWN_FAMILY_TIER);
assert.equal(estimateModelQualityTier('lunar-eclipse-2'), UNKNOWN_FAMILY_TIER);
assert.equal(resolveBaseCostTier('acme-5.6-lite'), UNKNOWN_FAMILY_TIER);

// The documented Codex alias `gpt-5.6` IS Sol (lib/codex/codex-models.js), so it
// must resolve through the Sol row, not through an unanchored `5.6` fragment.
assert.equal(estimateModelCostTier('gpt-5.6'), 4);
assert.equal(estimateModelQualityTier('gpt-5.6'), 5);
// A version-shaped id is not a whole-id alias, so it never borrows Sol's tiers.
assert.equal(estimateModelCostTier('claude-5.6'), 3);

// `::` params stay out of the *name*: the family row comes from the base id,
// while the effort param still moves the tier (it never picks the family).
assert.equal(estimateModelCostTier('gpt-6-astra::effort=high'), 5);
assert.equal(estimateModelCostTier('gpt-6-sol::effort=high'), 4);
assert.equal(estimateModelCostTier('composer-2.5::effort=max', [{ id: 'effort', value: 'max' }]), 3);
assert.equal(estimateModelCostTier('composer-2.5::effort=max'), 2);

// A class alias (flash) resolves with a boundary too: `flashx` is a verified
// alias of the same family, `flashlight` is not a model family at all.
assert.equal(estimateModelQualityTier('glm-5.3-flash'), 4);
assert.equal(estimateModelCostTier('glm-5.3-flashx'), 1);
assert.equal(estimateModelQualityTier('flashlight-9b'), UNKNOWN_FAMILY_TIER);

console.log('All model-catalog-meta tests passed.');
