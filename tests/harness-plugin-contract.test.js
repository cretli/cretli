import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_TRANSPORTS } from '../lib/agent-transport.js';
import {
  HARNESS_BUILTIN_IDS,
  HARNESS_PLUGIN_API_VERSION,
  HARNESS_PLUGIN_CAPABILITY_KEYS,
  HARNESS_RESERVED_IDS,
  buildHarnessPluginStatus,
  buildHarnessProviderMetadata,
  isHarnessPluginSemver,
  isSafeHarnessPluginEntry,
  normalizeHarnessPluginCapabilities,
  resolveHarnessEnabledState,
  resolveHarnessProvider,
  validateHarnessPluginManifest,
  validateHarnessPluginSet,
} from '../lib/agent-harness/harness-plugin-contract.js';

/** @returns {object} */
function localManifest(overrides = {}) {
  return {
    apiVersion: 1,
    id: 'my-harness',
    version: '1.2.3',
    hostMin: '0.4.0',
    label: 'My Harness',
    description: 'A local test harness.',
    origin: 'local',
    entry: './index.js',
    capabilities: { chat: true },
    ...overrides,
  };
}

test('contract constants are closed and derive from built-in transports', () => {
  assert.equal(HARNESS_PLUGIN_API_VERSION, 1);
  assert.deepEqual(HARNESS_PLUGIN_CAPABILITY_KEYS, [
    'chat',
    'models',
    'status',
    'settings',
    'mcp',
    'delegation',
    'serverRun',
  ]);
  assert.deepEqual(HARNESS_BUILTIN_IDS, AGENT_TRANSPORTS);
  for (const id of AGENT_TRANSPORTS) {
    assert.equal(HARNESS_RESERVED_IDS.includes(id), true);
  }
  assert.equal(HARNESS_RESERVED_IDS.includes('cursor'), true);
});

test('a valid local manifest normalizes with every capability key present', () => {
  const result = validateHarnessPluginManifest(localManifest());
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, 'my-harness');
  assert.equal(result.manifest.origin, 'local');
  assert.equal(result.manifest.entry, './index.js');
  assert.deepEqual(result.manifest.capabilities, {
    chat: true,
    models: false,
    status: false,
    settings: false,
    mcp: false,
    delegation: false,
    serverRun: false,
  });
});

test('static model catalogs require capability and normalize safe id/label values', () => {
  const valid = validateHarnessPluginManifest(localManifest({
    capabilities: { models: true },
    models: [
      { id: ' vendor/model-v1 ', label: ' Model V1 ' },
      { id: 'model-v2' },
    ],
  }));
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.manifest.models, [
    { id: 'vendor/model-v1', label: 'Model V1' },
    { id: 'model-v2' },
  ]);
  const metadata = buildHarnessProviderMetadata(localManifest({
    capabilities: { models: true },
    models: [{ id: 'model-v1', label: '<script>safe text</script>' }],
  }));
  assert.deepEqual(metadata.metadata.models, [{ id: 'model-v1', label: '<script>safe text</script>' }]);
  assert.equal(Object.hasOwn(metadata.metadata, 'entry'), false);
});

test('models are rejected unless capability is true and each row is valid and unique', () => {
  const invalid = [
    localManifest({ models: [] }),
    localManifest({ capabilities: { models: true }, models: {} }),
    localManifest({ capabilities: { models: true }, models: [{ id: ' ' }] }),
    localManifest({ capabilities: { models: true }, models: [{ id: 'x'.repeat(161) }] }),
    localManifest({ capabilities: { models: true }, models: [{ id: 'one' }, { id: 'one' }] }),
    localManifest({ capabilities: { models: true }, models: [{ id: 'one', label: ' ' }] }),
    localManifest({ capabilities: { models: true }, models: [{ id: 'one', label: 'L'.repeat(161) }] }),
    localManifest({ capabilities: { models: true }, models: [{ id: 'one', entry: '/secret/path' }] }),
    localManifest({ capabilities: { models: true }, models: Array.from({ length: 201 }, (_, i) => ({ id: `m${i}` })) }),
  ];
  for (const manifest of invalid) {
    const result = validateHarnessPluginManifest(manifest);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'manifest_invalid');
  }
});

