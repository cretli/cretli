import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { defaultFetchVersion, probeDevice, launchChrome, summarizeSystemInfo } from '../lib/devices/probe.js';
import { checkEndpoint } from '../lib/devices/endpoint-guard.js';

const adbDevice = { kind: 'adb-wifi', platform: 'android', host: '192.168.1.20', port: 40123, serial: '', cdpPort: 9222 };
const cdpDevice = { kind: 'chrome-cdp', platform: 'macos', host: '10.0.0.5', port: 9223 };
const run = (res) => async () => res;
const okVersion = async () => ({ Browser: 'Chrome/140', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' });
const info = async () => ({ gpu: { devices: [{ vendorString: 'ACME', deviceString: 'G1' }] } });

test('reachable (with hardware facts)', async () => {
  const r = await probeDevice(adbDevice, { runner: run({ code: 0, stdout: 'mWakefulness=Awake', stderr: '' }), fetchVersion: okVersion, systemInfo: info });
  assert.equal(r.status, 'reachable');
  assert.equal(r.hardware.gpu, 'ACME G1');
});

test('asleep, chrome-down, unreachable, adb-missing, timeout', async () => {
  const awake = { code: 0, stdout: 'mWakefulness=Awake', stderr: '' };
  assert.equal((await probeDevice(adbDevice, { runner: run({ code: 0, stdout: 'mWakefulness=Asleep', stderr: '' }) })).status, 'asleep');
  assert.equal((await probeDevice(adbDevice, { runner: run(awake), fetchVersion: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } })).status, 'chrome-down');
  assert.equal((await probeDevice(adbDevice, { runner: run({ code: 1, stdout: '', stderr: 'device offline' }) })).status, 'unreachable');
  assert.equal((await probeDevice(adbDevice, { runner: run({ code: 1, stdout: '', stderr: '', errorCode: 'ENOENT' }) })).status, 'adb-missing');
  assert.equal((await probeDevice(adbDevice, { runner: run({ code: 1, stdout: '', stderr: '', timedOut: true }) })).status, 'timeout');
  assert.equal((await probeDevice(cdpDevice, { fetchVersion: async () => { throw Object.assign(new Error('t'), { code: 'ETIMEDOUT' }); } })).status, 'timeout');
});

test('never throws, even when the runner does', async () => {
  const r = await probeDevice(adbDevice, { runner: async () => { throw new Error('boom'); } });
  assert.equal(r.status, 'unreachable');
});

test('injection-shaped host/serial is rejected before any process is spawned; argv array is used', async () => {
  let spawned = 0;
  const runner = async () => { spawned += 1; return { code: 0, stdout: '', stderr: '' }; };
  for (const host of ['1.2.3.4; rm -rf /', '$(id)']) {
    assert.equal((await probeDevice({ ...adbDevice, host }, { runner })).status, 'unreachable');
  }
  assert.equal((await probeDevice({ ...adbDevice, serial: '$(id)' }, { runner })).status, 'unreachable');
  assert.equal((await launchChrome({ ...adbDevice, serial: 'a;b' }, { runner })).ok, false);
  assert.equal(spawned, 0);
  let seen;
  await probeDevice(adbDevice, { runner: async (file, args) => { seen = { file, args }; return { code: 0, stdout: 'Asleep mWakefulness=Asleep', stderr: '' }; } });
  assert.ok(Array.isArray(seen.args));
  assert.equal(seen.file, 'adb');
  assert.ok(seen.args.includes('192.168.1.20:40123'));
});

test('endpoint guard: loopback/RFC1918 accepted; link-local, metadata, public, CGNAT refused', async () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.0.4']) assert.ok((await checkEndpoint({ host, port: 9222 })).ok, host);
  for (const host of ['169.254.1.1', '169.254.169.254', '8.8.8.8', '100.64.0.1', '100.100.100.200']) assert.equal((await checkEndpoint({ host, port: 9222 })).ok, false, host);
  assert.equal((await checkEndpoint({ host: '1.2.3.4', port: 0 })).ok, false);
});

test('endpoint guard: hostnames resolving to public or link-local addresses are refused', async () => {
  assert.equal((await checkEndpoint({ host: 'phone.example', lookup: async () => '8.8.8.8' })).ok, false);
  assert.equal((await checkEndpoint({ host: 'phone.example', lookup: async () => '169.254.169.254' })).ok, false);
  assert.equal((await checkEndpoint({ host: 'phone.example', lookup: async () => { throw new Error('nx'); } })).ok, false);
  assert.ok((await checkEndpoint({ host: 'phone.lan', lookup: async () => '192.168.1.9' })).ok);
});

test('adb serial is bound to the validated host:port; mismatched or public serials never reach adb', async () => {
  let spawned = 0;
  const runner = async () => { spawned += 1; return { code: 0, stdout: 'mWakefulness=Asleep', stderr: '' }; };
  const local = { ...adbDevice, host: '127.0.0.1', port: 5555 };
  for (const serial of ['8.8.8.8:5555', '192.168.1.20:40123', 'emulator-5554']) {
    assert.equal((await probeDevice({ ...local, serial }, { runner })).status, 'unreachable', serial);
    assert.equal((await launchChrome({ ...local, serial }, { runner })).ok, false, serial);
  }
  assert.equal(spawned, 0);
  assert.equal((await probeDevice({ ...local, serial: '127.0.0.1:5555' }, { runner })).status, 'asleep');
  assert.equal(spawned, 1);
});

test('hardware facts include CPU and DPR; missing page data yields nulls', async () => {
  const withPage = async () => ({ gpu: { devices: [{ vendorString: 'ACME', deviceString: 'G1' }] }, modelName: 'M', page: { dpr: 2.75, cores: 8 } });
  const r = await probeDevice(adbDevice, { runner: run({ code: 0, stdout: 'mWakefulness=Awake', stderr: '' }), fetchVersion: okVersion, systemInfo: withPage });
  assert.equal(r.hardware.cpuCores, 8);
  assert.equal(r.hardware.dpr, 2.75);
  const h = summarizeSystemInfo({ page: { dpr: 'x', cores: 0 } });
  assert.equal(h.cpuCores, null);
  assert.equal(h.dpr, null);
});

test('failed hardware refresh returns no hardware so previous facts are retained', async () => {
  const r = await probeDevice(adbDevice, { runner: run({ code: 0, stdout: 'mWakefulness=Awake', stderr: '' }), fetchVersion: okVersion, systemInfo: async () => { throw new Error('ws'); } });
  assert.equal(r.status, 'reachable');
  assert.equal(r.hardware, undefined);
});

test('defaultFetchVersion rejects promptly when the peer drops the socket mid-body', async () => {
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('data', () => {
      sock.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"Browser":');
      setTimeout(() => sock.destroy(), 20);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    const started = Date.now();
    await assert.rejects(defaultFetchVersion('127.0.0.1', port, 5000));
    assert.ok(Date.now() - started < 2000, 'must settle well before the overall timeout');
  } finally {
    server.close();
  }
});
