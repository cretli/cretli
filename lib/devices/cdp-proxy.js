import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { resolveDeviceEndpoint, summarizeSystemInfo } from './probe.js';

export const ALLOWED_METHODS = new Set([
  'Browser.getVersion',
  ...Object.entries({
    Page: ['enable', 'navigate', 'reload', 'captureScreenshot', 'getNavigationHistory', 'addScriptToEvaluateOnNewDocument', 'setLifecycleEventsEnabled', 'getLayoutMetrics', 'bringToFront'],
    Runtime: ['enable', 'evaluate', 'callFunctionOn', 'getProperties', 'releaseObject'],
    Performance: ['enable', 'disable', 'getMetrics'],
    Profiler: ['enable', 'disable', 'start', 'stop'],
    HeapProfiler: ['enable', 'disable', 'collectGarbage', 'startSampling', 'stopSampling'],
    Emulation: ['setDeviceMetricsOverride', 'setCPUThrottlingRate'],
    Network: ['enable', 'disable', 'emulateNetworkConditions', 'setCacheDisabled'],
    DOM: ['enable', 'getDocument', 'querySelector'],
    Log: ['enable'],
  }).flatMap(([domain, methods]) => methods.map((method) => domain + '.' + method)),
]);

/** A single-use CDP facade. Internal and script ids occupy one allocated namespace. */
export async function createCdpProxy(device, options = {}) {
  const timeout = options.timeoutMs || 5000;
  const upstream = new WebSocket(await (options.resolveEndpoint || resolveDeviceEndpoint)(device, options), { handshakeTimeout: timeout, maxPayload: 16 * 1024 * 1024 });
  const pending = new Map();
  let nextId = 0, targetId, contextId, sessionId, client, server, wss, closed = false;
  const sockets = new Set();
  const call = (method, params = {}, sid) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp-timeout')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    upstream.send(JSON.stringify({ id, method, params, sessionId: sid }));
  });
  const scriptIds = new Map();
  upstream.on('message', (bytes) => {
    let msg;
    try { msg = JSON.parse(String(bytes)); } catch { return; }
    if (pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'cdp-error')); else p.resolve(msg.result);
      return;
    }
    if (client?.readyState !== WebSocket.OPEN) return;
    if (msg.id !== undefined) {
      const request = scriptIds.get(msg.id);
      if (!request || (msg.sessionId && msg.sessionId !== sessionId)) return;
      scriptIds.delete(msg.id);
      msg.id = request.id;
    } else if (!sessionId || msg.sessionId !== sessionId) return;
    client.send(JSON.stringify(msg));
  });
  upstream.on('error', () => {});
  upstream.on('close', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('cdp-closed')); }
    pending.clear();
    client?.terminate();
  });
  async function close() {
    if (closed) return;
    closed = true;
    client?.terminate();
    if (upstream.readyState === WebSocket.OPEN) {
      if (targetId) await call('Target.closeTarget', { targetId }).catch(() => {});
      if (contextId) await call('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
    }
    upstream.terminate();
    for (const socket of sockets) socket.destroy();
    wss?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  try {
    await new Promise((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
    try { contextId = (await call('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId; }
    catch { throw new Error('context-unsupported'); }
    if (!contextId) throw new Error('context-unsupported');
    targetId = (await call('Target.createTarget', { url: 'about:blank', browserContextId: contextId })).targetId;
    if (!targetId) throw new Error('target-create-failed');
    sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    if (!sessionId) throw new Error('target-attach-failed');
    const info = await call('SystemInfo.getInfo');
    const page = await call('Runtime.evaluate', {
      expression: 'JSON.stringify({dpr:window.devicePixelRatio,cores:navigator.hardwareConcurrency})', returnByValue: true,
    }, sessionId);
    const hardware = summarizeSystemInfo({ ...info, page: JSON.parse(page.result?.value) });
    if (!hardware.cpuCores || !hardware.dpr) throw new Error('hardware-unavailable');
    const tokenPath = '/' + crypto.randomBytes(32).toString('hex');
    let url, used = false;
    server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && req.url === '/json/version' && req.headers.origin === undefined) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ webSocketDebuggerUrl: url }));
      } else { res.writeHead(403); res.end(); }
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      if (used || req.url !== tokenPath || req.headers.origin !== undefined) { socket.destroy(); return; }
      used = true;
      wss.handleUpgrade(req, socket, head, (ws) => {
        client = ws;
        ws.on('error', () => {});
        ws.on('message', (bytes) => {
          let msg;
          try { msg = JSON.parse(String(bytes)); } catch { return; }
          const deny = () => ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'method-refused' } }));
          if (!Number.isSafeInteger(msg.id) || !ALLOWED_METHODS.has(msg.method)) return deny();
          if (msg.sessionId !== undefined && msg.sessionId !== sessionId) return deny();
          if (msg.method === 'Page.navigate' && !/^(https?:\/\/|about:blank$)/i.test(String(msg.params?.url || ''))) return deny();
          const id = ++nextId;
          scriptIds.set(id, { id: msg.id });
          upstream.send(JSON.stringify({ id, method: msg.method, params: msg.params || {}, ...(msg.method === 'Browser.getVersion' ? {} : { sessionId }) }));
        });
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    url = 'ws://127.0.0.1:' + server.address().port + tokenPath;
    return { url, hardware, close };
  } catch (error) { await close(); throw error; }
}
