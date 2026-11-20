/**
 * Push test client (app_front/features/pwa/pushTestClient.js): the settings
 * "Send test push" button must call the real `POST /api/push/test` route with
 * this device's endpoint.
 */
import assert from 'node:assert/strict';
import {
  PUSH_TEST_PATH,
  buildPushTestRequest,
  sendPushTest,
} from '../app_front/features/pwa/pushTestClient.js';

// --- request shape ----------------------------------------------------------
assert.equal(PUSH_TEST_PATH, '/api/push/test');
{
  const { url, init } = buildPushTestRequest('  https://push.example/device  ');
  assert.equal(url, '/api/push/test');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { endpoint: 'https://push.example/device' });
}
assert.deepEqual(JSON.parse(buildPushTestRequest(undefined).init.body), { endpoint: '' });

// --- sending calls the real endpoint ----------------------------------------
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, sent: 1 };
      },
    };
  };
  const result = await sendPushTest('https://push.example/device', { fetchImpl });
  assert.deepEqual(result, { ok: true, status: 200, error: '', body: { ok: true, sent: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/push/test', 'the client must hit the real test route');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { endpoint: 'https://push.example/device' });
}

// Missing endpoint never hits the network.
{
  let called = false;
  const result = await sendPushTest('   ', {
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_endpoint');
}

// Server-side failure (unknown/expired subscription) is surfaced, not swallowed.
{
  const result = await sendPushTest('https://push.example/gone', {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: 'subscription_not_found' }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'subscription_not_found');
}

// Rate limit response is surfaced too.
{
  const result = await sendPushTest('https://push.example/device', {
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, error: 'rate_limited', retryAfterMs: 4000 }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'rate_limited');
}

// Network errors are reported as such instead of throwing.
{
  const result = await sendPushTest('https://push.example/device', {
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'network');
  assert.equal(result.detail, 'offline');
}

console.log('push-test-client.test.js: ok');
