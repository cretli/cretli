/**
 * WebSocket rooms for Zai AI agent harness — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import { rejectArchivedRoomPrompt } from '../chat-message-guard.js';
import { getChatByCursorSessionId, updateChat } from '../persist/chats-persist.js';
import { resolveExecutionFolderForChat } from '../execution-folder.js';
import { getEffectiveZaiSdkApiKey } from './zai-api-key.js';
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode } from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import { appendUserMessage, runLlmToolLoop } from '../agent-harness/llm-tool-loop.js';
import { streamZaiSdkCompletion } from './zai-sdk-client.js';
import { abortRoomController, createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { drainOnePendingPrompt } from '../agent-harness/pending-prompt-drain.js';
import { handleQueueControlMessage } from '../agent-harness/queue-controls.js';
import { isZaiChat } from '../agent-transport.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerChatRunAdapter } from '../chat-run-service.js';
import { canAcceptNewRun } from '../update-gate.js';
import { msg } from '../messages.js';
import { loadChatHistory } from '../persist/chat-history-persist.js';
import { buildOpenRouterConversationFromHistory } from '../openrouter/openrouter-conversation-hydrate.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { loadHarnessMcpTools } from '../mcp/mcp-openrouter-tools.js';
import { isScoutReadOnlyChatId } from '../workspace-scout-chat.js';
import {
  enforceWatcherOrchestratorMcpGate,
  stampWatcherOrchestratorRoom,
} from '../mcp/watcher-orchestrator-mcp-gate.js';

const kernel = createAgentRoomKernel({
  transport: 'zai',
  logLabel: 'zai-ws',
  goneMessage: 'Zai chat not found for this session.',
  afterBroadcast: noteDelegationRoomEvent,
});
const zaiRooms = kernel.rooms;
const {
  broadcastRoom,
  applySdkModeIfChanged,
  persistRoomEvent,
  flushPersistBuffer,
  attachClient,
  detachClient,
  scheduleEventLogReplay,
} = kernel;
const DEFAULT_ZAI_MODEL = 'glm-5.3';

/**
 * @param {object} room
 * @param {object} chat
 */
function drainZaiQueue(room, chat) {
  drainOnePendingPrompt(room, (next) => {
    void runZaiPrompt(room, chat, next.text, next.mode, next.displayText || '');
  });
}

/**
 * @param {object} room
 * @param {string} text
 * @param {string} [modeOverride]
 * @param {string} [displayText]
 */
function enqueueZaiPrompt(room, text, modeOverride, displayText) {
  const uiText = resolvePromptUiText(text, displayText);
  const item = { text, mode: normalizeSdkMode(modeOverride || room.sdkMode) };
  if (uiText && uiText !== text) item.displayText = uiText;
  room.pendingPrompts.push(item);
  broadcastRoom(room, { type: 'sdkQueued', text: uiText || text });
  kernel.sendRoomState(room);
}

/**
 * @param {string} sessionKey
 */
export function disposeZaiRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} deps
 * @returns {{ room: object, chat: object } | { error: string, code: string }}
 */
export function ensureZaiRoom(sessionKey, deps) {
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat || !isZaiChat(chat)) {
    return { error: 'Zai chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = zaiRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || DEFAULT_ZAI_MODEL,
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      abortController: null,
      conversationMessages: buildOpenRouterConversationFromHistory(
        loadChatHistory(chat.id)?.events || [],
      ),
    });
    zaiRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || DEFAULT_ZAI_MODEL;
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  stampWatcherOrchestratorRoom(room, chat, deps);
  room.drainQueue = () => drainZaiQueue(room, chat);
  room.cancelCurrentRun = () => {
    room.cancelled = true;
    abortRoomController(room);
  };
  return { room, chat };
}

/**
 * @param {object} room
 * @param {object} chat
 * @param {string} text
 * @param {string} [modeOverride]
 * @param {string} [displayText]
 */
