/**
 * Maps Realtime session events to the car-mode safety layer (pure, injected deps).
 *
 * Two things must come from the driver, never from the model: confirming a stop and
 * sending a waiting prompt. So this file decides what counts as "the driver spoke"
 * (a new utterance, not the late transcript of the one that issued the tool call) and
 * when the model's own audio holds or releases the undo window.
 */

/**
 * @typedef {{
 *   gate: () => { noteModelSpeech: (active: boolean) => void, reset: () => void },
 *   noteUserSpeech: () => void,
 *   resetGuards: () => void,
 * }} SignalDeps
 */

/**
 * OpenAI Realtime: events arrive typed, so the driver's speech is `input_audio_buffer.speech_started`.
 *
 * @param {SignalDeps} deps
 */
export function createOpenAiSignals(deps) {
  /** Once the peer reports playback edges, `response.done` says nothing about the audio tail. */
  let sawAudioBufferEvents = false;
  return {
    /** @param {string} type */
    handleEvent(type) {
      if (type === 'input_audio_buffer.speech_started') {
        deps.noteUserSpeech();
      } else if (type === 'response.created' || type === 'output_audio_buffer.started') {
        if (type === 'output_audio_buffer.started') sawAudioBufferEvents = true;
        deps.gate().noteModelSpeech(true);
      } else if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
        sawAudioBufferEvents = true;
        deps.gate().noteModelSpeech(false);
      } else if (type === 'response.done' && !sawAudioBufferEvents) {
        deps.gate().noteModelSpeech(false);
      }
    },
    /** Session end: a prompt still waiting must not be sent afterwards. */
    end() {
      deps.gate().reset();
      deps.resetGuards();
      sawAudioBufferEvents = false;
    },
  };
}

/** How long after a tool-call turn ends a transcript is still taken as its trailing text. */
export const GEMINI_LATE_TRANSCRIPT_GRACE_MS = 1000;

/**
 * Gemini Live: transcription arrives asynchronously and can trail the tool call of the very
 * utterance it transcribes, even past the end of that turn. Between a tool call and the end of
 * that turn, in the frame that ends it, and for a short grace period after it, every transcript
 * is treated as the old utterance. Only a later transcript counts as the driver speaking again.
 * This fails closed: a very quick "yes" may have to be repeated, the model never confirms alone.
 *
 * @param {SignalDeps & { now?: () => number }} deps
 */
export function createGeminiSignals(deps) {
  const now = deps.now || Date.now;
  let toolTurnOpen = false;
  /** End of the last tool-call turn; transcripts until GRACE after it still belong to it. */
  let toolTurnEndedAt = -Infinity;
  return {
    /** A `toolCall` frame: the turn that issued it is still open. */
    handleToolCall() {
      toolTurnOpen = true;
    },
    /**
     * @param {{ inputText?: boolean, hasAudio?: boolean, turnComplete?: boolean, interrupted?: boolean }} frame
     */
    handleServerContent(frame) {
      const ended = Boolean(frame.turnComplete || frame.interrupted);
      // Decided before the turn closes: a transcript in the closing frame is the old utterance.
      const stale = toolTurnOpen || now() - toolTurnEndedAt < GEMINI_LATE_TRANSCRIPT_GRACE_MS;
      if (ended) {
        if (toolTurnOpen) toolTurnEndedAt = now();
        toolTurnOpen = false;
        deps.gate().noteModelSpeech(false);
      } else if (frame.hasAudio) {
        deps.gate().noteModelSpeech(true);
      }
      // `generationComplete` is deliberately not an edge: the audio is still playing.
      if (frame.inputText && !stale) deps.noteUserSpeech();
    },
    end() {
      deps.gate().reset();
      deps.resetGuards();
      toolTurnOpen = false;
      toolTurnEndedAt = -Infinity;
    },
  };
}
