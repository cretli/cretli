/**
 * Live Browser end-to-end test.
 *
 * Uses the real Playwright/Chromium when the runtime is available and skips
 * (without failing) when it is not — matching the plan's browser-unavailable
 * fallback requirement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { detectBrowserRuntime } from '../lib/browser/runtime-detect.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';

test('live Chromium: navigate, redact console, screenshot, block metadata, cleanup', async (t) => {
  // Root containers need the explicit no-sandbox opt-in; never assumed by the app.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    process.env.CRETLI_BROWSER_ALLOW_NO_SANDBOX = '1';
  }
  const runtime = await detectBrowserRuntime();
  if (!runtime.available) {
    t.skip(`browser-unavailable: ${runtime.reason}`);
    return;
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end([
      '<!doctype html><html><head><title>Live Browser</title></head><body>',
      '<h1 id="x">ok</h1>',
      '<img src="http://169.254.169.254/latest/meta-data/x.png" alt="">',
      '<script>console.log("token=live-secret-value");</script>',
      '</body></html>',
    ].join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const manager = new BrowserSessionManager({
    driver: runtime.driver,
    driverStatus: runtime,
    resolvePolicy: () => ({ allowedOrigins: [origin], blockedPorts: [], unblockedPorts: [] }),
  });

  try {
    const session = await manager.createSession({
      ownerSessionId: 'live-owner',
      workspaceFile: '/tmp/live-ws',
      viewport: { width: 390, height: 844, dpr: 2, hasTouch: true },
    });
    const browser = manager.sessions.get(session.browserSessionId).browser;
    const scope = { workspaceFile: '/tmp/live-ws' };
    const [tab] = manager.listTabs(session.browserSessionId, 'live-owner', scope);
    const state = await manager.navigate(session.browserSessionId, tab.browserTabId, `${origin}/`, 'live-owner', scope);
    assert.equal(state.title, 'Live Browser');

    await new Promise((resolve) => setTimeout(resolve, 500));
    const consolePull = manager.pullConsole(session.browserSessionId, tab.browserTabId, 'live-owner', {}, scope);
    assert.ok(
      consolePull.entries.some((entry) => /token=\[redacted\]/.test(entry.text)),
      JSON.stringify(consolePull.entries),
    );

    const frame = await manager.screenshot(session.browserSessionId, tab.browserTabId, 'live-owner', { force: true, ...scope });
    assert.ok(frame.bytes > 0);
    assert.ok(frame.bytes <= BROWSER_LIMITS.MAX_SCREENSHOT_BYTES);
    assert.equal(frame.mimeType, 'image/jpeg');

    const networkPull = manager.pullNetwork(session.browserSessionId, tab.browserTabId, 'live-owner', {}, scope);
    assert.ok(
      networkPull.entries.some((entry) => entry.blocked === true),
      JSON.stringify(networkPull.entries.map((e) => ({ url: e.url, blocked: e.blocked }))),
    );

    await assert.rejects(
      () => manager.navigate(session.browserSessionId, tab.browserTabId, 'http://169.254.169.254/', 'live-owner', scope),
      (err) => err.code === 'navigation-blocked',
    );

    // A redirect to a blocked address is re-checked per request and blocked.
    await assert.rejects(
      () => manager.navigate(session.browserSessionId, tab.browserTabId, `${origin}/redirect`, 'live-owner', scope),
      (err) => err.code === 'navigation-blocked',
    );

    await manager.closeAll('live-test');
    assert.equal(browser.isConnected(), false);
  } finally {
    await manager.closeAll('live-test-finally');
    await new Promise((resolve) => server.close(resolve));
  }
});
