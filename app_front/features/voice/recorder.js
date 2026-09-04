/**
 * Microphone recorder for server-side transcription.
 *
 * Used where Web Speech is missing (Safari, Firefox): record with MediaRecorder,
 * then send the blob to Cretli, which forwards it to OpenAI.
 */

import { requestTranscription } from '../../api.js';
import { appLogger } from '../../logger.js';

/** Opus in WebM is the widely supported option; Safari answers with MP4/AAC. */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

/** A hard stop so a forgotten recording cannot grow into a huge upload. */
export const MAX_RECORDING_MS = 60_000;

/** Matches the server cap (base64 must stay inside the 8 MB JSON body limit). */
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024;

export function isMediaRecorderAvailable() {
  if (typeof window === 'undefined') return false;
  if (typeof window.MediaRecorder !== 'function') return false;
  return typeof navigator?.mediaDevices?.getUserMedia === 'function';
}

function pickMimeType() {
  if (typeof window.MediaRecorder?.isTypeSupported !== 'function') return '';
  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (window.MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  return '';
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>} base64 payload without the data URL prefix
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read the recording'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Push-to-talk recorder. One recording at a time; `stop()` resolves with the
 * transcript, so the caller can drop it straight into the input.
 *
 * @param {{ onStateChange?: (recording: boolean) => void, getLang?: () => string }} [options]
 */
export function createMicRecorder(options = {}) {
  const { onStateChange, getLang } = options;

  /** @type {MediaRecorder|null} */
  let recorder = null;
  /** @type {MediaStream|null} */
  let stream = null;
  /** @type {Blob[]} */
  let chunks = [];
  let recording = false;
  let autoStopTimer = 0;
  /** Bumped on every start so a late stop of a previous take is ignored. */
  let epoch = 0;

  function notifyState(next) {
    recording = next;
    if (typeof onStateChange === 'function') onStateChange(next);
  }

  function releaseStream() {
    if (autoStopTimer) {
      clearTimeout(autoStopTimer);
      autoStopTimer = 0;
    }
    stream?.getTracks?.().forEach((track) => track.stop());
    stream = null;
    recorder = null;
  }

  return {
    isRecording: () => recording,

    /**
     * @returns {Promise<{ ok: boolean, error?: string }>}
     */
    async start() {
      if (recording) return { ok: true };
      if (!isMediaRecorderAvailable()) {
        return { ok: false, error: 'Recording is not supported in this browser' };
      }
      epoch += 1;
      const myEpoch = epoch;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
          },
        });
      } catch (error) {
        releaseStream();
        const name = error && typeof error === 'object' ? String(error.name || '') : '';
        return {
          ok: false,
          error: name === 'NotAllowedError' ? 'Microphone permission denied' : 'Microphone is unavailable',
        };
      }
      // A newer start (or a stop) happened while permission was pending.
      if (myEpoch !== epoch) {
        releaseStream();
        return { ok: false, error: 'Recording was superseded' };
      }
      const mimeType = pickMimeType();
      chunks = [];
      recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.start();
      notifyState(true);
      autoStopTimer = window.setTimeout(() => {
        if (recorder && recorder.state === 'recording') recorder.stop();
      }, MAX_RECORDING_MS);
      return { ok: true };
    },

    /**
     * Stops the recording and transcribes it.
     *
     * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
     */
    async stop() {
      if (!recording || !recorder) {
        releaseStream();
        notifyState(false);
        return { ok: false, error: 'Nothing is being recorded' };
      }
      const activeRecorder = recorder;
      const blob = await new Promise((resolve) => {
        activeRecorder.onstop = () => {
          resolve(new Blob(chunks, { type: activeRecorder.mimeType || 'audio/webm' }));
        };
        if (activeRecorder.state !== 'inactive') activeRecorder.stop();
        else resolve(new Blob(chunks, { type: activeRecorder.mimeType || 'audio/webm' }));
      });
      releaseStream();
      notifyState(false);
      chunks = [];

      if (blob.size === 0) return { ok: false, error: 'Empty recording' };
      if (blob.size > MAX_RECORDING_BYTES) return { ok: false, error: 'Recording is too long' };

      try {
        const base64 = await blobToBase64(blob);
        const response = await requestTranscription({
          base64,
          mimeType: blob.type,
          lang: typeof getLang === 'function' ? getLang() : '',
        });
        if (!response?.ok) {
          return { ok: false, error: response?.error || 'Transcription failed' };
        }
        return { ok: true, text: String(response.text || '') };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appLogger.log('voice', 'transcription failed', { message });
        return { ok: false, error: message };
      }
    },

    /** Drops the take without transcribing it (e.g. the panel was closed). */
    cancel() {
      epoch += 1;
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.stop();
      }
      chunks = [];
      releaseStream();
      notifyState(false);
    },
  };
}
