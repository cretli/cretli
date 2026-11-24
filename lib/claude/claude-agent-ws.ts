import { registerDecisionGateSource, notifyRoomDecisionGateChange, roomsInDecisionWorkspace, questionGate } from '../decisions/host-gates.js';
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

import { externalizeToolResultImages, chatMediaSaver } from '../agent-harness/tool-result-images.ts';
import { CLAUDE_START_PROMPT_ARGS } from '../chat-run/start-prompt-args.ts';
import { auditCanUseToolGuardDeny } from '../approval/can-use-tool-adapter.ts';
import {
  rejectPendingCanUseToolPermissions,
  replyCanUseToolPermission,
  requestCanUseToolPermission,
} from '../approval/can-use-tool-permission.ts';
import { loadSettings } from '../persist/settings.js';
import { browserScopeKey, resolveBrowserPolicy } from '../browser/policy-store.js';
import { resolveDataPath } from '../runtime-paths.js';
import { randomUUID } from 'crypto';
import { rejectArchivedRoomPromptAsync } from '../chat-message-guard.js';
import {
  getChatByCursorSessionIdAsync,
  setChatClaudeSessionIdAsync,
  updateChatAsync,
} from '../persist/chats-persist.js';
import { runChatWrite } from '../chat-write-async.js';
import { resolveExecutionFolderForChat } from '../execution-folder.js';
import {
  beginEnforcedSdkMode,
  clearEnforcedSdkMode,
  isAskSdkMode,
  isPlanSdkMode,
  isReadOnlySdkMode,
  normalizeSdkMode,
  readEnforcedSdkMode,
} from '../sdk/sdk-mode.ts';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.ts';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.ts';
import { buildUserEvent } from '../agent-harness/event-normalizer.ts';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import {
  setActiveSelection,
  readClientSkillSelection,
  selectionRequestsSkill,
  withSkillSelection,
} from '../skills/skill-selection.js';
import { recordSteerManifest } from '../context/context-send-manifest.ts';
import { createClaudeEventNormalizer, readClaudePeerMessage } from '../agent-harness/claude-event-normalizer.ts';
import { handleQueueControlMessage } from '../agent-harness/queue-controls.ts';
import { createAgentRoomKernel } from '../agent-harness/room-kernel.ts';
import { isClaudeChat } from '../agent-transport.js';
import {
  resolvePlanModeSdkEventDecision,
  resolvePlanModeToolDecision,
  resolveReadOnlyGuardUserMessage,
} from '../sdk/sdk-plan-guard.ts';
import { resolvePlanGuardMcpServerIdentity } from '../mcp/mcp-session.js';
import { SCOUT_READ_ONLY_MESSAGE, isScoutReadOnlyChatId } from '../workspace-scout-chat.js';
import { isOperatorIsolatedChatId } from '../operator/operator-run-chat-registry.js';
import { gateOperatorNativeToolCall } from '../operator/operator-native-gate.js';
import { OPERATOR_DENIED_MESSAGE } from '../operator/operator-tool-policy.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.ts';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.ts';
import { buildClaudeHistoryDigest } from './claude-history-digest.ts';
import { appendChatNotice, getChatHistoryPage } from '../persist/chat-history-service.js';
import { parseInheritedPrompt } from '../conversation-fork.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.ts';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { bindRoomRecoveryLifecycle, registerKernelChatRunAdapter } from '../chat-run/kernel-adapter.ts';
import { drainOnePendingPrompt } from '../agent-harness/pending-prompt-drain.ts';
import { registerMcpOwnerSource } from '../mcp/mcp-owner-registry.js';
import { registerPendingPromptRoomSource } from '../agent-harness/pending-prompt-resume.ts';
import { canAcceptNewRun } from '../update-gate.js';
import { msg } from '../messages.js';
import {
  STEER_ACK_DELIVERED,
  STEER_ACK_REVERT,
  buildSdkSteerAckPayload,
} from '../sdk/sdk-run-steer.ts';
import { getClaudeAuthMode } from './claude-auth-mode.ts';
import { clearClaudePromptSuggestions, shouldAcceptClaudePromptSuggestion } from './prompt-suggestion-state.ts';
import { buildClaudeProcessEnv, isClaudeHarnessConfigured } from './claude-api-key.ts';
import { applyClaudeChatCompactionEnv, buildClaudeCompactionSignature } from './claude-cache-settings.ts';
import { ensureClaudeWorkspaceTrust, withClaudeTrustHint } from './claude-workspace-trust.ts';
import { loadClaudeSdk, type ClaudeSdkModule } from './claude-sdk.ts';
import { readClaudeContextBreakdown } from './claude-context-breakdown.ts';
import { recordClaudePeerMessage, resolveClaudeSessionName } from './claude-peer-message.ts';
import {
  collectClaudeIdleNotices,
  isClaudeMainThreadContent,
  isForeignClaudeResultItem,
} from '../agent-harness/claude-event-normalizer.ts';
import {
  getClaudeReportedContextWindow,
  isClaudeSessionModelCatalogFresh,
  noteClaudeReportedContextWindows,
  resolveClaudeRunModel,
  resolveClaudeRunEffort,
  resolveDefaultClaudeModel,
  setClaudeSessionModelCatalog,
} from './claude-models.ts';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { CONTEXT_RESTART_REASON, advanceRoomContextEpoch, recordContextRestart } from '../usage/context-restarts.ts';
import { INSTRUCTION_EPOCH_REASON, bumpInstructionEpoch, noteNativeSession } from '../context/instruction-epoch.ts';
import { buildProviderWindowError, isProviderWindowError } from '../context/context-budget.ts';
import {
  enforceWatcherOrchestratorMcpGate,
  isMcpOrchestratorErrorCode,
  isWatcherOrchestratorChat,
  stampWatcherOrchestratorRoom,
} from '../mcp/watcher-orchestrator-mcp-gate.js';
import { toClaudeMcpServers } from '../mcp/mcp-vendor-map.js';
import { createAskUserQuestionCanUseTool } from '../approval/ask-user-question.ts';
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
  countClaudeBackgroundTasks,
  hasClaudeBackgroundWork,
  noteClaudeBackgroundTasks,
  createClaudeStreamingSession,
  diffClaudeSessionStartKey,
  isClaudeSessionAlive,
  isClaudeStreamingSessionEnabled,
  parseClaudeEffortLevel,
  reconnectFailedClaudeMcpServers,
  resolveClaudeRunTuning,
  resolveClaudeSessionIdleMs,
  syncClaudeSessionIdleWithPendingQuestions,
} from './claude-session.ts';

import type { getChatByCursorSessionIdAsync as GetChatByCursorSessionId } from '../persist/chats-persist.js';

/** Chat row as this harness reads it (the persist layer only documents the base fields). */
type ClaudeChatRow = NonNullable<Awaited<ReturnType<typeof GetChatByCursorSessionId>>> & {
  agentTransport?: string;
  sdkMode?: string;
  claudeSessionId?: unknown;
};

/** Room state is a loose bag shared with the room kernel; fields are added dynamically. */
type ClaudeRoom = any;
/** Streaming session object owned by claude-session.ts. */
type ClaudeSession = any;
/** SDK `Query` handle (control requests + async iterator). */
type ClaudeQuery = any;
/** Active turn handle created by `sendTurn`. */
interface ClaudeTurn {
  session: ClaudeSession;
  runId: string;
  settled: boolean;
  /** `uuid` of the pushed user message; a follow-up run has none. */
  userMessageUuid?: string;
  /** Run opened by the model answering a background task, not by a prompt. */
  followUp?: boolean;
  finish(outcome?: ClaudeTurnOutcome): void;
}
interface ClaudeTurnOutcome {
  reason?: string;
  error?: string;
}
/** Answer / rejection payload for one pending question. */
interface ClaudeQuestionPayload {
  answers?: string[][];
  reject?: boolean;
  reason?: string;
}
interface ClaudeToolDecision {
  deny: boolean;
  abortRun: boolean;
  notify: boolean;
}
interface ClaudeCanUseToolResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}
interface ClaudeCanUseToolDeps {
  loadSettings?: typeof loadSettings;
  auditOptions?: Parameters<typeof auditCanUseToolGuardDeny>[1];
  advisor?: NonNullable<Parameters<typeof requestCanUseToolPermission>[0]>['advisor'];
}
interface ClaudeQueryExtras {
  model?: string;
  effort?: unknown;
  env?: Record<string, string | undefined>;
  abortController?: AbortController;
  mcpServers?: Record<string, unknown>;
  resumeSessionId?: unknown;
  systemPrompt?: Record<string, unknown>;
  chrome?: boolean;
  replayUserMessages?: boolean;
}
/** Normalized usage item produced by `claude-event-normalizer`. */
interface ClaudeUsageItem {
  usage?: unknown;
  final?: boolean;
  totalCostUsd?: unknown;
  durationMs?: unknown;
  modelUsage?: unknown;
  lastCallUsage?: unknown;
  lastCallModel?: unknown;
  lastCallContextWindowTokens?: unknown;
}
interface ClaudePreparedMcp {
  mcpContext: any;
  mcpPrep: any;
  claudeMcp: Record<string, unknown>;
}
type ClaudeBroadcast = (payload: Record<string, unknown>, opts?: Record<string, unknown>) => void;
interface ClaudePromptRunnerHooks {
  broadcast?: ClaudeBroadcast;
  sendRoomState?: () => void;
  persistRoomEvent?: (entry: Record<string, unknown>, immediate?: boolean) => void;
  flushPersist?: () => void;
  getChatHistoryPage?: typeof getChatHistoryPage;
  getChatRow?: () => Promise<any>;
  appendContextNotice?: typeof appendChatNotice;
  recordPeerMessage?: (peer: { id: string, fromName: string, body: string }) => void;
  loadSdk?: () => Promise<ClaudeSdkModule>;
  buildEnv?: () => Record<string, string | undefined>;
  allowsChrome?: (workspaceKey: string) => boolean;
  getAuthMode?: () => string;
  prepareMcp?: () => ClaudePreparedMcp | Promise<ClaudePreparedMcp>;
  markMcpApplied?: (prepared: { mcpContext: unknown; mcpPrep: unknown }) => void;
  resolveModel?: (modelId: string) => string;
  persistModel?: (model: string) => void;
  streamingEnabled?: () => boolean;
  sessionIdleMs?: () => number;
  enforceOneShotMcpGate?: typeof enforceWatcherOrchestratorMcpGate;
}
interface ClaudePromptRunner {
  startPrompt: (
    text: string,
    modeOverride?: string,
    fromQueue?: boolean,
    displayText?: string,
    alreadyPersisted?: boolean,
    selection?: unknown,
  ) => Promise<void>;
  cancelCurrentRun: () => Promise<void>;
  drainQueue: () => void;
  enqueuePrompt: (text: string, modeOverride?: string, displayText?: string, selection?: unknown) => void;
  steerPrompt: (text: string, modeOverride?: string, displayText?: string, selection?: unknown) => 'delivered' | 'queued' | 'started';
  applySteerInterruptReceipt: (receipt: unknown) => void;
}
interface ClaudeTurnInput {
  sdk: ClaudeSdkModule;
  mode: string;
  model: string;
  effort?: string;
  prepared: ClaudePreparedMcp;
  useResume: boolean;
}
interface ClaudeStreamingTurnInput extends ClaudeTurnInput {
  runId: string;
  text: string;
  chatRow?: object;
  mcpGate?: boolean;
}
interface ClaudeOneShotTurnInput extends ClaudeTurnInput {
  runId: string;
  text: string;
}
interface ClaudePromptItem {
  text: string;
  mode: string;
  displayText?: string;
  alreadyPersisted?: boolean;
  selection?: unknown;
  origin?: Record<string, unknown>;
  requestId?: string;
  contextMessageId?: string;
}
type ErrorLike = { message?: unknown; code?: unknown };

