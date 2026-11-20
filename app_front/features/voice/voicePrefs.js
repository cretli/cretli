/**
 * Read-aloud preferences (localStorage). Per device, not per chat — the setting
 * belongs to the speaker in the room, not to the conversation.
 */

import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';

const READ_MODE_KEY = 'cretli-voice-read-mode';
const ENGINE_KEY = 'cretli-voice-engine';
const RATE_KEY = 'cretli-voice-rate';
const BROWSER_VOICE_KEY = 'cretli-voice-browser-voice';
const OPENAI_VOICE_KEY = 'cretli-voice-openai-voice';
const AZURE_VOICE_KEY = 'cretli-voice-azure-voice';
const REALTIME_VOICE_KEY = 'cretli-voice-realtime-voice';
const REALTIME_PROVIDER_KEY = 'cretli-voice-realtime-provider';
const GEMINI_VOICE_KEY = 'cretli-voice-gemini-voice';
const OUTPUT_SINK_KEY = 'cretli-voice-output-sink';
const CAR_MODE_KEY = 'cretli-car-mode';
const CAR_PREV_READ_MODE_KEY = 'cretli-car-prev-read-mode';

/**
 * `final` reads the answer once the run ends; `stream` reads it sentence by sentence;
 * `agent` reads only the short version the agent sends through `voice_reply`.
 */
export const READ_MODES = ['off', 'final', 'stream', 'agent'];
export const TTS_ENGINES = ['browser', 'openai', 'azure'];
export const OPENAI_TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];

/**
 * Azure is the only engine here with native `pl-PL` voices. The list mirrors
 * `lib/voice/azure-tts.ts`, which validates the name server-side.
 */
export const AZURE_TTS_VOICES = [
  'pl-PL-AgnieszkaNeural',
  'pl-PL-MarekNeural',
  'pl-PL-ZofiaNeural',
  'en-US-AvaMultilingualNeural',
  'en-US-AndrewMultilingualNeural',
];
const AZURE_DEFAULT_VOICES = { pl: 'pl-PL-AgnieszkaNeural', en: 'en-US-AvaMultilingualNeural' };

/** Realtime adds two voices tuned for conversation; the server validates this list too. */
export const REALTIME_VOICE_OPTIONS = ['marin', 'cedar', ...OPENAI_TTS_VOICES];
export const DEFAULT_REALTIME_VOICE = 'marin';

/** Conversation backends offered in the voice-mode panel. */
export const REALTIME_PROVIDERS = ['openai-mini', 'openai', 'gemini'];
export const DEFAULT_REALTIME_PROVIDER = 'openai-mini';
export const REALTIME_PROVIDER_MODELS = {
  'openai-mini': 'gpt-realtime-2.1-mini',
  openai: 'gpt-realtime-2.1',
  gemini: 'gemini-3.1-flash-live-preview',
};
export const GEMINI_LIVE_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
export const DEFAULT_GEMINI_LIVE_VOICE = 'Kore';

export const DEFAULT_READ_MODE = 'off';
export const DEFAULT_TTS_ENGINE = 'browser';
export const DEFAULT_SPEECH_RATE = 1;
export const DEFAULT_OPENAI_VOICE = 'alloy';
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2;

/**
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function readPref(key, fallback) {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = readStorageValueWithAlias(localStorage, key, '');
    return raw ? String(raw) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function writePref(key, value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, key, value);
  } catch {
    // A blocked localStorage must not break speech itself.
  }
}

export function getReadMode() {
  const stored = readPref(READ_MODE_KEY, DEFAULT_READ_MODE);
  return READ_MODES.includes(stored) ? stored : DEFAULT_READ_MODE;
}

/**
 * @param {string} mode
 * @returns {void}
 */
export function setReadMode(mode) {
  writePref(READ_MODE_KEY, READ_MODES.includes(mode) ? mode : DEFAULT_READ_MODE);
}

/**
 * Car mode (big-button view) is reopened after a reload when it was left open.
 *
 * @returns {boolean}
 */
export function getCarMode() {
  return readPref(CAR_MODE_KEY, 'off') === 'on';
}

/**
 * @param {boolean} enabled
 * @returns {void}
 */
export function setCarMode(enabled) {
  writePref(CAR_MODE_KEY, enabled ? 'on' : 'off');
}

/**
 * Car mode reads the short `voice_reply` versions. The mode it replaced is kept in
 * localStorage so leaving car mode (also after a page reload) restores it. A re-entry that
 * still finds `agent` (reload while car mode was open) keeps the remembered mode; any other
 * current mode was chosen by hand since, so it is the one to remember.
 *
 * @returns {void}
 */
export function enterCarReadMode() {
  const remembered = readPref(CAR_PREV_READ_MODE_KEY, '');
  if (!remembered || getReadMode() !== 'agent') writePref(CAR_PREV_READ_MODE_KEY, getReadMode());
  setReadMode('agent');
}

/**
 * Restores the read mode from before car mode, unless the user changed it meanwhile: a
 * manual choice wins and only the remembered mode is dropped.
 *
 * @returns {void}
 */
