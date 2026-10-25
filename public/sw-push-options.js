/**
 * Pure push notification option/decision helpers for public/sw.js.
 *
 * Classic script on purpose (importScripts). Unit tests load this file through
 * node:vm the same way as sw-notification-click.js and sw-push-inbox.js, so it
 * must not use import/export or Node globals. It exposes `cretliPushOptions` on
 * the global object.
 *
 * Semantics:
 * - no `vibrate` field at all => legacy payload, the historical `[80,40,80]`;
 * - `vibrate: []` => vibration explicitly disabled (a new payload marker);
 * - `silent: true` => silent, never vibrate;
 * - `data.eventId` absent => legacy renotify (always true);
 * - `data.eventId` present => renotify only when no displayed notification with
 *   the same tag carries that event id.
 * - `data.eventId` present => the receiving side also keeps a durable seen list
 *   (sw.js) so a retried push after the first notification was dismissed is not
 *   shown again. The pure decision/prune helpers live here.
 */
(function attachPushOptions(root) {
  'use strict';

  var DEFAULT_VIBRATE = [80, 40, 80];
  var PUSH_TEST_TYPE = 'push-test';
  /** Upper bound of remembered push occurrence ids on one device. */
  var PUSH_EVENT_ID_MAX_ENTRIES = 100;
  /** Remembered occurrence ids older than this are pruned. */
  var PUSH_EVENT_ID_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  /**
   * @param {unknown} payload
   * @returns {string}
   */
  function readPushEventId(payload) {
    var data = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
      ? payload.data
      : null;
    if (!data) return '';
    return typeof data.eventId === 'string' ? data.eventId.trim() : '';
  }

  /**
   * @param {unknown} payload
   * @returns {boolean}
   */
  function hasPushEventId(payload) {
    return readPushEventId(payload) !== '';
  }

  /**
   * `true` when the payload is an explicit not-a-real-event test push that must
   * not be written to the push inbox.
   *
   * @param {unknown} payload
   * @returns {boolean}
   */
  function isPushTestPayload(payload) {
    var data = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
      ? payload.data
      : null;
    if (!data) return false;
    return String(data.type || '') === PUSH_TEST_TYPE;
  }

  /**
   * Whether the push handler should persist this payload in the inbox.
   *
   * @param {unknown} payload
   * @returns {boolean}
   */
  function shouldPersistPushPayload(payload) {
    return !isPushTestPayload(payload);
  }

  /**
   * @param {unknown} payload
   * @returns {boolean}
   */
  function resolvePushSilent(payload) {
    return !!(payload && typeof payload === 'object' && payload.silent === true);
  }

  /**
   * Vibration pattern for a push payload. Missing field => legacy default;
   * `silent: true` or `vibrate: []` => empty pattern (no vibration).
   *
   * @param {unknown} payload
   * @returns {number[]}
   */
  function resolvePushVibrate(payload) {
    if (resolvePushSilent(payload)) return [];
    if (payload && typeof payload === 'object' && Array.isArray(payload.vibrate)) {
      return payload.vibrate.slice();
    }
    return DEFAULT_VIBRATE.slice();
  }

  /**
   * @param {unknown} payload
   * @param {Array<{ data?: { eventId?: unknown } }>} existingNotifications
   * @returns {boolean}
   */
  function resolvePushRenotify(payload, existingNotifications) {
    var eventId = readPushEventId(payload);
    if (!eventId) return true;
    var existing = Array.isArray(existingNotifications) ? existingNotifications : [];
    for (var i = 0; i < existing.length; i += 1) {
      var notification = existing[i] || {};
      var data = notification.data && typeof notification.data === 'object' ? notification.data : {};
      if (typeof data.eventId === 'string' && data.eventId === eventId) return false;
    }
    return true;
  }

  /**
   * Event id carried by a stored seen entry. A bare string is accepted so an
   * older store shape cannot silently disable deduplication.
   *
   * @param {unknown} entry
   * @returns {string}
   */
  function readSeenPushEventId(entry) {
    if (typeof entry === 'string') return entry.trim();
    if (entry && typeof entry === 'object' && typeof entry.eventId === 'string') {
      return entry.eventId.trim();
    }
    return '';
  }

  /**
   * @param {unknown} entry
   * @returns {number}
   */
  function readSeenPushEventAt(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    var at = Number(entry.receivedAt);
    return Number.isFinite(at) && at > 0 ? at : 0;
  }

  /**
   * Whether `eventId` was already received on this device. A missing/empty id is
   * never a duplicate so payloads without an occurrence identity keep the
   * historical behaviour.
   *
   * @param {unknown} seenIds stored entries (strings or `{ eventId, receivedAt }`)
   * @param {unknown} eventId
   * @returns {boolean}
   */
  function isDuplicatePushEventId(seenIds, eventId) {
    var id = typeof eventId === 'string' ? eventId.trim() : '';
    if (!id) return false;
    var list = Array.isArray(seenIds) ? seenIds : [];
    for (var i = 0; i < list.length; i += 1) {
      if (readSeenPushEventId(list[i]) === id) return true;
    }
    return false;
  }

  /**
   * Bounds a seen-event list by age and size: drops junk, de-duplicates ids
   * (newest timestamp wins), drops entries older than the TTL and keeps the
   * newest `maxEntries`. Newest-first order makes a retried old event unable to
   * evict a fresh one.
   *
   * @param {unknown} entries
   * @param {unknown} now epoch ms
   * @param {{ maxEntries?: unknown, ttlMs?: unknown }} [options]
   * @returns {Array<{ eventId: string, receivedAt: number }>}
   */
  function prunePushEventIds(entries, now, options) {
    var at = Number(now);
    if (!Number.isFinite(at)) at = Date.now();
    var policy = options && typeof options === 'object' ? options : {};
    var ttl = Number(policy.ttlMs) > 0 ? Number(policy.ttlMs) : PUSH_EVENT_ID_TTL_MS;
    var max = Number(policy.maxEntries) > 0
      ? Math.floor(Number(policy.maxEntries))
      : PUSH_EVENT_ID_MAX_ENTRIES;
    var source = Array.isArray(entries) ? entries : [];
    var kept = [];
    var byId = Object.create(null);
    for (var i = 0; i < source.length; i += 1) {
      var id = readSeenPushEventId(source[i]);
      if (!id) continue;
      var receivedAt = readSeenPushEventAt(source[i]);
      if (!(receivedAt > 0)) receivedAt = at;
      if (at - receivedAt > ttl) continue;
      var existing = byId[id];
      if (existing) {
        if (receivedAt > existing.receivedAt) existing.receivedAt = receivedAt;
        continue;
      }
      var entry = { eventId: id, receivedAt: receivedAt };
      byId[id] = entry;
      kept.push(entry);
    }
    kept.sort(function (left, right) {
      return right.receivedAt - left.receivedAt;
    });
    return kept.slice(0, max);
  }

  /**
   * Returns a pruned seen-event list with `eventId` recorded at `now`. An empty
   * id and an already-seen id leave the list unchanged (idempotent record).
   *
   * @param {unknown} entries
   * @param {unknown} eventId
   * @param {unknown} now epoch ms
   * @param {{ maxEntries?: unknown, ttlMs?: unknown }} [options]
   * @returns {Array<{ eventId: string, receivedAt: number }>}
   */
  function recordPushEventId(entries, eventId, now, options) {
    var at = Number(now);
    if (!Number.isFinite(at)) at = Date.now();
    var pruned = prunePushEventIds(entries, at, options);
    var id = typeof eventId === 'string' ? eventId.trim() : '';
    if (!id || isDuplicatePushEventId(pruned, id)) return pruned;
    pruned.unshift({ eventId: id, receivedAt: at });
    return prunePushEventIds(pruned, at, options);
  }

  root.cretliPushOptions = {
    DEFAULT_VIBRATE: DEFAULT_VIBRATE,
    PUSH_TEST_TYPE: PUSH_TEST_TYPE,
    PUSH_EVENT_ID_MAX_ENTRIES: PUSH_EVENT_ID_MAX_ENTRIES,
    PUSH_EVENT_ID_TTL_MS: PUSH_EVENT_ID_TTL_MS,
    readPushEventId: readPushEventId,
    hasPushEventId: hasPushEventId,
    isPushTestPayload: isPushTestPayload,
    shouldPersistPushPayload: shouldPersistPushPayload,
    resolvePushSilent: resolvePushSilent,
    resolvePushVibrate: resolvePushVibrate,
    resolvePushRenotify: resolvePushRenotify,
    readSeenPushEventId: readSeenPushEventId,
    readSeenPushEventAt: readSeenPushEventAt,
    isDuplicatePushEventId: isDuplicatePushEventId,
    prunePushEventIds: prunePushEventIds,
    recordPushEventId: recordPushEventId,
  };
})(typeof self !== 'undefined' ? self : this);
