/**
 * WebSocket for @cursor/sdk chats — JSON event stream instead of PTY + ANSI parsing.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { getChatByCursorSessionId, setChatSdkAgentId, updateChat } from '../persist/chats-persist.js';
import { extractAssistantPlainText } from '../context-compression.js';
import { extractPlanTextFromSdkEvent, accumulateStreamText } from './sdk-plan-text.js';
import { buildChatPlanPromptContext, pickRicherPlanMarkdown } from '../chat-plan-persist.js';
import { resolveSdkPlanCreateOptions } from '../agent-harness/harness-plan-policy.js';
import {
  getSdkToolCallName,
  isPlanModeMutatingSdkEvent,
  PLAN_GUARD_USER_MESSAGE,
} from './sdk-plan-guard.js';
import { normalizeCatalogModelValue, resolveModelSelection } from '../model-catalog.js';
import { appendChatHistoryEvents } from '../persist/chat-history-persist.js';
import {
  readSdkRunStreamStep,
  resolveConfiguredSdkRunIdleTimeoutMs,
  resolveSdkRunIdleTimeoutMs,
  SDK_RUN_SETUP_PROGRESS_INTERVAL_MS,
  withAbortOnly,
} from './sdk-run-idle-guard.js';
import { buildSdkPromptMessage } from './sdk-prompt-images.js';
import { emptyUsageTokens } from '../usage/usage-event.js';
import { deltaTokens, fromSdkUsage } from '../usage/usage-normalize.js';
import { safeRecordUsage } from '../usage/usage-ledger.js';
import { loadSettings } from '../persist/settings.js';
import { msg } from '../messages.js';
import { executePageCommandForChat, getPageSessionForChat } from '../page-bridge.js';
import {
  buildSharedAlwaysApplyRulesPrompt,
  resolveSdkCwdList,
} from './shared-cursor-context.js';
import {
  BACKPRESSURE_DRAIN_MAX_WAIT_MS,
  BACKPRESSURE_DRAIN_POLL_MS,
  getMaxClientBufferedAmount,
  hasRoomBackpressure,
  resolveBroadcastPriority,
  shouldSendToClient,
  WS_BACKPRESSURE_THRESHOLD_BYTES,
} from './sdk-ws-transport.js';
import {
  buildSdkRoomStatePayload,
  ROOM_STATE_HEARTBEAT_INTERVAL_MS,
} from './sdk-room-state.js';
import {
  notifySdkClientsChatGone,
  sendSdkChatNotFoundAndClose,
} from './sdk-ws-chat-gone.js';
import {
  extractSdkStreamStatusError,
  isSdkRunFailureStatus,
  normalizeSdkRunStatus,
  readSdkRoomRunOutcome,
  trackSdkRoomRunOutcome,
} from './sdk-run-outcome.js';
import {
  buildSdkAuthRecoveryRetryMessage,
  buildSdkRateLimitRecoveryRetryMessage,
  isSdkAuthenticationError,
  isSdkRateLimitError,
  shouldRetrySdkAuthRecovery,
  shouldRetrySdkRateLimitRecovery,
} from './sdk-auth-recovery.js';
import {
  computeRateLimitRetryDelayMs,
  computeSetupRetryDelayMs,
  schedulePendingPromptRun,
  SDK_AUTH_RECOVERY_RETRY_DELAY_MS,
} from './sdk-retry-delay.js';
import {
  buildSetupRetryMessage,
  shouldRetrySetupFailure,
} from './sdk-setup-retry.js';
import {
  buildStuckRunRecoveryMessage,
  buildStuckRunRecoveryRetryMessage,
  resolveSdkRunAutoRecoveryGraceMs,
  shouldRetryStuckRunRecovery,
  shouldTriggerStuckRunRecovery,
} from './sdk-run-auto-recovery.js';
import { readEnvAlias } from '../env-alias.js';
import {
  estimateEffectiveUsageInputTokens,
  findLastUsageEventPayload,
  readReportedTokenCount,
} from './sdk-context-advisory.js';
import { getServerInstanceId } from './sdk-instance-id.js';
import { resolveSdkCwdForChat } from '../workspace.js';
import {
  isQueuedPromptText,
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../prompt-ui-text.js';
import { initSdkRoomBus, publishSdkRoomEvent } from './sdk-room-bus.js';
import {
  buildSdkRoomOwnerMeta,
  lookupSdkRoomOwner,
  refreshSdkRoomOwner,
  registerSdkRoomOwner,
  unregisterSdkRoomOwner,
} from './sdk-room-registry.js';
import {
  applySequencedRemoteRoomEvent,
  createSdkRemoteRoomStub,
  isSdkRemoteRoomStub,
} from './sdk-remote-room-stub.js';
import { scheduleSdkWsEventLogReplay } from './sdk-ws-handshake.js';
import { loadCursorSdk } from './cursor-sdk.js';
import { getEffectiveCursorApiKey } from './cursor-api-key.js';
import { normalizeSdkMode } from './sdk-mode.js';
import { resolveDataPath } from '../runtime-paths.js';

const sdkRooms = new Map();
const SDK_LOCAL_STORE_ROOT = resolveDataPath('sdk-agent-store');

/** How long an SDK room stays alive with no clients (page refresh / brief disconnect). */
const ROOM_EMPTY_GRACE_MS = 90000;

const DEFAULT_SDK_MODEL_ID = 'composer-2';

const PAGE_TOOL_DEFINITIONS = Object.freeze({
  page_get_context: ['getContext', 'context', 'Get the current URL, viewport, and the active/selected page element.'],
  page_get_dom: ['getDom', 'dom', 'Get a simplified, redacted DOM of the page.'],
  page_query_elements: ['queryElements', 'dom', 'Find page elements with a CSS selector.'],
  page_get_computed_styles: ['getComputedStyles', 'dom', 'Get computed styles for the element matching a CSS selector.'],
  page_get_console: ['getConsole', 'console', 'Get the latest redacted console entries and page errors.'],
  page_get_network: ['getNetwork', 'network', 'Get the latest redacted fetch/XHR requests and performance entries.'],
  page_take_screenshot: ['takeScreenshot', 'screenshot', 'Take a screenshot of the page after the browser confirmation.'],
  page_click: ['click', 'interact', 'Click the element matching a CSS selector.'],
  page_type: ['type', 'interact', 'Type text into the field matching a CSS selector.'],
  page_select: ['select', 'interact', 'Choose a value in a select field.'],
  page_scroll: ['scroll', 'interact', 'Scroll the page or a given element.'],
  page_focus: ['focus', 'interact', 'Focus the given element.'],
  page_reload: ['reload', 'navigate', 'Reload the host page.'],
  page_navigate: ['navigate', 'navigate', 'Navigate within origins allowed by the installation.'],
  page_wait_for: ['waitFor', 'interact', 'Wait until an element appears or a page condition is met.'],
  page_pick_element: ['pickElement', 'interact', 'Start interactive element picking on the page.'],
  page_press_key: ['pressKey', 'interact', 'Send a key (Enter, Tab, Escape, etc.) to an element or the active focus.'],
  page_copy_text: ['copyText', 'interact', 'Copy text to the browser clipboard on the host page.'],
  page_highlight: ['highlight', 'interact', 'Temporarily highlight the element matching a CSS selector.'],
  page_hover: ['hover', 'interact', 'Simulate hovering the mouse over an element (mouseover/mousemove).'],
  page_fill_form: ['fillForm', 'interact', 'Fill multiple form fields at once (selector + value/text/checked).'],
  page_read_storage: ['readStorage', 'storage', 'Read localStorage or sessionStorage (read-only; sensitive keys are redacted).'],
});

export function buildPageCustomTools(sessionKey, mode = 'agent') {
  const session = getPageSessionForChat(sessionKey);
  if (!session) return {};
  const permissions = new Set(session.permissions);
  return Object.fromEntries(
    Object.entries(PAGE_TOOL_DEFINITIONS)
      .filter(([, [, permission]]) => permissions.has(permission))
      .filter(([, [, permission]]) => mode !== 'plan' || !['interact', 'navigate'].includes(permission))
      .map(([toolName, [command, , description]]) => [
        toolName,
        {
          description,
          inputSchema: {
            type: 'object',
            additionalProperties: true,
          },
          execute: async (args) => executePageCommandForChat(sessionKey, command, args || {}),
        },
      ]),
  );
}

/**
 * Agent tools for host-page chat binding (independent of page bridge connection).
 *
 * @param {string} sessionKey
 * @param {'plan' | 'agent'} mode
 * @returns {Record<string, object>}
 */
export function buildChatHostCustomTools(sessionKey, mode = 'agent') {
  if (mode === 'plan') return {};
  return {
    chat_pin_url: {
      description: 'Pin the current chat to the host page URL (widget embed). Optionally navigate the host to that URL when the page bridge is connected.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL of the host page, e.g. http://192.0.2.10:8080/app/edit/5' },
          navigate: { type: 'boolean', description: 'Whether to navigate the host page to this URL (default true)' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: async (args = {}) => {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) throw new Error('url is required');
        const chat = getChatByCursorSessionId(sessionKey);
        if (!chat?.id) throw new Error(`Chat not found for session: ${sessionKey}`);
        const updated = updateChat(chat.id, { widgetPinnedUrl: url });
        const shouldNavigate = args.navigate !== false;
        const pageBound = Boolean(getPageSessionForChat(sessionKey));
        let navigated = false;
        let navigateError = '';
        if (shouldNavigate && pageBound) {
          try {
            await executePageCommandForChat(sessionKey, 'navigate', { url });
            navigated = true;
          } catch (error) {
            navigateError = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          ok: true,
          chatId: chat.id,
          widgetPinnedUrl: updated?.widgetPinnedUrl || url,
          pageBound,
          navigated,
          navigateError: navigateError || undefined,
        };
      },
    },
  };
}

/**
 * @param {string} sessionKey
 * @param {'plan' | 'agent'} mode
 * @returns {Record<string, object>}
 */
export function buildSdkCustomTools(sessionKey, mode = 'agent') {
  return {
    ...buildPageCustomTools(sessionKey, mode),
    ...buildChatHostCustomTools(sessionKey, mode),
  };
}

function buildAutomaticPageContext(sessionKey) {
  const session = getPageSessionForChat(sessionKey);
  if (!session?.latestState || !session.permissions.includes('context')) return '';
  const state = session.latestState;
  const permissions = new Set(session.permissions);
  const context = {
    url: state.url,
    title: state.title,
    viewport: state.viewport,
    activeElement: state.activeElement,
    selectedElement: state.selectedElement,
  };
  if (permissions.has('dom')) context.dom = state.dom;
  if (permissions.has('console')) context.console = state.console;
  if (permissions.has('network')) context.network = state.network;
  const serialized = JSON.stringify(context);
  const limited = serialized.length > 64_000
    ? `${serialized.slice(0, 64_000)}…`
    : serialized;
  return `[HOST PAGE CONTEXT]\n${limited}\n[/HOST PAGE CONTEXT]`;
}

