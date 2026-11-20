import { resetSdkStreamState } from '../../../../lib/sdk-chat-format.js';
import { probeEnd, probeStart } from '../../../../lib/perfProbe.js';
import { splitSdkFormattedConversation } from '../../../../../lib/sdk/sdk-chat-history.ts';
import { parseExplicitSdkMode, shouldRenderModeChange } from '../../../../../lib/sdk/sdk-mode.ts';
import { appLogger } from '../../../../core/logging/logger.js';
import { isUiFreezeTraceActive } from '../../../../lib/uiFreezeTrace.js';
import { HISTORY_REPLAY_SYNC_HEAD } from '../../../../lib/chatHistoryReplayLifecycle.js';
import { runHistoryReplayApplySlices } from '../../../../lib/chatHistoryReplayApplySlice.js';
import { emptyHistoryReplayResult } from '../../../../lib/chatHistoryReplayResult.js';
import { t } from '../../../../i18n/index.js';
import { resolveHarnessDisplayLabel } from '../../sdk-transport-labels.js';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { registerRecoveryWidget } from '../../recoveryActions.js';
import { resolveEventStreamId, resolveViewOrderKey } from '../../chatHistoryViewOrder.js';
import { clearHistoryMountedParking, getHistoryParkedNewerLocal, prependHistoryOlderLocal, prependHistoryParkedNewerLocal } from '../../chatHistoryMountedParking.js';
import { noteSdkHistoryViewReplaced } from '../../sdkEventReplayGuard.js';
import { countMountedStreamCards, planMountedWindowEviction } from '../../../../lib/sdkHistoryMountedWindow.js';
import { UI_FREEZE_CHAT_MOUNTED_RECORD_CAP } from '../../../../lib/uiFreezeRenderBudgets.js';
import { sdkEventsFromAgentRow, stripSdkTelemetryLines } from './sdkEventNormalize.js';

