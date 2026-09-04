import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVoiceHarness } from '../app_front/features/voice/voiceHarnessMatch.js';

test('accepts canonical harness ids', () => {
  assert.equal(resolveVoiceHarness('sdk'), 'sdk');
  assert.equal(resolveVoiceHarness('opencode'), 'opencode');
  assert.equal(resolveVoiceHarness('codex'), 'codex');
});

test('accepts spoken product names including Polish cursor', () => {
  assert.equal(resolveVoiceHarness('cursor'), 'sdk');
  assert.equal(resolveVoiceHarness('kursor'), 'sdk');
  assert.equal(resolveVoiceHarness('open code'), 'opencode');
  assert.equal(resolveVoiceHarness('open router'), 'openrouter');
  assert.equal(resolveVoiceHarness('code buddy'), 'codebuddy');
  assert.equal(resolveVoiceHarness('deep seek'), 'deepseek');
  assert.equal(resolveVoiceHarness('qwen'), 'qwen');
});

test('does not map an unknown name to sdk', () => {
  assert.equal(resolveVoiceHarness(''), '');
  assert.equal(resolveVoiceHarness('banana'), '');
  assert.equal(resolveVoiceHarness('open'), '');
});
