/**
 * Context compression helpers: history formatting, chunking, structured prompts, seed merge.
 * Shared between server (map-reduce) and browser (seed payload).
 */

/** Characters per map-reduce chunk when summarizing long chats. */
export const CONTEXT_COMPRESSION_BATCH_CHARS = 6000;

/** Max characters sent in a single agent print prompt (head + tail preserve). */
export const CONTEXT_COMPRESSION_PROMPT_MAX_CHARS = 8000;

/** Default auto-compression trigger (% of model context window). */
export const CONTEXT_COMPRESSION_DEFAULT_THRESHOLD_PERCENT = 80;

const STRUCTURED_SUMMARY_SECTIONS =
  '## Goal\n## Decisions (with rationale)\n## Files touched (exact paths)\n## Open tasks / bugs\n## Errors and constraints\n## Recent context (last turns, verbatim if short)';

const STRUCTURED_JSON_SUFFIX =
  '\n\nRespond with ONLY one JSON line: {"summary":"<structured session state using markdown sections above>","title":"<short chat title, max 50 chars>"}. ' +
  'Preserve exact file paths, function names, error messages, and decisions. No other text.';

/**
 * @param {unknown} event
 * @returns {string}
 */
export function extractAssistantPlainText(event) {
  if (!event || typeof event !== 'object') return '';
  const ev = /** @type {Record<string, unknown>} */ (event);
  if (ev.type !== 'assistant' || !ev.message || typeof ev.message !== 'object') return '';
  const msg = /** @type {Record<string, unknown>} */ (ev.message);
  const content = Array.isArray(msg.content) ? msg.content : [];
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const part = /** @type {Record<string, unknown>} */ (block);
    if (part.type === 'text' && typeof part.text === 'string') out += part.text;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeAutoContextCompressionThresholdPercent(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return CONTEXT_COMPRESSION_DEFAULT_THRESHOLD_PERCENT;
  return Math.min(95, Math.max(50, parsed));
}

/**
 * @param {unknown} fillPercent
 * @param {unknown} thresholdPercent
 * @returns {boolean}
 */
export function shouldTriggerAutoContextCompression(fillPercent, thresholdPercent) {
  const fill = Number(fillPercent);
  const threshold = normalizeAutoContextCompressionThresholdPercent(thresholdPercent);
  if (!Number.isFinite(fill)) return false;
  return fill >= threshold;
}

/**
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateTextForAgentPrompt(str, maxLen = CONTEXT_COMPRESSION_PROMPT_MAX_CHARS) {
  const raw = str == null ? '' : String(str);
  const limit = Math.max(200, Number(maxLen) || CONTEXT_COMPRESSION_PROMPT_MAX_CHARS);
  if (raw.length <= limit) return raw;
  const marker = '\n... [truncated] ...\n';
  const headLen = Math.floor((limit - marker.length) / 2);
  const tailLen = limit - marker.length - headLen;
  return `${raw.slice(0, headLen)}${marker}${raw.slice(-tailLen)}`;
}

/**
 * @param {string} text
 * @param {number} [batchSize]
 * @returns {string[]}
 */
export function splitTextIntoCompressionChunks(text, batchSize = CONTEXT_COMPRESSION_BATCH_CHARS) {
  const raw = String(text ?? '').trim();
  const size = Math.max(500, Number(batchSize) || CONTEXT_COMPRESSION_BATCH_CHARS);
  if (!raw) return [];
  if (raw.length <= size) return [raw];
  /** @type {string[]} */
  const chunks = [];
  let offset = 0;
  while (offset < raw.length) {
    chunks.push(raw.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

/**
 * @param {unknown} message
 * @returns {string}
 */
function extractSdkUserPlainText(message) {
  if (!message || typeof message !== 'object') return '';
  const msg = /** @type {Record<string, unknown>} */ (message);
  if (typeof msg.text === 'string') return msg.text.trim();
  const content = Array.isArray(msg.content) ? msg.content : [];
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const part = /** @type {Record<string, unknown>} */ (block);
    if (part.type === 'text' && typeof part.text === 'string') out += part.text;
  }
  return out.trim();
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function formatSdkEventForCompression(event) {
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'user') {
    const userText = extractSdkUserPlainText(event.message);
    return userText ? `\n> ${userText}\n` : '';
  }
  if (type === 'assistant') {
    const assistantText = extractAssistantPlainText(event).trim();
    return assistantText ? `${assistantText}\n\n` : '';
  }
  if (type === 'tool_call') {
    const name = typeof event.name === 'string' ? event.name : 'tool';
    const status = typeof event.status === 'string' ? event.status : '';
    const args =
      event.args && typeof event.args === 'object'
        ? JSON.stringify(event.args).slice(0, 1200)
        : '';
    return `[tool ${name} · ${status}]${args ? ` ${args}` : ''}\n`;
  }
  if (type === 'thinking') {
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text) return '';
    const clipped = text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
    return `[thinking] ${clipped}\n\n`;
  }
  return '';
}

/**
 * @param {Array<{ seq?: number, rec?: unknown }>} events
 * @returns {string}
 */
export function formatChatHistoryEventsToText(events) {
  if (!Array.isArray(events) || events.length === 0) return '';
  const sorted = [...events].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  /** @type {string[]} */
  const parts = [];
  let lastAssistantText = '';
  for (const entry of sorted) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (rec);
    if (record.kind === 'localUser' && typeof record.text === 'string') {
      lastAssistantText = '';
      const userText = record.text.trim();
      if (userText) parts.push(`\n> ${userText}\n`);
      continue;
    }
    if (record.kind === 'meta' && record.variant === 'contextSeed' && typeof record.payload === 'string') {
      lastAssistantText = '';
      const seed = record.payload.trim();
      if (seed) parts.push(`\n[PRIOR COMPRESSED CONTEXT]\n${seed}\n[/PRIOR COMPRESSED CONTEXT]\n`);
      continue;
    }
    if (record.kind !== 'sdk' || !record.event || typeof record.event !== 'object') continue;
    const event = /** @type {Record<string, unknown>} */ (record.event);
    if (event.type === 'assistant') {
      const assistantText = extractAssistantPlainText(event).trim();
      if (!assistantText) continue;
      if (lastAssistantText && assistantText.startsWith(lastAssistantText)) {
        if (assistantText.length <= lastAssistantText.length) continue;
        if (parts.length > 0) parts.pop();
      } else if (lastAssistantText && lastAssistantText.startsWith(assistantText)) {
        continue;
      }
      lastAssistantText = assistantText;
      parts.push(`${assistantText}\n\n`);
      continue;
    }
    lastAssistantText = '';
    const formatted = formatSdkEventForCompression(event);
    if (formatted) parts.push(formatted);
  }
  return parts.join('').trim();
}

/**
 * @param {Array<{ summary?: string, at?: string }>} summaries
 * @returns {string}
 */
export function buildExistingStateFromSummaries(summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0) return '';
  return summaries
    .map((entry) => String(entry?.summary || '').trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}

/**
 * @param {Array<{ summary?: string, title?: string, at?: string }>} summaries
 * @returns {string}
 */
export function buildSeedSummaryFromSummaries(summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0) return '';
  const texts = summaries
    .map((entry) => String(entry?.summary || '').trim())
    .filter(Boolean);
  if (texts.length === 0) return '';
  if (texts.length === 1) return texts[0];
  return texts
    .map((text, index) => {
      const entry = summaries[index];
      const at = typeof entry?.at === 'string' ? entry.at : '';
      const header = at ? `### Session state ${index + 1} (${at})` : `### Session state ${index + 1}`;
      return `${header}\n${text}`;
    })
    .join('\n\n');
}

