import assert from 'node:assert/strict';
import test from 'node:test';
import { probeGeminiApiKey } from '../lib/voice/gemini-probe.js';

test('accepts a 200 models list as a working key', async () => {
  const actual = await probeGeminiApiKey({
    apiKey: `AQ.${'x'.repeat(40)}`,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'models/gemini-3.1-flash-live-preview' }] }),
    }),
  });
  assert.deepEqual(actual, { ok: true, model: 'gemini-3.1-flash-live-preview' });
});

test('maps Google API key errors without leaking the key', async () => {
  const actual = await probeGeminiApiKey({
    apiKey: `AQ.${'x'.repeat(40)}`,
    fetchFn: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'API key not valid. Please pass a valid API key.' } }),
    }),
  });
  assert.equal(actual.ok, false);
  assert.equal(actual.status, 400);
  assert.match(actual.error, /API key not valid/);
  assert.ok(!JSON.stringify(actual).includes('AQ.'));
});

test('rejects an empty key before calling Google', async () => {
  let called = false;
  const actual = await probeGeminiApiKey({
    apiKey: '',
    fetchFn: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(actual.ok, false);
  assert.equal(called, false);
});
