/**
 * Bounded phrase search over persisted chat events for the chat_search tool.
 *
 * The scan reads the same records chat_history / chat_event use. Per event it
 * looks at the text, tool args and tool result fields through readEventField,
 * so the searchable surface matches chat_event exactly. One event yields at
 * most one match (the first matching field in CHAT_EVENT_FIELDS order), which
 * keeps a seq-based cursor free of duplicate rows.
 */

import { CHAT_EVENT_FIELDS, readEventField, unwrapHistoryEntry } from './chat-history-format.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

export const MCP_SEARCH_DEFAULT_LIMIT = 20;
export const MCP_SEARCH_MAX_LIMIT = 50;
export const MCP_SEARCH_MIN_QUERY_CHARS = 2;
export const MCP_SEARCH_MAX_QUERY_CHARS = 200;
export const MCP_SEARCH_SNIPPET_CHARS = 240;

/**
 * A single call reads at most this many events from the history page.
 * This is the event-count half of the scan bound.
 */
export const MCP_SEARCH_SCAN_MAX_EVENTS = 400;

/**
 * A single call searches at most this many field characters. A single event
 * may exceed the budget (progress must be guaranteed), so the true upper bound
 * is one event above this value.
 */
export const MCP_SEARCH_SCAN_MAX_CHARS = 400_000;

const SEARCH_CURSOR_PREFIX = 'seq:';

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function clampSearchLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return MCP_SEARCH_DEFAULT_LIMIT;
  return Math.min(MCP_SEARCH_MAX_LIMIT, Math.floor(value));
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeSearchQuery(raw) {
  const query = String(raw == null ? '' : raw).trim();
  if (query.length < MCP_SEARCH_MIN_QUERY_CHARS) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `query must be at least ${MCP_SEARCH_MIN_QUERY_CHARS} characters.`,
    );
  }
  if (query.length > MCP_SEARCH_MAX_QUERY_CHARS) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `query must be at most ${MCP_SEARCH_MAX_QUERY_CHARS} characters.`,
    );
  }
  return query;
}

/**
 * Cursor is a resume seq: `seq:<n>` means "start scanning at event seq n".
 * An invalid cursor is a VALIDATION_ERROR rather than a silently ignored arg.
 *
 * @param {unknown} raw
 * @returns {{ fromSeq: number }}
 */
export function parseSearchCursor(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { fromSeq: 0 };
  const match = new RegExp(`^${SEARCH_CURSOR_PREFIX}(\\d+)$`).exec(text);
  const seq = match ? Number(match[1]) : 0;
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'cursor is invalid.');
  }
  return { fromSeq: seq };
}

/**
 * @param {unknown} seq
 * @returns {string}
 */
