/**
 * Shared WebSocket room helpers for agent harnesses (broadcast, event log,
 * persist buffer, empty-room grace shutdown, replay, heartbeat).
 */

import { randomUUID } from 'node:crypto';
import { subscribeChatHistoryUpdates, unsubscribeChatHistoryUpdates } from '../sdk/sdk-history-updates.ts';
import { subscribeChatListUpdates } from '../chat-list-updates.js';
import { markAgentPresenceDirty } from '../agent-presence-hooks.js';
import { noteChatRunFinished } from '../chat-run/chat-run-recovery.ts';
import { initAgentPresenceBus } from '../agent-presence-bus.js';
import { appendChatHistoryEvents } from '../persist/chat-history-service.js';
import { createHistoryFlusher } from '../persist/history-room-flusher.js';
import { buildServerProducerId } from '../persist/history-pending-buffer.js';
import { noteRoomRunFinishedForAutoTitle } from '../chat-title-dispatcher.js';
import { noteHarnessWsPayloadForPlanSync } from '../sdk/harness-plan-sync.ts';
import { notifySdkClientsChatGone } from '../sdk/sdk-ws-chat-gone.ts';
import { scheduleSdkWsEventLogReplay } from '../sdk/sdk-ws-handshake.ts';
import {
  resolveBroadcastPriority,
  shouldSendToClient,
  WS_BACKPRESSURE_THRESHOLD_BYTES,
} from '../sdk/sdk-ws-transport.ts';
import {
  buildSdkRoomStatePayload,
  ROOM_STATE_HEARTBEAT_INTERVAL_MS,
} from '../sdk/sdk-room-state.ts';
import { disposeMcpContext } from '../mcp/mcp-service.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.ts';
import {
  applyDelegationFinalReportRunFinished,
  applyDelegationFinalReportSdkEvent,
} from '../delegation-run-bridge.js';
import { persistSdkRunFinishedHistoryStatus } from '../sdk/sdk-run-outcome.ts';
import { notifyAgentFinished } from '../agent-finished-push.js';
import { noteSdkRunToolActivity, resetSdkRunToolActivity } from '../sdk/sdk-run-tool-activity.ts';
import { getHarnessUsageLimit, noteHarnessUsageLimit } from '../harness-usage-limits.js';
import { armChatUsageLimitPause, cancelSubjectUsageLimitPauses } from '../usage-limit-paused.js';
import { appendPauseChatNotice } from '../usage-limit-resume-notices.js';
import { resolveDelegationStartContext } from '../delegation-start-context.js';
import { loadChats } from '../persist/chats-persist.js';
import { resolveHarnessLimitBinding } from './optional-harness-hooks.ts';
import { recordHarnessContextSample } from '../usage/harness-context-telemetry.ts';
import { safeRecordUsage } from '../usage/usage-ledger.ts';
import { stampUsageHistoryEvent } from '../usage/usage-history-meta.ts';
import { noteRoomMeasurementIdentity } from '../usage/context-restarts.ts';
import { noteHarnessPlanLimit } from '../usage/harness-health.ts';
import { getClaudeAuthMode } from '../claude/claude-auth-mode.ts';
import {
  beginHarnessRun,
  noteHarnessCallUsage,
  noteHarnessFirstOutput,
  recordHarnessFallbackUsage,
  recordHarnessRunFinished,
  recordHarnessUsageDelta,
  isPlanLimitLockout,
  resolveHarnessPlanLimitSnapshot,
  resolveHarnessRole,
  resolveHarnessSourceSessionId,
} from '../usage/harness-usage.ts';
import { captureRunEnd } from '../usage/run-end-snapshot.js';

export const ROOM_EMPTY_GRACE_MS = 90_000;
export const MAX_EVENT_LOG = 1200;
export const ROOM_PERSIST_FLUSH_MS = 2000;

// Rooms are loosely typed (shared with lib/claude and lib/codex, which use `any` rooms).
type Room = any;

