/**
 * Debounced live refresh of the Todo list after a server `todo.review` change
 * (`docs/todo-review-contract.md` §10.7).
 *
 * The server frame carries identifiers only, so the panel refetches the list.
 * Several open chat sockets deliver the same frame, and a reconnect can add
 * another trigger, so a burst collapses into one fetch. A trigger that arrives
 * while a fetch is in flight schedules exactly one follow-up fetch, so the final
 * state always wins. Pure and DOM-free so it runs under `node:test`.
 */

/**
 * @param {{
 *   load: () => Promise<unknown>,
 *   apply: (data: unknown) => void,
 *   isActive?: () => boolean,
 *   debounceMs?: number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 * @returns {{ schedule: () => void, flush: () => Promise<void>, dispose: () => void }}
 */
export function createTodoReviewRefresher(options) {
  const {
    load,
    apply,
    isActive = () => true,
    debounceMs = 400,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let inFlight = false;
  let queued = false;
  let disposed = false;

  async function run() {
    timer = null;
    if (disposed || !isActive()) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      const data = await load();
      if (!disposed && data != null) apply(data);
    } catch {
      // A failed background refresh is silent; the next frame or a manual
      // refresh recovers, and the visible list is left untouched.
    } finally {
      inFlight = false;
      if (queued && !disposed) {
        queued = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (disposed) return;
    // A hidden panel is reloaded by `showPanel('todo')`, so skip the fetch.
    if (!isActive()) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      void run();
    }, debounceMs);
  }

  return {
    schedule,
    flush() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      return run();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
