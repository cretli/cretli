/**
 * Browser runtime feature-detection tests (no real Chromium needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_ENV_DENYLIST,
  BROWSER_PROXY_ENV_DENYLIST,
  BROWSER_RUNTIME_STATUS,
  CHROMIUM_BASE_ARGS,
  buildChromiumProcessEnv,
  detectBrowserRuntime,
  isTermuxHost,
  resolveSystemChromiumPath,
  resolveCdpEndpoint,
  detectExternalRuntime,
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

test('Chromium env strips HTTP_PROXY/NO_PROXY so env cannot widen egress', () => {
  for (const key of BROWSER_PROXY_ENV_DENYLIST) {
    assert.ok(!BROWSER_ENV_DENYLIST.includes(key));
  }
  const env = buildChromiumProcessEnv({
    PATH: '/bin',
    HTTP_PROXY: 'http://evil:8080',
    HTTPS_PROXY: 'http://evil:8080',
    ALL_PROXY: 'socks5://evil:1080',
    NO_PROXY: '*',
  });
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.NO_PROXY, undefined);
  assert.deepEqual(env, { PATH: '/bin' });
});

test('Playwright proxy config uses explicit server without bypass widening', async () => {
  const fake = { chromium: { executablePath: () => '/usr/bin/chromium', launch: async () => ({}) } };
  const result = await detectBrowserRuntime({
    platform: 'linux',
    env: {
      CRETLI_BROWSER_NETWORK_BOUNDARY: 'proxy',
      CRETLI_BROWSER_PROXY_SERVER: 'http://127.0.0.1:3129',
    },
    importModule: async () => fake,
    fileExists: () => true,
    getuid: () => 1000,
  });
  let launchOptions = null;
  fake.chromium.launch = async (options) => { launchOptions = options; return {}; };
  await result.driver.launch();
  assert.deepEqual(launchOptions.proxy, { server: 'http://127.0.0.1:3129', bypass: '' });
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

test('external CDP validates DNS and rewrites the websocket to the verified IP', async () => {
  let probedUrl = '';
  let probeOptions;
  const resolved = await resolveCdpEndpoint('http://chrome.test:9222', {
    allowlist: 'chrome.test',
    lookup: async () => [{ address: '192.168.1.20' }],
    fetch: async (url, options) => {
      probedUrl = String(url);
      probeOptions = options;
      return { ok: true, json: async () => ({ Browser: 'Chrome/1', webSocketDebuggerUrl: 'ws://public.example:9999/devtools/browser/id' }) };
    },
  });
  assert.match(probedUrl, /^http:\/\/192\.168\.1\.20:9222\/json\/version$/);
  assert.equal(probeOptions.redirect, 'error');
  assert.ok(probeOptions.signal);
  assert.equal(resolved.endpoint, 'ws://192.168.1.20:9222/devtools/browser/id');
  await assert.rejects(
    () => resolveCdpEndpoint('http://user:pass@127.0.0.1:9222', { fetch: async () => ({}) }),
    /without credentials/,
  );
  await assert.rejects(
    () => resolveCdpEndpoint('http://public.test:9222', { allowlist: 'public.test', lookup: async () => [{ address: '8.8.8.8' }] }),
    /private, link-local, or loopback/,
  );
  await assert.rejects(
    () => resolveCdpEndpoint('http://169.254.169.254:9222', { fetch: async () => ({}) }),
    /private, link-local, or loopback/,
  );
  await assert.rejects(
    () => resolveCdpEndpoint('http://[fd00:ec2::254]:9222', { fetch: async () => ({}) }),
    /private, link-local, or loopback/,
  );
  const privateIpv6 = await resolveCdpEndpoint('http://[fd00::1]:9222', {
    fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://[fd00::2]:1/devtools/browser/id' }) }),
  });
  assert.equal(privateIpv6.endpoint, 'ws://[fd00::1]:9222/devtools/browser/id');
  await assert.rejects(
    () => resolveCdpEndpoint('ws://127.0.0.1:9222', { fetch: async () => ({}) }),
    /must be an http\(s\) URL/,
  );
  let httpsProbe = '';
  await resolveCdpEndpoint('https://127.0.0.1:9443', {
    fetch: async (url) => {
      httpsProbe = String(url);
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'wss://profile.invalid:1/devtools/browser/id' }) };
    },
  });
  assert.match(httpsProbe, /^https:\/\/127\.0\.0\.1:9443\/json\/version$/);
  await assert.rejects(
    () => resolveCdpEndpoint('http://127.0.0.1:9222', {
      timeoutMs: 1,
      fetch: (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    }),
    /aborted/,
  );
  await assert.rejects(
    () => resolveCdpEndpoint('http://127.0.0.1:9222', {
      fetch: async () => ({ ok: true, headers: { 'content-length': String(2 * 1024 * 1024) } }),
    }),
    /response is too large/,
  );
});

test('CDP runtime is available without probing or launching a local Chromium binary', async () => {
  let launched = false;
  const fake = { chromium: { executablePath: () => { throw new Error('must not probe'); }, connectOverCDP: async () => ({}) } };
  const result = await detectExternalRuntime({
    platform: 'linux',
    env: { CRETLI_BROWSER_CDP_URL: 'http://127.0.0.1:9222' },
    importModule: async () => fake,
    fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/id' }) }),
    fileExists: () => { launched = true; return false; },
  });
  assert.equal(result.mode, 'external-cdp');
  assert.equal(result.connected, 'unknown');
  assert.equal(launched, false);
});

test('CDP runtime refuses proxy and required network boundaries', async () => {
  for (const mode of ['proxy', 'required']) {
    let imported = false;
    const result = await detectExternalRuntime({
      env: {
        CRETLI_BROWSER_CDP_URL: 'http://127.0.0.1:9222',
        CRETLI_BROWSER_NETWORK_BOUNDARY: mode,
        CRETLI_BROWSER_PROXY_SERVER: 'http://proxy.internal:3128',
      },
      importModule: async () => { imported = true; return { chromium: {} }; },
    });
    assert.equal(result.available, false);
    assert.equal(result.status, BROWSER_RUNTIME_STATUS.UNAVAILABLE);
    assert.match(result.reason, /cannot enforce/);
    assert.equal(imported, true);
  }
});
