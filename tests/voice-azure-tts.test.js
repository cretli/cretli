import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AZURE_TTS_VOICES,
  buildSpeechSsml,
  getAzureDefaultVoice,
  isValidAzureVoiceName,
  synthesizeAzureSpeech,
} from '../lib/voice/azure-tts.js';

test('takes the locale from the voice name, not from the UI language', () => {
  const polish = buildSpeechSsml({ text: 'Gotowe.', voice: 'pl-PL-AgnieszkaNeural', rate: 1 });
  assert.match(polish, /xml:lang="pl-PL"/);
  assert.match(polish, /<voice name="pl-PL-AgnieszkaNeural">Gotowe\.<\/voice>/);

  const english = buildSpeechSsml({ text: 'Done.', voice: 'en-US-AvaMultilingualNeural', rate: 1 });
  assert.match(english, /xml:lang="en-US"/);
});

test('rate 1 leaves the SSML free of a prosody wrapper', () => {
  const actual = buildSpeechSsml({ text: 'Gotowe.', voice: 'pl-PL-MarekNeural', rate: 1 });
  assert.ok(!actual.includes('<prosody'), 'no change means no wrapper');
});

test('turns the rate multiplier into an SSML percentage', () => {
  assert.match(
    buildSpeechSsml({ text: 'x', voice: 'pl-PL-MarekNeural', rate: 1.5 }),
    /<prosody rate="\+50%">/
  );
  assert.match(
    buildSpeechSsml({ text: 'x', voice: 'pl-PL-MarekNeural', rate: 0.8 }),
    /<prosody rate="-20%">/
  );
  // Out of range values are clamped, never passed through.
  assert.match(
    buildSpeechSsml({ text: 'x', voice: 'pl-PL-MarekNeural', rate: 9 }),
    /<prosody rate="\+100%">/
  );
});

test('escapes the text so an answer cannot inject SSML', () => {
  const actual = buildSpeechSsml({
    text: '</voice><voice name="evil">hi</voice> & <b>bold</b>',
    voice: 'pl-PL-ZofiaNeural',
    rate: 1,
  });
  assert.equal(actual.match(/<voice /g).length, 1, 'exactly one voice element survives');
  assert.ok(actual.includes('&lt;/voice&gt;'));
  assert.ok(actual.includes('&amp;'));
});

test('accepts real Azure voice names and rejects anything else', () => {
  for (const voice of AZURE_TTS_VOICES) {
    assert.equal(isValidAzureVoiceName(voice), true, voice);
  }
  // HD voices carry a colon in the name.
  assert.equal(isValidAzureVoiceName('en-US-Ava:DragonHDLatestNeural'), true);
  for (const invalid of ['', 'alloy', 'pl-PL-Agnieszka Neural', '"><voice', 'a'.repeat(80)]) {
    assert.equal(isValidAzureVoiceName(invalid), false, JSON.stringify(invalid));
  }
});

test('defaults to a native Polish narrator for Polish', () => {
  assert.equal(getAzureDefaultVoice('pl'), 'pl-PL-AgnieszkaNeural');
  assert.equal(getAzureDefaultVoice('en'), 'en-US-AvaMultilingualNeural');
  assert.equal(getAzureDefaultVoice(''), 'en-US-AvaMultilingualNeural');
});

test('calls the regional endpoint and returns base64 mp3', async (t) => {
  const previousFetch = globalThis.fetch;
  /** @type {{ url: string, init: any }|null} */
  let call = null;
  globalThis.fetch = async (url, init) => {
    call = { url: String(url), init };
    return new Response(Buffer.from('fake-mp3'), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const actual = await synthesizeAzureSpeech({
    region: 'westeurope',
    key: 'k'.repeat(32),
    text: 'Gotowe.',
    voice: 'pl-PL-AgnieszkaNeural',
    rate: 1,
  });

  assert.equal(actual.ok, true);
  assert.equal(Buffer.from(actual.audioBase64, 'base64').toString(), 'fake-mp3');
  assert.equal(actual.mimeType, 'audio/mpeg');
  assert.equal(call.url, 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(call.init.headers['Ocp-Apim-Subscription-Key'], 'k'.repeat(32));
  assert.equal(call.init.headers['Content-Type'], 'application/ssml+xml');
  // Azure rejects requests without a User-Agent.
  assert.ok(call.init.headers['User-Agent']);
});

test('reports the upstream status so the client can stop retrying', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Quota exceeded', { status: 429 });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const actual = await synthesizeAzureSpeech({
    region: 'westeurope',
    key: 'k'.repeat(32),
    text: 'Gotowe.',
    voice: 'pl-PL-AgnieszkaNeural',
  });
  assert.equal(actual.ok, false);
  assert.equal(actual.status, 429);
  assert.match(actual.error, /Quota exceeded/);
});
