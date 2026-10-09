/**
 * WebSocket rooms for Mistral AI agent harness — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import { rejectArchivedRoomPrompt } from '../chat-message-guard.js';
import { getChatByCursorSessionId, updateChat } from '../persist/chats-persist.js';
import { resolveExecutionFolderForChat } from '../execution-folder.js';
import { getEffectiveMistralApiKey } from './mistral-api-key.js';
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode } from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import { appendUserMessage, runLlmToolLoop } from '../agent-harness/llm-tool-loop.js';
import { streamMistralChatCompletion } from './mistral-client.js';
import { abortRoomController, createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { drainOnePendingPrompt } from '../agent-harness/pending-prompt-drain.js';
import { handleQueueControlMessage } from '../agent-harness/queue-controls.js';
import { isMistralChat } from '../agent-transport.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerChatRunAdapter } from '../chat-run-service.js';
import { canAcceptNewRun } from '../update-gate.js';
import { msg } from '../messages.js';
import { loadChatHistory } from '../persist/chat-history-persist.js';
import { buildMistralConversationFromHistory } from './mistral-conversation-hydrate.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { loadMistralMcpTools } from '../mcp/mcp-openrouter-tools.js';
import { isScoutReadOnlyChatId } from '../workspace-scout-chat.js';
import {
  enforceWatcherOrchestratorMcpGate,
  stampWatcherOrchestratorRoom,
} from '../mcp/watcher-orchestrator-mcp-gate.js';

const kernel = createAgentRoomKernel({
  transport: 'mistral',
  logLabel: 'mistral-ws',
  goneMessage: 'Mistral chat not found for this session.',
  afterBroadcast: noteDelegationRoomEvent,
});
const mistralRooms = kernel.rooms;
const {
  broadcastRoom,
  applySdkModeIfChanged,
  persistRoomEvent,
  flushPersistBuffer,
  attachClient,
  detachClient,
  scheduleEventLogReplay,
} = kernel;
const DEFAULT_MISTRAL_MODEL = 'mistral-medium-latest';

/**
 * @param {object} room
 * @param {object} chat
 */
function drainMistralQueue(room, chat) {
  drainOnePendingPrompt(room, (next) => {
    void runMistralPrompt(room, chat, next.text, next.mode, next.displayText || '');
  });
}

/**
 * @param {object} room
 * @param {string} text
 * @param {string} [modeOverride]
 * @param {string} [displayText]
 */
function enqueueMistralPrompt(room, text, modeOverride, displayText) {
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
export function disposeMistralRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} deps
 * @returns {{ room: object, chat: object } | { error: string, code: string }}
 */
export function ensureMistralRoom(sessionKey, deps) {
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat || !isMistralChat(chat)) {
    return { error: 'Mistral chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = mistralRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || DEFAULT_MISTRAL_MODEL,
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      abortController: null,
      conversationMessages: buildMistralConversationFromHistory(
        loadChatHistory(chat.id)?.events || [],
      ),
    });
    mistralRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || DEFAULT_MISTRAL_MODEL;
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  stampWatcherOrchestratorRoom(room, chat, deps);
  room.drainQueue = () => drainMistralQueue(room, chat);
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
async function runMistralPrompt(room, chat, text, modeOverride, displayText = '') {
  if (rejectArchivedRoomPrompt(room, broadcastRoom)) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const uiText = resolvePromptUiText(trimmed, displayText);
  if (room.busy) {
    enqueueMistralPrompt(room, trimmed, modeOverride, displayText);
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
    decorateHarnessPrompt(room, trimmed, 'mistral'),
  );
  const model = String(room.modelId || chat.model || DEFAULT_MISTRAL_MODEL).trim() || DEFAULT_MISTRAL_MODEL;
  const mcpContext = buildMcpRuntimeContext({
    chat,
    room,
    harness: 'mistral',
    mode: room.sdkMode,
  });
  const mcpPrep = prepareHarnessMcp(mcpContext);
  const extraTools = await loadMistralMcpTools(mcpContext);
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
    drainMistralQueue(room, chat);
    return;
  }
  let reportsConfirmed = false;
  const confirmReports = () => {
    if (reportsConfirmed) return;
    reportsConfirmed = true;
    confirmDelegationReportsFromRoom(room);
  };
  const result = await runLlmToolLoop({
    transport: 'mistral',
    providerLabel: 'Mistral',
    streamChatCompletion: streamMistralChatCompletion,
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
            code: 'mistral_error',
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
  drainMistralQueue(room, chat);
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleMistralAgentWebSocket(ws, sessionKey, deps) {
  if (!getEffectiveMistralApiKey()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_api_key',
        message: 'Missing Mistral API key (MISTRAL_API_KEY or Settings).',
      }));
    }
    ws.close();
    return;
  }
  const ensured = ensureMistralRoom(sessionKey, deps);
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
    transport: 'mistral',
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
      void runMistralPrompt(room, chat, msg.text, msg.mode, readClientDisplayText(msg));
    }
  });

  ws.on('close', () => {
    detachClient(room, ws, sessionKey);
  });
}

/**
 * @param {{ chat: object, prompt: string, mode?: string, displayText?: string, deps?: object }} input
 */
export async function startMistralChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const ensured = ensureMistralRoom(sessionKey, input.deps || {});
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
  void runMistralPrompt(room, chat, input.prompt, input.mode, input.displayText || '');
  return { runId: String(room.currentRun?.id || ''), accepted: true };
}

/**
 * @param {{ chat: object, runId?: string }} input
 */
export async function cancelMistralChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const room = mistralRooms.get(sessionKey);
  if (!room) return;
  if (input.runId && room.currentRun?.id && room.currentRun.id !== input.runId) return;
  room.cancelled = true;
  abortRoomController(room);
}

registerChatRunAdapter({
  transport: 'mistral',
  start: startMistralChatRun,
  cancel: cancelMistralChatRun,
  getState({ chat, runId }) {
    const room = mistralRooms.get(String(chat?.cursorSessionId || ''));
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
export function getMistralRoomDiag(sessionKey) {
  const room = mistralRooms.get(sessionKey);
  if (!room) return null;
  return {
    transport: 'mistral',
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
export function syncMistralRoomModelFromChat(sessionKey, model) {
  const room = mistralRooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (nextModel) room.modelId = nextModel;
}
