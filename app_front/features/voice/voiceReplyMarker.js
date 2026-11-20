/**
 * Client side of the `voice_reply` contract (lib/mcp/builtin/voice-tools.js).
 *
 * In the `agent` read mode every prompt gets a one-line instruction with a turn
 * id; the agent answers it by calling `voice_reply` with the same id.
 */

/**
 * @returns {string} short random turn id, valid for the tool's `turn` pattern
 */
export function createVoiceTurnId() {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `v${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {string} turn
 * @returns {string} instruction line appended to the prompt the agent receives
 */
export function buildVoiceReplyMarker(turn) {
  return `[voice-reply mode, turn=${turn}: after your normal answer call voice_reply once with turn=${turn} and 1-3 plain sentences: the conclusion and any question or decision; no markdown]`;
}

/**
 * `agent` read mode (SDK transport only): asks the agent for a short spoken version. The user's
 * bubble keeps the text without the marker, so `displayText` is always set explicitly (an empty
 * one would make the server show the payload).
 *
 * @param {{ enabled: boolean, payloadText: string, displayText: string, issueTurn: (turn: string) => void }} input
 * @returns {{ payloadText: string, displayText: string, voiceTurn: string }}
 */
export function prepareVoiceReplyPayload(input) {
  if (!input.enabled) return { payloadText: input.payloadText, displayText: input.displayText, voiceTurn: '' };
  const voiceTurn = createVoiceTurnId();
  input.issueTurn(voiceTurn);
  return {
    payloadText: `${input.payloadText}\n\n${buildVoiceReplyMarker(voiceTurn)}`,
    displayText: input.displayText.trim() ? input.displayText : input.payloadText,
    voiceTurn,
  };
}

/**
 * @param {unknown} payload `payload` of a `voiceReply` history record (JSON string)
 * @returns {{ text: string, turn: string } | null}
 */
export function parseVoiceReplyPayload(payload) {
  try {
    const data = typeof payload === 'string' ? JSON.parse(payload) : null;
    if (!data || typeof data !== 'object') return null;
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    const turn = typeof data.turn === 'string' ? data.turn : '';
    return text ? { text, turn } : null;
  } catch {
    return null;
  }
}

/**
 * Newest `voiceReply` entry of a stored history (records or `{ rec }` rows).
 *
 * @param {unknown[]} events
 * @returns {{ text: string, turn: string } | null}
 */
export function findLastVoiceReply(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = /** @type {any} */ (list[i]);
    const rec = entry?.rec || entry;
    if (rec?.kind === 'meta' && rec.variant === 'voiceReply') {
      const parsed = parseVoiceReplyPayload(rec.payload);
      if (parsed) return parsed;
    }
  }
  return null;
}
