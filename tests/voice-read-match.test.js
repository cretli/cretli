import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVoiceReadMode } from '../app_front/features/voice/voiceReadMatch.js';

test('accepts canonical read modes', () => {
  assert.equal(resolveVoiceReadMode('off'), 'off');
  assert.equal(resolveVoiceReadMode('final'), 'final');
  assert.equal(resolveVoiceReadMode('stream'), 'stream');
  assert.equal(resolveVoiceReadMode('agent'), 'agent');
});

test('accepts Polish aliases', () => {
  assert.equal(resolveVoiceReadMode('wyłącz'), 'off');
  assert.equal(resolveVoiceReadMode('na końcu'), 'final');
  assert.equal(resolveVoiceReadMode('na bieżąco'), 'stream');
  assert.equal(resolveVoiceReadMode('krótko'), 'agent');
  assert.equal(resolveVoiceReadMode('podsumowanie'), 'agent');
  assert.equal(resolveVoiceReadMode('summary'), 'agent');
});

test('rejects an empty or unknown value', () => {
  assert.equal(resolveVoiceReadMode(''), '');
  assert.equal(resolveVoiceReadMode('loud'), '');
});
