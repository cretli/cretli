/**
 * Text-to-speech backends behind one interface.
 *
 * `browser` uses the built-in speech synthesis: free, offline, available on
 * phones. `openai` and `azure` go through the Cretli server so the API key stays
 * there — `azure` is the one with native `pl-PL` voices.
 */

import { requestSpeech } from '../../api.js';
import { appLogger } from '../../logger.js';

/**
 * @typedef {Object} TtsUtterance
 * @property {string} text
 * @property {string} lang BCP-47 tag, e.g. `pl-PL`.
 * @property {number} rate
 * @property {string} [voiceName]
 */

/**
 * @typedef {Object} TtsEngine
 * @property {string} id
 * @property {() => boolean} isAvailable
 * @property {(utterance: TtsUtterance) => Promise<void>} speak
 * @property {() => void} cancel
 */

function getSynth() {
  if (typeof window === 'undefined') return null;
  return window.speechSynthesis || null;
}

/** @type {SpeechSynthesisVoice[]} */
let cachedVoices = [];

function refreshCachedVoices() {
  const synth = getSynth();
  if (!synth || typeof synth.getVoices !== 'function') return;
  const voices = synth.getVoices();
  if (Array.isArray(voices) && voices.length > 0) cachedVoices = voices;
}

if (getSynth()) {
  refreshCachedVoices();
  const synth = getSynth();
  if (synth && typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', refreshCachedVoices);
  }
}

/**
 * Voices installed in the browser, newest snapshot available.
 *
 * @param {string} [langPrefix] two-letter language filter, e.g. `pl`
 * @returns {Array<{ name: string, lang: string }>}
 */
export function listBrowserVoices(langPrefix = '') {
  refreshCachedVoices();
  const prefix = String(langPrefix || '').slice(0, 2).toLowerCase();
  return cachedVoices
    .filter((voice) => !prefix || String(voice.lang || '').toLowerCase().startsWith(prefix))
    .map((voice) => ({ name: voice.name, lang: voice.lang }));
}

export function isBrowserTtsAvailable() {
  const synth = getSynth();
  return !!synth && typeof window.SpeechSynthesisUtterance === 'function';
}

/**
 * Safari and Chrome on iOS only allow speech that starts inside a user gesture.
 * Speaking a blank utterance from the enabling click unlocks the rest.
 *
 * @returns {void}
 */
export function primeBrowserSpeech() {
  const synth = getSynth();
  if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') return;
  try {
    const utterance = new window.SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    synth.speak(utterance);
  } catch {
    // Priming is best effort; a failure just means the first answer may be silent.
  }
}

/**
 * @param {string} lang
 * @param {string} voiceName
 * @returns {SpeechSynthesisVoice|null}
 */
function pickBrowserVoice(lang, voiceName) {
  refreshCachedVoices();
  if (cachedVoices.length === 0) return null;
  const wanted = String(voiceName || '').trim();
  if (wanted) {
    const exact = cachedVoices.find((voice) => voice.name === wanted);
    if (exact) return exact;
  }
  const prefix = String(lang || '').slice(0, 2).toLowerCase();
  if (!prefix) return null;
  return cachedVoices.find((voice) => String(voice.lang || '').toLowerCase().startsWith(prefix)) || null;
}

/**
 * @returns {TtsEngine}
 */
function createBrowserTtsEngine() {
  return {
    id: 'browser',
    isAvailable: isBrowserTtsAvailable,

    speak({ text, lang, rate, voiceName }) {
      const synth = getSynth();
      if (!synth) return Promise.reject(new Error('speechSynthesis is unavailable'));
      return new Promise((resolve, reject) => {
        const utterance = new window.SpeechSynthesisUtterance(text);
        utterance.lang = lang;
        utterance.rate = rate;
        const voice = pickBrowserVoice(lang, voiceName);
        if (voice) utterance.voice = voice;
        utterance.onend = () => resolve();
        utterance.onerror = (event) => {
          // cancel() reports itself as an error rather than as onend.
          const reason = String(event?.error || '');
          if (reason === 'interrupted' || reason === 'canceled') {
            resolve();
            return;
          }
          reject(new Error(reason || 'speechSynthesis failed'));
        };
        synth.speak(utterance);
      });
    },

    cancel() {
      const synth = getSynth();
      if (!synth) return;
      try {
        synth.cancel();
      } catch {
        // Nothing to do — the utterance is gone either way.
      }
    },
  };
}

/**
 * Statuses that will not resolve themselves between two sentences: missing key,
 * exhausted credits, revoked key, quota. Retrying those once per sentence only
 * burns time and leaves the user waiting in silence.
 */
const PERMANENT_SPEECH_FAILURE_STATUSES = new Set([401, 402, 403, 429]);

/**
 * Decides whether a failed speech request is worth retrying on the next
 * sentence.
 *
 * @param {{ error?: string, upstreamStatus?: number }|null} response
 * @returns {{ message: string, isPermanent: boolean }}
 */