/**
 * Public view API (second half): progress, replay and applyEvent; returns the API.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installViewApiTail(rv) {
  const { chat, mountEl, hooks } = rv;

  /**
   * Room events rendered live, newest last. The server persists them with a short
   * delay, so a history replay fetched mid-run can end before them; they are carried
   * over the replay instead of vanishing until the next catch-up.
   *
   * @type {Array<{ event: unknown, roomEventSeq: number, eventStreamId: string }>}
   */
  /** @type {Map<string, { event: unknown, roomEventSeq: number, eventStreamId: string }>} */
  let liveRoomEvents = new Map();
  const LIVE_ROOM_EVENTS_CAP = 400;

  /** @param {unknown} event @param {number} roomEventSeq @param {string} eventStreamId */
  function rememberLiveRoomEvent(event, roomEventSeq, eventStreamId) {
    if (!(roomEventSeq > 0) || !eventStreamId) return;
    liveRoomEvents.set(`${eventStreamId}:${roomEventSeq}`, { event, roomEventSeq, eventStreamId });
    while (liveRoomEvents.size > LIVE_ROOM_EVENTS_CAP) {
      liveRoomEvents.delete(liveRoomEvents.keys().next().value);
    }
  }

  /** View hooks with effects outside the view: persistence, plain buffer, speech, run signals. */
  const LIVE_SIDE_EFFECT_HOOKS = [
    'appendPlain',
    'onHistoryRecord',
    'onAssistantText',
    'onAssistantBlockEnd',
    'onAnswerEnd',
    'onRunActivity',
    'onFinishTitle',
  ];

  /**
   * Turns the side-effect hooks into no-ops; returns the function that restores them.
   *
   * @returns {() => void}
   */
  function muteLiveSideEffectHooks() {
    /** @type {Array<[string, boolean, unknown]>} */
    const saved = LIVE_SIDE_EFFECT_HOOKS.map((name) => [name, Object.prototype.hasOwnProperty.call(hooks, name), hooks[name]]);
    for (const [name, , value] of saved) {
      if (typeof value === 'function') hooks[name] = () => {};
    }
    return () => {
      for (const [name, own, value] of saved) {
        if (own) hooks[name] = value;
        else delete hooks[name];
      }
    };
  }

  /**
   * Highest room seq per stream in `records`; empty when none carry room streams.
   *
   * @param {unknown[]} records
   * @returns {Map<string, number>}
   */
  function maxRoomSeqByStream(records) {
    /** @type {Map<string, number>} */
    const maxByStream = new Map();
    for (const record of records) {
      const rec = /** @type {Record<string, unknown>} */ (record || {});
      const streamId = resolveEventStreamId(rec);
      const seq = Number(rec.roomEventSeq) || 0;
      if (!streamId || seq < 1) continue;
      maxByStream.set(streamId, Math.max(maxByStream.get(streamId) || 0, seq));
    }
    return maxByStream;
  }

  /**
   * Live events newer than everything `records` holds for their stream. Only records
   * tagged with room streams (server history) can prove that; a local snapshot without
   * them carries nothing, the HTTP catch-up after it does.
   *
   * @param {unknown[]} records
   */
  function selectLiveRoomEventsToCarry(records) {
    const maxByStream = maxRoomSeqByStream(records);
    if (maxByStream.size === 0) return [];
    return [...liveRoomEvents.values()]
      .filter((item) => item.roomEventSeq > (maxByStream.get(item.eventStreamId) || 0));
  }

  /**
   * After a replay completed: the records now hold everything up to their max seq, so
   * only the live events newer than that still need carrying. They are not dropped
   * earlier: a replay superseded mid-way never re-applies its carry, the next one must.
   *
   * @param {unknown[]} records
   */
  function pruneLiveRoomEventsCoveredBy(records) {
    const maxByStream = maxRoomSeqByStream(records);
    if (maxByStream.size === 0) {
      liveRoomEvents.clear();
      return;
    }
    for (const [key, item] of liveRoomEvents) {
      if (item.roomEventSeq <= (maxByStream.get(item.eventStreamId) || 0)) liveRoomEvents.delete(key);
    }
  }

  // Probe only when the server already told us this chat has a recovery row;
  // the presence poll calls `refreshRecovery()` when it learns about one later.
  if (chat?._serverRunState?.recoveryStatus) void rv.refreshChatRecoveryBanner();
  if (chat?.id) {
    // `refreshChatRecoveryBanner` is the exact callback used by its rows, so a
    // row action can refresh itself once and skip the registry notification.
    const unregister = registerRecoveryWidget(chat.id, rv.refreshChatRecoveryBanner);
    rv.recoveryWidgetCleanups.add(unregister);
  }

  const viewPublicApiTail = {
    appendSdkRunProgress(progress, opts = {}) {
      if (!progress || typeof progress !== 'object') return;
      const silent = opts.silent === true;
      const phase = typeof progress.phase === 'string' ? progress.phase : '';
      const idleForMs = Number.isFinite(progress.idleForMs) ? Number(progress.idleForMs) : 0;
      const remainingMs = Number.isFinite(progress.remainingMs) ? Number(progress.remainingMs) : null;
      const timeoutMs = Number.isFinite(progress.timeoutMs) ? Number(progress.timeoutMs) : null;
      const transport = typeof progress.transport === 'string' ? progress.transport : 'sdk';
      const label = resolveHarnessDisplayLabel(transport);
      if (phase === 'notice' || phase === 'retry') {
        const message = typeof progress.message === 'string' ? progress.message.trim() : '';
        if (!message) return;
        const notice = `[${label}] ${message}`;
        if (progress.noticeType === 'background_tasks') {
          rv.handleMetaNotice(notice, { silent });
          return;
        }
        if (!silent) hooks.appendPlain(`\n${notice}\n`);
        if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
          hooks.onHistoryRecord({
            kind: 'meta',
            variant: 'notice',
            payload: notice,
            noticeType: progress.noticeType || phase,
            createdAt: new Date().toISOString(),
          });
        }
        return;
      }
      if (phase === 'started') {
        const notice = `[${label}] ${t('sdkView.runProgressStarted')}`;
        const progressState = { idleSeconds: 0, remainingSeconds: 0, isStarted: true };
        if (!silent) hooks.appendPlain(`\n${notice}\n`);
        rv.appendTimeoutProgressSeries(progressState);
        if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
          hooks.onHistoryRecord({
            kind: 'meta',
            variant: 'notice',
            payload: notice,
            progress: progressState,
            createdAt: new Date().toISOString(),
          });
        }
        return;
      }

      if (phase !== 'awaiting_first_event'
        && phase !== 'awaiting_next_event'
        && phase !== 'awaiting_past_budget'
        && phase !== 'connecting'
        && phase !== 'setup'
        && phase !== 'preparing'
        && phase !== 'sending'
        && phase !== 'setup_past_budget') {
        return;
      }

      const idleSeconds = Math.max(0, Math.round(idleForMs / 1000));
      const remainingSeconds = remainingMs != null ? Math.max(0, Math.round(remainingMs / 1000)) : 0;
      const totalSeconds = timeoutMs != null ? Math.max(1, Math.round(timeoutMs / 1000)) : 0;
      let notice = '';
      if (phase === 'connecting' || phase === 'setup') {
        notice = `[${label}] ${t('sdkView.runProgressPreparingAgent', { seconds: idleSeconds })}`;
      } else if (phase === 'preparing') {
        notice = `[${label}] ${t('sdkView.runProgressPreparingPrompt', { seconds: idleSeconds })}`;
      } else if (phase === 'sending') {
        notice = `[${label}] ${t('sdkView.runProgressSendingPrompt', { seconds: idleSeconds })}`;
      } else if (phase === 'setup_past_budget' || phase === 'awaiting_past_budget') {
        notice = `[${label}] ${t('sdkView.runProgressPastBudget', { seconds: idleSeconds })}`;
      } else if (phase === 'awaiting_first_event') {
        notice = `[${label}] ${t('sdkView.runProgressAwaitingFirst', { seconds: idleSeconds })}`;
      } else {
        notice = `[${label}] ${t('sdkView.runProgressNoEvents', { seconds: idleSeconds })}`;
      }
      if (remainingSeconds > 0) {
        notice += ` ${t('sdkView.runProgressWarnThreshold', { seconds: remainingSeconds })}`;
      }
      if (!silent) hooks.appendPlain(`\n${notice}\n`);
      const progressState = { idleSeconds, remainingSeconds, totalSeconds };
      rv.appendTimeoutProgressSeries(progressState);
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'notice',
          payload: notice,
          progress: progressState,
          createdAt: new Date().toISOString(),
        });
      }
    },

    /** Live mode change pushed by the server (history is persisted on the backend side). */
    appendModeChange(mode, opts = {}) {
      rv.stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const normalized = parseExplicitSdkMode(mode);
      if (!normalized) return;
      if (!shouldRenderModeChange(rv.lastRenderedMode, normalized)) return;
      rv.lastRenderedMode = normalized;
      const modeLabel = normalized === 'plan' ? 'Plan' : normalized === 'ask' ? 'Ask' : 'Agent';
      if (!silent) hooks.appendPlain(`\n[Mode: ${modeLabel}]\n`);
      rv.lineMeta(
        'sdk-rich-line--notice',
        `<span class="sdk-rich-badge sdk-rich-badge--status">${escapeHtml(t('sdkView.modeBadge'))}</span> ${escapeHtml(modeLabel)}`
      );
    },

    /**
     * Restored plaintext buffer (localStorage or an API response without a messages list): rendered
     * with the same blocks as a live chat, without a separate collapsible "saved history" frame.
     *
     * @param {string} text
     * @param {string} [_summaryLabel] kept for call-site compatibility; ignored by the UI.
     */
    appendRestoredPlainBuffer(text, _summaryLabel) {
      const t = stripSdkTelemetryLines(text);
      if (!t.trim()) return;

      const segments = splitSdkFormattedConversation(t);
      if (segments.length > 0) {
        for (const seg of segments) {
          rv.emitHistoryTurn(seg.role === 'user', seg.text);
        }
        return;
      }

      rv.emitHistoryTurn(false, t);
    },

    /**
     * Rebuilds history from Agent.messages.list — the same events as over WS (tools, thinking, status).
     * Does not call hooks.appendPlain; the plaintext buffer is set separately in chat.js.
     *
     * @param {Array<Record<string, unknown>>} rows
     */
    applyAgentMessagesHistory(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;

      resetSdkStreamState(chat);
      rv.clearSegmentPointers();
      rv.resetRenderedActivity();
      rv.queuedUserBlocks.length = 0;
      rv.clearOpenCodeInteractiveMaps();
      rv.stream.replaceChildren();

      rv.suppressHooksPlain = true;
      rv.suppressHistoryPersist = true;
      rv.mdRenderImmediate = true;
      try {
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          /** @type {Record<string, unknown>} */
          const ev = /** @type {Record<string, unknown>} */ (row);
          const expanded = sdkEventsFromAgentRow(ev);
          if (expanded.length > 0) {
            for (const item of expanded) {
              rv.applySdkEvent(item);
            }
            continue;
          }
          const tt = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';
          if (
            tt === 'system' ||
            tt === 'user' ||
            tt === 'assistant' ||
            tt === 'thinking' ||
            tt === 'tool_call' ||
            tt === 'usage' ||
            tt === 'local_images' ||
            tt === 'status' ||
            tt === 'task' ||
            tt === 'request' ||
            tt === 'opencode_question' ||
            tt === 'opencode_permission'
          ) {
            rv.applySdkEvent(ev);
          }
        }
      } finally {
        rv.suppressHooksPlain = false;
        rv.suppressHistoryPersist = false;
        rv.mdRenderImmediate = false;
        rv.finalizeAllTerminalRunPresentations();
        rv.scrollToBottom({ force: true });
      }
    },

    /**
     * Replays from the local JSON store (IndexedDB / legacy localStorage — same shape as written).
     *
     * @param {unknown[]} records
     * @param {{ instant?: boolean }} [opts]
     */
    replayHistoryRecords(records, opts = {}) {
      if (!Array.isArray(records) || records.length === 0) {
        return Promise.resolve(emptyHistoryReplayResult());
      }
      resetSdkStreamState(chat);
      const carried = selectLiveRoomEventsToCarry(records);
      // Cards rendered before this replay are about to be cleared, live ones included;
      // the carried live tail is rendered again right after the records.
      noteSdkHistoryViewReplaced(chat, [
        ...records,
        ...carried.map(({ roomEventSeq, eventStreamId }) => ({ roomEventSeq, eventStreamId })),
      ]);
      rv.clearSegmentPointers();
      rv.resetRenderedActivity();
      rv.mountedHistoryRecordRegistry.clear();
      rv.mountedDomNodeRegistry.clear();
      rv.mountedViewResourceLedger.resetAll();
      clearHistoryMountedParking(chat);
      rv.queuedUserBlocks.length = 0;
      rv.lastHistoryErrorText = '';
      // A replay redefines the window, so any page fetched by scrolling up is gone with it.
      rv.bufferedOlderRecords = [];
      // The rebuilt view opens at the live end; only a scroll up during the replay
      // releases it (the final scroll of the replay respects that).
      rv.stickToBottom = true;
      rv.lastScrollTop = 0;
      if (chat && typeof chat === 'object' && chat._sdkHistoryTurnSegment) {
        rv.setHistoryTurnSegment(chat._sdkHistoryTurnSegment);
      } else {
        rv.setHistoryTurnSegment(null);
      }
      rv.clearOpenCodeInteractiveMaps();
      const instant = opts.instant === true && records.length <= HISTORY_REPLAY_SYNC_HEAD;
      const { generation: replayGeneration, syncHead, trackAsync } = rv.historyReplayLifecycle.beginReplay({
        source: opts.source,
        totalRecords: records.length,
        syncHead: instant ? records.length : HISTORY_REPLAY_SYNC_HEAD,
        instant,
      });
      rv.historyReplayGenerationGate.activate(replayGeneration);
      const replayPromise = rv.beginReplayOutcome(replayGeneration, records.length);
      const replayProbe = probeStart('chat.history.replay');
      void replayPromise.then(() => probeEnd(replayProbe), () => probeEnd(replayProbe));
      const syncCount = syncHead;
      const scheduleFrame =
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined;
      void (async () => {
        let syncApplied = 0;
        let syncFinalizeMs = 0;
        try {
          if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
          rv.stream.replaceChildren();
          if (instant) {
            rv.beginViewportAnchorBatch();
            rv.beginHistoryReplayApplySlice(replayGeneration);
            try {
              for (let index = 0; index < records.length; index += 1) {
                if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
                rv.applyHistoryRecord(records[index]);
                syncApplied += 1;
                rv.noteReplayApplied(replayGeneration, syncApplied);
              }
            } finally {
              rv.endHistoryReplayApplySlice();
              rv.endViewportAnchorBatch();
            }
            syncFinalizeMs = await rv.runHistoryReplayFinalizeForGeneration(replayGeneration);
            if (isUiFreezeTraceActive()) {
              rv.historyReplayLifecycle.noteSyncApplied(replayGeneration, records.length);
            }
          } else {
            await runHistoryReplayApplySlices({
              records,
              startIndex: 0,
              endIndexExclusive: syncCount,
              replayGeneration,
              lifecycle: rv.historyReplayLifecycle,
              scheduleFrame,
              isCancelled: () => !rv.historyReplayGenerationGate.isActive(replayGeneration),
              onSliceStart: () => {
                rv.beginViewportAnchorBatch();
                rv.beginHistoryReplayApplySlice(replayGeneration);
              },
              onSliceEnd: () => {
                rv.endHistoryReplayApplySlice();
                if (rv.viewportAnchorBatch.getDepth() > 0) rv.endViewportAnchorBatch();
              },
              applyHistoryRecord: (record) => {
                if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
                rv.applyHistoryRecord(record);
                syncApplied += 1;
                rv.noteReplayApplied(replayGeneration, syncApplied);
              },
            });
            rv.endHistoryReplayApplySlice();
            if (isUiFreezeTraceActive()) {
              rv.historyReplayLifecycle.noteSyncApplied(replayGeneration, syncCount);
            }
            syncFinalizeMs = await rv.runHistoryReplayFinalizeForGeneration(replayGeneration);
          }
        } catch (err) {
          rv.endHistoryReplayApplySlice();
          throw err;
        }
        if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
        if (!trackAsync) {
          rv.historyReplayLifecycle.finishReplay(replayGeneration, {
            reason: 'complete',
            applied: records.length,
            children: rv.realStream.childElementCount,
            finalizeMs: syncFinalizeMs,
          });
          rv.settleReplayOutcome(replayGeneration, 'complete');
          return;
        }
        await rv.replayHistoryRecordsChunkedImpl(records, syncCount, replayGeneration);
      })().catch((err) => {
        // A throwing apply/finalize must still settle the replay outcome; otherwise
        // the returned promise and waitForHistoryReplaySettled() hang forever and
        // the fire-and-forget async tail becomes an unhandled rejection.
        rv.historyReplayLifecycle.finishReplay(replayGeneration, {
          reason: 'error',
          applied: 0,
          children: rv.realStream.childElementCount,
          finalizeMs: 0,
        });
        rv.settleReplayOutcome(replayGeneration, 'error');
        appLogger.log('sdk-rich-history', 'history replay failed', {
          generation: replayGeneration,
          error: String(err?.message || err),
        });
      });
      return replayPromise.then((outcome) => {
        if (outcome?.reason === 'complete') pruneLiveRoomEventsCoveredBy(records);
        if (carried.length > 0 && outcome?.reason === 'complete' && !rv.viewDestroyed) {
          // These were already persisted, sent to the plain buffer and read aloud when
          // they first arrived: mute those side effects only. The render state (live
          // turn, run status, thinking) still follows every event in order.
          const restoreHooks = muteLiveSideEffectHooks();
          try {
            for (const item of carried) {
              viewPublicApiTail.applyEvent(item.event, {
                roomEventSeq: item.roomEventSeq,
                eventStreamId: item.eventStreamId,
              });
            }
          } finally {
            restoreHooks();
          }
        }
        return outcome;
      });
    },

    async appendHistoryRecords(records, opts = {}) {
      await rv.appendHistoryRecordsImpl(records, opts);
    },

    applyEvent(event, meta = {}) {
      const historySeq = Number(meta?.historySeq) > 0 ? Number(meta.historySeq) : 0;
      const roomEventSeq = Number(meta?.roomEventSeq) > 0 ? Number(meta.roomEventSeq) : 0;
      const eventStreamId = resolveEventStreamId(meta);
      rememberLiveRoomEvent(event, roomEventSeq, eventStreamId);
      const previousRoom = rv.renderedRecordRoomEventSeq;
      const previousStream = rv.renderedRecordEventStreamId;
      rv.renderedRecordRoomEventSeq = roomEventSeq;
      rv.renderedRecordEventStreamId = eventStreamId;
      try {
        rv.runViewApplyWithOrder(resolveViewOrderKey({ historySeq, roomEventSeq, eventStreamId }), () => {
          rv.applySdkEvent(event, '', historySeq);
        });
      } finally {
        if (historySeq > 0) {
          const liveRecord = {
            kind: 'sdk',
            historySeq,
            roomEventSeq,
            eventStreamId,
            event,
          };
          rv.mountedHistoryRecordRegistry.note(liveRecord);
          rv.linkHistoryRecordToHostCard?.(liveRecord, `h:${historySeq}`);
        }
        rv.markCopyTextDirty();
        // Past a few events in one task (resume replay of buffered live frames) the two
        // full-stream scans below are O(n) each, so run them once per burst instead.
        const deferScans = rv.noteApplyEventBurst();
        if (!deferScans) rv.foldDuplicateOrderKeyCards();
        if (rv.preserveViewportAnchor) {
          void mountEl.offsetHeight;
          rv.restoreInsertScroll();
        }
        rv.pendingViewportAnchor = null;
        rv.preserveViewportAnchor = false;
        rv.renderedRecordRoomEventSeq = previousRoom;
        rv.renderedRecordEventStreamId = previousStream;
        const protectIdentity = rv.pendingLiveRemountProtectIdentity;
        rv.pendingLiveRemountProtectIdentity = '';
        if (deferScans) {
          if (protectIdentity) rv.deferredBurstProtectIdentities.add(protectIdentity);
        }
        else rv.enforceMountedHistoryWindowBudget({ protectTailRemountIdentity: protectIdentity });
      }
    },

    ensureRelatedChatLinks: rv.ensureRelatedChatLinks,

    /**
     * Stage 4.2 — production mounted-window harness for DOM tests (not app API).
     */
    mountedWindowHarness: {
      enforceMountedHistoryWindowBudget: rv.enforceMountedHistoryWindowBudget,
      /** @param {'head' | 'tail'} evictFrom */
      enforceMountedHistoryWindowBudgetFromEdge(evictFrom) {
        if (rv.stream !== rv.realStream) return;
        const mountedCount = countMountedStreamCards(rv.realStream);
        const edge = evictFrom === 'head' ? 'head' : 'tail';
        const { evictCount } = planMountedWindowEviction({
          mountedCount,
          cap: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP,
          evictFrom: edge,
        });
        if (evictCount <= 0) return;
        const parked = rv.evictMountedStreamCards(edge, evictCount);
        if (parked.length === 0) return;
        if (edge === 'head') {
          prependHistoryOlderLocal(chat, parked);
          return;
        }
        prependHistoryParkedNewerLocal(chat, parked);
      },
      /** Parks the `count` newest cards regardless of the cap or the viewport. */
      evictTailCards(count) {
        const parked = rv.evictMountedStreamCards('tail', count, undefined, { ignoreViewport: true });
        if (parked.length > 0) prependHistoryParkedNewerLocal(chat, parked);
      },
      restoreParkedNewerTailIfNeeded: rv.restoreParkedNewerTailIfNeeded,
      applyHistoryRecord: rv.applyHistoryRecord,
      countMountedStreamCards: () => countMountedStreamCards(rv.realStream),
      getMountedRecordRegistry: () => rv.mountedHistoryRecordRegistry,
      getMountedViewResourceLedger: () => rv.mountedViewResourceLedger,
      getMountedDomNodeRegistry: () => rv.mountedDomNodeRegistry,
      getHistoryParkedNewerLocal: () => getHistoryParkedNewerLocal(chat),
      getRealStream: () => rv.realStream,
      getMountEl: () => mountEl,
      setStickToBottom: (value) => {
        rv.stickToBottom = value === true;
      },
    },
  };

  Object.defineProperties(rv.viewPublicApi, Object.getOwnPropertyDescriptors(viewPublicApiTail));
  return rv.viewPublicApi;
}
