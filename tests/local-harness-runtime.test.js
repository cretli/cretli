/**
 * Focused tests for the local harness plugin runtime: catalog/module caching,
 * the chat entry export contract, hostMin gating, persisting the exact local
 * id, WebSocket dispatch with explicit close (never SDK fallback), and
 * idempotent dispose.
 *
 * Everything runs against temp plugin roots; no vendor SDK and no network.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import {
  HARNESS_PLUGIN_ROOT_ENV,
  LOCAL_HARNESS_LOAD_CODES,
  dispatchLocalHarnessWebSocket,
  disposeLocalHarnessSession,
  getCachedLocalChatHarness,
  invalidateLocalHarnessDiscoveryCache,
  invalidateLocalHarnessModuleCache,
  invalidateLocalHarnessRuntimeCache,
  isLocalHarnessTransport,
  loadLocalChatHarness,
  rawHarnessTransportKind,
} from '../lib/agent-harness/local-harness-runtime.js';
import { addChat, getChatByCursorSessionId, loadChats, saveChats } from '../lib/persist/chats-persist.js';

const MANIFEST = 'harness-plugin.json';

/** Fake semver that always says "compatible". */
const SEMVER_COMPATIBLE = Object.freeze({ valid: (value) => value, gte: () => true });
/** Fake semver that always says "host too old". */
const SEMVER_TOO_OLD = Object.freeze({ valid: (value) => value, gte: () => false });

/** @type {string[]} */
const tempRoots = [];

beforeEach(() => {
  delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  invalidateLocalHarnessRuntimeCache();
  saveChats([]);
});

after(async () => {
  invalidateLocalHarnessRuntimeCache();
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  removeIsolatedDataDir();
});

/**
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function makeRoot(prefix = 'cretli-local-runtime-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {object} [manifestOverrides]
 * @param {string} [entrySource]
 * @returns {Promise<{ manifest: object, pluginDir: string, entryPath: string }>}
 */
async function addPlugin(root, dir, manifestOverrides = {}, entrySource = 'export const marker = 1;\n') {
  const pluginDir = path.join(root, dir);
  await mkdir(pluginDir, { recursive: true });
  const manifest = {
    apiVersion: 1,
    id: dir,
    version: '1.0.0',
    hostMin: '0.1.0',
    label: `Plugin ${dir}`,
    description: `Local plugin ${dir}.`,
    origin: 'local',
    entry: 'index.mjs',
    capabilities: { chat: true },
    ...manifestOverrides,
  };
  await writeFile(path.join(pluginDir, MANIFEST), JSON.stringify(manifest));
  const entryPath = path.join(pluginDir, 'index.mjs');
  await writeFile(entryPath, entrySource);
  return { manifest, pluginDir, entryPath };
}

/**
 * @param {object} [overrides]
 * @returns {{ handleChatWebSocket: Function, disposeSession: Function, calls: object }}
 */
function fakeModule(overrides = {}) {
  const calls = { handled: [], disposed: [] };
  const module = {
    calls,
    handleChatWebSocket: (args) => {
      calls.handled.push(args);
    },
    disposeSession: (sessionKey) => {
      calls.disposed.push(sessionKey);
    },
    ...overrides,
  };
  return module;
}

/**
 * Minimal WebSocket double: records `close`, exposes `readyState`, and lets the
 * test fire `close` (also transitioning to CLOSED).
 * @returns {object}
 */
function fakeWs() {
  return {
    readyState: 1,
    CLOSED: 3,
    closed: null,
    closeListeners: [],
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = this.CLOSED;
    },
    once(event, listener) {
      if (event === 'close') this.closeListeners.push(listener);
    },
    emitClose() {
      this.readyState = this.CLOSED;
      for (const listener of this.closeListeners) listener();
    },
  };
}

/**
 * Poll a predicate across macrotasks. Used only to deterministically observe
 * that an in-flight async dispatch has reached its awaited importer.
 *
 * @param {() => boolean} predicate
 * @param {string} label
 * @returns {Promise<void>}
 */
