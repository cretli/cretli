/**
 * Push inbox IndexedDB helpers for public/sw.js.
 *
 * Classic script on purpose (importScripts). Unit tests load this file through
 * node:vm the same way as sw-notification-click.js.
 */
(function attachPushInbox(root) {
  'use strict';

  var DB_NAME = 'cretli-push-inbox';
  var STORE_NAME = 'events';
  var SNIPPET_MAX = 280;

  /**
   * @param {unknown} value
   * @param {number} max
   * @returns {string}
   */
  function clipSnippet(value, max) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= max) return text;
    return text.slice(0, Math.max(1, max - 1)) + '…';
  }

  /**
   * @param {unknown} value
   * @returns {number}
   */
  function readFiniteNumber(value) {
    var num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  /**
   * @param {{ title?: unknown, body?: unknown, data?: unknown }} payload
   * @returns {object | null}
   */
  function buildPushInboxRecordFromNotificationPayload(payload) {
    var data = payload && payload.data && typeof payload.data === 'object' ? payload.data : null;
    if (!data) return null;
    var chatId = String(data.chatId || '').trim();
    if (!chatId) return null;
    var type = String(data.type || '').trim();
    if (!type) return null;
    var at = readFiniteNumber(data.at) || Date.now();
    var record = { chatId: chatId, type: type, at: at, receivedAt: Date.now() };
    var status = String(data.status || '').trim();
    if (status) record.status = status;
    var headSeq = readFiniteNumber(data.headSeq);
    if (headSeq > 0) record.headSeq = headSeq;
    var title = String(data.title || payload.title || '').trim();
    if (title) record.title = title;
    var snippet = clipSnippet(data.snippet, SNIPPET_MAX);
    if (snippet) record.snippet = snippet;
    var kind = String(data.kind || '').trim();
    if (kind) record.kind = kind;
    return record;
  }

  /**
   * @param {object | null | undefined} existing
   * @param {object | null | undefined} incoming
   * @returns {object | null}
   */
  function mergePushInboxRecords(existing, incoming) {
    if (!incoming) return existing || null;
    if (!existing) return incoming;
    if (readFiniteNumber(incoming.at) >= readFiniteNumber(existing.at)) return incoming;
    return existing;
  }

  /**
   * @returns {Promise<IDBDatabase>}
   */
  function openPushInboxDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, 1);
      request.onerror = function () {
        reject(request.error || new Error('push-inbox-open-failed'));
      };
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'chatId' });
        }
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
    });
  }

  /**
   * @param {object} record
   * @returns {Promise<void>}
   */
  function putPushInboxRecord(record) {
    return openPushInboxDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.oncomplete = function () {
          db.close();
          resolve();
        };
        tx.onerror = function () {
          db.close();
          reject(tx.error || new Error('push-inbox-tx-failed'));
        };
        var store = tx.objectStore(STORE_NAME);
        var getReq = store.get(record.chatId);
        getReq.onsuccess = function () {
          var merged = mergePushInboxRecords(getReq.result || null, record);
          if (merged) store.put(merged);
        };
        getReq.onerror = function () {
          reject(getReq.error || new Error('push-inbox-get-failed'));
        };
      });
    });
  }

  /**
   * @param {{ title?: unknown, body?: unknown, data?: unknown }} payload
   * @returns {Promise<void>}
   */
  function persistPushPayload(payload) {
    var record = buildPushInboxRecordFromNotificationPayload(payload);
    if (!record) return Promise.resolve();
    return putPushInboxRecord(record);
  }

  root.cretliPushInbox = {
    DB_NAME: DB_NAME,
    STORE_NAME: STORE_NAME,
    buildPushInboxRecordFromNotificationPayload: buildPushInboxRecordFromNotificationPayload,
    mergePushInboxRecords: mergePushInboxRecords,
    persistPushPayload: persistPushPayload,
  };
})(typeof self !== 'undefined' ? self : this);
