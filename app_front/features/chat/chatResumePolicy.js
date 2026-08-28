/** Recycle an open active-chat socket only after long background (avoids SDK replay storms). */
export const RESUME_FORCE_WS_RECONNECT_MS = 60000;

/** HTTP history catch-up after resume when background was at least this long. */
export const RESUME_HISTORY_SYNC_MIN_MS = 8000;

/** Defer cross-device history poll after mobile/PWA resume. */
export const RESUME_POLL_DEFER_MOBILE_MS = 12000;

/** Keep only the active chat WS open briefly after mobile resume. */
export const RESUME_BACKGROUND_WS_QUIET_MOBILE_MS = 30000;

/** Skip active-chat HTTP catch-up when WS is open and server gap is tiny. */
export const ACTIVE_CHAT_HISTORY_POLL_SKIP_GAP = 512;

/** Ignore duplicate active-chat history sync within this window. */
export const RESUME_SYNC_COOLDOWN_MS = 45000;

/** Base defer before resume history sync on mobile (visibility/pageshow). */
export const RESUME_HISTORY_SYNC_DEFER_MOBILE_MS = 2500;

/** Base defer before resume history sync on desktop. */
export const RESUME_HISTORY_SYNC_DEFER_DESKTOP_MS = 1200;

/** Extra defer for poll/room-state driven sync on mobile. */
export const RESUME_POLL_REASON_EXTRA_DEFER_MOBILE_MS = 2000;

/** Wait for WS replay to finish before HTTP catch-up on mobile reconnect. */
export const MOBILE_WS_REPLAY_FALLBACK_MS = 1500;

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
 * @returns {boolean}
 */
export function shouldRecycleActiveChatSocketOnResume(backgroundMs, forceReconnect, readyState) {
  if (readyState !== WebSocket.OPEN) return false;
  if (forceReconnect) return true;
  if (!Number.isFinite(backgroundMs) || backgroundMs <= 0) return false;
  return backgroundMs >= RESUME_FORCE_WS_RECONNECT_MS;
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
 * @param {string} reason
 * @param {boolean} isMobileLike
 * @param {number} [backgroundMs]
 * @returns {number}
 */
export function getResumeHistorySyncDeferMs(reason, isMobileLike, backgroundMs = 0) {
  if (!shouldDeferResumeHistorySyncReason(reason)) return 0;
  let deferMs = isMobileLike ? RESUME_HISTORY_SYNC_DEFER_MOBILE_MS : RESUME_HISTORY_SYNC_DEFER_DESKTOP_MS;
  const normalized = String(reason || '').trim();
  if (
    isMobileLike &&
    (normalized === 'cross_device_poll' || normalized === 'room_state_gap')
  ) {
    deferMs += RESUME_POLL_REASON_EXTRA_DEFER_MOBILE_MS;
  }
  if (isMobileLike && Number.isFinite(backgroundMs) && backgroundMs >= RESUME_FORCE_WS_RECONNECT_MS) {
    deferMs += 1500;
  }
  return deferMs;
}

/**
 * @param {{ headSeq: number, localAck: number, wsOpen: boolean, hydrating?: boolean, lastSyncAt?: number, now?: number }} input
 * @returns {boolean}
 */
export function shouldSkipActiveChatHistoryPollSync(input) {
  const headSeq = Number(input.headSeq);
  const localAck = Number(input.localAck);
  const gap = headSeq - localAck;
  if (!Number.isFinite(gap) || gap <= 0) return true;
  if (input.wsOpen && input.hydrating !== true) return true;
  if (gap <= ACTIVE_CHAT_HISTORY_POLL_SKIP_GAP) return true;
  const lastSyncAt = Number(input.lastSyncAt);
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  if (Number.isFinite(lastSyncAt) && lastSyncAt > 0 && now - lastSyncAt < RESUME_SYNC_COOLDOWN_MS) {
    return true;
  }
  return false;
}