async function loadSdkModule() {
  return loadCursorSdk();
}

function ensureSessionLocalStore(room, sessionKey, StoreCtor) {
  if (!room || room.localStore || !StoreCtor || !sessionKey) return;
  const normalizedSessionKey = String(sessionKey).trim();
  if (!normalizedSessionKey) return;
  const safeSessionKey = normalizedSessionKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storeDir = path.join(SDK_LOCAL_STORE_ROOT, safeSessionKey);
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    room.localStore = new StoreCtor(storeDir);
  } catch {
    room.localStore = null;
  }
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function jsonSafe(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    );
  } catch {
    return { _serialization: 'failed', type: typeof value };
  }
}

/**
 * Waits until all connected clients drain their WS send buffers.
 *
 * @param {{ clients: Set<import('ws').WebSocket> }} room
 * @param {number} [maxWaitMs]
 * @returns {Promise<boolean>}
 */
async function waitForRoomBackpressureDrain(room, maxWaitMs = BACKPRESSURE_DRAIN_MAX_WAIT_MS) {
  if (!room?.clients?.size) return true;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (!hasRoomBackpressure(room.clients, WS_BACKPRESSURE_THRESHOLD_BYTES)) return true;
    await new Promise((resolve) => setTimeout(resolve, BACKPRESSURE_DRAIN_POLL_MS));
  }
  return !hasRoomBackpressure(room.clients, WS_BACKPRESSURE_THRESHOLD_BYTES);
}

/**
 * @param {{ clients: Set<import('ws').WebSocket> }} room
 * @param {Record<string, unknown>} payload
 * @param {{ priority?: 'critical' | 'normal' }} [options]
 * @returns {{ sent: number, skipped: number }}
 */
function broadcast(room, payload, options = {}) {
  const priority = resolveBroadcastPriority(payload, options.priority);
  const serialized = JSON.stringify(payload);
  let sent = 0;
  let skipped = 0;
  for (const client of room.clients) {
    if (!shouldSendToClient(client, priority, WS_BACKPRESSURE_THRESHOLD_BYTES)) {
      skipped += 1;
      continue;
    }
    try {
      client.send(serialized);
      sent += 1;
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    room._backpressureSkipCount = Number(room._backpressureSkipCount || 0) + skipped;
  }
  return { sent, skipped };
}

const ROOM_EVENT_LOG_MAX = 1200;

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
function rememberRoomUsagePayload(room, payload) {
  if (!room || !payload || payload.type !== 'sdkEvent') return;
  const event = payload.event;
  if (!event || typeof event !== 'object' || event.type !== 'usage') return;
  if (!event.usage || typeof event.usage !== 'object') return;
  room._lastUsagePayload = event.usage;
  const current = fromSdkUsage(event.usage);
  const previous = room._lastRecordedUsageTokens || emptyUsageTokens();
  const tokens = deltaTokens(current, previous);
  room._lastRecordedUsageTokens = current;
  const hasQty = Object.values(tokens).some((count) => Number(count) > 0);
  if (!hasQty) return;
  safeRecordUsage({
    provider: 'cursor',
    feature: 'chat',
    model: String(room.modelId || room._lastRequestedModelId || ''),
    tokens,
    chatId: room.chatId,
    source: 'server',
  });
}

function pushRoomEvent(room, payload) {
  if (!room) return payload;
  if (!Array.isArray(room.eventLog)) room.eventLog = [];
  room.eventSeq = Number.isFinite(room.eventSeq) ? room.eventSeq + 1 : 1;
  room.lastEventAt = Date.now();
  const sequencedPayload = { ...payload, roomEventSeq: room.eventSeq };
  trackSdkRoomRunOutcome(room, sequencedPayload);
  rememberRoomUsagePayload(room, sequencedPayload);
  room.eventLog.push({ seq: room.eventSeq, at: room.lastEventAt, payload: sequencedPayload });
  if (room.eventLog.length > ROOM_EVENT_LOG_MAX) {
    room.eventLog = room.eventLog.slice(-ROOM_EVENT_LOG_MAX);
  }
  persistRoomEventFromPayload(room, sequencedPayload);
  return sequencedPayload;
}

const PERSIST_DEBOUNCE_MS = 250;
const PERSIST_BUSY_INTERVAL_MS = 2000;

/**
 * Defers disk flush off the SDK stream hot path.
 *
 * @param {any} room
 */
function queuePersistFlush(room) {
  if (!room || room._persistFlushQueued) return;
  room._persistFlushQueued = true;
  setImmediate(() => {
    room._persistFlushQueued = false;
    flushPersistBuffer(room);
    if (room.busy && Array.isArray(room._persistBuf) && room._persistBuf.length > 0) {
      schedulePersistFlush(room, false);
    }
  });
}

/**
 * @param {any} room
 * @param {boolean} [flushNow]
 */
function schedulePersistFlush(room, flushNow = false) {
  if (!room || !room.chatId || !room.sessionKey) return;
  if (flushNow) {
    if (room._persistTimer) {
      clearTimeout(room._persistTimer);
      room._persistTimer = null;
    }
    queuePersistFlush(room);
    return;
  }
  if (room._persistTimer) return;
  const delayMs = room.busy ? PERSIST_BUSY_INTERVAL_MS : PERSIST_DEBOUNCE_MS;
  room._persistTimer = setTimeout(() => {
    room._persistTimer = null;
    queuePersistFlush(room);
  }, delayMs);
}

/**
 * Buffers history records for disk write, independent of WS connectivity.
 * Server is the authoritative SDK history writer — clients only pull.
 *
 * @param {any} room
 * @param {Record<string, unknown>} rec
 * @param {boolean} [flushNow]
 */
function persistRoomEvent(room, rec, flushNow = false) {
  if (!room || !room.chatId || !room.sessionKey) return;
  if (!Array.isArray(room._persistBuf)) room._persistBuf = [];
  const createdAt =
    typeof rec?.createdAt === 'string' && rec.createdAt.trim()
      ? rec.createdAt
      : new Date().toISOString();
  room._persistBuf.push({ rec: { ...rec, createdAt } });
  schedulePersistFlush(room, flushNow);
}

/**
 * @param {any} room
 */
function flushPersistBuffer(room) {
  if (!room || !room.chatId || !room.sessionKey) return;
  if (room._persistTimer) {
    clearTimeout(room._persistTimer);
    room._persistTimer = null;
  }
  const buf = Array.isArray(room._persistBuf) ? room._persistBuf : [];
  if (buf.length === 0) return;
  room._persistBuf = [];
  try {
    appendChatHistoryEvents(room.chatId, room.sessionKey, buf);
  } catch (err) {
    console.warn('[sdk-ws] history persist flush failed:', err?.message || err);
  }
}

/**
 * Map a WS payload to a history record and call persistRoomEvent.
 * @param {any} room
 * @param {Record<string, unknown>} payload
 */
function persistRoomEventFromPayload(room, payload) {
  if (!payload || typeof payload !== 'object') return;
  const t = typeof payload.type === 'string' ? payload.type : '';
  const roomEventSeq = Number(payload.roomEventSeq);
  const source =
    Number.isSafeInteger(roomEventSeq) && roomEventSeq > 0
      ? { eventStreamId: room.eventStreamId, roomEventSeq }
      : {};
  if (t === 'sdkEvent' && payload.event && typeof payload.event === 'object') {
    persistRoomEvent(room, { kind: 'sdk', event: payload.event, ...source });
  } else if (t === 'sdkRunFinished') {
    const status = typeof payload.status === 'string' ? payload.status : '';
    persistRoomEvent(
      room,
      { kind: 'meta', variant: 'runFinished', payload: status, ...source },
      true
    );
  } else if (t === 'sdkQueued') {
    // The queue is transient — do not persist it (localUser is created on send).
  } else if (t === 'sdkQueueRemoved') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (text) {
      persistRoomEvent(
        room,
        { kind: 'meta', variant: 'queueRemoved', payload: text, ...source },
        true
      );
    }
  } else if (t === 'sdkMode') {
    const mode = payload.mode === 'plan' || payload.mode === 'agent' ? payload.mode : '';
    if (mode) {
      persistRoomEvent(room, { kind: 'meta', variant: 'mode', payload: mode, ...source }, true);
    }
  } else if (t === 'sdkError') {
    const code = typeof payload.code === 'string' ? payload.code.trim() : '';
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const detail = message || code;
    if (detail) {
      persistRoomEvent(
        room,
        { kind: 'meta', variant: 'error', payload: detail, ...source },
        true
      );
    }
  }
  // hello / sdkAgent / sdkPromptStarted / sdkBusy are not persisted
  // (localUser is persisted separately in runPrompt; the rest is transient UI).
}

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 * @param {{ log?: boolean, priority?: 'critical' | 'normal' }} [options]
 */
function broadcastRoom(room, payload, options = {}) {
  const outgoingPayload = options.log === false ? payload : pushRoomEvent(room, payload);
  broadcast(room, outgoingPayload, { priority: options.priority });
  if (room?.sessionKey) {
    publishSdkRoomEvent(room.sessionKey, outgoingPayload);
  }
}

