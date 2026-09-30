import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildHarnessProviderMetadata } from '../lib/agent-harness/harness-plugin-contract.js';
import {
  HARNESS_PLUGIN_MANIFEST_FILENAME,
  discoverHarnessPlugins,
  evaluateHostMinCompatibility,
  loadHarnessPlugins,
  resolveHarnessPluginRoot,
} from '../lib/agent-harness/harness-plugin-loader.js';

const MANIFEST = HARNESS_PLUGIN_MANIFEST_FILENAME;

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
 * @param {import('node:test').TestContext} t
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function makeTmp(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {object} manifest
 * @param {{ entryFile?: string, entrySource?: string }} [options]
 * @returns {Promise<string>} plugin directory
 */
async function addPlugin(root, dir, manifest, options = {}) {
  const pluginDir = path.join(root, dir);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, MANIFEST), JSON.stringify(manifest));
  if (options.entryFile) {
    const target = path.join(pluginDir, options.entryFile);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, options.entrySource ?? 'export default 1;\n');
  }
  return pluginDir;
}

/** @returns {(specifier: string) => Promise<unknown>} */
function spyImporter() {
  const calls = [];
  const importer = async (specifier) => {
    calls.push(specifier);
    return { specifier };
  };
  importer.calls = calls;
  return importer;
}

/** Minimal deterministic semver stand-in for dependency-free tests. */
const stubSemver = {
  valid: (value) => (value === 'bad' ? null : String(value)),
  gte: (a, b) => a === b || a > b,
};

test('resolves one explicit admin root with absolute non-symlink checks', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  const resolved = await resolveHarnessPluginRoot(root);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.root, root);

  for (const bad of [undefined, null, 42, '', '   ', './relative', 'plugins', 'https://evil.example/x']) {
    const result = await resolveHarnessPluginRoot(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.equal(result.code, 'root_invalid');
  }

  const missing = await resolveHarnessPluginRoot(path.join(root, 'does-not-exist'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'root_missing');

  const filePath = path.join(root, 'not-a-dir.txt');
  await writeFile(filePath, 'plain file');
  const notDir = await resolveHarnessPluginRoot(filePath);
  assert.equal(notDir.ok, false);
  assert.equal(notDir.code, 'root_invalid');

  const realDir = path.join(root, 'real');
  await mkdir(realDir, { recursive: true });
  const link = path.join(root, 'linked-root');
  await symlink(realDir, link, 'dir');
  const symlinked = await resolveHarnessPluginRoot(link);
  assert.equal(symlinked.ok, false);
  assert.equal(symlinked.code, 'root_symlink');
});

test('discovery returns a bad-root error without throwing', async () => {
  const result = await discoverHarnessPlugins({ root: path.join(os.tmpdir(), 'cretli-nope-missing') });
  assert.equal(result.ok, false);
  assert.deepEqual(result.plugins, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'root_missing');
});

test('discovers a valid local plugin and keeps entry host-internal', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), { entryFile: 'index.mjs' });

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, true);
  assert.equal(result.root, root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.plugins.length, 1);
  const [plugin] = result.plugins;
  assert.equal(plugin.dir, 'alpha');
  assert.equal(plugin.manifest.id, 'alpha');
  assert.equal(plugin.manifest.origin, 'local');
  assert.equal(path.isAbsolute(plugin.entryPath), true);
  assert.equal(plugin.entryPath, path.join(root, 'alpha', 'index.mjs'));

  const metadata = buildHarnessProviderMetadata(plugin.manifest);
  assert.equal(metadata.ok, true);
  assert.equal('entry' in metadata.metadata, false);
});

test('missing manifest is a per-plugin error and valid siblings survive', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await mkdir(path.join(root, 'empty'), { recursive: true });
  await addPlugin(root, 'good', localManifest('good'), { entryFile: 'index.mjs' });

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, false);
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].manifest.id, 'good');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].dir, 'empty');
  assert.equal(result.errors[0].code, 'manifest_missing');
});

