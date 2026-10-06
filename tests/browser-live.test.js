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
      '<my-widget></my-widget>',
      '<input id="name" placeholder="Your name">',
      '<script>',
      'console.log("token=live-secret-value");',
      'class MyWidget extends HTMLElement {',
      '  connectedCallback() {',
      '    const root = this.attachShadow({ mode: "open" });',
      '    root.innerHTML = \'<button id="shadow-save" aria-label="Shadow Save">Save shadow</button>\';',
      '    root.querySelector("#shadow-save").addEventListener("click", () => console.log("shadow-clicked"));',
      '  }',
      '}',
      'customElements.define("my-widget", MyWidget);',
      'document.querySelector("#name").addEventListener("input", () => console.log("name-filled"));',
      '</script>',
      '</body></html>',
    ].join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /** Reads the SOF0/SOF2 dimensions out of a JPEG buffer. */
  function jpegSize(buffer) {
    let i = 2;
    while (i < buffer.length - 9) {
      if (buffer[i] !== 0xFF) { i += 1; continue; }
      const marker = buffer[i + 1];
      const length = buffer.readUInt16BE(i + 2);
      const isSof = marker >= 0xC0 && marker <= 0xCF
        && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      i += 2 + length;
    }
    return null;
  }

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
    // `scale: 'css'`: one image pixel per CSS pixel even at DPR 2, so the frame
    // lines up with the viewport coordinates clicks use.
    assert.deepEqual(jpegSize(Buffer.from(frame.data, 'base64')), { width: 390, height: 844 });

    // Elements inside an open shadow root (a Lit-style custom element) must be
    // listed, and the generated selector must actually drive a click.
    const elements = await manager.getVisibleElements(session.browserSessionId, tab.browserTabId, 'live-owner', scope);
    const shadowSave = elements.elements.find((el) => el.name === 'Shadow Save');
    assert.ok(shadowSave, JSON.stringify(elements.elements));
    assert.equal(shadowSave.role, 'button');
    assert.match(shadowSave.selector, />>/, shadowSave.selector);
    const nameInput = elements.elements.find((el) => el.name === 'Your name');
    assert.ok(nameInput, JSON.stringify(elements.elements));

    await manager.dispatchInput(
      session.browserSessionId,
      tab.browserTabId,
      'live-owner',
      { kind: 'fill', placeholder: 'Your name', value: 'Ala' },
      scope,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    await manager.dispatchInput(
      session.browserSessionId,
      tab.browserTabId,
      'live-owner',
      { kind: 'click', selector: shadowSave.selector },
      scope,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const interactionPull = manager.pullConsole(session.browserSessionId, tab.browserTabId, 'live-owner', {}, scope);
    assert.ok(
      interactionPull.entries.some((entry) => entry.text.includes('name-filled')),
      JSON.stringify(interactionPull.entries),
    );
    assert.ok(
      interactionPull.entries.some((entry) => entry.text.includes('shadow-clicked')),
      JSON.stringify(interactionPull.entries),
    );

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
