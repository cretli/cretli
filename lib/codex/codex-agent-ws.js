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
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode, readEnforcedSdkMode } from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { normalizeCodexThreadEvent } from '../agent-harness/codex-event-normalizer.js';
import { createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import { isCodexChat } from '../agent-transport.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import {
  getSdkToolCallName,
  resolvePlanModeSdkEventDecision,
  resolveReadOnlyGuardUserMessage,
} from '../sdk/sdk-plan-guard.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerKernelChatRunAdapter } from '../chat-run/kernel-adapter.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { hasCodexCredentials } from './codex-credentials.js';
import { isCodexCliFound, getCodexCliMissingHint } from './codex-cli.js';
import { loadCodexSdk } from './codex-sdk.js';
import { resolveDefaultCodexModel } from './codex-models.js';
import { buildCodexClientOptions } from './codex-thread-options.js';
import { formatCodexExecFailure } from './codex-exec-error.js';
import { ensureCodexHomeDir } from './codex-home.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { toCodexMcpServers } from '../mcp/mcp-vendor-map.js';

/**
 * Abort the in-flight `codex exec` turn.
 * @param {any} room
 */
function abortCurrentTurn(room) {
  const abort = room?._abort;
  if (room) room._abort = null;
  if (!abort || typeof abort.abort !== 'function') return;
  try {
    abort.abort();
  } catch {
    // ignore abort failures
  }
}

function abortCodexRoom(room) {
  if (room) room.cancelled = true;
  abortCurrentTurn(room);
}

const kernel = createAgentRoomKernel({
  transport: 'codex',
  logLabel: 'codex-ws',
  goneMessage: 'Codex chat not found for this session.',
  abortRoom: abortCodexRoom,
  afterBroadcast(room, payload) {
    trackSdkRoomRunOutcome(room, payload);
    noteDelegationRoomEvent(room, payload);
  },
});
const codexRooms = kernel.rooms;
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
export function disposeCodexRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
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
    const mode = readEnforcedSdkMode(room);
    const decision = resolvePlanModeSdkEventDecision({
      transport: 'codex',
      mode,
      event: item,
    });
    if (decision.notify) {
      broadcastRoom(room, {
        type: 'sdkPlanGuard',
        message: resolveReadOnlyGuardUserMessage(mode),
        toolName: getSdkToolCallName(item) || 'unknown',
      });
    }
    if (decision.abortRun) {
      room.cancelled = true;
      room._planGuardTriggered = true;
      abortCurrentTurn(room);
      continue;
    }
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}


/**
 * @param {any} room
 * @param {object} chat
 */
function bindCodexPromptRunner(room, chat) {
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
    room._turnError = '';
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
      const mcpContext = buildMcpRuntimeContext({
        chat: getChatByCursorSessionId(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'codex' },
        room,
        harness: 'codex',
        mode: room.sdkMode,
      });
      const mcpPrep = prepareHarnessMcp(mcpContext);
      const mcpServers = toCodexMcpServers(mcpPrep.mcpServers);
      /** @type {{ env: Record<string, string>, apiKey?: string, codexPathOverride?: string, config?: object }} */
      const ctor = {
        env: clientOptions.env,
        codexPathOverride: clientOptions.codexPathOverride,
      };
      if (clientOptions.apiKey) ctor.apiKey = clientOptions.apiKey;
      if (Object.keys(mcpServers).length > 0) ctor.config = { mcp_servers: mcpServers };
      const codex = new Codex(ctor);
      markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
      const thread = room.codexThreadId
        ? codex.resumeThread(room.codexThreadId, clientOptions.threadOptions)
        : codex.startThread(clientOptions.threadOptions);
      broadcastRoom(room, {
        type: 'sdkRunProgress',
        runId,
        phase: 'stream',
        transport: 'codex',
      }, { log: false });
      confirmDelegationReportsFromRoom(room);
      const streamed = await thread.runStreamed(decorateHarnessPrompt(room, trimmed, 'codex'), {
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
      if (room.cancelled) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else if (room._turnError) {
        status = 'error';
        errorMessage = formatCodexExecFailure({
          execMessage: room._turnError,
          turnError: room._turnError,
          threadId: room.codexThreadId,
          homeDir: ensureCodexHomeDir(),
        });
      }
    } catch (err) {
      if (room.cancelled) {
        status = 'cancelled';
      } else {
        status = 'error';
        errorMessage = formatCodexExecFailure({
          execMessage: err?.message ? String(err.message) : String(err),
          turnError: room._turnError,
          threadId: room.codexThreadId,
          homeDir: ensureCodexHomeDir(),
        });
      }
    } finally {
      if (room._abort === abort) room._abort = null;
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
      if (errorMessage && status === 'error') finished.lastErrorCode = 'codex_error';
      broadcastRoom(room, finished);
      if (errorMessage && status === 'error') {
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'codex_error',
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
    abortCurrentTurn(room);
  }
  room.startPrompt = runPrompt;
  room.cancelCurrentRun = cancelCurrentRun;
}


/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent?: Function, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} [deps]
 */
export function ensureCodexRoom(sessionKey, deps = {}) {
  if (!hasCodexCredentials()) {
    return {
      error: 'Codex is not signed in. Use Settings → Harness → Codex (ChatGPT plan or API key).',
      code: 'missing_api_key',
    };
  }
  if (!isCodexCliFound()) {
    return {
      error: getCodexCliMissingHint(),
      code: 'missing_cli',
    };
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    return { error: 'Codex chat not found for this session.', code: 'chat_not_found' };
  }
  if (!isCodexChat(chat)) {
    return { error: 'Codex chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = codexRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || resolveDefaultCodexModel(),
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      codexThreadId: typeof chat.codexThreadId === 'string' ? chat.codexThreadId : '',
      currentRun: null,
      _abort: null,
      _turnError: '',
    });
    codexRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || resolveDefaultCodexModel();
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (typeof chat.codexThreadId === 'string' && chat.codexThreadId.trim()) {
      room.codexThreadId = chat.codexThreadId.trim();
    }
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  bindCodexPromptRunner(room, chat);
  return { room, chat };
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleCodexAgentWebSocket(ws, sessionKey, deps) {
  const ensured = ensureCodexRoom(sessionKey, deps);
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
    transport: 'codex',
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
  transport: 'codex',
  rooms: codexRooms,
  ensureRoom: ensureCodexRoom,
});

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
