/** Max automatic retries after Cursor API authentication failures. */
export const SDK_AUTH_RECOVERY_MAX_RETRIES = 1;

/** Max automatic retries after Cursor API rate-limit / resource-exhausted errors. */
export const SDK_RATE_LIMIT_RECOVERY_MAX_RETRIES = 1;

/**
 * @param {unknown} message
 * @returns {boolean}
 */
export function isSdkRateLimitError(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;
  if (text.includes('rate limit')) return true;
  if (text.includes('too many requests')) return true;
  if (text.includes('resource_exhausted')) return true;
  if (text.includes('resource exhausted')) return true;
  return text.includes('429');
}

/**
 * @param {unknown} message
 * @returns {boolean}
 */
export function isSdkAuthenticationError(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;
  if (isSdkRateLimitError(message)) return false;
  if (text.includes('authentication error')) return true;
  if (text.includes('invalid api key')) return true;
  if (text.includes('api key') && (text.includes('invalid') || text.includes('expired') || text.includes('unauthorized'))) {
    return true;
  }
  return text.includes('unauthorized') && text.includes('cursor');
}

/**
 * @param {number} retryAttempt
 * @param {number} [maxRetries]
 * @returns {string}
 */
export function buildSdkAuthRecoveryRetryMessage(
  retryAttempt,
  maxRetries = SDK_AUTH_RECOVERY_MAX_RETRIES
) {
  const attempt = Math.max(1, Number(retryAttempt) || 1);
  const max = Math.max(1, Number(maxRetries) || SDK_AUTH_RECOVERY_MAX_RETRIES);
  return `Cursor API authorization error — refreshing the agent session and retrying the prompt (${attempt}/${max})…`;
}

/**
 * @param {number} retryCount
 * @param {number} [maxRetries]
 * @returns {boolean}
 */
export function shouldRetrySdkAuthRecovery(retryCount, maxRetries = SDK_AUTH_RECOVERY_MAX_RETRIES) {
  return Number(retryCount) < Math.max(1, Number(maxRetries) || SDK_AUTH_RECOVERY_MAX_RETRIES);
}

/**
 * @param {number} retryAttempt
 * @param {number} [maxRetries]
 * @returns {string}
 */
export function buildSdkRateLimitRecoveryRetryMessage(
  retryAttempt,
  maxRetries = SDK_RATE_LIMIT_RECOVERY_MAX_RETRIES
) {
  const attempt = Math.max(1, Number(retryAttempt) || 1);
  const max = Math.max(1, Number(maxRetries) || SDK_RATE_LIMIT_RECOVERY_MAX_RETRIES);
  return `Cursor API usage limit — waiting and retrying your prompt (${attempt}/${max})…`;
}

/**
 * @param {number} retryCount
 * @param {number} [maxRetries]
 * @returns {boolean}
 */
export function shouldRetrySdkRateLimitRecovery(
  retryCount,
  maxRetries = SDK_RATE_LIMIT_RECOVERY_MAX_RETRIES
) {
  return Number(retryCount) < Math.max(1, Number(maxRetries) || SDK_RATE_LIMIT_RECOVERY_MAX_RETRIES);
}
