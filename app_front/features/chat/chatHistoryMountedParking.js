/**
 * Parks history records evicted from the mounted SDK stream window.
 */

import { isSameViewOrderKey, resolveViewOrderKey } from './chatHistoryViewOrder.js';
import { mergeParkedHistoryRecords } from '../../lib/sdkHistoryMountedWindow.js';

/**
 * @param {object | null | undefined} chat
 * @returns {unknown[]}
 */
export function getHistoryParkedNewerLocal(chat) {
  if (!chat || typeof chat !== 'object') return [];
  return Array.isArray(chat._historyParkedNewerLocal) ? chat._historyParkedNewerLocal : [];
}

/**
 * @param {object | null | undefined} chat
 * @returns {unknown[]}
 */
export function getHistoryOlderLocal(chat) {
  if (!chat || typeof chat !== 'object') return [];
  return Array.isArray(chat._historyOlderLocal) ? chat._historyOlderLocal : [];
}

/**
 * @param {object | null | undefined} chat
 * @param {unknown[]} records chronological
 */
export function prependHistoryOlderLocal(chat, records) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(records) || records.length === 0) return;
  const existing = getHistoryOlderLocal(chat);
  chat._historyOlderLocal = mergeParkedHistoryRecords(records, existing);
}

/**
 * @param {object | null | undefined} chat
 * @param {unknown[]} records chronological
 */
export function prependHistoryParkedNewerLocal(chat, records) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(records) || records.length === 0) return;
  const existing = getHistoryParkedNewerLocal(chat);
  chat._historyParkedNewerLocal = mergeParkedHistoryRecords(records, existing);
}

/**
 * @param {object | null | undefined} chat
 * @param {number} count from the start (oldest parked newer)
 * @returns {unknown[]}
 */
export function takeHistoryParkedNewerLocal(chat, count) {
  if (!chat || typeof chat !== 'object') return [];
  const list = getHistoryParkedNewerLocal(chat);
  const take = Math.max(0, Math.min(list.length, Math.floor(Number(count) || 0)));
  if (take <= 0) return [];
  const slice = list.slice(0, take);
  chat._historyParkedNewerLocal = list.slice(take);
  return slice;
}

/**
 * @param {object | null | undefined} chat
 */
export function clearHistoryMountedParking(chat) {
  if (!chat || typeof chat !== 'object') return;
  chat._historyParkedNewerLocal = [];
  chat._historyOlderLocal = [];
}

/**
 * Drops parked clones for a view-order key when the live stream remounts that record.
 *
 * @param {object | null | undefined} chat
 * @param {unknown} orderKeyOrRecord
 */
export function removeHistoryRecordFromMountedParking(chat, orderKeyOrRecord) {
  if (!chat || typeof chat !== 'object') return;
  const key = resolveViewOrderKey(orderKeyOrRecord);
  if (!key.historySeq && !key.roomEventSeq) return;
  /**
   * @param {unknown[]} list
   * @returns {unknown[]}
   */
  const withoutKey = (list) =>
    list.filter((rec) => !isSameViewOrderKey(key, resolveViewOrderKey(rec)));
  chat._historyParkedNewerLocal = withoutKey(getHistoryParkedNewerLocal(chat));
  chat._historyOlderLocal = withoutKey(getHistoryOlderLocal(chat));
}

/**
 * Mirrors {@link loadOlderSdkHistoryPage} local-cache slice in chat.js (no server fetch).
 *
 * @param {object | null | undefined} chat
 * @param {number} pageSize
 * @returns {{ records: unknown[], hasOlder: boolean, remaining: number }}
 */
export function takeOlderHistoryPageFromLocalCache(chat, pageSize) {
  const limit = Math.max(1, Math.floor(Number(pageSize) || 1));
  const cached = getHistoryOlderLocal(chat);
  if (cached.length === 0) {
    return { records: [], hasOlder: false, remaining: 0 };
  }
  const cut = Math.max(0, cached.length - limit);
  chat._historyOlderLocal = cached.slice(0, cut);
  const records = cached.slice(cut);
  return {
    records,
    hasOlder: cut > 0,
    remaining: cut,
  };
}
