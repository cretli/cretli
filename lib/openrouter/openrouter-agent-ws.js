/**
 * WebSocket rooms for OpenRouter agent harness — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import { getChatByCursorSessionId, updateChat } from '../persist/chats-persist.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import { getEffectiveOpenRouterApiKey } from './openrouter-api-key.js';
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode } from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import {
  appendUserMessage,
  runOpenRouterAgentLoop,
} from '../agent-harness/openrouter-agent-loop.js';
import { abortRoomController, createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
} from '../prompt-ui-text.js';
import { isOpenRouterChat } from '../agent-transport.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerChatRunAdapter } from '../chat-run-service.js';
import { loadChatHistory } from '../persist/chat-history-persist.js';
import { buildOpenRouterConversationFromHistory } from './openrouter-conversation-hydrate.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { loadOpenRouterMcpTools } from '../mcp/mcp-openrouter-tools.js';

const kernel = createAgentRoomKernel({
  transport: 'openrouter',
  logLabel: 'openrouter-ws',
  goneMessage: 'OpenRouter chat not found for this session.',
  afterBroadcast: noteDelegationRoomEvent,
});
const openRouterRooms = kernel.rooms;
const {
  broadcastRoom,
  persistRoomEvent,
  flushPersistBuffer,
  attachClient,
  detachClient,
  scheduleEventLogReplay,
} = kernel;
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

/**
 * @param {string} sessionKey
 */
export function disposeOpenRouterRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} deps
 * @returns {{ room: object, chat: object } | { error: string, code: string }}
 */
export function ensureOpenRouterRoom(sessionKey, deps) {
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat || !isOpenRouterChat(chat)) {
    return { error: 'OpenRouter chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = openRouterRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || DEFAULT_OPENROUTER_MODEL,
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      abortController: null,
      conversationMessages: buildOpenRouterConversationFromHistory(
        loadChatHistory(chat.id)?.events || [],
      ),
    });
    openRouterRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || DEFAULT_OPENROUTER_MODEL;
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  return { room, chat };
}

/**
 * @param {object} room
 * @param {object} chat
 * @param {string} text
 * @param {string} [modeOverride]
 * @param {string} [displayText]
 */
async function runOpenRouterPrompt(room, chat, text, modeOverride, displayText = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const uiText = resolvePromptUiText(trimmed, displayText);
  if (room.busy) {
    broadcastRoom(room, { type: 'sdkQueued', text: uiText });
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
  broadcastRoom(room, { type: 'sdkPromptStarted', runId });
  broadcastRoom(room, { type: 'sdkBusy', busy: true });
  persistRoomEvent(room, { kind: 'localUser', text: uiText }, true);
  broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(uiText) });
  room.conversationMessages = appendUserMessage(
    room.conversationMessages,
    decorateHarnessPrompt(room, trimmed, 'openrouter'),
  );
  const model = String(room.modelId || chat.model || DEFAULT_OPENROUTER_MODEL).trim() || DEFAULT_OPENROUTER_MODEL;
  const mcpContext = buildMcpRuntimeContext({
    chat,
    room,
    harness: 'openrouter',
    mode: room.sdkMode,
  });
  const mcpPrep = prepareHarnessMcp(mcpContext);
  const extraTools = await loadOpenRouterMcpTools(mcpContext);
  markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
  let reportsConfirmed = false;
  const confirmReports = () => {
    if (reportsConfirmed) return;
    reportsConfirmed = true;
    confirmDelegationReportsFromRoom(room);
  };
  const result = await runOpenRouterAgentLoop({
    model,
    cwd: room.cwd,
    mode: room.sdkMode,
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

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
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
  const ensured = ensureOpenRouterRoom(sessionKey, deps);
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
    transport: 'openrouter',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: [],
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
    if (msg.type === 'setSdkMode') {
      const mode = normalizeSdkMode(msg.mode);
      room.sdkMode = mode;
      if (chat.id) updateChat(chat.id, { sdkMode: mode });
      broadcastRoom(room, { type: 'sdkMode', mode }, { log: false });
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void runOpenRouterPrompt(room, chat, msg.text, msg.mode, readClientDisplayText(msg));
    }
  });

  ws.on('close', () => {
    detachClient(room, ws, sessionKey);
  });
}

/**
 * @param {{ chat: object, prompt: string, mode?: string, displayText?: string, deps?: object }} input
 */
export async function startOpenRouterChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const ensured = ensureOpenRouterRoom(sessionKey, input.deps || {});
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
  void runOpenRouterPrompt(room, chat, input.prompt, input.mode, input.displayText || '');
  return { runId: String(room.currentRun?.id || ''), accepted: true };
}

/**
 * @param {{ chat: object, runId?: string }} input
 */
export async function cancelOpenRouterChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const room = openRouterRooms.get(sessionKey);
  if (!room) return;
  if (input.runId && room.currentRun?.id && room.currentRun.id !== input.runId) return;
  room.cancelled = true;
  abortRoomController(room);
}

registerChatRunAdapter({
  transport: 'openrouter',
  start: startOpenRouterChatRun,
  cancel: cancelOpenRouterChatRun,
  getState({ chat, runId }) {
    const room = openRouterRooms.get(String(chat?.cursorSessionId || ''));
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
