/**
 * Routes: POST/DELETE /api/push/subscribe preferences contract.
 * Fake express app, isolated data dir.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerPushRoutes } from '../lib/routes/push-routes.js';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const handlers = new Map();
const app = {};
for (const verb of ['get', 'post', 'delete']) {
  app[verb] = (p, fn) => handlers.set(`${verb.toUpperCase()} ${p}`, fn);
}
registerPushRoutes(app);

function invoke(method, urlPath, req = {}) {
  const fn = handlers.get(`${method} ${urlPath}`);
  assert.ok(fn, `handler ${method} ${urlPath}`);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    fn({ params: {}, query: {}, body: {}, ...req }, res);
  });
}

const subsFile = path.join(ISOLATED_DATA_DIR, 'push-subscriptions.json');
function readSubs() {
  try {
    return JSON.parse(readFileSync(subsFile, 'utf8'));
  } catch {
    return [];
  }
}

const SUB = { endpoint: 'https://push.example/route', keys: { p256dh: 'p', auth: 'a' } };

// Missing subscription.
assert.deepEqual((await invoke('POST', '/api/push/subscribe', { body: {} })).body, {
  ok: false,
  error: 'invalid_subscription',
});
assert.equal((await invoke('POST', '/api/push/subscribe', { body: { subscription: {} } })).status, 400);

// Valid subscribe with preferences.
{
  const res = await invoke('POST', '/api/push/subscribe', {
    body: {
      subscription: SUB,
      preferences: {
        enabled: true,
        pushVibrate: 'long',
        events: { finished: false, question: true, permission: true },
      },
    },
  });
  assert.deepEqual(res.body, { ok: true });
  const stored = readSubs();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].preferences.pushVibrate, 'long');
  assert.equal(stored[0].preferences.events.finished, false);
}

// Invalid preferences => 400 and NO mutation of stored prefs.
for (const bad of [
  { pushVibrate: 'bogus' },
  { enabled: 'yes' },
  { events: { bogus: true } },
  { events: { finished: 'yes' } },
  { inAppSound: 1 },
  null,
  'nope',
]) {
  const before = readSubs();
  const res = await invoke('POST', '/api/push/subscribe', {
    body: { subscription: SUB, preferences: bad },
  });
  assert.equal(res.status, 400, `bad prefs rejected: ${JSON.stringify(bad)}`);
  assert.deepEqual(res.body, { ok: false, error: 'invalid_preferences' });
  assert.deepEqual(readSubs(), before, 'invalid preferences must not mutate storage');
}
assert.equal(readSubs()[0].preferences.pushVibrate, 'long', 'stored prefs survived rejects');

// Re-POST without preferences preserves stored ones.
{
  const res = await invoke('POST', '/api/push/subscribe', {
    body: { subscription: { ...SUB, keys: { p256dh: 'p2', auth: 'a2' } } },
  });
  assert.deepEqual(res.body, { ok: true });
  const stored = readSubs();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].keys.p256dh, 'p2');
  assert.equal(stored[0].preferences.pushVibrate, 'long');
  assert.equal(stored[0].preferences.events.finished, false);
}

// Partial preferences merge.
{
  await invoke('POST', '/api/push/subscribe', {
    body: { subscription: SUB, preferences: { pushVibrate: 'off' } },
  });
  const stored = readSubs();
  assert.equal(stored[0].preferences.pushVibrate, 'off');
  assert.equal(stored[0].preferences.events.finished, false, 'omitted field preserved');
}

// DELETE requires an endpoint and removes only the matching one.
assert.deepEqual((await invoke('DELETE', '/api/push/subscribe', { body: {} })).body, {
  ok: false,
  error: 'missing_endpoint',
});
{
  await invoke('POST', '/api/push/subscribe', {
    body: { subscription: { endpoint: 'https://push.example/other', keys: { p256dh: 'o', auth: 'o' } } },
  });
  assert.equal(readSubs().length, 2);
  const res = await invoke('DELETE', '/api/push/subscribe', {
    body: { endpoint: 'https://push.example/route' },
  });
  assert.deepEqual(res.body, { ok: true });
  const stored = readSubs();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].endpoint, 'https://push.example/other');
}

removeIsolatedDataDir();
console.log('push-routes-preferences.test.js: ok');
