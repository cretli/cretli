/**
 * Consent registry for agent port_expose calls and its routes. A fake clock drives
 * every timer, so nothing here waits in real time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-expose-consent-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = path.join(temp, 'data');
const auth = await import('../lib/auth.js');
const { createExposeConsentRegistry, MAX_PENDING_PER_CHAT } = await import('../lib/port-exposure/expose-consent.js');
const { registerPortExposureRoutes } = await import('../lib/routes/port-exposure-routes.js');

const WAIT = 20_000;
const TIMEOUT = 600_000;

/** Minimal fake timers: `advance(ms)` fires due callbacks in order. */
function fakeClock() {
  let t = 1_000_000;
  let nextId = 1;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  return {
    now: () => t,
    setTimeoutFn: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = target;
    },
  };
}

function setup() {
  const clock = fakeClock();
  const changes = [];
  const created = [];
  const reg = createExposeConsentRegistry({
    ...clock,
    waitMs: WAIT,
    timeoutMs: TIMEOUT,
    onChange: (e) => changes.push(e.chatId),
    onCreate: (e) => created.push(e),
  });
  return { clock, reg, changes, created };
}

test('request stays pending after waitMs while the card lives on', async () => {
  const { clock, reg } = setup();
  const answer = reg.request({ chatId: 'c1', port: 5173, ttlMs: 60_000, reason: 'demo' });
  clock.advance(WAIT);
  assert.equal(await answer, 'pending');
  const [card] = reg.list('c1');
  assert.equal(card.port, 5173);
  assert.equal(card.reason, 'demo');
  assert.equal(card.expiresAt - card.createdAt, TIMEOUT);
  assert.deepEqual(reg.list('c2'), []);
});

test('once wakes the waiter and the grant is spent exactly once', async () => {
  const { reg } = setup();
  const answer = reg.request({ chatId: 'c1', port: 5173 });
  const [card] = reg.list('c1');
  assert.deepEqual(reg.resolve(card.id, 'once', { chatId: 'c2' }), { ok: false, code: 'forbidden-chat' });
  assert.deepEqual(reg.resolve(card.id, 'once', { chatId: 'c1' }), { ok: true, port: 5173 });
  assert.equal(await answer, 'once');
  // The waiter spent it: a later call needs a new card.
  assert.equal(reg.hasOnceGrant('c1', 5173), false);
  const again = reg.request({ chatId: 'c1', port: 5173 });
  assert.equal(reg.list('c1').length, 1);
  reg.resolve(reg.list('c1')[0].id, 'deny');
  assert.equal(await again, 'deny');
});

test('once after the waiter gave up leaves a grant that the retry spends once', async () => {
  const { clock, reg } = setup();
  const first = reg.request({ chatId: 'c1', port: 6000 });
  clock.advance(WAIT);
  assert.equal(await first, 'pending');
  reg.resolve(reg.list('c1')[0].id, 'once');
  assert.equal(reg.hasOnceGrant('c1', 6000), true);
  assert.equal(reg.hasOnceGrant('c1', 6001), false);
  assert.equal(await reg.request({ chatId: 'c1', port: 6000 }), 'once');
  assert.equal(reg.hasOnceGrant('c1', 6000), false);
  const next = reg.request({ chatId: 'c1', port: 6000 });
  assert.equal(reg.list('c1').length, 1, 'the grant was consumed, a new card is needed');
  reg.clearChat('c1');
  assert.equal(await next, 'deny');
});

test('deny answers deny and invalid decisions are rejected', async () => {
  const { reg } = setup();
  const answer = reg.request({ chatId: 'c1', port: 4000 });
  const [card] = reg.list('c1');
  assert.deepEqual(reg.resolve(card.id, 'allow'), { ok: false, code: 'invalid-decision' });
  assert.equal(reg.resolve(card.id, 'deny').ok, true);
  assert.equal(await answer, 'deny');
  assert.deepEqual(reg.resolve(card.id, 'deny'), { ok: false, code: 'not-found' });
  assert.equal(reg.hasOnceGrant('c1', 4000), false);
});

