import assert from 'node:assert/strict';
import test from 'node:test';
import { matchModelBySpokenName } from '../app_front/features/voice/voiceModelMatch.js';

const models = [
  { id: 'auto', label: 'Auto' },
  { id: 'composer-2', label: 'Composer 2' },
  { id: 'gpt-5.2', label: 'GPT 5.2' },
];

test('picks a model by id ignoring case', () => {
  const actual = matchModelBySpokenName(models, 'Composer-2');
  assert.equal(actual.match?.id, 'composer-2');
});

test('picks a model by a spoken fragment of the label', () => {
  const actual = matchModelBySpokenName(models, 'composer');
  assert.equal(actual.match?.id, 'composer-2');
});

test('reports several matches instead of guessing', () => {
  const crowded = [...models, { id: 'composer-1.5', label: 'Composer 1.5' }];
  const actual = matchModelBySpokenName(crowded, 'composer');
  assert.equal(actual.ambiguous, true);
  assert.ok(actual.candidates.includes('composer-2'));
  assert.ok(actual.candidates.includes('composer-1.5'));
});

test('returns no match for an unknown name', () => {
  const actual = matchModelBySpokenName(models, 'claude-opus');
  assert.equal(actual.match, null);
});