test('malformed and contract-invalid manifests are per-plugin errors', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  const malformedDir = path.join(root, 'malformed');
  await mkdir(malformedDir, { recursive: true });
  await writeFile(path.join(malformedDir, MANIFEST), '{ not json');
  await addPlugin(root, 'invalid', localManifest('invalid', { label: '' }), { entryFile: 'index.mjs' });

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, false);
  assert.equal(result.plugins.length, 0);
  const byCode = Object.fromEntries(result.errors.map((row) => [row.code, row]));
  assert.equal(byCode.manifest_malformed.dir, 'malformed');
  assert.equal(byCode.manifest_invalid.dir, 'invalid');
  assert.equal(byCode.manifest_invalid.field, 'label');
});

test('non-local origin is rejected inside a local discovery root', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'builtinish', localManifest('builtinish', { origin: 'builtin', entry: undefined }));

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.plugins, []);
  assert.equal(result.errors[0].code, 'origin_not_local');
  assert.equal(result.errors[0].field, 'origin');
});

test('duplicate ids are reported as id_collision and de-duplicated', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'dup-a', localManifest('alpha'), { entryFile: 'index.mjs' });
  await addPlugin(root, 'dup-b', localManifest('alpha'), { entryFile: 'index.mjs' });

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicateIds, ['alpha']);
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].dir, 'dup-a');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'id_collision');
});

test('symlinked plugin directories are rejected, not followed', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  const outside = await makeTmp(t, 'cretli-plugin-outside-');
  await addPlugin(outside, 'real', localManifest('real'), { entryFile: 'index.mjs' });
  await symlink(path.join(outside, 'real'), path.join(root, 'linked'), 'dir');

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.plugins, []);
  assert.equal(result.errors[0].code, 'plugin_symlink');
  assert.equal(result.errors[0].dir, 'linked');
});

test('symlinked manifest files are rejected', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  const outside = await makeTmp(t, 'cretli-plugin-outside-');
  const realManifest = path.join(outside, 'manifest.json');
  await writeFile(realManifest, JSON.stringify(localManifest('linked-manifest')));
  const pluginDir = path.join(root, 'linked-manifest');
  await mkdir(pluginDir, { recursive: true });
  await symlink(realManifest, path.join(pluginDir, MANIFEST), 'file');

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'manifest_symlink');
});

test('missing and symlinked entry files are rejected', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'no-entry', localManifest('no-entry'), { entryFile: undefined });
  await addPlugin(root, 'linked-entry', localManifest('linked-entry'), { entryFile: undefined });
  const outside = await makeTmp(t, 'cretli-plugin-outside-');
  const realEntry = path.join(outside, 'index.mjs');
  await writeFile(realEntry, 'export default 1;\n');
  await symlink(realEntry, path.join(root, 'linked-entry', 'index.mjs'), 'file');

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, false);
  const byDir = Object.fromEntries(result.errors.map((row) => [row.dir, row]));
  assert.equal(byDir['no-entry'].code, 'entry_missing');
  assert.equal(byDir['linked-entry'].code, 'entry_symlink');
});

test('an entry reached through a symlinked subdirectory escapes and is rejected', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  const outside = await makeTmp(t, 'cretli-plugin-outside-');
  await writeFile(path.join(outside, 'plugin.mjs'), 'export default 1;\n');
  await addPlugin(root, 'escape', localManifest('escape', { entry: 'sub/plugin.mjs' }), { entryFile: undefined });
  await symlink(outside, path.join(root, 'escape', 'sub'), 'dir');

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.plugins, []);
  assert.equal(result.errors[0].code, 'entry_escape');
});

test('hidden directories and plain files are ignored', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, '.hidden', localManifest('hidden'), { entryFile: 'index.mjs' });
  await writeFile(path.join(root, 'README.md'), 'not a plugin');

  const result = await discoverHarnessPlugins({ root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plugins, []);
  assert.deepEqual(result.errors, []);
});

