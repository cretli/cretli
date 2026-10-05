/**
 * Sidebar Workspace Watcher toggles.
 *
 * The master switch maps to the server-wide start gate and must stay durable
 * across refreshes; a per-workspace switch maps to `mode: autopilot|off` and must
 * send the workspace folder. Both actions are plain REST PATCHes, so a fake
 * `fetch` proves the exact request bodies and the optimistic local state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkspaceWatcherRuntimeControl,
  getWorkspaceWatcherRuntimeControl,
  isWorkspaceWatcherStartsEnabled,
  refreshWorkspaceWatcherRuntimeControl,
  setWorkspaceWatcherEnabled,
  setWorkspaceWatcherStartsEnabled,
  workspaceWatcherRuntimeRevision,
  __resetWorkspaceWatcherToggleForTest,
} from '../app_front/features/sidebar/workspaceWatcherToggle.js';

/**
 * @param {object} payload
 * @param {{ ok?: boolean, status?: number }} [options]
 */
function jsonResponse(payload, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    json: async () => payload,
  };
}

test('the master gate defaults to enabled and tracks revisions', () => {
  __resetWorkspaceWatcherToggleForTest();
  assert.equal(isWorkspaceWatcherStartsEnabled(), true);
  const rev0 = workspaceWatcherRuntimeRevision();
  assert.equal(applyWorkspaceWatcherRuntimeControl({ startsEnabled: false }), true);
  assert.equal(isWorkspaceWatcherStartsEnabled(), false);
  assert.ok(workspaceWatcherRuntimeRevision() > rev0, 'revision advances on a change');
  assert.equal(applyWorkspaceWatcherRuntimeControl({ startsEnabled: false }), false, 'idempotent');
  assert.equal(workspaceWatcherRuntimeRevision(), rev0 + 1);
  // A damaged/unknown control file fails closed: unavailable means blocked.
  applyWorkspaceWatcherRuntimeControl({ startsEnabled: true, statusUnavailable: true });
  assert.equal(isWorkspaceWatcherStartsEnabled(), false);
});

test('refreshWorkspaceWatcherRuntimeControl applies the fetched gate', async () => {
  __resetWorkspaceWatcherToggleForTest();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    return jsonResponse({ ok: true, runtimeControl: { startsEnabled: false } });
  };
  assert.equal(await refreshWorkspaceWatcherRuntimeControl(fetchImpl), true);
  assert.deepEqual(calls, [{ url: '/api/workspace-watcher/runtime-control', method: 'GET' }]);
  assert.equal(getWorkspaceWatcherRuntimeControl().startsEnabled, false);
});

test('refreshWorkspaceWatcherRuntimeControl tolerates a failed response', async () => {
  __resetWorkspaceWatcherToggleForTest();
  const fetchImpl = async () => jsonResponse({ ok: false }, { ok: false, status: 500 });
  assert.equal(await refreshWorkspaceWatcherRuntimeControl(fetchImpl), false);
  assert.equal(isWorkspaceWatcherStartsEnabled(), true, 'state untouched on failure');
});

test('setWorkspaceWatcherStartsEnabled PATCHes the runtime gate', async () => {
  __resetWorkspaceWatcherToggleForTest();
  let seen = null;
  const fetchImpl = async (url, init = {}) => {
    seen = { url, method: init.method, body: JSON.parse(init.body) };
    return jsonResponse({ ok: true, runtimeControl: { startsEnabled: false } });
  };
  const result = await setWorkspaceWatcherStartsEnabled(false, fetchImpl);
  assert.equal(result.ok, true);
  assert.deepEqual(seen, {
    url: '/api/workspace-watcher/runtime-control',
    method: 'PATCH',
    body: { startsEnabled: false },
  });
  assert.equal(isWorkspaceWatcherStartsEnabled(), false);
});

test('setWorkspaceWatcherEnabled PATCHes autopilot/off for one folder', async () => {
  __resetWorkspaceWatcherToggleForTest();
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, method: init.method, body: JSON.parse(init.body) });
    return jsonResponse({ ok: true });
  };
  const on = await setWorkspaceWatcherEnabled('/repo/one', true, fetchImpl);
  assert.equal(on.ok, true);
  const off = await setWorkspaceWatcherEnabled('/repo/one', false, fetchImpl);
  assert.equal(off.ok, true);
  assert.deepEqual(seen, [
    { url: '/api/workspace-watcher', method: 'PATCH', body: { workspaceFolder: '/repo/one', mode: 'autopilot' } },
    { url: '/api/workspace-watcher', method: 'PATCH', body: { workspaceFolder: '/repo/one', mode: 'off' } },
  ]);
});

test('setWorkspaceWatcherEnabled rejects an empty folder and a failed write', async () => {
  __resetWorkspaceWatcherToggleForTest();
  assert.equal((await setWorkspaceWatcherEnabled('', true, async () => jsonResponse({ ok: true }))).ok, false);
  const failed = await setWorkspaceWatcherEnabled(
    '/repo/one',
    false,
    async () => jsonResponse({ ok: false, error: 'locked' }, { ok: false, status: 503 }),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'locked');
});