export function leaveCarReadMode() {
  const previous = readPref(CAR_PREV_READ_MODE_KEY, '');
  if (!previous) return;
  if (getReadMode() === 'agent') setReadMode(previous);
  writePref(CAR_PREV_READ_MODE_KEY, '');
}

export function isReadAloudEnabled() {
  return getReadMode() !== 'off';
}

export function getTtsEngineId() {
  const stored = readPref(ENGINE_KEY, DEFAULT_TTS_ENGINE);
  return TTS_ENGINES.includes(stored) ? stored : DEFAULT_TTS_ENGINE;
}

/**
 * @param {string} engineId
 * @returns {void}
 */
export function setTtsEngineId(engineId) {
  writePref(ENGINE_KEY, TTS_ENGINES.includes(engineId) ? engineId : DEFAULT_TTS_ENGINE);
}

export function getSpeechRate() {
  const parsed = Number.parseFloat(readPref(RATE_KEY, ''));
  if (!Number.isFinite(parsed)) return DEFAULT_SPEECH_RATE;
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, parsed));
}

/**
 * @param {number} rate
 * @returns {void}
 */
export function setSpeechRate(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value)) return;
  writePref(RATE_KEY, String(Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, value))));
}

export function getBrowserVoiceName() {
  return readPref(BROWSER_VOICE_KEY, '');
}

/**
 * @param {string} name
 * @returns {void}
 */
export function setBrowserVoiceName(name) {
  writePref(BROWSER_VOICE_KEY, typeof name === 'string' ? name.trim() : '');
}

export function getOpenAiVoice() {
  const stored = readPref(OPENAI_VOICE_KEY, DEFAULT_OPENAI_VOICE);
  return OPENAI_TTS_VOICES.includes(stored) ? stored : DEFAULT_OPENAI_VOICE;
}

/**
 * @param {string} voice
 * @returns {void}
 */
export function setOpenAiVoice(voice) {
  writePref(OPENAI_VOICE_KEY, OPENAI_TTS_VOICES.includes(voice) ? voice : DEFAULT_OPENAI_VOICE);
}

/**
 * @param {string} lang two-letter UI language
 * @returns {string}
 */
export function getAzureDefaultVoice(lang) {
  return AZURE_DEFAULT_VOICES[String(lang || '').slice(0, 2)] || AZURE_DEFAULT_VOICES.en;
}

/**
 * @param {string} [lang] used only when nothing is stored yet
 * @returns {string}
 */
export function getAzureVoice(lang = '') {
  const fallback = getAzureDefaultVoice(lang);
  const stored = readPref(AZURE_VOICE_KEY, fallback);
  return AZURE_TTS_VOICES.includes(stored) ? stored : fallback;
}

/**
 * @param {string} voice
 * @returns {void}
 */
export function setAzureVoice(voice) {
  if (!AZURE_TTS_VOICES.includes(voice)) return;
  writePref(AZURE_VOICE_KEY, voice);
}

export function getRealtimeVoice() {
  const stored = readPref(REALTIME_VOICE_KEY, DEFAULT_REALTIME_VOICE);
  return REALTIME_VOICE_OPTIONS.includes(stored) ? stored : DEFAULT_REALTIME_VOICE;
}

/**
 * @param {string} voice
 * @returns {void}
 */
export function setRealtimeVoice(voice) {
  writePref(REALTIME_VOICE_KEY, REALTIME_VOICE_OPTIONS.includes(voice) ? voice : DEFAULT_REALTIME_VOICE);
}

export function getRealtimeProvider() {
  const stored = readPref(REALTIME_PROVIDER_KEY, DEFAULT_REALTIME_PROVIDER);
  return REALTIME_PROVIDERS.includes(stored) ? stored : DEFAULT_REALTIME_PROVIDER;
}

/**
 * @param {string} provider
 * @returns {void}
 */
export function setRealtimeProvider(provider) {
  writePref(
    REALTIME_PROVIDER_KEY,
    REALTIME_PROVIDERS.includes(provider) ? provider : DEFAULT_REALTIME_PROVIDER
  );
}

export function getGeminiLiveVoice() {
  const stored = readPref(GEMINI_VOICE_KEY, DEFAULT_GEMINI_LIVE_VOICE);
  return GEMINI_LIVE_VOICES.includes(stored) ? stored : DEFAULT_GEMINI_LIVE_VOICE;
}

/**
 * @param {string} voice
 * @returns {void}
 */
export function setGeminiLiveVoice(voice) {
  writePref(GEMINI_VOICE_KEY, GEMINI_LIVE_VOICES.includes(voice) ? voice : DEFAULT_GEMINI_LIVE_VOICE);
}

/**
 * Output device for the server-brokered voices (`setSinkId`); `''` is the system
 * default. The browser voice always follows the system output.
 */
export function getOutputSinkId() {
  return readPref(OUTPUT_SINK_KEY, '');
}

/**
 * @param {string} deviceId
 * @returns {void}
 */
export function setOutputSinkId(deviceId) {
  writePref(OUTPUT_SINK_KEY, typeof deviceId === 'string' ? deviceId : '');
}
