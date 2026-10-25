/**
 * Asynchronous chat-history adapter contract (stage 2a of the history
 * migration; docs/storage-history-migration.md "Adapter contract").
 *
 * One adapter exposes the SAME operations as `chat-history-persist.js`, every
 * one returning a Promise, over exactly ONE explicitly selected backend:
 *   - `legacy`            existing JSON files (default; no marker needed);
 *   - `sqlite`            the worker-backed store, selected by the control marker;
 *   - `rollback-readonly` an exported rollback directory: reads and receipt
 *                         lookups only, every write refused.
 * Backends are never mixed or dual-written, and nothing here migrates data or
 * switches a backend on its own (see chat-history-backend-marker.js).
 *
 * This module is backend-neutral and imports no backend, so a later rename of
 * the legacy module cannot create an import cycle. Backends receive their
 * dependencies by injection (factory style), which keeps them testable with
 * synthetic stores.
 */
import { ChatHistoryAdapterError, refuseHistory } from './chat-history-errors.js';

export const HISTORY_PULL_DEFAULT_LIMIT = 1000;
export const HISTORY_PULL_MAX_LIMIT = 2000;
export const HISTORY_TAIL_DEFAULT_LIMIT = 80;
export const HISTORY_BATCH_MAX_CHATS = 32;
export const MAX_HISTORY_EVENTS = 2000;

/** Primitive operations every backend implements. */
export const CHAT_HISTORY_BACKEND_METHODS = Object.freeze([
  'loadChatHistory',
  'appendChatHistoryEvents',
  'appendChatNotice',
  'getChatHistorySince',
  'getChatHistoryEvent',
  'getChatHistoryPage',
  'copyChatHistory',
  'copyChatHistoryUntil',
  'deleteChatHistory',
  'listChatHistoryHeadSeqs',
  'getChatHistoryUsage',
]);

/** @param {unknown} chatId @returns {boolean} the legacy path-traversal guard (`isValidChatId`) */
export function isValidChatId(chatId) {
  return typeof chatId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(chatId);
}

/**
 * Body of the server-authored watcher notice (`meta` record with a JSON
 * payload), identical to the legacy `appendChatNotice`.
 *
 * @param {string} text
 * @param {Record<string, unknown>} [meta]
 * @returns {{ rec: Record<string, unknown> } | null} null for an empty notice
 */
export function buildChatNoticeItem(text, meta = {}) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return null;
  const payload = JSON.stringify({
    text: body,
    action: String(meta?.action || 'info').trim() || 'info',
    level: String(meta?.level || 'info').trim() || 'info',
    workspaceFolder: String(meta?.workspaceFolder || ''),
    todoId: String(meta?.todoId || ''),
    cycleId: String(meta?.cycleId || ''),
    chatId: String(meta?.chatId || ''),
    at: String(meta?.at || new Date().toISOString()),
  });
  return { rec: { kind: 'meta', variant: 'watcher', payload } };
}

/**
 * Clamp a pull limit exactly like the legacy readers.
 * @param {unknown} value @param {number} fallback @returns {number}
 */
export function clampPullLimit(value, fallback = HISTORY_PULL_DEFAULT_LIMIT) {
  return Math.min(HISTORY_PULL_MAX_LIMIT, Math.max(1, Number(value) || fallback));
}

/**
 * Assemble the adapter over one backend. `kind` is reported by `backendKind`
 * so a caller can log/guard which store it is talking to.
 *
 * @param {{ backend: Record<string, Function>, kind: 'legacy' | 'sqlite' | 'rollback-readonly', close?: () => Promise<void> }} options
 */
