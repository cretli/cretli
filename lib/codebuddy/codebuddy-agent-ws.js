/**
 * WebSocket rooms for the CodeBuddy Agent SDK harness — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import {
  getChatByCursorSessionId,
  setChatCodeBuddySessionId,
  updateChat,
} from '../persist/chats-persist.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode, readEnforcedSdkMode, toNativeAgentMode } from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { normalizeCodeBuddyMessage } from '../agent-harness/codebuddy-event-normalizer.js';
import { createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import { isCodeBuddyChat } from '../agent-transport.js';
import {
  resolvePlanModeSdkEventDecision,
  resolveReadOnlyGuardUserMessage,
} from '../sdk/sdk-plan-guard.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerKernelChatRunAdapter } from '../chat-run/kernel-adapter.js';
import { buildCodeBuddyProcessEnv, getEffectiveCodeBuddyApiKey } from './codebuddy-api-key.js';
import { isCodeBuddyCliFound, resolveCodeBuddyCliForSpawn } from './codebuddy-cli.js';
import { loadCodeBuddySdk } from './codebuddy-sdk.js';
import { resolveCodeBuddyRunModel, resolveDefaultCodeBuddyModel } from './codebuddy-models.js';
import {
  closeCodeBuddyLiveSession,
  createCodeBuddyLiveSession,
  isCodeBuddyLiveSessionOpen,
} from './codebuddy-live-session.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { toCodeBuddyMcpServers } from '../mcp/mcp-vendor-map.js';
import { loadMcpDocument } from '../persist/mcp-persist.js';

/**
 * @param {string} [value]
 * @returns {boolean}
 */
function isResumableCodeBuddySessionId(value) {
  const id = String(value || '').trim();
  if (!id) return false;
  return id.toLowerCase() !== 'current';
}

/**
 * @param {any} room
 * @returns {Promise<void>}
 */
async function interruptActiveQuery(room) {
  const query = room?._activeQuery;
  if (query && typeof query.interrupt === 'function') {
    try {
      await query.interrupt();
    } catch (err) {
      console.warn('[codebuddy-ws] interrupt failed:', err?.message || err);
    }
  }
  const session = room?._liveSession;
  if (!isCodeBuddyLiveSessionOpen(session) || !session?.transport) return;
  if (typeof session.transport.sendControlRequest !== 'function') return;
  try {
    await session.transport.sendControlRequest({
      subtype: 'interrupt',
      reason: 'User interrupt',
    });
  } catch (err) {
    console.warn('[codebuddy-ws] live interrupt failed:', err?.message || err);
  }
}

function abortCodeBuddyRoom(room) {
  if (room) room.cancelled = true;
  void interruptActiveQuery(room);
  closeCodeBuddyLiveSession(room?._liveSession);
  if (room) room._liveSession = null;
}

const kernel = createAgentRoomKernel({
  transport: 'codebuddy',
  logLabel: 'codebuddy-ws',
  goneMessage: 'CodeBuddy chat not found for this session.',
  abortRoom: abortCodeBuddyRoom,
  afterBroadcast(room, payload) {
    trackSdkRoomRunOutcome(room, payload);
    noteDelegationRoomEvent(room, payload);
  },
});
const codeBuddyRooms = kernel.rooms;
const {
  broadcastRoom,
  persistRoomEvent,
  flushPersistBuffer,
  sendRoomState,
  attachClient,
  detachClient,
  scheduleEventLogReplay,
} = kernel;

/**
 * @param {string} sessionKey
 */
export function disposeCodeBuddyRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {string} model
 */
export function syncCodeBuddyRoomModelFromChat(sessionKey, model) {
  const room = codeBuddyRooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (nextModel && nextModel !== room.modelId) {
    closeCodeBuddyLiveSession(room._liveSession);
    room._liveSession = null;
    room._liveSessionKey = '';
    room.modelId = nextModel;
  }
}

/**
 * @param {Record<string, unknown>} event
 * @param {any} room
 * @returns {boolean}
 */
function applyPlanGuardIfNeeded(event, room) {
  const mode = readEnforcedSdkMode(room);
  const decision = resolvePlanModeSdkEventDecision({
    transport: 'codebuddy',
    mode,
    event,
  });
  if (!decision.notify) return false;
  if (decision.abortRun) {
    room.cancelled = true;
    room._planGuardTriggered = true;
    void interruptActiveQuery(room);
  }
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    message: resolveReadOnlyGuardUserMessage(mode),
    toolName: typeof event.name === 'string' ? event.name : '',
  });
  return true;
}

function liveSessionKey(room) {
  return [
    resolveCodeBuddyRunModel(room.modelId),
    String(room.cwd || ''),
    normalizeSdkMode(room.sdkMode),
    String(loadMcpDocument().revision),
  ].join('\0');
}

