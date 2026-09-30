import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import {
  AGENT_TRANSPORTS,
  normalizeAgentTransport,
  parseKnownAgentTransport,
} from '../lib/agent-transport.js';
import {
  CREATE_HARNESS_DEFAULT,
  CREATE_HARNESS_REJECTION_CODES,
  classifyCreateHarness,
} from '../lib/agent-harness/chat-create-harness-guard.js';
import {
  HARNESS_PLUGIN_ROOT_ENV,
  invalidateHarnessSnapshotCache,
  listLocalHarnessProviders,
} from '../lib/agent-harness/harness-snapshot-registry.js';
import { dispatchLocalHarnessWebSocket } from '../lib/agent-harness/local-harness-runtime.js';
import { loadChats, saveChats } from '../lib/persist/chats-persist.js';
import { saveSettings } from '../lib/persist/settings.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { widgetChatListScope } from '../lib/widget/widget-chat-scope.js';

const MANIFEST = 'harness-plugin.json';

/** @type {string} */
let pluginRoot;
/** @type {Map<string, object>} */
let agentSessions;
/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let baseUrl;

before(async () => {
  pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'cretli-create-guard-'));
  const pluginDir = path.join(pluginRoot, 'alpha');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, MANIFEST),
    JSON.stringify({
      apiVersion: 1,
      id: 'alpha',
      version: '1.0.0',
      hostMin: '0.1.0',
      label: 'Alpha',
      description: 'Local alpha plugin.',
      origin: 'local',
      entry: 'index.mjs',
      capabilities: { chat: true },
    }),
  );
  await writeFile(
    path.join(pluginDir, 'index.mjs'),
    [
      'globalThis.__cretliLocalHarnessTest = globalThis.__cretliLocalHarnessTest || { handled: 0, disposed: [] };',
      'export function handleChatWebSocket() { globalThis.__cretliLocalHarnessTest.handled += 1; }',
      'export function disposeSession(key) { globalThis.__cretliLocalHarnessTest.disposed.push(key); }',
      '',
    ].join('\n'),
  );

  const app = express();
  app.use(express.json());
  agentSessions = new Map();
  registerChatsRoutes(app, {
    widgetChatListScope,
    dataDir: '',
    agentSessions,
    getCurrentAgentRunResumeId: () => '',
    setCurrentAgentRunResumeId: () => {},
    agentCmd: '',
    agentModel: '',
    workspaceDirForAgent: () => '/tmp',
    getCurrentWorkspaceFile: () => null,
    getCurrentCwd: () => '/tmp',
    buildAgentSpawnEnv: () => ({}),
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
  globalThis.__cretliLocalHarnessTest = { handled: 0, disposed: [] };
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pluginRoot) await rm(pluginRoot, { recursive: true, force: true });
  delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  invalidateHarnessSnapshotCache();
  delete globalThis.__cretliLocalHarnessTest;
  removeIsolatedDataDir();
});

/**
 * @param {string} pathname
 * @returns {Promise<{ status: number, body: any }>}
 */
async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

