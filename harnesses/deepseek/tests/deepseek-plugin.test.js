/**
 * The shipped deepseek plugin (harnesses/deepseek): manifest, light-entry import
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
  const dir = path.join(projectRoot, 'harnesses', 'deepseek');
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
    'app_front/features/settings/models/harnessSettingsSchemas.js',
    'lib/chat-title-providers.js',
    'lib/harness-versions.js',
    'lib/agent-harness/registry.ts',
    'lib/agent-harness/room-kernel.ts',
    'lib/usage/billing-account-registry.ts',
    'lib/routes/credit-ledger-routes.js',
  ]) {
    assert.doesNotMatch(read(file), /deepseek/i, `${file} must not mention deepseek`);
  }
  assert.match(read('app_front/features/settings/models/optionalHarnessPanels.js'), /import\(['"]\.\.\/\.\.\/\.\.\/\.\.\/harnesses\/deepseek\/front\.js['"]\)/);
});

/**
 * Run a probe in a fresh process that records every module URL the loader pulls
 * in, so "no deepseek module is imported" is observed rather than assumed.
 */
function probeRegistries(env) {
  const code = `
    const { loadOptionalHarnessPlugins } = await import('./lib/agent-harness/optional-harness-plugins.ts');
    const { listHarnesses } = await import('./lib/agent-harness/registry.ts');
    const { listBuiltinHarnessProviders } = await import('./lib/agent-harness/builtin-harness-providers.ts');
    const { listBuiltinHarnessBackends } = await import('./lib/agent-harness/builtin-harness-backends.ts');
    const { getHarnessMcpAdapter } = await import('./lib/mcp/adapters/index.js');
    const { TITLE_PROVIDER_ADAPTERS } = await import('./lib/chat-title-providers.js');
    const { listHarnessVersionIds } = await import('./lib/harness-versions.js');
    const hooks = await import('./lib/agent-harness/optional-harness-hooks.ts');
    const { listProcessLifecycleProviders } = await import('./lib/agent-harness/builtin-harness-providers.ts');
    const { listHarnessCatalog } = await import('./lib/harness-catalog.js');
    const result = await loadOptionalHarnessPlugins();
    const catalog = await listHarnessCatalog();
    process.stdout.write(JSON.stringify({
      loaded: result.loaded,
      errors: result.errors,
      harnesses: listHarnesses().map((meta) => meta.transport),
      providers: listBuiltinHarnessProviders().map((row) => row.id),
      backends: listBuiltinHarnessBackends().map((row) => row.id),
      titleProviders: TITLE_PROVIDER_ADAPTERS.map((row) => row.id),
      versionIds: listHarnessVersionIds(),
      hooks: {
        limitBinding: Object.keys(hooks.resolveHarnessLimitBinding('deepseek', {})).length >= 0 && hooks.hasOptionalHarnessHooks('deepseek'),
        billing: Boolean(hooks.getHarnessBillingCredentialSource('deepseek')),
        ledgerRoutes: hooks.listCreditLedgerContributions().length,
        lifecycle: listProcessLifecycleProviders().some((row) => row.id === 'deepseek'),
      },
      adapter: Boolean(getHarnessMcpAdapter('deepseek')),
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

test('deepseek plugin disabled: absent from every registry and no deepseek module is imported', async () => {
  const { run, modules } = await probeRegistries({ CRETLI_OPTIONAL_HARNESSES: '' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.loaded, []);
  assert.deepEqual(out.errors, []);
  for (const key of ['harnesses', 'providers', 'backends', 'catalog']) {
    assert.ok(!out[key].includes('deepseek'), `${key} must not list deepseek`);
  }
  assert.equal(out.adapter, false);
  assert.ok(!out.titleProviders.includes('deepseek'), 'title providers must not list deepseek');
  assert.ok(!out.versionIds.includes('deepseek'), 'version table must not list deepseek');
  assert.deepEqual(out.hooks, { limitBinding: false, billing: false, ledgerRoutes: 0, lifecycle: false });
  assert.deepEqual(modules.filter((url) => /\/harnesses\/deepseek\//.test(url) || /@deepseek-ai\//.test(url)), []);
});

test('deepseek plugin enabled by default: registered everywhere with the same catalog position', async () => {
  const { run, modules } = await probeRegistries({});
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.ok(out.loaded.includes('deepseek'), out.loaded.join());
  assert.deepEqual(out.errors, []);
  // Same list positions as when deepseek was built in: after codebuddy, before codex.
  assert.ok(out.harnesses.indexOf('deepseek') < out.harnesses.indexOf('codex') && out.harnesses.indexOf('opencode') < out.harnesses.indexOf('deepseek'), out.harnesses.join());
  const titleIds = out.titleProviders;
  assert.ok(titleIds.indexOf('openrouter') < titleIds.indexOf('deepseek') && titleIds.indexOf('deepseek') < titleIds.indexOf('codex'), titleIds.join());
  assert.ok(out.versionIds.indexOf('deepseek') < out.versionIds.indexOf('codex'), out.versionIds.join());
  assert.equal(out.hooks.limitBinding, true);
  assert.equal(out.hooks.billing, true);
  assert.equal(out.hooks.ledgerRoutes, 1);
  assert.equal(out.hooks.lifecycle, true);
  assert.ok(out.providers.includes('deepseek') && out.backends.includes('deepseek') && out.adapter && out.catalog.includes('deepseek'));
  assert.ok(modules.some((url) => /\/harnesses\/deepseek\/light\.js$/.test(url)));

  const listedOnly = await probeRegistries({ CRETLI_OPTIONAL_HARNESSES: 'deepseek' });
  assert.deepEqual(JSON.parse(listedOnly.run.stdout).loaded, ['deepseek']);
});
