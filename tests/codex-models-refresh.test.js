import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { catalogFromCodexModelsCache, listCodexModels } from '../lib/codex/codex-models.js';
import {
  CODEX_CATALOG_PROBE_MODEL,
  deleteCodexModelsCache,
  fingerprintCodexCatalog,
  refreshLiveCodexCatalog,
  runCodexCatalogProbe,
  shouldHintCodexCatalogRelogin,
} from '../lib/codex/codex-models-refresh.js';

/**
 * @param {string} slug
 * @returns {Record<string, unknown>}
 */
function cacheRow(slug) {
  return {
    slug,
    visibility: 'list',
    display_name: slug,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
  };
}

/**
 * @param {string} homeDir
 * @param {string[]} slugs
 */
function writeCache(homeDir, slugs) {
  fs.writeFileSync(
    path.join(homeDir, 'models_cache.json'),
    JSON.stringify({ models: slugs.map((slug) => cacheRow(slug)) }),
    'utf8',
  );
}

function makeHomeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-refresh-'));
}

const terraOnly = catalogFromCodexModelsCache({ models: [cacheRow('gpt-5.6-terra')] });
const terraLuna = catalogFromCodexModelsCache({
  models: [cacheRow('gpt-5.6-terra'), cacheRow('gpt-5.6-luna')],
});
assert.equal(fingerprintCodexCatalog(terraOnly), 'gpt-5.6-terra');
assert.equal(fingerprintCodexCatalog(terraLuna), 'gpt-5.6-luna,gpt-5.6-terra');

assert.equal(shouldHintCodexCatalogRelogin({
  refresh: true,
  catalogUnchanged: true,
  planTypeUnchanged: true,
}), true);
assert.equal(shouldHintCodexCatalogRelogin({
  refresh: true,
  catalogUnchanged: false,
  planTypeUnchanged: true,
}), false);
assert.equal(shouldHintCodexCatalogRelogin({
  refresh: true,
  catalogUnchanged: true,
  planTypeUnchanged: false,
}), false);
assert.equal(shouldHintCodexCatalogRelogin({
  refresh: false,
  catalogUnchanged: true,
  planTypeUnchanged: true,
}), false);

{
  const homeDir = makeHomeDir();
  writeCache(homeDir, ['gpt-5.6-terra']);
  const cacheFile = path.join(homeDir, 'models_cache.json');
  assert.equal(fs.existsSync(cacheFile), true);
  let sawMissingCache = false;
  const listed = await refreshLiveCodexCatalog({
    homeDir,
    runProbe: async ({ homeDir: probeHome }) => {
      sawMissingCache = !fs.existsSync(path.join(probeHome, 'models_cache.json'));
      writeCache(probeHome, ['gpt-5.6-terra', 'gpt-5.6-luna']);
      return { exitCode: 1 };
    },
  });
  assert.equal(sawMissingCache, true);
  assert.ok(listed.catalog.some((row) => row.modelId === 'gpt-5.6-luna'));
  assert.ok(listed.catalog.some((row) => row.modelId === 'gpt-5.6-terra'));
  assert.equal(listed.modelsSource, 'live');
  fs.rmSync(homeDir, { recursive: true, force: true });
}

{
  const homeDir = makeHomeDir();
  writeCache(homeDir, ['gpt-5.6-terra']);
  let probeCalls = 0;
  const runProbe = async () => {
    probeCalls += 1;
    return { exitCode: 1 };
  };
  await listCodexModels({
    refresh: false,
    authMode: 'chatgpt',
    homeDir,
    runProbe,
  });
  assert.equal(probeCalls, 0, 'plain GET must not spawn Codex CLI');
  await listCodexModels({
    refresh: true,
    authMode: 'chatgpt',
    homeDir,
    runProbe,
  });
  assert.equal(probeCalls, 1, 'refresh=1 must run the catalog probe');
  fs.rmSync(homeDir, { recursive: true, force: true });
}

{
  const homeDir = makeHomeDir();
  writeCache(homeDir, ['gpt-5.6-terra']);
  let probeCalls = 0;
  const listed = await listCodexModels({
    refresh: true,
    authMode: 'api-key',
    homeDir,
    runProbe: async () => {
      probeCalls += 1;
      return { exitCode: 0 };
    },
  });
  assert.equal(probeCalls, 0, 'API-key mode skips the ChatGPT catalog probe');
  assert.equal(listed.modelsSource, 'fallback');
  assert.equal(listed.reloginHint, false);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

{
  const homeDir = makeHomeDir();
  writeCache(homeDir, ['gpt-5.6-terra']);
  const listed = await listCodexModels({
    refresh: true,
    authMode: 'chatgpt',
    homeDir,
    chatgptPlanType: 'free',
    runProbe: async ({ homeDir: probeHome }) => {
      writeCache(probeHome, ['gpt-5.6-terra']);
      return { exitCode: 1 };
    },
  });
  assert.equal(listed.modelsSource, 'live');
  assert.equal(listed.reloginHint, true);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

{
  const homeDir = makeHomeDir();
  writeCache(homeDir, ['gpt-5.6-terra']);
  const makePlanJwt = (plan) => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_plan_type: plan },
    })).toString('base64url');
    return `${header}.${body}.sig`;
  };
  const writeAuth = (plan) => {
    fs.writeFileSync(path.join(homeDir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: makePlanJwt(plan), access_token: 'tok', refresh_token: 'ref' },
    }), 'utf8');
  };
  writeAuth('free');
  const listed = await listCodexModels({
    refresh: true,
    authMode: 'chatgpt',
    homeDir,
    runProbe: async ({ homeDir: probeHome }) => {
      writeCache(probeHome, ['gpt-5.6-terra']);
      writeAuth('go');
      return { exitCode: 1 };
    },
  });
  assert.equal(listed.reloginHint, false);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

{
  const homeDir = makeHomeDir();
  writeCache(homeDir, ['gpt-5.6-terra']);
  const listed = await listCodexModels({
    refresh: true,
    authMode: 'chatgpt',
    homeDir,
    chatgptPlanType: 'free',
    runProbe: async ({ homeDir: probeHome }) => {
      writeCache(probeHome, ['gpt-5.6-terra', 'gpt-6-astra']);
      return { exitCode: 1 };
    },
  });
  assert.equal(listed.reloginHint, false);
  assert.ok(listed.catalog.some((row) => row.modelId === 'gpt-6-astra'));
  fs.rmSync(homeDir, { recursive: true, force: true });
}

{
  const homeDir = makeHomeDir();
  /** @type {{ args: string[], env: Record<string, string> } | null} */
  let captured = null;
  await runCodexCatalogProbe({
    homeDir,
    cliPath: '/usr/bin/true',
    spawnFn: (_bin, args, opts) => {
      captured = { args, env: opts.env };
      const child = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      queueMicrotask(() => child.emit('close', 1));
      return child;
    },
  });
  assert.ok(captured);
  assert.deepEqual(captured.args, [
    'exec',
    '--skip-git-repo-check',
    '--experimental-json',
    '-m',
    CODEX_CATALOG_PROBE_MODEL,
  ]);
  assert.equal(captured.env.CODEX_HOME, homeDir);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

{
  const homeDir = makeHomeDir();
  writeCache(homeDir, ['gpt-5.6-terra']);
  deleteCodexModelsCache(homeDir);
  assert.equal(fs.existsSync(path.join(homeDir, 'models_cache.json')), false);
  deleteCodexModelsCache(homeDir);
  fs.rmSync(homeDir, { recursive: true, force: true });
}

console.log('codex-models-refresh.test.js OK');
