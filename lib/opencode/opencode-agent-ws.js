/**
 * WebSocket rooms for OpenCode agent harness — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import { readEnvAlias } from '../env-alias.js';
import {
  getChatByCursorSessionId,
  setChatOpenCodeSessionId,
  updateChat,
} from '../persist/chats-persist.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import {
  isQueuedPromptText,
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import { createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import {
  isOpenCodeEventForSession,
  normalizeOpenCodeEvent,
  parseOpenCodeModel,
  resolveOpenCodeSessionActivity,
} from '../agent-harness/opencode-event-normalizer.js';
import { buildAssistantFullEvent } from '../agent-harness/event-normalizer.js';
import { OpenCodeMessageRegistry, noteOpenCodeMessageFromEvent } from '../agent-harness/opencode-message-registry.js';
import {
  createOpenCodePromptRunWaiter,
  bumpOpenCodePromptRunActivity,
  notifyOpenCodePromptRunEnd,
  rejectOpenCodePromptRun,
  resolveOpenCodePromptTimeoutMs,
  resolveOpenCodePromptRunFromEvent,
  shouldBumpOpenCodePromptRunActivity,
} from './opencode-prompt-run.js';
import { isOpenCodeChat } from '../agent-transport.js';
import {
  getOrCreateOpenCodeInstance,
  releaseOpenCodeInstance,
} from './opencode-server-manager.js';
import { resolveOpenCodeModelForPrompt } from './opencode-model-resolve.js';
import {
  buildOpenCodeQuestionSdkEvent,
  postOpenCodeQuestionResponse,
  resolveOpenCodeQuestionResolvedRequestId,
} from './opencode-question.js';
import {
  buildOpenCodePermissionSdkEvent,
  buildOpenCodePlanPermissionRuleset,
  listOpenCodePermissionIdsForFailedTool,
  postOpenCodePermissionResponse,
  resolveOpenCodePermissionResolvedRequestId,
  shouldRejectOpenCodePlanPermission,
} from './opencode-permission.js';
import { ROOM_STATE_HEARTBEAT_INTERVAL_MS } from '../sdk/sdk-room-state.js';
import {
  getSdkToolCallName,
  PLAN_GUARD_USER_MESSAGE,
  resolvePlanModeSdkEventDecision,
} from '../sdk/sdk-plan-guard.js';
import { readSdkRoomRunOutcome, trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { schedulePendingPromptRun } from '../sdk/sdk-retry-delay.js';
import { decorateHarnessPrompt, HARNESS_PLAN_MODE_HINT } from '../sdk/harness-plan-prompt.js';
import { shouldExitPlanModeOnQuestionReply } from '../sdk/plan-approval-reply.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerChatRunAdapter } from '../chat-run-service.js';

const DEFAULT_OPENCODE_MODEL = 'opencode/x-preview-f-free';
const PLAN_MODE_SYSTEM = HARNESS_PLAN_MODE_HINT;

/**
 * Abort SSE subscription, run-progress timer, and OpenCode instance lease.
 * @param {any} room
 */
function abortOpenCodeRoom(room) {
  if (!room) return;
  room.cancelled = true;
  stopOpenCodeRunProgress(room);
  if (room._eventSubscriptionAbort) {
    try {
      room._eventSubscriptionAbort.abort();
    } catch {
      // ignore
    }
  }
  room._eventSubscriptionAbort = null;
  if (typeof room._openCodeInstanceRelease === 'function') {
    room._openCodeInstanceRelease();
    room._openCodeInstanceRelease = null;
    return;
  }
  releaseOpenCodeInstance(room._openCodeInstanceWorkspaceFolder || room.cwd);
}

const kernel = createAgentRoomKernel({
  transport: 'opencode',
  logLabel: 'opencode-ws',
  goneMessage: 'OpenCode chat not found for this session.',
  abortRoom: abortOpenCodeRoom,
  afterBroadcast: (room, payload) => {
    trackSdkRoomRunOutcome(room, payload);
    noteDelegationRoomEvent(room, payload);
  },
});
const openCodeRooms = kernel.rooms;
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
 * @param {string} workspaceFolder
 * @returns {string}
 */
function resolveOpenCodeInstanceWorkspaceFolder(workspaceFolder) {
  const forcedWorkspaceFolder = readEnvAlias({ current: 'CRETLI_OPENCODE_INSTANCE_FOLDER', legacy: 'CURSOR_REMOTE_OPENCODE_INSTANCE_FOLDER' }).trim();
  if (forcedWorkspaceFolder) return forcedWorkspaceFolder;
  return String(workspaceFolder || '').trim();
}

/**
 * @param {Array<Record<string, unknown>>} parts
 * @returns {string}
 */
function readOpenCodeTextParts(parts) {
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type !== 'text') continue;
    if (typeof part.text !== 'string' || !part.text.trim()) continue;
    text += part.text;
  }
  return text.trim();
}

/**
 * @param {Array<Record<string, unknown>>} messages
 * @param {string} [promptText]
 * @returns {string}
 */
export function extractOpenCodeAssistantTextFromMessages(messages, promptText = '') {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const normalizedPromptText = String(promptText || '').trim();
  let matchedUserId = '';
  if (normalizedPromptText) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const info = message?.info && typeof message.info === 'object' ? message.info : null;
      if (!info || info.role !== 'user') continue;
      const promptCandidate = readOpenCodeTextParts(message?.parts);
      if (promptCandidate === normalizedPromptText) {
        matchedUserId = typeof info.id === 'string' ? info.id : '';
        break;
      }
    }
  }
  const findAssistantText = (parentId) => {
    let foundMatchingAssistant = false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const info = message?.info && typeof message.info === 'object' ? message.info : null;
      if (!info || info.role !== 'assistant') continue;
      if (parentId) {
        const assistantParentId = typeof info.parentID === 'string' ? info.parentID : '';
        if (assistantParentId !== parentId) continue;
        foundMatchingAssistant = true;
      }
      const assistantText = readOpenCodeTextParts(message?.parts);
      if (assistantText) return assistantText;
    }
    if (parentId && foundMatchingAssistant) {
      return '';
    }
    return '';
  };
  if (matchedUserId) {
    const matchedText = findAssistantText(matchedUserId);
    if (matchedText) return matchedText;
    return '';
  }
  if (normalizedPromptText) {
    return '';
  }
  return findAssistantText('');
}