/**
 * @param {any} room
 */
function dropLiveSession(room) {
  closeCodeBuddyLiveSession(room._liveSession);
  room._liveSession = null;
  room._liveSessionKey = '';
}

/**
 * @param {any} room
 * @returns {Promise<object>}
 */
async function ensureLiveSession(room) {
  if (isCodeBuddyLiveSessionOpen(room._liveSession) && room._liveSessionKey === liveSessionKey(room)) {
    return room._liveSession;
  }
  dropLiveSession(room);
  const sdk = await loadCodeBuddySdk();
  const mcpContext = buildMcpRuntimeContext({
    chat: getChatByCursorSessionId(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'codebuddy' },
    room,
    harness: 'codebuddy',
    mode: room.sdkMode,
  });
  const mcpPrep = prepareHarnessMcp(mcpContext);
  const session = createCodeBuddyLiveSession({
    sdk,
    model: resolveCodeBuddyRunModel(room.modelId),
    pathToCodebuddyCode: resolveCodeBuddyCliForSpawn(),
    env: buildQueryEnv(),
    cwd: room.cwd,
    permissionMode: toNativeAgentMode(room.sdkMode) === 'plan' ? 'plan' : 'bypassPermissions',
    conversationMode: room.sdkMode,
    mcpServers: toCodeBuddyMcpServers(mcpPrep.mcpServers),
  });
  room._liveSession = session;
  room._liveSessionKey = liveSessionKey(room);
  markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
  return session;
}

/**
 * @param {any} room
 * @param {unknown} message
 */
function handleNormalizedMessage(room, message) {
  const items = normalizeCodeBuddyMessage(message);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'session' && isResumableCodeBuddySessionId(item.sessionId)) {
      room.codebuddySessionId = item.sessionId;
      if (room.chatId) setChatCodeBuddySessionId(room.chatId, item.sessionId);
      continue;
    }
    if (item.kind === 'result') {
      room._lastResult = item;
      if (isResumableCodeBuddySessionId(item.sessionId)) {
        room.codebuddySessionId = item.sessionId;
        if (room.chatId) setChatCodeBuddySessionId(room.chatId, item.sessionId);
      }
      continue;
    }
    if (applyPlanGuardIfNeeded(item, room)) return;
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}

/**
 * @returns {Record<string, string>}
 */
function buildQueryEnv() {
  return buildCodeBuddyProcessEnv();
}


/**
 * @param {any} room
 * @param {object} chat
 */
function bindCodeBuddyPromptRunner(room, chat) {
  void chat;
  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
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
    sendRoomState(room);
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
    const runId = randomUUID();
    room.currentRun = { id: runId, startedAt: Date.now() };
    const mode = normalizeSdkMode(modeOverride || room.sdkMode);
    room.sdkMode = mode;
    beginEnforcedSdkMode(room, mode);
    broadcastRoom(room, {
      type: 'sdkPromptStarted',
      runId,
      text: uiText,
      fromQueue: fromQueue === true,
      remaining: room.pendingPrompts.length,
    });
    broadcastRoom(room, { type: 'sdkBusy', busy: true }, { log: false });
    sendRoomState(room);
    persistRoomEvent(room, { kind: 'localUser', text: uiText }, true);
    broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(uiText) });
    broadcastRoom(room, {
      type: 'sdkRunProgress',
      runId,
      phase: 'setup',
      transport: 'codebuddy',
    }, { log: false });
    let status = 'completed';
    let errorMessage = '';
    try {
      const session = await ensureLiveSession(room);
      room._activeQuery = session;
      await session.send(decorateHarnessPrompt(room, trimmed, 'codebuddy'));
      broadcastRoom(room, {
        type: 'sdkRunProgress',
        runId,
        phase: 'stream',
        transport: 'codebuddy',
      }, { log: false });
      confirmDelegationReportsFromRoom(room);
      for await (const message of session.stream()) {
        if (room.cancelled) {
          await interruptActiveQuery(room);
          break;
        }
        handleNormalizedMessage(room, message);
      }
      if (room._planGuardTriggered) {
        status = 'plan_guard_cancelled';
        errorMessage = resolveReadOnlyGuardUserMessage(mode);
      } else if (room.cancelled) {
        status = 'cancelled';
      } else if (room._lastResult && room._lastResult.status === 'error') {
        status = 'error';
        errorMessage = String(room._lastResult.errorMessage || room._lastResult.resultText || 'CodeBuddy run failed');
      }
    } catch (err) {
      dropLiveSession(room);
      if (room.cancelled || room._planGuardTriggered) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else {
        status = 'error';
        errorMessage = err?.message ? String(err.message) : String(err);
      }
    } finally {
      room._activeQuery = null;
      room.busy = false;
      room.currentRun = null;
      clearEnforcedSdkMode(room);
      broadcastRoom(room, { type: 'sdkBusy', busy: false }, { log: false });
      const finished = {
        type: 'sdkRunFinished',
        runId,
        status,
        lastErrorMessage: errorMessage,
      };
      if (errorMessage && status === 'error') finished.lastErrorCode = 'codebuddy_error';
      broadcastRoom(room, finished);
      if (errorMessage && status === 'error') {
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'codebuddy_error',
          message: errorMessage,
        });
      }
      sendRoomState(room);
      flushPersistBuffer(room);
      drainQueue();
    }
  }


  async function cancelCurrentRun() {
    room.cancelled = true;
    await interruptActiveQuery(room);
  }
  room.startPrompt = runPrompt;
  room.cancelCurrentRun = cancelCurrentRun;
}

