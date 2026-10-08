/**
 * Live Chromium tests that pin the Browser network-boundary LIMITATIONS.
 *
 * The deterministic contract tests live in tests/browser-network-limits.test.js;
 * this file proves the same limits against real Chromium. It skips gracefully
 * when the runtime is unavailable, unless CRETLI_REQUIRE_BROWSER_LIVE=1 turns
 * that skip into a hard failure so a green CI run proves the live path executed.
 *
 * DNS rebinding and manager-level hostname pinning are intentionally not repeated
 * here: tests/browser-url-policy.test.js covers rebinding in evaluateUrlPolicy,
 * and tests/browser-session-manager.test.js covers session manager DNS pins.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { detectBrowserRuntime } from '../lib/browser/runtime-detect.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

const OWNER = 'live-limits-owner';
const WORKSPACE_FILE = '/tmp/live-limits-ws';
const SCOPE = { workspaceFile: WORKSPACE_FILE };
/** Upper bound for waits that prove a bypass happened rather than a hang. */
const LIVE_WAIT_MS = 5000;

/**
 * Resolves the live runtime, mirroring tests/browser-live.test.js: root needs
 * the explicit no-sandbox opt-in, and an absent runtime is a skip unless
 * CRETLI_REQUIRE_BROWSER_LIVE=1.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<object|null>} null when the caller should return early
 */
async function requireLiveRuntime(t) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    process.env.CRETLI_BROWSER_ALLOW_NO_SANDBOX = '1';
  }
  const runtime = await detectBrowserRuntime();
  if (!runtime.available) {
    if (process.env.CRETLI_REQUIRE_BROWSER_LIVE === '1') {
      assert.fail(`browser-unavailable: ${runtime.reason} (CRETLI_REQUIRE_BROWSER_LIVE=1 forbids skipping this test)`);
    }
    t.skip(`browser-unavailable: ${runtime.reason}`);
    return null;
  }
  return runtime;
}

/** @returns {Promise<{ close: () => Promise<void>, origin: string }>} */
async function startPageServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body>ok</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('live Chromium blocks a reverse-proxy self-origin even when the workspace allowlists it', async (t) => {
  const runtime = await requireLiveRuntime(t);
  if (!runtime) return;

  const pageServer = await startPageServer();
  const pageOrigin = pageServer.origin;
  const manager = new BrowserSessionManager({
    driver: runtime.driver,
    driverStatus: runtime,
    selfOrigins: [pageOrigin],
    resolvePolicy: () => ({
      allowedOrigins: [pageOrigin],
      blockedPorts: [],
      unblockedPorts: [],
    }),
  });

  try {
    const session = await manager.createSession({ ownerSessionId: OWNER, workspaceFile: WORKSPACE_FILE });
    const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
    await assert.rejects(
      () => manager.navigate(session.browserSessionId, tab.browserTabId, `${pageOrigin}/`, OWNER, SCOPE),
      (err) => err.code === 'navigation-blocked',
      'self-origin must block navigation even when allowlisted',
    );
  } finally {
    await manager.closeAll('live-limits-self-origin');
    await pageServer.close();
  }
});

test('live Chromium rejects metadata IPv4/IPv6/NAT64/6to4/Teredo navigations', async (t) => {
  const runtime = await requireLiveRuntime(t);
  if (!runtime) return;

  const pageServer = await startPageServer();
  const manager = new BrowserSessionManager({
    driver: runtime.driver,
    driverStatus: runtime,
    resolvePolicy: () => ({ allowedOrigins: [pageServer.origin], blockedPorts: [], unblockedPorts: [] }),
  });

  try {
    const session = await manager.createSession({ ownerSessionId: OWNER, workspaceFile: WORKSPACE_FILE });
    const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
    // The allowlisted origin itself is reachable; every metadata literal is not.
    await manager.navigate(session.browserSessionId, tab.browserTabId, `${pageServer.origin}/`, OWNER, SCOPE);

    for (const url of [
      'http://169.254.169.254/',
      'http://[fd00:ec2::254]/',
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[2002:a9fe:a9fe::1]/',
      'http://[2001::a9fe:a9fe]/',
    ]) {
      await assert.rejects(
        () => manager.navigate(session.browserSessionId, tab.browserTabId, url, OWNER, SCOPE),
        (err) => err.code === 'navigation-blocked',
        url,
      );
    }
  } finally {
    await manager.closeAll('live-limits-b1');
    await pageServer.close();
  }
});

