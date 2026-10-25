import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorkspaceWatcherView } from '../app_front/features/watcher/watcherGetCoalesce.js';
import { cretliApiFetch } from '../app_front/lib/cretliApiRequest.js';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('recent watcher reads are reused until an API write clears them', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const path = '/api/workspace-watcher/runtime-control';
  await getWorkspaceWatcherView(path);
  await getWorkspaceWatcherView(path);
  assert.equal(calls.filter((c) => c.startsWith('GET')).length, 1);
  await cretliApiFetch('/api/workspace-watcher', { method: 'PATCH', body: '{}' });
  await getWorkspaceWatcherView(path);
  assert.equal(calls.filter((c) => c.startsWith('GET')).length, 2);
});
