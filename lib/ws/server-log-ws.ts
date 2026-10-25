import type { WebSocket } from 'ws';

/** Server stdout/stderr ring buffer for modal preview. */
export const SERVER_LOG_BUFFER_MAX = 64 * 1024;

export const serverLogBuffer: { content: string } = { content: '' };

export const serverLogClients = new Set<WebSocket>();

export function handleServerLogConnection(ws: WebSocket): void {
  if (serverLogBuffer.content.length > 0 && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'output', catchUp: true, data: serverLogBuffer.content }));
  }
  serverLogClients.add(ws);
  ws.on('close', () => serverLogClients.delete(ws));
}

/** Hooks process.stdout/stderr and streams output to connected WS clients. */
export function installServerLogCapture(): void {
  const append = (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : (chunk && (chunk as { toString?: () => string }).toString ? (chunk as { toString: () => string }).toString() : '');
    if (!text) return;
    serverLogBuffer.content = (serverLogBuffer.content + text).slice(-SERVER_LOG_BUFFER_MAX);
    const msg = JSON.stringify({ type: 'output', data: text });
    for (const client of serverLogClients) {
      if (client.readyState === 1) client.send(msg);
    }
  };
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = function stdoutWrite(chunk: string | Uint8Array, enc?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) {
    append(chunk);
    return origStdout(chunk, enc as BufferEncoding, cb);
  };
  process.stderr.write = function stderrWrite(chunk: string | Uint8Array, enc?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) {
    append(chunk);
    return origStderr(chunk, enc as BufferEncoding, cb);
  };
}