test('evaluateHostMinCompatibility is deterministic with an injected comparator', async () => {
  const compatible = await evaluateHostMinCompatibility('1.0.0', '1.2.3', { semver: stubSemver });
  assert.equal(compatible.evaluated, true);
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.reason, 'compatible');

  const tooOld = await evaluateHostMinCompatibility('9.0.0', '1.2.3', { semver: stubSemver });
  assert.equal(tooOld.evaluated, true);
  assert.equal(tooOld.compatible, false);
  assert.equal(tooOld.reason, 'host_too_old');

  const unparseable = await evaluateHostMinCompatibility('bad', '1.2.3', { semver: stubSemver });
  assert.equal(unparseable.evaluated, false);
  assert.equal(unparseable.deferred, true);
  assert.equal(unparseable.reason, 'version_unparseable');
});

test('evaluateHostMinCompatibility defers when no comparator is available', async () => {
  const deferred = await evaluateHostMinCompatibility('1.0.0', '1.2.3', { semver: null });
  assert.deepEqual(deferred, {
    evaluated: false,
    compatible: null,
    deferred: true,
    reason: 'semver_unavailable',
  });

  const auto = await evaluateHostMinCompatibility('1.0.0', '1.2.3');
  if (auto.deferred) {
    assert.equal(auto.reason, 'semver_unavailable');
    assert.equal(auto.compatible, null);
  } else {
    assert.equal(auto.evaluated, true);
    assert.equal(auto.compatible, true);
  }
});

test('loading imports only explicitly enabled local plugin ids', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), { entryFile: 'index.mjs' });
  await addPlugin(root, 'beta', localManifest('beta'), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });
  assert.equal(catalog.ok, true);

  const importer = spyImporter();
  const loaded = await loadHarnessPlugins(catalog, {
    enabledIds: ['alpha'],
    importer,
    hostVersion: '1.0.0',
    semver: stubSemver,
  });

  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.loadedIds, ['alpha']);
  assert.equal(importer.calls.length, 1);
  assert.match(importer.calls[0], /alpha\/index\.mjs$/);
  assert.equal('beta' in loaded.modules, false);
  assert.deepEqual(loaded.results.map((row) => row.id), ['alpha']);
});

test('loading with no enabledIds or duplicates imports nothing twice', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });

  const importer = spyImporter();
  const none = await loadHarnessPlugins(catalog, { importer, hostVersion: '1.0.0', semver: stubSemver });
  assert.equal(none.ok, true);
  assert.deepEqual(none.loadedIds, []);
  assert.equal(importer.calls.length, 0);

  const twice = await loadHarnessPlugins(catalog, {
    enabledIds: ['alpha', 'alpha'],
    importer,
    hostVersion: '1.0.0',
    semver: stubSemver,
  });
  assert.deepEqual(twice.loadedIds, ['alpha']);
  assert.equal(importer.calls.length, 1);
});

test('a loader that resolves undefined still counts as loaded', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });

  const loaded = await loadHarnessPlugins(catalog, {
    enabledIds: ['alpha'],
    importer: async () => undefined,
    hostVersion: '1.0.0',
    semver: stubSemver,
  });

  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.loadedIds, ['alpha']);
  assert.equal('alpha' in loaded.modules, true);
});

test('loading reports unknown enabled ids without throwing', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });

  const loaded = await loadHarnessPlugins(catalog, { enabledIds: ['ghost'] });
  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.loadedIds, []);
  assert.equal(loaded.results.length, 1);
  assert.equal(loaded.results[0].code, 'plugin_not_found');
});