async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('raw transport classification keeps builtins/cursor and flags local candidates', () => {
  for (const id of ['sdk', 'openrouter', 'opencode', 'codebuddy', 'deepseek', 'codex', 'qwen', 'claude']) {
    assert.equal(rawHarnessTransportKind(id), 'builtin', id);
    assert.equal(rawHarnessTransportKind(id.toUpperCase()), 'builtin', id);
  }
  assert.equal(rawHarnessTransportKind('cursor'), 'builtin');
  assert.equal(rawHarnessTransportKind('  CURSOR '), 'builtin');
  assert.equal(rawHarnessTransportKind(''), 'blank');
  assert.equal(rawHarnessTransportKind('   '), 'blank');
  assert.equal(rawHarnessTransportKind(undefined), 'blank');
  assert.equal(rawHarnessTransportKind(null), 'blank');
  assert.equal(rawHarnessTransportKind('alpha'), 'local');
  assert.equal(rawHarnessTransportKind('  Alpha  '), 'local');
  assert.equal(isLocalHarnessTransport('not-a-harness'), true);
  assert.equal(isLocalHarnessTransport('sdk'), false);
});

test('loadLocalChatHarness rejects unknown, disabled, and non-chat plugins before importing', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha', { capabilities: { chat: false } });
  const env = { [HARNESS_PLUGIN_ROOT_ENV]: root };
  const importer = async () => {
    throw new Error('importer must not run for these rejections');
  };

  const unknown = await loadLocalChatHarness('ghost', {
    env,
    settings: { enabledLocalHarnesses: ['ghost'] },
    hostVersion: '0.4.0',
    importer,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, LOCAL_HARNESS_LOAD_CODES.unknown);

  const withRoot = { [HARNESS_PLUGIN_ROOT_ENV]: root };
  const disabled = await loadLocalChatHarness('alpha', {
    env: withRoot,
    settings: {},
    hostVersion: '0.4.0',
    importer,
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, LOCAL_HARNESS_LOAD_CODES.disabled);

  const capability = await loadLocalChatHarness('alpha', {
    env: withRoot,
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    importer,
  });
  assert.equal(capability.ok, false);
  assert.equal(capability.code, LOCAL_HARNESS_LOAD_CODES.capability);
});

test('loadLocalChatHarness enforces hostMin and maps import failures', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha', { hostMin: '99.0.0' });
  const env = { [HARNESS_PLUGIN_ROOT_ENV]: root };
  const settings = { enabledLocalHarnesses: ['alpha'] };

  const incompatible = await loadLocalChatHarness('alpha', {
    env,
    settings,
    hostVersion: '0.4.0',
    semver: SEMVER_TOO_OLD,
    importer: async () => fakeModule(),
  });
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.code, LOCAL_HARNESS_LOAD_CODES.incompatible);

  const root2 = await makeRoot();
  await addPlugin(root2, 'beta');
  const env2 = { [HARNESS_PLUGIN_ROOT_ENV]: root2 };
  const loadFailed = await loadLocalChatHarness('beta', {
    env: env2,
    settings: { enabledLocalHarnesses: ['beta'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(loadFailed.ok, false);
  assert.equal(loadFailed.code, LOCAL_HARNESS_LOAD_CODES.loadFailed);
  assert.match(loadFailed.error, /boom/);
});

test('loadLocalChatHarness revalidates the disk manifest before importing', async () => {
  const root = await makeRoot();
  // Disk manifest id is "other"; a forged catalog claims "alpha".
  await addPlugin(root, 'alpha', { id: 'other' });
  let importerCalls = 0;
  const result = await loadLocalChatHarness('alpha', {
    env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    catalog: {
      root,
      plugins: [{
        manifest: {
          apiVersion: 1,
          id: 'alpha',
          version: '1.0.0',
          hostMin: '0.1.0',
          label: 'Alpha',
          description: 'forged',
          origin: 'local',
          entry: 'index.mjs',
          capabilities: { chat: true },
        },
        dir: 'alpha',
      }],
    },
    importer: async () => {
      importerCalls += 1;
      return fakeModule();
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, LOCAL_HARNESS_LOAD_CODES.loadFailed);
  assert.equal(importerCalls, 0);
});

test('loadLocalChatHarness validates the required chat exports', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const env = { [HARNESS_PLUGIN_ROOT_ENV]: root };
  const settings = { enabledLocalHarnesses: ['alpha'] };

  const missingDispose = await loadLocalChatHarness('alpha', {
    env,
    settings,
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => ({ handleChatWebSocket() {} }),
  });
  assert.equal(missingDispose.ok, false);
  assert.equal(missingDispose.code, LOCAL_HARNESS_LOAD_CODES.exportMissing);
  assert.match(missingDispose.error, /disposeSession/);
  assert.equal(getCachedLocalChatHarness('alpha'), null);

  const missingHandler = await loadLocalChatHarness('alpha', {
    env,
    settings,
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => ({ disposeSession() {} }),
  });
  assert.equal(missingHandler.ok, false);
  assert.equal(missingHandler.code, LOCAL_HARNESS_LOAD_CODES.exportMissing);
  assert.equal(getCachedLocalChatHarness('alpha'), null);
});

test('a valid plugin is imported once and cached per process', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const env = { [HARNESS_PLUGIN_ROOT_ENV]: root };
  const settings = { enabledLocalHarnesses: ['alpha'] };
  let importerCalls = 0;
  const module = fakeModule();

  const first = await loadLocalChatHarness('alpha', {
    env,
    settings,
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => {
      importerCalls += 1;
      return module;
    },
  });
  const second = await loadLocalChatHarness('alpha', {
    env,
    settings,
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => {
      importerCalls += 1;
      return module;
    },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.module, module);
  assert.equal(second.module, module);
  assert.equal(importerCalls, 1);
  assert.equal(getCachedLocalChatHarness('alpha')?.module, module);
});

test('disposeLocalHarnessSession goes through the live pin, is idempotent, and is best-effort', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const module = fakeModule();
  const ws = fakeWs();
  const dispatched = await dispatchLocalHarnessWebSocket(
    ws,
    'session-1',
    { agentTransport: 'alpha' },
    {
      env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
      settings: { enabledLocalHarnesses: ['alpha'] },
      hostVersion: '0.4.0',
      semver: SEMVER_COMPATIBLE,
      importer: async () => module,
    },
  );
  assert.equal(dispatched.ok, true);

  assert.equal(disposeLocalHarnessSession('alpha', 'session-1'), true);
  assert.deepEqual(module.calls.disposed, ['session-1']);
  // The pin is removed on completion, so a repeat and the socket close are
  // both safe no-ops and never double-dispose.
  assert.equal(disposeLocalHarnessSession('alpha', 'session-1'), false);
  ws.emitClose();
  assert.deepEqual(module.calls.disposed, ['session-1']);
  // A stale/unknown id is a safe no-op.
  assert.equal(disposeLocalHarnessSession('ghost', 'session-1'), false);
  assert.equal(disposeLocalHarnessSession('alpha', ''), false);
  // Without a live pin there is no fallback to the module cache.
  assert.equal(disposeLocalHarnessSession('alpha', 'never-dispatched'), false);
  assert.deepEqual(module.calls.disposed, ['session-1']);
});

test('invalidateLocalHarnessModuleCache clears the load cache but keeps a live pin', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const module = fakeModule();
  const ws = fakeWs();
  const dispatched = await dispatchLocalHarnessWebSocket(
    ws,
    'pinned-session',
    { agentTransport: 'alpha' },
    {
      env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
      settings: { enabledLocalHarnesses: ['alpha'] },
      hostVersion: '0.4.0',
      semver: SEMVER_COMPATIBLE,
      importer: async () => module,
    },
  );
  assert.equal(dispatched.ok, true);
  assert.equal(getCachedLocalChatHarness('alpha')?.module, module);

  invalidateLocalHarnessModuleCache();
  invalidateLocalHarnessDiscoveryCache();
  // Cache-only invalidation must not drop the active pin or its module.
  assert.equal(getCachedLocalChatHarness('alpha'), null);
  assert.equal(disposeLocalHarnessSession('alpha', 'pinned-session'), true);
  assert.deepEqual(module.calls.disposed, ['pinned-session']);
  assert.equal(disposeLocalHarnessSession('alpha', 'pinned-session'), false);
  assert.deepEqual(module.calls.disposed, ['pinned-session']);
});

test('a replacement dispatch pins its own module and a late close disposes only its own pin', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const firstModule = fakeModule();
  const secondModule = fakeModule();
  const firstWs = fakeWs();
  const secondWs = fakeWs();
  const options = {
    env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
  };

  const first = await dispatchLocalHarnessWebSocket(
    firstWs,
    'shared-session',
    { agentTransport: 'alpha' },
    { ...options, importer: async () => firstModule },
  );
  assert.equal(first.ok, true);

  // A replacement load imports a new module for the same session key.
  invalidateLocalHarnessModuleCache();
  const second = await dispatchLocalHarnessWebSocket(
    secondWs,
    'shared-session',
    { agentTransport: 'alpha' },
    { ...options, importer: async () => secondModule },
  );
  assert.equal(second.ok, true);

  // The superseded socket closes late: it disposes its own module only and must
  // not touch the replacement pin.
  firstWs.emitClose();
  assert.deepEqual(firstModule.calls.disposed, ['shared-session']);
  assert.deepEqual(secondModule.calls.disposed, []);

  assert.equal(disposeLocalHarnessSession('alpha', 'shared-session'), true);
  assert.deepEqual(secondModule.calls.disposed, ['shared-session']);
  // A duplicate late close on the superseded socket is still a no-op.
  firstWs.emitClose();
  assert.deepEqual(firstModule.calls.disposed, ['shared-session']);
  secondWs.emitClose();
  assert.deepEqual(secondModule.calls.disposed, ['shared-session']);
});

test('a same-module replacement shares one plugin session and disposes it exactly once', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const sharedModule = fakeModule();
  const firstWs = fakeWs();
  const secondWs = fakeWs();
  let importerCalls = 0;
  const options = {
    env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => {
      importerCalls += 1;
      return sharedModule;
    },
  };

  const first = await dispatchLocalHarnessWebSocket(
    firstWs,
    'shared-session',
    { agentTransport: 'alpha' },
    options,
  );
  assert.equal(first.ok, true);

  // The replacement is a moduleCache hit: same module instance, same session
  // key, so both sockets share one plugin session.
  const second = await dispatchLocalHarnessWebSocket(
    secondWs,
    'shared-session',
    { agentTransport: 'alpha' },
    options,
  );
  assert.equal(second.ok, true);
  assert.equal(second.module, sharedModule);
  assert.equal(importerCalls, 1);

  // The superseded socket closing late must NOT dispose the plugin session the
  // replacement is still using.
  firstWs.emitClose();
  assert.deepEqual(sharedModule.calls.disposed, []);

  // The replacement owns the single dispose.
  secondWs.emitClose();
  assert.deepEqual(sharedModule.calls.disposed, ['shared-session']);

  // Repeated late closes on either socket stay idempotent.
  firstWs.emitClose();
  secondWs.emitClose();
  assert.deepEqual(sharedModule.calls.disposed, ['shared-session']);
});

