import { createHostedToolPermissionGate, handleHostedToolPermissionReply } from '../../lib/approval/hosted-tool-permission.ts';
/**
 * WebSocket rooms for the Antigravity agent harness — SDK-compatible event
 * protocol over the official Antigravity ACP runtime.
 */

import { randomUUID } from 'crypto';
import { rejectArchivedRoomPromptAsync } from '../../lib/chat-message-guard.js';
import { getChatByCursorSessionIdAsync, updateChatAsync } from '../../lib/persist/chats-persist.js';
import { resolveExecutionFolderForChat } from '../../lib/execution-folder.js';
import { isAntigravityCliFound } from './antigravity-config.js';
import { runAntigravityPrompt as runAntigravityAcp } from './antigravity-client.js';
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode } from '../../lib/sdk/sdk-mode.ts';
import { buildAgentHelloPayload } from '../../lib/sdk/sdk-ws-handshake.ts';
import { sendSdkChatNotFoundAndClose } from '../../lib/sdk/sdk-ws-chat-gone.ts';
import { abortRoomController, createAgentRoomKernel } from '../../lib/agent-harness/room-kernel.ts';
import { buildUserEvent } from '../../lib/agent-harness/event-normalizer.ts';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../../lib/prompt-ui-text.js';
import {
  setActiveSelection,
  readClientSkillSelection,
  selectionFromSkillIds,
  withSkillSelection,
} from '../../lib/skills/skill-selection.js';
import { drainOnePendingPrompt } from '../../lib/agent-harness/pending-prompt-drain.ts';
import { handleQueueControlMessage } from '../../lib/agent-harness/queue-controls.ts';
import { isAntigravityChat } from '../../lib/agent-transport.js';
import { decorateHarnessPrompt } from '../../lib/sdk/harness-plan-prompt.ts';
import { bindHarnessPlanSync } from '../../lib/sdk/harness-plan-sync.ts';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../../lib/delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../../lib/delegation-report-context.js';
import { registerChatRunAdapter } from '../../lib/chat-run-service.js';
import { canAcceptNewRun } from '../../lib/update-gate.js';
import { msg } from '../../lib/messages.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../../lib/mcp/mcp-session.js';
import { isScoutReadOnlyChatId } from '../../lib/workspace-scout-chat.js';
import { advanceRoomContextEpoch, CONTEXT_RESTART_REASON, recordContextRestart } from '../../lib/usage/context-restarts.ts';
import { classifyAntigravityContextReading, parseAntigravityNativeCommand } from './antigravity-context.js';
import {
  enforceWatcherOrchestratorMcpGate,
  stampWatcherOrchestratorRoom,
} from '../../lib/mcp/watcher-orchestrator-mcp-gate.js';

const kernel = createAgentRoomKernel({
  transport: 'antigravity',
  logLabel: 'antigravity-ws',
  goneMessage: 'Antigravity chat not found for this session.',
  afterBroadcast: noteDelegationRoomEvent,
});
const antigravityRooms = kernel.rooms;
const {
  broadcastRoom,
  applySdkModeIfChanged,
  persistRoomEvent,
  flushPersistBuffer,
  attachClient,
  detachClient,
  scheduleEventLogReplay,
} = kernel;
const DEFAULT_ANTIGRAVITY_MODEL = 'default';

/**
 * Clear the meter for a context that no longer exists (compaction or a lost
 * session) and tell the user why.
 *
 * @param {any} room
 * @param {string} noticeType
 * @param {string} message
 */
function emitAntigravityContextReset(room, noticeType, message) {
  room._antigravityLastContextTotal = null;
  broadcastRoom(room, { type: 'sdkEvent', event: { type: 'context_usage', reset: true, observedAt: new Date().toISOString() } });
  broadcastRoom(room, { type: 'sdkEvent', event: { kind: 'notice', noticeType, message } });
}

/**
 * The resumed session replayed no history: Antigravity created an empty one.
 *
 * @param {any} room
 */
function handleAntigravitySessionDrop(room) {
  recordContextRestart({ chatId: room.chatId, harness: 'antigravity', reason: CONTEXT_RESTART_REASON.SESSION_DROP, room });
  emitAntigravityContextReset(room, 'session_drop',
    'Antigravity no longer has this conversation (its saved session is gone); the model starts without the earlier messages.');
}

/**
 * Route one `context_usage` reading through compaction detection.
 *
 * @param {any} room
 * @param {Record<string, any>} event
 * @param {string} command native command of this turn, '' for a normal prompt
 * @returns {boolean} true when the reading should still be broadcast
 */
function applyAntigravityContextReading(room, event, command) {
  const kind = classifyAntigravityContextReading({ previousTotal: room._antigravityLastContextTotal, event, command });
  if (kind === 'compacted_by_command') {
    advanceRoomContextEpoch(room, 'compaction');
    emitAntigravityContextReset(room, 'compact', 'Antigravity compacted the conversation context.');
    return false;
  }
  if (kind === 'compacted') {
    advanceRoomContextEpoch(room, 'compaction');
    emitAntigravityContextReset(room, 'compact', 'Antigravity compacted the conversation context automatically.');
  }
  const total = Number(event?.usage?.totalTokens);
  room._antigravityLastContextTotal = Number.isFinite(total) && total > 0 ? total : null;
  return true;
}

