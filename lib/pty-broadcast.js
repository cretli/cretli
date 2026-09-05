import {
  shouldSendToClient,
  WS_BACKPRESSURE_THRESHOLD_BYTES,
} from './sdk/sdk-ws-transport.js';

/** Default PTY ring buffer size for terminal/agent session catch-up. */
export const PTY_BUFFER_MAX = 64 * 1024;

/** Smaller catch-up buffer for task/build runs (avoids UI freeze after refresh). */
export const TASK_RUN_BUFFER_MAX = 16 * 1024;

const BACKPRESSURE_WARN_INTERVAL_MS = 5000;
let lastBackpressureWarnAt = 0;

/**
 * @param {Set<{ readyState: number, send: (msg: string) => void, bufferedAmount?: number }>} clients
 * @param {object} data
 */
export function broadcastToClients(clients, data) {
  const msg = JSON.stringify(data);
  let skipped = 0;
  for (const client of clients) {
    if (!shouldSendToClient(client, 'normal', WS_BACKPRESSURE_THRESHOLD_BYTES)) {
      if (client?.readyState === 1) skipped += 1;
      continue;
    }
    client.send(msg);
  }
  if (skipped > 0) {
    const now = Date.now();
    if (now - lastBackpressureWarnAt >= BACKPRESSURE_WARN_INTERVAL_MS) {
      lastBackpressureWarnAt = now;
      console.warn(
        `[pty] skipped ${skipped} client(s): bufferedAmount > ${WS_BACKPRESSURE_THRESHOLD_BYTES} bytes`,
      );
    }
  }
}

/**
 * Sends PTY output immediately on each onData chunk. Batching agent sessions into one
 * frame per tick merged hundreds of lines and broke Cursor TUI (status, Thinking, \\r).
 * More WS frames, but behavior matches a real PTY.
 *
 * @param {Set<{ readyState: number, send: (msg: string) => void }>} clients
 * @param {{ buffer?: string, bufferMax?: number }} state
 * @param {string} data
 * @param {number} [defaultBufferMax]
 */
export function queuePtyOutput(clients, state, data, defaultBufferMax = PTY_BUFFER_MAX) {
  const bufferMax = Number.isFinite(state?.bufferMax) && state.bufferMax > 0
    ? state.bufferMax
    : defaultBufferMax;
  state.buffer = (state.buffer + data).slice(-bufferMax);
  if (data && clients.size > 0) broadcastToClients(clients, { type: 'output', data });
}

/**
 * Output is sent immediately in `queuePtyOutput`. Kept as an explicit hook before
 * `onExit` so call sites stay readable.
 *
 * @param {Set<{ readyState: number, send: (msg: string) => void }>} [_clients]
 * @param {{ _flushScheduled?: boolean }} [state]
 */
export function flushPtyOutput(_clients, state) {
  if (state) state._flushScheduled = false;
}
