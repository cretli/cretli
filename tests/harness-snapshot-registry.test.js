import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_TRANSPORTS } from '../lib/agent-transport.js';
import { listHarnessCatalog } from '../lib/harness-catalog.js';
import { saveSettings } from '../lib/persist/settings.js';
import {
  HARNESS_PLUGIN_ROOT_ENV,
  LOCAL_PROVIDER_STATE,
  invalidateHarnessSnapshotCache,
  listLocalHarnessProviders,
  readHarnessPluginRoot,
} from '../lib/agent-harness/harness-snapshot-registry.js';
import {
  dispatchLocalHarnessWebSocket,
  disposeLocalHarnessSession,
  getCachedLocalChatHarness,
} from '../lib/agent-harness/local-harness-runtime.js';

const MANIFEST = 'harness-plugin.json';
const BUILTIN_ROW_KEYS = ['id', 'label', 'enabled', 'ready', 'available', 'can_delegate', 'usage_limit'];

let originalRootEnv;

before(() => {
  originalRootEnv = process.env[HARNESS_PLUGIN_ROOT_ENV];
});

after(() => {
  if (originalRootEnv === undefined) delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  else process.env[HARNESS_PLUGIN_ROOT_ENV] = originalRootEnv;
  invalidateHarnessSnapshotCache();
  removeIsolatedDataDir();
});

beforeEach(() => {
  delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  invalidateHarnessSnapshotCache();
  saveSettings({});
});

/**
 * @param {import('node:test').TestContext} t
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function makeTmp(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** @returns {object} */
function localManifest(id, overrides = {}) {
  return {
    apiVersion: 1,
    id,
    version: '1.0.0',
    hostMin: '0.1.0',
    label: `Plugin ${id}`,
    description: `Local plugin ${id}.`,
    origin: 'local',
    entry: 'index.mjs',
    capabilities: { chat: true },
    ...overrides,
  };
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {object | string} manifest
 * @param {{ writeEntry?: boolean }} [options]
 * @returns {Promise<string>}
 */
async function addPlugin(root, dir, manifest, options = {}) {
  const pluginDir = path.join(root, dir);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, MANIFEST),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  );
  const writeEntry = options.writeEntry !== false;
  if (writeEntry && manifest && typeof manifest === 'object' && manifest.entry) {
    const entrySource = typeof options.entrySource === 'string'
      ? options.entrySource
      : 'export default 1;\n';
    await writeFile(path.join(pluginDir, manifest.entry), entrySource);
  }
  return pluginDir;
}

test('reads the plugin root only from the server-controlled env var', () => {
  assert.equal(readHarnessPluginRoot({}), '');
  assert.equal(readHarnessPluginRoot({ [HARNESS_PLUGIN_ROOT_ENV]: '  /tmp/plugins  ' }), '/tmp/plugins');
  assert.equal(readHarnessPluginRoot({ [HARNESS_PLUGIN_ROOT_ENV]: 42 }), '');
  assert.equal(readHarnessPluginRoot({ [HARNESS_PLUGIN_ROOT_ENV]: null }), '');
});

test('with no plugin root the catalog is exactly the eight built-in rows', async () => {
  assert.equal(readHarnessPluginRoot(process.env), '');
  const rows = await listHarnessCatalog();
  assert.equal(rows.length, AGENT_TRANSPORTS.length);
  assert.deepEqual(rows.map((row) => row.id), AGENT_TRANSPORTS.slice());
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), BUILTIN_ROW_KEYS, `built-in ${row.id} shape changed`);
    assert.equal('origin' in row, false);
    assert.equal('state' in row, false);
    assert.equal('entry' in row, false);
  }
});

