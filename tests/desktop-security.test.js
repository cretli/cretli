import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationGuard, resolveNavigationUrl, DEFAULT_SERVER_URL, guardIpcHandler, buildWindowOptions, isAllowedNavigation, isTrustedSender, parseServerUrl } from '../desktop/lib/security.js';

test('server URL defaults to localhost and rejects unsafe inputs', () => {
  assert.equal(parseServerUrl().href, 'http://127.0.0.1:3011/');
  assert.equal(DEFAULT_SERVER_URL, 'http://127.0.0.1:3011');
  assert.throws(() => parseServerUrl('file:///tmp/index.html'));
  assert.throws(() => parseServerUrl('https://user:pass@localhost'));
});

test('navigation is limited to the configured origin', () => {
  assert.equal(isAllowedNavigation('https://localhost/login?next=/', 'https://localhost'), true);
  assert.equal(isAllowedNavigation('https://evil.example/', 'https://localhost'), false);
  assert.equal(isAllowedNavigation('https://localhost:444/', 'https://localhost'), false);
  assert.equal(isAllowedNavigation('not a URL', 'https://localhost'), false);
});

test('only frames at the configured origin are trusted', () => {
  assert.equal(isTrustedSender({ url: 'https://localhost/app' }, 'https://localhost'), true);
  assert.equal(isTrustedSender({ url: 'https://evil.example/' }, 'https://localhost'), false);
  assert.equal(isTrustedSender(null, 'https://localhost'), false);
});

test('window options enforce isolated and sandboxed renderer', () => {
  const { webPreferences } = buildWindowOptions('/tmp/preload.js');
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.preload, '/tmp/preload.js');
});

test('redirect and subframe targets use the same origin check', () => {
  // main.js wires isAllowedNavigation to will-navigate, will-redirect and will-frame-navigate.
  assert.equal(isAllowedNavigation('https://evil.example/login', 'http://127.0.0.1:3011'), false);
  assert.equal(isAllowedNavigation('http://127.0.0.1:3011/x', 'http://127.0.0.1:3011'), true);
  assert.equal(isAllowedNavigation('http://127.0.0.1.evil.example:3011/', 'http://127.0.0.1:3011'), false);
});

test('guardIpcHandler runs only for trusted sender frames', () => {
  const origin = 'http://127.0.0.1:3011';
  const handler = guardIpcHandler((_e, x) => x * 2, origin);
  assert.equal(handler({ senderFrame: { url: 'http://127.0.0.1:3011/app' } }, 4), 8);
  assert.throws(() => handler({ senderFrame: { url: 'https://evil.example/' } }, 4));
  assert.throws(() => handler({}, 4));
  assert.throws(() => handler(undefined, 4));
});

test('preload is CommonJS and main.js points at it', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.existsSync(new URL('../desktop/preload.cjs', import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('../desktop/preload.js', import.meta.url)), false);
  const main = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.match(main, /preload\.cjs/);
  for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate']) assert.match(main, new RegExp(ev));
});

test('navigation guard reads the URL the way Electron delivers it', () => {
  const origin = 'http://127.0.0.1:3011';
  const guard = createNavigationGuard(origin);
  const run = (event, legacy) => {
    let prevented = false;
    guard({ ...event, preventDefault() { prevented = true; } }, legacy);
    return prevented;
  };
  // Modern form: single details object with `url` (will-frame-navigate).
  assert.equal(run({ url: 'http://127.0.0.1:3011/app' }), false);
  assert.equal(run({ url: 'https://evil.example/' }), true);
  // Legacy form: (event, url).
  assert.equal(run({}, 'http://127.0.0.1:3011/x'), false);
  assert.equal(run({}, 'https://evil.example/'), true);
  // Missing or malformed URL is blocked.
  assert.equal(run({}), true);
  assert.equal(run({ url: 'not a url' }), true);
  assert.equal(resolveNavigationUrl({ url: 'a' }, 'b'), 'a');
  assert.equal(resolveNavigationUrl({}, 'b'), 'b');
  assert.equal(resolveNavigationUrl(undefined), undefined);
});