/** Every kernel created in this process, so shutdown can flush all rooms. */
const liveKernels: Set<{
  transport: string,
  rooms: Map<string, Room>,
  flushPersistBuffer: (room: Room) => unknown,
}> = new Set();
const harnessRunStarts = new Map<string, number[]>();
const HARNESS_RUN_PRESSURE_WINDOW_MS = 5 * 60 * 1000;

function recordHarnessRunStart(harness: string, now = Date.now()): void {
  const starts = harnessRunStarts.get(harness) || [];
  starts.push(now);
  while (starts.length && starts[0] < now - HARNESS_RUN_PRESSURE_WINDOW_MS) starts.shift();
  harnessRunStarts.set(harness, starts);
}

function getHarnessRunPressure(harness: string, now = Date.now()): { activeRuns: number, startsLastMinute: number, startsLastFiveMinutes: number } {
  const starts = harnessRunStarts.get(harness) || [];
  while (starts.length && starts[0] < now - HARNESS_RUN_PRESSURE_WINDOW_MS) starts.shift();
  let activeRuns = 0;
  for (const kernel of liveKernels) {
    if (kernel.transport !== harness) continue;
    for (const room of kernel.rooms.values()) {
      if (Number.isFinite(Number(room?._runStartedAt)) && Number(room._runStartedAt) > 0) activeRuns += 1;
    }
  }
  return {
    activeRuns,
    startsLastMinute: starts.filter((at) => at >= now - 60_000).length,
    startsLastFiveMinutes: starts.length,
  };
}

/**
 * Flush the buffered history of every room of every harness kernel (the 2s
 * persist buffer). Never throws: a failing room is counted and skipped.
 */
export function flushAllRoomPersistBuffers(): { rooms: number, failed: number } {
  let rooms = 0;
  let failed = 0;
  for (const kernel of liveKernels) {
    for (const room of kernel.rooms.values()) {
      rooms += 1;
      try {
        kernel.flushPersistBuffer(room);
      } catch {
        failed += 1;
      }
    }
  }
  return { rooms, failed };
}

export interface AgentRoomKernelOptions {
  transport: string;
  logLabel?: string;
  goneMessage?: string;
  rooms?: Map<string, object>;
  graceMs?: number;
  maxEventLog?: number;
  /**
   * Durable append of one batch. It MUST reject when the batch is not acknowledged; the kernel then keeps the
   * same records and re-sends them with the same `retryToken` (see persist/history-room-flusher.js).
   */
  persistHistory?: (room: Room, recs: object[], callOptions?: { retryToken?: string, producerId?: string }) => void | Promise<unknown>;
  abortRoom?: (room: object) => void;
  afterBroadcast?: (room: object, payload: Record<string, unknown>) => void;
  usageDataDir?: string;
  /** Test seam merged into the pause arm deps. */
  usageLimitPauseDeps?: object;
  recordUsage?: (partial: object) => unknown;
  /** Test seam for the shared agent-finished push; defaults to notifyAgentFinished. */
  notifyRunFinished?: (input: object) => unknown;
  /** Test seam for the canonical end-of-run hook. */
  captureRunEnd?: (input: object) => unknown;
}

/**
 * Agent-finished pushes mirror the Cursor SDK path, where a room only pushes
 * when its interactive WS handler armed `onRunFinished`. For kernel harnesses
 * the equivalent signal is "an interactive client ever attached to this room":
 * `attachClient` is only called by the WS handlers, while delegation children /
 * headless / mailbox runs are started through the chat-run adapter without a
 * client. The flag is sticky, so closing the app before a run ends still
 * notifies (exactly like the SDK's persisted `onRunFinished`).
 */
export function shouldSuppressAgentFinishedPush(room: Room | null | undefined): boolean {
  if (!room || typeof room !== 'object') return true;
  return room._interactiveClientSeen !== true;
}