test('silence expires the card after 10 minutes; a waiting call sees timeout', async () => {
  const { clock, reg } = setup();
  const first = reg.request({ chatId: 'c1', port: 4000 });
  clock.advance(WAIT);
  assert.equal(await first, 'pending');
  clock.advance(TIMEOUT - WAIT - 5_000);
  const parked = reg.request({ chatId: 'c1', port: 4000 });
  clock.advance(5_000);
  assert.equal(await parked, 'timeout');
  assert.deepEqual(reg.list('c1'), []);
  assert.equal(reg.hasOnceGrant('c1', 4000), false);
});

test('a deny or timeout nobody waited for is reported once to the retry', async () => {
  const { clock, reg } = setup();
  const first = reg.request({ chatId: 'c1', port: 4000 });
  clock.advance(WAIT);
  assert.equal(await first, 'pending');
  clock.advance(TIMEOUT);
  assert.deepEqual(reg.list('c1'), []);
  assert.equal(await reg.request({ chatId: 'c1', port: 4000 }), 'timeout');
  const second = reg.request({ chatId: 'c1', port: 4000 });
  clock.advance(WAIT);
  assert.equal(await second, 'pending');
  reg.resolve(reg.list('c1')[0].id, 'deny');
  assert.equal(await reg.request({ chatId: 'c1', port: 4000 }), 'deny');
  const third = reg.request({ chatId: 'c1', port: 4000 });
  assert.equal(reg.list('c1').length, 1, 'refusal was reported once; the next call asks again');
  reg.clearChat('c1');
  await third;
});

test('concurrent requests share one card and the limit is 5 per chat', async () => {
  const { reg, created } = setup();
  const a = reg.request({ chatId: 'c1', port: 4000 });
  const b = reg.request({ chatId: 'c1', port: 4000 });
  assert.equal(reg.list('c1').length, 1);
  assert.equal(created.length, 1);
  for (let port = 4001; port < 4000 + MAX_PENDING_PER_CHAT; port += 1) reg.request({ chatId: 'c1', port });
  assert.equal(reg.list('c1').length, MAX_PENDING_PER_CHAT);
  assert.equal(await reg.request({ chatId: 'c1', port: 4999 }), 'limit');
  // Another chat is unaffected.
  reg.request({ chatId: 'c2', port: 4999 });
  assert.equal(reg.list('c2').length, 1);
  reg.resolve(reg.list('c1').find((c) => c.port === 4000).id, 'once');
  assert.equal(await a, 'once');
  assert.equal(await b, 'pending', 'only one parked call spends the grant');
  reg.clearChat('c1');
  reg.clearChat('c2');
});

test('clearChat (archive) denies cards and drops grants', async () => {
  const { clock, reg } = setup();
  const lateGrant = reg.request({ chatId: 'c1', port: 4100 });
  clock.advance(WAIT);
  assert.equal(await lateGrant, 'pending');
  reg.resolve(reg.list('c1').find((c) => c.port === 4100).id, 'once');
  assert.equal(reg.hasOnceGrant('c1', 4100), true);
  const parked = reg.request({ chatId: 'c1', port: 4000 });
  const other = reg.request({ chatId: 'c2', port: 4000 });
  reg.clearChat('c1');
  assert.equal(await parked, 'deny');
  assert.deepEqual(reg.list('c1'), []);
  assert.equal(reg.hasOnceGrant('c1', 4100), false);
  assert.equal(reg.list('c2').length, 1);
  reg.clearChat('c2');
  assert.equal(await other, 'deny');
});

test('onCreate fires once per card and onChange on creation and resolution', async () => {
  const { reg, changes, created } = setup();
  const answer = reg.request({ chatId: 'c1', port: 4000 });
  reg.request({ chatId: 'c1', port: 4000 });
  assert.deepEqual(created.map((e) => [e.chatId, e.port]), [['c1', 4000]]);
  assert.deepEqual(changes, ['c1']);
  reg.resolve(reg.list('c1')[0].id, 'deny');
  await answer;
  assert.deepEqual(changes, ['c1', 'c1']);
  const throwing = createExposeConsentRegistry({ onChange: () => { throw new Error('push down'); }, onCreate: () => { throw new Error('push down'); } });
  const parked = throwing.request({ chatId: 'c9', port: 4000 });
  throwing.clearChat('c9');
  assert.equal(await parked, 'deny');
});