export function classifySpeechFailure(response) {
  const message = String(response?.error || '').trim() || 'Speech request failed';
  const status = Number(response?.upstreamStatus || 0);
  // A missing key is reported by Cretli itself (503), not by OpenAI.
  const noKey = !status && /api key/i.test(message);
  return { message, isPermanent: PERMANENT_SPEECH_FAILURE_STATUSES.has(status) || noKey };
}

/**
 * @param {{ error?: string, upstreamStatus?: number }|null} response
 * @returns {Error & { isPermanent?: boolean }}
 */
function createSpeechError(response) {
  const { message, isPermanent } = classifySpeechFailure(response);
  const error = /** @type {Error & { isPermanent?: boolean }} */ (new Error(message));
  error.isPermanent = isPermanent;
  return error;
}

/** Budget for playback to start, and for it to keep progressing afterwards. */
const PLAYBACK_START_TIMEOUT_MS = 10000;
const PLAYBACK_PROGRESS_SLACK_MS = 6000;

/**
 * Server-brokered engines (OpenAI, Azure) differ only in the provider they ask
 * for: the request, the playback and the failure handling are the same.
 *
 * @param {string} id
 * @returns {TtsEngine}
 */
function createRemoteTtsEngine(id) {
  /** @type {HTMLAudioElement|null} */
  let audio = null;
  let cancelled = false;
  let watchdog = 0;

  function releaseAudio() {
    window.clearTimeout(watchdog);
    watchdog = 0;
    if (!audio) return;
    try {
      audio.pause();
      audio.src = '';
    } catch {
      // The element is being discarded anyway.
    }
    audio = null;
  }

  return {
    id,
    isAvailable: () => typeof Audio === 'function',

    async speak({ text, lang, rate, voiceName }) {
      cancelled = false;
      const response = await requestSpeech({
        text,
        voice: voiceName,
        speed: rate,
        provider: id,
        lang,
      });
      if (cancelled) return;
      if (!response?.ok || !response.audioBase64) {
        throw createSpeechError(response);
      }
      const mimeType = response.mimeType || 'audio/mpeg';
      await new Promise((resolve, reject) => {
        releaseAudio();
        audio = new Audio(`data:${mimeType};base64,${response.audioBase64}`);
        const element = audio;
        // Without an output device `play()` can resolve while `ended` never
        // fires; the queue would then wait for this sentence forever.
        const settle = (fn, arg) => {
          window.clearTimeout(watchdog);
          fn(arg);
        };
        const armWatchdog = (ms) => {
          window.clearTimeout(watchdog);
          watchdog = window.setTimeout(
            () => settle(reject, new Error('Audio playback stalled')),
            ms
          );
        };
        element.onended = () => settle(resolve);
        element.onerror = () => settle(reject, new Error('Audio playback failed'));
        element.ontimeupdate = () => {
          const remainingMs = Number.isFinite(element.duration)
            ? Math.max(0, element.duration - element.currentTime) * 1000
            : PLAYBACK_START_TIMEOUT_MS;
          armWatchdog(remainingMs + PLAYBACK_PROGRESS_SLACK_MS);
        };
        armWatchdog(PLAYBACK_START_TIMEOUT_MS);
        element.play().catch((error) => {
          // Autoplay policies block playback until the user interacts with the page.
          settle(reject, error instanceof Error ? error : new Error('Audio playback blocked'));
        });
      });
      releaseAudio();
    },

    cancel() {
      cancelled = true;
      releaseAudio();
    },
  };
}

/** Engines brokered by the Cretli server; anything else falls back to `browser`. */
const REMOTE_ENGINE_IDS = ['openai', 'azure'];

/** @type {Record<string, TtsEngine>} */
const engines = {};

/** Engines taken out of service for this page load. */
const disabledEngines = new Set();

/**
 * Takes an engine out of service until the user changes the setting or reloads.
 *
 * @param {string} engineId
 * @returns {void}
 */
export function disableTtsEngine(engineId) {
  if (engineId === 'browser') return;
  disabledEngines.add(engineId);
  appLogger.log('voice', 'tts engine disabled for this session', { engine: engineId });
}

/**
 * @param {string} engineId
 * @returns {boolean}
 */
export function isTtsEngineDisabled(engineId) {
  return disabledEngines.has(engineId);
}

/** Called when the user changes the engine or voice — worth one more try. */
export function resetTtsEngineFailures() {
  disabledEngines.clear();
}

/**
 * @param {string} engineId
 * @returns {TtsEngine}
 */
export function resolveTtsEngine(engineId) {
  const id = REMOTE_ENGINE_IDS.includes(engineId) ? engineId : 'browser';
  if (id !== 'browser' && disabledEngines.has(id)) return resolveTtsEngine('browser');
  if (!engines[id]) {
    engines[id] = id === 'browser' ? createBrowserTtsEngine() : createRemoteTtsEngine(id);
  }
  const engine = engines[id];
  if (engine.isAvailable()) return engine;
  if (id === 'browser') return engine;
  appLogger.log('voice', 'tts engine unavailable, falling back to the browser one', { engine: id });
  return resolveTtsEngine('browser');
}