/**
 * @param {string} pathname
 * @param {object} body
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postJson(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('blank, null, and non-string transports classify to sdk', async () => {
  for (const raw of [undefined, null, '', '   ', 0, false, 42, [], {}, ['sdk']]) {
    const result = await classifyCreateHarness(raw, { settings: {} });
    assert.deepEqual(
      result,
      { ok: true, harness: CREATE_HARNESS_DEFAULT, source: 'blank' },
      `raw=${JSON.stringify(raw)}`,
    );
  }
});

test('the cursor alias classifies to sdk in any case and with spaces', async () => {
  for (const raw of ['cursor', 'CURSOR', 'Cursor', '  cursor  ']) {
    const result = await classifyCreateHarness(raw, { settings: {} });
    assert.deepEqual(
      result,
      { ok: true, harness: CREATE_HARNESS_DEFAULT, source: 'cursor' },
      `raw=${raw}`,
    );
  }
});

test('the eight built-in ids classify to their canonical id regardless of case/spacing', async () => {
  for (const id of AGENT_TRANSPORTS) {
    for (const raw of [id, id.toUpperCase(), `  ${id}  `]) {
      const result = await classifyCreateHarness(raw, { settings: {} });
      assert.deepEqual(result, { ok: true, harness: id, source: 'builtin' }, `raw=${raw}`);
      assert.equal(parseKnownAgentTransport(raw), id);
    }
  }
});

test('an unknown non-empty id is rejected and the global fallback is untouched', async () => {
  let calls = 0;
  const result = await classifyCreateHarness('not-a-harness', {
    settings: {},
    loadLocalChatHarness: async () => {
      calls += 1;
      return {
        ok: false,
        code: CREATE_HARNESS_REJECTION_CODES.unknown,
        error: 'Unknown harness "not-a-harness"',
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, CREATE_HARNESS_REJECTION_CODES.unknown);
  assert.match(result.error, /not-a-harness/);

  // The shared normalizer still falls back to sdk; only the create guard rejects.
  assert.equal(normalizeAgentTransport('not-a-harness'), 'sdk');
  assert.equal(normalizeAgentTransport('cursor'), 'sdk');
  assert.equal(normalizeAgentTransport(''), 'sdk');
});

test('a disabled local candidate and a failing import reject with plugin codes', async () => {
  const disabled = await classifyCreateHarness('beta', {
    settings: {},
    loadLocalChatHarness: async () => ({
      ok: false,
      code: CREATE_HARNESS_REJECTION_CODES.disabled,
      error: 'Harness "beta" is disabled',
    }),
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.status, 400);
  assert.equal(disabled.code, CREATE_HARNESS_REJECTION_CODES.disabled);

  const loadFailed = await classifyCreateHarness('alpha', {
    settings: { enabledLocalHarnesses: ['alpha'] },
    loadLocalChatHarness: async () => ({
      ok: false,
      code: CREATE_HARNESS_REJECTION_CODES.loadFailed,
      error: 'plugin import failed',
    }),
  });
  assert.equal(loadFailed.ok, false);
  assert.equal(loadFailed.status, 503);
  assert.equal(loadFailed.code, CREATE_HARNESS_REJECTION_CODES.loadFailed);
});

test('plugin_load_failed is redacted to stable client-safe text but keeps code and 503', async () => {
  const raw = 'boom /home/secret/plugins/alpha/index.mjs file:///home/secret/plugins/alpha/index.mjs';
  const result = await classifyCreateHarness('alpha', {
    settings: { enabledLocalHarnesses: ['alpha'] },
    loadLocalChatHarness: async () => ({
      ok: false,
      code: CREATE_HARNESS_REJECTION_CODES.loadFailed,
      error: raw,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, CREATE_HARNESS_REJECTION_CODES.loadFailed);
  assert.equal(result.error, 'Harness "alpha" could not be loaded');
  assert.equal(result.error.includes('/'), false);
  assert.equal(result.error.includes('file:'), false);
  assert.equal(result.error.includes('index.mjs'), false);
  assert.equal(result.error.includes('secret'), false);
});

test('an absolute path in any loader error is not forwarded to the client', async () => {
  const result = await classifyCreateHarness('alpha', {
    settings: { enabledLocalHarnesses: ['alpha'] },
    loadLocalChatHarness: async () => ({
      ok: false,
      code: CREATE_HARNESS_REJECTION_CODES.exportMissing,
      error: 'Harness "alpha" must export disposeSession (loaded from file:///srv/plugins/alpha/index.mjs)',
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, CREATE_HARNESS_REJECTION_CODES.exportMissing);
  assert.equal(result.error, 'Harness "alpha" could not be loaded');
  assert.equal(result.error.includes('file:'), false);
  assert.equal(result.error.includes('/srv/'), false);
});

test('a Windows absolute path in a non-load loader error is redacted client-side and in logs', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args);
  };
  try {
    const backslash = await classifyCreateHarness('alpha', {
      settings: { enabledLocalHarnesses: ['alpha'] },
      loadLocalChatHarness: async () => ({
        ok: false,
        code: CREATE_HARNESS_REJECTION_CODES.exportMissing,
        error: 'Harness "alpha" must export disposeSession (loaded from C:\\srv\\plugins\\alpha\\index.mjs and \\\\fileserver\\share\\plugins)',
      }),
    });
    assert.equal(backslash.ok, false);
    assert.equal(backslash.status, 400);
    assert.equal(backslash.code, CREATE_HARNESS_REJECTION_CODES.exportMissing);
    assert.equal(backslash.error, 'Harness "alpha" could not be loaded');
    assert.equal(backslash.error.includes('C:'), false);
    assert.equal(backslash.error.includes('srv'), false);

    const forwardSlash = await classifyCreateHarness('alpha', {
      settings: { enabledLocalHarnesses: ['alpha'] },
      loadLocalChatHarness: async () => ({
        ok: false,
        code: CREATE_HARNESS_REJECTION_CODES.exportMissing,
        error: 'Harness "alpha" must export disposeSession (loaded from C:/srv/plugins/alpha/index.mjs)',
      }),
    });
    assert.equal(forwardSlash.ok, false);
    assert.equal(forwardSlash.status, 400);
    assert.equal(forwardSlash.error, 'Harness "alpha" could not be loaded');
    assert.equal(forwardSlash.error.includes('C:'), false);

    const unc = await classifyCreateHarness('alpha', {
      settings: { enabledLocalHarnesses: ['alpha'] },
      loadLocalChatHarness: async () => ({
        ok: false,
        code: CREATE_HARNESS_REJECTION_CODES.exportMissing,
        error: 'Harness "alpha" must export disposeSession (loaded from \\\\fileserver\\share\\plugins)',
      }),
    });
    assert.equal(unc.ok, false);
    assert.equal(unc.status, 400);
    assert.equal(unc.error, 'Harness "alpha" could not be loaded');
    assert.equal(unc.error.includes('fileserver'), false);

    // The server-side log keeps a diagnostic but never the raw Windows path.
    assert.equal(warnings.length, 3);
    for (const [, meta] of warnings) {
      assert.equal(meta.code, CREATE_HARNESS_REJECTION_CODES.exportMissing);
      assert.match(meta.detail, /<path>/);
      assert.equal(meta.detail.includes('C:'), false);
      assert.equal(meta.detail.includes('srv'), false);
      assert.equal(meta.detail.includes('share'), false);
      assert.equal(meta.detail.includes('fileserver'), false);
    }
  } finally {
    console.warn = originalWarn;
  }
});

test('an enabled local plugin that passes the load contract is accepted', async () => {
  const manifest = { id: 'alpha', label: 'Alpha', capabilities: { chat: true } };
  const module = { handleChatWebSocket() {}, disposeSession() {} };
  const result = await classifyCreateHarness('  ALPHA  ', {
    settings: { enabledLocalHarnesses: ['alpha'] },
    loadLocalChatHarness: async () => ({ ok: true, id: 'alpha', manifest, module }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.harness, 'alpha');
  assert.equal(result.source, 'local');
  assert.equal(result.label, 'Alpha');
  assert.equal(result.module, module);
});

test('a throwing local loader cannot turn an unknown id into sdk', async () => {
  const result = await classifyCreateHarness('alpha', {
    settings: {},
    loadLocalChatHarness: async () => {
      throw new Error('plugin root exploded');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CREATE_HARNESS_REJECTION_CODES.unknown);
});

test('settings are read lazily and only for the non-builtin path', async () => {
  let settingsCalls = 0;
  const loadSettings = () => {
    settingsCalls += 1;
    return {};
  };
  const loadLocalChatHarness = async () => ({
    ok: false,
    code: CREATE_HARNESS_REJECTION_CODES.unknown,
    error: 'unknown',
  });
  for (const raw of ['', 'cursor', ...AGENT_TRANSPORTS]) {
    const result = await classifyCreateHarness(raw, { loadLocalChatHarness, loadSettings });
    assert.equal(result.ok, true);
  }
  assert.equal(settingsCalls, 0);

  await classifyCreateHarness('unknown-xyz', { loadLocalChatHarness, loadSettings });
  assert.equal(settingsCalls, 1);
});

test('real local discovery accepts an enabled, host-compatible plugin and never falls back to sdk', async () => {
  process.env[HARNESS_PLUGIN_ROOT_ENV] = pluginRoot;
  invalidateHarnessSnapshotCache();

  // The read-only catalog must not import the plugin: it stays not_loaded.
  const rows = await listLocalHarnessProviders({ settings: {} });
  assert.deepEqual(rows.map((row) => row.id), ['alpha']);
  assert.equal(rows[0].available, false);
  assert.equal(rows[0].state, 'not_loaded');

  const defaultSettings = await classifyCreateHarness('alpha', { settings: {} });
  assert.equal(defaultSettings.ok, false);
  assert.equal(defaultSettings.code, CREATE_HARNESS_REJECTION_CODES.disabled);

  const explicitlyEnabled = await classifyCreateHarness('alpha', {
    settings: { enabledLocalHarnesses: ['alpha'] },
  });
  assert.equal(explicitlyEnabled.ok, true);
  assert.equal(explicitlyEnabled.harness, 'alpha');
  assert.equal(explicitlyEnabled.source, 'local');
  assert.equal(explicitlyEnabled.label, 'Alpha');
  assert.equal(normalizeAgentTransport('alpha'), 'sdk');
});

test('without a plugin root the same local id is unknown_harness, not sdk', async () => {
  const result = await classifyCreateHarness('alpha', { settings: {}, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, CREATE_HARNESS_REJECTION_CODES.unknown);
  assert.equal(normalizeAgentTransport('alpha'), 'sdk');
});

test('POST /api/chats rejects an unknown id with 400 and persists nothing', async () => {
  saveChats([]);
  const response = await postJson('/api/chats', { agentTransport: 'not-a-harness' });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'unknown_harness');
  assert.match(response.body.error, /not-a-harness/);
  assert.deepEqual(loadChats(), []);
});

test('POST /api/chats rejects a discovered local id that is not explicitly enabled and persists nothing', async () => {
  saveChats([]);
  process.env[HARNESS_PLUGIN_ROOT_ENV] = pluginRoot;
  invalidateHarnessSnapshotCache();

  const response = await postJson('/api/chats', { agentTransport: 'alpha' });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'plugin_disabled');
  assert.deepEqual(loadChats(), []);
});

test('POST /api/chats persists the exact enabled local plugin id and never sdk', async () => {
  saveChats([]);
  process.env[HARNESS_PLUGIN_ROOT_ENV] = pluginRoot;
  invalidateHarnessSnapshotCache();
  saveSettings({ enabledLocalHarnesses: ['alpha'] });

  const response = await postJson('/api/chats', { agentTransport: 'alpha' });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.chat.agentTransport, 'alpha');
  assert.match(response.body.chat.title, /Alpha chat/);
  assert.equal(loadChats()[0].agentTransport, 'alpha');
  assert.equal(loadChats()[0].agentTransport === 'sdk', false);
});

test('POST /api/chats returns a generic 503 for a failing import without loader detail', async () => {
  const brokenRoot = await mkdtemp(path.join(os.tmpdir(), 'cretli-create-broken-'));
  try {
    const dir = path.join(brokenRoot, 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, MANIFEST),
      JSON.stringify({
        apiVersion: 1,
        id: 'broken',
        version: '1.0.0',
        hostMin: '0.1.0',
        label: 'Broken',
        description: 'A plugin whose entry throws on import.',
        origin: 'local',
        entry: 'index.mjs',
        capabilities: { chat: true },
      }),
    );
    await writeFile(
      path.join(dir, 'index.mjs'),
      [
        'throw new Error(`boom ${import.meta.url}`);',
        'export function handleChatWebSocket() {}',
        'export function disposeSession() {}',
        '',
      ].join('\n'),
    );

    saveChats([]);
    process.env[HARNESS_PLUGIN_ROOT_ENV] = brokenRoot;
    invalidateHarnessSnapshotCache();
    saveSettings({ enabledLocalHarnesses: ['broken'] });

    const response = await postJson('/api/chats', { agentTransport: 'broken' });
    assert.equal(response.status, 503);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.code, 'plugin_load_failed');
    assert.equal(response.body.error, 'Harness "broken" could not be loaded');
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes(brokenRoot), false);
    assert.equal(serialized.includes('file:'), false);
    assert.equal(serialized.includes('index.mjs'), false);
    assert.deepEqual(loadChats(), []);
  } finally {
    delete process.env[HARNESS_PLUGIN_ROOT_ENV];
    invalidateHarnessSnapshotCache();
    await rm(brokenRoot, { recursive: true, force: true });
  }
});

test('a persisted chat with an unknown transport stays visible and unrewritten', async () => {
  saveChats([{ id: 'legacy-unknown', title: 'Legacy', agentTransport: 'not-a-harness' }]);

  const list = await getJson('/api/chats');
  assert.equal(list.status, 200);
  const row = list.body.chats.find((chat) => chat.id === 'legacy-unknown');
  assert.ok(row, 'legacy chat must remain visible');
  assert.equal(row.agentTransport, 'not-a-harness');

  await postJson('/api/chats', { agentTransport: 'not-a-harness' });
  assert.equal(loadChats()[0].agentTransport, 'not-a-harness');
});

test('GET /api/chats adds harnessState to a persisted local chat but not to builtins', async () => {
  saveChats([
    { id: 'ghost-local', title: 'Ghost local', agentTransport: 'alpha' },
    { id: 'plain-sdk', title: 'Plain SDK', agentTransport: 'sdk' },
  ]);

  const response = await getJson('/api/chats');
  assert.equal(response.status, 200);
  const localRow = response.body.chats.find((chat) => chat.id === 'ghost-local');
  const builtinRow = response.body.chats.find((chat) => chat.id === 'plain-sdk');
  assert.ok(localRow, 'the persisted local chat must stay visible');
  assert.ok(builtinRow, 'the built-in chat must stay visible');
  assert.equal(localRow.agentTransport, 'alpha');
  assert.deepEqual(localRow.harnessState, { code: 'plugin_unavailable', runnable: false });
  assert.equal(Object.prototype.hasOwnProperty.call(builtinRow, 'harnessState'), false);
  assert.equal(builtinRow.agentTransport, 'sdk');
  assert.equal(loadChats().find((chat) => chat.id === 'ghost-local').harnessState, undefined);
  assert.equal(JSON.stringify(response.body).includes(pluginRoot), false);
});

test('GET /api/chats distinguishes disabled from enabled local plugins', async () => {
  process.env[HARNESS_PLUGIN_ROOT_ENV] = pluginRoot;
  invalidateHarnessSnapshotCache();
  saveChats([{ id: 'idle-local', title: 'Idle local', agentTransport: 'alpha' }]);

  const disabled = await getJson('/api/chats');
  const disabledRow = disabled.body.chats.find((chat) => chat.id === 'idle-local');
  assert.equal(disabledRow.agentTransport, 'alpha');
  assert.deepEqual(disabledRow.harnessState, { code: 'plugin_disabled', runnable: false });

  saveSettings({ enabledLocalHarnesses: ['alpha'] });
  const enabled = await getJson('/api/chats');
  const enabledRow = enabled.body.chats.find((chat) => chat.id === 'idle-local');
  assert.equal(enabledRow.agentTransport, 'alpha');
  assert.deepEqual(enabledRow.harnessState, { code: 'not_loaded', runnable: false });
});

test('status-tail for a local transport never reads the PTY session buffer', async () => {
  process.env[HARNESS_PLUGIN_ROOT_ENV] = pluginRoot;
  invalidateHarnessSnapshotCache();
  saveSettings({ enabledLocalHarnesses: ['alpha'] });
  saveChats([{
    id: 'tail-local',
    title: 'Tail local',
    agentTransport: 'alpha',
    cursorSessionId: 'pty-session-1',
  }]);
  agentSessions.set('pty-session-1', { buffer: 'PTY SHOULD NOT BE READ' });

  let reads = 0;
  const originalGet = agentSessions.get;
  agentSessions.get = (...args) => {
    reads += 1;
    return originalGet.apply(agentSessions, args);
  };
  try {
    const response = await getJson('/api/chats/tail-local/status-tail');
    assert.equal(response.status, 200);
    assert.equal(response.body.transport, 'alpha');
    assert.equal(response.body.hasActiveSession, false);
    assert.equal(response.body.tail, '');
    assert.equal(response.body.state, null);
    assert.deepEqual(response.body.harnessState, { code: 'not_loaded', runnable: false });
    assert.equal(reads, 0, 'the PTY session map must not be consulted for a local harness');
  } finally {
    agentSessions.get = originalGet;
    agentSessions.delete('pty-session-1');
  }
});

test('DELETE /api/chats disposes a live pinned local plugin session', async () => {
  saveChats([]);
  process.env[HARNESS_PLUGIN_ROOT_ENV] = pluginRoot;
  invalidateHarnessSnapshotCache();
  saveSettings({ enabledLocalHarnesses: ['alpha'] });

  const created = await postJson('/api/chats', { agentTransport: 'alpha' });
  assert.equal(created.status, 200);
  const { chat } = created.body;
  assert.equal(chat.agentTransport, 'alpha');

  // A live WS dispatch pins the exact module; DELETE then disposes through it.
  const ws = { once() {}, close() {} };
  const dispatched = await dispatchLocalHarnessWebSocket(ws, chat.cursorSessionId, chat, {
    settings: { enabledLocalHarnesses: ['alpha'] },
  });
  assert.equal(dispatched.ok, true);

  globalThis.__cretliLocalHarnessTest = { handled: 0, disposed: [] };
  const deleted = await fetch(`${baseUrl}/api/chats/${chat.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(globalThis.__cretliLocalHarnessTest.disposed, [chat.cursorSessionId]);
});

test('DELETE /api/chats without a live pin is a safe no-op', async () => {
  saveChats([]);
  process.env[HARNESS_PLUGIN_ROOT_ENV] = pluginRoot;
  invalidateHarnessSnapshotCache();
  saveSettings({ enabledLocalHarnesses: ['alpha'] });

  const created = await postJson('/api/chats', { agentTransport: 'alpha' });
  assert.equal(created.status, 200);
  const { chat } = created.body;

  globalThis.__cretliLocalHarnessTest = { handled: 0, disposed: [] };
  const deleted = await fetch(`${baseUrl}/api/chats/${chat.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(globalThis.__cretliLocalHarnessTest.disposed, []);
});

test('POST /api/chats/:id/fork rejects a local harness parent with 400', async () => {
  saveChats([{ id: 'local-fork', title: 'Local parent', agentTransport: 'alpha', cursorSessionId: 'sess-local' }]);
  const response = await postJson('/api/chats/local-fork/fork', {});
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'local_harness_fork_unsupported');
});

test('new guard/route code never references the plugin runtime loader', () => {
  const guardSource = readFileSync(
    new URL('../lib/agent-harness/chat-create-harness-guard.js', import.meta.url),
    'utf8',
  );
  assert.equal(guardSource.includes('loadHarnessPlugins'), false);
  assert.equal(guardSource.includes('harness-plugin-loader'), false);

  const routeSource = readFileSync(
    new URL('../lib/routes/chats-routes.js', import.meta.url),
    'utf8',
  );
  const postIndex = routeSource.indexOf("app.post('/api/chats'");
  assert.ok(postIndex >= 0, 'POST /api/chats must exist');
  const guardIndex = routeSource.indexOf(
    'classifyCreateHarness(req.body?.agentTransport)',
    postIndex,
  );
  const normalizeIndex = routeSource.indexOf(
    'normalizeAgentTransport(req.body?.agentTransport)',
    postIndex,
  );
  assert.ok(guardIndex > postIndex, 'the guard must be wired into POST /api/chats');
  assert.ok(
    normalizeIndex === -1 || guardIndex < normalizeIndex,
    'the guard must run before the existing transport normalization',
  );
  assert.equal(routeSource.includes('loadHarnessPlugins'), false);
});

console.log('chat-create-harness-guard.test.js OK');
