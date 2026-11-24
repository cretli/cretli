import { externalizeToolResultImages, chatMediaSaver } from '../agent-harness/tool-result-images.ts';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { CodexAppServer, CODEX_APP_SERVER_REQUEST_TIMEOUT_MS, isCodexAppServerEnabled, isMissingCodexRolloutError, runCodexAppServerTurn } from './codex-app-server.ts';
import { createCodexSteering, resolveCodexPromptKind } from './codex-steer.ts';
import {
  setActiveSelection,
  readClientSkillSelection,
  withSkillSelection,
} from '../skills/skill-selection.js';
import { recordSteerManifest } from '../context/context-send-manifest.ts';
/**
 * WebSocket rooms for the Codex SDK — SDK-compatible event protocol.
 */

import { randomUUID } from 'crypto';
import type { CodexOptions } from '@openai/codex-sdk';
import { rejectArchivedRoomPromptAsync } from '../chat-message-guard.js';
import {
  getChatByCursorSessionIdAsync,
  setChatCodexThreadIdAsync,
  updateChatAsync,
} from '../persist/chats-persist.js';
import { runChatWrite } from '../chat-write-async.js';
import { resolveExecutionFolderForChat } from '../execution-folder.js';
import { beginEnforcedSdkMode, clearEnforcedSdkMode, normalizeSdkMode, readEnforcedSdkMode } from '../sdk/sdk-mode.ts';
import { buildAgentHelloPayload } from '../sdk/sdk-ws-handshake.ts';
import { sendSdkChatNotFoundAndClose } from '../sdk/sdk-ws-chat-gone.ts';
import { buildUserEvent } from '../agent-harness/event-normalizer.ts';
import {
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { handleQueueControlMessage } from '../agent-harness/queue-controls.ts';
import { normalizeCodexThreadEvent } from '../agent-harness/codex-event-normalizer.ts';
import { createAgentRoomKernel } from '../agent-harness/room-kernel.ts';
import { isCodexChat } from '../agent-transport.js';
import { decorateHarnessPrompt } from '../sdk/harness-plan-prompt.ts';
import {
  getSdkToolCallName,
  resolvePlanModeSdkEventDecision,
  resolveReadOnlyGuardUserMessage,
} from '../sdk/sdk-plan-guard.ts';
import { resolvePlanGuardMcpServerIdentity } from '../mcp/mcp-session.js';
import { SCOUT_READ_ONLY_MESSAGE, isScoutReadOnlyChatId } from '../workspace-scout-chat.js';
import { bindHarnessPlanSync } from '../sdk/harness-plan-sync.ts';
import { bindRoomToDelegation, noteDelegationRoomEvent, syncRoomDelegationAssignment } from '../delegation-run-bridge.js';
import { confirmDelegationReportsFromRoom } from '../delegation-report-context.js';
import { bindRoomRecoveryLifecycle, registerKernelChatRunAdapter } from '../chat-run/kernel-adapter.ts';
import { trackSdkRoomRunOutcome } from '../sdk/sdk-run-outcome.ts';
import { hasCodexCredentials } from './codex-credentials.ts';
import { isCodexCliFound, getCodexCliMissingHint } from './codex-cli.ts';
import { loadCodexSdk } from './codex-sdk.ts';
import { resolveDefaultCodexModel } from './codex-models.ts';
import { buildCodexClientOptions } from './codex-thread-options.ts';
import { resolveDelegationEnv } from '../delegation-settings.js';
import {
  buildCodexReviewGuardResumePrompt,
  buildReviewGuardExhaustedMessage,
  canResumeCodexReviewAfterGuard,
  CODEX_REVIEW_GUARD_EXHAUSTED_CODE,
  describeDeniedGuardTool,
  CODEX_REVIEW_GUARD_RESUME_DISPLAY,
} from './codex-review-guard-resume.ts';
import { CODEX_SERVER_SHUTDOWN_MESSAGE, formatCodexExecFailure } from './codex-exec-error.ts';
import { buildCodexGuardEvents } from './codex-guard-events.ts';
import { buildCodexCompactionEvent, watchCodexContextUsage } from './codex-context-usage.ts';
import { advanceRoomContextEpoch } from '../usage/context-restarts.ts';
import { ensureCodexHomeDir } from './codex-home.ts';
import { buildMcpRuntimeContext, markMcpConfigApplied, prepareHarnessMcp } from '../mcp/mcp-session.js';
import { CONTEXT_RESTART_REASON, recordContextRestart } from '../usage/context-restarts.ts';
import {
  enforceWatcherOrchestratorMcpGate,
  isMcpOrchestratorErrorCode,
  stampWatcherOrchestratorRoom,
} from '../mcp/watcher-orchestrator-mcp-gate.js';
import { toCodexMcpServers } from '../mcp/mcp-vendor-map.js';
import { drainOnePendingPrompt } from '../agent-harness/pending-prompt-drain.ts';
import { registerMcpOwnerSource } from '../mcp/mcp-owner-registry.js';
import { registerPendingPromptRoomSource } from '../agent-harness/pending-prompt-resume.ts';
import { canAcceptNewRun, isServerShuttingDown } from '../update-gate.js';
import { msg } from '../messages.js';

/** Chat row as this harness reads it (the persist layer only documents the base fields). */
type CodexChatRow = NonNullable<Awaited<ReturnType<typeof getChatByCursorSessionIdAsync>>> & {
  agentTransport?: string;
  sdkMode?: string;
  codexThreadId?: unknown;
};

/**
 * A usage reading that follows a `compacted` rollout record carries `compactedAt`.
 * Bump the epoch once per compaction, ignoring ones replayed from before this run.
 */
export function isNewCodexCompaction(room: any, event: { compactedAt?: string } | null | undefined): boolean {
  const compactedAt = event?.compactedAt;
  if (!compactedAt || room._codexCompactedAt === compactedAt) return false;
  const compactedMs = Date.parse(compactedAt);
  if (Number.isFinite(compactedMs) && Number.isFinite(room._runStartedAt) && compactedMs < room._runStartedAt) return false;
  room._codexCompactedAt = compactedAt;
  // The app-server's native `thread/compacted` signal already counted this compaction.
  if (Number.isFinite(compactedMs) && Number.isFinite(room._codexLastCompactionMs)
    && Math.abs(compactedMs - room._codexLastCompactionMs) < CODEX_COMPACTION_DEDUPE_MS) return false;
  return true;
}

/**
 * The saved thread has no rollout any more: forget it so the chat continues on
 * a fresh thread, invalidate the old context and tell the user why.
 */
function dropMissingCodexThread(room: any): void {
  if (!room?.codexThreadId) return;
  room.codexThreadId = '';
  if (room.chatId) runChatWrite('setChatCodexThreadId', () => setChatCodexThreadIdAsync(room.chatId, ''), room.chatId);
  recordContextRestart({ chatId: room.chatId, harness: 'codex', reason: CONTEXT_RESTART_REASON.SESSION_DROP, room });
  broadcastRoom(room, { type: 'sdkEvent', event: buildCodexCompactionEvent(new Date().toISOString()) });
  broadcastRoom(room, { type: 'sdkEvent', event: {
    kind: 'notice', noticeType: 'session_drop',
    message: 'Codex no longer has the saved thread of this chat; continuing in a new thread without the earlier messages.',
  } });
}

/**
 * Abort the in-flight `codex exec` turn.
 */
function abortCurrentTurn(room: any) {
  if (room?._appServer) {
    const client = room._appServer;
    room._codexSteering?.cancel();
    void client.interrupt().catch(() => client.close());
    return;
  }
  const abort = room?._abort;
  if (room) room._abort = null;
  if (!abort || typeof abort.abort !== 'function') return;
  try {
    abort.abort();
  } catch {
    // ignore abort failures
  }
}

function abortCodexRoom(room: any): void {
  if (room) room.cancelled = true;
  abortCurrentTurn(room);
}

const kernel = createAgentRoomKernel({
  transport: 'codex',
  logLabel: 'codex-ws',
  goneMessage: 'Codex chat not found for this session.',
  abortRoom: abortCodexRoom,
  afterBroadcast(room, payload) {
    trackSdkRoomRunOutcome(room, payload);
    noteDelegationRoomEvent(room, payload);
  },
});
const codexRooms = kernel.rooms;
registerPendingPromptRoomSource(() => codexRooms.values());
registerMcpOwnerSource('codex', () => codexRooms.entries());
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

export function disposeCodexRoom(sessionKey: string) {
  kernel.disposeRoom(sessionKey);
}

export function syncCodexRoomModelFromChat(sessionKey: string, model: string) {
  const room = codexRooms.get(sessionKey);
  if (!room) return;
  const nextModel = String(model || '').trim();
  if (!nextModel || nextModel === room.modelId) return;
  room.modelId = nextModel;
}

/** Two compaction signals (rollout log and native notification) closer than this are one compaction. */
const CODEX_COMPACTION_DEDUPE_MS = 10000;

/**
 * Emits the compaction reset exactly as the rollout watcher does: advance the
 * context epoch and broadcast `context_usage { reset }`. Returns false for a duplicate signal.
 */
function emitCodexCompaction(room: any, observedAt: string | null): boolean {
  const observedMs = Date.parse(String(observedAt || ''));
  const atMs = Number.isFinite(observedMs) ? observedMs : Date.now();
  if (Number.isFinite(room._codexLastCompactionMs) && Math.abs(atMs - room._codexLastCompactionMs) < CODEX_COMPACTION_DEDUPE_MS) return false;
  room._codexLastCompactionMs = atMs;
  const event = buildCodexCompactionEvent(observedAt);
  room._codexCompactedAt = observedAt || room._codexCompactedAt;
  advanceRoomContextEpoch(room, 'compaction');
  broadcastRoom(room, { type: 'sdkEvent', event });
  return true;
}

/** Exported for tests: the production handler for SDK and app-server thread events. */
export function handleThreadEvent(room: any, event: unknown): void {
  const items = normalizeCodexThreadEvent(externalizeToolResultImages(event, chatMediaSaver(room.chatId)));
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'thread' && typeof item.threadId === 'string' && item.threadId) {
      room.codexThreadId = item.threadId;
      if (room.chatId) runChatWrite('setChatCodexThreadId', () => setChatCodexThreadIdAsync(room.chatId, item.threadId), room.chatId);
      continue;
    }
    if (item.kind === 'turn') {
      if (typeof item.threadId === 'string' && item.threadId) {
        room.codexThreadId = item.threadId;
        if (room.chatId) runChatWrite('setChatCodexThreadId', () => setChatCodexThreadIdAsync(room.chatId, item.threadId), room.chatId);
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
    if (item.kind === 'usage') {
      broadcastRoom(room, {
        type: 'sdkEvent',
        event: { type: 'usage', usage: item.usage, final: true },
      });
      continue;
    }
    const mode = readEnforcedSdkMode(room);
    const assignment = room.delegationAssignment;
    const scoutReadOnly = isScoutReadOnlyChatId(room?.chatId);
    const decision = resolvePlanModeSdkEventDecision({
      transport: 'codex',
      mode,
      assignment,
      event: item,
      scoutReadOnly,
      projectRoot: room.cwd,
      mcpServer: resolvePlanGuardMcpServerIdentity({ room, harness: 'codex', event: item }),
    });
    if (decision.deny) {
      const message = scoutReadOnly ? SCOUT_READ_ONLY_MESSAGE : resolveReadOnlyGuardUserMessage(mode, assignment);
      for (const blockedEvent of buildCodexGuardEvents(item, message)) {
        broadcastRoom(room, { type: 'sdkEvent', event: blockedEvent });
      }
    }
    if (decision.notify) {
      broadcastRoom(room, {
        type: 'sdkPlanGuard',
        message: scoutReadOnly ? SCOUT_READ_ONLY_MESSAGE : resolveReadOnlyGuardUserMessage(mode, assignment),
        toolName: getSdkToolCallName(item) || 'unknown',
      });
    }
    if (decision.abortRun) {
      room.cancelled = true;
      room._planGuardTriggered = true;
      room._codexReviewGuardResume = canResumeCodexReviewAfterGuard({
        assignment: room.delegationAssignment,
        resumesUsed: room._codexReviewGuardResumes,
      });
      room._codexReviewGuardDenied = describeDeniedGuardTool(item);
      abortCurrentTurn(room);
      continue;
    }
    if (decision.deny) continue;
    broadcastRoom(room, { type: 'sdkEvent', event: item });
  }
}


function bindCodexPromptRunner(room: any, chat: object | null): void {
  void chat;
  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
  function enqueuePrompt(text: string, modeOverride?: string, displayText: string = '', selection: unknown = null, origin?: Record<string, unknown>, requestId = ''): void {
    const uiText = resolvePromptUiText(text, displayText);
    const item: { text: string; mode: ReturnType<typeof normalizeSdkMode>; displayText?: string; origin?: Record<string, unknown>; requestId?: string } = {
      text,
      mode: normalizeSdkMode(modeOverride || room.sdkMode),
    };
    if (uiText && uiText !== text) item.displayText = uiText;
    withSkillSelection(item, selection);
    if (origin) item.origin = origin;
    if (requestId) item.requestId = requestId;
    room.pendingPrompts.push(item);
    broadcastRoom(room, { type: 'sdkQueued', text: uiText || text }, { log: false });
    sendRoomState(room);
  }

  /**
   * Queue the read-only follow-up ahead of anything the user already queued.
   * Sets the defer flag before `sdkRunFinished` so the review job stays open.
   */
  function queueReviewGuardResume(): boolean {
    const used = Number(room._codexReviewGuardResumes) || 0;
    if (!canResumeCodexReviewAfterGuard({
      assignment: room.delegationAssignment,
      resumesUsed: used,
    })) {
      return false;
    }
    room._codexReviewGuardResumes = used + 1;
    room._codexReviewGuardResumeQueued = true;
    const text = buildCodexReviewGuardResumePrompt();
    if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
    room.pendingPrompts.unshift({
      text,
      mode: normalizeSdkMode(room.sdkMode),
      displayText: CODEX_REVIEW_GUARD_RESUME_DISPLAY,
    });
    broadcastRoom(room, {
      type: 'sdkQueued',
      text: CODEX_REVIEW_GUARD_RESUME_DISPLAY,
    }, { log: false });
    sendRoomState(room);
    return true;
  }

  function drainQueue(): void {
    drainOnePendingPrompt(room, (item: object) => {
      const next = item as { text: string; mode: string; displayText?: string; selection?: unknown; origin?: Record<string, unknown>; requestId?: string };
      void runPrompt(next.text, next.mode, true, next.displayText, next.selection, next.origin, next.requestId);
    });
  }

  async function runPrompt(text: string, modeOverride?: string, fromQueue: boolean = false, displayText: string = '', selection: unknown = null, origin?: Record<string, unknown>, requestId = ''): Promise<void> {
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
      enqueuePrompt(trimmed, modeOverride, displayText, selection, origin, requestId);
      return;
    }
    if (!canAcceptNewRun()) {
      if (fromQueue === true) {
        room.pendingPrompts.unshift(withSkillSelection({
          text: trimmed,
          mode: normalizeSdkMode(modeOverride || room.sdkMode),
          ...(uiText && uiText !== trimmed ? { displayText: uiText } : {}),
          ...(origin ? { origin } : {}),
          ...(requestId ? { requestId } : {}),
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
    room._turnError = '';
    room._planGuardTriggered = false;
    room._codexReviewGuardResume = false;
    room._codexReviewGuardResumeQueued = false;
    if (fromQueue !== true) room._codexReviewGuardResumes = 0;
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
      ...(origin ? { origin } : {}),
      requestId,
      fromQueue: fromQueue === true,
      remaining: room.pendingPrompts.length,
    });
    broadcastRoom(room, { type: 'sdkBusy', busy: true }, { log: false });
    sendRoomState(room);
    persistRoomEvent(room, { kind: 'localUser', text: uiText, ...(origin ? { origin } : {}), ...(requestId ? { requestId } : {}), createdAt: new Date().toISOString() }, true);
    broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(uiText) });
    broadcastRoom(room, {
      type: 'sdkRunProgress',
      runId,
      phase: 'setup',
      transport: 'codex',
    }, { log: false });
    let status = 'completed';
    let errorMessage = '';
    let mcpGateErrorCode = '';
    const abort = new AbortController();
    room._abort = abort;
    let contextWatcher: ReturnType<typeof watchCodexContextUsage> | undefined;
    try {
      const useAppServer = isCodexAppServerEnabled();
      const sdk = useAppServer ? null : await loadCodexSdk();
      const Codex = sdk?.Codex;
      if (!useAppServer && typeof Codex !== 'function') {
        throw new Error('Codex export is missing from @openai/codex-sdk.');
      }
      const chatRow = await getChatByCursorSessionIdAsync(room.sessionKey) || { id: room.chatId, workspaceFolder: room.cwd, agentTransport: 'codex' };
      const clientOptions = buildCodexClientOptions({
        // The Codex adapter and assertReviewAdapterAllowed must read the same
        // resolved delegation env so sandbox and certification cannot disagree.
        env: resolveDelegationEnv(chatRow.workspaceFolder || room.cwd),
        cwd: room.cwd,
        model: room.modelId,
        sdkMode: room.sdkMode,
        scoutReadOnly: isScoutReadOnlyChatId(room?.chatId),
        reviewReadOnly: room.delegationAssignment === 'review',
      });
      const mcpContext = buildMcpRuntimeContext({
        chat: chatRow,
        room,
        harness: 'codex',
        mode: room.sdkMode,
      });
      const mcpPrep = prepareHarnessMcp(mcpContext);
      const mcpServers = toCodexMcpServers(mcpPrep.mcpServers);
      // A new Codex client is built per run; only an MCP revision or tool
      // order/content change alters the tools prefix, so record just those.
      const mcpToolNames = Object.keys(mcpServers).join(',');
      if (room._codexMcpRevision !== undefined && room._codexMcpRevision !== mcpPrep.revision) {
        recordContextRestart({
          chatId: room.chatId,
          harness: 'codex',
          reason: CONTEXT_RESTART_REASON.MCP_REVISION,
          room,
        });
      } else if (room._codexMcpToolNames !== undefined && room._codexMcpToolNames !== mcpToolNames) {
        recordContextRestart({
          chatId: room.chatId,
          harness: 'codex',
          reason: CONTEXT_RESTART_REASON.MCP_CONTENT_CHANGE,
          room,
        });
      }
      room._codexMcpRevision = mcpPrep.revision;
      room._codexMcpToolNames = mcpToolNames;
      const ctor: CodexOptions & { env: Record<string, string> } = {
        env: clientOptions.env,
        codexPathOverride: clientOptions.codexPathOverride,
      };
      if (clientOptions.apiKey) ctor.apiKey = clientOptions.apiKey;
      ctor.config = {
        ...clientOptions.config,
        show_raw_agent_reasoning: true,
        ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers as NonNullable<CodexOptions['config']> } : {}),
      };
      const codex = useAppServer ? null : new Codex!(ctor);
      markMcpConfigApplied(mcpContext, mcpPrep.servers, mcpPrep.revision);
      const thread = useAppServer ? null : room.codexThreadId
        ? codex!.resumeThread(room.codexThreadId, clientOptions.threadOptions)
        : codex!.startThread(clientOptions.threadOptions);
      // The Codex SDK spawns its CLI only inside `runStreamed` (with the first
      // prompt), so the bridge mark cannot exist before the gate. Probe the
      // managed bridge catalog directly instead of waiting for a mark that can
      // never arrive in time.
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
      broadcastRoom(room, {
        type: 'sdkRunProgress',
        runId,
        phase: 'stream',
        transport: 'codex',
      }, { log: false });
      confirmDelegationReportsFromRoom(room);
      contextWatcher = watchCodexContextUsage({
        homeDir: ensureCodexHomeDir(),
        getThreadId: () => room.codexThreadId,
        getModel: () => room.modelId,
        onUsage: (event) => {
          const signature = JSON.stringify(event);
          if (room._codexContextSignature === signature) return;
          room._codexContextSignature = signature;
          if (event.reset) {
            // A compaction that ended the previous run (e.g. read after a server restart) is old news.
            const resetMs = Date.parse(String(event.observedAt || ''));
            if (Number.isFinite(resetMs) && Number.isFinite(room._runStartedAt) && resetMs < room._runStartedAt) return;
            emitCodexCompaction(room, event.observedAt);
            return;
          }
          // Reset the meter as well: the exec path may only show the compaction on the next reading.
          if (isNewCodexCompaction(room, event)) emitCodexCompaction(room, event.compactedAt ?? null);
          broadcastRoom(room, { type: 'sdkEvent', event });
        },
      });
      if (useAppServer) {
        const client = new CodexAppServer({ cli: clientOptions.codexPathOverride, env: clientOptions.env, apiKey: clientOptions.apiKey,
          // Explicit so a hung app-server rejects pending RPCs instead of stalling the turn.
          requestTimeoutMs: CODEX_APP_SERVER_REQUEST_TIMEOUT_MS });
        room._appServer = client;
        room._codexSteering = createSteering();
        const threadId = await client.initialize(clientOptions.threadOptions, room.codexThreadId, ctor.config, {
          onResumeMissing: () => dropMissingCodexThread(room),
        });
        handleThreadEvent(room, { type: 'thread.started', thread_id: threadId });
        // Raw diagnostics for missing bridge tools (e.g. todo_show) in read-only review sessions; names only, no secrets.
        console.info(`[codex-ws] thread ${threadId} started; configured MCP servers: ${room._codexMcpToolNames || '(none)'}`);
        let toolSearchCalls = 0;
        if (room.cancelled) throw new Error('Run cancelled during setup');
        await runCodexAppServerTurn(client, await decorateHarnessPrompt(room, trimmed, 'codex'), {
          observe: (notification) => {
            const item = (notification as any)?.params?.item;
            if (item && /tool_?search/i.test(String(item.tool ?? item.name ?? item.type ?? ''))) {
              toolSearchCalls += 1;
              console.info(`[codex-ws] thread ${threadId} model called tool_search (#${toolSearchCalls})`);
            }
            return room._codexSteering.observe(notification);
          },
          onCompaction: () => emitCodexCompaction(room, new Date().toISOString()),
          // Native token usage becomes the SDK `turn.completed` usage, so it reaches the same ledger path.
          onEvent: (event) => {
            handleThreadEvent(room, event);
            contextWatcher?.poll();
          },
        });
      } else {
      const streamed = await thread!.runStreamed(await decorateHarnessPrompt(room, trimmed, 'codex'), {
        signal: abort.signal,
      });
      for await (const event of streamed.events) {
        if (room.cancelled) break;
        handleThreadEvent(room, event);
        contextWatcher?.poll();
      }
      if (typeof thread!.id === 'string' && thread!.id.trim()) {
        room.codexThreadId = thread!.id.trim();
        if (room.chatId) runChatWrite('setChatCodexThreadId', () => setChatCodexThreadIdAsync(room.chatId, room.codexThreadId), room.chatId);
      }
      }
      if (room.cancelled) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else if (room._turnError) {
        status = 'error';
        errorMessage = describeCodexRunFailure(room._turnError, room._turnError);
      }
      }
    } catch (err) {
      const failure = err as { code?: unknown; message?: unknown } | null;
      const errCode = String(failure?.code || '');
      if (isMcpOrchestratorErrorCode(errCode)) mcpGateErrorCode = errCode;
      // `codex exec resume` cannot fall back in place; the next prompt starts a new thread.
      if (isMissingCodexRolloutError(err)) dropMissingCodexThread(room);
      if (room.cancelled) {
        status = room._planGuardTriggered ? 'plan_guard_cancelled' : 'cancelled';
      } else {
        status = 'error';
        errorMessage = describeCodexRunFailure(failure?.message ? String(failure.message) : String(err), room._turnError);
      }
    } finally {
      contextWatcher?.stop();
      room._appServer?.close();
      await Promise.allSettled(room._codexSteerRequests || []);
      room._appServer = null;
      room._codexSteering = null;
      if (room._abort === abort) room._abort = null;
      if (status === 'plan_guard_cancelled' && room._codexReviewGuardResume === true) {
        queueReviewGuardResume();
      }
      // Resumes exhausted on a read-only review: surface an explicit cause
      // instead of an anonymous `cancelled`.
      const guardExhausted = status === 'plan_guard_cancelled'
        && room._codexReviewGuardResume !== true
        && isReviewReadOnlyAssignment(room.delegationAssignment);
      room._codexReviewGuardResume = false;
      room.busy = false;
      room.currentRun = null;
      clearEnforcedSdkMode(room);
      broadcastRoom(room, { type: 'sdkBusy', busy: false }, { log: false });
      const finished: { type: string; runId: string; status: string; lastErrorMessage: string; lastErrorCode?: string } = {
        type: 'sdkRunFinished',
        runId,
        status: guardExhausted ? 'error' : status,
        lastErrorMessage: guardExhausted ? buildReviewGuardExhaustedMessage(room._codexReviewGuardDenied) : errorMessage,
      };
      const errorCode = guardExhausted ? CODEX_REVIEW_GUARD_EXHAUSTED_CODE : mcpGateErrorCode
        || (errorMessage && status === 'error' ? 'codex_error' : '');
      if (errorCode) finished.lastErrorCode = errorCode;
      broadcastRoom(room, finished);
      if (errorMessage && status === 'error' && !guardExhausted) {
        broadcastRoom(room, {
          type: 'sdkError',
          code: errorCode || 'codex_error',
          message: errorMessage,
        });
      }
      sendRoomState(room);
      flushPersistBuffer(room);
      drainQueue();
    }
  }


  /**
   * User-facing error for a failed run. The raw CLI text is logged because the
   * formatted message can hide it (stdin banner noise, killed process).
   */
  function describeCodexRunFailure(execMessage: string, turnError: unknown): string {
    const raw = String(execMessage || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const shuttingDown = isServerShuttingDown();
    console.warn(`[codex-ws] run failed chat=${room.chatId || '-'} thread=${room.codexThreadId || '-'} model=${room.modelId || '-'} shuttingDown=${shuttingDown} raw=${raw || '(empty)'}`);
    // A child killed by our own shutdown says nothing about the model or the
    // account; a provider-flavoured message here would record a lockout.
    if (shuttingDown) return CODEX_SERVER_SHUTDOWN_MESSAGE;
    return formatCodexExecFailure({
      execMessage,
      turnError: turnError as string,
      threadId: room.codexThreadId,
      homeDir: ensureCodexHomeDir(),
    });
  }

  room.steerViaInput = isCodexAppServerEnabled();
  room.steerPrompt = (text: string, mode?: string, displayText?: string, selection: unknown = null) => {
    // A turn may finish while the client's steer frame is in flight.
    if (!room.busy) return runPrompt(text, mode, false, displayText, selection);
    if (!room._codexSteering) {
      room._codexSteering = createSteering();
    }
    const request = room._codexSteering.steer(text, mode, displayText, selection);
    if (!room._codexSteerRequests) room._codexSteerRequests = new Set();
    room._codexSteerRequests.add(request);
    void request.finally(() => room._codexSteerRequests.delete(request));
    return request;
  };
  // `queueSteer` control: inject an already queued prompt (app-server only).
  room.steerQueuedItem = room.steerViaInput
    ? (item: { text: string; mode?: string; displayText?: string; selection?: unknown }) =>
      room.steerPrompt(item.text, item.mode, item.displayText || '', item.selection ?? null)
    : null;
  function createSteering() {
    return createCodexSteering({
      room, enqueue: enqueuePrompt,
      recordSteer: ({ status, text }) => recordSteerManifest({ chatId: room.chatId, transport: 'codex', text, status }),
      broadcast: (payload) => broadcastRoom(room, payload),
      delivered: (text) => {
        persistRoomEvent(room, { kind: 'localUser', text }, true);
        broadcastRoom(room, { type: 'sdkEvent', event: buildUserEvent(text) });
      },
    });
  }
  async function cancelCurrentRun() {
    room.cancelled = true;
    abortCurrentTurn(room);
  }
  room.startPrompt = runPrompt;
  room.drainQueue = drainQueue;
  room.cancelCurrentRun = cancelCurrentRun;
  // The callee documents `chat: object`; the row can be gone by now, as in the JS original.
  bindRoomRecoveryLifecycle({ room, chat: chat as object, transport: 'codex' });
}


