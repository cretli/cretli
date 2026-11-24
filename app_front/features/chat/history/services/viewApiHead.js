import { persistSdkRunFinishedHistoryStatus, presentSdkActivityTrayStatus } from '../../../../../lib/sdk/sdk-run-outcome.ts';
import { normalizeSdkUiMode } from '../../../../../lib/sdk/sdk-ui-mode.ts';
import { findReusableSdkThinkingBlockIndex } from '../../../../../lib/sdk/sdk-thinking-block-reuse.ts';
import { findReusableSdkAssistantBlockIndex } from '../../../../../lib/sdk/sdk-assistant-block-reuse.ts';
import { t } from '../../../../i18n/index.js';
import { resolveHarnessDisplayLabel } from '../../sdk-transport-labels.js';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { resolveEventStreamId } from '../../chatHistoryViewOrder.js';
import { clearHistoryMountedParking, getHistoryParkedNewerLocal } from '../../chatHistoryMountedParking.js';

/**
 * Public view API (first half): lifecycle, OpenCode interactions and prompts.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installViewApiHead(rv) {
  const { chat, mountEl, hooks } = rv;

  const viewPublicApi = {
    syncPendingQuestions(events) {
      if (chat._sdkHistoryHydrating || rv.suppressHistoryPersist) return;
      const activeIds = new Set(events.map((event) => event.requestId));
      for (const id of rv.openCodeQuestionByRequestId.keys()) {
        if (!activeIds.has(id)) rv.markOpenCodeQuestionResolved(id, { status: 'expired' });
      }
      for (const event of events) rv.renderOpenCodeQuestion(event, { persist: false });
    },

    getPendingInteractiveCounts() {
      const count = (cards, kind) => [...cards.values()].filter((block) => (
        block.isConnected
        && !block.classList.contains(`sdk-rich-opencode-${kind}--answered`)
        && !block.classList.contains(`sdk-rich-opencode-${kind}--resolved`)
      )).length;
      return {
        questions: count(rv.openCodeQuestionByRequestId, 'question'),
        permissions: count(rv.openCodePermissionByRequestId, 'permission'),
      };
    },

    destroy() {
      rv.viewDestroyed = true;
      rv.viewportController.dispose();
      rv.deferredBurstProtectIdentities.clear();
      for (const gen of [...rv.replayOutcomeByGeneration.keys()]) {
        rv.settleReplayOutcome(gen, 'destroyed');
      }
      rv.historyReplayGenerationGate.revoke();
      rv.historyReplayLifecycle.onViewDestroyed(rv.realStream.childElementCount);
      rv.mountedHistoryRecordRegistry.clear();
      rv.mountedDomNodeRegistry.clear();
      rv.mountedViewResourceLedger.resetAll();
      // Drop every recovery refresher the view registered (banner included):
      // a destroyed view must never be woken by a presence notify.
      for (const cleanup of [...rv.recoveryWidgetCleanups]) cleanup();
      rv.recoveryWidgetCleanups.clear();
      clearHistoryMountedParking(chat);
      mountEl.removeEventListener('scroll', rv.updateStickFromScroll);
      rv.stickResizeObserver?.disconnect();
      rv.stickResizeObserver = null;
      rv.viewportChildrenObserver?.disconnect();
      rv.viewportChildrenObserver = null;
      rv.scrollToBottomButton.remove();
      rv.disconnectHistoryTopObserver();
      if (rv.mdRaf) cancelAnimationFrame(rv.mdRaf);
      rv.mdRaf = 0;
      rv.stopTimeoutProgressSeries();
      rv.resetRenderedActivity();
      mountEl.innerHTML = '';
      mountEl.classList.remove('sdk-rich-chat-mount');
    },

    /**
     * Re-read the persisted recovery banner. The presence poll calls this when
     * a chat's recovery row appears or resolves; reload/second-device mounts
     * call it from the constructor when the presence row is already present.
     */
    refreshRecovery() {
      void rv.refreshChatRecoveryBanner();
    },

    /**
     * Arms (or disarms) auto-loading of older history. Called once hydration settled, so the
     * sentinel cannot fire against a still-empty stream.
     *
     * @param {boolean} available
     */
    setOlderHistoryAvailable(available) {
      rv.historyArmToken += 1;
      rv.hasOlderHistory = available === true;
      if (!rv.hasOlderHistory && rv.bufferedOlderRecords.length === 0) {
        rv.disconnectHistoryTopObserver();
        rv.renderHistoryTopState('hidden');
        return;
      }
      rv.renderHistoryTopState('idle');
      rv.ensureHistoryTopObserver();
    },

    setHistoryTurnSegment: rv.setHistoryTurnSegment,

    /**
     * @param {unknown[]} records
     * @returns {number}
     */
    prependHistoryRecords(records) {
      const cards = Array.isArray(records) ? records.length : 0;
      return rv.measureRenderSpan('history.prepend', { cards }, () => rv.prependHistoryRecordsImpl(records));
    },

    onStreamReset() {
      rv.runScope += 1;
      rv.openCodePermissionAdvisorMetaByRequestId.clear();
      rv.openCodeResolvedPermissionRequestIds.clear();
      rv.resumeThinkingAfterStreamReset = findReusableSdkThinkingBlockIndex(
        rv.listThinkingBlockEntries(),
        '',
        true
      ) >= 0;
      rv.resumeAssistantAfterStreamReset = findReusableSdkAssistantBlockIndex(
        rv.listAssistantBlockEntries(),
        true
      ) >= 0;
      rv.flushPendingAssistantMarkdown();
      rv.clearSegmentPointers();
      rv.stopTimeoutProgressSeries();
    },

    onHarnessBusy() {
      rv.openLiveTurn();
    },

    onHarnessIdle() {
      rv.closeLiveTurn();
      mountEl.removeAttribute('data-sdk-background-outstanding');
      mountEl.removeAttribute('title');
    },

    setBackgroundWorkOutstanding(count) {
      const outstanding = Math.max(0, Number(count) || 0);
      if (outstanding > 0) {
        mountEl.dataset.sdkBackgroundOutstanding = String(outstanding);
        mountEl.title = t('chat.sdkBackgroundWorkRunning', { count: outstanding });
      } else {
        delete mountEl.dataset.sdkBackgroundOutstanding;
        mountEl.removeAttribute('title');
      }
    },

    setUiMode(mode) {
      rv.uiMode = normalizeSdkUiMode(mode);
      chat.sdkUiMode = rv.uiMode;
      rv.applyUiModeVisibility();
      rv.scrollToBottom();
    },

    scrollToBottom: (opts = {}) => rv.scrollToBottom(opts),
    getViewportSnapshot: () => rv.viewportController.snapshot(),
    restoreViewportSnapshot: (snapshot) => rv.viewportController.restoreSnapshot(snapshot),
    isViewportAtBottom: () => rv.viewportController.isAtBottom(),
    isViewportNearBottom: () => rv.viewportController.isNearBottom(),

    /** Loading note while a chat opens; visible only until the first card renders. */
    setHistoryLoading(on) {
      rv.historyLoadingEl.hidden = on !== true;
    },

    /**
     * After the pane is shown again (chat switch): a following view goes to the live
     * end, a reader gets back the place they left.
     */
    restoreViewportAfterShow() {
      rv.viewportController.restoreSnapshot({
        following: rv.stickToBottom,
        scrollTop: rv.lastScrollTop,
        readingAnchor: rv.viewportController.state.readingAnchor,
      });
    },

    hasRenderedHistory() {
      return rv.stream.childElementCount > 0;
    },

    getCopyText() {
      if (!rv.copyTextDirty) return rv.copyTextCache;
      rv.copyTextCache = (rv.realStream.textContent || '').trimEnd();
      rv.copyTextDirty = false;
      return rv.copyTextCache;
    },

    get queuedCount() {
      return rv.queuedUserBlocks.length;
    },

    hasQueuedOrSentUserText(text) {
      return rv.hasQueuedOrSentUserText(text);
    },

    resolveOpenCodeQuestion(requestId, meta = {}) {
      rv.markOpenCodeQuestionResolved(requestId, meta);
    },

    resolveOpenCodePermission(requestId) {
      const id = String(requestId || '').trim();
      if (!id) return;
      rv.clearAdvisorPermissionPick(id);
      rv.openCodePermissionAdvisorMetaByRequestId.delete(id);
      rv.rememberResolvedOpenCodePermissionRequestId(id);
      const block = rv.openCodePermissionByRequestId.get(id);
      if (!block) return;
      block.classList.add('sdk-rich-opencode-permission--resolved');
      rv.openCodePermissionByRequestId.delete(id);
    },

    showOpenCodePermissionAdvisorPick(requestId, reply, applyAfterMs, meta = {}) {
      const id = String(requestId || '').trim();
      const choice = reply === 'always' || reply === 'reject' ? reply : 'once';
      const block = rv.openCodePermissionByRequestId.get(id);
      if (!id || !block) return;
      const advisorDecision = typeof meta?.advisorDecision === 'string' ? meta.advisorDecision : '';
      if (advisorDecision) rv.markOpenCodePermissionAdvisor(block, id, advisorDecision);
      if (block.classList.contains('sdk-rich-opencode-permission--answered')) return;
      const button = block.querySelector(`.sdk-rich-opencode-permission-${choice}`);
      if (!(button instanceof HTMLButtonElement)) return;
      rv.clearAdvisorPermissionPick(id);
      const baseLabel = button.dataset.baseLabel || button.textContent || choice;
      button.dataset.baseLabel = baseLabel;
      block.querySelectorAll('.sdk-rich-opencode-permission-actions button').forEach((el) => {
        el.classList.remove('is-advisor-pick');
        if (el instanceof HTMLButtonElement && el.dataset.baseLabel) el.textContent = el.dataset.baseLabel;
      });
      button.classList.add('is-advisor-pick');
      const waitMs = Number(applyAfterMs);
      const endsAt = Date.now() + (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0);
      const tick = () => {
        const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        button.textContent = left > 0 ? `${baseLabel} · ${left}s` : baseLabel;
        if (left <= 0) rv.clearAdvisorPermissionPick(id);
      };
      tick();
      if (endsAt > Date.now()) {
        rv.openCodeAdvisorPickTimers.set(id, setInterval(tick, 250));
      }
    },

    /** @returns {boolean} whether a permission card was found and marked */
    showOpenCodePermissionDecision(requestId, meta = {}) {
      return rv.markOpenCodePermissionDecision(requestId, meta);
    },

    showOpenCodePermissionAdvisorStatus(requestId, meta = {}) {
      const id = String(requestId || '').trim();
      if (!id) return;
      if (rv.isOpenCodePermissionRequestClosed(id)) return;
      const block = rv.openCodePermissionByRequestId.get(id);
      if (block?.classList.contains('sdk-rich-opencode-permission--resolved')) {
        rv.rememberResolvedOpenCodePermissionRequestId(id);
        return;
      }
      if (!block) {
        rv.mergeOpenCodePermissionAdvisorMeta(id, meta);
        return;
      }
      rv.markOpenCodePermissionAdvisorStatus(block, id, meta);
    },

    /** Whether advisor meta is buffered for reconnect / event-before-render (test hook). */
    isOpenCodePermissionAdvisorMetaBuffered(requestId) {
      const id = String(requestId || '').trim();
      return id ? rv.openCodePermissionAdvisorMetaByRequestId.has(id) : false;
    },

    appendBannerConnected(opts = {}) {
      rv.stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const transport = typeof opts.transport === 'string' ? opts.transport : 'sdk';
      const label = resolveHarnessDisplayLabel(transport);
      if (!silent) hooks.appendPlain(`\n[${label}] ${t('sdkView.connectedPlain')}\n`);
      rv.lineMeta(
        'sdk-rich-line--ok',
        `<span class="sdk-rich-badge sdk-rich-badge--ok">${escapeHtml(label)}</span> ${escapeHtml(t('sdkView.connected'))}`
      );
      // The banner is not persisted on purpose — otherwise every WS reconnect would pile up another "connected" line in history.
    },

    appendUserPrompt(text, opts = {}) {
      rv.stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const raw = text == null ? '' : String(text);
      // A new prompt jumps to the bottom; the parked newer tail goes back first so the
      // previous answers land above the prompt, not after it. The instant restore
      // applies its records synchronously before its first await.
      if (opts.forceScroll !== false && getHistoryParkedNewerLocal(chat).length > 0) {
        rv.stickToBottom = true;
        void rv.restoreParkedNewerTailIfNeeded({ all: true });
      }
      const echoKey = rv.renderUserTurn(raw, opts.createdAt || '', opts.origin || null, opts.requestId || '') || String(raw).trim();
      if (!echoKey) return;
      rv.openLiveTurn();
      if (!silent) hooks.appendPlain(`\n> ${echoKey}\n`);
      rv.scrollToBottom({ force: opts.forceScroll !== false });
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
        const createdAt = new Date().toISOString();
        hooks.onHistoryRecord({ kind: 'localUser', text: echoKey, createdAt, ...(opts.origin ? { origin: opts.origin } : {}), ...(opts.requestId ? { requestId: opts.requestId } : {}) });
      }
    },

    appendQueuedPrompt(text, position, opts = {}) {
      const silent = opts.silent === true;
      const raw = rv.normalizeUserPromptText(text);
      if (!raw) return;
      if (rv.queuedUserBlocks.some((item) => rv.normalizeUserPromptText(item.text) === raw)) return;
      const existing = rv.findUserBlockByText(raw);
      if (existing) {
        if (!existing.queued) return;
        this.markUserPromptQueued(raw);
        return;
      }
      const pos = Math.max(1, Number(position) || rv.queuedUserBlocks.length + 1);
      if (!silent) hooks.appendPlain(`\n> ${t('sdkView.queuedPlainTag', { n: pos })} ${raw}\n`);
      const block = rv.createUserBlock(raw);
      block.label = t('sdkView.youQueuedNumbered', { n: pos });
      rv.attachQueuedBlockActions(block, raw);
      rv.queuedUserBlocks.push({ text: raw, block });
      rv.relabelQueuedBlocks();
      rv.scrollToBottom({ force: opts.forceScroll === true });
    },

    markUserPromptQueued(text) {
      const raw = rv.normalizeUserPromptText(text);
      if (!raw) return false;
      if (rv.queuedUserBlocks.some((item) => rv.normalizeUserPromptText(item.text) === raw)) return true;
      const block = Array.from(rv.stream.children)
        .reverse()
        .find(
          (item) =>
            item?.localName === 'cr-sdk-block' &&
            rv.normalizeUserPromptText(item.copyText) === raw &&
            item.queued !== true,
        );
      if (!block) return false;
      rv.attachQueuedBlockActions(block, raw);
      rv.queuedUserBlocks.push({ text: raw, block });
      rv.relabelQueuedBlocks();
      rv.scrollToBottom();
      return true;
    },

    promoteQueuedPrompt(text, opts = {}) {
      const raw = rv.normalizeUserPromptText(text);
      if (!raw) return;
      const idx = rv.queuedUserBlocks.findIndex((item) => rv.normalizeUserPromptText(item.text) === raw);
      if (idx >= 0) {
        const item = rv.queuedUserBlocks.splice(idx, 1)[0];
        item.block.label = t('sdkView.you');
        item.block.classList.remove('sdk-rich-block--queued');
        item.block.queued = false;
        item.block.steerable = false;
        rv.placeBeforeQueuedBlocks(item.block);
        rv.applyUserBlockOrigin(item.block, raw, opts.origin || null, opts.requestId || '');
        chat._sdkLastLocalUserEcho = raw;
        rv.relabelQueuedBlocks();
        // The server starts the queued prompt; a reader scrolled up stays where they are.
        rv.scrollToBottom();
        return;
      }
      const existing = rv.findUserBlockByText(raw);
      if (existing) {
        if (opts.origin || opts.requestId) rv.applyUserBlockOrigin(existing, raw, opts.origin || null, opts.requestId || '');
        chat._sdkLastLocalUserEcho = raw;
        return;
      }
      this.appendUserPrompt(raw, { ...opts, forceScroll: false });
    },

    /**
     * Shows the Steer button on pending queue blocks when the transport can steer; it stays in
     * place (disabled) between turns so the buttons beside it never shift under a tap.
     *
     * @param {boolean} steerable
     * @param {boolean} [ready] a running turn accepts a steer right now
     */
    setQueuedSteerable(steerable, ready = steerable) {
      rv.queuedSteerable = steerable === true;
      rv.queuedSteerReady = ready === true;
      rv.queuedUserBlocks.forEach((item) => {
        if (!item?.block) return;
        item.block.steerable = rv.queuedSteerable;
        item.block.steerReady = rv.queuedSteerReady;
      });
    },

    /**
     * Applies the server queue order (UI texts, front first) after a `queueMove`.
     * Prompts this view does not know keep their relative place at the end.
     *
     * @param {string[]} order
     */
    reorderQueuedPrompts(order) {
      const keys = (Array.isArray(order) ? order : []).map((text) => rv.normalizeUserPromptText(text));
      const rank = (item) => {
        const idx = keys.indexOf(rv.normalizeUserPromptText(item.text));
        return idx < 0 ? keys.length : idx;
      };
      const sorted = rv.queuedUserBlocks
        .map((item, idx) => ({ item, idx }))
        .sort((a, b) => rank(a.item) - rank(b.item) || a.idx - b.idx)
        .map((entry) => entry.item);
      rv.queuedUserBlocks.splice(0, rv.queuedUserBlocks.length, ...sorted);
      // The queue is pinned to the bottom of the stream: re-append in the new order.
      sorted.forEach((item) => {
        const block = item.block;
        if (block && block.parentNode === rv.stream) rv.stream.appendChild(block);
      });
      rv.relabelQueuedBlocks();
    },

    removeQueuedPrompt(text) {
      const raw = rv.normalizeUserPromptText(text);
      const idx = rv.queuedUserBlocks.findIndex((item) => rv.normalizeUserPromptText(item.text) === raw);
      if (idx < 0) return;
      const item = rv.queuedUserBlocks.splice(idx, 1)[0];
      item.block?.remove();
      rv.relabelQueuedBlocks();
    },

    appendRunFinished(status, opts = {}) {
      const previousSeq = rv.renderedRecordHistorySeq;
      const previousRoom = rv.renderedRecordRoomEventSeq;
      const previousStream = rv.renderedRecordEventStreamId;
      rv.renderedRecordHistorySeq = Number(opts.historySeq) > 0 ? Number(opts.historySeq) : 0;
      rv.renderedRecordRoomEventSeq = Number(opts.roomEventSeq) > 0 ? Number(opts.roomEventSeq) : 0;
      rv.renderedRecordEventStreamId = resolveEventStreamId(opts);
      try {
      rv.stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const st = status == null ? '' : String(status);
      const errorCode = typeof opts.lastErrorCode === 'string' ? opts.lastErrorCode.trim() : '';
      const presented = presentSdkActivityTrayStatus({ status: st, lastErrorCode: errorCode });
      const display = rv.resolveActivityTrayLabel(presented.datasetStatus) || st;
      if (!silent) hooks.appendPlain(`\n[run finished: ${display}]\n`);
      // Paint the very last assistant delta before the turn closes; a pending
      // rAF would otherwise leave a mid-stream (often fence-open) render on
      // screen until the page is reloaded.
      rv.flushPendingAssistantMarkdown();
      rv.closeLiveTurn();
      rv.finalizeOpenToolCalls('', presented.terminalStatus || st);
      rv.runningToolCallsByRun.clear();
      rv.markAllTraysFinished(st, errorCode);
      const createdAt = rv.lineMeta(
        rv.resolveRunFinishedLineClass(st, errorCode),
        `<strong>${escapeHtml(t('sdkView.runFinished'))}</strong> · ${escapeHtml(display)}`,
        '',
        true
      );
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'runFinished',
          payload: persistSdkRunFinishedHistoryStatus({ status: st, lastErrorCode: errorCode }),
          createdAt,
        });
      }
      if (!silent && !rv.suppressHistoryPersist && typeof hooks.onAnswerEnd === 'function') {
        hooks.onAnswerEnd();
      }
      } finally {
        rv.renderedRecordHistorySeq = previousSeq;
        rv.renderedRecordRoomEventSeq = previousRoom;
        rv.renderedRecordEventStreamId = previousStream;
      }
    },

    appendBusy(message, opts = {}) {
      rv.stopTimeoutProgressSeries();
      const silent = opts.silent === true;
      const m = message == null ? '' : String(message).trim();
      const busyBadge = `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('sdkView.busy'))}</span>`;
      const busyLine = m ? `${busyBadge} ${escapeHtml(m)}` : busyBadge;
      if (!silent) hooks.appendPlain(`\n[SDK busy]${m ? ` ${m}` : ''}\n`);
      const createdAt = rv.lineMeta('sdk-rich-line--warn', busyLine);
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'busy',
          payload: m,
          createdAt,
        });
      }
    },

    appendError(message, opts = {}) {
      rv.discardTimeoutProgressSeries();
      const silent = opts.silent === true;
      const m = message == null ? '' : String(message);
      if (!silent) hooks.appendPlain(`\n[SDK error] ${m}\n`);
      const createdAt = rv.lineMeta(
        'sdk-rich-line--err',
        `<span class="sdk-rich-badge sdk-rich-badge--err">${escapeHtml(t('sdkView.error'))}</span> ${escapeHtml(m)}`
      );
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'error',
          payload: m,
          createdAt,
        });
      }
    },

    appendMetaNotice(text, opts = {}) {
      rv.handleMetaNotice(text, opts);
    },

    appendContextSeedBlock(summary, opts = {}) {
      const silent = opts.silent === true;
      const raw = summary == null ? '' : String(summary).trim();
      if (!raw) return;
      if (!silent) hooks.appendPlain(`\n[context seed]\n${raw}\n`);
      const block = rv.createContextSeedBlock(raw);
      rv.scrollToBottom();
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'contextSeed',
          payload: raw,
          createdAt: block.createdAt,
        });
      }
    },

    updateContextAdvisory(opts = {}) {
      rv.updateContextAdvisory(opts);
    },

  };
  rv.viewPublicApi = viewPublicApi;
}