/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent?: Function, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} [deps]
 */
export function ensureCodeBuddyRoom(sessionKey, deps = {}) {
  if (!getEffectiveCodeBuddyApiKey()) {
    return {
      error: 'Missing CodeBuddy API key (CODEBUDDY_API_KEY or Settings → Harness → CodeBuddy).',
      code: 'missing_api_key',
    };
  }
  if (!isCodeBuddyCliFound()) {
    return {
      error: 'CodeBuddy CLI not found. Install `codebuddy` or set CODEBUDDY_CODE_PATH.',
      code: 'missing_cli',
    };
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    return { error: 'CodeBuddy chat not found for this session.', code: 'chat_not_found' };
  }
  if (!isCodeBuddyChat(chat)) {
    return { error: 'CodeBuddy chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = codeBuddyRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || resolveDefaultCodeBuddyModel(),
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      codebuddySessionId: typeof chat.codebuddySessionId === 'string' ? chat.codebuddySessionId : '',
      currentRun: null,
      _activeQuery: null,
      _liveSession: null,
      _lastResult: null,
      _planGuardTriggered: false,
    });
    codeBuddyRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || resolveDefaultCodeBuddyModel();
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (typeof chat.codebuddySessionId === 'string' && isResumableCodeBuddySessionId(chat.codebuddySessionId)) {
      room.codebuddySessionId = chat.codebuddySessionId.trim();
    }
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  bindCodeBuddyPromptRunner(room, chat);
  return { room, chat };
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleCodeBuddyAgentWebSocket(ws, sessionKey, deps) {
  const ensured = ensureCodeBuddyRoom(sessionKey, deps);
  if ('error' in ensured) {
    if (ensured.code === 'chat_not_found') {
      sendSdkChatNotFoundAndClose(ws, ensured.error);
      return;
    }
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: ensured.code,
        message: ensured.error,
      }));
    }
    ws.close();
    return;
  }
  const { room, chat } = ensured;
  attachClient(room, ws);
  const hello = buildAgentHelloPayload({
    transport: 'codebuddy',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: room.pendingPrompts.map((item) => resolveQueuedPromptUiText(item)),
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  sendRoomState(room);
  scheduleEventLogReplay(room, ws);

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
      void room.cancelCurrentRun();
      return;
    }
    if (msg.type === 'setSdkMode') {
      const nextMode = normalizeSdkMode(msg.mode);
      if (nextMode !== room.sdkMode && !room.busy) dropLiveSession(room);
      room.sdkMode = nextMode;
      if (chat.id) updateChat(chat.id, { sdkMode: nextMode });
      broadcastRoom(room, { type: 'sdkMode', mode: nextMode }, { log: false });
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void room.startPrompt(msg.text, msg.mode, false, readClientDisplayText(msg));
    }
  });

  ws.on('close', () => {
    detachClient(room, ws, sessionKey);
  });
}

registerKernelChatRunAdapter({
  transport: 'codebuddy',
  rooms: codeBuddyRooms,
  ensureRoom: ensureCodeBuddyRoom,
});

/**
 * @param {string} sessionKey
 * @returns {Record<string, unknown> | null}
 */
export function getCodeBuddyRoomDiag(sessionKey) {
  const room = codeBuddyRooms.get(sessionKey);
  if (!room) return null;
  return {
    transport: 'codebuddy',
    busy: !!room.busy,
    modelId: room.modelId,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    codebuddySessionId: room.codebuddySessionId || '',
    lastRunId: room.lastRunId || null,
    lastRunStatus: room.lastRunStatus || null,
    queuedCount: Array.isArray(room.pendingPrompts) ? room.pendingPrompts.length : 0,
  };
}
