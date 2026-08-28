/**
 * WebSocket rooms for OpenRouter agent harness — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import { getChatByCursorSessionId, updateChat } from '../persist/chats-persist.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import { getEffectiveOpenRouterApiKey } from './openrouter-api-key.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.js';
import { appendChatHistoryEvents } from '../persist/chat-history-persist.js';
import { buildAgentHelloPayload, scheduleSdkWsEventLogReplay } from '../sdk/sdk-ws-handshake.js';
import {
  resolveBroadcastPriority,
  shouldSendToClient,
  WS_BACKPRESSURE_THRESHOLD_BYTES,
} from '../sdk/sdk-ws-transport.js';
import {
  appendUserMessage,
  runOpenRouterAgentLoop,
} from '../agent-harness/openrouter-agent-loop.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import { isOpenRouterChat } from '../agent-transport.js';

const openRouterRooms = new Map();
const ROOM_EMPTY_GRACE_MS = 90000;
const MAX_EVENT_LOG = 1200;
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

/**
 * @param {{ clients: Set<import('ws').WebSocket> }} room
 * @param {Record<string, unknown>} payload
 * @param {{ priority?: 'critical' | 'normal' }} [options]
 */
function broadcastToRoomClients(room, payload, options = {}) {
  const priority = resolveBroadcastPriority(payload, options.priority);
  const serialized = JSON.stringify(payload);
  for (const client of room.clients) {
    if (!shouldSendToClient(client, priority, WS_BACKPRESSURE_THRESHOLD_BYTES)) continue;
    try {
      client.send(serialized);
    } catch {
      // ignore send failures
    }
  }
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 */
function pushRoomEvent(room, payload) {
  if (!room) return payload;
  room.eventSeq = (Number(room.eventSeq) || 0) + 1;
  const enriched = {
    ...payload,
    roomEventSeq: room.eventSeq,
    eventStreamId: room.eventStreamId,
  };
  if (!Array.isArray(room.eventLog)) room.eventLog = [];
  room.eventLog.push({ seq: room.eventSeq, payload: enriched });
  if (room.eventLog.length > MAX_EVENT_LOG) {
    room.eventLog.splice(0, room.eventLog.length - MAX_EVENT_LOG);
  }
  room.lastEventAt = Date.now();
  return enriched;
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 * @param {{ log?: boolean }} [options]
 */
function broadcastRoom(room, payload, options = {}) {
  const outgoing = options.log === false ? payload : pushRoomEvent(room, payload);
  broadcastToRoomClients(room, outgoing);
  persistRoomEventFromPayload(room, outgoing);
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} rec
 * @param {boolean} [flushNow]
 */
function persistRoomEvent(room, rec, flushNow = false) {
  if (!room?.chatId || !room?.sessionKey) return;
  if (!Array.isArray(room._persistBuf)) room._persistBuf = [];
  const createdAt = new Date().toISOString();
  room._persistBuf.push({ rec: { ...rec, createdAt } });
  schedulePersistFlush(room, flushNow);
}

/**
 * @param {any} room
 * @param {number} [delayMs]
 */
function schedulePersistFlush(room, delayMs = 2000) {
  if (!room) return;
  if (room._persistTimer) return;
  room._persistTimer = setTimeout(() => {
    room._persistTimer = null;
    flushPersistBuffer(room);
  }, delayMs);
}

/**
 * @param {any} room
 */
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
    appendChatHistoryEvents(room.chatId, room.sessionKey, buf);
  } catch (err) {
    console.warn('[openrouter-ws] history persist failed:', err?.message || err);
  }
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 */
function persistRoomEventFromPayload(room, payload) {
  if (!payload || typeof payload !== 'object') return;
  const t = typeof payload.type === 'string' ? payload.type : '';
  const roomEventSeq = Number(payload.roomEventSeq);
  const source =
    Number.isSafeInteger(roomEventSeq) && roomEventSeq > 0
      ? { eventStreamId: room.eventStreamId, roomEventSeq, harness: 'openrouter' }
      : { harness: 'openrouter' };
  if (t === 'sdkEvent' && payload.event && typeof payload.event === 'object') {
    persistRoomEvent(room, { kind: 'sdk', event: payload.event, ...source });
  } else if (t === 'sdkRunFinished') {
    const status = typeof payload.status === 'string' ? payload.status : '';
    persistRoomEvent(room, { kind: 'meta', variant: 'runFinished', payload: status, ...source }, true);
  } else if (t === 'sdkError') {
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (message) {
      persistRoomEvent(room, { kind: 'meta', variant: 'error', payload: message, ...source }, true);
    }
  }
}

/**
 * @param {string} sessionKey
 */
function scheduleRoomShutdown(sessionKey) {
  const room = openRouterRooms.get(sessionKey);
  if (!room) return;
  if (room._shutdownTimer) clearTimeout(room._shutdownTimer);
  room._shutdownTimer = setTimeout(() => {
    const current = openRouterRooms.get(sessionKey);
    if (!current) return;
    current._shutdownTimer = null;
    if (current.clients.size > 0 || current.busy) {
      scheduleRoomShutdown(sessionKey);
      return;
    }
    flushPersistBuffer(current);
    if (current.abortController) {
      try {
        current.abortController.abort();
      } catch {
        // ignore
      }
    }
    openRouterRooms.delete(sessionKey);
  }, ROOM_EMPTY_GRACE_MS);
}

/**
 * @param {string} sessionKey
 */
export function disposeOpenRouterRoom(sessionKey) {
  const room = openRouterRooms.get(sessionKey);
  if (!room) return;
  if (room._shutdownTimer) clearTimeout(room._shutdownTimer);
  if (room.abortController) {
    try {
      room.abortController.abort();
    } catch {
      // ignore
    }
  }
  for (const client of room.clients) {
    try {
      if (client.readyState === 1) client.close();
    } catch {
      // ignore
    }
  }
  flushPersistBuffer(room);
  openRouterRooms.delete(sessionKey);
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string }} deps
 */
