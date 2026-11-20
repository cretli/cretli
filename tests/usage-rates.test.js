import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createUsageEvent, normalizeUsagePricing } from '../lib/usage/usage-event.js';
import {
  TOKEN_RATES,
  TOKEN_RATES_CAPTURED_AT,
  TOKEN_RATES_VERSION,
  formatUsd,
  priceUsage,
} from '../lib/usage/usage-rates.js';
import { recordUsage } from '../lib/usage/usage-ledger.ts';
import { readUsageEvents } from '../lib/persist/usage-persist.js';

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

test('table-priced events persist source, version/date and the applied rate snapshot', () => {
  const priced = priceUsage(createUsageEvent({
    provider: 'other',
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    tokens: { textInput: 1_000_000, cachedInput: 1_000_000, textOutput: 1_000_000 },
  }));
  assert.equal(priced.usd, 18.3);
  assert.equal(priced.pricing.source, 'token_rates');
  assert.equal(priced.pricing.ratesVersion, TOKEN_RATES_VERSION);
  assert.equal(priced.pricing.ratesCapturedAt, TOKEN_RATES_CAPTURED_AT);
  assert.deepEqual(priced.pricing.rates, {
    textInput: 3,
    cachedInput: 0.3,
    cacheWrite: 3,
    audioInput: 0,
    textOutput: 15,
    audioOutput: 0,
  });
});

test('provider-reported cost is recorded with source "reported" and no table snapshot', () => {
  const priced = priceUsage(createUsageEvent({
    provider: 'other',
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    reportedUsd: 0.5,
    tokens: { textInput: 100 },
  }));
  assert.equal(priced.pricing.source, 'reported');
  assert.equal(priced.pricing.rates, undefined);
});

test('unknown model without data stays unpriced with a reason and no invented rate', () => {
  const priced = priceUsage(createUsageEvent({
    provider: 'other',
    harness: 'qwen',
    model: 'totally-new-model',
    tokens: { textInput: 1000, textOutput: 100 },
  }));
  assert.equal(priced.usd, null);
  assert.deepEqual(priced.pricing, { source: 'none', reason: 'unknown_model' });
});

test('provider fallback rows are labelled provider_fallback and always estimated', () => {
  for (const provider of ['openrouter', 'google', 'openai']) {
    const priced = priceUsage(createUsageEvent({
      provider,
      model: 'unlisted-model-x',
      tokens: { textInput: 1000, textOutput: 100 },
    }));
    assert.ok(priced.usd > 0, provider);
    assert.equal(priced.estimated, true, provider);
    assert.equal(priced.pricing.source, 'provider_fallback', provider);
  }
});

test('a prefix match through a priced provider stays token_rates, not a fallback', () => {
  const priced = priceUsage(createUsageEvent({
    provider: 'google',
    model: 'gemini-3.1-flash-live-preview',
    tokens: { audioInput: 1_000_000 },
  }));
  assert.equal(priced.pricing.source, 'token_rates');
  assert.notEqual(priced.estimated, true);
});

test('a stale incoming pricing block is replaced, never inherited', () => {
  const priced = priceUsage(createUsageEvent({
    provider: 'other',
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    tokens: { textInput: 1_000_000 },
    pricing: { source: 'token_rates', ratesVersion: 'old', rates: { textInput: 99 } },
  }));
  assert.equal(priced.usd, 3);
  assert.equal(priced.pricing.rates.textInput, 3);
});

test('stored events keep usd and snapshot when the rate table later changes', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-rates-'));
  const partial = {
    provider: 'other',
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    tokens: { textInput: 1_000_000 },
    at: '2026-10-01T10:00:00.000Z',
  };
  const recorded = recordUsage(partial, { dataDir });
  assert.equal(recorded.usd, 3);
  const original = { ...TOKEN_RATES['claude-sonnet-4'] };
  try {
    TOKEN_RATES['claude-sonnet-4'].textInput = 30;
    const stored = readUsageEvents({ from: '2026-10-01', to: '2026-10-01', dataDir })
      .find((event) => event.id === recorded.id);
    assert.equal(stored.usd, 3);
    assert.equal(stored.pricing.rates.textInput, 3);
    assert.equal(stored.pricing.ratesVersion, TOKEN_RATES_VERSION);
    // New events see the new table; the old one is untouched.
    assert.equal(priceUsage(createUsageEvent(partial)).usd, 30);
    assert.equal(stored.usd, 3);
  } finally {
    Object.assign(TOKEN_RATES['claude-sonnet-4'], original);
  }
});

test('legacy events without a pricing block load fine', () => {
  assert.equal(createUsageEvent({ model: 'm', usd: 1 }).pricing, undefined);
  assert.equal(normalizeUsagePricing({ source: 'bogus' }), undefined);
  assert.equal(normalizeUsagePricing(null), undefined);
});
