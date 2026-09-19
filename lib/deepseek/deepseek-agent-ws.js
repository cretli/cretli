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
import { buildAssistantDeltaEvent, buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { normalizeDeepSeekNotification } from '../agent-harness/deepseek-event-normalizer.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../delegation-run-bridge.js';
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
import {
  pinDeepSeekRootSessionId,
  resolveDeepSeekRunStatus,
  shouldRetryDeepSeekRunWithoutSession,
} from './deepseek-run-outcome.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';

/**
 * A sessionId is only valid for the live dsh process. Reusing it after a
 * rebuild collides with the persisted log and the SDK returns an empty idle.
 * The dropped id is kept in memory so the next turn can tell the user that the
 * model context restarted instead of silently forgetting the conversation.
 * @param {any} room
 * @param {string} [reason]
 */
function clearDeepSeekSession(room, reason = '') {
  if (!room) return;
  const previous = String(room.deepseekSessionId || '').trim();
  room.deepseekSessionId = '';
  if (room.deepseekChildSessionIds instanceof Set) room.deepseekChildSessionIds.clear();
  if (room.deepseekChildDiagnostics instanceof Map) room.deepseekChildDiagnostics.clear();
  if (room.chatId) setChatDeepSeekSessionId(room.chatId, '');
  if (previous) {
    room.previousDeepSeekSessionId = previous;
    room._sessionResetReason = reason || room._sessionResetReason || 'the DeepSeek runtime restarted';
  }
}

/**
 * @param {any} room
 * @returns {Set<string>}
 */
function ensureChildSessions(room) {
  if (!(room.deepseekChildSessionIds instanceof Set)) {
    room.deepseekChildSessionIds = new Set();
  }
  return room.deepseekChildSessionIds;
}

/**
 * @param {any} room
 * @returns {Map<string, string>}
 */
function ensureChildDiagnostics(room) {
  if (!(room.deepseekChildDiagnostics instanceof Map)) {
    room.deepseekChildDiagnostics = new Map();
  }
  return room.deepseekChildDiagnostics;
}

/**
 * Prefer the pinned parent id over `result.sessionId` when a child is already known.
 * @param {any} room
 * @param {unknown} [result]
 * @param {string} [usedSessionId]
 * @returns {{ rootSessionId: string }}
 */
export function resolveDeepSeekRoomRunScope(room, result, usedSessionId = '') {
  const rec = result && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : null;
  return {
    rootSessionId: pinDeepSeekRootSessionId({
      roomRootId: room?.deepseekSessionId,
      usedSessionId,
      resultSessionId: rec?.sessionId,
      childSessionIds: room?.deepseekChildSessionIds,
    }),
  };
}

/**
 * Parent turn outcome, scoped so a child finish cannot override it.
 * @param {any} room
 * @param {unknown} result
 * @param {string} [usedSessionId]
 * @returns {{ status: 'completed' | 'error' | 'cancelled', errorMessage: string, reasonKind: string, isSessionCollision: boolean }}
 */
export function resolveDeepSeekRoomOutcome(room, result, usedSessionId = '') {
  return resolveDeepSeekRunStatus(result, resolveDeepSeekRoomRunScope(room, result, usedSessionId));
}

/**
 * Root session id stays on the parent dsh session. Child ids from workflow
 * subagents must not replace it or persist onto the chat.
 * @param {any} room
 * @param {string} sessionId
 * @param {boolean} [isChild]
 */
function rememberRootDeepSeekSession(room, sessionId, isChild = false) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return;
  const children = ensureChildSessions(room);
  if (isChild) {
    children.add(id);
    return;
  }
  if (children.has(id)) return;
  if (room.deepseekSessionId && room.deepseekSessionId !== id) {
    children.add(id);
    return;
  }
  if (room.deepseekSessionId === id) return;
  room.deepseekSessionId = id;
  if (room.chatId) setChatDeepSeekSessionId(room.chatId, id);
}

/**
 * Close the live harness and serialize successive closes so a queued run never
 * builds a new runtime while the previous one is still tearing down.
 * @param {any} room
 * @returns {Promise<void>}
 */
function closeRuntime(room) {
  const harness = room?._harness;
  if (room) room._harness = null;
  clearDeepSeekSession(room);
  const prior = room && room._closePromise ? room._closePromise : Promise.resolve();
  const closing = prior.catch(() => {}).then(async () => {
    if (!harness || typeof harness.close !== 'function') return;
    try {
      await harness.close();
    } catch (err) {
      console.warn('[deepseek-ws] runtime close failed:', err?.message || err);
    }
  });
  if (room) room._closePromise = closing;
  return closing;
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
  applySdkModeIfChanged,
  persistRoomEvent,
  flushPersistBuffer,
  sendRoomState,
  attachClient,
  detachClient,
  scheduleEventLogReplay,
} = kernel;

/**
 * Tell the user, once, that the model session was replaced and earlier turns
 * are no longer in its context.
 * @param {any} room
 */
function broadcastSessionResetNotice(room) {
  const reason = room && room._sessionResetReason;
  if (!reason) return;
  const previous = String(room.previousDeepSeekSessionId || '').trim();
  room._sessionResetReason = '';
  const detail = previous ? ` (previous session ${previous})` : '';
  broadcastRoom(room, {
    type: 'sdkEvent',
    event: buildAssistantDeltaEvent(
      `\n[DeepSeek started a new model session${detail}: ${reason}. Earlier turns are no longer in the model context.]\n`,
    ),
  });
}

/**
 * The dsh runtime accepts the MCP config only when it starts, so the applied
 * revision is recorded after the first run rather than after construction.
 * @param {any} room
 */
