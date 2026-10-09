/**
 * Durable in-app notification centre store (separate from the ephemeral push inbox).
 *
 * Semantics (server-global scope):
 * - Scope: one store per Cretli data directory; all authenticated browser sessions share it.
 * - Retention: bounded by NOTIFICATION_MAX_RECORDS and NOTIFICATION_MAX_AGE_MS (oldest pruned on write).
 * - Dedupe: one `fingerprint` identifies exactly ONE occurrence. Publishing a fingerprint
 *   that the store already knows — active, read OR dismissed — is a no-op while the record
 *   (or its compact tombstone) is retained. A genuinely new occurrence must use a NEW
 *   fingerprint; see `publishNotification`.
 * - Re-emission: only a different fingerprint (a new occurrence produced by the producer)
 *   creates a new visible item. Dismissing does not by itself make the old fingerprint
 *   publishable again.
 * - First snapshot: producers for models/cli snapshots must not notify on the initial baseline observation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ensureWritableDir } from '../ensure-writable-dir.js';
import {
  NOTIFICATION_CATEGORIES,
  getNotificationCenterPreferences,
  notificationMatchesPreferences,
} from './notification-preferences.js';
import { sanitizeNotificationText } from './notification-sanitize.js';
import { broadcastNotificationsChanged } from './notification-live.js';

export const NOTIFICATION_STORE_SCHEMA_VERSION = 2;
export const NOTIFICATION_STORE_FILE = 'notification-center.json';

/** @type {readonly string[]} */
export const NOTIFICATION_SEVERITIES = Object.freeze(['info', 'important', 'warning', 'error']);

/** Max rows kept on disk (includes dismissed until pruned). */
export const NOTIFICATION_MAX_RECORDS = 500;

/** Drop rows older than this age (ms), measured from createdAt. */
export const NOTIFICATION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Serializes read-modify-write in this process. */
/** @type {Promise<unknown>} */
let writeQueue = Promise.resolve();

/**
 * @template T
 * @param {() => T} fn synchronous critical section (no await inside)
 * @returns {Promise<T>}
 */
