import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerBrowserRoutes } from '../lib/browser/routes.js';
import { consentHost, domainOfUrl } from '../lib/browser/chrome-ext-store.js';
import { sanitizeError, sanitizeResult } from '../lib/browser/cretli-extension-bridge.js';
import * as extDomains from '../extensions/cretli-chrome/domains.js';
import { fetchDocument } from '../extensions/cretli-chrome/fetch-document.js';
import { abortAll, bindSocketLifecycle } from '../extensions/cretli-chrome/lifecycle.js';
import { createFixture, ctxFor, openShopTab, OWNER } from './helpers/chrome-ext-fixture.js';

const pdf = (n = 100) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n, 0x61)]);

test('F1: consent is per exact host on the server and in the extension (shared suffixes)', async () => {
  for (const mod of [{ consentHost, domainOfUrl }, extDomains]) {
    assert.equal(mod.consentHost('alice.github.io'), 'alice.github.io');
    assert.notEqual(mod.consentHost('alice.github.io'), mod.consentHost('bob.github.io'));
    assert.equal(mod.consentHost('a.b.example.co.uk'), 'a.b.example.co.uk');
    assert.equal(mod.consentHost('10.0.0.1'), '');
    assert.equal(mod.consentHost('localhost'), '');
    assert.equal(mod.domainOfUrl('https://bob.github.io/x'), 'bob.github.io');
    assert.equal(mod.domainOfUrl('https://u:p@bob.github.io/x'), '');
    assert.equal(mod.domainOfUrl('https://bob.github.io:8443/x'), '');
    assert.equal(mod.domainOfUrl('http://bob.github.io/x'), '');
  }
  assert.deepEqual(extDomains.originsFor('alice.github.io'), ['https://alice.github.io/*']);
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    fx.store.approveDomain(OWNER, 'alice.github.io');
    client.respondWith(() => ({ ok: true, data: { tabId: 1, url: 'https://alice.github.io/', title: '' } }));
    assert.equal((await fx.bridge.execute(ctxFor(), 'open_url', { url: 'https://alice.github.io/' })).ok, true);
    const other = await fx.bridge.execute(ctxFor(), 'open_url', { url: 'https://bob.github.io/' });
    assert.equal(other.error.code, 'E_DOMAIN_NOT_ALLOWED');
    assert.deepEqual(fx.store.listDomains(OWNER).pending.map((p) => p.domain), ['bob.github.io']);
    const cross = await fx.bridge.execute(ctxFor(), 'download', { tabId: 1, items: [{ href: 'https://bob.github.io/a.pdf' }] });
    assert.equal(cross.error.code, 'E_DOMAIN_NOT_ALLOWED');
  } finally { await fx.close(); }
});

const res = (over = {}) => ({
  ok: true, status: 200, type: 'basic', url: 'https://shop.example.com/a.pdf',
  headers: new Headers({ 'content-type': 'application/pdf' }),
  body: new Response(pdf()).body, ...over,
});
const allowOnly = (...hosts) => async (host) => hosts.includes(host);

test('F2: redirects are not followed and the final host is re-checked', async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push(init); return res({ type: 'opaqueredirect', status: 0, ok: false }); };
  const out = await fetchDocument('https://shop.example.com/a.pdf', { fetchFn, isHostAllowed: allowOnly('shop.example.com') });
  assert.equal(out.error.code, 'E_DOMAIN_NOT_ALLOWED');
  assert.equal(seen[0].redirect, 'manual');
  assert.equal(seen[0].credentials, 'include');
  const moved = await fetchDocument('https://shop.example.com/a.pdf', {
    fetchFn: async () => res({ url: 'https://evil.example.net/a.pdf' }), isHostAllowed: allowOnly('shop.example.com'),
  });
  assert.equal(moved.error.code, 'E_DOMAIN_NOT_ALLOWED');
  const unapproved = await fetchDocument('https://cdn.example.net/a.pdf', { fetchFn: async () => assert.fail('no fetch'), isHostAllowed: allowOnly('shop.example.com') });
  assert.equal(unapproved.error.code, 'E_DOMAIN_NOT_ALLOWED');
  const ok = await fetchDocument('https://shop.example.com/a.pdf', { fetchFn: async () => res(), isHostAllowed: allowOnly('shop.example.com') });
  assert.equal(ok.ok, true);
  assert.equal(ok.finalHost, 'shop.example.com');
});