function markHarnessMcpApplied(room) {
  const pending = room && room._pendingMcpApply;
  if (!pending) return;
  room._pendingMcpApply = null;
  markMcpConfigApplied(pending.context, pending.servers, pending.revision);
}

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
  const assignment = room.delegationAssignment;
  const decision = resolvePlanModeSdkEventDecision({
    transport: 'deepseek',
    mode,
    assignment,
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
    message: resolveReadOnlyGuardUserMessage(mode, assignment),
    toolName: typeof event.name === 'string' ? event.name : '',
  });
  return true;
}

/**
 * @param {any} room
 * @param {unknown} notification
 */
/**
 * Apply one DSH notification to room scope and return events that may broadcast.
 * Child session.event never becomes a parent assistant message.
 * @param {any} room
 * @param {unknown} notification
 * @returns {Array<Record<string, unknown>>}
 */
export function applyDeepSeekRoomNotification(room, notification) {
  const children = ensureChildSessions(room);
  const diagnostics = ensureChildDiagnostics(room);
  const items = normalizeDeepSeekNotification(notification, {
    rootSessionId: String(room.deepseekSessionId || ''),
    childSessionIds: children,
    childDiagnostics: diagnostics,
  });
  const broadcast = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'tool_call' && item.name === 'subagent' && typeof item.call_id === 'string' && item.call_id) {
      children.add(item.call_id);
    }
    if (item.kind === 'session' || item.kind === 'status') {
      rememberRootDeepSeekSession(room, String(item.sessionId || ''), item.child === true);
      continue;
    }
    if (typeof item.sessionId === 'string' && children.has(item.sessionId) && item.name !== 'subagent') {
      continue;
    }
    broadcast.push(item);
  }
  return broadcast;
}

function handleNotification(room, notification) {
  const events = applyDeepSeekRoomNotification(room, notification);
  for (const item of events) {
    if (applyPlanGuardIfNeeded(item, room)) return;
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}

/**
 * @param {any} room
 * @returns {Promise<object | null>}
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
  await closeRuntime(room);
  if (room.cancelled) return null;
  const sdk = await loadDeepSeekSdk();
  if (room.cancelled) return null;
  const DeepSeekHarness = sdk.DeepSeekHarness;
  if (typeof DeepSeekHarness !== 'function') {
    throw new Error('DeepSeekHarness export is missing from @deepseek-ai/dsh-sdk-client.');
  }
  const harness = new DeepSeekHarness(buildDeepSeekHarnessOptions({
    cwd: room.cwd,
    model: room.modelId,
    mcpBridge: mcpPrep.bridge,
  }));
  if (room.cancelled) {
    try {
      await harness.close();
    } catch {
      // cancelled before the runtime ever started
    }
    return null;
  }
  room._harness = harness;
  room._mcpRevision = mcpPrep.revision;
  room._pendingMcpApply = { context: mcpContext, servers: mcpPrep.servers, revision: mcpPrep.revision };
  return harness;
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
   * @param {any} harness
   * @param {string} prompt
   * @returns {Promise<{ result: unknown, scope: { rootSessionId: string } }>}
   */
  async function runDeepSeekTurn(harness, prompt) {
    const usedSessionId = String(room.deepseekSessionId || '').trim();
    const ownsHarness = () => room._harness === harness;
    /** @type {{ sessionId?: string, onNotification: (notification: unknown) => void }} */
    const runOptions = {
      onNotification: (notification) => {
        if (room.cancelled || !ownsHarness()) return;
        handleNotification(room, notification);
      },
    };
    if (usedSessionId) runOptions.sessionId = usedSessionId;
    let result = await harness.run(prompt, runOptions);
    markHarnessMcpApplied(room);
    let scope = resolveDeepSeekRoomRunScope(room, result, usedSessionId);
    if (!room.cancelled && ownsHarness()
      && shouldRetryDeepSeekRunWithoutSession(result, usedSessionId, scope)) {
      clearDeepSeekSession(room, 'the previous session collided with a persisted dsh log');
      broadcastSessionResetNotice(room);
      result = await harness.run(prompt, { onNotification: runOptions.onNotification });
      markHarnessMcpApplied(room);
      scope = resolveDeepSeekRoomRunScope(room, result, '');
    }
    if (!room.cancelled && ownsHarness() && scope.rootSessionId) {
      rememberRootDeepSeekSession(room, scope.rootSessionId);
    }
    return { result, scope };
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
    syncRoomDelegationAssignment(room);
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
      if (!harness || room.cancelled) {
        status = 'cancelled';
      } else {
        broadcastRoom(room, {
          type: 'sdkRunProgress',
          runId,
          phase: 'stream',
          transport: 'deepseek',
        }, { log: false });
        broadcastSessionResetNotice(room);
        confirmDelegationReportsFromRoom(room);
        const { result, scope } = await runDeepSeekTurn(
          harness,
          decorateHarnessPrompt(room, trimmed, 'deepseek'),
        );
        if (room._planGuardTriggered) {
          status = 'plan_guard_cancelled';
          errorMessage = resolveReadOnlyGuardUserMessage(mode, room.delegationAssignment);
        } else if (room.cancelled) {
          status = 'cancelled';
        } else {
          const outcome = resolveDeepSeekRunStatus(result, scope);
          if (outcome.status === 'error') {
            status = 'error';
            errorMessage = outcome.errorMessage;
          } else if (outcome.status === 'cancelled') {
            status = 'cancelled';
          }
        }
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
      _closePromise: null,
      _pendingMcpApply: null,
      previousDeepSeekSessionId: '',
      _sessionResetReason: '',
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
      applySdkModeIfChanged(room, msg.mode, { chatId: chat.id, updateChat });
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