export function withNotificationStoreLock(fn) {
  const run = writeQueue.then(() => fn());
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * @param {{ storePath?: string }} [options]
 * @returns {string}
 */
export function resolveNotificationStorePath(options = {}) {
  return options.storePath || resolveDataPath(NOTIFICATION_STORE_FILE);
}

/**
 * @typedef {{
 *   id: string,
 *   category: string,
 *   severity: string,
 *   title: string,
 *   body: string,
 *   actionUrl: string,
 *   createdAt: string,
 *   readAt: string | null,
 *   dismissedAt: string | null,
 *   fingerprint: string,
 * }} NotificationRecord
 */

/**
 * A compact stand-in for a dismissed occurrence that left the record cap.
 * Retained by age only (see `pruneNotificationStore`) so a replay cannot
 * resurrect a dismissed occurrence inside the retention window.
 *
 * @typedef {{
 *   fingerprint: string,
 *   createdAt: string,
 * }} NotificationTombstone
 */

/**
 * @typedef {{
 *   schemaVersion: number,
 *   revision: number,
 *   items: NotificationRecord[],
 *   tombstones: NotificationTombstone[],
 * }} NotificationStoreDocument
 */

/**
 * @returns {NotificationStoreDocument}
 */
function emptyDocument() {
  return {
    schemaVersion: NOTIFICATION_STORE_SCHEMA_VERSION,
    revision: 0,
    items: [],
    tombstones: [],
  };
}

/**
 * @param {unknown} row
 * @returns {NotificationTombstone | null}
 */
function normalizeTombstone(row) {
  if (typeof row === 'string') {
    const fingerprint = row.trim();
    return fingerprint ? { fingerprint, createdAt: '' } : null;
  }
  if (!row || typeof row !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (row);
  const fingerprint = String(rec.fingerprint || '').trim();
  if (!fingerprint) return null;
  return {
    fingerprint,
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : '',
  };
}

/**
 * @param {unknown} parsed
 * @returns {NotificationStoreDocument}
 */
function normalizeDocument(parsed) {
  if (!parsed || typeof parsed !== 'object') return emptyDocument();
  const doc = /** @type {Record<string, unknown>} */ (parsed);
  const itemsRaw = Array.isArray(doc.items) ? doc.items : [];
  /** @type {NotificationRecord[]} */
  const items = [];
  for (const row of itemsRaw) {
    if (!row || typeof row !== 'object') continue;
    const rec = /** @type {Record<string, unknown>} */ (row);
    const id = String(rec.id || '').trim();
    const category = String(rec.category || '').trim();
    const severity = String(rec.severity || '').trim();
    const fingerprint = String(rec.fingerprint || '').trim();
    const title = String(rec.title || '').trim();
    if (!id || !category || !severity || !fingerprint || !title) continue;
    if (!NOTIFICATION_CATEGORIES.includes(category)) continue;
    if (!NOTIFICATION_SEVERITIES.includes(severity)) continue;
    items.push({
      id,
      category,
      severity,
      title,
      body: String(rec.body || ''),
      actionUrl: String(rec.actionUrl || ''),
      createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString(),
      readAt: typeof rec.readAt === 'string' ? rec.readAt : null,
      dismissedAt: typeof rec.dismissedAt === 'string' ? rec.dismissedAt : null,
      fingerprint,
    });
  }
  const tombstonesRaw = Array.isArray(doc.tombstones) ? doc.tombstones : [];
  /** @type {NotificationTombstone[]} */
  const tombstones = [];
  const seenTombstones = new Set();
  for (const row of tombstonesRaw) {
    const tombstone = normalizeTombstone(row);
    if (!tombstone || seenTombstones.has(tombstone.fingerprint)) continue;
    seenTombstones.add(tombstone.fingerprint);
    tombstones.push(tombstone);
  }
  const revision = Number(doc.revision);
  return {
    schemaVersion: NOTIFICATION_STORE_SCHEMA_VERSION,
    revision: Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0,
    items,
    tombstones,
  };
}

/**
 * @param {{ storePath?: string }} [options]
 * @returns {NotificationStoreDocument}
 */
export function readNotificationStoreSync(options = {}) {
  const filePath = resolveNotificationStorePath(options);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeDocument(JSON.parse(raw));
  } catch {
    return emptyDocument();
  }
}

/**
 * Persist the whole document atomically. Callers hold `withNotificationStoreLock`,
 * so the synchronous `writeJsonAtomic` (temp file + rename) is enough.
 *
 * @param {NotificationStoreDocument} doc
 * @param {{ storePath?: string }} [options]
 * @returns {string}
 */
function writeNotificationStoreSync(doc, options = {}) {
  const filePath = resolveNotificationStorePath(options);
  ensureWritableDir(path.dirname(filePath));
  writeJsonAtomic(filePath, doc);
  return filePath;
}

/**
 * @param {NotificationRecord[]} items
 * @param {number} nowMs
 * @returns {NotificationRecord[]} newest first, age- and count-bounded
 */
function sortAndBoundItems(items, nowMs) {
  const cutoff = nowMs - NOTIFICATION_MAX_AGE_MS;
  return [...items]
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt) || 0;
      const tb = Date.parse(b.createdAt) || 0;
      return tb - ta;
    })
    .filter((row) => {
      const t = Date.parse(row.createdAt);
      return Number.isFinite(t) && t >= cutoff;
    })
    .slice(0, NOTIFICATION_MAX_RECORDS);
}

/**
 * Age/count prune the store and carry occurrences that fall out of the record
 * cap into compact tombstones.
 *
 * Tombstones are pruned by age only (same `NOTIFICATION_MAX_AGE_MS` measured from
 * the occurrence's `createdAt`), never by the record count, so a fingerprint
 * survives count-based pruning for the whole age-based retention window. This is
 * independent of read/dismiss state: an active or read row evicted by the count
 * bound also gets a tombstone, otherwise replaying its event would recreate it.
 * Once an occurrence is older than the window a replay may create a new row —
 * that is the documented bound of the dedupe guarantee.
 *
 * @param {NotificationRecord[]} items
 * @param {NotificationTombstone[]} tombstones
 * @param {number} [nowMs]
 * @returns {{ items: NotificationRecord[], tombstones: NotificationTombstone[] }}
 */
