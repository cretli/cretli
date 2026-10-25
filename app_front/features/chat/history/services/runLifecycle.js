import { presentSdkActivityTrayStatus } from '../../../../../lib/sdk/sdk-run-outcome.ts';
import { parseTimeoutProgressNotice } from '../../../../../lib/notices.js';
import { hasRunningSdkTools, isTerminalSdkRunStatus, shouldKeepSdkThinkingSpinner } from '../../../../../lib/sdk/sdk-thinking-state.ts';
import { shouldCloseLiveTurnAfterHistoryReplay } from '../../chatStatusMeta.js';
import { listAllRunItems, listRunItems, stopSdkBlockSpinners } from '../../../../../lib/sdk/sdk-run-block-registry.ts';
import { runHistoryReplayFinalizeSlices } from '../../../../lib/chatHistoryReplayFinalizeSlice.js';
import { escapeHtml } from '../../chatHtmlUtils.js';

/**
 * Watcher notices, live turn open/close and run finalization.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installRunLifecycle(rv) {
  const { chat, hooks } = rv;
  rv.parseWatcherNoticeRecord = parseWatcherNoticeRecord;
  rv.renderWatcherNoticeLine = renderWatcherNoticeLine;
  rv.handleMetaNotice = handleMetaNotice;
  rv.setThinkingRunning = setThinkingRunning;
  rv.openLiveTurn = openLiveTurn;
  rv.closeLiveTurn = closeLiveTurn;
  rv.markAllTraysFinished = markAllTraysFinished;
  rv.finalizeRunPresentation = finalizeRunPresentation;
  rv.finalizeAllTerminalRunPresentations = finalizeAllTerminalRunPresentations;
  rv.buildHistoryReplayFinalizeSteps = buildHistoryReplayFinalizeSteps;
  rv.runHistoryReplayFinalizeForGeneration = runHistoryReplayFinalizeForGeneration;
  rv.beginHistoryReplayApplySlice = beginHistoryReplayApplySlice;
  rv.endHistoryReplayApplySlice = endHistoryReplayApplySlice;
  rv.syncThinkingBlockRunning = syncThinkingBlockRunning;
  rv.getEventRunKey = getEventRunKey;

  /** Action -> Material Design icon for the pinned workspace watcher feed. */
  const WATCHER_NOTICE_ICONS = {
    cycle_start: 'mdi-play-circle-outline',
    plan_gate: 'mdi-file-document-outline',
    cycle_stop: 'mdi-stop-circle-outline',
    cycle_blocked: 'mdi-alert-circle-outline',
    cycle_failure: 'mdi-alert-octagon-outline',
    blocked: 'mdi-cancel',
    alert: 'mdi-alert-octagon-outline',
    todo_done: 'mdi-check-circle-outline',
    stopped: 'mdi-stop-circle-outline',
    plan_approval: 'mdi-timer-sand',
    idle_with_work: 'mdi-timer-sand',
    decision: 'mdi-gavel',
  };

  /**
   * Parse a persisted `watcher` meta notice. Returns null when the payload is
   * missing/invalid so a foreign or older record renders nothing rather than
   * throwing.
   *
   * @param {string} payload
   * @returns {{ text: string, action: string, level: string, at: string } | null}
   */
  function parseWatcherNoticeRecord(payload) {
    if (typeof payload !== 'string' || !payload.trim()) return null;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) return null;
    return {
      text,
      action: typeof data.action === 'string' && data.action.trim() ? data.action.trim() : 'info',
      level: ['info', 'warn', 'error', 'success'].includes(data.level) ? data.level : 'info',
      at: typeof data.at === 'string' ? data.at : '',
    };
  }

  /**
   * Special persisted style for the pinned workspace watcher chat: timestamp +
   * action icon + description.
   *
   * @param {{ text: string, action: string, level: string, at: string }} info
   * @param {string} createdAt
   */
  function renderWatcherNoticeLine(info, createdAt) {
    const icon = WATCHER_NOTICE_ICONS[info.action] || 'mdi-robot-outline';
    rv.lineMeta(
      `sdk-rich-line--watcher sdk-rich-line--watcher-${info.level}`,
      `<span class="mdi ${icon} sdk-rich-watcher-icon" aria-hidden="true"></span>` +
        `<span class="sdk-rich-watcher-text">${escapeHtml(info.text)}</span>`,
      info.at || createdAt
    );
  }

  /**
   * @param {string} text
   * @param {{ silent?: boolean }} [opts]
   */
  function handleMetaNotice(text, opts = {}) {
    const silent = opts.silent === true;
    const noticeText = text == null ? '' : String(text);
    // Replayed records carry the progress values; parsing the text is only a
    // fallback for history written before they were stored.
    const timeoutProgress = opts.progress || parseTimeoutProgressNotice(noticeText);
    if (timeoutProgress) {
      if (!silent) hooks.appendPlain(`\n${noticeText}\n`);
      rv.appendTimeoutProgressSeries(timeoutProgress);
      if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
        hooks.onHistoryRecord({
          kind: 'meta',
          variant: 'notice',
          payload: noticeText,
          progress: timeoutProgress,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }
    rv.stopTimeoutProgressSeries();
    if (!silent) hooks.appendPlain(`\n${noticeText}\n`);
    const createdAt = rv.lineMeta('sdk-rich-line--notice', escapeHtml(noticeText));
    if (!silent && typeof hooks.onHistoryRecord === 'function' && !rv.suppressHistoryPersist) {
      hooks.onHistoryRecord({
        kind: 'meta',
        variant: 'notice',
        payload: noticeText,
        createdAt,
      });
    }
  }

  /**
   * @param {boolean} value
   */
  function setThinkingRunning(value) {
    if (rv.thinkingDetails && typeof rv.thinkingDetails === 'object' && 'running' in rv.thinkingDetails) {
      rv.thinkingDetails.running = value;
    }
  }

  function listRenderedSdkBlocks() {
    return rv.stream.querySelectorAll('cr-sdk-block');
  }

  function stopAllThinkingSpinners() {
    setThinkingRunning(false);
    stopSdkBlockSpinners(listAllRunItems(rv.thinkingBlocksByRun));
    stopSdkBlockSpinners(rv.latestThinkingByRun.values());
    stopSdkBlockSpinners(listRenderedSdkBlocks());
  }

  function openLiveTurn() {
    rv.isLiveTurn = true;
  }

  function closeLiveTurn() {
    rv.isLiveTurn = false;
    stopAllThinkingSpinners();
    // History often has no FINISHED status. Idle/replay must still clear
    // leftover running tiles or they spin under the last assistant block.
    rv.finalizeOpenToolCalls('', 'finished');
    for (const tray of listAllRunItems(rv.traysByRun)) {
      const current = String(tray?.statusEl?.dataset?.status || '');
      const presented = presentSdkActivityTrayStatus({ status: current });
      if (isTerminalSdkRunStatus(current) || isTerminalSdkRunStatus(presented.terminalStatus)) continue;
      rv.setTrayStatus(tray, 'finished');
    }
  }

  /**
   * @param {string} runKey
   */
  function stopThinkingSpinnersForRun(runKey) {
    const key = String(runKey || '').trim();
    if (!key) {
      stopAllThinkingSpinners();
      return;
    }
    stopSdkBlockSpinners(listRunItems(rv.thinkingBlocksByRun, key));
    const latest = rv.latestThinkingByRun.get(key);
    if (latest) stopSdkBlockSpinners([latest]);
    if (rv.thinkingDetails && (rv.activeThinkingRunKey === key || !rv.activeThinkingRunKey)) {
      setThinkingRunning(false);
    }
  }

  function markAllTraysFinished(status, lastErrorCode = '') {
    markTraysFinishedForRun('', status, lastErrorCode);
  }

  /**
   * @param {string} runKey
   * @param {string} status
   * @param {string} [lastErrorCode]
   */
  function markTraysFinishedForRun(runKey, status, lastErrorCode = '') {
    const st = String(status || 'finished');
    const key = String(runKey || '').trim();
    const trays = key ? listRunItems(rv.traysByRun, key) : listAllRunItems(rv.traysByRun);
    for (const tray of trays) {
      if (tray) rv.setTrayStatus(tray, st, lastErrorCode);
    }
    if (!key) {
      for (const tray of rv.latestTrayByRun.values()) {
        if (tray) rv.setTrayStatus(tray, st, lastErrorCode);
      }
      return;
    }
    const latest = rv.latestTrayByRun.get(key);
    if (latest) rv.setTrayStatus(latest, st, lastErrorCode);
  }

  /**
   * SDK `status` FINISHED is not the same as `runFinished`. A turn can leave
   * several Activity trays; updating only the latest one leaves earlier
   * RUNNING labels and Thinking spinners on screen after the chat is idle.
   *
   * @param {string} runKey
   * @param {string} status
   * @param {string} [lastErrorCode]
   */
  function finalizeRunPresentation(runKey, status, lastErrorCode = '') {
    const presented = presentSdkActivityTrayStatus({ status, lastErrorCode });
    const terminalStatus = presented.terminalStatus || status;
    if (!isTerminalSdkRunStatus(status) && !isTerminalSdkRunStatus(terminalStatus)) return;
    const key = String(runKey || '').trim();
    rv.finalizeOpenToolCalls(key, terminalStatus);
    stopThinkingSpinnersForRun(key);
    markTraysFinishedForRun(key, status, lastErrorCode);
    if (key && rv.activeThinkingRunKey && rv.activeThinkingRunKey !== key) return;
    if (rv.activeKind !== 'thinking') return;
    rv.thinkingDetails = null;
    rv.thinkingPre = null;
    rv.activeKind = 'idle';
    rv.activeThinkingRunKey = '';
  }

  function finalizeAllTerminalRunPresentations() {
    for (const [key, st] of rv.runStatusByRun.entries()) {
      finalizeRunPresentation(key, st);
    }
    if (!shouldCloseLiveTurnAfterHistoryReplay(chat)) return;
    closeLiveTurn();
  }

  /**
   * @param {number} replayGeneration
   * @returns {Array<() => void>}
   */
  function buildHistoryReplayFinalizeSteps(replayGeneration) {
    const steps = [];
    for (const [key, st] of rv.runStatusByRun.entries()) {
      steps.push(() => {
        if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
        finalizeRunPresentation(key, st);
      });
    }
    steps.push(() => {
      if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
      if (!shouldCloseLiveTurnAfterHistoryReplay(chat)) return;
      closeLiveTurn();
    });
    steps.push(() => {
      if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
      rv.foldDuplicateOrderKeyCards();
    });
    steps.push(() => {
      if (!rv.historyReplayGenerationGate.isActive(replayGeneration)) return;
      rv.adoptTrailingTimeoutProgressSeries();
    });
    steps.push(() => {
      rv.scrollToBottomForReplay(replayGeneration, { force: true });
    });
    return steps;
  }

  /**
   * @param {number} replayGeneration
   * @returns {Promise<number>}
   */
  async function runHistoryReplayFinalizeForGeneration(replayGeneration) {
    const scheduleFrame =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined;
    const result = await runHistoryReplayFinalizeSlices({
      steps: buildHistoryReplayFinalizeSteps(replayGeneration),
      replayGeneration,
      isCancelled: () => !rv.historyReplayGenerationGate.isActive(replayGeneration),
      scheduleFrame,
    });
    return result.finalizeMs;
  }

  /**
   * @param {number} replayGeneration
   * @returns {boolean}
   */
  function beginHistoryReplayApplySlice(replayGeneration) {
    const generation = Math.round(Number(replayGeneration) || 0);
    if (generation > 0 && !rv.historyReplayGenerationGate.isActive(generation)) return false;
    rv.suppressHooksPlain = true;
    rv.suppressHistoryPersist = true;
    rv.mdRenderImmediate = true;
    return true;
  }

  function endHistoryReplayApplySlice() {
    rv.suppressHooksPlain = false;
    rv.suppressHistoryPersist = false;
    rv.mdRenderImmediate = false;
  }

  /**
   * @param {string} runKey
   */
  function syncThinkingBlockRunning(runKey) {
    const key = String(runKey || '').trim();
    if (!key) return;
    const latest = rv.latestThinkingByRun.get(key);
    const keepLatest = shouldKeepSdkThinkingSpinner({
      runKey: key,
      activeKind: rv.activeKind,
      activeThinkingRunKey: rv.activeThinkingRunKey,
      suppressHistoryPersist: rv.suppressHistoryPersist,
      runStatus: rv.runStatusByRun.get(key),
      hasRunningTools: hasRunningSdkTools(rv.runningToolCallsByRun, key),
      isLiveTurn: rv.isLiveTurn,
    });
    for (const stale of listRunItems(rv.thinkingBlocksByRun, key)) {
      if (stale === latest && keepLatest) continue;
      if (!stale || typeof stale !== 'object' || !('running' in stale)) continue;
      stale.running = false;
    }
    if (!latest || typeof latest !== 'object' || !('running' in latest)) return;
    latest.running = keepLatest;
    if (keepLatest) latest.open = true;
  }

  /**
   * @param {Record<string, unknown>} ev
   * @returns {string}
   */
  function getEventRunKey(ev) {
    const runId = typeof ev.run_id === 'string' ? ev.run_id.trim() : '';
    return runId || `local-run-${rv.runScope}`;
  }
}
