/**
 * Harness version inventory (`lib/harness-versions.js` + `GET /api/harness/versions`).
 *
 * Every case runs against a fixture project tree, an emptied PATH and a fake
 * spawn, so the suite depends on neither the packages installed here nor a
 * network, and never starts a real process.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import {
  PACKAGE_STATUSES,
  SNAPSHOT_FILE_NAME,
  VERSION_SOURCES,
  buildVersionSpawnArgs,
  collectHarnessVersions,
  getHarnessVersionInventory,
  parseVersionOutput,
  readHarnessVersionsSnapshot,
  readVersionFromBinary,
  rollupHarnessStatus,
} from '../lib/harness-versions.js';
import { registerHarnessVersionsRoutes } from '../lib/routes/harness-versions-routes.js';
import { createSession, requireAuth, setPassword } from '../lib/auth.js';
import { saveSettings } from '../lib/persist/settings.js';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const HARNESS_IDS = ['sdk', 'openrouter', 'mistral', 'opencode', 'codebuddy', 'deepseek', 'codex', 'qwen', 'claude'];

/** Versions only this suite knows about — the fixture is the source of truth. */
const FIXTURE_VERSIONS = {
  '@cursor/sdk': '1.0.37',
  '@opencode-ai/sdk': '1.18.26',
  'opencode-ai': '1.18.26',
  '@tencent-ai/agent-sdk': '0.1.30',
  '@deepseek-ai/dsh-sdk-client': '0.1.2-alpha.5',
  '@deepseek-ai/dsh': '0.1.2-alpha.5',
  '@openai/codex-sdk': '0.160.0',
  '@openai/codex': '0.160.0',
  '@qwen-code/sdk': '0.1.8',
  '@anthropic-ai/claude-agent-sdk': '0.3.284',
  '@anthropic-ai/sdk': '0.93.0',
};

/** Transitive packages are installed but not declared: never updatable alone. */
const TRANSITIVE_PACKAGES = new Set(['@openai/codex']);
/** Claude lives in its own npm prefix, not in the root manifest. */
const CLAUDE_PACKAGES = new Set(['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk']);

const CLI_ENV_KEYS = ['DSH_BIN', 'CODEX_BIN', 'CODEBUDDY_CODE_PATH', 'QWEN_BIN', 'QWEN_CODE_PATH'];
const previousEnv = Object.fromEntries(CLI_ENV_KEYS.map((key) => [key, process.env[key]]));
const previousPath = process.env.PATH;

const tempRoots = [];

/**
 * @param {string} suffix
 * @returns {string}
 */
