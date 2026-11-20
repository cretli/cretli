/**
 * Repo harness plugins (`builtin-optional` origin): contract, boot loader,
 * registry wiring and the light-entry import ban.
 *
 * The real `harnesses/` directory is never read here; every load uses the
 * fixture root, so the suite behaves the same with no plugin shipped.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_PLUGIN_ORIGINS,
  buildHarnessPluginStatus,
  validateHarnessPluginManifest,
} from '../lib/agent-harness/harness-plugin-contract.ts';
import { discoverHarnessPlugins } from '../lib/agent-harness/harness-plugin-loader.ts';
import {
  isOptionalHarnessSelectionExplicit,
  loadOptionalHarnessPlugins,
  readEnabledOptionalHarnessIds,
} from '../lib/agent-harness/optional-harness-plugins.ts';
import {
  getLoadedOptionalHarnessIds,
  resetOptionalHarnessStateForTests,
  setLoadedOptionalHarnessIds,
} from '../lib/agent-harness/optional-harness-state.ts';
import {
  getBuiltinHarnessProvider,
  listBuiltinHarnessProviders,
} from '../lib/agent-harness/builtin-harness-providers.ts';
import { getBuiltinHarnessBackend, listBuiltinHarnessBackends } from '../lib/agent-harness/builtin-harness-backends.ts';
import { listHarnesses } from '../lib/agent-harness/registry.ts';
import { getHarnessMcpAdapter, registerOptionalHarnessMcpAdapter } from '../lib/mcp/adapters/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(projectRoot, 'tests', 'fixtures', 'optional-harness');
const read = (file) => readFileSync(path.join(projectRoot, file), 'utf8');

/** Each load commits the state once; tests reopen it explicitly. */
async function loadFresh(options) {
  resetOptionalHarnessStateForTests();
  return loadOptionalHarnessPlugins(options);
}

function optionalManifest(overrides = {}) {
  return {
    apiVersion: 1,
    id: 'mistral',
    version: '1.0.0',
    hostMin: '0.1.0',
    label: 'Mistral',
    description: 'Optional.',
    origin: 'builtin-optional',
    entries: { light: './light.js', heavy: './heavy.js' },
    capabilities: { chat: true },
    ...overrides,
  };
}

/**
 * Relative-import closure of a module, so the ban also covers helpers a light
 * entry pulls in.
 */
