import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AGENT_TRANSPORTS } from '../lib/agent-transport.js';
import {
  getBuiltinHarnessBackend,
  listBuiltinHarnessBackends,
} from '../lib/agent-harness/builtin-harness-backends.ts';
import {
  listNotRefreshableHarnesses,
  listRefreshableHarnesses,
} from '../lib/harness-models-refresh.js';

const BACKENDS_SOURCE = readFileSync(
  new URL('../lib/agent-harness/builtin-harness-backends.ts', import.meta.url),
  'utf8',
);

test('every transport, sdk included, has exactly one backend', () => {
  const ids = listBuiltinHarnessBackends().map((backend) => backend.id);
  assert.deepEqual([...ids].sort(), [...AGENT_TRANSPORTS].sort());
  for (const id of AGENT_TRANSPORTS) {
    const backend = getBuiltinHarnessBackend(id);
    assert.ok(backend, id);
    assert.equal(typeof backend.status, 'function', id);
    assert.equal(Object.isFrozen(backend), true, id);
  }
  assert.equal(getBuiltinHarnessBackend('cursor'), null);
});

test('refreshable set is unchanged by the registry (opencode needs a live workspace)', () => {
  assert.deepEqual(
    listRefreshableHarnesses().sort(),
    ['claude', 'codebuddy', 'codex', 'deepseek', 'mimo', 'mistral', 'openrouter', 'qwen', 'sdk', 'zai'],
  );
  assert.deepEqual(listNotRefreshableHarnesses(), ['opencode']);
  assert.match(getBuiltinHarnessBackend('opencode').notRefreshableReason, /live OpenCode workspace/);
  const inference = listBuiltinHarnessBackends().filter((backend) => backend.refreshIsNetworkInference);
  assert.deepEqual(inference.map((backend) => backend.id), ['codex']);
});

test('catalog fields keep the pre-registry per-harness rules', () => {
  const backends = listBuiltinHarnessBackends();
  for (const backend of backends) {
    assert.match(backend.enabledModelsKey, /ChatEnabledModels$|^chatEnabledModels$/, backend.id);
    assert.equal(typeof backend.credentialsReadySync, 'function', backend.id);
  }
  assert.equal(getBuiltinHarnessBackend('sdk').enabledModelsKey, 'chatEnabledModels');
  assert.equal(getBuiltinHarnessBackend('qwen').enabledModelsKey, 'qwenChatEnabledModels');
  // opencode/openrouter use the generic Settings-list catalog.
  assert.deepEqual(
    backends.filter((backend) => !backend.offlineCatalog).map((backend) => backend.id).sort(),
    ['opencode', 'openrouter'],
  );
  assert.deepEqual(
    backends.filter((backend) => backend.favoritesMatchVariants).map((backend) => backend.id),
    ['claude'],
  );
  assert.deepEqual(
    backends.filter((backend) => backend.normalizeEnabledModels).map((backend) => backend.id).sort(),
    ['codebuddy', 'deepseek'],
  );
  const sdk = getBuiltinHarnessBackend('sdk').offlineCatalog(['custom-model']);
  assert.equal(sdk.source, 'settings');
  assert.equal(sdk.warning, 'Live Cursor catalog was not fetched.');
  assert.ok(sdk.entries.some((row) => row.value === 'custom-model'));
  assert.equal(getBuiltinHarnessBackend('qwen').offlineCatalog([]).source, 'fallback');
});

test('backend registry stays out of the harness runtime import graph', () => {
  // Importing a harness WebSocket module (or the provider registry that imports
  // them) here would pull status/catalog code into the room-kernel init cycle.
  assert.doesNotMatch(BACKENDS_SOURCE, /from\s+['"][^'"]*-agent-ws\.js['"]/);
  assert.doesNotMatch(BACKENDS_SOURCE, /from\s+['"][^'"]*builtin-harness-providers/);
});
