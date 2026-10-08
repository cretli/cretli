/**
 * Cretli Web Push (VAPID) support.
 * - reads/generates VAPID keys from env or data/vapid-keys.json
 * - stores subscriptions in data/push-subscriptions.json
 * - sends notifications via web-push
 *
 * Requires `web-push` (npm i web-push). If the package is missing,
 * the module stays in passive mode (push disabled) without breaking the server.
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { resolveDataPath } from './runtime-paths.js';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { trimWebPushNotificationPayload } from './push-inbox-logic.js';
import {
  buildPushNotificationOptions,
  mergePushPreferences,
  normalizePushPreferences,
  resolveNotificationScope,
  stripPushPreferences,
} from './push-preferences.js';

const DATA_DIR = resolveDataPath();
const VAPID_FILE = path.join(DATA_DIR, 'vapid-keys.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || 'mailto:cretli@localhost';

let webPush = null;
try {
  webPush = (await import('web-push')).default;
} catch {
  webPush = null;
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  writeJsonAtomic(file, data);
}

export function isPushAvailable() {
  return webPush !== null;
}

/**
 * Whether at least one device subscription is stored. Callers that would do
 * expensive work (loading chat history) before `broadcastPush` can use this to
 * bail out early: `broadcastPush` would only return `{ reason: 'no-subscriptions' }`.
 *
 * @returns {boolean}
 */
export function hasPushSubscriptions() {
  const subs = readJson(SUBS_FILE, []);
  return Array.isArray(subs) && subs.length > 0;
}

export function getVapidPublicKey() {
  ensureVapidKeys();
  return readJson(VAPID_FILE, { publicKey: '' }).publicKey;
}

function ensureVapidKeys() {
  if (existsSync(VAPID_FILE)) {
    const keys = readJson(VAPID_FILE, null);
    if (keys?.publicKey && keys?.privateKey) return keys;
  }
  if (!webPush) {
    // Without web-push we cannot generate keys, so return empty values.
    const empty = { publicKey: '', privateKey: '' };
    writeJson(VAPID_FILE, empty);
    return empty;
  }
  const keys = webPush.generateVAPIDKeys();
  writeJson(VAPID_FILE, keys);
  return keys;
}

function configureWebPush() {
  if (!webPush) return false;
  const keys = ensureVapidKeys();
  if (!keys.publicKey || !keys.privateKey) return false;
  webPush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  return true;
}

/**
 * Upsert a subscription by endpoint.
 *
 * Stored shape is `{ ...subscription, preferences }` — preferences live BESIDE
 * the web-push fields, never inside `keys` (see `stripPushPreferences`).
 *
 * A re-POST merges instead of replacing: when `preferences` is omitted or
 * partial, the previously stored preferences for this endpoint are preserved.
 * Other endpoints keep their own independent preferences.
 *
 * @param {{ endpoint?: string } & Record<string, unknown>} subscription
 * @param {unknown} [preferences]
 * @returns {void}
 */
export function addSubscription(subscription, preferences) {
  if (!subscription?.endpoint) return;
  const subs = readJson(SUBS_FILE, []);
  if (!Array.isArray(subs)) return;
  const idx = subs.findIndex((s) => s?.endpoint === subscription.endpoint);
  if (idx >= 0) {
    const existing = subs[idx] || {};
    subs[idx] = {
      ...existing,
      ...subscription,
      preferences: mergePushPreferences(existing.preferences, preferences),
    };
  } else {
    subs.push({
      ...subscription,
      preferences: normalizePushPreferences(preferences),
    });
  }
  writeJson(SUBS_FILE, subs);
}

export function removeSubscription(endpoint) {
  if (!endpoint) return;
  const subs = readJson(SUBS_FILE, []);
  if (!Array.isArray(subs)) return;
  const next = subs.filter((s) => s?.endpoint !== endpoint);
  writeJson(SUBS_FILE, next);
}

/**
 * Maps a notification payload to the per-endpoint preference event, or `null`
 * when the preference contract does not cover it (chat-history, watcher,
 * push-test, ...). A `null` event is sent to every endpoint exactly as before.
 *
 * @param {{ data?: unknown }} payload
 * @returns {'finished' | 'question' | 'permission' | 'newChat' | null}
 */
export function resolvePushPreferenceEvent(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (data);
  const type = String(record.type || '');
  if (type === 'agent-finished') return 'finished';
  if (type === 'agent-needs-input') {
    const kind = String(record.kind || '');
    if (kind === 'question') return 'question';
    if (kind === 'permission') return 'permission';
  }
  if (type === 'chat-created') return 'newChat';
  return null;
}

/**
 * Serialize the notification JSON for ONE endpoint. The collapsed
 * NotificationOptions (`vibrate`/`silent`) depend on that endpoint's
 * preferences, so they are computed per endpoint. A legacy payload without any
 * option field is left without one; an explicitly disabled vibration becomes
 * `vibrate: []` so the Service Worker can tell the two cases apart.
 *
 * `payload.options` (TTL/urgency) is intentionally NOT copied here — it stays
 * an HTTP web-push option.
 *
 * @param {{ title?: unknown, body?: unknown, tag?: unknown, data?: unknown, options?: unknown, silent?: unknown, vibrate?: unknown }} payload
 * @param {unknown} preferences
 * @returns {string}
 */
