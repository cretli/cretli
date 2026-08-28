import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVoiceSdkMode } from '../app_front/features/voice/voiceSdkMode.js';

test('accepts plan and agent literally', () => {
  assert.equal(resolveVoiceSdkMode('plan'), 'plan');
  assert.equal(resolveVoiceSdkMode('agent'), 'agent');
});

test('accepts spoken phrases around the mode name', () => {
  assert.equal(resolveVoiceSdkMode('tryb plan'), 'plan');
  assert.equal(resolveVoiceSdkMode('tryb agenta'), 'agent');
  assert.equal(resolveVoiceSdkMode('switch to agent mode'), 'agent');
});

test('rejects an empty or unknown value', () => {
  assert.equal(resolveVoiceSdkMode(''), '');
  assert.equal(resolveVoiceSdkMode('ask'), '');
});
