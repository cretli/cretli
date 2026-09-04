/**
 * WebSocket rooms for the Qwen Code SDK harness — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import {
  getChatByCursorSessionId,
  setChatQwenSessionId,
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
import { createQwenEventNormalizer } from '../agent-harness/qwen-event-normalizer.js';
import { isQwenChat } from '../agent-transport.js';
import {
  buildSdkRoomStatePayload,
  ROOM_STATE_HEARTBEAT_INTERVAL_MS,
} from '../sdk/sdk-room-state.js';
import {
  isPlanModeMutatingSdkEvent,
  PLAN_GUARD_USER_MESSAGE,
} from '../sdk/sdk-plan-guard.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { buildQwenProcessEnv, getEffectiveQwenApiKey } from './qwen-api-key.js';
import { resolveQwenCli } from './qwen-cli.js';
import { loadQwenSdk } from './qwen-sdk.js';
import { resolveDefaultQwenModel, resolveQwenRunModel } from './qwen-models.js';
import {
  createQwenCanUseTool,
  QWEN_CAN_USE_TOOL_TIMEOUT_MS,
} from './qwen-question.js';
import {
  formatQwenApiErrorMessage,
  isFatalQwenApiError,
  QWEN_API_ERROR_WATCH_MS,
  readNewQwenApiErrorsFromJsonl,
  readQwenJsonlSize,
  resolveQwenApiErrorCode,
  resolveQwenSessionJsonlPath,
} from './qwen-api-error.js';

const qwenRooms = new Map();
const ROOM_EMPTY_GRACE_MS = 90000;
const MAX_EVENT_LOG = 1200;

/**
 * @param {string} [value]
 * @returns {boolean}
 */
function isResumableQwenSessionId(value) {
  const id = String(value || '').trim();
  if (!id) return false;
  return id.toLowerCase() !== 'current';
}

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
    console.warn('[qwen-ws] history persist failed:', err?.message || err);
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
      ? { eventStreamId: room.eventStreamId, roomEventSeq, harness: 'qwen' }
      : { harness: 'qwen' };
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
function sendQwenRoomState(room) {
  if (!room) return;
  broadcastToRoomClients(room, buildSdkRoomStatePayload(room), { priority: 'normal' });
}

/**
 * @param {any} room
 */
