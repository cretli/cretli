/**
 * Lightweight SDK room stub for non-owner Node instances (multi-instance + Redis).
 * Receives live events via pub-sub; does not run @cursor/sdk Agent locally.
 */

import { randomUUID } from 'node:crypto';

/**
 * @param {string} sessionKey
 * @param {{
 *   id?: string,
 *   title?: string,
 *   model?: string,
 *   sdkMode?: string,
 * }} chat
 * @param {{
 *   instanceId?: string | null,
 *   eventStreamId?: string | null,
 *   eventSeq?: number,
 *   busy?: boolean,
 * }} ownerMeta
 * @param {{
 *   cwd: string,
 *   modelId: string,
 *   modelSelection: unknown,
 *   apiKey: string,
 *   sdkMode: 'plan' | 'agent',
 *   onRunFinished?: ((...args: unknown[]) => void) | null,
 * }} deps
 * @returns {Record<string, unknown>}
 */
export function createSdkRemoteRoomStub(sessionKey, chat, ownerMeta, deps) {
  const eventStreamId =
    typeof ownerMeta?.eventStreamId === 'string' && ownerMeta.eventStreamId.trim()
      ? ownerMeta.eventStreamId.trim()
      : randomUUID();
  const eventSeq = Number(ownerMeta?.eventSeq);
  const ownerInstanceId =
    typeof ownerMeta?.instanceId === 'string' && ownerMeta.instanceId.trim()
      ? ownerMeta.instanceId.trim()
      : null;
  return {
    clients: new Set(),
    agent: null,
    isRemoteStub: true,
    ownerInstanceId,
    cwd: deps.cwd,
    modelId: deps.modelId,
    modelSelection: deps.modelSelection,
    apiKey: deps.apiKey,
    sdkMode: deps.sdkMode,
    busy: ownerMeta?.busy === true,
    currentRun: null,
    pendingPrompts: [],
    eventStreamId,
    eventSeq: Number.isSafeInteger(eventSeq) && eventSeq >= 0 ? eventSeq : 0,
    eventLog: [],
    sessionKey,
    chatId: chat?.id || '',
    chatTitle: chat?.title || chat?.id || '',
    onRunFinished: typeof deps.onRunFinished === 'function' ? deps.onRunFinished : null,
    lastEventAt: null,
    lastRunTimings: null,
  };
}

/**
 * @param {any} room
 * @returns {boolean}
 */
export function isSdkRemoteRoomStub(room) {
  return !!(room && room.isRemoteStub === true);
}

/**
 * Applies a sequenced payload from Redis pub-sub to a room (stub or local mirror).
 *
 * @param {any} room
 * @param {Record<string, unknown>} payload
 * @param {{
 *   roomEventLogMax: number,
 *   broadcast: (room: any, payload: Record<string, unknown>, options?: Record<string, unknown>) => void,
 *   persist?: (room: any, payload: Record<string, unknown>) => void,
 * }} handlers
 * @returns {boolean}
 */
export function applySequencedRemoteRoomEvent(room, payload, handlers) {
  if (!room || !payload || typeof payload !== 'object') return false;
  const seq = Number(payload.roomEventSeq);
  if (!Number.isSafeInteger(seq) || seq <= 0) return false;
  if (seq <= room.eventSeq) return false;
  if (typeof payload.eventStreamId === 'string' && payload.eventStreamId.trim()) {
    room.eventStreamId = payload.eventStreamId.trim();
  }
  if (payload.type === 'sdkRoomState') {
    room.busy = payload.busy === true;
  }
  room.eventSeq = seq;
  room.lastEventAt = Date.now();
  if (!Array.isArray(room.eventLog)) room.eventLog = [];
  room.eventLog.push({ seq, at: room.lastEventAt, payload });
  const max = Number(handlers.roomEventLogMax);
  if (Number.isFinite(max) && max > 0 && room.eventLog.length > max) {
    room.eventLog = room.eventLog.slice(-max);
  }
  if (typeof handlers.persist === 'function' && !room.isRemoteStub) {
    handlers.persist(room, payload);
  }
  handlers.broadcast(room, payload, { priority: 'normal' });
  return true;
}