test('loading blocks host-incompatible plugins before importing them', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha', { hostMin: '9.0.0' }), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });

  const importer = spyImporter();
  const loaded = await loadHarnessPlugins(catalog, {
    enabledIds: ['alpha'],
    importer,
    hostVersion: '1.0.0',
    semver: stubSemver,
  });

  assert.equal(loaded.ok, false);
  assert.equal(importer.calls.length, 0);
  assert.equal(loaded.results[0].code, 'host_incompatible');
  assert.equal(loaded.results[0].field, 'hostMin');
});

test('loading proceeds and marks deferred hostMin when no comparator exists', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha', { hostMin: '9.0.0' }), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });

  const importer = spyImporter();
  const loaded = await loadHarnessPlugins(catalog, {
    enabledIds: ['alpha'],
    importer,
    hostVersion: '1.0.0',
    semver: null,
  });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.results[0].hostMinDeferred, true);
  assert.equal(loaded.results[0].hostMinReason, 'semver_unavailable');
  assert.equal(importer.calls.length, 1);
});

test('loading wraps importer failures as per-plugin errors', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });

  const loaded = await loadHarnessPlugins(catalog, {
    enabledIds: ['alpha'],
    importer: async () => {
      throw new Error('boom');
    },
    hostVersion: '1.0.0',
    semver: stubSemver,
  });

  assert.equal(loaded.ok, false);
  assert.equal(loaded.results[0].code, 'load_failed');
  assert.equal(loaded.results[0].error, 'boom');
});

test('default importer loads a real ESM entry file', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), {
    entryFile: 'index.mjs',
    entrySource: "export default 'alpha-real';\nexport const marker = 42;\n",
  });
  const catalog = await discoverHarnessPlugins({ root });

  const loaded = await loadHarnessPlugins(catalog, {
    enabledIds: ['alpha'],
    hostVersion: '1.0.0',
    semver: stubSemver,
  });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.modules.alpha.default, 'alpha-real');
  assert.equal(loaded.modules.alpha.marker, 42);
});