test('a discovered local plugin yields a safe, not-loaded, non-delegatable row', async (t) => {
  const root = await makeTmp(t, 'cretli-snapshot-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'));
  process.env[HARNESS_PLUGIN_ROOT_ENV] = root;
  invalidateHarnessSnapshotCache();

  const rows = await listLocalHarnessProviders({ settings: {} });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, 'alpha');
  assert.equal(row.origin, 'local');
  assert.equal(row.label, 'Plugin alpha');
  assert.equal(row.description, 'Local plugin alpha.');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.hostMin, '0.1.0');
  assert.equal(row.apiVersion, 1);
  assert.deepEqual(row.capabilities, {
    chat: true,
    models: false,
    status: false,
    settings: false,
    mcp: false,
    delegation: false,
    serverRun: false,
  });
  assert.equal(row.enabled, false);
  assert.equal(row.ready, false);
  assert.equal(row.available, false);
  assert.equal(row.can_delegate, false);
  assert.equal(row.state, LOCAL_PROVIDER_STATE);
  assert.equal(row.usage_limit, null);
  assert.equal('entry' in row, false);
  assert.equal('path' in row, false);

  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes(root), false, 'absolute root must not leak');
  assert.equal(serialized.includes('index.mjs'), false, 'entry path must not leak');
  assert.equal(serialized.includes(MANIFEST), false);
});

test('a broken plugin root keeps the built-in rows and leaks no path', async () => {
  const missing = path.join(os.tmpdir(), `cretli-missing-root-${process.pid}`);
  process.env[HARNESS_PLUGIN_ROOT_ENV] = missing;
  invalidateHarnessSnapshotCache();

  const rows = await listHarnessCatalog();
  assert.equal(rows.length, AGENT_TRANSPORTS.length);
  assert.deepEqual(rows.map((row) => row.id), AGENT_TRANSPORTS.slice());
  assert.equal(JSON.stringify(rows).includes(missing), false);

  assert.deepEqual(await listLocalHarnessProviders({ settings: {} }), []);
});

test('malformed siblings are dropped while valid locals and built-ins survive', async (t) => {
  const root = await makeTmp(t, 'cretli-snapshot-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'));
  await addPlugin(root, 'bad-json', '{ not valid json');
  await addPlugin(root, 'bad-entry', localManifest('bad-entry', { entry: 'missing.mjs' }), {
    writeEntry: false,
  });
  process.env[HARNESS_PLUGIN_ROOT_ENV] = root;
  invalidateHarnessSnapshotCache();

  const rows = await listHarnessCatalog();
  const ids = rows.map((row) => row.id);
  assert.equal(rows.length, AGENT_TRANSPORTS.length + 1);
  assert.equal(ids.includes('alpha'), true);
  assert.equal(ids.includes('bad-entry'), false);
  assert.equal(ids.includes('bad-json'), false);

  for (const row of rows.filter((entry) => AGENT_TRANSPORTS.includes(entry.id))) {
    assert.deepEqual(Object.keys(row), BUILTIN_ROW_KEYS, `built-in ${row.id} shape changed`);
  }

  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('missing.mjs'), false);
});

test('local enabled derives only from enabledLocalHarnesses, never enabledHarnesses', async (t) => {
  const root = await makeTmp(t, 'cretli-snapshot-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'));
  process.env[HARNESS_PLUGIN_ROOT_ENV] = root;

  const cases = [
    { settings: {}, expected: false },
    { settings: { enabledHarnesses: null }, expected: false },
    { settings: { enabledHarnesses: [] }, expected: false },
    { settings: { enabledHarnesses: AGENT_TRANSPORTS.slice() }, expected: false },
    { settings: { enabledHarnesses: [...AGENT_TRANSPORTS, 'alpha'] }, expected: false },
    { settings: { enabledHarnesses: ['alpha'] }, expected: false },
    { settings: { enabledHarnesses: ['sdk'] }, expected: false },
    { settings: { enabledLocalHarnesses: null }, expected: false },
    { settings: { enabledLocalHarnesses: [] }, expected: false },
    { settings: { enabledLocalHarnesses: ['alpha'] }, expected: true },
    { settings: { enabledLocalHarnesses: ['  ALPHA '] }, expected: true },
    { settings: { enabledLocalHarnesses: ['sdk'] }, expected: false },
    { settings: { enabledLocalHarnesses: ['beta'] }, expected: false },
    { settings: { enabledHarnesses: ['sdk'], enabledLocalHarnesses: ['alpha'] }, expected: true },
  ];
  for (const { settings, expected } of cases) {
    const rows = await listLocalHarnessProviders({ settings });
    assert.equal(rows.length, 1, JSON.stringify(settings));
    assert.equal(rows[0].enabled, expected, JSON.stringify(settings));
  }
});

