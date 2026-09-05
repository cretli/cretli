import assert from 'node:assert/strict';
import {
  applyCsrfFromAuthPayload,
  buildCretliApiHeaders,
  cretliApiFetch,
  getCsrfToken,
  isCretliApiUrl,
  setCsrfToken,
  setWidgetAccessToken,
} from '../app_front/lib/cretliApiRequest.js';

const originalFetch = globalThis.fetch;
const pageOrigin = 'https://cretli.local:3011';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

assert.equal(isCretliApiUrl('/api/chats'), true);
assert.equal(isCretliApiUrl('https://cretli.local:3011/api/push/subscribe', pageOrigin), true);
assert.equal(isCretliApiUrl('https://evil.example/api/chats', pageOrigin), false);
assert.equal(isCretliApiUrl('https://api.github.com/repos/x'), false);
assert.equal(isCretliApiUrl('https://evil.example/api/chats'), false);

setCsrfToken('csrf-token-1');
setWidgetAccessToken('widget-token-1');
const apiHeaders = buildCretliApiHeaders({
  url: '/api/client-instances/heartbeat',
  extra: { 'Content-Type': 'application/json' },
});
assert.equal(apiHeaders['X-Cretli-Csrf'], 'csrf-token-1');
assert.equal(apiHeaders.Authorization, 'Bearer widget-token-1');
assert.equal(apiHeaders['Content-Type'], 'application/json');

const externalHeaders = buildCretliApiHeaders({
  url: 'https://example.com/hook',
  extra: { 'Content-Type': 'application/json' },
  pageOrigin,
});
assert.equal(externalHeaders['X-Cretli-Csrf'], undefined);
assert.equal(externalHeaders.Authorization, undefined);

applyCsrfFromAuthPayload({ csrfToken: null });
assert.equal(getCsrfToken(), '');
applyCsrfFromAuthPayload({ csrfToken: 'fresh-csrf' });
assert.equal(getCsrfToken(), 'fresh-csrf');
applyCsrfFromAuthPayload({});
assert.equal(getCsrfToken(), '');

setCsrfToken('stale-csrf');
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), csrf: init?.headers?.['X-Cretli-Csrf'] || '' });
  if (String(url).includes('/api/auth-status')) {
    return jsonResponse(200, { ok: true, csrfToken: 'rotated-csrf' });
  }
  if (init?.headers?.['X-Cretli-Csrf'] === 'stale-csrf') {
    return jsonResponse(403, { ok: false, csrfRequired: true });
  }
  return jsonResponse(200, { ok: true });
};
const retried = await cretliApiFetch('/api/settings', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
assert.equal(retried.status, 200);
assert.equal(getCsrfToken(), 'rotated-csrf');
assert.equal(calls.length, 3);
assert.equal(calls.filter((item) => item.url.includes('/api/auth-status')).length, 1);

calls.length = 0;
setCsrfToken('stale-csrf');
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), csrf: init?.headers?.['X-Cretli-Csrf'] || '' });
  if (String(url).includes('/api/auth-status')) {
    return jsonResponse(200, { ok: true, csrfToken: 'shared-csrf' });
  }
  if (init?.headers?.['X-Cretli-Csrf'] === 'stale-csrf') {
    return jsonResponse(403, { ok: false, csrfRequired: true });
  }
  return jsonResponse(200, { ok: true });
};
const parallel = await Promise.all([
  cretliApiFetch('/api/settings', { method: 'PATCH', body: '{}' }),
  cretliApiFetch('/api/logout', { method: 'POST' }),
]);
assert.equal(parallel[0].status, 200);
assert.equal(parallel[1].status, 200);
assert.equal(calls.filter((item) => item.url.includes('/api/auth-status')).length, 1);

calls.length = 0;
setCsrfToken('stale-csrf');
globalThis.fetch = async (url) => {
  calls.push(String(url));
  if (String(url).includes('/api/auth-status')) {
    return jsonResponse(403, { ok: false, csrfRequired: true });
  }
  return jsonResponse(403, { ok: false, csrfRequired: true });
};
const noLoop = await cretliApiFetch('/api/settings', { method: 'PATCH', body: '{}' });
assert.equal(noLoop.status, 403);
assert.equal(calls.filter((item) => item.includes('/api/auth-status')).length, 1);
assert.equal(calls.filter((item) => item.includes('/api/settings')).length, 1);

calls.length = 0;
setCsrfToken('stale-csrf');
globalThis.fetch = async (url) => {
  calls.push(String(url));
  if (String(url).includes('/api/settings')) {
    return jsonResponse(403, { ok: false, error: 'forbidden' });
  }
  return jsonResponse(200, { ok: true, csrfToken: 'should-not-use' });
};
const ambiguous = await cretliApiFetch('/api/settings', { method: 'PATCH', body: '{}' });
assert.equal(ambiguous.status, 403);
assert.equal(calls.length, 1);

calls.length = 0;
globalThis.fetch = async () => {
  calls.push('net');
  throw new Error('network down');
};
await assert.rejects(() => cretliApiFetch('/api/settings', { method: 'PATCH', body: '{}' }), /network down/);
assert.equal(calls.length, 1);

setCsrfToken('keep-me');
globalThis.fetch = async () => jsonResponse(401, { ok: false, authRequired: true });
const unauthorized = await cretliApiFetch('/api/settings', { method: 'GET' });
assert.equal(unauthorized.status, 401);
assert.equal(getCsrfToken(), '');

setCsrfToken('csrf-token-1');
setWidgetAccessToken('widget-token-1');
calls.length = 0;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), headers: { ...init.headers } });
  return jsonResponse(200, { ok: true });
};
await cretliApiFetch('https://evil.example/api/chats', { method: 'POST', body: '{}' }, { pageOrigin });
assert.equal(calls[0].headers['X-Cretli-Csrf'], undefined);
assert.equal(calls[0].headers.Authorization, undefined);

globalThis.fetch = originalFetch;
setCsrfToken('');
setWidgetAccessToken('');
console.log('All cretli-api-request tests passed.');
