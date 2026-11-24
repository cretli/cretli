import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function fakeDeviceCdp({ contextUnsupported = false } = {}) {
  const requests = [], clients = new Set();
  const server = http.createServer((req, res) => {
    if (req.url !== '/json/version') return res.writeHead(404).end();
    res.end(JSON.stringify({ Browser: 'Fake', webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/browser' }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    clients.add(ws); ws.on('close', () => clients.delete(ws));
    ws.on('message', (bytes) => {
      const m = JSON.parse(String(bytes)); requests.push(m);
      let result = {};
      if (m.method === 'Target.createBrowserContext') result = { browserContextId: 'private-context' };
      if (m.method === 'Target.createTarget') result = { targetId: 'own-target' };
      if (m.method === 'Target.attachToTarget') result = { sessionId: 'own-session' };
      if (m.method === 'SystemInfo.getInfo') result = { gpu: { devices: [{ vendorString: 'TestGPU' }] }, modelName: 'TestModel', commandLine: '--remote-debugging-port=' + server.address().port + ' /private/profile' };
      if (m.method === 'Runtime.evaluate') result = { result: { value: '{"cores":8,"dpr":2}' } };
      if (m.method === 'Target.createBrowserContext' && contextUnsupported) ws.send(JSON.stringify({ id: m.id, error: { message: 'unsupported' } }));
      else ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port, requests,
    device: { id: 'd', name: 'Device', platform: 'macos', separateProfile: true, kind: 'chrome-cdp', host: '127.0.0.1', port },
    emit(message) { for (const ws of clients) ws.send(JSON.stringify(message)); },
    async close() { for (const ws of clients) ws.terminate(); wss.close(); await new Promise((resolve) => server.close(resolve)); },
  };
}
