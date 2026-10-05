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
  console.log('watcher-get-coalesce.test.js ok');
} finally {
  globalThis.fetch = originalFetch;
}
