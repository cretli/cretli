import { runHistoryReplayApplySlices } from '../../../../lib/chatHistoryReplayApplySlice.js';
import { viewOrderIdentity } from '../../chatHistoryViewOrder.js';
import { getHistoryOlderLocal, getHistoryParkedNewerLocal, prependHistoryOlderLocal, prependHistoryParkedNewerLocal, takeHistoryParkedNewerLocal } from '../../chatHistoryMountedParking.js';
import { countMountedStreamCards, planMountedWindowEviction, releaseEvictedMountedCard, resolveMountedEvictionEdge } from '../../../../lib/sdkHistoryMountedWindow.js';
import { UI_FREEZE_CHAT_MOUNTED_RECORD_CAP } from '../../../../lib/uiFreezeRenderBudgets.js';

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
   * @returns {HTMLElement[]}
   */
  function pickMountedStreamEvictionCards(cards, edge, evictCount, skipIdentities) {
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
    for (let index = cards.length - 1; index >= 0 && picked.length < count; index -= 1) {
      const card = cards[index];
      if (!(card instanceof HTMLElement)) continue;
      const identity = viewOrderIdentity(rv.readElementOrderKey(card));
      if (identity && skip.has(identity)) continue;
      picked.push(card);
    }
    picked.reverse();
    return picked;
  }

  /**
   * @param {'head' | 'tail'} edge
   * @param {number} evictCount
   * @param {ReadonlySet<string>} [skipIdentities]
   * @returns {unknown[]}
   */
  function evictMountedStreamCards(edge, evictCount, skipIdentities) {
    const count = Math.max(0, Math.floor(Number(evictCount) || 0));
    if (count <= 0 || rv.stream !== rv.realStream) return [];
    const cards = [...rv.realStream.children].filter((child) => child instanceof HTMLElement);
    if (cards.length === 0) return [];
    const slice = pickMountedStreamEvictionCards(cards, edge, count, skipIdentities);
    /** @type {unknown[]} */
    const parked = [];
    for (const el of slice) {
      const identity = viewOrderIdentity(rv.readElementOrderKey(el));
      const record = identity ? rv.mountedHistoryRecordRegistry.get(identity) : null;
      if (record) parked.push(cloneHistoryRecordForParking(record));
      if (identity) rv.mountedHistoryRecordRegistry.markParked(identity);
      releaseEvictedMountedCard(el, rv.mountedViewResourceLedger, rv.mountedDomNodeRegistry);
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
    const { evictCount } = planMountedWindowEviction({
      mountedCount,
      cap: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP,
      evictFrom: edge,
    });
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

  async function restoreParkedNewerTailIfNeeded() {
    if (restoringParkedNewerTail || !rv.stickToBottom) return;
    const batch = takeHistoryParkedNewerLocal(chat, getHistoryParkedNewerLocal(chat).length);
    if (batch.length === 0) return;
    restoringParkedNewerTail = true;
    try {
      rv.suppressAutoScroll = false;
      await appendHistoryRecordsImpl(batch, { instant: true, forceScroll: true });
      enforceMountedHistoryWindowBudget();
      rearmOlderHistoryAfterTailRestore();
    } finally {
      restoringParkedNewerTail = false;
    }
  }

  /**
   * @param {unknown[]} records
   * @param {{ instant?: boolean, forceScroll?: boolean }} [opts]
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
