/**
 * WebSocket rooms for the Claude Agent SDK harness — SDK-compatible event protocol.
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
import { resolveClaudeRunModel, resolveDefaultClaudeModel } from './claude-models.js';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { toClaudeMcpServers } from '../mcp/mcp-vendor-map.js';

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
  if (room) room.cancelled = true;
  void interruptActiveQuery(room);
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

/** How long `interrupt()` may take before falling back to abort/close. */
export const CLAUDE_INTERRUPT_TIMEOUT_MS = 3000;

/**
 * After a successful `interrupt()` the async iterator can still hang. If
 * `runPrompt` has not cleared `_activeQuery` in its `finally` by then, abort
 * the controller and close the query as a last resort.
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
  return async (toolName, input, options = {}) => {
    void options;
    const decision = resolveRoomClaudeToolDecision(room, toolName, input);
    if (decision.deny) {
      return {
        behavior: 'deny',
        message: resolveReadOnlyGuardUserMessage(readEnforcedSdkMode(room), room?.delegationAssignment),
      };
    }
    return {
      behavior: 'allow',
      updatedInput: input && typeof input === 'object' ? input : {},
    };
  };
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
 * Abort the controller, close the query and drop the room references. Used
 * when `interrupt()` fails/times out and as the emergency fallback after a
 * successful `interrupt()` that never ended the iterator.
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
  if (room && room._activeQuery === query) room._activeQuery = null;
  if (room && room._abortController === abort) room._abortController = null;
}

/**
 * Ask the SDK to interrupt the active turn first, then fall back to aborting
 * the controller and closing the query.
 *
 * On success the handles are kept: `runPrompt`'s `finally` clears them when
 * the iterator really ends, and until then a second cancel/interrupt still
 * reaches the live query. A timer aborts the query if it never settles.
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
  const query = room?._activeQuery;
  const abort = room?._abortController;
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
    abortAndCloseClaudeQuery(room, query, abort);
    return;
  }
  if (!room) return;
  // Keep `_activeQuery`/`_abortController` so a second cancel still works.
  // The fallback no-ops as soon as `runPrompt`'s finally clears the reference.
  const fallbackTimer = setTimeout(() => {
    if (room._activeQuery === query) abortAndCloseClaudeQuery(room, query, abort);
  }, Math.max(0, Number(abortFallbackMs) || 0));
  if (typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
}

/**
 * Model changes apply from the next turn; the in-flight run keeps its model.
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
 * @param {any} room
 * @param {string} message
 * @returns {boolean}
 */
function applyClaudeApiError(room, message) {
  const text = String(message || '').trim();
  if (!room || !text) return false;
  if (room._claudeLastApiErrorMessage === text) return false;
  room._claudeLastApiErrorMessage = text;
  room._lastApiError = text;
  broadcastRoom(room, {
    type: 'sdkError',
    code: 'claude_error',
    message: text,
  });
  return true;
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
  return payload;
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} notice
 */
function broadcastClaudeNotice(room, notice) {
  broadcastRoom(room, buildClaudeNoticePayload(notice, room?.currentRun?.id), { log: false });
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} event
 * @returns {boolean}
 */
function applyPlanGuardIfNeeded(event, room) {
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
  broadcastRoom(room, {
    type: 'sdkPlanGuard',
    message: resolveReadOnlyGuardUserMessage(mode, assignment),
    toolName: typeof event.name === 'string' ? event.name : '',
  });
  return true;
}

/**
 * @param {any} room
 * @param {unknown} message
 */
function handleNormalizedMessage(room, message) {
  if (!room._claudeNormalizer || typeof room._claudeNormalizer.normalize !== 'function') {
    room._claudeNormalizer = createClaudeEventNormalizer();
  }
  const items = room._claudeNormalizer.normalize(message);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'session' && isResumableClaudeSessionId(item.sessionId)) {
      persistClaudeSessionId(room, item.sessionId);
      continue;
    }
    if (item.kind === 'api_error') {
      applyClaudeApiError(room, item.message);
      continue;
    }
    if (item.kind === 'notice') {
      broadcastClaudeNotice(room, item);
      continue;
    }
    if (item.kind === 'result') {
      room._lastResult = item;
      if (isResumableClaudeSessionId(item.sessionId)) {
        persistClaudeSessionId(room, item.sessionId);
      }
      continue;
    }
    if (applyPlanGuardIfNeeded(item, room)) return;
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}

/**
 * @param {any} room
 * @param {unknown} sessionId
 */
function persistClaudeSessionId(room, sessionId) {
  const next = String(sessionId || '').trim();
  if (!isResumableClaudeSessionId(next)) return;
  room.claudeSessionId = next;
  if (room.chatId) setChatClaudeSessionId(room.chatId, next);
}

