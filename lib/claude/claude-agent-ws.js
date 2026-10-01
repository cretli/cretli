/**
 * WebSocket rooms for the Claude Agent SDK harness — SDK-compatible event protocol.
 *
 * Phase 3 keeps one long-lived `Query` per room in streaming-input mode
 * (`prompt` = AsyncIterable<SDKUserMessage>). Turns push user messages into
 * `room._claudeSession.input`; one consumer loop routes SDK messages back to
 * the active turn. `setModel` / `setPermissionMode` / `setMcpServers` and
 * `interrupt` are control requests that keep the process and its MCP
 * connections alive. `CRETLI_CLAUDE_STREAMING_SESSION=0` restores the
 * one-shot per-prompt `query({ prompt: string })` path.
 *
 * `permissionMode` never uses `bypassPermissions`:
 * - Agent uses `acceptEdits` (the SDK has no `yolo` mode).
 * - Plan uses the native `plan` mode.
 * - Ask and review use `default`, and `canUseTool` denies mutations before exec.
 */

import { randomUUID } from 'crypto';
import {
  getChatByCursorSessionId,
  setChatClaudeSessionId,
  updateChat,
} from '../persist/chats-persist.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import {
  beginEnforcedSdkMode,
  clearEnforcedSdkMode,
  isAskSdkMode,
  isPlanSdkMode,
  isReadOnlySdkMode,
  normalizeSdkMode,
  readEnforcedSdkMode,
} from '../sdk/sdk-mode.js';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.js';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.js';
import { buildUserEvent } from '../agent-harness/event-normalizer.js';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { createClaudeEventNormalizer } from '../agent-harness/claude-event-normalizer.js';
import { handleQueueControlMessage } from '../agent-harness/queue-controls.js';
import { createAgentRoomKernel } from '../agent-harness/room-kernel.js';
import { isClaudeChat } from '../agent-transport.js';
import {
  resolvePlanModeSdkEventDecision,
  resolvePlanModeToolDecision,
  resolveReadOnlyGuardUserMessage,
} from '../sdk/sdk-plan-guard.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.js';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { registerKernelChatRunAdapter } from '../chat-run/kernel-adapter.js';
import { getClaudeAuthMode } from './claude-auth-mode.js';
import { buildClaudeProcessEnv, isClaudeHarnessConfigured } from './claude-api-key.js';
import { loadClaudeSdk } from './claude-sdk.js';
import {
  collectClaudeIdleNotices,
} from '../agent-harness/claude-event-normalizer.js';
import {
  isClaudeSessionModelCatalogFresh,
  resolveClaudeRunModel,
  resolveClaudeRunEffort,
  resolveDefaultClaudeModel,
  setClaudeSessionModelCatalog,
} from './claude-models.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { toClaudeMcpServers } from '../mcp/mcp-vendor-map.js';
import { createQwenCanUseTool } from '../qwen/qwen-question.js';
import { notifyAgentNeedsInput } from '../agent-needs-input-push.js';
import {
  armClaudeSessionIdleTimer,
  buildClaudeAuthSignature,
  buildClaudeMcpSignature,
  buildClaudeSessionStartKey,
  buildClaudeTuningSignature,
  buildClaudeUserMessage,
  clearClaudeSessionIdleTimer,
  closeClaudeSession,
  createClaudeStreamingSession,
  diffClaudeSessionStartKey,
  isClaudeSessionAlive,
  isClaudeStreamingSessionEnabled,
  parseClaudeEffortLevel,
  resolveClaudeRunTuning,
  resolveClaudeSessionIdleMs,
  syncClaudeSessionIdleWithPendingQuestions,
} from './claude-session.js';

