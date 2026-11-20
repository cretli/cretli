/**
 * Shell-route contract: the SPA parser, the express shell routes, the login
 * `next` gate and the offline service worker must accept the same set of view
 * paths. Each stage 1 requirement that a new route refreshes over HTTP and works
 * offline is proven here, including `/git/worktrees` and the rejection of
 * `/git/<unknown>`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import express from 'express';

import {
  SPA_PANELS,
  SPA_PANEL_SUBVIEWS,
  SPA_PATH_ALIASES,
  SPA_SETTINGS_TABS,
  isSpaLoginNextPath,
  isSpaShellPath,
} from '../lib/spa-routes.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

/**
 * The service worker is a classic script, so it duplicates the contract in a form
 * node:vm can load (same trick as tests/sw-in-app-signal.test.js).
 */
function loadSwRoutes() {
  const context = { self: {}, URL };
  vm.createContext(context);
  vm.runInContext(read(path.join('public', 'sw-routes.js')), context);
  assert.ok(context.self.cretliSwRoutes, 'public/sw-routes.js must expose cretliSwRoutes');
  return context.self.cretliSwRoutes;
}

const swRoutes = loadSwRoutes();

test('the worker route set equals the shared contract', () => {
  const expected = [...SPA_PANELS, ...Object.keys(SPA_PATH_ALIASES)].sort();
  assert.deepEqual([...swRoutes.SPA_VIEW_PANELS].sort(), expected);
  assert.deepEqual([...swRoutes.SPA_VIEW_SETTINGS_TABS].sort(), [...SPA_SETTINGS_TABS].sort());
  // The worker object lives in a node:vm realm, so compare by value, not by
  // prototype identity.
  assert.deepEqual(
    JSON.parse(JSON.stringify(swRoutes.SPA_VIEW_SUBVIEWS)),
    JSON.parse(JSON.stringify(SPA_PANEL_SUBVIEWS)),
  );
});

test('the worker knows /git/worktrees and rejects an unknown git sub-view', () => {
  assert.equal(swRoutes.isSpaViewPath('/git/worktrees'), true);
  assert.equal(swRoutes.isSpaViewPath('/git/worktrees/'), true);
  assert.equal(swRoutes.isSpaViewPath('/git'), true);
  assert.equal(swRoutes.isSpaViewPath('/git/nope'), false);
  assert.equal(swRoutes.isSpaViewPath('/git/main'), false);
  assert.equal(swRoutes.isSpaViewPath('/git/worktrees/deep'), false);
});

test('parser and worker agree on every shell route they are given', () => {
  const cases = [
    ['/', true],
    ['/index.html', true],
    ['/login', false],
    ['/offline.html', false],
    ['/embed/abc', false],
    ['/api/settings', false],
    ['/widget', true],
    ['/widget/', true],
    ['/settings', true],
    ['/settings/workspace', true],
    ['/terminal/extra', false],
    ['/git', true],
    ['/git/worktrees', true],
    ['/git/nope', false],
    ['/nope', false],
    ['//evil.example.com', false],
    ['/chat/abc', false],
  ];
  for (const panel of SPA_PANELS) {
    cases.push([`/${panel}`, true]);
    if (panel !== 'settings') cases.push([`/${panel}/x`, false]);
  }
  for (const tab of SPA_SETTINGS_TABS) {
    cases.push([`/settings/${tab}`, true]);
  }
  cases.push(['/settings/nope', false]);
  cases.push(['/settings/browser', true]);
  for (const [pathname, expected] of cases) {
    assert.equal(isSpaShellPath(pathname), expected, `lib ${pathname}`);
    assert.equal(swRoutes.isSpaViewPath(pathname), expected, `sw ${pathname}`);
  }
});

test('the worker rejects unknown settings tabs like the server shell parser', () => {
  assert.equal(swRoutes.isSpaViewPath('/settings/nope'), false);
  assert.equal(isSpaShellPath('/settings/nope'), false);
  assert.equal(swRoutes.isSpaViewPath('/settings/a/b'), false);
});

