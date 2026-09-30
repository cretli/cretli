/**
 * HTTP contract tests for the explicit `enabledLocalHarnesses` setting.
 *
 * Boots the real `registerSettingsRoutes` handlers on a real HTTP server behind
 * the real `requireAuth` middleware, so the tests cover the JSON body contract,
 * the existing auth/CSRF gate, discovery-membership validation, atomic
 * rejection and the GET round-trip. Plugin discovery uses a temporary local
 * root set through the server-only `CRETLI_HARNESS_PLUGIN_ROOT` env var; no
 * plugin code is ever imported.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import {
  AUTH_CSRF_HEADER,
  createSession,
  getCsrfTokenForSessionToken,
  requireAuth,
  setPassword,
} from '../lib/auth.js';
import { registerSettingsRoutes } from '../lib/routes/settings-routes.js';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import {
  HARNESS_PLUGIN_ROOT_ENV,
  invalidateHarnessSnapshotCache,
  listLocalHarnessProviders,
} from '../lib/agent-harness/harness-snapshot-registry.js';
import {
  getCachedLocalChatHarness,
  loadLocalChatHarness,
} from '../lib/agent-harness/local-harness-runtime.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const MANIFEST = 'harness-plugin.json';

/** @type {string} */
let pluginRoot;
/** @type {string} */
let missingRoot;
/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let baseUrl;
/** @type {string} */
let sessionToken;
/** @type {string} */
let csrfToken;

/**
 * @param {string} root
 * @param {string} id
 * @returns {Promise<void>}
 */
async function addPlugin(root, id) {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, MANIFEST),
    JSON.stringify({
      apiVersion: 1,
      id,
      version: '1.0.0',
      hostMin: '0.1.0',
      label: `Plugin ${id}`,
      description: `Local plugin ${id}.`,
      origin: 'local',
      entry: 'index.mjs',
      capabilities: { chat: true },
    }),
  );
  await writeFile(
    path.join(dir, 'index.mjs'),
    [
      'export function handleChatWebSocket() {}',
      'export function disposeSession() {}',
      '',
    ].join('\n'),
  );
}

before(async () => {
  pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'cretli-settings-local-'));
  await addPlugin(pluginRoot, 'alpha');
  await addPlugin(pluginRoot, 'beta');
  missingRoot = path.join(os.tmpdir(), `cretli-settings-missing-${process.pid}-${Date.now()}`);

  setPassword('test-password-123');
  sessionToken = createSession();
  csrfToken = getCsrfTokenForSessionToken(sessionToken);
  assert.ok(csrfToken, 'CSRF token must exist for the test session');

  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  registerSettingsRoutes(app, {
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
  });
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  invalidateHarnessSnapshotCache();
  saveSettings({});
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pluginRoot) await rm(pluginRoot, { recursive: true, force: true });
  delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  invalidateHarnessSnapshotCache();
  removeIsolatedDataDir();
});

/**
 * @param {string | null} root
 * @returns {void}
 */
function useRoot(root) {
  if (root) process.env[HARNESS_PLUGIN_ROOT_ENV] = root;
  else delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  invalidateHarnessSnapshotCache();
}

/**
 * @param {{ csrf?: boolean }} [options]
 * @returns {Record<string, string>}
 */
function authHeaders(options = {}) {
  const headers = { cookie: `cr_session=${encodeURIComponent(sessionToken)}` };
  if (options.csrf !== false) headers[AUTH_CSRF_HEADER] = csrfToken;
  return headers;
}

