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
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { hasCodexCredentials } from './codex-credentials.js';
import { isCodexCliFound, getCodexCliMissingHint } from './codex-cli.js';
import { loadCodexSdk } from './codex-sdk.js';
import { resolveDefaultCodexModel } from './codex-models.js';
import { buildCodexClientOptions } from './codex-thread-options.js';
import { formatCodexExecFailure } from './codex-exec-error.js';
import { ensureCodexHomeDir } from './codex-home.js';

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
  afterBroadcast: trackSdkRoomRunOutcome,
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
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
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
    room.sdkMode = mode === 'plan' ? 'plan' : 'agent';
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
        status = 'cancelled';
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
    detachClient(room, ws, sessionKey);
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