test('sw.js loads the shared route script and keeps the offline shell fallback', () => {
  const source = read(path.join('public', 'sw.js'));
  assert.match(source, /importScripts\('\/sw-routes\.js'\)/);
  assert.match(source, /SW_ROUTES\.isSpaViewPath\(pathname\)/);
  assert.match(source, /if \(isSpaViewPath\(url\.pathname\)\) \{\n\s*const index = await caches\.match\('\/index\.html'\);/);
});

test('login next accepts the new route and rejects an unknown sub-view', () => {
  assert.equal(isSpaLoginNextPath('/git/worktrees'), true);
  assert.equal(isSpaLoginNextPath('/settings/workspace'), true);
  assert.equal(isSpaLoginNextPath('/git/nope'), false);
  assert.equal(isSpaLoginNextPath('/settings/nope'), false);
  assert.equal(isSpaLoginNextPath('/api/settings'), false);
  // The widget host pages are shells too, so their authorization flow survives.
  assert.equal(isSpaLoginNextPath('/widget-authorize/abc'), true);
  assert.equal(isSpaLoginNextPath('/embed/abc'), true);
});

/**
 * @param {{ authenticated: boolean }} options
 * @returns {Promise<{ base: string, close: () => Promise<void>, shells: string[] }>}
 */
async function startShellServer(options) {
  const { requireAuth, setPassword, createSession, clearSession } = await import('../lib/auth.js');
  const { registerPublicPages } = await import('../lib/public-pages.js');
  setPassword('test-password-123');
  const sessionToken = options.authenticated ? createSession() : '';
  const shells = [];
  const app = express();
  app.use((req, _res, next) => {
    if (sessionToken) req.headers.cookie = `cr_session=${encodeURIComponent(sessionToken)}`;
    next();
  });
  app.use(requireAuth);
  registerPublicPages(app, {
    indexHtmlPath: '/opt/cretli/public/index.html',
    loginHtmlPath: '/opt/cretli/public/login.html',
    sendVersionedHtml: (res, filePath) => {
      shells.push(filePath);
      res.status(200).type('html').send('<html><body>shell</body></html>');
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    shells,
    close: async () => {
      if (sessionToken) clearSession(sessionToken);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('an authenticated refresh of /git/worktrees gets the SPA shell', async () => {
  const { base, shells, close } = await startShellServer({ authenticated: true });
  try {
    for (const pathname of ['/git/worktrees', '/git/worktrees/', '/git', '/settings/workspace', '/widget']) {
      const res = await fetch(`${base}${pathname}?ws=cretli:ws:abc&folder=def`);
      assert.equal(res.status, 200, pathname);
      assert.match(await res.text(), /shell/, pathname);
    }
    assert.equal(shells.length, 5);
    assert.ok(shells.every((file) => file.endsWith('index.html')));
  } finally {
    await close();
  }
});

test('an unknown git sub-view is a 404, not a shell that cannot render', async () => {
  const { base, shells, close } = await startShellServer({ authenticated: true });
  try {
    for (const pathname of ['/git/nope', '/git/worktrees/deep', '/chat/abc']) {
      const res = await fetch(`${base}${pathname}`);
      assert.equal(res.status, 404, pathname);
    }
    assert.equal(shells.length, 0);
  } finally {
    await close();
  }
});

test('a signed-out deep link keeps the new route through the login redirect', async () => {
  const { base, close } = await startShellServer({ authenticated: false });
  try {
    const res = await fetch(`${base}/git/worktrees?ws=cretli:ws:abc`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location') || '';
    assert.ok(location.startsWith('/login?next='), location);
    const next = new URLSearchParams(location.split('?').slice(1).join('?')).get('next');
    assert.equal(next, '/git/worktrees?ws=cretli:ws:abc');
    assert.equal(isSpaLoginNextPath(new URL(next, 'https://cretli.local').pathname), true);

    const unknown = await fetch(`${base}/git/nope`, { redirect: 'manual' });
    assert.equal(unknown.status, 404);
  } finally {
    await close();
  }
});
