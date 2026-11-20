/**
 * Map harness run failures to a stable delegation error code.
 */

export const DELEGATION_ADAPTER_TIMEOUT_CODE = 'adapter_timeout';
export const DELEGATION_ADAPTER_INCOMPLETE_CODE = 'adapter_incomplete';
/** Review produced a report but no VERDICT line, even after the follow-up: infra "no answer", never a FAIL. */
export const DELEGATION_ADAPTER_NO_VERDICT_CODE = 'adapter_no_verdict';

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isDelegationAdapterTimeout(err) {
  if (!err || typeof err !== 'object') return false;
  const row = /** @type {{ code?: unknown, message?: unknown }} */ (err);
  if (String(row.code || '').trim() === DELEGATION_ADAPTER_TIMEOUT_CODE) return true;
  return /timed out/i.test(String(row.message || ''));
}

/**
 * @param {string} message
 * @returns {Error}
 */
export function createDelegationAdapterTimeoutError(message) {
  const err = new Error(String(message || 'Adapter timed out'));
  err.code = DELEGATION_ADAPTER_TIMEOUT_CODE;
  return err;
}

/**
 * @param {unknown} err
 * @returns {unknown}
 */
export function tagDelegationAdapterTimeout(err) {
  if (!err || typeof err !== 'object') return err;
  if (!isDelegationAdapterTimeout(err)) return err;
  const row = /** @type {{ code?: string }} */ (err);
  if (!row.code) row.code = DELEGATION_ADAPTER_TIMEOUT_CODE;
  return err;
}
