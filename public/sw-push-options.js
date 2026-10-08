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
 */
(function attachPushOptions(root) {
  'use strict';

  var DEFAULT_VIBRATE = [80, 40, 80];
  var PUSH_TEST_TYPE = 'push-test';

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

  root.cretliPushOptions = {
    DEFAULT_VIBRATE: DEFAULT_VIBRATE,
    PUSH_TEST_TYPE: PUSH_TEST_TYPE,
    readPushEventId: readPushEventId,
    hasPushEventId: hasPushEventId,
    isPushTestPayload: isPushTestPayload,
    shouldPersistPushPayload: shouldPersistPushPayload,
    resolvePushSilent: resolvePushSilent,
    resolvePushVibrate: resolvePushVibrate,
    resolvePushRenotify: resolvePushRenotify,
  };
})(typeof self !== 'undefined' ? self : this);
