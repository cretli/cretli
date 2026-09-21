/**
 * Browser REST API integration tests (express + fetch, fake driver).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerBrowserRoutes } from '../lib/browser/routes.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

function createFakeDriver() {
  class FakePage {
    constructor() {
      this._url = 'about:blank';
      this._handlers = new Map();
      this._viewport = { width: 390, height: 844 };
      this.mouse = { move: async () => {}, down: async () => {}, up: async () => {}, click: async () => {}, wheel: async () => {} };
      this.keyboard = { type: async () => {}, down: async () => {}, up: async () => {}, press: async () => {} };
      this.touchscreen = { tap: async () => {} };
    }
    on(event, handler) { if (!this._handlers.has(event)) this._handlers.set(event, []); this._handlers.get(event).push(handler); }
    async goto(url) { this._url = url; }
    async goBack() {}
    async goForward() {}
    async reload() {}
    async title() { return 'fake'; }
    url() { return this._url; }
    viewportSize() { return this._viewport; }
    async setViewportSize(v) { this._viewport = v; }
    async screenshot() { return Buffer.from('fake-jpeg'); }
    async close() { for (const handler of this._handlers.get('close') || []) handler(); }
  }
  class FakeContext {
    constructor() { this.pages = []; this.routes = []; this._handlers = new Map(); }
    on(event, handler) { if (!this._handlers.has(event)) this._handlers.set(event, []); this._handlers.get(event).push(handler); }
    async route(_p, handler) { this.routes.push(handler); }
    async newPage() { const page = new FakePage(); this.pages.push(page); for (const h of this._handlers.get('page') || []) h(page); return page; }
    async close() { for (const page of this.pages) await page.close(); }
  }
  class FakeBrowser {
    async newContext() { return new FakeContext(); }
    async close() {}
  }
  return { async launch() { return new FakeBrowser(); } };
}

/** @returns {Promise<{ base: string, close: () => Promise<void>, manager: BrowserSessionManager, dataDir: string }>} */
async function startServer(scope = {}) {
  const workspaceFile = scope.workspaceFile === undefined ? '/ws/a' : scope.workspaceFile;
  const cwd = scope.cwd === undefined ? '/ws/a' : scope.cwd;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-routes-'));
  const manager = new BrowserSessionManager({
    driver: createFakeDriver(),
    driverStatus: { status: 'available' },
    dataDir,
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-widget'] === '1') req.widgetAccess = { installationId: 'w' };
    next();
  });
  registerBrowserRoutes(app, {
    browserManager: manager,
    dataDir,
    getCurrentCwd: (req) => String(req?.headers?.['x-test-workspace'] || cwd),
    getCurrentWorkspaceFile: (req) => String(req?.headers?.['x-test-workspace'] || workspaceFile),
    getOwnerSessionId: (req) => String(req.headers['x-test-owner'] || ''),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    manager,
    dataDir,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('browser API requires Cretli session auth and rejects widget tokens', async () => {
  const ctx = await startServer();
  try {
    const noAuth = await fetch(`${ctx.base}/api/browser/status`);
    assert.equal(noAuth.status, 401);

    const widget = await fetch(`${ctx.base}/api/browser/status`, { headers: { 'x-test-widget': '1', 'x-test-owner': 'owner-a' } });
    assert.equal(widget.status, 403);
    assert.equal((await widget.json()).code, 'widget-auth-forbidden');

    const ok = await fetch(`${ctx.base}/api/browser/status`, { headers: { 'x-test-owner': 'owner-a' } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.namespace, 'browser_*');
    assert.equal(body.wsPath, '/ws-browser');
  } finally {
    await ctx.close();
  }
});

test('session lifecycle, workspace isolation and plan-mode guard', async () => {
  const ctx = await startServer();
  try {
    const owner = { 'x-test-owner': 'owner-a' };
    const create = await fetch(`${ctx.base}/api/browser/sessions`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent' }),
    });
    assert.equal(create.status, 201);
    const session = (await create.json()).session;
    assert.equal(session.tabs.length, 1);

    // Foreign owner cannot read the session.
    const foreign = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}`, {
      headers: { 'x-test-owner': 'owner-b' },
    });
    assert.equal(foreign.status, 403);

    const tabsRes = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}/tabs`, { headers: owner });
    const tabs = (await tabsRes.json()).tabs;
    const tabId = tabs[0].browserTabId;

    // Plan mode blocks navigation.
    const planNav = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}/tabs/${tabId}/navigate`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/', mode: 'plan' }),
    });
    assert.equal(planNav.status, 403);
    assert.equal((await planNav.json()).planModeReadOnly, true);

    // Agent mode allows it (origin is in the injected policy).
    const agentNav = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}/tabs/${tabId}/navigate`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/', mode: 'agent' }),
    });
    assert.equal(agentNav.status, 200);
    assert.equal((await agentNav.json()).state.url, 'https://example.com/');

    // Blocked origin still fails even in agent mode.
    const blockedNav = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}/tabs/${tabId}/navigate`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9999/', mode: 'agent' }),
    });
    assert.equal(blockedNav.status, 403);

    // Screenshot is a read action: allowed in plan mode.
    const shot = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}/tabs/${tabId}/screenshot?mode=plan`, { headers: owner });
    assert.equal(shot.status, 200);
    assert.equal((await shot.json()).frame.mimeType, 'image/jpeg');
  } finally {
    await ctx.close();
  }
});