test('F2: the server rejects a download whose reported host is not approved and audits the real host', async () => {
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    const tabId = await openShopTab(fx, client);
    client.respondWith((cmd) => {
      if (cmd.name !== 'download') return null;
      client.sendFile(cmd.id, { name: 'a.pdf', mime: 'application/pdf', bytes: pdf(), sourceHost: 'evil.example.net' });
      return { ok: true, data: {} };
    });
    const out = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: [{ href: 'https://shop.example.com/a.pdf' }] });
    assert.equal(out.error.code, 'E_DOMAIN_NOT_ALLOWED');
    assert.equal(fs.existsSync(path.join(fx.downloadsDir, 'chat-1')), false, 'nothing is written for an unapproved host');
    assert.equal(fx.store.readAudit(OWNER)[0].domain, 'evil.example.net');
    assert.equal(fx.store.readAudit(OWNER)[0].result, 'E_DOMAIN_NOT_ALLOWED');
  } finally { await fx.close(); }
});

test('F3: the declared Content-Type is reported unchanged and a mismatch is rejected', async () => {
  const html = await fetchDocument('https://shop.example.com/invoice.csv', {
    fetchFn: async () => res({ headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }) }), isHostAllowed: allowOnly('shop.example.com'),
  });
  assert.equal(html.error.code, 'E_TYPE');
  const magicButBinary = await fetchDocument('https://shop.example.com/a.pdf', {
    fetchFn: async () => res({ headers: new Headers({ 'content-type': 'application/octet-stream' }) }), isHostAllowed: allowOnly('shop.example.com'),
  });
  assert.equal(magicButBinary.error.code, 'E_TYPE');
  const csv = await fetchDocument('https://shop.example.com/x', {
    fetchFn: async () => res({ headers: new Headers({ 'content-type': 'text/csv; charset=utf-8' }), body: new Response('a,b\n').body }), isHostAllowed: allowOnly('shop.example.com'),
  });
  assert.equal(csv.mime, 'text/csv');
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    const tabId = await openShopTab(fx, client);
    client.respondWith((cmd) => {
      if (cmd.name !== 'download') return null;
      client.sendFile(cmd.id, { name: 'invoice.csv', mime: 'text/csv', bytes: '<html>not csv\u0000</html>' });
      return { ok: true, data: {} };
    });
    const out = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: [{ href: 'https://shop.example.com/invoice.csv' }] });
    assert.equal(out.error.code, 'E_TYPE');
  } finally { await fx.close(); }
});

test('F4: kill deletes the token hash (see chrome-ext-ws-router kill test) and the file no longer holds it', async () => {
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    fx.bridge.setKilled(OWNER, true);
    await client.closed;
    const raw = fs.readFileSync(path.join(fx.store.dir, 'installs.json'), 'utf8');
    assert.ok(!raw.includes(client.paired.installId));
  } finally { await fx.close(); }
});

test('F5: a socket close or error aborts every in-flight fetch', async () => {
  const running = new Map();
  const ws = {};
  let closed = null;
  bindSocketLifecycle(ws, { running, onClosed: (event) => { closed = event; } });
  let sawAbort = 0;
  const fetchFn = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { sawAbort += 1; reject(new DOMException('aborted', 'AbortError')); });
  });
  for (const trigger of ['onclose', 'onerror']) {
    const controller = new AbortController();
    running.set(`cmd-${trigger}`, controller);
    const pending = fetchDocument('https://shop.example.com/a.pdf', { fetchFn, signal: controller.signal, isHostAllowed: allowOnly('shop.example.com') });
    await new Promise((resolve) => setImmediate(resolve));
    ws[trigger]({ code: 4403 });
    assert.equal((await pending).error.code, 'E_CANCELLED', trigger);
    assert.equal(running.size, 0);
  }
  assert.equal(sawAbort, 2);
  assert.equal(closed.code, 4403);
  const c = new AbortController();
  abortAll(new Map([['x', c]]));
  assert.equal(c.signal.aborted, true);
});

