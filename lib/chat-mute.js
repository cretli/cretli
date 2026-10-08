/**
 * Per-chat device mute and in-app alert throttling.
 *
 * Pure ESM, never throws. Mute suppresses vibration/sound for one chat; the OS
 * notification may still appear.
 */

export const CHAT_MUTE_SCHEMA_VERSION = 1;
export const CHAT_ALERT_COOLDOWN_MS = 15000;

const MUTED_CHAT_CAP = 500;
const ALERT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} id
 * @returns {string}
 */
function normalizeChatId(id) {
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * @param {unknown} raw
 * @param {number} [referenceNow] clock used to prune stale alerts (defaults to Date.now())
 * @returns {{ schemaVersion: number, muted: string[], alerts: Record<string, { at: number, eventId: string }> }}
 */
export function normalizeChatMuteRecord(raw, referenceNow) {
  if (Array.isArray(raw)) {
    const muted = [];
    const seenLegacy = new Set();
    for (const entry of raw) {
      const id = normalizeChatId(entry);
      if (!id || seenLegacy.has(id)) continue;
      seenLegacy.add(id);
      muted.push(id);
      if (muted.length >= MUTED_CHAT_CAP) break;
    }
    return {
      schemaVersion: CHAT_MUTE_SCHEMA_VERSION,
      muted,
      alerts: {},
    };
  }
  const source = isPlainObject(raw) ? raw : {};
  const mutedRaw = Array.isArray(source.muted) ? source.muted : [];
  const muted = [];
  const seen = new Set();
  for (const entry of mutedRaw) {
    const id = normalizeChatId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    muted.push(id);
    if (muted.length >= MUTED_CHAT_CAP) break;
  }
  const alertsRaw = isPlainObject(source.alerts) ? source.alerts : {};
  /** @type {Record<string, { at: number, eventId: string }>} */
  const alerts = {};
  const now = Number.isFinite(referenceNow) ? Number(referenceNow) : Date.now();
  for (const key of Object.keys(alertsRaw)) {
    const chatId = normalizeChatId(key);
    if (!chatId) continue;
    const row = alertsRaw[key];
    if (!isPlainObject(row)) continue;
    const at = Number(row.at);
    const eventId = normalizeChatId(row.eventId);
    if (!Number.isFinite(at) || !eventId) continue;
    if (now - at > ALERT_MAX_AGE_MS) continue;
    alerts[chatId] = { at, eventId };
  }
  return {
    schemaVersion: CHAT_MUTE_SCHEMA_VERSION,
    muted,
    alerts,
  };
}

/**
 * @param {unknown} record
 * @param {unknown} chatId
 * @returns {boolean}
 */
export function isChatMuted(record, chatId) {
  const id = normalizeChatId(chatId);
  if (!id) return false;
  const normalized = normalizeChatMuteRecord(record);
  return normalized.muted.includes(id);
}

/**
 * @param {unknown} record
 * @param {unknown} chatId
 * @param {boolean} muted
 * @returns {ReturnType<typeof normalizeChatMuteRecord>}
 */
export function setChatMuted(record, chatId, muted) {
  const id = normalizeChatId(chatId);
  const next = normalizeChatMuteRecord(record);
  if (!id) return next;
  const set = new Set(next.muted);
  if (muted) set.add(id);
  else set.delete(id);
  return normalizeChatMuteRecord({ ...next, muted: [...set] });
}

/**
 * @param {{
 *   record?: unknown,
 *   chatId?: unknown,
 *   eventId?: unknown,
 *   now?: number,
 *   cooldownMs?: number,
 * }} input
 * @returns {{ allow: boolean, reason: string, record: ReturnType<typeof normalizeChatMuteRecord> }}
 */
export function resolveChatAlertThrottle(input = {}) {
  const chatId = normalizeChatId(input.chatId);
  const eventId = normalizeChatId(input.eventId);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const cooldownMs = Number.isFinite(input.cooldownMs) && input.cooldownMs >= 0
    ? Number(input.cooldownMs)
    : CHAT_ALERT_COOLDOWN_MS;
  let record = normalizeChatMuteRecord(input.record, now);
  if (!chatId) {
    return { allow: true, reason: 'no-chat', record };
  }
  if (!eventId) {
    return { allow: true, reason: 'no-event', record };
  }
  const last = record.alerts[chatId];
  if (last && last.eventId === eventId) {
    return { allow: false, reason: 'duplicate', record };
  }
  if (last && now - last.at < cooldownMs) {
    return { allow: false, reason: 'cooldown', record };
  }
  record = normalizeChatMuteRecord({
    ...record,
    alerts: { ...record.alerts, [chatId]: { at: now, eventId } },
  }, now);
  return { allow: true, reason: 'allowed', record };
}