test('invalid requests are denied without a card', async () => {
  const { reg } = setup();
  assert.equal(await reg.request({ chatId: '', port: 4000 }), 'deny');
  assert.equal(await reg.request({ chatId: 'c1', port: 'x' }), 'deny');
  assert.deepEqual(reg.list('c1'), []);
});

async function withServer(fn) {
  assert.equal(auth.setPassword('test-password-for-consent').ok, true);
  const token = auth.createSession();
  const cookie = `cr_session=${encodeURIComponent(token)}`;
  const csrf = auth.getCsrfTokenForSessionToken(token);
  const { reg } = setup();
  const app = express();
  app.use(express.json());
  registerPortExposureRoutes(app, { consent: reg, service: /** @type {any} */ ({}) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { cookie, [auth.AUTH_CSRF_HEADER]: csrf, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ call, base, reg }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('consent routes: 401 without a session, 404 for an unknown id, list and answer work', async () => {
  await withServer(async ({ call, base, reg }) => {
    assert.equal((await fetch(`${base}/api/port-exposures/consent?chatId=c1`)).status, 401);
    assert.equal((await fetch(`${base}/api/port-exposures/consent/pe-x`, { method: 'POST' })).status, 401);
    assert.equal((await call('GET', '/api/port-exposures/consent')).status, 400);
    assert.equal((await call('POST', '/api/port-exposures/consent/pe-unknown', { chatId: 'c1', decision: 'once' })).status, 404);

    const answer = reg.request({ chatId: 'c1', port: 5173, reason: 'demo' });
    const listed = await call('GET', '/api/port-exposures/consent?chatId=c1');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.prompts.length, 1);
    const id = listed.body.prompts[0].id;
    assert.equal((await call('POST', `/api/port-exposures/consent/${id}`, { chatId: 'c2', decision: 'once' })).status, 403);
    assert.equal((await call('POST', `/api/port-exposures/consent/${id}`, { chatId: 'c1', decision: 'forever' })).status, 400);
    const done = await call('POST', `/api/port-exposures/consent/${id}`, { chatId: 'c1', decision: 'once' });
    assert.equal(done.status, 200);
    assert.equal(done.body.port, 5173);
    assert.equal(await answer, 'once');
    assert.deepEqual((await call('GET', '/api/port-exposures/consent?chatId=c1')).body.prompts, []);
  });
});

test('runtime registry broadcasts portExposeConsentChanged on creation and resolution, scoped by chat', async () => {
  const { EventEmitter } = await import('node:events');
  const updates = await import('../lib/chat-list-updates.js');
  const runtime = await import('../lib/port-exposure/runtime.js');
  updates.__clearChatListUpdateClientsForTest();
  const frames = [];
  const session = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: (p) => frames.push(JSON.parse(p)) });
  const widget = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: () => frames.push({ widget: true }) });
  updates.subscribeChatListUpdates(session, { kind: 'session' });
  updates.subscribeChatListUpdates(widget, { kind: 'widget', chatIds: ['other'] });
  runtime.setExposeConsentRegistry(null);
  const registry = runtime.getExposeConsentRegistry();
  const parked = registry.request({ chatId: 'chat-bc', port: 5173 });
  assert.deepEqual(frames, [{ type: 'portExposeConsentChanged', chatId: 'chat-bc' }]);
  registry.resolve(registry.list('chat-bc')[0].id, 'deny');
  assert.equal(await parked, 'deny');
  assert.equal(frames.length, 2);
  assert.ok(frames.every((f) => f.type === 'portExposeConsentChanged' && f.chatId === 'chat-bc'));
  updates.__clearChatListUpdateClientsForTest();
  runtime.setExposeConsentRegistry(null);
});
