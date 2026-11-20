/**
 * Deterministic tests that pin the Browser module's documented network-boundary
 * LIMITATIONS (SECURITY.md "Residual risk" and the url-policy.js header).
 *
 * These are contract tests: they assert the residual risk is exactly as
 * documented, so nobody can claim the Browser is a complete network boundary.
 * No Chromium is launched here; the live counterpart is
 * tests/browser-live-limits.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALWAYS_BLOCKED_ADDRESSES,
  BLOCKED_SCHEMES,
  HOST_RESOLVER_DENY_RULE,
  buildHostResolverRules,
  evaluateUrlPolicy,
} from '../lib/browser/url-policy.js';
import { resolveBrowserNetworkBoundary } from '../lib/browser/network-boundary.js';
import { CHROMIUM_BASE_ARGS, detectBrowserRuntime } from '../lib/browser/runtime-detect.js';

/** Non-root uid so `detectBrowserRuntime` never needs the --no-sandbox opt-in. */
const NON_ROOT_UID = 1000;

/**
 * Wraps a fake `playwright-core` chromium in the `detectBrowserRuntime` options
 * bag and records the launch options the driver actually uses.
 * @param {Record<string, string|undefined>} env
 * @returns {{ options: object, getLaunchOptions: () => object|null }}
 */
function fakeRuntimeOptions(env) {
  /** @type {object|null} */
  let launchOptions = null;
  const fakeChromium = {
    executablePath: () => '/usr/bin/chromium',
    launch: async (options) => {
      launchOptions = options;
      return {};
    },
  };
  return {
    options: {
      env,
      platform: 'linux',
      getuid: () => NON_ROOT_UID,
      fileExists: () => true,
      importModule: async () => ({ chromium: fakeChromium }),
    },
    getLaunchOptions: () => launchOptions,
  };
}

test('IP-literal allowlisted origin: resolver map has no pin; route policy allows (residual risk)', async () => {
  const lookup = async () => [{ address: '93.184.216.34' }];

  // The resolver-map builder never emits a per-literal pin: pinnedHosts stays 0
  // and only the catch-all default-deny rule is passed to Chromium. On current
  // Chromium that catch-all also blocks IP-literal connects (defense in depth),
  // but there is still no hostname-style MAP entry for the literal itself.
  const ipLiteral = await buildHostResolverRules({
    policy: { allowedOrigins: ['http://93.184.216.34'] },
    lookup,
  });
  assert.equal(ipLiteral.pinnedHosts, 0);
  assert.deepEqual(ipLiteral.pins, {});
  assert.deepEqual(ipLiteral.rules, [HOST_RESOLVER_DENY_RULE]);

  // Contrast: a hostname allowlisted with the same DNS answer gets an explicit
  // MAP pin; the catch-all stays last so any unmapped hostname fails to resolve.
  const hostname = await buildHostResolverRules({
    policy: { allowedOrigins: ['http://example.com'] },
    lookup,
  });
  assert.ok(hostname.rules.includes('MAP example.com 93.184.216.34'));
  assert.equal(hostname.rules[hostname.rules.length - 1], HOST_RESOLVER_DENY_RULE);

  // Route policy (not the resolver map builder) is what allows an allowlisted
  // public IP literal when evaluateUrlPolicy runs in Node.
  const decision = await evaluateUrlPolicy({
    url: 'http://93.184.216.34/',
    policy: { allowedOrigins: ['http://93.184.216.34'] },
    lookup,
  });
  assert.equal(decision.allowed, true);
});

test('configured upstream proxy is a separate channel Playwright route policy cannot inspect (residual risk)', async () => {
  const boundary = resolveBrowserNetworkBoundary({
    CRETLI_BROWSER_NETWORK_BOUNDARY: 'proxy',
    CRETLI_BROWSER_PROXY_SERVER: 'http://127.0.0.1:3129',
  });
  assert.equal(boundary.proxyServer, 'http://127.0.0.1:3129');
  assert.equal(boundary.configured, true);
  // The contract object carries no route-policy coverage claim: only these keys.
  assert.deepEqual(Object.keys(boundary).sort(), ['configured', 'error', 'mode', 'proxyServer']);

  // Traffic inside CONNECT/HTTPS tunnels to an upstream proxy is invisible to
  // context.route(); exact Playwright launch proxy wiring is covered in
  // tests/browser-runtime-detect.test.js ("Playwright proxy config uses explicit
  // server without bypass widening"). Here we only pin that Cretli does not add
  // bypass / no-proxy flags that would widen egress around the configured proxy.
  const { options, getLaunchOptions } = fakeRuntimeOptions({
    CRETLI_BROWSER_NETWORK_BOUNDARY: 'proxy',
    CRETLI_BROWSER_PROXY_SERVER: 'http://127.0.0.1:3129',
  });
  const runtime = await detectBrowserRuntime(options);
  assert.equal(runtime.available, true);
  await runtime.driver.launch();
  const launchOptions = getLaunchOptions();
  assert.ok(launchOptions.proxy && typeof launchOptions.proxy.server === 'string');
  const args = launchOptions.args;
  assert.equal(args.some((arg) => arg.startsWith('--proxy-bypass-list')), false);
  assert.equal(args.includes('--no-proxy-server'), false);
  assert.equal(CHROMIUM_BASE_ARGS.some((arg) => /proxy/i.test(arg)), false);
});

test('WebSocket handshakes are not visible to Playwright route (default-deny resolver + always-blocked list only)', async () => {
  // context.route() never receives the WebSocket upgrade request, so a
  // page-initiated WebSocket cannot be judged by route policy — only by resolver
  // rules, the always-blocked list, and scheme blocks on panel navigations.
  const { rules } = await buildHostResolverRules({ policy: {} });
  assert.deepEqual(rules, [HOST_RESOLVER_DENY_RULE]);

  assert.ok(ALWAYS_BLOCKED_ADDRESSES.has('169.254.169.254'));
  assert.ok(ALWAYS_BLOCKED_ADDRESSES.has('fd00:ec2::254'));
  assert.ok(ALWAYS_BLOCKED_ADDRESSES.has('168.63.129.16'));

  // ws:/wss: typed into the panel are rejected up front; that is not the same as
  // intercepting a handshake started from page JavaScript.
  assert.ok(BLOCKED_SCHEMES.includes('ws:'));
  assert.ok(BLOCKED_SCHEMES.includes('wss:'));
});

test('WebRTC: disable_non_proxied_udp, no Cretli TURN/STUN, no proxy relay by default (TCP/TURN residual)', async () => {
  assert.ok(CHROMIUM_BASE_ARGS.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  for (const arg of CHROMIUM_BASE_ARGS) {
    assert.doesNotMatch(arg, /turn|stun/i, arg);
  }
  const webrtcFlags = CHROMIUM_BASE_ARGS.filter((arg) => /webrtc/i.test(arg));
  assert.deepEqual(webrtcFlags, ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);
  assert.equal(CHROMIUM_BASE_ARGS.filter((arg) => arg.startsWith('--webrtc-')).length, 0);

  // Cretli configures no TURN/STUN server and passes no proxy in the default
  // deployment; non-proxied UDP ICE is disabled. A hostile page can still supply
  // its own TURN relay over TCP — documented residual (see SECURITY.md).
  const { options, getLaunchOptions } = fakeRuntimeOptions({});
  const runtime = await detectBrowserRuntime(options);
  assert.equal(runtime.available, true);
  await runtime.driver.launch();
  assert.equal(getLaunchOptions().proxy, undefined);
});
