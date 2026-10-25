import assert from 'node:assert/strict';
import test from 'node:test';
import { compactVoiceModelList } from '../app_front/features/voice/voiceModelListCompact.js';

const models = [
  { id: 'auto', label: 'Auto' },
  { id: 'composer-2', label: 'Composer 2' },
  { id: 'gpt-5.2', label: 'GPT 5.2' },
  { id: 'grok-4.6::effort=high,fast=true', label: 'Grok 4.6' },
  ...Array.from({ length: 40 }, (_, i) => ({ id: `extra-${i}`, label: `Extra ${i}` })),
];

test('keeps the current model and caps a long catalog', () => {
  const actual = compactVoiceModelList(models, { current: 'gpt-5.2', limit: 8 });
  assert.equal(actual.total, models.length);
  assert.equal(actual.truncated, true);
  assert.equal(actual.models.length, 8);
  assert.equal(actual.models[0].id, 'gpt-5.2');
  assert.equal(actual.models[0].active, true);
});

test('filters by spoken query instead of dumping the catalog', () => {
  const actual = compactVoiceModelList(models, { query: 'grok 4.6', current: 'auto' });
  assert.equal(actual.models.length, 1);
  assert.equal(actual.models[0].id, 'grok-4.6::effort=high,fast=true');
  assert.equal(actual.truncated, true);
});