function collectRelativeImports(entryFile, seen = new Set()) {
  if (seen.has(entryFile)) return seen;
  seen.add(entryFile);
  // lib/ modules were migrated to TypeScript; a `.js` specifier may now resolve to `.ts`.
  const onDisk = !existsSync(entryFile) && entryFile.endsWith('.js') && existsSync(entryFile.replace(/\.js$/, '.ts')) ? entryFile.replace(/\.js$/, '.ts') : entryFile;
  const source = readFileSync(onDisk, 'utf8');
  for (const match of source.matchAll(/(?:from\s+|import\s+|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    collectRelativeImports(path.resolve(path.dirname(entryFile), match[1]), seen);
  }
  return seen;
}

const FORBIDDEN_LIGHT_IMPORT = /room-kernel|builtin-harness-providers|optional-harness-plugins/;

function lightImportViolations(entryFile) {
  return [...collectRelativeImports(entryFile)].filter((file) => FORBIDDEN_LIGHT_IMPORT.test(file));
}

test('builtin-optional manifests need entries, may reuse a non-core id and keep core ids reserved', () => {
  assert.ok(HARNESS_PLUGIN_ORIGINS.includes('builtin-optional'));
  const ok = validateHarnessPluginManifest(optionalManifest());
  assert.equal(ok.ok, true);
  assert.deepEqual({ ...ok.manifest.entries }, { light: './light.js', heavy: './heavy.js' });
  assert.equal(ok.manifest.entry, undefined);

  assert.equal(validateHarnessPluginManifest(optionalManifest({ id: 'claude' })).code, 'id_reserved');
  assert.equal(validateHarnessPluginManifest(optionalManifest({ entries: undefined })).ok, false);
  assert.equal(validateHarnessPluginManifest(optionalManifest({ entries: {} })).ok, false);
  assert.equal(validateHarnessPluginManifest(optionalManifest({ entries: { light: '../x.js' } })).ok, false);
  assert.equal(validateHarnessPluginManifest(optionalManifest({ entries: { other: './x.js' } })).ok, false);
  assert.equal(validateHarnessPluginManifest(optionalManifest({ entry: './index.js' })).ok, false);
  // `entries` belongs to optional plugins only; local semantics are unchanged.
  const local = { ...optionalManifest({ id: 'my-local', origin: 'local', entries: undefined }), entry: './index.js' };
  assert.equal(validateHarnessPluginManifest(local).ok, true);
  assert.equal(validateHarnessPluginManifest({ ...local, entries: { light: './l.js' } }).ok, false);
  // Opt-in by default, like a local plugin.
  assert.equal(buildHarnessPluginStatus(optionalManifest()).status.enabled, false);
});

test('the local discovery root refuses builtin-optional plugins', async () => {
  const result = await discoverHarnessPlugins({ root: FIXTURE_ROOT });
  assert.equal(result.plugins.length, 0);
  assert.ok(result.errors.some((error) => error.code === 'origin_not_local'));
});

test('enabled ids come from the env list only', () => {
  assert.deepEqual(readEnabledOptionalHarnessIds({}), []);
  assert.deepEqual(readEnabledOptionalHarnessIds({ CRETLI_OPTIONAL_HARNESSES: ' A ,b,,a' }), ['a', 'b']);
});

test('nothing is imported or registered without an enabled id', async () => {
  const before = [listBuiltinHarnessProviders().length, listBuiltinHarnessBackends().length];
  let imports = 0;
  const result = await loadFresh({
    enabledIds: [],
    root: FIXTURE_ROOT,
    importer: async () => { imports += 1; return {}; },
  });
  assert.deepEqual(result, { loaded: [], errors: [] });
  assert.equal(imports, 0);
  assert.deepEqual([listBuiltinHarnessProviders().length, listBuiltinHarnessBackends().length], before);
  assert.equal(getBuiltinHarnessProvider('fixtureopt'), null);
});

test('an enabled plugin fills providers, backends and MCP adapters', async () => {
  const result = await loadFresh({ enabledIds: ['fixtureopt'], root: FIXTURE_ROOT });
  assert.deepEqual(result, { loaded: ['fixtureopt'], errors: [] });
  assert.deepEqual(getLoadedOptionalHarnessIds(), ['fixtureopt']);
  const provider = getBuiltinHarnessProvider('fixtureopt');
  assert.equal(provider.origin, 'builtin-optional');
  assert.equal(provider.handler(), 'fixture-handled');
  assert.equal(provider.capabilities.chat, true);
  assert.ok(listBuiltinHarnessProviders().some((row) => row.id === 'fixtureopt'));
  assert.equal((await getBuiltinHarnessBackend('fixtureopt').status()).available, true);
  assert.ok(listBuiltinHarnessBackends().some((row) => row.id === 'fixtureopt'));
  assert.equal(getHarnessMcpAdapter('fixtureopt').callControl, 'bridge');
});

test('a plugin cannot shadow a registered harness and failures stay isolated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cretli-optional-'));
  try {
    for (const id of ['shadowme', 'brokenjson', 'nolight']) await mkdir(path.join(root, id));
    const base = (id, entries) => JSON.stringify(optionalManifest({ id, entries }));
    await writeFile(path.join(root, 'shadowme', 'harness-plugin.json'), base('shadowme', { light: './light.js' }));
    await writeFile(path.join(root, 'shadowme', 'light.js'), 'export default { backend: { id: "shadowme", status() {} } };\n');
    await writeFile(path.join(root, 'brokenjson', 'harness-plugin.json'), '{nope');
    await writeFile(path.join(root, 'nolight', 'harness-plugin.json'), base('nolight', { light: './light.js' }));
    // The first load registers it; every later load must be refused instead of replacing it.
    assert.deepEqual((await loadFresh({ enabledIds: ['shadowme'], root })).loaded, ['shadowme']);
    const before = getBuiltinHarnessBackend('shadowme');
    const result = await loadFresh({ enabledIds: ['shadowme', 'brokenjson', 'nolight', 'absent'], root });
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.errors.map((error) => [error.dir, error.code]), [
      ['shadowme', 'id_collision'],
      ['brokenjson', 'manifest_malformed'],
      ['nolight', 'entry_unsafe'],
      ['absent', 'plugin_not_found'],
    ]);
    assert.equal(getBuiltinHarnessBackend('shadowme'), before, 'the registered backend is untouched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dependsOn is validated: optional plugins only, plugin ids only, never itself or a core harness', () => {
  const ok = validateHarnessPluginManifest(optionalManifest({ id: 'child', dependsOn: ['parent', 'parent', 'other-plugin'] }));
  assert.equal(ok.ok, true);
  assert.deepEqual([...ok.manifest.dependsOn], ['parent', 'other-plugin']);
  assert.equal(validateHarnessPluginManifest(optionalManifest()).manifest.dependsOn, undefined);
  for (const bad of ['parent', [''], [1], ['Bad Id'], ['child'], ['claude'], ['codex'], Array.from({ length: 9 }, (_, i) => `dep${i}`)]) {
    const result = validateHarnessPluginManifest(optionalManifest({ id: 'child', dependsOn: bad }));
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.field, 'dependsOn');
  }
  const local = { ...optionalManifest({ id: 'my-local', origin: 'local', entries: undefined }), entry: './index.js', dependsOn: ['parent'] };
  assert.equal(validateHarnessPluginManifest(local).ok, false);
});

