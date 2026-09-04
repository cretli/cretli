import assert from 'node:assert/strict';
import test from 'node:test';
import { REALTIME_TOOLS } from '../lib/voice/realtime-session-config.js';
import {
  buildGeminiLiveRelayClientUrl,
  buildGeminiLiveSetup,
  buildGeminiLiveUpstreamWsUrl,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_VOICE,
  GEMINI_LIVE_RELAY_PATH,
  resolveGeminiLiveVoice,
  toGeminiFunctionDeclarations,
} from '../lib/voice/gemini-live-config.js';

test('maps Cretli tools to Gemini function declarations', () => {
  const actual = toGeminiFunctionDeclarations();
  assert.deepEqual(
    actual.map((tool) => tool.name).sort(),
    REALTIME_TOOLS.map((tool) => tool.name).sort()
  );
  for (const tool of actual) {
    assert.equal(tool.parameters.additionalProperties, undefined, `${tool.name} must drop additionalProperties`);
    assert.ok(!('type' in tool) || tool.type !== 'function');
  }
});

test('defaults to the current Gemini Live model', () => {
  assert.equal(DEFAULT_GEMINI_LIVE_MODEL, 'gemini-3.1-flash-live-preview');
});

test('pins audio output, voice and instructions on setup', () => {
  const actual = buildGeminiLiveSetup({ lang: 'pl', voice: 'Puck' });
  assert.equal(actual.setup.model, `models/${DEFAULT_GEMINI_LIVE_MODEL}`);
  assert.deepEqual(actual.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(actual.setup.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(actual.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.match(actual.setup.systemInstruction.parts[0].text, /Polish/);
});

test('keeps the Google key on the server and gives the browser a relay URL', () => {
  const upstream = buildGeminiLiveUpstreamWsUrl('AQ.example-key-not-real-000000000000');
  assert.match(upstream, /v1beta\.GenerativeService\.BidiGenerateContent\?key=/);
  assert.ok(!upstream.includes('v1alpha'));
  const relay = buildGeminiLiveRelayClientUrl({
    host: 'localhost:3011',
    proto: 'https',
    ticket: 'abc',
  });
  assert.equal(relay, `wss://localhost:3011${GEMINI_LIVE_RELAY_PATH}?ticket=abc`);
  assert.ok(!relay.includes('generativelanguage'));
});

test('falls back to the default Gemini voice', () => {
  assert.equal(resolveGeminiLiveVoice('not-a-voice'), DEFAULT_GEMINI_LIVE_VOICE);
  assert.equal(resolveGeminiLiveVoice('Kore'), 'Kore');
});
