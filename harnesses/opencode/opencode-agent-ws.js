/**
 * WebSocket rooms for OpenCode agent harness — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import { rejectArchivedRoomPrompt } from '../../lib/chat-message-guard.js';
import { readEnvAlias } from '../../lib/env-alias.js';
import {
  getChatByCursorSessionId,
  setChatOpenCodeSessionId,
  updateChat,
} from '../../lib/persist/chats-persist.js';
import { resolveExecutionFolderForChat } from '../../lib/execution-folder.js';
import {
  isQueuedPromptText,
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../../lib/prompt-ui-text.js';
import {
  setActiveSelection,
  readClientSkillSelection,
  withSkillSelection,
} from '../../lib/skills/skill-selection.js';
import { resolveHarnessPlanPolicy } from '../../lib/agent-harness/harness-plan-policy.ts';
import { beginEnforcedSdkMode, clearEnforcedSdkMode, isAskSdkMode, isReadOnlySdkMode, normalizeSdkMode, readEnforcedSdkMode } from '../../lib/sdk/sdk-mode.ts';
import { buildAgentHelloPayload } from '../../lib/sdk/sdk-ws-handshake.ts';
import { sendSdkChatNotFoundAndClose } from '../../lib/sdk/sdk-ws-chat-gone.ts';
import { createAgentRoomKernel } from '../../lib/agent-harness/room-kernel.ts';
import {
  isOpenCodeEventForSession,
  normalizeOpenCodeEvent,
  parseOpenCodeModel,
  resolveOpenCodeSessionActivity,
} from './opencode-event-normalizer.js';
import { hasOpenSdkRunTools, noteSdkRunToolActivity } from '../../lib/sdk/sdk-run-tool-activity.ts';
import { buildAssistantFullEvent } from '../../lib/agent-harness/event-normalizer.ts';
import { OpenCodeMessageRegistry, noteOpenCodeMessageFromEvent } from './opencode-message-registry.js';
import {
  resolveOpenCodeUsageFromStreamEvent,
  unwrapOpenCodeStreamEvent,
} from './opencode-usage.js';
import {
  buildOpenCodeRunErrorEvents,
  createOpenCodePromptRunWaiter,
  resolveOpenCodeFirstEventTimeoutMs,
  submitOpenCodePromptAndWait,
  bumpOpenCodePromptRunActivity,
  notifyOpenCodePromptRunEnd,
  rejectOpenCodePromptRun,
  settleOpenCodePromptRunAfterAbort,
  resolveOpenCodePromptTimeoutMs,
  resolveOpenCodePromptRunFromEvent,
  shouldBumpOpenCodePromptRunActivity,
} from './opencode-prompt-run.js';
import { tagDelegationAdapterTimeout } from '../../lib/delegation-adapter-error.js';
import { resolveOpenCodeDelegatedFirstEventTimeoutMs } from '../../lib/delegation-startup-lockout-policy.js';
import { isOpenCodeChat } from '../../lib/agent-transport.js';
import { isReviewReadOnlyAssignment } from '../../lib/delegation-review-policy.js';
import {
  getOrCreateOpenCodeInstance,
  hasOpenCodeInstanceExited,
  releaseOpenCodeInstance,
} from './opencode-server-manager.js';
import { syncOpenCodeManagedMcp } from './mcp-opencode-sync.js';
import { buildMcpRuntimeContext, prepareHarnessMcp } from '../../lib/mcp/mcp-session.js';
import { CONTEXT_RESTART_REASON, recordContextRestart } from '../../lib/usage/context-restarts.ts';
import {
  enforceWatcherOrchestratorMcpGate,
  isWatcherOrchestratorChat,
  stampWatcherOrchestratorRoom,
} from '../../lib/mcp/watcher-orchestrator-mcp-gate.js';
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
  resolveOpenCodeApprovalAction,
  resolveOpenCodePermissionResolvedRequestId,
  shouldRejectOpenCodePlanPermission,
} from './opencode-permission.js';
import {
  readApprovalBrokerMode,
  recordOpenCodeApprovalAudit,
} from '../../lib/approval/approval-broker.ts';
import {
  createApprovalAdvisorSessionPin,
  isApprovalAdvisorSessionPinValid,
  releaseApprovalAdvisorSessionPin,
  recordApprovalAdvisorAudit,
  buildOpenCodePermissionDecisionPayload,
  recordApprovalAdvisorSkipAudit,
  captureApprovalActionSnapshot,
  recordApprovalHumanPermissionDecisionAudit,
  requestApprovalAdvisor,
  resolveApprovalAdvisorPlan,
  resolveAdvisorReplyOutcome,
  shouldScheduleApprovalAdvisor,
  buildOpenCodePermissionAdvisorStatusPayload,
  toPublicAdvisoryAssessment,
  waitForAdvisorApplyWindow,
} from '../../lib/approval/approval-advisor.ts';
import { createOpenCodePermissionReplyGuard } from './opencode-permission-reply-guard.js';
import { loadSettings } from '../../lib/persist/settings.js';
import { ROOM_STATE_HEARTBEAT_INTERVAL_MS } from '../../lib/sdk/sdk-room-state.ts';
import {
  getSdkToolCallName,
  resolvePlanModeSdkEventDecision,
  resolveReadOnlyGuardUserMessage,
} from '../../lib/sdk/sdk-plan-guard.ts';
import { resolvePlanGuardMcpServerIdentity } from '../../lib/mcp/mcp-session.js';
import { SCOUT_READ_ONLY_MESSAGE, isScoutReadOnlyChatId } from '../../lib/workspace-scout-chat.js';
import { readSdkRoomRunOutcome, trackSdkRoomRunOutcome } from '../../lib/sdk/sdk-run-outcome.ts';
import { schedulePendingPromptRun } from '../../lib/sdk/sdk-retry-delay.ts';
import { decorateHarnessPrompt, HARNESS_ASK_MODE_HINT, HARNESS_PLAN_MODE_HINT } from '../../lib/sdk/harness-plan-prompt.ts';
import { shouldExitPlanModeOnQuestionReply } from '../../lib/sdk/plan-approval-reply.ts';
import { bindHarnessPlanSync } from '../../lib/sdk/harness-plan-sync.ts';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../../lib/delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../../lib/delegation-report-context.js';
import { registerChatRunAdapter } from '../../lib/chat-run-service.js';
import { drainOnePendingPrompt } from '../../lib/agent-harness/pending-prompt-drain.ts';
import { registerPendingPromptRoomSource } from '../../lib/agent-harness/pending-prompt-resume.ts';
import { canAcceptNewRun } from '../../lib/update-gate.js';
import { msg } from '../../lib/messages.js';
import { acceptRoomPrompt, bindRoomRecoveryLifecycle, createDurableRequestLookup } from '../../lib/chat-run/kernel-adapter.ts';
import { notifyAgentNeedsInput } from '../../lib/agent-needs-input-push.js';

const DEFAULT_OPENCODE_MODEL = 'opencode/x-preview-f-free';
const PLAN_MODE_SYSTEM = HARNESS_PLAN_MODE_HINT;
const ASK_MODE_SYSTEM = HARNESS_ASK_MODE_HINT;

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
registerPendingPromptRoomSource(() => openCodeRooms.values());
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
 * @param {string} workspaceFolder
 * @returns {string}
 */
