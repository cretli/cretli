import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import { formatUsd, priceUsage } from '../lib/usage/usage-rates.js';

test('prices OpenAI realtime audio at the flagship rate', () => {
  const event = createUsageEvent({
    provider: 'openai',
    feature: 'voice-live',
    model: 'gpt-realtime-2.1',
    tokens: { audioInput: 1_000_000, audioOutput: 0, textInput: 0, textOutput: 0, cachedInput: 0, reasoning: 0 },
  });
  const priced = priceUsage(event);
  assert.equal(priced.usd, 32);
});

test('prices Gemini live audio cheaper than OpenAI flagship', () => {
  const event = createUsageEvent({
    provider: 'google',
    feature: 'voice-live',
    model: 'gemini-3.1-flash-live-preview',
    tokens: { audioInput: 1_000_000, audioOutput: 0, textInput: 0, textOutput: 0, cachedInput: 0, reasoning: 0 },
  });
  assert.ok(priceUsage(event).usd < 10);
});

test('leaves Cursor SDK unpriced', () => {
  const event = createUsageEvent({
    provider: 'cursor',
    feature: 'chat',
    model: 'composer-2',
    tokens: { textInput: 1000, textOutput: 200, audioInput: 0, audioOutput: 0, cachedInput: 0, reasoning: 0 },
  });
  assert.equal(priceUsage(event).usd, null);
});

test('formats tiny amounts', () => {
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(1.2), '$1.20');
  assert.equal(formatUsd(null), '—');
});
