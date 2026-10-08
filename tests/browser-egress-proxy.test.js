/**
 * Live egress-proxy tests (127.0.0.1, injected DNS, fake upstreams).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createEgressProxyServer } from '../lib/browser/egress-proxy/server.js';
import { loadEgressProxyConfig } from '../lib/browser/egress-proxy/config.js';
import { createSessionResolver } from '../lib/browser/egress-proxy/allowlist.js';
import { probeBrowserProxy } from '../lib/browser/proxy-health.js';
import { validatePolicyUrl } from '../lib/browser/egress-proxy/target.js';

/**
 * @param {(socket: net.Socket) => void} onClient
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startFakeUpstream(onClient) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => onClient(socket));
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/** Respond after the proxy forwards the request (avoids connect-time races). */
function replyOnRequest(body) {
  return (socket) => {
    socket.on('data', () => {
      socket.end(body);
    });
  };
}

/**
 * @param {{ proxyPort: number, token: string, request: string }} opts
 * @returns {Promise<{ statusLine: string, body: string, headers: Record<string, string> }>}
 */
function proxyRequest(opts) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`x:${opts.token}`).toString('base64');
    const payload = opts.request.includes('Proxy-Authorization')
      ? opts.request
      : opts.request.replace('\r\n', `\r\nProxy-Authorization: Basic ${auth}\r\n`);
    const socket = net.connect({ host: '127.0.0.1', port: opts.proxyPort }, () => {
      socket.write(payload);
    });
    /** @type {Buffer[]} */
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.split('\r\n\r\n');
      const head = split[0] || '';
      const body = split.slice(1).join('\r\n\r\n');
      const lines = head.split('\r\n');
      /** @type {Record<string, string>} */
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ statusLine: lines[0] || '', body, headers });
    };
    socket.on('data', (c) => {
      chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.split('\r\n\r\n');
      if (split.length < 2) return;
      const head = split[0] || '';
      const body = split.slice(1).join('\r\n\r\n');
      const lines = head.split('\r\n');
      /** @type {Record<string, string>} */
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const length = Number.parseInt(headers['content-length'] || '', 10);
      if (Number.isInteger(length) && Buffer.byteLength(body) >= length) finish();
    });
    socket.on('end', finish);
    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('proxyRequest timeout'));
    });
  });
}

/**
 * @param {object} sessions
 * @returns {string}
 */
function writePolicyFile(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-policy-'));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, sessions }), 'utf8');
  return file;
}

const loopbackPin = '127.0.0.1';

/**
 * @param {Record<string, unknown>} [overrides]
 */
function proxyConfig(overrides = {}) {
  return {
    bind: '127.0.0.1',
    port: 0,
    dataDir: '',
    policyFile: '',
    blockedPorts: [],
    selfOrigins: [],
    probePath: '/_egress_ready',
    connectTimeoutMs: 5000,
    idleTimeoutMs: 10_000,
    maxHeaderBytes: 65_536,
    ...overrides,
  };
}

/**
 * @param {{ proxyPort: number, request: string }} opts
 */
function rawProxyRequest(opts) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: opts.proxyPort }, () => {
      socket.write(opts.request);
    });
    /** @type {Buffer[]} */
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.split('\r\n\r\n');
      const head = split[0] || '';
      const body = split.slice(1).join('\r\n\r\n');
      const lines = head.split('\r\n');
      /** @type {Record<string, string>} */
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ statusLine: lines[0] || '', body, headers });
    };
    socket.on('data', (c) => {
      chunks.push(c);
      finish();
    });
    socket.on('end', finish);
    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('rawProxyRequest timeout'));
    });
  });
}

/** Explicit loopback origins (no allowLocalhost wildcard). */
function literalOriginPolicy(allowedOrigins) {
  return {
    allowedOrigins,
    blockedPorts: [],
    unblockedPorts: [],
    allowLocalhost: false,
    allowPrivateNetwork: false,
    allowSelfOrigin: false,
    allowInsecureTls: false,
  };
}

async function liveConnectDeny(opts) {
  let upstreamHits = 0;
  const upstream = await startFakeUpstream(() => { upstreamHits += 1; });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([opts.allowOrigin]) },
  });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup: opts.lookup,
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `CONNECT ${opts.authority} HTTP/1.1\r\nHost: ${opts.authority}\r\nConnection: close\r\n\r\n`,
  });
  await proxy.close();
  await upstream.close();
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], opts.denyCode);
  assert.equal(upstreamHits, 0);
}

test('B8/R2 metadata IPv4 CONNECT denied through live proxy', async () => {
  await liveConnectDeny({
    authority: 'metadata.example:443',
    allowOrigin: 'https://metadata.example:443',
    denyCode: 'blocked-address',
    lookup: async () => [{ address: '169.254.169.254' }],
  });
});

test('B8/R2 metadata IPv6 CONNECT denied through live proxy', async () => {
  await liveConnectDeny({
    authority: 'metadata6.example:443',
    allowOrigin: 'https://metadata6.example:443',
    denyCode: 'blocked-address',
    lookup: async () => [{ address: 'fd00:ec2::254' }],
  });
});

test('B8/R8 NAT64 smuggled metadata denied through live proxy', async () => {
  const nat64 = '64:ff9b::169.254.169.254';
  await liveConnectDeny({
    authority: `[${nat64}]:443`,
    allowOrigin: `https://[${nat64}]:443`,
    denyCode: 'blocked-address',
    lookup: async () => [{ address: nat64 }],
  });
});

