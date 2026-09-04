import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeGeminiLiveRelayTicket,
  issueGeminiLiveRelayTicket,
  noteGeminiLiveUsage,
} from '../lib/voice/gemini-live-relay.js';
import { emptyUsageTokens } from '../lib/usage/usage-event.js';

test('a relay ticket works once and then is spent', () => {
  const ticket = issueGeminiLiveRelayTicket();
  assert.equal(consumeGeminiLiveRelayTicket(ticket), true);
  assert.equal(consumeGeminiLiveRelayTicket(ticket), false);
});

test('unknown and empty tickets are rejected', () => {
  assert.equal(consumeGeminiLiveRelayTicket(''), false);
  assert.equal(consumeGeminiLiveRelayTicket('missing'), false);
  assert.equal(consumeGeminiLiveRelayTicket(undefined), false);
});

test('records a Gemini usage delta and keeps the cumulative snapshot', () => {
  /** @type {object[]} */
  const recorded = [];
  const first = noteGeminiLiveUsage(
    { usageMetadata: { promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 40 }] } },
    emptyUsageTokens(),
    (partial) => recorded.push(partial)
  );
  assert.equal(first.audioInput, 40);
  assert.equal(recorded[0].tokens.audioInput, 40);
  assert.equal(recorded[0].provider, 'google');
  const second = noteGeminiLiveUsage(
    { usageMetadata: { promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 90 }] } },
    first,
    (partial) => recorded.push(partial)
  );
  assert.equal(second.audioInput, 90);
  assert.equal(recorded[1].tokens.audioInput, 50);
});
