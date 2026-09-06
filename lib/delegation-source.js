/**
 * Resolve a delegated task body from a saved plan or a chat-history message.
 */

import { loadChatHistory } from './persist/chat-history-persist.js';
import { readSdkHistoryStreamText } from './sdk/sdk-history-stream-coalesce.js';
import { hashDelegationContent } from './delegation-request.js';

/**
 * @param {unknown} rec
 * @returns {string}
 */
export function extractHistoryRecordText(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const row = /** @type {Record<string, unknown>} */ (rec);
  if (row.kind === 'localUser') return String(row.text || '').trim();
  if (row.kind === 'sdk') return String(readSdkHistoryStreamText(row) || '').trim();
  return '';
}

/**
 * @param {{ seq: number, rec: unknown }} event
 * @returns {string}
 */
export function extractHistoryEventText(event) {
  return extractHistoryRecordText(event?.rec);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readHistorySeq(value) {
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

/**
 * Read only the named history seq. Never invent text from a snapshot.
 *
 * @param {string} chatId
 * @param {{ historySeq?: unknown, contentHash?: unknown }} query
 * @returns {{
 *   ok: true,
 *   seq: number,
 *   rec: unknown,
 *   text: string,
 *   contentHash: string,
 * } | {
 *   ok: false,
 *   code: 'source_unavailable' | 'source_changed' | 'source_required',
 *   error: string,
 * }}
 */
export function resolveHistoryMessageSource(chatId, query = {}) {
  const seq = readHistorySeq(query.historySeq);
  if (!seq) {
    return {
      ok: false,
      code: 'source_required',
      error: 'historySeq is required to delegate a chat message.',
    };
  }
  const store = loadChatHistory(chatId);
  const match = (store?.events || []).find((row) => row.seq === seq);
  if (!match) {
    return {
      ok: false,
      code: 'source_unavailable',
      error: 'The source message is not in saved history.',
    };
  }
  const text = extractHistoryEventText(match);
  if (!text) {
    return {
      ok: false,
      code: 'source_unavailable',
      error: 'The source message is empty after coalescing.',
    };
  }
  const contentHash = hashDelegationContent(text);
  const expected = String(query.contentHash || '').trim();
  if (expected && expected !== contentHash) {
    return {
      ok: false,
      code: 'source_changed',
      error: 'The source message changed. Refresh and try again.',
    };
  }
  return {
    ok: true,
    seq: match.seq,
    rec: match.rec,
    text,
    contentHash,
  };
}

/**
 * @param {string} chatId
 * @param {{ historySeq?: number, createdAt?: string, textSnapshot?: string, contentHash?: string }} query
 * @returns {{ seq: number, rec: unknown, text: string } | null}
 */
export function findChatHistoryMessage(chatId, query = {}) {
  const resolved = resolveHistoryMessageSource(chatId, query);
  if (!resolved.ok) return null;
  return { seq: resolved.seq, rec: resolved.rec, text: resolved.text };
}

export { hashDelegationContent };
