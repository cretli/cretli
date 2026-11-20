/**
 * Coalesces `agentPresence` WebSocket frames. A resume burst can deliver hundreds of
 * frames inside one task; applying each one synchronously re-renders the sidebar per
 * frame and trips the ui-freeze-ws watchdog. Frames are queued (arrival order kept) and
 * flushed once per animation frame, so the consumer can ingest them in order and
 * schedule its UI work a single time per batch.
 */

/**
 * @param {{ onFlush: (frames: unknown[]) => void, requestFrame?: (cb: () => void) => unknown, cancelFrame?: (handle: unknown) => void }} opts
 * @returns {{ push: (frame: unknown) => void, flush: () => void, dispose: () => void }}
 */
export function createPresenceFrameCoalescer({ onFlush, requestFrame, cancelFrame }) {
  const raf = requestFrame
    || (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null);
  const caf = cancelFrame
    || (typeof cancelAnimationFrame === 'function' ? (h) => cancelAnimationFrame(/** @type {number} */ (h)) : null);
  let queue = [];
  let frameHandle = null;
  let timerHandle = null;
  let disposed = false;

  function clearTimers() {
    if (frameHandle != null && caf) caf(frameHandle);
    if (timerHandle != null) clearTimeout(timerHandle);
    frameHandle = null;
    timerHandle = null;
  }

  function flush() {
    clearTimers();
    if (disposed || !queue.length) return;
    const frames = queue;
    queue = [];
    onFlush(frames);
  }

  function push(frame) {
    if (disposed) return;
    queue.push(frame);
    if (frameHandle != null || timerHandle != null) return;
    if (raf) frameHandle = raf(flush);
    // Hidden tabs pause rAF; the timer keeps presence state from going stale.
    timerHandle = setTimeout(flush, 100);
  }

  function dispose() {
    disposed = true;
    clearTimers();
    queue = [];
  }

  return { push, flush, dispose };
}