/** Default wait for AskUserQuestion replies (30 minutes). */
export const CLAUDE_QUESTION_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveClaudeQuestionTimeoutMs(env = process.env) {
  const raw = Number(env?.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return CLAUDE_QUESTION_TIMEOUT_MS_DEFAULT;
}

/**
 * @param {string} requestId
 * @param {{ reject?: boolean, reason?: string }} payload
 * @returns {Record<string, unknown>}
 */
export function buildClaudeQuestionResolvedPayload(requestId, payload = {}) {
  if (payload.reject === true) {
    const reason = String(payload.reason || 'cancelled').trim() || 'cancelled';
    const status = reason === 'timeout' || reason === 'session_closed' ? 'expired' : 'cancelled';
    return { type: 'questionResolved', requestId, status, reason };
  }
  return { type: 'questionResolved', requestId, status: 'answered' };
}

/**
 * @param {string} [value]
 * @returns {boolean}
 */
export function isResumableClaudeSessionId(value) {
  const id = String(value || '').trim();
  if (!id) return false;
  return id.toLowerCase() !== 'current';
}

/**
 * Native `permissionMode` for a chat conversation mode.
 * The SDK only supports `plan`/`acceptEdits` for read-only/agent; Ask and
 * review keep the SDK default so `canUseTool` is consulted before every edit.
 *
 * @param {unknown} mode
 * @param {unknown} [assignment]
 * @returns {'plan' | 'acceptEdits' | 'default'}
 */
export function resolveClaudePermissionMode(mode, assignment) {
  if (isReviewReadOnlyAssignment(assignment)) return 'default';
  if (isAskSdkMode(mode)) return 'default';
  if (isPlanSdkMode(mode)) return 'plan';
  return 'acceptEdits';
}

function abortClaudeRoom(room) {
  if (!room) return;
  room.cancelled = true;
  void interruptActiveQuery(room);
  closeClaudeSession(room);
  settleActiveClaudeTurn(room, { reason: 'session_closed' });
}

const kernel = createAgentRoomKernel({
  transport: 'claude',
  logLabel: 'claude-ws',
  goneMessage: 'Claude chat not found for this session.',
  abortRoom: abortClaudeRoom,
  afterBroadcast(room, payload) {
    trackSdkRoomRunOutcome(room, payload);
    noteDelegationRoomEvent(room, payload);
  },
});
const claudeRooms = kernel.rooms;
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
export function disposeClaudeRoom(sessionKey) {
  kernel.disposeRoom(sessionKey);
}

/**
 * Native tools that mutate files. Denied up front in read-only modes so they
 * are never offered to the model (and cannot slip past a settings allow rule).
 */
export const CLAUDE_READ_ONLY_DISALLOWED_TOOLS = Object.freeze([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Explicit settings sources for read-only runs. `project` keeps CLAUDE.md
 * loading while avoiding user/local permission allow rules that can shadow the
 * tool callbacks. Agent mode leaves `settingSources` unset so the SDK keeps its
 * default sources (user + project + local).
 */
export const CLAUDE_AGENT_SETTING_SOURCES = Object.freeze(['project']);

/**
 * `Options.systemPrompt` when nothing is passed. Per the SDK 0.3.284 option
 * normalizer an absent `systemPrompt` becomes the empty custom prompt `""`,
 * not Claude Code's built-in prompt; the explicit preset preserves the
 * intended Claude Code behaviour. No `append` is added.
 */
export const CLAUDE_SYSTEM_PROMPT = Object.freeze({ type: 'preset', preset: 'claude_code' });

/** How long `interrupt()` may take before falling back to abort/close. */
export const CLAUDE_INTERRUPT_TIMEOUT_MS = 3000;

/**
 * After a successful `interrupt()` the streaming iterator keeps living. If the
 * active turn has not ended by then, abort the controller and close the
 * session as a last resort.
 */
export const CLAUDE_INTERRUPT_ABORT_FALLBACK_MS = 5000;

/**
 * @param {unknown} mode
 * @param {unknown} [assignment]
 * @returns {boolean}
 */
export function isClaudeReadOnlyRunMode(mode, assignment) {
  return isReviewReadOnlyAssignment(assignment) || isReadOnlySdkMode(mode);
}

/**
 * Shared Plan/Ask/review decision for one tool invocation.
 *
 * @param {any} room
 * @param {unknown} toolName
 * @param {unknown} input
 * @returns {{ deny: boolean, abortRun: boolean, notify: boolean }}
 */
function resolveRoomClaudeToolDecision(room, toolName, input) {
  return resolvePlanModeToolDecision({
    transport: 'claude',
    mode: readEnforcedSdkMode(room),
    assignment: room?.delegationAssignment,
    toolName,
    input,
  });
}

/**
 * Builds the `canUseTool` callback for a room. Mutations are denied before
 * execution in Plan / Ask / review; every other tool is allowed.
 *
 * @param {any} room
 * @returns {(toolName: string, input: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<{
 *   behavior: 'allow' | 'deny',
 *   updatedInput?: Record<string, unknown>,
 *   message?: string,
 * }>}
 */
export function createRoomClaudeCanUseTool(room) {
  const questionTool = createQwenCanUseTool({
    generateId: () => randomUUID(),
    emitQuestion: (event) => {
      const requestId = String(event?.requestId || '');
      if (!requestId) return;
      if (!(room._pendingQuestions instanceof Map)) room._pendingQuestions = new Map();
      room._pendingQuestions.set(requestId, event);
      broadcastRoom(room, { type: 'sdkEvent', event });
      sendRoomState(room);
      syncClaudeSessionIdleWithPendingQuestions(room);
      notifyAgentNeedsInput({ room, event });
    },
    waitForReply: (requestId, options = {}) => new Promise((resolve) => {
      if (!(room._claudeQuestionWaiters instanceof Map)) room._claudeQuestionWaiters = new Map();
      let settled = false;
      let timeoutTimer = null;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        room._claudeQuestionWaiters.delete(requestId);
        room._pendingQuestions?.delete(requestId);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        options.signal?.removeEventListener('abort', onAbort);
        syncClaudeSessionIdleWithPendingQuestions(room);
        resolve(payload);
      };
      const onAbort = () => {
        resolveClaudeQuestion(room, requestId, { reject: true, reason: 'cancelled' });
      };
      room._claudeQuestionWaiters.set(requestId, finish);
      const timeoutMs = resolveClaudeQuestionTimeoutMs();
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          resolveClaudeQuestion(room, requestId, { reject: true, reason: 'timeout' });
        }, timeoutMs);
        if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
      }
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    }),
  });
  return async (toolName, input, options = {}) => {
    const decision = resolveRoomClaudeToolDecision(room, toolName, input);
    if (decision.deny) {
      return {
        behavior: 'deny',
        message: resolveReadOnlyGuardUserMessage(readEnforcedSdkMode(room), room?.delegationAssignment),
      };
    }
    return questionTool(toolName, input, options);
  };
}

/**
 * @param {any} room
 * @param {string} requestId
 * @param {{ answers?: Array<Array<string>>, reject?: boolean, reason?: string }} payload
 * @returns {boolean}
 */
export function resolveClaudeQuestion(room, requestId, payload) {
  const id = String(requestId || '').trim();
  if (!id) return false;
  const waiter = room?._claudeQuestionWaiters?.get(id);
  if (typeof waiter !== 'function') return false;
  waiter(payload);
  broadcastRoom(room, buildClaudeQuestionResolvedPayload(id, payload));
  sendRoomState(room);
  return true;
}

/**
 * @param {any} room
 * @param {string} [reason]
 * @returns {void}
 */
export function rejectPendingClaudeQuestions(room, reason = 'cancelled') {
  if (!(room?._claudeQuestionWaiters instanceof Map)) return;
  for (const requestId of [...room._claudeQuestionWaiters.keys()]) {
    resolveClaudeQuestion(room, requestId, { reject: true, reason });
  }
}

/**
 * Replays pending AskUserQuestion cards to a reconnecting browser tab.
 *
 * @param {any} room
 * @param {import('ws').WebSocket} ws
 * @returns {void}
 */
export function sendPendingClaudeQuestionsToClient(room, ws) {
  if (!room || !ws || ws.readyState !== 1) return;
  if (!(room._pendingQuestions instanceof Map) || room._pendingQuestions.size === 0) return;
  for (const event of room._pendingQuestions.values()) {
    if (!event || typeof event !== 'object') continue;
    ws.send(JSON.stringify({ type: 'sdkEvent', event }));
  }
}

/**
 * @param {any} room
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {{ requestId?: string, answers?: Array<Array<string>>, reject?: boolean }} msg
 * @returns {boolean}
 */
export function handleClaudeOpenCodeQuestionReply(room, ws, msg) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId.trim() : '';
  if (!requestId) return false;
  const resolved = resolveClaudeQuestion(room, requestId, {
    answers: Array.isArray(msg.answers) ? msg.answers : [],
    reject: msg.reject === true,
    reason: msg.reject === true ? 'User declined to answer' : '',
  });
  if (resolved || !ws || ws.readyState !== 1) return resolved;
  ws.send(JSON.stringify({
    type: 'questionReplyRejected',
    requestId,
    reason: 'expired',
  }));
  return false;
}

/**
 * `PreToolUse` hook with the same decision as `canUseTool`. Unlike
 * `canUseTool` it also sees tools auto-approved by settings `permissions.allow`
 * rules, closing the read-only bypass.
 *
 * @param {any} room
 * @returns {(input: { tool_name?: unknown, tool_input?: unknown }) => Promise<Record<string, unknown>>}
 */
export function createRoomClaudePreToolUseHook(room) {
  return async (input) => {
    const rec = input && typeof input === 'object' ? input : {};
    const toolName = typeof rec.tool_name === 'string' ? rec.tool_name : '';
    const rawInput = rec.tool_input;
    const toolInput = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? rawInput
      : {};
    const decision = resolveRoomClaudeToolDecision(room, toolName, toolInput);
    if (!decision.deny) return { continue: true };
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: resolveReadOnlyGuardUserMessage(
          readEnforcedSdkMode(room),
          room?.delegationAssignment,
        ),
      },
    };
  };
}