function ensureRoomStateHeartbeat(room) {
  if (!room || room._roomStateTimer) return;
  room._roomStateTimer = setInterval(() => {
    sendQwenRoomState(room);
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
 * @param {any} room
 * @returns {Promise<void>}
 */
function ensureQwenQuestionState(room) {
  if (!(room._pendingOpenCodeQuestions instanceof Map)) {
    room._pendingOpenCodeQuestions = new Map();
  }
  if (!(room._qwenQuestionWaiters instanceof Map)) {
    room._qwenQuestionWaiters = new Map();
  }
}

/**
 * @param {any} room
 * @param {string} requestId
 * @param {{ answers?: Array<Array<string>>, reject?: boolean, reason?: string }} payload
 * @returns {boolean}
 */
function resolveQwenQuestion(room, requestId, payload) {
  if (!room || !requestId) return false;
  ensureQwenQuestionState(room);
  const waiter = room._qwenQuestionWaiters.get(requestId);
  room._pendingOpenCodeQuestions.delete(requestId);
  room._qwenQuestionWaiters.delete(requestId);
  if (typeof waiter !== 'function') return false;
  waiter(payload);
  broadcastRoom(room, {
    type: 'opencodeQuestionResolved',
    requestId,
  }, { log: false });
  sendQwenRoomState(room);
  return true;
}

/**
 * @param {any} room
 * @param {string} [reason]
 */
function rejectPendingQwenQuestions(room, reason = 'aborted') {
  if (!room) return;
  ensureQwenQuestionState(room);
  const requestIds = [...room._qwenQuestionWaiters.keys()];
  for (const requestId of requestIds) {
    resolveQwenQuestion(room, requestId, { reject: true, reason });
  }
}

/**
 * @param {any} room
 * @returns {(toolName: string, input: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<{
 *   behavior: 'allow' | 'deny',
 *   updatedInput?: Record<string, unknown>,
 *   message?: string,
 * }>}
 */
function createRoomQwenCanUseTool(room) {
  return createQwenCanUseTool({
    generateId: () => randomUUID(),
    emitQuestion: (event) => {
      const requestId = typeof event.requestId === 'string' ? event.requestId : '';
      if (!requestId) return;
      ensureQwenQuestionState(room);
      room._pendingOpenCodeQuestions.set(requestId, event);
      broadcastRoom(room, { type: 'sdkEvent', event });
      sendQwenRoomState(room);
    },
    waitForReply: (requestId, options = {}) => new Promise((resolve) => {
      ensureQwenQuestionState(room);
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        room._qwenQuestionWaiters.delete(requestId);
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        resolve(payload);
      };
      const onAbort = () => {
        resolveQwenQuestion(room, requestId, { reject: true, reason: 'aborted' });
      };
      room._qwenQuestionWaiters.set(requestId, finish);
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    }),
  });
}

/**
 * @param {any} room
 * @returns {Promise<void>}
 */
async function interruptActiveQuery(room) {
  rejectPendingQwenQuestions(room, 'cancelled');
  const abort = room?._abortController;
  if (abort && typeof abort.abort === 'function') {
    try {
      abort.abort();
    } catch {
      // ignore abort failures
    }
  }
  const query = room?._activeQuery;
  if (query && typeof query.interrupt === 'function') {
    try {
      await query.interrupt();
    } catch {
      // ignore interrupt failures
    }
  }
  if (query && typeof query.close === 'function') {
    try {
      await query.close();
    } catch {
      // ignore close failures
    }
  }
  room._activeQuery = null;
  room._abortController = null;
}

/**
 * @param {any} room
 */
function stopQwenApiErrorWatch(room) {
  if (!room?._qwenApiErrorTimer) return;
  clearInterval(room._qwenApiErrorTimer);
  room._qwenApiErrorTimer = null;
}

/**
 * Surfaces a Qwen API failure in the chat and aborts the run when it cannot recover.
 *
 * @param {any} room
 * @param {{ message?: string, errorType?: string, statusCode?: number | null }} rawError
 * @returns {boolean}
 */
function applyQwenApiError(room, rawError) {
  if (!room || !rawError) return false;
  const message = formatQwenApiErrorMessage(rawError);
  if (!message) return false;
  if (room._qwenLastApiErrorMessage === message) return false;
  const code = resolveQwenApiErrorCode(rawError);
  const fatal = isFatalQwenApiError(rawError);
  room._qwenApiErrorApplied = true;
  room._qwenLastApiErrorMessage = message;
  room._lastResult = {
    kind: 'result',
    status: 'error',
    errorMessage: message,
  };
  if (fatal) {
    room._qwenFatalApiError = { code, displayMessage: message };
  }
  broadcastRoom(room, {
    type: 'sdkError',
    code,
    message,
  });
  if (fatal) void interruptActiveQuery(room);
  return true;
}

/**
 * @param {any} room
 */
function startQwenApiErrorWatch(room) {
  stopQwenApiErrorWatch(room);
  if (!room) return;
  const jsonlState = { offset: 0, primed: false, seenMissing: false };
  const poll = () => {
    if (!room.busy || room._qwenFatalApiError) {
      stopQwenApiErrorWatch(room);
      return;
    }
    const filePath = resolveQwenSessionJsonlPath(room.cwd, room.qwenSessionId);
    if (!filePath) return;
    const size = readQwenJsonlSize(filePath);
    if (size <= 0) {
      jsonlState.seenMissing = true;
      return;
    }
    if (!jsonlState.primed) {
      jsonlState.offset = jsonlState.seenMissing ? 0 : size;
      jsonlState.primed = true;
      if (jsonlState.offset === size) return;
    }
    const errors = readNewQwenApiErrorsFromJsonl(filePath, jsonlState);
    for (const error of errors) {
      applyQwenApiError(room, error);
      if (room._qwenFatalApiError) break;
    }
  };
  room._qwenApiErrorTimer = setInterval(poll, QWEN_API_ERROR_WATCH_MS);
  if (typeof room._qwenApiErrorTimer.unref === 'function') {
    room._qwenApiErrorTimer.unref();
  }
  poll();
}

/**
 * @param {string} sessionKey
 */
function scheduleRoomShutdown(sessionKey) {
  const room = qwenRooms.get(sessionKey);
  if (!room) return;
  if (room._shutdownTimer) clearTimeout(room._shutdownTimer);
  room._shutdownTimer = setTimeout(() => {
    const current = qwenRooms.get(sessionKey);
    if (!current) return;
    current._shutdownTimer = null;
    if (current.clients.size > 0 || current.busy) {
      scheduleRoomShutdown(sessionKey);
      return;
    }
    stopRoomStateHeartbeat(current);
    stopQwenApiErrorWatch(current);
    flushPersistBuffer(current);
    void interruptActiveQuery(current);
    qwenRooms.delete(sessionKey);
  }, ROOM_EMPTY_GRACE_MS);
}

/**
 * @param {string} sessionKey
 */
export function disposeQwenRoom(sessionKey) {
  const room = qwenRooms.get(sessionKey);
  if (!room) return;
  if (room._shutdownTimer) clearTimeout(room._shutdownTimer);
  stopRoomStateHeartbeat(room);
  stopQwenApiErrorWatch(room);
  room.cancelled = true;
  void interruptActiveQuery(room);
  notifySdkClientsChatGone(room.clients, 'Qwen chat not found for this session.');
  flushPersistBuffer(room);
  qwenRooms.delete(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {string} model
 */
export function syncQwenRoomModelFromChat(sessionKey, model) {
  const room = qwenRooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (nextModel && nextModel !== room.modelId) {
    void interruptActiveQuery(room);
    room.modelId = nextModel;
  }
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
  void interruptActiveQuery(room);
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    message: PLAN_GUARD_USER_MESSAGE,
    toolName: typeof event.name === 'string' ? event.name : '',
  });
  return true;
}

/**
 * @param {any} room
 * @param {unknown} message
 */
function handleNormalizedMessage(room, message) {
  if (!room._qwenNormalizer || typeof room._qwenNormalizer.normalize !== 'function') {
    room._qwenNormalizer = createQwenEventNormalizer();
  }
  const items = room._qwenNormalizer.normalize(message);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'session' && isResumableQwenSessionId(item.sessionId)) {
      room.qwenSessionId = item.sessionId;
      if (room.chatId) setChatQwenSessionId(room.chatId, item.sessionId);
      continue;
    }
    if (item.kind === 'api_error') {
      applyQwenApiError(room, item);
      continue;
    }
    if (item.kind === 'result') {
      room._lastResult = item;
      if (isResumableQwenSessionId(item.sessionId)) {
        room.qwenSessionId = item.sessionId;
        if (room.chatId) setChatQwenSessionId(room.chatId, item.sessionId);
      }
      if (item.status === 'error' && item.errorMessage) {
        const probe = {
          message: String(item.errorMessage),
          errorType: 'result',
          statusCode: null,
        };
        if (isFatalQwenApiError(probe) || resolveQwenApiErrorCode(probe) !== 'qwen_error') {
          applyQwenApiError(room, probe);
        }
      }
      continue;
    }
    if (applyPlanGuardIfNeeded(item, room)) return;
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}

/**
 * @param {any} room
 * @param {object} query
 */
function persistQuerySessionId(room, query) {
  if (!query || typeof query.getSessionId !== 'function') return;
  const sessionId = String(query.getSessionId() || '').trim();
  if (!isResumableQwenSessionId(sessionId)) return;
  room.qwenSessionId = sessionId;
  if (room.chatId) setChatQwenSessionId(room.chatId, sessionId);
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string }} deps
 */