test('B8/R8 6to4 and Teredo literals denied through live proxy', async () => {
  for (const host of ['2002:7f00:1::', '2001:0000:4136:e378:8000:63bf:3fff:fdd2']) {
    await liveConnectDeny({
      authority: `[${host}]:443`,
      allowOrigin: `https://[${host}]:443`,
      denyCode: 'blocked-address',
      lookup: async () => [{ address: host }],
    });
  }
});

test('R3 session tokens isolate allowlists', async () => {
  const upstreamA = await startFakeUpstream(replyOnRequest('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  const upstreamB = await startFakeUpstream(replyOnRequest('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  const policyFile = writePolicyFile({
    'token-a': { policy: literalOriginPolicy([`http://127.0.0.1:${upstreamA.port}`]) },
    'token-b': { policy: literalOriginPolicy([`http://127.0.0.1:${upstreamB.port}`]) },
  });
  const lookup = async () => [{ address: loopbackPin }];
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup,
  });
  const { port } = await proxy.listen(0);
  const allowedA = await proxyRequest({
    proxyPort: port,
    token: 'token-a',
    request: `GET http://127.0.0.1:${upstreamA.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(allowedA.statusLine, /200/);
  const allowedB = await proxyRequest({
    proxyPort: port,
    token: 'token-b',
    request: `GET http://127.0.0.1:${upstreamB.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(allowedB.statusLine, /200/);
  const denied = await proxyRequest({
    proxyPort: port,
    token: 'token-a',
    request: `GET http://127.0.0.1:${upstreamB.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(denied.statusLine, /403/);
  await proxy.close();
  await upstreamA.close();
  await upstreamB.close();
});

test('R4 HTTP absolute-form forwarding streams response', async () => {
  const upstream = await startFakeUpstream(replyOnRequest('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello'));
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const lookup = async () => [{ address: loopbackPin }];
  const proxy = createEgressProxyServer({
    config: { bind: '127.0.0.1', port: 0, dataDir: '', policyFile, blockedPorts: [], selfOrigins: [], probePath: '/_egress_ready', connectTimeoutMs: 5000, idleTimeoutMs: 10000 },
    lookup,
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET http://127.0.0.1:${upstream.port}/x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(res.statusLine, /200/);
  assert.equal(res.body.trim(), 'hello');
  await proxy.close();
  await upstream.close();
});

test('R5 CONNECT allow tunnels and deny never opens upstream', async () => {
  let upstreamConnects = 0;
  const upstream = await startFakeUpstream((socket) => {
    upstreamConnects += 1;
    socket.on('data', () => {});
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`https://127.0.0.1:${upstream.port}`]) },
  });
  const lookupOk = async () => [{ address: loopbackPin }];
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup: lookupOk,
  });
  const { port } = await proxy.listen(0);
  await new Promise((resolve, reject) => {
    const auth = Buffer.from('x:tok').toString('base64');
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    client.once('data', (chunk) => {
      try {
        assert.match(chunk.toString('utf8'), /200/);
        assert.equal(upstreamConnects, 1);
        client.end('ping');
        resolve();
      } catch (err) {
        client.destroy();
        reject(err);
      }
    });
    client.on('error', reject);
  });
  const denyPolicyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`https://127.0.0.1:${upstream.port}`]) },
  });
  const proxyDeny = createEgressProxyServer({
    config: proxyConfig({ policyFile: denyPolicyFile }),
    lookup: async () => [{ address: '169.254.169.254' }],
  });
  const { port: denyPort } = await proxyDeny.listen(0);
  let denyUpstream = 0;
  const badUpstream = await startFakeUpstream(() => { denyUpstream += 1; });
  const denied = await proxyRequest({
    proxyPort: denyPort,
    token: 'tok',
    request: `CONNECT 127.0.0.1:${badUpstream.port} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(denied.statusLine, /403/);
  assert.equal(denyUpstream, 0);
  await proxy.close();
  await proxyDeny.close();
  await upstream.close();
  await badUpstream.close();
});

test('R6 WebSocket ws denied target never returns 101', async () => {
  let sawUpgrade = 0;
  const upstream = await startFakeUpstream((socket) => {
    socket.on('data', () => {
      sawUpgrade += 1;
      socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://allowed-only.test:${upstream.port}`]) },
  });
  const lookup = async () => [{ address: '93.184.216.34' }];
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup,
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: [
      `GET http://not-on-allowlist.test:${upstream.port}/sock HTTP/1.1`,
      'Host: not-on-allowlist.test',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'),
  });
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], 'origin-not-allowed');
  assert.doesNotMatch(res.statusLine, /101/);
  assert.equal(sawUpgrade, 0);
  await proxy.close();
  await upstream.close();
});

