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

test('prices Claude API tokens as an estimate', () => {
  const event = createUsageEvent({
    provider: 'other',
    harness: 'claude',
    feature: 'chat',
    model: 'claude-sonnet-4-5',
    tokens: { textInput: 1_000_000, textOutput: 1_000_000 },
  });
  const priced = priceUsage(event);
  assert.equal(priced.usd, 18);
  assert.equal(priced.estimated, true);
});

test('sdk harness stays unpriced even for a priced provider', () => {
  const event = createUsageEvent({
    provider: 'openai',
    harness: 'sdk',
    feature: 'chat',
    model: 'composer-2',
    tokens: { textInput: 1_000_000 },
  });
  assert.equal(priceUsage(event).usd, null);
});

test('Opus 4.5+ uses $5/$25 while Opus 4 and 4.1 keep $15/$75', () => {
  const price = (model) => priceUsage(createUsageEvent({
    provider: 'other',
    harness: 'claude',
    feature: 'chat',
    model,
    tokens: { textInput: 1_000_000, textOutput: 1_000_000 },
  }));
  const opus45 = price('claude-opus-4-5');
  assert.equal(opus45.usd, 30);
  assert.equal(opus45.estimated, true);
  assert.equal(price('claude-opus-4-5-20251101').usd, 30);
  assert.equal(price('claude-opus-4-6').usd, 30);
  assert.equal(price('claude-opus-4-1').usd, 90);
  assert.equal(price('claude-opus-4').usd, 90);
  // A date suffix on bare Opus 4 must not be read as minor version 20250514.
  assert.equal(price('claude-opus-4-20250514').usd, 90);
});

test('leaves Claude models without rates unpriced', () => {
  const event = createUsageEvent({
    provider: 'other',
    harness: 'claude',
    feature: 'chat',
    model: 'claude-fable-9',
    tokens: { textInput: 1_000_000, textOutput: 1_000_000 },
  });
  assert.equal(priceUsage(event).usd, null);
});

test('Claude subscription mode never gets an estimated USD', () => {
  const event = createUsageEvent({
    provider: 'other',
    harness: 'claude',
    feature: 'chat',
    model: 'claude-sonnet-4-5',
    billingMode: 'subscription',
    tokens: { textInput: 1_000_000, textOutput: 1_000_000 },
  });
  assert.equal(priceUsage(event).usd, null);
});

test('provider-reported Claude cost wins over the rate table', () => {
  const event = createUsageEvent({
    provider: 'other',
    harness: 'claude',
    feature: 'chat',
    model: 'claude-sonnet-4-5',
    reportedUsd: 0.123456,
    tokens: { textInput: 1_000_000, textOutput: 1_000_000 },
  });
  const priced = priceUsage(event);
  assert.equal(priced.usd, 0.123456);
  assert.equal(priced.estimated, false);
});

test('prices DeepSeek API tokens with the cache-hit rate', () => {
  const event = createUsageEvent({
    provider: 'other',
    harness: 'deepseek',
    feature: 'chat',
    model: 'deepseek-flash',
    tokens: { textInput: 1_000_000, cachedInput: 1_000_000, textOutput: 1_000_000 },
  });
  const priced = priceUsage(event);
  assert.equal(priced.usd, 0.728);
  assert.equal(priced.estimated, true);
  // A sibling DeepSeek model id resolves through the bare `deepseek` prefix.
  assert.equal(
    priceUsage(createUsageEvent({
      provider: 'other',
      harness: 'deepseek',
      feature: 'chat',
      model: 'deepseek-v4-pro',
      tokens: { textInput: 1_000_000 },
    })).usd,
    0.28
  );
});

test('formats tiny amounts', () => {
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(1.2), '$1.20');
  assert.equal(formatUsd(null), '—');
});
