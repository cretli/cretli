/**
 * Pure helpers for the PWA push inbox (Service Worker + app page).
 */

export const PUSH_INBOX_DB_NAME = 'cretli-push-inbox';
export const PUSH_INBOX_STORE_NAME = 'events';

/** Inbox presence patches older than this are ignored (history headSeq sync is not capped). */
export const PUSH_INBOX_STATE_MAX_AGE_MS = 30 * 60 * 1000;

const SNIPPET_MAX = 280;
const WEB_PUSH_JSON_MAX_BYTES = 3000;
const WEB_PUSH_TITLE_MAX_CHARS = 120;

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function clipPushInboxSnippet(value, max = SNIPPET_MAX) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * @param {{
 *   title?: unknown,
 *   body?: unknown,
 *   tag?: unknown,
 *   data?: unknown,
 * }} payload
 * @returns {PushInboxRecord | null}
 */
export function buildPushInboxRecordFromNotificationPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object'
    ? /** @type {Record<string, unknown>} */ (payload.data)
    : null;
  if (!data) return null;
  const chatId = String(data.chatId || '').trim();
  if (!chatId) return null;
  const type = String(data.type || '').trim();
  if (!type) return null;
  const at = readFiniteNumber(data.at) || Date.now();
  const headSeqRaw = data.headSeq;
  const headSeq = headSeqRaw == null || headSeqRaw === ''
    ? undefined
    : readFiniteNumber(headSeqRaw);
  const snippet = clipPushInboxSnippet(data.snippet);
  /** @type {PushInboxRecord} */
  const record = {
    chatId,
    type,
    at,
    // Device clock at write time. `at` is the server clock, `_serverRunStateAt`
    // is the client clock — mixing them made watermark checks unreliable, so
    // freshness is decided on receivedAt (see shouldApplyPushInboxPresenceRecord).
    receivedAt: Date.now(),
  };
  const status = String(data.status || '').trim();
  if (status) record.status = status;
  if (headSeq !== undefined && headSeq > 0) record.headSeq = headSeq;
  const title = String(data.title || payload?.title || '').trim();
  if (title) record.title = title;
  if (snippet) record.snippet = snippet;
  const kind = String(data.kind || '').trim();
  if (kind) record.kind = kind;
  return record;
}

/**
 * @typedef {{
 *   chatId: string,
 *   type: string,
 *   at: number,
 *   status?: string,
 *   headSeq?: number,
 *   title?: string,
 *   snippet?: string,
 *   kind?: string,
 *   receivedAt?: number,
 * }} PushInboxRecord
 */

/**
 * @param {PushInboxRecord | null | undefined} existing
 * @param {PushInboxRecord | null | undefined} incoming
 * @returns {PushInboxRecord | null}
 */
export function mergePushInboxRecords(existing, incoming) {
  if (!incoming) return existing || null;
  if (!existing) return incoming;
  if (readFiniteNumber(incoming.at) >= readFiniteNumber(existing.at)) return incoming;
  return existing;
}

/**
 * History headSeq is a delta-sync watermark, not a presence patch: it is
 * deliberately NOT capped by PUSH_INBOX_STATE_MAX_AGE_MS. A late delta still
 * advances the local ack safely; only the presence patch in a stale inbox record
 * is dropped (see shouldApplyPushInboxPresenceRecord).
 *
 * @param {number | undefined} headSeq
 * @param {number | undefined} lastAckedSeq
 * @returns {boolean}
 */
export function shouldSyncChatHistoryFromPushInbox(headSeq, lastAckedSeq) {
  const head = readFiniteNumber(headSeq);
  if (head <= 0) return false;
  const ack = readFiniteNumber(lastAckedSeq);
  return head > ack;
}

/**
 * Inbox presence patches must be newer than both watermarks:
 * - `_serverRunStateAt` is stamped only by authoritative server/WS sources,
 * - `_inboxRunStateAt` is stamped by a previously applied inbox record.
 * The inbox never writes `_serverRunStateAt`, so it cannot mask server truth.
 *
 * Clock safety: `record.at` is the SERVER clock while both watermarks are the
 * CLIENT clock, so comparisons use `receivedAt` (device clock recorded by the
 * Service Worker) with `at` only as a legacy fallback.
 *
 * @param {PushInboxRecord | null | undefined} record
 * @param {{ _serverRunStateAt?: unknown, _inboxRunStateAt?: unknown } | null | undefined} chat
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function shouldApplyPushInboxPresenceRecord(record, chat, nowMs = Date.now()) {
  const at = resolvePushInboxRecordDeviceTime(record);
  if (at <= 0) return false;
  const serverAt = readFiniteNumber(chat?._serverRunStateAt);
  if (serverAt > 0 && at <= serverAt) return false;
  const inboxAt = readFiniteNumber(chat?._inboxRunStateAt);
  if (inboxAt > 0 && at <= inboxAt) return false;
  if (nowMs - at > PUSH_INBOX_STATE_MAX_AGE_MS) return false;
  return true;
}

/**
 * The record's device-clock timestamp: `receivedAt` when the Service Worker
 * stamped it, otherwise the server `at` (legacy records).
 *
 * @param {PushInboxRecord | null | undefined} record
 * @returns {number}
 */
