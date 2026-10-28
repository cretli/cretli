/**
 * External Chrome (CDP) endpoint configured from Settings: source precedence
 * and the runtime-config REST endpoint that swaps the driver without a restart.
 */

import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildBrowserRuntimeEnv,
  normalizeCdpAllowlist,
  readCalmPaceModeSetting,
  resolveBrowserCdpConfig,
} from '../lib/browser/cdp-config.js';
import { registerBrowserRoutes } from '../lib/browser/routes.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';
import { loadSettings } from '../lib/persist/settings.js';

test('the env endpoint wins over Settings and locks the field', () => {
  const config = resolveBrowserCdpConfig(
    { CRETLI_BROWSER_CDP_URL: ' http://127.0.0.1:9222 ' },
    { browserCdpUrl: 'http://10.0.0.5:9222' },
  );
  assert.equal(config.source, 'env');
  assert.equal(config.envLocked, true);
  assert.equal(config.url, 'http://127.0.0.1:9222');
  assert.equal(config.settingsUrl, 'http://10.0.0.5:9222');
});

test('Settings fill the runtime env only when the env does not pin an endpoint', () => {
  const env = { PATH: '/bin' };
  const built = buildBrowserRuntimeEnv(env, { browserCdpUrl: 'http://your-pc:9222', browserCdpAllowlist: 'Your-PC, your-pc other' });
  assert.equal(built.CRETLI_BROWSER_CDP_URL, 'http://your-pc:9222');
  assert.equal(built.CRETLI_BROWSER_CDP_ALLOWLIST, 'your-pc,other');
  assert.equal(built.PATH, '/bin');
  assert.equal(buildBrowserRuntimeEnv(env, {}), env);
  const pinned = { CRETLI_BROWSER_CDP_URL: 'http://127.0.0.1:9222' };
  assert.equal(buildBrowserRuntimeEnv(pinned, { browserCdpUrl: 'http://10.0.0.5:9222' }), pinned);
  assert.equal(resolveBrowserCdpConfig({}, {}).source, 'none');
  assert.equal(normalizeCdpAllowlist(undefined), '');
});

/** A fake Chrome that only answers the `/json/version` probe. */
async function startFakeChrome() {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      const port = server.address().port;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        Browser: 'Chrome/999.0.0.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
      }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function startApi() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-cdp-'));
  const manager = new BrowserSessionManager({
    driver: { async launch() { throw new Error('not used'); } },
    driverStatus: { status: 'available' },
    dataDir,
    resolvePolicy: () => ({ allowedOrigins: [] }),
  });
  const app = express();
  app.use(express.json());
  registerBrowserRoutes(app, {
    browserManager: manager,
    dataDir,
    getCurrentCwd: () => '/ws/a',
    getCurrentWorkspaceFile: () => '/ws/a',
    getOwnerSessionId: () => 'owner',
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (body) => fetch(`${base}/api/browser/runtime-config?mode=agent`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    base,
    manager,
    put,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('runtime-config saves a reachable endpoint, switches to external CDP and back', async (t) => {
  const savedEnv = process.env.CRETLI_BROWSER_CDP_URL;
  delete process.env.CRETLI_BROWSER_CDP_URL;
  const chrome = await startFakeChrome();
  const api = await startApi();
  t.after(async () => {
    await api.close();
    await chrome.close();
    if (savedEnv !== undefined) process.env.CRETLI_BROWSER_CDP_URL = savedEnv;
  });

  const saved = await (await api.put({ cdpUrl: chrome.url })).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.config.source, 'settings');
  assert.equal(saved.config.cdpUrl, chrome.url);
  assert.equal(saved.runtime.mode, 'external-cdp');
  assert.equal(saved.runtime.version, 'Chrome/999.0.0.0');
  assert.equal(loadSettings().browserCdpUrl, chrome.url);

  const cleared = await (await api.put({ cdpUrl: '' })).json();
  assert.equal(cleared.ok, true);
  assert.equal(cleared.config.source, 'none');
  assert.notEqual(cleared.runtime.mode, 'external-cdp');
  assert.equal(loadSettings().browserCdpUrl, undefined);
});

test('runtime-config rejects unreachable, public and busy changes and ignores env-pinned fields', async (t) => {
  const savedEnv = process.env.CRETLI_BROWSER_CDP_URL;
  delete process.env.CRETLI_BROWSER_CDP_URL;
  const api = await startApi();
  t.after(async () => {
    await api.close();
    if (savedEnv !== undefined) process.env.CRETLI_BROWSER_CDP_URL = savedEnv;
    else delete process.env.CRETLI_BROWSER_CDP_URL;
  });

  const unreachable = await api.put({ cdpUrl: 'http://127.0.0.1:1' });
  assert.equal(unreachable.status, 400);
  assert.equal((await unreachable.json()).code, 'cdp-unreachable');

  const publicHost = await api.put({ cdpUrl: 'http://93.184.216.34:9222' });
  assert.equal(publicHost.status, 400);
  assert.equal(loadSettings().browserCdpUrl, undefined);

  api.manager.externalPending = 1;
  const busy = await api.put({ cdpUrl: 'http://127.0.0.1:1' });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).code, 'sessions-active');
  api.manager.externalPending = 0;

  process.env.CRETLI_BROWSER_CDP_URL = 'http://127.0.0.1:9222';
  const locked = await (await api.put({ cdpUrl: 'http://10.0.0.9:9222' })).json();
  assert.equal(locked.ok, true, 'an env pin ignores the endpoint fields');
  assert.equal(loadSettings().browserCdpUrl, undefined);
  const view = await (await fetch(`${api.base}/api/browser/runtime-config`)).json();
  assert.equal(view.config.envLocked, true);
  assert.equal(view.config.cdpUrl, 'http://127.0.0.1:9222');
});

