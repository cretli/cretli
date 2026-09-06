/**
 * Compact and paged renderers for MCP chat history.
 * Offsets are UTF-16 code units (JavaScript string indexes). Slices concatenate
 * without loss, including Polish letters and emoji.
 */

import { truncateText } from './result.js';
import { parseRelatedChatPayload } from '../../chat-relation-payload.js';

export const MCP_HISTORY_DEFAULT_LIMIT = 40;
export const MCP_HISTORY_MAX_LIMIT = 80;
export const MCP_TOOL_PAYLOAD_CHARS = 400;
export const MCP_EVENT_TEXT_CHARS = 1500;
export const MCP_HISTORY_PAGE_CHARS = 8000;
export const MCP_EVENT_SLICE_DEFAULT = 1500;
export const MCP_EVENT_SLICE_MAX = 4000;
export const CHAT_EVENT_FIELDS = Object.freeze(['text', 'args', 'result']);

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function clampHistoryLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return MCP_HISTORY_DEFAULT_LIMIT;
  return Math.min(MCP_HISTORY_MAX_LIMIT, Math.floor(value));
}

/**
 * Slice length for chat_event. Omitted values use the default. Fractions, zero,
 * and non-integers are invalid so a truncated read cannot stall on the same offset.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: number } | { ok: false, value: 0 }}
 */
export function parseEventSliceLength(raw) {
  if (raw == null || raw === '') {
    return { ok: true, value: MCP_EVENT_SLICE_DEFAULT };
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value <= 0) return { ok: false, value: 0 };
  return { ok: true, value: Math.min(MCP_EVENT_SLICE_MAX, value) };
}

/**
 * @param {unknown} rec
 * @returns {Record<string, unknown>}
 */
function asRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return {};
  return /** @type {Record<string, unknown>} */ (rec);
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function extractAssistantText(event) {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function fieldJson(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {unknown} entry
 * @returns {{ seq: number, rec: Record<string, unknown> }}
 */
export function unwrapHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return { seq: 0, rec: {} };
  const row = /** @type {Record<string, unknown>} */ (entry);
  const seq = Number(row.seq) || 0;
  const rec = row.rec && typeof row.rec === 'object' ? asRecord(row.rec) : asRecord(row);
  return { seq, rec };
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {Record<string, unknown> | null}
 */
function sdkEventFromRec(rec) {
  if (rec.kind === 'sdk' && rec.event && typeof rec.event === 'object') {
    return asRecord(rec.event);
  }
  if (rec.kind && rec.kind !== 'sdk') return null;
  if (rec.type) return rec;
  return rec.event && typeof rec.event === 'object' ? asRecord(rec.event) : null;
}

/**
 * Raw field used by chat_event. No trim — fragments must concatenate.
 *
 * @param {Record<string, unknown>} rec
 * @param {string} field
 * @returns {string}
 */
export function readEventField(rec, field) {
  const name = String(field || '').trim();
  if (name === 'text') {
    if (typeof rec.text === 'string' && (rec.kind === 'localUser' || !sdkEventFromRec(rec))) {
      return rec.text;
    }
    const event = sdkEventFromRec(rec);
    if (event?.type === 'assistant') return extractAssistantText(event);
    return typeof rec.text === 'string' ? rec.text : '';
  }
  const event = sdkEventFromRec(rec);
  if (!event || event.type !== 'tool_call') return '';
  if (name === 'args') return fieldJson(event.args);
  if (name === 'result') return fieldJson(event.result);
  return '';
}

/**
 * @param {string} text
 * @param {unknown} offset
 * @param {unknown} length
 */
export function sliceEventField(text, offset, length) {
  const source = typeof text === 'string' ? text : '';
  const offRaw = Number(offset);
  const off = Number.isInteger(offRaw) && offRaw >= 0 ? offRaw : 0;
  const parsed = parseEventSliceLength(length);
  const lim = parsed.ok ? parsed.value : 0;
  if (lim <= 0) {
    return {
      fragment: '',
      offset: off,
      total_length: source.length,
      next_offset: null,
      truncated: false,
    };
  }
  const fragment = source.slice(off, off + lim);
  const next = off + fragment.length;
  const progressed = next > off;
  const atEnd = next >= source.length || !progressed;
  return {
    fragment,
    offset: off,
    total_length: source.length,
    next_offset: atEnd ? null : next,
    truncated: !atEnd,
  };
}

/**
 * Compact conversation: user + assistant + tool-call counts (no payloads).
 *
 * @param {unknown} history
 * @returns {string}
 */
export function formatHistoryTail(history) {
  const page = prepareHistoryPage(history, { compactTools: true, forward: false });
  return page.compact_text;
}

/**
 * @param {{ seq: number, rec: Record<string, unknown> }} entry
 * @param {{ includeToolPayloads?: boolean, compactTools?: boolean, maxEventChars?: number }} [options]
 * @returns {{ line: string, item: Record<string, unknown> } | null}
 */
export function formatHistoryEvent(entry, options = {}) {
  const seq = Number(entry?.seq) || 0;
  const rec = asRecord(entry?.rec);
  const includeToolPayloads = options.includeToolPayloads === true;
  const compactTools = options.compactTools === true;
  const maxEventChars = Number(options.maxEventChars) > 0 ? Number(options.maxEventChars) : MCP_EVENT_TEXT_CHARS;
  const userText = rec.kind === 'localUser' && typeof rec.text === 'string' ? rec.text : '';
  if (userText) {
    const clipped = truncateText(userText, maxEventChars);
    return {
      line: `${seq}  user  ${clipped.text}`,
      preview: clipped.text,
      item: {
        seq,
        kind: 'user',
        text_truncated: clipped.truncated,
        preview_chars: clipped.text.length,
      },
    };
  }
  if (rec.kind === 'meta' && rec.variant === 'relatedChat') {
    const data = parseRelatedChatPayload(rec.payload);
    if (!data) return null;
    const title = data.title || data.chatId;
    const clipped = truncateText(title, maxEventChars);
    return {
      line: `${seq}  related_chat  ${data.role}  ${clipped.text}`,
      preview: clipped.text,
      item: {
        seq,
        kind: 'related_chat',
        role: data.role,
        chat_id: data.chatId,
      },
    };
  }
  const event = sdkEventFromRec(rec);
  if (!event) return null;
  if (event.type === 'assistant') {
    const text = extractAssistantText(event);
    if (!text) return null;
    const clipped = truncateText(text, maxEventChars);
    return {
      line: `${seq}  assistant  ${clipped.text}`,
      preview: clipped.text,
      item: {
        seq,
        kind: 'assistant',
        text_truncated: clipped.truncated,
        preview_chars: clipped.text.length,
      },
    };
  }
  if (event.type === 'tool_call') {
    const name = String(event.name || 'tool').trim() || 'tool';
    const status = String(event.status || '').trim() || 'unknown';
    const item = {
      seq,
      kind: 'tool',
      name,
      status,
      call_id: event.call_id ? String(event.call_id) : '',
    };
    const lines = [`${seq}  tool  ${name}  ${status}`];
    if (includeToolPayloads && !compactTools) {
      const args = truncateText(fieldJson(event.args), MCP_TOOL_PAYLOAD_CHARS);
      const result = truncateText(fieldJson(event.result), MCP_TOOL_PAYLOAD_CHARS);
      if (args.text) {
        item.args_truncated = args.truncated;
        item.args_preview_chars = args.text.length;
        lines.push(`  args  ${args.text}`);
      }
      if (result.text) {
        item.result_truncated = result.truncated;
        item.result_preview_chars = result.text.length;
        lines.push(`  result  ${result.text}`);
      }
    }
    return { line: lines.join('\n'), preview: '', item };
  }
  if (event.type === 'opencode_question') {
    return { line: `${seq}  pending_question`, preview: '', item: { seq, kind: 'pending_question' } };
  }
  if (event.type === 'opencode_permission') {
    return { line: `${seq}  pending_permission`, preview: '', item: { seq, kind: 'pending_permission' } };
  }
  return null;
}

/**
 * Compact conversation for chat_show. Uses the same packed rows as the seq page.
 *
 * @param {{ item: Record<string, unknown>, preview?: string }[]} rows
 * @returns {string}
 */
function renderCompactHistory(rows) {
  const lines = [];
  const tools = [];
  for (const row of rows) {
    const kind = row.item?.kind;
    if (kind === 'tool') {
      tools.push(row.item);
      continue;
    }
    if (kind === 'user' && row.preview) lines.push(`\n> ${row.preview}`);
    else if (kind === 'assistant' && row.preview) lines.push(`\n${row.preview}`);
    else if (kind === 'related_chat') {
      lines.push(`\n[${row.item?.role || 'related'} chat: ${row.preview || row.item?.chat_id || ''}]`);
    }
    else if (kind === 'pending_question') lines.push('\n(pending question)');
    else if (kind === 'pending_permission') lines.push('\n(pending permission)');
  }
  if (tools.length > 0) {
    const byKey = new Map();
    for (const call of tools) {
      const key = `${call.name}:${call.status}`;
      byKey.set(key, (byKey.get(key) || 0) + 1);
    }
    const summary = [...byKey.entries()].map(([key, count]) => `${key}×${count}`).join(', ');
    lines.push(`\n[tool calls: ${tools.length} — ${summary}]`);
  }
  return lines.join('\n').trim();
}

/**
 * Full tool text: header, body, continue hints, and paging. Length is the page budget.
 *
 * @param {{
 *   titleHeader?: string,
 *   section?: string,
 *   headSeq?: number,
 *   body?: string,
 *   events?: object[],
 *   cursors?: { next_from_seq?: number | null, next_before_seq?: number | null, truncated?: boolean },
 *   chatId?: string,
 * }} input
 * @returns {string}
 */
export function assembleHistoryPageText(input = {}) {
  const titleHeader = String(input.titleHeader || '').trim();
  const section = String(input.section || 'history').trim() || 'history';
  const headSeq = Number(input.headSeq) || 0;
  const events = Array.isArray(input.events) ? input.events : [];
  const seqs = events.map((row) => Number(row?.seq) || 0).filter((seq) => seq > 0);
  const oldest = seqs.length > 0 ? seqs[0] : 0;
  const newest = seqs.length > 0 ? seqs[seqs.length - 1] : 0;
  const headerLines = [];
  if (titleHeader) headerLines.push(titleHeader);
  headerLines.push(`head_seq: ${headSeq}  events: ${events.length}  seqs: ${oldest || '-'}–${newest || '-'}`);
  headerLines.push('');
  headerLines.push(`--- ${section} ---`);
  const body = String(input.body || '') || '(no renderable events)';
  const hints = formatContinueHints(input.chatId, events);
  const paging = formatHistoryPagingLines(input.cursors || {});
  return [headerLines.join('\n'), body, hints, paging]
    .filter((part) => String(part || '').trim())
    .join('\n\n');
}

/**
 * @param {{ item: Record<string, unknown>, line: string, preview?: string }[]} rows
 * @param {{ compactTools?: boolean }} options
 * @returns {string}
 */
function renderPackedBody(rows, options = {}) {
  if (options.compactTools === true) return renderCompactHistory(rows);
  return rows.map((row) => row.line).join('\n');
}

/**
 * @param {{ line: string, item: Record<string, unknown> }[]} formatted
 * @param {{
 *   maxPageChars?: number,
 *   direction?: 'forward' | 'backward',
 *   chatId?: string,
 *   titleHeader?: string,
 *   section?: string,
 *   headSeq?: number,
 *   compactTools?: boolean,
 * }} options
 */
function packHistoryEvents(formatted, options = {}) {
  const direction = options.direction === 'forward' ? 'forward' : 'backward';
  const maxPageChars = Number(options.maxPageChars) > 0 ? Number(options.maxPageChars) : MCP_HISTORY_PAGE_CHARS;
  const fill = direction === 'backward' ? [...formatted].reverse() : formatted;
  const packingCursors = {
    next_from_seq: direction === 'forward' ? 999999 : null,
    next_before_seq: direction === 'backward' ? 999999 : null,
    truncated: true,
  };
  const kept = [];
  let omittedSeq = 0;
  let budgetOmitted = false;
  for (const row of fill) {
    const candidate = [...kept, row];
    const chronological = direction === 'backward' ? [...candidate].reverse() : candidate;
    const measured = assembleHistoryPageText({
      titleHeader: options.titleHeader,
      section: options.section,
      headSeq: options.headSeq,
      body: renderPackedBody(chronological, options),
      events: chronological.map((item) => item.item),
      cursors: packingCursors,
      chatId: options.chatId,
    });
    if (measured.length > maxPageChars && kept.length > 0) {
      omittedSeq = Number(row.item.seq) || 0;
      budgetOmitted = true;
      break;
    }
    kept.push(row);
  }
  const chronological = direction === 'backward' ? [...kept].reverse() : kept;
  const seqs = chronological.map((row) => Number(row.item.seq) || 0).filter((seq) => seq > 0);
  const eventTruncated = chronological.some((row) => row.item.text_truncated === true
    || row.item.args_truncated === true
    || row.item.result_truncated === true);
  return {
    text: chronological.map((row) => row.line).join('\n'),
    compact_text: renderCompactHistory(chronological),
    events: chronological.map((row) => row.item),
    displayed_oldest_seq: seqs.length > 0 ? seqs[0] : 0,
    displayed_newest_seq: seqs.length > 0 ? seqs[seqs.length - 1] : 0,
    budget_omitted_seq: budgetOmitted ? omittedSeq : 0,
    event_truncated: eventTruncated,
  };
}

/**
 * One page for chat_show and chat_history: scanned seqs, displayed seqs, budget.
 *
 * @param {unknown} history
 * @param {{ includeToolPayloads?: boolean, compactTools?: boolean, forward?: boolean, maxPageChars?: number }} [options]
 */
export function prepareHistoryPage(history, options = {}) {
  const rows = Array.isArray(history?.events) ? history.events : [];
  const direction = options.forward === true ? 'forward' : 'backward';
  const scanned = [];
  const formatted = [];
  for (const entry of rows) {
    const unwrapped = unwrapHistoryEntry(entry);
    if (unwrapped.seq > 0) scanned.push(unwrapped.seq);
    const item = formatHistoryEvent(unwrapped, options);
    if (item) formatted.push(item);
  }
  const packed = packHistoryEvents(formatted, {
    maxPageChars: options.maxPageChars,
    direction,
    chatId: options.chatId,
    titleHeader: options.titleHeader,
    section: options.section,
    headSeq: options.headSeq,
    compactTools: options.compactTools,
  });
  const scannedOldest = scanned.length > 0 ? scanned[0] : 0;
  const scannedNewest = scanned.length > 0 ? scanned[scanned.length - 1] : 0;
  const truncated = packed.budget_omitted_seq > 0 || packed.event_truncated;
  return {
    text: packed.text,
    compact_text: packed.compact_text,
    events: packed.events,
    oldest_seq: packed.displayed_oldest_seq,
    newest_seq: packed.displayed_newest_seq,
    displayed_oldest_seq: packed.displayed_oldest_seq,
    displayed_newest_seq: packed.displayed_newest_seq,
    scanned_oldest_seq: scannedOldest,
    scanned_newest_seq: scannedNewest,
    budget_omitted_seq: packed.budget_omitted_seq,
    event_truncated: packed.event_truncated,
    store_has_more: history?.hasMore === true,
    store_has_older: history?.hasOlder === true,
    truncated,
    omitted_from_seq: direction === 'forward' ? packed.budget_omitted_seq : 0,
    omitted_before_seq: direction === 'backward' && packed.displayed_oldest_seq > 0
      ? packed.displayed_oldest_seq
      : 0,
  };
}

/**
 * @param {unknown} history
 * @param {{ includeToolPayloads?: boolean, compactTools?: boolean, forward?: boolean, maxPageChars?: number }} [options]
 */
export function formatHistoryPage(history, options = {}) {
  return prepareHistoryPage(history, options);
}

/**
 * @param {object} page
 * @param {{ from_seq?: unknown }} args
 */
export function resolveHistoryCursors(page, args = {}) {
  const fromSeq = Number(args.from_seq);
  const walkingForward = Number.isInteger(fromSeq) && fromSeq > 0;
  const truncated = page?.truncated === true;
  if (walkingForward) {
    if (page?.budget_omitted_seq > 0) {
      return { next_from_seq: page.budget_omitted_seq, next_before_seq: null, truncated: true };
    }
    if (page?.store_has_more === true && page?.scanned_newest_seq > 0) {
      return { next_from_seq: page.scanned_newest_seq + 1, next_before_seq: null, truncated };
    }
    return { next_from_seq: null, next_before_seq: null, truncated };
  }
  if (page?.budget_omitted_seq > 0 && page?.displayed_oldest_seq > 0) {
    return { next_from_seq: null, next_before_seq: page.displayed_oldest_seq, truncated: true };
  }
  if (page?.store_has_older === true && page?.scanned_oldest_seq > 0) {
    return { next_from_seq: null, next_before_seq: page.scanned_oldest_seq, truncated };
  }
  return { next_from_seq: null, next_before_seq: null, truncated };
}

/**
 * @param {{ next_from_seq?: number | null, next_before_seq?: number | null, truncated?: boolean }} cursors
 * @returns {string}
 */
export function formatHistoryPagingLines(cursors = {}) {
  const lines = ['--- paging ---'];
  const fromSeq = Number(cursors.next_from_seq);
  const beforeSeq = Number(cursors.next_before_seq);
  if (Number.isFinite(fromSeq) && fromSeq > 0) lines.push(`next_from_seq: ${fromSeq}`);
  if (Number.isFinite(beforeSeq) && beforeSeq > 0) lines.push(`next_before_seq: ${beforeSeq}`);
  if (lines.length === 1) lines.push('next: none');
  if (cursors.truncated === true) lines.push('truncated: true');
  return lines.join('\n');
}

/**
 * @param {string} chatId
 * @param {object[]} events
 * @returns {string}
 */
export function formatContinueHints(chatId, events) {
  const id = String(chatId || '').trim();
  const rows = Array.isArray(events) ? events : [];
  const lines = [];
  for (const item of rows) {
    const seq = Number(item?.seq) || 0;
    if (seq <= 0) continue;
    if (item.text_truncated === true) {
      const offset = Number(item.preview_chars) || MCP_EVENT_TEXT_CHARS;
      lines.push('text_truncated: true');
      lines.push(`continue: chat_event(chat="${id}", seq=${seq}, field="text", offset=${offset})`);
    }
    if (item.args_truncated === true) {
      const offset = Number(item.args_preview_chars) || MCP_TOOL_PAYLOAD_CHARS;
      lines.push('args_truncated: true');
      lines.push(`continue: chat_event(chat="${id}", seq=${seq}, field="args", offset=${offset})`);
    }
    if (item.result_truncated === true) {
      const offset = Number(item.result_preview_chars) || MCP_TOOL_PAYLOAD_CHARS;
      lines.push('result_truncated: true');
      lines.push(`continue: chat_event(chat="${id}", seq=${seq}, field="result", offset=${offset})`);
    }
  }
  return lines.join('\n');
}
