import './helpers/isolated-data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createCdpProxy, ALLOWED_METHODS } from '../lib/devices/cdp-proxy.js';
import { probeDevice } from '../lib/devices/probe.js';
import { fakeDeviceCdp } from './helpers/fake-device-cdp.js';

test('private context, method allowlist, id mapping, upstream filters and single-use token', async () => {
  const fake = await fakeDeviceCdp();
  let proxy, ws;
  try {
    await probeDevice(fake.device, { passive: true });
    assert.equal(fake.requests.length, 0, 'passive probe never attaches');
    proxy = await createCdpProxy(fake.device);
    assert.deepEqual(fake.requests.slice(0, 3).map((r) => r.method), ['Target.createBrowserContext', 'Target.createTarget', 'Target.attachToTarget']);
    assert.equal(fake.requests[1].params.browserContextId, 'private-context');
    assert.equal(fake.requests.find((r) => r.method === 'Runtime.evaluate').sessionId, 'own-session');
    assert.equal(proxy.hardware.cpuCores, 8); assert.equal(proxy.hardware.dpr, 2);
    assert.equal(JSON.stringify(proxy.hardware).includes('commandLine'), false);
    const base = proxy.url.replace(/^ws:/, 'http:');
    const version = await (await fetch(new URL('/json/version', base))).json();
    assert.equal(version.webSocketDebuggerUrl, proxy.url);
    assert.equal((await fetch(new URL('/json', base))).status, 403);
    const origin = new WebSocket(proxy.url, { origin: 'http://example.com' });
    await new Promise((resolve) => origin.once('error', resolve));
    ws = new WebSocket(proxy.url);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const events = [];
    ws.on('message', (b) => { const m = JSON.parse(String(b)); if (!m.id) events.push(m); });
    const request = (msg) => new Promise((resolve) => { const listener = (b) => { const m = JSON.parse(String(b)); if (m.id === msg.id) { ws.off('message', listener); resolve(m); } }; ws.on('message', listener); ws.send(JSON.stringify(msg)); });
    for (const method of ['Target.getTargets', 'Target.attachToTarget', 'Target.sendMessageToTarget', 'Target.attachToBrowserTarget', 'SystemInfo.getInfo', 'Tracing.start', 'Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Storage.getCookies', 'Browser.close', 'Fetch.enable', 'IO.read', 'HeapProfiler.takeHeapSnapshot']) {
      const before = fake.requests.length;
      assert.ok((await request({ id: 1, method, params: { targetId: 'foreign' }, sessionId: 'own-session' })).error, method);
      assert.equal(fake.requests.length, before);
    }
    assert.ok((await request({ id: 1, method: 'Page.enable', sessionId: 'foreign' })).error);
    assert.ok((await request({ id: 1, method: 'Page.navigate', params: { url: 'file:///secret' } })).error);
    for (const method of ALLOWED_METHODS) {
      const response = await request({ id: 1, method, params: method === 'Page.navigate' ? { url: 'https://example.com' } : {} });
      assert.equal(response.id, 1); assert.equal(response.error, undefined);
      const forwarded = fake.requests.at(-1);
      assert.notEqual(forwarded.id, 1, 'internal id cannot be reused');
      assert.equal(forwarded.sessionId, method === 'Browser.getVersion' ? undefined : 'own-session');
    }
    fake.emit({ method: 'Target.targetCreated', params: { secret: true } });
    fake.emit({ method: 'Runtime.consoleAPICalled', sessionId: 'foreign' });
    fake.emit({ id: 999999, result: { secret: true } });
    fake.emit({ method: 'Page.loadEventFired', sessionId: 'own-session' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events.map((e) => e.method), ['Page.loadEventFired']);
    const second = new WebSocket(proxy.url);
    await new Promise((resolve) => second.once('error', resolve));
    ws.close(); await new Promise((resolve) => ws.once('close', resolve));
    const reused = new WebSocket(proxy.url);
    await new Promise((resolve) => reused.once('error', resolve));
    await proxy.close();
    assert.ok(fake.requests.some((r) => r.method === 'Target.closeTarget' && r.params.targetId === 'own-target'));
    assert.ok(fake.requests.some((r) => r.method === 'Target.disposeBrowserContext'));
  } finally { ws?.terminate(); await proxy?.close(); await fake.close(); }
});

test('unsupported contexts fail closed without attaching an owner tab', async () => {
  const fake = await fakeDeviceCdp({ contextUnsupported: true });
  try { await assert.rejects(createCdpProxy(fake.device), /context-unsupported/); assert.equal(fake.requests.length, 1); }
  finally { await fake.close(); }
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { UNSANDBOXED_SENTENCE } from '../lib/devices/run-consent.js';
import { setup, approve } from './helpers/device-run-fixture.js';

test('exact approved bytes use argv/stdin; env and persisted hardware never expose endpoint metadata', async (t) => {
  const calls = [];
  const original = Buffer.from('approved bytes');
  const spawn = (file, args, opts) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    const chunks = []; child.stdin.on('data', (b) => chunks.push(b));
    child.stdin.on('finish', async () => {
      calls.push({ file, args, opts, bytes: Buffer.concat(chunks) });
      child.stdout.write('{"metrics":{"score":42}}'); child.emit('close', 0);
    });
    return child;
  };
  const { workspace, fake, service, consent, history } = await setup(t, { spawn, fakeDeviceHost: '192.168.1.77' });
  const filename = path.join(workspace, 'measure.mjs');
  await fs.writeFile(filename, original);
  const result = await service.start('d', { scriptPath: 'measure.mjs', args: ['a; echo bad'] }, { workspace });
  assert.equal(result.run.status, 'awaiting-consent'); assert.equal(calls.length, 0);
  await fs.writeFile(filename, 'changed while pending');
  const card = approve(consent);
  assert.ok(card.text.includes(filename)); assert.ok(card.text.includes(result.run.hash)); assert.ok(card.text.includes(UNSANDBOXED_SENTENCE));
  await fs.writeFile(filename, 'changed after approval');
  await result.completion;
  assert.equal(result.run.status, 'success'); assert.deepEqual(calls[0].bytes, original);
  assert.deepEqual(calls[0].args, ['--input-type=module', '-', 'a; echo bad']); assert.equal(calls[0].opts.shell, false);
  const env = calls[0].opts.env;
  assert.match(env.CRETLI_DEVICE_CDP_URL, /^ws:\/\/127\.0\.0\.1:/);
  assert.equal(Object.values(env).some((v) => String(v).includes(String(fake.port))), false);
  assert.equal(JSON.stringify(env).includes(fake.device.host), false);
  assert.equal(Object.hasOwn(env, 'CRETLI_DEVICE_HOST'), false); assert.equal(Object.hasOwn(env, 'CRETLI_DEVICE_PORT'), false);
  assert.deepEqual(JSON.parse(env.CRETLI_DEVICE_SYSTEM_INFO), result.run.hardware);
  assert.equal(result.run.hardware.cpuCores, 8); assert.equal(result.run.hardware.dpr, 2);
  const persisted = await fs.readFile(history.file, 'utf8');
  assert.equal(persisted.includes(String(fake.port)), false);
  assert.equal(persisted.includes(fake.device.host), false);
  assert.equal(persisted.includes('commandLine'), false); assert.equal(persisted.includes('/private/profile'), false);
  assert.ok(fake.requests.some((r) => r.method === 'Target.closeTarget'));
  assert.ok(fake.requests.some((r) => r.method === 'Target.disposeBrowserContext'));
});

for (const [source, error] of [['throw new Error("boom")', 'script-error'], ['setInterval(()=>{},1000)', 'script-timeout'], ['console.log("x".repeat(10000))', 'output-limit']]) {
  test('cleanup on ' + error, async (t) => {
    const { workspace, service, consent, fake } = await setup(t, { timeoutMs: 500, outputCap: 1024 });
    await fs.writeFile(path.join(workspace, 'measure.mjs'), source);
    const r = await service.start('d', { scriptPath: 'measure.mjs' }, { workspace }); approve(consent);
    await r.completion; assert.equal(r.run.error, error); assert.equal(r.run.metrics, null);
    assert.ok(fake.requests.some((r) => r.method === 'Target.closeTarget')); assert.ok(fake.requests.some((r) => r.method === 'Target.disposeBrowserContext'));
  });
}
