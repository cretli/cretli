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

export function addSubscription(subscription) {
  if (!subscription?.endpoint) return;
  const subs = readJson(SUBS_FILE, []);
  if (!Array.isArray(subs)) return;
  const idx = subs.findIndex((s) => s?.endpoint === subscription.endpoint);
  if (idx >= 0) subs[idx] = subscription;
  else subs.push(subscription);
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
 * Sends a notification to every stored subscription.
 * @param {{ title?: string, body?: string, tag?: string, data?: object }} payload
 */
export async function broadcastPush(payload) {
  if (!isPushAvailable()) return { sent: 0, failed: 0, reason: 'web-push-unavailable' };
  if (!configureWebPush()) return { sent: 0, failed: 0, reason: 'vapid-not-configured' };
  const subs = readJson(SUBS_FILE, []);
  if (!Array.isArray(subs) || subs.length === 0) return { sent: 0, failed: 0, reason: 'no-subscriptions' };

  const notificationPayload = JSON.stringify({
    title: String(payload?.title || 'Cretli'),
    body: String(payload?.body || ''),
    tag: String(payload?.tag || 'cretli'),
    data: payload?.data || {},
  });

  let sent = 0;
  let failed = 0;
  const stillAlive = [];
  for (const sub of subs) {
    if (!sub?.endpoint) continue;
    try {
      await webPush.sendNotification(sub, notificationPayload);
      sent++;
      stillAlive.push(sub);
    } catch (err) {
      failed++;
      // 404/410 means expired or unsubscribed endpoint, so remove it.
      const code = err?.statusCode || 0;
      if (code !== 404 && code !== 410) stillAlive.push(sub);
    }
  }
  writeJson(SUBS_FILE, stillAlive);
  return { sent, failed };
}

// Startup initialization (best effort).
ensureVapidKeys();