export async function handleQwenAgentWebSocket(ws, sessionKey, deps) {
  if (!getEffectiveQwenApiKey()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_api_key',
        message: 'Missing Qwen Cloud API key (QWEN_API_KEY or Settings → Harness → Qwen).',
      }));
    }
    ws.close();
    return;
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    sendSdkChatNotFoundAndClose(ws, 'Qwen chat not found for this session.');
    return;
  }
  if (!isQwenChat(chat)) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'invalid_session',
        message: 'Qwen chat not found for this session.',
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
  let room = qwenRooms.get(sessionKey);
  if (!room) {
    room = {
      transport: 'qwen',
      clients: new Set(),
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || resolveDefaultQwenModel(),
      sdkMode: normalizeSdkMode(chat.sdkMode),
      busy: false,
      cancelled: false,
      pendingPrompts: [],
      qwenSessionId: typeof chat.qwenSessionId === 'string' ? chat.qwenSessionId : '',
      eventStreamId: randomUUID(),
      eventSeq: 0,
      eventLog: [],
      currentRun: null,
      _persistBuf: [],
      _persistTimer: null,
      _activeQuery: null,
      _abortController: null,
      _lastResult: null,
      _planGuardTriggered: false,
      _qwenNormalizer: createQwenEventNormalizer(),
      _pendingOpenCodeQuestions: new Map(),
      _qwenQuestionWaiters: new Map(),
    };
    qwenRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || resolveDefaultQwenModel();
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (typeof chat.qwenSessionId === 'string' && isResumableQwenSessionId(chat.qwenSessionId)) {
      room.qwenSessionId = chat.qwenSessionId.trim();
    }
    ensureQwenQuestionState(room);
  }
  if (room._shutdownTimer) {
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }
  room.clients.add(ws);
  ensureRoomStateHeartbeat(room);
  const hello = buildAgentHelloPayload({
    transport: 'qwen',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: room.pendingPrompts.map((item) => resolveQueuedPromptUiText(item)),
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  sendQwenRoomState(room);
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
    sendQwenRoomState(room);
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
    room._lastResult = null;
    room._qwenApiErrorApplied = false;
    room._qwenLastApiErrorMessage = '';
    room._qwenFatalApiError = null;
    room._qwenNormalizer = createQwenEventNormalizer();
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
    sendQwenRoomState(room);
    startQwenApiErrorWatch(room);
    persistRoomEvent(room, { kind: 'localUser', text: uiText }, true);
    broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(uiText) });
    broadcastRoom(room, {
      type: 'sdkRunProgress',
      runId,
      phase: 'setup',
      transport: 'qwen',
    }, { log: false });
    let status = 'completed';
    let errorMessage = '';
    const abortController = new AbortController();
    room._abortController = abortController;
    try {
      const sdk = await loadQwenSdk();
      if (typeof sdk.query !== 'function') {
        throw new Error('Qwen Code SDK is missing query().');
      }
      const model = resolveQwenRunModel(room.modelId);
      if (model && model !== room.modelId) {
        room.modelId = model;
        if (room.chatId) updateChat(room.chatId, { model });
      }
      /** @type {Record<string, unknown>} */
      const options = {
        cwd: room.cwd,
        model,
        permissionMode: room.sdkMode === 'plan' ? 'plan' : 'yolo',
        env: buildQwenProcessEnv({ model }),
        abortController,
        includePartialMessages: true,
        authType: 'openai',
        canUseTool: createRoomQwenCanUseTool(room),
        timeout: {
          canUseTool: QWEN_CAN_USE_TOOL_TIMEOUT_MS,
        },
      };
      const cliPath = resolveQwenCli();
      if (cliPath) options.pathToQwenExecutable = cliPath;
      if (isResumableQwenSessionId(room.qwenSessionId)) options.resume = room.qwenSessionId;
      const query = sdk.query({ prompt: trimmed, options });
      room._activeQuery = query;
      persistQuerySessionId(room, query);
      broadcastRoom(room, {
        type: 'sdkRunProgress',
        runId,
        phase: 'stream',
        transport: 'qwen',
      }, { log: false });
      for await (const message of query) {
        if (room.cancelled) {
          await interruptActiveQuery(room);
          break;
        }
        persistQuerySessionId(room, query);
        handleNormalizedMessage(room, message);
      }
      persistQuerySessionId(room, query);
      if (room._qwenFatalApiError) {
        status = 'error';
        errorMessage = room._qwenFatalApiError.displayMessage;
      } else if (room._planGuardTriggered) {
        status = 'plan_guard_cancelled';
        errorMessage = PLAN_GUARD_USER_MESSAGE;
      } else if (room.cancelled) {
        status = 'cancelled';
      } else if (room._lastResult && room._lastResult.status === 'error') {
        status = 'error';
        errorMessage = String(room._lastResult.errorMessage || room._lastResult.resultText || 'Qwen run failed');
      }
    } catch (err) {
      if (room._qwenFatalApiError) {
        status = 'error';
        errorMessage = room._qwenFatalApiError.displayMessage;
      } else if (room.cancelled || room._planGuardTriggered) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else {
        status = 'error';
        errorMessage = err?.message ? String(err.message) : String(err);
      }
    } finally {
      stopQwenApiErrorWatch(room);
      rejectPendingQwenQuestions(room, 'run_finished');
      room._activeQuery = null;
      room._abortController = null;
      room.busy = false;
      room.currentRun = null;
      broadcastRoom(room, { type: 'sdkBusy', busy: false }, { log: false });
      const finished = {
        type: 'sdkRunFinished',
        runId,
        status,
        lastErrorMessage: errorMessage,
      };
      if (errorMessage && status === 'error') {
        finished.lastErrorCode = room._qwenFatalApiError?.code || 'qwen_error';
      }
      broadcastRoom(room, finished);
      if (errorMessage && status === 'error' && !room._qwenApiErrorApplied) {
        broadcastRoom(room, {
          type: 'sdkError',
          code: finished.lastErrorCode || 'qwen_error',
          message: errorMessage,
        });
      }
      sendQwenRoomState(room);
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
      void interruptActiveQuery(room);
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
      return;
    }
    if (msg.type === 'opencodeQuestionReply' && typeof msg.requestId === 'string') {
      const requestId = msg.requestId.trim();
      if (!requestId) return;
      const resolved = resolveQwenQuestion(room, requestId, {
        answers: Array.isArray(msg.answers) ? msg.answers : [],
        reject: msg.reject === true,
        reason: msg.reject === true ? 'User declined to answer' : '',
      });
      if (!resolved) {
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'qwen_question_error',
          message: 'No pending Qwen question to answer.',
        });
      }
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
export function getQwenRoomDiag(sessionKey) {
  const room = qwenRooms.get(sessionKey);
  if (!room) return null;
  return {
    transport: 'qwen',
    busy: !!room.busy,
    modelId: room.modelId,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    qwenSessionId: room.qwenSessionId || '',
    lastRunId: room.lastRunId || null,
    lastRunStatus: room.lastRunStatus || null,
    queuedCount: Array.isArray(room.pendingPrompts) ? room.pendingPrompts.length : 0,
    pendingQuestions: room._pendingOpenCodeQuestions instanceof Map
      ? room._pendingOpenCodeQuestions.size
      : 0,
  };
}