test('native networking is a Settings switch that applies live and works with an env-pinned endpoint', async (t) => {
  const savedEnv = process.env.CRETLI_BROWSER_CDP_URL;
  delete process.env.CRETLI_BROWSER_CDP_URL;
  const api = await startApi();
  t.after(async () => {
    await api.close();
    if (savedEnv !== undefined) process.env.CRETLI_BROWSER_CDP_URL = savedEnv;
    else delete process.env.CRETLI_BROWSER_CDP_URL;
  });

  // An open session does not block a network-mode-only change.
  api.manager.externalPending = 1;
  const on = await (await api.put({ nativeNetwork: true })).json();
  assert.equal(on.ok, true);
  assert.equal(on.config.nativeNetwork, true);
  assert.equal(api.manager.externalNativeNetwork, true);
  assert.equal(loadSettings().browserCdpNativeNetwork, true);
  api.manager.externalPending = 0;

  process.env.CRETLI_BROWSER_CDP_URL = 'http://127.0.0.1:9222';
  const off = await (await api.put({ nativeNetwork: false, cdpUrl: 'http://ignored.example:9222' })).json();
  assert.equal(off.ok, true, 'the env pin ignores endpoint fields instead of refusing');
  assert.equal(off.config.nativeNetwork, false);
  assert.equal(api.manager.externalNativeNetwork, false);
  assert.equal(loadSettings().browserCdpNativeNetwork, undefined);
  assert.equal(loadSettings().browserCdpUrl, undefined);
});

test('native networking continues public requests in Chrome and keeps local and Cretli targets strict', async () => {
  const manager = new BrowserSessionManager({
    driver: { async launch() { throw new Error('not used'); } },
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: [] }),
    selfOrigins: ['https://localhost:3011'],
  });
  const session = { external: true };
  const blocked = [];
  manager.recordBlockedRequest = (_s, _r, decision) => blocked.push(decision.code);
  const run = async (url, decision) => {
    const calls = { continued: false, aborted: false };
    const route = { continue: async () => { calls.continued = true; }, abort: async () => { calls.aborted = true; } };
    const handled = await manager.handleExternalNativeRoute(session, route, { url: () => url }, async () => decision);
    return { handled, ...calls };
  };

  const pub = await run('https://shop.example/offer', { allowed: true, resolvedIps: ['93.184.216.34'] });
  assert.deepEqual(pub, { handled: true, continued: true, aborted: false });

  const lan = await run('http://nas.example/', { allowed: true, resolvedIps: ['10.0.0.5'] });
  assert.deepEqual(lan, { handled: false, continued: false, aborted: false }, 'a local target falls back to the strict path');

  const self = await run('https://localhost:3011/chat', { allowed: true, resolvedIps: ['127.0.0.1'] });
  assert.equal(self.handled, false, 'Cretli itself always uses the strict path');

  const denied = await run('https://blocked.example/', { allowed: false, code: 'origin-not-allowed' });
  assert.deepEqual(denied, { handled: true, continued: false, aborted: true });
  assert.deepEqual(blocked, ['origin-not-allowed']);

  assert.equal(await manager.handleExternalNativeRoute({ external: false }, {}, { url: () => 'https://shop.example/' }, async () => ({})), false,
    'the headless Chromium never uses native networking');
});

 test('Calm pace saves live independently of native networking and survives an env pin', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  api.manager.externalPending = 1;
  const on = await (await api.put({ calmPaceMode: true })).json();
  assert.equal(on.ok, true);
  assert.equal(on.config.calmPaceMode, true);
  assert.equal(api.manager.calmPaceMode, true);
  assert.equal(loadSettings().browserCalmPaceMode, true);
  const unchanged = await (await api.put({})).json();
  assert.equal(unchanged.config.calmPaceMode, true);
  assert.equal(resolveBrowserCdpConfig({ CRETLI_BROWSER_CDP_URL: 'http://localhost:9222' }, loadSettings()).calmPaceMode, true);
  const off = await (await api.put({ calmPaceMode: false })).json();
  assert.equal(off.config.calmPaceMode, false);
  assert.equal(api.manager.calmPaceMode, false);
  assert.equal(loadSettings().browserCalmPaceMode, undefined);
});

test('calm pace reads the pre-rename browserHumanMode key until the next save', () => {
  assert.equal(readCalmPaceModeSetting({ browserHumanMode: true }), true);
  assert.equal(readCalmPaceModeSetting({ browserCalmPaceMode: true }), true);
  assert.equal(readCalmPaceModeSetting({}), false);
  assert.equal(resolveBrowserCdpConfig({}, { browserHumanMode: true }).calmPaceMode, true);
});

test('the external session cap saves live, is clamped, and keeps the default out of config', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  // A busy profile must not block this Settings-only change.
  api.manager.externalPending = 1;
  const raised = await (await api.put({ maxSessions: 5 })).json();
  assert.equal(raised.ok, true);
  assert.equal(raised.config.maxSessions, 5);
  assert.equal(api.manager.externalMaxSessions, 5);
  assert.equal(loadSettings().browserCdpMaxSessions, 5);
  const clamped = await (await api.put({ maxSessions: 99 })).json();
  assert.equal(clamped.config.maxSessions, clamped.config.maxSessionsLimit);
  const unchanged = await (await api.put({})).json();
  assert.equal(unchanged.config.maxSessions, clamped.config.maxSessionsLimit);
  const reset = await (await api.put({ maxSessions: 3 })).json();
  assert.equal(reset.config.maxSessions, 3);
  assert.equal(loadSettings().browserCdpMaxSessions, undefined);
});