/**
 * @param {any} room
 * @param {any} chat
 */
function drainAntigravityQueue(room, chat) {
  drainOnePendingPrompt(room, (/** @type {any} */ next) => {
    void runAntigravityPrompt(room, chat, next.text, next.mode, next.displayText || '', next.selection, undefined, true);
  });
}

/**
 * @param {any} room
 * @param {string} text
 * @param {string} [modeOverride]
 * @param {string} [displayText]
 */
function enqueueAntigravityPrompt(room, text, modeOverride, displayText, selection = null) {
  const uiText = resolvePromptUiText(text, displayText);
  const item = { text, mode: normalizeSdkMode(modeOverride || room.sdkMode) };
  if (uiText && uiText !== text) item.displayText = uiText;
  withSkillSelection(item, selection);
  room.pendingPrompts.push(item);
  broadcastRoom(room, { type: 'sdkQueued', text: uiText || text, position: room.pendingPrompts.length });
  kernel.sendRoomState(room);
}

/**
 * @param {string} sessionKey
 */
export function disposeAntigravityRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} deps
 * @returns {Promise<{ room: any, chat: any } | { error: string, code: string }>}
 */
export async function ensureAntigravityRoom(sessionKey, deps) {
  const chat = await getChatByCursorSessionIdAsync(sessionKey);
  if (!chat || !isAntigravityChat(chat)) {
    return { error: 'Antigravity chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = antigravityRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || DEFAULT_ANTIGRAVITY_MODEL,
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      abortController: null,
      antigravitySessionId: chat.antigravitySessionId || '',
    });
    antigravityRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || DEFAULT_ANTIGRAVITY_MODEL;
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
  }
  bindHarnessPlanSync(room, deps);
  await bindRoomToDelegation(room, deps);
  stampWatcherOrchestratorRoom(room, chat, deps);
  room.drainQueue = () => drainAntigravityQueue(room, chat);
  room.cancelCurrentRun = () => {
    room.cancelled = true;
    abortRoomController(room);
  };
  return { room, chat };
}

/**
 * @param {any} room
 * @param {any} chat
 * @param {string} text
 * @param {string} [modeOverride]
 * @param {string} [displayText]
 * @param {unknown} [selection] Explicit skill IDs / mention policy of this prompt.
 */