function refreshSdkRoomOwnerLease(room) {
  if (!room?.sessionKey || isSdkRemoteRoomStub(room)) return;
  void refreshSdkRoomOwner(room.sessionKey, buildSdkRoomOwnerMeta(room));
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {any} room
 */
function sendRemoteRoomStubError(ws, room) {
  if (!ws || ws.readyState !== 1 || !room) return;
  ws.send(
    JSON.stringify({
      type: 'sdkError',
      code: 'remote_room_stub',
      message:
        'This chat run is owned by another server instance. Use sticky routing or wait for owner failover.',
      ownerInstanceId: room.ownerInstanceId || null,
    })
  );
}

/**
 * @param {string} sessionKey
 * @param {import('../persist/chats-persist.js').ChatEntry} chat
 * @param {any} stubRoom
 * @param {{
 *   cwd: string,
 *   modelId: string,
 *   modelSelection: unknown,
 *   apiKey: string,
 *   sdkMode: 'plan' | 'agent',
 *   onRunFinished?: ((...args: unknown[]) => void) | null,
 * }} deps
 * @returns {any}
 */
function upgradeRemoteStubToLocalRoom(sessionKey, chat, stubRoom, deps) {
  const room = {
    clients: stubRoom.clients,
    agent: null,
    cwd: deps.cwd,
    modelId: deps.modelId,
    modelSelection: deps.modelSelection,
    apiKey: deps.apiKey,
    sdkMode: deps.sdkMode,
    busy: false,
    currentRun: null,
    pendingPrompts: Array.isArray(stubRoom.pendingPrompts) ? stubRoom.pendingPrompts : [],
    eventStreamId: stubRoom.eventStreamId || randomUUID(),
    eventSeq: Number.isFinite(stubRoom.eventSeq) ? stubRoom.eventSeq : 0,
    eventLog: Array.isArray(stubRoom.eventLog) ? stubRoom.eventLog : [],
    sessionKey,
    chatId: chat.id || stubRoom.chatId || '',
    chatTitle: chat.title || chat.id || stubRoom.chatTitle || '',
    onRunFinished: deps.onRunFinished || null,
    _persistBuf: [],
    _persistTimer: null,
    _agentConnectPromise: null,
    _agentModelId: null,
    _agentMode: null,
    lastRunTimings: null,
    lastEventAt: stubRoom.lastEventAt || null,
    _lastRequestedModelId:
      typeof stubRoom._lastRequestedModelId === 'string' ? stubRoom._lastRequestedModelId : null,
    _lastEffectiveModelId:
      typeof stubRoom._lastEffectiveModelId === 'string' ? stubRoom._lastEffectiveModelId : null,
    _strictModelRequested: stubRoom._strictModelRequested === true,
    _lastModelFallback:
      stubRoom._lastModelFallback && typeof stubRoom._lastModelFallback === 'object'
        ? { ...stubRoom._lastModelFallback }
        : null,
  };
  sdkRooms.set(sessionKey, room);
  void registerSdkRoomOwner(sessionKey, buildSdkRoomOwnerMeta(room));
  return room;
}

/**
 * Applies a sequenced room event received from another Node instance (Redis bus).
 *
 * @param {string} sessionKey
 * @param {Record<string, unknown>} payload
 */
function ingestRemoteRoomEvent(sessionKey, payload) {
  if (!sessionKey || !payload || typeof payload !== 'object') return;
  let room = sdkRooms.get(sessionKey);
  if (room && !isSdkRemoteRoomStub(room)) return;
  if (!room) {
    const chat = getChatByCursorSessionId(sessionKey);
    if (!chat || chat.agentTransport !== 'sdk') return;
    const cwd = resolveSdkCwdForChat(chat, () => '') || '';
    room = createSdkRemoteRoomStub(
      sessionKey,
      chat,
      {
        instanceId: null,
        eventStreamId:
          typeof payload.eventStreamId === 'string' ? payload.eventStreamId : null,
        eventSeq: 0,
        busy: false,
      },
      {
        cwd,
        modelId: normalizeCatalogModelValue(chat.model) || 'auto',
        modelSelection: resolveSdkModelSelection(normalizeCatalogModelValue(chat.model) || 'auto'),
        apiKey: getEffectiveCursorApiKey() || '',
        sdkMode: normalizeSdkMode(chat.sdkMode),
        onRunFinished: null,
      }
    );
    sdkRooms.set(sessionKey, room);
  }
  applySequencedRemoteRoomEvent(room, payload, {
    roomEventLogMax: ROOM_EVENT_LOG_MAX,
    broadcast: (targetRoom, outgoingPayload) =>
      broadcast(targetRoom, outgoingPayload, {
        priority: resolveBroadcastPriority(outgoingPayload),
      }),
    persist: persistRoomEventFromPayload,
  });
}

/**
 * Initializes optional Redis pub-sub for multi-instance SDK rooms.
 *
 * @returns {Promise<{ mode: 'local' | 'redis', error?: string }>}
 */
export async function initSdkRoomTransport() {
  return initSdkRoomBus({ onRemoteEvent: ingestRemoteRoomEvent });
}

export { getSdkRoomRegistryMode } from './sdk-room-registry.js';

/**
 * Sends event-log replay in paced batches to avoid reconnect spikes.
 *
 * @param {any} room
 * @param {import('ws').WebSocket} ws
 */
function scheduleEventLogReplay(room, ws) {
  if (!room || !ws) return;
  cancelWsReplayBatch(ws);
  const entries = Array.isArray(room.eventLog) ? room.eventLog : [];
  scheduleSdkWsEventLogReplay({
    entries,
    send: (payload) => {
      if (ws.readyState !== 1) {
        cancelWsReplayBatch(ws);
        return;
      }
      ws.send(JSON.stringify(payload));
    },
    setTimer: (fn, delayMs) => {
      if (ws.readyState !== 1) {
        cancelWsReplayBatch(ws);
        return;
      }
      ws._replayBatchTimer = setTimeout(fn, delayMs);
    },
  });
}

/**
 * @param {import('ws').WebSocket} ws
 */
function cancelWsReplayBatch(ws) {
  if (!ws?._replayBatchTimer) return;
  clearTimeout(ws._replayBatchTimer);
  ws._replayBatchTimer = null;
}

/**
 * @param {any} room
 */
function ensureRoomStateHeartbeat(room) {
  if (!room || room._roomStateHeartbeatTimer) return;
  room._roomStateHeartbeatTimer = setInterval(() => {
    if (!room.clients?.size) {
      stopRoomStateHeartbeat(room);
      return;
    }
    broadcastRoom(room, buildSdkRoomStatePayload(room), { log: false, priority: 'normal' });
    refreshSdkRoomOwnerLease(room);
  }, ROOM_STATE_HEARTBEAT_INTERVAL_MS);
}

/**
 * @param {any} room
 */
function stopRoomStateHeartbeat(room) {
  if (!room?._roomStateHeartbeatTimer) return;
  clearInterval(room._roomStateHeartbeatTimer);
  room._roomStateHeartbeatTimer = null;
}

/**
 * @param {any} room
 */
function sendSdkRoomState(room) {
  if (!room?.clients?.size) return;
  broadcastRoom(room, buildSdkRoomStatePayload(room), { log: false, priority: 'normal' });
}

/**
 * Optional notifier (PWA push) called after an agent run finishes.
 * No onRunFinished means no-op (guard clause).
 */
function notifyRunFinished(room, runId, status) {
  if (!room || typeof room.onRunFinished !== 'function') return;
  try {
    room.onRunFinished({
      chatId: room.chatId || '',
      chatTitle: room.chatTitle || '',
      sessionKey: room.sessionKey || '',
      runId: runId || '',
      status: String(status || ''),
      sdkMode: room.sdkMode || '',
      room,
    });
  } catch {
    // notifier never breaks the run
  }
}

const SDK_RUN_PROGRESS_INTERVAL_MS = 15000;
const SDK_RUN_STREAM_POLL_INTERVAL_MS = 5000;

/**
 * @returns {number}
 */
function resolveRoomSdkRunIdleTimeoutMs() {
  const configuredIdleTimeoutMs = resolveConfiguredSdkRunIdleTimeoutMs(
    loadSettings().sdkRunIdleTimeoutSeconds
  );
  const envIdleTimeoutMs = readEnvAlias({
    current: 'CRETLI_SDK_RUN_IDLE_TIMEOUT_MS',
    legacy: 'CURSOR_REMOTE_SDK_RUN_IDLE_TIMEOUT_MS',
  });
  return resolveSdkRunIdleTimeoutMs(
    envIdleTimeoutMs,
    configuredIdleTimeoutMs
  );
}

/**
 * @param {any} room
 */
function stopSetupProgressReporter(room) {
  if (!room?._setupProgressTimer) return;
  clearInterval(room._setupProgressTimer);
  room._setupProgressTimer = null;
}

/**
 * @param {any} room
 * @param {(payload: Record<string, unknown>) => void} broadcast
 * @param {number} setupTimeoutMs
 */
function startSetupProgressReporter(room, broadcast, idleBudgetMs) {
  stopSetupProgressReporter(room);
  const recoveryGraceEnv = readEnvAlias({
    current: 'CRETLI_SDK_RUN_AUTO_RECOVERY_GRACE_MS',
    legacy: 'CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY_GRACE_MS',
  });
  const recoveryGraceMs = resolveSdkRunAutoRecoveryGraceMs(
    recoveryGraceEnv
  );
  room._setupProgressTimer = setInterval(() => {
    if (!room?.busy || room.currentRun) {
      stopSetupProgressReporter(room);
      return;
    }
    const settings = loadSettings();
    const startedAt = Number(room._setupStartedAt);
    const idleForMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
    const overBudget = idleForMs >= idleBudgetMs;
    broadcast({
      type: 'sdkRunProgress',
      phase: overBudget ? 'setup_past_budget' : room._setupPhase || 'setup',
      idleForMs,
      remainingMs: overBudget ? 0 : Math.max(0, idleBudgetMs - idleForMs),
      timeoutMs: idleBudgetMs,
      overBudget,
    });
    if (shouldTriggerStuckRunRecovery(idleForMs, idleBudgetMs, recoveryGraceMs, settings)) {
      room._stuckRecoveryTriggered = true;
      if (room._setupAbort && typeof room._setupAbort.abort === 'function') {
        room._setupAbort.abort();
      }
    }
  }, SDK_RUN_SETUP_PROGRESS_INTERVAL_MS);
}

/**
 * @param {any} room
 */
function resetAgentAfterSetupFailure(room) {
  if (!room?.agent) return;
  try {
    room.agent.close();
  } catch {
    // Ignore and continue with a fresh agent on retry.
  }
  room.agent = null;
  room._agentModelId = null;
  room._agentMode = null;
}

/**
 * Resume keeps the same Cursor agent id; after a model change that agent may still
 * have an active run bound to the previous model.
 *
 * @param {any} room
 * @param {string} desiredModelId
 * @returns {boolean}
 */
export function shouldSkipSdkAgentResumeForModelChange(room, desiredModelId) {
  const previousModelId = room?._agentModelId;
  if (previousModelId == null || previousModelId === '') return false;
  return previousModelId !== desiredModelId;
}

/**
 * @param {any} room
 * @param {string} sessionKey
 */
function clearSdkAgentBinding(room, sessionKey) {
  if (room?.agent) {
    try {
      room.agent.close();
    } catch {
      // Ignore and continue with a fresh agent.
    }
    room.agent = null;
  }
  room._agentModelId = null;
  room._agentMode = null;
  const currentChat = getChatByCursorSessionId(sessionKey);
  if (currentChat?.id) {
    setChatSdkAgentId(currentChat.id, null);
  }
}

/**
 * Keeps in-memory SDK room model in sync after PATCH /api/chats/:id.
 *
 * @param {string} sessionKey
 * @param {string | undefined | null} modelValue
 */
export function syncSdkRoomModelFromChat(sessionKey, modelValue) {
  if (!sessionKey) return;
  const room = sdkRooms.get(sessionKey);
  if (!room || isSdkRemoteRoomStub(room)) return;
  const normalized = normalizeCatalogModelValue(modelValue) || 'auto';
  const modelChanged = room.modelId !== normalized;
  room.modelId = normalized;
  room.modelSelection = resolveSdkModelSelection(normalized);
  if (!modelChanged || room.busy) return;
  if (shouldSkipSdkAgentResumeForModelChange(room, normalized) || room.agent) {
    clearSdkAgentBinding(room, sessionKey);
  }
}

/**
 * @param {any} room
 * @param {string} sessionKey
 * @param {string} text
 * @param {string | undefined | null} modeOverride
 * @param {number | null} clientSentAt
 * @param {number} idleForMs
 * @param {number} budgetMs
 * @returns {boolean}
 */
function tryScheduleStuckRunRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt, idleForMs, budgetMs) {
  if (!room?._stuckRecoveryTriggered) return false;
  room._stuckRecoveryTriggered = false;
  resetAgentAfterSetupFailure(room);
  const currentChat = getChatByCursorSessionId(sessionKey);
  if (currentChat?.id) {
    setChatSdkAgentId(currentChat.id, null);
  }
  const stuckRetryCount = Number(room._stuckRecoveryRetries) || 0;
  if (shouldRetryStuckRunRecovery(stuckRetryCount)) {
    room._stuckRecoveryRetries = stuckRetryCount + 1;
    const freshChat = getChatByCursorSessionId(sessionKey);
    const retryMode = normalizeSdkMode(modeOverride ?? freshChat?.sdkMode ?? room.sdkMode);
    const retryText = text.trim();
    const retryItem = { text: retryText, mode: retryMode, clientSentAt };
    const retryUiText = resolvePromptUiText(retryText, room._activePromptUiText);
    if (retryUiText && retryUiText !== retryText) retryItem.displayText = retryUiText;
    room.pendingPrompts.unshift(retryItem);
    broadcastRoom(room, {
      type: 'sdkBusy',
      message: buildStuckRunRecoveryRetryMessage(room._stuckRecoveryRetries),
    });
    return true;
  }
  room._stuckRecoveryRetries = 0;
  broadcastRoom(room, {
    type: 'sdkError',
    code: 'run_stuck_auto_recovery',
    message: buildStuckRunRecoveryMessage(idleForMs, budgetMs),
  });
  return true;
}

