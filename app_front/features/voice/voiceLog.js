/**
 * Voice-panel transcript log. Gemini Live streams word-sized deltas, so
 * consecutive speech from the same speaker is merged onto one line.
 */

const SENTENCE_PUNCT_START = /^[,.;:!?…)]/;

/**
 * Joins a new transcription chunk onto the text already shown.
 * Deltas are appended; a cumulative rewrite replaces the previous string.
 *
 * @param {string} previous
 * @param {string} next
 * @returns {string}
 */
export function mergeSpeechChunk(previous, next) {
  const a = String(previous || '');
  const b = String(next || '').trim();
  if (!b) return a;
  if (!a) return b;
  if (b.startsWith(a)) return b;
  if (a.endsWith(b)) return a;
  const needsSpace = !/\s$/.test(a) && !SENTENCE_PUNCT_START.test(b);
  return needsSpace ? `${a} ${b}` : `${a}${b}`;
}

/**
 * Appends a panel log entry. Same-speaker speech is folded into the last line.
 *
 * @param {Array<{ kind: string, role?: string, text: string, failed?: boolean }>} log
 * @param {{ kind: string, role?: string, text: string, failed?: boolean }} entry
 * @param {number} [maxEntries]
 * @returns {Array<{ kind: string, role?: string, text: string, failed?: boolean }>}
 */
export function appendVoiceLog(log, entry, maxEntries = 14) {
  const next = Array.isArray(log) ? log : [];
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 14;
  if (entry?.kind === 'speech' && next.length > 0) {
    const last = next[next.length - 1];
    if (last.kind === 'speech' && last.role === entry.role) {
      return [...next.slice(0, -1), { ...last, text: mergeSpeechChunk(last.text, entry.text) }].slice(
        -limit
      );
    }
  }
  return [...next, entry].slice(-limit);
}