/**
 * @param {string} method
 * @param {object} [body]
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function request(method, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (typeof body !== 'undefined') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}/api/settings`, init);
  return { status: response.status, body: await response.json() };
}

test('GET requires a session and defaults enabledLocalHarnesses to an empty array', async () => {
  const anonymous = await request('GET');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.authRequired, true);

  const res = await request('GET', undefined, authHeaders());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.enabledLocalHarnesses, []);
});

test('PATCH reuses the existing auth and CSRF guard', async () => {
  const anonymous = await request('PATCH', { enabledLocalHarnesses: [] });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.authRequired, true);

  const noCsrf = await request('PATCH', { enabledLocalHarnesses: [] }, authHeaders({ csrf: false }));
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.csrfRequired, true);

  const authed = await request('PATCH', { enabledLocalHarnesses: [] }, authHeaders());
  assert.equal(authed.status, 200);
});

test('PATCH persists normalized discovered local ids and GET round-trips them', async () => {
  useRoot(pluginRoot);
  const patched = await request(
    'PATCH',
    { enabledLocalHarnesses: ['  ALPHA ', 'beta', 'beta'] },
    authHeaders(),
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.ok, true);
  assert.deepEqual(patched.body.enabledLocalHarnesses, ['alpha', 'beta']);
  assert.deepEqual(loadSettings().enabledLocalHarnesses, ['alpha', 'beta']);

  const got = await request('GET', undefined, authHeaders());
  assert.deepEqual(got.body.enabledLocalHarnesses, ['alpha', 'beta']);
});

test('PATCH [] clears the field and persists no empty array', async () => {
  useRoot(pluginRoot);
  await request('PATCH', { enabledLocalHarnesses: ['alpha'] }, authHeaders());
  assert.deepEqual(loadSettings().enabledLocalHarnesses, ['alpha']);

  const cleared = await request('PATCH', { enabledLocalHarnesses: [] }, authHeaders());
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.enabledLocalHarnesses, []);
  assert.equal('enabledLocalHarnesses' in loadSettings(), false);

  const restored = await request('PATCH', { enabledLocalHarnesses: ['alpha'] }, authHeaders());
  assert.deepEqual(restored.body.enabledLocalHarnesses, ['alpha']);
});

test('PATCH rejects a non-array field without writing', async () => {
  useRoot(pluginRoot);
  for (const raw of ['alpha', { alpha: true }, 42, null]) {
    const res = await request('PATCH', { enabledLocalHarnesses: raw }, authHeaders());
    assert.equal(res.status, 400, JSON.stringify(raw));
    assert.equal(res.body.ok, false, JSON.stringify(raw));
    assert.equal('enabledLocalHarnesses' in loadSettings(), false, JSON.stringify(raw));
  }
});

test('PATCH rejects reserved, malformed and undiscovered ids atomically', async () => {
  useRoot(pluginRoot);
  for (const raw of [['sdk'], ['cursor'], ['bad id'], ['-leading'], [''], ['ghost']]) {
    const res = await request('PATCH', { enabledLocalHarnesses: raw }, authHeaders());
    assert.equal(res.status, 400, JSON.stringify(raw));
    assert.equal(res.body.ok, false, JSON.stringify(raw));
    assert.equal('enabledLocalHarnesses' in loadSettings(), false, JSON.stringify(raw));
  }
});

test('a rejected local update does not partially save another field', async () => {
  useRoot(pluginRoot);
  const res = await request(
    'PATCH',
    { lanHost: 'should-not-persist', enabledLocalHarnesses: ['ghost'] },
    authHeaders(),
  );
  assert.equal(res.status, 400);
  assert.equal('lanHost' in loadSettings(), false);
  assert.equal('enabledLocalHarnesses' in loadSettings(), false);
});

test('a non-empty update fails closed without a plugin root and leaks no path', async () => {
  useRoot(null);
  const res = await request('PATCH', { enabledLocalHarnesses: ['alpha'] }, authHeaders());
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes(HARNESS_PLUGIN_ROOT_ENV), false);
  assert.equal(serialized.includes(pluginRoot), false);
  assert.equal('enabledLocalHarnesses' in loadSettings(), false);

  // An empty clear still succeeds without any discovery.
  const cleared = await request('PATCH', { enabledLocalHarnesses: [] }, authHeaders());
  assert.equal(cleared.status, 200);
});

test('a discovery failure (missing root dir) fails closed with a generic error', async () => {
  useRoot(missingRoot);
  const res = await request('PATCH', { enabledLocalHarnesses: ['alpha'] }, authHeaders());
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  const serialized = JSON.stringify(res.body);
  assert.equal(serialized.includes(missingRoot), false, 'the root path must not leak');
  assert.equal(serialized.includes(HARNESS_PLUGIN_ROOT_ENV), false);
  assert.equal('enabledLocalHarnesses' in loadSettings(), false);
});

test('GET exposes syntactically valid saved local ids even when discovery is empty', async () => {
  useRoot(null);
  saveSettings({
    enabledLocalHarnesses: ['alpha', 'ghost', 'sdk', 'bad id', 42, 'BETA', 'alpha'],
  });
  const res = await request('GET', undefined, authHeaders());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.enabledLocalHarnesses, ['alpha', 'ghost', 'beta']);
  // GET must not destructively prune the saved value.
  assert.deepEqual(
    loadSettings().enabledLocalHarnesses,
    ['alpha', 'ghost', 'sdk', 'bad id', 42, 'BETA', 'alpha'],
  );
});

test('enabledHarnesses stays builtin-only and separate from the local list', async () => {
  useRoot(pluginRoot);
  const patched = await request('PATCH', { enabledHarnesses: ['sdk'] }, authHeaders());
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.enabledHarnesses, ['sdk']);
  assert.deepEqual(loadSettings().enabledHarnesses, ['sdk']);
  assert.equal('enabledLocalHarnesses' in loadSettings(), false);

  // A local id in the builtin list is still normalized out.
  const localInBuiltins = await request(
    'PATCH',
    { enabledHarnesses: ['sdk', 'alpha'] },
    authHeaders(),
  );
  assert.equal(localInBuiltins.status, 200);
  assert.deepEqual(loadSettings().enabledHarnesses, ['sdk']);
  assert.equal('enabledLocalHarnesses' in loadSettings(), false);
});

test('PATCH enabledLocalHarnesses re-scans discovery instead of trusting a stale snapshot', async (t) => {
  useRoot(pluginRoot);
  // Prime the memoized catalog with the current disk (alpha, beta).
  const primed = await listLocalHarnessProviders({ settings: {} });
  assert.deepEqual(primed.map((row) => row.id).sort(), ['alpha', 'beta']);

  // A new plugin appears only after the snapshot was cached.
  await addPlugin(pluginRoot, 'gamma');
  t.after(() => rm(path.join(pluginRoot, 'gamma'), { recursive: true, force: true }));

  const patched = await request('PATCH', { enabledLocalHarnesses: ['gamma'] }, authHeaders());
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.enabledLocalHarnesses, ['gamma']);
  assert.deepEqual(loadSettings().enabledLocalHarnesses, ['gamma']);
});

test('a successful enabledLocalHarnesses PATCH clears the loaded module cache', async () => {
  useRoot(pluginRoot);
  const loaded = await loadLocalChatHarness('alpha', {
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
  });
  assert.equal(loaded.ok, true);
  assert.ok(getCachedLocalChatHarness('alpha'));

  const patched = await request('PATCH', { enabledLocalHarnesses: ['alpha'] }, authHeaders());
  assert.equal(patched.status, 200);
  assert.equal(getCachedLocalChatHarness('alpha'), null);
});

test('a rejected enabledLocalHarnesses PATCH keeps the loaded module cache', async () => {
  useRoot(pluginRoot);
  const loaded = await loadLocalChatHarness('alpha', {
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
  });
  assert.equal(loaded.ok, true);
  assert.ok(getCachedLocalChatHarness('alpha'));

  const rejected = await request('PATCH', { enabledLocalHarnesses: ['ghost'] }, authHeaders());
  assert.equal(rejected.status, 400);
  assert.ok(getCachedLocalChatHarness('alpha'), 'a rejected update must not drop loaded modules');
});

test('a PATCH without enabledLocalHarnesses keeps the loaded module cache', async () => {
  useRoot(pluginRoot);
  const loaded = await loadLocalChatHarness('alpha', {
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
  });
  assert.equal(loaded.ok, true);
  assert.ok(getCachedLocalChatHarness('alpha'));

  const patched = await request('PATCH', { lanHost: 'test-lan-host' }, authHeaders());
  assert.equal(patched.status, 200);
  assert.ok(getCachedLocalChatHarness('alpha'), 'an unrelated PATCH must not drop loaded modules');
});

test('the settings module registers no new route', () => {
  const source = readFileSync(
    new URL('../lib/routes/settings-routes.js', import.meta.url),
    'utf8',
  );
  const matches = source.match(/app\.(?:get|post|put|patch|delete)\(\s*'\/api\/settings'/g) || [];
  assert.equal(matches.length, 2, 'only the existing GET/PATCH /api/settings routes');
});

console.log('harness-plugin-settings-routes.test.js OK');