test('R7 redirect hop deny blocks response', async () => {
  const upstream = await startFakeUpstream(replyOnRequest('HTTP/1.1 302 Found\r\nLocation: http://evil.test/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const lookup = async (host) => {
    if (host === '127.0.0.1') return [{ address: loopbackPin }];
    return [{ address: '169.254.169.254' }];
  };
  const proxy = createEgressProxyServer({
    config: { bind: '127.0.0.1', port: 0, dataDir: '', policyFile, blockedPorts: [], selfOrigins: [], probePath: '/_egress_ready', connectTimeoutMs: 5000, idleTimeoutMs: 10000 },
    lookup,
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(res.statusLine, /403/);
  await proxy.close();
  await upstream.close();
});

test('B8/R2 self-origin behind public name denied through live proxy', async () => {
  const selfOrigin = 'http://app.example.com';
  let upstreamHits = 0;
  const upstream = await startFakeUpstream(() => { upstreamHits += 1; });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy(['http://app.example.com']) },
  });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile, selfOrigins: [selfOrigin] }),
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: 'GET http://app.example.com/ HTTP/1.1\r\nHost: app.example.com\r\nConnection: close\r\n\r\n',
  });
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], 'self-origin');
  assert.equal(upstreamHits, 0);
  await proxy.close();
  await upstream.close();
});

test('B8 self-origin passes only when allowSelfOrigin is true', async () => {
  const upstream = await startFakeUpstream(replyOnRequest('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  const origin = `http://127.0.0.1:${upstream.port}`;
  const policyFile = writePolicyFile({
    tok: {
      policy: {
        allowedOrigins: [origin],
        blockedPorts: [],
        unblockedPorts: [],
        allowLocalhost: false,
        allowPrivateNetwork: false,
        allowSelfOrigin: true,
        allowInsecureTls: false,
      },
    },
  });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile, selfOrigins: [origin] }),
    lookup: async () => [{ address: loopbackPin }],
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET ${origin}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(res.statusLine, /200/);
  await proxy.close();
  await upstream.close();
});

test('R2 loopback private link-local each have explicit deny codes', async () => {
  const base = { blockedPorts: [], unblockedPorts: [], allowLocalhost: false, allowPrivateNetwork: false, allowSelfOrigin: false, allowInsecureTls: false };
  const loopback = await validatePolicyUrl({
    url: 'http://app.test/',
    policy: { ...base, allowedOrigins: ['http://app.test'] },
    lookup: async () => [{ address: '127.0.0.1' }],
  });
  assert.equal(loopback.allowed, false);
  assert.equal(loopback.code, 'dns-rebinding');
  const priv = await validatePolicyUrl({
    url: 'http://corp.test/',
    policy: { ...base, allowedOrigins: ['http://corp.test'] },
    lookup: async () => [{ address: '10.0.0.5' }],
  });
  assert.equal(priv.allowed, false);
  assert.equal(priv.code, 'dns-rebinding');
  const linkLocal = await validatePolicyUrl({
    url: 'http://link.test/',
    policy: { ...base, allowedOrigins: ['http://link.test'] },
    lookup: async () => [{ address: '169.254.1.1' }],
  });
  assert.equal(linkLocal.allowed, false);
  assert.equal(linkLocal.code, 'blocked-address');
});

test('R7 redirect allow forwards when hop validates', async () => {
  const upstream = await startFakeUpstream(replyOnRequest('HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9999/ok\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`, 'http://127.0.0.1:9999']) },
  });
  const lookup = async () => [{ address: loopbackPin }];
  const proxy = createEgressProxyServer({
    config: { bind: '127.0.0.1', port: 0, dataDir: '', policyFile, blockedPorts: [], selfOrigins: [], probePath: '/_egress_ready', connectTimeoutMs: 5000, idleTimeoutMs: 10000 },
    lookup,
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(res.statusLine, /302/);
  assert.equal(res.headers.location, 'http://127.0.0.1:9999/ok');
  await proxy.close();
  await upstream.close();
});

test('R2 blocked-port deny code', async () => {
  const deny = await validatePolicyUrl({
    url: 'http://svc.test:3011/',
    policy: { allowedOrigins: ['http://svc.test:3011'], blockedPorts: [], unblockedPorts: [], allowLocalhost: false, allowPrivateNetwork: false, allowSelfOrigin: false, allowInsecureTls: false },
    blockedPorts: [3011],
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  assert.equal(deny.allowed, false);
  assert.equal(deny.code, 'blocked-port');
});

test('B8 DNS rebinding denied through live proxy with dns-rebinding code', async () => {
  let upstreamHits = 0;
  const upstream = await startFakeUpstream(() => { upstreamHits += 1; });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy(['http://rebind.test']) },
  });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup: async () => [{ address: '10.0.0.8' }],
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: 'GET http://rebind.test/ HTTP/1.1\r\nHost: rebind.test\r\nConnection: close\r\n\r\n',
  });
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], 'dns-rebinding');
  assert.equal(upstreamHits, 0);
  await proxy.close();
  await upstream.close();
});

