import assert from 'node:assert/strict';
import {
  DEFAULT_CODEX_MODEL,
  catalogFromCodexModelsCache,
  listFallbackCodexModels,
  resolveCodexModelSelection,
  resolveDefaultCodexModel,
} from '../lib/codex/codex-models.js';

assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-sol');
assert.equal(resolveDefaultCodexModel(), 'gpt-5.6-sol');

const fallback = listFallbackCodexModels();
assert.ok(fallback.some((row) => row.modelId === 'gpt-6-astra'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.6-sol'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.6-terra'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.6-luna'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.3-codex-spark'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.6'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.5'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.4'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.4-mini'));

const lunaHigh = fallback.find((row) => row.value === 'gpt-5.6-luna::effort=high');
assert.ok(lunaHigh);
assert.equal(lunaHigh.modelId, 'gpt-5.6-luna');
assert.equal(lunaHigh.group, 'GPT-5.6 Luna');
assert.equal(lunaHigh.variantLabel, 'High');
assert.deepEqual(lunaHigh.params, [{ id: 'effort', value: 'high' }]);

assert.equal(
  fallback.some((row) => row.value === 'gpt-5.6-luna::effort=ultra'),
  false,
);
assert.ok(fallback.some((row) => row.value === 'gpt-5.6-sol::effort=ultra'));
assert.ok(fallback.some((row) => row.value === 'gpt-6-astra::effort=max'));
assert.equal(
  fallback.some((row) => row.value === 'gpt-6-astra::effort=minimal'),
  false,
);
assert.ok(fallback.some((row) => row.value === 'gpt-5.4::effort=minimal'));
assert.ok(fallback.some((row) => row.value === 'gpt-5.4-mini::effort=low'));
assert.ok(fallback.some((row) => row.value === 'gpt-5.3-codex-spark::effort=low'));

const astraDefault = fallback.find((row) => row.modelId === 'gpt-6-astra' && row.isDefault);
assert.ok(astraDefault);
assert.equal(astraDefault.value, 'gpt-6-astra::effort=medium');

const solDefault = fallback.find((row) => row.modelId === 'gpt-5.6-sol' && row.isDefault);
assert.ok(solDefault);
assert.equal(solDefault.value, 'gpt-5.6-sol::effort=low');

const lunaDefault = fallback.find((row) => row.modelId === 'gpt-5.6-luna' && row.isDefault);
assert.ok(lunaDefault);
assert.equal(lunaDefault.value, 'gpt-5.6-luna::effort=medium');

assert.deepEqual(resolveCodexModelSelection('gpt-5.6-luna::effort=high'), {
  model: 'gpt-5.6-luna',
  modelReasoningEffort: 'high',
});
assert.deepEqual(resolveCodexModelSelection('gpt-5.6-luna'), {
  model: 'gpt-5.6-luna',
});
assert.deepEqual(resolveCodexModelSelection(''), {
  model: 'gpt-5.6-sol',
});
assert.deepEqual(resolveCodexModelSelection('gpt-5.6-luna::effort=bogus'), {
  model: 'gpt-5.6-luna',
});

const live = catalogFromCodexModelsCache({
  models: [
    { slug: 'gpt-reserve', visibility: 'hide', display_name: 'GPT-Reserve' },
    {
      slug: 'gpt-5.6-terra',
      visibility: 'list',
      display_name: 'GPT-5.6-Terra',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
      ],
    },
  ],
});
assert.equal(live.some((row) => row.modelId === 'gpt-6-astra'), false);
assert.ok(live.some((row) => row.modelId === 'gpt-5.6-terra'));
assert.equal(live.some((row) => row.modelId === 'gpt-reserve'), false);
assert.ok(live.some((row) => row.value === 'gpt-5.6-terra::effort=medium'));

console.log('codex-models.test.js OK');
