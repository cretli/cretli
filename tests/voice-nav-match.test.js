import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVoiceNavKey } from '../app_front/features/voice/voiceNavMatch.js';

test('accepts canonical keys', () => {
  assert.equal(resolveVoiceNavKey('up'), 'up');
  assert.equal(resolveVoiceNavKey('enter'), 'enter');
  assert.equal(resolveVoiceNavKey('escape'), 'escape');
  assert.equal(resolveVoiceNavKey('y'), 'y');
  assert.equal(resolveVoiceNavKey('n'), 'n');
});

test('accepts Polish aliases for arrows and confirm', () => {
  assert.equal(resolveVoiceNavKey('góra'), 'up');
  assert.equal(resolveVoiceNavKey('strzałka w dół'), 'down');
  assert.equal(resolveVoiceNavKey('lewo'), 'left');
  assert.equal(resolveVoiceNavKey('prawo'), 'right');
  assert.equal(resolveVoiceNavKey('zatwierdź'), 'enter');
  assert.equal(resolveVoiceNavKey('anuluj'), 'escape');
});

test('accepts spoken yes and no', () => {
  assert.equal(resolveVoiceNavKey('tak'), 'y');
  assert.equal(resolveVoiceNavKey('nie'), 'n');
  assert.equal(resolveVoiceNavKey('yes'), 'y');
});

test('rejects an empty or unknown value', () => {
  assert.equal(resolveVoiceNavKey(''), '');
  assert.equal(resolveVoiceNavKey('space'), '');
});
