/**
 * WebSocket rooms for the DeepSeek Harness SDK — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import {
  getChatByCursorSessionId,
  setChatDeepSeekSessionId,
  updateChat,
} from '../persist/chats-persist.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.js';
import { appendChatHistoryEvents } from '../persist/chat-history-persist.js';
import { buildAgentHelloPayload, scheduleSdkWsEventLogReplay } from '../sdk/sdk-ws-handshake.js';
import {
  notifySdkClientsChatGone,
  sendSdkChatNotFoundAndClose,
} from '../sdk/sdk-ws-chat-gone.js';
import {
  resolveBroadcastPriority,
  shouldSendToClient,
  WS_BACKPRESSURE_THRESHOLD_BYTES,
} from '../sdk/sdk-ws-transport.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { normalizeDeepSeekNotification } from '../agent-harness/deepseek-event-normalizer.js';
import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.js';
import { isDeepSeekChat } from '../agent-transport.js';
import {
  buildSdkRoomStatePayload,
  ROOM_STATE_HEARTBEAT_INTERVAL_MS,
} from '../sdk/sdk-room-state.js';
import {
  isPlanModeMutatingSdkEvent,
  PLAN_GUARD_USER_MESSAGE,
} from '../sdk/sdk-plan-guard.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { getEffectiveDeepSeekApiKey } from './deepseek-api-key.js';
import { isDeepSeekCliFound } from './deepseek-cli.js';
import { loadDeepSeekSdk } from './deepseek-sdk.js';
import { resolveDefaultDeepSeekModel } from './deepseek-models.js';
import { buildDeepSeekHarnessOptions } from './deepseek-harness-options.js';

const deepSeekRooms = new Map();
const ROOM_EMPTY_GRACE_MS = 90000;
const MAX_EVENT_LOG = 1200;
const PLAN_MODE_HINT = 'You are in plan mode. Analyze and propose changes only; do not run mutating tools until the user confirms.';

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
 * @param {Record<string, unknown>} rec
 * @param {boolean} [flushNow]
 */