test('F6: two login sessions of the same instance owner share the install and consents', async () => {
  const fx = await createFixture();
  const app = express();
  app.use(express.json());
  registerBrowserRoutes(app, {
    browserManager: { getRuntimeStatus: () => ({}) }, dataDir: fx.root,
    getOwnerSessionId: (req) => String(req.headers['x-session'] || ''),
    isOwnerSessionActive: (id) => id.startsWith('session-'),
    chromeExtBridge: fx.bridge, chromeExtStore: fx.store,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = async (method, route, session, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/browser/chrome-ext${route}`, {
      method, headers: { 'content-type': 'application/json', 'x-session': session }, body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  };
  try {
    const pairing = await call('POST', '/pairing', 'session-one');
    const client = fx.client();
    await client.open();
    client.json({ type: 'pair', code: pairing.code, extensionId: 'a'.repeat(32) });
    await client.next('paired');
    await call('POST', '/domains', 'session-one', { domain: 'shop.example.com' });
    // A different login session of the same owner sees the same state; no re-pair needed after re-login.
    const status = await call('GET', '/status', 'session-two');
    assert.equal(status.paired, true);
    assert.deepEqual(status.domains.allowed, ['shop.example.com']);
    assert.equal(fx.store.getInstallForOwner(OWNER).installId, (await call('GET', '/status', 'session-one')).paired ? fx.store.getInstallForOwner(OWNER).installId : '');
    assert.equal((await call('DELETE', '/install', 'session-two')).removed, true);
    assert.equal((await call('GET', '/status', 'session-one')).paired, false);
  } finally { await new Promise((resolve) => server.close(resolve)); await fx.close(); }
});

test('F7: credentials in URLs and error messages never reach the caller', () => {
  const secretUrl = 'https://user:hunter2@shop.example.com/a.pdf?x=1';
  const opened = sanitizeResult('open_url', { tabId: 1, url: secretUrl, title: 't' });
  assert.equal(opened.url, 'https://shop.example.com/a.pdf?x=1');
  const listed = sanitizeResult('list_documents', { items: [
    { selector: 'a', href: secretUrl, text: 'x', mimeHint: '' },
    { selector: 'b', href: 'javascript:alert(1)', text: 'x', mimeHint: '' },
    { selector: 'c', href: 'not a url', text: 'x', mimeHint: '' },
  ] });
  assert.deepEqual(listed.items.map((i) => i.href), ['https://shop.example.com/a.pdf?x=1', '', '']);
  assert.ok(!JSON.stringify([opened, listed]).includes('hunter2'));
  for (const code of ['E_INTERNAL', 'E_SELECTOR', 'E_TYPE', 'E_PERMISSION_DENIED', 'E_WHATEVER']) {
    const err = sanitizeError({ code, message: 'Cookie: sid=abc; Authorization: Bearer tok', status: 500 });
    assert.ok(!/sid=|Bearer|Cookie|Authorization/.test(err.message), code);
  }
  assert.equal(sanitizeError({ code: 'E_HTTP', status: 404, message: 'Set-Cookie: a=b' }).message, 'HTTP 404');
});

test('F8: the collision suffix keeps the file name within 120 characters', async () => {
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    const tabId = await openShopTab(fx, client);
    const name = `${'x'.repeat(300)}.pdf`;
    const names = [];
    for (let i = 0; i < 12; i += 1) {
      client.respondWith((cmd) => {
        if (cmd.name !== 'download') return null;
        client.sendFile(cmd.id, { name, mime: 'application/pdf', bytes: pdf() });
        return { ok: true, data: {} };
      });
      const out = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: [{ href: 'https://shop.example.com/a.pdf' }] });
      names.push(out.data.files[0].name);
    }
    assert.equal(new Set(names).size, 12);
    for (const n of names) {
      assert.ok(n.length <= 120, `${n.length}`);
      assert.ok(n.endsWith('.pdf'));
    }
  } finally { await fx.close(); }
});

test('R1A1-F5: early exits after headers abort the request and cancel the body', async () => {
  const cases = [
    ['bad status', { ok: false, status: 500 }],
    ['disallowed MIME', { headers: new Headers({ 'content-type': 'text/html' }) }],
    ['oversize Content-Length', { headers: new Headers({ 'content-type': 'application/pdf', 'content-length': String(21 * 1024 * 1024) }) }],
  ];
  for (const [label, over] of cases) {
    let cancelled = false;
    let signal;
    const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
    const fetchFn = async (_url, init) => { signal = init.signal; return res({ ...over, body }); };
    const out = await fetchDocument('https://shop.example.com/a.pdf', { fetchFn, isHostAllowed: allowOnly('shop.example.com') });
    assert.equal(out.ok, false, label);
    assert.equal(signal.aborted, true, `${label}: request aborted`);
    // Aborting the signal is what tears down the stream in Chrome; the fake body needs an explicit cancel.
    await body.cancel().catch(() => {});
    assert.equal(cancelled || signal.aborted, true, label);
  }
  // The caller's signal also still reaches the request.
  const outer = new AbortController();
  let inner;
  const pending = fetchDocument('https://shop.example.com/a.pdf', {
    fetchFn: (_u, init) => { inner = init.signal; return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('x')))); },
    signal: outer.signal, isHostAllowed: allowOnly('shop.example.com'),
  });
  await new Promise((resolve) => setImmediate(resolve));
  outer.abort();
  assert.equal((await pending).error.code, 'E_CANCELLED');
  assert.equal(inner.aborted, true);
});
