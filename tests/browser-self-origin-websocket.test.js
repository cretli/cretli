import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { detectBrowserRuntime } from '../lib/browser/runtime-detect.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

for (const { hostname, secure } of [
  { hostname: '127.0.0.1', secure: false },
  { hostname: 'localhost', secure: false },
  { hostname: '127.0.0.1', secure: true },
]) {
  test(`self-origin ${secure ? 'wss' : 'ws'} works on ${hostname} and rejects another port and revoked opt-in`, async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      process.env.CRETLI_BROWSER_ALLOW_NO_SANDBOX = '1';
    }
    const runtime = await detectBrowserRuntime();
    if (!runtime.available) {
      if (process.env.CRETLI_REQUIRE_BROWSER_LIVE === '1') assert.fail(runtime.reason);
      t.skip(`browser-unavailable: ${runtime.reason}`);
      return;
    }
    const handlePage = (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><body>Self-origin WebSocket fixture</body>');
    };
    let tlsOptions;
    if (secure) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-wss-'));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const keyPath = path.join(directory, 'key.pem');
      const certPath = path.join(directory, 'cert.pem');
      const generated = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath,
      ], { stdio: 'ignore' });
      assert.equal(generated.status, 0, 'openssl must be available, as in the server TLS tests');
      tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }
    const server = secure ? https.createServer(tlsOptions, handlePage) : http.createServer(handlePage);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sockets = new WebSocketServer({ server });
    const foreign = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(foreign, 'listening');
    let foreignConnections = 0;
    foreign.on('connection', () => { foreignConnections += 1; });
    let connections = 0;
    sockets.on('connection', (socket, request) => {
      connections += 1;
      assert.match(request.headers.cookie || '', /fixture=authenticated/);
      assert.equal(request.headers.origin, origin);
      socket.on('message', (message) => socket.send(`echo:${message}`));
    });
    const origin = `${secure ? 'https' : 'http'}://${hostname}:${server.address().port}`;
    const socketOrigin = origin.replace(/^http/, 'ws');
    let allowSelfOrigin = true;
    const owner = 'self-ws-owner';
    const scope = { workspaceFile: '/tmp/self-ws-fixture' };
    const manager = new BrowserSessionManager({
      driver: runtime.driver, driverStatus: runtime, selfOrigins: [origin],
      resolvePolicy: () => ({ allowSelfOrigin, allowInsecureTls: secure }),
    });
    try {
      const session = await manager.createSession({ ownerSessionId: owner, ...scope });
      const [tab] = manager.listTabs(session.browserSessionId, owner, scope);
      const context = manager.sessions.get(session.browserSessionId).context;
      await context.addCookies([{ name: 'fixture', value: 'authenticated', url: origin }]);
      await manager.navigate(session.browserSessionId, tab.browserTabId, origin, owner, scope);
      const page = context.pages()[0];
      const exchange = (url) => page.evaluate((target) => new Promise((resolve) => {
        const socket = new WebSocket(target);
        const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 5000);
        socket.onopen = () => socket.send('hello');
        socket.onmessage = (event) => { clearTimeout(timer); socket.close(); resolve(event.data); };
        socket.onclose = () => { clearTimeout(timer); resolve('closed'); };
        socket.onerror = () => { clearTimeout(timer); resolve('error'); };
      }), url);
      assert.equal(await exchange(`${socketOrigin}/ws-agent-sdk`), 'echo:hello');
      assert.equal(connections, 1);
      assert.ok(['closed', 'error'].includes(await exchange(`ws://${hostname}:${foreign.address().port}/`)));
      assert.equal(foreignConnections, 0);
      allowSelfOrigin = false;
      assert.ok(['closed', 'error'].includes(await exchange(`${socketOrigin}/ws-agent-sdk`)));
      assert.equal(connections, 1);
    } finally {
      await manager.closeAll('self-ws-fixture');
      for (const socket of sockets.clients) socket.terminate();
      for (const socket of foreign.clients) socket.terminate();
      await Promise.all([
        new Promise((resolve) => sockets.close(resolve)),
        new Promise((resolve) => foreign.close(resolve)),
        new Promise((resolve) => server.close(resolve)),
      ]);
    }
  });
}