test('a same-module replacement disposes once when the replacement closes before the old socket', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const sharedModule = fakeModule();
  const firstWs = fakeWs();
  const secondWs = fakeWs();
  const options = {
    env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => sharedModule,
  };

  const first = await dispatchLocalHarnessWebSocket(
    firstWs,
    'shared-session',
    { agentTransport: 'alpha' },
    options,
  );
  assert.equal(first.ok, true);
  const second = await dispatchLocalHarnessWebSocket(
    secondWs,
    'shared-session',
    { agentTransport: 'alpha' },
    options,
  );
  assert.equal(second.ok, true);

  // The replacement (newest socket) closes first. The shared plugin session is
  // still in use by the older socket, so nothing may be disposed yet.
  secondWs.emitClose();
  assert.deepEqual(sharedModule.calls.disposed, []);

  // Only the last live reference disposes, and it does so exactly once.
  firstWs.emitClose();
  assert.deepEqual(sharedModule.calls.disposed, ['shared-session']);

  // Repeated closes on either socket stay idempotent.
  firstWs.emitClose();
  secondWs.emitClose();
  assert.deepEqual(sharedModule.calls.disposed, ['shared-session']);
});

test('a different-module replacement disposes each module once when the replacement closes first', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const firstModule = fakeModule();
  const secondModule = fakeModule();
  const firstWs = fakeWs();
  const secondWs = fakeWs();
  const options = {
    env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
  };

  const first = await dispatchLocalHarnessWebSocket(
    firstWs,
    'shared-session',
    { agentTransport: 'alpha' },
    { ...options, importer: async () => firstModule },
  );
  assert.equal(first.ok, true);

  // A replacement load imports a new module instance for the same session key.
  invalidateLocalHarnessModuleCache();
  const second = await dispatchLocalHarnessWebSocket(
    secondWs,
    'shared-session',
    { agentTransport: 'alpha' },
    { ...options, importer: async () => secondModule },
  );
  assert.equal(second.ok, true);

  // New-first close order: the replacement module is disposed once, and the
  // older module is untouched until its own socket closes.
  secondWs.emitClose();
  assert.deepEqual(secondModule.calls.disposed, ['shared-session']);
  assert.deepEqual(firstModule.calls.disposed, []);

  firstWs.emitClose();
  assert.deepEqual(firstModule.calls.disposed, ['shared-session']);

  // Repeated closes on either socket stay idempotent.
  firstWs.emitClose();
  secondWs.emitClose();
  assert.deepEqual(firstModule.calls.disposed, ['shared-session']);
  assert.deepEqual(secondModule.calls.disposed, ['shared-session']);
});