function makeTempDir(suffix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cretli-hv-${suffix}-`));
  tempRoots.push(dir);
  return dir;
}

/**
 * @param {string} filePath
 * @param {object} value
 * @returns {void}
 */
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\necho stub\n', 'utf8');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

/**
 * A project tree shaped like an installed Cretli: a root manifest plus the
 * Claude agent SDK in its isolated prefix.
 *
 * @param {{ omit?: string[], withOpenCodeBin?: boolean }} [options]
 * @returns {string} project root
 */
function makeFixtureProject(options = {}) {
  const omit = new Set(options.omit || []);
  const root = makeTempDir('project');
  const claudePrefix = path.join('optional-packages', 'claude-agent-sdk');
  const declared = (name) => `^${FIXTURE_VERSIONS[name]}`;
  writeJson(path.join(root, 'package.json'), {
    name: 'cretli',
    version: '0.4.1',
    dependencies: { '@opencode-ai/sdk': declared('@opencode-ai/sdk') },
    optionalDependencies: Object.fromEntries(Object.keys(FIXTURE_VERSIONS)
      .filter((name) => name !== '@opencode-ai/sdk'
        && !TRANSITIVE_PACKAGES.has(name) && !CLAUDE_PACKAGES.has(name))
      .map((name) => [name, declared(name)])),
  });
  for (const [name, version] of Object.entries(FIXTURE_VERSIONS)) {
    if (omit.has(name) || CLAUDE_PACKAGES.has(name)) continue;
    writeJson(path.join(root, 'node_modules', name, 'package.json'), { name, version });
  }
  writeJson(path.join(root, claudePrefix, 'package.json'), {
    name: 'cretli-optional-claude-agent-sdk',
    private: true,
    dependencies: Object.fromEntries(
      [...CLAUDE_PACKAGES].map((name) => [name, declared(name)]),
    ),
  });
  for (const name of CLAUDE_PACKAGES) {
    if (omit.has(name)) continue;
    writeJson(path.join(root, claudePrefix, 'node_modules', name, 'package.json'), {
      name,
      version: FIXTURE_VERSIONS[name],
    });
  }
  if (options.withOpenCodeBin) writeExecutable(path.join(root, 'node_modules', '.bin', 'opencode'));
  return root;
}

/**
 * @param {object[]} harnesses
 * @param {string} id
 * @returns {object}
 */
function harnessOf(harnesses, id) {
  const entry = harnesses.find((item) => item.harness === id);
  assert.ok(entry, `missing harness entry for ${id}`);
  return entry;
}

/**
 * @param {object} entry
 * @param {string} name
 * @returns {object}
 */
function rowOf(entry, name) {
  const row = entry.packages.find((item) => item.name === name);
  assert.ok(row, `missing package row ${name} in ${entry.harness}`);
  return row;
}

/**
 * A stand-in for `child_process.spawn` that reports canned output through the
 * same event surface, so the deadline and exit-code paths are really exercised.
 *
 * @param {{ output?: string, code?: number, error?: string, hang?: boolean }} behavior
 * @param {{ count?: number, killed?: boolean, calls?: Array<{file: string, args: string[]}> }} [spy]
 * @returns {Function}
 */
function fakeSpawnFactory(behavior, spy = {}) {
  return (file, args) => {
    spy.calls = spy.calls || [];
    spy.calls.push({ file, args });
    spy.count = (spy.count || 0) + 1;
    const listeners = {};
    const child = {
      stdout: { on: (event, handler) => { (listeners[event] = listeners[event] || []).push(handler); } },
      stderr: { on: (event, handler) => { (listeners[event] = listeners[event] || []).push(handler); } },
      on: (event, handler) => { (listeners[event] = listeners[event] || []).push(handler); },
      kill: () => {
        spy.killed = true;
        return true;
      },
    };
    if (behavior.hang) return child;
    setImmediate(() => {
      if (behavior.error) {
        for (const handler of listeners.error || []) handler(new Error(behavior.error));
        return;
      }
      if (behavior.output) {
        for (const handler of listeners.data || []) handler(behavior.output);
      }
      for (const handler of listeners.close || []) {
        handler(behavior.code === undefined ? 0 : behavior.code);
      }
    });
    return child;
  };
}

/**
 * @param {string} bin
 * @param {string} version
 * @returns {Function}
 */
function spawnFactoryReturning(bin, version) {
  const spy = { count: 0, calls: [] };
  const factory = fakeSpawnFactory({ output: `${bin} ${version}\n` }, spy);
  factory.spy = spy;
  return factory;
}

/**
 * A spawn stand-in that must never be used: it records instead of throwing,
 * because a throwing factory would be swallowed by the probe's own guard.
 *
 * @returns {{ factory: Function, spy: {count:number, calls:Array} }}
 */
function forbiddenSpawn() {
  const spy = { count: 0, calls: [] };
  return {
    spy,
    factory: (file, args) => {
      spy.calls.push({ file, args });
      spy.count += 1;
      return fakeSpawnFactory({ output: 'unexpected 0.0.0\n' }, {})(file, args);
    },
  };
}

/**
 * @returns {void}
 */
function clearCliEnv() {
  for (const key of CLI_ENV_KEYS) delete process.env[key];
}

saveSettings({});
clearCliEnv();
setPassword('test-password-123');

test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
  process.env.PATH = previousPath;
  saveSettings({});
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
  removeIsolatedDataDir();
});

/**
 * Empties PATH so a host-installed CLI cannot leak into the resolvers.
 *
 * @param {Function} body
 * @returns {Promise<void>}
 */
async function withEmptyPath(body) {
  process.env.PATH = makeTempDir('empty-path');
  try {
    await body();
  } finally {
    process.env.PATH = previousPath;
  }
}

test('bundled packages are read from node_modules with no spawn and no network', async () => {
  const root = makeFixtureProject();
  const fetchSpy = { count: 0 };
  const spawnSpy = { count: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetchSpy.count += 1;
    throw new Error(`inventory touched the network: ${String(args[0])}`);
  };
  try {
    await withEmptyPath(async () => {
      const result = await collectHarnessVersions({
        projectRoot: root,
        homeDirs: [],
        checkedAt: '2026-10-08T00:00:00.000Z',
        spawnFactory: (file, args) => {
          spawnSpy.count += 1;
          return fakeSpawnFactory({ output: 'should.not.be.probe\n' })(file, args);
        },
      });
      assert.equal(spawnSpy.count, 0, 'a bundled install must not spawn anything');
      assert.equal(fetchSpy.count, 0, 'the inventory must not touch the network');
      assert.equal(result.checkedAt, '2026-10-08T00:00:00.000Z');
      assert.deepEqual(result.harnesses.map((entry) => entry.harness).sort(), [...HARNESS_IDS].sort());
      for (const entry of result.harnesses) {
        assert.equal(PACKAGE_STATUSES.includes(entry.status), true, `bad harness status ${entry.status}`);
        assert.equal(entry.checkedAt, '2026-10-08T00:00:00.000Z');
        for (const row of entry.packages) {
          assert.equal(VERSION_SOURCES.includes(row.source), true, `bad source ${row.source}`);
          assert.equal(PACKAGE_STATUSES.includes(row.status), true, `bad status ${row.status}`);
          assert.equal(typeof row.canUpdate, 'boolean');
          assert.equal(typeof row.name, 'string');
        }
      }
      const sdk = harnessOf(result.harnesses, 'sdk');
      assert.equal(sdk.status, 'managed');
      assert.equal(sdk.canUpdate, true);
      assert.deepEqual(rowOf(sdk, '@cursor/sdk'), {
        name: '@cursor/sdk',
        role: 'sdk',
        installed: '1.0.37',
        source: 'bundled',
        status: 'managed',
        canUpdate: true,
        declared: true,
        declaredSpec: '^1.0.37',
      });
      const claude = harnessOf(result.harnesses, 'claude');
      assert.equal(claude.channel, 'npm-prefix');
      assert.equal(claude.installPrefix, path.join('optional-packages', 'claude-agent-sdk'));
      assert.equal(rowOf(claude, '@anthropic-ai/claude-agent-sdk').installed, '0.3.284');
      assert.equal(rowOf(claude, '@anthropic-ai/claude-agent-sdk').source, 'bundled');
      assert.equal(rowOf(claude, '@anthropic-ai/sdk').canUpdate, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openrouter is API-only and reported as n/a', async () => {
  const root = makeFixtureProject();
  const { factory, spy } = forbiddenSpawn();
  await withEmptyPath(async () => {
    const result = await collectHarnessVersions({
      projectRoot: root,
      homeDirs: [],
      spawnFactory: factory,
    });
    const openrouter = harnessOf(result.harnesses, 'openrouter');
    assert.equal(openrouter.status, 'n/a');
    assert.equal(openrouter.channel, 'api');
    assert.deepEqual(openrouter.packages, []);
    assert.equal(openrouter.canUpdate, false);
    assert.equal(spy.count, 0, 'an API-only harness has no CLI to probe');
  });
});

test('a package that is not installed reports missing', async () => {
  const root = makeFixtureProject({ omit: ['@qwen-code/sdk', '@cursor/sdk'] });
  const { factory, spy } = forbiddenSpawn();
  await withEmptyPath(async () => {
    const result = await collectHarnessVersions({
      projectRoot: root,
      homeDirs: [],
      spawnFactory: factory,
    });
    const qwen = harnessOf(result.harnesses, 'qwen');
    const row = rowOf(qwen, '@qwen-code/sdk');
    assert.equal(row.installed, null);
    assert.equal(row.source, 'missing');
    assert.equal(row.status, 'missing');
    assert.equal(row.canUpdate, false);
    assert.equal(qwen.status, 'missing');
    assert.equal(qwen.canUpdate, false);
    assert.equal(harnessOf(result.harnesses, 'sdk').status, 'missing');
    assert.equal(spy.count, 0, 'a missing package must not be probed');
  });
});

test('a transitive package is related, never independently updatable', async () => {
  const root = makeFixtureProject();
  const { factory, spy } = forbiddenSpawn();
  await withEmptyPath(async () => {
    const result = await collectHarnessVersions({
      projectRoot: root,
      homeDirs: [],
      spawnFactory: factory,
    });
    const codex = harnessOf(result.harnesses, 'codex');
    assert.equal(rowOf(codex, '@openai/codex-sdk').canUpdate, true);
    const transitive = rowOf(codex, '@openai/codex');
    assert.equal(transitive.installed, '0.160.0');
    assert.equal(transitive.source, 'bundled');
    assert.equal(transitive.status, 'managed');
    assert.equal(transitive.declared, false);
    assert.equal(transitive.declaredSpec, undefined);
    assert.equal(transitive.canUpdate, false);
    assert.equal(transitive.requiredBy, '@openai/codex-sdk');
    assert.equal(codex.status, 'missing', 'missing platform package drives rollup');
    assert.equal(codex.canUpdate, true, 'the declared SDK keeps the harness updatable');
    assert.equal(spy.count, 0, 'a bundled Codex install needs no probe');
  });
});

test('a CLI resolved from env reports the probed version, not node_modules', async () => {
  process.env.DSH_BIN = '/opt/elsewhere/dsh';
  try {
    const root = makeFixtureProject();
    const spy = { count: 0, calls: [] };
    await withEmptyPath(async () => {
      const result = await collectHarnessVersions({
        projectRoot: root,
        homeDirs: [],
        cache: new Map(),
        spawnFactory: (file, args) => {
          spy.calls.push({ file, args });
          spy.count += 1;
          return fakeSpawnFactory({ output: 'dsh 0.9.9\n' }, {})(file, args);
        },
      });
      const deepseek = harnessOf(result.harnesses, 'deepseek');
      const row = rowOf(deepseek, '@deepseek-ai/dsh');
      assert.equal(row.installed, '0.9.9', 'the running version, not the pinned one');
      assert.equal(row.source, 'env');
      assert.equal(row.status, 'external');
      assert.equal(row.canUpdate, false);
      assert.equal(row.declared, true, 'still declared; only the binary is external');
      assert.equal(deepseek.status, 'external');
      assert.deepEqual(spy.calls, [{ file: '/opt/elsewhere/dsh', args: ['--version'] }]);
      const client = rowOf(deepseek, '@deepseek-ai/dsh-sdk-client');
      assert.equal(client.installed, '0.1.2-alpha.5');
      assert.equal(client.source, 'bundled');
    });
  } finally {
    clearCliEnv();
  }
});

test('a CLI resolved from settings is external too', async () => {
  const root = makeFixtureProject();
  const externalBin = writeExecutable(path.join(root, 'external', 'opencode'));
  saveSettings({ opencodeBin: externalBin });
  try {
    await withEmptyPath(async () => {
      const factory = spawnFactoryReturning(externalBin, '2.3.4');
      const result = await collectHarnessVersions({
        projectRoot: root,
        homeDirs: [],
        cache: new Map(),
        spawnFactory: factory,
      });
      const row = rowOf(harnessOf(result.harnesses, 'opencode'), 'opencode-ai');
      assert.equal(row.source, 'settings');
      assert.equal(row.installed, '2.3.4');
      assert.equal(row.status, 'external');
      assert.equal(row.canUpdate, false);
      assert.equal(factory.spy.count, 1);
    });
  } finally {
    saveSettings({});
  }
});

test('a CLI found through PATH is external, and the probe result is cached', async () => {
  const home = makeTempDir('home');
  const pathBin = writeExecutable(path.join(home, '.opencode', 'bin', 'opencode'));
  const root = makeFixtureProject();
  const spy = { count: 0, calls: [] };
  const options = {
    projectRoot: root,
    homeDirs: [home],
    cache: new Map(),
    spawnFactory: (file, args) => {
      spy.calls.push({ file, args });
      spy.count += 1;
      return fakeSpawnFactory({ output: 'opencode 5.6.7\n' }, {})(file, args);
    },
  };
  await withEmptyPath(async () => {
    const first = await collectHarnessVersions(options);
    const row = rowOf(harnessOf(first.harnesses, 'opencode'), 'opencode-ai');
    assert.equal(row.source, 'path');
    assert.equal(row.installed, '5.6.7');
    assert.equal(row.status, 'external');
    const second = await collectHarnessVersions(options);
    assert.equal(rowOf(harnessOf(second.harnesses, 'opencode'), 'opencode-ai').installed, '5.6.7');
    assert.equal(spy.count, 1, 'the second inventory reuses the cached version');
  });
});

test('a hanging --version times out, kills the child and yields unknown', async () => {
  const spy = { killed: false, count: 0 };
  const startedAt = Date.now();
  const version = await readVersionFromBinary('/opt/hangs/dsh', {
    timeoutMs: 40,
    spawnFactory: (file, args) => fakeSpawnFactory({ hang: true }, spy)(file, args),
  });
  assert.equal(version, '');
  assert.equal(spy.count, 1);
  assert.equal(spy.killed, true, 'the deadline must kill the child');
  assert.ok(Date.now() - startedAt < 5000, 'the probe must not outlive its deadline');
});

test('a failing --version yields unknown instead of throwing', async () => {
  const fromSpawnError = await readVersionFromBinary('/opt/broken/dsh', {
    timeoutMs: 40,
    spawnFactory: fakeSpawnFactory({ error: 'ENOENT' }),
  });
  assert.equal(fromSpawnError, '');
  const fromExitCode = await readVersionFromBinary('/opt/broken/dsh', {
    timeoutMs: 40,
    spawnFactory: fakeSpawnFactory({ output: '0.0.0\n', code: 1 }),
  });
  assert.equal(fromExitCode, '', 'a non-zero exit is not a version');
  const fromThrowingFactory = await readVersionFromBinary('/opt/broken/dsh', {
    timeoutMs: 40,
    spawnFactory: () => {
      throw new Error('spawn EACCES');
    },
  });
  assert.equal(fromThrowingFactory, '');
  assert.equal(await readVersionFromBinary(''), '', 'nothing to probe');
});

test('a hanging binary degrades the inventory to unknown, never a thrown error', async () => {
  process.env.QWEN_BIN = '/opt/hangs/qwen';
  try {
    const root = makeFixtureProject();
    await withEmptyPath(async () => {
      const result = await collectHarnessVersions({
        projectRoot: root,
        homeDirs: [],
        cache: new Map(),
        timeoutMs: 40,
        spawnFactory: fakeSpawnFactory({ hang: true }),
      });
      const qwen = harnessOf(result.harnesses, 'qwen');
      const row = rowOf(qwen, '@qwen-code/sdk');
      assert.equal(row.source, 'env');
      assert.equal(row.installed, null);
      assert.equal(row.status, 'unknown');
      assert.equal(row.canUpdate, false);
      assert.equal(qwen.status, 'unknown');
    });
  } finally {
    clearCliEnv();
  }
});

test('a .js wrapper is spawned through node', () => {
  assert.deepEqual(
    buildVersionSpawnArgs('/opt/pkg/bin/codex.js', { execPath: '/usr/bin/node' }),
    { file: '/usr/bin/node', args: ['/opt/pkg/bin/codex.js', '--version'] },
  );
  assert.deepEqual(
    buildVersionSpawnArgs('/opt/pkg/bin/codex', { execPath: '/usr/bin/node' }),
    { file: '/opt/pkg/bin/codex', args: ['--version'] },
  );
});

test('version text is parsed out of banner output', () => {
  assert.equal(parseVersionOutput('dsh 0.9.9\n'), '0.9.9');
  assert.equal(parseVersionOutput('codex-cli 0.160.0\n'), '0.160.0');
  assert.equal(parseVersionOutput('OpenCode version 1.18.26-beta.1'), '1.18.26-beta.1');
  assert.equal(parseVersionOutput('  \n no digits here  '), 'no digits here');
  assert.equal(parseVersionOutput(''), '');
});

test('the harness rollup prefers missing, unknown then external', () => {
  assert.equal(rollupHarnessStatus([]), 'unknown');
  assert.equal(rollupHarnessStatus([{ status: 'missing' }, { status: 'missing' }]), 'missing');
  assert.equal(rollupHarnessStatus([{ status: 'managed' }, { status: 'missing' }]), 'missing');
  assert.equal(rollupHarnessStatus([{ status: 'managed' }, { status: 'unknown' }]), 'unknown');
  assert.equal(rollupHarnessStatus([{ status: 'managed' }, { status: 'external' }]), 'external');
  assert.equal(rollupHarnessStatus([{ status: 'managed' }]), 'managed');
  assert.equal(
    rollupHarnessStatus([
      { status: 'managed', role: 'sdk' },
      { status: 'missing', role: 'native', requiredBy: '@openai/codex' },
    ]),
    'missing',
    'a missing transitive native row pulls the rollup down',
  );
  assert.equal(
    rollupHarnessStatus([
      { status: 'managed', role: 'sdk' },
      { status: 'missing', role: 'cli' },
    ]),
    'missing',
  );
});

test('default OpenCode home dirs probe passwd home after env HOME', async () => {
  const envHome = makeTempDir('oc-env-home');
  const passwdHome = makeTempDir('oc-passwd-home');
  const opencodeBin = writeExecutable(path.join(passwdHome, '.opencode', 'bin', 'opencode'));
  const root = makeFixtureProject();
  const spy = { count: 0, calls: [] };
  await withEmptyPath(async () => {
    const result = await collectHarnessVersions({
      projectRoot: root,
      openCodeHomeDirs: { envHome, passwdHome },
      cache: new Map(),
      spawnFactory: (file, args) => {
        spy.calls.push({ file, args });
        spy.count += 1;
        return fakeSpawnFactory({ output: 'opencode 8.8.8\n' }, {})(file, args);
      },
    });
    const row = rowOf(harnessOf(result.harnesses, 'opencode'), 'opencode-ai');
    assert.equal(row.source, 'path');
    assert.equal(row.installed, '8.8.8');
    assert.equal(row.status, 'external');
    assert.deepEqual(spy.calls, [{ file: opencodeBin, args: ['--version'] }]);
  });
});

test('a CLI package in node_modules without a resolvable binary is missing, not bundled', async () => {
  const root = makeFixtureProject();
  const { factory, spy } = forbiddenSpawn();
  await withEmptyPath(async () => {
    const result = await collectHarnessVersions({
      projectRoot: root,
      homeDirs: [],
      spawnFactory: factory,
    });
    const row = rowOf(harnessOf(result.harnesses, 'opencode'), 'opencode-ai');
    assert.equal(row.installed, '1.18.26');
    assert.equal(row.source, 'missing');
    assert.equal(row.status, 'missing');
    assert.equal(row.canUpdate, false);
    assert.equal(spy.count, 0);
  });
});

test('codex harness rollup is missing when the platform package is absent', async () => {
  const root = makeFixtureProject();
  const { factory, spy } = forbiddenSpawn();
  await withEmptyPath(async () => {
    const result = await collectHarnessVersions({
      projectRoot: root,
      homeDirs: [],
      spawnFactory: factory,
    });
    const codex = harnessOf(result.harnesses, 'codex');
    const native = codex.packages.find((row) => row.role === 'native');
    assert.ok(native, 'expected a native platform row');
    assert.equal(native.status, 'missing');
    assert.equal(codex.status, 'missing');
    assert.equal(spy.count, 0);
  });
});

test('the snapshot is persisted under the data directory', async () => {
  const root = makeFixtureProject();
  const { factory, spy } = forbiddenSpawn();
  await withEmptyPath(async () => {
    const result = await getHarnessVersionInventory({
      projectRoot: root,
      homeDirs: [],
      spawnFactory: factory,
    });
    const expectedPath = path.join(ISOLATED_DATA_DIR, SNAPSHOT_FILE_NAME);
    assert.equal(result.snapshotPath, expectedPath);
    assert.equal(fs.existsSync(expectedPath), true);
    const snapshot = readHarnessVersionsSnapshot();
    assert.equal(snapshot.checkedAt, result.checkedAt);
    assert.equal(snapshot.harnesses.length, HARNESS_IDS.length);
    assert.equal(rowOf(harnessOf(snapshot.harnesses, 'sdk'), '@cursor/sdk').installed, '1.0.37');

    const skipped = await getHarnessVersionInventory({
      projectRoot: root,
      homeDirs: [],
      persist: false,
      spawnFactory: factory,
    });
    assert.equal(skipped.snapshotPath, undefined);
    assert.equal(skipped.harnesses.length, HARNESS_IDS.length);
    assert.equal(spy.count, 0, 'a bundled install must not spawn');
  });
});

test('snapshot write failure returns 200 with snapshotError, not 500', async () => {
  const root = makeFixtureProject();
  const blockFile = path.join(makeTempDir('snapshot-block'), 'not-a-directory');
  fs.writeFileSync(blockFile, 'blocked\n', 'utf8');
  const snapshotPath = path.join(blockFile, SNAPSHOT_FILE_NAME);
  const { factory } = forbiddenSpawn();
  const inventory = async (options) => getHarnessVersionInventory({
    ...options,
    projectRoot: root,
    homeDirs: [],
    snapshotPath,
    spawnFactory: factory,
  });
  const app = express();
  registerHarnessVersionsRoutes(app, { inventory });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/harness/versions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.snapshotError, 'string');
    assert.ok(body.snapshotError.length > 0);
    assert.equal(body.snapshotPath, undefined);
    assert.equal(body.harnesses.length, HARNESS_IDS.length);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/harness/versions answers the inventory and persists the snapshot', async () => {
  const root = makeFixtureProject({ omit: ['@cursor/sdk'] });
  const seen = [];
  const { factory, spy } = forbiddenSpawn();
  const inventory = async (options) => {
    seen.push(options);
    return getHarnessVersionInventory({
      ...options,
      projectRoot: root,
      homeDirs: [],
      checkedAt: '2026-10-08T00:00:00.000Z',
      spawnFactory: factory,
    });
  };
  const app = express();
  app.use(requireAuth);
  registerHarnessVersionsRoutes(app, { inventory });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const sessionToken = createSession();
  const stored = path.join(ISOLATED_DATA_DIR, SNAPSHOT_FILE_NAME);
  if (fs.existsSync(stored)) fs.rmSync(stored);
  try {
    await withEmptyPath(async () => {
      const base = `http://127.0.0.1:${server.address().port}/api/harness/versions`;
      const anonymous = await fetch(base);
      assert.equal(anonymous.status, 401);
      assert.equal((await anonymous.json()).authRequired, true);

      const res = await fetch(base, { headers: { cookie: `cr_session=${encodeURIComponent(sessionToken)}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.checkedAt, '2026-10-08T00:00:00.000Z');
      assert.deepEqual(body.harnesses.map((entry) => entry.harness).sort(), [...HARNESS_IDS].sort());
      assert.equal(rowOf(harnessOf(body.harnesses, 'sdk'), '@cursor/sdk').status, 'missing');
      assert.equal(harnessOf(body.harnesses, 'openrouter').status, 'n/a');
      assert.equal(body.snapshotPath, stored);
      assert.equal(fs.existsSync(stored), true);
      assert.deepEqual(seen, [{ persist: true, check: false, force: false }]);

      const skipped = await fetch(`${base}?persist=0`, {
        headers: { cookie: `cr_session=${encodeURIComponent(sessionToken)}` },
      });
      assert.equal(skipped.status, 200);
      assert.equal((await skipped.json()).snapshotPath, undefined);
      assert.deepEqual(seen[1], { persist: false, check: false, force: false });
      assert.equal(fs.existsSync(stored), true, 'the earlier snapshot stays on disk');
      assert.equal(spy.count, 0, 'the route answer stayed spawn free');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the endpoint rejects widget and MCP token callers before collecting', async () => {
  for (const flag of ['widgetAccess', 'mcpIntegration']) {
    const app = express();
    app.use((req, _res, next) => {
      req[flag] = { installationId: 'some-fixture-id' };
      next();
    });
    registerHarnessVersionsRoutes(app, {
      inventory: async () => assert.fail(`a ${flag} caller must not reach the inventory`),
    });
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/harness/versions`);
      assert.equal(res.status, 403, flag);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(typeof body.error, 'string');
      assert.ok(body.error.length > 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('a failing collector answers 500 instead of hanging the request', async () => {
  const app = express();
  registerHarnessVersionsRoutes(app, {
    inventory: async () => {
      throw new Error('manifest unreadable');
    },
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/harness/versions`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: 'manifest unreadable' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the endpoint is registered with the session routes, not the dev block', () => {
  const source = fs.readFileSync(new URL('../lib/register-app-routes.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /import \{ registerHarnessVersionsRoutes \} from '\.\/routes\/harness-versions-routes\.js';/,
  );
  const appRoutes = source.slice(
    source.indexOf('export function registerAppRoutes'),
    source.indexOf('export function registerDevAndUpdateRoutes'),
  );
  assert.match(appRoutes, /registerHarnessCatalogRoutes\(app\);\n\s*registerHarnessVersionsRoutes\(app\);/);
});