export function broadcastToRoomClients(
  room: { clients?: Set<{ readyState: number, send: (msg: string) => void, bufferedAmount?: number }> } | null | undefined,
  payload: Record<string, unknown>,
  options: { priority?: 'critical' | 'normal' } = {},
): void {
  if (!room?.clients) return;
  const priority = resolveBroadcastPriority(payload, options.priority);
  const serialized = JSON.stringify(payload);
  for (const client of room.clients) {
    if (!shouldSendToClient(client as any, priority, WS_BACKPRESSURE_THRESHOLD_BYTES)) continue;
    try {
      client.send(serialized);
    } catch (err) {
      console.warn('[room-kernel] send failed:', (err as Error | undefined)?.message || err);
    }
  }
}

export function pushRoomEvent(room: Room, payload: Record<string, unknown>, maxEventLog: number = MAX_EVENT_LOG): Record<string, unknown> {
  if (!room) return payload;
  room.eventSeq = (Number(room.eventSeq) || 0) + 1;
  const enriched = {
    ...payload,
    roomEventSeq: room.eventSeq,
    eventStreamId: room.eventStreamId,
  };
  if (!Array.isArray(room.eventLog)) room.eventLog = [];
  room.eventLog.push({ seq: room.eventSeq, payload: enriched });
  const cap = Number.isFinite(maxEventLog) && maxEventLog > 0 ? maxEventLog : MAX_EVENT_LOG;
  if (room.eventLog.length > cap) {
    room.eventLog.splice(0, room.eventLog.length - cap);
  }
  room.lastEventAt = Date.now();
  return enriched;
}

export function ensureRoomStateHeartbeat(room: Room, sendRoomState: (room: Room) => void): void {
  if (!room || room._roomStateTimer || typeof sendRoomState !== 'function') return;
  room._roomStateTimer = setInterval(() => {
    sendRoomState(room);
  }, ROOM_STATE_HEARTBEAT_INTERVAL_MS);
  if (typeof room._roomStateTimer.unref === 'function') room._roomStateTimer.unref();
}

export function stopRoomStateHeartbeat(room: Room): void {
  if (!room?._roomStateTimer) return;
  clearInterval(room._roomStateTimer);
  room._roomStateTimer = null;
}

export function cancelWsReplayBatch(ws: Room): void {
  if (!ws?._replayBatchTimer) return;
  clearTimeout(ws._replayBatchTimer);
  ws._replayBatchTimer = null;
}

export function scheduleEventLogReplay(room: Room, ws: Room): void {
  if (!room || !ws) return;
  cancelWsReplayBatch(ws);
  const entries = Array.isArray(room.eventLog) ? room.eventLog : [];
  if (entries.length === 0) return;
  scheduleSdkWsEventLogReplay({
    entries,
    cancelTimer: () => cancelWsReplayBatch(ws),
    send: (payload: unknown) => {
      if (ws.readyState !== 1) {
        cancelWsReplayBatch(ws);
        return;
      }
      ws.send(JSON.stringify(payload));
    },
    setTimer: (fn: () => void, delayMs: number) => {
      if (ws.readyState !== 1) {
        cancelWsReplayBatch(ws);
        return;
      }
      ws._replayBatchTimer = setTimeout(fn, delayMs);
    },
  });
}

export function abortRoomController(room: Room): void {
  const controller = room?.abortController;
  if (!controller || typeof controller.abort !== 'function') return;
  try {
    controller.abort();
  } catch (err) {
    console.warn('[room-kernel] abort failed:', (err as Error | undefined)?.message || err);
  }
}

