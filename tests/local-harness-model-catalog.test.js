import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { listHarnessModels, listHarnessModelsIncludingLocal } from '../lib/harness-catalog.js';
import { HARNESS_PLUGIN_ROOT_ENV, invalidateHarnessSnapshotCache } from '../lib/agent-harness/harness-snapshot-registry.js';
import { saveSettings } from '../lib/persist/settings.js';
import { registerHarnessCatalogRoutes } from '../lib/routes/harness-catalog-routes.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'cretli-local-models-'));
const importMarker = '__cretliLocalModelCatalogPluginExecuted';

function writePlugin(dir, manifest) {
  const pluginDir = path.join(root, dir);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, 'harness-plugin.json'), JSON.stringify(manifest));
  writeFileSync(path.join(pluginDir, 'index.mjs'), `globalThis.${importMarker} = true;`);
}

function manifest(id, overrides = {}) {
  return {
    apiVersion: 1,
    id,
    version: '1.0.0',
    hostMin: '0.0.1',
    label: `${id} Harness`,
    description: 'Static model catalog test plugin.',
    origin: 'local',
    entry: './index.mjs',
    capabilities: { models: true },
    ...overrides,
  };
}

function refreshCatalog() {
  invalidateHarnessSnapshotCache();
}

const previousRoot = process.env[HARNESS_PLUGIN_ROOT_ENV];
process.env[HARNESS_PLUGIN_ROOT_ENV] = root;
refreshCatalog();

try {
  delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  refreshCatalog();
  const noRootBuiltin = listHarnessModels({ harness: 'sdk' });
  const initialBuiltin = await listHarnessModelsIncludingLocal({ harness: 'sdk' });
  assert.deepEqual(initialBuiltin, noRootBuiltin, 'builtins without a plugin root keep their established shape');

  process.env[HARNESS_PLUGIN_ROOT_ENV] = root;
  refreshCatalog();
  writePlugin('alpha', manifest('alpha', {
    label: '<img src=x onerror=alert(1)>',
    entry: './index.mjs',
    models: [
      { id: 'alpha/model-1', label: '<script>model</script>' },
      { id: 'alpha/model-2' },
    ],
  }));
  writePlugin('no-model-capability', manifest('no-model-capability', {
    capabilities: { chat: true },
    models: undefined,
  }));
  writePlugin('empty-models', manifest('empty-models', { models: [] }));
  saveSettings({ enabledLocalHarnesses: [] });
  refreshCatalog();

  const disabled = await listHarnessModelsIncludingLocal({ harness: 'alpha' });
  assert.deepEqual(disabled.items, []);
  assert.equal(disabled.source, 'unavailable');
  assert.doesNotMatch(disabled.warning, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  saveSettings({ enabledLocalHarnesses: ['alpha', 'no-model-capability', 'empty-models'] });
  const listed = await listHarnessModelsIncludingLocal({ harness: 'alpha' });
  assert.equal(listed.source, 'manifest');
  assert.equal(listed.favorites_configured, false);
  assert.deepEqual(listed.items, [
    { id: 'alpha/model-1', label: '<script>model</script>', enabled: false, available: false },
    { id: 'alpha/model-2', label: 'alpha/model-2', enabled: false, available: false },
  ]);
  assert.deepEqual((await listHarnessModelsIncludingLocal({ harness: 'alpha', enabledOnly: true })).items, []);
  assert.deepEqual((await listHarnessModelsIncludingLocal({ harness: 'alpha', query: 'model-2' })).items.map(({ id }) => id), ['alpha/model-2']);
  assert.equal((await listHarnessModelsIncludingLocal({ harness: 'no-model-capability' })).items.length, 0);
  assert.equal((await listHarnessModelsIncludingLocal({ harness: 'empty-models' })).items.length, 0);
  assert.equal(globalThis[importMarker], undefined, 'catalog reads must not execute plugin entry code');

  await assert.rejects(
    listHarnessModelsIncludingLocal({ harness: 'not-discovered' }),
    (err) => err?.code === 'VALIDATION',
  );

  const app = express();
  registerHarnessCatalogRoutes(app);
  const server = await new Promise((resolve) => {
    const current = app.listen(0, '127.0.0.1', () => resolve(current));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/harness-catalog/models`;
    const httpResponse = await fetch(`${base}?harness=alpha`);
    assert.equal(httpResponse.status, 200);
    const httpBody = await httpResponse.json();
    assert.equal(httpBody.source, 'manifest');
    assert.equal(httpBody.items.length, 2);
    const unknownResponse = await fetch(`${base}?harness=not-discovered`);
    assert.equal(unknownResponse.status, 400);
    const unknownBody = await unknownResponse.text();
    assert.doesNotMatch(unknownBody, /index\.mjs|harness-plugin\.json/);
    assert.doesNotMatch(unknownBody, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const mcpClient = createInProcessMcpClient({ harness: 'sdk', chatId: '', workspaceFolder: '' });
    const handlers = createCretliMcpToolHandlers(mcpClient, { mode: 'agent', harness: 'sdk' });
    const mcpResult = await handlers.model_list({ harness: 'alpha' });
    assert.equal(mcpResult.isError, false);
    assert.equal(mcpResult.structuredContent.source, 'manifest');
    assert.equal(mcpResult.structuredContent.items.length, 2);
    const unknownMcp = await handlers.model_list({ harness: 'not-discovered' });
    assert.equal(unknownMcp.isError, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // Discovery remains memoized until explicit invalidation, then reflects manifest edits.
  writePlugin('alpha', manifest('alpha', { models: [{ id: 'alpha/model-3' }] }));
  const cached = await listHarnessModelsIncludingLocal({ harness: 'alpha' });
  assert.deepEqual(cached.items.map(({ id }) => id), ['alpha/model-1', 'alpha/model-2']);
  refreshCatalog();
  const refreshed = await listHarnessModelsIncludingLocal({ harness: 'alpha' });
  assert.deepEqual(refreshed.items.map(({ id }) => id), ['alpha/model-3']);
  assert.equal(globalThis[importMarker], undefined, 'cache refresh must still avoid plugin imports');
} finally {
  if (previousRoot === undefined) delete process.env[HARNESS_PLUGIN_ROOT_ENV];
  else process.env[HARNESS_PLUGIN_ROOT_ENV] = previousRoot;
  refreshCatalog();
  rmSync(root, { recursive: true, force: true });
  delete globalThis[importMarker];
  removeIsolatedDataDir();
}

console.log('local-harness-model-catalog.test.js OK');
