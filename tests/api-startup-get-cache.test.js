import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, patchSettings, getGitInfo, sharedStartupGet, invalidateStartupGetCache } from '../app_front/core/api/index.js';

const originalFetch = globalThis.fetch;

function installFetch() {
  const calls = [];
  let settingsVersion = 1;
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (method === 'PATCH') settingsVersion += 1;
    const body = String(url).startsWith('/api/settings') ? { ok: true, v: settingsVersion } : { ok: true, branch: 'main' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateStartupGetCache();
});

test('concurrent and repeated settings reads share one request', async () => {
  const calls = installFetch();
  const [a, b] = await Promise.all([getSettings(), getSettings()]);
  const c = await getSettings();
  assert.equal(a.v, 1);
  assert.equal(b.v, 1);
  assert.equal(c.v, 1);
  assert.equal(calls.filter((x) => x === 'GET /api/settings').length, 1);
  a.v = 99;
  assert.equal((await getSettings()).v, 1, 'callers get independent copies');
});

test('a settings write invalidates the cached read', async () => {
  const calls = installFetch();
  assert.equal((await getSettings()).v, 1);
  await patchSettings({ lanHost: 'x' });
  assert.equal((await getSettings()).v, 2);
  assert.equal(calls.filter((x) => x === 'GET /api/settings').length, 2);
});

test('git info is shared per scope URL and failures are not cached', async () => {
  const calls = installFetch();
  await Promise.all([getGitInfo(), getGitInfo()]);
  assert.equal(calls.filter((x) => x.startsWith('GET /api/git/info')).length, 1);
  let n = 0;
  const loader = async () => (n += 1) === 1 ? { ok: false } : { ok: true, n };
  assert.equal((await sharedStartupGet('k', loader)).ok, false);
  assert.equal((await sharedStartupGet('k', loader)).n, 2);
});

test('a write landing during an in-flight read prevents caching that read', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let n = 0;
  const loader = async () => { n += 1; const mine = n; await gate; return { ok: true, n: mine }; };
  const first = sharedStartupGet('race', loader);
  invalidateStartupGetCache(); // a write lands while the read is in flight
  release();
  assert.equal((await first).n, 1);
  assert.equal((await sharedStartupGet('race', loader)).n, 2, 'stale result must not be cached');
});

test('notification list fetches are never served from the startup cache', async () => {
  const calls = installFetch();
  const { createNotificationCenterApi } = await import('../app_front/features/notifications/notificationCenter.js');
  const api = createNotificationCenterApi();
  await api.fetchList();
  await api.fetchList();
  assert.equal(calls.filter((x) => x === 'GET /api/notifications').length, 2);
});

test('git info backs off after a failure and a write resets it', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  };
  await getGitInfo();
  const again = await getGitInfo();
  assert.equal(n, 1, 'second call is served from the backoff');
  assert.equal(again.ok, false);
});