function buildPerEndpointNotificationPayload(payload, preferences) {
  const options = buildPushNotificationOptions(payload, preferences);
  const merged = { ...payload, ...options };
  if (options.silent === true) {
    delete merged.vibrate;
  } else if (!Array.isArray(merged.vibrate)) {
    merged.vibrate = [];
  }
  return JSON.stringify(trimWebPushNotificationPayload(merged));
}

/**
 * Sends a notification to every stored subscription, skipping endpoints whose
 * per-endpoint preferences opt out of this event type.
 *
 * The preference filter is per endpoint: a skipped device is not an error and
 * keeps its subscription, while every other device still receives the push.
 *
 * @param {{ title?: string, body?: string, tag?: string, data?: object, options?: object }} payload
 */
export async function broadcastPush(payload) {
  if (!isPushAvailable()) return { sent: 0, failed: 0, reason: 'web-push-unavailable' };
  if (!configureWebPush()) return { sent: 0, failed: 0, reason: 'vapid-not-configured' };
  const subs = readJson(SUBS_FILE, []);
  if (!Array.isArray(subs) || subs.length === 0) return { sent: 0, failed: 0, reason: 'no-subscriptions' };

  const preferenceEvent = resolvePushPreferenceEvent(payload);
  if (preferenceEvent && payload?.data?.chatId && !payload.data.notificationScope) {
    // Resolve ancestry once for all subscribers; lazy import avoids the chat persistence cycle.
    try {
      const { loadChats } = await import('./persist/chats-persist.js');
      const chat = loadChats().find((row) => row.id === payload.data.chatId);
      payload = { ...payload, data: { ...payload.data, notificationScope: resolveNotificationScope(chat) } };
    } catch (_) {}
  }
  const sendOptions = {
    TTL: 3600,
    urgency: 'high',
    ...(payload?.options && typeof payload.options === 'object' ? payload.options : {}),
  };

  let sent = 0;
  let failed = 0;
  const stillAlive = [];
  for (const sub of subs) {
    if (!sub?.endpoint) continue;
    if (preferenceEvent) {
      const prefs = normalizePushPreferences(sub.preferences);
      if (prefs.enabled === false || prefs.events[preferenceEvent] === false) {
        stillAlive.push(sub);
        continue;
      }
    }
    // Only the web-push subscription fields may be passed to sendNotification.
    // `preferences` is our own per-endpoint metadata and must never be sent.
    const webPushSub = stripPushPreferences(sub);
    const notificationPayload = buildPerEndpointNotificationPayload(payload, sub.preferences);
    try {
      await webPush.sendNotification(webPushSub, notificationPayload, sendOptions);
      sent++;
      stillAlive.push(sub);
    } catch (err) {
      failed++;
      // 404/410 means expired or unsubscribed endpoint, so remove it. Other
      // endpoints keep their subscriptions (and preferences) untouched.
      const code = err?.statusCode || 0;
      if (code !== 404 && code !== 410) stillAlive.push(sub);
    }
  }
  writeJson(SUBS_FILE, stillAlive);
  return { sent, failed };
}

/**
 * Sends one notification to exactly ONE stored endpoint (the caller's current
 * device), used by `POST /api/push/test`. It deliberately does NOT broadcast and
 * does not apply the per-endpoint event filter — an explicit test must reach the
 * device regardless of opt-outs. Vibration/silent options still follow that
 * endpoint's preferences.
 *
 * Returns a result object that callers map to an HTTP status; it never throws.
 *
 * @param {unknown} endpoint
 * @param {{ title?: string, body?: string, tag?: string, data?: object, options?: object }} payload
 * @returns {Promise<{ ok: boolean, sent: number, failed: number, error?: string, statusCode?: number }>}
 */
export async function sendPushToEndpoint(endpoint, payload) {
  if (!isPushAvailable()) return { ok: false, sent: 0, failed: 0, error: 'web-push-unavailable' };
  if (!configureWebPush()) return { ok: false, sent: 0, failed: 0, error: 'vapid-not-configured' };
  const target = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!target) return { ok: false, sent: 0, failed: 0, error: 'missing_endpoint' };
  const subs = readJson(SUBS_FILE, []);
  const sub = Array.isArray(subs) ? subs.find((row) => row?.endpoint === target) : null;
  if (!sub) return { ok: false, sent: 0, failed: 0, error: 'subscription_not_found' };
  const sendOptions = {
    TTL: 3600,
    urgency: 'high',
    ...(payload?.options && typeof payload.options === 'object' ? payload.options : {}),
  };
  const notificationPayload = buildPerEndpointNotificationPayload(payload, sub.preferences);
  try {
    await webPush.sendNotification(stripPushPreferences(sub), notificationPayload, sendOptions);
    return { ok: true, sent: 1, failed: 0 };
  } catch (err) {
    const code = err?.statusCode || 0;
    if (code === 404 || code === 410) removeSubscription(target);
    return {
      ok: false,
      sent: 0,
      failed: 1,
      error: 'send_failed',
      ...(code ? { statusCode: code } : {}),
    };
  }
}

// Startup initialization (best effort).
ensureVapidKeys();
