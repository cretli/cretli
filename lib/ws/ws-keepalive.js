/** Interval between WebSocket protocol pings. */
export const WS_KEEPALIVE_INTERVAL_MS = 30_000;

/** Terminate after this many unanswered pings. */
export const WS_KEEPALIVE_MAX_MISSED = 2;

/**
 * Sends WebSocket protocol ping frames and terminates sockets that stop answering.
 *
 * @param {import('ws').WebSocket} ws
 * @param {{
 *   intervalMs?: number,
 *   maxMissed?: number,
 *   now?: () => number,
 * }} [options]
 * @returns {() => void} stop function
 */
export function attachWsKeepalive(ws, options = {}) {
  if (!ws || typeof ws.ping !== 'function') return () => {};
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : WS_KEEPALIVE_INTERVAL_MS;
  const maxMissed = Number.isFinite(options.maxMissed) && options.maxMissed > 0
    ? Math.floor(options.maxMissed)
    : WS_KEEPALIVE_MAX_MISSED;
  let missed = 0;
  const onPong = () => {
    missed = 0;
  };
  ws.on('pong', onPong);
  const timer = setInterval(() => {
    if (ws.readyState !== 1) {
      stop();
      return;
    }
    if (missed >= maxMissed) {
      try {
        ws.terminate();
      } catch (err) {
        console.warn('[ws-keepalive] terminate failed:', err?.message || err);
      }
      stop();
      return;
    }
    missed += 1;
    try {
      ws.ping();
    } catch (err) {
      console.warn('[ws-keepalive] ping failed:', err?.message || err);
    }
  }, intervalMs);
  function stop() {
    clearInterval(timer);
    if (typeof ws.off === 'function') ws.off('pong', onPong);
  }
  ws.once('close', stop);
  return stop;
}
