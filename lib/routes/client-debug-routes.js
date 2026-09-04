import { appendClientInstanceLogFile } from '../client-instance-logs.js';
import { isValidClientInstanceId } from '../client-instance-registry.js';

/**
 * @typedef {Object} ClientDebugRoutesContext
 * @property {string} dataDir
 * @property {(reason: string, ua: string, lines: string[]) => void} appendClientDebugLogFile
 */

/**
 * @param {import('express').Express} app
 * @param {ClientDebugRoutesContext} ctx
 */
export function registerClientDebugRoutes(app, ctx) {
  /** Browser logs (mobile freeze / no DevTools) — inspect on the Node host (e.g. RDP). */
  app.post('/api/client-debug-log', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 80) : '(none)';
    const ua = typeof body.ua === 'string' ? body.ua.slice(0, 500) : '';
    const clientInstanceId = typeof body.clientInstanceId === 'string' ? body.clientInstanceId.trim() : '';
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    const lines = [];
    for (let i = 0; i < rawLines.length && lines.length < 100; i += 1) {
      const line = rawLines[i];
      if (typeof line !== 'string') continue;
      lines.push(line.length > 2400 ? `${line.slice(0, 2400)}…` : line);
    }
    const stamp = new Date().toISOString();
    const idSuffix = clientInstanceId && isValidClientInstanceId(clientInstanceId) ? ` id=${clientInstanceId.slice(0, 8)}` : '';
    console.error('[client-debug]', stamp, 'reason=', reason, idSuffix, ua ? `ua=${ua}` : '');
    for (const line of lines) {
      console.error('[client-debug]', line);
    }
    if (clientInstanceId && isValidClientInstanceId(clientInstanceId)) {
      try {
        appendClientInstanceLogFile(ctx.dataDir, clientInstanceId, reason, ua, lines);
      } catch (err) {
        console.error('[client-instance-log]', err?.message || err);
      }
    }
    ctx.appendClientDebugLogFile(reason, ua, lines);
    res.json({ ok: true, received: lines.length, clientInstanceId: clientInstanceId || null });
  });
}