export function pruneNotificationStore(items, tombstones = [], nowMs = Date.now()) {
  const cutoff = nowMs - NOTIFICATION_MAX_AGE_MS;
  const kept = sortAndBoundItems(items, nowMs);
  /** @type {NotificationTombstone[]} */
  const nextTombstones = [];
  const seen = new Set();
  const addTombstone = (fingerprint, createdAt) => {
    const key = String(fingerprint || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    nextTombstones.push({ fingerprint: key, createdAt: typeof createdAt === 'string' ? createdAt : '' });
  };
  for (const tombstone of Array.isArray(tombstones) ? tombstones : []) {
    const key = String(tombstone?.fingerprint || '').trim();
    if (!key || seen.has(key)) continue;
    const t = Date.parse(tombstone?.createdAt);
    // Keep tombstones with an unparseable timestamp rather than resurrecting them.
    if (Number.isFinite(t) && t < cutoff) continue;
    addTombstone(key, tombstone?.createdAt);
  }
  // Every row dropped by the count cap becomes a tombstone, not only the
  // dismissed ones: the "one fingerprint = one occurrence" contract must hold
  // for an active/read row that a later publish pushes out of the cap, so a
  // replay of that old event cannot recreate it. Rows dropped by age are already
  // outside the retention window, so they need none.
  const keptIdSet = new Set(kept.map((row) => row.id));
  for (const row of items) {
    if (keptIdSet.has(row.id)) continue;
    const t = Date.parse(row.createdAt);
    if (!Number.isFinite(t) || t < cutoff) continue;
    addTombstone(row.fingerprint, row.createdAt);
  }
  return { items: kept, tombstones: nextTombstones };
}

/**
 * @param {NotificationRecord[]} items
 * @param {number} [nowMs]
 * @returns {NotificationRecord[]}
 */
export function pruneNotificationItems(items, nowMs = Date.now()) {
  return pruneNotificationStore(items, [], nowMs).items;
}

/**
 * One fingerprint == one occurrence. A match is a live/read/dismissed record or a
 * retained tombstone; only a producer choosing a NEW fingerprint creates a row.
 *
 * @param {NotificationStoreDocument} doc
 * @param {string} fingerprint
 * @returns {NotificationRecord | null}
 */
function findByFingerprint(doc, fingerprint) {
  const key = String(fingerprint || '').trim();
  if (!key) return null;
  for (const row of doc.items) {
    if (row.fingerprint === key) return row;
  }
  for (const tombstone of doc.tombstones) {
    if (tombstone.fingerprint === key) {
      return { id: null, fingerprint: key, dismissedAt: '', readAt: '' };
    }
  }
  return null;
}

/**
 * @param {string} actionUrl
 * @returns {boolean}
 */
function isSafeRelativeActionUrl(actionUrl) {
  if (!actionUrl.startsWith('/')) return false;
  if (actionUrl.startsWith('//')) return false;
  if (actionUrl.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(actionUrl)) return false;
  return true;
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: {
 *   category: string,
 *   severity: string,
 *   title: string,
 *   body: string,
 *   actionUrl: string,
 *   fingerprint: string,
 * } } | { ok: false, error: string }}
 */
export function validatePublishInput(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid_input' };
  const raw = /** @type {Record<string, unknown>} */ (input);
  const category = String(raw.category || '').trim();
  const severity = String(raw.severity || '').trim();
  const fingerprint = String(raw.fingerprint || '').trim();
  const title = sanitizeNotificationText(raw.title, 240);
  const body = sanitizeNotificationText(raw.body, 4000);
  const actionUrl = String(raw.actionUrl || '').trim();
  if (!NOTIFICATION_CATEGORIES.includes(category)) return { ok: false, error: 'invalid_category' };
  if (!NOTIFICATION_SEVERITIES.includes(severity)) return { ok: false, error: 'invalid_severity' };
  if (!fingerprint || fingerprint.length > 512) return { ok: false, error: 'invalid_fingerprint' };
  if (!title) return { ok: false, error: 'invalid_title' };
  // Same-origin relative navigation only: a single leading `/`, no protocol-relative
  // `//`, no backslash, no control/whitespace characters and no scheme.
  if (actionUrl && !isSafeRelativeActionUrl(actionUrl)) {
    return { ok: false, error: 'invalid_action_url' };
  }
  return {
    ok: true,
    value: { category, severity, title, body, actionUrl, fingerprint },
  };
}

