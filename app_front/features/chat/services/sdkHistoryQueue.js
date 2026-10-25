/** SDK structured-history queue, optimistic prompt lines and rich-view history paging. */
import {
  CHAT_BUFFER_MAX,
  CHAT_BUFFER_LOCALSTORAGE_PREFIX,
  CHAT_HISTORY_INITIAL_TAIL,
  CHAT_HISTORY_OLDER_PAGE,
} from '../../../config.js';
import {
  resolvePendingInheritedSend,
  parseInheritedPrompt,
  resolveInheritedPromptEcho,
} from '../../../../lib/conversation-fork.js';
import { t } from '../../../i18n/index.js';
import { persistChatBuffer } from '../../../lib/chatBufferStore.js';
import { syncViewAppliedSessionKey } from '../chatHistoryConvergence.js';
import { replaySdkRichViewHistory } from '../chatHistoryViewApply.js';
import { allowSdkLiveEventsDuringHydration } from '../sdkEventReplayGuard.js';
import { sortRecordsByCreatedAt, rememberHistoryWindowStart } from '../chatHistoryWindowOrder.js';
import { resolveTurnAlignedHistoryWindow } from '../../../../lib/sdk/sdk-history-turn-window.ts';
import { UI_FREEZE_CHAT_MOUNTED_RECORD_CAP } from '../../../lib/uiFreezeRenderBudgets.js';
import { getChatSpeaker } from '../../voice/chatSpeaker.js';
import {
  appendSdkChatHistoryRecordsSync,
  mirrorSdkChatHistoryToIndexedDb,
  replaceSdkChatHistoryRecords,
  pullChatHistoryOlderFromServer,
  getOldestLoadedSeq,
} from '../../../lib/sdk-chat-history-store.js';
import { stripAnsi } from '../chatTitleParsing.js';
import { chatHost } from './chatHost.js';

/** SDK event types present in the API snapshot (agentConversationTurn). */
const STANDARD_SDK_EVENT_TYPES = new Set([
  'system',
  'user',
  'assistant',
  'thinking',
  'tool_call',
  'status',
  'task',
  'request',
]);

/**
 * @param {unknown} rec
 * @returns {'standard' | 'raw' | null} timeline record type (for merge order)
 */
function sdkTimelineRecordKind(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (rec);
  if (r.kind === 'localUser') return 'standard';
  if (r.kind !== 'sdk' || !r.event || typeof r.event !== 'object') return null;
  const ev = /** @type {Record<string, unknown>} */ (r.event);
  const t = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';
  return t && STANDARD_SDK_EVENT_TYPES.has(t) ? 'standard' : 'raw';
}

/**
 * Merges the authoritative standard records from the API with raw SDK events from the local
 * store (e.g. `usage` that the API does not return), keeping their place on the timeline.
 *
 * Raw event position is derived from the number of preceding standard events
 * in the local log (written chronologically).
 *
 * @param {Array<Record<string, unknown>>} apiRecords
 * @param {{ cursorSessionId?: string, events?: unknown[] } | null} localState
 * @param {string} sessionKey
 * @returns {Array<Record<string, unknown>>}
 */
