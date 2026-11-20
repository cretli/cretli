/**
 * The shipped openrouter chat plugin (harnesses/openrouter): manifest, light-entry import
 * ban, composition roots that must not name it, and the enabled / disabled
 * registry behaviour observed in a fresh process (loaded module URLs recorded).
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

test('manifest, light entry import ban and composition roots that do not name the plugin', () => {
  const dir = path.join(projectRoot, 'harnesses', 'openrouter');
  const manifest = validateHarnessPluginManifest(JSON.parse(readFileSync(path.join(dir, 'harness-plugin.json'), 'utf8')));
  assert.equal(manifest.ok, true);
  assert.equal(manifest.manifest.origin, 'builtin-optional');
  assert.equal(manifest.manifest.defaultEnabled, true);
  assert.deepEqual({ ...manifest.manifest.entries }, { light: './light.js', heavy: './heavy.js', front: './front.js' });
  assert.deepEqual(lightImportViolations(path.join(dir, 'light.js')), []);
  for (const file of [
    'lib/agent-harness/builtin-harness-providers.ts',
    'lib/agent-harness/builtin-harness-backends.ts',
    'lib/mcp/adapters/index.js',
    'app_front/features/settings/models/harnessModelSettingsPanels.js',
    'lib/agent-harness/registry.ts',
    'lib/harness-versions.js',
  ]) {
    assert.doesNotMatch(read(file), /openrouter/i, `${file} must not mention openrouter`);
  }
  assert.match(read('app_front/features/settings/models/optionalHarnessPanels.js'), /import\(['"]\.\.\/\.\.\/\.\.\/\.\.\/harnesses\/openrouter\/front\.js['"]\)/);
});

/**
 * Run a probe in a fresh process that records every module URL the loader pulls
 * in, so "no openrouter module is imported" is observed rather than assumed.
 */
function probeRegistries(env) {
  const code = `
    const { loadOptionalHarnessPlugins } = await import('./lib/agent-harness/optional-harness-plugins.ts');
    const { listHarnesses } = await import('./lib/agent-harness/registry.ts');
    const { listBuiltinHarnessProviders } = await import('./lib/agent-harness/builtin-harness-providers.ts');
    const { listBuiltinHarnessBackends } = await import('./lib/agent-harness/builtin-harness-backends.ts');
    const { getHarnessMcpAdapter } = await import('./lib/mcp/adapters/index.js');
    const { hasHarnessVersionsRow } = await import('./lib/harness-versions.js');
    const { listHarnessCatalog } = await import('./lib/harness-catalog.js');
    const result = await loadOptionalHarnessPlugins();
    const catalog = await listHarnessCatalog();
    process.stdout.write(JSON.stringify({
      loaded: result.loaded,
      errors: result.errors,
      harnesses: listHarnesses().map((meta) => meta.transport),
      providers: listBuiltinHarnessProviders().map((row) => row.id),
      backends: listBuiltinHarnessBackends().map((row) => row.id),
      adapter: Boolean(getHarnessMcpAdapter('openrouter')),
      versionsRow: hasHarnessVersionsRow('openrouter'),
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

test('openrouter plugin disabled: absent from every registry and no openrouter module is imported', async () => {
  const { run, modules } = await probeRegistries({ CRETLI_OPTIONAL_HARNESSES: '' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.loaded, []);
  assert.deepEqual(out.errors, []);
  for (const key of ['harnesses', 'providers', 'backends', 'catalog']) {
    assert.ok(!out[key].includes('openrouter'), `${key} must not list openrouter`);
  }
  assert.equal(out.adapter, false);
  assert.equal(out.versionsRow, false);
  assert.deepEqual(modules.filter((url) => /\/harnesses\/openrouter\//.test(url)), []);
});

test('openrouter plugin enabled by default: registered everywhere with the same catalog position', async () => {
  const { run, modules } = await probeRegistries({});
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.ok(out.loaded.includes('openrouter'), out.loaded.join());
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.harnesses.slice(0, 3), ['sdk', 'openrouter', 'mistral']);
  assert.ok(out.providers.includes('openrouter') && out.backends.includes('openrouter') && out.adapter && out.versionsRow && out.catalog.includes('openrouter'));
  // Plugin backends keep the pre-plugin place: openrouter right before opencode.
  assert.equal(out.backends.indexOf('openrouter') + 1, out.backends.indexOf('opencode'));
  assert.ok(modules.some((url) => /\/harnesses\/openrouter\/light\.js$/.test(url)));

  const listedOnly = await probeRegistries({ CRETLI_OPTIONAL_HARNESSES: 'openrouter' });
  assert.deepEqual(JSON.parse(listedOnly.run.stdout).loaded, ['openrouter']);
});

test('the shared client lives in lib/providers/openrouter and no core or harness module imports the plugin', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(full).isDirectory() ? walk(full) : (full.endsWith('.js') ? [full] : []);
  });
  const offenders = [];
  for (const dir of ['lib', 'harnesses/mistral', 'harnesses/qwen', 'harnesses/codebuddy', 'harnesses/deepseek']) {
    for (const file of walk(path.join(projectRoot, dir))) {
      if (file.includes(`${path.sep}tests${path.sep}`)) continue;
      if (/harnesses\/openrouter\//.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(projectRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
  for (const file of ['openrouter-client', 'openrouter-api-key', 'openrouter-models', 'openrouter-pricing-cache', 'openrouter-conversation-hydrate']) {
    assert.ok(existsSync(path.join(projectRoot, 'lib', 'providers', 'openrouter', `${file}.ts`)), file);
    assert.ok(!existsSync(path.join(projectRoot, 'harnesses', 'openrouter', `${file}.js`)), `${file} must not live in the plugin`);
  }
});
