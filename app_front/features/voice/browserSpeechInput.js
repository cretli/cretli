import { decideEmit } from './utteranceDedupe.js';
import { FATAL_VOICE_ERRORS, isSecure, mapSpeechError } from './voiceDiagnostics.js';

/**
 * Browser dictation through the Web Speech API (`SpeechRecognition`).
 *
 * No provider key is involved: the browser (or OS) does the recognition. Two
 * consumers share this file: the send bar microphone (`sendBarMedia.js`, which
 * only needs the transcript de-duplication) and hands-free browser voice mode
 * (`browserVoiceMode.js`, which needs the whole controller below).
 */

/**
 * @typedef {{ continuous: boolean, interimResults: boolean, lang: string, start: () => void, stop: () => void, onresult: ((event: any) => void) | null, onerror: ((event: { error?: string }) => void) | null, onend: (() => void) | null }} BrowserRecognizer
 * @typedef {new () => BrowserRecognizer} BrowserRecognizerCtor
 * @typedef {{ SpeechRecognition?: BrowserRecognizerCtor, webkitSpeechRecognition?: BrowserRecognizerCtor }} SpeechRecognitionWindow
 */
export const DICTATION_LANGS = { en: 'en-US', pl: 'pl-PL' };

/** Silence after the last result that ends an utterance. */
export const DEFAULT_SILENCE_MS = 1300;
/** Delay before the recognizer is started again after it ended on its own. */
const RESTART_DELAY_MS = 80;
/** How long after a flush a final result of the same speech is still recognised as a duplicate. */
const LATE_FINAL_MS = 4000;

/**
 * @param {Window|object|undefined} [win]
 * @returns {BrowserRecognizerCtor|null} the recognizer constructor, or null where the API is missing
 */
export function getSpeechRecognitionCtor(win = typeof window === 'undefined' ? undefined : window) {
  if (!win) return null;
  return /** @type {SpeechRecognitionWindow} */ (win).SpeechRecognition || /** @type {SpeechRecognitionWindow} */ (win).webkitSpeechRecognition || null;
}

/**
 * @param {Window|object|undefined} [win]
 * @returns {boolean}
 */
export function isBrowserSpeechAvailable(win) {
  return Boolean(getSpeechRecognitionCtor(win));
}

/**
 * Chrome re-sends the whole cumulative transcript in each final result, so a
 * naive join repeats words. Returns only the part of `transcript` that is new.
 *
 * @param {string[]} accumulated segments already taken
 * @param {string} lastCumulative the previous final transcript, as the engine sent it
 * @param {string} transcript the new final transcript
 * @returns {{ segment: string, lastCumulative: string }} empty `segment` means nothing new
 */