export function mergeSdkHistoryWithRawEvents(apiRecords, localState, sessionKey) {
  const base = Array.isArray(apiRecords) ? apiRecords : [];
  if (!localState || !Array.isArray(localState.events)) return base;
  if (sessionKey && localState.cursorSessionId && localState.cursorSessionId !== sessionKey) {
    return base;
  }

  /** @type {Array<{ pos: number, rec: Record<string, unknown> }>} */
  const raw = [];
  let standardCount = 0;
  for (const rec of localState.events) {
    const kind = sdkTimelineRecordKind(rec);
    if (kind === 'raw') {
      raw.push({ pos: standardCount, rec: /** @type {Record<string, unknown>} */ (rec) });
    } else if (kind === 'standard') {
      standardCount += 1;
    }
  }
  if (raw.length === 0) return base;

  // Drift diagnostics: if the API standard-event count diverges a lot from local,
  // positioning raw events by the local counter can scramble order (a possible cause of
  // garbled thinking/assistant). Log a warning — do not abort (KISS).
  if (typeof console !== 'undefined' && console.warn) {
    const apiStdCount = base.length;
    const drift = Math.abs(apiStdCount - standardCount);
    if (drift > 2) {
      console.warn(
        `[chat] mergeSdkHistoryWithRawEvents: standard counter drift (api=${apiStdCount}, local=${standardCount}, raw=${raw.length}) — raw event order may be approximate`
      );
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  let ri = 0;
  let stdSeen = 0;
  for (const rec of base) {
    while (ri < raw.length && raw[ri].pos <= stdSeen) {
      out.push(raw[ri].rec);
      ri += 1;
    }
    out.push(rec);
    stdSeen += 1;
  }
  while (ri < raw.length) {
    out.push(raw[ri].rec);
    ri += 1;
  }
  return out;
}

/**
 * @param {unknown} rec
 * @returns {'assistant' | 'thinking' | null}
 */
function sdkHistoryStreamKindForQueue(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (rec);
  if (r.kind !== 'sdk' || !r.event || typeof r.event !== 'object') return null;
  const ev = /** @type {Record<string, unknown>} */ (r.event);
  const t = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';
  if (t === 'assistant' || t === 'thinking') return t;
  return null;
}

/**
 * Queue for SDK structured history writes (localStorage) so we do not write on every assistant token.
 *
 * @param {object} chat
 * @param {unknown} rec
 */
export function enqueueSdkStructuredHistoryRecord(chat, rec) {
  if (!chat?.id) return;
  if (!rec || typeof rec !== 'object') return;
  if (!chat.cursorSessionId) return;
  if (!Array.isArray(chat._sdkHistoryPending)) chat._sdkHistoryPending = [];

  const r = /** @type {Record<string, unknown>} */ (rec);
  if (r.kind === 'localUser' && typeof r.text === 'string') {
    const text = r.text.trim();
    if (chat._sdkHistoryPending.some((entry) => entry?.kind === 'localUser' && entry?.text === text)) {
      return;
    }
  }
  if (r.kind === 'meta' && r.variant === 'queued' && typeof r.payload === 'string') {
    const payload = r.payload.trim();
    if (
      chat._sdkHistoryPending.some(
        (entry) => entry?.kind === 'meta' && entry?.variant === 'queued' && entry?.payload === payload,
      )
    ) {
      return;
    }
  }

  const streamKind = sdkHistoryStreamKindForQueue(rec);
  if (streamKind) {
    const pend = chat._sdkHistoryPending;
    const prevKind = sdkHistoryStreamKindForQueue(pend[pend.length - 1]);
    if (prevKind === streamKind) {
      const previous = pend[pend.length - 1];
      pend[pend.length - 1] = {
        ...rec,
        createdAt:
          typeof previous?.createdAt === 'string' ? previous.createdAt : rec.createdAt,
      };
    } else {
      pend.push(rec);
    }
  } else {
    chat._sdkHistoryPending.push(rec);
  }

  if (chat._sdkHistoryFlushTimer) return;
  chat._sdkHistoryFlushTimer = setTimeout(() => {
    chat._sdkHistoryFlushTimer = null;
    const batch = chat._sdkHistoryPending || [];
    chat._sdkHistoryPending = [];
    if (batch.length === 0) return;
    // The server-side tap (cursor-agent-sdk-ws.ts) is the authoritative writer of SDK history.
    // The client only keeps a local mirror (IDB) for fast offline reloads and never pushes to the server.
    appendSdkChatHistoryRecordsSync(chat.id, chat.cursorSessionId || '', batch);
    void mirrorSdkChatHistoryToIndexedDb(chat.id).catch(() => {});
  }, 320);
}

/**
 * Flushes the queue without debounce — e.g. on tab hide, pagehide or beforeunload.
 * @param {object} chat
 */
export function flushSdkStructuredHistoryNow(chat) {
  if (!chat?.id) return;
  if (!chat.cursorSessionId) return;
  if (chat._sdkHistoryFlushTimer) {
    clearTimeout(chat._sdkHistoryFlushTimer);
    chat._sdkHistoryFlushTimer = null;
  }
  const batch = chat._sdkHistoryPending || [];
  chat._sdkHistoryPending = [];
  if (batch.length === 0) return;
  appendSdkChatHistoryRecordsSync(chat.id, chat.cursorSessionId || '', batch);
  void mirrorSdkChatHistoryToIndexedDb(chat.id).catch(() => {});
}

function inheritedPromptLabels() {
  return {
    fork: t('chat.forkContinueDisplayText'),
    handoff: t('chat.harnessHandoffDisplayText'),
    analyze: t('chat.monitorAgentDisplayPrompt'),
  };
}

function inheritedPromptLabelForKind(kind) {
  const labels = inheritedPromptLabels();
  if (kind === 'handoff') return labels.handoff;
  if (kind === 'analyze') return labels.analyze;
  return labels.fork;
}

/**
 * Use the stored fork/handoff prompt on the first user send instead of auto-sending it.
 *
 * @param {object} chat
 * @param {string} userText
 * @returns {{ payloadText: string, displayText: string } | null}
 */
export function consumePendingInheritedPrompt(chat, userText) {
  const pending = typeof chat?._pendingInheritedPrompt === 'string'
    ? chat._pendingInheritedPrompt.trim()
    : '';
  if (!pending) return null;
  const defaultDraft = typeof chat._pendingInheritedDisplayText === 'string'
    ? chat._pendingInheritedDisplayText
    : '';
  delete chat._pendingInheritedPrompt;
  delete chat._pendingInheritedDisplayText;
  return resolvePendingInheritedSend(pending, defaultDraft, userText);
}

/**
 * @param {string[]} list
 * @param {string} userText
 * @returns {number}
 */
function findOptimisticPromptIndex(list, userText) {
  const raw = userText == null ? '' : String(userText).trim();
  if (!raw || !Array.isArray(list)) return -1;
  const direct = list.indexOf(raw);
  if (direct !== -1) return direct;
  const inherited = parseInheritedPrompt(raw);
  if (!inherited.wrapped) return -1;
  const echo = resolveInheritedPromptEcho(raw, inheritedPromptLabels()).trim();
  if (echo) {
    const echoIdx = list.indexOf(echo);
    if (echoIdx !== -1) return echoIdx;
  }
  const label = inheritedPromptLabelForKind(inherited.kind);
  return list.indexOf(label);
}

export function appendSdkUserPromptLine(chat, userText) {
  const raw = resolveInheritedPromptEcho(
    userText == null ? '' : String(userText),
    inheritedPromptLabels()
  );
  // A new prompt makes the previous answer stale — stop reading it mid-sentence.
  getChatSpeaker().resetAnswer();
  chat._sdkLastLocalUserEcho = raw;
  const line = `\n> ${raw}\n`;
  chatHost.processAgentOutput(chat, line);
  if (chat._sdkRichView) {
    chat._sdkRichView.appendUserPrompt(raw);
  }
}

/**
 * @param {object} chat
 */
function ensureSdkOptimisticPromptState(chat) {
  if (!Array.isArray(chat?._sdkOptimisticSentNow)) {
    chat._sdkOptimisticSentNow = [];
  }
  if (!Array.isArray(chat?._sdkOptimisticSentQueued)) {
    chat._sdkOptimisticSentQueued = [];
  }
}

/**
 * Immediate echo after clicking Send so UX feels instant.
 * When the agent is busy, show the queued variant immediately.
 *
 * @param {object} chat
 * @param {string} userText
 */
export function appendOptimisticSdkPrompt(chat, userText) {
  const raw = userText == null ? '' : String(userText).trim();
  if (!chat || !raw) return;
  allowSdkLiveEventsDuringHydration(chat);
  ensureSdkOptimisticPromptState(chat);
  const shouldQueue =
    chat._agentState === 'active' ||
    chat._sdkServerBusy === true ||
    (chat._sdkRichView?.queuedCount || 0) > 0;
  if (shouldQueue) {
    const nextPos = (chat._sdkRichView?.queuedCount || 0) + 1;
    chat._sdkOptimisticSentQueued.push(raw);
    appendSdkQueuedPromptLine(chat, raw, nextPos);
    return;
  }
  chat._sdkOptimisticSentNow.push(raw);
  appendSdkUserPromptLine(chat, raw);
}

/**
 * @param {object} chat
 * @param {string} userText
 * @returns {boolean}
 */
export function consumeOptimisticSdkPrompt(chat, userText) {
  const raw = userText == null ? '' : String(userText).trim();
  if (!raw) return false;
  ensureSdkOptimisticPromptState(chat);
  const idx = findOptimisticPromptIndex(chat._sdkOptimisticSentNow, raw);
  if (idx === -1) return false;
  chat._sdkOptimisticSentNow.splice(idx, 1);
  return true;
}

/**
 * @param {object} chat
 * @param {string} userText
 * @returns {boolean}
 */
export function consumeOptimisticSdkQueuedPrompt(chat, userText) {
  const raw = userText == null ? '' : String(userText).trim();
  ensureSdkOptimisticPromptState(chat);
  const idx = findOptimisticPromptIndex(chat._sdkOptimisticSentQueued, raw);
  if (idx === -1) return false;
  chat._sdkOptimisticSentQueued.splice(idx, 1);
  return true;
}

export function appendSdkQueuedPromptLine(chat, userText, position) {
  const raw = resolveInheritedPromptEcho(
    userText == null ? '' : String(userText).trim(),
    inheritedPromptLabels()
  ).trim();
  if (!raw) return;
  if (chat._sdkRichView?.hasQueuedOrSentUserText?.(raw)) return;
  const pos = Math.max(1, Number(position) || 1);
  const line = `\n> ${t('chatUi.queuedPlainTag', { n: pos })} ${raw}\n`;
  chatHost.processAgentOutput(chat, line);
  if (chat._sdkRichView) {
    chat._sdkRichView.appendQueuedPrompt(raw, pos);
  }
}

export function promoteSdkQueuedPromptLine(chat, userText) {
  const raw = userText == null ? '' : String(userText);
  if (chat._sdkRichView) {
    chat._sdkRichView.promoteQueuedPrompt(raw);
    return;
  }
  appendSdkUserPromptLine(chat, raw);
}

export function removeSdkQueuedPromptLine(chat, userText) {
  const raw = userText == null ? '' : String(userText);
  if (!chat?._sdkRichView) return;
  chat._sdkRichView.removeQueuedPrompt(raw);
}

export function sendQueueControl(chat, type, text) {
  if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type, text: String(text || '') }));
}

