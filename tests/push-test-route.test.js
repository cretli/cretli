/**
 * POST /api/push/test: one endpoint only, push-test payload, no chatId, and a
 * per-endpoint rate limit. Isolated data dir + monkeypatched web-push sender.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

const webPush = (await import('web-push')).default;
const sentCalls = [];
webPush.sendNotification = async (sub, payload, options) => {
  sentCalls.push({ endpoint: sub.endpoint, parsed: JSON.parse(payload), options });
};

const { addSubscription } = await import('../lib/push.js');
const {
  registerPushRoutes,
  resetPushTestRateLimits,
  checkPushTestRateLimit,
  PUSH_TEST_MIN_INTERVAL_MS,
} = await import('../lib/routes/push-routes.js');
const { ISOLATED_DATA_DIR, removeIsolatedDataDir } = await import('./helpers/isolated-data-dir.js');

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

// --- pure rate limiter -------------------------------------------------------
resetPushTestRateLimits();
assert.deepEqual(checkPushTestRateLimit('ep', 1000), { allowed: true, retryAfterMs: 0 });
assert.equal(checkPushTestRateLimit('ep', 1000 + PUSH_TEST_MIN_INTERVAL_MS - 1).allowed, false);
assert.equal(checkPushTestRateLimit('other', 1000 + 100).allowed, true);
assert.equal(checkPushTestRateLimit('ep', 1000 + PUSH_TEST_MIN_INTERVAL_MS).allowed, true);

// --- route -------------------------------------------------------------------
resetPushTestRateLimits();
const A = 'https://push.example/only';
const B = 'https://push.example/other';
addSubscription({ endpoint: A, keys: { p256dh: 'a', auth: 'a' } }, { pushVibrate: 'short' });
addSubscription({ endpoint: B, keys: { p256dh: 'b', auth: 'b' } });

// Missing endpoint.
assert.deepEqual((await invoke('POST', '/api/push/test', { body: {} })).body, {
  ok: false,
  error: 'missing_endpoint',
});
assert.equal((await invoke('POST', '/api/push/test', { body: { endpoint: '   ' } })).status, 400);

// Unknown endpoint.
{
  const res = await invoke('POST', '/api/push/test', {
    body: { endpoint: 'https://push.example/nope' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'subscription_not_found');
}

// Happy path: only the addressed endpoint receives, payload is push-test w/o chatId.
sentCalls.length = 0;
{
  const res = await invoke('POST', '/api/push/test', { body: { endpoint: A } });
  assert.deepEqual(res.body, { ok: true, sent: 1 });
  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0].endpoint, A, 'no broadcast to the other endpoint');
  assert.equal(sentCalls[0].parsed.data.type, 'push-test');
  assert.equal('chatId' in sentCalls[0].parsed.data, false);
  assert.equal('eventId' in sentCalls[0].parsed.data, false);
  assert.deepEqual(sentCalls[0].parsed.vibrate, [80], 'endpoint preferences still apply');
}

// Rate limit: second immediate request to the same endpoint => 429, no send.
{
  const res = await invoke('POST', '/api/push/test', { body: { endpoint: A } });
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'rate_limited');
  assert.ok(res.body.retryAfterMs > 0);
  assert.equal(sentCalls.length, 1, 'a rate-limited request does not send');
}

// A different endpoint is independent of A's rate limit.
{
  const res = await invoke('POST', '/api/push/test', { body: { endpoint: B } });
  assert.deepEqual(res.body, { ok: true, sent: 1 });
  assert.equal(sentCalls.length, 2);
  assert.equal(sentCalls[1].endpoint, B);
}

// The test route never created push-inbox / chat-history state.
const files = readdirSync(ISOLATED_DATA_DIR);
assert.equal(files.some((name) => name.includes('push-inbox')), false);
assert.equal(files.some((name) => name.includes('chat-history')), false);

removeIsolatedDataDir();
console.log('push-test-route.test.js: ok');
