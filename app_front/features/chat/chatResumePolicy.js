/** Recycle an open active-chat socket only after long background (avoids SDK replay storms). */
export const RESUME_FORCE_WS_RECONNECT_MS = 60000;

/**
 * Mobile recycles an apparently-open active socket much earlier: iOS/Android
 * freeze or kill the socket within seconds, and the resume probe is short.
 */
export const RESUME_FORCE_WS_RECONNECT_MOBILE_MS = 15000;

/**
 * @param {boolean} isMobileLike
 * @returns {number}
 */
export function resolveResumeForceWsReconnectMs(isMobileLike) {
  return isMobileLike === true
    ? RESUME_FORCE_WS_RECONNECT_MOBILE_MS
    : RESUME_FORCE_WS_RECONNECT_MS;
}

/** HTTP history catch-up after any real background interval (0 = even a short absence). */
export const RESUME_HISTORY_SYNC_MIN_MS = 0;

/** Defer cross-device history poll after mobile/PWA resume. */
export const RESUME_POLL_DEFER_MOBILE_MS = 12000;

/** Keep only the active chat WS open briefly after mobile resume. */
export const RESUME_BACKGROUND_WS_QUIET_MOBILE_MS = 30000;

/** Wait this long for live WS events before HTTP-fetching an active-chat gap. */
export const ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS = 4000;

/** @deprecated Gaps are no longer skipped by size; kept for callers that still import the name. */
export const ACTIVE_CHAT_HISTORY_POLL_SKIP_GAP = 0;

/** Ignore duplicate active-chat history sync within this window. */
export const RESUME_SYNC_COOLDOWN_MS = 45000;

/** Base defer before resume history sync on mobile (background poll reasons only). */
export const RESUME_HISTORY_SYNC_DEFER_MOBILE_MS = 2500;

/** Base defer before resume history sync on desktop (background poll reasons only). */
export const RESUME_HISTORY_SYNC_DEFER_DESKTOP_MS = 1200;

/** Extra defer for poll/room-state driven sync on mobile. */
export const RESUME_POLL_REASON_EXTRA_DEFER_MOBILE_MS = 2000;

/** Wait for WS replay to start/finish before HTTP catch-up on mobile reconnect. */
export const MOBILE_WS_REPLAY_FALLBACK_MS = 1500;

/** Absolute deadline covering missing replay start or end. */
export const MOBILE_WS_REPLAY_DEADLINE_MS = 8000;

/** Cooldown between room-state gap HTTP syncs for the active chat. */
export const ROOM_STATE_GAP_SYNC_COOLDOWN_MS = 45000;

/**
 * @param {boolean} needsReconnect
 * @param {boolean} isMobileLike
 * @returns {boolean}
 */
export function shouldSkipHttpHistorySyncForMobileWsReplay(needsReconnect, isMobileLike) {
  return needsReconnect === true && isMobileLike === true;
}

/**
 * @param {number} backgroundMs
 * @param {boolean} forceReconnect
 * @param {number | undefined} readyState
 * @param {boolean} [isMobileLike]
 * @returns {boolean}
 */
export function shouldRecycleActiveChatSocketOnResume(
  backgroundMs,
  forceReconnect,
  readyState,
  isMobileLike = false
) {
  if (readyState !== WebSocket.OPEN) return false;
  if (forceReconnect) return true;
  if (!Number.isFinite(backgroundMs) || backgroundMs <= 0) return false;
  return backgroundMs >= resolveResumeForceWsReconnectMs(isMobileLike);
}

/**
 * @param {number} backgroundMs
 * @param {boolean} forceReconnect
 * @param {number | undefined} readyState
 * @returns {boolean}
 */
export function shouldSyncActiveChatHistoryOnResume(backgroundMs, forceReconnect, readyState) {
  if (forceReconnect) return true;
  if (readyState !== WebSocket.OPEN) return true;
  if (!Number.isFinite(backgroundMs) || backgroundMs <= 0) return false;
  return backgroundMs >= RESUME_HISTORY_SYNC_MIN_MS;
}

/**
 * Replay can speed up reconnect, but it does not prove the view has new
 * persistent history rows. HTTP catch-up still runs after replay ends.
 *
 * @returns {boolean}
 */
export function shouldHttpCatchUpAfterWsReplay() {
  return true;
}

/**
 * Existing rendered history is not proof it contains newly arrived messages.
 *
 * @returns {boolean}
 */
export function shouldApplyReplayEventsToRenderedView() {
  return true;
}

