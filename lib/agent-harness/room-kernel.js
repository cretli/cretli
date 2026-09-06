/**
 * Shared WebSocket room helpers for agent harnesses (broadcast, event log,
 * persist buffer, empty-room grace shutdown, replay, heartbeat).
 */

import { randomUUID } from 'node:crypto';
import { appendChatHistoryEvents } from '../persist/chat-history-persist.js';
import { noteHarnessWsPayloadForPlanSync } from '../sdk/harness-plan-sync.js';
import { notifySdkClientsChatGone } from '../sdk/sdk-ws-chat-gone.js';
import { scheduleSdkWsEventLogReplay } from '../sdk/sdk-ws-handshake.js';
import {
  resolveBroadcastPriority,
  shouldSendToClient,
  WS_BACKPRESSURE_THRESHOLD_BYTES,
} from '../sdk/sdk-ws-transport.js';
import {
  buildSdkRoomStatePayload,
  ROOM_STATE_HEARTBEAT_INTERVAL_MS,
} from '../sdk/sdk-room-state.js';
import { disposeMcpContext } from '../mcp/mcp-service.js';

export const ROOM_EMPTY_GRACE_MS = 90_000;
export const MAX_EVENT_LOG = 1200;
export const ROOM_PERSIST_FLUSH_MS = 2000;

/**
 * @typedef {object} AgentRoomKernelOptions
 * @property {string} transport
 * @property {string} [logLabel]
 * @property {string} [goneMessage]
 * @property {Map<string, object>} [rooms]
 * @property {number} [graceMs]
 * @property {number} [maxEventLog]
 * @property {(room: object, recs: object[]) => void} [persistHistory]
 * @property {(room: object) => void} [abortRoom]
 * @property {(room: object, payload: Record<string, unknown>) => void} [afterBroadcast]
 */

/**
 * @param {{ clients?: Set<{ readyState: number, send: (msg: string) => void, bufferedAmount?: number }> }} room
 * @param {Record<string, unknown>} payload
 * @param {{ priority?: 'critical' | 'normal' }} [options]
 */
export function broadcastToRoomClients(room, payload, options = {}) {
  if (!room?.clients) return;
  const priority = resolveBroadcastPriority(payload, options.priority);
  const serialized = JSON.stringify(payload);
  for (const client of room.clients) {
    if (!shouldSendToClient(client, priority, WS_BACKPRESSURE_THRESHOLD_BYTES)) continue;
    try {
      client.send(serialized);
    } catch (err) {
      console.warn('[room-kernel] send failed:', err?.message || err);
    }
  }
}

/**
 * @param {object} room
 * @param {Record<string, unknown>} payload
 * @param {number} [maxEventLog]
 * @returns {Record<string, unknown>}
 */
export function pushRoomEvent(room, payload, maxEventLog = MAX_EVENT_LOG) {
  if (!room) return payload;
  room.eventSeq = (Number(room.eventSeq) || 0) + 1;
  const enriched = {
    ...payload,
    roomEventSeq: room.eventSeq,
    eventStreamId: room.eventStreamId,
  };
  if (!Array.isArray(room.eventLog)) room.eventLog = [];
  room.eventLog.push({ seq: room.eventSeq, payload: enriched });
  const cap = Number.isFinite(maxEventLog) && maxEventLog > 0 ? maxEventLog : MAX_EVENT_LOG;
  if (room.eventLog.length > cap) {
    room.eventLog.splice(0, room.eventLog.length - cap);
  }
  room.lastEventAt = Date.now();
  return enriched;
}

/**
 * @param {object} room
 * @param {(room: object) => void} sendRoomState
 */
export function ensureRoomStateHeartbeat(room, sendRoomState) {
  if (!room || room._roomStateTimer || typeof sendRoomState !== 'function') return;
  room._roomStateTimer = setInterval(() => {
    sendRoomState(room);
  }, ROOM_STATE_HEARTBEAT_INTERVAL_MS);
  if (typeof room._roomStateTimer.unref === 'function') room._roomStateTimer.unref();
}

/**
 * @param {object} room
 */
export function stopRoomStateHeartbeat(room) {
  if (!room?._roomStateTimer) return;
  clearInterval(room._roomStateTimer);
  room._roomStateTimer = null;
}

/**
 * @param {import('ws').WebSocket} ws
 */
export function cancelWsReplayBatch(ws) {
  if (!ws?._replayBatchTimer) return;
  clearTimeout(ws._replayBatchTimer);
  ws._replayBatchTimer = null;
}