/**
 * @param {unknown} response
 * @returns {Array<Record<string, unknown>>}
 */
function readOpenCodeMessagesFromResponse(response) {
  if (!response || typeof response !== 'object') return [];
  const payload = response.data && typeof response.data === 'object'
    ? response.data
    : response;
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object' && Array.isArray(payload.messages)) {
    return payload.messages;
  }
  return [];
}

/**
 * @param {import('@opencode-ai/sdk').OpencodeClient} client
 * @param {any} room
 * @param {string} promptText
 * @returns {Promise<string>}
 */
async function recoverOpenCodeAssistantTextFromSession(client, room, promptText) {
  if (!client || !room?.opencodeSessionId || !room?.cwd) return '';
  const response = await client.session.messages({
    path: { id: room.opencodeSessionId },
    query: { directory: room.cwd },
  });
  const messages = readOpenCodeMessagesFromResponse(response);
  return extractOpenCodeAssistantTextFromMessages(messages, promptText);
}

/**
 * @returns {number}
 */
function resolveOpenCodeSessionRecoveryPollMs() {
  const fromEnv = Number.parseInt(String(process.env.OPENCODE_RECOVERY_POLL_MS ?? ''), 10);
  if (!Number.isFinite(fromEnv) || fromEnv <= 0) return 250;
  return Math.max(250, fromEnv);
}

/**
 * @param {import('@opencode-ai/sdk').OpencodeClient} client
 * @param {any} room
 * @param {string} promptText
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function recoverOpenCodeAssistantTextDuringWait(client, room, promptText, timeoutMs) {
  const pollMs = resolveOpenCodeSessionRecoveryPollMs();
  const startedAt = Date.now();
  const safeTimeoutMs = Math.max(1000, Number(timeoutMs) || 0);
  while (Date.now() - startedAt < safeTimeoutMs) {
    if (room.cancelled || !room._awaitingPromptFinish || !room._promptRunWaiter) {
      return '';
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (room.cancelled || !room._awaitingPromptFinish || !room._promptRunWaiter) {
      return '';
    }
    let recoveredText = '';
    try {
      recoveredText = await recoverOpenCodeAssistantTextFromSession(client, room, promptText);
    } catch {
      recoveredText = '';
    }
    if (!recoveredText) continue;
    notifyOpenCodePromptRunEnd(room, { status: 'completed' });
    return recoveredText;
  }
  return '';
}

/**
 * @param {any} room
 * @param {boolean} busy
 */
function broadcastBusyState(room, busy) {
  if (!!room._lastBroadcastBusy === busy) return;
  room._lastBroadcastBusy = busy;
  broadcastRoom(room, { type: 'sdkBusy', busy }, { log: false });
}

function resetOpenCodeStreamContext(room) {
  room._openCodeStreamContext = {
    partTextAcc: new Map(),
    assistantTextByMessageId: new Map(),
    thinkingTextByMessageId: new Map(),
  };
}

/**
 * @param {any} room
 * @returns {string}
 */
function readLatestAssistantTextFromStreamContext(room) {
  const streamContext = room?._openCodeStreamContext;
  const assistantTextByMessageId =
    streamContext?.assistantTextByMessageId instanceof Map
      ? streamContext.assistantTextByMessageId
      : null;
  if (!assistantTextByMessageId || assistantTextByMessageId.size === 0) return '';
  const values = Array.from(assistantTextByMessageId.values());
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const text = typeof values[index] === 'string' ? values[index].trim() : '';
    if (text) return text;
  }
  return '';
}

/**
 * @param {import('@opencode-ai/sdk').OpencodeClient} client
 * @param {any} room
 * @param {string} promptText
 * @param {number} maxWaitMs
 * @returns {Promise<string>}
 */
async function recoverOpenCodeAssistantTextAfterCompletion(client, room, promptText, maxWaitMs) {
  const pollMs = resolveOpenCodeSessionRecoveryPollMs();
  const safeMaxWaitMs = Math.max(1000, Number(maxWaitMs) || 0);
  const startedAt = Date.now();
  while (Date.now() - startedAt < safeMaxWaitMs) {
    if (room.cancelled) return '';
    let recoveredText = '';
    try {
      recoveredText = await recoverOpenCodeAssistantTextFromSession(client, room, promptText);
    } catch {
      recoveredText = '';
    }
    if (recoveredText) return recoveredText;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return '';
}

function emitOpenCodeRunProgress(room, progress) {
  if (!room?.clients?.size) return;
  const now = Date.now();
  const idleForMs = Math.max(0, now - progress.startedAt);
  const timeoutMs = Math.max(1, Number(progress.timeoutMs) || 1);
  const remainingMs = Math.max(0, timeoutMs - idleForMs);
  broadcastRoom(room, {
    type: 'sdkRunProgress',
    runId: progress.runId,
    phase: progress.phase,
    idleForMs,
    timeoutMs,
    remainingMs,
    transport: 'opencode',
  }, { log: false });
}

/**
 * @param {any} room
 * @param {string} runId
 * @param {number} timeoutMs
 */
function startOpenCodeRunProgress(room, runId, timeoutMs) {
  stopOpenCodeRunProgress(room);
  room._openCodeRunProgress = {
    runId,
    phase: 'started',
    startedAt: Date.now(),
    timeoutMs,
    timer: null,
  };
  emitOpenCodeRunProgress(room, room._openCodeRunProgress);
  room._openCodeRunProgress.timer = setInterval(() => {
    if (!room._openCodeRunProgress) return;
    emitOpenCodeRunProgress(room, room._openCodeRunProgress);
  }, ROOM_STATE_HEARTBEAT_INTERVAL_MS);
}

/**
 * @param {any} room
 * @param {string} phase
 */
function updateOpenCodeRunProgressPhase(room, phase) {
  if (!room?._openCodeRunProgress) return;
  room._openCodeRunProgress.phase = phase;
  emitOpenCodeRunProgress(room, room._openCodeRunProgress);
}

/**
 * @param {any} room
 */
function stopOpenCodeRunProgress(room) {
  if (!room?._openCodeRunProgress) return;
  if (room._openCodeRunProgress.timer) {
    clearInterval(room._openCodeRunProgress.timer);
  }
  room._openCodeRunProgress = null;
}

/**
 * @param {any} room
 * @param {string} [toolName]
 */
function emitOpenCodePlanGuardNotice(room, toolName) {
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    toolName: toolName || 'unknown',
    message: PLAN_GUARD_USER_MESSAGE,
  });
}