test('a plugin loads after its dependency, and without it the load is refused instead of crashing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cretli-optional-deps-'));
  try {
    for (const id of ['depbase', 'depchild']) await mkdir(path.join(root, id));
    const manifest = (id, extra = {}) => JSON.stringify(optionalManifest({ id, entries: { light: './light.js' }, ...extra }));
    await writeFile(path.join(root, 'depbase', 'harness-plugin.json'), manifest('depbase'));
    await writeFile(path.join(root, 'depbase', 'light.js'), 'export default { backend: { id: "depbase", status() {} } };\n');
    await writeFile(path.join(root, 'depchild', 'harness-plugin.json'), manifest('depchild', { dependsOn: ['depbase'] }));
    await writeFile(path.join(root, 'depchild', 'light.js'), 'export default { backend: { id: "depchild", status() {} } };\n');

    // Child alone: a readable error, nothing registered, the id stays a known-but-disabled plugin.
    const alone = await loadFresh({ enabledIds: ['depchild'], root });
    assert.deepEqual(alone.loaded, []);
    assert.equal(alone.errors.length, 1);
    assert.equal(alone.errors[0].code, 'dependency_missing');
    assert.match(alone.errors[0].error, /"depchild".*"depbase".*CRETLI_OPTIONAL_HARNESSES=depbase,depchild/);
    assert.equal(getBuiltinHarnessBackend('depchild'), null);

    // The selection order does not matter: the dependency is loaded first.
    const both = await loadFresh({ enabledIds: ['depchild', 'depbase'], root });
    assert.deepEqual(both.errors, []);
    assert.deepEqual(both.loaded, ['depbase', 'depchild']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a light entry may not import room-kernel or the providers module (transitively)', () => {
  assert.deepEqual(lightImportViolations(path.join(FIXTURE_ROOT, 'fixtureopt', 'light.js')), []);
  // The scanner itself: a helper reached through the light entry is caught.
  assert.equal(lightImportViolations(path.join(FIXTURE_ROOT, 'leakylight', 'light.js')).length, 1);
  // The same ban already applies to the light composition roots.
  for (const file of ['lib/agent-harness/builtin-harness-backends.ts', 'lib/mcp/adapters/index.js']) {
    assert.doesNotMatch(read(file), /from\s+['"][^'"]*(builtin-harness-providers|optional-harness-plugins)/, file);
  }
  assert.doesNotMatch(read('lib/routes/settings-routes.js'), /optional-harness-plugins/);
});

test('boot loads plugins before the provider registries are read, and the browser map is static', () => {
  const server = read('server.js');
  const loadIdx = server.indexOf('await loadOptionalHarnessPlugins()');
  assert.ok(loadIdx > 0);
  assert.ok(loadIdx < server.indexOf('const processLifecycleProviders = listProcessLifecycleProviders()'));
  assert.ok(loadIdx < server.indexOf('registerAppRoutes('));
  const front = read('app_front/features/settings/models/optionalHarnessPanels.js');
  assert.doesNotMatch(front, /from\s+['"](node:)?(fs|path)/);
  assert.match(read('app_front/features/settings/models/harnessModelSettingsPanels.js'), /OPTIONAL_HARNESS_LOADERS/);
});

test('front files reach harnesses/ only through dynamic import()', () => {
  const dirs = ['app_front'];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(projectRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.js$/.test(entry.name)) files.push(rel);
    }
  };
  for (const dir of dirs) walk(dir);
  const staticImport = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+['"][^'"]*harnesses\//;
  const bareImport = /(?:^|\n)\s*import\s+['"][^'"]*harnesses\//;
  for (const file of files) {
    // i18n packs are plain strings and may stay in the static bundle.
    if (/^app_front\/i18n\/.*\.js$/.test(file)) continue;
    const text = read(file);
    assert.doesNotMatch(text, staticImport, `${file} statically imports a plugin module`);
    assert.doesNotMatch(text, bareImport, `${file} side-effect imports a plugin module`);
  }
  const map = read('app_front/features/settings/models/optionalHarnessPanels.js');
  assert.match(map, /panel:\s*\(\)\s*=>\s*import\(['"]\.\.\/\.\.\/\.\.\/\.\.\/harnesses\/mistral\/front\.js['"]\)/);
  assert.match(map, /schema:\s*\(\)\s*=>\s*import\(['"]\.\.\/\.\.\/\.\.\/\.\.\/harnesses\/mistral\/mistral-settings-schema\.js['"]\)/);
  assert.doesNotMatch(read('app_front/features/settings/models/harnessSettingsSchemas.js'), /harnesses\/|mistral/i);
});

test('a symlinked harnesses root loads nothing and records an error', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'cretli-optional-link-'));
  try {
    const link = path.join(base, 'harnesses');
    await symlink(FIXTURE_ROOT, link);
    let imports = 0;
    const result = await loadFresh({
      enabledIds: ['fixtureopt'],
      root: link,
      importer: async () => { imports += 1; return {}; },
    });
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.errors.map((error) => error.code), ['root_invalid']);
    assert.equal(imports, 0);
    assert.deepEqual(getLoadedOptionalHarnessIds(), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a collision in one registry leaves no partial registration and no front id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cretli-optional-atomic-'));
  try {
    // `sdk` has an MCP adapter but is a core id, so use a free id and pre-register only its adapter.
    const id = 'atomicopt';
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, 'harness-plugin.json'), JSON.stringify(optionalManifest({
      id, entries: { light: './light.js', heavy: './heavy.js' },
    })));
    await writeFile(path.join(root, id, 'light.js'), `export default {
      backend: { id: '${id}', status: async () => ({ available: true, configured: true }) },
      mcpAdapter: { harness: '${id}', transports: ['${id}'], liveUpdate: false, callControl: 'bridge', unsupportedFeature: '' },
    };\n`);
    await writeFile(path.join(root, id, 'heavy.js'), await readFile(path.join(FIXTURE_ROOT, 'fixtureopt', 'heavy.js'), 'utf8'));
    registerOptionalHarnessMcpAdapter({ harness: id, transports: [id], liveUpdate: false, callControl: 'bridge', unsupportedFeature: '' });
    const result = await loadFresh({ enabledIds: [id], root });
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.errors.map((error) => [error.dir, error.code]), [[id, 'id_collision']]);
    assert.equal(getBuiltinHarnessBackend(id), null, 'backend not installed');
    assert.equal(getBuiltinHarnessProvider(id), null, 'provider not installed');
    assert.deepEqual(getLoadedOptionalHarnessIds(), [], 'front id list names only fully registered plugins');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an invalid MCP adapter shape leaves the backend unregistered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cretli-optional-shape-'));
  try {
    const id = 'shapeopt';
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, 'harness-plugin.json'), JSON.stringify(optionalManifest({ id, entries: { light: './light.js' } })));
    await writeFile(path.join(root, id, 'light.js'), `export default {
      backend: { id: '${id}', status: async () => ({ available: true, configured: true }) },
      mcpAdapter: { harness: 'other' },
    };\n`);
    const result = await loadFresh({ enabledIds: [id], root });
    assert.deepEqual(result.errors.map((error) => error.code), ['light_invalid']);
    assert.equal(getBuiltinHarnessBackend(id), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the loaded-id state is committed once, frozen, and a second commit is refused', () => {
  resetOptionalHarnessStateForTests();
  assert.equal(setLoadedOptionalHarnessIds(['one']), true);
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    assert.equal(setLoadedOptionalHarnessIds(['two']), false);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.deepEqual(getLoadedOptionalHarnessIds(), ['one']);
  assert.ok(Object.isFrozen(getLoadedOptionalHarnessIds()));
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => resetOptionalHarnessStateForTests(), /not available in production/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
  resetOptionalHarnessStateForTests();
  assert.deepEqual(getLoadedOptionalHarnessIds(), []);
});

test('defaultEnabled is an optional boolean, valid for builtin-optional plugins only', () => {
  assert.equal(validateHarnessPluginManifest(optionalManifest()).manifest.defaultEnabled, false);
  assert.equal(validateHarnessPluginManifest(optionalManifest({ defaultEnabled: true })).manifest.defaultEnabled, true);
  assert.equal(validateHarnessPluginManifest(optionalManifest({ defaultEnabled: 'yes' })).ok, false);
  const local = { ...optionalManifest({ id: 'my-local', origin: 'local', entries: undefined, defaultEnabled: true }), entry: './index.js' };
  assert.equal(validateHarnessPluginManifest(local).ok, false);
});

test('an unset selection loads defaultEnabled plugins; a set one (even empty) loads exactly the list', async () => {
  assert.equal(isOptionalHarnessSelectionExplicit({}), false);
  assert.equal(isOptionalHarnessSelectionExplicit({ CRETLI_OPTIONAL_HARNESSES: '' }), true);

  const unset = await loadFresh({ root: FIXTURE_ROOT, env: {} });
  assert.deepEqual(unset.loaded, ['defaultopt'], 'only the manifest with defaultEnabled:true is loaded');
  assert.deepEqual(unset.errors.map((error) => error.code), [], 'a plugin that is not selected is not an error');
  assert.deepEqual(getLoadedOptionalHarnessIds(), ['defaultopt']);
  assert.ok(listHarnesses().some((meta) => meta.transport === 'defaultopt'), 'plugin metadata joins the harness list');

  let imports = 0;
  const empty = await loadFresh({
    root: FIXTURE_ROOT,
    env: { CRETLI_OPTIONAL_HARNESSES: '' },
    importer: async () => { imports += 1; return {}; },
  });
  assert.deepEqual(empty, { loaded: [], errors: [] });
  assert.equal(imports, 0, 'an explicit empty list imports nothing');

  const listed = await loadFresh({ root: FIXTURE_ROOT, env: { CRETLI_OPTIONAL_HARNESSES: 'leakylight' } });
  assert.deepEqual(listed.loaded, ['leakylight'], 'the explicit list wins over defaultEnabled');
});