/**
 * @param {object} room
 * @param {import('ws').WebSocket} ws
 */
export function scheduleEventLogReplay(room, ws) {
  if (!room || !ws) return;
  cancelWsReplayBatch(ws);
  const entries = Array.isArray(room.eventLog) ? room.eventLog : [];
  if (entries.length === 0) return;
  scheduleSdkWsEventLogReplay({
    entries,
    cancelTimer: () => cancelWsReplayBatch(ws),
    send: (payload) => {
      if (ws.readyState !== 1) {
        cancelWsReplayBatch(ws);
        return;
      }
      ws.send(JSON.stringify(payload));
    },
    setTimer: (fn, delayMs) => {
      if (ws.readyState !== 1) {
        cancelWsReplayBatch(ws);
        return;
      }
      ws._replayBatchTimer = setTimeout(fn, delayMs);
    },
  });
}

/**
 * @param {object} room
 */
export function abortRoomController(room) {
  const controller = room?.abortController;
  if (!controller || typeof controller.abort !== 'function') return;
  try {
    controller.abort();
  } catch (err) {
    console.warn('[room-kernel] abort failed:', err?.message || err);
  }
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {{ eventStreamId?: string, roomEventSeq?: number, harness: string }} source
 * @returns {{ rec: object, flushNow: boolean } | null}
 */
export function mapWsPayloadToHistoryRecord(type, payload, source) {
  if (type === 'sdkEvent' && payload.event && typeof payload.event === 'object') {
    return { rec: { kind: 'sdk', event: payload.event, ...source }, flushNow: false };
  }
  if (type === 'sdkRunFinished') {
    const status = typeof payload.status === 'string' ? payload.status : '';
    return { rec: { kind: 'meta', variant: 'runFinished', payload: status, ...source }, flushNow: true };
  }
  if (type === 'sdkError') {
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) return null;
    return { rec: { kind: 'meta', variant: 'error', payload: message, ...source }, flushNow: true };
  }
  if (type === 'sdkQueueRemoved') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text) return null;
    return { rec: { kind: 'meta', variant: 'queueRemoved', payload: text, ...source }, flushNow: true };
  }
  if (type === 'sdkMode') {
    const mode = payload.mode === 'plan' || payload.mode === 'agent' || payload.mode === 'ask'
      ? payload.mode
      : '';
    if (!mode) return null;
    return { rec: { kind: 'meta', variant: 'mode', payload: mode, ...source }, flushNow: true };
  }
  if (type === 'sdkPlanGuard') {
    const toolName = typeof payload.toolName === 'string' ? payload.toolName.trim() : '';
    if (!toolName) return null;
    return { rec: { kind: 'meta', variant: 'planGuard', payload: toolName, ...source }, flushNow: true };
  }
  return null;
}

/**
 * @param {AgentRoomKernelOptions} options
 */
