/**
 * Reads agent answers aloud.
 *
 * One speaker for the whole app: only the active chat feeds it, so switching
 * chats never turns into two voices talking over each other.
 */

import { getCurrentLang } from '../../i18n/index.js';
import { createSpeechQueue } from './speechQueue.js';
import { takeCompleteSentences, toSpeakableText } from './speakableText.js';
import {
  getAzureVoice,
  getBrowserVoiceName,
  getOpenAiVoice,
  getReadMode,
  getSpeechRate,
  getTtsEngineId,
} from './voicePrefs.js';

const SPEECH_LANGS = { en: 'en-US', pl: 'pl-PL' };

/**
 * Each engine names its voices differently, so the queue asks for the one that
 * belongs to the engine currently selected.
 *
 * @returns {string}
 */
function resolveVoiceName() {
  const engineId = getTtsEngineId();
  if (engineId === 'openai') return getOpenAiVoice();
  if (engineId === 'azure') return getAzureVoice(getCurrentLang());
  return getBrowserVoiceName();
}

/** Fired on window so UI controls can show a playing state. */
export const VOICE_SPEAKING_EVENT = 'cr-voice-speaking';

/** Fired on window when an engine fails, so the send bar can say why. */
export const VOICE_ERROR_EVENT = 'cr-voice-error';

/** @type {ReturnType<typeof createChatSpeaker>|null} */
let sharedSpeaker = null;

function resolveSpeechLang() {
  return SPEECH_LANGS[getCurrentLang()] || SPEECH_LANGS.en;
}

function createChatSpeaker() {
  /** Speakable text of the answer block currently streaming in. */
  let blockSpeakable = '';
  /** Characters of `blockSpeakable` already handed to the queue. */
  let spokenChars = 0;
  /** Earlier answer blocks of the same run, kept for the `final` mode. */
  let finishedBlocks = '';
  /** Identifies who asked for the current playback, for per-block button state. */
  let activeToken = '';
  /** Last completed answer, kept so the voice agent can read it back on request. */
  let lastAnswerSpeakable = '';
  /** Voice mode needs the text even with reading off; parsing every delta is not free. */
  let trackingForced = false;

  const queue = createSpeechQueue({
    getEngineId: getTtsEngineId,
    getLang: resolveSpeechLang,
    getRate: getSpeechRate,
    getVoiceName: resolveVoiceName,
    onStateChange: (speaking) => {
      const token = activeToken;
      if (!speaking) activeToken = '';
      if (typeof window === 'undefined') return;
      window.dispatchEvent(
        new CustomEvent(VOICE_SPEAKING_EVENT, { detail: { active: speaking, token } })
      );
    },
    onError: (error, meta) => {
      if (typeof window === 'undefined') return;
      window.dispatchEvent(
        new CustomEvent(VOICE_ERROR_EVENT, {
          detail: { message: error.message, engineId: meta?.engineId || '', permanent: meta?.permanent === true },
        })
      );
    },
  });

  function resetAnswerState() {
    blockSpeakable = '';
    spokenChars = 0;
    finishedBlocks = '';
  }

  return {
    /**
     * Streaming assistant text of the active chat, as a growing accumulator.
     *
     * @param {string} fullMarkdown
     * @returns {void}
     */
    handleAssistantText(fullMarkdown) {
      const mode = getReadMode();
      if (mode === 'off' && !trackingForced) return;
      const speakable = toSpeakableText(fullMarkdown);
      if (!speakable) return;

      if (!speakable.startsWith(blockSpeakable)) {
        // The text got shorter (a trailing title stripped mid-stream) — nothing new.
        if (blockSpeakable.startsWith(speakable)) return;
        // A fresh answer block after a tool call; the previous one still counts.
        if (blockSpeakable) {
          finishedBlocks = finishedBlocks ? `${finishedBlocks}\n${blockSpeakable}` : blockSpeakable;
        }
        blockSpeakable = '';
        spokenChars = 0;
      }
      blockSpeakable = speakable;
      if (mode !== 'stream') return;

      const { ready, consumed } = takeCompleteSentences(speakable.slice(spokenChars));
      if (!ready) return;
      spokenChars += consumed;
      queue.enqueue(ready);
    },

    /** The run ended: speak whatever is still owed. */
    endAnswer() {
      const mode = getReadMode();
      const fullText = [finishedBlocks, blockSpeakable].filter(Boolean).join('\n').trim();
      if (fullText) lastAnswerSpeakable = fullText;
      if (mode === 'off') {
        resetAnswerState();
        return;
      }
      if (mode === 'final') {
        if (fullText) queue.enqueue(fullText);
        resetAnswerState();
        return;
      }
      const { ready } = takeCompleteSentences(blockSpeakable.slice(spokenChars), { force: true });
      if (ready) queue.enqueue(ready);
      resetAnswerState();
    },

    /** A new prompt was sent: the previous answer is no longer worth hearing. */
    resetAnswer() {
      queue.cancel();
      resetAnswerState();
    },

    /**
     * Manual read of one answer block. Clicking again while it plays stops it.
     *
     * @param {string} markdown
     * @param {string} [token]
     * @returns {void}
     */
    toggleSpeakMarkdown(markdown, token = '') {
      if (queue.isBusy()) {
        const wasSameSource = !!token && token === activeToken;
        queue.cancel();
        if (wasSameSource) return;
      }
      const text = toSpeakableText(markdown);
      if (!text) return;
      activeToken = token;
      queue.enqueue(text);
    },

    stop() {
      queue.cancel();
    },

    isSpeaking() {
      return queue.isBusy();
    },

    /**
     * Keeps the last answer available while voice mode is live, even with
     * read-aloud switched off.
     *
     * @param {boolean} enabled
     * @returns {void}
     */
    setAnswerTracking(enabled) {
      trackingForced = enabled === true;
    },

    /** @returns {string} speakable text of the last completed answer */
    getLastAnswerText() {
      return lastAnswerSpeakable;
    },
  };
}

/**
 * @returns {ReturnType<typeof createChatSpeaker>}
 */
export function getChatSpeaker() {
  if (!sharedSpeaker) sharedSpeaker = createChatSpeaker();
  return sharedSpeaker;
}