test('loading ignores forged catalog metadata and requires a real disk manifest', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  const badDir = path.join(root, 'bad');
  await mkdir(badDir, { recursive: true });

  // The catalog claims a label-less manifest and a bogus entryPath, but the
  // directory itself has no harness-plugin.json on disk: per-plugin error,
  // never an import.
  const badCatalog = {
    root,
    plugins: [
      {
        manifest: localManifest('bad', { label: '' }),
        dir: 'bad',
        dirPath: badDir,
        entryPath: path.join(badDir, 'index.mjs'),
      },
    ],
  };
  const spy = spyImporter();
  const missing = await loadHarnessPlugins(badCatalog, {
    enabledIds: ['bad'],
    importer: spy,
    hostVersion: '1.0.0',
    semver: stubSemver,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(spy.calls, [], 'a missing disk manifest must never reach the importer');
  assert.equal(missing.results[0].code, 'manifest_missing');
  assert.equal(missing.results[0].dir, 'bad');

  // A disk manifest that is contract-invalid is still a per-plugin error even
  // when the catalog claims valid metadata for the same id.
  await writeFile(path.join(badDir, MANIFEST), JSON.stringify(localManifest('bad', { label: '' })));
  const invalidDisk = await loadHarnessPlugins(badCatalog, {
    enabledIds: ['bad'],
    hostVersion: '1.0.0',
    semver: stubSemver,
  });
  assert.equal(invalidDisk.ok, false);
  assert.equal(invalidDisk.results[0].code, 'manifest_invalid');
  assert.equal(invalidDisk.results[0].field, 'label');

  for (const invalid of [null, undefined, {}, { plugins: [] }, { root, plugins: 'nope' }]) {
    const result = await loadHarnessPlugins(invalid);
    assert.equal(result.ok, false);
    assert.equal(result.results[0].code, 'catalog_invalid');
  }
});

test('REGRESSION: a forged catalog cannot import another plugin directory as a different id', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'alpha-entry';\n",
  });
  await addPlugin(root, 'beta', localManifest('beta'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'beta-entry';\n",
  });

  // The catalog claims id "alpha" but points at beta's directory, and supplies
  // no dirPath — only the disk manifest can expose the forgery.
  const spy = spyImporter();
  const forged = await loadHarnessPlugins(
    { root, plugins: [{ manifest: localManifest('alpha'), dir: 'beta' }] },
    { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(forged.ok, false);
  assert.deepEqual(forged.loadedIds, []);
  assert.deepEqual(spy.calls, [], 'no entry may be imported for a forged id/dir pair');
  assert.equal(forged.results.length, 1);
  assert.equal(forged.results[0].id, 'alpha');
  assert.equal(forged.results[0].dir, 'beta');
  assert.equal(forged.results[0].code, 'id_mismatch');
  assert.equal(forged.results[0].field, 'id');

  // The honest path still works: beta's own id loads beta's own entry.
  const honest = await loadHarnessPlugins(
    { root, plugins: [{ manifest: localManifest('beta'), dir: 'beta' }] },
    { enabledIds: ['beta'], hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(honest.ok, true);
  assert.equal(honest.modules.beta.marker, 'beta-entry');
});

test('loading uses the disk manifest entry, hostMin, and origin over forged catalog values', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha', { hostMin: '9.0.0' }), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'disk-entry';\n",
  });
  // A second file inside alpha that only the forged catalog entry references.
  await writeFile(path.join(root, 'alpha', 'other.mjs'), "export const marker = 'forged-entry';\n");

  // Catalog downgrades hostMin, re-points the entry, and demotes the origin;
  // every field must come from the disk manifest instead.
  const forgedManifest = localManifest('alpha', { hostMin: '0.1.0', entry: 'other.mjs' });
  const spy = spyImporter();
  const blocked = await loadHarnessPlugins(
    { root, plugins: [{ manifest: forgedManifest, dir: 'alpha' }] },
    { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(blocked.ok, false);
  assert.deepEqual(spy.calls, [], 'the forged hostMin must not let the plugin through');
  assert.equal(blocked.results[0].code, 'host_incompatible');
  assert.equal(blocked.results[0].field, 'hostMin');
  assert.match(blocked.results[0].error, /9\.0\.0/);

  // With a compatible host the disk entry wins too: other.mjs is never imported.
  const loaded = await loadHarnessPlugins(
    { root, plugins: [{ manifest: forgedManifest, dir: 'alpha' }] },
    { enabledIds: ['alpha'], hostVersion: '9.0.0', semver: stubSemver },
  );
  assert.equal(loaded.ok, true);
  assert.equal(loaded.modules.alpha.marker, 'disk-entry');
  assert.match(loaded.results[0].source, /alpha\/index\.mjs$/);

  // A forged origin cannot demote a disk-local plugin either.
  const builtinForged = await loadHarnessPlugins(
    {
      root,
      plugins: [{ manifest: localManifest('alpha', { origin: 'builtin', entry: undefined }), dir: 'alpha' }],
    },
    { enabledIds: ['alpha'], hostVersion: '9.0.0', semver: stubSemver },
  );
  assert.equal(builtinForged.ok, true);
  assert.equal(builtinForged.modules.alpha.marker, 'disk-entry');
});

test('a missing or whitespace dirPath stays optional and derivation still applies', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'alpha-entry';\n",
  });

  for (const dirPath of [undefined, '', '   ']) {
    const loaded = await loadHarnessPlugins(
      { root, plugins: [{ manifest: localManifest('alpha'), dir: 'alpha', dirPath }] },
      { enabledIds: ['alpha'], hostVersion: '1.0.0', semver: stubSemver },
    );
    assert.equal(loaded.ok, true, `expected dirPath ${JSON.stringify(dirPath)} to stay optional`);
    assert.equal(loaded.modules.alpha.marker, 'alpha-entry');
  }
});

