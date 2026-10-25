import { normalizeSdkUiMode } from '../../../../../lib/sdk/sdk-ui-mode.ts';
import { createViewportAnchorBatchController } from '../../../../lib/sdkRichViewViewportBatch.js';
import { getChatSpeaker } from '../../../voice/chatSpeaker.js';
import { getHistoryParkedNewerLocal } from '../../chatHistoryMountedParking.js';

/**
 * Per-run render maps, scroll-stick state and viewport anchor batching.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installViewScroll(rv) {
  const { chat, mountEl, hooks } = rv;
  rv.markCopyTextDirty = markCopyTextDirty;
  rv.noteForcedGeometryRead = noteForcedGeometryRead;
  rv.noteApplyEventBurst = noteApplyEventBurst;
  rv.beginViewportAnchorBatch = beginViewportAnchorBatch;
  rv.endViewportAnchorBatch = endViewportAnchorBatch;
  rv.applyHistoryRecordsInViewportBatches = applyHistoryRecordsInViewportBatches;
  rv.isScrollableNearBottom = isScrollableNearBottom;
  rv.stickScrollToBottom = stickScrollToBottom;
  rv.updateStickFromScroll = updateStickFromScroll;
  rv.scrollToBottom = scrollToBottom;
  rv.scrollToBottomForReplay = scrollToBottomForReplay;

  const compactTrayHosts = new Set();
  rv.compactTrayHosts = compactTrayHosts;
  const fullToolBlocks = new Set();
  rv.fullToolBlocks = fullToolBlocks;
  const compactStatusLines = new Set();
  rv.compactStatusLines = compactStatusLines;
  const latestThinkingByRun = new Map();
  rv.latestThinkingByRun = latestThinkingByRun;
  const latestTrayByRun = new Map();
  rv.latestTrayByRun = latestTrayByRun;
  /** @type {Map<string, Set<unknown>>} Every Thinking/Activity block a run has rendered. */
  const thinkingBlocksByRun = new Map();
  rv.thinkingBlocksByRun = thinkingBlocksByRun;
  /** @type {Map<string, Set<unknown>>} Every Activity tray a run has rendered. */
  const traysByRun = new Map();
  rv.traysByRun = traysByRun;
  const runStatusByRun = new Map();
  rv.runStatusByRun = runStatusByRun;
  const runningToolCallsByRun = new Map();
  rv.runningToolCallsByRun = runningToolCallsByRun;
  rv.runScope = 1;
  /**
   * User prompt / RUNNING opens this; FINISHED / harness idle closes it.
   * Stream reset must not reopen it — late thinking after a finished run
   * would otherwise spawn a new local-run-* spinner that never stops.
   */
  rv.isLiveTurn = false;
  rv.lastRenderedMode = '';
  rv.uiMode = normalizeSdkUiMode(chat.sdkUiMode);
  /** After WS hello/reconnect, keep using the live Thinking block (same run, new local-run key). */
  rv.resumeThinkingAfterStreamReset = false;
  /** After WS hello/reconnect, keep using the live Answer block instead of spawning a duplicate. */
  rv.resumeAssistantAfterStreamReset = false;

  /** @type {'assistant'|'thinking'|'idle'} */
  rv.activeKind = 'idle';
  rv.activeThinkingRunKey = '';

  /** When true (replay from Agent.messages.list) — do not append to the plaintext buffer in chat.js. */
  rv.suppressHooksPlain = false;

  /** When true — do not write to the local structured history (replay / applyAgentMessagesHistory). */
  rv.suppressHistoryPersist = false;

  /** When true (history replay) — render Markdown synchronously, without the shared rAF. */
  rv.mdRenderImmediate = false;

  /** Record timestamp of the SDK event currently being rendered. */
  rv.renderedRecordCreatedAt = '';
  rv.renderedRecordHistorySeq = 0;
  rv.renderedRecordRoomEventSeq = 0;
  rv.renderedRecordEventStreamId = '';
  /** Mid-stream insert of a recovered hole: keep the visible card, skip autoscroll. */
  rv.preserveViewportAnchor = false;
  /** @type {{ el: HTMLElement, top: number } | null} */
  rv.pendingViewportAnchor = null;
  const viewportAnchorBatch = createViewportAnchorBatchController({
    capture: () => {},
    restore: () => {
      if (!rv.preserveViewportAnchor || !rv.pendingViewportAnchor) return;
      rv.restoreInsertScroll();
      rv.pendingViewportAnchor = null;
      rv.preserveViewportAnchor = false;
    },
  });
  rv.viewportAnchorBatch = viewportAnchorBatch;
  /** Last node passed through appendStreamChild — cards must not assume lastElementChild. */
  rv.lastStreamChild = null;

  rv.mdRaf = 0;
  /** Host the pending animation frame will paint. A second Answer in the same frame must not be dropped. */
  rv.mdScheduledHost = null;
  rv.copyTextCache = '';
  rv.copyTextDirty = true;
  function markCopyTextDirty() {
    rv.copyTextDirty = true;
  }
  /** @type {{
   *   block: HTMLElement,
   *   summaryEl: HTMLElement,
   *   progressFillEl: HTMLElement,
   *   progressEl: HTMLElement,
   *   updatesEl: HTMLElement,
   *   totalSeconds: number,
   *   updates: number,
   *   isStarted?: boolean,
   *   anchorAt?: number,
   *   anchorIdleSeconds?: number,
   *   anchorRemainingSeconds?: number,
   *   liveTick?: boolean
   * } | null} */
  rv.timeoutProgressSeries = null;
  rv.timeoutProgressTickTimer = 0;

  const SCROLL_STICK_THRESHOLD_PX = 64;
  rv.SCROLL_STICK_THRESHOLD_PX = SCROLL_STICK_THRESHOLD_PX;
  /** When false — the user scrolled up; do not autoscroll while streaming. */
  rv.stickToBottom = true;
  rv.suppressScrollStickUpdate = false;
  /** When true (rendering an older history page) — nothing may pull the viewport to the bottom. */
  rv.suppressAutoScroll = false;

  function isHistoryHydrating() {
    return !!(chat && typeof chat === 'object' && chat._sdkHistoryHydrating === true);
  }

  function noteForcedGeometryRead(kind) {
    const probe = globalThis.__cretliUiFreezeGeometryProbe;
    if (!probe || typeof probe !== 'object') return;
    const key = String(kind || 'unknown');
    probe[key] = (Number(probe[key]) || 0) + 1;
  }

  const APPLY_EVENT_BURST_SYNC_LIMIT = 6;
  let applyEventBurstCount = 0;
  let applyEventBurstFlushQueued = false;
  /** Every live-remount identity seen during the burst; all stay protected in the deferred pass. */
  const deferredBurstProtectIdentities = new Set();
  rv.deferredBurstProtectIdentities = deferredBurstProtectIdentities;
  rv.viewDestroyed = false;

  /**
   * Counts applyEvent calls inside one task. Returns true once the burst exceeds the
   * synchronous limit; a single microtask then runs the skipped post-processing.
   * @returns {boolean}
   */
  function noteApplyEventBurst() {
    applyEventBurstCount += 1;
    if (!applyEventBurstFlushQueued) {
      applyEventBurstFlushQueued = true;
      queueMicrotask(() => {
        const ranDeferred = applyEventBurstCount > APPLY_EVENT_BURST_SYNC_LIMIT;
        applyEventBurstFlushQueued = false;
        applyEventBurstCount = 0;
        if (!ranDeferred || rv.viewDestroyed) return;
        const protectIds = [...deferredBurstProtectIdentities];
        deferredBurstProtectIdentities.clear();
        rv.foldDuplicateOrderKeyCards();
        rv.enforceMountedHistoryWindowBudget({ protectTailRemountIdentities: protectIds });
      });
    }
    return applyEventBurstCount > APPLY_EVENT_BURST_SYNC_LIMIT;
  }

  function beginViewportAnchorBatch() {
    viewportAnchorBatch.begin();
  }

  function endViewportAnchorBatch() {
    viewportAnchorBatch.end();
  }

  /**
   * @param {unknown[]} records
   * @param {number} startIndex
   * @param {number} endIndexExclusive
   * @param {(record: unknown, index: number) => void} applyFn
   */
  function applyHistoryRecordsInViewportBatches(records, startIndex, endIndexExclusive, applyFn) {
    viewportAnchorBatch.forEachRecordInTimeBudget(startIndex, endIndexExclusive, (index) => {
      applyFn(records[index], index);
    });
  }

  function isNearBottom() {
    if (rv.suppressHistoryPersist) return rv.stickToBottom;
    const maxScroll = mountEl.scrollHeight - mountEl.clientHeight;
    if (maxScroll <= 0) return true;
    return mountEl.scrollTop >= maxScroll - SCROLL_STICK_THRESHOLD_PX;
  }

  /**
   * Autoscrolls a scrollable element (e.g. the thinking <pre>) to newly appended text,
   * but only while the user sits at the bottom — a manual scroll up must not be overridden.
   * @param {HTMLElement} el
   * @returns {boolean} whether the element should be pinned to the bottom after the update
   */
  function isScrollableNearBottom(el) {
    if (!el) return false;
    if (isHistoryHydrating() || rv.suppressHistoryPersist) return false;
    noteForcedGeometryRead('scrollHeight');
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) return true;
    return el.scrollTop >= maxScroll - SCROLL_STICK_THRESHOLD_PX;
  }

  /** @param {HTMLElement} el */
  function stickScrollToBottom(el) {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function updateStickFromScroll() {
    if (rv.suppressScrollStickUpdate) return;
    rv.stickToBottom = isNearBottom();
    const maxScroll = mountEl.scrollHeight - mountEl.clientHeight;
    rv.scrollToBottomButton.hidden = maxScroll <= SCROLL_STICK_THRESHOLD_PX || rv.stickToBottom;
    // Not gated on a false→true transition: a forced scrollToBottom() sets stickToBottom
    // before this runs, which used to leave tail cards parked off-screen forever.
    if (rv.stickToBottom && getHistoryParkedNewerLocal(chat).length > 0) {
      void rv.restoreParkedNewerTailIfNeeded();
    }
  }

  /**
   * @param {{ force?: boolean } | boolean} [opts]
   */
  function scrollToBottom(opts) {
    const force = opts === true || (opts && typeof opts === 'object' && opts.force === true);
    // Explicit user navigation must work even while history paging has disabled
    // automatic scroll adjustments; those guards are only for background updates.
    if (!force && (rv.suppressAutoScroll || rv.preserveViewportAnchor)) return;
    if (!force && !rv.stickToBottom) return;
    if (force) rv.stickToBottom = true;
    const scheduleFrame =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined;
    rv.historyReplayGenerationGate.scheduleMergedFrameWork(
      0,
      () => {
        try {
          rv.suppressScrollStickUpdate = true;
          mountEl.scrollTop = mountEl.scrollHeight;
        } catch (_) {
          /* ignore */
        } finally {
          rv.suppressScrollStickUpdate = false;
          updateStickFromScroll();
        }
      },
      scheduleFrame,
    );
  }

  /**
   * @param {number} replayGeneration
   * @param {{ force?: boolean } | boolean} [opts]
   */
  function scrollToBottomForReplay(replayGeneration, opts) {
    if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
    const force = opts === true || (opts && typeof opts === 'object' && opts.force === true);
    if (!force && (rv.suppressAutoScroll || rv.preserveViewportAnchor)) return;
    if (!force && !rv.stickToBottom) return;
    if (force) rv.stickToBottom = true;
    const scheduleFrame =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined;
    rv.historyReplayGenerationGate.scheduleGuardedScroll(
      replayGeneration,
      () => {
        try {
          rv.suppressScrollStickUpdate = true;
          mountEl.scrollTop = mountEl.scrollHeight;
        } catch (_) {
          /* ignore */
        } finally {
          rv.suppressScrollStickUpdate = false;
          updateStickFromScroll();
        }
      },
      scheduleFrame,
    );
  }

  mountEl.addEventListener('scroll', updateStickFromScroll, { passive: true });
  rv.scrollToBottomButton.addEventListener('click', () => scrollToBottom({ force: true }));

  mountEl.addEventListener('cr-sdk-block-speak', (event) => {
    const detail = event?.detail || {};
    if (typeof detail.text !== 'string' || !detail.text) return;
    getChatSpeaker().toggleSpeakMarkdown(detail.text, detail.token || '');
  });

  mountEl.addEventListener('cr-sdk-block-fork', (event) => {
    const block = event?.target;
    const createdAt =
      block instanceof HTMLElement && typeof /** @type {any} */ (block).createdAt === 'string'
        ? /** @type {any} */ (block).createdAt.trim()
        : '';
    if (!createdAt) return;
    if (typeof hooks.onForkFromPoint === 'function') hooks.onForkFromPoint({ createdAt });
  });

  mountEl.addEventListener('cr-sdk-block-pass', (event) => {
    const point = rv.readBlockMessagePoint(event?.target);
    if (!point.text) return;
    if (typeof hooks.onPassMessageToChild === 'function') hooks.onPassMessageToChild(point);
  });

  mountEl.addEventListener('cr-sdk-block-reply', (event) => {
    const point = rv.readBlockMessagePoint(event?.target);
    if (!point.text) return;
    if (typeof hooks.onReplyMessageToParent === 'function') hooks.onReplyMessageToParent(point);
  });
}