export function mapWsPayloadToHistoryRecord(
  type: string,
  payload: Record<string, any>,
  source: { eventStreamId?: string, roomEventSeq?: number, harness: string },
): { rec: object, flushNow: boolean } | null {
  if (type === 'sdkEvent' && payload.event && typeof payload.event === 'object') {
    return { rec: { kind: 'sdk', event: payload.event, ...source }, flushNow: false };
  }
  if (type === 'sdkRunFinished') {
    return {
      rec: {
        kind: 'meta',
        variant: 'runFinished',
        payload: persistSdkRunFinishedHistoryStatus(payload),
        ...source,
      },
      flushNow: true,
    };
  }
  if (type === 'sdkError') {
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) return null;
    return { rec: { kind: 'meta', variant: 'error', payload: message, ...source }, flushNow: true };
  }
  if (type === 'sdkQueueRemoved') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text) return null;
    return { rec: { kind: 'meta', variant: 'queueRemoved', payload: text, ...source }, flushNow: true };
  }
  if (type === 'sdkMode') {
    const mode = payload.mode === 'plan' || payload.mode === 'agent' || payload.mode === 'ask'
      ? payload.mode
      : '';
    if (!mode) return null;
    return { rec: { kind: 'meta', variant: 'mode', payload: mode, ...source }, flushNow: true };
  }
  if (type === 'sdkPlanGuard') {
    const toolName = typeof payload.toolName === 'string' ? payload.toolName.trim() : '';
    if (!toolName) return null;
    return { rec: { kind: 'meta', variant: 'planGuard', payload: toolName, ...source }, flushNow: true };
  }
  if (type === 'opencodePermissionDecision') {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
    const decidedBy = typeof payload.decidedBy === 'string' ? payload.decidedBy.trim() : '';
    if (!requestId || !decidedBy) return null;
    // `local` auto-allows never render a card; keep them out of chat history.
    if (decidedBy === 'local') return null;
    const { type: _type, ...rest } = payload;
    return {
      rec: { kind: 'meta', variant: 'permissionDecision', payload: JSON.stringify(rest), ...source },
      flushNow: true,
    };
  }
  if (type === 'questionResolved' || type === 'opencodeQuestionResolved') {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
    if (!requestId) return null;
    const status = typeof payload.status === 'string' ? payload.status.trim() : 'answered';
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
    return {
      rec: {
        kind: 'meta',
        variant: 'questionResolved',
        payload: { requestId, status, reason },
        ...source,
      },
      flushNow: false,
    };
  }
  return null;
}