/**
 * Resume history sync should run only after a real background / reconnect,
 * not on the initial pageshow of a fresh page load (openTerminal already hydrates).
 *
 * @param {string} reason
 * @param {number} backgroundMs
 * @param {boolean} forceReconnect
 * @param {boolean} wasPageHidden
 * @returns {boolean}
 */
export function shouldRunResumeChatHistorySync(reason, backgroundMs, forceReconnect, wasPageHidden) {
  if (forceReconnect) return true;
  if (Number.isFinite(backgroundMs) && backgroundMs > 0) return true;
  const normalized = String(reason || '').trim();
  if (normalized === 'online' || normalized === 'backend_recovery') return true;
  if (normalized === 'notification') return true;
  if ((normalized === 'pageshow' || normalized === 'visibility') && wasPageHidden) return true;
  return false;
}

/**
 * @param {string} reason
 * @returns {boolean}
 */
export function shouldDeferResumeHistorySyncReason(reason) {
  const normalized = String(reason || '').trim();
  return (
    normalized === 'visibility' ||
    normalized === 'pageshow' ||
    normalized === 'online' ||
    normalized === 'backend_recovery' ||
    normalized === 'cross_device_poll' ||
    normalized === 'room_state_gap' ||
    normalized === 'replay_fallback'
  );
}

/**
 * Active-chat resume reasons (visibility/pageshow/online/backend_recovery,
 * replay_complete/replay_fallback) sync immediately. Only the background poll
 * reasons keep the original defer, which protects the UI during a poll storm.
 *
 * @param {string} reason
 * @param {boolean} isMobileLike
 * @param {number} [backgroundMs]
 * @returns {number}
 */
export function getResumeHistorySyncDeferMs(reason, isMobileLike, backgroundMs = 0) {
  if (!shouldDeferResumeHistorySyncReason(reason)) return 0;
  const normalized = String(reason || '').trim();
  // Active-chat resume reasons (visibility/pageshow/online/backend_recovery,
  // replay_fallback) sync immediately; only background poll reasons keep a defer.
  if (normalized !== 'cross_device_poll' && normalized !== 'room_state_gap') return 0;
  let deferMs = isMobileLike
    ? RESUME_HISTORY_SYNC_DEFER_MOBILE_MS
    : RESUME_HISTORY_SYNC_DEFER_DESKTOP_MS;
  if (isMobileLike) {
    deferMs += RESUME_POLL_REASON_EXTRA_DEFER_MOBILE_MS;
    if (Number.isFinite(backgroundMs) && backgroundMs >= resolveResumeForceWsReconnectMs(true)) {
      deferMs += 1500;
    }
  }
  return deferMs;
}

/**
 * @param {{
 *   headSeq: number,
 *   localAck: number,
 *   viewAppliedSeq?: number,
 *   wsOpen: boolean,
 *   hydrating?: boolean,
 *   lastSyncAt?: number,
 *   now?: number,
 *   gapObservedAt?: number,
 *   wsGraceMs?: number,
 *   hasPendingDelegation?: boolean,
 * }} input
 * @returns {boolean}
 */
export function shouldSkipActiveChatHistoryPollSync(input) {
  const headSeq = Number(input.headSeq);
  const localAck = Number(input.localAck);
  const viewAppliedSeq = Number.isFinite(Number(input.viewAppliedSeq))
    ? Number(input.viewAppliedSeq)
    : localAck;
  const storeGap = headSeq - localAck;
  const viewGap = headSeq - viewAppliedSeq;
  if (!Number.isFinite(storeGap) || !Number.isFinite(viewGap)) return true;
  if (storeGap <= 0 && viewGap <= 0) return true;
  if (input.hasPendingDelegation === true) return false;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const lastSyncAt = Number(input.lastSyncAt);
  const viewCaughtUp = viewGap <= 0;
  if (
    viewCaughtUp &&
    Number.isFinite(lastSyncAt) &&
    lastSyncAt > 0 &&
    now - lastSyncAt < RESUME_SYNC_COOLDOWN_MS
  ) {
    return true;
  }
  if (viewCaughtUp) return true;
  if (input.hydrating === true) return false;
  if (input.wsOpen !== true) return false;
  const graceMs = Number.isFinite(Number(input.wsGraceMs))
    ? Number(input.wsGraceMs)
    : ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS;
  const gapObservedAt = Number(input.gapObservedAt);
  if (!Number.isFinite(gapObservedAt) || gapObservedAt <= 0) return true;
  return now - gapObservedAt < graceMs;
}