/**
 * Query options for one Claude run. Exported so the read-only gate can be
 * asserted without spawning the SDK.
 *
 * @param {any} room
 * @param {unknown} mode
 * @param {{
 *   model?: string,
 *   env?: Record<string, string | undefined>,
 *   abortController?: AbortController,
 *   mcpServers?: Record<string, unknown>,
 *   resumeSessionId?: unknown,
 *   systemPrompt?: Record<string, unknown>,
 * }} [extras]
 * @returns {Record<string, unknown>}
 */
export function buildClaudeQueryOptions(room, mode, extras = {}) {
  const assignment = room?.delegationAssignment;
  /** @type {Record<string, unknown>} */
  const options = {
    cwd: room?.cwd,
    model: extras.model,
    permissionMode: resolveClaudePermissionMode(mode, assignment),
    env: extras.env,
    abortController: extras.abortController,
    includePartialMessages: true,
    systemPrompt: extras.systemPrompt || CLAUDE_SYSTEM_PROMPT,
    stderr: (data) => appendClaudeStderrChunk(room, data),
    canUseTool: createRoomClaudeCanUseTool(room),
    hooks: {
      PreToolUse: [{ hooks: [createRoomClaudePreToolUseHook(room)] }],
    },
  };
  if (isClaudeReadOnlyRunMode(mode, assignment)) {
    // Read-only modes must not inherit user/local permission allow rules.
    options.settingSources = [...CLAUDE_AGENT_SETTING_SOURCES];
    options.disallowedTools = [...CLAUDE_READ_ONLY_DISALLOWED_TOOLS];
  }
  // Start-time tuning is read from env; invalid values are omitted. Changing
  // one of these forces a new process through the session start key.
  const tuning = resolveClaudeRunTuning(extras.env || process.env, {
    delegation: Boolean(assignment),
  });
  const selectedEffort = parseClaudeEffortLevel(extras.effort);
  if (selectedEffort || tuning.effort) options.effort = selectedEffort || tuning.effort;
  if (tuning.fallbackModel) options.fallbackModel = tuning.fallbackModel;
  if (tuning.maxTurns) options.maxTurns = tuning.maxTurns;
  if (tuning.maxBudgetUsd) options.maxBudgetUsd = tuning.maxBudgetUsd;
  const mcpServers = extras.mcpServers;
  if (mcpServers && typeof mcpServers === 'object' && Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
    options.strictMcpConfig = true;
  }
  if (isResumableClaudeSessionId(extras.resumeSessionId)) {
    options.resume = String(extras.resumeSessionId).trim();
  }
  return options;
}

/**
 * Resume failures leave a stale `claudeSessionId` on the chat; the next run
 * would fail the same way.
 *
 * The patterns are intentionally narrow, so unrelated "not found" errors do
 * not drop a healthy session:
 * - Claude Code CLI: `No conversation found to continue` and
 *   `No conversation found with session ID: <id>`.
 * - Claude Agent SDK: `Session <id> not found` (and variants such as
 *   `Session <id> not found in any project directory`).
 */
export const CLAUDE_RESUME_FAILURE_PATTERNS = Object.freeze([
  /\bno conversation found\b/i,
  /\bsession\s+[0-9a-f-]{8,}\s+(?:was\s+)?not found\b/i,
]);

/**
 * @param {unknown} message
 * @returns {boolean}
 */