/** Default wait for AskUserQuestion replies (30 minutes). */
export const CLAUDE_QUESTION_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;

export function resolveClaudeQuestionTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env?.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return CLAUDE_QUESTION_TIMEOUT_MS_DEFAULT;
}

export function buildClaudeQuestionResolvedPayload(
  requestId: string,
  payload: ClaudeQuestionPayload = {},
): Record<string, unknown> {
  if (payload.reject === true) {
    const reason = String(payload.reason || 'cancelled').trim() || 'cancelled';
    const status = reason === 'timeout' || reason === 'session_closed' ? 'expired' : 'cancelled';
    return { type: 'questionResolved', requestId, status, reason };
  }
  const answers = sanitizeQuestionAnswers(payload.answers);
  return answers.length > 0
    ? { type: 'questionResolved', requestId, status: 'answered', answers }
    : { type: 'questionResolved', requestId, status: 'answered' };
}

/**
 * Answers shown on the resolved question card: one list of non-empty labels per question.
 */
function sanitizeQuestionAnswers(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => (Array.isArray(entry)
    ? entry.filter((value) => typeof value === 'string' && value.trim()).map((value) => String(value).trim().slice(0, 2000))
    : []));
}

export function isResumableClaudeSessionId(value?: unknown): boolean {
  const id = String(value || '').trim();
  if (!id) return false;
  return id.toLowerCase() !== 'current';
}

/**
 * Native `permissionMode` for a chat conversation mode.
 * The SDK only supports `plan`/`acceptEdits` for read-only/agent; Ask and
 * review keep the SDK default so `canUseTool` is consulted before every edit.
 */
export function resolveClaudePermissionMode(
  mode: unknown,
  assignment?: unknown,
): 'plan' | 'acceptEdits' | 'default' {
  if (isReviewReadOnlyAssignment(assignment)) return 'default';
  if (isAskSdkMode(mode)) return 'default';
  if (isPlanSdkMode(mode)) return 'plan';
  return 'acceptEdits';
}

function closeClaudeRoomSession(room: ClaudeRoom, session?: ClaudeSession | null): void {
  closeClaudeSession(room, session, (payload) => broadcastRoom(room, payload));
}

function abortClaudeRoom(room: ClaudeRoom): void {
  if (!room) return;
  room.cancelled = true;
  void interruptActiveQuery(room);
  closeClaudeRoomSession(room, undefined);
  settleActiveClaudeTurn(room, { reason: 'session_closed' });
}

const kernel = createAgentRoomKernel({
  transport: 'claude',
  logLabel: 'claude-ws',
  goneMessage: 'Claude chat not found for this session.',
  abortRoom: abortClaudeRoom,
  holdRoom: (room) => hasClaudeBackgroundWork(room as ClaudeRoom),
  afterBroadcast(room, payload) {
    trackSdkRoomRunOutcome(room, payload);
    noteDelegationRoomEvent(room, payload);
  },
});
const claudeRooms = kernel.rooms;
registerDecisionGateSource('claude-questions', async (workspaceFolder) => (await roomsInDecisionWorkspace(claudeRooms.values(), workspaceFolder))
  .flatMap((room) => [...(room._pendingQuestions || new Map()).values()]
    .filter((event) => event.type !== 'opencode_permission')
    .map((event) => questionGate(room, event, (payload) => handleClaudeOpenCodeQuestionReply(room, null, payload)))
    .filter(Boolean)));
registerPendingPromptRoomSource(() => claudeRooms.values());
registerMcpOwnerSource('claude', () => claudeRooms.entries());
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

export function setClaudePromptSuggestionsEnabled(enabled: boolean): void {
  if (enabled) return;
  clearClaudePromptSuggestions(claudeRooms.values(), (room, payload) => {
    broadcastRoom(room as ClaudeRoom, payload);
    sendRoomState(room as ClaudeRoom);
  });
}