test('explicit dispose with live sockets disposes every live module once and late closes are no-ops', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const sharedModule = fakeModule();
  const otherModule = fakeModule();
  const firstWs = fakeWs();
  const secondWs = fakeWs();
  const thirdWs = fakeWs();
  const options = {
    env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
  };

  // Two live sockets share one module instance for the same session key...
  const first = await dispatchLocalHarnessWebSocket(
    firstWs,
    'shared-session',
    { agentTransport: 'alpha' },
    { ...options, importer: async () => sharedModule },
  );
  assert.equal(first.ok, true);
  const second = await dispatchLocalHarnessWebSocket(
    secondWs,
    'shared-session',
    { agentTransport: 'alpha' },
    options,
  );
  assert.equal(second.ok, true);

  // ...and a third live socket uses a different module instance for that key.
  invalidateLocalHarnessModuleCache();
  const third = await dispatchLocalHarnessWebSocket(
    thirdWs,
    'shared-session',
    { agentTransport: 'alpha' },
    { ...options, importer: async () => otherModule },
  );
  assert.equal(third.ok, true);

  // An explicit chat DELETE disposes each live module group exactly once.
  assert.equal(disposeLocalHarnessSession('alpha', 'shared-session'), true);
  assert.deepEqual(sharedModule.calls.disposed, ['shared-session']);
  assert.deepEqual(otherModule.calls.disposed, ['shared-session']);

  // A repeat explicit dispose finds no live group and is a no-op.
  assert.equal(disposeLocalHarnessSession('alpha', 'shared-session'), false);

  // Every socket that was live at dispose time is now a no-op on close.
  firstWs.emitClose();
  secondWs.emitClose();
  thirdWs.emitClose();
  assert.deepEqual(sharedModule.calls.disposed, ['shared-session']);
  assert.deepEqual(otherModule.calls.disposed, ['shared-session']);
});

