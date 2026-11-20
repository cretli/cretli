import assert from 'node:assert/strict';
import {
  DEFAULT_BIND_HOST,
  assertLanSetupGuard,
  isLanBindHost,
  resolveBindHost,
} from '../lib/bind-host.js';

assert.equal(DEFAULT_BIND_HOST, '127.0.0.1');

const previousBind = process.env.CRETLI_BIND;
const previousLegacy = process.env.CURSOR_REMOTE_BIND;
const previousBindHost = process.env.BIND_HOST;
delete process.env.CRETLI_BIND;
delete process.env.CURSOR_REMOTE_BIND;
delete process.env.BIND_HOST;

try {
  assert.equal(resolveBindHost(), '127.0.0.1');
  assert.equal(isLanBindHost(), false);
  assert.equal(isLanBindHost('127.0.0.1'), false);
  assert.equal(isLanBindHost('localhost'), false);
  assert.equal(isLanBindHost('::1'), false);
  assert.equal(isLanBindHost('0.0.0.0'), true);

  assert.equal(assertLanSetupGuard({
    authConfigured: false,
    setupToken: '',
    lanExposed: false,
  }).ok, true);
  assert.equal(assertLanSetupGuard({
    authConfigured: true,
    setupToken: '',
    lanExposed: true,
  }).ok, true);
  assert.equal(assertLanSetupGuard({
    authConfigured: false,
    setupToken: 'secret-token',
    lanExposed: true,
  }).ok, true);
  const blocked = assertLanSetupGuard({
    authConfigured: false,
    setupToken: '',
    lanExposed: true,
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /CRETLI_SETUP_TOKEN/);
} finally {
  if (typeof previousBind === 'string') process.env.CRETLI_BIND = previousBind;
  else delete process.env.CRETLI_BIND;
  if (typeof previousLegacy === 'string') process.env.CURSOR_REMOTE_BIND = previousLegacy;
  else delete process.env.CURSOR_REMOTE_BIND;
  if (typeof previousBindHost === 'string') process.env.BIND_HOST = previousBindHost;
  else delete process.env.BIND_HOST;
}

console.log('bind-host.test.js OK');

// Multi-bind: comma-separated list, unique entries, whitespace tolerated.
{
  const {
    parseBindHosts,
    probeableLanHosts,
    listenOnHosts,
  } = await import('../lib/bind-host.js');
  const net = await import('node:net');
  const http = await import('node:http');

  assert.deepEqual(parseBindHosts('127.0.0.1'), ['127.0.0.1']);
  assert.deepEqual(parseBindHosts(' 127.0.0.1 , 192.0.2.10,,127.0.0.1'), ['127.0.0.1', '192.0.2.10']);
  assert.deepEqual(parseBindHosts(''), ['127.0.0.1']);
  assert.deepEqual(parseBindHosts('0.0.0.0'), ['0.0.0.0']);
  assert.equal(isLanBindHost('127.0.0.1,localhost'), false);
  assert.equal(isLanBindHost('127.0.0.1,192.0.2.10'), true);
  assert.deepEqual(probeableLanHosts(['127.0.0.1', '192.0.2.10', '0.0.0.0', '::']), ['192.0.2.10']);

  // The LAN guard applies once any listed address is non-local.
  assert.equal(assertLanSetupGuard({
    authConfigured: false,
    setupToken: '',
    lanExposed: isLanBindHost('127.0.0.1,192.0.2.10'),
  }).ok, false);

  // Two loopback addresses stand in for localhost + LAN: both must serve HTTP.
  const server = http.createServer((_req, res) => res.end('ok'));
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const errors = [];
  const handle = listenOnHosts(server, { hosts: ['127.0.0.1', '127.0.0.2'], port, onError: (host, err) => errors.push([host, err]) });
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    if (errors.length === 0) {
      assert.deepEqual([...handle.states.values()], [true, true]);
      for (const host of ['127.0.0.1', '127.0.0.2']) {
        const body = await new Promise((resolve, reject) => {
          http.get({ host, port }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve(data));
          }).on('error', reject);
        });
        assert.equal(body, 'ok');
      }
    } else {
      // Platforms without 127.0.0.2 (macOS): the failed bind is reported, not fatal.
      assert.equal(errors[0][0], '127.0.0.2');
      assert.equal(handle.states.get('127.0.0.2'), false);
    }
  } finally {
    handle.close();
    server.close();
  }
}
console.log('bind-host multi ok');
