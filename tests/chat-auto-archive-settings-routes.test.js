/**
 * Automatic idle-chat archiving settings route contract.
 *
 * Boots the real `registerSettingsRoutes` handlers against an isolated data
 * dir and checks the GET/PATCH contract used by Settings → Chat & agents →
 * General. No network and no real HTTP server.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSettingsRoutes } from '../lib/routes/settings-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

test.after(() => {
  removeIsolatedDataDir();
});

const DAY_MS = 24 * 60 * 60 * 1000;

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
    frontHmrEnabled: false,
    frontHmrForcedByEnv: false,
    frontHotFallbackEnabled: false,
    getLanHost: () => null,
    getConfiguredWorkspaceSelection: () => ({ workspaceFile: '', workspaceFolder: '' }),
    isSessionSyncEnabled: () => false,
    resolveFrontHmrEnabledFromSettings: () => false,
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

test('auto-archive settings default to off with a 30-day window', async () => {
  const client = createSettingsClient();
  const res = await client.get();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.chatAutoArchive, {
    enabled: false,
    idleValue: 30,
    idleUnit: 'days',
    idleMs: 30 * DAY_MS,
  });
});

test('PATCH persists the auto-archive toggle and a minutes window', async () => {
  const client = createSettingsClient();
  const patched = await client.patch({ chatAutoArchive: { enabled: true, idleValue: 15, idleUnit: 'minutes' } });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.chatAutoArchive, {
    enabled: true,
    idleValue: 15,
    idleUnit: 'minutes',
    idleMs: 15 * 60_000,
  });

  const reloaded = await client.get();
  assert.deepEqual(reloaded.body.chatAutoArchive, {
    enabled: true,
    idleValue: 15,
    idleUnit: 'minutes',
    idleMs: 15 * 60_000,
  });
});

test('an out-of-range value is rejected and does not change the stored window', async () => {
  const client = createSettingsClient();
  await client.patch({ chatAutoArchive: { enabled: true, idleValue: 5, idleUnit: 'hours' } });

  for (const idleValue of [0, -1, 8_761, 10_000_000]) {
    const rejected = await client.patch({ chatAutoArchive: { idleValue } });
    assert.equal(rejected.status, 400, `idleValue=${idleValue} must be rejected`);
    assert.equal(rejected.body.ok, false);
  }

  const reloaded = await client.get();
  assert.deepEqual(reloaded.body.chatAutoArchive, {
    enabled: true,
    idleValue: 5,
    idleUnit: 'hours',
    idleMs: 5 * 60 * 60_000,
  });
});

test('an unknown unit is rejected', async () => {
  const client = createSettingsClient();
  const rejected = await client.patch({ chatAutoArchive: { idleValue: 3, idleUnit: 'weeks' } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.ok, false);
});

test('a non-boolean enabled value is ignored', async () => {
  const client = createSettingsClient();
  await client.patch({ chatAutoArchive: { enabled: true, idleValue: 3, idleUnit: 'days' } });
  const patched = await client.patch({ chatAutoArchive: { enabled: 'yes' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.chatAutoArchive.enabled, true);
  assert.equal(patched.body.chatAutoArchive.idleValue, 3);
  assert.equal(patched.body.chatAutoArchive.idleUnit, 'days');
});