export async function handleOpenRouterAgentWebSocket(ws, sessionKey, deps) {
  if (!getEffectiveOpenRouterApiKey()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_api_key',
        message: 'Missing OpenRouter API key (OPENROUTER_API_KEY or Settings).',
      }));
    }
    ws.close();
    return;
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat || !isOpenRouterChat(chat)) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'invalid_session',
        message: 'OpenRouter chat not found for this session.',
      }));
    }
    ws.close();
    return;
  }
  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'no_cwd',
        message: 'Missing workspace directory.',
      }));
    }
    ws.close();
    return;
  }
  let room = openRouterRooms.get(sessionKey);
  if (!room) {
    room = {
      clients: new Set(),
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || DEFAULT_OPENROUTER_MODEL,
      sdkMode: normalizeSdkMode(chat.sdkMode),
      busy: false,
      cancelled: false,
      abortController: null,
      conversationMessages: [],
      eventStreamId: randomUUID(),
      eventSeq: 0,
      eventLog: [],
      _persistBuf: [],
      _persistTimer: null,
    };
    openRouterRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || DEFAULT_OPENROUTER_MODEL;
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
  }
  if (room._shutdownTimer) {
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }
  room.clients.add(ws);

  const hello = buildAgentHelloPayload({
    transport: 'openrouter',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: [],
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));

  const replayEntries = Array.isArray(room.eventLog) ? room.eventLog : [];
  if (replayEntries.length > 0) {
    scheduleSdkWsEventLogReplay({
      send: (payload) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(payload));
      },
      entries: replayEntries,
    });
  }

  /**
   * @param {string} text
   * @param {string} [modeOverride]
   */
  async function runPrompt(text, modeOverride) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (room.busy) {
      broadcastRoom(room, { type: 'sdkQueued', text: trimmed });
      return;
    }
    room.busy = true;
    room.cancelled = false;
    room.abortController = new AbortController();
    const mode = normalizeSdkMode(modeOverride || room.sdkMode);
    if (mode === 'plan') room.sdkMode = 'plan';
    else room.sdkMode = 'agent';
    broadcastRoom(room, { type: 'sdkPromptStarted' });
    broadcastRoom(room, { type: 'sdkBusy', busy: true });
    persistRoomEvent(room, { kind: 'localUser', text: trimmed }, true);
    broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(trimmed) });
    room.conversationMessages = appendUserMessage(room.conversationMessages, trimmed);
    const model = String(room.modelId || chat.model || DEFAULT_OPENROUTER_MODEL).trim() || DEFAULT_OPENROUTER_MODEL;
    const result = await runOpenRouterAgentLoop({
      model,
      cwd: room.cwd,
      mode: room.sdkMode === 'plan' ? 'plan' : 'agent',
      messages: room.conversationMessages,
      signal: room.abortController.signal,
      callbacks: {
        onEvent: (event) => {
          broadcastRoom(room, { type: 'sdkEvent', event });
        },
        onFinished: (status, detail) => {
          room.busy = false;
          room.abortController = null;
          broadcastRoom(room, { type: 'sdkBusy', busy: false });
          broadcastRoom(room, {
            type: 'sdkRunFinished',
            status,
            lastErrorMessage: detail || '',
          }, { log: true });
          if (detail && status === 'error') {
            broadcastRoom(room, {
              type: 'sdkError',
              code: 'openrouter_error',
              message: detail,
            });
          }
        },
        isCancelled: () => room.cancelled,
      },
    });
    if (result.messages) room.conversationMessages = result.messages;
    flushPersistBuffer(room);
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (msg.type === 'cancel') {
      room.cancelled = true;
      if (room.abortController) {
        try {
          room.abortController.abort();
        } catch {
          // ignore
        }
      }
      return;
    }
    if (msg.type === 'setSdkMode') {
      const mode = normalizeSdkMode(msg.mode);
      room.sdkMode = mode;
      if (chat.id) updateChat(chat.id, { sdkMode: mode });
      broadcastRoom(room, { type: 'sdkMode', mode }, { log: false });
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void runPrompt(msg.text, msg.mode);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (room.clients.size === 0) scheduleRoomShutdown(sessionKey);
  });
}

/**
 * @param {string} sessionKey
 * @returns {Record<string, unknown> | null}
 */
export function getOpenRouterRoomDiag(sessionKey) {
  const room = openRouterRooms.get(sessionKey);
  if (!room) return null;
  return {
    transport: 'openrouter',
    busy: !!room.busy,
    modelId: room.modelId,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    messageCount: Array.isArray(room.conversationMessages) ? room.conversationMessages.length : 0,
  };
}