/**
 * Publish one occurrence of an event.
 *
 * Fingerprint contract: the caller owns occurrence identity. The store treats a
 * fingerprint as ONE occurrence — publishing an already known fingerprint
 * (active, read or dismissed) is a `created: false` no-op for the whole
 * retention window. To surface a genuinely new occurrence the producer MUST
 * derive a NEW fingerprint:
 *   - chat/new-chat/request events: include the durable ids (chatId + runId /
 *     requestId) so a replay of the same event keeps the fingerprint and a new
 *     run gets a different one;
 *   - catalog snapshots: include a stable hash of the resulting sorted id set so
 *     a retry after a failed snapshot write stays deduped while a later change
 *     creates a new item;
 *   - recurring "episode" producers (server self-check, unclassified-errors)
 *     must add an episode counter/version, e.g.
 *     `notificationFingerprintWithEpisode(base, episode)` from
 *     `notification-producers.js`.
 *
 * @param {object} input
 * @param {{ storePath?: string, now?: () => number, broadcast?: boolean }} [options]
 * @returns {Promise<{ created: boolean, id: string | null, revision: number }>}
 */
export async function publishNotification(input, options = {}) {
  const checked = validatePublishInput(input);
  if (!checked.ok) {
    return { created: false, id: null, revision: readNotificationStoreSync(options).revision };
  }
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const shouldBroadcast = options.broadcast !== false;
  return withNotificationStoreLock(() => {
    const doc = readNotificationStoreSync(options);
    const existing = findByFingerprint(doc, checked.value.fingerprint);
    if (existing) {
      return { created: false, id: existing.id, revision: doc.revision };
    }
    const record = {
      id: randomUUID(),
      ...checked.value,
      createdAt,
      readAt: null,
      dismissedAt: null,
    };
    const pruned = pruneNotificationStore([record, ...doc.items], doc.tombstones, nowMs);
    const nextDoc = {
      schemaVersion: NOTIFICATION_STORE_SCHEMA_VERSION,
      revision: doc.revision + 1,
      items: pruned.items,
      tombstones: pruned.tombstones,
    };
    writeNotificationStoreSync(nextDoc, { ...options, nowMs });
    if (shouldBroadcast) {
      broadcastNotificationsChanged({ revision: nextDoc.revision, reason: 'publish' });
    }
    return { created: true, id: record.id, revision: nextDoc.revision };
  });
}

/**
 * @param {{ category?: string }} [query]
 * @param {{ storePath?: string, preferences?: import('./notification-preferences.js').NotificationCenterPreferences }} [options]
 * @returns {{
 *   revision: number,
 *   unreadCount: number,
 *   preferences: import('./notification-preferences.js').NotificationCenterPreferences,
 *   items: NotificationRecord[],
 * }}
 */
export function listNotifications(query = {}, options = {}) {
  const doc = readNotificationStoreSync(options);
  const preferences = options.preferences || getNotificationCenterPreferences();
  const categoryFilter = String(query.category || '').trim();
  const visible = doc.items.filter((row) => !row.dismissedAt);
  /** @type {NotificationRecord[]} */
  const items = [];
  let unreadCount = 0;
  for (const row of visible) {
    if (categoryFilter && row.category !== categoryFilter) continue;
    if (!notificationMatchesPreferences(preferences, row)) continue;
    items.push(row);
    if (!row.readAt) unreadCount += 1;
  }
  if (!preferences.showBadge) unreadCount = 0;
  return {
    revision: doc.revision,
    unreadCount,
    preferences,
    items,
  };
}

/**
 * @param {{ id?: string, all?: boolean }} input
 * @param {{ storePath?: string, now?: () => number }} [options]
 * @returns {Promise<{ ok: boolean, error?: string, revision: number, changed: boolean }>}
 */