/**
 * @param {string} chunkText
 * @param {number} chunkIndex
 * @param {number} totalChunks
 * @returns {string}
 */
export function buildStructuredChunkSummaryPrompt(chunkText, chunkIndex, totalChunks) {
  const segment = truncateTextForAgentPrompt(chunkText);
  return (
    `Conversation segment ${chunkIndex} of ${totalChunks}:\n\n` +
    `${segment}\n\n` +
    `Create a structured session state document with these sections:\n${STRUCTURED_SUMMARY_SECTIONS}` +
    STRUCTURED_JSON_SUFFIX
  );
}

/**
 * @param {string} chunkText
 * @param {string} existingState
 * @param {number} chunkIndex
 * @param {number} totalChunks
 * @returns {string}
 */
export function buildStructuredMergeSummaryPrompt(chunkText, existingState, chunkIndex, totalChunks) {
  const segment = truncateTextForAgentPrompt(chunkText);
  const state = truncateTextForAgentPrompt(existingState, 12000);
  return (
    `You maintain an anchored session state document. Merge segment ${chunkIndex} of ${totalChunks} into the current state without dropping prior decisions, file paths, or open tasks.\n\n` +
    `CURRENT STATE:\n${state}\n\n` +
    `NEW SEGMENT:\n${segment}\n\n` +
    `Return the updated full state document with sections:\n${STRUCTURED_SUMMARY_SECTIONS}` +
    STRUCTURED_JSON_SUFFIX
  );
}

/**
 * @param {string} chunkText
 * @param {string} [existingState]
 * @param {number} chunkIndex
 * @param {number} totalChunks
 * @returns {string}
 */
export function buildCompressionPromptForChunk(chunkText, existingState, chunkIndex, totalChunks) {
  const prior = String(existingState || '').trim();
  if (!prior) {
    return buildStructuredChunkSummaryPrompt(chunkText, chunkIndex, totalChunks);
  }
  return buildStructuredMergeSummaryPrompt(chunkText, prior, chunkIndex, totalChunks);
}