export function createChatHistoryAdapter({ backend, kind, close }) {
  if (!backend || typeof backend !== 'object') throw new TypeError('A history backend is required');
  for (const method of CHAT_HISTORY_BACKEND_METHODS) {
    if (typeof backend[method] !== 'function') throw new TypeError(`History backend lacks ${method}`);
  }
  const invalid = (chatId) => ({ ok: false, error: 'Invalid chatId', code: 'history_invalid_chat_id', chatId: typeof chatId === 'string' ? chatId.slice(0, 64) : '' });

  /**
   * HTTP query routing of `GET /api/chats/:id/history` (async twin of the
   * legacy `readChatHistoryFromHttpQuery`): `seq` is an exact lookup, `tail` /
   * `before` select the newest window, otherwise `since` + `limit` read forward.
   */
  async function readChatHistoryFromHttpQuery(chatId, query = {}) {
    const seqRaw = Number.parseInt(String(query?.seq || '0'), 10);
    if (Number.isInteger(seqRaw) && seqRaw > 0) return backend.getChatHistoryEvent(chatId, seqRaw);
    const tailRaw = Number.parseInt(String(query?.tail || '0'), 10);
    const beforeRaw = Number.parseInt(String(query?.before || '0'), 10);
    const wantsPage = Number.isFinite(tailRaw) && tailRaw > 0;
    const wantsBefore = Number.isFinite(beforeRaw) && beforeRaw > 0;
    if (wantsPage || wantsBefore) {
      return backend.getChatHistoryPage(chatId, {
        beforeSeq: wantsBefore ? beforeRaw : 0,
        limit: wantsPage ? tailRaw : HISTORY_TAIL_DEFAULT_LIMIT,
      });
    }
    const sinceRaw = Number.parseInt(String(query?.since || '0'), 10);
    const since = Number.isFinite(sinceRaw) ? Math.max(0, sinceRaw) : 0;
    const limitRaw = Number.parseInt(String(query?.limit || String(HISTORY_PULL_DEFAULT_LIMIT)), 10);
    const limit = Number.isFinite(limitRaw) ? clampPullLimit(limitRaw) : HISTORY_PULL_DEFAULT_LIMIT;
    return backend.getChatHistorySince(chatId, since, limit);
  }

  /**
   * Explicit multi-chat delta pull (at most 32 chats; an empty request or an
   * empty allow-list never means "every chat"). Chats are read one after the
   * other so a batch never queues more than one worker read at a time.
   */
  async function readChatHistoryBatch(requests, allowedIds) {
    const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
    /** @type {Record<string, unknown>} */
    const histories = {};
    if (!Array.isArray(requests) || allowed.size === 0) return histories;
    let count = 0;
    for (const row of requests) {
      const chatId = String(row?.id || '').trim();
      if (!chatId || !allowed.has(chatId) || histories[chatId]) continue;
      if (count >= HISTORY_BATCH_MAX_CHATS) break;
      const sinceRaw = Number(row?.since);
      const since = Number.isFinite(sinceRaw) ? Math.max(0, sinceRaw) : 0;
      const limitRaw = Number(row?.limit);
      histories[chatId] = await backend.getChatHistorySince(chatId, since, Number.isFinite(limitRaw) ? limitRaw : HISTORY_PULL_DEFAULT_LIMIT);
      count += 1;
    }
    return histories;
  }

  /** Guard that returns the legacy `{ ok: false }` shape instead of reaching a backend with a hostile chat id. */
  const guarded = (method, argIndex = 0) => async (...args) => {
    if (!isValidChatId(args[argIndex])) return invalid(args[argIndex]);
    return backend[method](...args);
  };

  const adapter = {
    backendKind: kind,
    loadChatHistory: async (chatId, options) => (isValidChatId(chatId) ? backend.loadChatHistory(chatId, options) : null),
    appendChatHistoryEvents: guarded('appendChatHistoryEvents'),
    appendChatNotice: guarded('appendChatNotice'),
    getChatHistorySince: async (chatId, since, limit) => (isValidChatId(chatId)
      ? backend.getChatHistorySince(chatId, since, limit)
      : { ok: true, chatId, cursorSessionId: '', headSeq: 0, events: [], hasMore: false }),
    getChatHistoryEvent: async (chatId, seq) => (isValidChatId(chatId)
      ? backend.getChatHistoryEvent(chatId, seq)
      : { ok: true, chatId, headSeq: 0, event: null, events: [] }),
    getChatHistoryPage: async (chatId, options) => (isValidChatId(chatId)
      ? backend.getChatHistoryPage(chatId, options)
      : { ok: true, chatId, cursorSessionId: '', headSeq: 0, events: [], oldestSeq: 0, hasOlder: false }),
    readChatHistoryFromHttpQuery,
    readChatHistoryBatch,
    copyChatHistory: async (source, target, cursor, callOptions) => (isValidChatId(source) && isValidChatId(target)
      ? backend.copyChatHistory(source, target, cursor, callOptions) : { ok: false, error: 'Invalid chatId' }),
    copyChatHistoryUntil: async (source, target, cursor, upTo, callOptions) => (isValidChatId(source) && isValidChatId(target)
      ? backend.copyChatHistoryUntil(source, target, cursor, upTo, callOptions) : { ok: false, error: 'Invalid chatId' }),
    deleteChatHistory: async (chatId, callOptions) => (isValidChatId(chatId) ? backend.deleteChatHistory(chatId, callOptions) : undefined),
    listChatHistoryHeadSeqs: () => backend.listChatHistoryHeadSeqs(),
    getChatHistoryUsage: async (chatId) => (isValidChatId(chatId) ? backend.getChatHistoryUsage(chatId) : null),
    /** Optional backend hooks (pending replay, receipt lookup, diagnosis); absent ones are `undefined`. */
    recoverPending: backend.recoverPending ? () => backend.recoverPending() : undefined,
    lookupReceipt: backend.lookupReceipt ? (args) => backend.lookupReceipt(args) : undefined,
    lookupInput: backend.lookupInput ? (args) => backend.lookupInput(args) : undefined,
    diagnose: backend.diagnose ? () => backend.diagnose() : undefined,
    close: async () => { await close?.(); },
  };
  return Object.freeze(adapter);
}

export { ChatHistoryAdapterError, refuseHistory };
