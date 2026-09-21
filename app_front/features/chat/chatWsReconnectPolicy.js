import { isMobileLikeClient } from '../../lib/mobileClient.js';
import {
  CHAT_BACKGROUND_RECONNECT_BATCH_DELAY_MS,
  CHAT_BACKGROUND_RECONNECT_BATCH_DELAY_MS_MOBILE,
  CHAT_BACKGROUND_RECONNECT_BATCH_SIZE,
  CHAT_BACKGROUND_RECONNECT_BATCH_SIZE_MOBILE,
  CHAT_HISTORY_BACKGROUND_HTTP_BATCH_SIZE,
  CHAT_HISTORY_BACKGROUND_HTTP_BATCH_SIZE_MOBILE,
  CHAT_WS_MAX_CONCURRENT_CONNECTS,
  CHAT_WS_MAX_CONCURRENT_CONNECTS_MOBILE,
} from '../../config.js';

/**
 * @param {boolean} [isMobileResumeQuietPeriod]
 * @returns {number}
 */
export function resolveBackgroundReconnectBatchSize(isMobileResumeQuietPeriod = false) {
  if (isMobileLikeClient() || isMobileResumeQuietPeriod) {
    return CHAT_BACKGROUND_RECONNECT_BATCH_SIZE_MOBILE;
  }
  return CHAT_BACKGROUND_RECONNECT_BATCH_SIZE;
}

/**
 * @param {boolean} [isMobileResumeQuietPeriod]
 * @returns {number}
 */
export function resolveBackgroundReconnectBatchDelayMs(isMobileResumeQuietPeriod = false) {
  if (isMobileLikeClient() || isMobileResumeQuietPeriod) {
    return CHAT_BACKGROUND_RECONNECT_BATCH_DELAY_MS_MOBILE;
  }
  return CHAT_BACKGROUND_RECONNECT_BATCH_DELAY_MS;
}

/**
 * @returns {number}
 */
export function resolveMaxConcurrentWsConnects() {
  if (isMobileLikeClient()) return CHAT_WS_MAX_CONCURRENT_CONNECTS_MOBILE;
  return CHAT_WS_MAX_CONCURRENT_CONNECTS;
}

/**
 * Background HTTP history pulls reuse the WS handshake budget, but must stay
 * above 0 on mobile (backgroundWsMax is 0 there; HTTP is the only path).
 *
 * @param {boolean} [isMobile]
 * @returns {number}
 */
export function resolveBackgroundHttpMaxConcurrent(isMobile = isMobileLikeClient()) {
  const raw = isMobile ? CHAT_WS_MAX_CONCURRENT_CONNECTS_MOBILE : CHAT_WS_MAX_CONCURRENT_CONNECTS;
  return Math.max(1, raw);
}

/**
 * @param {boolean} [isMobileResumeQuietPeriod]
 * @returns {number}
 */
export function resolveBackgroundHttpBatchSize(isMobileResumeQuietPeriod = false) {
  if (isMobileLikeClient() || isMobileResumeQuietPeriod) {
    return Math.max(1, CHAT_HISTORY_BACKGROUND_HTTP_BATCH_SIZE_MOBILE);
  }
  return Math.max(1, CHAT_HISTORY_BACKGROUND_HTTP_BATCH_SIZE);
}

/**
 * @param {boolean} [isMobileResumeQuietPeriod]
 * @returns {number}
 */
export function resolveBackgroundHttpBatchDelayMs(isMobileResumeQuietPeriod = false) {
  return Math.max(0, resolveBackgroundReconnectBatchDelayMs(isMobileResumeQuietPeriod));
}

/**
 * @param {number} activeConnectCount
 * @param {boolean} isActiveChat
 * @returns {boolean}
 */
export function canOpenChatWebSocketNow(activeConnectCount, isActiveChat) {
  if (isActiveChat) return true;
  return activeConnectCount < resolveMaxConcurrentWsConnects();
}