export function resolvePushInboxRecordDeviceTime(record) {
  const receivedAt = readFiniteNumber(record?.receivedAt);
  if (receivedAt > 0) return receivedAt;
  return readFiniteNumber(record?.at);
}

/**
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function clipPushTitle(value, maxChars = WEB_PUSH_TITLE_MAX_CHARS) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * UTF-8 byte length that works in Node and in the browser bundle (no Buffer).
 * @param {unknown} value
 * @returns {number}
 */
function jsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Keeps encrypted web-push payload under ~4 KB by bounding JSON size.
 *
 * Termination guarantee: every step strictly shrinks the payload (a fixed-size
 * body cut, a halved title cap, a removed data field, or a halved url/chatId/type)
 * or breaks, so the function always returns and the result is ALWAYS
 * <= WEB_PUSH_JSON_MAX_BYTES. The title loop in particular must not re-clamp at a
 * constant cap: `clipPushTitle(title, 8)` returns the same string once the title is
 * short, which used to spin forever and block the Node process.
 *
 * @param {{ title?: unknown, body?: unknown, tag?: unknown, data?: unknown }} payload
 * @returns {{ title: string, body: string, tag: string, data: object }}
 */
export function trimWebPushNotificationPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object'
    ? { .../** @type {Record<string, unknown>} */ (payload.data) }
    : {};
  if (data.title) data.title = clipPushTitle(data.title);
  let title = clipPushTitle(payload?.title || 'Cretli');
  let body = String(payload?.body || '');
  let tag = String(payload?.tag || 'cretli');
  const build = () => ({
    title,
    body,
    tag,
    data,
  });
  let out = build();
  if (jsonByteLength(out) <= WEB_PUSH_JSON_MAX_BYTES) return out;

  // Body: fixed-size steps, each removes at least one character.
  while (body.length > 0 && jsonByteLength(build()) > WEB_PUSH_JSON_MAX_BYTES) {
    body = body.slice(0, Math.max(0, body.length - 32));
    out = build();
  }
  if (jsonByteLength(out) <= WEB_PUSH_JSON_MAX_BYTES) return out;

  // Title: halving the cap strictly decreases the string, so the loop cannot
  // spin on a clamped `clipPushTitle` result.
  while (title.length > 1 && jsonByteLength(build()) > WEB_PUSH_JSON_MAX_BYTES) {
    title = title.slice(0, Math.max(1, Math.floor(title.length / 2)));
    out = build();
  }
  if (jsonByteLength(out) <= WEB_PUSH_JSON_MAX_BYTES) return out;

  // Optional data fields are dropped one by one.
  for (const key of ['snippet', 'title', 'status', 'kind']) {
    if (!(key in data)) continue;
    delete data[key];
    out = build();
    if (jsonByteLength(out) <= WEB_PUSH_JSON_MAX_BYTES) return out;
  }

  // Hard floor: only the routing data survives and url/chatId/type are halved
  // until the payload fits (each branch removes at least one character, then breaks).
  title = 'Cretli';
  body = '';
  tag = 'cretli';
  const minimalData = {
    type: String(data.type || ''),
    chatId: String(data.chatId || ''),
    url: String(data.url || ''),
    at: readFiniteNumber(data.at) || Date.now(),
  };
  out = { title, body, tag, data: minimalData };
  while (jsonByteLength(out) > WEB_PUSH_JSON_MAX_BYTES) {
    if (minimalData.url.length > 0) {
      minimalData.url = minimalData.url.slice(0, Math.floor(minimalData.url.length / 2));
      continue;
    }
    if (minimalData.chatId.length > 0) {
      minimalData.chatId = minimalData.chatId.slice(0, Math.floor(minimalData.chatId.length / 2));
      continue;
    }
    if (minimalData.type.length > 0) {
      minimalData.type = minimalData.type.slice(0, Math.floor(minimalData.type.length / 2));
      continue;
    }
    break;
  }
  return out;
}

/**
 * @param {{
 *   chatId?: unknown,
 *   chatTitle?: unknown,
 *   status?: unknown,
 *   headSeq?: unknown,
 *   snippet?: unknown,
 *   url?: unknown,
 *   at?: unknown,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildAgentFinishedPushData(input) {
  const chatId = String(input?.chatId || '').trim();
  const chatTitle = String(input?.chatTitle || '').trim();
  const status = String(input?.status || '').trim() || 'done';
  const url = typeof input?.url === 'string' && input.url
    ? input.url
    : (chatId
      ? `/?source=pwa&panel=chat&chat=${encodeURIComponent(chatId)}`
      : '/?source=pwa&panel=chat');
  const at = readFiniteNumber(input?.at) || Date.now();
  /** @type {Record<string, unknown>} */
  const data = {
    type: 'agent-finished',
    chatId,
    status,
    title: chatTitle || chatId || 'Chat',
    at,
    url,
  };
  const headSeq = readFiniteNumber(input?.headSeq);
  if (headSeq > 0) data.headSeq = headSeq;
  const snippet = clipPushInboxSnippet(input?.snippet);
  if (snippet) data.snippet = snippet;
  return data;
}
