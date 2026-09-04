import assert from 'node:assert/strict';
import test from 'node:test';
import { registerVoiceRoutes } from '../lib/routes/voice-routes.js';

/**
 * Minimal Express stand-in: collects the registered POST handlers.
 *
 * @returns {{ post: (path: string, handler: Function) => void, routes: Map<string, Function> }}
 */
function createFakeApp() {
  /** @type {Map<string, Function>} */
  const routes = new Map();
  return { post: (path, handler) => routes.set(path, handler), routes };
}

/**
 * @returns {{ statusCode: number, body: any, status: Function, json: Function }}
 */
function createFakeResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/**
 * @param {string} path
 * @param {object} body
 * @returns {Promise<{ statusCode: number, body: any }>}
 */
async function callRoute(path, body) {
  const app = createFakeApp();
  registerVoiceRoutes(app, { recordUsage: () => null });
  const handler = app.routes.get(path);
  assert.ok(handler, `${path} must be registered`);
  const res = createFakeResponse();
  await handler({ body, headers: {}, socket: {} }, res);
  return res;
}

test('registers the voice endpoints', () => {
  const app = createFakeApp();
  registerVoiceRoutes(app, { recordUsage: () => null });
  assert.deepEqual(
    [...app.routes.keys()].sort(),
    [
      '/api/voice/gemini-live-token',
      '/api/voice/gemini-probe',
      '/api/voice/realtime-token',
      '/api/voice/speak',
      '/api/voice/transcribe',
    ]
  );
});

test('reports a missing API key instead of calling OpenAI', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  // A malformed env key short-circuits the resolver, so the developer's own key
  // in data/config.json cannot leak into this test.
  process.env.OPENAI_API_KEY = 'not-a-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  for (const path of ['/api/voice/speak', '/api/voice/transcribe', '/api/voice/realtime-token']) {
    const actual = await callRoute(path, { text: 'hej', base64: 'AAAA' });
    assert.equal(actual.statusCode, 503, `${path} must not pretend to work without a key`);
    assert.equal(actual.body.ok, false);
  }
});

test('validates the payload before spending a request', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.OPENAI_API_KEY = `sk-${'x'.repeat(40)}`;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('no network in tests');
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const emptyText = await callRoute('/api/voice/speak', { text: '   ' });
  assert.equal(emptyText.statusCode, 400);

  const longText = await callRoute('/api/voice/speak', { text: 'a'.repeat(5000) });
  assert.equal(longText.statusCode, 413);

  const noAudio = await callRoute('/api/voice/transcribe', { base64: '' });
  assert.equal(noAudio.statusCode, 400);

  const shortAudio = await callRoute('/api/voice/transcribe', {
    base64: Buffer.alloc(100).toString('base64'),
  });
  assert.equal(shortAudio.statusCode, 400);

  const hugeAudio = await callRoute('/api/voice/transcribe', {
    base64: Buffer.alloc(5 * 1024 * 1024).toString('base64'),
  });
  assert.equal(hugeAudio.statusCode, 413, 'stay under the express.json body limit');

  assert.equal(fetchCalls, 0, 'rejected payloads must never reach OpenAI');
});

test('the gemini live relay issues a same-origin ticket', async (t) => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = `AQ.${'x'.repeat(40)}`;
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  });
  const actual = await callRoute('/api/voice/gemini-live-token', {});
  assert.equal(actual.statusCode, 200);
  assert.equal(actual.body.ok, true);
  assert.match(String(actual.body.wsUrl || ''), /\/ws-gemini-live\?ticket=/);
  assert.ok(!String(actual.body.wsUrl || '').includes('generativelanguage'));
  assert.ok(actual.body.token);
  assert.ok(actual.body.setup);
});

test('the gemini probe needs a Gemini key', async (t) => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'not-a-key';
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  });
  const actual = await callRoute('/api/voice/gemini-probe', {});
  assert.equal(actual.statusCode, 503);
  assert.match(actual.body.error, /GEMINI_API_KEY/);
});

test('the gemini live token needs a Gemini key', async (t) => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'not-a-key';
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  });
  const actual = await callRoute('/api/voice/gemini-live-token', {});
  assert.equal(actual.statusCode, 503);
  assert.match(actual.body.error, /GEMINI_API_KEY/);
});

test('the azure provider needs its own credentials, not the OpenAI key', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousAzureKey = process.env.AZURE_SPEECH_KEY;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.OPENAI_API_KEY = `sk-${'x'.repeat(40)}`;
  process.env.AZURE_SPEECH_KEY = 'nope';
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('no network in tests');
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousAzureKey === undefined) delete process.env.AZURE_SPEECH_KEY;
    else process.env.AZURE_SPEECH_KEY = previousAzureKey;
  });

  const actual = await callRoute('/api/voice/speak', { text: 'Gotowe.', provider: 'azure' });
  assert.equal(actual.statusCode, 503);
  assert.match(actual.body.error, /AZURE_SPEECH_KEY/);
  assert.equal(fetchCalls, 0);
});

test('routes the azure provider to Azure with a validated voice', async (t) => {
  const previousAzureKey = process.env.AZURE_SPEECH_KEY;
  const previousAzureRegion = process.env.AZURE_SPEECH_REGION;
  const previousFetch = globalThis.fetch;
  /** @type {string[]} */
  const urls = [];
  /** @type {string[]} */
  const bodies = [];
  process.env.AZURE_SPEECH_KEY = 'a'.repeat(32);
  process.env.AZURE_SPEECH_REGION = 'westeurope';
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    bodies.push(String(init?.body || ''));
    return new Response(Buffer.from('mp3'), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousAzureKey === undefined) delete process.env.AZURE_SPEECH_KEY;
    else process.env.AZURE_SPEECH_KEY = previousAzureKey;
    if (previousAzureRegion === undefined) delete process.env.AZURE_SPEECH_REGION;
    else process.env.AZURE_SPEECH_REGION = previousAzureRegion;
  });

  const actual = await callRoute('/api/voice/speak', {
    text: 'Gotowe.',
    provider: 'azure',
    voice: 'pl-PL-MarekNeural',
    lang: 'pl-PL',
  });
  assert.equal(actual.statusCode, 200);
  assert.equal(actual.body.provider, 'azure');
  assert.equal(actual.body.voice, 'pl-PL-MarekNeural');
  assert.match(urls[0], /westeurope\.tts\.speech\.microsoft\.com/);
  assert.match(bodies[0], /pl-PL-MarekNeural/);

  // A voice from another provider must not reach the SSML; Polish falls back to
  // a Polish narrator.
  const fallback = await callRoute('/api/voice/speak', {
    text: 'Gotowe.',
    provider: 'azure',
    voice: 'ash',
    lang: 'pl',
  });
  assert.equal(fallback.body.voice, 'pl-PL-AgnieszkaNeural');
});

test('passes the upstream status through so the client can stop retrying', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = `sk-${'x'.repeat(40)}`;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'You have no credits remaining.' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const actual = await callRoute('/api/voice/speak', { text: 'Test.' });
  assert.equal(actual.statusCode, 502);
  assert.equal(actual.body.upstreamStatus, 429);
  assert.match(actual.body.error, /no credits/);
});