async function runZaiPrompt(room, chat, text, modeOverride, displayText = '') {
  if (rejectArchivedRoomPrompt(room, broadcastRoom)) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const uiText = resolvePromptUiText(trimmed, displayText);
  if (room.busy) {
    enqueueZaiPrompt(room, trimmed, modeOverride, displayText);
    return;
  }
  if (!canAcceptNewRun()) {
    broadcastRoom(room, {
      type: 'sdkError',
      code: 'update_in_progress',
      message: msg(null, 'update.notAcceptingRuns'),
    });
    return;
  }
  room.busy = true;
  room.cancelled = false;
  room.abortController = new AbortController();
  const runId = randomUUID();
  room.currentRun = { id: runId, startedAt: Date.now() };
  const mode = normalizeSdkMode(modeOverride || room.sdkMode);
  room.sdkMode = mode;
  beginEnforcedSdkMode(room, mode);
  syncRoomDelegationAssignment(room);
  broadcastRoom(room, { type: 'sdkPromptStarted', runId });
  broadcastRoom(room, { type: 'sdkBusy', busy: true });
  persistRoomEvent(room, { kind: 'localUser', text: uiText }, true);
  broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(uiText) });
  room.conversationMessages = appendUserMessage(
    room.conversationMessages,
    decorateHarnessPrompt(room, trimmed, 'zai'),
  );
  const model = String(room.modelId || chat.model || DEFAULT_ZAI_MODEL).trim() || DEFAULT_ZAI_MODEL;
  const mcpContext = buildMcpRuntimeContext({
    chat,
    room,
    harness: 'zai',
    mode: room.sdkMode,
  });
  const mcpPrep = prepareHarnessMcp(mcpContext);
  const extraTools = await loadHarnessMcpTools(mcpContext, 'zai');
  markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
  const mcpBlock = await enforceWatcherOrchestratorMcpGate({
    chat,
    room,
    mcpPrep,
    mcpContext,
    sessionStartedAt: room.currentRun.startedAt,
    liveToolNames: extraTools.map((tool) => String(tool?.function?.name || '').trim()).filter(Boolean),
  });
  if (mcpBlock) {
    room.busy = false;
    room.abortController = null;
    room.currentRun = null;
    clearEnforcedSdkMode(room);
    broadcastRoom(room, { type: 'sdkBusy', busy: false });
    broadcastRoom(room, {
      type: 'sdkRunFinished',
      runId,
      status: 'error',
      lastErrorMessage: mcpBlock.message,
      lastErrorCode: mcpBlock.code,
    });
    broadcastRoom(room, {
      type: 'sdkError',
      code: mcpBlock.code,
      message: mcpBlock.message,
    });
    flushPersistBuffer(room);
    kernel.sendRoomState(room);
    drainZaiQueue(room, chat);
    return;
  }
  let reportsConfirmed = false;
  const confirmReports = () => {
    if (reportsConfirmed) return;
    reportsConfirmed = true;
    confirmDelegationReportsFromRoom(room);
  };
  const result = await runLlmToolLoop({
    transport: 'zai',
    providerLabel: 'Zai',
    streamChatCompletion: streamZaiSdkCompletion,
    model,
    cwd: room.cwd,
    mode: room.sdkMode,
    assignment: room.delegationAssignment,
    delegationId: room.delegationId,
    attemptId: room.delegationAttemptId,
    scoutReadOnly: isScoutReadOnlyChatId(room?.chatId),
    messages: room.conversationMessages,
    extraTools,
    mcpContext,
    signal: room.abortController.signal,
    callbacks: {
      onEvent: (event) => {
        confirmReports();
        broadcastRoom(room, { type: 'sdkEvent', event });
      },
      onFinished: (status, detail) => {
        if (status === 'completed') confirmReports();
        room.busy = false;
        room.abortController = null;
        room.currentRun = null;
        clearEnforcedSdkMode(room);
        broadcastRoom(room, { type: 'sdkBusy', busy: false });
        broadcastRoom(room, {
          type: 'sdkRunFinished',
          runId,
          status,
          lastErrorMessage: detail || '',
        }, { log: true });
        if (detail && status === 'error') {
          broadcastRoom(room, {
            type: 'sdkError',
            code: 'zai_error',
            message: detail,
          });
        }
      },
      isCancelled: () => room.cancelled,
    },
  });
  if (result.messages) room.conversationMessages = result.messages;
  flushPersistBuffer(room);
  kernel.sendRoomState(room);
  drainZaiQueue(room, chat);
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleZaiAgentWebSocket(ws, sessionKey, deps) {
  if (!getEffectiveZaiSdkApiKey()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_api_key',
        message: 'Missing Z.AI API key (configure it in Settings → OpenCode).',
      }));
    }
    ws.close();
    return;
  }
  const ensured = ensureZaiRoom(sessionKey, deps);
  if ('error' in ensured) {
    if (ensured.code === 'no_cwd') {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'sdkError',
          code: 'no_cwd',
          message: ensured.error,
        }));
      }
      ws.close();
      return;
    }
    sendSdkChatNotFoundAndClose(ws, ensured.error);
    return;
  }
  const { room, chat } = ensured;
  attachClient(room, ws);

  const hello = buildAgentHelloPayload({
    transport: 'zai',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: room.pendingPrompts.map((item) => resolveQueuedPromptUiText(item)),
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  kernel.sendRoomState(room);
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
      room.cancelled = true;
      abortRoomController(room);
      return;
    }
    if (handleQueueControlMessage(room, msg, { broadcast: broadcastRoom })) return;
    if (msg.type === 'setSdkMode') {
      applySdkModeIfChanged(room, msg.mode, { chatId: chat.id, updateChat });
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void runZaiPrompt(room, chat, msg.text, msg.mode, readClientDisplayText(msg));
    }
  });

  ws.on('close', () => {
    detachClient(room, ws, sessionKey);
  });
}

