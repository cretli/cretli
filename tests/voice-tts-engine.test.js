import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyOutputSink,
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

test('output sink is applied before playback can start', async () => {
  const order = [];
  const element = {
    setSinkId: async (id) => { await Promise.resolve(); order.push(`sink:${id}`); },
  };
  const applied = await applyOutputSink(element, 'dev-1');
  order.push('play');
  assert.equal(applied, true);
  assert.deepEqual(order, ['sink:dev-1', 'play']);
});

test('output sink falls back to the default when it rejects, hangs or is unsupported', async () => {
  assert.equal(await applyOutputSink({ setSinkId: async () => { throw new Error('gone'); } }, 'dev-1'), false);
  assert.equal(await applyOutputSink({ setSinkId: () => new Promise(() => {}) }, 'dev-1', 20), false);
  assert.equal(await applyOutputSink({ setSinkId: () => { throw new Error('sync'); } }, 'dev-1'), false);
  assert.equal(await applyOutputSink({}, 'dev-1'), false);
  let called = false;
  assert.equal(await applyOutputSink({ setSinkId: async () => { called = true; } }, ''), false);
  assert.equal(called, false, 'the default output needs no call');
});

test('a setSinkId that succeeds after the timeout is ignored and undone on the same element', async () => {
  let release;
  const calls = [];
  const element = {
    setSinkId: (id) => {
      calls.push(id);
      if (calls.length === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve();
    },
  };
  assert.equal(await applyOutputSink(element, 'dev-1', 10), false);
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(calls, ['dev-1', ''], 'the sentence stays on the output it started with');
  assert.equal(await applyOutputSink({ setSinkId: async () => {} }, 'dev-1', 10), true);
});

test('cancel settles a remote speak() whose stopped audio emits nothing, so the queue moves on', async (t) => {
  const { createSpeechQueue } = await import('../app_front/features/voice/speechQueue.js');
  const created = [];
  // A stopped element that never fires `ended` or `error`.
  globalThis.Audio = function SilentAudio() {
    this.play = () => Promise.resolve();
    this.pause = () => {};
    created.push(this);
  };
  globalThis.window = { setTimeout, clearTimeout, location: { search: '', pathname: '/', href: 'http://localhost/' } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: true, audioBase64: 'AAAA', mimeType: 'audio/mpeg' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  t.after(() => {
    delete globalThis.Audio;
    delete globalThis.window;
    globalThis.fetch = realFetch;
    resetTtsEngineFailures();
  });

  const settleOutcomes = [];
  const engine = resolveTtsEngine('openai');
  const errors = [];
  const spoken = [];
  const queue = createSpeechQueue({
    getEngineId: () => 'openai',
    getLang: () => 'pl-PL',
    getRate: () => 1,
    getVoiceName: () => '',
    onError: (error) => errors.push(error.message),
    resolveEngine: (id) => (id === 'openai' ? {
      id: 'openai',
      isAvailable: () => true,
      speak: async (utterance) => { spoken.push(utterance.text); await engine.speak(utterance); settleOutcomes.push('settled'); },
      cancel: () => engine.cancel(),
    } : { id: 'browser', isAvailable: () => true, speak: async () => { spoken.push('FALLBACK'); }, cancel() {} }),
  });

  const waitFor = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 5));
  };
  queue.enqueue('first');
  await waitFor(() => created.length === 1);
  assert.equal(created.length, 1, `first sentence is playing ${JSON.stringify(errors)}`);

  queue.cancel();
  await waitFor(() => settleOutcomes.length === 1);
  assert.deepEqual(settleOutcomes, ['settled'], 'cancel() settled the in-flight speak()');
  // A late event from the dead element must not settle twice or start a fallback.
  created[0].onended?.();
  created[0].onerror?.();
  assert.deepEqual(errors, []);
  assert.ok(!spoken.includes('FALLBACK'), 'no fallback speech after a cancel');

  queue.enqueue('second');
  await waitFor(() => created.length === 2);
  assert.equal(created.length, 2, 'the next reply is read after the cancel');
  assert.deepEqual(spoken, ['first', 'second']);
  queue.cancel();
});

test('speech queue: cancel followed at once by enqueue still speaks the new text', async () => {
  const { createSpeechQueue } = await import('../app_front/features/voice/speechQueue.js');
  const spoken = [];
  /** @type {(() => void)|null} */
  let finishFirst = null;
  const engine = {
    id: 'fake',
    speak(utterance) {
      spoken.push(utterance.text);
      if (spoken.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
      return Promise.resolve();
    },
    cancel() {
      // Like a remote engine: stopping settles the pending speak() a tick later.
      const done = finishFirst;
      finishFirst = null;
      if (done) queueMicrotask(done);
    },
  };
  const queue = createSpeechQueue({
    getEngineId: () => 'fake',
    getLang: () => 'en-US',
    getRate: () => 1,
    getVoiceName: () => '',
    resolveEngine: () => engine,
  });
  queue.enqueue('First block.');
  await new Promise((resolve) => setTimeout(resolve, 0));
  queue.cancel();
  queue.enqueue('Second block.');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(spoken, ['First block.', 'Second block.']);
  assert.equal(queue.isBusy(), false);
});
