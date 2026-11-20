const DEFAULT_FALLBACK_MS = 4000;

/**
 * Stops a Live session after the model has had a chance to say goodbye.
 * `request()` starts a fallback timer; `onComplete()` / `finish()` stop when
 * the spoken reply has ended.
 *
 * @param {{
 *   stop: () => void,
 *   delayMs?: number,
 *   schedule?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void,
 * }} options
 */
export function createPendingEndSession(options) {
  const stop = typeof options?.stop === 'function' ? options.stop : () => {};
  const delayMs = Number.isFinite(options?.delayMs) && options.delayMs > 0
    ? options.delayMs
    : DEFAULT_FALLBACK_MS;
  const schedule = typeof options?.schedule === 'function'
    ? options.schedule
    : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof options?.clearTimer === 'function'
    ? options.clearTimer
    : (id) => clearTimeout(id);
  let pending = false;
  let skipLeft = 0;
  let timer = null;

  function clear() {
    pending = false;
    skipLeft = 0;
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function finish() {
    if (!pending) return;
    clear();
    stop();
  }

  return {
    /**
     * @param {{ skipCompletions?: number }} [opts]
     */
    request(opts = {}) {
      pending = true;
      skipLeft = Number.isFinite(opts.skipCompletions) && opts.skipCompletions > 0
        ? Math.floor(opts.skipCompletions)
        : 0;
      if (timer != null) clearTimer(timer);
      timer = schedule(() => {
        if (!pending) return;
        finish();
      }, delayMs);
    },
    onComplete() {
      if (!pending) return;
      if (skipLeft > 0) {
        skipLeft -= 1;
        return;
      }
      finish();
    },
    finish,
    reset: clear,
    isPending() {
      return pending;
    },
  };
}