test('live Chromium WebSocket handshake bypasses the route policy (IP-literal residual)', async (t) => {
  const runtime = await requireLiveRuntime(t);
  if (!runtime) return;

  // Residual pinned here: a WebSocket handshake never reaches context.route(),
  // so the route policy cannot judge it. The installed Chromium matches even an
  // IP literal with the default-deny `MAP * ~NOTFOUND` rule, so a plain
  // `ws://127.0.0.1:<port>/` handshake is already stopped by that defense in
  // depth and cannot demonstrate the bypass. The route blindness itself is
  // shown with a hostname the resolver maps (as the product does for every
  // allowlisted hostname) targeting a DIFFERENT, non-allowlisted port: the
  // handshake completes while the equivalent HTTP fetch is route-blocked.
  const mappedHost = 'ws-target.test';

  // A second local server on a DIFFERENT port that is intentionally NOT
  // allowlisted; it speaks WebSocket so a completed handshake is observable.
  const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wsServer, 'listening');
  const wsPort = wsServer.address().port;
  let wsConnections = 0;
  wsServer.on('connection', (socket) => {
    wsConnections += 1;
    socket.send('cretli-ws-open');
  });

  const mappedWsUrl = `ws://${mappedHost}:${wsPort}/`;
  const mappedFetchUrl = `http://${mappedHost}:${wsPort}/`;
  const pageServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><body><script>
      (function () {
        var ws = new WebSocket('${mappedWsUrl}');
        ws.onopen = function () { console.log('ws-open'); };
        ws.onmessage = function (event) { console.log('ws-message:' + event.data); };
        ws.onerror = function () { console.log('ws-error'); };
        fetch('${mappedFetchUrl}').then(function () { console.log('fetch-ok'); }).catch(function () { console.log('fetch-blocked'); });
      })();
    </script></body></html>`);
  });
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${pageServer.address().port}`;

  const manager = new BrowserSessionManager({
    driver: runtime.driver,
    driverStatus: runtime,
    // Only the page origin is reachable. The second entry never serves content:
    // it exists solely so the resolver map pins `mappedHost` -> 127.0.0.1, which
    // is what lets the page-initiated WS handshake leave Chromium at all.
    lookup: async (host) => (String(host) === mappedHost ? [{ address: '127.0.0.1' }] : []),
    resolvePolicy: () => ({
      allowedOrigins: [origin, `http://${mappedHost}:1`],
      blockedPorts: [],
      unblockedPorts: [],
    }),
  });

  try {
    const session = await manager.createSession({ ownerSessionId: OWNER, workspaceFile: WORKSPACE_FILE });
    const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
    await manager.navigate(session.browserSessionId, tab.browserTabId, `${origin}/`, OWNER, SCOPE);

    // The WS handshake bypassed context.route(), so the server completed it.
    const wsDeadline = Date.now() + LIVE_WAIT_MS;
    while (wsConnections < 1 && Date.now() < wsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(wsConnections, 1, `WebSocket handshake to the non-allowlisted port (${mappedWsUrl}) did not complete`);

    // ...and the page observed onopen / a message.
    let consoleEntries = [];
    const consoleDeadline = Date.now() + LIVE_WAIT_MS;
    while (Date.now() < consoleDeadline) {
      consoleEntries = manager.pullConsole(session.browserSessionId, tab.browserTabId, OWNER, {}, SCOPE).entries;
      if (consoleEntries.some((entry) => entry.text.includes('ws-message:cretli-ws-open'))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      consoleEntries.some((entry) => entry.text.includes('ws-open') || entry.text.includes('ws-message:cretli-ws-open')),
      JSON.stringify(consoleEntries.map((entry) => entry.text)),
    );

    // Contrast: the same host:port fetched over HTTP IS seen by the route policy
    // and blocked, while the WS handshake to it never appears as a request.
    let networkEntries = [];
    const networkDeadline = Date.now() + LIVE_WAIT_MS;
    while (Date.now() < networkDeadline) {
      networkEntries = manager.pullNetwork(session.browserSessionId, tab.browserTabId, OWNER, {}, SCOPE).entries;
      if (networkEntries.some((entry) => entry.blocked === true && String(entry.url).startsWith(mappedFetchUrl))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      networkEntries.some((entry) => entry.blocked === true && String(entry.url).startsWith(mappedFetchUrl)),
      JSON.stringify(networkEntries.map((entry) => ({ url: entry.url, blocked: entry.blocked }))),
    );
    assert.equal(
      networkEntries.some((entry) => entry.blocked === true && String(entry.url).startsWith(mappedWsUrl)),
      false,
      'WebSocket handshake must not be recorded as a blocked route request',
    );
  } finally {
    await manager.closeAll('live-limits-b2');
    // Terminate any still-open client before closing, or close() waits on it.
    for (const client of wsServer.clients) client.terminate();
    await new Promise((resolve) => wsServer.close(() => resolve()));
    await pageServer.close();
  }
});