test('B8 DNS pinning opens one upstream when redirect rebinding is denied', async () => {
  /** @type {string[]} */
  const lookupHosts = [];
  let upstreamConnects = 0;
  const upstream = await startFakeUpstream((socket) => {
    upstreamConnects += 1;
    socket.on('data', () => {
      socket.end('HTTP/1.1 302 Found\r\nLocation: http://metadata.test/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`, 'http://metadata.test']) },
  });
  const lookup = async (host) => {
    lookupHosts.push(String(host));
    if (host === '127.0.0.1') return [{ address: loopbackPin }];
    if (host === 'metadata.test') return [{ address: '169.254.169.254' }];
    return [{ address: '169.254.169.254' }];
  };
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup,
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], 'blocked-address');
  assert.equal(upstreamConnects, 1);
  assert.ok(lookupHosts.includes('metadata.test'));
  await proxy.close();
  await upstream.close();
});

test('B8/R8 IP-literal WS denied through live proxy', async () => {
  let upstreamHits = 0;
  const upstream = await startFakeUpstream(() => { upstreamHits += 1; });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy(['http://other.test:8080', 'http://169.254.169.254:8080']) },
  });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup: async () => [{ address: loopbackPin }],
  });
  const { port } = await proxy.listen(0);
  const loopbackRes = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: 'GET ws://127.0.0.1:8080/s HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  });
  assert.match(loopbackRes.statusLine, /403/);
  assert.equal(loopbackRes.headers['x-egress-deny'], 'origin-not-allowed');
  assert.doesNotMatch(loopbackRes.statusLine, /101/);
  const metadataRes = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: 'GET ws://169.254.169.254:8080/s HTTP/1.1\r\nHost: 169.254.169.254:8080\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  });
  assert.match(metadataRes.statusLine, /403/);
  assert.equal(metadataRes.headers['x-egress-deny'], 'blocked-address');
  assert.doesNotMatch(metadataRes.statusLine, /101/);
  assert.equal(upstreamHits, 0);
  await proxy.close();
  await upstream.close();
});

test('R10 probeBrowserProxy succeeds against running egress proxy', async () => {
  const policyFile = writePolicyFile({});
  const proxy = createEgressProxyServer({
    config: { bind: '127.0.0.1', port: 0, dataDir: '', policyFile, blockedPorts: [], selfOrigins: [], probePath: '/_egress_ready', connectTimeoutMs: 5000, idleTimeoutMs: 10000 },
    lookup: async () => [{ address: loopbackPin }],
  });
  const { port } = await proxy.listen(0);
  const result = await probeBrowserProxy(`http://127.0.0.1:${port}`);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'proxy-ok');
  await proxy.close();
});

test('R1 health probe path without auth', async () => {
  const policyFile = writePolicyFile({});
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup: async () => [],
  });
  const { port } = await proxy.listen(0);
  const res = await rawProxyRequest({
    proxyPort: port,
    request: 'GET /_egress_ready HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
  });
  assert.match(res.statusLine, /200/);
  assert.equal(res.body.trim(), 'ok');
  await proxy.close();
});

test('B1 missing Proxy-Authorization is denied', async () => {
  const policyFile = writePolicyFile({ tok: { policy: literalOriginPolicy(['http://example.test']) } });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const res = await rawProxyRequest({
    proxyPort: port,
    request: 'GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n',
  });
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], 'unknown-session');
  await proxy.close();
});

test('B1 unknown session token is denied', async () => {
  const policyFile = writePolicyFile({ tok: { policy: literalOriginPolicy(['http://example.test']) } });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'not-in-map',
    request: 'GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n',
  });
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], 'unknown-session');
  await proxy.close();
});

test('B1 ws:workspaceKey guess token is denied fail-closed', async () => {
  let upstreamHits = 0;
  const upstream = await startFakeUpstream(() => { upstreamHits += 1; });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-data-'));
  fs.writeFileSync(path.join(dataDir, 'browser-policy.json'), JSON.stringify({
    '/evil-workspace': { allowedOrigins: [`http://127.0.0.1:${upstream.port}`] },
  }), 'utf8');
  const policyFile = writePolicyFile({ legit: { policy: literalOriginPolicy(['http://nowhere.test']) } });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile, dataDir }),
    lookup: async () => [{ address: loopbackPin }],
  });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'ws:/evil-workspace',
    request: `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], 'unknown-session');
  assert.equal(upstreamHits, 0);
  await proxy.close();
  await upstream.close();
});

test('B1 allowlist resolver unit rejects ws: prefix without session map', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-resolver-'));
  const resolver = createSessionResolver({ dataDir, policyFile: '' });
  const header = `Basic ${Buffer.from('x:ws:guess-me').toString('base64')}`;
  assert.equal(resolver.resolveSession(header), null);
});

test('B2 upstream request strips Proxy-Authorization and uses origin-form line', async () => {
  /** @type {Buffer[]} */
  const captured = [];
  const upstream = await startFakeUpstream((socket) => {
    socket.on('data', (chunk) => {
      captured.push(chunk);
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET http://127.0.0.1:${upstream.port}/path?q=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Connection: keep-alive\r\nConnection: close\r\n\r\n`,
  });
  const raw = Buffer.concat(captured).toString('latin1');
  assert.doesNotMatch(raw, /proxy-authorization/i);
  assert.doesNotMatch(raw, /proxy-connection/i);
  assert.match(raw, /^GET \/path\?q=1 HTTP\/1\.1/i);
  assert.match(raw, /\r\nHost: 127\.0\.0\.1\r\n/i);
  await proxy.close();
  await upstream.close();
});

