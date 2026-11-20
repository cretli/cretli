/**
 * Browser URL/SSRF policy contract tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHostResolverRules,
  classifyIp,
  evaluateUrlPolicy,
  isLocalHostname,
  isLocalOnlyHostname,
  isLoopbackHostname,
  isPrivateHostname,
  normalizeHostname,
  normalizeNavigationUrl,
  normalizeOrigin,
  parseHttpUrl,
} from '../lib/browser/url-policy.js';
import { getWorkspacePolicy, setWorkspacePolicy } from '../lib/browser/policy-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const publicLookup = async () => [{ address: '93.184.216.34' }];

test('blocks special schemes', async () => {
  for (const url of ['file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'chrome://settings', 'devtools://x']) {
    const result = await evaluateUrlPolicy({ url, policy: {}, lookup: publicLookup });
    assert.equal(result.allowed, false, url);
    assert.equal(result.code, 'blocked-scheme', url);
  }
});

test('default-deny for unknown origins, allow for allowlisted origins', async () => {
  const deny = await evaluateUrlPolicy({ url: 'https://evil.test/', policy: {}, lookup: publicLookup });
  assert.equal(deny.allowed, false);
  assert.equal(deny.code, 'origin-not-allowed');

  const allow = await evaluateUrlPolicy({
    url: 'https://example.com/',
    policy: { allowedOrigins: ['https://example.com'] },
    lookup: publicLookup,
  });
  assert.equal(allow.allowed, true);
  assert.deepEqual(allow.resolvedIps, ['93.184.216.34']);
});

test('blocks localhost/RFC1918 unless explicitly allowlisted', async () => {
  const loopback = await evaluateUrlPolicy({ url: 'http://127.0.0.1:3000/', policy: {}, lookup: publicLookup });
  assert.equal(loopback.allowed, false);

  const privateIp = await evaluateUrlPolicy({ url: 'http://192.168.1.10/', policy: {}, lookup: publicLookup });
  assert.equal(privateIp.allowed, false);

  const optedIn = await evaluateUrlPolicy({
    url: 'http://127.0.0.1:3000/',
    policy: { allowedOrigins: ['http://127.0.0.1:3000'] },
    lookup: publicLookup,
  });
  assert.equal(optedIn.allowed, true);

  const notOpted = await evaluateUrlPolicy({
    url: 'http://127.0.0.1:3000/',
    policy: { allowedOrigins: ['https://example.com'] },
    lookup: publicLookup,
  });
  assert.equal(notOpted.allowed, false);
});

test('always blocks link-local and cloud metadata, even when allowlisted', async () => {
  const metadata = await evaluateUrlPolicy({
    url: 'http://169.254.169.254/latest/meta-data/',
    policy: { allowedOrigins: ['http://169.254.169.254'] },
    lookup: publicLookup,
  });
  assert.equal(metadata.allowed, false);
  assert.equal(metadata.code, 'blocked-address');

  const lookup = async () => [{ address: '169.254.10.10' }];
  const linkLocal = await evaluateUrlPolicy({
    url: 'http://internal.test/',
    policy: { allowedOrigins: ['http://internal.test'] },
    lookup,
  });
  assert.equal(linkLocal.allowed, false);
  assert.equal(linkLocal.code, 'blocked-address');
});

test('blocks DNS rebinding of an allowlisted public hostname', async () => {
  const lookup = async () => [{ address: '127.0.0.1' }];
  const result = await evaluateUrlPolicy({
    url: 'https://rebind.example.com/',
    policy: { allowedOrigins: ['https://rebind.example.com'] },
    lookup,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'dns-rebinding');
});

test('recognises local-only hostnames (single label, reserved or non-delegated TLD)', () => {
  for (const host of ['your-pc', 'my-app.loc', 'my-app.test', 'nas.lan', 'printer.local', 'svc.internal', 'nas.home.arpa', 'my-app.loc.']) {
    assert.equal(isLocalOnlyHostname(host), true, host);
  }
  for (const host of ['example.com', 'my-app.dev', 'evil.arpa', 'in-addr.arpa', '127.0.0.1', '::1', '']) {
    assert.equal(isLocalOnlyHostname(host), false, host);
  }
});

test('an allowlisted local-only dev hostname may resolve to loopback or LAN', async () => {
  const loopback = await evaluateUrlPolicy({
    url: 'http://my-app.loc/login',
    policy: { allowedOrigins: ['http://my-app.loc'] },
    lookup: async () => [{ address: '127.0.0.1' }],
  });
  assert.equal(loopback.allowed, true);
  assert.deepEqual(loopback.resolvedIps, ['127.0.0.1']);

  const lan = await evaluateUrlPolicy({
    url: 'http://nas.lan:8080/',
    policy: { allowedOrigins: ['http://nas.lan:8080'] },
    lookup: async () => [{ address: '10.0.0.5' }],
  });
  assert.equal(lan.allowed, true);

  // Not allowlisted: still denied before DNS.
  const notListed = await evaluateUrlPolicy({
    url: 'http://other.loc/',
    policy: { allowedOrigins: ['http://my-app.loc'], allowLocalhost: true },
    lookup: async () => [{ address: '127.0.0.1' }],
  });
  assert.equal(notListed.code, 'origin-not-allowed');

  // Metadata stays blocked and pins still apply.
  const metadata = await evaluateUrlPolicy({
    url: 'http://my-app.loc/',
    policy: { allowedOrigins: ['http://my-app.loc'] },
    lookup: async () => [{ address: '169.254.169.254' }],
  });
  assert.equal(metadata.code, 'blocked-address');
  const moved = await evaluateUrlPolicy({
    url: 'http://my-app.loc/',
    policy: { allowedOrigins: ['http://my-app.loc'] },
    lookup: async () => [{ address: '10.0.0.9' }],
    pinnedAddresses: ['127.0.0.1'],
  });
  assert.equal(moved.code, 'dns-rebinding');
});

test('blocks internal service ports unless explicitly unblocked', async () => {
  const blocked = await evaluateUrlPolicy({
    url: 'http://localhost:6379/',
    policy: { allowedOrigins: ['http://localhost:6379'] },
    blockedPorts: [6379],
    lookup: publicLookup,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'blocked-port');

  const unblocked = await evaluateUrlPolicy({
    url: 'http://localhost:6379/',
    policy: { allowedOrigins: ['http://localhost:6379'], unblockedPorts: [6379] },
    blockedPorts: [6379],
    lookup: publicLookup,
  });
  assert.equal(unblocked.allowed, true);
});

test('classifies IP ranges', () => {
  assert.equal(classifyIp('127.0.0.1').scope, 'loopback');
  assert.equal(classifyIp('10.1.2.3').scope, 'private');
  assert.equal(classifyIp('172.16.0.1').scope, 'private');
  assert.equal(classifyIp('192.168.0.1').scope, 'private');
  assert.equal(classifyIp('169.254.169.254').alwaysBlocked, true);
  assert.equal(classifyIp('8.8.8.8').scope, 'public');
  assert.equal(classifyIp('::1').scope, 'loopback');
  assert.equal(classifyIp('fe80::1').alwaysBlocked, true);
});

test('classifies IPv4-mapped IPv6 and known metadata endpoints as blocked', () => {
  assert.equal(classifyIp('::ffff:7f00:1').scope, 'loopback');
  assert.equal(classifyIp('::ffff:127.0.0.1').scope, 'loopback');
  assert.equal(classifyIp('::ffff:a9fe:a9fe').alwaysBlocked, true);
  assert.equal(classifyIp('::ffff:169.254.169.254').alwaysBlocked, true);
  assert.equal(classifyIp('::ffff:0a00:0001').scope, 'private');
  assert.equal(classifyIp('fd00:ec2::254').alwaysBlocked, true);
  assert.equal(classifyIp('168.63.129.16').alwaysBlocked, true);
  assert.equal(classifyIp('100.100.100.200').alwaysBlocked, true);
  assert.equal(normalizeHostname('[::ffff:A9FE:A9FE]'), '::ffff:a9fe:a9fe');
});

test('blocks mapped IPv6 metadata even when the origin is allowlisted', async () => {
  const result = await evaluateUrlPolicy({
    url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
    policy: { allowedOrigins: ['http://[::ffff:a9fe:a9fe]'] },
    lookup: publicLookup,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'blocked-address');
});

test('a pinned public host may rotate public addresses but never move to a local one', async () => {
  // CDN / round-robin DNS: another public answer is not rebinding.
  const rotated = await evaluateUrlPolicy({
    url: 'https://example.com/',
    policy: { allowedOrigins: ['https://example.com'] },
    lookup: async () => [{ address: '93.184.216.99' }],
    pinnedAddresses: ['93.184.216.34'],
  });
  assert.equal(rotated.allowed, true);

  const toPrivate = await evaluateUrlPolicy({
    url: 'https://example.com/',
    policy: { allowedOrigins: ['https://example.com'], allowPrivateNetwork: true },
    lookup: async () => [{ address: '10.0.0.5' }],
    pinnedAddresses: ['93.184.216.34'],
  });
  assert.equal(toPrivate.allowed, false);
  assert.equal(toPrivate.code, 'dns-rebinding');

  // A host pinned to a private address (explicit LAN allowlist) stays pinned.
  const lanMoved = await evaluateUrlPolicy({
    url: 'http://10.0.0.5:8080/',
    policy: { allowedOrigins: ['http://nas.lan:8080'], allowPrivateNetwork: true },
    lookup: async () => [{ address: '10.0.0.5' }],
    pinnedAddresses: ['10.0.0.7'],
  });
  assert.equal(lanMoved.allowed, false);
  assert.equal(lanMoved.code, 'dns-rebinding');

  const same = await evaluateUrlPolicy({
    url: 'https://example.com/',
    policy: { allowedOrigins: ['https://example.com'] },
    lookup: async () => [{ address: '93.184.216.34' }],
    pinnedAddresses: ['93.184.216.34'],
  });
  assert.equal(same.allowed, true);
});

test('buildHostResolverRules maps allowlisted hostnames and default-denies DNS', async () => {
  const { rules, pinnedHosts, pins, defaultDeny } = await buildHostResolverRules({
    policy: {
      allowedOrigins: ['https://example.com', 'http://127.0.0.1:3000'],
    },
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(pinnedHosts, 1);
  assert.equal(defaultDeny, true);
  assert.deepEqual(rules, ['MAP example.com 93.184.216.34', 'MAP * ~NOTFOUND']);
  assert.deepEqual(pins['example.com'], ['93.184.216.34']);
});

test('buildHostResolverRules keeps localhost resolvable for an allowLocalhost policy', async () => {
  const { rules } = await buildHostResolverRules({
    policy: { allowLocalhost: true },
    lookup: async () => [],
  });
  assert.ok(rules.includes('MAP localhost 127.0.0.1'));
  assert.equal(rules[rules.length - 1], 'MAP * ~NOTFOUND');
});

test('self-origin debug opt-in permits local addresses and only exempts validated self hosts', async () => {
  const blockedOrigins = ['http://127.0.0.1:3011', 'http://localhost:3011', 'http://169.254.169.254'];
  const lookup = async () => [{ address: '127.0.0.1' }];
  const disabled = await buildHostResolverRules({ policy: {}, blockedOrigins, lookup });
  assert.deepEqual(disabled.rules, ['MAP * ~NOTFOUND']);
  const enabled = await buildHostResolverRules({ policy: { allowSelfOrigin: true }, blockedOrigins, lookup });
  assert.ok(enabled.rules.includes('EXCLUDE 127.0.0.1'));
  assert.ok(enabled.rules.includes('MAP localhost 127.0.0.1'));
  assert.ok(!enabled.rules.some((rule) => rule.includes('169.254.169.254')));
  assert.equal(enabled.rules.at(-1), 'MAP * ~NOTFOUND');
  const allowed = await evaluateUrlPolicy({
    url: blockedOrigins[0], policy: { allowSelfOrigin: true }, blockedOrigins, lookup,
  });
  assert.equal(allowed.allowed, true);
  const otherPort = await evaluateUrlPolicy({
    url: 'http://127.0.0.1:3012', policy: { allowSelfOrigin: true }, blockedOrigins, lookup,
  });
  assert.equal(otherPort.allowed, false);
});

test('rejects URLs with userinfo instead of silently stripping credentials', async () => {
  const result = await evaluateUrlPolicy({
    url: 'https://user:secret@example.com/private',
    policy: { allowedOrigins: ['https://example.com'] },
    lookup: publicLookup,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'userinfo-not-allowed');
});

test('decodes NAT64 and 6to4 metadata addresses instead of trusting the prefix', async () => {
  for (const address of ['64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '2001::a9fe:a9fe', '64:ff9b:1::1']) {
    assert.equal(classifyIp(address).alwaysBlocked, true, address);
  }
  // A NAT64/6to4 embedding of a public IPv4 stays public.
  assert.equal(classifyIp('64:ff9b::5db8:d822').scope, 'public');
  const result = await evaluateUrlPolicy({
    url: 'http://[64:ff9b::a9fe:a9fe]/latest/meta-data/',
    policy: { allowedOrigins: ['http://[64:ff9b::a9fe:a9fe]'] },
    lookup: publicLookup,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'blocked-address');
});

test('separates allowLocalhost from allowPrivateNetwork', async () => {
  // allowLocalhost only opens loopback...
  const loopback = await evaluateUrlPolicy({
    url: 'http://127.0.0.1:3000/',
    policy: { allowLocalhost: true },
    lookup: publicLookup,
  });
  assert.equal(loopback.allowed, true);
  const rfc1918 = await evaluateUrlPolicy({
    url: 'http://192.168.1.10/',
    policy: { allowLocalhost: true },
    lookup: publicLookup,
  });
  assert.equal(rfc1918.allowed, false);
  // ...while allowPrivateNetwork only opens RFC1918/ULA.
  const priv = await evaluateUrlPolicy({
    url: 'http://192.168.1.10/',
    policy: { allowPrivateNetwork: true },
    lookup: publicLookup,
  });
  assert.equal(priv.allowed, true);
  const notLoopback = await evaluateUrlPolicy({
    url: 'http://127.0.0.1:3000/',
    policy: { allowPrivateNetwork: true },
    lookup: publicLookup,
  });
  assert.equal(notLoopback.allowed, false);
});

test('always blocks Cretli self-origins, even when allowlisted', async () => {
  const result = await evaluateUrlPolicy({
    url: 'https://cretli.example.com/browser',
    policy: { allowedOrigins: ['https://cretli.example.com'] },
    blockedOrigins: ['https://cretli.example.com'],
    lookup: publicLookup,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'self-origin');

  const cleared = await evaluateUrlPolicy({
    url: 'https://other.test/',
    policy: { allowedOrigins: ['https://other.test'] },
    blockedOrigins: ['https://cretli.example.com'],
    lookup: publicLookup,
  });
  assert.equal(cleared.allowed, true);
});

test('origin helpers normalize and detect local hosts', () => {
  assert.equal(normalizeOrigin('example.com'), 'https://example.com');
  assert.equal(normalizeOrigin('HTTPS://Example.com/Path'), 'https://example.com');
  assert.equal(normalizeOrigin('file:///tmp'), '');
  assert.equal(normalizeOrigin('https://user:pass@example.com'), '');
  assert.equal(parseHttpUrl('ftp://x').origin, 'ftp://x');
  assert.equal(isLocalHostname('localhost'), true);
  assert.equal(isLocalHostname('foo.localhost'), true);
  assert.equal(isLocalHostname('localhost.'), true);
  assert.equal(isLocalHostname('example.com'), false);
  assert.equal(isLocalHostname('10.0.0.1'), true);
  assert.equal(isLoopbackHostname('10.0.0.1'), false);
  assert.equal(isPrivateHostname('10.0.0.1'), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isPrivateHostname('127.0.0.1'), false);
});

test('policy store persists per-workspace policy', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-policy-'));
  try {
    assert.deepEqual(getWorkspacePolicy(dir, '/ws/a').allowedOrigins, []);
    assert.equal(getWorkspacePolicy(dir, '/ws/a').allowExternalBrowser, false);
    setWorkspacePolicy(dir, '/ws/a', {
      allowedOrigins: ['https://example.com', 'not a url'],
      unblockedPorts: [6379],
      allowExternalBrowser: true,
    });
    const policy = getWorkspacePolicy(dir, '/ws/a');
    assert.deepEqual(policy.allowedOrigins, ['https://example.com']);
    assert.deepEqual(policy.unblockedPorts, [6379]);
    assert.equal(policy.allowExternalBrowser, true);
    // Other workspaces stay default-deny.
    assert.deepEqual(getWorkspacePolicy(dir, '/ws/b').allowedOrigins, []);
    assert.equal(getWorkspacePolicy(dir, '/ws/b').allowExternalBrowser, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeNavigationUrl gives a bare host the scheme the allowlist already assumes', () => {
  assert.equal(normalizeNavigationUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeNavigationUrl('  example.com  '), 'https://example.com/');
  assert.equal(normalizeNavigationUrl('example.com/a?b=1#f'), 'https://example.com/a?b=1#f');
  // A host:port pair is a bare target, not a scheme — the common thing to type.
  assert.equal(normalizeNavigationUrl('127.0.0.1:3011/path'), 'https://127.0.0.1:3011/path');
  assert.equal(normalizeNavigationUrl(''), '');
  assert.equal(normalizeNavigationUrl(null), '');
  assert.equal(normalizeNavigationUrl(undefined), '');
});

test('normalizeNavigationUrl keeps an absolute target and only rewrites the missing scheme', () => {
  for (const url of [
    'https://example.com/a?b=1',
    'http://example.com/',
    'https://example.com:8443/x',
    'file:///etc/passwd',
    'chrome://settings',
  ]) {
    assert.equal(normalizeNavigationUrl(url), parseHttpUrl(url)?.href ?? url, url);
  }
});

test('the normalized navigation target and the allowlist agree on one origin', () => {
  // The invariant behind the fix: policy and `page.goto` must judge and fetch
  // the same string, so whatever origin the allowlist matches is the origin
  // Chromium is handed.
  for (const raw of ['example.com', 'https://example.com/a', 'EXAMPLE.com', '//example.com/']) {
    const normalized = normalizeNavigationUrl(raw);
    assert.equal(parseHttpUrl(normalized).origin, normalizeOrigin(raw), raw);
  }
});

test('normalizeNavigationUrl never turns a blocked scheme into a reachable URL', async () => {
  for (const raw of [
    'file:///etc/passwd',
    'data:text/html,hi',
    'javascript:alert(1)',
    'chrome://settings',
    'view-source:https://example.com',
    'ftp://example.com',
  ]) {
    const normalized = normalizeNavigationUrl(raw);
    const decision = await evaluateUrlPolicy({
      url: normalized,
      policy: { allowedOrigins: ['https://example.com'] },
      lookup: publicLookup,
    });
    assert.equal(decision.allowed, false, `${raw} -> ${normalized} must stay denied`);
  }
  // The bare-host case the panel actually sends.
  const allowed = await evaluateUrlPolicy({
    url: normalizeNavigationUrl('example.com'),
    policy: { allowedOrigins: ['https://example.com'] },
    lookup: publicLookup,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.href, 'https://example.com/');
});
