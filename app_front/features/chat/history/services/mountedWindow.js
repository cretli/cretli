import { runHistoryReplayApplySlices } from '../../../../lib/chatHistoryReplayApplySlice.js';
import { viewOrderIdentity } from '../../chatHistoryViewOrder.js';
import { getHistoryOlderLocal, getHistoryParkedNewerLocal, prependHistoryOlderLocal, prependHistoryParkedNewerLocal, takeHistoryParkedNewerLocal } from '../../chatHistoryMountedParking.js';
import { countMountedStreamCards, parkMountedCardRecords, planMountedWindowEviction, releaseEvictedMountedCard, resolveMountedEvictionEdge } from '../../../../lib/sdkHistoryMountedWindow.js';
import { UI_FREEZE_CHAT_MOUNTED_RECORD_CAP } from '../../../../lib/uiFreezeRenderBudgets.js';
import { resolveSdkToolCallId } from '../../../../../lib/sdk/sdk-thinking-state.ts';
import { resetSdkStreamState } from '../../../../lib/sdk-chat-format.js';

/**
 * Mounted-window eviction and parked-tail restore.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installMountedWindow(rv) {
  const { chat, mountEl } = rv;
  rv.cloneHistoryRecordForParking = cloneHistoryRecordForParking;
  rv.evictMountedStreamCards = evictMountedStreamCards;
  rv.enforceMountedHistoryWindowBudget = enforceMountedHistoryWindowBudget;
  rv.restoreParkedNewerTailIfNeeded = restoreParkedNewerTailIfNeeded;
  rv.appendHistoryRecordsImpl = appendHistoryRecordsImpl;
  rv.linkHistoryRecordToHostCard = linkHistoryRecordToHostCard;

  /** @type {WeakMap<HTMLElement, Set<string>>} identities merged into a card it did not open */
  const mergedIdentitiesByCard = new WeakMap();

  /**
   * Element a record updated in place, when it did not open a card of its own.
   *
   * @param {Record<string, any>} record
   * @returns {HTMLElement | null}
   */
  function resolveHistoryRecordHostElement(record) {
    const ev = record.kind === 'sdk' && record.event && typeof record.event === 'object'
      ? record.event
      : null;
    if (!ev) return null;
    // Streamed answers and thinking: every snapshot/delta after the first lands in the
    // block the first one opened.
    if (ev.type === 'assistant' || ev.type === 'thinking') {
      const hosts = rv.isolatedApplyHosts || { assistant: rv.assistantMdEl, thinking: rv.thinkingDetails };
      const host = ev.type === 'assistant' ? hosts.assistant : hosts.thinking;
      return host instanceof HTMLElement ? host : null;
    }
    let callId = '';
    if (ev.type === 'tool_call') callId = resolveSdkToolCallId(ev);
    else if (ev.type === 'usage') callId = `usage-${rv.getEventRunKey(ev)}`;
    if (!callId) return null;
    const block = rv.toolByCallId.get(callId)?.fullBlock;
    return block instanceof HTMLElement ? block : null;
  }

  /**
   * Remembers that `identity` was merged into an existing card (e.g. a tool's
   * `completed` update), so evicting that card parks the record with it.
   *
   * @param {unknown} record
   * @param {string} identity
   */
  function linkHistoryRecordToHostCard(record, identity) {
    if (!identity || !record || typeof record !== 'object') return;
    let card = resolveHistoryRecordHostElement(/** @type {Record<string, any>} */ (record));
    while (card && card.parentElement !== rv.stream) card = card.parentElement;
    if (!(card instanceof HTMLElement)) return;
    if (viewOrderIdentity(rv.readElementOrderKey(card)) === identity) return;
    let merged = mergedIdentitiesByCard.get(card);
    if (!merged) {
      merged = new Set();
      mergedIdentitiesByCard.set(card, merged);
    }
    merged.add(identity);
  }

  /**
   * A card can only be parked when its record is known; live cards without a history
   * seq would simply vanish, so tail eviction leaves them in place.
   *
   * @param {HTMLElement} card
   * @returns {boolean}
   */
  function isParkableCard(card) {
    const identity = viewOrderIdentity(rv.readElementOrderKey(card));
    return identity !== '' && rv.mountedHistoryRecordRegistry.get(identity) !== undefined;
  }

  /**
   * @param {unknown} record
   * @returns {unknown}
   */
  function cloneHistoryRecordForParking(record) {
    if (!record || typeof record !== 'object') return record;
    try {
      return structuredClone(record);
    } catch {
      return JSON.parse(JSON.stringify(record));
    }
  }

  function purgeDisconnectedRunMaps() {
    for (const [callId, block] of rv.planByCallId) {
      if (!(block instanceof HTMLElement) || !block.isConnected) rv.planByCallId.delete(callId);
    }
    for (const [callId, record] of rv.toolByCallId) {
      const block = record?.fullBlock;
      const tile = record?.tile;
      const connected =
        (block instanceof HTMLElement && block.isConnected)
        || (tile instanceof HTMLElement && tile.isConnected);
      if (!connected) rv.toolByCallId.delete(callId);
    }
  }

  /**
   * @param {HTMLElement[]} cards
   * @param {'head' | 'tail'} edge
   * @param {number} evictCount
   * @param {ReadonlySet<string>} [skipIdentities]
   * @param {{ ignoreViewport?: boolean }} [opts]
   * @returns {HTMLElement[]}
   */
  function pickMountedStreamEvictionCards(cards, edge, evictCount, skipIdentities, opts = {}) {
    const count = Math.max(0, Math.floor(Number(evictCount) || 0));
    const skip = skipIdentities instanceof Set ? skipIdentities : new Set();
    if (count <= 0 || cards.length === 0) return [];
    /** @type {HTMLElement[]} */
    const picked = [];
    if (edge === 'head') {
      for (const card of cards) {
        if (picked.length >= count) break;
        if (!(card instanceof HTMLElement)) continue;
        const identity = viewOrderIdentity(rv.readElementOrderKey(card));
        if (identity && skip.has(identity)) continue;
        picked.push(card);
      }
      return picked;
    }
    // The parked tail must stay one contiguous run from the newest card, and it may only
    // take cards the user cannot see. Skipping an unparkable card (a live prompt echo has
    // no history seq) or parking a card in view leaves the prompt as the last visible card
    // with its answers parked behind it: "I only see my own messages".
    const keepBelow = opts.ignoreViewport ? Number.NEGATIVE_INFINITY : resolveTailEvictionLine();
    for (let index = cards.length - 1; index >= 0 && picked.length < count; index -= 1) {
      const card = cards[index];
      if (!(card instanceof HTMLElement)) continue;
      const identity = viewOrderIdentity(rv.readElementOrderKey(card));
      // A protected live remount keeps itself and everything older mounted.
      if (identity && skip.has(identity)) break;
      if (!isParkableCard(card)) break;
      if (card.getBoundingClientRect().top < keepBelow) break;
      picked.push(card);
    }
    picked.reverse();
    return picked;
  }

  /**
   * Trailing mounted cards newer than the first parked record.
   *
   * @returns {number}
   */
  function countCardsPastParkedTail() {
    const firstParkedSeq = Number(getHistoryParkedNewerLocal(chat)[0]?.historySeq) || 0;
    if (firstParkedSeq <= 0) return 0;
    const cards = rv.realStream.children;
    let count = 0;
    for (let index = cards.length - 1; index >= 0; index -= 1) {
      const seq = Number(rv.readElementOrderKey(cards[index])?.historySeq) || 0;
      if (seq <= firstParkedSeq) break;
      count += 1;
    }
    return count;
  }

  /**
   * Viewport-relative line below which tail cards may be parked: one screen under the
   * visible bottom, so content the user is about to scroll into stays mounted.
   *
   * @returns {number}
   */
  function resolveTailEvictionLine() {
    const rect = mountEl.getBoundingClientRect();
    return rect.bottom + Math.max(mountEl.clientHeight, 0);
  }

  /**
   * @param {'head' | 'tail'} edge
   * @param {number} evictCount
   * @param {ReadonlySet<string>} [skipIdentities]
   * @param {{ ignoreViewport?: boolean }} [opts]
   * @returns {unknown[]}
   */
  function evictMountedStreamCards(edge, evictCount, skipIdentities, opts = {}) {
    const count = Math.max(0, Math.floor(Number(evictCount) || 0));
    if (count <= 0 || rv.stream !== rv.realStream) return [];
    const cards = [...rv.realStream.children].filter((child) => child instanceof HTMLElement);
    if (cards.length === 0) return [];
    const slice = pickMountedStreamEvictionCards(cards, edge, count, skipIdentities, opts);
    /** @type {string[][]} */
    const identityLists = [];
    for (const el of slice) {
      const identity = viewOrderIdentity(rv.readElementOrderKey(el));
      identityLists.push([identity, ...(mergedIdentitiesByCard.get(el) || [])]);
    }
    const parked = parkMountedCardRecords(identityLists, rv.mountedHistoryRecordRegistry)
      .map(cloneHistoryRecordForParking);
    for (const el of slice) {
      releaseEvictedMountedCard(el, rv.mountedViewResourceLedger, rv.mountedDomNodeRegistry);
    }
    // The open answer/thinking block may have left with the slice. Keeping the pointer
    // would stream (or replay the restored tail) into a detached node and lose that text.
    const openBlockEvicted =
      (rv.assistantMdEl instanceof HTMLElement && !rv.assistantMdEl.isConnected)
      || (rv.thinkingDetails instanceof HTMLElement && !rv.thinkingDetails.isConnected);
    if (openBlockEvicted) {
      rv.clearSegmentPointers();
      resetSdkStreamState(chat);
    }
    purgeDisconnectedRunMaps();
    rv.refreshDuplicateMailboxReports();
    return parked;
  }

  /**
   * @param {{ protectTailRemountIdentity?: string, protectTailRemountIdentities?: Iterable<string> }} [opts]
   */
  function enforceMountedHistoryWindowBudget(opts = {}) {
    if (rv.stream !== rv.realStream) return;
    const mountedCount = countMountedStreamCards(rv.realStream);
    const edge = resolveMountedEvictionEdge({
      stickToBottom: rv.stickToBottom,
      isLoadingOlderHistory: rv.isLoadingOlderHistory,
    });
    let { evictCount } = planMountedWindowEviction({
      mountedCount,
      cap: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP,
      evictFrom: edge,
    });
    // Once a newer tail is parked, a live card appended after the last mounted card sits
    // past that gap. Park those cards too, so the tail stays one run.
    if (edge === 'tail') evictCount = Math.max(evictCount, countCardsPastParkedTail());
    if (evictCount <= 0) return;
    const protectedIds = new Set();
    for (const raw of [opts.protectTailRemountIdentity, ...(opts.protectTailRemountIdentities || [])]) {
      const id = String(raw || '').trim();
      if (id) protectedIds.add(id);
    }
    const skipForTail = protectedIds.size ? protectedIds : undefined;
    let parked = evictMountedStreamCards(edge, evictCount, edge === 'tail' ? skipForTail : undefined);
    if (parked.length < evictCount && edge === 'tail' && protectedIds.size) {
      const shortfall = evictCount - parked.length;
      parked = [...parked, ...evictMountedStreamCards('head', shortfall)];
    }
    if (parked.length === 0) return;
    if (edge === 'head') {
      prependHistoryOlderLocal(chat, parked);
      return;
    }
    prependHistoryParkedNewerLocal(chat, parked);
  }

  /**
   * Restoring the tail evicts the head into the older-local cache. If paging had already
   * reached "start", the sentinel is disarmed and those cards would be unreachable.
   */
  function rearmOlderHistoryAfterTailRestore() {
    if (rv.hasOlderHistory || getHistoryOlderLocal(chat).length === 0) return;
    rv.historyArmToken += 1;
    rv.hasOlderHistory = true;
    rv.renderHistoryTopState('idle');
    rv.ensureHistoryTopObserver();
  }

  let restoringParkedNewerTail = false;

  /** Records brought back per step while the reader scrolls down toward the live end. */
  const PARKED_TAIL_RESTORE_STEP = 40;

  /**
   * First card whose bottom edge is inside the viewport, with its current top.
   *
   * @returns {{ el: HTMLElement, top: number } | null}
   */
  function captureFirstVisibleCard() {
    const viewTop = mountEl.getBoundingClientRect().top;
    for (const card of rv.realStream.children) {
      if (!(card instanceof HTMLElement)) continue;
      const rect = card.getBoundingClientRect();
      if (rect.bottom > viewTop) return { el: card, top: rect.top };
    }
    return null;
  }

  /**
   * Brings the parked newer tail back once the reader reaches the bottom of what is
   * mounted. One step at a time, appended under the reader without moving what they
   * see; the head is trimmed above them. Only the last step can hand over to
   * auto-follow. `all` restores everything at once and jumps to the live end (a new
   * prompt being sent).
   *
   * @param {{ all?: boolean }} [opts]
   */
  async function restoreParkedNewerTailIfNeeded(opts = {}) {
    if (restoringParkedNewerTail || !rv.stickToBottom) return;
    const parkedCount = getHistoryParkedNewerLocal(chat).length;
    if (parkedCount === 0) return;
    const all = opts.all === true;
    const batch = takeHistoryParkedNewerLocal(chat, all ? parkedCount : PARKED_TAIL_RESTORE_STEP);
    if (batch.length === 0) return;
    restoringParkedNewerTail = true;
    try {
      rv.suppressAutoScroll = false;
      if (all) {
        await appendHistoryRecordsImpl(batch, { instant: true, forceScroll: true });
        enforceMountedHistoryWindowBudget();
      } else {
        const anchor = captureFirstVisibleCard();
        await appendHistoryRecordsImpl(batch, { instant: true, keepScroll: true });
        if (anchor?.el.isConnected) {
          const delta = anchor.el.getBoundingClientRect().top - anchor.top;
          if (Math.abs(delta) >= 0.5) mountEl.scrollTop += delta;
        }
        const maxScroll = mountEl.scrollHeight - mountEl.clientHeight;
        const atLiveEnd = getHistoryParkedNewerLocal(chat).length === 0
          && maxScroll - mountEl.scrollTop <= rv.SCROLL_STICK_THRESHOLD_PX;
        // The reader is still above the live end: following resumes only once they
        // scroll down to it, as with any other scroll.
        rv.stickToBottom = atLiveEnd;
        rv.lastScrollTop = mountEl.scrollTop;
      }
      rearmOlderHistoryAfterTailRestore();
    } finally {
      restoringParkedNewerTail = false;
    }
  }

  /**
   * @param {unknown[]} records
   * @param {{ instant?: boolean, forceScroll?: boolean, keepScroll?: boolean }} [opts]
   */
  async function appendHistoryRecordsImpl(records, opts = {}) {
    if (!Array.isArray(records) || records.length === 0) return;
    const instant = opts.instant === true;
    const forceScroll = opts.forceScroll !== false;
    const replayGeneration = rv.historyReplayGenerationGate.getActiveGeneration();
    try {
      const applyOne = (record) => {
        rv.applyHistoryRecord(record);
      };
      if (instant) {
        rv.beginViewportAnchorBatch();
        rv.beginHistoryReplayApplySlice(replayGeneration);
        try {
          for (let index = 0; index < records.length; index += 1) {
            applyOne(records[index]);
          }
        } finally {
          rv.endHistoryReplayApplySlice();
          rv.endViewportAnchorBatch();
        }
      } else {
        await runHistoryReplayApplySlices({
          records,
          startIndex: 0,
          endIndexExclusive: records.length,
          replayGeneration,
          applyHistoryRecord: (record) => {
            applyOne(record);
          },
          onSliceStart: () => {
            rv.beginViewportAnchorBatch();
            rv.beginHistoryReplayApplySlice(replayGeneration);
          },
          onSliceEnd: () => {
            rv.endHistoryReplayApplySlice();
            if (rv.viewportAnchorBatch.getDepth() > 0) rv.endViewportAnchorBatch();
          },
          scheduleFrame:
            typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined,
        });
        rv.endHistoryReplayApplySlice();
      }
    } finally {
      rv.endHistoryReplayApplySlice();
      if (replayGeneration > 0 && rv.historyReplayGenerationGate.isActive(replayGeneration)) {
        await rv.runHistoryReplayFinalizeForGeneration(replayGeneration);
      } else {
        rv.finalizeAllTerminalRunPresentations();
        rv.foldDuplicateOrderKeyCards();
      }
    }
    enforceMountedHistoryWindowBudget();
    if (opts.keepScroll === true) {
      // The caller keeps the reader's place itself.
      rv.preserveViewportAnchor = false;
      rv.pendingViewportAnchor = null;
      return;
    }
    if (rv.preserveViewportAnchor) {
      rv.preserveViewportAnchor = false;
      if (forceScroll) {
        rv.pendingViewportAnchor = null;
        rv.scrollToBottom({ force: true });
        return;
      }
      void mountEl.offsetHeight;
      rv.restoreInsertScroll();
      if (typeof requestAnimationFrame === 'function') {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        rv.restoreInsertScroll();
      }
      rv.pendingViewportAnchor = null;
      return;
    }
    rv.pendingViewportAnchor = null;
    rv.scrollToBottom({ force: forceScroll });
  }
}
