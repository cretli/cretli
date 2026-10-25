/**
 * Initial history hydration of an opened chat pane.
 */
import { chatHost } from './chatHost.js';
import {
  CHAT_BUFFER_LOCALSTORAGE_PREFIX,
  CHAT_BUFFER_MAX,
  CHAT_HISTORY_INITIAL_TAIL,
} from '../../../config.js';
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { hydrateChatBuffer, persistChatBuffer } from '../../../lib/chatBufferStore.js';
import { isMobileLikeClient } from '../../../lib/mobileClient.js';
import {
  flushPendingPush,
  pullChatHistoryFromServer,
  readSdkChatHistoryStateAsync,
  replaceSdkChatHistoryRecords,
  sdkHistoryRecordsFromAgentMessageRows,
} from '../../../lib/sdk-chat-history-store.js';
import { appLogger } from '../../../core/logging/logger.js';
import {
  replaceViewAppliedRecords,
  setChatHistorySyncInFlight,
  shouldArmCachedHistorySyncIndicator,
} from '../chatHistoryConvergence.js';
import {
  captureHydrationHttpBoundary,
  isHydrationHttpBoundaryCurrent,
  mergeServerSdkHistoryIntoRichView,
} from '../chatHistoryHttpMerge.js';
import { waitForHistoryReplaySettled } from '../chatHistoryHydrationLive.js';
import { replaySdkRichViewHistory } from '../chatHistoryViewApply.js';
import { rememberHistoryWindowStart, sortRecordsByCreatedAt } from '../chatHistoryWindowOrder.js';
import { stripAnsi } from '../chatTitleParsing.js';
import {
  PAGE_RESUME_LOG_TAG,
  buildColdBootCachedRenderPayload,
  markPageResumeStage,
  shouldLogColdBootCachedRender,
} from '../pageResumeTrace.js';
import { clearSdkOpenTerminalHydrating } from '../sdkEventReplayGuard.js';
import { chatShell } from '../state/chatShellState.js';
import { renderChatTerminalState, updateAwaitingInput } from './chatSidebarState.js';
import { refreshRelatedChatHistoryLinks } from './harnessSwitch.js';
import {
  armOlderSdkHistory,
  hydrateSdkRichViewFromLocalCache,
  mergeSdkHistoryWithRawEvents,
  syncRichViewPlainBuffer,
  takeSdkHistoryWindow,
} from './sdkHistoryQueue.js';

/**
 * Hydrate a freshly opened chat pane: cached history first, then server tail, API and local fallbacks.
 * @param {any} chat
 * @returns {Promise<void>}
 */
