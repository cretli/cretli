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
  isLoopbackHostname,
  isPrivateHostname,
  normalizeHostname,
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
    url: 'https://rebind.test/',
    policy: { allowedOrigins: ['https://rebind.test'] },
    lookup,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'dns-rebinding');
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

test('rejects an address that changed after the session pinned it', async () => {
  const result = await evaluateUrlPolicy({
    url: 'https://example.com/',
    policy: { allowedOrigins: ['https://example.com'] },
    lookup: async () => [{ address: '93.184.216.99' }],
    pinnedAddresses: ['93.184.216.34'],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'dns-rebinding');

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
    setWorkspacePolicy(dir, '/ws/a', {
      allowedOrigins: ['https://example.com', 'not a url'],
      unblockedPorts: [6379],
    });
    const policy = getWorkspacePolicy(dir, '/ws/a');
    assert.deepEqual(policy.allowedOrigins, ['https://example.com']);
    assert.deepEqual(policy.unblockedPorts, [6379]);
    // Other workspaces stay default-deny.
    assert.deepEqual(getWorkspacePolicy(dir, '/ws/b').allowedOrigins, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
