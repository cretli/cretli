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

/**
 * Setup errors the server answers on every handshake (then closes the socket) until
 * the operator fixes the configuration. Reconnecting on the normal 1 s backoff only
 * loops "Connected / Missing API key", because a successful open resets the attempts.
 */
const SDK_SETUP_ERROR_CODES = new Set([
  'missing_api_key',
  'missing_subscription',
  'missing_cli',
  'no_cwd',
]);

const SDK_SETUP_ERROR_RETRY_BASE_MS = 30_000;
const SDK_SETUP_ERROR_RETRY_MAX_MS = 10 * 60_000;

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isSdkSetupErrorCode(code) {
  return SDK_SETUP_ERROR_CODES.has(String(code || ''));
}

/**
 * Cooldown before the next automatic handshake after `count` consecutive setup errors.
 *
 * @param {number} count
 * @returns {number}
 */
export function resolveSdkSetupErrorRetryMs(count) {
  const exponent = Math.max(0, Math.floor(Number(count) || 1) - 1);
  return Math.min(SDK_SETUP_ERROR_RETRY_MAX_MS, SDK_SETUP_ERROR_RETRY_BASE_MS * 2 ** exponent);
}

/**
 * @param {{ _sdkSetupErrorAt?: number, _sdkSetupErrorCount?: number } | null | undefined} chat
 * @param {number} [now]
 * @returns {boolean}
 */
export function isSdkSetupErrorCoolingDown(chat, now = Date.now()) {
  const at = Number(chat?._sdkSetupErrorAt) || 0;
  if (!at) return false;
  return now - at < resolveSdkSetupErrorRetryMs(chat?._sdkSetupErrorCount || 1);
}
