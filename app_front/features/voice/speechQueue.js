/**
 * Serial speech queue: one utterance at a time, cancellable at any point.
 *
 * Cancelling bumps a generation counter, so a `speak()` promise that resolves
 * after the cancel can never resume a queue the user already stopped.
 */

import { splitForUtterances } from './speakableText.js';
import { disableTtsEngine, resolveTtsEngine } from './ttsEngine.js';
import { appLogger } from '../../logger.js';

/**
 * @param {{
 *   getEngineId: () => string,
 *   getLang: () => string,
 *   getRate: () => number,
 *   getVoiceName: () => string,
 *   onStateChange?: (speaking: boolean) => void,
 *   onError?: (error: Error, meta: { engineId: string, permanent: boolean }) => void,
 * }} options
 */
export function createSpeechQueue(options) {
  const { getEngineId, getLang, getRate, getVoiceName, onStateChange, onError } = options;

  /** @type {string[]} */
  let pending = [];
  let generation = 0;
  let running = false;
  /** @type {import('./ttsEngine.js').TtsEngine|null} */
  let activeEngine = null;

  function notifyState(speaking) {
    if (typeof onStateChange !== 'function') return;
    onStateChange(speaking);
  }

  async function drain() {
    if (running) return;
    running = true;
    const myGeneration = generation;
    notifyState(true);
    try {
      while (pending.length > 0 && myGeneration === generation) {
        const text = pending.shift();
        if (!text) continue;
        const engine = resolveTtsEngine(getEngineId());
        activeEngine = engine;
        const utterance = { text, lang: getLang(), rate: getRate(), voiceName: getVoiceName() };
        try {
          await engine.speak(utterance);
        } catch (error) {
          if (myGeneration !== generation) break;
          const err = error instanceof Error ? error : new Error(String(error));
          appLogger.log('voice', 'speech failed', { engine: engine.id, message: err.message });
          // No credits or a dead key stays broken for the next sentence too.
          const permanent = err.isPermanent === true;
          if (permanent) disableTtsEngine(engine.id);
          if (typeof onError === 'function') {
            onError(err, { engineId: engine.id, permanent });
          }
          if (engine.id === 'browser') {
            // Nothing left to fall back to; a broken engine would otherwise fail
            // once per queued sentence.
            pending = [];
            break;
          }
          // A paid engine can fail for reasons the user cannot fix mid-answer
          // (no credits, rate limit, network). Reading it in the built-in voice
          // beats silence.
          const fallback = resolveTtsEngine('browser');
          activeEngine = fallback;
          try {
            await fallback.speak({ ...utterance, voiceName: '' });
          } catch {
            pending = [];
            break;
          }
        }
      }
    } finally {
      activeEngine = null;
      running = false;
      notifyState(false);
    }
  }

  return {
    /**
     * @param {string} text
     * @returns {void}
     */
    enqueue(text) {
      const pieces = splitForUtterances(text);
      if (pieces.length === 0) return;
      pending.push(...pieces);
      void drain();
    },

    cancel() {
      generation += 1;
      pending = [];
      if (activeEngine) activeEngine.cancel();
      else resolveTtsEngine(getEngineId()).cancel();
      activeEngine = null;
      notifyState(false);
    },

    isBusy() {
      return running || pending.length > 0;
    },
  };
}