test('duplicate catalog entries for one enabled id are refused without importing', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'alpha-entry';\n",
  });
  await addPlugin(root, 'beta', localManifest('beta'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'beta-entry';\n",
  });

  // Two catalog entries claim the same id with different directories; the
  // ambiguity must not be resolved by position (first or last wins).
  const spy = spyImporter();
  const loaded = await loadHarnessPlugins(
    {
      root,
      plugins: [
        { manifest: localManifest('alpha'), dir: 'alpha' },
        { manifest: localManifest('alpha'), dir: 'beta' },
      ],
    },
    { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.loadedIds, []);
  assert.deepEqual(spy.calls, [], 'an ambiguous id must never be imported');
  assert.equal(loaded.results.length, 1);
  assert.equal(loaded.results[0].code, 'id_collision');
  assert.equal(loaded.results[0].field, 'id');
});

test('REGRESSION: a forged catalog dirPath cannot make one id import another plugin entry', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'alpha-entry';\n",
  });
  await addPlugin(root, 'beta', localManifest('beta'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'beta-entry';\n",
  });
  const catalog = await discoverHarnessPlugins({ root });
  assert.equal(catalog.ok, true);

  const victim = catalog.plugins.find((row) => row.manifest.id === 'alpha');
  const decoy = catalog.plugins.find((row) => row.manifest.id === 'beta');
  const forged = {
    root: catalog.root,
    plugins: [{ ...victim, dirPath: decoy.dirPath, entryPath: decoy.entryPath }],
  };

  const spy = spyImporter();
  const blocked = await loadHarnessPlugins(forged, {
    enabledIds: ['alpha'],
    importer: spy,
    hostVersion: '1.0.0',
    semver: stubSemver,
  });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.loadedIds, []);
  assert.deepEqual(spy.calls, [], 'the decoy entry must never be imported');
  assert.equal(blocked.results[0].code, 'dir_mismatch');
  assert.equal(blocked.results[0].dir, 'alpha');
  assert.equal(blocked.results[0].field, 'dirPath');

  const real = await loadHarnessPlugins(forged, {
    enabledIds: ['alpha'],
    hostVersion: '1.0.0',
    semver: stubSemver,
  });
  assert.equal(real.ok, false);
  assert.equal('alpha' in real.modules, false);
  assert.equal(real.results[0].code, 'dir_mismatch');
});

test('a forged dirPath pointing outside the root is rejected before any import', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'alpha-entry';\n",
  });
  const outside = await makeTmp(t, 'cretli-plugin-outside-');
  await writeFile(path.join(outside, 'index.mjs'), "export const marker = 'outside-entry';\n");
  const catalog = await discoverHarnessPlugins({ root });

  const spy = spyImporter();
  const loaded = await loadHarnessPlugins(
    { root: catalog.root, plugins: [{ ...catalog.plugins[0], dirPath: outside }] },
    { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(loaded.ok, false);
  assert.deepEqual(spy.calls, []);
  assert.equal(loaded.results[0].code, 'dir_mismatch');
});

test('loading derives the plugin directory from dir alone and ignores a forged entryPath', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), {
    entryFile: 'index.mjs',
    entrySource: "export const marker = 'alpha-entry';\n",
  });
  const outside = await makeTmp(t, 'cretli-plugin-outside-');
  await writeFile(path.join(outside, 'evil.mjs'), "export const marker = 'evil-entry';\n");

  const loaded = await loadHarnessPlugins(
    { root, plugins: [{ manifest: localManifest('alpha'), dir: 'alpha', entryPath: path.join(outside, 'evil.mjs') }] },
    { enabledIds: ['alpha'], hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(loaded.ok, true);
  assert.equal(loaded.modules.alpha.marker, 'alpha-entry');
  assert.match(loaded.results[0].source, /alpha\/index\.mjs$/);
});