/**
 * @param {any} room
 * @param {object} chat
 */
function bindClaudePromptRunner(room, chat) {
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
    room._lastApiError = '';
    room._claudeLastApiErrorMessage = '';
    room._claudeNormalizer = createClaudeEventNormalizer();
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
      transport: 'claude',
    }, { log: false });
    let status = 'completed';
    let errorMessage = '';
    const abortController = new AbortController();
    room._abortController = abortController;
    let useResume = isResumableClaudeSessionId(room.claudeSessionId);
    try {
      // No pre-flight token refresh: the Claude Code CLI refreshes the plan
      // token in CLAUDE_CONFIG_DIR itself, and a parallel write to
      // `.credentials.json` raced with its refresh-token rotation. An expired
      // session surfaces as `authentication_failed` from the SDK.
      const sdk = await loadClaudeSdk();
      if (typeof sdk.query !== 'function') {
        throw new Error('Claude Agent SDK is missing query().');
      }
      const model = resolveClaudeRunModel(room.modelId);
      if (model && model !== room.modelId) {
        room.modelId = model;
        if (room.chatId) updateChat(room.chatId, { model });
      }
      const mcpContext = buildMcpRuntimeContext({
        chat: getChatByCursorSessionId(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'claude' },
        room,
        harness: 'claude',
        mode: room.sdkMode,
      });
      const mcpPrep = prepareHarnessMcp(mcpContext);
      const claudeMcp = toClaudeMcpServers(mcpPrep.mcpServers);
      let attempt = 0;
      for (;;) {
        attempt += 1;
        room._lastResult = null;
        room._lastApiError = '';
        room._claudeLastApiErrorMessage = '';
        room._claudeNormalizer = createClaudeEventNormalizer();
        status = 'completed';
        errorMessage = '';
        try {
          const options = buildClaudeQueryOptions(room, mode, {
            model,
            env: buildClaudeProcessEnv(),
            abortController,
            mcpServers: claudeMcp,
            resumeSessionId: useResume ? room.claudeSessionId : '',
          });
          const query = sdk.query({ prompt: decorateHarnessPrompt(room, trimmed, 'claude'), options });
          room._activeQuery = query;
          markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
          broadcastRoom(room, {
            type: 'sdkRunProgress',
            runId,
            phase: 'stream',
            transport: 'claude',
          }, { log: false });
          confirmDelegationReportsFromRoom(room);
          for await (const message of query) {
            if (room.cancelled) {
              await interruptActiveQuery(room);
              break;
            }
            handleNormalizedMessage(room, message);
          }
          if (room._planGuardTriggered) {
            status = 'plan_guard_cancelled';
            errorMessage = resolveReadOnlyGuardUserMessage(mode, room.delegationAssignment);
          } else if (room.cancelled) {
            status = 'cancelled';
          } else if (room._lastResult && room._lastResult.status === 'error') {
            status = 'error';
            errorMessage = String(room._lastResult.errorMessage || room._lastResult.resultText || 'Claude run failed');
          } else if (room._lastApiError) {
            status = 'error';
            errorMessage = room._lastApiError;
          }
        } catch (err) {
          if (room.cancelled || room._planGuardTriggered) {
            status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
            errorMessage = '';
          } else {
            status = 'error';
            errorMessage = err?.message ? String(err.message) : String(err);
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
        // Drop the dead session id and retry once without `resume`.
        clearClaudeRoomSession(room);
        useResume = false;
        broadcastClaudeNotice(room, {
          noticeType: 'session_reset',
          message: 'Claude session could not be resumed. Starting a new session.',
        });
        broadcastRoom(room, {
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
        errorMessage = err?.message ? String(err.message) : String(err);
      }
    } finally {
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
        finished.lastErrorCode = 'claude_error';
      }
      broadcastRoom(room, finished);
      if (errorMessage && status === 'error' && room._lastApiError !== errorMessage) {
        broadcastRoom(room, {
          type: 'sdkError',
          code: finished.lastErrorCode || 'claude_error',
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
export function ensureClaudeRoom(sessionKey, deps = {}) {
  if (!isClaudeHarnessConfigured()) {
    const subscription = getClaudeAuthMode() === 'subscription';
    return {
      error: subscription
        ? 'Claude Code plan is not signed in on this machine. Run claude login or claude setup-token (CLAUDE_CODE_OAUTH_TOKEN), or switch Settings → Harness → Claude to an API key.'
        : 'Missing Anthropic API key (ANTHROPIC_API_KEY or Settings → Harness → Claude).',
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
      _lastResult: null,
      _lastApiError: '',
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
  };
}