export function sendOpenCodeQuestionReply(chat, payload) {
  if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type: 'opencodeQuestionReply', ...(payload || {}) }));
}

export function sendOpenCodePermissionReply(chat, payload) {
  if (!chat?.ws || chat.ws.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type: 'opencodePermissionReply', ...(payload || {}) }));
}

export function syncRichViewPlainBuffer(chat) {
  if (!chat?._sdkRichView) return;
  const synthesized = stripAnsi(chat._sdkRichView.getCopyText());
  chat._buffer =
    synthesized.length > CHAT_BUFFER_MAX ? synthesized.slice(-CHAT_BUFFER_MAX) : synthesized;
  persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
}

/**
 * Renders only the newest slice of a record list and parks the rest as the first
 * "older" page — cached records are free to render, no round trip needed.
 *
 * @param {object} chat
 * @param {unknown[]} records
 * @returns {unknown[]} the slice that was handed to the view
 */
export function takeSdkHistoryWindow(chat, records) {
  const list = Array.isArray(records) ? records : [];
  // A bare tail cut can land mid-run and drop the run's leading Thinking block, which
  // splits its Activity tray on replay. Expand the window to the user turn that opens
  // the run so the renderer rebuilds the same group as the live stream. Cap the
  // mounted slice so one long run cannot blow past UI freeze budgets (stage 4).
  const resolved = resolveTurnAlignedHistoryWindow(
    list,
    CHAT_HISTORY_INITIAL_TAIL,
    UI_FREEZE_CHAT_MOUNTED_RECORD_CAP,
  );
  chat._historyOlderLocal = resolved.parked;
  chat._sdkHistoryTurnSegment = resolved.turnSegment;
  if (typeof chat._sdkRichView?.setHistoryTurnSegment === 'function') {
    chat._sdkRichView.setHistoryTurnSegment(resolved.turnSegment);
  }
  return resolved.records;
}

