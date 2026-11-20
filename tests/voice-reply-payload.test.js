import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareVoiceReplyPayload } from '../app_front/features/voice/voiceReplyMarker.js';

test('disabled: the payload and bubble text pass through untouched', () => {
  const issued = [];
  const out = prepareVoiceReplyPayload({ enabled: false, payloadText: 'hi', displayText: '', issueTurn: (t) => issued.push(t) });
  assert.deepEqual(out, { payloadText: 'hi', displayText: '', voiceTurn: '' });
  assert.deepEqual(issued, []);
});

test('enabled: marker appended, bubble keeps the user text, the turn is issued once', () => {
  const issued = [];
  const out = prepareVoiceReplyPayload({ enabled: true, payloadText: 'fix it', displayText: '', issueTurn: (t) => issued.push(t) });
  assert.equal(issued.length, 1);
  assert.equal(out.voiceTurn, issued[0]);
  assert.equal(out.displayText, 'fix it');
  assert.ok(out.payloadText.startsWith('fix it\n\n[voice-reply mode, turn='));
  assert.ok(out.payloadText.includes(out.voiceTurn));
  const kept = prepareVoiceReplyPayload({ enabled: true, payloadText: 'p', displayText: 'shown', issueTurn: () => {} });
  assert.equal(kept.displayText, 'shown');
});
