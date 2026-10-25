import assert from 'node:assert/strict';
import { resolveModelStrength, sortModelOptionsByStrength, sortHarnessesByModelStrength } from '../lib/model-strength-sort.js';
import { buildNewChatModelOptions, decodeNewChatModelChoice } from '../app_front/features/chat/newChatModelOptions.js';

const model = (id, effort, disabled = false) => ({ value: `${id}::effort=${effort}`, label: `${id} ${effort}`, disabled });
const shuffled = [model('claude-haiku-5-5', 'max'), model('claude-opus-5-5', 'low'),
  model('claude-sonnet-5-5', 'medium'), model('claude-opus-5-5', 'max', true),
  model('claude-opus-5-5', 'medium'), model('claude-sonnet-5-5', 'low'), model('claude-opus-5-5', 'high')];
const sorted = sortModelOptionsByStrength(shuffled);
assert.deepEqual(sorted.map((row) => row.value), [
  'claude-opus-5-5::effort=max', 'claude-opus-5-5::effort=high', 'claude-opus-5-5::effort=medium',
  'claude-opus-5-5::effort=low', 'claude-sonnet-5-5::effort=medium', 'claude-sonnet-5-5::effort=low', 'claude-haiku-5-5::effort=max',
]);
assert.equal(shuffled[0].value, 'claude-haiku-5-5::effort=max', 'sorting must not mutate catalogs');
assert.equal(resolveModelStrength({ value: 'resolution::effort=sol' }).known, false);
assert.equal(resolveModelStrength({ value: 'gpt-6-solomon' }).known, false);
assert.deepEqual(sortModelOptionsByStrength([model('gpt-6.1-sol', 'low'), model('gpt-6.1-sol', 'ultra'),
  model('gpt-6.1-sol', 'xhigh'), model('gpt-6-sol', 'max')]).map((row) => row.value), [
  'gpt-6.1-sol::effort=ultra', 'gpt-6.1-sol::effort=xhigh', 'gpt-6.1-sol::effort=low', 'gpt-6-sol::effort=max',
]);
assert.equal(sortModelOptionsByStrength([{ value: 'unknown', label: 'Unknown' }, model('claude-haiku-5-5', 'low')])[0].value,
  'claude-haiku-5-5::effort=low');
assert.equal(sortModelOptionsByStrength([{ value: 'custom', label: 'Custom', strengthRank: 10 }, model('claude-opus-5-5', 'max')])[0].value, 'custom');
const harnesses = [
  { id: 'weak', label: 'A weak', ready: true, models: [model('claude-haiku-5-5', 'max')] },
  { id: 'strong', label: 'Z strong', ready: true, models: shuffled },
  { id: 'unknown', label: 'Unknown', ready: true, models: [] },
];
assert.deepEqual(sortHarnessesByModelStrength(harnesses).map((row) => row.id), ['strong', 'weak', 'unknown']);
const options = buildNewChatModelOptions(harnesses, [], (key) => key);
assert.equal(options[0].group, 'Z strong');
assert.equal(decodeNewChatModelChoice(options[0].value).model, 'claude-opus-5-5::effort=max');
assert.equal(decodeNewChatModelChoice(options[3].value).model, 'claude-opus-5-5::effort=low');
console.log('model-strength-sort.test.js OK');