/**
 * Session errors are sdkError, not a fake assistant answer.
 * During a prompt run the waiter already ends with sdkError — skip the duplicate.
 *
 * @param {any} room
 * @param {Record<string, unknown>} sdkEvent
 */
function broadcastOpenCodeNormalizedEvent(room, sdkEvent) {
  if (!sdkEvent || typeof sdkEvent !== 'object') return;
  if (sdkEvent.kind === 'error') {
    const message = typeof sdkEvent.message === 'string' ? sdkEvent.message.trim() : '';
    if (!message || room._awaitingPromptFinish) return;
    broadcastRoom(room, {
      type: 'sdkError',
      code: 'opencode_error',
      message,
    });
    return;
  }
  const planDecision = resolvePlanModeSdkEventDecision({
    transport: 'opencode',
    mode: room.sdkMode,
    event: sdkEvent,
  });
  if (planDecision.notify) {
    emitOpenCodePlanGuardNotice(room, getSdkToolCallName(sdkEvent) || 'unknown');
  }
  broadcastRoom(room, { type: 'sdkEvent', event: sdkEvent });
}

/**
 * @param {any} room
 * @param {string} runId
 * @param {string} message
 */
function broadcastOpenCodeRunError(room, runId, message) {
  const errorMessage = message || 'OpenCode session error';
  broadcastRoom(room, {
    type: 'sdkError',
    code: 'opencode_error',
    message: errorMessage,
  });
  broadcastRoom(room, {
    type: 'sdkRunFinished',
    runId,
    status: 'error',
    lastErrorCode: 'opencode_error',
    lastErrorMessage: errorMessage,
    remaining: room.pendingPrompts.length,
  }, { log: true });
}

/**
 * Persist Plan/Agent on the OpenCode room and chat, then sync session permissions.
 *
 * @param {any} room
 * @param {object} chat
 * @param {'plan' | 'agent'} mode
 * @param {{ reason?: string }} [options]
 */
async function applyOpenCodeRoomSdkMode(room, chat, mode, options = {}) {
  const normalized = normalizeSdkMode(mode);
  room.sdkMode = normalized;
  if (chat?.id) updateChat(chat.id, { sdkMode: normalized });
  /** @type {Record<string, unknown>} */
  const payload = { type: 'sdkMode', mode: normalized };
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (reason) payload.reason = reason;
  broadcastRoom(room, payload, { log: false });
  await syncOpenCodeSessionPlanPermissions(room, normalized);
}

/**
 * @param {any} room
 * @param {'plan' | 'agent'} mode
 */
async function syncOpenCodeSessionPlanPermissions(room, mode) {
  const policy = resolveHarnessPlanPolicy('opencode');
  if (!policy.denyMutatingTools) return;
  if (!room.opencodeSessionId) return;
  try {
    const client = await ensureOpenCodeClient(room);
    await client.session.update({
      path: { id: room.opencodeSessionId },
      query: { directory: room.cwd },
      body: { permission: buildOpenCodePlanPermissionRuleset(mode) },
    });
  } catch (err) {
    console.warn('[opencode] session permission sync failed:', err?.message || err);
  }
}

function hasPendingOpenCodeUserInput(targetRoom) {
  const questions = targetRoom?._pendingOpenCodeQuestions instanceof Map
    && targetRoom._pendingOpenCodeQuestions.size > 0;
  const permissions = targetRoom?._pendingOpenCodePermissions instanceof Map
    && targetRoom._pendingOpenCodePermissions.size > 0;
  return Boolean(questions || permissions);
}

/**
 * @param {any} room
 * @param {unknown} event
 */
