/**
 * Gemini Live session config pinned when minting an ephemeral token / setup.
 *
 * Tool names must stay in sync with `app_front/features/voice/realtimeTools.js`
 * and `lib/voice/realtime-session-config.js`.
 */

import { REALTIME_TOOLS, buildRealtimeInstructions } from './realtime-session-config.js';

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const GEMINI_LIVE_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
export const DEFAULT_GEMINI_LIVE_VOICE = 'Kore';
export const GEMINI_LIVE_RELAY_PATH = '/ws-gemini-live';
export const GEMINI_LIVE_RELAY_TICKET_TTL_MS = 30_000;
const GEMINI_LIVE_WS =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/**
 * @param {unknown} voice
 * @returns {string}
 */
export function resolveGeminiLiveVoice(voice) {
  const raw = String(voice || '').trim();
  return GEMINI_LIVE_VOICES.includes(raw) ? raw : DEFAULT_GEMINI_LIVE_VOICE;
}

/**
 * @param {unknown} requested
 * @returns {string}
 */
export function resolveGeminiLiveModel(requested) {
  const raw = String(requested || '').trim();
  if (raw.startsWith('gemini-')) return raw;
  return process.env.CRETLI_GEMINI_LIVE_MODEL || DEFAULT_GEMINI_LIVE_MODEL;
}

/**
 * Gemini function declarations do not take `type: 'function'` or
 * `additionalProperties`.
 *
 * @returns {Array<{ name: string, description: string, parameters: object }>}
 */
export function toGeminiFunctionDeclarations() {
  return REALTIME_TOOLS.map((tool) => {
    const parameters = { ...(tool.parameters || {}) };
    delete parameters.additionalProperties;
    return {
      name: tool.name,
      description: tool.description,
      parameters,
    };
  });
}

/**
 * @param {{ lang?: string, voice?: string, model?: string }} [options]
 * @returns {object} first WebSocket `setup` message
 */
export function buildGeminiLiveSetup(options = {}) {
  const lang = options.lang === 'pl' ? 'pl' : 'en';
  const voice = resolveGeminiLiveVoice(options.voice);
  const model = resolveGeminiLiveModel(options.model);
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        thinkingConfig: { thinkingLevel: 'minimal' },
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
      systemInstruction: { parts: [{ text: buildRealtimeInstructions({ lang }) }] },
      tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
      outputAudioTranscription: {},
      inputAudioTranscription: {},
    },
  };
}

/**
 * Upstream Google Live socket. The API key stays on the server.
 *
 * @param {string} apiKey
 * @returns {string}
 */
export function buildGeminiLiveUpstreamWsUrl(apiKey) {
  return `${GEMINI_LIVE_WS}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Same-origin relay the browser opens. The ticket is not a Google key.
 *
 * @param {{ host?: string, proto?: string, ticket: string }} options
 * @returns {string}
 */
export function buildGeminiLiveRelayClientUrl(options) {
  const host = String(options.host || 'localhost').trim() || 'localhost';
  const proto = options.proto === 'https' || options.proto === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${host}${GEMINI_LIVE_RELAY_PATH}?ticket=${encodeURIComponent(options.ticket)}`;
}
