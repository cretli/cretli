/** Default PTY ring buffer size for terminal/agent session catch-up. */
export const PTY_BUFFER_MAX = 64 * 1024;

/** Smaller catch-up buffer for task/build runs (avoids UI freeze after refresh). */
export const TASK_RUN_BUFFER_MAX = 16 * 1024;

/**
 * @param {Set<{ readyState: number, send: (msg: string) => void }>} clients
 * @param {object} data
 */
export function broadcastToClients(clients, data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(msg);
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
 * Flushes any pending batched PTY output (e.g. before onExit so clients see full output).
 *
 * @param {Set<{ readyState: number, send: (msg: string) => void }>} clients
 * @param {{ _flushScheduled?: boolean, _pendingOutput?: string }} state
 */
export function flushPtyOutput(clients, state) {
  state._flushScheduled = false;
  const out = state._pendingOutput || '';
  state._pendingOutput = '';
  if (out && clients.size > 0) broadcastToClients(clients, { type: 'output', data: out });
}
