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
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode, readEnforcedSdkMode } from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { normalizeDeepSeekNotification } from '../agent-harness/deepseek-event-normalizer.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerKernelChatRunAdapter } from '../chat-run/kernel-adapter.js';
import { createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import { isDeepSeekChat } from '../agent-transport.js';
import {
  resolvePlanModeSdkEventDecision,
  resolveReadOnlyGuardUserMessage,
} from '../sdk/sdk-plan-guard.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { getEffectiveDeepSeekApiKey } from './deepseek-api-key.js';
import { isDeepSeekCliFound } from './deepseek-cli.js';
import { loadDeepSeekSdk } from './deepseek-sdk.js';
import { resolveDefaultDeepSeekModel } from './deepseek-models.js';
import { buildDeepSeekHarnessOptions } from './deepseek-harness-options.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';

async function closeRuntime(room) {
  const harness = room?._harness;
  if (room) room._harness = null;
  if (!harness || typeof harness.close !== 'function') return;
  try {
    await harness.close();
  } catch (err) {
    console.warn('[deepseek-ws] runtime close failed:', err?.message || err);
  }
}

function abortDeepSeekRoom(room) {
  if (room) room.cancelled = true;
  void closeRuntime(room);
}

const kernel = createAgentRoomKernel({
  transport: 'deepseek',
  logLabel: 'deepseek-ws',
  goneMessage: 'DeepSeek chat not found for this session.',
  abortRoom: abortDeepSeekRoom,
  afterBroadcast(room, payload) {
    trackSdkRoomRunOutcome(room, payload);
    noteDelegationRoomEvent(room, payload);
  },
});
const deepSeekRooms = kernel.rooms;
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
export function disposeDeepSeekRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
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
  const mode = readEnforcedSdkMode(room);
  const decision = resolvePlanModeSdkEventDecision({
    transport: 'deepseek',
    mode,
    event,
  });
  if (!decision.notify) return false;
  if (decision.abortRun) {
    room.cancelled = true;
    room._planGuardTriggered = true;
    void closeRuntime(room);
  }
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    message: resolveReadOnlyGuardUserMessage(mode),
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
  const mcpContext = buildMcpRuntimeContext({
    chat: getChatByCursorSessionId(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'deepseek' },
    room,
    harness: 'deepseek',
    mode: room.sdkMode,
  });
  const mcpPrep = prepareHarnessMcp(mcpContext);
  if (room._harness && room._mcpRevision === mcpPrep.revision) return room._harness;
  if (room._harness && typeof room._harness.close === 'function') {
    try {
      await room._harness.close();
    } catch {
      // rebuild below
    }
    room._harness = null;
  }
  const sdk = await loadDeepSeekSdk();
  const DeepSeekHarness = sdk.DeepSeekHarness;
  if (typeof DeepSeekHarness !== 'function') {
    throw new Error('DeepSeekHarness export is missing from @deepseek-ai/dsh-sdk-client.');
  }
  room._harness = new DeepSeekHarness(buildDeepSeekHarnessOptions({
    cwd: room.cwd,
    model: room.modelId,
    mcpBridge: mcpPrep.bridge,
  }));
  room._mcpRevision = mcpPrep.revision;
  markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
  return room._harness;
}


/**
 * @param {any} room
 * @param {object} chat
 */
function bindDeepSeekPromptRunner(room, chat) {
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
      confirmDelegationReportsFromRoom(room);
      /** @type {{ sessionId?: string, onNotification: (notification: unknown) => void }} */
      const runOptions = {
        onNotification: (notification) => {
          if (room.cancelled) return;
          handleNotification(room, notification);
        },
      };
      if (room.deepseekSessionId) runOptions.sessionId = room.deepseekSessionId;
      const result = await harness.run(decorateHarnessPrompt(room, trimmed, 'deepseek'), runOptions);
      if (result && typeof result.sessionId === 'string' && result.sessionId.trim()) {
        room.deepseekSessionId = result.sessionId.trim();
        if (room.chatId) setChatDeepSeekSessionId(room.chatId, room.deepseekSessionId);
      }
      if (room._planGuardTriggered) {
        status = 'plan_guard_cancelled';
        errorMessage = resolveReadOnlyGuardUserMessage(mode);
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
      clearEnforcedSdkMode(room);
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
      sendRoomState(room);
      flushPersistBuffer(room);
      drainQueue();
    }
  }


  async function cancelCurrentRun() {
    room.cancelled = true;
    await closeRuntime(room);
  }
  room.startPrompt = runPrompt;
  room.cancelCurrentRun = cancelCurrentRun;
}


/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent?: Function, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} [deps]
 */
export function ensureDeepSeekRoom(sessionKey, deps = {}) {
  if (!getEffectiveDeepSeekApiKey()) {
    return {
      error: 'Missing DeepSeek API key (DEEPSEEK_API_KEY or Settings → Harness → DeepSeek).',
      code: 'missing_api_key',
    };
  }
  if (!isDeepSeekCliFound()) {
    return {
      error: 'DeepSeek Harness CLI not found. Install `@deepseek-ai/dsh` or set DSH_BIN.',
      code: 'missing_cli',
    };
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    return { error: 'DeepSeek chat not found for this session.', code: 'chat_not_found' };
  }
  if (!isDeepSeekChat(chat)) {
    return { error: 'DeepSeek chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = deepSeekRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || resolveDefaultDeepSeekModel(),
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      deepseekSessionId: typeof chat.deepseekSessionId === 'string' ? chat.deepseekSessionId : '',
      currentRun: null,
      _harness: null,
      _planGuardTriggered: false,
    });
    deepSeekRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || resolveDefaultDeepSeekModel();
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (typeof chat.deepseekSessionId === 'string' && chat.deepseekSessionId.trim()) {
      room.deepseekSessionId = chat.deepseekSessionId.trim();
    }
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  bindDeepSeekPromptRunner(room, chat);
  return { room, chat };
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleDeepSeekAgentWebSocket(ws, sessionKey, deps) {
  const ensured = ensureDeepSeekRoom(sessionKey, deps);
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
    transport: 'deepseek',
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
  transport: 'deepseek',
  rooms: deepSeekRooms,
  ensureRoom: ensureDeepSeekRoom,
});

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
