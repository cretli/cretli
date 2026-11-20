/**
 * The OpenRouter CLIENT (lib/providers/openrouter) is core infrastructure: with
 * the OpenRouter chat plugin disabled (CRETLI_OPTIONAL_HARNESSES without
 * openrouter) model-pick, chat titles, the cost proxy, usage mapping, the model
 * catalog and the SSE stream keep working. Observed in a fresh process; no
 * network (fetch is stubbed) and an isolated data dir.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROBE = `
const out = {};
const { loadOptionalHarnessPlugins } = await import('./lib/agent-harness/optional-harness-plugins.ts');
const { listBuiltinHarnessProviders } = await import('./lib/agent-harness/builtin-harness-providers.ts');
const { getBuiltinHarnessBackend } = await import('./lib/agent-harness/builtin-harness-backends.ts');
const load = await loadOptionalHarnessPlugins();
out.loaded = load.loaded;
out.errors = load.errors;
out.providerRegistered = listBuiltinHarnessProviders().some((row) => row.id === 'openrouter');
out.backendRegistered = Boolean(getBuiltinHarnessBackend('openrouter'));

const sse = (events) => events.map((event) => 'data: ' + JSON.stringify(event) + '\\n\\n').join('') + 'data: [DONE]\\n\\n';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url || '');
  if (url.endsWith('/models')) {
    return { ok: true, status: 200, async json() {
      return { data: [{ id: 'openrouter/alpha', name: 'Alpha', pricing: { prompt: '0.000002', completion: '0.00001' } }] };
    } };
  }
  if (url.includes('/chat/completions')) {
    const body = sse([
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ]);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return realFetch(input);
};

const models = await import('./lib/providers/openrouter/openrouter-models.ts');
const listed = await models.listOpenRouterModels({ refresh: true });
out.modelIds = listed.models.map((row) => row.id);

const pricingCache = await import('./lib/providers/openrouter/openrouter-pricing-cache.ts');
const pricing = pricingCache.getOpenRouterEndpointPricing('openrouter/alpha');
out.pricingPrompt = pricing?.pricing?.prompt ?? null;

const client = await import('./lib/providers/openrouter/openrouter-client.ts');
let text = '';
let usage = null;
for await (const chunk of client.streamOpenRouterChatCompletion({ model: 'openrouter/alpha', messages: [{ role: 'user', content: 'hi' }] })) {
  if (chunk.deltaText) text += chunk.deltaText;
  if (chunk.usage) usage = chunk.usage;
}
out.streamText = text;

const costProxy = await import('./lib/model-pick-cost-proxy.js');
const estimate = costProxy.estimateCostProxy({
  harness: 'openrouter',
  model: 'openrouter/alpha',
  samples: costProxy.collectTokenSamples([], () => ''),
  openrouterPricingFor: (id) => pricingCache.getOpenRouterEndpointPricing(id)?.pricing ?? null,
});
out.costBasis = estimate.basis;
out.costRateSource = estimate.rateSource;

const usageMod = await import('./lib/usage/harness-usage.ts');
const tokens = usageMod.resolveHarnessUsageTokens('openrouter', { usage });
out.usageTokens = tokens ? { textInput: tokens.textInput, textOutput: tokens.textOutput } : null;

const titles = await import('./lib/chat-title-providers.js');
const row = titles.listTitleProviders({}).find((entry) => entry.id === 'openrouter');
out.titleProvider = row ? { available: row.available, models: row.models.length } : null;

process.stdout.write(JSON.stringify(out));
`;

/**
 * @param {Record<string, string>} env
 */
async function runProbe(env, code = PROBE) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cretli-or-client-'));
  try {
    const childEnv = {
      ...process.env,
      CRETLI_DATA_DIR: path.join(tmp, 'data'),
      OPENROUTER_API_KEY: 'sk-or-v1-testkey123456',
      ...env,
    };
    if (env.OPENROUTER_API_KEY === '') delete childEnv.OPENROUTER_API_KEY;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: projectRoot, env: childEnv, encoding: 'utf8' });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

