/**
 * Turn timing state for Gemini Live responses.
 *
 * Gemini Live has no explicit "response created" frame, so the session handler
 * infers the response start from turn content. Input transcription is user
 * speech, not a response: it must never open one (that would fold the user's
 * speech into the first-audio latency and leave a stale response open across
 * turns) and it only supplies the first-audio reference timestamp.
 *
 * Pure state (no DOM, no WebSocket) so the turn rules stay unit-testable.
 */

/**
 * @param {{ now?: () => number }} [options]
 */
export function createGeminiTurnTiming(options = {}) {
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  /** Timestamp of the last user input-transcription frame. */
  let lastUserSpeechAt = 0;

  /**
   * Classifies one `serverContent` frame.
   *
   * Input transcription only notes the user speech end; it never opens a
   * response. Model content (model parts or output transcription) opens one,
   * first audio is reported when the frame carries audio, and a completion
   * flag closes the open response — a completion without one is a no-op.
   *
   * @param {{
   *   inputText?: boolean,
   *   hasModelContent?: boolean,
   *   hasAudio?: boolean,
   *   completed?: boolean,
   * }} [frame]
   * @returns {{
   *   start: boolean,
   *   userSpeechEndedAt: number,
   *   firstAudio: boolean,
   *   end: boolean,
   * }}
   */
  function readFrame(frame = {}) {
    if (frame?.inputText) {
      const ts = now();
      if (Number.isFinite(ts) && ts > 0) lastUserSpeechAt = ts;
    }
    const start = Boolean(frame?.hasModelContent);
    const userSpeechEndedAt = start ? lastUserSpeechAt : 0;
    // Consume the reference once so it cannot leak into a later turn that
    // starts without new user speech.
    if (start) lastUserSpeechAt = 0;
    return {
      start,
      userSpeechEndedAt,
      firstAudio: Boolean(frame?.hasAudio),
      end: Boolean(frame?.completed),
    };
  }

  return {
    readFrame,
    /** Drops the pending speech reference (session start or stop). */
    reset() {
      lastUserSpeechAt = 0;
    },
  };
}