export function nextFinalSegment(accumulated, lastCumulative, transcript) {
  const text = String(transcript || '').replace(/\s+/g, ' ').trim();
  if (!text) return { segment: '', lastCumulative };
  const candidateWords = text.split(' ');
  const previousWords = String(lastCumulative || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let segment = text;
  if (previousWords.length) {
    const extendsPrevious = previousWords.length <= candidateWords.length
      && previousWords.every((word, index) => word.toLowerCase() === candidateWords[index].toLowerCase());
    const shrinksPrevious = candidateWords.length <= previousWords.length
      && candidateWords.every((word, index) => word.toLowerCase() === previousWords[index].toLowerCase());
    if (extendsPrevious) segment = candidateWords.slice(previousWords.length).join(' ');
    else if (shrinksPrevious || candidateWords[0].toLowerCase() === previousWords[0].toLowerCase()) segment = '';
  }
  const last = accumulated[accumulated.length - 1];
  if (last && last.toLowerCase() === segment.toLowerCase()) segment = '';
  const candidateIsRevision = previousWords.length > 0
    && !previousWords.every((word, index) => word.toLowerCase() === candidateWords[index]?.toLowerCase())
    && candidateWords[0].toLowerCase() === previousWords[0].toLowerCase();
  const keepPrevious = candidateIsRevision && candidateWords.length < previousWords.length;
  return { segment, lastCumulative: keepPrevious ? lastCumulative : text };
}

/**
 * @typedef {import('./voiceDiagnostics.js').VoiceErrorCode} BrowserSpeechErrorCode
 */

/**
 * Continuous recognizer that turns pauses into utterances.
 *
 * `pause()` stops the recognizer and drops whatever it had heard (used while
 * the app is speaking, so its own voice never comes back as a prompt);
 * `resume()` starts it again after `resumeDelayMs`.
 *
 * @param {{
 *   getLang?: () => string,
 *   win?: object,
 *   silenceMs?: number,
 *   resumeDelayMs?: number,
 *   onUtterance?: (text: string) => void,
 *   onInterim?: (text: string) => void,
 *   onState?: (state: { listening: boolean, paused: boolean }) => void,
 *   onError?: (error: { code: BrowserSpeechErrorCode, message: string }) => void,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   isSpeaking?: () => boolean,
 *   now?: () => number,
 * }} [options]
 */
export function createBrowserSpeechInput(options = {}) {
  const {
    getLang = () => 'en',
    win = typeof window === 'undefined' ? undefined : window,
    silenceMs = DEFAULT_SILENCE_MS,
    resumeDelayMs = 350,
    onUtterance = () => {},
    onInterim = () => {},
    onState = () => {},
    onError = () => {},
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(/** @type {any} */ (handle)),
    isSpeaking = () => false,
    now = () => Date.now(),
  } = options;

  /** @type {any} */
  let recognition = null;
  let wanted = false;
  let paused = false;
  let fatal = false;
  let accumulated = [];
  let finalSegments = [];
  let lastCumulative = '';
  let lastResultWasFinal = false;
  let breakPendingFinalGroup = false;
  let interim = '';
  /** @type {unknown} */
  let silenceTimer = null;
  /** @type {unknown} */
  let restartTimer = null;
  /** True from the first pause() until resume() runs: the app is (or may be) speaking. */
  let holdForSpeech = false;
  /** Normalized words already covered by an emission in the current utterance. */
  let covered = '';
  let coveredAt = 0;

  function emitState() {
    onState({ listening: wanted && !paused, paused });
  }

  function clearSilence() {
    if (silenceTimer != null) clearTimer(silenceTimer);
    silenceTimer = null;
  }

  function clearRestart() {
    if (restartTimer != null) clearTimer(restartTimer);
    restartTimer = null;
  }

  function resetBuffer() {
    accumulated = [];
    finalSegments = [];
    lastCumulative = '';
    lastResultWasFinal = false;
    breakPendingFinalGroup = false;
    interim = '';
    onInterim('');
  }

  function flush() {
    clearSilence();
    const finalParts = accumulated;
    const interimText = interim;
    accumulated = [];
    interim = '';
    onInterim('');
    for (const { text } of finalParts) onUtterance(text);
    if (interimText) {
      const currentWords = interimText.toLowerCase().split(/\s+/).filter(Boolean);
      const priorWords = lastCumulative.toLowerCase().split(/\s+/).filter(Boolean);
      const sameUtterance = priorWords.length > 0 && currentWords[0] === priorWords[0];
      if (!sameUtterance || currentWords.length >= priorWords.length) {
        finalSegments = [interimText];
        lastCumulative = interimText;
      }
      emitCandidate(interimText);
    }
  }

  function emitCandidate(candidate, isFinal = false, utteranceKey = '', fullTranscript = '', finalContinuation = false) {
    if (covered && now() - coveredAt > LATE_FINAL_MS) covered = '';
    const hadCoverage = Boolean(covered);
    const decision = decideEmit(covered, candidate);
    covered = decision.covered;
    coveredAt = now();
    if (decision.emit) {
      if (isFinal) {
        const key = utteranceKey || candidate.trim().split(/\s+/)[0].toLowerCase();
        const previous = accumulated.at(-1);
        if (!breakPendingFinalGroup && previous?.key === key && previous.full) {
          previous.text = fullTranscript || `${previous.text} ${decision.emit}`;
        } else {
          accumulated.push({
            key,
            text: hadCoverage || finalContinuation ? decision.emit : (fullTranscript || decision.emit),
            full: !hadCoverage && !finalContinuation,
          });
        }
        breakPendingFinalGroup = false;
      } else onUtterance(decision.emit);
    }
    if (isFinal) {
      covered = '';
      coveredAt = 0;
    }
  }

  function armSilence() {
    clearSilence();
    silenceTimer = setTimer(flush, silenceMs);
  }

  function startRecognizer() {
    if (!recognition || !wanted || paused || fatal || holdForSpeech || isSpeaking()) return;
    // A (re)started recognizer begins a new utterance.
    covered = '';
    coveredAt = 0;
    try {
      recognition.lang = DICTATION_LANGS[getLang()] || DICTATION_LANGS.en;
      recognition.start();
    } catch {
      // `start()` throws when a run is already active; the next `onend` retries.
    }
  }

  function ensureRecognition() {
    if (recognition) return true;
    const Ctor = getSpeechRecognitionCtor(win);
    if (!Ctor) return false;
    recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (paused || !wanted) return;
      let lastInterim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0] && result[0].transcript ? result[0].transcript.trim() : '';
        if (result.isFinal) {
          const previousFinalWords = lastCumulative.toLowerCase().split(/\s+/).filter(Boolean);
          const transcriptWords = transcript.toLowerCase().split(/\s+/).filter(Boolean);
          const finalContinuation = previousFinalWords.length > 0
            && previousFinalWords[0] === transcriptWords[0];
          const finalShrinksPrevious = finalContinuation && transcriptWords.length < previousFinalWords.length;
          const next = nextFinalSegment(finalSegments, lastCumulative, transcript);
          lastCumulative = next.lastCumulative;
          if (next.segment) finalSegments.push(next.segment);
          interim = '';
          const utteranceKey = transcript.toLowerCase().split(/\s+/)[0] || '';
          const previousGroup = accumulated.at(-1);
          if (!finalShrinksPrevious && !breakPendingFinalGroup && previousGroup?.key === utteranceKey && previousGroup.full) {
            previousGroup.text = transcript;
          }
          emitCandidate(next.segment, true, utteranceKey, transcript, finalContinuation);
          lastResultWasFinal = true;
        } else {
          if (lastResultWasFinal) {
            finalSegments = [];
            lastCumulative = '';
            breakPendingFinalGroup = true;
          }
          lastResultWasFinal = false;
          lastInterim = transcript;
        }
      }
      interim = lastInterim;
      onInterim([...accumulated.map(({ text }) => text), interim].join(' ').trim());
      if (accumulated.length > 0 || interim) armSilence();
    };
    recognition.onerror = (event) => {
      const raw = String(event?.error || '');
      // Silence and our own stop() are routine (code ''); `onend` restarts the recognizer.
      const code = mapSpeechError(raw, { secure: isSecure(win) });
      if (!code) return;
      if (FATAL_VOICE_ERRORS.includes(code)) {
        fatal = true;
        wanted = false;
        clearSilence();
        emitState();
      }
      onError({ code, message: raw || 'unknown' });
    };
    recognition.onend = () => {
      if (!wanted || paused || fatal || holdForSpeech) return;
      clearRestart();
      restartTimer = setTimer(() => {
        restartTimer = null;
        startRecognizer();
      }, RESTART_DELAY_MS);
    };
    return true;
  }

  return {
    /** @returns {{ ok: true } | { ok: false, code: BrowserSpeechErrorCode }} */
    start() {
      if (!ensureRecognition()) {
        onError({ code: 'unsupported', message: 'SpeechRecognition is not available' });
        return { ok: false, code: 'unsupported' };
      }
      wanted = true;
      fatal = false;
      covered = '';
      coveredAt = 0;
      resetBuffer();
      // Starting while the app is already speaking: wait for the speech to end instead of listening to it.
      holdForSpeech = isSpeaking();
      paused = holdForSpeech;
      emitState();
      startRecognizer();
      return { ok: true };
    },
    stop() {
      wanted = false;
      paused = false;
      holdForSpeech = false;
      clearSilence();
      clearRestart();
      resetBuffer();
      try {
        recognition?.stop();
      } catch {}
      emitState();
    },
    pause() {
      // Always cancel a scheduled restart: a pause inside the resume window must win.
      holdForSpeech = true;
      clearRestart();
      if (!wanted) return;
      paused = true;
      clearSilence();
      resetBuffer();
      try {
        recognition?.stop();
      } catch {}
      emitState();
    },
    resume() {
      holdForSpeech = false;
      if (!wanted || !paused) return;
      clearRestart();
      restartTimer = setTimer(() => {
        restartTimer = null;
        // Speech may have started again while this timer was pending.
        if (!wanted || holdForSpeech || isSpeaking()) return;
        paused = false;
        resetBuffer();
        emitState();
        startRecognizer();
      }, resumeDelayMs);
    },
    isListening() {
      return wanted && !paused;
    },
    isWanted() {
      return wanted;
    },
    isPaused() {
      return paused;
    },
  };
}
