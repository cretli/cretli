import assert from 'node:assert/strict';
import {
  buildCatalogFromSdkStatusPayload,
  buildVariantLabelFromParams,
  decodeModelValue,
  encodeModelValue,
  enrichCatalogEntryLabels,
  expandSdkModelRow,
  filterCatalogByEnabled,
  mergeModelCatalogEntries,
  normalizeChatEnabledModels,
  resolveModelSelection,
} from '../lib/model-catalog.js';

assert.equal(encodeModelValue('gpt-5.2'), 'gpt-5.2');
assert.equal(
  encodeModelValue('gpt-5.2', [{ id: 'reasoning', value: 'high' }]),
  'gpt-5.2::reasoning=high',
);
assert.deepEqual(decodeModelValue('auto'), { modelId: 'auto' });
assert.deepEqual(decodeModelValue('gpt-5.2-high'), { modelId: 'gpt-5.2' });
assert.deepEqual(decodeModelValue('gpt-5.2::reasoning=high'), {
  modelId: 'gpt-5.2',
  params: [{ id: 'reasoning', value: 'high' }],
});
assert.deepEqual(resolveModelSelection('auto', 'composer-2'), { id: 'composer-2' });
assert.deepEqual(resolveModelSelection('gpt-5.2::reasoning=low'), {
  id: 'gpt-5.2',
  params: [{ id: 'reasoning', value: 'low' }],
});

const expanded = expandSdkModelRow({
  id: 'gpt-5.2',
  displayName: 'GPT-5.2',
  variants: [
    { displayName: 'High', params: [{ id: 'reasoning', value: 'high' }], isDefault: true },
    { displayName: 'Low', params: [{ id: 'reasoning', value: 'low' }] },
  ],
});
assert.equal(expanded.length, 2);
assert.equal(expanded[0].value, 'gpt-5.2::reasoning=high');
assert.equal(expanded[0].label, 'GPT-5.2 — High');
assert.equal(expanded[1].value, 'gpt-5.2::reasoning=low');

const opusLike = expandSdkModelRow({
  id: 'claude-opus-4-8',
  displayName: 'Opus 4.8',
  parameters: [
    { id: 'context', displayName: 'Context', values: [{ value: '300k', displayName: '300K' }] },
    { id: 'effort', displayName: 'Effort', values: [{ value: 'high', displayName: 'High' }] },
    { id: 'fast', displayName: 'Fast', values: [{ value: 'true', displayName: 'Fast' }] },
  ],
  variants: [
    {
      displayName: 'Opus 4.8',
      params: [
        { id: 'context', value: '300k' },
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'true' },
      ],
    },
    {
      displayName: 'Opus 4.8',
      params: [
        { id: 'context', value: '300k' },
        { id: 'effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ],
    },
  ],
});
assert.equal(opusLike.length, 2);
assert.equal(opusLike[0].label, 'Opus 4.8 — 300K · High · Fast');
assert.equal(opusLike[1].label, 'Opus 4.8 — 300K · Low');
assert.equal(buildVariantLabelFromParams(
  [{ id: 'fast', value: 'false' }],
  [{ id: 'fast', displayName: 'Fast', values: [{ value: 'true', displayName: 'Fast' }] }],
), 'Standard');

const merged = mergeModelCatalogEntries(
  [{ value: 'auto', label: 'Auto', modelId: 'auto' }],
  [{ value: 'composer-2', label: 'Composer 2', modelId: 'composer-2' }],
);
assert.equal(merged.length, 2);

assert.deepEqual(normalizeChatEnabledModels([' auto ', 'composer-2', 'composer-2']), [
  'auto',
  'composer-2',
]);

const catalog = [
  { value: 'auto', label: 'Auto', modelId: 'auto' },
  { value: 'composer-2', label: 'Composer 2', modelId: 'composer-2' },
  { value: 'gpt-5.2::reasoning=high', label: 'GPT-5.2 — High', modelId: 'gpt-5.2' },
];
assert.equal(filterCatalogByEnabled(catalog, []).length, 3);
assert.equal(filterCatalogByEnabled(catalog, ['auto', 'gpt-5.2::reasoning=high']).length, 2);
assert.equal(filterCatalogByEnabled(catalog, ['gpt-5.2']).length, 1);
assert.equal(filterCatalogByEnabled(catalog, ['gpt-5.2'])[0].value, 'gpt-5.2::reasoning=high');

const fromEmptyCatalog = buildCatalogFromSdkStatusPayload({
  catalog: [],
  models: [{ value: 'composer-2', label: 'Composer 2' }],
});
assert.ok(fromEmptyCatalog.some((row) => row.value === 'composer-2'));
assert.ok(fromEmptyCatalog.some((row) => row.value === 'auto'));

const fromMissingPayload = buildCatalogFromSdkStatusPayload(null);
assert.ok(fromMissingPayload.length > 0);
assert.equal(fromMissingPayload[0].value, 'auto');

const staleOpusRows = enrichCatalogEntryLabels([
  {
    value: 'claude-opus-4-7::context=300k,effort=high,fast=true,thinking=false',
    label: 'Opus 4.7',
    modelId: 'claude-opus-4-7',
    group: 'Opus 4.7',
    variantLabel: 'Opus 4.7',
  },
]);
assert.equal(staleOpusRows[0].label, 'Opus 4.7 — 300k · High · Fast');
assert.equal(staleOpusRows[0].variantLabel, '300k · High · Fast');

console.log('All model-catalog tests passed.');
