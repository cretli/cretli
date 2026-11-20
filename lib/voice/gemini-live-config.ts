/**
 * Gemini Live session config pinned when minting an ephemeral token / setup.
 *
 * Declarations are derived from the shared action registry via
 * `REALTIME_TOOLS`, so the OpenAI and Gemini tool sets cannot drift.
 */

import type { RealtimeToolParameters } from './action-registry.ts';
import { REALTIME_TOOLS, buildRealtimeInstructions } from './realtime-session-config.ts';

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export const GEMINI_LIVE_VOICES: string[] = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
export const DEFAULT_GEMINI_LIVE_VOICE = 'Kore';
export const GEMINI_LIVE_RELAY_PATH = '/ws-gemini-live';
export const GEMINI_LIVE_RELAY_TICKET_TTL_MS = 30_000;
const GEMINI_LIVE_WS =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export function resolveGeminiLiveVoice(voice: unknown): string {
  const raw = String(voice || '').trim();
  return GEMINI_LIVE_VOICES.includes(raw) ? raw : DEFAULT_GEMINI_LIVE_VOICE;
}

export function resolveGeminiLiveModel(requested: unknown): string {
  const raw = String(requested || '').trim();
  if (raw.startsWith('gemini-')) return raw;
  return process.env.CRETLI_GEMINI_LIVE_MODEL || DEFAULT_GEMINI_LIVE_MODEL;
}

/**
 * Gemini function declarations do not take `type: 'function'` or
 * `additionalProperties`.
 */
export function toGeminiFunctionDeclarations(): Array<{
  name: string;
  description: string;
  parameters: RealtimeToolParameters;
}> {
  return REALTIME_TOOLS.map((tool) => {
    const parameters: RealtimeToolParameters = { ...tool.parameters };
    delete parameters.additionalProperties;
    return {
      name: tool.name,
      description: tool.description,
      parameters,
    };
  });
}

/**
 * First WebSocket `setup` message.
 */
export function buildGeminiLiveSetup(
  options: { lang?: string; voice?: string; model?: string } = {},
): Record<string, unknown> {
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
 */
export function buildGeminiLiveUpstreamWsUrl(apiKey: string): string {
  return `${GEMINI_LIVE_WS}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Same-origin relay the browser opens. The ticket is not a Google key.
 */
export function buildGeminiLiveRelayClientUrl(options: {
  host?: string;
  proto?: string;
  ticket: string;
}): string {
  const host = String(options.host || 'localhost').trim() || 'localhost';
  const proto = options.proto === 'https' || options.proto === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${host}${GEMINI_LIVE_RELAY_PATH}?ticket=${encodeURIComponent(options.ticket)}`;
}
