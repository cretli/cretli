import { resolveSdkToolCallId } from '../../../../../lib/sdk/sdk-thinking-state.ts';
import { isPlaceholderSdkPlanMarkdown, pickSdkPlanKeeper, shouldFoldSdkPlanCard } from '../../../../../lib/sdk/sdk-plan-block-reuse.ts';
import { t } from '../../../../i18n/index.js';
import { hasViewOrderKey, isSameViewOrderKey, resolveViewOrderKey, shouldPlaceViewCardBefore, viewOrderIdentity } from '../../chatHistoryViewOrder.js';
import { TIMEOUT_PROGRESS_SERIES_CLASS, foldTimeoutProgressSeriesAtTail, isTimeoutProgressSeriesBlock, isTimeoutProgressSeriesSkipNode, trimTimeoutProgressUpdates } from '../../timeoutProgressSeries.js';
import { formatTimeoutProgressSeconds } from './sdkEventNormalize.js';

/**
 * Stream order keys, plan card folding, insert-scroll anchors and timeout progress series.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installStreamOrder(rv) {
  const { mountEl } = rv;
  rv.readElementOrderKey = readElementOrderKey;
  rv.stampElementOrderKey = stampElementOrderKey;
  rv.findInsertBeforeChild = findInsertBeforeChild;
  rv.findStreamChildByOrderKey = findStreamChildByOrderKey;
  rv.foldDuplicateOrderKeyCards = foldDuplicateOrderKeyCards;
  rv.findReusablePlanBlock = findReusablePlanBlock;
  rv.foldDuplicatePlanCards = foldDuplicatePlanCards;
  rv.noteInsertBeforeAnchor = noteInsertBeforeAnchor;
  rv.restoreInsertScroll = restoreInsertScroll;
  rv.appendStreamChild = appendStreamChild;
  rv.adoptTrailingTimeoutProgressSeries = adoptTrailingTimeoutProgressSeries;
  rv.appendTimeoutProgressSeries = appendTimeoutProgressSeries;

  /**
   * @param {HTMLElement} el
   * @returns {{ historySeq: number, roomEventSeq: number, eventStreamId: string }}
   */
  function readElementOrderKey(el) {
    if (!(el instanceof HTMLElement)) {
      return { historySeq: 0, roomEventSeq: 0, eventStreamId: '', createdAt: '' };
    }
    const historySeq =
      Number(/** @type {any} */ (el).historySeq)
      || Number(el.dataset.historySeq)
      || Number(el.getAttribute('history-seq'))
      || Number(el.dataset.delegationHistorySeq)
      || Number(el.dataset.mailboxHistorySeq)
      || 0;
    const roomEventSeq = Number(el.dataset.roomEventSeq) || 0;
    const propCreatedAt = /** @type {{ createdAt?: unknown }} */ (el).createdAt;
    const datasetCreatedAt =
      typeof el.dataset.createdAt === 'string' ? el.dataset.createdAt.trim() : '';
    const propTrimmed =
      typeof propCreatedAt === 'string' && propCreatedAt.trim() ? propCreatedAt.trim() : '';
    // View order uses durable timestamps only. Live room stamps get wall-clock
    // block.createdAt for display; that must not reorder HTTP catch-up cards.
    const createdAt = datasetCreatedAt
      || (historySeq > 0 && propTrimmed ? propTrimmed : '');
    return {
      ...resolveViewOrderKey({
        historySeq,
        roomEventSeq,
        eventStreamId: el.dataset.eventStreamId || '',
      }),
      createdAt,
    };
  }

  /**
   * @param {HTMLElement} el
   */
  function stampElementOrderKey(el) {
    if (!(el instanceof HTMLElement)) return;
    if (rv.renderedRecordHistorySeq > 0) {
      el.dataset.historySeq = String(rv.renderedRecordHistorySeq);
      if ('historySeq' in el) {
        /** @type {any} */ (el).historySeq = rv.renderedRecordHistorySeq;
      }
    }
    if (rv.renderedRecordRoomEventSeq > 0) {
      el.dataset.roomEventSeq = String(rv.renderedRecordRoomEventSeq);
    }
    if (rv.renderedRecordEventStreamId) {
      el.dataset.eventStreamId = rv.renderedRecordEventStreamId;
    }
  }

  /**
   * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} incomingKey
   * @returns {HTMLElement | null}
   */
  function findInsertBeforeChild(incomingKey) {
    if (rv.stream !== rv.realStream || !hasViewOrderKey(incomingKey)) return null;
    for (const child of rv.stream.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (shouldPlaceViewCardBefore(incomingKey, readElementOrderKey(child))) {
        return child;
      }
    }
    return null;
  }

  /**
   * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} incomingKey
   * @returns {HTMLElement | null}
   */
  function findStreamChildByOrderKey(incomingKey) {
    if (rv.stream !== rv.realStream || !hasViewOrderKey(incomingKey)) return null;
    for (const child of rv.stream.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (isSameViewOrderKey(incomingKey, readElementOrderKey(child))) return child;
    }
    return null;
  }

  function foldDuplicateOrderKeyCards() {
    if (rv.stream !== rv.realStream) return;
    const seen = new Set();
    for (const child of [...rv.stream.children]) {
      if (!(child instanceof HTMLElement)) continue;
      // A standalone Activity tray is created from the same history record as its first
      // (hidden) full tool block, so it shares that order key without being a duplicate.
      if (child.classList.contains('sdk-compact-activity-block')) continue;
      const id = viewOrderIdentity(readElementOrderKey(child));
      if (!id) continue;
      if (seen.has(id)) {
        child.remove();
        continue;
      }
      seen.add(id);
    }
    foldDuplicatePlanCards();
  }

  /**
   * @param {HTMLElement} block
   * @returns {string}
   */
  function readPlanBlockMarkdown(block) {
    if (!(block instanceof HTMLElement)) return '';
    const mdEl = block.querySelector('.sdk-rich-plan-md');
    if (mdEl instanceof HTMLElement && mdEl.dataset.rawMd) return mdEl.dataset.rawMd;
    return mdEl ? String(mdEl.textContent || '') : '';
  }

  /**
   * @returns {HTMLElement[]}
   */
  function listPlanBlocks() {
    return [...rv.stream.children].filter((el) => (
      el instanceof HTMLElement && el.variant === 'plan'
    ));
  }

  /**
   * @param {string} callId
   * @returns {HTMLElement | null}
   */
  function findReusablePlanBlock(callId) {
    const id = String(callId || '').trim();
    const fromMap = id ? rv.planByCallId.get(id) : null;
    if (fromMap instanceof HTMLElement && fromMap.isConnected) return fromMap;
    const plans = listPlanBlocks();
    if (id) {
      const sameId = plans.find((el) => resolveSdkToolCallId({ call_id: el.dataset.callId }) === id);
      if (sameId) return sameId;
    }
    const placeholder = plans.find((el) => {
      const existingId = resolveSdkToolCallId({ call_id: el.dataset.callId });
      return !existingId && isPlaceholderSdkPlanMarkdown(readPlanBlockMarkdown(el));
    });
    if (placeholder) return placeholder;
    if (plans.length === 1) return plans[0];
    return null;
  }

  /**
   * @param {HTMLElement | null} [_preferred]
   */
  function foldDuplicatePlanCards(_preferred = null) {
    const plans = listPlanBlocks();
    if (plans.length < 2) return;
    const cards = plans.map((el) => ({
      el,
      callId: resolveSdkToolCallId({ call_id: el.dataset.callId }),
      status: String(el.label || ''),
      text: readPlanBlockMarkdown(el),
    }));
    const keeper = pickSdkPlanKeeper(cards);
    if (!keeper) return;
    for (const card of cards) {
      if (card.el === keeper.el) continue;
      if (shouldFoldSdkPlanCard(card, keeper)) card.el.remove();
    }
    const keepId = String(keeper.callId || '').trim();
    if (keepId && keeper.el instanceof HTMLElement) rv.planByCallId.set(keepId, keeper.el);
  }

  /**
   * @param {HTMLElement | null} later
   */
  function captureInsertScroll(later) {
    if (!(later instanceof HTMLElement) || !(mountEl instanceof HTMLElement)) return;
    rv.noteForcedGeometryRead('getBoundingClientRect');
    rv.pendingViewportAnchor = {
      el: later,
      top: later.getBoundingClientRect().top,
    };
    rv.preserveViewportAnchor = true;
  }

  /**
   * @param {HTMLElement | null} later
   */
  function noteInsertBeforeAnchor(later) {
    if (!(later instanceof HTMLElement)) return;
    rv.viewportAnchorBatch.noteInsertBefore(
      () => captureInsertScroll(later),
      () => {
        rv.preserveViewportAnchor = true;
      },
    );
  }

  function restoreInsertScroll() {
    const anchor = rv.pendingViewportAnchor;
    if (!anchor?.el?.isConnected || !(mountEl instanceof HTMLElement)) return;
    rv.noteForcedGeometryRead('getBoundingClientRect');
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 0.5) return;
    mountEl.scrollTop += delta;
    rv.noteForcedGeometryRead('getBoundingClientRect');
    anchor.top = anchor.el.getBoundingClientRect().top;
  }

  /**
   * @param {HTMLElement} el
   * @param {{ skipTimeoutFinalize?: boolean }} [opts]
   */
  function appendStreamChild(el, opts = {}) {
    if (!(el instanceof HTMLElement)) return;
    const skipTimeoutFinalize = opts.skipTimeoutFinalize === true
      || el.hidden === true
      || isTimeoutProgressSeriesSkipNode(el)
      || isTimeoutProgressSeriesBlock(el);
    if (!skipTimeoutFinalize) {
      rv.finalizeTimeoutProgressSeries();
    }
    stampElementOrderKey(el);
    rv.lastStreamChild = el;
    const before = rv.stream === rv.realStream && !rv.suppressAutoScroll
      ? findInsertBeforeChild(readElementOrderKey(el))
      : null;
    if (!before) {
      rv.stream.appendChild(el);
    } else {
      rv.preserveViewportAnchor = true;
      rv.stream.insertBefore(el, before);
    }
    if (rv.stream === rv.realStream) {
      rv.mountedDomNodeRegistry.trackSubtree(el);
    }
  }

  /**
   * @param {HTMLElement} block
   * @returns {number}
   */
  function readTimeoutSeriesTotalSeconds(block) {
    const raw = Number(block?.dataset?.timeoutTotalSeconds);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /**
   * @param {HTMLElement} block
   */
  function hydrateTimeoutProgressSeries(block) {
    if (!(block instanceof HTMLElement)) return null;
    const summaryEl = block.querySelector('.sdk-timeout-progress__summary');
    const progressEl = block.querySelector('.sdk-timeout-progress__bar');
    const progressFillEl = block.querySelector('.sdk-timeout-progress__bar-fill');
    const updatesEl = block.querySelector('.sdk-timeout-progress__updates');
    if (!summaryEl || !progressEl || !progressFillEl || !updatesEl) return null;
    return {
      block,
      summaryEl,
      progressFillEl,
      progressEl,
      updatesEl,
      totalSeconds: readTimeoutSeriesTotalSeconds(block),
      updates: updatesEl.childElementCount,
    };
  }

  function adoptTrailingTimeoutProgressSeries() {
    if (rv.stream !== rv.realStream) return;
    const { keeper } = foldTimeoutProgressSeriesAtTail({
      streamLastChild: rv.stream.lastElementChild,
    });
    if (!(keeper instanceof HTMLElement)) {
      if (!rv.timeoutProgressSeries?.block?.isConnected) rv.timeoutProgressSeries = null;
      return;
    }
    if (rv.timeoutProgressSeries?.block === keeper) return;
    const hydrated = hydrateTimeoutProgressSeries(keeper);
    if (hydrated) rv.timeoutProgressSeries = hydrated;
  }

  function resolveReusableTimeoutProgressSeries() {
    const incomingKey = resolveViewOrderKey({
      historySeq: rv.renderedRecordHistorySeq,
      roomEventSeq: rv.renderedRecordRoomEventSeq,
      eventStreamId: rv.renderedRecordEventStreamId,
    });
    const insertBefore = rv.stream === rv.realStream && hasViewOrderKey(incomingKey)
      ? findInsertBeforeChild(incomingKey)
      : null;
    const { keeper } = foldTimeoutProgressSeriesAtTail({
      insertBefore,
      streamLastChild: rv.stream.lastElementChild,
    });
    if (keeper instanceof HTMLElement) {
      const hydrated = hydrateTimeoutProgressSeries(keeper);
      if (hydrated) return hydrated;
    }
    if (rv.timeoutProgressSeries?.block?.isConnected) return rv.timeoutProgressSeries;
    return null;
  }

  /**
   * @param {{ idleSeconds: number, remainingSeconds: number, totalSeconds?: number, isStarted?: boolean }} parsed
   */
  function appendTimeoutProgressSeries(parsed) {
    if (!parsed) return;
    const isStarted = parsed.isStarted === true;
    const idleSeconds = Math.max(0, Number(parsed.idleSeconds) || 0);
    const remainingSeconds = Math.max(0, Number(parsed.remainingSeconds) || 0);

    rv.timeoutProgressSeries = resolveReusableTimeoutProgressSeries();
    if (!rv.timeoutProgressSeries) {
      const block = rv.createSdkBlock({
        variant: 'warn',
        label: '',
        name: t('sdkView.waitingForAgentReply'),
        open: false,
        skipTimeoutFinalize: true,
      });
      block.classList.add(TIMEOUT_PROGRESS_SERIES_CLASS);
      block.running = true;

      const body = document.createElement('div');
      body.className = 'sdk-timeout-progress';
      const summaryEl = document.createElement('div');
      summaryEl.className = 'sdk-timeout-progress__summary';
      const progressEl = document.createElement('div');
      progressEl.className = 'sdk-timeout-progress__bar';
      progressEl.setAttribute('role', 'progressbar');
      progressEl.setAttribute('aria-valuemin', '0');
      progressEl.setAttribute('aria-valuemax', '100');
      const progressFillEl = document.createElement('div');
      progressFillEl.className = 'sdk-timeout-progress__bar-fill';
      progressEl.appendChild(progressFillEl);
      const updatesEl = document.createElement('div');
      updatesEl.className = 'sdk-timeout-progress__updates';
      body.append(summaryEl, progressEl, updatesEl);
      block.appendChild(body);

      rv.timeoutProgressSeries = {
        block,
        summaryEl,
        progressFillEl,
        progressEl,
        updatesEl,
        totalSeconds: 0,
        updates: 0,
      };
    }

    const explicitTotal = Math.max(0, Number(parsed.totalSeconds) || 0);
    const inferredTotal = idleSeconds + remainingSeconds;
    const totalSeconds = Math.max(
      rv.timeoutProgressSeries.totalSeconds,
      explicitTotal,
      inferredTotal
    );
    rv.timeoutProgressSeries.totalSeconds = Math.max(totalSeconds, 1);
    if (rv.timeoutProgressSeries.block instanceof HTMLElement) {
      rv.timeoutProgressSeries.block.classList.add(TIMEOUT_PROGRESS_SERIES_CLASS);
      rv.timeoutProgressSeries.block.dataset.timeoutTotalSeconds = String(
        rv.timeoutProgressSeries.totalSeconds
      );
    }
    if (!isStarted) {
      rv.timeoutProgressSeries.updates += 1;
    }
    rv.timeoutProgressSeries.block.running = true;
    rv.timeoutProgressSeries.block.label = '';
    rv.timeoutProgressSeries.isStarted = isStarted;
    rv.timeoutProgressSeries.anchorAt = Date.now();
    rv.timeoutProgressSeries.anchorIdleSeconds = idleSeconds;
    rv.timeoutProgressSeries.anchorRemainingSeconds = remainingSeconds;
    rv.timeoutProgressSeries.liveTick = !rv.suppressHistoryPersist;

    rv.renderTimeoutProgressSeriesDisplay(idleSeconds, remainingSeconds, isStarted);
    if (rv.timeoutProgressSeries.liveTick) {
      rv.startTimeoutProgressTicker();
    } else {
      rv.stopTimeoutProgressTicker();
    }

    if (!isStarted) {
      const updateLine = document.createElement('div');
      updateLine.className = 'sdk-timeout-progress__update';
      updateLine.textContent =
        `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}` +
        ` • ${t('sdkView.timeoutProgressUpdate', {
          idle: formatTimeoutProgressSeconds(idleSeconds),
          remaining: formatTimeoutProgressSeconds(remainingSeconds),
        })}`;
      rv.timeoutProgressSeries.updatesEl.prepend(updateLine);
      trimTimeoutProgressUpdates(rv.timeoutProgressSeries.updatesEl);
    }
    rv.scrollToBottom();
  }
}
