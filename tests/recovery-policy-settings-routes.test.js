/**
 * Chat restart recovery mode (R14) settings route contract.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSettingsRoutes } from '../lib/routes/settings-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

test.after(() => {
  removeIsolatedDataDir();
});


/** Register the settings routes on a tiny fake express app. */
function createSettingsClient() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(path, fn) {
      handlers.set(`GET ${path}`, fn);
    },
    patch(path, fn) {
      handlers.set(`PATCH ${path}`, fn);
    },
    post(path, fn) {
      handlers.set(`POST ${path}`, fn);
    },
  };
  const ctx = {
    port: 0,
    useHttps: false,
    serverInstanceToken: 'test-instance-token',
    frontHotFallbackEnabled: false,
    getLanHost: () => null,
    getConfiguredWorkspaceSelection: () => ({ workspaceFile: '', workspaceFolder: '' }),
    isSessionSyncEnabled: () => false,
  };
  registerSettingsRoutes(app, ctx);

  function call(method, body) {
    const handler = handlers.get(`${method} /api/settings`);
    assert.ok(handler, `missing ${method} /api/settings handler`);
    const req = { body: body || {}, headers: {} };
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          resolve({ status: this.statusCode, body: payload });
        },
      };
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((err) => resolve({ status: 500, body: { ok: false, error: err?.message || String(err) } }));
    });
  }

  return {
    get: () => call('GET'),
    patch: (body) => call('PATCH', body),
  };
}

test('recovery mode defaults to manual, patches globally and per workspace', async () => {
  const client = createSettingsClient();
  const first = await client.get();
  assert.deepEqual(first.body.chatRestartRecovery, { mode: 'manual', workspaces: {} });
  const bad = await client.patch({ chatRestartRecoveryMode: 'always' });
  assert.equal(bad.status, 400);
  const set = await client.patch({
    chatRestartRecoveryMode: 'automatic',
    chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a', mode: 'off' },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.chatRestartRecovery, { mode: 'automatic', workspaces: { '/w/a': 'off' } });
  const invalidGlobal = await client.patch({ chatRestartRecoveryMode: ['automatic'] });
  assert.equal(invalidGlobal.status, 400);
  assert.deepEqual((await client.get()).body.chatRestartRecovery, { mode: 'automatic', workspaces: { '/w/a': 'off' } });
  const invalidWorkspace = await client.patch({
    chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a', mode: [] },
  });
  assert.equal(invalidWorkspace.status, 400);
  assert.deepEqual((await client.get()).body.chatRestartRecovery, { mode: 'automatic', workspaces: { '/w/a': 'off' } });
  const missingWorkspaceMode = await client.patch({
    chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a' },
  });
  assert.equal(missingWorkspaceMode.status, 400);
  assert.deepEqual((await client.get()).body.chatRestartRecovery, { mode: 'automatic', workspaces: { '/w/a': 'off' } });
  const omitted = await client.patch({});
  assert.deepEqual(omitted.body.chatRestartRecovery, { mode: 'automatic', workspaces: { '/w/a': 'off' } });
  const cleared = await client.patch({ chatRestartRecoveryWorkspace: { workspaceFolder: '/w/a', mode: '' } });
  assert.deepEqual(cleared.body.chatRestartRecovery, { mode: 'automatic', workspaces: {} });
});