function handleOpenCodeStreamEvent(room, event) {
  if (!isOpenCodeEventForSession(event, room.opencodeSessionId)) return;
  noteOpenCodeMessageFromEvent(event, room._openCodeMessageRegistry);
  const shouldBumpPromptRun = room._awaitingPromptFinish
    && shouldBumpOpenCodePromptRunActivity(event, { opencodeSessionId: room.opencodeSessionId });
  if (shouldBumpPromptRun) {
    bumpOpenCodePromptRunActivity(room);
  }
  const resolvedQuestionId = resolveOpenCodeQuestionResolvedRequestId(event, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (resolvedQuestionId) {
    if (room._pendingOpenCodeQuestions instanceof Map) {
      room._pendingOpenCodeQuestions.delete(resolvedQuestionId);
    }
    broadcastRoom(room, {
      type: 'opencodeQuestionResolved',
      requestId: resolvedQuestionId,
    }, { log: false });
  }
  const resolvedPermissionId = resolveOpenCodePermissionResolvedRequestId(event, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (resolvedPermissionId) {
    if (room._pendingOpenCodePermissions instanceof Map) {
      room._pendingOpenCodePermissions.delete(resolvedPermissionId);
    }
    broadcastRoom(room, {
      type: 'opencodePermissionResolved',
      requestId: resolvedPermissionId,
    }, { log: false });
    sendRoomState(room);
  }
  const permissionEvent = buildOpenCodePermissionSdkEvent(event, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (permissionEvent) {
    if (
      shouldRejectOpenCodePlanPermission(room.sdkMode, permissionEvent)
    ) {
      emitOpenCodePlanGuardNotice(room, String(permissionEvent.action || 'unknown'));
      void rejectOpenCodePlanPermission(room, permissionEvent);
      return;
    }
    if (!(room._pendingOpenCodePermissions instanceof Map)) {
      room._pendingOpenCodePermissions = new Map();
    }
    room._pendingOpenCodePermissions.set(String(permissionEvent.requestId), permissionEvent);
    bumpOpenCodePromptRunActivity(room);
    broadcastRoom(room, { type: 'sdkEvent', event: permissionEvent });
    sendRoomState(room);
    return;
  }
  const questionEvent = buildOpenCodeQuestionSdkEvent(event, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (questionEvent) {
    if (!(room._pendingOpenCodeQuestions instanceof Map)) {
      room._pendingOpenCodeQuestions = new Map();
    }
    room._pendingOpenCodeQuestions.set(String(questionEvent.requestId), questionEvent);
    bumpOpenCodePromptRunActivity(room);
    broadcastRoom(room, { type: 'sdkEvent', event: questionEvent });
    return;
  }
  const promptRun = room._awaitingPromptFinish
    ? resolveOpenCodePromptRunFromEvent(event, {
      opencodeSessionId: room.opencodeSessionId,
      hasPendingUserInput: hasPendingOpenCodeUserInput(room),
    })
    : null;
  if (promptRun && room._promptRunWaiter) {
    notifyOpenCodePromptRunEnd(room, promptRun);
  }
  const activity = resolveOpenCodeSessionActivity(event, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (activity === 'busy' && !room.busy) {
    room.busy = true;
    broadcastBusyState(room, true);
  }
  if (activity === 'idle' && room.busy && !room._awaitingPromptFinish) {
    room.busy = false;
    broadcastBusyState(room, false);
  }
  const sdkEvents = normalizeOpenCodeEvent(event, {
    opencodeSessionId: room.opencodeSessionId,
    messageRegistry: room._openCodeMessageRegistry,
    lastUserPromptText: room._lastUserPromptText,
    ...(room._openCodeStreamContext || {}),
  });
  for (const sdkEvent of sdkEvents) {
    broadcastOpenCodeNormalizedEvent(room, sdkEvent);
    const stalePermissionIds = listOpenCodePermissionIdsForFailedTool(
      room._pendingOpenCodePermissions,
      sdkEvent,
    );
    for (const requestId of stalePermissionIds) {
      room._pendingOpenCodePermissions.delete(requestId);
      broadcastRoom(room, {
        type: 'opencodePermissionResolved',
        requestId,
      }, { log: false });
      sendRoomState(room);
    }
  }
}

/**
 * @param {any} room
 */
async function ensureOpenCodeEventSubscription(room) {
  if (room._openCodeClient) return;
  if (room._openCodeInitPromise) {
    await room._openCodeInitPromise;
    return;
  }
  room._openCodeInitPromise = (async () => {
    const instanceWorkspaceFolder = resolveOpenCodeInstanceWorkspaceFolder(
      room._openCodeInstanceWorkspaceFolder || room.cwd
    );
    room._openCodeInstanceWorkspaceFolder = instanceWorkspaceFolder;
    const instance = await getOrCreateOpenCodeInstance({ workspaceFolder: instanceWorkspaceFolder });
    room._openCodeInstanceRelease = instance.release;
    room._openCodeClient = instance.client;
    if (room._eventSubscriptionStarted) return;
    room._eventSubscriptionStarted = true;
    const abort = new AbortController();
    room._eventSubscriptionAbort = abort;
    const subscription = await instance.client.event.subscribe({
      query: { directory: instanceWorkspaceFolder },
    });
    const stream = subscription?.stream || subscription?.data?.stream;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      console.warn('[opencode-ws] event subscription unavailable');
      return;
    }
    void (async () => {
      try {
        for await (const event of stream) {
          if (abort.signal.aborted) break;
          handleOpenCodeStreamEvent(room, event);
        }
        if (!abort.signal.aborted) {
          console.warn('[opencode-ws] event stream ended, scheduling re-subscribe');
          room._eventSubscriptionStarted = false;
          room._openCodeClient = null;
          room._openCodeInitPromise = null;
          if (room.clients?.size > 0) {
            void ensureOpenCodeEventSubscription(room).catch(() => {});
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          console.warn('[opencode-ws] event stream ended:', err?.message || err);
          room._eventSubscriptionStarted = false;
          room._openCodeClient = null;
          room._openCodeInitPromise = null;
          if (room.clients?.size > 0) {
            setTimeout(() => {
              if (room.clients?.size > 0) {
                void ensureOpenCodeEventSubscription(room).catch(() => {});
              }
            }, 1500);
          }
        }
      }
    })();
  })();
  try {
    await room._openCodeInitPromise;
  } catch (err) {
    room._openCodeInitPromise = null;
    room._eventSubscriptionStarted = false;
    room._openCodeClient = null;
    console.warn('[opencode-ws] failed to subscribe to events:', err?.message || err);
    throw err;
  }
}

/**
 * @param {any} room
 */
async function ensureOpenCodeClient(room) {
  if (room._openCodeClient) return room._openCodeClient;
  await ensureOpenCodeEventSubscription(room);
  if (!room._openCodeClient) {
    throw new Error('OpenCode client unavailable');
  }
  return room._openCodeClient;
}

/**
 * @param {any} room
 * @param {{ resetSession?: boolean }} [options]
 */
function recycleOpenCodeConnection(room, options = {}) {
  if (room?._eventSubscriptionAbort) {
    try {
      room._eventSubscriptionAbort.abort();
    } catch {
      // ignore
    }
  }
  room._eventSubscriptionAbort = null;
  room._eventSubscriptionStarted = false;
  room._openCodeClient = null;
  room._openCodeInitPromise = null;
  if (typeof room?._openCodeInstanceRelease === 'function') {
    room._openCodeInstanceRelease();
  }
  room._openCodeInstanceRelease = null;
  if (options.resetSession === true) {
    room.opencodeSessionId = '';
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function shouldRetryOpenCodeRun(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('timed out')
    || message.includes('event stream ended')
    || message.includes('client unavailable')
    || message.includes('fetch failed')
  );
}

/**
 * @param {any} room
 * @param {object} chat
 */
async function rejectOpenCodePlanPermission(room, permissionEvent) {
  const requestId = String(permissionEvent?.requestId || '').trim();
  if (!requestId) return;
  const instanceWorkspaceFolder = resolveOpenCodeInstanceWorkspaceFolder(
    room._openCodeInstanceWorkspaceFolder || room.cwd
  );
  room._openCodeInstanceWorkspaceFolder = instanceWorkspaceFolder;
  let instance = null;
  try {
    instance = await getOrCreateOpenCodeInstance({ workspaceFolder: instanceWorkspaceFolder });
    await postOpenCodePermissionResponse({
      baseUrl: instance.baseUrl,
      requestId,
      sessionId: String(permissionEvent.sessionId || room.opencodeSessionId || '').trim(),
      directory: instanceWorkspaceFolder,
      reply: 'reject',
      message: PLAN_GUARD_USER_MESSAGE,
    });
    broadcastRoom(room, {
      type: 'opencodePermissionResolved',
      requestId,
    }, { log: false });
    sendRoomState(room);
  } catch (err) {
    console.warn('[opencode] plan permission reject failed:', err?.message || err);
  } finally {
    instance?.release();
  }
}

/**
 * @param {any} room
 * @param {object} chat
 */
async function ensureOpenCodeSession(room, chat) {
  if (room.opencodeSessionId) return room.opencodeSessionId;
  const client = await ensureOpenCodeClient(room);
  const policy = resolveHarnessPlanPolicy('opencode');
  /** @type {Record<string, unknown>} */
  const body = { title: chat.title || chat.id || 'Cretli chat' };
  if (policy.denyMutatingTools && normalizeSdkMode(room.sdkMode) === 'plan') {
    body.permission = buildOpenCodePlanPermissionRuleset('plan');
  }
  const created = await client.session.create({
    query: { directory: room.cwd },
    body,
  });
  const session = created?.data ?? created;
  const sessionId = typeof session?.id === 'string' ? session.id : '';
  if (!sessionId) {
    throw new Error('OpenCode session.create returned no session id');
  }
  room.opencodeSessionId = sessionId;
  if (chat.id) setChatOpenCodeSessionId(chat.id, sessionId);
  return sessionId;
}

/**
 * @param {string} sessionKey
 */
export function disposeOpenCodeRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
}

/**
 * @param {string} sessionKey
 * @param {string} modelValue
 */
export function syncOpenCodeRoomModelFromChat(sessionKey, modelValue) {
  const room = openCodeRooms.get(sessionKey);
  if (!room) return;
  const normalized = String(modelValue || '').trim();
  if (!normalized) return;
  room.modelId = normalized;
}

/**
 * Bind prompt start/cancel onto an OpenCode room (WS and server-side start).
 * @param {any} room
 * @param {object} chat
 */
function bindOpenCodePromptRunner(room, chat) {
  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
  if (!(room._pendingOpenCodeQuestions instanceof Map)) {
    room._pendingOpenCodeQuestions = new Map();
  }
  if (!(room._pendingOpenCodePermissions instanceof Map)) {
    room._pendingOpenCodePermissions = new Map();
  }
  room.transport = 'opencode';
/**
 * @param {string} text
 * @param {string} [modeOverride]
 * @param {string} [displayText]
 */
function enqueuePrompt(text, modeOverride, displayText = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const uiText = resolvePromptUiText(trimmed, displayText);
  const item = { text: trimmed };
  if (uiText && uiText !== trimmed) item.displayText = uiText;
  room.pendingPrompts.push(item);
  broadcastRoom(room, {
    type: 'sdkQueued',
    position: room.pendingPrompts.length,
    text: uiText || trimmed,
  });
}

function drainNextPendingPrompt() {
  if (room.busy) return;
  if (hasPendingOpenCodeUserInput(room)) return;
  const next = room.pendingPrompts.shift();
  if (!next) return;
  schedulePendingPromptRun(next, (item) => {
    void runPrompt(item.text, undefined, true, item.displayText);
  });
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
  room._planGuardToolName = '';
  room._awaitingPromptFinish = true;
  const runId = randomUUID();
  room.currentRun = { id: runId, startedAt: Date.now() };
  room._lastUserPromptText = trimmed;
  resetOpenCodeStreamContext(room);
  const timeoutMs = resolveOpenCodePromptTimeoutMs();
  startOpenCodeRunProgress(room, runId, timeoutMs);
  if (modeOverride === 'plan' || modeOverride === 'agent') {
    room.sdkMode = normalizeSdkMode(modeOverride);
  }
  broadcastRoom(room, {
    type: 'sdkPromptStarted',
    runId,
    text: uiText,
    fromQueue: fromQueue === true,
    remaining: room.pendingPrompts.length,
  });
  sendRoomState(room);
  broadcastBusyState(room, true);
  persistRoomEvent(room, { kind: 'localUser', text: uiText }, true);
  const modelString = resolveOpenCodeModelForPrompt(
    String(room.modelId || chat.model || DEFAULT_OPENCODE_MODEL).trim() || DEFAULT_OPENCODE_MODEL
  );
  const parsedModel = parseOpenCodeModel(modelString);
  try {
    /** @type {{ status: 'completed' | 'error' | 'cancelled', message?: string } | null} */
    let runResult = null;
    /** @type {unknown} */
    let runError = null;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        updateOpenCodeRunProgressPhase(room, 'setup');
        const client = await ensureOpenCodeClient(room);
        await ensureOpenCodeSession(room, chat);
        const mode = normalizeSdkMode(room.sdkMode);
        await syncOpenCodeSessionPlanPermissions(room, mode);
        let recoveredAssistantText = '';
        /** @type {Record<string, unknown>} */
        const body = {
          parts: [{
            type: 'text',
            text: decorateHarnessPrompt(room, trimmed, 'opencode', { skipPlanHint: true }),
          }],
        };
        if (parsedModel) {
          body.model = parsedModel;
        }
        if (mode === 'plan' && resolveHarnessPlanPolicy('opencode').promptHint) {
          body.system = PLAN_MODE_SYSTEM;
        }
        const promptWaiter = createOpenCodePromptRunWaiter(room, timeoutMs);
        void recoverOpenCodeAssistantTextDuringWait(client, room, trimmed, timeoutMs)
          .then((text) => {
            if (!text) return;
            recoveredAssistantText = text;
          })
          .catch(() => {});
        await client.session.promptAsync({
          path: { id: room.opencodeSessionId },
          query: { directory: room.cwd },
          body,
        });
        confirmDelegationReportsFromRoom(room);
        updateOpenCodeRunProgressPhase(room, 'awaiting_first_event');
        runResult = room.cancelled
          ? { status: 'cancelled' }
          : await promptWaiter;
        const streamAssistantText = readLatestAssistantTextFromStreamContext(room);
        if (runResult.status === 'completed' && !streamAssistantText && !recoveredAssistantText) {
          recoveredAssistantText = await recoverOpenCodeAssistantTextAfterCompletion(
            client,
            room,
            trimmed,
            12000,
          );
        }
        if (runResult.status === 'completed' && !streamAssistantText && recoveredAssistantText) {
          broadcastRoom(room, {
            type: 'sdkEvent',
            event: buildAssistantFullEvent(recoveredAssistantText),
          });
        }
        runError = null;
        break;
      } catch (err) {
        if (room._promptRunWaiter?.reject) {
          rejectOpenCodePromptRun(room, err);
        }
        const message = err?.message || String(err);
        if (/timed out/i.test(message) && room.opencodeSessionId) {
          try {
            const client = await ensureOpenCodeClient(room);
            const recoveredAssistantText = await recoverOpenCodeAssistantTextFromSession(client, room, trimmed);
            if (recoveredAssistantText) {
              broadcastRoom(room, {
                type: 'sdkEvent',
                event: buildAssistantFullEvent(recoveredAssistantText),
              });
              runResult = { status: 'completed' };
              runError = null;
              break;
            }
          } catch {
            // ignore session-recovery failures
          }
          try {
            const client = await ensureOpenCodeClient(room);
            await client.session.abort({
              path: { id: room.opencodeSessionId },
              query: { directory: room.cwd },
            });
          } catch {
            // ignore abort failures after timeout
          }
        }
        const shouldRetry = attempt < maxAttempts && shouldRetryOpenCodeRun(err);
        if (!shouldRetry) {
          runError = err;
          break;
        }
        recycleOpenCodeConnection(room, { resetSession: true });
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    if (runError) {
      throw runError;
    }
    if (!runResult) {
      throw new Error('OpenCode run ended without result');
    }
    if (runResult.status === 'cancelled') {
      const status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      broadcastRoom(room, {
        type: 'sdkRunFinished',
        runId,
        status,
        lastErrorMessage: '',
        remaining: room.pendingPrompts.length,
      }, { log: true });
    } else if (runResult.status === 'error') {
      broadcastOpenCodeRunError(room, runId, runResult.message || 'OpenCode session error');
    } else {
      broadcastRoom(room, {
        type: 'sdkRunFinished',
        runId,
        status: 'completed',
        lastErrorMessage: '',
        remaining: room.pendingPrompts.length,
      }, { log: true });
    }
  } catch (err) {
    broadcastOpenCodeRunError(room, runId, err?.message || String(err));
  } finally {
    room._awaitingPromptFinish = false;
    room._planGuardTriggered = false;
    room._planGuardToolName = '';
    room.currentRun = null;
    stopOpenCodeRunProgress(room);
    const waitingForInput = hasPendingOpenCodeUserInput(room);
    room.busy = waitingForInput;
    room.cancelled = false;
    broadcastBusyState(room, waitingForInput);
    flushPersistBuffer(room);
    sendRoomState(room);
    if (!waitingForInput) drainNextPendingPrompt();
  }
}

/**
 * @param {string} target
 */
function prioritizeQueuedPrompt(target) {
  let idx = room.pendingPrompts.findIndex((item) => isQueuedPromptText(item, target));
  if (idx < 0) {
    room.pendingPrompts.push({ text: target });
    idx = room.pendingPrompts.length - 1;
  }
  const [item] = room.pendingPrompts.splice(idx, 1);
  room.pendingPrompts.unshift(item);
}

/**
 * @param {{ requestId?: string, answers?: Array<Array<string>>, reject?: boolean }} payload
 */
async function replyOpenCodeQuestion(payload) {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
  if (!requestId) return;
  const pending = room._pendingOpenCodeQuestions instanceof Map
    ? room._pendingOpenCodeQuestions.get(requestId)
    : null;
  const sessionId = typeof pending?.sessionId === 'string'
    ? pending.sessionId
    : room.opencodeSessionId;
  const instanceWorkspaceFolder = resolveOpenCodeInstanceWorkspaceFolder(
    room._openCodeInstanceWorkspaceFolder || room.cwd
  );
  room._openCodeInstanceWorkspaceFolder = instanceWorkspaceFolder;
  const instance = await getOrCreateOpenCodeInstance({ workspaceFolder: instanceWorkspaceFolder });
  try {
    if (shouldExitPlanModeOnQuestionReply({
      mode: room.sdkMode,
      questionEvent: pending,
      answers: payload?.answers,
      reject: payload?.reject === true,
    })) {
      await applyOpenCodeRoomSdkMode(room, chat, 'agent', { reason: 'plan_question_approved' });
    }
    await postOpenCodeQuestionResponse({
      baseUrl: instance.baseUrl,
      requestId,
      sessionId,
      directory: instanceWorkspaceFolder,
      answers: Array.isArray(payload?.answers) ? payload.answers : [],
      reject: payload?.reject === true,
    });
    room._pendingOpenCodeQuestions?.delete(requestId);
    broadcastRoom(room, {
      type: 'opencodeQuestionResolved',
      requestId,
    }, { log: false });
    if (!room._awaitingPromptFinish && !hasPendingOpenCodeUserInput(room)) {
      room.busy = false;
      broadcastBusyState(room, false);
      sendRoomState(room);
      drainNextPendingPrompt();
    }
  } finally {
    instance.release();
  }
}

/**
 * @param {{ requestId?: string, reply?: string, message?: string }} payload
 */
async function replyOpenCodePermission(payload) {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
  const reply = payload?.reply;
  if (!requestId) return;
  if (reply !== 'once' && reply !== 'always' && reply !== 'reject') return;
  const pending = room._pendingOpenCodePermissions instanceof Map
    ? room._pendingOpenCodePermissions.get(requestId)
    : null;
  const sessionId = typeof pending?.sessionId === 'string'
    ? pending.sessionId
    : room.opencodeSessionId;
  const instanceWorkspaceFolder = resolveOpenCodeInstanceWorkspaceFolder(
    room._openCodeInstanceWorkspaceFolder || room.cwd
  );
  room._openCodeInstanceWorkspaceFolder = instanceWorkspaceFolder;
  const instance = await getOrCreateOpenCodeInstance({ workspaceFolder: instanceWorkspaceFolder });
  try {
    await postOpenCodePermissionResponse({
      baseUrl: instance.baseUrl,
      requestId,
      sessionId,
      directory: instanceWorkspaceFolder,
      reply,
      message: typeof payload?.message === 'string' ? payload.message : '',
    });
    room._pendingOpenCodePermissions?.delete(requestId);
    broadcastRoom(room, {
      type: 'opencodePermissionResolved',
      requestId,
    }, { log: false });
    sendRoomState(room);
    if (!room._awaitingPromptFinish && !hasPendingOpenCodeUserInput(room)) {
      room.busy = false;
      broadcastBusyState(room, false);
      drainNextPendingPrompt();
    }
  } finally {
    instance.release();
  }
}

  room.startPrompt = runPrompt;
  room.prioritizeQueuedPrompt = prioritizeQueuedPrompt;
  room.drainNextPendingPrompt = drainNextPendingPrompt;
  room.replyOpenCodeQuestion = replyOpenCodeQuestion;
  room.replyOpenCodePermission = replyOpenCodePermission;
  room._chatRef = chat;
  room.cancelCurrentRun = async () => {
    room.cancelled = true;
    if (!room.opencodeSessionId) return;
    try {
      const client = await ensureOpenCodeClient(room);
      await client.session.abort({
        path: { id: room.opencodeSessionId },
        query: { directory: room.cwd },
      });
    } catch {
      // ignore abort failures
    }
  };
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleOpenCodeAgentWebSocket(ws, sessionKey, deps) {
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    sendSdkChatNotFoundAndClose(ws, 'OpenCode chat not found for this session.');
    return;
  }
  if (!isOpenCodeChat(chat)) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'sdkError',
        code: 'invalid_session',
        message: 'OpenCode chat not found for this session.',
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
  let room = openCodeRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || DEFAULT_OPENCODE_MODEL,
      sdkMode: normalizeSdkMode(chat.sdkMode),
      opencodeSessionId: typeof chat.opencodeSessionId === 'string' ? chat.opencodeSessionId : '',
      cancelled: false,
      _eventSubscriptionStarted: false,
      _eventSubscriptionAbort: null,
      _openCodeInstanceRelease: null,
      _openCodeInstanceWorkspaceFolder: resolveOpenCodeInstanceWorkspaceFolder(cwd),
      _openCodeClient: null,
      _openCodeMessageRegistry: new OpenCodeMessageRegistry(),
      _lastUserPromptText: '',
      _openCodeStreamContext: null,
      _awaitingPromptFinish: false,
      _pendingOpenCodeQuestions: new Map(),
      _pendingOpenCodePermissions: new Map(),
      _planGuardTriggered: false,
      _planGuardToolName: '',
      _openCodeRunProgress: null,
      lastEventAt: null,
    });
    openCodeRooms.set(sessionKey, room);
    void ensureOpenCodeEventSubscription(room);
  } else {
    room.cwd = cwd;
    room._openCodeInstanceWorkspaceFolder = resolveOpenCodeInstanceWorkspaceFolder(cwd);
    room.modelId = chat.model || room.modelId || DEFAULT_OPENCODE_MODEL;
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (!room.opencodeSessionId && typeof chat.opencodeSessionId === 'string') {
      room.opencodeSessionId = chat.opencodeSessionId;
    }
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  attachClient(room, ws);

  if (!Array.isArray(room.pendingPrompts)) {
    room.pendingPrompts = [];
  }
  if (!(room._pendingOpenCodeQuestions instanceof Map)) {
    room._pendingOpenCodeQuestions = new Map();
  }
  if (!(room._pendingOpenCodePermissions instanceof Map)) {
    room._pendingOpenCodePermissions = new Map();
  }
  room.transport = 'opencode';

  const hello = buildAgentHelloPayload({
    transport: 'opencode',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: room.pendingPrompts.map((item) => resolveQueuedPromptUiText(item)),
    hasCurrentRun: !!room.currentRun,
    ...readSdkRoomRunOutcome(room),
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  sendRoomState(room);
  scheduleEventLogReplay(room, ws);

  bindOpenCodePromptRunner(room, chat);


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
    if (msg.type === 'warmup') {
      if (room.busy) return;
      void ensureOpenCodeEventSubscription(room).catch(() => {});
      return;
    }
    if (msg.type === 'cancel') {
      void room.cancelCurrentRun();
      return;
    }
    if (msg.type === 'setSdkMode') {
      void applyOpenCodeRoomSdkMode(room, chat, msg.mode);
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void room.startPrompt(msg.text, msg.mode, false, readClientDisplayText(msg));
      return;
    }
    if (msg.type === 'queueRemove' && typeof msg.text === 'string') {
      const target = String(msg.text).trim();
      if (!target) return;
      const idx = room.pendingPrompts.findIndex((item) => isQueuedPromptText(item, target));
      if (idx >= 0) {
        room.pendingPrompts.splice(idx, 1);
        broadcastRoom(room, { type: 'sdkQueueRemoved', text: target });
      }
      return;
    }
    if (msg.type === 'queueForceSend' && typeof msg.text === 'string') {
      const target = String(msg.text).trim();
      if (!target) return;
      room.prioritizeQueuedPrompt(target);
      if (room.busy) {
        void room.cancelCurrentRun();
        return;
      }
      room.drainNextPendingPrompt();
      return;
    }
    if (msg.type === 'opencodeQuestionReply' && typeof msg.requestId === 'string') {
      void room.replyOpenCodeQuestion(msg).catch((err) => {
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'opencode_question_error',
          message: err?.message || String(err),
        });
      });
      return;
    }
    if (msg.type === 'opencodePermissionReply' && typeof msg.requestId === 'string') {
      void room.replyOpenCodePermission(msg).catch((err) => {
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'opencode_permission_error',
          message: err?.message || String(err),
        });
      });
      return;
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
export function getOpenCodeRoomDiag(sessionKey) {
  const room = openCodeRooms.get(sessionKey);
  if (!room) return null;
  return buildOpenCodeRoomDiagSnapshot(room);
}

/**
 * Build debug snapshot for an OpenCode room.
 * @param {any} room
 * @param {number} [nowMs]
 * @returns {Record<string, unknown>}
 */
export function buildOpenCodeRoomDiagSnapshot(room, nowMs = Date.now()) {
  const pendingQuestions = room._pendingOpenCodeQuestions instanceof Map
    ? room._pendingOpenCodeQuestions.size
    : 0;
  const pendingPermissions = room._pendingOpenCodePermissions instanceof Map
    ? room._pendingOpenCodePermissions.size
    : 0;
  const safeNowMs = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const currentRunStartedAt = Number(room?.currentRun?.startedAt);
  const currentRunAgeMs = Number.isFinite(currentRunStartedAt) && currentRunStartedAt > 0
    ? Math.max(0, safeNowMs - currentRunStartedAt)
    : null;
  const lastEventAt = Number(room?.lastEventAt);
  const lastEventAgeMs = Number.isFinite(lastEventAt) && lastEventAt > 0
    ? Math.max(0, safeNowMs - lastEventAt)
    : null;
  const runOutcome = readSdkRoomRunOutcome(room);
  return {
    transport: 'opencode',
    busy: !!room.busy,
    sdkMode: room.sdkMode || 'agent',
    modelId: room.modelId,
    opencodeSessionId: room.opencodeSessionId || null,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    eventStreamId: room.eventStreamId,
    queuedCount: Array.isArray(room.pendingPrompts) ? room.pendingPrompts.length : 0,
    pendingQuestions,
    pendingPermissions,
    lastEventAt: room.lastEventAt || null,
    lastEventAgeMs,
    awaitingPromptFinish: !!room._awaitingPromptFinish,
    planGuardTriggered: !!room._planGuardTriggered,
    currentRunId: room?.currentRun?.id || null,
    currentRunStartedAt: Number.isFinite(currentRunStartedAt) && currentRunStartedAt > 0
      ? currentRunStartedAt
      : null,
    currentRunAgeMs,
    lastRunId: runOutcome.lastRunId || null,
    lastRunStatus: runOutcome.lastRunStatus || null,
    lastErrorCode: runOutcome.lastErrorCode || null,
    lastErrorMessage: runOutcome.lastErrorMessage || null,
  };
}

/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} deps
 */
export function ensureOpenCodeRoom(sessionKey, deps) {
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat || !isOpenCodeChat(chat)) {
    return { error: 'OpenCode chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = openCodeRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || DEFAULT_OPENCODE_MODEL,
      sdkMode: normalizeSdkMode(chat.sdkMode),
      opencodeSessionId: typeof chat.opencodeSessionId === 'string' ? chat.opencodeSessionId : '',
      cancelled: false,
      _eventSubscriptionStarted: false,
      _eventSubscriptionAbort: null,
      _openCodeInstanceRelease: null,
      _openCodeInstanceWorkspaceFolder: resolveOpenCodeInstanceWorkspaceFolder(cwd),
      _openCodeClient: null,
      _openCodeMessageRegistry: new OpenCodeMessageRegistry(),
      _lastUserPromptText: '',
      _openCodeStreamContext: null,
      _awaitingPromptFinish: false,
      _pendingOpenCodeQuestions: new Map(),
      _pendingOpenCodePermissions: new Map(),
      _planGuardTriggered: false,
      _planGuardToolName: '',
      _openCodeRunProgress: null,
      lastEventAt: null,
    });
    openCodeRooms.set(sessionKey, room);
    void ensureOpenCodeEventSubscription(room);
  } else {
    room.cwd = cwd;
    room._openCodeInstanceWorkspaceFolder = resolveOpenCodeInstanceWorkspaceFolder(cwd);
    room.modelId = chat.model || room.modelId || DEFAULT_OPENCODE_MODEL;
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (!room.opencodeSessionId && typeof chat.opencodeSessionId === 'string') {
      room.opencodeSessionId = chat.opencodeSessionId;
    }
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  bindOpenCodePromptRunner(room, chat);
  return { room, chat };
}

/**
 * @param {{ chat: object, prompt: string, mode?: string, displayText?: string, deps?: object }} input
 */
export async function startOpenCodeChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const ensured = ensureOpenCodeRoom(sessionKey, input.deps || {});
  if ('error' in ensured) {
    const error = new Error(ensured.error);
    error.code = ensured.code;
    throw error;
  }
  const { room, chat } = ensured;
  room.serverHold = true;
  bindOpenCodePromptRunner(room, chat);
  void room.startPrompt(input.prompt, input.mode || 'agent', false, input.displayText || '');
  return { runId: String(room.currentRun?.id || '') };
}

/**
 * @param {{ chat: object, runId?: string }} input
 */
export async function cancelOpenCodeChatRun(input) {
  const sessionKey = String(input.chat?.cursorSessionId || '').trim();
  const room = openCodeRooms.get(sessionKey);
  if (!room) return;
  if (input.runId && room.currentRun?.id && room.currentRun.id !== input.runId) return;
  if (typeof room.cancelCurrentRun === 'function') {
    await room.cancelCurrentRun();
    return;
  }
  room.cancelled = true;
}

registerChatRunAdapter({
  transport: 'opencode',
  start: startOpenCodeChatRun,
  cancel: cancelOpenCodeChatRun,
  getState({ chat, runId }) {
    const room = openCodeRooms.get(String(chat?.cursorSessionId || ''));
    if (!room) return null;
    if (runId && room.currentRun?.id && room.currentRun.id !== runId) return null;
    const waiting = room._pendingOpenCodeQuestions instanceof Map && room._pendingOpenCodeQuestions.size > 0
      || room._pendingOpenCodePermissions instanceof Map && room._pendingOpenCodePermissions.size > 0;
    return {
      runId: String(room.currentRun?.id || ''),
      busy: !!room.busy,
      waitingForInput: !!waiting,
    };
  },
});