export async function markNotificationsRead(input, options = {}) {
  const all = input?.all === true;
  const id = String(input?.id || '').trim();
  if (!all && !id) return { ok: false, error: 'missing_target', revision: readNotificationStoreSync(options).revision, changed: false };
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  return withNotificationStoreLock(() => {
    const doc = readNotificationStoreSync(options);
    let changed = false;
    const nextItems = doc.items.map((row) => {
      if (row.dismissedAt) return row;
      const match = all ? true : row.id === id;
      if (!match) return row;
      if (row.readAt) return row;
      changed = true;
      return { ...row, readAt: nowIso };
    });
    if (!all && id && !doc.items.some((row) => row.id === id)) {
      return { ok: false, error: 'not_found', revision: doc.revision, changed: false };
    }
    if (!changed) {
      // Retention also advances on idempotent writes so a read-only client still
      // ages out stale rows (see the dismissal branch for the tombstone carry-over).
      const pruned = pruneNotificationStore(nextItems, doc.tombstones, nowMs);
      if (pruned.items.length !== doc.items.length || pruned.tombstones.length !== doc.tombstones.length) {
        const nextDoc = {
          schemaVersion: NOTIFICATION_STORE_SCHEMA_VERSION,
          revision: doc.revision + 1,
          items: pruned.items,
          tombstones: pruned.tombstones,
        };
        writeNotificationStoreSync(nextDoc, options);
        broadcastNotificationsChanged({ revision: nextDoc.revision, reason: 'read' });
        return { ok: true, revision: nextDoc.revision, changed: false };
      }
      return { ok: true, revision: doc.revision, changed: false };
    }
    const pruned = pruneNotificationStore(nextItems, doc.tombstones, nowMs);
    const nextDoc = {
      schemaVersion: NOTIFICATION_STORE_SCHEMA_VERSION,
      revision: doc.revision + 1,
      items: pruned.items,
      tombstones: pruned.tombstones,
    };
    writeNotificationStoreSync(nextDoc, options);
    broadcastNotificationsChanged({ revision: nextDoc.revision, reason: 'read' });
    return { ok: true, revision: nextDoc.revision, changed: true };
  });
}

/**
 * @param {{ id?: string, all?: boolean }} input
 * @param {{ storePath?: string, now?: () => number }} [options]
 * @returns {Promise<{ ok: boolean, error?: string, revision: number, changed: boolean }>}
 */
export async function dismissNotifications(input, options = {}) {
  const all = input?.all === true;
  const id = String(input?.id || '').trim();
  if (!all && !id) return { ok: false, error: 'missing_target', revision: readNotificationStoreSync(options).revision, changed: false };
  const nowMs = typeof options.now === 'function' ? options.now() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  return withNotificationStoreLock(() => {
    const doc = readNotificationStoreSync(options);
    let changed = false;
    const nextItems = doc.items.map((row) => {
      const match = all ? !row.dismissedAt : row.id === id;
      if (!match) return row;
      if (all && row.dismissedAt) return row;
      if (!all && row.id !== id) return row;
      if (row.dismissedAt) return row;
      changed = true;
      return { ...row, dismissedAt: nowIso, readAt: row.readAt || nowIso };
    });
    if (!all && id && !doc.items.some((row) => row.id === id)) {
      return { ok: false, error: 'not_found', revision: doc.revision, changed: false };
    }
    if (!changed) {
      const pruned = pruneNotificationStore(nextItems, doc.tombstones, nowMs);
      if (pruned.items.length !== doc.items.length || pruned.tombstones.length !== doc.tombstones.length) {
        const nextDoc = {
          schemaVersion: NOTIFICATION_STORE_SCHEMA_VERSION,
          revision: doc.revision + 1,
          items: pruned.items,
          tombstones: pruned.tombstones,
        };
        writeNotificationStoreSync(nextDoc, options);
        broadcastNotificationsChanged({ revision: nextDoc.revision, reason: 'dismiss' });
        return { ok: true, revision: nextDoc.revision, changed: false };
      }
      return { ok: true, revision: doc.revision, changed: false };
    }
    const pruned = pruneNotificationStore(nextItems, doc.tombstones, nowMs);
    const nextDoc = {
      schemaVersion: NOTIFICATION_STORE_SCHEMA_VERSION,
      revision: doc.revision + 1,
      items: pruned.items,
      tombstones: pruned.tombstones,
    };
    writeNotificationStoreSync(nextDoc, options);
    broadcastNotificationsChanged({ revision: nextDoc.revision, reason: 'dismiss' });
    return { ok: true, revision: nextDoc.revision, changed: true };
  });
}

/**
 * Test-only reset of the in-process write queue.
 * @returns {void}
 */
export function __resetNotificationStoreQueueForTest() {
  writeQueue = Promise.resolve();
}