test('B3 POST body larger than one chunk is forwarded intact', async () => {
  const body = Buffer.alloc(300 * 1024, 0x61);
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  let received = Buffer.alloc(0);
  const upstream = await startFakeUpstream((socket) => {
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      const marker = received.indexOf('\r\n\r\n');
      if (marker === -1) return;
      const rest = received.slice(marker + 4);
      if (rest.length >= body.length) {
        const got = rest.slice(0, body.length);
        if (crypto.createHash('sha256').update(got).digest('hex') !== digest) {
          socket.destroy();
          return;
        }
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      }
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const auth = Buffer.from('x:tok').toString('base64');
  const head = [
    `POST http://127.0.0.1:${upstream.port}/upload HTTP/1.1`,
    'Host: 127.0.0.1',
    `Content-Length: ${body.length}`,
    `Proxy-Authorization: Basic ${auth}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  const res = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body]));
    });
    /** @type {Buffer[]} */
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(8000, () => reject(new Error('timeout')));
  });
  assert.match(res, /200 OK/);
  await proxy.close();
  await upstream.close();
});

test('B4 allowlisted ws:// upgrade returns 101 and tunnels frames both ways', async () => {
  let upstreamGotClient = false;
  const upstream = await startFakeUpstream((socket) => {
    let upgraded = false;
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      if (!upgraded && text.includes('GET /sock')) {
        assert.match(text, /Connection:\s*Upgrade/i);
        assert.match(text, /Upgrade:\s*websocket/i);
        upgraded = true;
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        return;
      }
      if (text.includes('client-frame')) upstreamGotClient = true;
      socket.write(Buffer.from('upstream-frame'));
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const auth = Buffer.from('x:tok').toString('base64');
  const client = net.connect({ host: '127.0.0.1', port });
  const result = await new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    client.on('data', (c) => chunks.push(c));
    client.on('error', reject);
    client.on('connect', () => {
      client.write([
        `GET ws://127.0.0.1:${upstream.port}/sock HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Proxy-Authorization: Basic ${auth}`,
        '',
        '',
      ].join('\r\n'));
      setTimeout(() => client.write('client-frame'), 30);
    });
    setTimeout(() => {
      const raw = Buffer.concat(chunks).toString('latin1');
      assert.match(raw, /101 Switching Protocols/);
      assert.match(raw, /upstream-frame/);
      assert.ok(upstreamGotClient);
      client.destroy();
      resolve(true);
    }, 200);
  });
  assert.equal(result, true);
  await proxy.close();
  await upstream.close();
});

test('B4 wss CONNECT on non-443 port is validated as https origin', async () => {
  let upstreamConnects = 0;
  const upstream = await startFakeUpstream((socket) => {
    upstreamConnects += 1;
    socket.on('data', () => {});
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`https://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  await new Promise((resolve, reject) => {
    const auth = Buffer.from('x:tok').toString('base64');
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    client.once('data', (chunk) => {
      assert.match(chunk.toString('utf8'), /200/);
      assert.equal(upstreamConnects, 1);
      client.destroy();
      resolve();
    });
    client.on('error', reject);
  });
  await proxy.close();
  await upstream.close();
});

test('B5 CONNECT host:8443 requires https allowlist not http', async () => {
  let connectAttempts = 0;
  const upstream = await startFakeUpstream(() => { connectAttempts += 1; });
  const tlsPort = upstream.port;
  const httpsPolicy = writePolicyFile({
    tok: { policy: literalOriginPolicy([`https://127.0.0.1:${tlsPort}`]) },
  });
  const proxyOk = createEgressProxyServer({ config: proxyConfig({ policyFile: httpsPolicy }), lookup: async () => [{ address: loopbackPin }] });
  const { port: okPort } = await proxyOk.listen(0);
  await new Promise((resolve, reject) => {
    const auth = Buffer.from('x:tok').toString('base64');
    const client = net.connect({ host: '127.0.0.1', port: okPort }, () => {
      client.write(`CONNECT 127.0.0.1:${tlsPort} HTTP/1.1\r\nHost: 127.0.0.1:${tlsPort}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    client.once('data', (chunk) => {
      assert.match(chunk.toString('utf8'), /200/);
      client.destroy();
      resolve();
    });
    client.on('error', reject);
  });
  await proxyOk.close();
  const httpPolicy = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxyDeny = createEgressProxyServer({ config: proxyConfig({ policyFile: httpPolicy }), lookup: async () => [{ address: loopbackPin }] });
  const { port: denyPort } = await proxyDeny.listen(0);
  const denied = await proxyRequest({
    proxyPort: denyPort,
    token: 'tok',
    request: `CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nConnection: close\r\n\r\n`,
  });
  assert.match(denied.statusLine, /403/);
  assert.equal(connectAttempts, 1);
  await proxyDeny.close();
  await upstream.close();
});

test('B6 CONNECT pipelined bytes after request reach upstream', async () => {
  /** @type {Buffer[]} */
  const upstreamChunks = [];
  const upstream = await startFakeUpstream((socket) => {
    socket.on('data', (chunk) => upstreamChunks.push(chunk));
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`https://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const auth = Buffer.from('x:tok').toString('base64');
  const pipelined = Buffer.from('CLIENT_HELLO');
  await new Promise((resolve, reject) => {
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      client.write(pipelined);
    });
    setTimeout(() => {
      const raw = Buffer.concat(upstreamChunks).toString('utf8');
      assert.match(raw, /CLIENT_HELLO/);
      client.destroy();
      resolve();
    }, 100);
    client.on('error', reject);
  });
  await proxy.close();
  await upstream.close();
});

test('B7 slow redirect validation denies without leaking 302 body', async () => {
  const bodyChunk1 = 'HTTP/1.1 302 Found\r\nLocation: http://evil.test/\r\nContent-Length: 10\r\nConnection: close\r\n\r\npart1';
  const bodyChunk2 = 'part2body';
  let lookupDelayMs = 80;
  const upstream = await startFakeUpstream((socket) => {
    socket.on('data', () => {
      socket.write(bodyChunk1);
      setTimeout(() => socket.write(bodyChunk2), 5);
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const lookup = async (host) => {
    await new Promise((r) => setTimeout(r, lookupDelayMs));
    if (host === '127.0.0.1') return [{ address: loopbackPin }];
    return [{ address: '169.254.169.254' }];
  };
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
  });
  assert.match(res.statusLine, /403/);
  assert.doesNotMatch(res.body, /part1/);
  assert.doesNotMatch(res.body, /part2/);
  const raw = `${res.statusLine}\r\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${res.body}`;
  const headerCount = (raw.match(/HTTP\/1\.1 302/g) || []).length;
  assert.equal(headerCount, 0);
  await proxy.close();
  await upstream.close();
});

test('M1 oversized request headers return 431', async () => {
  const policyFile = writePolicyFile({ tok: { policy: literalOriginPolicy(['http://x.test']) } });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile, maxHeaderBytes: 512 }),
    lookup: async () => [{ address: loopbackPin }],
  });
  const { port } = await proxy.listen(0);
  let headerBlock = 'GET http://x.test/ HTTP/1.1\r\nHost: x.test\r\n';
  while (headerBlock.length < 520) {
    headerBlock += `X-Pad-${headerBlock.length}: ${'a'.repeat(30)}\r\n`;
  }
  const res = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(headerBlock));
    /** @type {Buffer[]} */
    const chunks = [];
    socket.on('data', (c) => {
      chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const lines = raw.split('\r\n');
      /** @type {Record<string, string>} */
      const headers = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i === -1) break;
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ statusLine: lines[0] || '', headers, body: '' });
    });
    socket.on('error', reject);
    socket.setTimeout(2000, () => reject(new Error('M1 timeout')));
  });
  assert.match(res.statusLine, /431/);
  assert.equal(res.headers['x-egress-deny'], 'header-too-large');
  await proxy.close();
});