for (const [label, selection] of [['no optional harness', ''], ['other plugins only', 'mistral']]) {
  test(`OpenRouter client keeps working with the chat plugin disabled (${label})`, async () => {
    const run = await runProbe({ CRETLI_OPTIONAL_HARNESSES: selection });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual(out.errors, []);
    assert.ok(!out.loaded.includes('openrouter'));
    assert.equal(out.providerRegistered, false);
    assert.equal(out.backendRegistered, false);
    // Model catalog + pricing cache (model-pick input).
    assert.deepEqual(out.modelIds, ['openrouter/alpha']);
    assert.equal(out.pricingPrompt, '0.000002');
    // SSE client.
    assert.equal(out.streamText, 'hello');
    // Cost proxy prices the candidate from the catalog, not from a tier guess.
    assert.equal(out.costBasis, 'rate');
    assert.equal(out.costRateSource, 'openrouter_pricing');
    // Usage mapping for openrouter-shaped events.
    assert.deepEqual(out.usageTokens, { textInput: 10, textOutput: 4 });
    // Chat titles via OpenRouter.
    assert.equal(out.titleProvider?.available, true);
    assert.ok(out.titleProvider.models > 0);
  });
}

const SETTINGS_PROBE = `
const out = {};
const { loadOptionalHarnessPlugins } = await import('./lib/agent-harness/optional-harness-plugins.ts');
out.loaded = (await loadOptionalHarnessPlugins()).loaded;
const { createSession, getCsrfTokenForSessionToken, requireAuth, setPassword, AUTH_CSRF_HEADER } = await import('./lib/auth.js');
const { registerSettingsRoutes } = await import('./lib/routes/settings-routes.js');
const { default: express } = await import('express');
setPassword('test-password-123');
const token = createSession();
const headers = { cookie: 'cr_session=' + encodeURIComponent(token), [AUTH_CSRF_HEADER]: getCsrfTokenForSessionToken(token), 'Content-Type': 'application/json' };
const app = express();
app.use(express.json());
app.use(requireAuth);
registerSettingsRoutes(app, {
  port: 0, useHttps: false, serverInstanceToken: 't',
  frontHotFallbackEnabled: false, getLanHost: () => null,
  getConfiguredWorkspaceSelection: () => ({ workspaceFile: '', workspaceFolder: '' }),
  isSessionSyncEnabled: () => false,
});
const server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
const url = 'http://127.0.0.1:' + server.address().port + '/api/settings';
const call = async (method, body) => {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const key = 'sk-or-v1-' + 'b'.repeat(40);
const bad = await call('PATCH', { openrouterApiKey: 'sk-wrong' });
out.badStatus = bad.status;
const saved = await call('PATCH', { openrouterApiKey: key, openrouterSiteUrl: 'https://example.com', openrouterAppTitle: 'My app' });
out.saveStatus = saved.status;
out.effective = saved.body.openrouterApiKeyEffective;
out.stored = saved.body.openrouterApiKeyStoredInSettings;
out.leaksKey = JSON.stringify(saved.body).includes(key);
const { loadSettings } = await import('./lib/persist/settings.js');
const persisted = loadSettings();
out.persisted = { key: persisted.openrouterApiKey === key, site: persisted.openrouterSiteUrl, title: persisted.openrouterAppTitle };
const get = await call('GET');
out.getEffective = get.body.openrouterApiKeyEffective;
out.chatModelsKey = 'openrouterChatEnabledModels' in get.body;
const cleared = await call('PATCH', { clearOpenrouterApiKey: true });
out.clearedStored = cleared.body.openrouterApiKeyStoredInSettings;
out.clearedEffective = cleared.body.openrouterApiKeyEffective;
await new Promise((resolve) => server.close(resolve));
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

test('OpenRouter API key settings stay patchable and reported with the chat plugin disabled', async () => {
  const run = await runProbe({ CRETLI_OPTIONAL_HARNESSES: '', OPENROUTER_API_KEY: '' }, SETTINGS_PROBE);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.loaded, []);
  assert.equal(out.badStatus, 400);
  assert.equal(out.saveStatus, 200);
  assert.equal(out.effective, true);
  assert.equal(out.stored, true);
  assert.equal(out.leaksKey, false);
  assert.deepEqual(out.persisted, { key: true, site: 'https://example.com', title: 'My app' });
  assert.equal(out.getEffective, true);
  // The favorites field belongs to the plugin and is absent while it is off.
  assert.equal(out.chatModelsKey, false);
  assert.equal(out.clearedStored, false);
  assert.equal(out.clearedEffective, false);
});