export function createAgentRoomKernel(options: AgentRoomKernelOptions) {
  const transport = String(options?.transport || '').trim();
  if (!transport) throw new TypeError('createAgentRoomKernel requires transport');
  const logLabel = options.logLabel || `${transport}-ws`;
  const goneMessage = options.goneMessage || `${transport} chat not found for this session.`;
  const rooms: Map<string, Room> = options.rooms instanceof Map ? options.rooms : new Map();
  const graceMs = Number.isFinite(options.graceMs) && (options.graceMs as number) >= 0
    ? (options.graceMs as number)
    : ROOM_EMPTY_GRACE_MS;
  const maxEventLog = Number.isFinite(options.maxEventLog) && (options.maxEventLog as number) > 0
    ? (options.maxEventLog as number)
    : MAX_EVENT_LOG;
  const persistHistory = typeof options.persistHistory === 'function'
    ? options.persistHistory
    : async (room: Room, recs: object[], callOptions?: { retryToken?: string, producerId?: string }) => await appendChatHistoryEvents(room.chatId, room.sessionKey, recs, callOptions);
  // One stable producer per room (= per run attempt in this process): a retried batch keeps its identity.
  const roomProducerId = (room: Room) => (room._historyProducerId ||= buildServerProducerId({ runId: String(room.sessionKey), attemptId: randomUUID() }));
  const historyFlusher = createHistoryFlusher({
    label: logLabel,
    append: (room: Room, items: object[], callOptions?: object) => persistHistory(room, items, { producerId: roomProducerId(room), ...callOptions }) as Promise<unknown>,
  });
  const abortRoom = typeof options.abortRoom === 'function' ? options.abortRoom : abortRoomController;
  const afterBroadcast = typeof options.afterBroadcast === 'function' ? options.afterBroadcast : null;
  const usageCtx = options.usageDataDir ? { dataDir: options.usageDataDir } : {};
  const usageDataDir = String(options.usageDataDir || '').trim() || undefined;
  // Test seam for the usage-limit pause hooks (settings, now, findChat, ...).
  const usageLimitPauseDeps = options.usageLimitPauseDeps && typeof options.usageLimitPauseDeps === 'object'
    ? options.usageLimitPauseDeps
    : {};
  const recordUsage = typeof options.recordUsage === 'function'
    ? options.recordUsage
    : (partial: object) => safeRecordUsage(partial, usageCtx);
  // An injected recorder is a test/embedding seam: it must stay side-effect
  // free, so run-start persistence only happens on the production path.
  const recordUsageInjected = typeof options.recordUsage === 'function';
  const notifyRunFinished = typeof options.notifyRunFinished === 'function'
    ? options.notifyRunFinished
    : notifyAgentFinished;
  const captureRunEndHook = typeof options.captureRunEnd === 'function'
    ? options.captureRunEnd
    : captureRunEnd;

  /**
   * Records harness telemetry from the same payloads clients see. Run events
   * carry no tokens; token deltas are recorded per harness usage event.
   */
  function noteRoomUsageTelemetry(room: Room, payload: Record<string, any>): void {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'sdkPromptStarted') {
      if (transport === 'codex' || transport === 'claude') recordHarnessRunStart(transport);
      beginHarnessRun(
        room,
        payload,
        recordUsageInjected
          ? {}
          : { dataDir: usageDataDir, persistRunStart: true, harness: transport }
      );
      return;
    }
    if (payload.type === 'sdkEvent') {
      noteHarnessFirstOutput(room, payload);
      const event = payload.event;
      if (event?.type === 'context_usage') {
        recordHarnessContextSample({ room, harness: transport, event, role: resolveHarnessRole(room), dataDir: usageDataDir });
        noteHarnessCallUsage(room, transport, event);
      }
      if (event && typeof event === 'object' && event.type === 'usage') {
        recordHarnessUsageDelta(room, transport, event, recordUsage);
      }
      return;
    }
    if (payload.type === 'sdkContextUsage') {
      // Claude reports per-call context outside `sdkEvent`; normalise it for the shared stream.
      recordHarnessContextSample({
        room, harness: transport, role: resolveHarnessRole(room), dataDir: usageDataDir,
        event: { source: 'claude-sdk', ...payload },
      });
      return;
    }
    if (payload.type === 'sdkRunFinished') {
      recordHarnessFallbackUsage(room, transport, recordUsage);
      const runPayload = transport === 'codex' || transport === 'claude'
        ? { ...payload, harnessRunPressure: getHarnessRunPressure(transport) }
        : payload;
      recordHarnessRunFinished(room, transport, runPayload, recordUsage);
    }
  }

  /**
   * Flush the room buffer durably. Records stay in the room (buffer or in-flight batch, same `retryToken`) until the
   * adapter acknowledged them; the returned promise resolves with the outcome and never rejects, a failed flush is
   * retried in the background. Fire-and-forget callers may ignore it, a caller that must not run ahead of the
   * commit (stop, final flush, notifications) awaits it.
   */
  function flushPersistBuffer(room: Room): Promise<{ ok: boolean, pending: number, deadLettered: number }> {
    if (!room?.chatId || !room?.sessionKey) return Promise.resolve({ ok: true, pending: 0, deadLettered: 0 });
    room._flushHistory = () => historyFlusher.flush(room);
    return historyFlusher.flush(room);
  }

  function persistRoomEvent(room: Room, rec: object, flushNow = false): void {
    if (!room?.chatId || !room?.sessionKey) return;
    if (room._persistDiscarded) return;
    if (!Array.isArray(room._persistBuf)) room._persistBuf = [];
    room._persistBuf.push({ rec: { ...rec, createdAt: new Date().toISOString() } });
    historyFlusher.enqueue(room);
    if (flushNow) {
      void flushPersistBuffer(room);
      return;
    }
    if (room._persistTimer) return;
    room._persistTimer = setTimeout(() => {
      room._persistTimer = null;
      void flushPersistBuffer(room);
    }, ROOM_PERSIST_FLUSH_MS);
  }

  function persistRoomEventFromPayload(room: Room, payload: Record<string, any>): void {
    if (!payload || typeof payload !== 'object') return;
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type === 'sdkPromptStarted') resetSdkRunToolActivity(room);
    if (type === 'sdkEvent') noteSdkRunToolActivity(room, payload.event);
    if (
      type === 'sdkBusy'
      || type === 'sdkRunFinished'
      || type === 'sdkPromptStarted'
      || type === 'sdkEvent'
    ) {
      markAgentPresenceDirty(room.chatId ? [room.chatId] : undefined);
    }
    noteHarnessWsPayloadForPlanSync(room, payload);
    const roomEventSeq = Number(payload.roomEventSeq);
    const source =
      Number.isSafeInteger(roomEventSeq) && roomEventSeq > 0
        ? { eventStreamId: room.eventStreamId, roomEventSeq, harness: transport }
        : { harness: transport };
    const mapped = mapWsPayloadToHistoryRecord(type, payload, source);
    if (!mapped) return;
    persistRoomEvent(room, mapped.rec, mapped.flushNow);
  }

  function broadcastRoom(room: Room, payload: Record<string, any>, broadcastOptions: { log?: boolean } = {}): void {
    // Usage events get their contract metadata once, before WS fan-out and history
    // persistence, so both carry the same provenance/epoch/eligibility facts.
    if (payload && typeof payload === 'object' && payload.type === 'sdkEvent' && payload.event) {
      // Model/session change is detected on every usage-shaped event, before the
      // epoch is stamped, so the event that reveals it already belongs to the new epoch.
      noteRoomMeasurementIdentity(room, payload.event, resolveHarnessSourceSessionId(room));
      const stamped = stampUsageHistoryEvent(room, transport, payload.event);
      if (stamped !== payload.event) payload = { ...payload, event: stamped };
    }
    // The quiet-stop rewrite runs first so notify and usage see the final status.
    if (payload && typeof payload === 'object' && payload.type === 'sdkRunFinished') {
      applyDelegationFinalReportRunFinished(room, payload);
    }
    if (payload && typeof payload === 'object' && payload.type === 'sdkEvent') {
      applyDelegationFinalReportSdkEvent(room, payload);
    }
    // Fire before `afterBroadcast`/noteDelegationRoomEvent, which clears
    // room.serverHold for a server-started run. The shared notifier dedupes on
    // the room so a second finish for the same run never pushes twice.
    if (payload && typeof payload === 'object' && payload.type === 'sdkRunFinished') {
      if (!shouldSuppressAgentFinishedPush(room)) {
        notifyRunFinished({
          chatId: room.chatId,
          chatTitle: room.chatTitle,
          status: payload.status,
          runId: payload.runId,
          room,
        });
      }
    }
    // Capture while the telemetry fields still describe this run;
    // recordHarnessRunFinished resets timing immediately afterwards.
    if (payload?.type === 'sdkRunFinished') {
      // Codex may only have per-call context usage. Materialise that fallback
      // before the snapshot so its *Known fields describe the final evidence.
      recordHarnessFallbackUsage(room, transport, recordUsage);
      const errorCandidates = [
        ...(Array.isArray(payload.lastErrorMessages) ? payload.lastErrorMessages : []),
        payload.result,
      ]
        .map((value: unknown) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);
      captureRunEndHook({
        room,
        harness: transport,
        model: room?.modelId || room?.model || '',
        sessionId: room?.sessionKey || room?.sessionId || room?.chatId || '',
        payload: {
          ...payload,
          lastErrorMessage: payload.lastErrorMessage || payload.result,
          ...(errorCandidates.length ? { lastErrorMessages: errorCandidates } : {}),
        },
        ...(transport === 'claude' ? { authMode: getClaudeAuthMode() } : {}),
        limitBinding: resolveHarnessLimitBinding(transport, { dataDir: usageDataDir }),
        dataDir: usageDataDir,
        onUsageLimit: (_snapshot: object, runError: any) => {
          armChatUsageLimitPause({
            chatId: room.chatId,
            harness: transport,
            model: runError.model,
            subjectModel: room?.modelId || room?.model || '',
          }, {
            dataDir: usageDataDir,
            getLimit: getHarnessUsageLimit,
            resolveContext: resolveDelegationStartContext,
            findChat: (id: string) => loadChats().find((row: any) => row?.id === id),
            onArmed: (record: object) => { void appendPauseChatNotice({ record, state: 'armed' }, usageLimitPauseDeps).catch(() => {}); },
            ...usageLimitPauseDeps,
          });
        },
      });
    }
    noteRoomUsageTelemetry(room, payload);
    // A new run or a user Stop supersedes any armed usage-limit pause.
    if (room?.chatId && (payload?.type === 'sdkPromptStarted'
      || (payload?.type === 'sdkRunFinished' && payload.status === 'cancelled'))) {
      cancelSubjectUsageLimitPauses({
        subjectType: 'chat',
        subjectId: room.chatId,
        reason: payload.type === 'sdkPromptStarted' ? 'new_run' : 'user_stop',
      }, { dataDir: usageDataDir });
    }
    if (payload?.type === 'sdkRunFinished') {
      noteChatRunFinished({ chatId: room.chatId, runId: payload.runId, status: payload.status });
    }
    // Structured plan-limit signal (Claude `rate_limit_event`): keep the last
    // snapshot and, on a rejected window, record a lockout without any prose.
    // API-key/provider Claude sessions resolve to null here: they carry no plan.
    const planLimit = resolveHarnessPlanLimitSnapshot(transport, payload);
    if (planLimit) {
      noteHarnessPlanLimit({
        ...planLimit,
        model: room?.modelId || room?.model || '',
        dataDir: usageDataDir,
      });
      if (isPlanLimitLockout(planLimit)) {
        noteHarnessUsageLimit({
          harness: transport,
          model: room?.modelId || room?.model || '',
          source: 'rate-limit-event',
          status: planLimit.status,
          resetAt: planLimit.resetsAt,
          rateLimitType: planLimit.rateLimitType,
          authMode: planLimit.authMode,
          code: planLimit.rateLimitType ? `rate_limit_${planLimit.rateLimitType}` : 'rate_limit_rejected',
          dataDir: usageDataDir,
        });
      }
    }
    const outgoing = broadcastOptions.log === false ? payload : pushRoomEvent(room, payload, maxEventLog);
    // Enqueue the terminal history record before the delegation bridge sees
    // it, so the bridge can await a durable flush and snapshot the exact
    // session boundary. Client broadcast ordering is unchanged.
    persistRoomEventFromPayload(room, outgoing);
    if (afterBroadcast) afterBroadcast(room, outgoing);
    broadcastToRoomClients(room, outgoing);
    noteRoomRunFinishedForAutoTitle(room, outgoing);
  }

  /**
   * Update and broadcast a room mode only when it actually changes.
   */
  function applySdkModeIfChanged(
    room: Room,
    mode: unknown,
    options: { chatId?: string, updateChat?: Function, extraPayload?: Record<string, unknown>, onChanged?: Function } = {},
  ): boolean {
    const normalized = normalizeSdkMode(mode);
    const previous = normalizeSdkMode(room?.sdkMode);
    if (previous === normalized) {
      if (room) room.sdkMode = normalized;
      return false;
    }
    if (typeof options.onChanged === 'function') options.onChanged(previous, normalized);
    if (room) room.sdkMode = normalized;
    const chatId = typeof options.chatId === 'string' ? options.chatId : room?.chatId;
    if (chatId && typeof options.updateChat === 'function') {
      options.updateChat(chatId, { sdkMode: normalized });
    }
    broadcastRoom(room, {
      type: 'sdkMode',
      mode: normalized,
      ...(options.extraPayload && typeof options.extraPayload === 'object' ? options.extraPayload : {}),
    });
    return true;
  }

  function sendRoomState(room: Room): void {
    if (!room) return;
    broadcastToRoomClients(room, buildSdkRoomStatePayload({ ...room, transport }), { priority: 'normal' });
  }

  function clearShutdownTimer(room: Room): void {
    if (!room?._shutdownTimer) return;
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }

  function scheduleRoomShutdown(sessionKey: string): void {
    const room = rooms.get(sessionKey);
    if (!room) return;
    clearShutdownTimer(room);
    room._shutdownTimer = setTimeout(() => {
      const current = rooms.get(sessionKey);
      if (!current) return;
      current._shutdownTimer = null;
      if (current.clients.size > 0 || current.busy || current.serverHold) {
        scheduleRoomShutdown(sessionKey);
        return;
      }
      stopRoomStateHeartbeat(current);
      void flushPersistBuffer(current);
      abortRoom(current);
      void disposeMcpContext({
        sessionId: sessionKey,
        chatId: current.chatId,
        workspaceFolder: current.cwd,
      });
      rooms.delete(sessionKey);
    }, graceMs);
  }

  function disposeRoom(sessionKey: string): void {
    const room = rooms.get(sessionKey);
    if (!room) return;
    clearShutdownTimer(room);
    stopRoomStateHeartbeat(room);
    abortRoom(room);
    void disposeMcpContext({
      sessionId: sessionKey,
      chatId: room.chatId,
      workspaceFolder: room.cwd,
    });
    notifySdkClientsChatGone(room.clients, goneMessage);
    void flushPersistBuffer(room);
    rooms.delete(sessionKey);
  }

  function createRoomState(fields: { sessionKey: string, chatId?: string, [key: string]: unknown }) {
    return {
      clients: new Set(),
      transport,
      busy: false,
      eventStreamId: randomUUID(),
      eventSeq: 0,
      eventLog: [],
      pendingPrompts: [],
      _persistBuf: [],
      _persistTimer: null,
      ...fields,
    };
  }

  function attachClient(room: Room, ws: Room): void {
    if (!room || !ws) return;
    clearShutdownTimer(room);
    room.clients.add(ws);
    // Sticky: this room belongs to an interactive session, so its runs may
    // raise the shared "agent finished" push (see shouldSuppressAgentFinishedPush).
    room._interactiveClientSeen = true;
    subscribeChatHistoryUpdates(room.chatId, ws);
    try {
      initAgentPresenceBus();
      subscribeChatListUpdates(ws, ws._chatListScope);
    } catch (err) {
      // Presence is auxiliary: a failure here must leave the socket attached to the room.
      console.error('[room-kernel] presence subscribe failed:', err instanceof Error ? err.message : err);
    }
    ensureRoomStateHeartbeat(room, sendRoomState);
  }

  function detachClient(room: Room, ws: Room, sessionKey: string): void {
    if (!room || !ws) return;
    room.clients.delete(ws);
    unsubscribeChatHistoryUpdates(room.chatId, ws);
    cancelWsReplayBatch(ws);
    if (room.clients.size === 0) scheduleRoomShutdown(sessionKey);
  }

  const kernel = {
    rooms,
    transport,
    broadcastToRoomClients,
    pushRoomEvent: (room: Room, payload: Record<string, unknown>) => pushRoomEvent(room, payload, maxEventLog),
    broadcastRoom,
    applySdkModeIfChanged,
    persistRoomEvent,
    persistRoomEventFromPayload,
    flushPersistBuffer,
    sendRoomState,
    scheduleRoomShutdown,
    disposeRoom,
    clearShutdownTimer,
    createRoomState,
    attachClient,
    detachClient,
    scheduleEventLogReplay,
    cancelWsReplayBatch,
  };
  liveKernels.add(kernel);
  return kernel;
}