test('loading rejects a catalog dir that is not a safe direct child name', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  const outside = await makeTmp(t, 'cretli-plugin-outside-');
  await addPlugin(outside, 'victim', localManifest('victim'), { entryFile: 'index.mjs' });

  const unsafe = [
    '../outside/victim',
    'outside/victim',
    path.join(outside, 'victim'),
    '.',
    '..',
    '',
    '   ',
    '.hidden',
    'a/b',
    'a\\b',
    'na\0me',
    'a'.repeat(65),
    42,
    null,
    undefined,
  ];
  for (const dir of unsafe) {
    const spy = spyImporter();
    const loaded = await loadHarnessPlugins(
      { root, plugins: [{ manifest: localManifest('alpha'), dir }] },
      { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
    );
    assert.equal(loaded.ok, false, `expected dir ${JSON.stringify(dir)} to be rejected`);
    assert.deepEqual(spy.calls, [], `expected no import for dir ${JSON.stringify(dir)}`);
    assert.equal(loaded.results[0].code, 'dir_unsafe', `unexpected code for dir ${JSON.stringify(dir)}`);
    assert.equal(loaded.results[0].field, 'dir');
  }
});

test('a dirPath that differs only by path normalization is still accepted', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });
  const [plugin] = catalog.plugins;

  const spy = spyImporter();
  const loaded = await loadHarnessPlugins(
    { root: catalog.root, plugins: [{ ...plugin, dirPath: `${plugin.dirPath}${path.sep}` }] },
    { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(loaded.ok, true);
  assert.equal(spy.calls.length, 1);
});

test('loading refuses a catalog dir whose target is not a directory', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await writeFile(path.join(root, 'alpha'), 'not a directory');

  const spy = spyImporter();
  const loaded = await loadHarnessPlugins(
    { root, plugins: [{ manifest: localManifest('alpha'), dir: 'alpha' }] },
    { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(loaded.ok, false);
  assert.equal(loaded.results[0].code, 'plugin_not_directory');
  assert.equal(loaded.results[0].field, 'dir');
  assert.deepEqual(spy.calls, []);
});

test('loading refuses a catalog dir that is a symlink', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  const outside = await makeTmp(t, 'cretli-plugin-outside-');
  await addPlugin(outside, 'real', localManifest('alpha'), { entryFile: 'index.mjs' });
  await symlink(path.join(outside, 'real'), path.join(root, 'linked'), 'dir');

  const spy = spyImporter();
  const loaded = await loadHarnessPlugins(
    { root, plugins: [{ manifest: localManifest('alpha'), dir: 'linked' }] },
    { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
  );
  assert.equal(loaded.ok, false);
  assert.equal(loaded.results[0].code, 'plugin_symlink');
  assert.equal(loaded.results[0].field, 'dir');
  assert.deepEqual(spy.calls, []);
});

test('loading refuses a catalog root that is not an explicit non-symlink directory', async (t) => {
  const root = await makeTmp(t, 'cretli-plugin-root-');
  await addPlugin(root, 'alpha', localManifest('alpha'), { entryFile: 'index.mjs' });
  const catalog = await discoverHarnessPlugins({ root });

  const parent = await makeTmp(t, 'cretli-plugin-parent-');
  const link = path.join(parent, 'linked-root');
  await symlink(root, link, 'dir');

  for (const [bad, code] of [
    [link, 'root_symlink'],
    ['relative-root', 'root_invalid'],
    ['https://evil.example/plugins', 'root_invalid'],
  ]) {
    const spy = spyImporter();
    const loaded = await loadHarnessPlugins(
      { root: bad, plugins: catalog.plugins },
      { enabledIds: ['alpha'], importer: spy, hostVersion: '1.0.0', semver: stubSemver },
    );
    assert.equal(loaded.ok, false, `expected root ${JSON.stringify(bad)} to be rejected`);
    assert.deepEqual(spy.calls, [], `expected no import for root ${JSON.stringify(bad)}`);
    assert.equal(loaded.results[0].code, code);
    assert.equal(loaded.results[0].field, 'root');
  }
});