/**
 * @param {{ chat: object, prompt: string, mode?: string, displayText?: string, deps?: object }} input
 */
export async function startZaiChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const ensured = ensureZaiRoom(sessionKey, input.deps || {});
  if ('error' in ensured) {
    const error = new Error(ensured.error);
    error.code = ensured.code;
    throw error;
  }
  const { room, chat } = ensured;
  if (room.busy) {
    const error = new Error('Recipient is busy');
    error.code = 'recipient_busy';
    throw error;
  }
  room.serverHold = true;
  void runZaiPrompt(room, chat, input.prompt, input.mode, input.displayText || '');
  return { runId: String(room.currentRun?.id || ''), accepted: true };
}

/**
 * @param {{ chat: object, runId?: string }} input
 */
export async function cancelZaiChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const room = zaiRooms.get(sessionKey);
  if (!room) return;
  if (input.runId && room.currentRun?.id && room.currentRun.id !== input.runId) return;
  room.cancelled = true;
  abortRoomController(room);
}

registerChatRunAdapter({
  transport: 'zai',
  start: startZaiChatRun,
  cancel: cancelZaiChatRun,
  getState({ chat, runId }) {
    const room = zaiRooms.get(String(chat?.cursorSessionId || ''));
    if (!room) return null;
    if (runId && room.currentRun?.id && room.currentRun.id !== runId) return null;
    return {
      runId: String(room.currentRun?.id || ''),
      busy: !!room.busy,
    };
  },
});

/**
 * @param {string} sessionKey
 * @returns {Record<string, unknown> | null}
 */
export function getZaiRoomDiag(sessionKey) {
  const room = zaiRooms.get(sessionKey);
  if (!room) return null;
  return {
    transport: 'zai',
    busy: !!room.busy,
    modelId: room.modelId,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    messageCount: Array.isArray(room.conversationMessages) ? room.conversationMessages.length : 0,
  };
}

/**
 * @param {string} sessionKey
 * @param {string} model
 */
export function syncZaiRoomModelFromChat(sessionKey, model) {
  const room = zaiRooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (nextModel) room.modelId = nextModel;
}