function resolveOpenCodeInstanceWorkspaceFolder(workspaceFolder) {
  const forcedWorkspaceFolder = readEnvAlias({ current: 'CRETLI_OPENCODE_INSTANCE_FOLDER', legacy: 'CURSOR_REMOTE_OPENCODE_INSTANCE_FOLDER' }).trim();
  if (forcedWorkspaceFolder) return forcedWorkspaceFolder;
  return String(workspaceFolder || '').trim();
}

/**
 * @param {object} room
 */
function openCodeInstanceOptions(room) {
  const workspaceFolder = resolveOpenCodeInstanceWorkspaceFolder(
    room._openCodeInstanceWorkspaceFolder || room.cwd
  );
  room._openCodeInstanceWorkspaceFolder = workspaceFolder;
  return {
    workspaceFolder,
    sessionKey: String(room.sessionKey || room.chatId || '').trim(),
    // Delegation children may use a shorter, opt-in idle window; normal chats
    // keep the default until the setting/env is explicitly configured.
    delegation: Boolean(String(room.delegationId || '').trim()),
  };
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
    signal: AbortSignal.timeout(10000),
    throwOnError: true,
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
    toolSignatureByCallId: new Map(),
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
function emitOpenCodePlanGuardNotice(room, toolName, message = '') {
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    toolName: toolName || 'unknown',
    message: message || resolveReadOnlyGuardUserMessage(readEnforcedSdkMode(room), room.delegationAssignment),
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
  const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
  const planDecision = resolvePlanModeSdkEventDecision({
    transport: 'opencode',
    mode: readEnforcedSdkMode(room),
      assignment: room.delegationAssignment,
      event: sdkEvent,
      scoutReadOnly,
      projectRoot: room._openCodeInstanceWorkspaceFolder || room.cwd,
      mcpServer: resolvePlanGuardMcpServerIdentity({ room, harness: 'opencode', event: sdkEvent }),
  });
  if (planDecision.notify) {
    emitOpenCodePlanGuardNotice(
      room,
      getSdkToolCallName(sdkEvent) || 'unknown',
      scoutReadOnly ? SCOUT_READ_ONLY_MESSAGE : '',
    );
  }
  broadcastRoom(room, { type: 'sdkEvent', event: sdkEvent });
}

/**
 * @param {any} room
 * @param {string} runId
 * @param {string} message
 */
function broadcastOpenCodeRunError(room, runId, message, err = null) {
  const events = buildOpenCodeRunErrorEvents({
    runId,
    message,
    err,
    cancelled: !!room.cancelled,
    planGuardTriggered: !!room._planGuardTriggered,
    remaining: room.pendingPrompts.length,
  });
  for (const event of events) {
    broadcastRoom(room, event, { log: true });
  }
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
  const reason = typeof options.reason === 'string' ? options.reason.trim() : '';
  const changed = applySdkModeIfChanged(room, normalized, {
    chatId: chat?.id,
    updateChat,
    extraPayload: reason ? { reason } : undefined,
  });
  if (!changed) return;
  if (room.busy && reason !== 'plan_question_approved') return;
  await syncOpenCodeSessionPlanPermissions(room, normalized);
}

/**
 * @param {any} room
 * @param {'plan' | 'agent' | 'ask'} mode
 */
async function syncOpenCodeSessionPlanPermissions(room, mode) {
  const policy = resolveHarnessPlanPolicy('opencode');
  if (!policy.denyMutatingTools) return;
  if (!room.opencodeSessionId) return;
  try {
    const client = await ensureOpenCodeClient(room);
    const review = isReviewReadOnlyAssignment(room.delegationAssignment);
    await client.session.update({
      path: { id: room.opencodeSessionId },
      query: { directory: room.cwd },
      body: { permission: buildOpenCodePlanPermissionRuleset(mode, { review, scoutReadOnly: isScoutReadOnlyChatId(room?.chatId) }) },
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
export function noteOpenCodeUsageFromEvent(room, event) {
  if (!(room._openCodeTokensByMessageId instanceof Map)) room._openCodeTokensByMessageId = new Map();
  const resolved = resolveOpenCodeUsageFromStreamEvent(event, room._openCodeTokensByMessageId);
  if (!resolved) return;
  const prevPayload = room._lastUsagePayload && typeof room._lastUsagePayload === 'object'
    ? room._lastUsagePayload
    : { inputTokens: 0, outputTokens: 0 };
  room._lastUsagePayload = {
    inputTokens: (Number(prevPayload.inputTokens) || 0) + resolved.delta.input,
    outputTokens: (Number(prevPayload.outputTokens) || 0) + resolved.delta.output,
  };
  broadcastRoom(room, { type: 'sdkEvent', event: resolved.sdkEvent });
}

function handleOpenCodeStreamEvent(room, event) {
  const streamEvent = unwrapOpenCodeStreamEvent(event);
  if (!streamEvent || !isOpenCodeEventForSession(streamEvent, room.opencodeSessionId)) return;
  noteOpenCodeMessageFromEvent(streamEvent, room._openCodeMessageRegistry);
  noteOpenCodeUsageFromEvent(room, streamEvent);
  const shouldBumpPromptRun = room._awaitingPromptFinish
    && shouldBumpOpenCodePromptRunActivity(streamEvent, { opencodeSessionId: room.opencodeSessionId });
  if (shouldBumpPromptRun) {
    bumpOpenCodePromptRunActivity(room);
  }
  const resolvedQuestionId = resolveOpenCodeQuestionResolvedRequestId(streamEvent, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (resolvedQuestionId) {
    if (room._pendingOpenCodeQuestions instanceof Map) {
      room._pendingOpenCodeQuestions.delete(resolvedQuestionId);
    }
    broadcastRoom(room, {
      type: 'opencodeQuestionResolved',
      requestId: resolvedQuestionId,
    });
  }
  const resolvedPermissionId = resolveOpenCodePermissionResolvedRequestId(streamEvent, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (resolvedPermissionId) {
    removePendingOpenCodePermission(room, resolvedPermissionId);
    broadcastRoom(room, {
      type: 'opencodePermissionResolved',
      requestId: resolvedPermissionId,
    }, { log: false });
    sendRoomState(room);
  }
  const permissionEvent = buildOpenCodePermissionSdkEvent(streamEvent, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (permissionEvent) {
    const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
    if (
      shouldRejectOpenCodePlanPermission(
        room.sdkMode,
        permissionEvent,
        room.delegationAssignment,
        {
          scoutReadOnly,
          projectRoot: room._openCodeInstanceWorkspaceFolder || room.cwd,
          room,
        },
      )
    ) {
      emitOpenCodePlanGuardNotice(
        room,
        String(permissionEvent.action || 'unknown'),
        scoutReadOnly ? SCOUT_READ_ONLY_MESSAGE : '',
      );
      void rejectOpenCodePlanPermission(room, permissionEvent);
      return;
    }
    const approvalAction = resolveOpenCodeApprovalAction({
      mode: readApprovalBrokerMode(loadSettings()),
      settings: loadSettings(),
      sdkMode: room.sdkMode,
      permissionEvent,
      assignment: room.delegationAssignment,
      workspaceFolder: room._openCodeInstanceWorkspaceFolder || room.cwd,
      scoutReadOnly,
    });
    // `off` keeps the pre-broker manual flow (plus the existing delegation
    // read-only auto-allow); `shadow` audits but never sends a reply.
    recordOpenCodeApprovalAudit({ room, permissionEvent, action: approvalAction });
    if (approvalAction.reply === 'reject') {
      emitOpenCodePlanGuardNotice(room, String(permissionEvent.action || 'unknown'));
      void rejectOpenCodePlanPermission(room, permissionEvent);
      return;
    }
    if (approvalAction.reply === 'once') {
      void allowOpenCodeReviewPermissionOnce(room, permissionEvent, { reason: approvalAction.reason })
        .then((status) => {
          if (status === 'sent') {
            broadcastOpenCodePermissionDecision(room, {
              requestId: permissionEvent.requestId,
              decidedBy: 'local',
              reply: 'once',
            });
          }
        });
      return;
    }
    if (!(room._pendingOpenCodePermissions instanceof Map)) {
      room._pendingOpenCodePermissions = new Map();
    }
    const permissionId = String(permissionEvent.requestId);
    const isNewPermission = !room._pendingOpenCodePermissions.has(permissionId);
    room._pendingOpenCodePermissions.set(permissionId, {
      ...permissionEvent,
      approvalActionSnapshot: captureApprovalActionSnapshot(approvalAction),
    });
    bumpOpenCodePromptRunActivity(room);
    broadcastRoom(room, { type: 'sdkEvent', event: permissionEvent });
    sendRoomState(room);
    if (isNewPermission) notifyAgentNeedsInput({ room, event: permissionEvent });
    const advisorPlan = resolveApprovalAdvisorPlan(loadSettings(), approvalAction);
    broadcastPermissionAdvisorStatus(room, buildOpenCodePermissionAdvisorStatusPayload({
      requestId: permissionId,
      status: 'checking',
      permissionEvent,
      approvalAction,
      plan: advisorPlan,
    }));
    // Phase 2: the local card is already pending, broadcast and pushed. Only now
    // may the optional external advisor run, asynchronously. Authority role may
    // widen a narrow `ask_user` into a single `once`; advisory role (`advise_all`)
    // only emits guidance — never an automatic reply.
    void maybeRunApprovalAdvisor(room, permissionEvent, approvalAction);
    return;
  }
  const questionEvent = buildOpenCodeQuestionSdkEvent(streamEvent, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (questionEvent) {
    if (!(room._pendingOpenCodeQuestions instanceof Map)) {
      room._pendingOpenCodeQuestions = new Map();
    }
    const questionId = String(questionEvent.requestId);
    const isNewQuestion = !room._pendingOpenCodeQuestions.has(questionId);
    room._pendingOpenCodeQuestions.set(questionId, questionEvent);
    bumpOpenCodePromptRunActivity(room);
    broadcastRoom(room, { type: 'sdkEvent', event: questionEvent });
    if (isNewQuestion) notifyAgentNeedsInput({ room, event: questionEvent });
    return;
  }
  const activity = resolveOpenCodeSessionActivity(streamEvent, {
    opencodeSessionId: room.opencodeSessionId,
  });
  if (activity === 'busy' && !room.busy) {
    room.busy = true;
    broadcastBusyState(room, true);
  }
  const sdkEvents = normalizeOpenCodeEvent(streamEvent, {
    opencodeSessionId: room.opencodeSessionId,
    messageRegistry: room._openCodeMessageRegistry,
    lastUserPromptText: room._lastUserPromptText,
    ...(room._openCodeStreamContext || {}),
  });
  for (const sdkEvent of sdkEvents) {
    noteSdkRunToolActivity(room, sdkEvent);
    broadcastOpenCodeNormalizedEvent(room, sdkEvent);
    const stalePermissionIds = listOpenCodePermissionIdsForFailedTool(
      room._pendingOpenCodePermissions,
      sdkEvent,
    );
    for (const requestId of stalePermissionIds) {
      removePendingOpenCodePermission(room, requestId);
      broadcastRoom(room, {
        type: 'opencodePermissionResolved',
        requestId,
      }, { log: false });
      sendRoomState(room);
    }
  }
  const promptRun = room._awaitingPromptFinish
    ? resolveOpenCodePromptRunFromEvent(streamEvent, {
      opencodeSessionId: room.opencodeSessionId,
      hasPendingUserInput: hasPendingOpenCodeUserInput(room),
      hasOpenTools: hasOpenSdkRunTools(room),
    })
    : null;
  if (promptRun && room._promptRunWaiter) {
    notifyOpenCodePromptRunEnd(room, promptRun);
  }
  if (activity === 'idle' && room.busy && !room._awaitingPromptFinish) {
    room.busy = false;
    broadcastBusyState(room, false);
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
    const instanceOptions = openCodeInstanceOptions(room);
    const instance = await getOrCreateOpenCodeInstance(instanceOptions);
    room._openCodeInstanceRelease = instance.release;
    room._openCodeClient = instance.client;
    if (room._eventSubscriptionStarted) return;
    room._eventSubscriptionStarted = true;
    const abort = new AbortController();
    room._eventSubscriptionAbort = abort;
    const subscription = await instance.client.event.subscribe({
      query: { directory: instanceOptions.workspaceFolder },
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
          if (room.clients?.size > 0 || room.busy) {
            void ensureOpenCodeEventSubscription(room).catch(() => {});
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          console.warn('[opencode-ws] event stream ended:', err?.message || err);
          room._eventSubscriptionStarted = false;
          room._openCodeClient = null;
          room._openCodeInitPromise = null;
          if (room.clients?.size > 0 || room.busy) {
            setTimeout(() => {
              if (room.clients?.size > 0 || room.busy) {
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
    reconcileAdvisorSnapshotsAfterSessionReset(room);
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
 * One reply per permission requestId. The guard is bounded because rooms are
 * long-lived; the pending map is still the primary liveness check.
 *
 * @param {any} room
 * @returns {{ claim: (requestId: unknown) => boolean, release: (requestId: unknown) => void, has: (requestId: unknown) => boolean, readonly size: number }}
 */
function readOpenCodePermissionReplyGuard(room) {
  if (!room._openCodeApprovalReplies || typeof room._openCodeApprovalReplies.claim !== 'function') {
    room._openCodeApprovalReplies = createOpenCodePermissionReplyGuard();
  }
  return room._openCodeApprovalReplies;
}

/**
 * @param {any} room
 * @param {unknown} requestId
 * @returns {boolean}
 */
function claimOpenCodePermissionReply(room, requestId) {
  return readOpenCodePermissionReplyGuard(room).claim(requestId);
}

/**
 * @param {any} room
 * @param {unknown} requestId
 */
function releaseOpenCodePermissionReplyClaim(room, requestId) {
  readOpenCodePermissionReplyGuard(room).release(requestId);
}

/**
 * When an automatic reply cannot be delivered, the user must still see the
 * card instead of losing the permission. Re-publish the pending event and push.
 *
 * @param {any} room
 * @param {object} permissionEvent
 */
function restoreOpenCodePermissionCard(room, permissionEvent) {
  if (!permissionEvent || typeof permissionEvent !== 'object') return;
  const permissionId = String(permissionEvent.requestId || '').trim();
  if (!permissionId) return;
  if (!(room._pendingOpenCodePermissions instanceof Map)) {
    room._pendingOpenCodePermissions = new Map();
  }
  const isNew = !room._pendingOpenCodePermissions.has(permissionId);
  room._pendingOpenCodePermissions.set(permissionId, permissionEvent);
  releaseOpenCodePermissionReplyClaim(room, permissionId);
  broadcastRoom(room, { type: 'sdkEvent', event: permissionEvent });
  sendRoomState(room);
  if (isNew) notifyAgentNeedsInput({ room, event: permissionEvent });
  bumpOpenCodePromptRunActivity(room);
}

/**
 * @param {any} room
 * @param {object} chat
 */
async function rejectOpenCodePlanPermission(room, permissionEvent) {
  const requestId = String(permissionEvent?.requestId || '').trim();
  if (!requestId) return;
  if (!claimOpenCodePermissionReply(room, requestId)) return;
  const instanceOptions = openCodeInstanceOptions(room);
  let instance = null;
  try {
    instance = await getOrCreateOpenCodeInstance(instanceOptions);
    await postOpenCodePermissionResponse({
      baseUrl: instance.baseUrl,
      requestId,
      sessionId: String(permissionEvent.sessionId || room.opencodeSessionId || '').trim(),
      directory: instanceOptions.workspaceFolder,
      reply: 'reject',
      message: resolveReadOnlyGuardUserMessage(readEnforcedSdkMode(room), room.delegationAssignment),
    });
    broadcastRoom(room, {
      type: 'opencodePermissionResolved',
      requestId,
    }, { log: false });
    sendRoomState(room);
  } catch (err) {
    console.warn('[opencode] plan permission reject failed:', err?.message || err);
    restoreOpenCodePermissionCard(room, permissionEvent);
  } finally {
    instance?.release();
  }
}

/**
 * @param {any} room
 * @param {object} permissionEvent
 * @param {{ reason?: string }} [meta]
 * @returns {Promise<'invalid' | 'not_claimed' | 'sent' | 'failed'>} whether the
 *   one-shot reply was actually delivered. `not_claimed` means the human (or an
 *   earlier reply) already answered this `requestId` and wins.
 */
async function allowOpenCodeReviewPermissionOnce(room, permissionEvent, meta = {}) {
  const requestId = String(permissionEvent?.requestId || '').trim();
  if (!requestId) return 'invalid';
  if (!claimOpenCodePermissionReply(room, requestId)) return 'not_claimed';
  const instanceOptions = openCodeInstanceOptions(room);
  let instance = null;
  try {
    instance = await getOrCreateOpenCodeInstance(instanceOptions);
    await postOpenCodePermissionResponse({
      baseUrl: instance.baseUrl,
      requestId,
      sessionId: String(permissionEvent.sessionId || room.opencodeSessionId || '').trim(),
      directory: instanceOptions.workspaceFolder,
      reply: 'once',
    });
    bumpOpenCodePromptRunActivity(room);
    return 'sent';
  } catch (err) {
    console.warn('[opencode] permission allow failed:', err?.message || err, meta.reason || '');
    // Fail closed: a lost POST must fall back to the human card, never vanish.
    restoreOpenCodePermissionCard(room, permissionEvent);
    return 'failed';
  } finally {
    instance?.release();
  }
}

/**
 * Tell clients (and chat history) who made the final permission decision.
 * Logged on purpose: unlike `opencodePermissionResolved` it must survive a
 * reload so the card keeps its "decided by" chip.
 *
 * @param {any} room
 * @param {Parameters<typeof buildOpenCodePermissionDecisionPayload>[0]} input
 */
function broadcastOpenCodePermissionDecision(room, input) {
  const payload = buildOpenCodePermissionDecisionPayload(input);
  if (payload) broadcastRoom(room, payload);
}

/**
 * @param {any} room
 * @param {string} requestId
 */
function forgetPermissionAdvisorStatus(room, requestId) {
  const id = String(requestId || '').trim();
  if (!id || !(room?._approvalAdvisorStatusByRequestId instanceof Map)) return;
  room._approvalAdvisorStatusByRequestId.delete(id);
}

/**
 * Drop pending permission state and all advisor snapshots/pins for one request.
 *
 * @param {any} room
 * @param {string} requestId
 */
export function removePendingOpenCodePermission(room, requestId) {
  const id = String(requestId || '').trim();
  if (!id) return;
  if (room._pendingOpenCodePermissions instanceof Map) {
    room._pendingOpenCodePermissions.delete(id);
  }
  forgetPermissionAdvisorStatus(room, id);
  releaseApprovalAdvisorSessionPin(room, id);
  if (room._approvalHumanDecisionAudited instanceof Set) {
    room._approvalHumanDecisionAudited.delete(id);
  }
}

/**
 * @param {any} room
 * @param {string} requestId
 * @param {string} reason
 * @param {object} permissionEvent
 * @param {any} approvalAction
 * @param {{ protocol?: string, model?: string } | null} plan
 */
function broadcastAdvisorSkippedIfPending(room, requestId, reason, permissionEvent, approvalAction, plan) {
  const id = String(requestId || '').trim();
  if (!id) return;
  const stillPending = room._pendingOpenCodePermissions instanceof Map
    && room._pendingOpenCodePermissions.has(id);
  if (!stillPending) return;
  broadcastPermissionAdvisorStatus(room, buildOpenCodePermissionAdvisorStatusPayload({
    requestId: id,
    status: 'skipped',
    reason,
    permissionEvent,
    approvalAction,
    plan,
  }));
}

/**
 * After OpenCode session reset, drop stale advisor snapshots and end in-flight checks.
 *
 * @param {any} room
 */
export function reconcileAdvisorSnapshotsAfterSessionReset(room) {
  if (!(room?._approvalAdvisorStatusByRequestId instanceof Map)) return;
  const pending = room._pendingOpenCodePermissions instanceof Map
    ? room._pendingOpenCodePermissions
    : null;
  const settings = loadSettings();
  for (const requestId of [...room._approvalAdvisorStatusByRequestId.keys()]) {
    const id = String(requestId);
    const payload = room._approvalAdvisorStatusByRequestId.get(id);
    const status = String(payload?.status || '').trim();
    if (!pending?.has(id)) {
      forgetPermissionAdvisorStatus(room, id);
      releaseApprovalAdvisorSessionPin(room, id);
      continue;
    }
    if (status !== 'checking') continue;
    const permissionEvent = pending.get(id);
    forgetPermissionAdvisorStatus(room, id);
    releaseApprovalAdvisorSessionPin(room, id);
    broadcastAdvisorSkippedIfPending(
      room,
      id,
      'session_changed',
      permissionEvent,
      null,
      resolveApprovalAdvisorPlan(settings, { mode: readApprovalBrokerMode(settings) }),
    );
  }
  if (room._approvalAdvisorSessionPins instanceof Map) {
    room._approvalAdvisorSessionPins.clear();
  }
}

/**
 * Latest advisor payloads to replay for still-pending permission cards.
 *
 * @param {any} room
 * @returns {Record<string, unknown>[]}
 */
export function getPendingAdvisorReplayPayloads(room) {
  if (!(room?._pendingOpenCodePermissions instanceof Map) || room._pendingOpenCodePermissions.size === 0) {
    return [];
  }
  const snapshots = room._approvalAdvisorStatusByRequestId;
  if (!(snapshots instanceof Map) || snapshots.size === 0) return [];
  /** @type {Record<string, unknown>[]} */
  const payloads = [];
  for (const requestId of room._pendingOpenCodePermissions.keys()) {
    const payload = snapshots.get(String(requestId));
    if (!payload || typeof payload !== 'object') continue;
    payloads.push(/** @type {Record<string, unknown>} */ (payload));
  }
  return payloads;
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 * @param {{ log?: boolean }} [broadcastOptions]
 */
export function broadcastPermissionAdvisorStatus(room, payload, broadcastOptions = {}) {
  const requestId = String(payload?.requestId || '').trim();
  if (requestId) {
    const stillPending = room._pendingOpenCodePermissions instanceof Map
      && room._pendingOpenCodePermissions.has(requestId);
    if (stillPending) {
      if (!(room._approvalAdvisorStatusByRequestId instanceof Map)) {
        room._approvalAdvisorStatusByRequestId = new Map();
      }
      room._approvalAdvisorStatusByRequestId.set(requestId, payload);
    } else {
      forgetPermissionAdvisorStatus(room, requestId);
    }
  }
  broadcastRoom(room, payload, broadcastOptions);
}

/**
 * After event-log replay, push the latest advisor snapshot for still-pending cards.
 *
 * @param {any} room
 * @param {import('ws').WebSocket} ws
 */
function replayPendingPermissionAdvisorStatus(room, ws) {
  if (!room || !ws || ws.readyState !== 1) return;
  for (const payload of getPendingAdvisorReplayPayloads(room)) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Phase 2 advisory: run the external model advisor for a low-risk read, or the
 * host-owned review-verify runner, that the local broker left on the human card.
 * Fire-and-forget; the card is always shown first. An allow highlights Once
 * and waits `timeoutMs` before a single `once` reply, and only while the
 * request is still pending. A human click during that wait wins.
 *
 * Every path that does not reach the advisor writes an `advisor_skip` audit
 * entry with the gate reason, so "the advisor never ran" is diagnosable from
 * `data/approvals/approval-audit.jsonl` alone.
 *
 * @param {any} room
 * @param {object} permissionEvent
 * @param {any} approvalAction
 */
async function maybeRunApprovalAdvisor(room, permissionEvent, approvalAction) {
  let requestId = '';
  let plan = null;
  let sessionPinActive = false;
  try {
    requestId = String(permissionEvent?.requestId || '').trim();
    if (!requestId) {
      recordApprovalAdvisorSkipAudit({ room, permissionEvent, approvalAction, reason: 'no_request_id' });
      return;
    }
    if (!(room?._pendingOpenCodePermissions instanceof Map)) {
      broadcastPermissionAdvisorStatus(room, buildOpenCodePermissionAdvisorStatusPayload({
        requestId,
        status: 'skipped',
        reason: 'no_pending_permission_map',
        permissionEvent,
        approvalAction,
        plan: resolveApprovalAdvisorPlan(loadSettings(), approvalAction),
      }));
      recordApprovalAdvisorSkipAudit({
        room,
        permissionEvent,
        approvalAction,
        requestId,
        reason: 'no_pending_permission_map',
      });
      return;
    }
    const settings = loadSettings();
    if (!(room._approvalAdvisorRequested instanceof Set)) {
      room._approvalAdvisorRequested = new Set();
    }
    const gate = shouldScheduleApprovalAdvisor({
      approvalAction,
      settings,
      requestId,
      requested: room._approvalAdvisorRequested,
    });
    if (!gate.eligible) {
      broadcastPermissionAdvisorStatus(room, buildOpenCodePermissionAdvisorStatusPayload({
        requestId,
        status: 'skipped',
        reason: gate.reason,
        permissionEvent,
        approvalAction,
        plan: resolveApprovalAdvisorPlan(settings, approvalAction),
      }));
      recordApprovalAdvisorSkipAudit({
        room,
        permissionEvent,
        approvalAction,
        requestId,
        reason: gate.reason,
      });
      return;
    }
    plan = resolveApprovalAdvisorPlan(settings, approvalAction);
    room._approvalAdvisorRequested.add(requestId);
    const sessionPin = createApprovalAdvisorSessionPin(room, permissionEvent);
    if (!(room._approvalAdvisorSessionPins instanceof Map)) {
      room._approvalAdvisorSessionPins = new Map();
    }
    room._approvalAdvisorSessionPins.set(requestId, sessionPin);
    sessionPinActive = true;
    if (!room._pendingOpenCodePermissions.has(requestId)) {
      broadcastPermissionAdvisorStatus(room, buildOpenCodePermissionAdvisorStatusPayload({
        requestId,
        status: 'skipped',
        reason: 'permission_gone',
        permissionEvent,
        approvalAction,
        plan,
      }));
      recordApprovalAdvisorSkipAudit({
        room,
        permissionEvent,
        approvalAction,
        requestId,
        reason: 'permission_gone',
      });
      return;
    }

    const result = await requestApprovalAdvisor({
      plan,
      settings,
      permissionEvent,
      approvalAction,
    });

    const pin = room._approvalAdvisorSessionPins instanceof Map
      ? room._approvalAdvisorSessionPins.get(requestId)
      : null;
    if (!isApprovalAdvisorSessionPinValid(room, pin)) {
      forgetPermissionAdvisorStatus(room, requestId);
      broadcastAdvisorSkippedIfPending(
        room,
        requestId,
        'session_changed',
        permissionEvent,
        approvalAction,
        plan,
      );
      recordApprovalAdvisorSkipAudit({
        room,
        permissionEvent,
        approvalAction,
        requestId,
        reason: 'session_pin_mismatch',
      });
      return;
    }

    let replyStatus = 'skipped';
    const stillPending = room._pendingOpenCodePermissions instanceof Map
      && room._pendingOpenCodePermissions.has(requestId);
    if (!stillPending) {
      forgetPermissionAdvisorStatus(room, requestId);
      recordApprovalAdvisorSkipAudit({
        room,
        permissionEvent,
        approvalAction,
        requestId,
        reason: 'permission_gone_late',
      });
      return;
    }
    const isAuthority = plan.role === 'authority';
    if (isAuthority && result?.advisorDecision === 'allow' && stillPending) {
      const applyAfterMs = plan.timeoutMs;
      broadcastRoom(room, {
        type: 'opencodePermissionAdvisorPick',
        requestId,
        reply: 'once',
        applyAfterMs,
        advisorDecision: result.advisorDecision,
      }, { log: false });
      const stillAfterWindow = await waitForAdvisorApplyWindow(applyAfterMs, () => (
        isApprovalAdvisorSessionPinValid(room, pin)
        && room._pendingOpenCodePermissions instanceof Map
        && room._pendingOpenCodePermissions.has(requestId)
      ));
      if (stillAfterWindow && isAuthority) {
        replyStatus = await allowOpenCodeReviewPermissionOnce(room, permissionEvent, {
          reason: 'advisor_once',
        });
      }
    }
    const advisorAutomationOutcome = resolveAdvisorReplyOutcome(result, {
      mode: approvalAction?.mode,
      shadow: approvalAction?.shadow,
      stillPending,
      replyStatus,
      role: plan.role,
    });
    recordApprovalAdvisorAudit({
      room,
      permissionEvent,
      approvalAction,
      plan,
      result,
      advisorAutomationOutcome,
    });
    if (advisorAutomationOutcome === 'allow_once') {
      broadcastOpenCodePermissionDecision(room, {
        requestId,
        decidedBy: 'advisor',
        reply: 'once',
        result,
        plan,
        approvalAction,
      });
    }
    broadcastPermissionAdvisorStatus(room, buildOpenCodePermissionAdvisorStatusPayload({
      requestId,
      status: result?.error ? 'error' : 'decided',
      advisorDecision: result?.advisorDecision || 'ask_user',
      finalDecision: advisorAutomationOutcome,
      reason: result?.error || result?.reason || '',
      advisoryAssessment: toPublicAdvisoryAssessment(result?.advisoryAssessment),
      permissionEvent,
      approvalAction,
      plan,
    }));
  } catch (err) {
    const error = 'advisor_run_exception';
    recordApprovalAdvisorAudit({
      room,
      permissionEvent,
      approvalAction,
      plan,
      result: { advisorDecision: 'ask_user', error },
      advisorAutomationOutcome: 'ask_user',
    });
    broadcastPermissionAdvisorStatus(room, buildOpenCodePermissionAdvisorStatusPayload({
      requestId,
      status: 'error',
      reason: 'advisor_run_exception',
      permissionEvent,
      approvalAction,
      plan,
    }));
    console.warn('[approval-advisor] run failed:', error, err?.message || '');
  } finally {
    if (sessionPinActive && requestId) {
      releaseApprovalAdvisorSessionPin(room, requestId);
    }
  }
}

/**
 * @param {any} room
 * @param {object} chat
 */
async function ensureOpenCodeSession(room, chat) {
  if (room.opencodeSessionId) {
    if (isReviewReadOnlyAssignment(room.delegationAssignment)) {
      await syncOpenCodeSessionPlanPermissions(room, room.sdkMode);
    }
    return room.opencodeSessionId;
  }
  const client = await ensureOpenCodeClient(room);
  /** @type {Record<string, unknown>} */
  const body = { title: chat.title || chat.id || 'Cretli chat' };
  const review = isReviewReadOnlyAssignment(room.delegationAssignment);
  const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
  if (isReadOnlySdkMode(room.sdkMode) || review || scoutReadOnly) {
    body.permission = buildOpenCodePlanPermissionRuleset(room.sdkMode, { review, scoutReadOnly });
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
function enqueuePrompt(text, modeOverride, displayText = '', selection = null) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const uiText = resolvePromptUiText(trimmed, displayText);
  const item = { text: trimmed };
  if (uiText && uiText !== trimmed) item.displayText = uiText;
  withSkillSelection(item, selection);
  room.pendingPrompts.push(item);
  broadcastRoom(room, {
    type: 'sdkQueued',
    position: room.pendingPrompts.length,
    text: uiText || trimmed,
  });
}

function drainNextPendingPrompt() {
  drainOnePendingPrompt(room, (/** @type {any} */ next) => {
    schedulePendingPromptRun(next, (/** @type {any} */ item) => {
      void runPrompt(item.text, undefined, true, item.displayText, item.selection);
    });
  }, {
    isBlocked: (targetRoom) => hasPendingOpenCodeUserInput(targetRoom),
  });
}

/**
 * @param {string} text
 * @param {string} [modeOverride]
 * @param {boolean} [fromQueue]
 * @param {string} [displayText]
 * @param {unknown} [selection] Explicit skill IDs / mention policy of this prompt.
 */
async function runPrompt(text, modeOverride, fromQueue = false, displayText = '', selection = null) {
  if (rejectArchivedRoomPrompt(room, broadcastRoom)) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const uiText = resolvePromptUiText(trimmed, displayText);
  if (room.busy) {
    enqueuePrompt(trimmed, modeOverride, displayText, selection);
    return;
  }
  if (!canAcceptNewRun()) {
    if (fromQueue === true) {
      room.pendingPrompts.unshift(withSkillSelection({
        text: trimmed,
        ...(uiText && uiText !== trimmed ? { displayText: uiText } : {}),
      }, selection));
      return;
    }
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
  room._planGuardTriggered = false;
  room._planGuardToolName = '';
  room._awaitingPromptFinish = true;
  const runId = randomUUID();
  room.currentRun = { id: runId, startedAt: Date.now() };
  room._lastUserPromptText = trimmed;
  resetOpenCodeStreamContext(room);
  const timeoutMs = resolveOpenCodePromptTimeoutMs();
  startOpenCodeRunProgress(room, runId, timeoutMs);
  if (modeOverride === 'plan' || modeOverride === 'agent' || modeOverride === 'ask') {
    room.sdkMode = normalizeSdkMode(modeOverride);
  }
  beginEnforcedSdkMode(room, room.sdkMode);
  syncRoomDelegationAssignment(room);
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
        const mcpContext = buildMcpRuntimeContext({
          chat,
          room,
          harness: 'opencode',
          mode: room.sdkMode,
        });
        await syncOpenCodeManagedMcp({
          client,
          workspaceFolder: room.cwd,
          context: mcpContext,
          // A watcher orchestrator waits on a fresh bridge listing mark per run,
          // so keep the previous per-prompt re-add behavior for it.
          force: isWatcherOrchestratorChat(chat, room),
        });
        const mcpPrep = prepareHarnessMcp(mcpContext);
        const mcpBlock = await enforceWatcherOrchestratorMcpGate({
          chat,
          room,
          mcpPrep,
          mcpContext,
          sessionStartedAt: room.currentRun.startedAt,
        });
        if (mcpBlock) {
          runResult = {
            status: 'error',
            message: mcpBlock.message,
            mcpErrorCode: mcpBlock.code,
          };
          runError = null;
          break;
        }
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
        } else if (isAskSdkMode(mode)) {
          body.system = ASK_MODE_SYSTEM;
        }
        // The system hint is part of the context prefix. Track the effective
        // key so a Plan/Ask switch is visible as a prompt-cache invalidation.
        const systemPromptKey = body.system === PLAN_MODE_SYSTEM
          ? 'plan'
          : (body.system === ASK_MODE_SYSTEM ? 'ask' : 'agent');
        if (
          room._openCodeSystemPromptKey !== undefined
          && room._openCodeSystemPromptKey !== systemPromptKey
        ) {
          recordContextRestart({
            chatId: room.chatId || chat.id,
            harness: 'opencode',
            reason: CONTEXT_RESTART_REASON.SYSTEM_PROMPT_CHANGE,
          });
        }
        room._openCodeSystemPromptKey = systemPromptKey;
        const firstEventTimeoutMs = String(room.delegationId || '').trim()
          ? resolveOpenCodeDelegatedFirstEventTimeoutMs()
          : resolveOpenCodeFirstEventTimeoutMs();
        const promptWaiter = createOpenCodePromptRunWaiter(room, timeoutMs, firstEventTimeoutMs);
        void recoverOpenCodeAssistantTextDuringWait(client, room, trimmed, timeoutMs)
          .then((text) => {
            if (!text) return;
            recoveredAssistantText = text;
          })
          .catch(() => {});
        const submissionAbort = new AbortController();
        try {
          runResult = await submitOpenCodePromptAndWait(promptWaiter, () => client.session.promptAsync({
            path: { id: room.opencodeSessionId },
            query: { directory: room.cwd },
            body,
            signal: submissionAbort.signal,
            throwOnError: true,
          }), () => {
            confirmDelegationReportsFromRoom(room);
            updateOpenCodeRunProgressPhase(room, 'awaiting_first_event');
          });
        } finally {
          submissionAbort.abort();
        }
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
              signal: AbortSignal.timeout(10000),
              throwOnError: true,
            });
          } catch {
            // ignore abort failures after timeout
          }
        }
        const shouldRetry = !room.cancelled && attempt < maxAttempts && shouldRetryOpenCodeRun(err);
        if (!shouldRetry) {
          runError = err;
          break;
        }
        recycleOpenCodeConnection(room, { resetSession: true });
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    if (runError) {
      throw tagDelegationAdapterTimeout(runError);
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
      if (runResult.mcpErrorCode) {
        broadcastRoom(room, {
          type: 'sdkError',
          code: runResult.mcpErrorCode,
          message: runResult.message || 'Cretli MCP bridge is not ready.',
        });
        broadcastRoom(room, {
          type: 'sdkRunFinished',
          runId,
          status: 'error',
          lastErrorCode: runResult.mcpErrorCode,
          lastErrorMessage: runResult.message || 'Cretli MCP bridge is not ready.',
          remaining: room.pendingPrompts.length,
        }, { log: true });
      } else {
      broadcastOpenCodeRunError(room, runId, runResult.message || 'OpenCode session error');
      }
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
    broadcastOpenCodeRunError(room, runId, err?.message || String(err), err);
  } finally {
    room._awaitingPromptFinish = false;
    room._planGuardTriggered = false;
    room._planGuardToolName = '';
    room.currentRun = null;
    clearEnforcedSdkMode(room);
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
  const instanceOptions = openCodeInstanceOptions(room);
  const instance = await getOrCreateOpenCodeInstance(instanceOptions);
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
      directory: instanceOptions.workspaceFolder,
      answers: Array.isArray(payload?.answers) ? payload.answers : [],
      reject: payload?.reject === true,
    });
    room._pendingOpenCodeQuestions?.delete(requestId);
    broadcastRoom(room, {
      type: 'opencodeQuestionResolved',
      requestId,
    });
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
  // Manual path stays authoritative, but a second click / late broker reply
  // must not POST twice for the same requestId.
  if (!claimOpenCodePermissionReply(room, requestId)) return;
  const pending = room._pendingOpenCodePermissions instanceof Map
    ? room._pendingOpenCodePermissions.get(requestId)
    : null;
  const sessionId = typeof pending?.sessionId === 'string'
    ? pending.sessionId
    : room.opencodeSessionId;
  const instanceOptions = openCodeInstanceOptions(room);
  const instance = await getOrCreateOpenCodeInstance(instanceOptions);
  try {
    await postOpenCodePermissionResponse({
      baseUrl: instance.baseUrl,
      requestId,
      sessionId,
      directory: instanceOptions.workspaceFolder,
      reply,
      message: typeof payload?.message === 'string' ? payload.message : '',
    });
    const brokerMode = readApprovalBrokerMode(loadSettings());
    const assessmentSnapshot = pending?.approvalActionSnapshot && typeof pending.approvalActionSnapshot === 'object'
      ? pending.approvalActionSnapshot
      : null;
    const approvalAction = assessmentSnapshot
      || (pending
        ? resolveOpenCodeApprovalAction({
          mode: brokerMode,
          settings: loadSettings(),
          sdkMode: readEnforcedSdkMode(room),
          permissionEvent: pending,
          assignment: room.delegationAssignment || '',
          workspaceFolder: instanceOptions.workspaceFolder,
        })
        : null);
    recordApprovalHumanPermissionDecisionAudit({
      room,
      permissionEvent: pending || { requestId, sessionId },
      approvalAction,
      approvalActionSnapshot: assessmentSnapshot,
      humanReply: reply,
    });
    broadcastOpenCodePermissionDecision(room, { requestId, decidedBy: 'user', reply });
    removePendingOpenCodePermission(room, requestId);
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
  } catch (err) {
    // Let the human retry the same card instead of silently losing the reply.
    releaseOpenCodePermissionReplyClaim(room, requestId);
    throw err;
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
        signal: AbortSignal.timeout(10000),
        throwOnError: true,
      });
    } catch {
      // A connection failure alone cannot prove that execution stopped.
      // A confirmed exit of our owned process does permit finishing the stop.
      if (!hasOpenCodeInstanceExited(openCodeInstanceOptions(room))) return;
    }
    // Abort acknowledged or process exited: drop stale input cards and end the prompt waiter now
    // instead of waiting for an idle event that may never come.
    const settled = settleOpenCodePromptRunAfterAbort(room);
    for (const requestId of settled.questionIds) {
      broadcastRoom(room, { type: 'opencodeQuestionResolved', requestId });
    }
    for (const requestId of settled.permissionIds) {
      forgetPermissionAdvisorStatus(room, requestId);
      releaseApprovalAdvisorSessionPin(room, requestId);
      broadcastRoom(room, { type: 'opencodePermissionResolved', requestId }, { log: false });
    }
    if (!room._awaitingPromptFinish && room.busy) {
      room.busy = false;
      broadcastBusyState(room, false);
    }
    if (settled.questionIds.length || settled.permissionIds.length) sendRoomState(room);
  };
  bindRoomRecoveryLifecycle({ room, chat, transport: 'opencode' });
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
  const cwd = resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
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
  const isNewRoom = !room;
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
  if (isNewRoom) void ensureOpenCodeEventSubscription(room);
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
  replayPendingPermissionAdvisorStatus(room, ws);

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
      void room.startPrompt(msg.text, msg.mode, false, readClientDisplayText(msg), readClientSkillSelection(msg));
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
  const cwd = resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = openCodeRooms.get(sessionKey);
  const isNewRoom = !room;
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
  stampWatcherOrchestratorRoom(room, chat, deps);
  if (isNewRoom) void ensureOpenCodeEventSubscription(room);
  bindOpenCodePromptRunner(room, chat);
  return { room, chat };
}

/**
 * @param {{ chat: object, prompt: string, mode?: string, displayText?: string, selectedSkillIds?: string[], requestId?: string, deps?: object }} input
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
  bindOpenCodePromptRunner(room, chat);
  return acceptRoomPrompt(room, {
    prompt: input.prompt,
    mode: input.mode,
    displayText: input.displayText,
    selectedSkillIds: input.selectedSkillIds,
    requestId: input.requestId,
  }, (current) => current._pendingOpenCodeQuestions instanceof Map && current._pendingOpenCodeQuestions.size > 0);
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

// The room's own runtime reattach claim, declared ONCE and passed to BOTH the
// capability surface and the durable lookup (finding F1). Two independent
// literals would let one surface say resume/reattach is available while the
// other denied it.
const OPENCODE_REATTACH_CAPABILITY = true;

registerChatRunAdapter({
  transport: 'opencode',
  start: startOpenCodeChatRun,
  cancel: cancelOpenCodeChatRun,
  // OpenCode rooms are kernel-backed too: the prompt runner lives in the
  // OpenCode server, so a restart loses the room but not the durable run row.
  lookupRequest: createDurableRequestLookup({
    transport: 'opencode',
    rooms: openCodeRooms,
    reattachCapability: OPENCODE_REATTACH_CAPABILITY,
  }),
  capabilities: {
    canLookupRequest: true,
    canCancel: true,
    canReconstructSession: true,
    canReadFiles: true,
    canSearch: true,
    deniesMutation: false,
    // The MVP table grants reattach only to opencode; the room says whether this
    // process can still reach that server session.
    canReattach: OPENCODE_REATTACH_CAPABILITY,
  },
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