function persistRoomEvent(room, rec, flushNow = false) {
  if (!room?.chatId || !room?.sessionKey) return;
  if (!Array.isArray(room._persistBuf)) room._persistBuf = [];
  room._persistBuf.push({ rec: { ...rec, createdAt: new Date().toISOString() } });
  if (room._persistTimer) {
    if (flushNow) flushPersistBuffer(room);
    return;
  }
  room._persistTimer = setTimeout(() => {
    room._persistTimer = null;
    flushPersistBuffer(room);
  }, flushNow ? 0 : 2000);
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
    console.warn('[deepseek-ws] history persist failed:', err?.message || err);
  }
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 */
function persistRoomEventFromPayload(room, payload) {
  if (!payload || typeof payload !== 'object') return;
  const type = typeof payload.type === 'string' ? payload.type : '';
  const roomEventSeq = Number(payload.roomEventSeq);
  const source =
    Number.isSafeInteger(roomEventSeq) && roomEventSeq > 0
      ? { eventStreamId: room.eventStreamId, roomEventSeq, harness: 'deepseek' }
      : { harness: 'deepseek' };
  if (type === 'sdkEvent' && payload.event && typeof payload.event === 'object') {
    persistRoomEvent(room, { kind: 'sdk', event: payload.event, ...source });
    return;
  }
  if (type === 'sdkRunFinished') {
    const status = typeof payload.status === 'string' ? payload.status : '';
    persistRoomEvent(room, { kind: 'meta', variant: 'runFinished', payload: status, ...source }, true);
    return;
  }
  if (type !== 'sdkError') return;
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (message) {
    persistRoomEvent(room, { kind: 'meta', variant: 'error', payload: message, ...source }, true);
  }
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 * @param {{ log?: boolean }} [options]
 */
function broadcastRoom(room, payload, options = {}) {
  const outgoing = options.log === false ? payload : pushRoomEvent(room, payload);
  trackSdkRoomRunOutcome(room, outgoing);
  broadcastToRoomClients(room, outgoing);
  persistRoomEventFromPayload(room, outgoing);
}

/**
 * @param {any} room
 */
function sendDeepSeekRoomState(room) {
  if (!room) return;
  broadcastToRoomClients(room, buildSdkRoomStatePayload(room), { priority: 'normal' });
}

/**
 * @param {any} room
 */
function ensureRoomStateHeartbeat(room) {
  if (!room || room._roomStateTimer) return;
  room._roomStateTimer = setInterval(() => {
    sendDeepSeekRoomState(room);
  }, ROOM_STATE_HEARTBEAT_INTERVAL_MS);
  if (typeof room._roomStateTimer.unref === 'function') room._roomStateTimer.unref();
}

/**
 * @param {any} room
 */
function stopRoomStateHeartbeat(room) {
  if (!room?._roomStateTimer) return;
  clearInterval(room._roomStateTimer);
  room._roomStateTimer = null;
}

/**
 * DSH has no mid-turn cancel — Stop closes the runtime subprocess.
 * @param {any} room
 * @returns {Promise<void>}
 */
async function closeRuntime(room) {
  const harness = room?._harness;
  room._harness = null;
  if (!harness || typeof harness.close !== 'function') return;
  try {
    await harness.close();
  } catch {
    // ignore teardown failures
  }
}

/**
 * @param {string} sessionKey
 */
function scheduleRoomShutdown(sessionKey) {
  const room = deepSeekRooms.get(sessionKey);
  if (!room) return;
  if (room._shutdownTimer) clearTimeout(room._shutdownTimer);
  room._shutdownTimer = setTimeout(() => {
    const current = deepSeekRooms.get(sessionKey);
    if (!current) return;
    current._shutdownTimer = null;
    if (current.clients.size > 0 || current.busy) {
      scheduleRoomShutdown(sessionKey);
      return;
    }
    stopRoomStateHeartbeat(current);
    flushPersistBuffer(current);
    void closeRuntime(current);
    deepSeekRooms.delete(sessionKey);
  }, ROOM_EMPTY_GRACE_MS);
}

/**
 * @param {string} sessionKey
 */
export function disposeDeepSeekRoom(sessionKey) {
  const room = deepSeekRooms.get(sessionKey);
  if (!room) return;
  if (room._shutdownTimer) clearTimeout(room._shutdownTimer);
  stopRoomStateHeartbeat(room);
  room.cancelled = true;
  void closeRuntime(room);
  notifySdkClientsChatGone(room.clients, 'DeepSeek chat not found for this session.');
  flushPersistBuffer(room);
  deepSeekRooms.delete(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {string} model
 */
export function syncDeepSeekRoomModelFromChat(sessionKey, model) {
  const room = deepSeekRooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (!nextModel || nextModel === room.modelId) return;
  room.modelId = nextModel;
  void closeRuntime(room);
}

/**
 * @param {Record<string, unknown>} event
 * @param {any} room
 * @returns {boolean}
 */
function applyPlanGuardIfNeeded(event, room) {
  if (room.sdkMode !== 'plan') return false;
  if (!isPlanModeMutatingSdkEvent(event)) return false;
  room.cancelled = true;
  room._planGuardTriggered = true;
  void closeRuntime(room);
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    message: PLAN_GUARD_USER_MESSAGE,
    toolName: typeof event.name === 'string' ? event.name : '',
  });
  return true;
}

/**
 * @param {any} room
 * @param {unknown} notification
 */
function handleNotification(room, notification) {
  const items = normalizeDeepSeekNotification(notification);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'session' && typeof item.sessionId === 'string' && item.sessionId) {
      room.deepseekSessionId = item.sessionId;
      if (room.chatId) setChatDeepSeekSessionId(room.chatId, item.sessionId);
      continue;
    }
    if (item.kind === 'status') {
      if (typeof item.sessionId === 'string' && item.sessionId) {
        room.deepseekSessionId = item.sessionId;
        if (room.chatId) setChatDeepSeekSessionId(room.chatId, item.sessionId);
      }
      continue;
    }
    if (applyPlanGuardIfNeeded(item, room)) return;
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}

