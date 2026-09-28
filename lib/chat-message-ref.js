/**
 * Compact pointer to a saved chat history event.
 * Agents load the body with MCP chat_event({ chat, seq, field: "text" }).
 */

export const CHAT_MESSAGE_REF_PREFIX = 'cretli-ref';

const CHAT_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_LINE_RE = /^cretli-ref\s+chat=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+seq=(\d+)\s*$/i;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isChatIdUuid(value) {
  return CHAT_ID_UUID_RE.test(String(value || '').trim());
}

/**
 * @param {unknown} seq
 * @returns {boolean}
 */
export function isSavedHistorySeq(seq) {
  const n = Number(seq);
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * @param {unknown} variant
 * @returns {boolean}
 */
export function isChatMessageRefVariant(variant) {
  const value = String(variant || '');
  return value === 'user' || value === 'assistant';
}

/**
 * @param {{ chatId?: unknown, seq?: unknown }} input
 * @returns {string}
 */
export function formatChatMessageRef(input = {}) {
  const chatId = String(input?.chatId || '').trim().toLowerCase();
  const seq = Number(input?.seq);
  if (!isChatIdUuid(chatId) || !isSavedHistorySeq(seq)) return '';
  return `${CHAT_MESSAGE_REF_PREFIX} chat=${chatId} seq=${seq}`;
}

/**
 * @param {unknown} text
 * @returns {{ chatId: string, seq: number } | null}
 */
export function parseChatMessageRef(text) {
  const line = String(text || '').trim();
  const match = REF_LINE_RE.exec(line);
  if (!match) return null;
  const seq = Number(match[2]);
  if (!isSavedHistorySeq(seq)) return null;
  return { chatId: match[1].toLowerCase(), seq };
}

/**
 * @param {{
 *   variant?: unknown,
 *   historySeq?: unknown,
 *   chatId?: unknown,
 *   queued?: unknown,
 *   running?: unknown,
 *   canReadText?: unknown,
 * }} input
 * @returns {{
 *   visible: boolean,
 *   enabled: boolean,
 *   reason: 'hidden' | 'needs_saved_history' | '',
 *   ref: string,
 * }}
 */
export function resolveChatMessageRefAction(input = {}) {
  const hidden = { visible: false, enabled: false, reason: 'hidden', ref: '' };
  if (!isChatMessageRefVariant(input.variant)) return hidden;
  if (input.queued === true || input.running === true) return hidden;
  if (input.canReadText === false) return hidden;
  const chatId = String(input.chatId || '').trim();
  if (!isChatIdUuid(chatId)) return hidden;
  if (!isSavedHistorySeq(input.historySeq)) {
    return { visible: true, enabled: false, reason: 'needs_saved_history', ref: '' };
  }
  const ref = formatChatMessageRef({ chatId, seq: input.historySeq });
  if (!ref) return hidden;
  return { visible: true, enabled: true, reason: '', ref };
}

/**
 * @param {{
 *   variant?: unknown,
 *   historySeq?: unknown,
 *   chatId?: unknown,
 *   queued?: unknown,
 *   running?: unknown,
 *   canReadText?: unknown,
 * }} input
 * @param {(text: string) => boolean | Promise<boolean>} writeText
 * @returns {Promise<{ ok: boolean, reason: string, ref: string }>}
 */
export async function writeChatMessageRef(input, writeText) {
  const action = resolveChatMessageRefAction(input);
  if (!action.enabled || !action.ref) {
    return { ok: false, reason: action.reason || 'hidden', ref: '' };
  }
  if (typeof writeText !== 'function') {
    return { ok: false, reason: 'clipboard', ref: action.ref };
  }
  try {
    const ok = await writeText(action.ref);
    if (ok !== true) return { ok: false, reason: 'clipboard', ref: action.ref };
    return { ok: true, reason: '', ref: action.ref };
  } catch {
    return { ok: false, reason: 'clipboard', ref: action.ref };
  }
}