test('cache invalidation keeps a live session group while a re-import forms a new module group', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const firstModule = fakeModule();
  const secondModule = fakeModule();
  const firstWs = fakeWs();
  const secondWs = fakeWs();
  const options = {
    env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
  };

  const first = await dispatchLocalHarnessWebSocket(
    firstWs,
    'pinned-session',
    { agentTransport: 'alpha' },
    { ...options, importer: async () => firstModule },
  );
  assert.equal(first.ok, true);
  assert.equal(getCachedLocalChatHarness('alpha')?.module, firstModule);

  // Cache-only invalidation must not drop the live session group. A subsequent
  // dispatch re-imports a new module instance for the same key and pins it.
  invalidateLocalHarnessModuleCache();
  invalidateLocalHarnessDiscoveryCache();
  assert.equal(getCachedLocalChatHarness('alpha'), null);

  const second = await dispatchLocalHarnessWebSocket(
    secondWs,
    'pinned-session',
    { agentTransport: 'alpha' },
    { ...options, importer: async () => secondModule },
  );
  assert.equal(second.ok, true);

  // The older live group still disposes through its exact module...
  firstWs.emitClose();
  assert.deepEqual(firstModule.calls.disposed, ['pinned-session']);
  assert.deepEqual(secondModule.calls.disposed, []);

  // ...and the newer group disposes through the re-imported module.
  assert.equal(disposeLocalHarnessSession('alpha', 'pinned-session'), true);
  assert.deepEqual(secondModule.calls.disposed, ['pinned-session']);
  assert.equal(disposeLocalHarnessSession('alpha', 'pinned-session'), false);
  secondWs.emitClose();
  assert.deepEqual(secondModule.calls.disposed, ['pinned-session']);
});

