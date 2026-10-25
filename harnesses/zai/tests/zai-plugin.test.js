/**
 * The shipped zai plugin (harnesses/zai): manifest with its dependency on the
 * opencode plugin, light-entry import ban, and what happens in a fresh process when it
 * is enabled with and without opencode: an isolated tmp data dir, a logged
 * `dependency_missing` error and a read-only plugin, never a crash.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

test('manifest declares the opencode dependency, light entry import ban and clean composition roots', () => {
  const dir = path.join(projectRoot, 'harnesses', 'zai');
  const manifest = validateHarnessPluginManifest(JSON.parse(readFileSync(path.join(dir, 'harness-plugin.json'), 'utf8')));
  assert.equal(manifest.ok, true);
  assert.equal(manifest.manifest.origin, 'builtin-optional');
  assert.equal(manifest.manifest.defaultEnabled, true);
  assert.deepEqual([...manifest.manifest.dependsOn], ['opencode']);
  assert.deepEqual({ ...manifest.manifest.entries }, { light: './light.js', heavy: './heavy.js', front: './front.js' });
  assert.deepEqual(lightImportViolations(path.join(dir, 'light.js')), []);
  for (const file of [
    'lib/agent-harness/builtin-harness-providers.ts',
    'lib/agent-harness/builtin-harness-backends.ts',
    'lib/mcp/adapters/index.js',
    'app_front/features/settings/models/harnessModelSettingsPanels.js',
    'app_front/features/settings/models/harnessSettingsSchemas.js',
    'lib/agent-harness/registry.ts',
  ]) {
    assert.doesNotMatch(read(file), /\bzai\b/i, `${file} must not mention zai`);
  }
  assert.match(read('app_front/features/settings/models/optionalHarnessPanels.js'), /import\(['"]\.\.\/\.\.\/\.\.\/\.\.\/harnesses\/zai\/front\.js['"]\)/);
});

/** Run a probe in a fresh process with its own tmp data dir; records every loaded module URL. */
function probeRegistries(env) {
  const code = `
    const { loadOptionalHarnessPlugins } = await import('./lib/agent-harness/optional-harness-plugins.ts');
    const { listHarnesses } = await import('./lib/agent-harness/registry.ts');
    const { listBuiltinHarnessProviders } = await import('./lib/agent-harness/builtin-harness-providers.ts');
    const { listBuiltinHarnessBackends } = await import('./lib/agent-harness/builtin-harness-backends.ts');
    const { getHarnessMcpAdapter } = await import('./lib/mcp/adapters/index.js');
    const { listHarnessCatalog } = await import('./lib/harness-catalog.js');
    const { getDisabledOptionalHarness, describeDisabledOptionalHarness } = await import('./lib/agent-harness/disabled-optional-harness.ts');
    const result = await loadOptionalHarnessPlugins();
    const catalog = await listHarnessCatalog();
    const disabled = getDisabledOptionalHarness('zai');
    process.stdout.write(JSON.stringify({
      loaded: result.loaded,
      errors: result.errors,
      harnesses: listHarnesses().map((meta) => meta.transport),
      providers: listBuiltinHarnessProviders().map((row) => row.id),
      backends: listBuiltinHarnessBackends().map((row) => row.id),
      adapter: Boolean(getHarnessMcpAdapter('zai')),
      catalog: catalog.map((row) => row.id),
      disabled: disabled ? describeDisabledOptionalHarness(disabled) : null,
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

test('zai plugin enabled by default (with opencode): registered everywhere', async () => {
  const { run, modules } = await probeRegistries({});
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.errors, []);
  assert.ok(out.loaded.includes('opencode') && out.loaded.includes('zai'), out.loaded.join());
  assert.ok(out.loaded.indexOf('opencode') < out.loaded.indexOf('zai'), 'the dependency loads first');
  assert.ok(out.providers.includes('zai') && out.backends.includes('zai') && out.adapter && out.catalog.includes('zai'));
  assert.equal(out.disabled, null);
  assert.ok(modules.some((url) => /\/harnesses\/zai\/light\.js$/.test(url)));
});

test('zai plugin enabled without opencode: a logged error and a disabled plugin, never a crash', async () => {
  const { run, modules } = await probeRegistries({ CRETLI_OPTIONAL_HARNESSES: 'zai' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.loaded, []);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].dir, 'zai');
  assert.equal(out.errors[0].code, 'dependency_missing');
  assert.match(out.errors[0].error, /"opencode"/);
  assert.match(out.errors[0].error, /CRETLI_OPTIONAL_HARNESSES=opencode,zai/);
  for (const key of ['harnesses', 'providers', 'backends', 'catalog']) {
    assert.ok(!out[key].includes('zai'), `${key} must not list zai`);
  }
  assert.equal(out.adapter, false);
  // The chat id stays valid but read-only, and the message names the missing plugin.
  assert.match(out.disabled, /OpenCode/);
  assert.deepEqual(modules.filter((url) => /\/harnesses\/(zai|opencode)\//.test(url) && !/harness-plugin\.json/.test(url)), []);

  const both = await probeRegistries({ CRETLI_OPTIONAL_HARNESSES: 'zai,opencode' });
  const bothOut = JSON.parse(both.run.stdout);
  assert.deepEqual(bothOut.errors, []);
  assert.deepEqual(bothOut.loaded, ['opencode', 'zai']);
});
