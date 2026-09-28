/**
 * Browser runtime feature-detection tests (no real Chromium needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_RUNTIME_STATUS,
  CHROMIUM_BASE_ARGS,
  buildChromiumProcessEnv,
  detectBrowserRuntime,
  isTermuxHost,
  resolveSystemChromiumPath,
} from '../lib/browser/runtime-detect.js';

test('Termux/Android hosts are unsupported', async () => {
  assert.equal(isTermuxHost('android', {}), true);
  assert.equal(isTermuxHost('linux', { TERMUX_VERSION: '0.118' }), true);
  assert.equal(isTermuxHost('linux', { PREFIX: '/data/data/com.termux/files/usr' }), true);
  const result = await detectBrowserRuntime({ platform: 'android', env: {}, importModule: async () => ({ chromium: {} }) });
  assert.equal(result.available, false);
  assert.equal(result.status, BROWSER_RUNTIME_STATUS.UNSUPPORTED_PLATFORM);
});

test('missing Playwright runtime yields a controlled unavailable status', async () => {
  const result = await detectBrowserRuntime({
    platform: 'linux',
    env: {},
    importModule: async () => { throw new Error('module not found'); },
  });
  assert.equal(result.available, false);
  assert.equal(result.status, BROWSER_RUNTIME_STATUS.UNAVAILABLE);
  assert.match(result.reason, /Playwright runtime is not installed/);
});

test('missing Chromium binary yields a controlled unavailable status', async () => {
  const fake = { chromium: { executablePath: () => '/nope/chrome' } };
  const result = await detectBrowserRuntime({
    platform: 'linux',
    env: {},
    importModule: async () => fake,
    fileExists: () => false,
  });
  assert.equal(result.available, false);
  assert.equal(result.status, BROWSER_RUNTIME_STATUS.UNAVAILABLE);
  assert.match(result.reason, /Chromium is not installed/);
});

test('available runtime exposes a driver; root without opt-in warns about sandbox', async () => {
  const fake = { chromium: { executablePath: () => '/usr/bin/chromium', launch: async () => ({}) } };
  const root = await detectBrowserRuntime({
    platform: 'linux',
    env: {},
    importModule: async () => fake,
    fileExists: () => true,
    getuid: () => 0,
  });
  assert.equal(root.available, true);
  assert.equal(root.status, BROWSER_RUNTIME_STATUS.AVAILABLE);
  assert.ok(root.driver);
  assert.match(root.sandboxWarning, /sandbox/);

  const optedIn = await detectBrowserRuntime({
    platform: 'linux',
    env: { CRETLI_BROWSER_ALLOW_NO_SANDBOX: '1' },
    importModule: async () => fake,
    fileExists: () => true,
    getuid: () => 0,
  });
  assert.match(optedIn.sandboxWarning, /--no-sandbox/);
  // The driver only injects --no-sandbox when the opt-in is explicit.
  let launchArgs = null;
  fake.chromium.launch = async (options) => { launchArgs = options.args; return {}; };
  await optedIn.driver.launch();
  assert.ok(launchArgs.includes('--no-sandbox'));
});

test('Chromium launch always restricts non-proxied WebRTC UDP', async () => {
  const webrtcArg = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';
  assert.ok(CHROMIUM_BASE_ARGS.includes(webrtcArg));
  const fake = { chromium: { executablePath: () => '/usr/bin/chromium', launch: async () => ({}) } };
  const result = await detectBrowserRuntime({
    platform: 'linux',
    env: {},
    importModule: async () => fake,
    fileExists: () => true,
    getuid: () => 1000,
  });
  let launchOptions = null;
  fake.chromium.launch = async (options) => { launchOptions = options; return {}; };
  // The session manager passes host-resolver rules; the WebRTC flag must be
  // present regardless and must not be duplicated if a caller repeats it.
  await result.driver.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND', webrtcArg] });
  assert.ok(launchOptions.args.includes(webrtcArg));
  assert.ok(launchOptions.args.includes('--host-resolver-rules=MAP * ~NOTFOUND'));
  assert.equal(launchOptions.args.filter((arg) => arg === webrtcArg).length, 1);
});

test('falls back to a system Chromium when the Playwright download is missing', async () => {
  const fake = { chromium: { executablePath: () => '/pw/missing/chrome', launch: async () => ({}) } };
  const result = await detectBrowserRuntime({
    platform: 'linux',
    env: { CRETLI_BROWSER_EXECUTABLE_PATH: '/opt/system/chrome' },
    importModule: async () => fake,
    fileExists: (p) => p === '/opt/system/chrome',
    getuid: () => 1000,
  });
  assert.equal(result.available, true);
  assert.equal(result.usingSystemChromium, true);
  assert.equal(result.executablePath, '/opt/system/chrome');

  let launchOptions = null;
  fake.chromium.launch = async (options) => { launchOptions = options; return {}; };
  await result.driver.launch();
  assert.equal(launchOptions.executablePath, '/opt/system/chrome');
});

test('resolveSystemChromiumPath prefers the explicit env path', () => {
  const env = { CRETLI_BROWSER_EXECUTABLE_PATH: '/custom/chrome' };
  assert.equal(resolveSystemChromiumPath((p) => p === '/custom/chrome', env), '/custom/chrome');
  assert.equal(resolveSystemChromiumPath((p) => p === '/usr/bin/chromium', {}), '/usr/bin/chromium');
  assert.equal(resolveSystemChromiumPath(() => false, {}), null);
});

test('buildChromiumProcessEnv drops only the Codex identity deny-list', () => {
  const env = buildChromiumProcessEnv({
    PATH: '/bin',
    CODEX_SESSION_ID: 'session',
    CODEX_THREAD_ID: 'thread',
  });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('Chromium launch env strips CODEX_SESSION_ID/CODEX_THREAD_ID', async () => {
  const fake = { chromium: { executablePath: () => '/usr/bin/chromium', launch: async () => ({}) } };
  const result = await detectBrowserRuntime({
    platform: 'linux',
    env: {},
    importModule: async () => fake,
    fileExists: () => true,
    getuid: () => 1000,
  });
  process.env.CODEX_SESSION_ID = 'parent-session';
  process.env.CODEX_THREAD_ID = 'parent-thread';
  process.env.CRETLI_BROWSER_ENV_KEEP = 'keep-me';
  try {
    let launchOptions = null;
    fake.chromium.launch = async (options) => { launchOptions = options; return {}; };
    await result.driver.launch();
    assert.equal(launchOptions.env.CODEX_SESSION_ID, undefined);
    assert.equal(launchOptions.env.CODEX_THREAD_ID, undefined);
    assert.equal(launchOptions.env.CRETLI_BROWSER_ENV_KEEP, 'keep-me');
    // The parent process environment is left untouched.
    assert.equal(process.env.CODEX_SESSION_ID, 'parent-session');
  } finally {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CRETLI_BROWSER_ENV_KEEP;
  }
});