test('dispatchLocalHarnessWebSocket closes explicitly for a stale/disabled plugin and never runs it', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const env = { [HARNESS_PLUGIN_ROOT_ENV]: root };
  const module = fakeModule();

  // Not discovered at all.
  const missingWs = fakeWs();
  const missing = await dispatchLocalHarnessWebSocket(
    missingWs,
    'session-ghost',
    { agentTransport: 'ghost' },
    { env, settings: { enabledLocalHarnesses: ['ghost'] }, hostVersion: '0.4.0', semver: SEMVER_COMPATIBLE, importer: async () => module },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, 'unavailable');
  assert.equal(missing.code, LOCAL_HARNESS_LOAD_CODES.unknown);
  assert.equal(missingWs.closed.code, 4404);
  assert.deepEqual(module.calls.handled, []);

  // Discovered but disabled.
  const disabledWs = fakeWs();
  const disabled = await dispatchLocalHarnessWebSocket(
    disabledWs,
    'session-disabled',
    { agentTransport: 'alpha' },
    { env, settings: {}, hostVersion: '0.4.0', semver: SEMVER_COMPATIBLE, importer: async () => module },
  );
  assert.equal(disabled.ok, false);
  assert.equal(disabled.kind, 'unavailable');
  assert.equal(disabled.code, LOCAL_HARNESS_LOAD_CODES.disabled);
  assert.equal(disabledWs.closed.code, 4404);
  assert.deepEqual(module.calls.handled, []);
});

test('dispatchLocalHarnessWebSocket runs the plugin and disposes on close', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const module = fakeModule();
  const ws = fakeWs();
  const chat = { agentTransport: 'alpha', cursorSessionId: 'session-1', title: 'Alpha chat' };
  const result = await dispatchLocalHarnessWebSocket(ws, 'session-1', chat, {
    env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => module,
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'local');
  assert.equal(module.calls.handled.length, 1);
  assert.equal(module.calls.handled[0].sessionKey, 'session-1');
  assert.equal(module.calls.handled[0].chat, chat);

  ws.emitClose();
  ws.emitClose();
  assert.deepEqual(module.calls.disposed, ['session-1']);
});