test('discovery is memoized per root and only an explicit invalidation re-scans', async (t) => {
  const root = await makeTmp(t, 'cretli-snapshot-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'));
  process.env[HARNESS_PLUGIN_ROOT_ENV] = root;
  invalidateHarnessSnapshotCache();

  const first = await listLocalHarnessProviders({ settings: {} });
  assert.deepEqual(first.map((row) => row.id), ['alpha']);

  await addPlugin(root, 'beta', localManifest('beta'));
  const cached = await listLocalHarnessProviders({ settings: {} });
  assert.deepEqual(cached.map((row) => row.id), ['alpha'], 'cached call must not rescan');

  invalidateHarnessSnapshotCache();
  const rescanned = await listLocalHarnessProviders({ settings: {} });
  assert.deepEqual(rescanned.map((row) => row.id), ['alpha', 'beta']);
});

test('a legacy cursor settings list keeps sdk on and locals off', async (t) => {
  const root = await makeTmp(t, 'cretli-snapshot-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'));
  process.env[HARNESS_PLUGIN_ROOT_ENV] = root;
  invalidateHarnessSnapshotCache();
  saveSettings({ enabledHarnesses: ['cursor'] });

  const rows = await listHarnessCatalog();
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get('sdk').enabled, true);
  assert.equal(byId.get('opencode').enabled, false);
  assert.equal(byId.get('alpha').enabled, false);

  const locals = await listLocalHarnessProviders({ settings: { enabledHarnesses: ['cursor'] } });
  assert.equal(locals[0].enabled, false);

  // The separate local list is the only thing that can turn the plugin on.
  const explicitLocal = await listLocalHarnessProviders({
    settings: { enabledHarnesses: ['cursor'], enabledLocalHarnesses: ['alpha'] },
  });
  assert.equal(explicitLocal[0].enabled, true);
});

test('invalidateHarnessSnapshotCache clears caches but keeps a live session pin', async (t) => {
  const root = await makeTmp(t, 'cretli-snapshot-pin-');
  await addPlugin(root, 'alpha', localManifest('alpha'), {
    entrySource: [
      'export function handleChatWebSocket() {}',
      'export function disposeSession() {}',
      '',
    ].join('\n'),
  });
  process.env[HARNESS_PLUGIN_ROOT_ENV] = root;

  const disposed = [];
  const module = {
    handleChatWebSocket() {},
    disposeSession(key) { disposed.push(key); },
  };
  const ws = { once() {}, close() {} };
  const dispatched = await dispatchLocalHarnessWebSocket(
    ws,
    'pinned-session',
    { agentTransport: 'alpha' },
    {
      env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
      settings: { enabledLocalHarnesses: ['alpha'] },
      hostVersion: '0.4.0',
      semver: { valid: (value) => value, gte: () => true },
      importer: async () => module,
    },
  );
  assert.equal(dispatched.ok, true);
  assert.equal(getCachedLocalChatHarness('alpha')?.module, module);

  invalidateHarnessSnapshotCache();
  // Catalog and loaded module cache are gone, but the live pin survives and
  // still disposes exactly once through its exact module.
  assert.equal(getCachedLocalChatHarness('alpha'), null);
  assert.deepEqual(disposed, []);
  assert.equal(disposeLocalHarnessSession('alpha', 'pinned-session'), true);
  assert.deepEqual(disposed, ['pinned-session']);
  assert.equal(disposeLocalHarnessSession('alpha', 'pinned-session'), false);
  assert.deepEqual(disposed, ['pinned-session']);
});

console.log('harness-snapshot-registry.test.js OK');