export function isClaudeResumeFailure(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  return CLAUDE_RESUME_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Forget a session that can no longer be resumed.
 *
 * @param {any} room
 */
export function clearClaudeRoomSession(room) {
  if (!room) return;
  room.claudeSessionId = '';
  if (room.chatId) setChatClaudeSessionId(room.chatId, '');
}

/**
 * True when a failed first attempt used `resume` and the error says the
 * session is gone: the run may be retried exactly once without `resume`.
 *
 * @param {{ attempt?: unknown, useResume?: unknown, status?: unknown, cancelled?: unknown, errorMessage?: unknown }} [input]
 * @returns {boolean}
 */
export function shouldRetryClaudeRunWithoutResume(input = {}) {
  return Number(input.attempt) === 1
    && input.useResume === true
    && String(input.status || '') === 'error'
    && input.cancelled !== true
    && isClaudeResumeFailure(input.errorMessage);
}

/**
 * Cancels the emergency fallback timer that `interruptActiveQuery` arms.
 * Called when a turn ends: the Query outlives the turn, so an identity check
 * on the Query object alone would abort a healthy idle session.
 *
 * @param {any} room
 */
function clearInterruptFallback(room) {
  if (!room) return;
  if (room._interruptFallbackTimer) {
    clearTimeout(room._interruptFallbackTimer);
    room._interruptFallbackTimer = null;
  }
  room._interruptFallbackRunId = '';
}

/**
 * @param {any} room
 * @param {any} turn
 * @param {{ reason?: string, error?: string }} [outcome]
 */
function settleActiveClaudeTurn(room, outcome = {}) {
  const turn = room?._activeTurn;
  if (!turn || typeof turn.finish !== 'function') return;
  turn.finish({ reason: outcome.reason || 'session_closed', error: outcome.error || '' });
}

/**
 * Abort the controller, close the query and drop the room references. Also
 * marks the streaming session dead so the next prompt resumes it in a fresh
 * process.
 *
 * @param {any} room
 * @param {any} query
 * @param {any} abort
 */
function abortAndCloseClaudeQuery(room, query, abort) {
  if (abort && typeof abort.abort === 'function') {
    try {
      abort.abort();
    } catch {
      // ignore abort failures
    }
  }
  if (query && typeof query.close === 'function') {
    try {
      query.close();
    } catch {
      // ignore close failures
    }
  }
  const session = room?._claudeSession;
  if (session && session.query === query) {
    session.alive = false;
    clearClaudeSessionIdleTimer(session);
    if (session.input && typeof session.input.close === 'function') {
      try {
        session.input.close();
      } catch {
        // ignore
      }
    }
    room._claudeSession = null;
  }
  if (room && room._activeQuery === query) room._activeQuery = null;
  if (room && room._abortController === abort) room._abortController = null;
}

/**
 * Ask the SDK to interrupt the active turn first, then fall back to aborting
 * the controller and closing the session. A successful interrupt leaves the
 * session alive: the SDK answers with a `result`, which ends the turn.
 *
 * The fallback is keyed by the active turn's run id (the Query outlives the
 * turn, so comparing Query references is not enough). `runPrompt` clears it
 * explicitly when the turn ends.
 *
 * @param {any} room
 * @param {number} [timeoutMs]
 * @param {number} [abortFallbackMs]
 * @returns {Promise<void>}
 */
export async function interruptActiveQuery(
  room,
  timeoutMs = CLAUDE_INTERRUPT_TIMEOUT_MS,
  abortFallbackMs = CLAUDE_INTERRUPT_ABORT_FALLBACK_MS,
) {
  rejectPendingClaudeQuestions(room, 'cancelled');
  const query = room?._activeQuery;
  const abort = room?._abortController;
  // Capture the turn id before awaiting: the result may arrive while
  // `interrupt()` is in flight and clear `_activeTurnRunId`.
  const runId = room && typeof room._activeTurnRunId === 'string' ? room._activeTurnRunId : '';
  let interrupted = false;
  if (query && typeof query.interrupt === 'function') {
    let timer = null;
    try {
      interrupted = await Promise.race([
        Promise.resolve(query.interrupt()).then(() => true, () => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0));
        }),
      ]) === true;
    } catch {
      interrupted = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (!interrupted) {
    // The interrupted turn may have ended while `interrupt()` timed out and the
    // queue may already run the next turn on this session; do not kill it.
    if (room && runId && room._activeTurnRunId && room._activeTurnRunId !== runId) return;
    abortAndCloseClaudeQuery(room, query, abort);
    return;
  }
  if (!room) return;
  // The turn may have ended while the interrupt was in flight; do not arm a
  // fallback that would kill an idle session.
  if (runId) {
    if (room._activeTurnRunId !== runId) return;
  } else if (room._activeQuery !== query) {
    return;
  }
  // Keep `_activeQuery`/`_abortController` so a second cancel still works.
  // The fallback no-ops as soon as the turn ended (run id cleared) or, when no
  // turn id is tracked, as soon as `runPrompt` cleared the reference.
  const fallbackTimer = setTimeout(() => {
    room._interruptFallbackTimer = null;
    if (runId) {
      if (room._activeTurnRunId !== runId) return;
    } else if (room._activeQuery !== query) {
      return;
    }
    abortAndCloseClaudeQuery(room, query, abort);
  }, Math.max(0, Number(abortFallbackMs) || 0));
  if (typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
  clearInterruptFallback(room);
  room._interruptFallbackTimer = fallbackTimer;
  room._interruptFallbackRunId = runId;
}

/**
 * Model changes apply from the next turn; the in-flight run keeps its model.
 * With a streaming session the change is pushed through `query.setModel()`.
 *
 * @param {string} sessionKey
 * @param {string} model
 * @param {Map<string, any>} [rooms]
 * @returns {void}
 */
export function syncClaudeRoomModelFromChat(sessionKey, model, rooms = claudeRooms) {
  const room = rooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (nextModel && nextModel !== room.modelId) room.modelId = nextModel;
}

/**
 * Payload for an informational, non-fatal event (permission denial, SDK retry,
 * session reset). `sdkRunProgress` is the existing WS channel the front treats
 * as progress: it does not reset the stream or flip the run to an error.
 *
 * @param {Record<string, unknown>} notice
 * @param {unknown} [runId]
 * @returns {Record<string, unknown>}
 */
export function buildClaudeNoticePayload(notice, runId) {
  /** @type {Record<string, unknown>} */
  const payload = {
    type: 'sdkRunProgress',
    phase: notice?.noticeType === 'api_retry' ? 'retry' : 'notice',
    transport: 'claude',
    message: typeof notice?.message === 'string' ? notice.message : '',
  };
  if (typeof runId === 'string' && runId) payload.runId = runId;
  if (typeof notice?.noticeType === 'string' && notice.noticeType) {
    payload.noticeType = notice.noticeType;
  }
  if (typeof notice?.toolName === 'string' && notice.toolName) payload.toolName = notice.toolName;
  if (typeof notice?.errorType === 'string' && notice.errorType) {
    payload.errorType = notice.errorType;
  }
  for (const key of ['attempt', 'max_retries', 'retry_delay_ms']) {
    const value = Number(notice?.[key]);
    if (Number.isFinite(value)) payload[key] = value;
  }
  if (typeof notice?.status === 'string' && notice.status) payload.status = notice.status;
  const resetsAt = Number(notice?.resetsAt);
  if (Number.isFinite(resetsAt)) payload.resetsAt = resetsAt;
  // Plan-meter metadata from a `rate_limit_event`. The room kernel reads these
  // back to keep the per-window plan snapshot and the lockout code, so dropping
  // them here silently degrades every Claude rate-limit snapshot.
  if (typeof notice?.rateLimitType === 'string' && notice.rateLimitType) {
    payload.rateLimitType = notice.rateLimitType;
  }
  const utilization = Number(notice?.utilization);
  // `Number(null) === 0`: only forward a real, finite number.
  if (notice?.utilization != null && Number.isFinite(utilization)) payload.utilization = utilization;
  if (typeof notice?.overageStatus === 'string' && notice.overageStatus) {
    payload.overageStatus = notice.overageStatus;
  }
  if (notice?.isUsingOverage === true) payload.isUsingOverage = true;
  if (typeof notice?.trigger === 'string' && notice.trigger) payload.trigger = notice.trigger;
  for (const key of ['preTokens', 'postTokens']) {
    const value = Number(notice?.[key]);
    if (Number.isFinite(value)) payload[key] = value;
  }
  return payload;
}

/** Lines of subprocess stderr kept per room for diagnostics. */
export const CLAUDE_STDERR_TAIL_LINES = 50;

/**
 * Removes obvious credentials from a stderr line before it is stored.
 *
 * @param {unknown} line
 * @returns {string}
 */
export function redactClaudeStderrLine(line) {
  let text = String(line ?? '');
  text = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
  text = text.replace(
    /((?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CRETLI_MCP_TOKEN|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1***',
  );
  return text;
}

/**
 * Appends one stderr chunk to the room's ring buffer (last N non-empty lines).
 *
 * @param {any} room
 * @param {unknown} chunk
 * @returns {void}
 */
export function appendClaudeStderrChunk(room, chunk) {
  if (!room || typeof room !== 'object') return;
  const text = String(chunk ?? '');
  if (!text) return;
  if (!Array.isArray(room._claudeStderrTail)) room._claudeStderrTail = [];
  for (const part of text.split(/\r?\n/)) {
    const line = redactClaudeStderrLine(part).trimEnd();
    if (!line.trim()) continue;
    room._claudeStderrTail.push(line);
  }
  const overflow = room._claudeStderrTail.length - CLAUDE_STDERR_TAIL_LINES;
  if (overflow > 0) room._claudeStderrTail.splice(0, overflow);
}

/**
 * @param {any} room
 * @returns {string[]}
 */
export function readClaudeStderrTail(room) {
  return Array.isArray(room?._claudeStderrTail) ? room._claudeStderrTail.slice() : [];
}

/**
 * @param {any} room
 * @returns {string}
 */
export function readLastClaudeStderrLine(room) {
  const tail = Array.isArray(room?._claudeStderrTail) ? room._claudeStderrTail : [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = String(tail[index] || '').trim();
    if (line) return line;
  }
  return '';
}

/**
 * @param {unknown} message
 * @returns {string}
 */
function readClaudeMessageSessionId(message) {
  if (!message || typeof message !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (message);
  if (typeof rec.session_id === 'string' && rec.session_id.trim()) return rec.session_id.trim();
  if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) return rec.sessionId.trim();
  return '';
}

/**
 * Refreshes the global Claude model catalog from `query.supportedModels()`,
 * asynchronously and at most once per TTL. Never blocks a turn; all failures
 * are ignored (the `/v1/models` and alias sources remain).
 *
 * @type {boolean}
 */
let claudeSessionModelsProbeInFlight = false;

/**
 * @param {any} session
 * @returns {void}
 */
function primeClaudeSessionModelCatalog(session) {
  if (claudeSessionModelsProbeInFlight) return;
  if (isClaudeSessionModelCatalogFresh()) return;
  const query = session?.query;
  if (!query || typeof query.supportedModels !== 'function') return;
  claudeSessionModelsProbeInFlight = true;
  Promise.resolve()
    .then(() => query.supportedModels())
    .then((models) => {
      setClaudeSessionModelCatalog(models);
    })
    .catch(() => {})
    .finally(() => {
      claudeSessionModelsProbeInFlight = false;
    });
}

/**
 * Turns one `runPrompt` invocation (and its queue drain) into a small runner
 * bound to a room. Production injects room-kernel side effects; tests inject
 * no-op collectors plus a fake SDK.
 *
 * @param {{
 *   room: any,
 *   hooks?: {
 *     broadcast?: (payload: Record<string, unknown>, opts?: Record<string, unknown>) => void,
 *     sendRoomState?: () => void,
 *     persistRoomEvent?: (entry: Record<string, unknown>, immediate?: boolean) => void,
 *     flushPersist?: () => void,
 *     loadSdk?: () => Promise<any>,
 *     buildEnv?: () => Record<string, string | undefined>,
 *     getAuthMode?: () => string,
 *     prepareMcp?: () => { mcpContext: any, mcpPrep: any, claudeMcp: Record<string, unknown> },
 *     markMcpApplied?: (prepared: { mcpContext: any, mcpPrep: any }) => void,
 *     resolveModel?: (modelId: string) => string,
 *     persistModel?: (model: string) => void,
 *     streamingEnabled?: () => boolean,
 *     sessionIdleMs?: () => number,
 *   },
 * }} params
 * @returns {{ startPrompt: Function, cancelCurrentRun: Function, drainQueue: Function, enqueuePrompt: Function }}
 */
export function createClaudePromptRunner({ room, hooks = {} }) {
  const broadcast = typeof hooks.broadcast === 'function'
    ? hooks.broadcast
    : (payload, opts) => broadcastRoom(room, payload, opts);
  const sendRoomStateHook = typeof hooks.sendRoomState === 'function'
    ? hooks.sendRoomState
    : () => sendRoomState(room);
  const persistEventHook = typeof hooks.persistRoomEvent === 'function'
    ? hooks.persistRoomEvent
    : (entry, immediate) => persistRoomEvent(room, entry, immediate);
  const flushHook = typeof hooks.flushPersist === 'function'
    ? hooks.flushPersist
    : () => flushPersistBuffer(room);
  const loadSdk = typeof hooks.loadSdk === 'function' ? hooks.loadSdk : () => loadClaudeSdk();
  const buildEnv = typeof hooks.buildEnv === 'function' ? hooks.buildEnv : () => buildClaudeProcessEnv();
  const getAuthMode = typeof hooks.getAuthMode === 'function' ? hooks.getAuthMode : () => getClaudeAuthMode();
  const prepareMcp = typeof hooks.prepareMcp === 'function' ? hooks.prepareMcp : () => {
    const mcpContext = buildMcpRuntimeContext({
      chat: getChatByCursorSessionId(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'claude' },
      room,
      harness: 'claude',
      mode: room.sdkMode,
    });
    const mcpPrep = prepareHarnessMcp(mcpContext);
    return { mcpContext, mcpPrep, claudeMcp: toClaudeMcpServers(mcpPrep.mcpServers) };
  };
  const markMcpApplied = typeof hooks.markMcpApplied === 'function'
    ? hooks.markMcpApplied
    : (prepared) => markMcpConfigApplied(prepared.mcpContext, prepared.mcpPrep.servers, prepared.mcpPrep.revision);
  const resolveModel = typeof hooks.resolveModel === 'function'
    ? hooks.resolveModel
    : (modelId) => resolveClaudeRunModel(modelId);
  const persistModel = typeof hooks.persistModel === 'function'
    ? hooks.persistModel
    : (model) => {
      room.modelId = model;
      if (room.chatId) updateChat(room.chatId, { model });
    };
  const streamingEnabled = typeof hooks.streamingEnabled === 'function'
    ? hooks.streamingEnabled
    : () => isClaudeStreamingSessionEnabled();
  const sessionIdleMs = typeof hooks.sessionIdleMs === 'function'
    ? hooks.sessionIdleMs
    : () => resolveClaudeSessionIdleMs();

  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];

  /**
   * @param {Record<string, unknown>} notice
   */
  function notify(notice) {
    broadcast(buildClaudeNoticePayload(notice, room.currentRun?.id), { log: false });
  }

  /**
   * @param {string} message
   * @returns {boolean}
   */
  function applyApiError(message) {
    const text = String(message || '').trim();
    if (!text) return false;
    if (room._claudeLastApiErrorMessage === text) return false;
    room._claudeLastApiErrorMessage = text;
    room._lastApiError = text;
    broadcast({ type: 'sdkError', code: 'claude_error', message: text });
    return true;
  }

  /**
   * @param {unknown} sessionId
   */
  function persistSessionId(sessionId) {
    const next = String(sessionId || '').trim();
    if (!isResumableClaudeSessionId(next)) return;
    room.claudeSessionId = next;
    if (room.chatId) setChatClaudeSessionId(room.chatId, next);
  }

  /**
   * @param {Record<string, unknown>} event
   * @returns {boolean}
   */
  function applyPlanGuardIfNeeded(event) {
    const mode = readEnforcedSdkMode(room);
    const assignment = room.delegationAssignment;
    const decision = resolvePlanModeSdkEventDecision({
      transport: 'claude',
      mode,
      assignment,
      event,
    });
    if (!decision.notify) return false;
    if (decision.abortRun) {
      room.cancelled = true;
      room._planGuardTriggered = true;
      void interruptActiveQuery(room);
    }
    broadcast({
      type: 'sdkPlanGuard',
      message: resolveReadOnlyGuardUserMessage(mode, assignment),
      toolName: typeof event.name === 'string' ? event.name : '',
    });
    return true;
  }

  /**
   * Normalizes and dispatches one SDK message. `turn` may be null (legacy
   * one-shot runs and between-turn streaming messages): `result` is still
   * recorded so `runPrompt` can read the status.
   *
   * @param {unknown} message
   * @param {any} turn
   */
  function dispatchClaudeMessage(message, turn) {
    if (!room._claudeNormalizer || typeof room._claudeNormalizer.normalize !== 'function') {
      room._claudeNormalizer = createClaudeEventNormalizer();
    }
    const items = room._claudeNormalizer.normalize(message);
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (item.kind === 'session') {
        persistSessionId(item.sessionId);
        continue;
      }
      if (item.kind === 'api_error') {
        applyApiError(item.message);
        continue;
      }
      if (item.kind === 'notice') {
        notify(item);
        continue;
      }
      if (item.kind === 'usage') {
        room._lastUsage = item;
        /** @type {Record<string, unknown>} */
        const usageEvent = { type: 'usage', usage: item.usage };
        if (item.totalCostUsd != null) usageEvent.totalCostUsd = item.totalCostUsd;
        if (item.durationMs != null) usageEvent.durationMs = item.durationMs;
        if (item.modelUsage && typeof item.modelUsage === 'object') {
          usageEvent.modelUsage = item.modelUsage;
        }
        broadcast({ type: 'sdkEvent', event: usageEvent });
        continue;
      }
      if (item.kind === 'result') {
        room._lastResult = item;
        persistSessionId(item.sessionId);
        if (turn && typeof turn.finish === 'function') turn.finish({ reason: 'result' });
        continue;
      }
      if (applyPlanGuardIfNeeded(item)) return;
      broadcast({ type: 'sdkEvent', event: item });
    }
  }

  /**
   * Routes one streaming session message to the active turn. Messages outside
   * a turn (for example `system init` between turns, or background task /
   * tool_progress chatter that arrives after `result`) only refresh the
   * persisted session id and surface advisory notices; they are never
   * broadcast as answer content for the next turn.
   *
   * @param {any} session
   * @param {unknown} message
   */
  function handleSessionMessage(session, message) {
    if (room._claudeSession !== session) return;
    const turn = room._activeTurn;
    if (!turn || turn.session !== session || turn.settled === true) {
      const sessionId = readClaudeMessageSessionId(message);
      if (sessionId) persistSessionId(sessionId);
      for (const notice of collectClaudeIdleNotices(message)) notify(notice);
      return;
    }
    dispatchClaudeMessage(message, turn);
  }

  /**
   * Consumer loop ended (normal end or exception). Marks the session dead and
   * settles the active turn so `runPrompt` never hangs.
   *
   * @param {any} session
   * @param {unknown} error
   */
  function handleSessionEnd(session, error) {
    clearClaudeSessionIdleTimer(session);
    if (session && typeof session === 'object') session.alive = false;
    if (room._claudeSession === session) room._claudeSession = null;
    if (session && room._activeQuery === session.query) room._activeQuery = null;
    if (session && room._abortController === session.abortController) room._abortController = null;
    const turn = room._activeTurn;
    if (!turn || turn.session !== session) return;
    const message = error?.message ? String(error.message) : (error ? String(error) : '');
    const fallback = message
      || room._lastSessionError
      || readLastClaudeStderrLine(room)
      || 'Claude session ended unexpectedly.';
    if (message) room._lastSessionError = message;
    turn.finish({ reason: 'session_end', error: fallback });
  }

  /**
   * Applies a turn's start-time constraints to `room._claudeSession`, restarting
   * the session when the start key changed, or using control requests for the
   * live-updatable pieces (model, permission mode, MCP revision).
   *
   * @param {{
   *   sdk: any,
   *   mode: string,
   *   model: string,
   *   effort?: string,
   *   prepared: { mcpContext: any, mcpPrep: any, claudeMcp: Record<string, unknown> },
   *   useResume: boolean,
   * }} input
   * @returns {Promise<any>}
   */
  async function ensureSession(input) {
    const readOnly = isClaudeReadOnlyRunMode(input.mode, room.delegationAssignment);
    const permissionMode = resolveClaudePermissionMode(input.mode, room.delegationAssignment);
    const env = buildEnv();
    const authSignature = buildClaudeAuthSignature(getAuthMode(), env);
    const mcpSignature = buildClaudeMcpSignature(input.prepared.claudeMcp);
    const tuning = resolveClaudeRunTuning(env, {
      delegation: Boolean(room.delegationAssignment),
    });
    tuning.effort = parseClaudeEffortLevel(input.effort) || tuning.effort;
    const tuningSignature = buildClaudeTuningSignature(tuning);
    const nextStartKey = buildClaudeSessionStartKey({
      cwd: room.cwd,
      readOnly,
      authSignature,
      mcpRevision: input.prepared.mcpPrep?.revision,
      mcpSignature,
      tuningSignature,
    });

    let session = isClaudeSessionAlive(room._claudeSession) ? room._claudeSession : null;
    if (session) {
      const diff = diffClaudeSessionStartKey(session.startKey, nextStartKey);
      if (diff.stableChanged) {
        closeClaudeSession(room, session);
        session = null;
      } else {
        if (input.model && session.model !== input.model) {
          if (typeof session.query.setModel === 'function') {
            try {
              await session.query.setModel(input.model);
              session.model = input.model;
            } catch {
              closeClaudeSession(room, session);
              session = null;
            }
          } else {
            closeClaudeSession(room, session);
            session = null;
          }
        }
        if (session && session.permissionMode !== permissionMode) {
          if (typeof session.query.setPermissionMode === 'function') {
            try {
              await session.query.setPermissionMode(permissionMode);
              session.permissionMode = permissionMode;
            } catch {
              closeClaudeSession(room, session);
              session = null;
            }
          } else {
            closeClaudeSession(room, session);
            session = null;
          }
        }
        if (session && diff.mcpChanged) {
          if (typeof session.query.setMcpServers === 'function') {
            try {
              await session.query.setMcpServers(input.prepared.claudeMcp || {});
              session.startKey = {
                ...session.startKey,
                mcpRevision: nextStartKey.mcpRevision,
                mcpSignature: nextStartKey.mcpSignature,
              };
            } catch {
              closeClaudeSession(room, session);
              session = null;
            }
          } else {
            closeClaudeSession(room, session);
            session = null;
          }
        }
      }
    }

    if (!session) {
      const abortController = new AbortController();
      const options = buildClaudeQueryOptions(room, input.mode, {
        model: input.model,
        effort: input.effort,
        env,
        abortController,
        mcpServers: input.prepared.claudeMcp,
        resumeSessionId: input.useResume ? room.claudeSessionId : '',
      });
      session = createClaudeStreamingSession({
        room,
        sdk: input.sdk,
        options,
        mode: input.mode,
        model: input.model,
        permissionMode,
        readOnly,
        authSignature,
        mcpRevision: nextStartKey.mcpRevision,
        mcpSignature,
        tuningSignature,
        onMessage: (active, message) => handleSessionMessage(active, message),
        onEnd: (ended, error) => handleSessionEnd(ended, error),
      });
    }

    room._activeQuery = session.query;
    room._abortController = session.abortController;
    primeClaudeSessionModelCatalog(session);
    return session;
  }

  /**
   * @param {any} session
   * @param {Record<string, unknown>} message
   * @returns {Promise<{ reason: string, error?: string }>}
   */
  function sendTurn(session, message) {
    return new Promise((resolve) => {
      /** @type {any} */
      const turn = {
        session,
        runId: room.currentRun?.id || '',
        settled: false,
        finish(outcome = {}) {
          if (turn.settled) return;
          turn.settled = true;
          if (room._activeTurn === turn) room._activeTurn = null;
          clearInterruptFallback(room);
          resolve({ reason: outcome.reason || 'result', error: outcome.error || '' });
        },
      };
      room._activeTurn = turn;
      if (!session.input.push(message)) {
        turn.finish({ reason: 'session_closed', error: 'Claude session input is closed.' });
        return;
      }
      if (room.cancelled) void interruptActiveQuery(room);
    });
  }

  /**
   * One streaming turn: ensure the session, push the decorated user message and
   * wait for its `result` (or for the session to die).
   *
   * @param {{
   *   sdk: any,
   *   mode: string,
   *   model: string,
   *   effort?: string,
   *   prepared: { mcpContext: any, mcpPrep: any, claudeMcp: Record<string, unknown> },
   *   useResume: boolean,
   *   runId: string,
   *   text: string,
   * }} input
   * @returns {Promise<{ reason: string, error?: string }>}
   */
  async function runStreamingTurn(input) {
    const session = await ensureSession({
      sdk: input.sdk,
      mode: input.mode,
      model: input.model,
      effort: input.effort,
      prepared: input.prepared,
      useResume: input.useResume,
    });
    broadcast({
      type: 'sdkRunProgress',
      runId: input.runId,
      phase: 'stream',
      transport: 'claude',
    }, { log: false });
    markMcpApplied(input.prepared);
    session.turns += 1;
    // Decorate first (captures pending delegation report ids), then confirm.
    const text = decorateHarnessPrompt(room, input.text, 'claude');
    confirmDelegationReportsFromRoom(room);
    return sendTurn(session, buildClaudeUserMessage(room.claudeSessionId, text));
  }

  /**
   * Legacy one-shot turn (kill switch): a fresh Query per prompt with a string
   * prompt and `resume`.
   *
   * @param {{
   *   sdk: any,
   *   mode: string,
   *   model: string,
   *   effort?: string,
   *   prepared: { mcpContext: any, mcpPrep: any, claudeMcp: Record<string, unknown> },
   *   useResume: boolean,
   *   runId: string,
   *   text: string,
   * }} input
   * @returns {Promise<void>}
   */
  async function runOneShotTurn(input) {
    const abortController = new AbortController();
    room._abortController = abortController;
    const options = buildClaudeQueryOptions(room, input.mode, {
      model: input.model,
      effort: input.effort,
      env: buildEnv(),
      abortController,
      mcpServers: input.prepared.claudeMcp,
      resumeSessionId: input.useResume ? room.claudeSessionId : '',
    });
    const query = input.sdk.query({ prompt: decorateHarnessPrompt(room, input.text, 'claude'), options });
    room._activeQuery = query;
    markMcpApplied(input.prepared);
    broadcast({
      type: 'sdkRunProgress',
      runId: input.runId,
      phase: 'stream',
      transport: 'claude',
    }, { log: false });
    confirmDelegationReportsFromRoom(room);
    for await (const message of query) {
      if (room.cancelled) {
        await interruptActiveQuery(room);
        break;
      }
      dispatchClaudeMessage(message, null);
    }
  }

  /**
   * @param {string} mode
   * @param {{ reason?: string, error?: string } | null} outcome
   * @returns {{ status: string, errorMessage: string }}
   */
  function resolveTurnStatus(mode, outcome) {
    if (room._planGuardTriggered) {
      return {
        status: 'plan_guard_cancelled',
        errorMessage: resolveReadOnlyGuardUserMessage(mode, room.delegationAssignment),
      };
    }
    if (room.cancelled) return { status: 'cancelled', errorMessage: '' };
    if (outcome && outcome.reason !== 'result') {
      return {
        status: 'error',
        errorMessage: String(
          outcome.error
          || room._lastSessionError
          || readLastClaudeStderrLine(room)
          || 'Claude session ended unexpectedly.',
        ),
      };
    }
    if (room._lastResult && room._lastResult.status === 'error') {
      return {
        status: 'error',
        errorMessage: String(room._lastResult.errorMessage || room._lastResult.resultText || 'Claude run failed'),
      };
    }
    if (room._lastApiError) return { status: 'error', errorMessage: room._lastApiError };
    return { status: 'completed', errorMessage: '' };
  }

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
    broadcast({ type: 'sdkQueued', text: uiText || text }, { log: false });
    sendRoomStateHook();
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
    room._lastApiError = '';
    room._claudeLastApiErrorMessage = '';
    room._lastSessionError = '';
    room._claudeNormalizer = createClaudeEventNormalizer();
    const runId = randomUUID();
    room.currentRun = { id: runId, startedAt: Date.now() };
    room._activeTurnRunId = runId;
    const mode = normalizeSdkMode(modeOverride || room.sdkMode);
    room.sdkMode = mode;
    beginEnforcedSdkMode(room, mode);
    syncRoomDelegationAssignment(room);
    broadcast({
      type: 'sdkPromptStarted',
      runId,
      text: uiText,
      fromQueue: fromQueue === true,
      remaining: room.pendingPrompts.length,
    });
    broadcast({ type: 'sdkBusy', busy: true }, { log: false });
    sendRoomStateHook();
    persistEventHook({ kind: 'localUser', text: uiText }, true);
    broadcast({ type: 'sdkEvent', event: buildUserEvent(uiText) });
    broadcast({
      type: 'sdkRunProgress',
      runId,
      phase: 'setup',
      transport: 'claude',
    }, { log: false });
    let status = 'completed';
    let errorMessage = '';
    const streaming = streamingEnabled();
    let useResume = isResumableClaudeSessionId(room.claudeSessionId);
    clearClaudeSessionIdleTimer(room._claudeSession);
    try {
      // No pre-flight token refresh: the Claude Code CLI refreshes the plan
      // token in CLAUDE_CONFIG_DIR itself, and a parallel write to
      // `.credentials.json` raced with its refresh-token rotation. An expired
      // session surfaces as `authentication_failed` from the SDK.
      const sdk = await loadSdk();
      if (typeof sdk.query !== 'function') {
        throw new Error('Claude Agent SDK is missing query().');
      }
      const model = resolveModel(room.modelId);
      const effort = resolveClaudeRunEffort(room.modelId);
      if (model && model !== room.modelId && !effort) persistModel(model);
      const prepared = prepareMcp();
      let attempt = 0;
      for (;;) {
        attempt += 1;
        room._lastResult = null;
        room._lastApiError = '';
        room._claudeLastApiErrorMessage = '';
        room._claudeNormalizer = createClaudeEventNormalizer();
        room._activeTurnRunId = runId;
        status = 'completed';
        errorMessage = '';
        try {
          if (streaming) {
            const outcome = await runStreamingTurn({
              sdk,
              mode,
              model,
              effort,
              prepared,
              useResume,
              runId,
              text: trimmed,
            });
            ({ status, errorMessage } = resolveTurnStatus(mode, outcome));
          } else {
            await runOneShotTurn({
              sdk,
              mode,
              model,
              effort,
              prepared,
              useResume,
              runId,
              text: trimmed,
            });
            ({ status, errorMessage } = resolveTurnStatus(mode, null));
          }
        } catch (err) {
          if (room.cancelled || room._planGuardTriggered) {
            status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
            errorMessage = '';
          } else {
            status = 'error';
            errorMessage = err?.message
              ? String(err.message)
              : (err ? String(err) : readLastClaudeStderrLine(room));
          }
        }
        const staleResume = shouldRetryClaudeRunWithoutResume({
          attempt,
          useResume,
          status,
          cancelled: room.cancelled,
          errorMessage,
        });
        if (!staleResume) break;
        // Drop the dead session id (and session) and retry once without resume.
        if (streaming) closeClaudeSession(room);
        clearClaudeRoomSession(room);
        useResume = false;
        notify({
          noticeType: 'session_reset',
          message: 'Claude session could not be resumed. Starting a new session.',
        });
        broadcast({
          type: 'sdkRunProgress',
          runId,
          phase: 'setup',
          transport: 'claude',
        }, { log: false });
      }
    } catch (err) {
      if (room.cancelled || room._planGuardTriggered) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else {
        status = 'error';
        errorMessage = err?.message
          ? String(err.message)
          : (err ? String(err) : readLastClaudeStderrLine(room));
      }
    } finally {
      room._activeTurnRunId = '';
      clearInterruptFallback(room);
      if (!streaming) {
        room._activeQuery = null;
        room._abortController = null;
      } else if (isClaudeSessionAlive(room._claudeSession)) {
        armClaudeSessionIdleTimer(room, room._claudeSession, sessionIdleMs());
      }
      room.busy = false;
      room.currentRun = null;
      clearEnforcedSdkMode(room);
      broadcast({ type: 'sdkBusy', busy: false }, { log: false });
      const finished = {
        type: 'sdkRunFinished',
        runId,
        status,
        lastErrorMessage: errorMessage,
      };
      if (errorMessage && status === 'error') {
        finished.lastErrorCode = 'claude_error';
      }
      broadcast(finished);
      if (errorMessage && status === 'error' && room._lastApiError !== errorMessage) {
        broadcast({
          type: 'sdkError',
          code: finished.lastErrorCode || 'claude_error',
          message: errorMessage,
        });
      }
      sendRoomStateHook();
      flushHook();
      drainQueue();
    }
  }

  async function cancelCurrentRun() {
    room.cancelled = true;
    await interruptActiveQuery(room);
  }

  return {
    startPrompt: runPrompt,
    cancelCurrentRun,
    drainQueue,
    enqueuePrompt,
  };
}

