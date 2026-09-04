import assert from 'node:assert/strict';
import {
  DEFAULT_CODEX_MODEL,
  listFallbackCodexModels,
  resolveCodexModelSelection,
  resolveDefaultCodexModel,
} from '../lib/codex/codex-models.js';

assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-sol');
assert.equal(resolveDefaultCodexModel(), 'gpt-5.6-sol');

const fallback = listFallbackCodexModels();
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.6-sol'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.6-terra'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.6-luna'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.6'));
assert.ok(fallback.some((row) => row.modelId === 'gpt-5.4'));

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
assert.ok(fallback.some((row) => row.value === 'gpt-5.4::effort=minimal'));

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

console.log('codex-models.test.js OK');