/**
 * @param {any} room
 */
function clearCurrentRunDiagnostics(room) {
  if (!room) return;
  room._currentRunStatusError = '';
  room._currentRunAuthError = false;
}

/**
 * @param {any} room
 */
function resetSdkAutomaticRetryCounters(room) {
  if (!room) return;
  room._authRecoveryRetries = 0;
  room._rateLimitRecoveryRetries = 0;
  room._setupFailureRetries = 0;
}

/**
 * @param {any} room
 * @param {{
 *   text: string,
 *   mode: string,
 *   clientSentAt: number | null,
 *   scheduleAfterMs?: number,
 * }} input
 */
function unshiftAutomaticPromptRetry(room, input) {
  const text = input.text.trim();
  const uiText = resolvePromptUiText(text, input.displayText || room._activePromptUiText);
  const item = {
    text,
    mode: input.mode,
    clientSentAt: input.clientSentAt,
    scheduleAfterMs: Math.max(0, Number(input.scheduleAfterMs) || 0),
  };
  if (uiText && uiText !== text) item.displayText = uiText;
  room.pendingPrompts.unshift(item);
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function broadcastSdkRateLimitError(room, message) {
  if (!isSdkRateLimitError(message)) return false;
  broadcastRoom(room, {
    type: 'sdkError',
    code: 'cursor_rate_limit',
    message: String(message || '').trim() || 'Cursor API rate limit exceeded. Wait a minute and try again.',
  });
  return true;
}

/**
 * @param {any} room
 * @param {unknown} event
 */
function captureSdkStreamStatusError(room, event) {
  const message = extractSdkStreamStatusError(event);
  if (!message || !room) return;
  room._currentRunStatusError = message;
  if (isSdkAuthenticationError(message)) {
    room._currentRunAuthError = true;
  }
}

/**
 * @param {any} room
 * @param {unknown} runResult
 * @returns {string}
 */
function resolveCurrentRunResult(room, runResult) {
  const rawResult = typeof runResult === 'string' ? runResult.trim() : '';
  if (rawResult) return rawResult;
  const statusError =
    typeof room?._currentRunStatusError === 'string' ? room._currentRunStatusError.trim() : '';
  return statusError;
}

/**
 * @param {any} room
 * @param {{
 *   runId: string,
 *   status: string,
 *   result?: unknown,
 *   remaining: number,
 * }} input
 * @returns {{ payload: Record<string, unknown>, isAuthError: boolean }}
 */
function buildSdkRunFinishedPayload(room, input) {
  const resolvedResult = resolveCurrentRunResult(room, input.result);
  const isAuthError =
    room?._currentRunAuthError === true || isSdkAuthenticationError(resolvedResult);
  const isRateLimitError = isSdkRateLimitError(resolvedResult);
  const payload = {
    type: 'sdkRunFinished',
    runId: input.runId,
    status: input.status,
    result: resolvedResult,
    remaining: input.remaining,
  };
  if (isAuthError) {
    payload.lastErrorCode = 'cursor_auth_error';
    payload.lastErrorMessage =
      resolvedResult || 'Authentication error. Update the API key in Settings → Cursor API.';
  } else if (isRateLimitError && isSdkRunFailureStatus(input.status)) {
    payload.lastErrorCode = 'cursor_rate_limit';
    payload.lastErrorMessage =
      resolvedResult || 'Cursor API usage limit exceeded. Wait a minute and try again.';
  } else if (String(input.status || '').trim().toLowerCase() === 'cancelled' && !resolvedResult) {
    payload.lastErrorCode = 'run_cancelled';
  } else if (resolvedResult && isSdkRunFailureStatus(input.status)) {
    payload.lastErrorMessage = resolvedResult;
  }
  return { payload, isAuthError, isRateLimitError };
}

/**
 * @param {any} room
 * @param {string} sessionKey
 * @param {string} text
 * @param {string | undefined | null} modeOverride
 * @param {number | null} clientSentAt
 * @returns {boolean}
 */
function tryScheduleAuthRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt) {
  const retryCount = Number(room?._authRecoveryRetries) || 0;
  if (!shouldRetrySdkAuthRecovery(retryCount)) {
    return false;
  }
  room._authRecoveryRetries = retryCount + 1;
  room.apiKey = getEffectiveCursorApiKey() || room.apiKey;
  clearSdkAgentBinding(room, sessionKey);
  resetAgentAfterSetupFailure(room);
  const freshChat = getChatByCursorSessionId(sessionKey);
  const retryMode = normalizeSdkMode(modeOverride ?? freshChat?.sdkMode ?? room.sdkMode);
  unshiftAutomaticPromptRetry(room, {
    text,
    mode: retryMode,
    clientSentAt,
    scheduleAfterMs: SDK_AUTH_RECOVERY_RETRY_DELAY_MS,
  });
  broadcastRoom(room, {
    type: 'sdkBusy',
    message: buildSdkAuthRecoveryRetryMessage(room._authRecoveryRetries),
  });
  return true;
}

/**
 * @param {any} room
 * @param {string} sessionKey
 * @param {string} text
 * @param {string | undefined | null} modeOverride
 * @param {number | null} clientSentAt
 * @returns {boolean}
 */
function tryScheduleRateLimitRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt) {
  const retryCount = Number(room?._rateLimitRecoveryRetries) || 0;
  if (!shouldRetrySdkRateLimitRecovery(retryCount)) {
    return false;
  }
  room._rateLimitRecoveryRetries = retryCount + 1;
  const freshChat = getChatByCursorSessionId(sessionKey);
  const retryMode = normalizeSdkMode(modeOverride ?? freshChat?.sdkMode ?? room.sdkMode);
  unshiftAutomaticPromptRetry(room, {
    text,
    mode: retryMode,
    clientSentAt,
    scheduleAfterMs: computeRateLimitRetryDelayMs(room._rateLimitRecoveryRetries),
  });
  broadcastRoom(room, {
    type: 'sdkBusy',
    message: buildSdkRateLimitRecoveryRetryMessage(room._rateLimitRecoveryRetries),
  });
  return true;
}

/**
 * @param {any} room
 * @param {string} sessionKey
 * @param {string} text
 * @param {string | undefined | null} modeOverride
 * @param {number | null} clientSentAt
 * @param {{
 *   runId: string,
 *   status: string,
 *   result?: unknown,
 *   remaining: number,
 * }} input
 * @returns {boolean} true when auth retry was scheduled and run-finished should be skipped
 */
function finishSdkRun(room, sessionKey, text, modeOverride, clientSentAt, input) {
  const { payload, isAuthError, isRateLimitError } = buildSdkRunFinishedPayload(room, input);
  if (
    isAuthError &&
    isSdkRunFailureStatus(input.status) &&
    tryScheduleAuthRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt)
  ) {
    clearCurrentRunDiagnostics(room);
    return true;
  }
  if (
    isRateLimitError &&
    isSdkRunFailureStatus(input.status) &&
    tryScheduleRateLimitRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt)
  ) {
    clearCurrentRunDiagnostics(room);
    return true;
  }
  if (!isAuthError && !isRateLimitError && !isSdkRunFailureStatus(input.status)) {
    resetSdkAutomaticRetryCounters(room);
  }
  broadcastRoom(room, payload);
  notifyRunFinished(room, input.runId, input.status);
  if (isAuthError && isSdkRunFailureStatus(input.status)) {
    broadcastRoom(room, {
      type: 'sdkError',
      code: 'cursor_auth_error',
      message:
        payload.lastErrorMessage ||
        'Authentication error. Update the API key in Settings → Cursor API.',
    });
  } else if (isRateLimitError && isSdkRunFailureStatus(input.status)) {
    broadcastSdkRateLimitError(room, payload.lastErrorMessage || payload.result);
  }
  clearCurrentRunDiagnostics(room);
  return false;
}

/**
 * @param {string | undefined | null} model
 * @returns {string}
 */
export function resolveSdkModelId(model) {
  return resolveModelSelection(model, DEFAULT_SDK_MODEL_ID).id;
}

/**
 * @param {string | undefined | null} model
 * @returns {{ id: string, params?: Array<{ id: string, value: string }> }}
 */
export function resolveSdkModelSelection(model) {
  return resolveModelSelection(model, DEFAULT_SDK_MODEL_ID);
}

/**
 * Strict fast scenarios should never auto-fallback to another model.
 *
 * @param {string | undefined | null} model
 * @returns {boolean}
 */
