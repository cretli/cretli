/**
 * Serial speech queue: one utterance at a time, cancellable at any point.
 *
 * Cancelling bumps a generation counter, so a `speak()` promise that resolves
 * after the cancel can never resume a queue the user already stopped.
 */

import { splitForUtterances } from './speakableText.js';
import { disableTtsEngine, resolveTtsEngine } from './ttsEngine.js';
import { appLogger } from '../../core/logging/logger.js';

/**
 * @param {{
 *   getEngineId: () => string,
 *   getLang: () => string,
 *   getRate: () => number,
 *   getVoiceName: () => string,
 *   onStateChange?: (speaking: boolean) => void,
 *   onError?: (error: Error, meta: { engineId: string, permanent: boolean }) => void,
 *   resolveEngine?: (engineId: string) => import('./ttsEngine.js').TtsEngine, replaces the real engines (tests)
 * }} options
 */
export function createSpeechQueue(options) {
  const { getEngineId, getLang, getRate, getVoiceName, onStateChange, onError } = options;
  const resolveEngine = options.resolveEngine || resolveTtsEngine;

  /** @type {Array<{ text: string, tag: string, cancelled?: boolean, onStart?: () => void }>} */
  let pending = [];
  /** Utterance being spoken; `cancelled` is set before its engine is stopped. @type {{ text: string, tag: string, cancelled?: boolean }|null} */
  let activeItem = null;
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
        const next = pending.shift();
        if (!next?.text) continue;
        const text = next.text;
        activeItem = next;
        // Per-item edge: `onStateChange` only reports the start and end of the whole drain.
        if (typeof next.onStart === 'function') {
          try {
            next.onStart();
          } catch {
            // A broken observer must not stop the speech.
          }
        }
        const engine = resolveEngine(getEngineId());
        activeEngine = engine;
        const utterance = { text, lang: getLang(), rate: getRate(), voiceName: getVoiceName() };
        try {
          await engine.speak(utterance);
        } catch (error) {
          if (myGeneration !== generation) break;
          // A paid engine rejects when it is stopped: that is a cancel, not a failure to fall back from.
          if (next.cancelled) continue;
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
          if (next.cancelled) continue;
          const fallback = resolveEngine('browser');
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
      activeItem = null;
      running = false;
      notifyState(false);
    }
    // cancel() + enqueue() while this loop was still awaiting: the new text waits in `pending`
    // and its own drain() returned early because `running` was still set.
    if (pending.length > 0 && myGeneration !== generation) void drain();
  }

  return {
    /**
     * @param {string} text
     * @param {string} [tag] groups utterances so `cancelTagged` can drop them alone
     * @param {{ onStart?: () => void }} [itemOptions] `onStart` fires when the first piece of this text begins to play
     * @returns {void}
     */
    enqueue(text, tag = '', itemOptions = {}) {
      const pieces = splitForUtterances(text);
      if (pieces.length === 0) return;
      pending.push(...pieces.map((piece, index) => ({
        text: piece,
        tag,
        ...(index === 0 && itemOptions.onStart ? { onStart: itemOptions.onStart } : {}),
      })));
      void drain();
    },

    /**
     * Drops the queued utterances of one tag and stops the current one if it has that tag.
     * Untagged speech (the answer the user asked for) keeps playing.
     *
     * @param {string} tag
     * @returns {void}
     */
    cancelTagged(tag) {
      if (!tag) return;
      pending = pending.filter((item) => item.tag !== tag);
      // Cancelling the engine resolves its speak(); the drain loop then moves on.
      if (running && activeItem?.tag === tag && activeEngine) {
        // Flag first: the engine's rejection must not be mistaken for a failure.
        activeItem.cancelled = true;
        activeEngine.cancel();
      }
    },

    cancel() {
      generation += 1;
      pending = [];
      if (activeItem) activeItem.cancelled = true;
      activeItem = null;
      if (activeEngine) activeEngine.cancel();
      else resolveEngine(getEngineId()).cancel();
      activeEngine = null;
      notifyState(false);
    },

    isBusy() {
      return running || pending.length > 0;
    },
  };
}
