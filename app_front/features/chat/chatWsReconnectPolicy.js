import { isMobileLikeClient } from '../../lib/mobileClient.js';
import {
  CHAT_BACKGROUND_RECONNECT_BATCH_DELAY_MS,
  CHAT_BACKGROUND_RECONNECT_BATCH_DELAY_MS_MOBILE,
  CHAT_BACKGROUND_RECONNECT_BATCH_SIZE,
  CHAT_BACKGROUND_RECONNECT_BATCH_SIZE_MOBILE,
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
 * @param {number} activeConnectCount
 * @param {boolean} isActiveChat
 * @returns {boolean}
 */
export function canOpenChatWebSocketNow(activeConnectCount, isActiveChat) {
  if (isActiveChat) return true;
  return activeConnectCount < resolveMaxConcurrentWsConnects();
}
