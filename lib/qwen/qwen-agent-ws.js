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
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode, readEnforcedSdkMode, toNativeAgentMode } from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { createQwenEventNormalizer } from '../agent-harness/qwen-event-normalizer.js';
import { createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import { isQwenChat } from '../agent-transport.js';
import {
  resolvePlanModeSdkEventDecision,
  resolvePlanModeToolDecision,
  resolveReadOnlyGuardUserMessage,
} from '../sdk/sdk-plan-guard.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerKernelChatRunAdapter } from '../chat-run/kernel-adapter.js';
import { buildQwenProcessEnv, getEffectiveQwenApiKey } from './qwen-api-key.js';
import { resolveQwenCli } from './qwen-cli.js';
import { loadQwenSdk } from './qwen-sdk.js';
import { resolveDefaultQwenModel, resolveQwenRunModel } from './qwen-models.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { toQwenMcpServers } from '../mcp/mcp-vendor-map.js';
import {
  buildQwenCanUseToolResult,
  createQwenCanUseTool,
  QWEN_CAN_USE_TOOL_TIMEOUT_MS,
} from './qwen-question.js';
import { notifyAgentNeedsInput } from '../agent-needs-input-push.js';
import {
  formatQwenApiErrorMessage,
  isFatalQwenApiError,
  QWEN_API_ERROR_WATCH_MS,
  readNewQwenApiErrorsFromJsonl,
  readQwenJsonlSize,
  resolveQwenApiErrorCode,
  resolveQwenSessionJsonlPath,
} from './qwen-api-error.js';

/**
 * @param {string} [value]
 * @returns {boolean}
 */
function isResumableQwenSessionId(value) {
  const id = String(value || '').trim();
  if (!id) return false;
  return id.toLowerCase() !== 'current';
}

function stopQwenApiErrorWatch(room) {
  if (!room?._qwenApiErrorTimer) return;
  clearInterval(room._qwenApiErrorTimer);
  room._qwenApiErrorTimer = null;
}

function abortQwenRoom(room) {
  if (room) room.cancelled = true;
  stopQwenApiErrorWatch(room);
  void interruptActiveQuery(room);
}

const kernel = createAgentRoomKernel({
  transport: 'qwen',
  logLabel: 'qwen-ws',
  goneMessage: 'Qwen chat not found for this session.',
  abortRoom: abortQwenRoom,
  afterBroadcast(room, payload) {
    trackSdkRoomRunOutcome(room, payload);
    noteDelegationRoomEvent(room, payload);
  },
});
const qwenRooms = kernel.rooms;
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
export function disposeQwenRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
}

/**
 * @param {any} room
 * @returns {Promise<void>}
 */
function ensureQwenQuestionState(room) {
  if (!(room._pendingQuestions instanceof Map)) {
    room._pendingQuestions = new Map();
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
  room._pendingQuestions.delete(requestId);
  room._qwenQuestionWaiters.delete(requestId);
  if (typeof waiter !== 'function') return false;
  waiter(payload);
  broadcastRoom(room, {
    type: 'questionResolved',
    requestId,
  }, { log: false });
  sendRoomState(room);
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
  const inner = createQwenCanUseTool({
    generateId: () => randomUUID(),
    emitQuestion: (event) => {
      const requestId = typeof event.requestId === 'string' ? event.requestId : '';
      if (!requestId) return;
      ensureQwenQuestionState(room);
      const isNewQuestion = !room._pendingQuestions.has(requestId);
      room._pendingQuestions.set(requestId, event);
      broadcastRoom(room, { type: 'sdkEvent', event });
      sendRoomState(room);
      if (isNewQuestion) notifyAgentNeedsInput({ room, event });
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
  return async (toolName, input, options = {}) => {
    const decision = resolvePlanModeToolDecision({
      transport: 'qwen',
      mode: readEnforcedSdkMode(room),
      toolName,
      input,
    });
    if (decision.deny) {
      return buildQwenCanUseToolResult({
        behavior: 'deny',
        message: resolveReadOnlyGuardUserMessage(readEnforcedSdkMode(room)),
      });
    }
    return inner(toolName, input, options);
  };
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
  const mode = readEnforcedSdkMode(room);
  const decision = resolvePlanModeSdkEventDecision({
    transport: 'qwen',
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
 * @param {any} room
 * @param {object} chat
 */
function bindQwenPromptRunner(room, chat) {
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
    room._qwenApiErrorApplied = false;
    room._qwenLastApiErrorMessage = '';
    room._qwenFatalApiError = null;
    room._qwenNormalizer = createQwenEventNormalizer();
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
        permissionMode: toNativeAgentMode(mode) === 'plan' ? 'plan' : 'yolo',
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
      const mcpContext = buildMcpRuntimeContext({
        chat: getChatByCursorSessionId(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'qwen' },
        room,
        harness: 'qwen',
        mode: room.sdkMode,
      });
      const mcpPrep = prepareHarnessMcp(mcpContext);
      const qwenMcp = toQwenMcpServers(mcpPrep.mcpServers);
      if (Object.keys(qwenMcp).length > 0) options.mcpServers = qwenMcp;
      const query = sdk.query({ prompt: decorateHarnessPrompt(room, trimmed, 'qwen'), options });
      room._activeQuery = query;
      markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
      persistQuerySessionId(room, query);
      broadcastRoom(room, {
        type: 'sdkRunProgress',
        runId,
        phase: 'stream',
        transport: 'qwen',
      }, { log: false });
      confirmDelegationReportsFromRoom(room);
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
        errorMessage = resolveReadOnlyGuardUserMessage(mode);
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
      clearEnforcedSdkMode(room);
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
export function ensureQwenRoom(sessionKey, deps = {}) {
  if (!getEffectiveQwenApiKey()) {
    return {
      error: 'Missing Qwen Cloud API key (QWEN_API_KEY or Settings → Harness → Qwen).',
      code: 'missing_api_key',
    };
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    return { error: 'Qwen chat not found for this session.', code: 'chat_not_found' };
  }
  if (!isQwenChat(chat)) {
    return { error: 'Qwen chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = qwenRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || resolveDefaultQwenModel(),
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      qwenSessionId: typeof chat.qwenSessionId === 'string' ? chat.qwenSessionId : '',
      currentRun: null,
      _activeQuery: null,
      _abortController: null,
      _lastResult: null,
      _planGuardTriggered: false,
      _qwenNormalizer: createQwenEventNormalizer(),
      _pendingQuestions: new Map(),
      _qwenQuestionWaiters: new Map(),
    });
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
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  bindQwenPromptRunner(room, chat);
  return { room, chat };
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleQwenAgentWebSocket(ws, sessionKey, deps) {
  const ensured = ensureQwenRoom(sessionKey, deps);
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
    transport: 'qwen',
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
    detachClient(room, ws, sessionKey);
  });
}

registerKernelChatRunAdapter({
  transport: 'qwen',
  rooms: qwenRooms,
  ensureRoom: ensureQwenRoom,
  waitingForInput: (room) => room._pendingQuestions instanceof Map && room._pendingQuestions.size > 0,
});

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
    pendingQuestions: room._pendingQuestions instanceof Map
      ? room._pendingQuestions.size
      : 0,
  };
}