function isStrictFastSdkModel(model) {
  const normalizedModel = normalizeCatalogModelValue(model) || '';
  return normalizedModel.includes('::fast=true');
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnsupportedSdkModelError(err) {
  const message =
    err && typeof err === 'object' && 'message' in err ? String(err.message || '') : String(err || '');
  return message.includes('Cannot use this model:');
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAgentBusyError(err) {
  const message =
    err && typeof err === 'object' && 'message' in err ? String(err.message || '') : String(err || '');
  const lower = message.toLowerCase();
  if (!lower) return false;
  return (
    lower.includes('already has active run') ||
    lower.includes('agent is busy') ||
    lower.includes('agent_busy') ||
    (lower.includes('active run') && lower.includes('agent'))
  );
}

/**
 * Close the SDK room (no PTY — with no clients we release the agent in Node).
 *
 * @param {string} sessionKey - SDK chat cursorSessionId
 */
export function disposeSdkRoom(sessionKey) {
  if (!sessionKey) {
    return;
  }
  const room = sdkRooms.get(sessionKey);
  if (!room) {
    return;
  }
  if (room._shutdownTimer) {
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }
  notifySdkClientsChatGone(room.clients, msg(null, 'sdk.chatNotFound'));
  room.clients.clear();
  if (room.agent) {
    try {
      room.agent.close();
    } catch {
      // ignore
    }
    room.agent = null;
  }
  room.currentRun = null;
  room.busy = false;
  stopRoomStateHeartbeat(room);
  if (!isSdkRemoteRoomStub(room)) {
    void unregisterSdkRoomOwner(sessionKey);
  }
  sdkRooms.delete(sessionKey);
}

/**
 * Close the room only after the grace period — never during an active run.
 * A page refresh then does not kill a live stream (after reconnect, broadcast
 * continues to the new client).
 *
 * @param {string} sessionKey
 */
function scheduleRoomShutdown(sessionKey) {
  const room = sdkRooms.get(sessionKey);
  if (!room) {
    return;
  }
  if (room._shutdownTimer) {
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }
  room._shutdownTimer = setTimeout(() => {
    const r = sdkRooms.get(sessionKey);
    if (!r) {
      return;
    }
    r._shutdownTimer = null;
    if (r.clients.size > 0) {
      return;
    }
    if (r.busy) {
      // The run is still active — defer close until it finishes.
      scheduleRoomShutdown(sessionKey);
      return;
    }
    if (r.agent) {
      try {
        r.agent.close();
      } catch {
        // ignore
      }
      r.agent = null;
    }
    r.currentRun = null;
    flushPersistBuffer(r);
    stopRoomStateHeartbeat(r);
    if (!isSdkRemoteRoomStub(r)) {
      void unregisterSdkRoomOwner(sessionKey);
    }
    sdkRooms.delete(sessionKey);
  }, ROOM_EMPTY_GRACE_MS);
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @param {{ workspaceDirForAgent: (p: string | null) => string }} deps
 */
export async function handleAgentSdkWebSocket(ws, sessionKey, deps) {
  const apiKey = getEffectiveCursorApiKey();
  if (!apiKey) {
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'sdkError',
          code: 'missing_api_key',
          message:
            msg(null, 'sdk.noApiKey'),
        })
      );
    }
    ws.close();
    return;
  }

  const chat = getChatByCursorSessionId(sessionKey);
  if (!chat) {
    sendSdkChatNotFoundAndClose(ws, msg(null, 'sdk.chatNotFound'));
    return;
  }
  if (chat.agentTransport !== 'sdk') {
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'sdkError',
          code: 'invalid_session',
          message: msg(null, 'sdk.chatNotFound'),
        })
      );
    }
    ws.close();
    return;
  }

  const cwd = resolveSdkCwdForChat(chat, deps.workspaceDirForAgent);
  if (!cwd) {
    if (ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'sdkError',
          code: 'no_cwd',
          message: msg(null, 'sdk.noWorkspaceDir'),
        })
      );
    }
    ws.close();
    return;
  }

  const storedModelValue = normalizeCatalogModelValue(chat.model) || 'auto';
  const modelSelection = resolveSdkModelSelection(storedModelValue);
  const sdkMode = normalizeSdkMode(chat.sdkMode);
  const roomDeps = {
    cwd,
    modelId: storedModelValue,
    modelSelection,
    apiKey,
    sdkMode,
    onRunFinished: typeof deps.onRunFinished === 'function' ? deps.onRunFinished : null,
    todoSyncDataDir: typeof deps.todoSyncDataDir === 'string' ? deps.todoSyncDataDir : '',
  };

  let room = sdkRooms.get(sessionKey);
  if (!room) {
    const owner = await lookupSdkRoomOwner(sessionKey);
    const isRemoteOwned =
      owner?.instanceId && owner.instanceId !== getServerInstanceId();
    if (isRemoteOwned) {
      room = createSdkRemoteRoomStub(sessionKey, chat, owner, roomDeps);
    } else {
      room = {
        clients: new Set(),
        agent: null,
        cwd,
        modelId: storedModelValue,
        modelSelection,
        apiKey,
        sdkMode,
        busy: false,
        currentRun: null,
        pendingPrompts: [],
        eventStreamId: randomUUID(),
        eventSeq: 0,
        eventLog: [],
        sessionKey,
        chatId: chat.id || '',
        chatTitle: chat.title || chat.id || '',
        onRunFinished: roomDeps.onRunFinished,
        _todoSyncDataDir: roomDeps.todoSyncDataDir,
        _persistBuf: [],
        _persistTimer: null,
        _agentConnectPromise: null,
        _agentModelId: null,
        _agentMode: null,
        lastRunTimings: null,
        _lastRequestedModelId: null,
        _lastEffectiveModelId: null,
        _strictModelRequested: false,
        _lastModelFallback: null,
      };
      void registerSdkRoomOwner(sessionKey, buildSdkRoomOwnerMeta(room));
    }
    sdkRooms.set(sessionKey, room);
  } else if (isSdkRemoteRoomStub(room)) {
    room.cwd = cwd;
    room.modelId = storedModelValue;
    room.modelSelection = modelSelection;
    room.apiKey = apiKey;
    room.sdkMode = sdkMode;
    if (typeof room._lastRequestedModelId === 'undefined') room._lastRequestedModelId = null;
    if (typeof room._lastEffectiveModelId === 'undefined') room._lastEffectiveModelId = null;
    if (typeof room._strictModelRequested === 'undefined') room._strictModelRequested = false;
    if (typeof room._lastModelFallback === 'undefined') room._lastModelFallback = null;
    if (!room.onRunFinished && roomDeps.onRunFinished) {
      room.onRunFinished = roomDeps.onRunFinished;
    }
  } else {
    room.cwd = cwd;
    room.modelId = storedModelValue;
    room.modelSelection = modelSelection;
    room.apiKey = apiKey;
    room.sdkMode = sdkMode;
    if (!room.sessionKey) room.sessionKey = sessionKey;
    if (!room.chatId && chat.id) room.chatId = chat.id;
    if (!room.chatTitle && chat.title) room.chatTitle = chat.title;
    if (!room.onRunFinished && roomDeps.onRunFinished) {
      room.onRunFinished = roomDeps.onRunFinished;
    }
    if (typeof room._lastRequestedModelId === 'undefined') room._lastRequestedModelId = null;
    if (typeof room._lastEffectiveModelId === 'undefined') room._lastEffectiveModelId = null;
    if (typeof room._strictModelRequested === 'undefined') room._strictModelRequested = false;
    if (typeof room._lastModelFallback === 'undefined') room._lastModelFallback = null;
    void refreshSdkRoomOwner(sessionKey, buildSdkRoomOwnerMeta(room));
  }
  if (!Array.isArray(room.pendingPrompts)) {
    room.pendingPrompts = [];
  }

  if (room._shutdownTimer) {
    clearTimeout(room._shutdownTimer);
    room._shutdownTimer = null;
  }
  room.clients.add(ws);
  ensureRoomStateHeartbeat(room);

  /**
   * Upgrades a remote stub when owner lease expired, or rejects mutating ops.
   *
   * @returns {Promise<boolean>}
   */
  async function ensureRoomCanMutate() {
    if (!isSdkRemoteRoomStub(room)) return true;
    const owner = await lookupSdkRoomOwner(sessionKey);
    if (owner?.instanceId && owner.instanceId !== getServerInstanceId()) {
      sendRemoteRoomStubError(ws, room);
      return false;
    }
    room = upgradeRemoteStubToLocalRoom(sessionKey, chat, room, roomDeps);
    ensureRoomStateHeartbeat(room);
    return true;
  }

  /**
   * Connect the agent once per room. A shared Promise prevents a double
   * create/resume when a prompt arrives while the connection is warming up.
   *
   * @param {'plan' | 'agent'} mode
   * @returns {Promise<any>}
   */
  async function connectAgent(mode) {
    const desiredModelId = room.modelId;
    const desiredModelSelection = room.modelSelection || resolveSdkModelSelection(desiredModelId);
    if (
      room.agent &&
      room._agentModelId === desiredModelId &&
      room._agentMode === mode
    ) {
      return room.agent;
    }
    if (room.agent) {
      try {
        room.agent.close();
      } catch {
        // Kontynuuj z agentem o aktualnej konfiguracji.
      }
      room.agent = null;
    }
    if (room._agentConnectPromise) {
      await room._agentConnectPromise;
      return connectAgent(mode);
    }

    const connectPromise = (async () => {
      const sdkModule = await loadSdkModule();
      const Agent = sdkModule.Agent;
      ensureSessionLocalStore(room, sessionKey, sdkModule.JsonlLocalAgentStore);
      const cwdList = resolveSdkCwdList(room.cwd);
      const localOptions = {
        // The SDK requires a single primary path here; extra roots go to `dirs`.
        cwd: cwdList[0] || room.cwd,
        // Load ambient project rules/skills from each workspace root (.cursor/*).
        settingSources: ['project'],
        customTools: buildSdkCustomTools(sessionKey, mode),
      };
      if (cwdList.length > 1) {
        localOptions.dirs = cwdList;
      }
      if (room.localStore) {
        localOptions.store = room.localStore;
      }
      const currentChat = getChatByCursorSessionId(sessionKey) || chat;
      const skipResumeForModelChange = shouldSkipSdkAgentResumeForModelChange(room, desiredModelId);
      if (skipResumeForModelChange) {
        clearSdkAgentBinding(room, sessionKey);
      }
      const resumeOpts = {
        apiKey: room.apiKey,
        model: desiredModelSelection,
        local: localOptions,
        mode,
        ...resolveSdkPlanCreateOptions(mode),
      };
      const persistedId =
        !skipResumeForModelChange &&
        currentChat?.sdkAgentId &&
        String(currentChat.sdkAgentId).trim()
          ? String(currentChat.sdkAgentId).trim()
          : '';

      if (persistedId) {
        try {
          room.agent = await Agent.resume(persistedId, resumeOpts);
          room._agentModelId = desiredModelId;
          room._agentMode = mode;
          room._lastEffectiveModelId = desiredModelId;
          return room.agent;
        } catch {
          // The guard clause below will create a new agent.
        }
      }

      room.agent = await Agent.create({
        apiKey: room.apiKey,
        model: desiredModelSelection,
        local: localOptions,
        mode,
        ...resolveSdkPlanCreateOptions(mode),
      });
      room._agentModelId = desiredModelId;
      room._agentMode = mode;
      room._lastEffectiveModelId = desiredModelId;
      if (currentChat?.id) {
        setChatSdkAgentId(currentChat.id, room.agent.agentId);
      }
      return room.agent;
    })();
    room._agentConnectPromise = connectPromise;

    try {
      return await connectPromise;
    } finally {
      if (room._agentConnectPromise === connectPromise) {
        room._agentConnectPromise = null;
      }
    }
  }

  if (ws.readyState === 1) {
    const runOutcome = readSdkRoomRunOutcome(room);
    ws.send(
      JSON.stringify({
        type: 'hello',
        transport: 'cursor-sdk',
        sessionKey,
        agentId: room.agent?.agentId || null,
        modelId: room.modelId,
        sdkMode: room.sdkMode,
        eventStreamId: room.eventStreamId,
        replayTagged: true,
        busy: !!room.busy,
        hasCurrentRun: !!room.currentRun,
        remoteStub: isSdkRemoteRoomStub(room),
        ownerInstanceId: room.ownerInstanceId || null,
        queuedPrompts: room.pendingPrompts.map((item) => resolveQueuedPromptUiText(item)),
        lastRunId: runOutcome.lastRunId || null,
        lastRunStatus: runOutcome.lastRunStatus || null,
        lastRunStatusNormalized: runOutcome.lastRunStatusNormalized || null,
        lastErrorCode: runOutcome.lastErrorCode || null,
        lastErrorMessage: runOutcome.lastErrorMessage || null,
        requestedModelId: room._lastRequestedModelId || room.modelId || null,
        effectiveModelId: room._lastEffectiveModelId || room._agentModelId || room.modelId || null,
        strictModelRequested: room._strictModelRequested === true,
        strictModelActive: isStrictFastSdkModel(room._lastRequestedModelId || room.modelId),
        lastModelFallback:
          room._lastModelFallback && typeof room._lastModelFallback === 'object'
            ? room._lastModelFallback
            : null,
      })
    );
    if (Array.isArray(room.eventLog) && room.eventLog.length > 0) {
      scheduleEventLogReplay(room, ws);
    }
    sendSdkRoomState(room);
  }

  /**
   * @param {string} text
   * @param {string | undefined | null} [modeOverride]
   * @param {number | null} [clientSentAt]
   * @param {string} [displayText]
   */
  function enqueuePrompt(text, modeOverride, clientSentAt = null, displayText = '') {
    const freshChat = getChatByCursorSessionId(sessionKey);
    const mode = normalizeSdkMode(modeOverride ?? freshChat?.sdkMode ?? room.sdkMode);
    const trimmed = text.trim();
    if (!trimmed) return;
    const uiText = resolvePromptUiText(trimmed, displayText);
    const item = { text: trimmed, mode, clientSentAt };
    if (uiText && uiText !== trimmed) item.displayText = uiText;
    room.pendingPrompts.push(item);
    broadcastRoom(room, {
      type: 'sdkQueued',
      position: room.pendingPrompts.length,
      text: uiText || trimmed,
    });
  }

  /**
   * @param {string} text
   * @param {string | undefined | null} [modeOverride]
   * @param {boolean} [fromQueue]
   * @param {number | null} [clientSentAt]
   * @param {string} [displayText]
   */
  async function runPrompt(text, modeOverride, fromQueue = false, clientSentAt = null, displayText = '') {
    if (!text.trim()) {
      return;
    }
    if (!(await ensureRoomCanMutate())) {
      return;
    }
    if (room.busy) {
      enqueuePrompt(text, modeOverride, clientSentAt, displayText);
      return;
    }
    if (!fromQueue) {
      resetSdkAutomaticRetryCounters(room);
    }

    // Reserve the room before async create/resume/send. Otherwise two quick
    // prompts can both pass the guard and run in parallel.
    room.busy = true;
    refreshSdkRoomOwnerLease(room);
    room._currentRunAssistantText = '';
    room._currentRunPlanMarkdown = '';
    clearCurrentRunDiagnostics(room);
    const setupAbort = new AbortController();
    room._setupAbort = setupAbort;
    const sdkRunIdleTimeoutMs = resolveRoomSdkRunIdleTimeoutMs();
    const requestReceivedAt = Date.now();
    room._setupStartedAt = requestReceivedAt;
    room._setupPhase = 'connecting';
    startSetupProgressReporter(room, (payload) => broadcastRoom(room, payload), sdkRunIdleTimeoutMs);
    const normalizedClientSentAt = Number(clientSentAt);
    const timings = {
      clientSentAt: Number.isFinite(normalizedClientSentAt) ? normalizedClientSentAt : null,
      requestReceivedAt,
      agentReadyAt: null,
      sendResolvedAt: null,
      firstEventAt: null,
      firstAssistantAt: null,
    };
    room.lastRunTimings = timings;
    try {
      const freshChat = getChatByCursorSessionId(sessionKey);
      const mode = normalizeSdkMode(modeOverride ?? freshChat?.sdkMode ?? room.sdkMode);
      const promptText = text.trim();
      const uiText = resolvePromptUiText(promptText, displayText);
      room._activePromptUiText = uiText;
      const modeChanged = room.sdkMode !== mode;
      room.sdkMode = mode;
      if (modeChanged && freshChat?.id) {
        updateChat(freshChat.id, { sdkMode: mode });
        broadcastRoom(room, { type: 'sdkMode', mode });
      }
      // UX: acknowledge send immediately (agent resume/create can take a few seconds).
      broadcastRoom(room, {
        type: 'sdkRunProgress',
        phase: 'started',
        idleForMs: 0,
        remainingMs: null,
        timeoutMs: null,
      });
      room.modelId = normalizeCatalogModelValue(freshChat?.model || room.modelId) || 'auto';
      room.modelSelection = resolveSdkModelSelection(room.modelId);
      room._lastRequestedModelId = room.modelId;
      room._strictModelRequested = isStrictFastSdkModel(room.modelId);
      try {
        await withAbortOnly(connectAgent(mode), setupAbort.signal);
      } catch (err) {
        if (!isUnsupportedSdkModelError(err)) throw err;
        const requestedModelId = room.modelId;
        const fallbackModelValue = 'auto';
        const fallbackModelId = resolveSdkModelId(fallbackModelValue);
        if (!fallbackModelId || fallbackModelId === resolveSdkModelId(room.modelId)) throw err;
        if (room._strictModelRequested === true) {
          room._lastModelFallback = {
            attemptedModelId: requestedModelId,
            fallbackModelId: fallbackModelValue,
            applied: false,
            blockedByStrict: true,
            reason: 'unsupported_model',
            at: Date.now(),
          };
          const strictError = new Error(
            `Strict SDK model "${requestedModelId}" is unavailable. Automatic fallback is disabled.`
          );
          strictError.code = 'strict_model_unsupported';
          throw strictError;
        }
        const previousModelId = room.modelId;
        room.modelId = fallbackModelValue;
        room.modelSelection = resolveSdkModelSelection(fallbackModelValue);
        room._lastRequestedModelId = room.modelId;
        room._strictModelRequested = isStrictFastSdkModel(room.modelId);
        room._lastModelFallback = {
          attemptedModelId: previousModelId,
          fallbackModelId: fallbackModelValue,
          applied: true,
          blockedByStrict: false,
          reason: 'unsupported_model',
          at: Date.now(),
        };
        const currentChat = getChatByCursorSessionId(sessionKey) || chat;
        if (currentChat?.id) updateChat(currentChat.id, { model: fallbackModelValue });
        room.agent = null;
        await withAbortOnly(connectAgent(mode), setupAbort.signal);
        broadcastRoom(room, {
          type: 'sdkModelFallback',
          previousModelId,
          modelId: fallbackModelValue,
        });
      }
      timings.agentReadyAt = Date.now();
      room._stuckRecoveryRetries = 0;
      broadcastRoom(room, {
        type: 'sdkAgent',
        agentId: room.agent.agentId,
        modelId: room.modelId,
        sdkMode: mode,
      });
      broadcastRoom(room, {
        type: 'sdkPromptStarted',
        text: uiText,
        fromQueue: !!fromQueue,
        remaining: room.pendingPrompts.length,
      });
      room._setupPhase = 'preparing';
      // Record goes into the ordered buffer before SDK events. Disk write
      // happens after the run and does not delay agent.send().
      persistRoomEvent(room, {
        kind: 'localUser',
        text: uiText,
        createdAt: new Date(requestReceivedAt).toISOString(),
      });
      const automaticPageContext = buildAutomaticPageContext(sessionKey);
      const sharedRulesContext = buildSharedAlwaysApplyRulesPrompt();
      const chatPlanContext = buildChatPlanPromptContext({
        cwd: room.cwd,
        chatId: room.chatId || chat.id,
      });
      const promptPrefix = [sharedRulesContext, automaticPageContext, chatPlanContext]
        .filter(Boolean)
        .join('\n\n');
      const promptWithPageContext = promptPrefix
        ? `${promptPrefix}\n\n${promptText}`
        : promptText;
      const sdkPrompt = await withAbortOnly(
        buildSdkPromptMessage(promptWithPageContext),
        setupAbort.signal
      );
      let run = null;
      room._setupPhase = 'sending';
      try {
        run = await withAbortOnly(
          room.agent.send(sdkPrompt, {
            mode,
            customTools: buildSdkCustomTools(sessionKey, mode),
          }),
          setupAbort.signal
        );
        timings.sendResolvedAt = Date.now();
      } catch (err) {
        if (!isAgentBusyError(err)) {
          throw err;
        }
        broadcastRoom(room, {
          type: 'sdkBusy',
          message: msg(null, 'sdk.activeRunDetected'),
        });
        clearSdkAgentBinding(room, sessionKey);
        await withAbortOnly(connectAgent(mode), setupAbort.signal);
        run = await withAbortOnly(
          room.agent.send(sdkPrompt, {
            mode,
            customTools: buildSdkCustomTools(sessionKey, mode),
          }),
          setupAbort.signal
        );
        timings.agentReadyAt = timings.agentReadyAt || Date.now();
        timings.sendResolvedAt = Date.now();
      }
      room._setupPhase = null;
      room._setupStartedAt = null;
      stopSetupProgressReporter(room);
      room.currentRun = run;
      if (run?.id && typeof run.id === 'string') {
        room.lastRunId = run.id.trim();
      }
      sendSdkRoomState(room);
      let idleWithoutEventsMs = 0;
      let lastProgressReportMs = 0;
      let sdkEventCount = 0;
      const streamPollTimeoutMs = Math.min(sdkRunIdleTimeoutMs, SDK_RUN_STREAM_POLL_INTERVAL_MS);
      const streamRecoveryGraceEnv = readEnvAlias({
        current: 'CRETLI_SDK_RUN_AUTO_RECOVERY_GRACE_MS',
        legacy: 'CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY_GRACE_MS',
      });
      const recoveryGraceMs = resolveSdkRunAutoRecoveryGraceMs(
        streamRecoveryGraceEnv
      );
      const streamIterator = run.stream()[Symbol.asyncIterator]();
      while (true) {
        const streamResult = await readSdkRunStreamStep(streamIterator, streamPollTimeoutMs);
        if (streamResult.timedOut) {
          idleWithoutEventsMs += streamPollTimeoutMs;
          const overBudget = idleWithoutEventsMs >= sdkRunIdleTimeoutMs;
          if (
            idleWithoutEventsMs >= SDK_RUN_PROGRESS_INTERVAL_MS &&
            idleWithoutEventsMs - lastProgressReportMs >= SDK_RUN_PROGRESS_INTERVAL_MS
          ) {
            broadcastRoom(room, {
              type: 'sdkRunProgress',
              phase: overBudget
                ? 'awaiting_past_budget'
                : sdkEventCount === 0
                  ? 'awaiting_first_event'
                  : 'awaiting_next_event',
              idleForMs: idleWithoutEventsMs,
              remainingMs: overBudget ? 0 : Math.max(0, sdkRunIdleTimeoutMs - idleWithoutEventsMs),
              timeoutMs: sdkRunIdleTimeoutMs,
              overBudget,
            });
            lastProgressReportMs = idleWithoutEventsMs;
          }
          if (shouldTriggerStuckRunRecovery(idleWithoutEventsMs, sdkRunIdleTimeoutMs, recoveryGraceMs, loadSettings())) {
            room._stuckRecoveryTriggered = true;
            if (typeof run.cancel === 'function') {
              await run.cancel();
            }
            throw new Error(buildStuckRunRecoveryMessage(idleWithoutEventsMs, sdkRunIdleTimeoutMs));
          }
          continue;
        }
        if (!streamResult.step || streamResult.step.done) {
          break;
        }
        idleWithoutEventsMs = 0;
        lastProgressReportMs = 0;
        const event = streamResult.step.value;
        sdkEventCount += 1;
        const eventAt = Date.now();
        if (!timings.firstEventAt) {
          timings.firstEventAt = eventAt;
        }
        await waitForRoomBackpressureDrain(room);
        captureSdkStreamStatusError(room, event);
        broadcastRoom(room, { type: 'sdkEvent', event: jsonSafe(event) });
        const planText = extractPlanTextFromSdkEvent(event);
        if (planText) {
          room._currentRunPlanMarkdown = pickRicherPlanMarkdown(room._currentRunPlanMarkdown, planText);
        }
        if (event && typeof event === 'object' && event.type === 'assistant') {
          const assistantText = extractAssistantPlainText(event).trim();
          if (assistantText) {
            room._currentRunAssistantText = accumulateStreamText(
              room._currentRunAssistantText,
              assistantText
            );
          }
        }
        if (
          !timings.firstAssistantAt &&
          event &&
          typeof event === 'object' &&
          event.type === 'assistant'
        ) {
          timings.firstAssistantAt = eventAt;
          broadcastRoom(room, {
            type: 'sdkTtft',
            clientSentAt: timings.clientSentAt,
            requestReceivedAt: timings.requestReceivedAt,
            agentReadyAt: timings.agentReadyAt,
            sendResolvedAt: timings.sendResolvedAt,
            firstEventAt: timings.firstEventAt,
            firstAssistantAt: timings.firstAssistantAt,
            socketToServerMs:
              timings.clientSentAt == null
                ? null
                : timings.requestReceivedAt - timings.clientSentAt,
            agentSetupMs: timings.agentReadyAt - timings.requestReceivedAt,
            sendCallMs: timings.sendResolvedAt - timings.agentReadyAt,
            sendToFirstEventMs: timings.firstEventAt - timings.sendResolvedAt,
            serverTtftMs: timings.firstAssistantAt - timings.requestReceivedAt,
          });
        }
        if (mode === 'plan' && isPlanModeMutatingSdkEvent(event)) {
          broadcastRoom(room, {
            type: 'sdkPlanGuard',
            toolName: getSdkToolCallName(event) || 'unknown',
            message: PLAN_GUARD_USER_MESSAGE,
          });
        }
      }
      finishSdkRun(room, sessionKey, text, modeOverride, clientSentAt, {
        runId: run.id,
        status: run.status,
        result: run.result ?? '',
        remaining: room.pendingPrompts.length,
      });
    } catch (err) {
      if (room.currentRun) {
        if (
          tryScheduleStuckRunRecoveryRetry(
            room,
            sessionKey,
            text,
            modeOverride,
            clientSentAt,
            sdkRunIdleTimeoutMs,
            sdkRunIdleTimeoutMs
          )
        ) {
          return;
        }
        const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
        if (isSdkRateLimitError(message)) {
          if (tryScheduleRateLimitRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt)) {
            clearCurrentRunDiagnostics(room);
            return;
          }
          broadcastSdkRateLimitError(room, message);
          clearCurrentRunDiagnostics(room);
          return;
        }
        broadcastRoom(room, { type: 'sdkError', code: 'run_failed', message });
        const runId =
          room.currentRun &&
          typeof room.currentRun === 'object' &&
          typeof room.currentRun.id === 'string'
            ? room.currentRun.id
            : room.lastRunId || '';
        if (isSdkAuthenticationError(message)) {
          if (tryScheduleAuthRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt)) {
            clearCurrentRunDiagnostics(room);
            return;
          }
          broadcastRoom(room, {
            type: 'sdkError',
            code: 'cursor_auth_error',
            message,
          });
          clearCurrentRunDiagnostics(room);
          return;
        }
        finishSdkRun(room, sessionKey, text, modeOverride, clientSentAt, {
          runId,
          status: 'error',
          result: message,
          remaining: room.pendingPrompts.length,
        });
        return;
      }
      if (
        tryScheduleStuckRunRecoveryRetry(
          room,
          sessionKey,
          text,
          modeOverride,
          clientSentAt,
          Math.max(0, Date.now() - requestReceivedAt),
          sdkRunIdleTimeoutMs
        )
      ) {
        return;
      }
      if (isAgentBusyError(err)) {
        enqueuePrompt(text, modeOverride, clientSentAt, displayText);
        return;
      }
      const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
      const errorCode =
        err && typeof err === 'object' && typeof err.code === 'string'
          ? err.code.trim()
          : '';
      if (errorCode === 'strict_model_unsupported') {
        resetAgentAfterSetupFailure(room);
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'strict_model_unsupported',
          message,
        });
        return;
      }
      const isSetupCancelled = /anulowano przez użytkownika|cancelled by (the )?user/i.test(message);
      if (isSetupCancelled) {
        resetAgentAfterSetupFailure(room);
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'run_setup_cancelled',
          message,
        });
        return;
      }
      resetAgentAfterSetupFailure(room);
      const currentChat = getChatByCursorSessionId(sessionKey) || chat;
      if (currentChat?.id) {
        setChatSdkAgentId(currentChat.id, null);
      }
      if (isSdkRateLimitError(message)) {
        if (tryScheduleRateLimitRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt)) {
          clearCurrentRunDiagnostics(room);
          return;
        }
        broadcastSdkRateLimitError(room, message);
        clearCurrentRunDiagnostics(room);
        return;
      }
      if (isSdkAuthenticationError(message)) {
        if (tryScheduleAuthRecoveryRetry(room, sessionKey, text, modeOverride, clientSentAt)) {
          clearCurrentRunDiagnostics(room);
          return;
        }
        broadcastRoom(room, {
          type: 'sdkError',
          code: 'cursor_auth_error',
          message,
        });
        clearCurrentRunDiagnostics(room);
        return;
      }
      const retryCount = Number(room._setupFailureRetries) || 0;
      if (shouldRetrySetupFailure(retryCount)) {
        room._setupFailureRetries = retryCount + 1;
        const freshChat = getChatByCursorSessionId(sessionKey);
        const retryMode = normalizeSdkMode(modeOverride ?? freshChat?.sdkMode ?? room.sdkMode);
        unshiftAutomaticPromptRetry(room, {
          text,
          mode: retryMode,
          clientSentAt,
          scheduleAfterMs: computeSetupRetryDelayMs(room._setupFailureRetries),
        });
        broadcastRoom(room, {
          type: 'sdkBusy',
          message: buildSetupRetryMessage(room._setupFailureRetries),
        });
        return;
      }
      room._setupFailureRetries = 0;
      broadcastRoom(room, {
        type: 'sdkError',
        code: 'run_setup_failed',
        message,
      });
    } finally {
      stopSetupProgressReporter(room);
      room._setupPhase = null;
      room._setupStartedAt = null;
      if (room._setupAbort === setupAbort) {
        room._setupAbort = null;
      }
      room.currentRun = null;
      room.busy = false;
      refreshSdkRoomOwnerLease(room);
      const next = room.pendingPrompts.shift();
      if (next) {
        schedulePendingPromptRun(next, (item) => {
          void runPrompt(item.text, item.mode, true, item.clientSentAt ?? null, item.displayText);
        });
      } else {
        setImmediate(() => {
          if (room.busy) return;
          flushPersistBuffer(room);
        });
      }
    }
  }

  ws.on('message', (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (msg.type === 'ping') {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      return;
    }
    if (msg.type === 'warmup') {
      if (room.busy || isSdkRemoteRoomStub(room)) return;
      const currentChat = getChatByCursorSessionId(sessionKey) || chat;
      room.modelId = normalizeCatalogModelValue(currentChat?.model || room.modelId) || 'auto';
      room.modelSelection = resolveSdkModelSelection(room.modelId);
      room.sdkMode = normalizeSdkMode(currentChat?.sdkMode || room.sdkMode);
      if (shouldSkipSdkAgentResumeForModelChange(room, room.modelId)) {
        clearSdkAgentBinding(room, sessionKey);
      }
      void connectAgent(room.sdkMode)
        .then(() => connectAgent(room.sdkMode))
        .then((agent) => {
          if (!agent || room.busy) return;
          broadcastRoom(room, {
            type: 'sdkAgent',
            agentId: agent.agentId,
            modelId: room.modelId,
            sdkMode: room.sdkMode,
          });
        })
        .catch(() => {});
      return;
    }
    if (msg.type === 'cancel') {
      if (room._setupAbort && typeof room._setupAbort.abort === 'function') {
        room._setupAbort.abort();
      }
      const run = room.currentRun;
      if (run && typeof run.cancel === 'function') {
        void run.cancel();
      }
      return;
    }
    if (msg.type === 'setSdkMode') {
      void (async () => {
        if (!(await ensureRoomCanMutate())) return;
        const mode = normalizeSdkMode(msg.mode);
        const previousMode = normalizeSdkMode(room.sdkMode);
        room.sdkMode = mode;
        const currentChat = getChatByCursorSessionId(sessionKey);
        if (currentChat?.id) {
          updateChat(currentChat.id, { sdkMode: mode });
        }
        if (previousMode !== mode && room.agent && !room.busy) {
          try {
            room.agent.close();
          } catch {
            // Guard clause: the SDK session resumes on the next prompt with the new mode.
          }
          room.agent = null;
        }
        if (previousMode !== mode) {
          broadcastRoom(room, { type: 'sdkMode', mode });
        }
      })();
      return;
    }
    if (msg.type === 'send' && typeof msg.text === 'string') {
      void runPrompt(msg.text, msg.mode, false, msg.clientSentAt, readClientDisplayText(msg));
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
      let idx = room.pendingPrompts.findIndex((item) => isQueuedPromptText(item, target));
      if (idx < 0) {
        const freshChat = getChatByCursorSessionId(sessionKey);
        const mode = normalizeSdkMode(freshChat?.sdkMode ?? room.sdkMode);
        room.pendingPrompts.push({ text: target, mode, clientSentAt: null });
        idx = room.pendingPrompts.length - 1;
      }
      const [item] = room.pendingPrompts.splice(idx, 1);
      room.pendingPrompts.unshift(item);
      if (room.currentRun && typeof room.currentRun.cancel === 'function') {
        void room.currentRun.cancel();
        return;
      }
      if (!room.busy) {
        const next = room.pendingPrompts.shift();
        if (next) {
          schedulePendingPromptRun(next, (item) => {
            void runPrompt(item.text, item.mode, true, item.clientSentAt ?? null, item.displayText);
          });
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    cancelWsReplayBatch(ws);
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      scheduleRoomShutdown(sessionKey);
    }
  });
}

/**
 * Returns a diagnostic snapshot of an SDK room (without leaking keys/functions).
 *
 * @param {string} sessionKey
 * @returns {Record<string, unknown>|null}
 */
export function getSdkRoomDiag(sessionKey) {
  if (!sessionKey) return null;
  const room = sdkRooms.get(sessionKey);
  if (!room) return null;
  const now = Date.now();
  const lastEventAt = Number.isFinite(room.lastEventAt) ? room.lastEventAt : null;
  const lastEventAgoMs = lastEventAt ? now - lastEventAt : null;
  const entries = Array.isArray(room.eventLog) ? room.eventLog : [];
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const lastPayload = lastEntry?.payload && typeof lastEntry.payload === 'object' ? lastEntry.payload : null;
  const recentPayloads = entries.slice(-5).map((entry) => {
    const payload = entry?.payload && typeof entry.payload === 'object' ? entry.payload : null;
    return payload;
  }).filter(Boolean);
  const recentEvents = recentPayloads.map((payload) => ({
    type: typeof payload.type === 'string' ? payload.type : null,
    status: typeof payload.status === 'string' ? payload.status : null,
    code: typeof payload.code === 'string' ? payload.code : null,
    message: typeof payload.message === 'string' ? payload.message.slice(0, 240) : null,
    runId: typeof payload.runId === 'string' ? payload.runId : null,
  }));
  const lastRunEvent = [...recentPayloads].reverse().find((payload) => payload.type === 'sdkRunFinished') || null;
  const lastErrorEvent = [...recentPayloads].reverse().find((payload) => payload.type === 'sdkError') || null;
  const rawLastRunStatus =
    typeof lastRunEvent?.status === 'string' ? lastRunEvent.status.trim() : '';
  const normalizedLastRunStatus = normalizeSdkRunStatus(rawLastRunStatus);
  const requestedModelId =
    typeof room?._lastRequestedModelId === 'string' && room._lastRequestedModelId.trim()
      ? room._lastRequestedModelId.trim()
      : room.modelId || null;
  const effectiveModelId =
    typeof room?._lastEffectiveModelId === 'string' && room._lastEffectiveModelId.trim()
      ? room._lastEffectiveModelId.trim()
      : typeof room?._agentModelId === 'string' && room._agentModelId.trim()
        ? room._agentModelId.trim()
        : room.modelId || null;
  const strictModelRequested = room?._strictModelRequested === true;
  const strictModelActive = isStrictFastSdkModel(requestedModelId);
  const rawLastModelFallback =
    room?._lastModelFallback && typeof room._lastModelFallback === 'object'
      ? room._lastModelFallback
      : null;
  const lastModelFallback = rawLastModelFallback
    ? {
        attemptedModelId:
          typeof rawLastModelFallback.attemptedModelId === 'string'
            ? rawLastModelFallback.attemptedModelId.trim()
            : null,
        fallbackModelId:
          typeof rawLastModelFallback.fallbackModelId === 'string'
            ? rawLastModelFallback.fallbackModelId.trim()
            : null,
        applied: rawLastModelFallback.applied === true,
        blockedByStrict: rawLastModelFallback.blockedByStrict === true,
        reason:
          typeof rawLastModelFallback.reason === 'string'
            ? rawLastModelFallback.reason.trim() || null
            : null,
        at: Number.isFinite(rawLastModelFallback.at) ? Number(rawLastModelFallback.at) : null,
      }
    : null;
  const usagePayload = findLastUsageEventPayload(entries, room._lastUsagePayload);
  const usageInputTokens = readReportedTokenCount(usagePayload?.inputTokens);
  const usageOutputTokens = readReportedTokenCount(usagePayload?.outputTokens);
  const usageTotalTokens = readReportedTokenCount(usagePayload?.totalTokens);
  const usageCacheReadTokens = readReportedTokenCount(usagePayload?.cacheReadTokens);
  const usageCacheWriteTokens = readReportedTokenCount(usagePayload?.cacheWriteTokens);
  const usageReasoningTokens = readReportedTokenCount(usagePayload?.reasoningTokens);
  const effectiveUsageInputTokens = estimateEffectiveUsageInputTokens(
    usageInputTokens,
    usageCacheReadTokens
  );
  const setupStartedAt = Number.isFinite(room._setupStartedAt) ? room._setupStartedAt : null;
  const setupAgoMs = setupStartedAt ? now - setupStartedAt : null;
  const stuckInSetup = !!room.busy && !room.currentRun;
  return {
    exists: true,
    sessionKey,
    isRemoteStub: isSdkRemoteRoomStub(room),
    ownerInstanceId: room.ownerInstanceId || null,
    busy: !!room.busy,
    stuckInSetup,
    setupPhase: stuckInSetup && typeof room._setupPhase === 'string' ? room._setupPhase : null,
    setupAgoMs,
    sdkMode: room.sdkMode || null,
    modelId: room.modelId || null,
    requestedModelId,
    effectiveModelId,
    strictModelRequested,
    strictModelActive,
    lastModelFallback,
    agentId: room.agent?.agentId || null,
    hasAgent: !!room.agent,
    agentConnecting: !!room._agentConnectPromise,
    hasCurrentRun: !!room.currentRun,
    clients: room.clients ? room.clients.size : 0,
    queuedCount: Array.isArray(room.pendingPrompts) ? room.pendingPrompts.length : 0,
    queued: Array.isArray(room.pendingPrompts)
      ? room.pendingPrompts.map((item) => ({ text: item?.text || '', mode: item?.mode || null }))
      : [],
    eventLogCount: Array.isArray(room.eventLog) ? room.eventLog.length : 0,
    lastEventAt,
    lastEventAgoMs,
    lastEventSeq: Number.isFinite(room.eventSeq) ? room.eventSeq : null,
    lastEventType: lastEntry?.payload?.type || null,
    lastEventStatus: typeof lastPayload?.status === 'string' ? lastPayload.status : null,
    lastEventCode: typeof lastPayload?.code === 'string' ? lastPayload.code : null,
    lastEventMessage: typeof lastPayload?.message === 'string' ? lastPayload.message.slice(0, 240) : null,
    lastRunTimings:
      room.lastRunTimings && typeof room.lastRunTimings === 'object'
        ? { ...room.lastRunTimings }
        : null,
    lastRunStatus: rawLastRunStatus || null,
    lastRunStatusNormalized: normalizedLastRunStatus || null,
    lastRunId: typeof lastRunEvent?.runId === 'string' ? lastRunEvent.runId : null,
    lastErrorCode: typeof lastErrorEvent?.code === 'string' ? lastErrorEvent.code : null,
    lastErrorMessage: typeof lastErrorEvent?.message === 'string' ? lastErrorEvent.message.slice(0, 240) : null,
    lastUsageInputTokens: Number.isFinite(effectiveUsageInputTokens)
      ? effectiveUsageInputTokens
      : Number.isFinite(usageInputTokens)
        ? usageInputTokens
        : null,
    rawLastUsageInputTokens: Number.isFinite(usageInputTokens) ? usageInputTokens : null,
    lastUsageOutputTokens: Number.isFinite(usageOutputTokens) ? usageOutputTokens : null,
    lastUsageTotalTokens: Number.isFinite(usageTotalTokens) ? usageTotalTokens : null,
    lastUsageCacheReadTokens: Number.isFinite(usageCacheReadTokens) ? usageCacheReadTokens : null,
    lastUsageCacheWriteTokens: Number.isFinite(usageCacheWriteTokens) ? usageCacheWriteTokens : null,
    lastUsageReasoningTokens: Number.isFinite(usageReasoningTokens) ? usageReasoningTokens : null,
    recentEvents,
    shutdownScheduled: !!room._shutdownTimer,
    backpressureSkipCount: Number(room._backpressureSkipCount) || 0,
    maxClientBufferedBytes: room.clients
      ? getMaxClientBufferedAmount(room.clients, WS_BACKPRESSURE_THRESHOLD_BYTES)
      : 0,
    backpressureThresholdBytes: WS_BACKPRESSURE_THRESHOLD_BYTES,
  };
}
