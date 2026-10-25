import { isUiFreezeTraceActive } from '../../../../lib/uiFreezeTrace.js';
import { measureSpan } from '../../../../lib/chatPerfBudget.js';
import { createHistoryReplayLifecycleForView } from '../../../../lib/chatHistoryReplayLifecycle.js';
import { createChatHistoryReplayGenerationGate } from '../../../../lib/chatHistoryReplayGenerationGate.js';
import { buildHistoryReplayResult } from '../../../../lib/chatHistoryReplayResult.js';
import { t } from '../../../../i18n/index.js';
import { createLatestRequestGuard } from '../../recoveryActions.js';
import { createMountedDomNodeRegistry, createMountedHistoryRecordRegistry, createMountedViewResourceLedger } from '../../../../lib/sdkHistoryMountedWindow.js';

/**
 * View shell: mount DOM, replay outcome bookkeeping and the shared render state.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installViewShell(rv) {
  const { chat, mountEl, hooks } = rv;
  rv.settleReplayOutcome = settleReplayOutcome;
  rv.beginReplayOutcome = beginReplayOutcome;
  rv.noteReplayApplied = noteReplayApplied;
  rv.measureRenderSpan = measureRenderSpan;
  if (!mountEl || typeof hooks?.appendPlain !== 'function') {
    throw new Error('createSdkRichView: mountEl and hooks.appendPlain are required');
  }
  mountEl.classList.add('sdk-rich-chat-mount');
  mountEl.innerHTML = '';
  const scrollToBottomButton = document.createElement('button');
  rv.scrollToBottomButton = scrollToBottomButton;
  scrollToBottomButton.type = 'button';
  scrollToBottomButton.className = 'sdk-rich-scroll-bottom';
  scrollToBottomButton.setAttribute('aria-label', t('sdkView.scrollToBottom'));
  scrollToBottomButton.title = t('sdkView.scrollToBottom');
  scrollToBottomButton.innerHTML = '<span class="mdi mdi-arrow-down" aria-hidden="true"></span>';
  scrollToBottomButton.hidden = true;
  mountEl.parentElement?.appendChild(scrollToBottomButton);
  // Sentinel lives outside the stream — replayHistoryRecords wipes the stream on every replay.
  const historyTopEl = document.createElement('div');
  rv.historyTopEl = historyTopEl;
  historyTopEl.className = 'sdk-rich-history-top';
  historyTopEl.hidden = true;
  mountEl.appendChild(historyTopEl);
  const realStream = document.createElement('div');
  rv.realStream = realStream;
  realStream.className = 'sdk-rich-stream';
  mountEl.appendChild(realStream);
  // Chat-level recovery banner. It lives outside the stream (replay wipes the
  // stream) and covers ordinary runs that have no delegation card.
  const recoveryWidgetGuards = new WeakMap();
  rv.recoveryWidgetGuards = recoveryWidgetGuards;
  /** @type {WeakMap<HTMLElement, (feedback?: object | null) => Promise<boolean> | void>} */
  const recoveryHostRefreshes = new WeakMap();
  rv.recoveryHostRefreshes = recoveryHostRefreshes;
  /** @type {Set<() => void>} Every live recovery registration (banner + cards). */
  const recoveryWidgetCleanups = new Set();
  rv.recoveryWidgetCleanups = recoveryWidgetCleanups;
  /** @type {WeakSet<HTMLElement>} Hosts already queued for a detached re-check. */
  const recoveryDetachCleanupPending = new WeakSet();
  rv.recoveryDetachCleanupPending = recoveryDetachCleanupPending;
  const recoveryBannerGuard = createLatestRequestGuard();
  rv.recoveryBannerGuard = recoveryBannerGuard;
  const recoveryBannerEl = document.createElement('section');
  rv.recoveryBannerEl = recoveryBannerEl;
  recoveryBannerEl.className = 'sdk-rich-recovery-banner';
  recoveryBannerEl.hidden = true;
  mountEl.insertBefore(recoveryBannerEl, historyTopEl);
  /** Render target — temporarily swapped to an offscreen node while paging older history in. */
  rv.stream = realStream;
  const historyReplayLifecycle = createHistoryReplayLifecycleForView();
  rv.historyReplayLifecycle = historyReplayLifecycle;
  const historyReplayGenerationGate = createChatHistoryReplayGenerationGate();
  rv.historyReplayGenerationGate = historyReplayGenerationGate;
  const mountedHistoryRecordRegistry = createMountedHistoryRecordRegistry();
  rv.mountedHistoryRecordRegistry = mountedHistoryRecordRegistry;
  const mountedDomNodeRegistry = createMountedDomNodeRegistry();
  rv.mountedDomNodeRegistry = mountedDomNodeRegistry;
  const mountedViewResourceLedger = createMountedViewResourceLedger();
  rv.mountedViewResourceLedger = mountedViewResourceLedger;
  /** @type {string} Live remount of a parked record must survive the same-turn budget pass. */
  rv.pendingLiveRemountProtectIdentity = '';

  /** @type {Map<number, { total: number, applied: number, resolve: (result: import('../../../../lib/chatHistoryReplayResult.js').HistoryReplayResult) => void }>} */
  const replayOutcomeByGeneration = new Map();
  rv.replayOutcomeByGeneration = replayOutcomeByGeneration;

  /**
   * @param {number} generation
   * @param {import('../../../../lib/chatHistoryReplayResult.js').HistoryReplayFinishReason} reason
   */
  function settleReplayOutcome(generation, reason) {
    const gen = Math.round(Number(generation) || 0);
    const entry = replayOutcomeByGeneration.get(gen);
    if (!entry) return;
    replayOutcomeByGeneration.delete(gen);
    entry.resolve(
      buildHistoryReplayResult({
        generation: gen,
        total: entry.total,
        applied: entry.applied,
        reason,
      }),
    );
  }

  /** @param {number} nextGeneration */
  function supersedeOutstandingReplays(nextGeneration) {
    const nextGen = Math.round(Number(nextGeneration) || 0);
    for (const [gen, entry] of replayOutcomeByGeneration.entries()) {
      if (gen >= nextGen) continue;
      replayOutcomeByGeneration.delete(gen);
      entry.resolve(
        buildHistoryReplayResult({
          generation: gen,
          total: entry.total,
          applied: entry.applied,
          reason: 'superseded',
        }),
      );
    }
  }

  /**
   * @param {number} generation
   * @param {number} total
   * @returns {Promise<import('../../../../lib/chatHistoryReplayResult.js').HistoryReplayResult>}
   */
  function beginReplayOutcome(generation, total) {
    supersedeOutstandingReplays(generation);
    if (chat && typeof chat === 'object') {
      chat._sdkActiveHistoryReplayGeneration = generation;
    }
    return new Promise((resolve) => {
      replayOutcomeByGeneration.set(generation, { total, applied: 0, resolve });
    });
  }

  /**
   * @param {number} generation
   * @param {number} applied
   */
  function noteReplayApplied(generation, applied) {
    const entry = replayOutcomeByGeneration.get(generation);
    if (!entry) return;
    entry.applied = Math.max(entry.applied, Math.min(entry.total, Math.round(Number(applied) || 0)));
  }

  /**
   * Times a render slice only while freeze diag is on.
   * @template T
   * @param {string} kind
   * @param {Record<string, unknown>} fields
   * @param {() => T} fn
   * @returns {T}
   */
  function measureRenderSpan(kind, fields, fn) {
    if (!isUiFreezeTraceActive()) return fn();
    return measureSpan(kind, fields, fn, () => ({ children: realStream.childElementCount }));
  }

  /** @type {HTMLElement | null} */
  rv.assistantMdEl = null;
  /** Answer text host a replayed snapshot should update (see runViewApplyWithOrder). @type {HTMLElement | null} */
  rv.snapshotAdoptCandidate = null;
  /** @type {HTMLDetailsElement | null} */
  rv.thinkingDetails = null;
  /** @type {HTMLElement | null} */
  rv.thinkingPre = null;
  /** @type {Map<string, { fullBlock: HTMLElement, tile: HTMLButtonElement, tray: object, event: Record<string, unknown> }>} */
  const toolByCallId = new Map();
  rv.toolByCallId = toolByCallId;
  const planByCallId = new Map();
  rv.planByCallId = planByCallId;
}