test('M4 absolute-form https:// on plaintext path is rejected', async () => {
  const policyFile = writePolicyFile({ tok: { policy: literalOriginPolicy(['https://secure.test']) } });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: 'GET https://secure.test/path HTTP/1.1\r\nHost: secure.test\r\nConnection: close\r\n\r\n',
  });
  assert.match(res.statusLine, /400/);
  assert.equal(res.headers['x-egress-deny'], 'https-use-connect');
  await proxy.close();
});

test('M5 loadEgressProxyConfig accepts CRETLI_EGRESS_IDLE_TIMEOUT_MS=120000', () => {
  const cfg = loadEgressProxyConfig({ CRETLI_EGRESS_IDLE_TIMEOUT_MS: '120000' });
  assert.equal(cfg.idleTimeoutMs, 120_000);
});

/**
 * @param {string} raw
 * @returns {number}
 */
function countProxyStatusLines(raw) {
  return (raw.match(/HTTP\/1\.1 \d{3}/g) || []).length;
}

/**
 * @param {Buffer} buf
 * @returns {{ headers: Record<string, string>, bodyStart: number } | null}
 */
function splitHttpHead(buf) {
  const marker = buf.indexOf('\r\n\r\n');
  if (marker === -1) return null;
  const headText = buf.slice(0, marker).toString('latin1');
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of headText.split('\r\n').slice(1)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, bodyStart: marker + 4 };
}

/**
 * @param {Buffer} chunkedBody
 * @returns {Buffer}
 */
