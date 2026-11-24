import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerBrowserRoutes } from '../lib/browser/routes.js';
import { createFixture, EXT_ID, OWNER } from './helpers/chrome-ext-fixture.js';

async function start(fx, { human = true } = {}) {
  const app = express();
  app.use(express.json());
  registerBrowserRoutes(app, {
    browserManager: { getRuntimeStatus: () => ({}) }, dataDir: fx.root,
    getOwnerSessionId: (req) => String(req.headers['x-owner'] || ''),
    isOwnerSessionActive: () => human,
    chromeExtBridge: fx.bridge, chromeExtStore: fx.store,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/browser/chrome-ext`;
  const call = async (method, route, body, owner = OWNER) => {
    const res = await fetch(`${base}${route}`, {
      method, headers: { 'content-type': 'application/json', ...(owner ? { 'x-owner': owner } : {}), 'x-cretli-csrf': 'test-csrf' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('routes need a login; mutations need an interactive login', async () => {
  const fx = await createFixture();
  const anon = await start(fx);
  const agent = await start(fx, { human: false });
  try {
    assert.equal((await anon.call('GET', '/status', undefined, '')).status, 401);
    assert.equal((await anon.call('POST', '/pairing', {}, '')).status, 401);
    assert.equal((await agent.call('POST', '/pairing', {})).status, 403);
    assert.equal((await agent.call('POST', '/domains', { domain: 'example.com' })).status, 403);
    assert.equal((await agent.call('PUT', '/kill', { killed: true })).status, 403);
    assert.equal((await agent.call('GET', '/status')).status, 200);
  } finally { await anon.close(); await agent.close(); await fx.close(); }
});

test('pairing, status, unpair', async () => {
  const fx = await createFixture();
  const api = await start(fx);
  try {
    const pairing = await api.call('POST', '/pairing', {});
    assert.equal(pairing.status, 200);
    assert.match(pairing.body.code, /^[A-Z2-9]{8}$/);
    assert.equal(pairing.body.ttlMs, 120000);
    const client = fx.client();
    await client.open();
    client.json({ type: 'pair', code: pairing.body.code, extensionId: EXT_ID });
    await client.next('paired');
    const status = (await api.call('GET', '/status')).body;
    assert.equal(status.paired, true);
    assert.equal(status.connected, true);
    assert.ok(!JSON.stringify(status).match(/token/i));
    const removed = await api.call('DELETE', '/install');
    assert.equal(removed.body.removed, true);
    assert.equal((await client.closed).code, 4403);
    assert.equal((await api.call('GET', '/status')).body.paired, false);
  } finally { await api.close(); await fx.close(); }
});

test('domain opt-in: human approval, removal, validation', async () => {
  const fx = await createFixture();
  const api = await start(fx);
  try {
    fx.store.requestDomain(OWNER, 'billing.acme.test', 'chat-1');
    const listed = await api.call('GET', '/domains');
    assert.deepEqual(listed.body.pending.map((p) => p.domain), ['billing.acme.test']);
    assert.deepEqual(listed.body.allowed, []);
    assert.equal((await api.call('POST', '/domains', { domain: 'not a domain' })).status, 400);
    assert.equal((await api.call('POST', '/domains', { domain: '10.0.0.1' })).status, 400);
    const approved = await api.call('POST', '/domains', { domain: 'billing.acme.test' });
    assert.deepEqual(approved.body.allowed, ['billing.acme.test']);
    assert.deepEqual(approved.body.pending, []);
        const removed = await api.call('DELETE', '/domains?domain=billing.acme.test');
    assert.equal(removed.body.removed, true);
    assert.deepEqual(removed.body.allowed, []);
  } finally { await api.close(); await fx.close(); }
});

test('audit read returns the owner entries newest first; kill switch on and off', async () => {
  const fx = await createFixture();
  const api = await start(fx);
  try {
    fx.store.appendAudit({ owner: OWNER, chatId: 'c1', domain: 'a.test', file: 'one.pdf', size: 1, sha256: 'x', result: 'ok' });
    fx.store.appendAudit({ owner: OWNER, chatId: 'c1', domain: 'a.test', file: 'two.pdf', size: 2, sha256: 'y', result: 'E_TYPE' });
    fx.store.appendAudit({ owner: 'other', chatId: 'c9', domain: 'b.test', file: 'secret.pdf', size: 3, sha256: 'z', result: 'ok' });
    const audit = (await api.call('GET', '/audit')).body.entries;
    assert.deepEqual(audit.map((e) => e.file), ['two.pdf', 'one.pdf']);
    assert.deepEqual(Object.keys(audit[0]).sort(), ['at', 'chatId', 'domain', 'file', 'owner', 'result', 'sha256', 'size']);
    assert.ok(fs.existsSync(path.join(fx.store.dir, 'audit.jsonl')));
    assert.equal((await api.call('PUT', '/kill', { killed: 'yes' })).status, 400);
    const client = await fx.pairedClient();
    const on = await api.call('PUT', '/kill', { killed: true });
    assert.equal(on.body.killed, true);
    assert.equal((await client.closed).code, 4403);
    assert.equal(fx.store.isKilled(OWNER), true);
    assert.equal((await api.call('PUT', '/kill', { killed: false })).body.killed, false);
  } finally { await api.close(); await fx.close(); }
});

test('audit rotates at 5 MB', async () => {
  const fx = await createFixture();
  try {
    const file = path.join(fx.store.dir, 'audit.jsonl');
    fs.mkdirSync(fx.store.dir, { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 1));
    fx.store.appendAudit({ owner: OWNER, file: 'a.pdf', result: 'ok' });
    assert.ok(fs.existsSync(`${file}.1`));
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  } finally { await fx.close(); }
});
