/**
 * Offline state for the Todo list refresh. A rejected fetch (network down, no
 * response) must keep the last rendered list and retry quietly, while a server
 * answer (ok:false / 5xx payload) keeps the regular error path.
 */

const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;

/**
 * True for transport-level failures: fetch rejected without any response.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNetworkLoadError(error) {
  if (!error) return false;
  if (error instanceof TypeError) return true;
  const message = String(/** @type {{ message?: unknown }} */ (error)?.message || error);
  return /failed to fetch|networkerror|network request failed|load failed|no response/i.test(message);
}

/**
 * @param {number} attempt zero-based retry attempt
 * @returns {number} delay in ms (exponential, capped)
 */
export function offlineRetryDelay(attempt) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt));
}

/**
 * Holds the last good list plus the offline flag.
 *
 * @param {Array<object>} [initialItems]
 */
export function createTodoListModel(initialItems = []) {
  let items = initialItems;
  let offline = false;
  let attempt = 0;
  return {
    get items() { return items; },
    get offline() { return offline; },
    get attempt() { return attempt; },
    /** @param {Array<object>} next */
    applySuccess(next) {
      items = Array.isArray(next) ? next : [];
      offline = false;
      attempt = 0;
    },
    /**
     * @param {unknown} error
     * @returns {'offline' | 'error'} offline keeps `items`; error is for the caller to render
     */
    applyFailure(error) {
      if (!isNetworkLoadError(error)) return 'error';
      offline = true;
      attempt += 1;
      return 'offline';
    },
  };
}