test('missing capabilities default to false', () => {
  const result = validateHarnessPluginManifest(localManifest({ capabilities: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.manifest.capabilities.chat, false);
  assert.equal(normalizeHarnessPluginCapabilities(undefined).chat, false);
});

test('a builtin manifest is valid without an entry path', () => {
  const result = validateHarnessPluginManifest(localManifest({
    origin: 'builtin',
    entry: undefined,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.manifest.entry, undefined);
});

test('apiVersion must be the supported integer', () => {
  for (const apiVersion of [undefined, 0, 2, '1', 1.5]) {
    const result = validateHarnessPluginManifest(localManifest({ apiVersion }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'manifest_invalid');
    assert.equal(result.field, 'apiVersion');
  }
});

test('id must be a stable lowercase slug', () => {
  for (const id of ['My-Harness', 'my harness', '1harness', '-harness', 'harness-', 'ha--rness', 'x']) {
    const result = validateHarnessPluginManifest(localManifest({ id }));
    assert.equal(result.ok, false, `expected ${id} to be rejected`);
    assert.equal(result.code, 'manifest_invalid');
    assert.equal(result.field, 'id');
  }
  assert.equal(validateHarnessPluginManifest(localManifest({ id: 'qwen-local' })).ok, true);
});

test('built-in transport ids and legacy aliases are reserved', () => {
  for (const id of [...AGENT_TRANSPORTS, 'cursor']) {
    const result = validateHarnessPluginManifest(localManifest({ id }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'id_reserved');
    assert.equal(result.field, 'id');
  }
});

test('reservedIds can be narrowed for isolated callers', () => {
  const result = validateHarnessPluginManifest(
    localManifest({ id: 'sdk', origin: 'builtin', entry: undefined }),
    { reservedIds: [] },
  );
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, 'sdk');
});

test('version and hostMin must be semver strings', () => {
  for (const field of ['version', 'hostMin']) {
    for (const value of [undefined, '', 'v1.2.3', '1.2', '1.2.3.4', 123]) {
      const result = validateHarnessPluginManifest(localManifest({ [field]: value }));
      assert.equal(result.ok, false, `expected ${field}=${value} to be rejected`);
      assert.equal(result.code, 'manifest_invalid');
      assert.equal(result.field, field);
    }
  }
  assert.equal(isHarnessPluginSemver('1.2.3'), true);
  assert.equal(isHarnessPluginSemver('1.2.3-beta.1+build.7'), true);
  assert.equal(isHarnessPluginSemver('not-a-version'), false);
});

test('label and description must be non-empty and bounded', () => {
  for (const field of ['label', 'description']) {
    for (const value of [undefined, '', '   ', 42]) {
      const result = validateHarnessPluginManifest(localManifest({ [field]: value }));
      assert.equal(result.ok, false, `expected ${field}=${JSON.stringify(value)} to be rejected`);
      assert.equal(result.code, 'manifest_invalid');
      assert.equal(result.field, field);
    }
  }
  assert.equal(validateHarnessPluginManifest(localManifest({ label: 'x'.repeat(65) })).field, 'label');
  assert.equal(
    validateHarnessPluginManifest(localManifest({ description: 'x'.repeat(281) })).field,
    'description',
  );
});

test('origin is a closed builtin|local set', () => {
  for (const origin of [undefined, 'remote', 'BUILTIN', '']) {
    const result = validateHarnessPluginManifest(localManifest({ origin }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'manifest_invalid');
    assert.equal(result.field, 'origin');
  }
});

test('entry must be a safe relative path', () => {
  for (const entry of [
    undefined,
    '/etc/passwd',
    '../outside.js',
    'dist/../../outside.js',
    'dist\\plugin.js',
    'https://evil.example/plugin.js',
    'file:///tmp/x.js',
    'dist//plugin.js',
    'dist/',
    'has space.js',
    'dist/plugin\u0000.js',
  ]) {
    const result = validateHarnessPluginManifest(localManifest({ entry }));
    assert.equal(result.ok, false, `expected entry ${JSON.stringify(entry)} to be rejected`);
    assert.equal(result.code, 'manifest_invalid');
    assert.equal(result.field, 'entry');
  }
  for (const entry of ['./index.js', 'dist/plugin.mjs', 'src/my_plugin@2.js']) {
    const result = validateHarnessPluginManifest(localManifest({ entry }));
    assert.equal(result.ok, true, `expected entry ${entry} to be accepted`);
  }
  assert.equal(isSafeHarnessPluginEntry('./index.js'), true);
  assert.equal(isSafeHarnessPluginEntry('../index.js'), false);
});

test('builtin plugins must not declare an entry path', () => {
  const result = validateHarnessPluginManifest(localManifest({
    origin: 'builtin',
    entry: './index.js',
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'manifest_invalid');
  assert.equal(result.field, 'entry');
});

test('capabilities are closed booleans', () => {
  const unknown = validateHarnessPluginManifest(localManifest({
    capabilities: { chat: true, teleport: true },
  }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'manifest_invalid');
  assert.equal(unknown.field, 'capabilities.teleport');

  const nonBoolean = validateHarnessPluginManifest(localManifest({
    capabilities: { chat: 'yes' },
  }));
  assert.equal(nonBoolean.ok, false);
  assert.equal(nonBoolean.code, 'manifest_invalid');
  assert.equal(nonBoolean.field, 'capabilities.chat');

  const notObject = validateHarnessPluginManifest(localManifest({ capabilities: ['chat'] }));
  assert.equal(notObject.ok, false);
  assert.equal(notObject.code, 'manifest_invalid');
  assert.equal(notObject.field, 'capabilities');
});

test('unknown manifest fields and non-objects are rejected', () => {
  const unknown = validateHarnessPluginManifest(localManifest({ capabilites: {} }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'manifest_invalid');
  assert.equal(unknown.field, 'capabilites');

  for (const raw of [null, undefined, 'manifest', 7, []]) {
    const result = validateHarnessPluginManifest(raw);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'manifest_invalid');
  }
});

test('validateHarnessPluginSet reports id_collision for duplicate ids', () => {
  const result = validateHarnessPluginSet([
    localManifest({ id: 'alpha', entry: 'alpha/index.js' }),
    localManifest({ id: 'alpha', entry: 'alpha/other.js' }),
    localManifest({ id: 'beta', entry: 'beta/index.js' }),
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicateIds, ['alpha']);
  assert.equal(result.manifests.length, 2);
  assert.equal(result.errors[0].code, 'id_collision');
});

test('validateHarnessPluginSet collects per-entry errors and rejects non-arrays', () => {
  const result = validateHarnessPluginSet([
    localManifest({ id: 'sdk' }),
    localManifest({ id: 'Bad Id' }),
    localManifest({ id: 'gamma', entry: 'gamma/index.js' }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.manifests.length, 1);
  assert.deepEqual(result.errors.map((row) => row.code), ['id_reserved', 'manifest_invalid']);

  const notArray = validateHarnessPluginSet({});
  assert.equal(notArray.ok, false);
  assert.equal(notArray.errors[0].code, 'manifest_invalid');
});

test('provider metadata omits the local entry path', () => {
  const result = buildHarnessProviderMetadata(localManifest());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.metadata).sort(), [
    'apiVersion',
    'capabilities',
    'description',
    'hostMin',
    'id',
    'label',
    'origin',
    'version',
  ]);
  assert.equal('entry' in result.metadata, false);

  const invalid = buildHarnessProviderMetadata(localManifest({ id: 'sdk' }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'id_reserved');
});

test('plugin status defaults builtin on and local off', () => {
  const builtin = buildHarnessPluginStatus(
    localManifest({ origin: 'builtin', entry: undefined, capabilities: { delegation: true } }),
  );
  assert.equal(builtin.ok, true);
  assert.equal(builtin.status.enabled, true);
  assert.equal(builtin.status.available, false);
  assert.equal(builtin.status.canDelegate, true);

  const local = buildHarnessPluginStatus(localManifest());
  assert.equal(local.ok, true);
  assert.equal(local.status.enabled, false);
  assert.equal(local.status.canDelegate, false);
  assert.equal(local.status.reason, '');

  const overridden = buildHarnessPluginStatus(localManifest(), {
    enabled: true,
    available: true,
    configured: true,
    reason: 'ready',
  });
  assert.deepEqual(
    { ...overridden.status, capabilities: undefined },
    {
      id: 'my-harness',
      label: 'My Harness',
      origin: 'local',
      enabled: true,
      available: true,
      configured: true,
      canDelegate: false,
      capabilities: undefined,
      reason: 'ready',
    },
  );
});

test('resolveHarnessProvider rejects a disabled plugin even when available', () => {
  const providers = [validateHarnessPluginManifest(localManifest()).manifest];

  const disabled = resolveHarnessProvider({
    id: 'my-harness',
    providers,
    statuses: { 'my-harness': { enabled: false, available: true } },
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, 'plugin_disabled');
  assert.equal(disabled.manifest.id, 'my-harness');
  assert.equal(disabled.status.enabled, false);

  // A disabled plugin can never be resolved, even if its backend is missing too.
  const both = resolveHarnessProvider({
    id: 'my-harness',
    providers,
    statuses: { 'my-harness': { enabled: false, available: false } },
  });
  assert.equal(both.ok, false);
  assert.equal(both.code, 'plugin_disabled');

  // `enabled: true` stays resolvable; only an explicit `false` rejects.
  const enabled = resolveHarnessProvider({
    id: 'my-harness',
    providers,
    statuses: { 'my-harness': { enabled: true, available: true } },
  });
  assert.equal(enabled.ok, true);
});

test('resolveHarnessProvider distinguishes unknown from unavailable', () => {
  const providers = [validateHarnessPluginManifest(localManifest()).manifest];

  const unknown = resolveHarnessProvider({ id: 'nope', providers });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown_harness');

  const unavailable = resolveHarnessProvider({
    id: 'my-harness',
    providers,
    statuses: { 'my-harness': { available: false } },
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'plugin_unavailable');
  assert.equal(unavailable.manifest.id, 'my-harness');

  const ok = resolveHarnessProvider({
    id: 'my-harness',
    providers,
    statuses: { 'my-harness': { available: true } },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.id, 'my-harness');

  const missingId = resolveHarnessProvider({ providers });
  assert.equal(missingId.ok, false);
  assert.equal(missingId.code, 'manifest_invalid');
});

test('null, missing, empty, or full builtin list enables every builtin and no local', () => {
  const localIds = ['my-harness', 'other-local'];
  for (const savedIds of [undefined, null, [], AGENT_TRANSPORTS.slice(), [...AGENT_TRANSPORTS, ...localIds]]) {
    const state = resolveHarnessEnabledState({ savedIds, localIds });
    assert.equal(state.allBuiltinsEnabled, true, `saved=${JSON.stringify(savedIds)}`);
    assert.deepEqual(state.enabledBuiltinIds, AGENT_TRANSPORTS.slice());
    // `allBuiltinsEnabled` always means no discovered local plugin is enabled,
    // even when the saved list contains every builtin plus local ids.
    assert.deepEqual(state.enabledLocalIds, []);
    assert.deepEqual(state.enabledIds, AGENT_TRANSPORTS.slice());
    assert.equal(state.enabledBuiltinIds.includes('my-harness'), false);
  }
});

test('a builtin subset enables only that subset and keeps locals default-off', () => {
  const state = resolveHarnessEnabledState({
    savedIds: ['sdk', 'opencode'],
    localIds: ['my-harness'],
  });
  assert.equal(state.allBuiltinsEnabled, false);
  assert.deepEqual(state.enabledBuiltinIds, ['sdk', 'opencode']);
  assert.deepEqual(state.enabledLocalIds, []);
  assert.deepEqual(state.enabledIds, ['sdk', 'opencode']);
});

test('a saved local plugin is enabled explicitly and never leaks into the builtin list', () => {
  const state = resolveHarnessEnabledState({
    savedIds: ['sdk', 'my-harness'],
    localIds: ['my-harness'],
  });
  assert.equal(state.allBuiltinsEnabled, false);
  assert.deepEqual(state.enabledBuiltinIds, ['sdk']);
  assert.deepEqual(state.enabledLocalIds, ['my-harness']);
  assert.deepEqual(state.enabledIds, ['sdk', 'my-harness']);
  assert.equal(state.enabledBuiltinIds.includes('my-harness'), false);
});

test('unknown saved ids are preserved for the caller but omitted from generated lists', () => {
  const state = resolveHarnessEnabledState({
    savedIds: ['sdk', 'ghost-plugin', 'my-harness', 'another-ghost'],
    localIds: ['my-harness'],
  });
  assert.deepEqual(state.preservedUnknownIds, ['ghost-plugin', 'another-ghost']);
  assert.deepEqual(state.enabledBuiltinIds, ['sdk']);
  assert.deepEqual(state.enabledLocalIds, ['my-harness']);
  assert.equal(state.enabledIds.includes('ghost-plugin'), false);
});

test('a custom builtin list drives the full-list invariant', () => {
  const state = resolveHarnessEnabledState({
    builtinIds: ['sdk', 'codex'],
    localIds: ['my-harness'],
    savedIds: ['sdk', 'codex'],
  });
  assert.equal(state.allBuiltinsEnabled, true);
  assert.deepEqual(state.enabledBuiltinIds, ['sdk', 'codex']);
  assert.deepEqual(state.enabledLocalIds, []);
});

test('an all-builtins saved list never auto-enables a discovered local plugin', () => {
  const localIds = ['my-harness', 'other-local'];
  const state = resolveHarnessEnabledState({
    savedIds: AGENT_TRANSPORTS.slice(),
    localIds,
  });
  assert.equal(state.allBuiltinsEnabled, true);
  assert.deepEqual(state.enabledBuiltinIds, AGENT_TRANSPORTS.slice());
  assert.deepEqual(state.enabledLocalIds, []);
  assert.deepEqual(state.preservedUnknownIds, []);
  assert.equal(state.enabledBuiltinIds.includes('my-harness'), false);
});

test('the legacy cursor saved id is normalized to sdk before resolution', () => {
  const state = resolveHarnessEnabledState({
    savedIds: ['cursor'],
    localIds: ['my-harness'],
  });
  assert.equal(state.allBuiltinsEnabled, false);
  assert.deepEqual(state.enabledBuiltinIds, ['sdk']);
  assert.deepEqual(state.enabledLocalIds, []);
  assert.deepEqual(state.preservedUnknownIds, []);
  assert.deepEqual(state.enabledIds, ['sdk']);

  const mixed = resolveHarnessEnabledState({
    savedIds: ['Cursor', 'opencode', 'my-harness'],
    localIds: ['my-harness'],
  });
  assert.deepEqual(mixed.enabledBuiltinIds, ['sdk', 'opencode']);
  assert.deepEqual(mixed.enabledLocalIds, ['my-harness']);
  assert.deepEqual(mixed.preservedUnknownIds, []);
});