test('a socket that closes while the plugin import awaits is never handled and its pin is released once', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const module = fakeModule();
  const ws = fakeWs();

  // Deterministic race: the dispatch cannot finish loading until this deferred
  // promise resolves, so the CLOSED transition is guaranteed to happen while
  // `loadLocalChatHarness` is still awaiting.
  let releaseImport;
  const importGate = new Promise((resolve) => {
    releaseImport = resolve;
  });
  let importStarted = false;
  const importer = async () => {
    importStarted = true;
    await importGate;
    return module;
  };

  const pending = dispatchLocalHarnessWebSocket(
    ws,
    'session-raced',
    { agentTransport: 'alpha' },
    {
      env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
      settings: { enabledLocalHarnesses: ['alpha'] },
      hostVersion: '0.4.0',
      semver: SEMVER_COMPATIBLE,
      importer,
    },
  );

  await waitFor(() => importStarted, 'the plugin importer to start');
  // The close event has already fired before the runtime attached its
  // listener, so that listener can never observe it. Force the numeric CLOSED
  // fallback by removing the instance constant.
  delete ws.CLOSED;
  ws.readyState = 3;
  releaseImport();

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'socket_closed');
  assert.deepEqual(module.calls.handled, []);
  // The leaked pin is released synchronously and disposes exactly once.
  assert.deepEqual(module.calls.disposed, ['session-raced']);
  // The session group is gone, so an explicit dispose finds nothing...
  assert.equal(disposeLocalHarnessSession('alpha', 'session-raced'), false);
  // ...and a late close event is harmless and never double-disposes.
  ws.emitClose();
  assert.deepEqual(module.calls.disposed, ['session-raced']);
  assert.equal(disposeLocalHarnessSession('alpha', 'session-raced'), false);
});

test('an already-CLOSED socket is released through the instance CLOSED constant without running the plugin', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const module = fakeModule();
  const ws = fakeWs();
  ws.readyState = ws.CLOSED;

  const result = await dispatchLocalHarnessWebSocket(
    ws,
    'session-closed',
    { agentTransport: 'alpha' },
    {
      env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
      settings: { enabledLocalHarnesses: ['alpha'] },
      hostVersion: '0.4.0',
      semver: SEMVER_COMPATIBLE,
      importer: async () => module,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'socket_closed');
  assert.deepEqual(module.calls.handled, []);
  assert.deepEqual(module.calls.disposed, ['session-closed']);
  assert.equal(disposeLocalHarnessSession('alpha', 'session-closed'), false);
  ws.emitClose();
  assert.deepEqual(module.calls.disposed, ['session-closed']);
});

test('a socket without a close listener is rejected before pinning and never runs the plugin', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const module = fakeModule();
  const ws = {
    readyState: 1,
    closed: null,
    close(code, reason) {
      this.closed = { code, reason };
    },
  };

  const result = await dispatchLocalHarnessWebSocket(
    ws,
    'session-untracked',
    { agentTransport: 'alpha' },
    {
      env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
      settings: { enabledLocalHarnesses: ['alpha'] },
      hostVersion: '0.4.0',
      semver: SEMVER_COMPATIBLE,
      importer: async () => module,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'socket_unsupported');
  assert.deepEqual(module.calls.handled, []);
  // No pin was retained: there is no live session group to dispose.
  assert.equal(disposeLocalHarnessSession('alpha', 'session-untracked'), false);
  assert.deepEqual(module.calls.disposed, []);
  assert.equal(ws.closed?.code, 1011);
});