function decodeChunkedBody(chunkedBody) {
  let offset = 0;
  /** @type {Buffer[]} */
  const parts = [];
  while (offset < chunkedBody.length) {
    const lineEnd = chunkedBody.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const sizeLine = chunkedBody.slice(offset, lineEnd).toString('latin1').split(';')[0].trim();
    const size = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(size)) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    parts.push(chunkedBody.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(parts);
}

test('F2 chunked Transfer-Encoding body forwarded with consistent upstream headers', async () => {
  const payload = Buffer.from('chunk-payload-bytes');
  const upstream = await startFakeUpstream((socket) => {
    /** @type {Buffer[]} */
    const chunks = [];
    socket.on('data', (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      const split = splitHttpHead(buf);
      if (!split) return;
      assert.match(buf.toString('latin1'), /\r\nHost: 127\.0\.0\.1\r\n/i);
      assert.match(buf.toString('latin1'), /Transfer-Encoding:\s*chunked/i);
      assert.doesNotMatch(buf.toString('latin1'), /Content-Length:/i);
      const bodyPart = buf.slice(split.bodyStart);
      const decoded = decodeChunkedBody(bodyPart);
      if (decoded.length < payload.length) return;
      assert.equal(decoded.slice(0, payload.length).toString('utf8'), payload.toString('utf8'));
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const chunkHex = payload.length.toString(16);
  const chunkedPart = `${chunkHex}\r\n${payload.toString('latin1')}\r\n0\r\n\r\n`;
  const auth = Buffer.from('x:tok').toString('base64');
  const res = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write([
        `PUT http://127.0.0.1:${upstream.port}/upload HTTP/1.1`,
        'Host: 127.0.0.1',
        'Transfer-Encoding: chunked',
        `Proxy-Authorization: Basic ${auth}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
      socket.write(chunkedPart);
    });
    /** @type {Buffer[]} */
    const out = [];
    socket.on('data', (c) => out.push(c));
    socket.on('end', () => resolve(Buffer.concat(out).toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(8000, () => reject(new Error('F2 timeout')));
  });
  assert.match(res, /200 OK/);
  await proxy.close();
  await upstream.close();
});

test('F3 upstream connect refused yields exactly one 502 with deny header', async () => {
  const closedServer = net.createServer();
  await new Promise((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
  const closedPort = /** @type {net.AddressInfo} */ (closedServer.address()).port;
  await new Promise((resolve) => closedServer.close(resolve));
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${closedPort}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const raw = await new Promise((resolve, reject) => {
    const auth = Buffer.from('x:tok').toString('base64');
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET http://127.0.0.1:${closedPort}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`);
    });
    /** @type {Buffer[]} */
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(5000, () => reject(new Error('F3a timeout')));
  });
  assert.equal(countProxyStatusLines(raw), 1);
  assert.match(raw, /502/);
  assert.match(raw, /X-Egress-Deny: upstream-connect-failed/i);
  await proxy.close();
});

test('F3 upstream error after CONNECT 200 does not inject 502 into tunnel', async () => {
  /** @type {net.Socket|null} */
  let upstreamSock = null;
  const upstream = await startFakeUpstream((socket) => {
    upstreamSock = socket;
    socket.on('data', () => {});
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`https://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const raw = await new Promise((resolve, reject) => {
    const auth = Buffer.from('x:tok').toString('base64');
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    /** @type {Buffer[]} */
    const chunks = [];
    client.on('data', (c) => {
      chunks.push(c);
      const text = Buffer.concat(chunks).toString('latin1');
      if (text.includes('200 Connection Established') && upstreamSock) {
        setTimeout(() => upstreamSock?.destroy(), 15);
      }
    });
    client.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    client.on('error', reject);
    setTimeout(() => client.destroy(), 300);
  });
  assert.match(raw, /200 Connection Established/);
  assert.doesNotMatch(raw, /HTTP\/1\.1 502/);
  await proxy.close();
  await upstream.close();
});

test('F3 upstream error after WS 101 does not inject 502 into tunnel', async () => {
  /** @type {net.Socket|null} */
  let upstreamSocket = null;
  const upstream = await startFakeUpstream((socket) => {
    upstreamSocket = socket;
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      if (text.includes('GET /sock')) {
        assert.match(text, /Connection:\s*Upgrade/i);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      }
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const raw = await new Promise((resolve, reject) => {
    const auth = Buffer.from('x:tok').toString('base64');
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write([
        `GET ws://127.0.0.1:${upstream.port}/sock HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Proxy-Authorization: Basic ${auth}`,
        '',
        '',
      ].join('\r\n'));
    });
    /** @type {Buffer[]} */
    const chunks = [];
    client.on('data', (c) => chunks.push(c));
    client.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    client.on('error', reject);
    setTimeout(() => {
      if (upstreamSocket) upstreamSocket.destroy();
    }, 80);
    setTimeout(() => client.destroy(), 250);
  });
  assert.match(raw, /101 Switching Protocols/);
  assert.doesNotMatch(raw, /HTTP\/1\.1 502/);
  await proxy.close();
  await upstream.close();
});

test('F6 DNS answer change pins first validated address only', async () => {
  let lookupCallsForFlip = 0;
  let upstreamConnects = 0;
  let upstreamPort = 0;
  const upstream = await startFakeUpstream((socket) => {
    upstreamConnects += 1;
    socket.on('data', () => {
      socket.end(`HTTP/1.1 302 Found\r\nLocation: http://flip.localhost:${upstreamPort}/again\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
  });
  upstreamPort = upstream.port;
  const origin = `http://flip.localhost:${upstream.port}`;
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([origin]) },
  });
  const lookup = async (host) => {
    if (host === 'flip.localhost') {
      lookupCallsForFlip += 1;
      if (lookupCallsForFlip === 1) return [{ address: loopbackPin }];
      return [{ address: '127.0.0.2' }];
    }
    return [{ address: loopbackPin }];
  };
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET ${origin}/ HTTP/1.1\r\nHost: flip.localhost\r\nConnection: close\r\n\r\n`,
  });
  assert.match(res.statusLine, /403/);
  assert.equal(res.headers['x-egress-deny'], 'dns-rebinding');
  assert.equal(upstreamConnects, 1);
  assert.ok(lookupCallsForFlip >= 2);
  await proxy.close();
  await upstream.close();
});

/**
 * @param {string} raw
 * @returns {number}
 */
function countHttpStatusLines(raw) {
  return (raw.match(/HTTP\/1\.[01] \d{3}/g) || []).length;
}

test('G1 WS client frames after 101 reach upstream exactly once each', async () => {
  /** @type {Buffer[]} */
  const postHandshakeUpstream = [];
  const upstream = await startFakeUpstream((socket) => {
    let upgraded = false;
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      if (!upgraded && text.includes('GET /sock')) {
        upgraded = true;
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        return;
      }
      if (upgraded) postHandshakeUpstream.push(chunk);
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const auth = Buffer.from('x:tok').toString('base64');
  await new Promise((resolve, reject) => {
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write([
        `GET ws://127.0.0.1:${upstream.port}/sock HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Proxy-Authorization: Basic ${auth}`,
        '',
        '',
      ].join('\r\n'));
      setTimeout(() => {
        client.write('EGRESS_MARKER_A');
        setTimeout(() => {
          client.write('EGRESS_MARKER_B');
          setTimeout(() => {
            client.destroy();
            resolve();
          }, 40);
        }, 40);
      }, 40);
    });
    client.on('error', reject);
    client.setTimeout(5000, () => reject(new Error('G1 timeout')));
  });
  const received = Buffer.concat(postHandshakeUpstream).toString('latin1');
  assert.equal((received.match(/EGRESS_MARKER_A/g) || []).length, 1);
  assert.equal((received.match(/EGRESS_MARKER_B/g) || []).length, 1);
  const idxA = received.indexOf('EGRESS_MARKER_A');
  const idxB = received.indexOf('EGRESS_MARKER_B');
  assert.ok(idxA >= 0 && idxB > idxA);
  await proxy.close();
  await upstream.close();
});

