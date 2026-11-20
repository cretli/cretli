/**
 * Fallback for `agent` read mode in car mode: when the agent sent no `voice_reply`,
 * the driver still hears the opening of the full answer.
 */

const DEFAULT_SENTENCES = 2;
const DEFAULT_MAX_CHARS = 280;

/**
 * First sentences of an answer, capped so a run-on paragraph is not read out whole.
 *
 * @param {string} text speakable text (markdown already stripped)
 * @param {{ sentences?: number, maxChars?: number }} [options]
 * @returns {string}
 */
export function firstSentences(text, options = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const limit = options.sentences ?? DEFAULT_SENTENCES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const boundary = /[.!?…]["')\]]*(?:\s|$)/g;
  let end = 0;
  let count = 0;
  let match = boundary.exec(raw);
  while (match !== null && count < limit) {
    end = match.index + match[0].length;
    count += 1;
    match = boundary.exec(raw);
  }
  let out = (end > 0 ? raw.slice(0, end) : raw).trim();
  if (out.length > maxChars) {
    const cut = out.lastIndexOf(' ', maxChars);
    out = out.slice(0, cut > 0 ? cut : maxChars).trim();
  }
  return out;
}
