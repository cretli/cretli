/**
 * Turns provider events into exactly one `response.first_audio` and one
 * `response.end` per model response. Providers emit many audio chunks and may
 * repeat completion events; the diagnosis latency math needs single marks.
 */

import { appendVoiceResponseTiming } from './voiceSessionLog.js';

/**
 * @param {{ emit?: (kind: 'first_audio'|'end', detail?: object) => void }} [options]
 */
export function createVoiceResponseTiming(options = {}) {
  const emit = options.emit || appendVoiceResponseTiming;
  let open = false;
  let audioSeen = false;

  return {
    /** A response began (also opened implicitly by the first audio chunk). */
    markStart() {
      open = true;
    },

    /** Call for every audio chunk / audio-started event. */
    markAudio() {
      if (audioSeen) return;
      audioSeen = true;
      open = true;
      emit('first_audio');
    },

    /** Call when the provider reports the response finished. */
    markEnd() {
      if (!open) return;
      open = false;
      audioSeen = false;
      emit('end');
    },

    reset() {
      open = false;
      audioSeen = false;
    },
  };
}