/**
 * @param {any} room
 * @param {object} chat
 */
function bindClaudePromptRunner(room, chat) {
  void chat;
  const runner = createClaudePromptRunner({ room });
  room.startPrompt = runner.startPrompt;
  room.cancelCurrentRun = runner.cancelCurrentRun;
  room.drainQueue = runner.drainQueue;
}

/**
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent?: Function, todoSyncDataDir?: string, delegationId?: string, attemptId?: string }} [deps]
 */
export function ensureClaudeRoom(sessionKey, deps = {}) {
  if (!isClaudeHarnessConfigured()) {
    const subscription = getClaudeAuthMode() === 'subscription';
    return {
      error: subscription
        ? 'Claude Code plan login is not available. Run claude login on this machine or set CLAUDE_CODE_OAUTH_TOKEN.'
        : 'Missing Anthropic API/provider credentials. Set ANTHROPIC_API_KEY or configure Bedrock, Vertex, or Foundry with your own provider credentials.',
      code: subscription ? 'missing_subscription' : 'missing_api_key',
    };
  }
  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    return { error: 'Claude chat not found for this session.', code: 'chat_not_found' };
  }
  if (!isClaudeChat(chat)) {
    return { error: 'Claude chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
  }
  let room = claudeRooms.get(sessionKey);
  if (!room) {
    room = kernel.createRoomState({
      sessionKey,
      chatId: chat.id,
      chatTitle: chat.title || chat.id,
      cwd,
      modelId: chat.model || resolveDefaultClaudeModel(),
      sdkMode: normalizeSdkMode(chat.sdkMode),
      cancelled: false,
      claudeSessionId: typeof chat.claudeSessionId === 'string' ? chat.claudeSessionId : '',
      currentRun: null,
      _activeQuery: null,
      _abortController: null,
      _claudeSession: null,
      _activeTurn: null,
      _activeTurnRunId: '',
      _interruptFallbackTimer: null,
      _interruptFallbackRunId: '',
      _lastResult: null,
      _lastApiError: '',
      _lastSessionError: '',
      _planGuardTriggered: false,
      _claudeNormalizer: createClaudeEventNormalizer(),
    });
    claudeRooms.set(sessionKey, room);
  } else {
    room.cwd = cwd;
    room.modelId = chat.model || room.modelId || resolveDefaultClaudeModel();
    room.sdkMode = normalizeSdkMode(chat.sdkMode);
    if (typeof chat.claudeSessionId === 'string' && isResumableClaudeSessionId(chat.claudeSessionId)) {
      room.claudeSessionId = chat.claudeSessionId.trim();
    }
  }
  bindHarnessPlanSync(room, deps);
  bindRoomToDelegation(room, deps);
  bindClaudePromptRunner(room, chat);
  return { room, chat };
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }} deps
 */
