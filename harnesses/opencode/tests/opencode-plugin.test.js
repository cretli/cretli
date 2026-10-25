/**
 * The shipped opencode plugin (harnesses/opencode): manifest, light-entry import
 * ban, the core files that must not import or name it, and the enabled / disabled
 * registry and process-lifecycle behaviour observed in a fresh process (loaded
 * module URLs recorded).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateHarnessPluginManifest } from '../../../lib/agent-harness/harness-plugin-contract.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (file) => readFileSync(path.join(projectRoot, file), 'utf8');
const FORBIDDEN_LIGHT_IMPORT = /room-kernel|builtin-harness-providers|optional-harness-plugins/;

/** Relative-import closure of a module (the light entry may not pull in the heavy side). */
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

function lightImportViolations(entryFile) {
  return [...collectRelativeImports(entryFile)].filter((file) => FORBIDDEN_LIGHT_IMPORT.test(file));
}

test('manifest, light and lifecycle entry import ban and composition roots that do not name the plugin', () => {
  const dir = path.join(projectRoot, 'harnesses', 'opencode');
  const manifest = validateHarnessPluginManifest(JSON.parse(readFileSync(path.join(dir, 'harness-plugin.json'), 'utf8')));
  assert.equal(manifest.ok, true);
  assert.equal(manifest.manifest.origin, 'builtin-optional');
  assert.equal(manifest.manifest.defaultEnabled, true);
  assert.equal(manifest.manifest.dependsOn, undefined, 'opencode is the base plugin: zai and mimo depend on it');
  assert.deepEqual(
    { ...manifest.manifest.entries },
    { light: './light.js', heavy: './heavy.js', front: './front.js', lifecycle: './lifecycle.js' },
  );
  assert.deepEqual(lightImportViolations(path.join(dir, 'light.js')), []);
  // The lifecycle entry is read by the memory monitor CLI, which loads no chat runtime.
  assert.deepEqual(lightImportViolations(path.join(dir, 'lifecycle.js')), []);
  for (const file of [
    'lib/agent-harness/builtin-harness-providers.ts',
    'lib/agent-harness/builtin-harness-backends.ts',
    'lib/agent-harness/builtin-process-lifecycles.ts',
    'lib/mcp/adapters/index.js',
    'lib/memory-monitor.js',
    'app_front/features/settings/models/harnessModelSettingsPanels.js',
    'app_front/features/settings/models/harnessSettingsSchemas.js',
    'lib/agent-harness/registry.ts',
  ]) {
    assert.doesNotMatch(read(file), /opencode/i, `${file} must not mention opencode`);
  }
  assert.match(read('app_front/features/settings/models/optionalHarnessPanels.js'), /import\(['"]\.\.\/\.\.\/\.\.\/\.\.\/harnesses\/opencode\/front\.js['"]\)/);
});

test('no core file imports the opencode, zai or mimo plugins; server.js and the memory monitor import no opencode', () => {
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(full).isDirectory() ? walk(full) : (/\.(js|mjs)$/.test(full) ? [full] : []);
  });
  const offenders = [];
  for (const file of [path.join(projectRoot, 'server.js'), ...walk(path.join(projectRoot, 'lib'))]) {
    if (/(?:from\s+|import\(\s*)['"][^'"]*harnesses\/(opencode|zai|mimo)\//.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(projectRoot, file));
  }
  assert.deepEqual(offenders, []);
  for (const file of ['server.js', 'lib/memory-monitor.js']) {
    assert.doesNotMatch(read(file), /(?:from\s+|import\()\s*['"][^'"]*opencode/, `${file} must not import opencode`);
  }
});

test('the harness-neutral pieces OpenCode used to own live in core and the plugin re-exports them', async () => {
  for (const file of ['lib/process-probes.js', 'lib/approval/permission-classifier.ts']) {
    assert.ok(existsSync(path.join(projectRoot, file)), file);
  }
  const pluginImport = /(?:from\s+|import\(\s*)['"][^'"]*harnesses\//;
  assert.doesNotMatch(read('lib/process-probes.js'), pluginImport);
  assert.doesNotMatch(read('lib/approval/permission-classifier.ts'), pluginImport);
  assert.doesNotMatch(read('lib/child-process-registry.js'), /opencode-port-registry/);
  const classifier = await import('../../../lib/approval/permission-classifier.ts');
  const plugin = await import('../opencode-permission.js');
  assert.equal(plugin.resolveOpenCodeApprovalAction, classifier.resolveApprovalAction);
  assert.equal(typeof plugin.postOpenCodePermissionResponse, 'function');
  assert.equal(classifier.postOpenCodePermissionResponse, undefined, 'the HTTP reply stays in the plugin');
});

/**
 * Run a probe in a fresh process that records every module URL the loader pulls
 * in, so "no opencode module is imported" is observed rather than assumed.
 */
function probeRegistries(env) {
  const code = `
    const { loadOptionalHarnessPlugins } = await import('./lib/agent-harness/optional-harness-plugins.ts');
    const { listHarnesses } = await import('./lib/agent-harness/registry.ts');
    const { listBuiltinHarnessProviders, listProcessLifecycleProviders } = await import('./lib/agent-harness/builtin-harness-providers.ts');
    const { listBuiltinHarnessBackends } = await import('./lib/agent-harness/builtin-harness-backends.ts');
    const { listBuiltinProcessLifecycles } = await import('./lib/agent-harness/builtin-process-lifecycles.ts');
    const { getHarnessMcpAdapter } = await import('./lib/mcp/adapters/index.js');
    const { listHarnessVersionIds } = await import('./lib/harness-versions.js');
    const { listHarnessCatalog } = await import('./lib/harness-catalog.js');
    const result = await loadOptionalHarnessPlugins();
    const catalog = await listHarnessCatalog();
    process.stdout.write(JSON.stringify({
      loaded: result.loaded,
      errors: result.errors,
      harnesses: listHarnesses().map((meta) => meta.transport),
      providers: listBuiltinHarnessProviders().map((row) => row.id),
      backends: listBuiltinHarnessBackends().map((row) => row.id),
      adapter: Boolean(getHarnessMcpAdapter('opencode')),
      versionIds: listHarnessVersionIds(),
      lifecycles: listBuiltinProcessLifecycles().map((row) => row.id),
      lifecycleProviders: listProcessLifecycleProviders().map((row) => row.id),
      catalog: catalog.map((row) => row.id),
    }));`;
  return mkdtemp(path.join(os.tmpdir(), 'cretli-probe-')).then(async (tmp) => {
    const log = path.join(tmp, 'modules.log');
    const hookFile = path.join(tmp, 'hook.mjs');
    const registerFile = path.join(tmp, 'register.mjs');
    await writeFile(hookFile, `import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  appendFileSync(process.env.PROBE_LOG, url + '\\n');
  return next(url, context);
}
`);
    await writeFile(registerFile, `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(hookFile).href)});
`);
    const childEnv = { ...process.env, CRETLI_DATA_DIR: path.join(tmp, 'data'), PROBE_LOG: log, ...env };
    if (env.CRETLI_OPTIONAL_HARNESSES === undefined) delete childEnv.CRETLI_OPTIONAL_HARNESSES;
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(registerFile).href, '--input-type=module', '-e', code], {
      cwd: projectRoot, env: childEnv, encoding: 'utf8',
    });
    const modules = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return rm(tmp, { recursive: true, force: true }).then(() => ({ run, modules }));
  });
}

test('opencode plugin disabled: absent from every registry, no process hook and no opencode module is imported', async () => {
  const { run, modules } = await probeRegistries({ CRETLI_OPTIONAL_HARNESSES: '' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.loaded, []);
  assert.deepEqual(out.errors, []);
  for (const key of ['harnesses', 'providers', 'backends', 'catalog']) {
    assert.ok(!out[key].includes('opencode'), `${key} must not list opencode`);
  }
  assert.equal(out.adapter, false);
  assert.ok(!out.versionIds.includes('opencode'), 'version table must not list opencode');
  assert.deepEqual(out.lifecycles, []);
  assert.deepEqual(out.lifecycleProviders, []);
  assert.deepEqual(modules.filter((url) => /\/harnesses\/opencode\//.test(url) || /@opencode-ai\//.test(url)), []);
});

test('opencode plugin enabled by default: registered everywhere with the same list positions', async () => {
  const { run, modules } = await probeRegistries({});
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.ok(out.loaded.includes('opencode'), out.loaded.join());
  assert.deepEqual(out.errors, []);
  // Same positions as when it was built in: after mimo, right before codebuddy.
  assert.equal(out.harnesses.indexOf('opencode') + 1, out.harnesses.indexOf('codebuddy'), out.harnesses.join());
  assert.ok(out.versionIds.indexOf('opencode') < out.versionIds.indexOf('codebuddy'), out.versionIds.join());
  // OpenRouter is still ahead of it in the backend (settings patch) order.
  assert.equal(out.backends.indexOf('openrouter') + 1, out.backends.indexOf('opencode'), out.backends.join());
  assert.ok(out.providers.includes('opencode') && out.backends.includes('opencode') && out.adapter && out.catalog.includes('opencode'));
  assert.ok(out.lifecycles.includes('opencode') && out.lifecycleProviders.includes('opencode'));
  assert.ok(modules.some((url) => /\/harnesses\/opencode\/light\.js$/.test(url)));
  assert.ok(modules.some((url) => /\/harnesses\/opencode\/lifecycle\.js$/.test(url)));

  const listedOnly = await probeRegistries({ CRETLI_OPTIONAL_HARNESSES: 'opencode' });
  assert.deepEqual(JSON.parse(listedOnly.run.stdout).loaded, ['opencode']);
});

test('the memory monitor CLI registers the lifecycle without loading the chat runtime', async () => {
  const code = `
    const { loadOptionalProcessLifecycles } = await import('./lib/agent-harness/optional-process-lifecycles.ts');
    const { listBuiltinProcessLifecycles } = await import('./lib/agent-harness/builtin-process-lifecycles.ts');
    const registered = await loadOptionalProcessLifecycles();
    process.stdout.write(JSON.stringify({ registered, ids: listBuiltinProcessLifecycles().map((row) => row.id) }));`;
  const probe = (env) => {
    const childEnv = { ...process.env, ...env };
    if (env.CRETLI_OPTIONAL_HARNESSES === undefined) delete childEnv.CRETLI_OPTIONAL_HARNESSES;
    return JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: projectRoot, env: childEnv, encoding: 'utf8' }).stdout);
  };
  assert.deepEqual(probe({}).ids, ['opencode']);
  assert.deepEqual(probe({ CRETLI_OPTIONAL_HARNESSES: 'opencode,zai' }).ids, ['opencode']);
  assert.deepEqual(probe({ CRETLI_OPTIONAL_HARNESSES: 'zai' }).ids, []);
  assert.deepEqual(probe({ CRETLI_OPTIONAL_HARNESSES: '' }).ids, []);
});
