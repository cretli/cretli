import assert from 'node:assert/strict';
import test from 'node:test';
import { probeAzureSpeechKey, probeOpenAiApiKey } from '../lib/voice/key-probes.ts';

const json = (status, body) => async () => new Response(JSON.stringify(body), { status });

test('openai probe accepts a 200 and surfaces the upstream error otherwise', async () => {
  assert.deepEqual(await probeOpenAiApiKey({ apiKey: 'sk-x', fetchFn: json(200, { data: [] }) }), { ok: true });
  const bad = await probeOpenAiApiKey({ apiKey: 'sk-x', fetchFn: json(401, { error: { message: 'bad key' } }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad key');
  assert.equal((await probeOpenAiApiKey({ apiKey: '' })).ok, false);
});

test('azure probe needs key and region and maps 401 to a rejection', async () => {
  assert.equal((await probeAzureSpeechKey({ key: 'k', region: '' })).ok, false);
  assert.deepEqual(await probeAzureSpeechKey({ key: 'k', region: 'westeurope', fetchFn: json(200, {}) }), { ok: true });
  const bad = await probeAzureSpeechKey({ key: 'k', region: 'westeurope', fetchFn: json(401, {}) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /rejected/);
});