test('dispatchLocalHarnessWebSocket closes on handler failure and still disposes', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const module = fakeModule({
    handleChatWebSocket() {
      throw new Error('handler blew up');
    },
  });
  const ws = fakeWs();
  const result = await dispatchLocalHarnessWebSocket(
    ws,
    'session-err',
    { agentTransport: 'alpha' },
    {
      env: { [HARNESS_PLUGIN_ROOT_ENV]: root },
      settings: { enabledLocalHarnesses: ['alpha'] },
      hostVersion: '0.4.0',
      semver: SEMVER_COMPATIBLE,
      importer: async () => module,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.code, 'handler_failed');
  assert.match(result.error, /handler blew up/);
  assert.equal(ws.closed.code, 1011);
  ws.emitClose();
  assert.deepEqual(module.calls.disposed, ['session-err']);
});

test('addChat persists the exact local id only under the explicit server flag', () => {
  addChat('cursor-session-local', 'Local', null, null, undefined, {
    agentTransport: 'alpha',
    localHarnessTransport: true,
  });
  addChat('cursor-session-unknown', 'Unknown', null, null, undefined, {
    agentTransport: 'not-a-harness',
  });
  addChat('cursor-session-cursor', 'Legacy', null, null, undefined, {
    agentTransport: 'cursor',
  });
  const byTitle = new Map(loadChats().map((chat) => [chat.title, chat]));
  assert.equal(byTitle.get('Local').agentTransport, 'alpha');
  assert.equal(byTitle.get('Unknown').agentTransport, 'sdk');
  assert.equal(byTitle.get('Legacy').agentTransport, 'sdk');
});

test('a persisted local chat reconnects to the local handler, not the SDK', async () => {
  const root = await makeRoot();
  await addPlugin(root, 'alpha');
  const module = fakeModule();
  const env = { [HARNESS_PLUGIN_ROOT_ENV]: root };

  const created = addChat('persisted-session', 'Persisted', null, null, undefined, {
    agentTransport: 'alpha',
    localHarnessTransport: true,
  });
  // The persisted record must keep the raw local id (no sdk rewrite).
  assert.equal(created.agentTransport, 'alpha');
  const reloaded = getChatByCursorSessionId('persisted-session');
  assert.equal(reloaded.agentTransport, 'alpha');
  assert.equal(rawHarnessTransportKind(reloaded.agentTransport), 'local');

  // Reconnect with the persisted record selects the plugin handler.
  const ws = fakeWs();
  const result = await dispatchLocalHarnessWebSocket(ws, 'persisted-session', reloaded, {
    env,
    settings: { enabledLocalHarnesses: ['alpha'] },
    hostVersion: '0.4.0',
    semver: SEMVER_COMPATIBLE,
    importer: async () => module,
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'local');
  assert.equal(module.calls.handled.length, 1);
  assert.equal(module.calls.handled[0].chat, reloaded);
});

test('ws-router routes persisted local ids before the SDK fallback', () => {
  const source = readFileSync(new URL('../lib/ws/ws-router.js', import.meta.url), 'utf8');
  const localIndex = source.indexOf('dispatchLocalHarnessWebSocket(ws, sessionKey, routedChat');
  assert.ok(localIndex > 0, 'the local dispatch call must exist');
  const guardIndex = source.indexOf("rawHarnessTransportKind(routedChat.agentTransport) === 'local'");
  assert.ok(guardIndex > 0 && guardIndex < localIndex, 'the local guard must gate the dispatch');
  const sdkIndex = source.indexOf('handleAgentSdkWebSocket(ws, sessionKey', localIndex);
  assert.ok(sdkIndex > localIndex, 'the SDK fallback must come after the local branch');
});

test('session disposal is reference-counted with no timer deferral', () => {
  const source = readFileSync(
    new URL('../lib/agent-harness/local-harness-runtime.js', import.meta.url),
    'utf8',
  );
  for (const banned of ['setTimeout', 'setInterval', 'setImmediate', 'process.nextTick']) {
    assert.equal(source.includes(banned), false, `disposal must not use ${banned}`);
  }
});

console.log('local-harness-runtime.test.js OK');
