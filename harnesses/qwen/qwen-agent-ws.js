import { notifyDecisionGateChange } from '../../lib/decisions/gate-changes.js';
import { registerDecisionGateSource, decisionRoomWorkspace, questionGate } from '../../lib/decisions/host-gates.js';
/**
 * WebSocket rooms for the Qwen Code SDK harness — SDK-compatible event protocol.
 */

import { auditCanUseToolGuardDeny } from '../../lib/approval/can-use-tool-adapter.ts';
import {
  rejectPendingCanUseToolPermissions,
  replyCanUseToolPermission,
  requestCanUseToolPermission,
} from '../../lib/approval/can-use-tool-permission.ts';
import { loadSettings } from '../../lib/persist/settings.js';
import { randomUUID } from 'crypto';
import { rejectArchivedRoomPrompt } from '../../lib/chat-message-guard.js';
import {
  getChatByCursorSessionId,
  setChatQwenSessionId,
  updateChat,
} from '../../lib/persist/chats-persist.js';
import { resolveExecutionFolderForChat } from '../../lib/execution-folder.js';
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode, readEnforcedSdkMode, toNativeAgentMode } from '../../lib/sdk/sdk-mode.ts';
import { buildAgentHelloPayload } from '../../lib/sdk/sdk-ws-handshake.ts';
import { sendSdkChatNotFoundAndClose } from '../../lib/sdk/sdk-ws-chat-gone.ts';
import { buildUserEvent } from '../../lib/agent-harness/event-normalizer.ts';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../../lib/prompt-ui-text.js';
import {
  setActiveSelection,
  readClientSkillSelection,
  withSkillSelection,
} from '../../lib/skills/skill-selection.js';
import { handleQueueControlMessage } from '../../lib/agent-harness/queue-controls.ts';
import { createQwenEventNormalizer } from './qwen-event-normalizer.js';
import { createAgentRoomKernel } from '../../lib/agent-harness/room-kernel.ts';
import { isQwenChat } from '../../lib/agent-transport.js';
import {
  resolvePlanModeSdkEventDecision,
  resolvePlanModeToolDecision,
  resolveReadOnlyGuardUserMessage,
} from '../../lib/sdk/sdk-plan-guard.ts';
import { resolvePlanGuardMcpServerIdentity } from '../../lib/mcp/mcp-session.js';
import { trackSdkRoomRunOutcome } from '../../lib/sdk/sdk-run-outcome.ts';
import { decorateHarnessPrompt } from '../../lib/sdk/harness-plan-prompt.ts';
import { CONTEXT_RESTART_REASON, advanceRoomContextEpoch, recordContextRestart } from '../../lib/usage/context-restarts.ts';
import { bindHarnessPlanSync } from '../../lib/sdk/harness-plan-sync.ts';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../../lib/delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../../lib/delegation-report-context.js';
import { bindRoomRecoveryLifecycle, registerKernelChatRunAdapter } from '../../lib/chat-run/kernel-adapter.ts';
import { drainOnePendingPrompt } from '../../lib/agent-harness/pending-prompt-drain.ts';
import { registerPendingPromptRoomSource } from '../../lib/agent-harness/pending-prompt-resume.ts';
import { canAcceptNewRun } from '../../lib/update-gate.js';
import { msg } from '../../lib/messages.js';
import { buildQwenProcessEnv, getEffectiveQwenApiKey } from './qwen-api-key.js';
import { resolveQwenCli } from './qwen-cli.js';
import { loadQwenSdk } from './qwen-sdk.js';
import { resolveDefaultQwenModel, resolveQwenRunModel } from './qwen-models.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../../lib/mcp/mcp-session.js';
import {
  enforceWatcherOrchestratorMcpGate,
  isMcpOrchestratorErrorCode,
  stampWatcherOrchestratorRoom,
} from '../../lib/mcp/watcher-orchestrator-mcp-gate.js';
import { toQwenMcpServers } from '../../lib/mcp/mcp-vendor-map.js';
import {
  buildCanUseToolResult,
  createAskUserQuestionCanUseTool,
  ASK_USER_QUESTION_TIMEOUT_MS,
} from '../../lib/approval/ask-user-question.ts';
import { notifyAgentNeedsInput } from '../../lib/agent-needs-input-push.js';
import { SCOUT_READ_ONLY_MESSAGE, isScoutReadOnlyChatId } from '../../lib/workspace-scout-chat.js';
import {
  collectQwenRunErrorMessages,
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
export function isResumableQwenSessionId(value) {
  const id = String(value || '').trim();
  if (!id) return false;
  return id.toLowerCase() !== 'current';
}

/**
 * Track the Qwen CLI session identity used by the prompt-decoration state.
 *
 * The static skills/rules block lives in the conversation that the resumed CLI
 * session carries. When the session id changes under a live room (the CLI
 * created a new session instead of resuming, or the persisted id was reset
 * elsewhere) the earlier copy is gone, so record a context restart that makes
 * the next turn re-emit the full static block. The first observed id is not a
 * restart — it is the fresh state of a new room.
 *
 * @param {any} room
 * @param {unknown} sessionId
 * @returns {void}
 */
export function noteQwenSessionIdentity(room, sessionId) {
  if (!room) return;
  const next = isResumableQwenSessionId(sessionId) ? String(sessionId).trim() : '';
  if (!next) return;
  const previous = String(room._decorationQwenSessionId || '');
  if (previous && previous !== next) {
    recordContextRestart({
      chatId: room.chatId,
      harness: 'qwen',
      reason: CONTEXT_RESTART_REASON.SESSION_DROP,
    });
  }
  room._decorationQwenSessionId = next;
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
registerDecisionGateSource('qwen-questions', (workspaceFolder) => [...qwenRooms.values()]
  .filter((room) => decisionRoomWorkspace(room) === workspaceFolder)
  .flatMap((room) => [...(room._pendingQuestions || new Map()).values()]
    .filter((event) => event.type !== 'opencode_permission')
    .map((event) => questionGate(room, event, (payload) => resolveQwenQuestion(room, payload.requestId, payload)))
    .filter(Boolean)));

registerPendingPromptRoomSource(() => qwenRooms.values());
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
  notifyDecisionGateChange(decisionRoomWorkspace(room));
  broadcastRoom(room, {
    type: 'questionResolved',
    requestId,
  });
  sendRoomState(room);
  return true;
}

/**
 * @param {any} room
 * @param {string} [reason]
 */
function rejectPendingQwenQuestions(room, reason = 'aborted') {
  if (!room) return;
  rejectPendingCanUseToolPermissions(room, reason);
  ensureQwenQuestionState(room);
  const requestIds = [...room._qwenQuestionWaiters.keys()];
  for (const requestId of requestIds) {
    resolveQwenQuestion(room, requestId, { reject: true, reason });
  }
}

/**
 * @param {any} room
 * @returns {import('../../lib/approval/can-use-tool-permission.ts').CanUseToolPermissionHost}
 */
function createQwenPermissionHost(room) {
  return {
    broadcast: (payload, opts) => broadcastRoom(room, payload, opts),
    onPendingChange: () => sendRoomState(room),
    notify: (event) => notifyAgentNeedsInput({ room, event }),
  };
}

/**
 * @param {any} room
 * @returns {(toolName: string, input: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<{
 *   behavior: 'allow' | 'deny',
 *   updatedInput?: Record<string, unknown>,
 *   message?: string,
 * }>}
 */
export function createRoomQwenCanUseTool(room, deps = {}) {
  const inner = createAskUserQuestionCanUseTool({
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
  const readSettings = deps.loadSettings || loadSettings;
  return async (toolName, input, options = {}) => {
    const assignment = room.delegationAssignment;
    const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
    const decision = resolvePlanModeToolDecision({
      transport: 'qwen',
      mode: readEnforcedSdkMode(room),
      assignment,
      toolName,
      input,
      scoutReadOnly,
      projectRoot: room.cwd,
      mcpServer: resolvePlanGuardMcpServerIdentity({ room, harness: 'qwen', toolName, args: input }),
    });
    if (decision.deny) {
      try {
        auditCanUseToolGuardDeny({
          harness: 'qwen',
          room,
          toolName,
          input,
          settings: readSettings(),
          sdkMode: readEnforcedSdkMode(room),
          scoutReadOnly,
        }, deps.auditOptions);
      } catch {
        // Audit is best effort and never changes the callback result.
      }
      return buildCanUseToolResult({
        behavior: 'deny',
        message: scoutReadOnly
          ? SCOUT_READ_ONLY_MESSAGE
          : resolveReadOnlyGuardUserMessage(readEnforcedSdkMode(room), assignment),
      });
    }
    let permission;
    try {
      permission = await requestCanUseToolPermission({
        harness: 'qwen',
        room,
        toolName,
        input,
        signal: options.signal,
        // Same bound as the Qwen SDK canUseTool timeout; test seam via deps.permissionTimeoutMs.
        timeoutMs: deps.permissionTimeoutMs ?? ASK_USER_QUESTION_TIMEOUT_MS,
        sdkMode: readEnforcedSdkMode(room),
        scoutReadOnly,
        host: createQwenPermissionHost(room),
        settings: readSettings(),
        auditOptions: deps.auditOptions,
        advisor: deps.advisor,
      });
    } catch (err) {
      // Fail closed: an unexpected gate failure must not silently allow.
      console.warn('[qwen] permission gate failed:', err?.message || err);
      return buildCanUseToolResult({ behavior: 'deny', message: 'Permission check failed' });
    }
    if (permission.outcome === 'deny') {
      return buildCanUseToolResult({
        behavior: 'deny',
        message: permission.message || 'Permission denied',
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
  const assignment = room.delegationAssignment;
  const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
  const decision = resolvePlanModeSdkEventDecision({
    transport: 'qwen',
    mode,
    assignment,
    event,
    scoutReadOnly,
    projectRoot: room.cwd,
    mcpServer: resolvePlanGuardMcpServerIdentity({ room, harness: 'qwen', event }),
  });
  if (!decision.notify) return false;
  if (decision.abortRun) {
    room.cancelled = true;
    room._planGuardTriggered = true;
    void interruptActiveQuery(room);
  }
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    message: scoutReadOnly ? SCOUT_READ_ONLY_MESSAGE : resolveReadOnlyGuardUserMessage(mode, assignment),
    toolName: typeof event.name === 'string' ? event.name : '',
  });
  return true;
}

/**
 * Folds one Qwen usage payload into the room's SDK-compatible cumulative bag.
 *
 * Delegation metrics read `inputTokens`/`outputTokens`, but the cache counters
 * must survive too so cache-state inference can see them. Qwen reports raw
 * snake_case; `cache_creation_input_tokens` is accepted when the OpenAI
 * compatible path supplies it.
 *
 * @param {any} prev
 * @param {unknown} usage
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }}
 */
export function accumulateQwenUsagePayload(prev, usage) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const rec = usage && typeof usage === 'object' ? usage : {};
  return {
    inputTokens: (Number(base.inputTokens) || 0) + (Number(rec.input_tokens) || 0),
    outputTokens: (Number(base.outputTokens) || 0) + (Number(rec.output_tokens) || 0),
    cacheReadTokens: (Number(base.cacheReadTokens) || 0) + (Number(rec.cache_read_input_tokens) || 0),
    cacheWriteTokens: (Number(base.cacheWriteTokens) || 0) + (Number(rec.cache_creation_input_tokens) || 0),
  };
}

/**
 * Latest assistant answer of a run. Qwen Cloud surfaces quota failures as this
 * prose instead of `api_error` telemetry, so the run error must be able to read
 * it back after the loop ends.
 *
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function readAssistantEventText(event) {
  const message = event && typeof event === 'object' ? event.message : null;
  const content = message && typeof message === 'object' && Array.isArray(message.content)
    ? message.content
    : [];
  return content
    .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Broadcasts one normalized usage item as a `usage` sdkEvent (the room kernel
 * turns it into a ledger delta carrying the delegation id).
 *
 * @param {any} room
 * @param {Record<string, any>} item
 * @returns {boolean} true when a usage event was broadcast
 */
export function emitQwenUsage(room, item) {
  if (!item || !item.usage || typeof item.usage !== 'object') return false;
  // Store in SDK-compatible shape so delegation-run-bridge can read
  // inputTokens/outputTokens; cache counters are preserved for cache state.
  room._lastUsagePayload = accumulateQwenUsagePayload(room._lastUsagePayload, item.usage);
  /** @type {Record<string, unknown>} */
  const usageEvent = { type: 'usage', usage: item.usage };
  if (item.totalCostUsd != null) usageEvent.totalCostUsd = item.totalCostUsd;
  if (item.durationMs != null) usageEvent.durationMs = item.durationMs;
  if (item.modelUsage && typeof item.modelUsage === 'object') usageEvent.modelUsage = item.modelUsage;
  broadcastRoom(room, { type: 'sdkEvent', event: usageEvent });
  return true;
}

/**
 * Flushes usage of an assistant message cut short by abort/error so the tokens
 * already consumed reach the ledger before the run is finished.
 *
 * @param {any} room
 * @returns {boolean}
 */
export function flushQwenPendingUsage(room) {
  const pending = room?._qwenNormalizer?.flushPendingUsage?.();
  return pending ? emitQwenUsage(room, pending) : false;
}

/**
 * @param {any} room
 * @param {unknown} message
 */
function handleNormalizedMessage(room, message) {
  if (!room._qwenNormalizer || typeof room._qwenNormalizer.normalize !== 'function') {
    room._qwenNormalizer = createQwenEventNormalizer();  }
  const items = room._qwenNormalizer.normalize(message);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'session' && isResumableQwenSessionId(item.sessionId)) {
      room.qwenSessionId = item.sessionId;
      noteQwenSessionIdentity(room, item.sessionId);
      if (room.chatId) setChatQwenSessionId(room.chatId, item.sessionId);
      continue;
    }
    if (item.kind === 'notice') {
      // Native compaction rewrites the prompt prefix and destroys the cache.
      if (item.noticeType === 'compact') advanceRoomContextEpoch(room, 'compact_boundary');
      broadcastRoom(room, { type: 'sdkEvent', event: item });
      continue;
    }
    if (item.kind === 'api_error') {
      applyQwenApiError(room, item);
      continue;
    }
    if (item.kind === 'usage' && emitQwenUsage(room, item)) continue;
    if (item.kind === 'result') {
      room._lastResult = item;
      if (isResumableQwenSessionId(item.sessionId)) {
        room.qwenSessionId = item.sessionId;
        noteQwenSessionIdentity(room, item.sessionId);
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
    if (item.type === 'assistant') {
      // Keep the latest answer around: a quota failure is often only present
      // here, and the run error must still see it after the loop ends.
      const assistantText = readAssistantEventText(item);
      if (assistantText) room._lastAssistantText = assistantText;
    }
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
  noteQwenSessionIdentity(room, sessionId);
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
  function enqueuePrompt(text, modeOverride, displayText = '', selection = null) {
    const uiText = resolvePromptUiText(text, displayText);
    const item = {
      text,
      mode: normalizeSdkMode(modeOverride || room.sdkMode),
    };
    if (uiText && uiText !== text) item.displayText = uiText;
    withSkillSelection(item, selection);
    room.pendingPrompts.push(item);
    broadcastRoom(room, { type: 'sdkQueued', text: uiText || text }, { log: false });
    sendRoomState(room);
  }

  /**
   * @returns {void}
   */
  function drainQueue() {
    drainOnePendingPrompt(room, (/** @type {any} */ next) => {
      void runPrompt(next.text, next.mode, true, next.displayText, next.selection);
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
          mode: normalizeSdkMode(modeOverride || room.sdkMode),
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
    room._lastResult = null;
    room._lastAssistantText = '';
    room._qwenApiErrorApplied = false;
    room._qwenLastApiErrorMessage = '';
    room._qwenFatalApiError = null;
    room._qwenNormalizer = createQwenEventNormalizer();
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
    /** @type {string[]} */
    let errorMessages = [];
    let mcpGateErrorCode = '';
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
          canUseTool: ASK_USER_QUESTION_TIMEOUT_MS,
        },
      };
      const cliPath = resolveQwenCli();
      if (cliPath) options.pathToQwenExecutable = cliPath;
      if (isResumableQwenSessionId(room.qwenSessionId)) options.resume = room.qwenSessionId;
      const chatRow = getChatByCursorSessionId(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'qwen' };
      const mcpContext = buildMcpRuntimeContext({
        chat: chatRow,
        room,
        harness: 'qwen',
        mode: room.sdkMode,
      });
      const mcpPrep = prepareHarnessMcp(mcpContext);
      // The Qwen SDK starts its CLI with the first prompt, so the bridge mark
      // cannot exist before the gate. Probe the managed bridge catalog instead.
      const mcpBlock = await enforceWatcherOrchestratorMcpGate({
        chat: chatRow,
        room,
        mcpPrep,
        mcpContext,
        sessionStartedAt: room.currentRun.startedAt,
        bridgeStrategy: 'preflight',
      });
      if (mcpBlock) {
        mcpGateErrorCode = mcpBlock.code;
        status = 'error';
        errorMessage = mcpBlock.message;
      } else {
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
        errorMessages = collectQwenRunErrorMessages({ fatalErrorMessage: errorMessage });
      } else if (room._planGuardTriggered) {
        status = 'plan_guard_cancelled';
        errorMessage = resolveReadOnlyGuardUserMessage(mode, room.delegationAssignment);
      } else if (room.cancelled) {
        status = 'cancelled';
      } else if (room._lastResult && room._lastResult.status === 'error') {
        status = 'error';
        // Keep every variant of the failure: the provider's reset clock can sit
        // in the assistant prose while the result record only carries a generic
        // text (or nothing at all).
        errorMessages = collectQwenRunErrorMessages({
          resultErrorMessage: room._lastResult.errorMessage,
          resultText: room._lastResult.resultText,
          assistantText: room._lastAssistantText,
        });
        errorMessage = String(errorMessages[0] || 'Qwen run failed');
      }
      }
    } catch (err) {
      const errCode = String(err?.code || '');
      if (isMcpOrchestratorErrorCode(errCode)) mcpGateErrorCode = errCode;
      if (room._qwenFatalApiError) {
        status = 'error';
        errorMessage = room._qwenFatalApiError.displayMessage;
        errorMessages = collectQwenRunErrorMessages({ fatalErrorMessage: errorMessage });
      } else if (room.cancelled || room._planGuardTriggered) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else {
        status = 'error';
        errorMessages = collectQwenRunErrorMessages({
          resultErrorMessage: err?.message ? String(err.message) : String(err),
          assistantText: room._lastAssistantText,
        });
        errorMessage = String(errorMessages[0] || 'Qwen run failed');
      }
    } finally {
      flushQwenPendingUsage(room);
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
      // All error variants of the failed run: the shared usage-limit parser
      // reads them so the provider's reset clock is never shadowed by a generic
      // fallback such as "Qwen run failed".
      if (errorMessages.length) finished.lastErrorMessages = errorMessages;
      if (errorMessage && status === 'error') {
        finished.lastErrorCode = mcpGateErrorCode || room._qwenFatalApiError?.code || 'qwen_error';
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
  room.drainQueue = drainQueue;
  room.cancelCurrentRun = cancelCurrentRun;
  bindRoomRecoveryLifecycle({ room, chat: getChatByCursorSessionId(room.sessionKey), transport: 'qwen' });
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
  const cwd = resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
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
      _lastAssistantText: '',
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
      noteQwenSessionIdentity(room, chat.qwenSessionId);
    }
    ensureQwenQuestionState(room);
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  stampWatcherOrchestratorRoom(room, chat, deps);
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
    if (handleQueueControlMessage(room, msg, { broadcast: broadcastRoom })) return;
    if (msg.type === 'setSdkMode') {
      applySdkModeIfChanged(room, msg.mode, { chatId: chat.id, updateChat });
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void room.startPrompt(msg.text, msg.mode, false, readClientDisplayText(msg), readClientSkillSelection(msg));
      return;
    }
    if (msg.type === 'opencodePermissionReply' && typeof msg.requestId === 'string') {
      const resolved = replyCanUseToolPermission(room, createQwenPermissionHost(room), msg);
      if (!resolved && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'opencodePermissionResolved', requestId: msg.requestId }));
      }
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