test('an empty workspace cannot create or list Browser sessions', async () => {
  const ctx = await startServer({ workspaceFile: '', cwd: '' });
  try {
    const owner = { 'x-test-owner': 'owner-a' };
    const listed = await fetch(`${ctx.base}/api/browser/sessions`, { headers: owner });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).sessions, []);

    const create = await fetch(`${ctx.base}/api/browser/sessions`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent' }),
    });
    assert.equal(create.status, 400);
    assert.equal((await create.json()).code, 'no-workspace');
  } finally {
    await ctx.close();
  }
});

test('a session cannot be read, bound or deleted from another workspace', async () => {
  const ctx = await startServer();
  try {
    const owner = { 'x-test-owner': 'owner-a' };
    const create = await fetch(`${ctx.base}/api/browser/sessions`, {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent' }),
    });
    const session = (await create.json()).session;
    const foreign = { ...owner, 'x-test-workspace': '/ws/other', 'content-type': 'application/json' };

    const read = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}`, { headers: foreign });
    assert.equal(read.status, 403);

    const bind = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}/bind`, {
      method: 'POST',
      headers: foreign,
      body: JSON.stringify({ chatId: 'chat-1', mode: 'agent' }),
    });
    assert.equal(bind.status, 403);

    const del = await fetch(`${ctx.base}/api/browser/sessions/${session.browserSessionId}?mode=agent`, {
      method: 'DELETE',
      headers: foreign,
    });
    assert.equal(del.status, 403);
    assert.equal(ctx.manager.sessions.has(session.browserSessionId), true);
  } finally {
    await ctx.close();
  }
});

test('policy endpoint is default-deny, plan-guarded for writes and persists', async () => {
  const ctx = await startServer();
  try {
    const owner = { 'x-test-owner': 'owner-a' };
    const initial = await (await fetch(`${ctx.base}/api/browser/policy`, { headers: owner })).json();
    assert.deepEqual(initial.policy.allowedOrigins, []);

    const planWrite = await fetch(`${ctx.base}/api/browser/policy?mode=plan`, {
      method: 'PUT',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ allowedOrigins: ['https://news.test'] }),
    });
    assert.equal(planWrite.status, 403);

    const write = await fetch(`${ctx.base}/api/browser/policy?mode=agent`, {
      method: 'PUT',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ allowedOrigins: ['https://news.test'], unblockedPorts: [6379] }),
    });
    assert.equal(write.status, 200);
    const updated = await (await fetch(`${ctx.base}/api/browser/policy`, { headers: owner })).json();
    assert.deepEqual(updated.policy.allowedOrigins, ['https://news.test']);
    assert.deepEqual(updated.policy.unblockedPorts, [6379]);
  } finally {
    await ctx.close();
  }
});