export function createAgentRoomKernel(options) {
  const transport = String(options?.transport || '').trim();
  if (!transport) throw new TypeError('createAgentRoomKernel requires transport');
  const logLabel = options.logLabel || `${transport}-ws`;
  const goneMessage = options.goneMessage || `${transport} chat not found for this session.`;
  const rooms = options.rooms instanceof Map ? options.rooms : new Map();
  const graceMs = Number.isFinite(options.graceMs) && options.graceMs >= 0
    ? options.graceMs
    : ROOM_EMPTY_GRACE_MS;
  const maxEventLog = Number.isFinite(options.maxEventLog) && options.maxEventLog > 0
    ? options.maxEventLog
    : MAX_EVENT_LOG;
  const persistHistory = typeof options.persistHistory === 'function'
    ? options.persistHistory
    : (room, recs) => appendChatHistoryEvents(room.chatId, room.sessionKey, recs);
  const abortRoom = typeof options.abortRoom === 'function' ? options.abortRoom : abortRoomController;
  const afterBroadcast = typeof options.afterBroadcast === 'function' ? options.afterBroadcast : null;

  function flushPersistBuffer(room) {
    if (!room?.chatId || !room?.sessionKey) return;
    if (room._persistTimer) {
      clearTimeout(room._persistTimer);
      room._persistTimer = null;
    }
    const buf = Array.isArray(room._persistBuf) ? room._persistBuf : [];
    if (buf.length === 0) return;
    room._persistBuf = [];
    try {
      persistHistory(room, buf);
    } catch (err) {
      console.warn(`[${logLabel}] history persist failed:`, err?.message || err);
    }
  }

  function persistRoomEvent(room, rec, flushNow = false) {
    if (!room?.chatId || !room?.sessionKey) return;
    if (!Array.isArray(room._persistBuf)) room._persistBuf = [];
    room._persistBuf.push({ rec: { ...rec, createdAt: new Date().toISOString() } });
    if (flushNow) {
      flushPersistBuffer(room);
      return;
    }
    if (room._persistTimer) return;
    room._persistTimer = setTimeout(() => {
      room._persistTimer = null;
      flushPersistBuffer(room);
    }, ROOM_PERSIST_FLUSH_MS);
  }

  function persistRoomEventFromPayload(room, payload) {
    if (!payload || typeof payload !== 'object') return;
    noteHarnessWsPayloadForPlanSync(room, payload);
    const type = typeof payload.type === 'string' ? payload.type : '';
    const roomEventSeq = Number(payload.roomEventSeq);
    const source =
      Number.isSafeInteger(roomEventSeq) && roomEventSeq > 0
        ? { eventStreamId: room.eventStreamId, roomEventSeq, harness: transport }
        : { harness: transport };
    const mapped = mapWsPayloadToHistoryRecord(type, payload, source);
    if (!mapped) return;
    persistRoomEvent(room, mapped.rec, mapped.flushNow);
  }

  function broadcastRoom(room, payload, broadcastOptions = {}) {
    const outgoing = broadcastOptions.log === false ? payload : pushRoomEvent(room, payload, maxEventLog);
    if (afterBroadcast) afterBroadcast(room, outgoing);
    broadcastToRoomClients(room, outgoing);
    persistRoomEventFromPayload(room, outgoing);
  }

  function sendRoomState(room) {
    if (!room) return;
    broadcastToRoomClients(room, buildSdkRoomStatePayload({ ...room, transport }), { priority: 'normal' });
  }

  function clearShutdownTimer(room) {
    if (!room?._shutdownTimer) return;
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }

  function scheduleRoomShutdown(sessionKey) {
    const room = rooms.get(sessionKey);
    if (!room) return;
    clearShutdownTimer(room);
    room._shutdownTimer = setTimeout(() => {
      const current = rooms.get(sessionKey);
      if (!current) return;
      current._shutdownTimer = null;
      if (current.clients.size > 0 || current.busy || current.serverHold) {
        scheduleRoomShutdown(sessionKey);
        return;
      }
      stopRoomStateHeartbeat(current);
      flushPersistBuffer(current);
      abortRoom(current);
      void disposeMcpContext({
        sessionId: sessionKey,
        chatId: current.chatId,
        workspaceFolder: current.cwd,
      });
      rooms.delete(sessionKey);
    }, graceMs);
  }

  function disposeRoom(sessionKey) {
    const room = rooms.get(sessionKey);
    if (!room) return;
    clearShutdownTimer(room);
    stopRoomStateHeartbeat(room);
    abortRoom(room);
    void disposeMcpContext({
      sessionId: sessionKey,
      chatId: room.chatId,
      workspaceFolder: room.cwd,
    });
    notifySdkClientsChatGone(room.clients, goneMessage);
    flushPersistBuffer(room);
    rooms.delete(sessionKey);
  }

  /**
   * @param {{ sessionKey: string, chatId?: string }} fields
   */
  function createRoomState(fields) {
    return {
      clients: new Set(),
      transport,
      busy: false,
      eventStreamId: randomUUID(),
      eventSeq: 0,
      eventLog: [],
      pendingPrompts: [],
      _persistBuf: [],
      _persistTimer: null,
      ...fields,
    };
  }

  function attachClient(room, ws) {
    if (!room || !ws) return;
    clearShutdownTimer(room);
    room.clients.add(ws);
    ensureRoomStateHeartbeat(room, sendRoomState);
  }

  function detachClient(room, ws, sessionKey) {
    if (!room || !ws) return;
    room.clients.delete(ws);
    cancelWsReplayBatch(ws);
    if (room.clients.size === 0) scheduleRoomShutdown(sessionKey);
  }

  return {
    rooms,
    transport,
    broadcastToRoomClients,
    pushRoomEvent: (room, payload) => pushRoomEvent(room, payload, maxEventLog),
    broadcastRoom,
    persistRoomEvent,
    persistRoomEventFromPayload,
    flushPersistBuffer,
    sendRoomState,
    scheduleRoomShutdown,
    disposeRoom,
    clearShutdownTimer,
    createRoomState,
    attachClient,
    detachClient,
    scheduleEventLogReplay,
    cancelWsReplayBatch,
  };
}
