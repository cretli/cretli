import { isUserTurnBoundaryRecord, splitHistoryPageAtUserTurn } from '../../../../../lib/sdk/sdk-history-turn-window.ts';
import { appLogger } from '../../../../core/logging/logger.js';
import { runHistoryReplayAsyncTail } from '../../../../lib/chatHistoryReplayAsyncLoop.js';
import { t } from '../../../../i18n/index.js';
import { getHistoryParkedNewerLocal } from '../../chatHistoryMountedParking.js';

/**
 * History window: isolated render, older-page prepend/load and the top sentinel.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installHistoryWindow(rv) {
  const { chat, mountEl, hooks } = rv;
  rv.withIsolatedRenderState = withIsolatedRenderState;
  rv.prependHistoryRecordsImpl = prependHistoryRecordsImpl;
  rv.replayHistoryRecordsChunkedImpl = replayHistoryRecordsChunkedImpl;
  rv.renderHistoryTopState = renderHistoryTopState;
  rv.disconnectHistoryTopObserver = disconnectHistoryTopObserver;
  rv.ensureHistoryTopObserver = ensureHistoryTopObserver;
  rv.setHistoryTurnSegment = setHistoryTurnSegment;

  /**
   * Runs `fn` with a blank renderer state, then restores the live one.
   *
   * applyHistoryRecord is stateful: it keeps segment pointers and per-run maps that describe the
   * currently rendered tail. Older records are a self-contained prefix, so they must render from
   * scratch without clobbering that state.
   *
   * @param {() => void} fn
   */
  function withIsolatedRenderState(fn) {
    const scalars = {
      assistantMdEl: rv.assistantMdEl,
      thinkingDetails: rv.thinkingDetails,
      thinkingPre: rv.thinkingPre,
      activeKind: rv.activeKind,
      activeThinkingRunKey: rv.activeThinkingRunKey,
      runScope: rv.runScope,
      isLiveTurn: rv.isLiveTurn,
      timeoutProgressSeries: rv.timeoutProgressSeries,
      timeoutProgressTickTimer: rv.timeoutProgressTickTimer,
      renderedRecordCreatedAt: rv.renderedRecordCreatedAt,
      renderedRecordHistorySeq: rv.renderedRecordHistorySeq,
      renderedRecordRoomEventSeq: rv.renderedRecordRoomEventSeq,
      renderedRecordEventStreamId: rv.renderedRecordEventStreamId,
    };
    // Run-scoped state only. compactTrayHosts / fullToolBlocks / compactStatusLines are left
    // alone on purpose: they register DOM nodes that get toggled when the UI mode changes, and
    // the nodes rendered here end up in the real stream — dropping them would freeze the
    // prepended history in whatever mode was active when it loaded.
    /** @type {Array<Map<unknown, unknown> | Set<unknown>>} */
    const collections = [
      rv.toolByCallId,
      rv.planByCallId,
      rv.openCodeQuestionByRequestId,
      rv.openCodePermissionByRequestId,
      rv.latestThinkingByRun,
      rv.latestTrayByRun,
      rv.thinkingBlocksByRun,
      rv.traysByRun,
      rv.runStatusByRun,
      rv.runningToolCallsByRun,
    ];
    const snapshots = collections.map((c) => (c instanceof Map ? new Map(c) : new Set(c)));
    const queuedSnapshot = rv.queuedUserBlocks.slice();

    collections.forEach((c) => c.clear());
    rv.queuedUserBlocks.length = 0;
    rv.assistantMdEl = null;
    rv.thinkingDetails = null;
    rv.thinkingPre = null;
    rv.activeKind = 'idle';
    rv.activeThinkingRunKey = '';
    rv.runScope += 1;
    rv.timeoutProgressSeries = null;
    rv.timeoutProgressTickTimer = 0;

    try {
      fn();
    } finally {
      // A ticker started while rendering the prefix would outlive its (offscreen) block.
      if (rv.timeoutProgressTickTimer) clearInterval(rv.timeoutProgressTickTimer);
      collections.forEach((c, index) => {
        c.clear();
        const snapshot = snapshots[index];
        if (c instanceof Map && snapshot instanceof Map) {
          snapshot.forEach((value, key) => /** @type {Map<unknown, unknown>} */ (c).set(key, value));
        } else if (c instanceof Set && snapshot instanceof Set) {
          snapshot.forEach((value) => /** @type {Set<unknown>} */ (c).add(value));
        }
      });
      rv.queuedUserBlocks.length = 0;
      rv.queuedUserBlocks.push(...queuedSnapshot);
      rv.assistantMdEl = scalars.assistantMdEl;
      rv.thinkingDetails = scalars.thinkingDetails;
      rv.thinkingPre = scalars.thinkingPre;
      rv.activeKind = scalars.activeKind;
      rv.activeThinkingRunKey = scalars.activeThinkingRunKey;
      rv.runScope = scalars.runScope;
      rv.isLiveTurn = scalars.isLiveTurn;
      rv.timeoutProgressSeries = scalars.timeoutProgressSeries;
      rv.timeoutProgressTickTimer = scalars.timeoutProgressTickTimer;
      rv.renderedRecordCreatedAt = scalars.renderedRecordCreatedAt;
      rv.renderedRecordHistorySeq = scalars.renderedRecordHistorySeq;
      rv.renderedRecordRoomEventSeq = scalars.renderedRecordRoomEventSeq;
      rv.renderedRecordEventStreamId = scalars.renderedRecordEventStreamId;
      if (rv.stream === rv.realStream) rv.adoptTrailingTimeoutProgressSeries();
    }
  }

  /**
   * Paging older history evicts the newest cards, which can shrink the stream under the
   * viewport and clamp it to the bottom edge. That reads as "back at the live tail": the
   * parked newer cards are restored and the page that was just loaded is evicted again,
   * so paging loops and leaves a gap. Park the viewport just above the edge instead.
   */
  function keepOlderPageAwayFromBottomEdge() {
    if (getHistoryParkedNewerLocal(chat).length === 0) return;
    const maxScroll = mountEl.scrollHeight - mountEl.clientHeight;
    if (maxScroll <= rv.SCROLL_STICK_THRESHOLD_PX * 4) return;
    if (mountEl.scrollTop < maxScroll - rv.SCROLL_STICK_THRESHOLD_PX * 2) return;
    mountEl.scrollTop = maxScroll - rv.SCROLL_STICK_THRESHOLD_PX * 3;
    rv.stickToBottom = false;
  }

  /**
   * Renders older records above the current stream, keeping the viewport visually anchored.
   *
   * @param {unknown[]} records
   * @returns {number} number of records rendered
   */
  function prependHistoryRecordsImpl(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const offscreen = document.createElement('div');
    offscreen.className = 'sdk-rich-stream';

    const previousStream = rv.stream;
    const previousSuppressPlain = rv.suppressHooksPlain;
    const previousSuppressPersist = rv.suppressHistoryPersist;
    const previousMdImmediate = rv.mdRenderImmediate;
    rv.stream = offscreen;
    rv.suppressHooksPlain = true;
    rv.suppressHistoryPersist = true;
    rv.mdRenderImmediate = true;
    rv.suppressAutoScroll = true;
    try {
      withIsolatedRenderState(() => {
        rv.applyHistoryRecordsInViewportBatches(records, 0, records.length, (record) => {
          rv.applyHistoryRecord(record);
        });
      });
    } finally {
      rv.stream = previousStream;
      rv.suppressHooksPlain = previousSuppressPlain;
      rv.suppressHistoryPersist = previousSuppressPersist;
      rv.mdRenderImmediate = previousMdImmediate;
      rv.suppressAutoScroll = false;
    }

    if (offscreen.childElementCount === 0) return 0;
    const heightBefore = mountEl.scrollHeight;
    const scrollBefore = mountEl.scrollTop;
    rv.suppressScrollStickUpdate = true;
    try {
      rv.realStream.prepend(...Array.from(offscreen.childNodes));
      rv.refreshDuplicateMailboxReports();
      mountEl.scrollTop = scrollBefore + (mountEl.scrollHeight - heightBefore);
      rv.adoptTrailingTimeoutProgressSeries();
      rv.enforceMountedHistoryWindowBudget();
      keepOlderPageAwayFromBottomEdge();
    } finally {
      const scheduleFrame =
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined;
      rv.historyReplayGenerationGate.scheduleMergedFrameWork(
        0,
        () => {
          rv.suppressScrollStickUpdate = false;
        },
        scheduleFrame,
      );
    }
    return records.length;
  }

  async function replayHistoryRecordsChunkedImpl(records, startIndex, replayGeneration) {
    if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) {
      if (rv.replayOutcomeByGeneration.has(replayGeneration)) {
        rv.settleReplayOutcome(replayGeneration, 'cancelled');
      }
      return;
    }
    let appliedCount = Math.min(records.length, Math.max(0, startIndex));
    rv.endHistoryReplayApplySlice();
    try {
      await runHistoryReplayAsyncTail({
        records,
        startIndex,
        replayGeneration,
        lifecycle: rv.historyReplayLifecycle,
        isCancelled: () => !rv.historyReplayGenerationGate.isActive(replayGeneration),
        onSliceStart: () => {
          if (rv.historyReplayGenerationGate.isActive(replayGeneration)) rv.beginViewportAnchorBatch();
          rv.beginHistoryReplayApplySlice(replayGeneration);
        },
        onSliceEnd: () => {
          rv.endHistoryReplayApplySlice();
          if (rv.viewportAnchorBatch.getDepth() > 0) rv.endViewportAnchorBatch();
        },
        applyHistoryRecord: (record) => {
          if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
          try {
            rv.applyHistoryRecord(record);
            appliedCount += 1;
            rv.noteReplayApplied(replayGeneration, appliedCount);
          } catch (err) {
            rv.endHistoryReplayApplySlice();
            while (rv.viewportAnchorBatch.getDepth() > 0) rv.endViewportAnchorBatch();
            throw err;
          }
        },
        scheduleFrame: typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined,
        getFinalizeSteps: () => rv.buildHistoryReplayFinalizeSteps(replayGeneration),
        getAppliedMeta: () => ({
          applied: appliedCount,
          children: rv.realStream.childElementCount,
        }),
      });
    } finally {
      rv.endHistoryReplayApplySlice();
    }
    if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
    if (!rv.replayOutcomeByGeneration.has(replayGeneration)) return;
    const reason = rv.historyReplayGenerationGate.isActive(replayGeneration) ? 'complete' : 'cancelled';
    rv.settleReplayOutcome(replayGeneration, reason);
  }

  rv.hasOlderHistory = false;
  rv.isLoadingOlderHistory = false;
  /** @type {IntersectionObserver | null} */
  let historyTopObserver = null;
  /** Records trimmed off the oldest edge of a page so it starts on a user turn. */
  rv.bufferedOlderRecords = [];
  /** @type {{ partIndex: number, partCount: number, includesTurnOpen: boolean } | null} */
  let historyTurnSegment = null;
  /**
   * Bumped on every (dis)arming. A page fetched under an older token belongs to a paging
   * session that no longer exists — applying it would resurrect a dead sentinel state
   * (notably `error` over `hidden`), leaving a retry button that can never load anything.
   */
  rv.historyArmToken = 0;

  /**
   * `idle` keeps the sentinel rendered but empty — it must have a box for IntersectionObserver
   * to ever report it; `hidden` is only for chats with nothing older to load.
   *
   * @param {'hidden'|'idle'|'loading'|'error'|'start'} state
   */
  function renderHistoryTopState(state) {
    rv.historyTopEl.replaceChildren();
    rv.historyTopEl.dataset.state = state;
    rv.historyTopEl.hidden = state === 'hidden';
    if (state === 'hidden' || state === 'idle') return;
    if (state === 'error') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'sdk-rich-history-top-retry';
      retry.textContent = t('sdkView.loadOlderFailed');
      retry.addEventListener('click', () => void retryOlderHistoryPage());
      rv.historyTopEl.appendChild(retry);
      return;
    }
    if (state === 'loading') {
      const spinner = document.createElement('span');
      spinner.className = 'sdk-rich-history-top-spinner';
      rv.historyTopEl.appendChild(spinner);
    }
    const label = document.createElement('span');
    label.className = 'sdk-rich-history-top-label';
    if (state === 'loading') {
      label.textContent = t('sdkView.loadingOlder');
    } else if (
      historyTurnSegment &&
      historyTurnSegment.includesTurnOpen !== true &&
      historyTurnSegment.partCount > 1
    ) {
      label.textContent = t('sdkView.historyTurnSegment', {
        part: historyTurnSegment.partIndex,
        total: historyTurnSegment.partCount,
      });
    } else {
      label.textContent = t('sdkView.historyStart');
    }
    rv.historyTopEl.appendChild(label);
  }

  function disconnectHistoryTopObserver() {
    if (!historyTopObserver) return;
    historyTopObserver.disconnect();
    historyTopObserver = null;
  }

  function ensureHistoryTopObserver() {
    if (historyTopObserver) return;
    if (typeof IntersectionObserver !== 'function') return;
    historyTopObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void loadOlderHistoryPage();
      },
      { root: mountEl, rootMargin: '200px 0px 0px 0px' },
    );
    historyTopObserver.observe(rv.historyTopEl);
  }

  /**
   * Re-observes the sentinel to force a fresh intersection report. Without it a sentinel that
   * stays visible after a page (short conversation, tall viewport) would never fire again,
   * because the observer only reports transitions.
   */
  function refreshHistoryTopObserver() {
    if (!historyTopObserver) return;
    historyTopObserver.unobserve(rv.historyTopEl);
    historyTopObserver.observe(rv.historyTopEl);
  }

  /**
   * Splits a page so the rendered part starts on a user turn; the older remainder waits
   * for the next page instead of showing a run without its opening prompt. A page with no
   * user turn is buffered whole — rendering it would split its Activity tray from the
   * earlier page that holds the run opening.
   *
   * @param {unknown[]} records
   * @returns {{ buffered: unknown[], renderable: unknown[] }}
   */
  function splitPageAtUserTurn(records) {
    const allowMidRunContinuation =
      (historyTurnSegment !== null && historyTurnSegment.includesTurnOpen !== true) ||
      rv.bufferedOlderRecords.length > 0;
    return splitHistoryPageAtUserTurn(records, { allowMidRunContinuation });
  }

  /**
   * @param {{ partIndex: number, partCount: number, includesTurnOpen: boolean } | null} segment
   */
  function setHistoryTurnSegment(segment) {
    if (
      !segment ||
      typeof segment !== 'object' ||
      !Number.isFinite(segment.partIndex) ||
      !Number.isFinite(segment.partCount)
    ) {
      historyTurnSegment = null;
      return;
    }
    historyTurnSegment = {
      partIndex: Math.max(1, Math.floor(Number(segment.partIndex))),
      partCount: Math.max(1, Math.floor(Number(segment.partCount))),
      includesTurnOpen: segment.includesTurnOpen === true,
    };
  }

  function finishOlderHistory() {
    disconnectHistoryTopObserver();
    renderHistoryTopState('start');
  }

  /**
   * The error state is only ever rendered while a page was owed, so a cleared `hasOlderHistory`
   * means the paging state was lost (e.g. the view got disarmed mid-flight), not that history
   * ended. Re-arm before retrying; a genuinely exhausted log answers with an empty page and the
   * sentinel settles on `start`.
   */
  function retryOlderHistoryPage() {
    if (rv.isLoadingOlderHistory) return undefined;
    const canFetch = typeof hooks.loadOlderHistory === 'function';
    if (!rv.hasOlderHistory && rv.bufferedOlderRecords.length === 0 && canFetch) rv.hasOlderHistory = true;
    return loadOlderHistoryPage();
  }

  async function loadOlderHistoryPage() {
    if (rv.isLoadingOlderHistory) return;
    if (!rv.hasOlderHistory && rv.bufferedOlderRecords.length === 0) return;
    const armToken = rv.historyArmToken;
    // Nothing can supply older pages — that is an exhausted history, not a failure.
    if (rv.hasOlderHistory && typeof hooks.loadOlderHistory !== 'function') {
      rv.hasOlderHistory = false;
      if (rv.bufferedOlderRecords.length === 0) {
        finishOlderHistory();
        return;
      }
    }
    rv.isLoadingOlderHistory = true;
    renderHistoryTopState('loading');
    const restoreBuffer = rv.bufferedOlderRecords;
    const restoreHasOlder = rv.hasOlderHistory;
    let retryRecords = restoreBuffer;
    try {
      let fetched = [];
      if (rv.hasOlderHistory) {
        const page = await hooks.loadOlderHistory();
        if (armToken !== rv.historyArmToken) return;
        if (!page) {
          renderHistoryTopState('error');
          return;
        }
        fetched = Array.isArray(page.records) ? page.records : [];
        rv.hasOlderHistory = page.hasOlder === true;
      }

      const batch = fetched.concat(rv.bufferedOlderRecords);
      retryRecords = batch;
      rv.bufferedOlderRecords = [];
      if (rv.hasOlderHistory) {
        const split = splitPageAtUserTurn(batch);
        rv.bufferedOlderRecords = split.buffered;
        prependHistoryRecordsImpl(split.renderable);
        if (
          historyTurnSegment &&
          split.renderable.length > 0 &&
          isUserTurnBoundaryRecord(split.renderable[0])
        ) {
          historyTurnSegment = { ...historyTurnSegment, includesTurnOpen: true };
          if (chat && typeof chat === 'object') chat._sdkHistoryTurnSegment = historyTurnSegment;
        }
      } else {
        prependHistoryRecordsImpl(batch);
      }

      if (rv.hasOlderHistory || rv.bufferedOlderRecords.length > 0) {
        renderHistoryTopState('idle');
        rv.isLoadingOlderHistory = false;
        refreshHistoryTopObserver();
        return;
      }
      finishOlderHistory();
    } catch (err) {
      appLogger.log('sdk-rich-history', 'older history page failed', {
        error: String(err?.message || err),
        stack: String(err?.stack || '').slice(0, 900),
      });
      if (armToken !== rv.historyArmToken) return;
      // Keep the fetched page too: its cursor may already have moved past it, and
      // dropping freshly buffered records here would make the retry skip that page.
      rv.bufferedOlderRecords = retryRecords;
      rv.hasOlderHistory = restoreHasOlder;
      renderHistoryTopState('error');
    } finally {
      rv.isLoadingOlderHistory = false;
    }
  }
}
