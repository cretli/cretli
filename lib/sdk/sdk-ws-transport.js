/** @typedef {'critical' | 'normal'} SdkBroadcastPriority */

export const WS_BACKPRESSURE_THRESHOLD_BYTES = 512 * 1024;
export const REPLAY_BATCH_SIZE = 25;
export const REPLAY_BATCH_DELAY_MS = 50;
export const BACKPRESSURE_DRAIN_POLL_MS = 50;
export const BACKPRESSURE_DRAIN_MAX_WAIT_MS = 5000;

import { SDK_WS_CRITICAL_BROADCAST_TYPES } from './sdk-ws-protocol.js';

const CRITICAL_BROADCAST_TYPES = SDK_WS_CRITICAL_BROADCAST_TYPES;

/**
 * @param {Record<string, unknown>} payload
 * @param {SdkBroadcastPriority} [override]
 * @returns {SdkBroadcastPriority}
 */
export function resolveBroadcastPriority(payload, override) {
  if (override === 'critical' || override === 'normal') return override;
  const type = typeof payload?.type === 'string' ? payload.type : '';
  if (CRITICAL_BROADCAST_TYPES.has(type)) return 'critical';
  return 'normal';
}

/**
 * @param {import('ws').WebSocket | null | undefined} client
 * @param {SdkBroadcastPriority} priority
 * @param {number} [thresholdBytes]
 * @returns {boolean}
 */
export function shouldSendToClient(client, priority, thresholdBytes = WS_BACKPRESSURE_THRESHOLD_BYTES) {
  if (!client || client.readyState !== 1) return false;
  if (priority === 'critical') return true;
  return client.bufferedAmount <= thresholdBytes;
}

/**
 * @param {Set<import('ws').WebSocket>} clients
 * @returns {number}
 */
export function getMaxClientBufferedAmount(clients) {
  let maxBuffered = 0;
  for (const client of clients) {
    if (!client || client.readyState !== 1) continue;
    if (client.bufferedAmount > maxBuffered) maxBuffered = client.bufferedAmount;
  }
  return maxBuffered;
}

/**
 * @param {Set<import('ws').WebSocket>} clients
 * @param {number} [thresholdBytes]
 * @returns {boolean}
 */
export function hasRoomBackpressure(clients, thresholdBytes = WS_BACKPRESSURE_THRESHOLD_BYTES) {
  return getMaxClientBufferedAmount(clients, thresholdBytes) > thresholdBytes;
}

/**
 * @param {Array<{ payload?: Record<string, unknown> }>} entries
 * @param {number} [batchSize]
 * @returns {Array<Array<Record<string, unknown>>>}
 */
export function chunkReplayPayloads(entries, batchSize = REPLAY_BATCH_SIZE) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const safeBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : REPLAY_BATCH_SIZE;
  const batches = [];
  /** @type {Array<Record<string, unknown>>} */
  let current = [];
  for (const entry of entries) {
    if (!entry?.payload || typeof entry.payload !== 'object') continue;
    current.push({ ...entry.payload, replay: true });
    if (current.length >= safeBatchSize) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
