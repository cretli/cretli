import { findReusableSdkThinkingBlockIndex, restoreSdkThinkingAccumulator } from '../../../../../lib/sdk/sdk-thinking-block-reuse.ts';
import { registerRunItem } from '../../../../../lib/sdk/sdk-run-block-registry.ts';
import { findReusableSdkAssistantBlockIndex, restoreSdkAssistantAccumulator } from '../../../../../lib/sdk/sdk-assistant-block-reuse.ts';
import { cloneSerializableSdkEvent } from '../../../../lib/sdk-chat-history-store.js';
import { isUiFreezeTraceActive } from '../../../../lib/uiFreezeTrace.js';
import { t } from '../../../../i18n/index.js';
import { isTimeoutProgressSeriesBlock } from '../../timeoutProgressSeries.js';
import { decorateCodeForCopy, mdEngine, mdReadyListeners, renderMarkdownSource, renderMermaidDiagrams, whenHljsReady } from './markdownEngine.js';
import { appendInlineImageThumbs, collectInlineImageRefs, isImageLikeHref, screenshotPathToPreviewUrl, stripScreenshotMarkers } from './inlineImages.js';
import { formatTimeoutProgressSeconds } from './sdkEventNormalize.js';

/**
 * History persistence hooks, markdown painting and thinking/assistant block adoption.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installStreamBlocks(rv) {
  const { chat, mountEl, hooks } = rv;
  rv.persistThisSdkEvent = persistThisSdkEvent;
  rv.persistSdkStreamSnapshot = persistSdkStreamSnapshot;
  rv.flushMarkdown = flushMarkdown;
  rv.scheduleMd = scheduleMd;
  rv.clearSegmentPointers = clearSegmentPointers;
  rv.listThinkingBlockEntries = listThinkingBlockEntries;
  rv.resolveThinkingBlockForRun = resolveThinkingBlockForRun;
  rv.listAssistantBlockEntries = listAssistantBlockEntries;
  rv.resolveAssistantBlockAfterReset = resolveAssistantBlockAfterReset;
  rv.adoptAssistantBlock = adoptAssistantBlock;
  rv.rememberThinkingBlock = rememberThinkingBlock;
  rv.adoptThinkingBlock = adoptThinkingBlock;
  rv.stopTimeoutProgressTicker = stopTimeoutProgressTicker;
  rv.startTimeoutProgressTicker = startTimeoutProgressTicker;
  rv.renderTimeoutProgressSeriesDisplay = renderTimeoutProgressSeriesDisplay;
  rv.finalizeTimeoutProgressSeries = finalizeTimeoutProgressSeries;
  rv.stopTimeoutProgressSeries = stopTimeoutProgressSeries;
  rv.discardTimeoutProgressSeries = discardTimeoutProgressSeries;

  /**
   * @param {Record<string, unknown>} ev
   */
  function persistThisSdkEvent(ev) {
    if (rv.suppressHistoryPersist) return;
    if (typeof hooks.onHistoryRecord !== 'function') return;
    const cloned = cloneSerializableSdkEvent(ev);
    if (!cloned) return;
    hooks.onHistoryRecord({
      kind: 'sdk',
      event: cloned,
      createdAt: rv.renderedRecordCreatedAt || new Date().toISOString(),
    });
  }

  /**
   * Persists a streaming event (assistant/thinking) with the full accumulator text instead of
   * the raw, possibly partial, WS event. This guarantees that after "last one wins" coalescing
   * the history holds the complete text, so replay through takeStreamDelta stays deterministic
   * (full.startsWith(prev)) — fixes fragmented thinking/assistant output.
   *
   * @param {Record<string, unknown>} ev
   * @param {'assistant' | 'thinking'} kind
   * @param {string} acc full accumulator text
   */
  function persistSdkStreamSnapshot(ev, kind, acc) {
    if (rv.suppressHistoryPersist) return;
    if (typeof hooks.onHistoryRecord !== 'function') return;
    const cloned = cloneSerializableSdkEvent(ev);
    if (!cloned) return;
    if (kind === 'thinking') {
      cloned.text = acc;
    } else if (kind === 'assistant') {
      const msg = cloned.message && typeof cloned.message === 'object' ? cloned.message : {};
      cloned.message = { ...msg, content: [{ type: 'text', text: acc }] };
    }
    hooks.onHistoryRecord({
      kind: 'sdk',
      event: cloned,
      createdAt: rv.renderedRecordCreatedAt || new Date().toISOString(),
    });
  }

  /**
   * @param {HTMLElement} mdHost
   * @param {string} raw
   */
  function flushMarkdown(mdHost, raw, opts = {}) {
    if (!isUiFreezeTraceActive()) {
      paintMarkdown(mdHost, raw, opts);
      return;
    }
    const chars = raw == null ? 0 : String(raw).length;
    rv.measureRenderSpan('markdown.flush', { chars }, () => paintMarkdown(mdHost, raw, opts));
  }

  /**
   * @param {HTMLElement} mdHost
   * @param {string} raw
   * @param {{ diagrams?: boolean }} [opts]
   */
  function paintMarkdown(mdHost, raw, opts = {}) {
    const r = raw == null ? '' : String(raw);
    const textForDisplay = stripScreenshotMarkers(r);
    mdHost.dataset.rawMd = r;
    mdHost.innerHTML = renderMarkdownSource(textForDisplay);
    if (!mdEngine) {
      mdReadyListeners.add(() => {
        if (mdHost.dataset.rawMd !== r || !mdHost.isConnected) return;
        flushMarkdown(mdHost, r, opts);
      });
    }
    rv.markCopyTextDirty();
    decorateCodeForCopy(mdHost);
    if (opts.diagrams !== false) void renderMermaidDiagrams(mdHost);
    const mdLinkRefs = Array.from(mdHost.querySelectorAll('a[href]'))
      .map((el) => String(el.getAttribute('href') || '').trim())
      .filter((href) => isImageLikeHref(href))
      .map((href) => ({
        source: href,
        href: screenshotPathToPreviewUrl(href) || href,
      }));
    const markerRefs = collectInlineImageRefs(r);
    const thumbRefs = [];
    const seenThumbHref = new Set();
    for (const ref of [...markerRefs, ...mdLinkRefs]) {
      if (!ref || typeof ref !== 'object') continue;
      const href = String(ref.href || '').trim();
      if (!href || seenThumbHref.has(href)) continue;
      seenThumbHref.add(href);
      thumbRefs.push(ref);
    }
    appendInlineImageThumbs(mdHost, thumbRefs);
    rv.scrollToBottom();
  }

  /**
   * @param {HTMLElement} mdHost
   * @param {string} raw
   */
  function scheduleMd(mdHost, raw) {
    mdHost.dataset.rawMd = raw;
    if (rv.mdRenderImmediate) {
      flushMarkdown(mdHost, raw, { diagrams: false });
      return;
    }
    // One shared frame used to paint only the first host. A second Answer
    // created in the same turn kept an empty body.
    if (rv.mdScheduledHost && rv.mdScheduledHost !== mdHost) {
      const previous = rv.mdScheduledHost;
      rv.mdScheduledHost = null;
      flushMarkdown(previous, previous.dataset.rawMd || '', { diagrams: false });
    }
    if (rv.mdScheduledHost === mdHost) return;
    rv.mdScheduledHost = mdHost;
    const scheduleFrame =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined;
    rv.historyReplayGenerationGate.scheduleMergedFrameWork(
      0,
      () => {
        const host = rv.mdScheduledHost;
        rv.mdScheduledHost = null;
        if (!(host instanceof HTMLElement) || !host.isConnected) return;
        flushMarkdown(host, host.dataset.rawMd || '', { diagrams: false });
      },
      scheduleFrame,
    );
  }

  whenHljsReady(() => {
    mountEl.querySelectorAll('[data-raw-md]').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      flushMarkdown(el, el.dataset.rawMd || '', { diagrams: false });
    });
  });

  function clearSegmentPointers() {
    rv.setThinkingRunning(false);
    rv.assistantMdEl = null;
    rv.thinkingDetails = null;
    rv.thinkingPre = null;
    rv.activeKind = 'idle';
    rv.activeThinkingRunKey = '';
  }

  /**
   * @returns {Array<{ runKey: string, isConnected: boolean, isActivityOnly: boolean, hasThinkingPre: boolean, block: HTMLElement }>}
   */
  function listThinkingBlockEntries() {
    const entries = [];
    for (const [runKey, block] of rv.latestThinkingByRun.entries()) {
      if (!block) continue;
      entries.push({
        runKey,
        block,
        isConnected: block.isConnected === true,
        isActivityOnly: block.classList.contains('sdk-compact-activity-block'),
        hasThinkingPre: !!block.querySelector('.sdk-rich-thinking-pre'),
      });
    }
    return entries;
  }

  /**
   * @param {string} runKey
   * @returns {HTMLElement | null}
   */
  function resolveThinkingBlockForRun(runKey) {
    const entries = listThinkingBlockEntries();
    const index = findReusableSdkThinkingBlockIndex(
      entries,
      runKey,
      rv.resumeThinkingAfterStreamReset
    );
    if (index < 0) return null;
    return entries[index].block;
  }

  /**
   * @returns {Array<{ variant: string, isConnected: boolean, hasAssistantMd: boolean, timeoutProgress: boolean, block: HTMLElement }>}
   */
  function listAssistantBlockEntries() {
    const entries = [];
    for (const node of rv.stream.querySelectorAll(':scope > cr-sdk-block')) {
      if (!(node instanceof HTMLElement)) continue;
      const variant = typeof node.variant === 'string' ? node.variant : '';
      entries.push({
        variant,
        block: node,
        isConnected: node.isConnected === true,
        hasAssistantMd: !!node.querySelector('.sdk-rich-assistant-md'),
        timeoutProgress: isTimeoutProgressSeriesBlock(node),
      });
    }
    return entries;
  }

  /**
   * @returns {HTMLElement | null}
   */
  function resolveAssistantBlockAfterReset() {
    const entries = listAssistantBlockEntries();
    const index = findReusableSdkAssistantBlockIndex(entries, rv.resumeAssistantAfterStreamReset);
    if (index < 0) return null;
    return entries[index].block.querySelector('.sdk-rich-assistant-md');
  }

  /**
   * @param {HTMLElement} mdEl
   */
  function adoptAssistantBlock(mdEl) {
    rv.assistantMdEl = mdEl;
    rv.applyMessageSourceActions(mdEl?.closest?.('cr-sdk-block'));
    const restored = restoreSdkAssistantAccumulator(
      typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '',
      mdEl.dataset.rawMd || ''
    );
    if (restored) chat._sdkAssistantAcc = restored;
  }

  /**
   * @param {unknown} block
   * @param {string} runKey
   * @returns {void}
   */
  function rememberThinkingBlock(runKey, block) {
    if (!block) return;
    rv.latestThinkingByRun.set(runKey, block);
    registerRunItem(rv.thinkingBlocksByRun, runKey, block);
  }

  /**
   * @param {HTMLElement} block
   * @param {string} runKey
   */
  function adoptThinkingBlock(block, runKey) {
    rv.thinkingDetails = block;
    rv.thinkingPre = block.querySelector('.sdk-rich-thinking-pre');
    rememberThinkingBlock(runKey, block);
    rv.activeThinkingRunKey = runKey;
    if ('running' in block) {
      block.open = true;
    }
    const restored = block.dataset.reasoningUnavailable === 'true'
      ? ''
      : restoreSdkThinkingAccumulator(
        typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '',
        rv.thinkingPre ? rv.thinkingPre.textContent || '' : ''
      );
    if (restored) chat._sdkThinkingAcc = restored;
  }

  function stopTimeoutProgressTicker() {
    if (!rv.timeoutProgressTickTimer) return;
    clearInterval(rv.timeoutProgressTickTimer);
    rv.timeoutProgressTickTimer = 0;
  }

  function startTimeoutProgressTicker() {
    if (rv.timeoutProgressTickTimer) return;
    if (!rv.timeoutProgressSeries?.liveTick) return;
    rv.timeoutProgressTickTimer = setInterval(() => {
      renderTimeoutProgressSeriesLive();
    }, 1000);
  }

  /**
   * @param {number} idleSeconds
   * @param {number} remainingSeconds
   * @param {boolean} isStarted
   */
  function renderTimeoutProgressSeriesDisplay(idleSeconds, remainingSeconds, isStarted) {
    if (!rv.timeoutProgressSeries) return;

    if (isStarted) {
      rv.timeoutProgressSeries.progressFillEl.style.width = '0%';
      rv.timeoutProgressSeries.progressEl.setAttribute('aria-valuenow', '0');
      rv.timeoutProgressSeries.summaryEl.textContent = t('sdkView.promptSentWaiting');
      rv.timeoutProgressSeries.block.name =
        idleSeconds > 0
          ? t('sdkView.waitingFirstReplyWithTime', {
            time: formatTimeoutProgressSeconds(idleSeconds),
          })
          : t('sdkView.waitingFirstReply');
      return;
    }

    const totalSeconds = Math.max(rv.timeoutProgressSeries.totalSeconds, 1);
    const elapsedSeconds = Math.max(0, totalSeconds - remainingSeconds);
    const percent = Math.max(
      0,
      Math.min(100, Math.round((elapsedSeconds / totalSeconds) * 100))
    );
    rv.timeoutProgressSeries.progressFillEl.style.width = `${percent}%`;
    rv.timeoutProgressSeries.progressEl.setAttribute('aria-valuenow', String(percent));
    rv.timeoutProgressSeries.summaryEl.textContent = t('sdkView.timeoutProgressSummary', {
      idle: formatTimeoutProgressSeconds(idleSeconds),
      remaining: formatTimeoutProgressSeconds(remainingSeconds),
      percent,
    });
    rv.timeoutProgressSeries.block.name = t('sdkView.waitingBlockName', {
      idle: formatTimeoutProgressSeconds(idleSeconds),
      remaining: formatTimeoutProgressSeconds(remainingSeconds),
    });
  }

  function renderTimeoutProgressSeriesLive() {
    if (!rv.timeoutProgressSeries?.liveTick) return;
    const series = rv.timeoutProgressSeries;
    const anchorAt = Number(series.anchorAt) || Date.now();
    const deltaSec = Math.max(0, Math.floor((Date.now() - anchorAt) / 1000));
    const idleSeconds = Math.max(0, Number(series.anchorIdleSeconds) || 0) + deltaSec;
    const remainingSeconds = Math.max(0, (Number(series.anchorRemainingSeconds) || 0) - deltaSec);
    renderTimeoutProgressSeriesDisplay(idleSeconds, remainingSeconds, series.isStarted === true);
  }

  function finalizeTimeoutProgressSeries() {
    stopTimeoutProgressTicker();
    if (!rv.timeoutProgressSeries) return;
    rv.timeoutProgressSeries.block.running = false;
    rv.timeoutProgressSeries.block.label = '';
    rv.timeoutProgressSeries.liveTick = false;
    rv.timeoutProgressSeries = null;
  }

  function stopTimeoutProgressSeries() {
    finalizeTimeoutProgressSeries();
  }

  function discardTimeoutProgressSeries() {
    stopTimeoutProgressTicker();
    if (rv.timeoutProgressSeries?.block) {
      rv.timeoutProgressSeries.block.remove();
    }
    rv.timeoutProgressSeries = null;
  }
}
