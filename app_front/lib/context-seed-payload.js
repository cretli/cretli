/** Marker wrapping compressed conversation context in a seeded user prompt. */
export const CONTEXT_SEED_BEGIN = '[COMPRESSED CONTEXT]';

/** Closing marker for compressed conversation context. */
export const CONTEXT_SEED_END = '[/COMPRESSED CONTEXT]';

/** Prefix before the real user message in a seeded prompt payload. */
export const CONTEXT_SEED_USER_PREFIX = 'Current user message:\n';

// Chats stored before the markers were translated still carry the Polish form.
// Reading both keeps archived history splitting into context + message.
const LEGACY_MARKERS = {
  begin: '[KONTEKST SKOMPRESOWANY]',
  end: '[/KONTEKST SKOMPRESOWANY]',
  userPrefix: 'Aktualna wiadomość użytkownika:\n',
};

/**
 * @typedef {object} ContextSeedPayloadParts
 * @property {boolean} hasSeed
 * @property {string} summary
 * @property {string} userText
 */

/**
 * Build the SDK prompt payload that carries compressed context plus the user message.
 *
 * @param {string} summary
 * @param {string} userText
 * @returns {string}
 */
export function buildContextSeedPayload(summary, userText) {
  const seedSummary = summary == null ? '' : String(summary).trim();
  const message = userText == null ? '' : String(userText);
  if (!seedSummary) return message;
  return (
    `${CONTEXT_SEED_BEGIN}\n` +
    `${seedSummary}\n` +
    `${CONTEXT_SEED_END}\n\n` +
    `${CONTEXT_SEED_USER_PREFIX}${message}`
  );
}

/**
 * Split a seeded prompt payload into compressed context and the user message.
 *
 * @param {unknown} text
 * @returns {ContextSeedPayloadParts}
 */
export function parseContextSeedPayload(text) {
  const raw = text == null ? '' : String(text);
  const markers = raw.includes(CONTEXT_SEED_BEGIN)
    ? { begin: CONTEXT_SEED_BEGIN, end: CONTEXT_SEED_END, userPrefix: CONTEXT_SEED_USER_PREFIX }
    : LEGACY_MARKERS;
  const beginIdx = raw.indexOf(markers.begin);
  if (beginIdx < 0) {
    return { hasSeed: false, summary: '', userText: raw };
  }
  const afterBegin = raw.slice(beginIdx + markers.begin.length);
  const endIdx = afterBegin.indexOf(markers.end);
  if (endIdx < 0) {
    return { hasSeed: false, summary: '', userText: raw };
  }
  const summary = afterBegin.slice(0, endIdx).replace(/^\n+|\n+$/g, '');
  const rest = afterBegin.slice(endIdx + markers.end.length).replace(/^\s+/, '');
  let userText = '';
  if (rest.startsWith(markers.userPrefix)) {
    userText = rest.slice(markers.userPrefix.length);
  } else if (rest) {
    userText = rest;
  }
  return { hasSeed: true, summary, userText };
}