async function runAntigravityPrompt(room, chat, text, modeOverride, displayText = '', selection = null, onStarted = (_runId) => {}, fromQueue = false) {
  // Callers fire this without awaiting: a storage error here must not become a
  // fatal unhandled rejection.
  try {
    if (await rejectArchivedRoomPromptAsync(room, broadcastRoom)) return;
  } catch (error) {
    broadcastRoom(room, { type: 'sdkError', code: 'chat_lookup_failed', message: error instanceof Error ? error.message : String(error) });
    return;
  }
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const uiText = resolvePromptUiText(trimmed, displayText);
  if (room.busy) {
    enqueueAntigravityPrompt(room, trimmed, modeOverride, displayText, selection);
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
  setActiveSelection(room, selection);
  room.cancelled = false;
  room.abortController = new AbortController();
  const runId = randomUUID();
  room.currentRun = { id: runId, startedAt: Date.now() };
  const mode = normalizeSdkMode(modeOverride || room.sdkMode);
  room.sdkMode = mode;
  beginEnforcedSdkMode(room, mode);
  syncRoomDelegationAssignment(room);
  broadcastRoom(room, { type: 'sdkPromptStarted', runId, text: uiText, fromQueue, remaining: room.pendingPrompts.length });
  onStarted(runId);
  broadcastRoom(room, { type: 'sdkBusy', busy: true }, { log: false });
  persistRoomEvent(room, { kind: 'localUser', text: uiText }, true);
  broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(uiText) });
  let reportsConfirmed = false;
  const confirmReports = () => {
    if (reportsConfirmed) return;
    reportsConfirmed = true;
    confirmDelegationReportsFromRoom(room);
  };
  let status = 'completed';
  let detail = '';
  try {
    // A native command only works as the first text of the prompt: send it bare.
    const command = parseAntigravityNativeCommand(trimmed, room.antigravityCommands);
    const prompt = command ? trimmed : await decorateHarnessPrompt(room, trimmed, 'antigravity');
    const mcpContext = buildMcpRuntimeContext({ chat, room, harness: 'antigravity', mode });
    const mcpPrep = prepareHarnessMcp(mcpContext);
    const mcpBlock = await enforceWatcherOrchestratorMcpGate({
      chat, room, mcpPrep, mcpContext, sessionStartedAt: room.currentRun.startedAt,
    });
    if (mcpBlock) throw new Error(mcpBlock.message);
    await runAntigravityAcp({
      cwd: room.cwd,
      model: room.modelId,
      sessionId: room.antigravitySessionId,
      prompt,
      mode,
      assignment: room.delegationAssignment,
      scoutReadOnly: isScoutReadOnlyChatId(room.chatId),
      mcpServers: mcpPrep.mcpServers,
      signal: room.abortController.signal,
      turnId: runId,
      checkPermission: createHostedToolPermissionGate({ harness: 'antigravity', room, broadcastRoom, sendRoomState: kernel.sendRoomState }),
      onConfiguration: (configuration) => { room.effectiveConfiguration = configuration; },
      onCommands: (names) => { room.antigravityCommands = names; },
      onSessionDropped: async () => { handleAntigravitySessionDrop(room); },
      onSession: async (sessionId) => {
        room.antigravitySessionId = sessionId;
        await updateChatAsync(chat.id, { antigravitySessionId: sessionId });
        markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
      },
      onEvent: (event) => {
        confirmReports();
        if (event?.type === 'context_usage' && !applyAntigravityContextReading(room, event, command)) return;
        broadcastRoom(room, { type: 'sdkEvent', event });
      },
    });
    confirmReports();
  } catch (error) {
    status = room.cancelled ? 'cancelled' : 'error';
    detail = error instanceof Error ? error.message : String(error);
  } finally {
    if (room.cancelled) status = 'cancelled';
    room.busy = false;
    room.abortController = null;
    room.currentRun = null;
    clearEnforcedSdkMode(room);
    broadcastRoom(room, { type: 'sdkBusy', busy: false });
    broadcastRoom(room, { type: 'sdkRunFinished', runId, status, lastErrorMessage: detail });
    if (status === 'error') broadcastRoom(room, { type: 'sdkError', code: 'antigravity_error', message: detail });
    flushPersistBuffer(room);
    kernel.sendRoomState(room);
    drainAntigravityQueue(room, chat);
  }
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleAntigravityAgentWebSocket(ws, sessionKey, deps) {
  if (!isAntigravityCliFound()) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'missing_cli',
        message: 'Antigravity CLI is missing. Install agy, then sign in in Settings → Harness → Antigravity.',
      }));
    }
    ws.close();
    return;
  }
  const ensured = await ensureAntigravityRoom(sessionKey, deps);
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
    transport: 'antigravity',
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
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'opencodePermissionReply') {
      handleHostedToolPermissionReply(/** @type {any} */ (room), msg);
      return;
    }
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
      applySdkModeIfChanged(room, msg.mode, { chatId: chat.id, updateChat: updateChatAsync });
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void runAntigravityPrompt(room, chat, msg.text, msg.mode, readClientDisplayText(msg), readClientSkillSelection(msg));
    }
  });

  ws.on('close', () => {
    detachClient(room, ws, sessionKey);
  });
}

/**
 * @param {{ chat: any, prompt: string, mode?: string, displayText?: string, selectedSkillIds?: string[], deps?: any }} input
 */
export async function startAntigravityChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const ensured = await ensureAntigravityRoom(sessionKey, input.deps || {});
  if ('error' in ensured) {
    const error = Object.assign(new Error(ensured.error), { code: ensured.code });
    throw error;
  }
  const { room, chat } = ensured;
  if (room.busy) {
    const error = Object.assign(new Error('Recipient is busy'), { code: 'recipient_busy' });
    throw error;
  }
  room.serverHold = true;
  const runId = await new Promise((resolve, reject) => {
    runAntigravityPrompt(room, chat, input.prompt, input.mode, input.displayText || '', selectionFromSkillIds(input.selectedSkillIds), resolve)
      .then(() => reject(new Error('Antigravity run was not started')))
      .catch(reject);
  });
  return { runId: String(runId), accepted: true };
}

/**
 * @param {{ chat: any, runId?: string }} input
 */
export async function cancelAntigravityChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const room = antigravityRooms.get(sessionKey);
  if (!room) return;
  if (input.runId && room.currentRun?.id && room.currentRun.id !== input.runId) return;
  room.cancelled = true;
  abortRoomController(room);
}

registerChatRunAdapter({
  transport: 'antigravity',
  start: startAntigravityChatRun,
  cancel: cancelAntigravityChatRun,
  getState({ chat, runId }) {
    const room = antigravityRooms.get(String(chat?.cursorSessionId || ''));
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
export function getAntigravityRoomDiag(sessionKey) {
  const room = antigravityRooms.get(sessionKey);
  if (!room) return null;
  return {
    transport: 'antigravity',
    busy: !!room.busy,
    modelId: room.modelId,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    sessionId: room.antigravitySessionId,
    effectiveConfiguration: room.effectiveConfiguration || null,
  };
}

/**
 * @param {string} sessionKey
 * @param {string} model
 */
export function syncAntigravityRoomModelFromChat(sessionKey, model) {
  const room = antigravityRooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (!nextModel || nextModel === room.modelId) return;
  room.modelId = nextModel;
  // Same ACP session, but the new model starts with a cold cache and another window.
  room._antigravityLastContextTotal = null;
  recordContextRestart({ chatId: room.chatId, harness: 'antigravity', reason: CONTEXT_RESTART_REASON.MODEL_CHANGE, room });
}