test('G2 plaintext idle after response does not append second HTTP status', async () => {
  const upstream = await startFakeUpstream(replyOnRequest('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok'));
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile, idleTimeoutMs: 80 }),
    lookup: async () => [{ address: loopbackPin }],
  });
  const { port } = await proxy.listen(0);
  const auth = Buffer.from('x:tok').toString('base64');
  const { raw, clientDestroyed } = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic ${auth}\r\nConnection: keep-alive\r\n\r\n`);
    });
    /** @type {Buffer[]} */
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => {
      resolve({
        raw: Buffer.concat(chunks).toString('latin1'),
        clientDestroyed: socket.destroyed,
      });
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => reject(new Error('G2 plaintext timeout')));
  });
  assert.match(raw, /200 OK/);
  assert.equal(countHttpStatusLines(raw), 1);
  assert.equal(clientDestroyed, true);
  await proxy.close();
  await upstream.close();
});

test('G2 CONNECT idle after 200 does not inject 502 bytes', async () => {
  const upstream = await startFakeUpstream((socket) => {
    socket.on('data', () => {});
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`https://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile, idleTimeoutMs: 80 }),
    lookup: async () => [{ address: loopbackPin }],
  });
  const { port } = await proxy.listen(0);
  const auth = Buffer.from('x:tok').toString('base64');
  const raw = await new Promise((resolve, reject) => {
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write(`CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    /** @type {Buffer[]} */
    const chunks = [];
    client.on('data', (c) => chunks.push(c));
    client.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    client.on('error', reject);
    client.setTimeout(5000, () => reject(new Error('G2 CONNECT timeout')));
  });
  assert.match(raw, /200 Connection Established/);
  assert.doesNotMatch(raw, /HTTP\/1\.1 502/);
  assert.equal(countHttpStatusLines(raw), 1);
  await proxy.close();
  await upstream.close();
});

test('G3 conflicting Transfer-Encoding and Content-Length denied without upstream', async () => {
  let upstreamHits = 0;
  const upstream = await startFakeUpstream((socket) => {
    upstreamHits += 1;
    socket.on('data', () => {
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({ config: proxyConfig({ policyFile }), lookup: async () => [{ address: loopbackPin }] });
  const { port } = await proxy.listen(0);
  const res = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: [
      `PUT http://127.0.0.1:${upstream.port}/ HTTP/1.1`,
      'Host: 127.0.0.1',
      'Transfer-Encoding: chunked',
      'Content-Length: 5',
      'Connection: close',
      '',
      '0',
      '',
      '',
    ].join('\r\n'),
  });
  assert.match(res.statusLine, /400/);
  assert.equal(res.headers['x-egress-deny'], 'transfer-encoding-conflict');
  assert.equal(upstreamHits, 0);
  const clOnly = await proxyRequest({
    proxyPort: port,
    token: 'tok',
    request: `GET http://127.0.0.1:${upstream.port}/cl HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  });
  assert.match(clOnly.statusLine, /200/);
  await proxy.close();
  await upstream.close();
});

test('G4 client abort during plaintext connect destroys upstream socket', async () => {
  /** @type {net.Socket|null} */
  let upstreamSocket = null;
  const upstream = await startFakeUpstream((socket) => {
    upstreamSocket = socket;
    socket.on('data', () => {});
  });
  const policyFile = writePolicyFile({
    tok: { policy: literalOriginPolicy([`http://127.0.0.1:${upstream.port}`]) },
  });
  const proxy = createEgressProxyServer({
    config: proxyConfig({ policyFile }),
    lookup: async () => [{ address: loopbackPin }],
  });
  const { port } = await proxy.listen(0);
  const auth = Buffer.from('x:tok').toString('base64');
  await new Promise((resolve, reject) => {
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write(`GET http://127.0.0.1:${upstream.port}/slow HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`);
      process.nextTick(() => client.destroy());
    });
    client.on('error', () => {});
    const started = Date.now();
    const poll = () => {
      if (upstreamSocket && upstreamSocket.destroyed) {
        resolve();
        return;
      }
      if (Date.now() - started > 3000) {
        reject(new Error('G4 upstream not destroyed'));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
  await proxy.close();
  await upstream.close();
});