/**
 * @param {object} chat
 * @param {{ v: number, cursorSessionId: string, events: unknown[] } | null} localState
 * @param {string} sessionKey
 * @returns {Promise<{ hydratedRecords: unknown[], structuredReplayDone: boolean }>}
 */
export async function hydrateSdkRichViewFromLocalCache(chat, localState, sessionKey) {
  if (!chat?._sdkRichView || !sessionKey) {
    return { hydratedRecords: [], structuredReplayDone: false };
  }
  const hasLocalEvents =
    !!localState && Array.isArray(localState.events) && localState.events.length > 0;
  if (!hasLocalEvents) {
    return { hydratedRecords: [], structuredReplayDone: false };
  }
  const localSessionId =
    typeof localState.cursorSessionId === 'string' ? localState.cursorSessionId.trim() : '';
  if (localSessionId && localSessionId !== sessionKey) {
    return { hydratedRecords: [], structuredReplayDone: false };
  }
  if (localSessionId !== sessionKey) {
    await replaceSdkChatHistoryRecords(chat.id, sessionKey, localState.events);
  }
  const chronological = sortRecordsByCreatedAt(localState.events);
  const windowed = takeSdkHistoryWindow(chat, chronological);
  rememberHistoryWindowStart(chat, windowed, { reset: true });
  syncViewAppliedSessionKey(chat.id, chat, sessionKey);
  await replaySdkRichViewHistory(chat, windowed, { instant: true, source: 'local' });
  syncRichViewPlainBuffer(chat);
  return { hydratedRecords: chronological, structuredReplayDone: true };
}

