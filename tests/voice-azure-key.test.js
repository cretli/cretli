import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAzureSpeechMetaForClient,
  getEffectiveAzureSpeechCredentials,
  isValidAzureSpeechKeyFormat,
  isValidAzureSpeechRegion,
} from '../lib/voice/azure-speech-key.js';

/**
 * The resolver reads the environment on every call, so a test only has to set
 * it and put it back afterwards.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ key?: string, region?: string }} values
 * @returns {void}
 */
function withEnv(t, values) {
  const previous = {
    key: process.env.AZURE_SPEECH_KEY,
    region: process.env.AZURE_SPEECH_REGION,
  };
  if (values.key === undefined) delete process.env.AZURE_SPEECH_KEY;
  else process.env.AZURE_SPEECH_KEY = values.key;
  if (values.region === undefined) delete process.env.AZURE_SPEECH_REGION;
  else process.env.AZURE_SPEECH_REGION = values.region;
  t.after(() => {
    if (previous.key === undefined) delete process.env.AZURE_SPEECH_KEY;
    else process.env.AZURE_SPEECH_KEY = previous.key;
    if (previous.region === undefined) delete process.env.AZURE_SPEECH_REGION;
    else process.env.AZURE_SPEECH_REGION = previous.region;
  });
}

test('accepts subscription keys and rejects pasted junk', () => {
  assert.equal(isValidAzureSpeechKeyFormat('a'.repeat(32)), true);
  assert.equal(isValidAzureSpeechKeyFormat(`  ${'b'.repeat(40)}  `), true);
  assert.equal(isValidAzureSpeechKeyFormat('too-short'), false);
  assert.equal(isValidAzureSpeechKeyFormat(`sk-${'x'.repeat(40)} with space`), false);
  assert.equal(isValidAzureSpeechKeyFormat(''), false);
  assert.equal(isValidAzureSpeechKeyFormat(undefined), false);
});

test('accepts region ids, not display names', () => {
  assert.equal(isValidAzureSpeechRegion('westeurope'), true);
  assert.equal(isValidAzureSpeechRegion('polandcentral'), true);
  assert.equal(isValidAzureSpeechRegion('WestEurope'), true, 'case is normalized');
  assert.equal(isValidAzureSpeechRegion('west europe'), false);
  assert.equal(isValidAzureSpeechRegion('12345'), false);
  assert.equal(isValidAzureSpeechRegion(''), false);
});

test('a key without a region is not usable', (t) => {
  withEnv(t, { key: 'a'.repeat(32) });
  assert.deepEqual(getEffectiveAzureSpeechCredentials(), { key: '', region: '' });
});

test('resolves a complete env pair', (t) => {
  withEnv(t, { key: 'a'.repeat(32), region: 'WestEurope' });
  assert.deepEqual(getEffectiveAzureSpeechCredentials(), {
    key: 'a'.repeat(32),
    region: 'westeurope',
  });
});

test('meta flags the format problem without leaking the key', (t) => {
  withEnv(t, { key: 'nope', region: 'westeurope' });
  const actual = getAzureSpeechMetaForClient();
  assert.equal(actual.azureSpeechEffective, false);
  assert.equal(actual.azureSpeechInvalidFormat, true);
  assert.equal(actual.azureSpeechFromEnv, true);
  assert.ok(!JSON.stringify(actual).includes('nope'));
});