export function encodeSearchCursor(seq) {
  const value = Number(seq);
  if (!Number.isInteger(value) || value <= 0) return '';
  return `${SEARCH_CURSOR_PREFIX}${value}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the searchable fields of one event, in CHAT_EVENT_FIELDS order.
 *
 * @param {Record<string, unknown>} rec
 * @returns {Array<{ field: string, text: string }>}
 */
export function readSearchableFields(rec) {
  const row = rec && typeof rec === 'object' && !Array.isArray(rec)
    ? /** @type {Record<string, unknown>} */ (rec)
    : {};
  const fields = [];
  for (const field of CHAT_EVENT_FIELDS) {
    const text = readEventField(row, field);
    if (typeof text === 'string' && text) fields.push({ field, text });
  }
  return fields;
}

/**
 * First case-insensitive phrase hit across the fields.
 *
 * @param {Array<{ field: string, text: string }>} fields
 * @param {string} query
 * @returns {{ field: string, text: string, index: number, length: number } | null}
 */
export function findSearchMatch(fields, query) {
  const rows = Array.isArray(fields) ? fields : [];
  const text = String(query || '');
  if (!text) return null;
  const pattern = new RegExp(escapeRegExp(text), 'i');
  for (const entry of rows) {
    const source = String(entry?.text || '');
    if (!source) continue;
    const found = pattern.exec(source);
    if (found) {
      return { field: entry.field, text: source, index: found.index, length: found[0].length };
    }
  }
  return null;
}

/**
 * Center a bounded window on the match, elide the edges and collapse
 * whitespace so the snippet fits on one output line.
 *
 * @param {string} text
 * @param {number} index
 * @param {number} matchLength
 * @param {number} [max]
 * @returns {string}
 */
export function buildSearchSnippet(text, index, matchLength, max = MCP_SEARCH_SNIPPET_CHARS) {
  const source = String(text || '');
  const width = Math.max(1, max - 2);
  const matchLen = Math.min(source.length, Math.max(1, Number(matchLength) || 0));
  let start = Math.max(0, (Number(index) || 0) - Math.floor((width - matchLen) / 2));
  const end = Math.min(source.length, start + width);
  start = Math.max(0, end - width);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  const snippet = `${prefix}${source.slice(start, end)}${suffix}`.replace(/\s+/g, ' ').trim();
  return snippet.length <= max ? snippet : snippet.slice(0, max);
}

/**
 * Scan one page of history events for a phrase.
 *
 * Pagination: the returned `next_cursor` is the seq to resume at. It points at
 * the first unscanned event, so consecutive pages never return a duplicate seq.
 * The scan stops when the match limit is reached, when the character budget is
 * exhausted, or when the history page ends. `hasMore` extends the cursor past
 * the last scanned event when the store holds more events than the page.
 *
 * @param {{
 *   chatId?: string,
 *   events?: unknown[],
 *   query?: string,
 *   limit?: unknown,
 *   hasMore?: boolean,
 * }} input
 * @returns {{
 *   items: Array<{ seq: number, field: string, snippet: string, pointer: string }>,
 *   next_cursor: string,
 *   truncated: boolean,
 *   scanned_from_seq: number,
 *   scanned_to_seq: number,
 *   scanned_events: number,
 *   scanned_chars: number,
 * }}
 */
export function scanHistoryForMatches(input = {}) {
  const chatId = String(input.chatId || '');
  const events = Array.isArray(input.events) ? input.events : [];
  const query = String(input.query || '');
  const limit = clampSearchLimit(input.limit);
  const items = [];
  let scannedChars = 0;
  let scannedEvents = 0;
  let scannedFirst = 0;
  let scannedLast = 0;
  let resumeSeq = 0;
  for (let index = 0; index < events.length; index += 1) {
    const entry = unwrapHistoryEntry(events[index]);
    if (entry.seq <= 0) continue;
    if (items.length >= limit) {
      resumeSeq = entry.seq;
      break;
    }
    scannedEvents += 1;
    if (scannedFirst === 0) scannedFirst = entry.seq;
    scannedLast = entry.seq;
    const fields = readSearchableFields(entry.rec);
    for (const field of fields) scannedChars += field.text.length;
    const hit = findSearchMatch(fields, query);
    if (hit) {
      items.push({
        seq: entry.seq,
        field: hit.field,
        snippet: buildSearchSnippet(hit.text, hit.index, hit.length),
        pointer: `cretli-ref chat=${chatId} seq=${entry.seq}`,
      });
    }
    if (scannedChars >= MCP_SEARCH_SCAN_MAX_CHARS
      || scannedEvents >= MCP_SEARCH_SCAN_MAX_EVENTS) {
      const next = events[index + 1] ? unwrapHistoryEntry(events[index + 1]).seq : 0;
      resumeSeq = next > 0 ? next : 0;
      break;
    }
  }
  let nextSeq = resumeSeq;
  if (nextSeq <= 0 && input.hasMore === true && scannedLast > 0) nextSeq = scannedLast + 1;
  const nextCursor = encodeSearchCursor(nextSeq);
  return {
    items,
    next_cursor: nextCursor,
    truncated: nextCursor !== '',
    scanned_from_seq: scannedFirst,
    scanned_to_seq: scannedLast,
    scanned_events: scannedEvents,
    scanned_chars: scannedChars,
  };
}
