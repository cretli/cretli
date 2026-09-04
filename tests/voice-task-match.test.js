import assert from 'node:assert/strict';
import test from 'node:test';
import { matchTaskBySpokenLabel } from '../app_front/features/voice/voiceTaskMatch.js';

const labels = [
  'Cretli: build front (watch)',
  'Cretli: test',
  'fade: deploy',
];

test('picks a task by exact label ignoring case', () => {
  const actual = matchTaskBySpokenLabel(labels, 'cretli: test');
  assert.equal(actual.match, 'Cretli: test');
});

test('picks a task by a spoken fragment', () => {
  const actual = matchTaskBySpokenLabel(labels, 'build front');
  assert.equal(actual.match, 'Cretli: build front (watch)');
});

test('reports several matches instead of guessing', () => {
  const actual = matchTaskBySpokenLabel(labels, 'cretli');
  assert.equal(actual.ambiguous, true);
  assert.ok(actual.candidates.includes('Cretli: test'));
});

test('returns no match for an unknown label', () => {
  const actual = matchTaskBySpokenLabel(labels, 'unknown task');
  assert.equal(actual.match, null);
});