export async function ensureCodexRoom(sessionKey: string, deps: { workspaceDirForAgent?: (workspacePath: string | null) => string, todoSyncDataDir?: string, delegationId?: string, attemptId?: string } = {}) {
  if (!hasCodexCredentials()) {
    return {
      error: 'Codex is not signed in. Use Settings → Harness → Codex (ChatGPT plan or API key).',
      code: 'missing_api_key',
    };
  }
  if (!isCodexCliFound()) {
    return {
      error: getCodexCliMissingHint(),
      code: 'missing_cli',
    };
  }
  const chat = await getChatByCursorSessionIdAsync(sessionKey) as CodexChatRow | null;
  if (!chat) {
    return { error: 'Codex chat not found for this session.', code: 'chat_not_found' };
  }
  if (!isCodexChat(chat)) {
    return { error: 'Codex chat not found for this session.', code: 'invalid_session' };
  }
  const cwd = resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    return { error: 'Missing workspace directory.', code: 'no_cwd' };
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
  await bindRoomToDelegation(room, deps);
  stampWatcherOrchestratorRoom(room, chat, deps);
  bindCodexPromptRunner(room, chat);
  return { room, chat };
}

export async function handleCodexAgentWebSocket(ws: import('ws').WebSocket, sessionKey: string, deps: { workspaceDirForAgent: (p: string | null) => string, todoSyncDataDir?: string }) {
  const ensured = await ensureCodexRoom(sessionKey, deps);
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
    transport: 'codex',
    sessionKey,
    modelId: room.modelId,
    sdkMode: room.sdkMode,
    eventStreamId: room.eventStreamId,
    busy: !!room.busy,
    queuedPrompts: room.pendingPrompts.map((item: { text?: unknown; displayText?: unknown }) => resolveQueuedPromptUiText(item)),
  });
  if (ws.readyState === 1) ws.send(JSON.stringify(hello));
  sendRoomState(room);
  scheduleEventLogReplay(room, ws);

  ws.on('message', (raw) => {
    let msg: { type?: unknown; text?: unknown; mode?: unknown; [key: string]: unknown } | null;
    try {
      msg = JSON.parse(Buffer.from(raw as Buffer).toString('utf8'));
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
    const promptKind = typeof msg.text === 'string' ? resolveCodexPromptKind(msg.type, isCodexAppServerEnabled()) : null;
    if (promptKind === 'steer') {
      void room.steerPrompt(msg.text, msg.mode, readClientDisplayText(msg), readClientSkillSelection(msg));
      return;
    }
    // With the app-server disabled, a steer message degrades to a normal send (no steer state).
    if (promptKind === 'send') {
      void room.startPrompt(msg.text, msg.mode, false, readClientDisplayText(msg), readClientSkillSelection(msg));
    }
  });

  ws.on('close', () => {
    detachClient(room, ws, sessionKey);
  });
}

registerKernelChatRunAdapter({
  transport: 'codex',
  rooms: codexRooms,
  ensureRoom: ensureCodexRoom,
});

export function getCodexRoomDiag(sessionKey: string): Record<string, unknown> | null {
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