export async function hydrateOpenedChat(chat) {
      /** @type {unknown[]} */
      let hydratedRecords = [];
      let cachedSyncIndicatorArmed = false;
      try {
      const sessionKey = typeof chat.cursorSessionId === 'string' ? chat.cursorSessionId : '';
      const localState = await readSdkChatHistoryStateAsync(chat.id);

      // Flag: whether history was restored structurally (replay / applyAgentMessagesHistory).
      // If so — do NOT call appendRestoredPlainBuffer (double-restore bug: flattened
      // getCopyText() with banners/statuses would land as an extra "Reply" block).
      let structuredReplayDone = false;
      // Whether we only had formatted text (API without messages) — then a text fallback is OK.
      let fromApiFormattedOnly = false;

      const localHydration = await hydrateSdkRichViewFromLocalCache(chat, localState, sessionKey);
      hydratedRecords = localHydration.hydratedRecords;
      structuredReplayDone = localHydration.structuredReplayDone;

      const hasCachedHistory = shouldArmCachedHistorySyncIndicator(localHydration);
      if (
        shouldLogColdBootCachedRender({
          alreadyLogged: chatShell.coldBootCachedRenderAttempted,
          hasActiveResumeTrace: Boolean(chat._pageResumeTrace),
          hasCachedHistory,
        })
      ) {
        appLogger.log(
          PAGE_RESUME_LOG_TAG,
          'cold boot cached render',
          buildColdBootCachedRenderPayload({
            chatId: chat.id,
            mobile: isMobileLikeClient(),
            cachedRenderMs: typeof performance !== 'undefined' ? performance.now() : 0,
          })
        );
      }
      chatShell.coldBootCachedRenderAttempted = true;

      // Cached history is now on screen. Show the discreet mode-bar "syncing" label while
      // the delta catches up (never a full-screen spinner), and record the cached render
      // stage on an active page-resume trace. Cleared in the finally below.
      if (shouldArmCachedHistorySyncIndicator(localHydration)) {
        setChatHistorySyncInFlight(chat, true, renderChatTerminalState);
        cachedSyncIndicatorArmed = true;
        if (chat._pageResumeTrace) markPageResumeStage(chat._pageResumeTrace, 'cachedRender');
      }

      // --- 1. SYNC WITH BACKEND: pull the log from the server (source of truth) ---
      try {
        const httpBoundary = captureHydrationHttpBoundary(chat, sessionKey);
        const serverState = await pullChatHistoryFromServer(chat.id, {
          tail: CHAT_HISTORY_INITIAL_TAIL,
        });
        const httpStillOwned = isHydrationHttpBoundaryCurrent(chat, httpBoundary);
        // A tail pull redefines the cache window, so the server cursor — not the leftover
        // local prefix — owns paging back from here on.
        if (httpStillOwned && serverState && typeof serverState.oldestLoadedSeq === 'number') {
          chat._historyOldestSeq = serverState.hasOlder ? serverState.oldestLoadedSeq : 0;
          chat._historyOlderLocal = [];
          chat._historyParkedNewerLocal = [];
        }
        if (
          httpStillOwned &&
          serverState &&
          Array.isArray(serverState.events) &&
          serverState.events.length > 0
        ) {
          const events = takeSdkHistoryWindow(chat, serverState.events);
          const merged = await mergeServerSdkHistoryIntoRichView(
            chat,
            events,
            sessionKey || serverState.cursorSessionId || '',
            structuredReplayDone,
            httpBoundary,
            syncRichViewPlainBuffer,
          );
          if (!merged.staleHttp) {
            hydratedRecords = merged.hydratedRecords;
            structuredReplayDone = merged.structuredReplayDone;
          }
          // After pull, also try to flush a pending push (if the offline queue had events).
          void flushPendingPush(chat.id, sessionKey).catch(() => {});
        } else if (httpStillOwned && serverState && serverState.headSeq === 0) {
          // Empty server: do NOT backfill from local IDB — old local logs can be
          // corrupted (thinking fragments stored as deltas instead of snapshots).
          // Fallback: Cursor SDK API (Agent.messages.list) — the client only renders;
          // the server stays the authoritative history writer after the first run from this device.
        }
      } catch (_) {}

      // --- 2. FALLBACK: SDK API (Agent.messages.list) — only when the server had no history ---
      if (!structuredReplayDone) {
        try {
          const r = await api.getChatSdkMessages(chat.id, { limit: 250 });
          if (
            r?.ok &&
            Array.isArray(r.messages) &&
            r.messages.length > 0 &&
            typeof r.formatted === 'string'
          ) {
            chat._buffer = r.formatted.slice(-CHAT_BUFFER_MAX);
            persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
            const sdkHistoryRows = r.messages;
            const records = sdkHistoryRecordsFromAgentMessageRows(
              /** @type {Array<Record<string, unknown>>} */ (sdkHistoryRows)
            );
            const merged = mergeSdkHistoryWithRawEvents(records, localState, sessionKey);
            if (merged.length > 0 && sessionKey) {
              await replaceSdkChatHistoryRecords(chat.id, sessionKey, merged);
            }
            hydratedRecords = merged.length > 0 ? merged : records;
            if (chat._sdkRichView) {
              if (merged.length > records.length) {
                const windowed = takeSdkHistoryWindow(chat, sortRecordsByCreatedAt(merged));
                rememberHistoryWindowStart(chat, windowed, { reset: true });
                await replaySdkRichViewHistory(chat, windowed, { instant: true, source: 'sdk-api' });
              } else {
                rememberHistoryWindowStart(chat, records, { reset: true });
                chat._sdkRichView.applyAgentMessagesHistory(sdkHistoryRows);
                replaceViewAppliedRecords(chat.id, chat, records);
              }
              structuredReplayDone = true;
              syncRichViewPlainBuffer(chat);
            }
          } else if (r?.ok && typeof r.formatted === 'string' && r.formatted.trim()) {
            chat._buffer = r.formatted.slice(-CHAT_BUFFER_MAX);
            persistChatBuffer(chat.id, chat._buffer || '', CHAT_BUFFER_LOCALSTORAGE_PREFIX);
            fromApiFormattedOnly = true;
          }
        } catch (_) {}
      }

      // --- 3. FALLBACK: local store (IndexedDB / localStorage) — when server and API are silent ---
      if (!structuredReplayDone && !fromApiFormattedOnly && chat._sdkRichView) {
          const hasLocalEvents =
            !!localState && Array.isArray(localState.events) && localState.events.length > 0;
          if (sessionKey && hasLocalEvents) {
            if (localState.cursorSessionId !== sessionKey) {
              await replaceSdkChatHistoryRecords(chat.id, sessionKey, localState.events);
            }
            const chronological = sortRecordsByCreatedAt(localState.events);
            hydratedRecords = chronological;
            const windowed = takeSdkHistoryWindow(chat, chronological);
            rememberHistoryWindowStart(chat, windowed, { reset: true });
            await replaySdkRichViewHistory(chat, windowed, { instant: true, source: 'local' });
            structuredReplayDone = true;
            syncRichViewPlainBuffer(chat);
          } else {
            let sdkRestoreBuf = chat._buffer || '';
            if (!sdkRestoreBuf && chat.id) {
              // Await IDB hydration — readChatBufferSync (sync) may return '' when data is only in IDB.
              const saved = await hydrateChatBuffer(chat.id, CHAT_BUFFER_LOCALSTORAGE_PREFIX);
              if (saved) {
                sdkRestoreBuf = saved.slice(-CHAT_BUFFER_MAX);
                chat._buffer = sdkRestoreBuf;
              }
            }
          }
      }

      // --- 4. FINAL TEXT FALLBACK: only when no structural path succeeded ---
      // Do not stack a block on top of a correct replay (double-restore bug fix).
      if (!structuredReplayDone && chat._sdkRichView) {
        const plain = stripAnsi(chat._buffer || '');
        if (plain.trim()) {
          if (fromApiFormattedOnly) {
            chat._sdkRichView.appendRestoredPlainBuffer(
              plain,
              t('chat.restoredApiConversation', { chars: plain.length })
            );
          } else {
            chat._sdkRichView.appendRestoredPlainBuffer(plain);
          }
        }
      }

      } finally {
        await waitForHistoryReplaySettled(chat);
        if (cachedSyncIndicatorArmed) {
          setChatHistorySyncInFlight(chat, false, renderChatTerminalState);
        }
        clearSdkOpenTerminalHydrating(chat);
        chatHost.chatTransport.completeSdkHistoryHydration(chat, hydratedRecords);
        chatHost.ensureChatConnection(chat);
        updateAwaitingInput(chat);
        renderChatTerminalState(chat);
        armOlderSdkHistory(chat);
        refreshRelatedChatHistoryLinks(chat);
      }
}
