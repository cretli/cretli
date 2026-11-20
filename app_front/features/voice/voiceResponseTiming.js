/**
 * Per-response streaming timing for live voice sessions.
 *
 * Pure state (no DOM, no storage, no logging) so the latency math can be
 * unit-tested, and both providers share the same at-most-once rules. The
 * session log wrapper lives in `voiceSessionLog.js` (`appendVoiceResponseTiming`).
 */

/** First audio of a response reached the speakers. */
export const VOICE_RESPONSE_FIRST_AUDIO_EVENT = 'response.first_audio';
/** A response finished — completed, cancelled or interrupted. */
export const VOICE_RESPONSE_END_EVENT = 'response.end';

/**
 * @typedef {{
 *   provider: string,
 *   responseId: string,
 *   startedAt: number,
 *   userSpeechEndedAt: number,
 *   firstAudioAt: number,
 * }} VoiceResponseTimingState
 */

/**
 * @typedef {{
 *   provider: string,
 *   responseId: string,
 *   latencyMs: number,
 * }} VoiceResponseFirstAudioTiming
 */

/**
 * @typedef {{
 *   provider: string,
 *   responseId: string,
 *   durationMs: number,
 * }} VoiceResponseEndTiming
 */

/**
 * Creates the tracker behind `appendVoiceResponseTiming`.
 *
 * A provider calls `begin()` when a response starts, `firstAudio()` when its
 * first audio chunk arrives and `end()` when it finishes. `firstAudio()` and
 * `end()` report at most once per response and return `null` for repeats, so
 * the provider code stays free of extra guards.
 *
 * @param {{ now?: () => number }} [options]
 */
export function createVoiceResponseTimingTracker(options = {}) {
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  /** @type {Map<string, VoiceResponseTimingState>} */
  const responses = new Map();
  /** Key of the response currently being streamed, if any. */
  let currentKey = '';
  let anonymousSeq = 0;

  /**
   * Resolves the response a phase belongs to. Gemini Live does not expose a
   * response id, so id-less calls keep hitting the open response.
   *
   * @param {string} [responseId]
   * @returns {string}
   */
  function resolveKey(responseId) {
    const id = String(responseId || '').trim();
    if (id && responses.has(id)) return id;
    if (currentKey && responses.has(currentKey)) {
      const state = responses.get(currentKey);
      if (!id || !state.responseId || state.responseId === id) return currentKey;
    }
    return id;
  }

  /**
   * Starts timing a response. Repeated calls while the same response is open
   * are no-ops, so a provider may call it on every frame of a turn.
   *
   * @param {{ provider?: string, responseId?: string, userSpeechEndedAt?: number }} [detail]
   * @returns {{ provider: string, responseId: string, startedAt: number }|null}
   */
  function begin(detail = {}) {
    const provider = String(detail.provider || '');
    const responseId = String(detail.responseId || '').trim();
    // An id-less provider is telling us the open response started, not that a
    // new one did.
    if (!responseId && currentKey && responses.has(currentKey)) return null;
    const key = responseId || `anonymous:${++anonymousSeq}`;
    if (responses.has(key)) return null;
    const startedAt = now();
    const speechEnd = Number(detail.userSpeechEndedAt);
    const userSpeechEndedAt =
      Number.isFinite(speechEnd) && speechEnd > 0 && speechEnd <= startedAt ? speechEnd : 0;
    responses.set(key, { provider, responseId, startedAt, userSpeechEndedAt, firstAudioAt: 0 });
    currentKey = key;
    return { provider, responseId, startedAt };
  }

  /**
   * Records the first audio of the open response; the latency is measured from
   * the user speech end when the provider knows it, otherwise from the
   * response start.
   *
   * @param {{ responseId?: string }} [detail]
   * @returns {VoiceResponseFirstAudioTiming|null}
   */
  function firstAudio(detail = {}) {
    const key = resolveKey(detail.responseId);
    const state = key ? responses.get(key) : null;
    if (!state || state.firstAudioAt > 0) return null;
    const at = now();
    state.firstAudioAt = at;
    const referenceAt = state.userSpeechEndedAt > 0 ? state.userSpeechEndedAt : state.startedAt;
    return {
      provider: state.provider,
      responseId: state.responseId,
      latencyMs: Math.max(0, at - referenceAt),
    };
  }

  /**
   * @param {{ responseId?: string }} [detail]
   * @returns {VoiceResponseEndTiming|null}
   */
  function end(detail = {}) {
    const key = resolveKey(detail.responseId);
    const state = key ? responses.get(key) : null;
    if (!state) return null;
    responses.delete(key);
    if (currentKey === key) currentKey = '';
    return {
      provider: state.provider,
      responseId: state.responseId,
      durationMs: Math.max(0, now() - state.startedAt),
    };
  }

  /** Drops every open response — used when a session starts or ends. */
  function reset() {
    responses.clear();
    currentKey = '';
    anonymousSeq = 0;
  }

  return { begin, firstAudio, end, reset };
}
