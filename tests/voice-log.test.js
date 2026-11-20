import assert from 'node:assert/strict';
import test from 'node:test';
import { appendVoiceLog, mergeSpeechChunk } from '../app_front/features/voice/voiceLog.js';

test('joins Gemini word deltas with a space', () => {
  assert.equal(mergeSpeechChunk('Wiadomość została', 'wysłana.'), 'Wiadomość została wysłana.');
  assert.equal(mergeSpeechChunk('dam', 'Ci znać.'), 'dam Ci znać.');
});

test('keeps punctuation glued to the previous word', () => {
  assert.equal(mergeSpeechChunk('odpowiedź', ','), 'odpowiedź,');
  assert.equal(mergeSpeechChunk('odpowiedź,', 'dam'), 'odpowiedź, dam');
});

test('replaces a cumulative rewrite instead of doubling it', () => {
  assert.equal(mergeSpeechChunk('Wiadomość', 'Wiadomość została'), 'Wiadomość została');
});

test('merges consecutive assistant speech onto one line', () => {
  const chunks = ['Wiadomość została', 'wysłana.', 'Jak', 'tylko', 'dostanę', 'odpowiedź,', 'dam', 'Ci znać.'];
  const actual = chunks.reduce(
    (log, text) => appendVoiceLog(log, { kind: 'speech', role: 'assistant', text }),
    []
  );
  assert.deepEqual(actual, [
    { kind: 'speech', role: 'assistant', text: 'Wiadomość została wysłana. Jak tylko dostanę odpowiedź, dam Ci znać.' },
  ]);
});

test('starts a new line after a tool call or a speaker change', () => {
  let log = appendVoiceLog([], { kind: 'speech', role: 'assistant', text: 'Wiadomość została wysłana.' });
  log = appendVoiceLog(log, { kind: 'tool', text: 'send_prompt: ok' });
  log = appendVoiceLog(log, { kind: 'speech', role: 'assistant', text: 'Jak tylko dostanę odpowiedź.' });
  log = appendVoiceLog(log, { kind: 'speech', role: 'user', text: 'Tak,' });
  log = appendVoiceLog(log, { kind: 'speech', role: 'user', text: 'wykonaj.' });
  assert.deepEqual(log, [
    { kind: 'speech', role: 'assistant', text: 'Wiadomość została wysłana.' },
    { kind: 'tool', text: 'send_prompt: ok' },
    { kind: 'speech', role: 'assistant', text: 'Jak tylko dostanę odpowiedź.' },
    { kind: 'speech', role: 'user', text: 'Tak, wykonaj.' },
  ]);
});
