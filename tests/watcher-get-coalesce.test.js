import { setSharedViewContextStore } from '../app_front/app/appShell/viewContextBridge.js';
import assert from 'node:assert/strict';
import { getWorkspaceWatcherView, isWorkspaceWatcherRead } from '../app_front/features/watcher/watcherGetCoalesce.js';

assert.equal(isWorkspaceWatcherRead('/api/workspace-watcher'), true);
assert.equal(isWorkspaceWatcherRead('/api/workspace-watcher?workspaceFolder=%2Fw'), true);
assert.equal(isWorkspaceWatcherRead('/api/workspace-watcher', { method: 'POST', body: '{}' }), false);
assert.equal(isWorkspaceWatcherRead('/api/todos'), false);

const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return new Response(JSON.stringify({ ok: true, mode: 'observe' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

try {
  const path = '/api/workspace-watcher?workspaceFolder=%2Ftmp%2Fapp';
  const [first, second] = await Promise.all([
    getWorkspaceWatcherView(path),
    getWorkspaceWatcherView(path),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.status, 200);
  assert.equal(second.json?.mode, 'observe');
  assert.equal(first, second);

  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ ok: true, scope: url }), { status: 200 });
  };
  let folder = '/ws/coalesce-a';
  setSharedViewContextStore({ getState: () => ({ runtime: { workspaceFolder: folder } }) });
  const a = getWorkspaceWatcherView('/api/workspace-watcher');
  assert.equal(getWorkspaceWatcherView('/api/workspace-watcher'), a);
  folder = '/ws/coalesce-b';
  const b = getWorkspaceWatcherView('/api/workspace-watcher');
  assert.notEqual(a, b, 'concurrent workspace reads must not share a response');
  await Promise.all([a, b]);
  assert.deepEqual(urls.map((url) => new URL(url, 'http://localhost').searchParams.get('workspaceFolder')),
    ['/ws/coalesce-a', '/ws/coalesce-b']);
  assert.equal(getWorkspaceWatcherView('/api/workspace-watcher'), b, 'recent reads stay in their workspace');
  folder = '/ws/coalesce-a';
  assert.equal(getWorkspaceWatcherView('/api/workspace-watcher'), a);
  setSharedViewContextStore(null);

  calls = 0;
  const rejectPath = '/api/workspace-watcher?workspaceFolder=%2Ftmp%2Freject';
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('network down');
  };
  const shared = getWorkspaceWatcherView(rejectPath);
  const duplicate = getWorkspaceWatcherView(rejectPath);
  assert.equal(shared, duplicate);
  assert.equal(calls, 1);
  await assert.rejects(shared, /network down/);
  await new Promise((resolve) => setImmediate(resolve));

  console.log('watcher-get-coalesce.test.js ok');
} finally {
  setSharedViewContextStore(null);
  globalThis.fetch = originalFetch;
}
