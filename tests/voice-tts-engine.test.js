import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySpeechFailure,
  disableTtsEngine,
  isTtsEngineDisabled,
  resetTtsEngineFailures,
  resolveTtsEngine,
} from '../app_front/features/voice/ttsEngine.js';

test('treats billing and auth failures as not worth retrying', () => {
  for (const status of [401, 402, 403, 429]) {
    const actual = classifySpeechFailure({ error: 'You have no credits remaining.', upstreamStatus: status });
    assert.equal(actual.isPermanent, true, `HTTP ${status} must not be retried per sentence`);
    assert.equal(actual.message, 'You have no credits remaining.');
  }
});

test('treats a missing key as permanent even without an upstream status', () => {
  const actual = classifySpeechFailure({ error: 'OpenAI API key is not configured — set OPENAI_API_KEY.' });
  assert.equal(actual.isPermanent, true);
});

test('keeps retrying after a transient failure', () => {
  assert.equal(classifySpeechFailure({ error: 'boom', upstreamStatus: 500 }).isPermanent, false);
  assert.equal(classifySpeechFailure({ error: 'timed out', upstreamStatus: 504 }).isPermanent, false);
  assert.equal(classifySpeechFailure(null).isPermanent, false);
  assert.equal(classifySpeechFailure(null).message, 'Speech request failed');
});

test('a disabled engine resolves to the browser one until the failures are reset', (t) => {
  // The OpenAI engine plays an <audio> element, so it reports itself
  // unavailable outside a browser.
  globalThis.Audio = function FakeAudio() {};
  t.after(() => {
    delete globalThis.Audio;
    resetTtsEngineFailures();
  });

  assert.equal(resolveTtsEngine('openai').id, 'openai');
  disableTtsEngine('openai');
  assert.equal(isTtsEngineDisabled('openai'), true);
  assert.equal(resolveTtsEngine('openai').id, 'browser', 'a dead engine must not be asked again');

  resetTtsEngineFailures();
  assert.equal(isTtsEngineDisabled('openai'), false);
  assert.equal(resolveTtsEngine('openai').id, 'openai', 'changing the setting earns a fresh attempt');
});

test('the browser engine can never be disabled — there is nothing behind it', () => {
  disableTtsEngine('browser');
  assert.equal(isTtsEngineDisabled('browser'), false);
  assert.equal(resolveTtsEngine('browser').id, 'browser');
});
