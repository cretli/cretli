/**
 * WebSocket rooms for the Codex SDK — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import {
  getChatByCursorSessionId,
  setChatCodexThreadId,
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
import { normalizeCodexThreadEvent } from '../agent-harness/codex-event-normalizer.js';
import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.js';
import { isCodexChat } from '../agent-transport.js';
import {
  buildSdkRoomStatePayload,
  ROOM_STATE_HEARTBEAT_INTERVAL_MS,
} from '../sdk/sdk-room-state.js';
import {
  isPlanModeMutatingSdkEvent,
  PLAN_GUARD_USER_MESSAGE,
} from '../sdk/sdk-plan-guard.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { hasCodexCredentials } from './codex-credentials.js';
import { isCodexCliFound, getCodexCliMissingHint } from './codex-cli.js';
import { loadCodexSdk } from './codex-sdk.js';
import { resolveDefaultCodexModel } from './codex-models.js';
import { buildCodexClientOptions } from './codex-thread-options.js';

const codexRooms = new Map();
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
    console.warn('[codex-ws] history persist failed:', err?.message || err);
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
      ? { eventStreamId: room.eventStreamId, roomEventSeq, harness: 'codex' }
      : { harness: 'codex' };
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
function sendCodexRoomState(room) {
  if (!room) return;
  broadcastToRoomClients(room, buildSdkRoomStatePayload(room), { priority: 'normal' });
}

/**
 * @param {any} room
 */