export async function handleClaudeAgentWebSocket(ws, sessionKey, deps) {
  const ensured = ensureClaudeRoom(sessionKey, deps);
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
  sendPendingClaudeQuestionsToClient(room, ws);
  const hello = buildAgentHelloPayload({
    transport: 'claude',
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
      void room.startPrompt(msg.text, msg.mode, false, readClientDisplayText(msg));
      return;
    }
    if (msg.type === 'opencodeQuestionReply' && typeof msg.requestId === 'string') {
      handleClaudeOpenCodeQuestionReply(room, ws, msg);
    }
  });

  ws.on('close', () => {
    detachClient(room, ws, sessionKey);
  });
}

registerKernelChatRunAdapter({
  transport: 'claude',
  rooms: claudeRooms,
  ensureRoom: ensureClaudeRoom,
});

/**
 * @param {string} sessionKey
 * @returns {Record<string, unknown> | null}
 */
export function getClaudeRoomDiag(sessionKey) {
  const room = claudeRooms.get(sessionKey);
  if (!room) return null;
  const session = room._claudeSession;
  return {
    transport: 'claude',
    busy: !!room.busy,
    modelId: room.modelId,
    clients: room.clients.size,
    eventSeq: room.eventSeq,
    claudeSessionId: room.claudeSessionId || '',
    lastRunId: room.lastRunId || null,
    lastRunStatus: room.lastRunStatus || null,
    queuedCount: Array.isArray(room.pendingPrompts) ? room.pendingPrompts.length : 0,
    sessionAlive: Boolean(session && session.alive === true),
    sessionStartedAt: session?.startedAt || null,
    turnsInSession: Number(session?.turns) || 0,
    stderrTail: readClaudeStderrTail(room),
  };
}