/**
 * Supplies the rich view with one page of older history: cached records first (free),
 * then pages from the server walking back from the oldest seq we hold.
 *
 * @param {object} chat
 * @returns {Promise<{ records: unknown[], hasOlder: boolean } | null>}
 */
export async function loadOlderSdkHistoryPage(chat) {
  // null is reserved for a failed fetch (the view offers a retry); a chat without an id can
  // never produce pages, so report it as exhausted instead of looping on retry.
  if (!chat?.id) return { records: [], hasOlder: false };
  const cached = Array.isArray(chat._historyOlderLocal) ? chat._historyOlderLocal : [];
  if (cached.length > 0) {
    const cut = Math.max(0, cached.length - CHAT_HISTORY_OLDER_PAGE);
    chat._historyOlderLocal = cached.slice(0, cut);
    const records = cached.slice(cut);
    rememberHistoryWindowStart(chat, records);
    return {
      records,
      hasOlder: cut > 0 || resolveOlderHistoryCursor(chat) > 0,
    };
  }
  const beforeSeq = resolveOlderHistoryCursor(chat);
  if (beforeSeq <= 0) return { records: [], hasOlder: false };
  const page = await pullChatHistoryOlderFromServer(chat.id, {
    beforeSeq,
    limit: CHAT_HISTORY_OLDER_PAGE,
  });
  if (!page) return null;
  chat._historyOldestSeq = page.hasOlder ? page.oldestLoadedSeq : 0;
  rememberHistoryWindowStart(chat, page.events);
  return { records: page.events, hasOlder: page.hasOlder };
}

/**
 * In-session cursor for paging back; falls back to the persisted window edge so a reload
 * (which renders the cache, not a fresh tail) can keep scrolling further back.
 *
 * @param {object} chat
 * @returns {number}
 */
function resolveOlderHistoryCursor(chat) {
  if (Number.isSafeInteger(chat._historyOldestSeq)) return chat._historyOldestSeq;
  return getOldestLoadedSeq(chat.id);
}

/**
 * Arms auto-loading of older history once hydration settled and the view sits at the bottom —
 * arming earlier would make the top sentinel fire against a still-empty stream.
 *
 * @param {object} chat
 */
export function armOlderSdkHistory(chat) {
  const view = chat?._sdkRichView;
  if (!view) return;
  view.scrollToBottom();
  const hasCached = Array.isArray(chat._historyOlderLocal) && chat._historyOlderLocal.length > 0;
  const available = hasCached || resolveOlderHistoryCursor(chat) > 0;
  // Two frames: one for the forced scroll to land, one for layout to settle before observing.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (chat._sdkRichView !== view) return;
      view.setOlderHistoryAvailable(available);
    });
  });
}
