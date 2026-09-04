/** Server stdout/stderr ring buffer for modal preview. */
export const SERVER_LOG_BUFFER_MAX = 64 * 1024;

/** @type {{ content: string }} */
export const serverLogBuffer = { content: '' };

/** @type {Set<import('ws').WebSocket>} */
export const serverLogClients = new Set();

/**
 * @param {import('ws').WebSocket} ws
 */
export function handleServerLogConnection(ws) {
  if (serverLogBuffer.content.length > 0 && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'output', catchUp: true, data: serverLogBuffer.content }));
  }
  serverLogClients.add(ws);
  ws.on('close', () => serverLogClients.delete(ws));
}

/** Hooks process.stdout/stderr and streams output to connected WS clients. */
export function installServerLogCapture() {
  const append = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : (chunk && chunk.toString ? chunk.toString() : '');
    if (!text) return;
    serverLogBuffer.content = (serverLogBuffer.content + text).slice(-SERVER_LOG_BUFFER_MAX);
    const msg = JSON.stringify({ type: 'output', data: text });
    for (const client of serverLogClients) {
      if (client.readyState === 1) client.send(msg);
    }
  };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = function stdoutWrite(chunk, enc, cb) {
    append(chunk);
    return origStdout(chunk, enc, cb);
  };
  process.stderr.write = function stderrWrite(chunk, enc, cb) {
    append(chunk);
    return origStderr(chunk, enc, cb);
  };
}