function ensureRoomStateHeartbeat(room) {
  if (!room || room._roomStateTimer) return;
  room._roomStateTimer = setInterval(() => {
    sendCodexRoomState(room);
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
 * Abort the in-flight `codex exec` turn.
 * @param {any} room
 */
function abortCurrentTurn(room) {
  const abort = room?._abort;
  room._abort = null;
  if (!abort || typeof abort.abort !== 'function') return;
  try {
    abort.abort();
  } catch {
    // ignore abort failures
  }
}

/**
 * @param {string} sessionKey
 */
function scheduleRoomShutdown(sessionKey) {
  const room = codexRooms.get(sessionKey);
  if (!room) return;
  if (room._shutdownTimer) clearTimeout(room._shutdownTimer);
  room._shutdownTimer = setTimeout(() => {
    const current = codexRooms.get(sessionKey);
    if (!current) return;
    current._shutdownTimer = null;
    if (current.clients.size > 0 || current.busy) {
      scheduleRoomShutdown(sessionKey);
      return;
    }
    stopRoomStateHeartbeat(current);
    flushPersistBuffer(current);
    abortCurrentTurn(current);
    codexRooms.delete(sessionKey);
  }, ROOM_EMPTY_GRACE_MS);
}

/**
 * @param {string} sessionKey
 */
export function disposeCodexRoom(sessionKey) {
  const room = codexRooms.get(sessionKey);
  if (!room) return;
  if (room._shutdownTimer) clearTimeout(room._shutdownTimer);
  stopRoomStateHeartbeat(room);
  room.cancelled = true;
  abortCurrentTurn(room);
  notifySdkClientsChatGone(room.clients, 'Codex chat not found for this session.');
  flushPersistBuffer(room);
  codexRooms.delete(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {string} model
 */
export function syncCodexRoomModelFromChat(sessionKey, model) {
  const room = codexRooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (!nextModel || nextModel === room.modelId) return;
  room.modelId = nextModel;
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
  abortCurrentTurn(room);
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    message: PLAN_GUARD_USER_MESSAGE,
    toolName: typeof event.name === 'string' ? event.name : '',
  });
  return true;
}

/**
 * @param {any} room
 * @param {unknown} event
 */
function handleThreadEvent(room, event) {
  const items = normalizeCodexThreadEvent(event);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'thread' && typeof item.threadId === 'string' && item.threadId) {
      room.codexThreadId = item.threadId;
      if (room.chatId) setChatCodexThreadId(room.chatId, item.threadId);
      continue;
    }
    if (item.kind === 'turn') {
      if (typeof item.threadId === 'string' && item.threadId) {
        room.codexThreadId = item.threadId;
        if (room.chatId) setChatCodexThreadId(room.chatId, item.threadId);
      }
      if (item.status === 'failed' && typeof item.message === 'string' && item.message) {
        room._turnError = item.message;
      }
      continue;
    }
    if (item.kind === 'error') {
      if (typeof item.message === 'string' && item.message) room._turnError = item.message;
      continue;
    }
    if (applyPlanGuardIfNeeded(item, room)) return;
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}

/**
 * @param {string} text
 * @param {string} mode
 * @returns {string}
 */
function applyPlanHint(text, mode) {
  if (mode !== 'plan') return text;
  if (!resolveHarnessPlanPolicy('codex').promptHint) return text;
  return `${PLAN_MODE_HINT}\n\n${text}`;
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string }} deps
 */
export async function handleCodexAgentWebSocket(ws, sessionKey, deps) {
  if (!hasCodexCredentials()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_api_key',
        message: 'Codex is not signed in. Use Settings → Harness → Codex (ChatGPT plan or API key).',
      }));
    }
    ws.close();
    return;
  }
  if (!isCodexCliFound()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_cli',
        message: getCodexCliMissingHint(),
      }));
    }
    ws.close();
    return;
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    sendSdkChatNotFoundAndClose(ws, 'Codex chat not found for this session.');
    return;
  }
  if (!isCodexChat(chat)) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'invalid_session',
        message: 'Codex chat not found for this session.',
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
  let room = codexRooms.get(sessionKey);
  if (!room) {
    room = {
      transport: 'codex',
      clients: new Set(),
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || resolveDefaultCodexModel(),
      sdkMode: normalizeSdkMode(chat.sdkMode),
      busy: false,
      cancelled: false,
      pendingPrompts: [],
      codexThreadId: typeof chat.codexThreadId === 'string' ? chat.codexThreadId : '',
      eventStreamId: randomUUID(),
      eventSeq: 0,
      eventLog: [],
      currentRun: null,
      _persistBuf: [],
      _persistTimer: null,
      _abort: null,
      _planGuardTriggered: false,
      _turnError: '',
    };
    codexRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || resolveDefaultCodexModel();
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (typeof chat.codexThreadId === 'string' && chat.codexThreadId.trim()) {
      room.codexThreadId = chat.codexThreadId.trim();
    }
  }
  if (room._shutdownTimer) {
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }
  room.clients.add(ws);
  ensureRoomStateHeartbeat(room);
  const hello = buildAgentHelloPayload({
    transport: 'codex',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: room.pendingPrompts.map((item) => resolveQueuedPromptUiText(item)),
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  sendCodexRoomState(room);
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
    sendCodexRoomState(room);
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
    room._turnError = '';
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
    sendCodexRoomState(room);
    persistRoomEvent(room, { kind: 'localUser', text: uiText }, true);
    broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(uiText) });
    broadcastRoom(room, {
      type: 'sdkRunProgress',
      runId,
      phase: 'setup',
      transport: 'codex',
    }, { log: false });
    let status = 'completed';
    let errorMessage = '';
    const abort = new AbortController();
    room._abort = abort;
    try {
      const sdk = await loadCodexSdk();
      const Codex = sdk.Codex;
      if (typeof Codex !== 'function') {
        throw new Error('Codex export is missing from @openai/codex-sdk.');
      }
      const clientOptions = buildCodexClientOptions({
        cwd: room.cwd,
        model: room.modelId,
        sdkMode: room.sdkMode,
      });
      /** @type {{ env: Record<string, string>, apiKey?: string, codexPathOverride?: string }} */
      const ctor = {
        env: clientOptions.env,
        codexPathOverride: clientOptions.codexPathOverride,
      };
      if (clientOptions.apiKey) ctor.apiKey = clientOptions.apiKey;
      const codex = new Codex(ctor);
      const thread = room.codexThreadId
        ? codex.resumeThread(room.codexThreadId, clientOptions.threadOptions)
        : codex.startThread(clientOptions.threadOptions);
      broadcastRoom(room, {
        type: 'sdkRunProgress',
        runId,
        phase: 'stream',
        transport: 'codex',
      }, { log: false });
      const streamed = await thread.runStreamed(applyPlanHint(trimmed, room.sdkMode), {
        signal: abort.signal,
      });
      for await (const event of streamed.events) {
        if (room.cancelled) break;
        handleThreadEvent(room, event);
      }
      if (typeof thread.id === 'string' && thread.id.trim()) {
        room.codexThreadId = thread.id.trim();
        if (room.chatId) setChatCodexThreadId(room.chatId, room.codexThreadId);
      }
      if (room._planGuardTriggered) {
        status = 'plan_guard_cancelled';
        errorMessage = PLAN_GUARD_USER_MESSAGE;
      } else if (room.cancelled) {
        status = 'cancelled';
      } else if (room._turnError) {
        status = 'error';
        errorMessage = room._turnError;
      }
    } catch (err) {
      if (room.cancelled || room._planGuardTriggered) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else {
        status = 'error';
        errorMessage = err?.message ? String(err.message) : String(err);
      }
    } finally {
      if (room._abort === abort) room._abort = null;
      room.busy = false;
      room.currentRun = null;
      broadcastRoom(room, { type: 'sdkBusy', busy: false }, { log: false });
      const finished = {
        type: 'sdkRunFinished',
        runId,
        status,
        lastErrorMessage: errorMessage,
      };
      if (errorMessage && status === 'error') finished.lastErrorCode = 'codex_error';
      broadcastRoom(room, finished);
      if (errorMessage && status === 'error') {
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'codex_error',
          message: errorMessage,
        });
      }
      sendCodexRoomState(room);
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
      abortCurrentTurn(room);
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
export function getCodexRoomDiag(sessionKey) {
  const room = codexRooms.get(sessionKey);
  if (!room) return null;
  return {
    transport: 'codex',
    busy: !!room.busy,
    modelId: room.modelId,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    codexThreadId: room.codexThreadId || '',
    lastRunId: room.lastRunId || null,
    lastRunStatus: room.lastRunStatus || null,
    queuedCount: Array.isArray(room.pendingPrompts) ? room.pendingPrompts.length : 0,
  };
}
