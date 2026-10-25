import { probeSync } from '../../../../lib/perfProbe.js';
import { presentSdkActivityTrayStatus } from '../../../../../lib/sdk/sdk-run-outcome.ts';
import { parseExplicitSdkMode, shouldRenderModeChange } from '../../../../../lib/sdk/sdk-mode.ts';
import { parseContextSeedPayload } from '../../../../lib/context-seed-payload.js';
import { parseInheritedPrompt } from '../../../../../lib/conversation-fork.js';
import { t } from '../../../../i18n/index.js';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { resolveEventStreamId, resolveViewOrderKey, viewOrderIdentity } from '../../chatHistoryViewOrder.js';
import { removeHistoryRecordFromMountedParking } from '../../chatHistoryMountedParking.js';
import { isMountedHistoryRecordApplied, isMountedViewOrderKeyApplied, resolveMountedRecordIdentity } from '../../../../lib/sdkHistoryMountedWindow.js';

/**
 * Ordered apply of live events and persisted history records.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installHistoryApply(rv) {
  const { chat } = rv;
  rv.flushPendingAssistantMarkdown = flushPendingAssistantMarkdown;
  rv.runViewApplyWithOrder = runViewApplyWithOrder;
  rv.applyHistoryRecord = applyHistoryRecord;

  /**
   * Recovered earlier seqs must not reuse the live tail's assistant/thinking pointers.
   * A proven new stream starts a fresh tail card so room seq 1 cannot merge into
   * an older session. Isolation is the wrong tool here: restoring the old
   * assistant pointer would keep later deltas on the previous stream.
   *
   * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} incomingKey
   * @returns {boolean}
   */
  function shouldStartFreshTailForNewEventStream(incomingKey) {
    if (rv.stream !== rv.realStream) return false;
    const incomingStream = resolveEventStreamId(incomingKey);
    if (!incomingStream) return false;
    const tail = rv.lastStreamChild instanceof HTMLElement
      ? rv.lastStreamChild
      : (rv.stream.lastElementChild instanceof HTMLElement ? rv.stream.lastElementChild : null);
    if (!tail) return false;
    const tailStream = resolveEventStreamId(rv.readElementOrderKey(tail));
    return !!tailStream && tailStream !== incomingStream;
  }

  /**
   * The answer text host directly above `anchor` when it belongs to the same
   * event stream and was opened before `incomingKey`. A replayed snapshot of
   * that answer must update the host instead of starting a second block.
   *
   * @param {HTMLElement} anchor
   * @param {{ roomEventSeq?: number, eventStreamId?: string }} incomingKey
   * @returns {HTMLElement | null}
   */
  function findAnswerBlockPrecedingAnchor(anchor, incomingKey) {
    const incomingStream = resolveEventStreamId(incomingKey);
    const incomingRoom = Number(incomingKey?.roomEventSeq) || 0;
    if (!incomingStream || incomingRoom <= 0) return null;
    const prev = anchor.previousElementSibling;
    if (!(prev instanceof HTMLElement)) return null;
    const md = prev.querySelector('.sdk-rich-assistant-md');
    if (!(md instanceof HTMLElement)) return null;
    const prevKey = rv.readElementOrderKey(prev);
    if (resolveEventStreamId(prevKey) !== incomingStream) return null;
    if (!((Number(prevKey.roomEventSeq) || 0) > 0 && Number(prevKey.roomEventSeq) < incomingRoom)) return null;
    return md;
  }

  function flushPendingAssistantMarkdown() {
    const pendingHost = rv.mdScheduledHost || (rv.mdRaf ? rv.assistantMdEl : null);
    rv.mdScheduledHost = null;
    if (rv.mdRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rv.mdRaf);
    }
    rv.mdRaf = 0;
    if (pendingHost instanceof HTMLElement && pendingHost.isConnected) {
      rv.flushMarkdown(pendingHost, pendingHost.dataset.rawMd || '');
    }
  }

  /**
   * @param {() => void} fn
   */
  function startFreshTailForNewEventStream(fn) {
    flushPendingAssistantMarkdown();
    rv.assistantMdEl = null;
    rv.thinkingDetails = null;
    rv.thinkingPre = null;
    rv.activeKind = 'idle';
    rv.activeThinkingRunKey = '';
    if (chat && typeof chat === 'object') {
      delete chat._sdkAssistantAcc;
      delete chat._sdkThinkingAcc;
    }
    fn();
  }

  /**
   * @param {{ historySeq?: number, roomEventSeq?: number, eventStreamId?: string }} incomingKey
   * @param {() => void} fn
   */
  function runViewApplyWithOrder(incomingKey, fn) {
    const existing = rv.findStreamChildByOrderKey(incomingKey);
    if (existing) {
      rv.stampElementOrderKey(existing);
      rv.foldDuplicateOrderKeyCards();
      fn();
      return;
    }
    const appliedRecord = {
      historySeq: incomingKey.historySeq,
      roomEventSeq: incomingKey.roomEventSeq,
      eventStreamId: incomingKey.eventStreamId,
    };
    if (isMountedHistoryRecordApplied(appliedRecord, rv.mountedHistoryRecordRegistry)) {
      const identity = viewOrderIdentity(incomingKey);
      if (identity && rv.mountedHistoryRecordRegistry.isMounted(identity)) {
        return;
      }
      removeHistoryRecordFromMountedParking(chat, incomingKey);
      if (identity) rv.pendingLiveRemountProtectIdentity = identity;
    } else if (isMountedViewOrderKeyApplied(incomingKey, rv.mountedHistoryRecordRegistry)) {
      return;
    }
    const later = rv.stream === rv.realStream ? rv.findInsertBeforeChild(incomingKey) : null;
    if (later) rv.noteInsertBeforeAnchor(later);
    if (later) {
      // A reconnect replays every snapshot of an answer that is already on screen.
      // Its older snapshots sort before the cards that followed it, so without a
      // hint each one would open a new answer block in the isolated state.
      rv.snapshotAdoptCandidate = findAnswerBlockPrecedingAnchor(later, incomingKey);
      try {
        rv.withIsolatedRenderState(fn);
      } finally {
        rv.snapshotAdoptCandidate = null;
      }
      return;
    }
    if (shouldStartFreshTailForNewEventStream(incomingKey)) {
      startFreshTailForNewEventStream(fn);
      return;
    }
    fn();
  }

  rv.lastHistoryErrorText = '';

  function applyHistoryRecord(record) {
    probeSync('chat.history.applyRecord', () => applyHistoryRecordBody(record));
  }

  function applyHistoryRecordBody(record) {
    if (!record || typeof record !== 'object') return;
    const rec = /** @type {Record<string, unknown>} */ (record);
    const createdAt = typeof rec.createdAt === 'string' ? rec.createdAt : '';
    const historySeq = Number(rec.historySeq) > 0 ? Number(rec.historySeq) : 0;
    const roomEventSeq = Number(rec.roomEventSeq) > 0 ? Number(rec.roomEventSeq) : 0;
    const eventStreamId = resolveEventStreamId(rec);
    const previousSeq = rv.renderedRecordHistorySeq;
    const previousRoom = rv.renderedRecordRoomEventSeq;
    const previousStream = rv.renderedRecordEventStreamId;
    rv.renderedRecordHistorySeq = historySeq;
    rv.renderedRecordRoomEventSeq = roomEventSeq;
    rv.renderedRecordEventStreamId = eventStreamId;
    const historyRecordSnapshot = rv.cloneHistoryRecordForParking(record);
    let didRenderHistoryRecord = false;
    try {
    runViewApplyWithOrder(resolveViewOrderKey({ historySeq, roomEventSeq, eventStreamId }), () => {
    didRenderHistoryRecord = true;
    if (rec.kind === 'sdk' && rec.event != null && typeof rec.event === 'object') {
      rv.applySdkEvent(rec.event, createdAt, historySeq);
      return;
    }
    if (rec.kind === 'localUser' && typeof rec.text === 'string') {
      const parsed = parseContextSeedPayload(rec.text);
      const inherited = parseInheritedPrompt(rec.text);
      const raw = rv.normalizeUserPromptText(
        parsed.hasSeed ? parsed.userText : rv.resolveVisibleUserPromptText(rec.text)
      );
      if (!raw) return;
      const idx = rv.queuedUserBlocks.findIndex((item) => rv.normalizeUserPromptText(item.text) === raw);
      if (idx >= 0) {
        const item = rv.queuedUserBlocks.splice(idx, 1)[0];
        if (item?.block) {
          item.block.label = t('sdkView.you');
          item.block.classList.remove('sdk-rich-block--queued');
          item.block.queued = false;
          // The sent record carries the authoritative cut point for "fork from here".
          if (createdAt) item.block.createdAt = createdAt;
          if (historySeq) item.block.historySeq = historySeq;
          item.block.forkable = true;
          rv.applyMessageSourceActions(item.block);
          rv.relabelQueuedBlocks();
          rv.scrollToBottom();
          return;
        }
      }
      const existing = rv.findUserBlockByText(raw);
      if (existing && !existing.queued && !inherited.followUp) {
        rv.applyMessageSourceActions(existing);
        rv.scrollToBottom();
        return;
      }
      rv.renderUserTurn(rec.text, createdAt);
      rv.scrollToBottom();
      return;
    }
    if (rec.kind !== 'meta') return;

    const variant = rec.variant;
    if (variant === 'permissionDecision') {
      // Payload is a JSON string (history validation only allows string payloads).
      let decision = null;
      try {
        decision = typeof rec.payload === 'string' ? JSON.parse(rec.payload) : null;
      } catch {
        decision = null;
      }
      if (decision && typeof decision === 'object') {
        rv.markOpenCodePermissionDecision(String(decision.requestId || ''), decision);
      }
      return;
    }
    if (variant === 'questionResolved') {
      const meta = rec.payload && typeof rec.payload === 'object'
        ? /** @type {Record<string, unknown>} */ (rec.payload)
        : {};
      const requestId = typeof meta.requestId === 'string' ? meta.requestId : '';
      const status = typeof meta.status === 'string' ? meta.status : 'answered';
      rv.markOpenCodeQuestionResolved(requestId, { status });
      return;
    }
    const payload = typeof rec.payload === 'string' ? rec.payload : '';
    if (variant === 'banner') {
      rv.lineMeta(
        'sdk-rich-line--ok',
        `<span class="sdk-rich-badge sdk-rich-badge--ok">SDK</span> ${escapeHtml(t('sdkView.connected'))}`,
        createdAt
      );
    } else if (variant === 'runFinished') {
      const presented = presentSdkActivityTrayStatus({ status: payload });
      rv.closeLiveTurn();
      rv.finalizeOpenToolCalls('', presented.terminalStatus || payload);
      rv.markAllTraysFinished(payload);
      rv.lineMeta(
        rv.resolveRunFinishedLineClass(payload),
        `<strong>${escapeHtml(t('sdkView.runFinished'))}</strong> · ${escapeHtml(rv.resolveActivityTrayLabel(presented.datasetStatus) || payload)}`,
        createdAt,
        true
      );
    } else if (variant === 'busy') {
      const busyText = payload == null ? '' : String(payload).trim();
      const busyBadge = `<span class="sdk-rich-badge sdk-rich-badge--warn">${escapeHtml(t('sdkView.busy'))}</span>`;
      const busyLine = busyText ? `${busyBadge} ${escapeHtml(busyText)}` : busyBadge;
      rv.lineMeta('sdk-rich-line--warn', busyLine, createdAt);
    } else if (variant === 'queued') {
      const raw = rv.normalizeUserPromptText(payload);
      if (!raw) return;
      if (rv.queuedUserBlocks.some((item) => rv.normalizeUserPromptText(item.text) === raw)) return;
      if (rv.findUserBlockByText(raw)) return;
      rv.createUserBlock(raw, createdAt);
      const lastBlock = rv.stream.lastElementChild;
      if (lastBlock) {
        lastBlock.label = t('sdkView.youQueued');
        rv.attachQueuedBlockActions(lastBlock, raw);
        rv.queuedUserBlocks.push({ text: raw, block: lastBlock });
      }
    } else if (variant === 'queueRemoved') {
      const raw = rv.normalizeUserPromptText(payload);
      const idx = rv.queuedUserBlocks.findIndex((item) => rv.normalizeUserPromptText(item.text) === raw);
      if (idx >= 0) {
        const item = rv.queuedUserBlocks.splice(idx, 1)[0];
        item?.block?.remove();
        rv.relabelQueuedBlocks();
      }
    } else if (variant === 'mode') {
      if (!shouldRenderModeChange(rv.lastRenderedMode, payload)) return;
      const renderedMode = parseExplicitSdkMode(payload);
      const modeLabel =
        renderedMode === 'plan' ? 'Plan' : renderedMode === 'ask' ? 'Ask' : renderedMode === 'agent' ? 'Agent' : '';
      if (modeLabel) {
        rv.lastRenderedMode = renderedMode;
        rv.lineMeta(
          'sdk-rich-line--notice',
          `<span class="sdk-rich-badge sdk-rich-badge--status">${escapeHtml(t('sdkView.modeBadge'))}</span> ${escapeHtml(modeLabel)}`,
          createdAt
        );
      }
    } else if (variant === 'error') {
      rv.lastHistoryErrorText = payload.trim();
      rv.lineMeta(
        'sdk-rich-line--err',
        `<span class="sdk-rich-badge sdk-rich-badge--err">${escapeHtml(t('sdkView.error'))}</span> ${escapeHtml(payload)}`,
        createdAt
      );
    } else if (variant === 'notice') {
      const noticeText = payload.trim();
      if (noticeText && noticeText === rv.lastHistoryErrorText) return;
      const progress =
        rec.progress && typeof rec.progress === 'object' ? rec.progress : null;
      rv.handleMetaNotice(payload, { silent: true, progress });
    } else if (variant === 'watcher') {
      const info = rv.parseWatcherNoticeRecord(payload);
      if (!info) return;
      rv.renderWatcherNoticeLine(info, createdAt);
    } else if (variant === 'contextSeed') {
      if (!payload.trim()) return;
      rv.createContextSeedBlock(payload.trim(), createdAt);
    } else if (variant === 'delegation') {
      rv.renderDelegationCard(payload, createdAt);
    } else if (variant === 'mailbox') {
      rv.renderMailboxCard(payload, createdAt);
    } else if (variant === 'relatedChat') {
      rv.renderRelatedChatCard(payload, createdAt);
    }
    });
    } finally {
      if (didRenderHistoryRecord && resolveMountedRecordIdentity(historyRecordSnapshot)) {
        rv.mountedHistoryRecordRegistry.note(historyRecordSnapshot);
      }
      rv.renderedRecordHistorySeq = previousSeq;
      rv.renderedRecordRoomEventSeq = previousRoom;
      rv.renderedRecordEventStreamId = previousStream;
    }
  }
}
