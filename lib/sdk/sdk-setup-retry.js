export const SETUP_FAILURE_MAX_RETRIES = 2;

/**
 * @param {number} retryCount
 * @param {number} [maxRetries]
 * @returns {boolean}
 */
export function shouldRetrySetupFailure(retryCount, maxRetries = SETUP_FAILURE_MAX_RETRIES) {
  if (!Number.isFinite(retryCount) || retryCount < 0) return true;
  if (!Number.isFinite(maxRetries) || maxRetries < 1) return false;
  return retryCount < maxRetries;
}

/**
 * @param {number} retryCount
 * @param {number} [maxRetries]
 * @returns {string}
 */
export function buildSetupRetryMessage(retryCount, maxRetries = SETUP_FAILURE_MAX_RETRIES) {
  const attempt = Math.max(1, Number(retryCount) || 1);
  const max = Math.max(1, Number(maxRetries) || SETUP_FAILURE_MAX_RETRIES);
  return `Agent setup failed. Retrying (${attempt}/${max})…`;
}