/**
 * @param {any} room
 * @returns {Promise<object>}
 */
async function ensureHarness(room) {
  if (room._harness) return room._harness;
  const sdk = await loadDeepSeekSdk();
  const DeepSeekHarness = sdk.DeepSeekHarness;
  if (typeof DeepSeekHarness !== 'function') {
    throw new Error('DeepSeekHarness export is missing from @deepseek-ai/dsh-sdk-client.');
  }
  room._harness = new DeepSeekHarness(buildDeepSeekHarnessOptions({
    cwd: room.cwd,
    model: room.modelId,
  }));
  return room._harness;
}

/**
 * @param {string} text
 * @param {string} mode
 * @returns {string}
 */
function applyPlanHint(text, mode) {
  if (mode !== 'plan') return text;
  if (!resolveHarnessPlanPolicy('deepseek').promptHint) return text;
  return `${PLAN_MODE_HINT}\n\n${text}`;
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string }} deps
 */
export async function handleDeepSeekAgentWebSocket(ws, sessionKey, deps) {
  if (!getEffectiveDeepSeekApiKey()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_api_key',
        message: 'Missing DeepSeek API key (DEEPSEEK_API_KEY or Settings → Harness → DeepSeek).',
      }));
    }
    ws.close();
    return;
  }
  if (!isDeepSeekCliFound()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_cli',
        message: 'DeepSeek Harness CLI not found. Install `@deepseek-ai/dsh` or set DSH_BIN.',
      }));
    }
    ws.close();
    return;
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    sendSdkChatNotFoundAndClose(ws, 'DeepSeek chat not found for this session.');
    return;
  }
  if (!isDeepSeekChat(chat)) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'invalid_session',
        message: 'DeepSeek chat not found for this session.',
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
  let room = deepSeekRooms.get(sessionKey);
  if (!room) {
    room = {
      transport: 'deepseek',
      clients: new Set(),
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || resolveDefaultDeepSeekModel(),
      sdkMode: normalizeSdkMode(chat.sdkMode),
      busy: false,
      cancelled: false,
      pendingPrompts: [],
      deepseekSessionId: typeof chat.deepseekSessionId === 'string' ? chat.deepseekSessionId : '',
      eventStreamId: randomUUID(),
      eventSeq: 0,
      eventLog: [],
      currentRun: null,
      _persistBuf: [],
      _persistTimer: null,
      _harness: null,
      _planGuardTriggered: false,
    };
    deepSeekRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || resolveDefaultDeepSeekModel();
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (typeof chat.deepseekSessionId === 'string' && chat.deepseekSessionId.trim()) {
      room.deepseekSessionId = chat.deepseekSessionId.trim();
    }
  }
  if (room._shutdownTimer) {
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }
  room.clients.add(ws);
  ensureRoomStateHeartbeat(room);
  const hello = buildAgentHelloPayload({
    transport: 'deepseek',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: room.pendingPrompts.map((item) => resolveQueuedPromptUiText(item)),
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  sendDeepSeekRoomState(room);
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
   * @param {string} [displayText]
   */
  function enqueuePrompt(text, modeOverride, displayText = '') {
    const uiText = resolvePromptUiText(text, displayText);
    const item = {
      text,
      mode: normalizeSdkMode(modeOverride || room.sdkMode),
    };
    if (uiText && uiText !== text) item.displayText = uiText;
    room.pendingPrompts.push(item);
    broadcastRoom(room, { type: 'sdkQueued', text: uiText || text }, { log: false });
    sendDeepSeekRoomState(room);
  }

  /**
   * @returns {void}
   */
  function drainQueue() {
    if (room.busy) return;
    const next = room.pendingPrompts.shift();
    if (!next) return;
    void runPrompt(next.text, next.mode, true, next.displayText);
  }

  /**
   * @param {string} text
   * @param {string} [modeOverride]
   * @param {boolean} [fromQueue]
   * @param {string} [displayText]
   */
  async function runPrompt(text, modeOverride, fromQueue = false, displayText = '') {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const uiText = resolvePromptUiText(trimmed, displayText);
    if (room.busy) {
      enqueuePrompt(trimmed, modeOverride, displayText);
      return;
    }
    room.busy = true;
    room.cancelled = false;
    room._planGuardTriggered = false;
    const runId = randomUUID();
    room.currentRun = { id: runId, startedAt: Date.now() };
    const mode = normalizeSdkMode(modeOverride || room.sdkMode);
    room.sdkMode = mode === 'plan' ? 'plan' : 'agent';
    broadcastRoom(room, {
      type: 'sdkPromptStarted',
      runId,
      text: uiText,
      fromQueue: fromQueue === true,
      remaining: room.pendingPrompts.length,
    });
    broadcastRoom(room, { type: 'sdkBusy', busy: true }, { log: false });
    sendDeepSeekRoomState(room);
    persistRoomEvent(room, { kind: 'localUser', text: uiText }, true);
    broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(uiText) });
    broadcastRoom(room, {
      type: 'sdkRunProgress',
      runId,
      phase: 'setup',
      transport: 'deepseek',
    }, { log: false });
    let status = 'completed';
    let errorMessage = '';
    try {
      const harness = await ensureHarness(room);
      broadcastRoom(room, {
        type: 'sdkRunProgress',
        runId,
        phase: 'stream',
        transport: 'deepseek',
      }, { log: false });
      /** @type {{ sessionId?: string, onNotification: (notification: unknown) => void }} */
      const runOptions = {
        onNotification: (notification) => {
          if (room.cancelled) return;
          handleNotification(room, notification);
        },
      };
      if (room.deepseekSessionId) runOptions.sessionId = room.deepseekSessionId;
      const result = await harness.run(applyPlanHint(trimmed, room.sdkMode), runOptions);
      if (result && typeof result.sessionId === 'string' && result.sessionId.trim()) {
        room.deepseekSessionId = result.sessionId.trim();
        if (room.chatId) setChatDeepSeekSessionId(room.chatId, room.deepseekSessionId);
      }
      if (room._planGuardTriggered) {
        status = 'plan_guard_cancelled';
        errorMessage = PLAN_GUARD_USER_MESSAGE;
      } else if (room.cancelled) {
        status = 'cancelled';
      }
    } catch (err) {
      if (room.cancelled || room._planGuardTriggered) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else {
        status = 'error';
        errorMessage = err?.message ? String(err.message) : String(err);
      }
      void closeRuntime(room);
    } finally {
      room.busy = false;
      room.currentRun = null;
      broadcastRoom(room, { type: 'sdkBusy', busy: false }, { log: false });
      const finished = {
        type: 'sdkRunFinished',
        runId,
        status,
        lastErrorMessage: errorMessage,
      };
      if (errorMessage && status === 'error') finished.lastErrorCode = 'deepseek_error';
      broadcastRoom(room, finished);
      if (errorMessage && status === 'error') {
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'deepseek_error',
          message: errorMessage,
        });
      }
      sendDeepSeekRoomState(room);
      flushPersistBuffer(room);
      drainQueue();
    }
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
      void closeRuntime(room);
      return;
    }
    if (msg.type === 'setSdkMode') {
      const nextMode = normalizeSdkMode(msg.mode);
      room.sdkMode = nextMode;
      if (chat.id) updateChat(chat.id, { sdkMode: nextMode });
      broadcastRoom(room, { type: 'sdkMode', mode: nextMode }, { log: false });
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void runPrompt(msg.text, msg.mode, false, readClientDisplayText(msg));
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
export function getDeepSeekRoomDiag(sessionKey) {
  const room = deepSeekRooms.get(sessionKey);
  if (!room) return null;
  return {
    transport: 'deepseek',
    busy: !!room.busy,
    modelId: room.modelId,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    deepseekSessionId: room.deepseekSessionId || '',
    lastRunId: room.lastRunId || null,
    lastRunStatus: room.lastRunStatus || null,
    queuedCount: Array.isArray(room.pendingPrompts) ? room.pendingPrompts.length : 0,
  };
}