export function disposeClaudeRoom(sessionKey: string): void {
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

/** Second-line block for Scout chats: mutating natives and opaque shell runners. */
export const CLAUDE_SCOUT_READ_ONLY_DISALLOWED_TOOLS = Object.freeze([
  ...CLAUDE_READ_ONLY_DISALLOWED_TOOLS,
  'Monitor',
  'EnterWorktree',
  'CronCreate',
  'RemoteTrigger',
  'SendMessage',
  'Agent',
  'Task',
]);

/** Operator run chats additionally lose the shell, the web and Skill (Scout keeps read-only shell and web). */
export const CLAUDE_OPERATOR_DISALLOWED_TOOLS = Object.freeze([
  ...CLAUDE_SCOUT_READ_ONLY_DISALLOWED_TOOLS,
  'Bash',
  'WebFetch',
  'WebSearch',
  'Skill',
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

export function isClaudeReadOnlyRunMode(mode: unknown, assignment?: unknown): boolean {
  return isReviewReadOnlyAssignment(assignment) || isReadOnlySdkMode(mode);
}

/**
 * Shared Plan/Ask/review decision for one tool invocation.
 */
function resolveRoomClaudeToolDecision(
  room: ClaudeRoom,
  toolName: unknown,
  input: unknown,
): ClaudeToolDecision {
  return resolvePlanModeToolDecision({
    transport: 'claude',
    mode: readEnforcedSdkMode(room),
    assignment: room?.delegationAssignment,
    toolName,
    input,
    scoutReadOnly: isScoutReadOnlyChatId(room?.chatId),
    operatorRun: isOperatorIsolatedChatId(room?.chatId),
    mcpServer: resolvePlanGuardMcpServerIdentity({ room, harness: 'claude', toolName, args: input }),
    projectRoot: room?.cwd,
  });
}

/** Tool-use ids whose operator audit row the PreToolUse hook already wrote (canUseTool must not write a second). */
const OPERATOR_AUDITED_TOOL_USES_MAX = 500;

/**
 * Audited operator decision for one native tool call. The PreToolUse hook writes the row; canUseTool re-checks
 * the same policy without a second row when it sees the same tool-use id, and audits itself otherwise.
 */
function decideOperatorRoomToolCall(
  room: ClaudeRoom,
  toolName: unknown,
  input: unknown,
  toolUseId: unknown,
  source: 'hook' | 'canUseTool',
): { deny: boolean; reason: string } {
  const audited = (room._operatorAuditedToolUses ||= new Set<string>()) as Set<string>;
  const id = typeof toolUseId === 'string' ? toolUseId : '';
  const already = source === 'canUseTool' && id !== '' && audited.has(id);
  const decision = gateOperatorNativeToolCall({
    chatId: room?.chatId,
    toolName,
    args: input,
    workspaceRoot: room?.cwd,
    server: resolvePlanGuardMcpServerIdentity({ room, harness: 'claude', toolName, args: input }),
    audit: !already,
  });
  if (source === 'hook' && id !== '') {
    if (audited.size >= OPERATOR_AUDITED_TOOL_USES_MAX) audited.clear();
    audited.add(id);
  }
  return decision;
}

/**
 * Builds the `canUseTool` callback for a room. Mutations are denied before
 * execution in Plan / Ask / review; every other tool is allowed.
 */
export function createRoomClaudeCanUseTool(
  room: ClaudeRoom,
  deps: ClaudeCanUseToolDeps = {},
): (
  toolName: string,
  input: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<ClaudeCanUseToolResult> {
  const readSettings = deps.loadSettings || loadSettings;
  const questionTool = createAskUserQuestionCanUseTool({
    generateId: () => randomUUID(),
    // The Claude AskUserQuestion tool reads `answers` keyed by question text;
    // index keys are treated as "the user did not answer".
    answerKeyBy: 'question',
    emitQuestion: (event: Record<string, unknown>) => {
      const requestId = String(event?.requestId || '');
      if (!requestId) return;
      if (!(room._pendingQuestions instanceof Map)) room._pendingQuestions = new Map();
      room._pendingQuestions.set(requestId, event);
      broadcastRoom(room, { type: 'sdkEvent', event });
      sendRoomState(room);
      syncClaudeSessionIdleWithPendingQuestions(room);
      notifyAgentNeedsInput({ room, event });
    },
    waitForReply: (requestId: string, options: { signal?: AbortSignal } = {}) => new Promise((resolve) => {
      if (!(room._claudeQuestionWaiters instanceof Map)) room._claudeQuestionWaiters = new Map();
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (payload: ClaudeQuestionPayload) => {
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
  return async (toolName: string, input: Record<string, unknown>, options: { signal?: AbortSignal; toolUseID?: string } = {}) => {
    if (isOperatorIsolatedChatId(room?.chatId)) {
      // Headless run: the audited native policy is the whole decision, there is no human to ask.
      const operatorDecision = decideOperatorRoomToolCall(room, toolName, input, options.toolUseID, 'canUseTool');
      return operatorDecision.deny
        ? { behavior: 'deny', message: OPERATOR_DENIED_MESSAGE }
        : { behavior: 'allow', updatedInput: input };
    }
    const decision = resolveRoomClaudeToolDecision(room, toolName, input);
    const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
    if (decision.deny) {
      try {
        auditCanUseToolGuardDeny({
          harness: 'claude',
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
      return {
        behavior: 'deny',
        message: scoutReadOnly
          ? SCOUT_READ_ONLY_MESSAGE
          : resolveReadOnlyGuardUserMessage(readEnforcedSdkMode(room), room?.delegationAssignment),
      };
    }
    let permission: Awaited<ReturnType<typeof requestCanUseToolPermission>>;
    try {
      permission = await requestCanUseToolPermission({
        harness: 'claude',
        room,
        toolName,
        input,
        signal: options.signal,
        sdkMode: readEnforcedSdkMode(room),
        scoutReadOnly,
        timeoutMs: resolveClaudeQuestionTimeoutMs(),
        settings: readSettings(),
        auditOptions: deps.auditOptions,
        advisor: deps.advisor,
        host: {
          broadcast: (payload: Record<string, unknown>, opts?: Record<string, unknown>) => broadcastRoom(room, payload, opts),
          onPendingChange: () => {
            sendRoomState(room);
            syncClaudeSessionIdleWithPendingQuestions(room);
          },
          notify: (event: Record<string, unknown>) => notifyAgentNeedsInput({ room, event }),
        },
      });
    } catch (err) {
      // Fail closed: an unexpected gate failure must not silently allow.
      console.warn('[claude] permission gate failed:', (err as ErrorLike)?.message || err);
      return { behavior: 'deny', message: 'Permission check failed' };
    }
    if (permission.outcome === 'deny') {
      return { behavior: 'deny', message: permission.message || 'Permission denied' };
    }
    return questionTool(toolName, input, options);
  };
}

export function resolveClaudeQuestion(
  room: ClaudeRoom,
  requestId: string,
  payload: ClaudeQuestionPayload,
): boolean {
  const id = String(requestId || '').trim();
  if (!id) return false;
  const waiter = room?._claudeQuestionWaiters?.get(id);
  if (typeof waiter !== 'function') return false;
  waiter(payload);
  notifyRoomDecisionGateChange(room);
  broadcastRoom(room, buildClaudeQuestionResolvedPayload(id, payload));
  sendRoomState(room);
  return true;
}

export function rejectPendingClaudeQuestions(room: ClaudeRoom, reason = 'cancelled'): void {
  rejectPendingCanUseToolPermissions(room, reason);
  if (!(room?._claudeQuestionWaiters instanceof Map)) return;
  for (const requestId of [...room._claudeQuestionWaiters.keys()]) {
    resolveClaudeQuestion(room, requestId, { reject: true, reason });
  }
}

export function handleClaudePermissionReply(
  room: ClaudeRoom,
  ws: import('ws').WebSocket | null | undefined,
  msg: { requestId?: string; reply?: string; message?: string },
): boolean {
  const host = {
    broadcast: (payload: Record<string, unknown>, opts?: Record<string, unknown>) => broadcastRoom(room, payload, opts),
    onPendingChange: () => {
      sendRoomState(room);
      syncClaudeSessionIdleWithPendingQuestions(room);
    },
  };
  const resolved = replyCanUseToolPermission(room, host, msg);
  if (resolved || !ws || ws.readyState !== 1) return resolved;
  ws.send(JSON.stringify({ type: 'opencodePermissionResolved', requestId: msg.requestId }));
  return false;
}

/**
 * Replays pending AskUserQuestion cards to a reconnecting browser tab.
 *
 * The frames are tagged `replay: true` so the frontend still renders the card
 * but does not fire a second in-app signal for a question that may be older
 * than the client-side claim window (see `noteInAppSignalIfLive`).
 */
export function sendPendingClaudeQuestionsToClient(room: ClaudeRoom, ws: import('ws').WebSocket): void {
  if (!room || !ws || ws.readyState !== 1) return;
  if (!(room._pendingQuestions instanceof Map) || room._pendingQuestions.size === 0) return;
  for (const event of room._pendingQuestions.values()) {
    if (!event || typeof event !== 'object') continue;
    ws.send(JSON.stringify({ type: 'sdkEvent', event, replay: true }));
  }
}

export function handleClaudeOpenCodeQuestionReply(
  room: ClaudeRoom,
  ws: import('ws').WebSocket | null | undefined,
  msg: { requestId?: string; answers?: Array<Array<string>>; reject?: boolean },
): boolean {
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
 */
export function createRoomClaudePreToolUseHook(
  room: ClaudeRoom,
): (input: { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown }) => Promise<Record<string, unknown>> {
  return async (input) => {
    const rec = input && typeof input === 'object' ? input : {};
    const toolName = typeof rec.tool_name === 'string' ? rec.tool_name : '';
    const rawInput = rec.tool_input;
    const toolInput = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? rawInput
      : {};
    const decision = isOperatorIsolatedChatId(room?.chatId)
      ? decideOperatorRoomToolCall(room, toolName, toolInput, rec.tool_use_id, 'hook')
      : resolveRoomClaudeToolDecision(room, toolName, toolInput);
    if (!decision.deny) return { continue: true };
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: isOperatorIsolatedChatId(room?.chatId)
          ? OPERATOR_DENIED_MESSAGE
          : isScoutReadOnlyChatId(room?.chatId)
          ? SCOUT_READ_ONLY_MESSAGE
          : resolveReadOnlyGuardUserMessage(
            readEnforcedSdkMode(room),
            room?.delegationAssignment,
          ),
      },
    };
  };
}

/**
 * Claude in Chrome acts in the user's real browser with their signed-in
 * accounts, so it needs workspace consent and a human at the keyboard:
 * delegations, Watcher orchestrators, Scout scans and read-only runs never get it.
 */
export function resolveRoomClaudeChrome(
  room: ClaudeRoom,
  chat: { workspaceFile?: unknown; workspaceFolder?: unknown } | null | undefined,
  mode: unknown,
  allowsChrome: (workspaceKey: string) => boolean,
): boolean {
  if (room?.delegationId || room?.delegationAssignment) return false;
  if (isClaudeReadOnlyRunMode(mode) || isScoutReadOnlyChatId(room?.chatId)) return false;
  if (isWatcherOrchestratorChat(chat, room)) return false;
  const workspaceKey = browserScopeKey({ workspaceFile: chat?.workspaceFile, workspaceFolder: chat?.workspaceFolder, cwd: room?.cwd });
  return Boolean(workspaceKey) && allowsChrome(workspaceKey) === true;
}

/**
 * Query options for one Claude run. Exported so the read-only gate can be
 * asserted without spawning the SDK.
 */
export function buildClaudeQueryOptions(
  room: ClaudeRoom,
  mode: unknown,
  extras: ClaudeQueryExtras = {},
): Record<string, unknown> {
  const assignment = room?.delegationAssignment;
  // Pre-accept the folder trust dialog in the Cretli-owned config so project
  // permissions (e.g. in a Watcher worktree) are not ignored headlessly.
  ensureClaudeWorkspaceTrust(extras.env?.CLAUDE_CONFIG_DIR, room?.cwd);
  const options: Record<string, unknown> = {
    cwd: room?.cwd,
    model: extras.model,
    permissionMode: resolveClaudePermissionMode(mode, assignment),
    env: extras.env && room?.chatId
      ? { ...extras.env, CLAUDE_CODE_SESSION_NAME: resolveClaudeSessionName(room.chatId, room.cwd) }
      : extras.env,
    abortController: extras.abortController,
    includePartialMessages: true,
    systemPrompt: extras.systemPrompt || CLAUDE_SYSTEM_PROMPT,
    stderr: (data: unknown) => appendClaudeStderrChunk(room, data),
    canUseTool: createRoomClaudeCanUseTool(room),
    hooks: {
      PreToolUse: [{ hooks: [createRoomClaudePreToolUseHook(room)] }],
    },
  };
  const promptSuggestionsEnabled = loadSettings().claudePromptSuggestionEnabled !== false
    && String((extras.env || process.env).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION ?? '').toLowerCase() !== 'false';
  if (promptSuggestionsEnabled && !room?.delegationId && !assignment
      && !isOperatorIsolatedChatId(room?.chatId) && !isScoutReadOnlyChatId(room?.chatId)
      && !isWatcherOrchestratorChat(null, room) && !isClaudeReadOnlyRunMode(mode, assignment)) {
    options.promptSuggestions = true;
  }
  const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
  if (isOperatorIsolatedChatId(room?.chatId)) {
    // Repository settings and CLAUDE.md are data, not instructions, for an operator run.
    options.settingSources = [];
    options.disallowedTools = [...CLAUDE_OPERATOR_DISALLOWED_TOOLS];
  } else if (scoutReadOnly) {
    options.settingSources = [...CLAUDE_AGENT_SETTING_SOURCES];
    options.disallowedTools = [...CLAUDE_SCOUT_READ_ONLY_DISALLOWED_TOOLS];
  } else if (isClaudeReadOnlyRunMode(mode, assignment)) {
    // Read-only modes must not inherit user/local permission allow rules.
    // CLI 2.1.300 skips retention when user settings are excluded and no enabled
    // source sets cleanupPeriodDays. Keep inline settings absent; see SETUP.md
    // and claude-retention-cli.test.js for the pinned SDK regression check.
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
  // Survives strictMcpConfig: the CLI registers claude-in-chrome itself.
  const extraArgs: Record<string, null> = {};
  if (extras.chrome === true) extraArgs.chrome = null;
  // Without the echo a message from another session is known only from the
  // `result` that follows the answer. Needs streaming stdin, so never one-shot.
  if (extras.replayUserMessages === true) extraArgs['replay-user-messages'] = null;
  if (Object.keys(extraArgs).length > 0) options.extraArgs = extraArgs;
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

export function isClaudeResumeFailure(message: unknown): boolean {
  const text = String(message || '').trim();
  if (!text) return false;
  return CLAUDE_RESUME_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Forget a session that can no longer be resumed.
 */
export function clearClaudeRoomSession(room: ClaudeRoom): void {
  if (!room) return;
  room.claudeSessionId = '';
  if (room.chatId) runChatWrite('setChatClaudeSessionId', () => setChatClaudeSessionIdAsync(room.chatId, ''), room.chatId);
  // The earlier session (and anything delivered into it) is gone: the next
  // turn must re-deliver the required instruction blocks.
  bumpInstructionEpoch(room, INSTRUCTION_EPOCH_REASON.RESUME_FAILED, { nativeSessionId: '' });
}

/**
 * True when a failed first attempt used `resume` and the error says the
 * session is gone: the run may be retried exactly once without `resume`.
 */
export function shouldRetryClaudeRunWithoutResume(
  input: {
    attempt?: unknown;
    useResume?: unknown;
    status?: unknown;
    cancelled?: unknown;
    errorMessage?: unknown;
  } = {},
): boolean {
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
 */
function clearInterruptFallback(room: ClaudeRoom): void {
  if (!room) return;
  if (room._interruptFallbackTimer) {
    clearTimeout(room._interruptFallbackTimer);
    room._interruptFallbackTimer = null;
  }
  room._interruptFallbackRunId = '';
}

function settleActiveClaudeTurn(room: ClaudeRoom, outcome: ClaudeTurnOutcome = {}): void {
  const turn = room?._activeTurn;
  if (!turn || typeof turn.finish !== 'function') return;
  turn.finish({ reason: outcome.reason || 'session_closed', error: outcome.error || '' });
}

/**
 * Abort the controller, close the query and drop the room references. Also
 * marks the streaming session dead so the next prompt resumes it in a fresh
 * process.
 */
function abortAndCloseClaudeQuery(room: ClaudeRoom, query: ClaudeQuery, abort: AbortController | null | undefined): void {
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
 */
export async function interruptActiveQuery(
  room: ClaudeRoom,
  timeoutMs: number = CLAUDE_INTERRUPT_TIMEOUT_MS,
  abortFallbackMs: number = CLAUDE_INTERRUPT_ABORT_FALLBACK_MS,
): Promise<void> {
  rejectPendingClaudeQuestions(room, 'cancelled');
  const query = room?._activeQuery;
  const abort = room?._abortController;
  // Capture the turn id before awaiting: the result may arrive while
  // `interrupt()` is in flight and clear `_activeTurnRunId`.
  const runId = room && typeof room._activeTurnRunId === 'string' ? room._activeTurnRunId : '';
  let interrupted = false;
  let receipt: unknown;
  // Steered messages are reclaimed from the receipt below; keep the turn's own
  // settle path from re-queueing them first.
  if (room) room._interruptInFlight = true;
  if (query && typeof query.interrupt === 'function') {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      interrupted = await Promise.race([
        Promise.resolve(query.interrupt()).then((value: unknown) => {
          receipt = value;
          return true;
        }, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, Number(timeoutMs) || 0));
        }),
      ]) === true;
    } catch {
      interrupted = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (room) {
    room._interruptInFlight = false;
    if (typeof room._applySteerInterruptReceipt === 'function') room._applySteerInterruptReceipt(receipt);
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
 */
export function syncClaudeRoomModelFromChat(
  sessionKey: string,
  model: string,
  rooms: Map<string, ClaudeRoom> = claudeRooms,
): void {
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
 * `meta` is run-time context stamped on rate-limit notices so a snapshot is
 * attributed to the auth mode it was read under.
 */
export function buildClaudeNoticePayload(
  notice: Record<string, unknown>,
  runId?: unknown,
  meta: { authMode?: string } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
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
  // Auth mode only (`subscription` | `api-key`): a coarse, secret-free scope.
  if (notice?.noticeType === 'rate_limit' && typeof meta?.authMode === 'string' && meta.authMode) {
    payload.authMode = meta.authMode;
  }
  if (typeof notice?.trigger === 'string' && notice.trigger) payload.trigger = notice.trigger;
  for (const key of ['preTokens', 'postTokens']) {
    const value = Number(notice?.[key]);
    if (Number.isFinite(value)) payload[key] = value;
  }
  return payload;
}

/**
 * Builds the `sdkEvent` broadcast for a normalized Claude `usage` item.
 *
 * `final` is the run's coverage proof: `recordHarnessUsageDelta` only promotes a
 * run to `complete` when the usage event carries it, so it must survive this
 * adapter boundary together with the cost/duration/model metadata. Exported so
 * the production propagation path can be asserted directly instead of a
 * hand-copied shape.
 *
 * `item` is a normalized `claude-event-normalizer` usage item.
 */
export function buildClaudeUsageSdkEvent(item: ClaudeUsageItem): Record<string, unknown> {
  const usageEvent: Record<string, unknown> = { type: 'usage', usage: item?.usage };
  if (item?.final === true) usageEvent.final = true;
  if (item?.totalCostUsd != null) usageEvent.totalCostUsd = item.totalCostUsd;
  if (item?.durationMs != null) usageEvent.durationMs = item.durationMs;
  if (item?.modelUsage && typeof item.modelUsage === 'object') {
    usageEvent.modelUsage = item.modelUsage;
  }
  if (item?.lastCallUsage && typeof item.lastCallUsage === 'object') {
    usageEvent.lastCallUsage = item.lastCallUsage;
    if (item.lastCallModel) usageEvent.lastCallModel = item.lastCallModel;
    if (item.lastCallContextWindowTokens) {
      usageEvent.lastCallContextWindowTokens = item.lastCallContextWindowTokens;
    }
  }
  return usageEvent;
}

/** Lines of subprocess stderr kept per room for diagnostics. */
export const CLAUDE_STDERR_TAIL_LINES = 50;

/**
 * Removes obvious credentials from a stderr line before it is stored.
 */
export function redactClaudeStderrLine(line: unknown): string {
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
 */
export function appendClaudeStderrChunk(room: ClaudeRoom, chunk: unknown): void {
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

export function readClaudeStderrTail(room: ClaudeRoom): string[] {
  return Array.isArray(room?._claudeStderrTail) ? room._claudeStderrTail.slice() : [];
}

export function readLastClaudeStderrLine(room: ClaudeRoom): string {
  const tail = Array.isArray(room?._claudeStderrTail) ? room._claudeStderrTail : [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = String(tail[index] || '').trim();
    if (line) return line;
  }
  return '';
}

/**
 * Trims and de-duplicates error candidates, keeping priority order. One run can
 * report the same failure as several texts (a generic SDK error plus provider
 * prose carrying a reset clock); the shared usage-limit parser needs all of
 * them so it can prefer the variant that states when the window reopens.
 */
function collectErrorMessages(...values: unknown[]): string[] {
  const list: string[] = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text && !list.includes(text)) list.push(text);
  }
  return list;
}

function readClaudeMessageSessionId(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const rec = message as Record<string, unknown>;
  if (typeof rec.session_id === 'string' && rec.session_id.trim()) return rec.session_id.trim();
  if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) return rec.sessionId.trim();
  return '';
}

/**
 * Refreshes the global Claude model catalog from `query.supportedModels()`,
 * asynchronously and at most once per TTL. Never blocks a turn; all failures
 * are ignored (the `/v1/models` and alias sources remain).
 */
let claudeSessionModelsProbeInFlight = false;

function primeClaudeSessionModelCatalog(session: ClaudeSession): void {
  if (claudeSessionModelsProbeInFlight) return;
  if (isClaudeSessionModelCatalogFresh()) return;
  const query = session?.query;
  if (!query || typeof query.supportedModels !== 'function') return;
  claudeSessionModelsProbeInFlight = true;
  Promise.resolve()
    .then(() => query.supportedModels())
    .then((models: unknown) => {
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
 */
export function createClaudePromptRunner({
  room,
  hooks = {},
}: {
  room: ClaudeRoom;
  hooks?: ClaudePromptRunnerHooks;
}): ClaudePromptRunner {
  const broadcast = typeof hooks.broadcast === 'function'
    ? hooks.broadcast
    : (payload: Record<string, unknown>, opts?: Record<string, unknown>) => broadcastRoom(room, payload, opts);
  const sendRoomStateHook = typeof hooks.sendRoomState === 'function'
    ? hooks.sendRoomState
    : () => sendRoomState(room);
  const persistEventHook = typeof hooks.persistRoomEvent === 'function'
    ? hooks.persistRoomEvent
    : (entry: Record<string, unknown>, immediate?: boolean) => persistRoomEvent(room, entry, immediate);
  const flushHook = typeof hooks.flushPersist === 'function'
    ? hooks.flushPersist
    : () => flushPersistBuffer(room);
  const historyPageHook = typeof hooks.getChatHistoryPage === 'function' ? hooks.getChatHistoryPage : getChatHistoryPage;
  const contextNoticeHook = typeof hooks.appendContextNotice === 'function' ? hooks.appendContextNotice : appendChatNotice;
  const enforceOneShotMcpGate = typeof hooks.enforceOneShotMcpGate === 'function' ? hooks.enforceOneShotMcpGate : enforceWatcherOrchestratorMcpGate;
  const loadSdk = typeof hooks.loadSdk === 'function' ? hooks.loadSdk : () => loadClaudeSdk();
  const buildEnv = typeof hooks.buildEnv === 'function' ? hooks.buildEnv : () => buildClaudeProcessEnv();
  const allowsChrome = typeof hooks.allowsChrome === 'function'
    ? hooks.allowsChrome
    : (workspaceKey: string) => resolveBrowserPolicy(resolveDataPath(), workspaceKey, loadSettings()).allowClaudeChrome === true;
  const resolveChrome = async (mode: unknown) => resolveRoomClaudeChrome(
    room,
    await getChatByCursorSessionIdAsync(room.sessionKey),
    mode,
    allowsChrome,
  );
  const recordPeerMessage = typeof hooks.recordPeerMessage === 'function'
    ? hooks.recordPeerMessage
    : (peerMessage: Parameters<typeof recordClaudePeerMessage>[1]) => {
      flushHook();
      void recordClaudePeerMessage(room.chatId, peerMessage);
    };
  const getAuthMode = typeof hooks.getAuthMode === 'function' ? hooks.getAuthMode : () => getClaudeAuthMode();
  const prepareMcp = typeof hooks.prepareMcp === 'function' ? hooks.prepareMcp : async () => {
    const mcpContext = buildMcpRuntimeContext({
      chat: await getChatByCursorSessionIdAsync(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'claude' },
      room,
      harness: 'claude',
      mode: room.sdkMode,
    });
    const mcpPrep = prepareHarnessMcp(mcpContext);
    return { mcpContext, mcpPrep, claudeMcp: toClaudeMcpServers(mcpPrep.mcpServers) };
  };
  const markMcpApplied = typeof hooks.markMcpApplied === 'function'
    ? hooks.markMcpApplied
    : (prepared: { mcpContext: any; mcpPrep: any }) => markMcpConfigApplied(prepared.mcpContext, prepared.mcpPrep.servers, prepared.mcpPrep.revision);
  const resolveModel = typeof hooks.resolveModel === 'function'
    ? hooks.resolveModel
    : (modelId: string) => resolveClaudeRunModel(modelId);
  const persistModel = typeof hooks.persistModel === 'function'
    ? hooks.persistModel
    : (model: string) => {
      room.modelId = model;
      if (room.chatId) runChatWrite('model', () => updateChatAsync(room.chatId, { model }), room.chatId);
    };
  const streamingEnabled = typeof hooks.streamingEnabled === 'function'
    ? hooks.streamingEnabled
    : () => isClaudeStreamingSessionEnabled();
  const sessionIdleMs = typeof hooks.sessionIdleMs === 'function'
    ? hooks.sessionIdleMs
    : () => resolveClaudeSessionIdleMs();

  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];

  function notify(notice: Record<string, unknown>, runId = room.currentRun?.id): void {
    // A compact boundary rewrites the prompt prefix, so the prompt cache is
    // destroyed; bump the epoch before the following usage is attributed.
    if (notice && notice.noticeType === 'compact') {
      advanceRoomContextEpoch(room, 'compact_boundary');
      room._claudeContextObservation = null;
    }
    broadcast(buildClaudeNoticePayload(notice, runId, { authMode: getAuthMode() }), {
      log: notice.noticeType === 'background_tasks',
    });
  }

  function applyApiError(message: string): boolean {
    const text = String(message || '').trim();
    if (!text) return false;
    if (room._claudeLastApiErrorMessage === text) return false;
    room._claudeLastApiErrorMessage = text;
    room._lastApiError = text;
    if (isProviderWindowError(text)) {
      // Hard window error: explain the sizes Cretli added and the ways forward.
      // The turn is never resent with shortened instructions.
      const windowError = buildProviderWindowError({
        transport: 'claude',
        providerMessage: text,
        budget: room._lastContextBudget || null,
      });
      broadcast({
        type: 'sdkError',
        code: windowError.code,
        message: windowError.message,
        details: windowError,
      });
      return true;
    }
    broadcast({ type: 'sdkError', code: 'claude_error', message: text });
    return true;
  }

  function persistSessionId(sessionId: unknown): void {
    const next = String(sessionId || '').trim();
    if (!isResumableClaudeSessionId(next)) return;
    // The room mirrors the stored id, so an unchanged id needs no write: rewriting chats.json on
    // every streamed message cost seconds of event loop per turn.
    const changed = room.claudeSessionId !== next;
    room.claudeSessionId = next;
    if (changed && room.chatId) runChatWrite('setChatClaudeSessionId', () => setChatClaudeSessionIdAsync(room.chatId, next), room.chatId);
    // A native session id that differs from the one seen before is a new
    // session for instruction purposes (bumps the epoch, nothing else).
    noteNativeSession(room, { nativeSessionId: next });
  }

  function applyPlanGuardIfNeeded(event: Record<string, unknown>): boolean {
    const mode = readEnforcedSdkMode(room);
    const assignment = room.delegationAssignment;
    const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
    const operatorRun = isOperatorIsolatedChatId(room?.chatId);
    const decision = resolvePlanModeSdkEventDecision({
      transport: 'claude',
      mode,
      assignment,
      event,
      scoutReadOnly,
      operatorRun,
      projectRoot: room.cwd,
      mcpServer: resolvePlanGuardMcpServerIdentity({ room, harness: 'claude', event }),
    });
    if (!decision.notify) return false;
    if (decision.abortRun) {
      room.cancelled = true;
      room._planGuardTriggered = true;
      void interruptActiveQuery(room);
    }
    broadcast({
      type: 'sdkPlanGuard',
      message: operatorRun ? OPERATOR_DENIED_MESSAGE : scoutReadOnly ? SCOUT_READ_ONLY_MESSAGE : resolveReadOnlyGuardUserMessage(mode, assignment),
      toolName: typeof event.name === 'string' ? event.name : '',
    });
    return true;
  }

  /**
   * Moves unconsumed steered messages to `pendingPrompts`, each exactly once
   * (the outstanding entry is removed as it is queued). `only` limits the move
   * to these uuids; null = all.
   */
  function reclaimSteers(only: Set<string> | null): void {
    const outstanding = room._steerOutstanding;
    if (!(outstanding instanceof Map) || outstanding.size === 0) return;
    let moved = false;
    for (const [uuid, entry] of [...outstanding]) {
      if (only && !only.has(uuid)) continue;
      outstanding.delete(uuid);
      const item: ClaudePromptItem = { text: entry.text, mode: entry.mode, alreadyPersisted: true, contextMessageId: entry.contextMessageId, origin: entry.origin, requestId: entry.requestId };
      if (entry.displayText) item.displayText = entry.displayText;
      room.pendingPrompts.push(item);
      broadcast({ type: 'sdkQueued', text: entry.displayText || entry.text }, { log: false });
      moved = true;
    }
    if (moved) sendRoomStateHook();
  }

  /**
   * Handles the `Query.interrupt()` receipt (`still_queued`, or `cancelled`
   * when the caller asked for `cancel_queued`). Reported uuids go back to the
   * queue; the others were consumed. Without a receipt everything outstanding
   * is conservatively re-queued.
   */
  function applySteerInterruptReceipt(receipt: unknown): void {
    const outstanding = room._steerOutstanding;
    if (!(outstanding instanceof Map) || outstanding.size === 0) return;
    const rec = receipt && typeof receipt === 'object' ? (receipt as Record<string, unknown>) : null;
    const reported: string[] = [];
    let hasReceiptFields = false;
    for (const key of ['still_queued', 'cancelled']) {
      if (rec && Array.isArray(rec[key])) {
        hasReceiptFields = true;
        for (const id of rec[key]) if (typeof id === 'string') reported.push(id);
      }
    }
    if (!hasReceiptFields) {
      reclaimSteers(null);
      return;
    }
    reclaimSteers(new Set(reported));
    outstanding.clear();
  }

  /**
   * A per-message echo carrying one of our steer uuids means it was consumed.
   */
  function noteSteerEcho(message: unknown): string {
    const outstanding = room._steerOutstanding;
    if (!(outstanding instanceof Map) || outstanding.size === 0) return '';
    const rec = message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
    if (!rec) return '';
    if (typeof rec.user_message_uuid === 'string') {
      const uuid = rec.user_message_uuid;
      outstanding.delete(uuid);
      return uuid;
    }
    if (rec.type === 'user' && rec.isReplay === true && typeof rec.uuid === 'string') {
      const uuid = rec.uuid;
      outstanding.delete(uuid);
      return uuid;
    }
    return '';
  }

  /** A follow-up run owns task-notification results; a user turn does not. */
  function isForeignResultItem(item: unknown, turn: ClaudeTurn | null): boolean {
    return turn?.followUp !== true && isForeignClaudeResultItem(item, turn?.userMessageUuid);
  }

  /**
   * Normalizes and dispatches one SDK message. `turn` may be null (legacy
   * one-shot runs and between-turn streaming messages): `result` is still
   * recorded so `runPrompt` can read the status.
   */
  function dispatchClaudeMessage(message: unknown, turn: ClaudeTurn | null): void {
    if (!room._claudeNormalizer || typeof room._claudeNormalizer.normalize !== 'function') {
      room._claudeNormalizer = createClaudeEventNormalizer();
    }
    const steerEchoId = noteSteerEcho(message);
    const items = room._claudeNormalizer.normalize(externalizeToolResultImages(message, chatMediaSaver(room.chatId)));
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (steerEchoId) (item as any).contextMessageId = steerEchoId;
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
      if (item.kind === 'api_call_usage') {
        // Per-API-call usage of the first call in the turn; the run-level
        // `usage` item remains the token source so nothing is counted twice.
        if (!room._firstApiCallUsage && item.usage && typeof item.usage === 'object') {
          room._firstApiCallUsage = item.usage;
        }
        continue;
      }
      if (item.kind === 'context_usage') {
        // The cache lifetime runs from the start of a request, so every update of
        // one call (stream start, final output count) keeps the first timestamp.
        const previous = room._claudeContextObservation;
        const sameCall = previous && previous.usage?.inputTokens === item.usage?.inputTokens;
        const observedAt = sameCall ? previous.observedAt : new Date().toISOString();
        room._claudeContextObservation = {
          observedAt,
          usage: item.usage,
          model: item.model ?? null,
          contextWindowTokens: getClaudeReportedContextWindow(item.model),
        };
        broadcast({ type: 'sdkContextUsage', ...room._claudeContextObservation }, { log: false });
        continue;
      }
      if (item.kind === 'usage') {
        if (isForeignResultItem(item, turn)) continue;
        room._lastUsage = item;
        noteClaudeReportedContextWindows(item.modelUsage);
        if (item.firstApiCallUsage && typeof item.firstApiCallUsage === 'object') {
          room._firstApiCallUsage = item.firstApiCallUsage;
        }
        // `buildClaudeUsageSdkEvent` keeps `final` (the run coverage proof),
        // cost, duration and modelUsage on the event the kernel consumes.
        broadcast({ type: 'sdkEvent', event: buildClaudeUsageSdkEvent(item) });
        continue;
      }
      if (item.kind === 'result') {
        persistSessionId(item.sessionId);
        if (isForeignResultItem(item, turn)) continue;
        room._lastResult = item;
        if (Array.isArray(item.userMessageUuids)) {
          for (const id of item.userMessageUuids) room._steerOutstanding?.delete(id);
        }
        // Hold the turn open only when the CLI says more work is queued behind
        // this result (`queuedTurnCount > 0`): Claude then runs the steered
        // message next and reports it in a later result. A missing or zero
        // count cannot prove more is coming, so the result settles and leftover
        // steers are re-queued instead of risking a turn that never ends.
        const holdForSteers = item.queuedTurnCount > 0
          && room._steerOutstanding?.size > 0
          && item.status !== 'error'
          && !room.cancelled;
        if (!holdForSteers && turn && typeof turn.finish === 'function') turn.finish({ reason: 'result' });
        continue;
      }
      if (applyPlanGuardIfNeeded(item)) return;
      room._turnContentSeen = true;
      broadcast({ type: 'sdkEvent', event: item });
    }
  }

  /**
   * Routes one streaming session message to the active turn. Messages outside
   * a turn (for example `system init` between turns, or background task /
   * tool_progress chatter that arrives after `result`) only refresh the
   * persisted session id and surface advisory notices; they are never
   * broadcast as answer content for the next turn. The exception is the model
   * answering a finished background task, which opens its own follow-up run.
   */
  function handleSessionMessage(session: ClaudeSession, message: unknown): void {
    if (room._claudeSession !== session) return;
    const raw = message as { type?: string; suggestion?: unknown; session_id?: unknown };
    if (raw?.type === 'prompt_suggestion') {
      const text = typeof raw.suggestion === 'string' ? raw.suggestion.trim().slice(0, 500) : '';
      const expectedSession = String(room._lastResult?.sessionId || '');
      const receivedSession = String(raw.session_id || '');
      const result = room._lastResult;
      setTimeout(() => {
        if (room._claudeSession !== session || session.alive !== true) return;
        const enabled = session.promptSuggestionsEnabled === true
          && loadSettings().claudePromptSuggestionEnabled !== false
          && String(process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION || '').toLowerCase() !== 'false';
        if (text && room._lastResult === result && shouldAcceptClaudePromptSuggestion({
          enabled,
          busy: room.busy === true,
          pendingPromptCount: room.pendingPrompts?.length || 0,
          sessionId: receivedSession,
          expectedSessionId: expectedSession,
          resultStatus: String(result?.status || ''),
          apiError: !!room._lastApiError || !!room._claudeLastApiErrorMessage,
          runMode: normalizeSdkMode(room.sdkMode),
        })) {
          const value = { text, turnRunId: String(room.lastRunId || ''), createdAt: Date.now() };
          room.promptSuggestion = value;
          broadcast({ type: 'promptSuggestion', chatId: room.chatId, text, turnRunId: value.turnRunId });
          sendRoomStateHook();
        }
      }, 0);
      return;
    }
    if (room.promptSuggestion && (raw?.type === 'result' || raw?.type === 'assistant')) {
      room.promptSuggestion = null;
      broadcast({ type: 'promptSuggestion', chatId: room.chatId, text: '', turnRunId: '' });
    }
    const previousCount = countClaudeBackgroundTasks(session);
    noteClaudeBackgroundTasks(session, message);
    const signal = message as { type?: string; subtype?: string };
    if (signal?.type === 'system' && signal.subtype === 'background_tasks_changed') {
      const count = countClaudeBackgroundTasks(session);
      // Counts only: task descriptions can contain private command details.
      console.info('[claude] background_tasks_changed', { count, busy: room.busy === true });
      sendRoomStateHook();
      if (!room.busy && count > 0 && count !== previousCount) {
        notify({ noticeType: 'background_tasks', message: msg(null, 'claude.backgroundTasksRunning', { count }) });
      }
    }
    const peerMessage = readClaudePeerMessage(message);
    const active = room._activeTurn;
    const turn = active && active.session === session && active.settled !== true
      ? active
      : (peerMessage || isClaudeMainThreadContent(message) ? openFollowUpRun(session) : null);
    // Stored even when no run could open: the model still reads the message.
    if (peerMessage) recordPeerMessage(peerMessage);
    if (!turn) {
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
   */
  function handleSessionEnd(session: ClaudeSession, error: unknown): void {
    clearClaudeSessionIdleTimer(session);
    if (session && typeof session === 'object') session.alive = false;
    if (room._claudeSession === session) room._claudeSession = null;
    if (session && room._activeQuery === session.query) room._activeQuery = null;
    if (session && room._abortController === session.abortController) room._abortController = null;
    if ((!room._claudeSession || room._claudeSession === session) && room.promptSuggestion) {
      room.promptSuggestion = null;
      broadcast({ type: 'promptSuggestion', chatId: room.chatId, text: '', turnRunId: '' });
    }
    const turn = room._activeTurn;
    if (!turn || turn.session !== session) {
      sendRoomStateHook();
      return;
    }
    const message = (error as ErrorLike)?.message ? String((error as ErrorLike).message) : (error ? String(error) : '');
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
   */
  async function ensureSession(input: ClaudeTurnInput): Promise<ClaudeSession> {
    const readOnly = isClaudeReadOnlyRunMode(input.mode, room.delegationAssignment);
    const permissionMode = resolveClaudePermissionMode(input.mode, room.delegationAssignment);
    // The chat's auto-compression opt-in drives Claude's native compaction.
    const env = applyClaudeChatCompactionEnv(buildEnv(), room._lastChatRow);
    const authSignature = buildClaudeAuthSignature(getAuthMode(), env);
    // The bridge token pins the delegation attempt, so a new round must not reuse the session.
    const mcpSignature = `${buildClaudeMcpSignature(input.prepared.claudeMcp)}|attempt:${String(room.delegationAttemptId || '')}`;
    const tuning = resolveClaudeRunTuning(env, {
      delegation: Boolean(room.delegationAssignment),
    });
    tuning.effort = parseClaudeEffortLevel(input.effort) || tuning.effort;
    const chrome = await resolveChrome(input.mode);
    // Only a new process can gain or lose the Chrome tools.
    const tuningSignature = `${buildClaudeTuningSignature(tuning)}|chrome:${chrome ? 1 : 0}|${buildClaudeCompactionSignature(env)}`;
    const nextStartKey = buildClaudeSessionStartKey({
      cwd: room.cwd,
      readOnly,
      authSignature,
      mcpRevision: input.prepared.mcpPrep?.revision,
      mcpSignature,
      tuningSignature,
    });

    const noteRestart = (reason: string) => {
      // A rebuilt session may carry another system prompt, tools or model; do
      // not assume the earlier instruction copy survived.
      bumpInstructionEpoch(
        room,
        reason === CONTEXT_RESTART_REASON.MODEL_CHANGE
          ? INSTRUCTION_EPOCH_REASON.MODEL_CHANGE
          : reason === CONTEXT_RESTART_REASON.MODE_CHANGE
            ? INSTRUCTION_EPOCH_REASON.MODE_CHANGE
            : INSTRUCTION_EPOCH_REASON.CHANNEL_CHANGE,
      );
      return recordContextRestart({
        chatId: room.chatId,
        harness: 'claude',
        reason,
        room,
      });
    };
    let session: ClaudeSession = isClaudeSessionAlive(room._claudeSession) ? room._claudeSession : null;
    if (session) {
      const diff = diffClaudeSessionStartKey(session.startKey, nextStartKey);
      if (diff.stableChanged) {
        noteRestart(
          session.startKey?.modeClass !== nextStartKey.modeClass
            ? CONTEXT_RESTART_REASON.MODE_CHANGE
            : CONTEXT_RESTART_REASON.PROCESS_RECREATED,
        );
        closeClaudeRoomSession(room, session);
        session = null;
      } else {
        if (input.model && session.model !== input.model) {
          if (typeof session.query.setModel === 'function') {
            try {
              await session.query.setModel(input.model);
              session.model = input.model;
              // The transcript survives, but the new model starts with a cold
              // cache (and maybe another window): earlier readings are stale.
              noteRestart(CONTEXT_RESTART_REASON.MODEL_CHANGE);
            } catch {
              noteRestart(CONTEXT_RESTART_REASON.MODEL_CHANGE);
              closeClaudeRoomSession(room, session);
              session = null;
            }
          } else {
            noteRestart(CONTEXT_RESTART_REASON.MODEL_CHANGE);
            closeClaudeRoomSession(room, session);
            session = null;
          }
        }
        if (session && session.permissionMode !== permissionMode) {
          if (typeof session.query.setPermissionMode === 'function') {
            try {
              await session.query.setPermissionMode(permissionMode);
              session.permissionMode = permissionMode;
            } catch {
              noteRestart(CONTEXT_RESTART_REASON.MODE_CHANGE);
              closeClaudeRoomSession(room, session);
              session = null;
            }
          } else {
            noteRestart(CONTEXT_RESTART_REASON.MODE_CHANGE);
            closeClaudeRoomSession(room, session);
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
              noteRestart(CONTEXT_RESTART_REASON.MCP_REVISION);
              closeClaudeRoomSession(room, session);
              session = null;
            }
          } else {
            noteRestart(CONTEXT_RESTART_REASON.MCP_REVISION);
            closeClaudeRoomSession(room, session);
            session = null;
          }
        }
        if (session) {
          // A crashed stdio bridge is never restarted by the CLI itself.
          const health = await reconnectFailedClaudeMcpServers(
            session.query,
            Object.keys(input.prepared.claudeMcp || {}),
          );
          if (health.reconnected.length > 0) {
            console.warn('[claude] reconnected failed MCP server(s):', health.reconnected.join(', '));
          }
          if (health.failed.length > 0) {
            console.warn('[claude] MCP server(s) still failed, restarting session:', health.failed.join(', '));
            noteRestart(CONTEXT_RESTART_REASON.PROCESS_RECREATED);
            closeClaudeRoomSession(room, session);
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
        chrome,
        replayUserMessages: true,
      });
      // Without resume this is a fresh native session with no earlier copy of
      // the instructions (a resumed one keeps its history; a failed resume
      // bumps the epoch in clearClaudeRoomSession).
      if (!input.useResume || !room.claudeSessionId) {
        bumpInstructionEpoch(room, INSTRUCTION_EPOCH_REASON.NEW_SESSION);
      }
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
        onMessage: (active: ClaudeSession, message: unknown) => handleSessionMessage(active, message),
        onEnd: (ended: ClaudeSession, error: unknown) => handleSessionEnd(ended, error),
      });
    }

    room._activeQuery = session.query;
    room._abortController = session.abortController;
    primeClaudeSessionModelCatalog(session);
    return session;
  }

  function sendTurn(session: ClaudeSession, message: Record<string, unknown>): Promise<{ reason: string; error?: string }> {
    return new Promise((resolve) => {
      const userMessageUuid = randomUUID();
      const turn: ClaudeTurn = {
        session,
        runId: room.currentRun?.id || '',
        settled: false,
        userMessageUuid,
        finish(outcome: ClaudeTurnOutcome = {}) {
          if (turn.settled) return;
          turn.settled = true;
          if (room._activeTurn === turn) room._activeTurn = null;
          clearInterruptFallback(room);
          if (!room._interruptInFlight) reclaimSteers(null);
          resolve({ reason: outcome.reason || 'result', error: outcome.error || '' });
        },
      };
      room._activeTurn = turn;
      if (!session.input.push({ ...message, uuid: userMessageUuid })) {
        turn.finish({ reason: 'session_closed', error: 'Claude session input is closed.' });
        return;
      }
      if (room.cancelled) void interruptActiveQuery(room);
    });
  }

  /**
   * One streaming turn: ensure the session, push the decorated user message and
   * wait for its `result` (or for the session to die).
   */
  async function runStreamingTurn(
    input: ClaudeStreamingTurnInput,
  ): Promise<{ reason: string; error?: string; code?: string }> {
    const session = await ensureSession({
      sdk: input.sdk,
      mode: input.mode,
      model: input.model,
      effort: input.effort,
      prepared: input.prepared,
      useResume: input.useResume,
    });
    if (input.mcpGate) {
      // The Query process is alive now; wait for its bridge to list the live
      // catalog before the first prompt is pushed into the session.
      const block = await enforceWatcherOrchestratorMcpGate({
        chat: input.chatRow,
        room,
        mcpPrep: input.prepared.mcpPrep,
        mcpContext: input.prepared.mcpContext,
        sessionStartedAt: room.currentRun?.startedAt,
        bridgeStrategy: 'session',
      });
      if (block) return { reason: 'mcp_gate', error: block.message, code: block.code };
    }
    broadcast({
      type: 'sdkRunProgress',
      runId: input.runId,
      phase: 'stream',
      transport: 'claude',
    }, { log: false });
    markMcpApplied(input.prepared);
    session.turns += 1;
    // Decorate first (captures pending delegation report ids), then confirm.
    const text = await decorateHarnessPrompt(room, input.text, 'claude');
    confirmDelegationReportsFromRoom(room);
    return sendTurn(session, buildClaudeUserMessage(room.claudeSessionId, text));
  }

  /**
   * Legacy one-shot turn (kill switch): a fresh Query per prompt with a string
   * prompt and `resume`.
   */
  async function runOneShotTurn(input: ClaudeOneShotTurnInput): Promise<void> {
    const abortController = new AbortController();
    room._abortController = abortController;
    const options = buildClaudeQueryOptions(room, input.mode, {
      model: input.model,
      effort: input.effort,
      env: applyClaudeChatCompactionEnv(buildEnv(), room._lastChatRow),
      abortController,
      mcpServers: input.prepared.claudeMcp,
      resumeSessionId: input.useResume ? room.claudeSessionId : '',
      chrome: await resolveChrome(input.mode),
    });
    const query = input.sdk.query({ prompt: await decorateHarnessPrompt(room, input.text, 'claude'), options });
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

  function resolveTurnStatus(
    mode: string,
    outcome: ClaudeTurnOutcome | null,
  ): { status: string; errorMessage: string; errorMessages: string[] } {
    if (room._planGuardTriggered) {
      const guardMessage = resolveReadOnlyGuardUserMessage(mode, room.delegationAssignment);
      return { status: 'plan_guard_cancelled', errorMessage: guardMessage, errorMessages: [guardMessage] };
    }
    if (room.cancelled) return { status: 'cancelled', errorMessage: '', errorMessages: [] };
    if (outcome && outcome.reason !== 'result') {
      const outcomeMessages = collectErrorMessages(
        outcome.error,
        room._lastSessionError,
        readLastClaudeStderrLine(room),
      );
      const errorMessage = withClaudeTrustHint(
        String(outcomeMessages[0] || 'Claude session ended unexpectedly.'),
        readClaudeStderrTail(room),
      );
      return {
        status: 'error',
        errorMessage,
        errorMessages: outcomeMessages.length ? outcomeMessages : [errorMessage],
      };
    }
    if (room._lastResult && room._lastResult.status === 'error') {
      // Keep both the normalized error and the raw result text: the provider
      // clock can live in either one while the other carries the generic text.
      const resultMessages = collectErrorMessages(
        room._lastResult.errorMessage,
        room._lastResult.resultText,
        room._lastApiError,
      );
      const errorMessage = String(resultMessages[0] || 'Claude run failed');
      return {
        status: 'error',
        errorMessage,
        errorMessages: resultMessages.length ? resultMessages : [errorMessage],
      };
    }
    if (room._lastApiError) {
      // The clock-less assistant error and the clock-bearing result prose can
      // arrive in the same run; forward both candidates instead of dropping the
      // result text.
      const apiMessages = collectErrorMessages(room._lastApiError, room._lastResult?.resultText);
      return {
        status: 'error',
        errorMessage: room._lastApiError,
        errorMessages: apiMessages.length ? apiMessages : [room._lastApiError],
      };
    }
    return { status: 'completed', errorMessage: '', errorMessages: [] };
  }

  function enqueuePrompt(text: string, modeOverride?: string, displayText = '', selection: unknown = null, origin?: Record<string, unknown>, requestId = ''): void {
    const uiText = resolvePromptUiText(text, displayText);
    const item: ClaudePromptItem = {
      text,
      mode: normalizeSdkMode(modeOverride || room.sdkMode),
    };
    if (uiText && uiText !== text) item.displayText = uiText;
    withSkillSelection(item, selection);
    if (origin) item.origin = origin;
    if (requestId) item.requestId = requestId;
    room.pendingPrompts.push(item);
    broadcast({ type: 'sdkQueued', text: uiText || text }, { log: false });
    sendRoomStateHook();
  }

  /**
   * Pushes a message into the running turn's input stream so Claude folds it in
   * between tool rounds. An undelivered steer is queued, never dropped.
   */
  function steerPrompt(
    text: string,
    modeOverride?: string,
    displayText = '',
    selection: unknown = null,
  ): 'delivered' | 'queued' | 'started' {
    const trimmed = String(text || '').trim();
    if (!trimmed) return 'queued';
    if (!room.busy) {
      void runPrompt(trimmed, modeOverride, false, displayText, false, selection);
      return 'started';
    }
    const uiText = resolvePromptUiText(trimmed, displayText);
    const runId = room.currentRun?.id || '';
    // A steer that asks for a skill must go through the full prompt builder: it
    // becomes an ordinary follow-up with the selection and keeps its text.
    if (selectionRequestsSkill(trimmed, selection)) {
      broadcast(buildSdkSteerAckPayload({ runId, outcome: STEER_ACK_REVERT, text: uiText || trimmed }));
      enqueuePrompt(trimmed, modeOverride, displayText, selection);
      recordSteerManifest({ chatId: room.chatId, transport: 'claude', text: trimmed, status: 'reverted_to_followup' });
      return 'queued';
    }
    const session = room._claudeSession;
    const turn = room._activeTurn;
    const uuid = randomUUID();
    let delivered = false;
    if (
      isClaudeSessionAlive(session)
      && turn && turn.session === session && turn.settled !== true
      && !room.cancelled
      && session.input && typeof session.input.push === 'function'
    ) {
      try {
        // The active turn already has its plan, rules, and skills context;
        // a mid-turn steer carries only the user's new text.
        delivered = session.input.push({
          ...buildClaudeUserMessage(room.claudeSessionId, trimmed),
          uuid,
        }) === true;
      } catch {
        delivered = false;
      }
    }
    if (delivered) {
      if (!(room._steerOutstanding instanceof Map)) room._steerOutstanding = new Map();
      const entry: { text: string; mode: string; displayText?: string; contextMessageId?: string } = { text: trimmed, mode: normalizeSdkMode(modeOverride || room.sdkMode), contextMessageId: uuid };
      if (uiText && uiText !== trimmed) entry.displayText = uiText;
      room._steerOutstanding.set(uuid, entry);
      persistEventHook({ kind: 'localUser', text: uiText || trimmed, contextMessageId: uuid }, true);
      broadcast({ type: 'sdkEvent', event: buildUserEvent(uiText || trimmed) });
      broadcast(buildSdkSteerAckPayload({ runId, outcome: STEER_ACK_DELIVERED, text: uiText || trimmed }));
      recordSteerManifest({ chatId: room.chatId, transport: 'claude', text: trimmed, status: 'delivered' });
      return 'delivered';
    }
    broadcast(buildSdkSteerAckPayload({ runId, outcome: STEER_ACK_REVERT, text: uiText || trimmed }));
    enqueuePrompt(trimmed, modeOverride, displayText, selection);
    recordSteerManifest({ chatId: room.chatId, transport: 'claude', text: trimmed, status: 'reverted_to_followup' });
    return 'queued';
  }

  function drainQueue(): void {
    drainOnePendingPrompt(room, (item: object) => {
      const next = item as ClaudePromptItem;
      void runPrompt(next.text, next.mode, true, next.displayText, next.alreadyPersisted === true, next.selection, next.origin, next.requestId, next.contextMessageId);
    });
  }

  /** Ends a run, whether it answered a prompt or followed up a background task. */
  function finalizeRun(input: {
    runId: string;
    status: string;
    errorMessage: string;
    errorMessages: string[];
    errorCode: string;
    streaming: boolean;
  }): void {
    const { runId, status, errorMessage, errorMessages, streaming } = input;
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
    const finished: Record<string, unknown> = {
      type: 'sdkRunFinished',
      runId,
      status,
      lastErrorMessage: errorMessage,
    };
    // All error variants of the run: the kernel's shared reset parser reads
    // them so a clock-bearing provider message is never shadowed by a
    // generic one. Only present when the run actually failed.
    if (errorMessages.length) finished.lastErrorMessages = errorMessages;
    const errorCode = input.errorCode
      || (errorMessage && status === 'error' ? 'claude_error' : '');
    if (errorCode) finished.lastErrorCode = errorCode;
    broadcast(finished);
    const backgroundTasks = countClaudeBackgroundTasks(room._claudeSession);
    if (backgroundTasks > 0) {
      notify({ noticeType: 'background_tasks', message: msg(null, 'claude.backgroundTasksRunning', { count: backgroundTasks }) }, runId);
    }
    if (streaming && status === 'completed') void publishClaudeContextBreakdown();
    if (errorMessage && status === 'error' && room._lastApiError !== errorMessage) {
      broadcast({
        type: 'sdkError',
        code: errorCode || 'claude_error',
        message: errorMessage,
      });
    }
    // An accepted run must leave a trace in the chat history. A turn that
    // settled without any answer event (for example a stale `result` of an
    // interrupted pre-restart turn that a resumed CLI session replays first)
    // would otherwise show only the user message and busy=false.
    if (status === 'completed' && room._turnContentSeen !== true) {
      broadcast({
        type: 'sdkError',
        code: 'claude_empty_turn',
        message: 'Claude finished the turn without producing any output. Send the message again.',
      });
    }
    sendRoomStateHook();
    flushHook();
    drainQueue();
  }

  /**
   * The model answers a finished background task on its own, outside any user
   * turn. Giving that answer a run of its own keeps it in the history, shows the
   * chat as busy and queues prompts sent meanwhile.
   *
   * Server-driven rooms are skipped: their run finish is a delegation or
   * Watcher report, and a second finish would report the same work twice.
   */
  function openFollowUpRun(session: ClaudeSession): ClaudeTurn | null {
    if (room.busy || room.cancelled || room.delegationId || room.delegationAssignment) return null;
    if (!canAcceptNewRun()) return null;
    // Sync stream path: it must not await (message order), so it uses the row the last prompt start read.
    const chatRow = room._lastChatRow || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'claude' };
    if (isWatcherOrchestratorChat(chatRow, room)) return null;
    clearClaudeSessionIdleTimer(session);
    room.busy = true;
    if (room.promptSuggestion) {
      room.promptSuggestion = null;
      broadcast({ type: 'promptSuggestion', chatId: room.chatId, text: '', turnRunId: '' });
    }
    room._planGuardTriggered = false;
    room._lastResult = null;
    room._lastApiError = '';
    room._claudeLastApiErrorMessage = '';
    room._lastSessionError = '';
    room._turnContentSeen = false;
    room._claudeNormalizer = createClaudeEventNormalizer();
    const runId = randomUUID();
    room.currentRun = { id: runId, startedAt: Date.now() };
    room._activeTurnRunId = runId;
    const mode = normalizeSdkMode(room.sdkMode);
    beginEnforcedSdkMode(room, mode);
    syncRoomDelegationAssignment(room);
    const turn: ClaudeTurn = {
      session,
      runId,
      settled: false,
      followUp: true,
      finish(outcome: ClaudeTurnOutcome = {}) {
        if (turn.settled) return;
        turn.settled = true;
        if (room._activeTurn === turn) room._activeTurn = null;
        clearInterruptFallback(room);
        if (!room._interruptInFlight) reclaimSteers(null);
        const resolved = resolveTurnStatus(mode, { reason: outcome.reason || 'result', error: outcome.error || '' });
        finalizeRun({ runId, ...resolved, errorCode: '', streaming: true });
      },
    };
    room._activeTurn = turn;
    broadcast({
      type: 'sdkPromptStarted',
      runId,
      text: '',
      followUp: true,
      fromQueue: false,
      remaining: room.pendingPrompts.length,
    });
    broadcast({ type: 'sdkBusy', busy: true }, { log: false });
    sendRoomStateHook();
    broadcast({ type: 'sdkRunProgress', runId, phase: 'stream', transport: 'claude' }, { log: false });
    return turn;
  }

  async function runPrompt(
    text: string,
    modeOverride?: string,
    fromQueue = false,
    displayText = '',
    alreadyPersisted = false,
    selection: unknown = null,
    origin?: Record<string, unknown>,
    requestId = '',
    contextMessageId = '',
  ): Promise<void> {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    const currentMessageId = contextMessageId || randomUUID();
    const uiText = resolvePromptUiText(trimmed, displayText);
    if (room.busy) {
      if (alreadyPersisted) {
        room.pendingPrompts.push(withSkillSelection({ text: trimmed, mode: normalizeSdkMode(modeOverride || room.sdkMode), displayText: uiText, alreadyPersisted: true, contextMessageId: currentMessageId, ...(origin ? { origin } : {}), ...(requestId ? { requestId } : {}) }, selection));
        broadcast({ type: 'sdkQueued', text: uiText }, { log: false });
        sendRoomStateHook();
      } else enqueuePrompt(trimmed, modeOverride, displayText, selection, origin, requestId);
      return;
    }
    if (!canAcceptNewRun()) {
      if (fromQueue === true) {
        room.pendingPrompts.unshift(withSkillSelection({
          text: trimmed,
          mode: normalizeSdkMode(modeOverride || room.sdkMode),
          ...(uiText && uiText !== trimmed ? { displayText: uiText } : {}),
          ...(alreadyPersisted ? { alreadyPersisted: true } : {}),
          ...(alreadyPersisted ? { contextMessageId: currentMessageId } : {}),
          ...(origin ? { origin } : {}),
          ...(requestId ? { requestId } : {}),
        }, selection));
        return;
      }
      broadcast({
        type: 'sdkError',
        code: 'update_in_progress',
        message: msg(null, 'update.notAcceptingRuns'),
      });
      return;
    }
    // Claim the room and mint the run id synchronously (acceptRoomPrompt reads
    // currentRun right after this call); only then await the archived-room read.
    room.busy = true;
    if (room.promptSuggestion) {
      room.promptSuggestion = null;
      broadcast({ type: 'promptSuggestion', chatId: room.chatId, text: '', turnRunId: '' });
    }
    setActiveSelection(room, selection);
    room.cancelled = false;
    room._planGuardTriggered = false;
    room._lastResult = null;
    room._lastApiError = '';
    room._claudeLastApiErrorMessage = '';
    room._lastSessionError = '';
    room._turnContentSeen = false;
    room._claudeNormalizer = createClaudeEventNormalizer();
    const runId = randomUUID();
    room.currentRun = { id: runId, startedAt: Date.now() };
    room._activeTurnRunId = runId;
    const mode = normalizeSdkMode(modeOverride || room.sdkMode);
    room.sdkMode = mode;
    beginEnforcedSdkMode(room, mode);
    syncRoomDelegationAssignment(room);
    // This await runs before the run's try/finally: release the claimed room on
    // every exit, including a storage error, or the chat stays busy for good.
    const releaseUnstartedRun = () => {
      room.busy = false;
      room.currentRun = null;
      room._activeTurnRunId = null;
      clearEnforcedSdkMode(room);
      sendRoomStateHook();
    };
    let archived = false;
    try {
      archived = await rejectArchivedRoomPromptAsync(room, (_room, payload) => broadcast(payload as Record<string, unknown>));
    } catch (error) {
      releaseUnstartedRun();
      broadcast({ type: 'sdkError', code: 'chat_lookup_failed', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (archived) {
      releaseUnstartedRun();
      return;
    }
    broadcast({
      type: 'sdkPromptStarted',
      runId,
      text: uiText,
      ...(origin ? { origin } : {}),
      requestId,
      fromQueue: fromQueue === true,
      remaining: room.pendingPrompts.length,
    });
    broadcast({ type: 'sdkBusy', busy: true }, { log: false });
    sendRoomStateHook();
    broadcast({
      type: 'sdkRunProgress',
      runId,
      phase: 'setup',
      transport: 'claude',
    }, { log: false });
    let status = 'completed';
    let errorMessage = '';
    let errorMessages: string[] = [];
    let mcpGateErrorCode = '';
    const streaming = streamingEnabled();
    let useResume = isResumableClaudeSessionId(room.claudeSessionId);
    let contextPrompt = trimmed;
    let contextDecisionMade = false;
    let userMessageRecorded = alreadyPersisted;
    const recordUserMessage = () => {
      if (userMessageRecorded) return;
      userMessageRecorded = true;
      persistEventHook({ kind: 'localUser', text: uiText, contextMessageId: currentMessageId, ...(origin ? { origin } : {}), ...(requestId ? { requestId } : {}), createdAt: new Date().toISOString() }, true);
      broadcast({ type: 'sdkEvent', event: { ...buildUserEvent(uiText), contextMessageId: currentMessageId } });
    };
    if (useResume) recordUserMessage();
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
      const prepared = await prepareMcp();
      const chatRow = (hooks.getChatRow ? await hooks.getChatRow() : await getChatByCursorSessionIdAsync(room.sessionKey)) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'claude' };
      room._lastChatRow = chatRow;
      const orchestrator = isWatcherOrchestratorChat(chatRow, room);
      // Streaming mode starts the Query process in `ensureSession`, so its gate
      // runs there (after the process exists, before the first prompt). The
      // legacy one-shot path sends the prompt together with the spawn, so it
      // verifies the managed bridge catalog up front instead.
      let oneShotBlock: Awaited<ReturnType<typeof enforceWatcherOrchestratorMcpGate>> | null = null;
      if (orchestrator && !streaming) {
        oneShotBlock = await enforceOneShotMcpGate({
          chat: chatRow,
          room,
          mcpPrep: prepared.mcpPrep,
          mcpContext: prepared.mcpContext,
          sessionStartedAt: room.currentRun.startedAt,
          bridgeStrategy: 'preflight',
        });
      }
      if (oneShotBlock) {
        recordUserMessage();
        mcpGateErrorCode = oneShotBlock.code;
        status = 'error';
        errorMessage = oneShotBlock.message;
        errorMessages = errorMessage ? [errorMessage] : [];
      } else {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        room._lastResult = null;
        room._turnContentSeen = false;
        room._lastApiError = '';
        room._claudeLastApiErrorMessage = '';
        room._claudeNormalizer = createClaudeEventNormalizer();
        room._activeTurnRunId = runId;
        status = 'completed';
        errorMessage = '';
        errorMessages = [];
        try {
          if (!useResume && !contextDecisionMade && !parseInheritedPrompt(trimmed).wrapped && !room._claudeSession?.input) {
            contextDecisionMade = true;
            let digest: ReturnType<typeof buildClaudeHistoryDigest> = null;
            let historyExisted = false;
            let complete = true;
            try {
              const flush = await Promise.race([
                flushHook(),
                new Promise<{ ok: false, pending: number, deadLettered: number }>((resolve) => setTimeout(() => resolve({ ok: false, pending: 1, deadLettered: 0 }), 2000)),
              ]) as { ok: boolean, pending: number, deadLettered: number };
              complete = flush?.ok === true && Number(flush.pending || 0) === 0 && Number(flush.deadLettered || 0) === 0;
              const page = await historyPageHook(room.chatId, { limit: 160 });
              let events = Array.isArray(page?.events) ? page.events : [];
              historyExisted = events.length > 0 || Number(page?.total || 0) > 0;
              const pending = Array.isArray(room._persistBuf) ? room._persistBuf : [];
              events = events.filter((row: any) => row?.rec?.contextMessageId !== currentMessageId);
              const buffered = pending.filter((row: any) => row?.rec?.contextMessageId !== currentMessageId);
              if (buffered.length) events = [...events, ...buffered.map((row: any) => ({ rec: row.rec }))];
              const planSummary = Array.isArray(chatRow?.summaries) ? chatRow.summaries.map((item: any) => item?.summary || '').filter(Boolean).join('\n') : '';
              digest = buildClaudeHistoryDigest(events, planSummary, currentMessageId);
            } catch {
              complete = false;
            }
            // Inject whenever the digest carries user/assistant text; the notice mirrors what actually happened.
            const injected = Boolean(digest?.text);
            if (injected && digest) contextPrompt = `${digest.text}\n\nCurrent request:\n${trimmed}`;
            if (injected || !complete || historyExisted) {
              const restored = injected && complete;
              try {
                await contextNoticeHook(room.chatId, restored ? 'Previous chat context restored.' : 'Previous chat context could not be restored.', {
                  variant: 'contextNotice', code: restored ? 'context_restored' : 'context_lost',
                  turns: restored ? (digest?.turns || 0) : 0, level: restored ? 'info' : 'warning',
                });
              } catch {
                // A notice write failure never prevents the requested turn.
              }
            }
          }
          if (!useResume) recordUserMessage();
          if (streaming) {
            const outcome = await runStreamingTurn({
              sdk,
              mode,
              model,
              effort,
              prepared,
              useResume,
              runId,
              text: contextPrompt,
              chatRow,
              mcpGate: orchestrator,
            });
            if (outcome?.code) {
              mcpGateErrorCode = outcome.code;
              status = 'error';
              errorMessage = outcome.error as string;
              errorMessages = errorMessage ? [errorMessage] : [];
              break;
            }
            ({ status, errorMessage, errorMessages = [] } = resolveTurnStatus(mode, outcome));
          } else {
            await runOneShotTurn({
              sdk,
              mode,
              model,
              effort,
              prepared,
              useResume,
              runId,
              text: contextPrompt,
            });
            ({ status, errorMessage, errorMessages = [] } = resolveTurnStatus(mode, null));
          }
        } catch (err) {
          if (room.cancelled || room._planGuardTriggered) {
            status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
            errorMessage = '';
            errorMessages = [];
          } else {
            status = 'error';
            errorMessage = (err as ErrorLike)?.message
              ? String((err as ErrorLike).message)
              : (err ? String(err) : readLastClaudeStderrLine(room));
            errorMessages = errorMessage ? [errorMessage] : [];
          }
        }
        const staleResume = shouldRetryClaudeRunWithoutResume({
          attempt,
          useResume,
          status,
          cancelled: room.cancelled,
          errorMessage,
        });
        if (!staleResume) {
          recordUserMessage();
          break;
        }
        // Drop the dead session id (and session) and retry once without resume.
        if (streaming) closeClaudeRoomSession(room, undefined);
        clearClaudeRoomSession(room);
        // The old transcript and its cache are gone: move the context epoch and
        // drop the last reading so the meter and cache tracker start cold.
        room._claudeContextObservation = null;
        recordContextRestart({ chatId: room.chatId, harness: 'claude', reason: CONTEXT_RESTART_REASON.SESSION_DROP, room });
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
      }
    } catch (err) {
      try {
        recordUserMessage();
      } catch {
        // Preserve the setup error while still attempting one user-message write.
      }
      const errCode = String((err as ErrorLike)?.code || '');
      if (isMcpOrchestratorErrorCode(errCode)) mcpGateErrorCode = errCode;
      if (room.cancelled || room._planGuardTriggered) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else {
        status = 'error';
        errorMessage = (err as ErrorLike)?.message
          ? String((err as ErrorLike).message)
          : (err ? String(err) : readLastClaudeStderrLine(room));
      }
    } finally {
      finalizeRun({ runId, status, errorMessage, errorMessages, errorCode: mcpGateErrorCode, streaming });
    }
  }

  /**
   * After a completed turn, attach the SDK's per-category context breakdown to
   * the last measured call. It reuses that call's `observedAt`, so the shared
   * context stream refines the sample instead of adding a second one.
   */
  async function publishClaudeContextBreakdown() {
    const query = room._claudeSession?.query;
    if (!room._claudeContextObservation || !query) return;
    let measured = await readClaudeContextBreakdown(query);
    // The control request can lose a race with the next queued turn; retry once.
    if (!measured) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      measured = await readClaudeContextBreakdown(room._claudeSession?.query);
    }
    // Always attach to the newest measured call: a late usage event may have replaced it.
    const observation = room._claudeContextObservation;
    if (!measured || !observation) return;
    broadcast({
      type: 'sdkContextUsage',
      ...observation,
      contextWindowTokens: measured.contextWindowTokens ?? observation.contextWindowTokens,
      breakdown: { ...measured.breakdown, observedAt: observation.observedAt },
    }, { log: false });
  }

  async function cancelCurrentRun(): Promise<void> {
    room.cancelled = true;
    await interruptActiveQuery(room);
  }

  if (!(room._steerOutstanding instanceof Map)) room._steerOutstanding = new Map();
  room._applySteerInterruptReceipt = applySteerInterruptReceipt;
  room.steerViaInput = true;
  return {
    startPrompt: runPrompt,
    cancelCurrentRun,
    drainQueue,
    enqueuePrompt,
    steerPrompt,
    applySteerInterruptReceipt,
  };
}

function bindClaudePromptRunner(room: ClaudeRoom, chat: object): void {
  void chat;
  const runner = createClaudePromptRunner({ room });
  room.startPrompt = runner.startPrompt;
  room.startPromptArgs = CLAUDE_START_PROMPT_ARGS;
  room.cancelCurrentRun = runner.cancelCurrentRun;
  room.drainQueue = runner.drainQueue;
  room.steerPrompt = runner.steerPrompt;
  // `queueSteer` control: inject an already queued prompt into the running turn.
  room.steerQueuedItem = (item: ClaudePromptItem) =>
    runner.steerPrompt(item.text, item.mode, item.displayText || '', item.selection ?? null);
  bindRoomRecoveryLifecycle({ room, chat, transport: 'claude' });
}

export async function ensureClaudeRoom(
  sessionKey: string,
  deps: {
    workspaceDirForAgent?: (p: string | null) => string;
    todoSyncDataDir?: string;
    delegationId?: string;
    attemptId?: string;
  } = {},
) {
  if (!isClaudeHarnessConfigured()) {
    const subscription = getClaudeAuthMode() === 'subscription';
    return {
      error: subscription
        ? 'Claude Code plan login is not available. Run claude login on this machine or set CLAUDE_CODE_OAUTH_TOKEN.'
        : 'Missing Anthropic API/provider credentials. Set ANTHROPIC_API_KEY or configure Bedrock, Vertex, or Foundry with your own provider credentials.',
      code: subscription ? 'missing_subscription' : 'missing_api_key',
    };
  }
  const chat = await getChatByCursorSessionIdAsync(sessionKey) as ClaudeChatRow | null;
  if (!chat) {
    return { error: 'Claude chat not found for this session.', code: 'chat_not_found' };
  }
  if (!isClaudeChat(chat)) {
    return { error: 'Claude chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
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
      _steerOutstanding: new Map(),
      _interruptInFlight: false,
      _interruptFallbackTimer: null,
      _interruptFallbackRunId: '',
      _lastResult: null,
      promptSuggestion: null,
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
  await bindRoomToDelegation(room, deps);
  stampWatcherOrchestratorRoom(room, chat, deps);
  bindClaudePromptRunner(room, chat);
  return { room, chat };
}

export async function handleClaudeAgentWebSocket(
  ws: import('ws').WebSocket,
  sessionKey: string,
  deps: { workspaceDirForAgent: (p: string | null) => string; todoSyncDataDir?: string },
): Promise<void> {
  const ensured = await ensureClaudeRoom(sessionKey, deps);
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
    queuedPrompts: room.pendingPrompts.map((item: ClaudePromptItem) => resolveQueuedPromptUiText(item)),
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  sendRoomState(room);
  scheduleEventLogReplay(room, ws);

  ws.on('message', (raw: Buffer) => {
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
      applySdkModeIfChanged(room, msg.mode, { chatId: chat.id, updateChat: updateChatAsync });
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void room.startPrompt(msg.text, msg.mode, false, readClientDisplayText(msg), false, readClientSkillSelection(msg));
      return;
    }
    if (msg.type === 'steer' && typeof msg.text === 'string') {
      room.steerPrompt(msg.text, msg.mode, readClientDisplayText(msg), readClientSkillSelection(msg));
      return;
    }
    if (msg.type === 'opencodeQuestionReply' && typeof msg.requestId === 'string') {
      handleClaudeOpenCodeQuestionReply(room, ws, msg);
      return;
    }
    if (msg.type === 'opencodePermissionReply' && typeof msg.requestId === 'string') {
      handleClaudePermissionReply(room, ws, msg);
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
 * Live streaming query of a chat's room, used for read-only control requests.
 */
export function getClaudeRoomQuery(sessionKey: string): ClaudeQuery | null {
  const session = claudeRooms.get(sessionKey)?._claudeSession;
  return session && session.alive === true ? session.query : null;
}

export function getClaudeRoomDiag(sessionKey: string): Record<string, unknown> | null {
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
