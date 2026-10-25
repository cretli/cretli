/**
 * In-process change signal for delegation records. This replaces the 50 ms
 * hot poll in `delegation_wait`: a persist write wakes every waiter subscribed
 * to that id.
 *
 * This module is a leaf on purpose: it imports nothing (especially not
 * `delegations-persist.js` or `delegation-service.js`), so the persist layer
 * can import it without closing an import cycle.
 */

/**
 * @typedef {object} DelegationWaiter
 * @property {(event: { reason: 'changed', id: string }) => void} resolve
 */

/**
 * @type {Map<string, { waiters: Set<(event: { reason: 'changed', id: string }) => void> }>}
 */
const channels = new Map();

/** @type {Set<(event: { reason: 'changed', id: string }) => void>} */
const globalListeners = new Set();

/**
 * @param {unknown} delegationId
 * @returns {string}
 */
function normalizeId(delegationId) {
  return String(delegationId || '').trim();
}

/**
 * @param {string} id
 * @returns {{ waiters: Set<(event: { reason: 'changed', id: string }) => void> }}
 */
function ensureChannel(id) {
  let channel = channels.get(id);
  if (!channel) {
    channel = { waiters: new Set() };
    channels.set(id, channel);
  }
  return channel;
}

/**
 * Signal that a delegation record changed. Called from the persist layer after
 * every successful write. It must be cheap, synchronous and must never throw:
 * the caller's disk write has already happened, and an error here would only
 * mask a real conflict, so listeners are invoked defensively.
 *
 * @param {unknown} delegationId
 * @returns {void}
 */
export function notifyDelegationChange(delegationId) {
  const id = normalizeId(delegationId);
  if (!id) return;
  try {
    const channel = channels.get(id);
    if (channel) {
      const waiters = [...channel.waiters];
      channel.waiters.clear();
      if (channel.waiters.size === 0) {
        channels.delete(id);
      }
      for (const resolve of waiters) {
        try {
          resolve({ reason: 'changed', id });
        } catch {
          // A broken listener must not stop the remaining waiters.
        }
      }
    }
    for (const listener of [...globalListeners]) {
      try {
        listener({ reason: 'changed', id });
      } catch {
        // Global listeners are best-effort observers only.
      }
    }
  } catch {
    // Signalling is an optimization. Never let it break a persisted write.
  }
}

/**
 * Add a persistent observer for every delegation change. Returns an unsubscribe
 * function. Used by hosts that want a push hook instead of polling.
 *
 * @param {(event: { reason: 'changed', id: string }) => void} listener
 * @returns {() => void}
 */
/**
 * Test-only: number of open per-id wait channels (empty channels are removed).
 *
 * @returns {number}
 */
export function countDelegationSignalChannelsForTests() {
  return channels.size;
}

export function subscribeDelegationChanges(listener) {
  if (typeof listener !== 'function') return () => {};
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

/**
 * @returns {{ reason: Error }}
 */
function abortError() {
  const err = new Error('MCP call cancelled');
  err.code = 'VALIDATION_ERROR';
  return err;
}

/**
 * Wait until any of `delegationIds` changes, or `fallbackMs` elapses, or the
 * overall `timeoutMs` budget is spent, or `signal` aborts. Mirrors the abort
 * semantics of `sleepDelegationWait` (`MCP call cancelled`, `VALIDATION_ERROR`).
 *
 * The caller still re-reads the records after this resolves: `changed` and
 * `fallback` are both "look again", only `timeout` means "give up". A change
 * landing between the caller's last read and this subscription is therefore
 * still caught by the next fallback re-check, so no terminal state is missed.
 *
 * @param {string[]} delegationIds
 * @param {{ signal?: AbortSignal, timeoutMs?: number, fallbackMs?: number }} [options]
 * @returns {Promise<{ reason: 'changed' | 'fallback' | 'timeout', id?: string }>}
 */
export function waitForDelegationChange(delegationIds, options = {}) {
  const ids = [...new Set((Array.isArray(delegationIds) ? delegationIds : [])
    .map((value) => normalizeId(value))
    .filter(Boolean))];
  const signal = options.signal;
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  const fallbackMs = Number.isFinite(options.fallbackMs) && options.fallbackMs > 0
    ? Math.floor(options.fallbackMs)
    : 1000;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (ids.length === 0 || timeoutMs === 0) {
      resolve(timeoutMs === 0 ? { reason: 'timeout' } : { reason: 'fallback' });
      return;
    }

    /** @type {Map<string, (event: { reason: 'changed', id: string }) => void>} */
    const registered = new Map();
    let settled = false;
    let fallbackTimer = null;
    let timeoutTimer = null;

    function cleanup() {
      for (const [id, cb] of registered) {
        const channel = channels.get(id);
        if (!channel) continue;
        channel.waiters.delete(cb);
        if (channel.waiters.size === 0) {
          channels.delete(id);
        }
      }
      registered.clear();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    function finish(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    for (const id of ids) {
      const channel = ensureChannel(id);
      const cb = (event) => finish(event);
      channel.waiters.add(cb);
      registered.set(id, cb);
    }

    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    }

    fallbackTimer = setTimeout(() => finish({ reason: 'fallback' }), fallbackMs);
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => finish({ reason: 'timeout' }), timeoutMs);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
