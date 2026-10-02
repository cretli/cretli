/**
 * Auto-title providers: availability (key ok / wrong format / missing), 'auto' pick, HTTP adapters
 * with a mocked fetch, no key leakage, /api/settings/auto-title/* routes, PATCH validation.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';

for (const name of [
  'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
]) delete process.env[name];

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const claudeCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-title-claudecfg-'));
process.env.CRETLI_CLAUDE_CONFIG_DIR = claudeCfgDir;
const { loadSettings, saveSettings } = await import('../lib/persist/settings.js');
const { loadChats, addChat } = await import('../lib/persist/chats-persist.js');
const providers = await import('../lib/chat-title-providers.js');
const { createChatTitleService } = await import('../lib/chat-title-service.js');
const { registerSettingsRoutes } = await import('../lib/routes/settings-routes.js');
const { removeIsolatedDataDir } = await import('./helpers/isolated-data-dir.js');

const OR_KEY = 'sk-or-v1-SECRETOPENROUTERKEY1234';
const DS_KEY = 'ds-SECRETDEEPSEEKKEY5678';
const BAD_OR_KEY = 'sk-zoyBADFORMATSECRET9999';
const ALL_KEYS = [OR_KEY, DS_KEY, BAD_OR_KEY, 'qwen-SECRETQWEN', 'cx-SECRETCODEX', 'ant-SECRETCLAUDE'];

function setSettings(patch, replace = false) {
  const base = replace ? {} : loadSettings();
  saveSettings({ ...base, ...patch });
}
const byId = (list, id) => list.find((p) => p.id === id);

// --- fake express app ---
const handlers = new Map();
const app = {};
for (const verb of ['get', 'post', 'patch', 'delete', 'put']) {
  app[verb] = (p, fn) => handlers.set(`${verb.toUpperCase()} ${p}`, fn);
}
registerSettingsRoutes(app, {
  getLanHost: () => null,
  getConfiguredWorkspaceSelection: () => ({}),
  isSessionSyncEnabled: () => false,
  resolveFrontHmrEnabledFromSettings: () => false,
});
function invoke(method, urlPath, body = {}) {
  const fn = handlers.get(`${method} ${urlPath}`);
  assert.ok(fn, `handler ${method} ${urlPath}`);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    Promise.resolve(fn({ params: {}, query: {}, body, headers: {} }, res)).catch((e) => resolve({ status: 599, body: { error: e.message } }));
  });
}

const realFetch = globalThis.fetch;
const calls = [];
function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}
const jsonResponse = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });

try {
  // --- availability: nothing configured ---
  setSettings({}, true);
  let list = providers.listTitleProviders();
  for (const id of ['openrouter', 'deepseek', 'qwen', 'codex', 'claude']) {
    assert.equal(byId(list, id).available, false, id);
    assert.equal(byId(list, id).reason, 'no_key', id);
  }
  for (const id of ['sdk', 'opencode', 'codebuddy']) {
    assert.equal(byId(list, id).available, false, id);
    assert.equal(byId(list, id).reason, 'unsupported', id);
    assert.deepEqual(byId(list, id).models, []);
  }
  const none = providers.resolveTitleProvider();
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'none_available');
  assert.match(providers.explainTitleGeneratorGap(), /openrouter: no API key/);

  // --- wrong OpenRouter key format (the sk-zoy… case) ---
  setSettings({ openrouterApiKey: BAD_OR_KEY });
  list = providers.listTitleProviders();
  assert.equal(byId(list, 'openrouter').reason, 'invalid_key_format');
  assert.match(providers.explainTitleGeneratorGap(), /wrong format/);
  assert.ok(!providers.explainTitleGeneratorGap().includes(BAD_OR_KEY));

  // --- valid OpenRouter key ---
  setSettings({ openrouterApiKey: OR_KEY });
  assert.equal(byId(providers.listTitleProviders(), 'openrouter').available, true);
  let resolved = providers.resolveTitleProvider();
  assert.equal(resolved.ok, true);
  assert.equal(resolved.provider, 'openrouter');
  assert.equal(resolved.model, 'openai/gpt-4o-mini');

  // --- 'auto' skips unavailable earlier providers, takes the first available ---
  setSettings({ openrouterApiKey: BAD_OR_KEY, deepseekApiKey: DS_KEY });
  resolved = providers.resolveTitleProvider();
  assert.equal(resolved.provider, 'deepseek');
  assert.equal(resolved.model, 'deepseek-flash');

  // --- explicit provider unavailable => clear reason, not a silent pass ---
  const explicit = providers.resolveTitleProvider({ provider: 'openrouter', model: 'x' });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.reason, 'invalid_key_format');
  assert.match(explicit.message, /openrouter unavailable/);

  // --- harness disabled in Settings ---
  setSettings({ openrouterApiKey: OR_KEY, enabledHarnesses: ['deepseek', 'qwen'] });
  assert.equal(byId(providers.listTitleProviders(), 'openrouter').reason, 'harness_disabled');
  assert.equal(providers.resolveTitleProvider().provider, 'deepseek');
  setSettings({ enabledHarnesses: undefined });

  // --- plan modes: ChatGPT / Claude subscription work without an API key when logged in ---
  setSettings({ codexApiKey: 'cx-SECRETCODEX', codexAuthMode: 'chatgpt', claudeApiKey: 'ant-SECRETCLAUDE', claudeAuthMode: 'subscription' });
  list = providers.listTitleProviders();
  assert.equal(byId(list, 'codex').viaPlan, true);
  assert.equal(byId(list, 'codex').reason, 'no_key'); // no auth.json in the isolated CODEX_HOME
  assert.equal(byId(list, 'claude').viaPlan, true);
  assert.deepEqual(byId(list, 'claude').models.map((m) => m.id), ['haiku', 'sonnet']);
  assert.equal(byId(list, 'claude').defaultModel, 'haiku');
  fs.writeFileSync(path.join(claudeCfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token-xyz' } }));
  const { resolveCodexHomeDir } = await import('../lib/codex/codex-home.js');
  fs.mkdirSync(resolveCodexHomeDir(), { recursive: true });
  fs.writeFileSync(path.join(resolveCodexHomeDir(), 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake' } }));
  list = providers.listTitleProviders();
  assert.equal(byId(list, 'claude').available, true);
  assert.equal(byId(list, 'codex').available, true);
  assert.equal(providers.pickProviderModel(providers.getTitleProviderAdapter('claude'), 'openai/gpt-4o-mini'), 'haiku');

  // Claude plan runner: SDK called one-shot with tools off and no session persistence
  const { setClaudeSdkForTests, resetClaudeSdkForTests } = await import('../lib/claude/claude-sdk.js');
  let seen = null;
  setClaudeSdkForTests({
    query: ({ prompt, options }) => {
      seen = { prompt, options };
      return (async function* gen() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'plan: claude title' };
      }());
    },
  });
  const planOut = await providers.getTitleProviderAdapter('claude').generate({ prompt: 'PP', model: 'haiku' });
  resetClaudeSdkForTests();
  assert.equal(planOut, 'plan: claude title');
  assert.equal(seen.prompt, 'PP');
  assert.equal(seen.options.persistSession, false);
  assert.deepEqual(seen.options.tools, []);
  assert.equal(seen.options.maxTurns, 1);
  assert.equal((await seen.options.canUseTool()).behavior, 'deny');
  assert.ok(!JSON.stringify(planOut).includes('fake-token'));
  setSettings({ codexAuthMode: 'api-key', claudeAuthMode: 'subscription' });
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  setSettings({ claudeAuthMode: 'api-key' });
  assert.equal(byId(providers.listTitleProviders(), 'claude').reason, 'auth_mode');
  delete process.env.CLAUDE_CODE_USE_BEDROCK;

  setSettings({ codexAuthMode: 'api-key', claudeAuthMode: 'api-key' });
  list = providers.listTitleProviders();
  assert.equal(byId(list, 'codex').available, true);
  assert.equal(byId(list, 'claude').available, true);

  // --- model picking: other providers ignore a foreign stored model ---
  const ds = providers.getTitleProviderAdapter('deepseek');
  assert.equal(providers.pickProviderModel(ds, 'openai/gpt-4o-mini'), 'deepseek-flash');
  assert.equal(providers.pickProviderModel(ds, 'deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(providers.pickProviderModel(providers.getTitleProviderAdapter('openrouter'), 'any/model'), 'any/model');

  // --- adapters with mocked fetch ---
  setSettings({
    openrouterApiKey: OR_KEY, deepseekApiKey: DS_KEY, qwenApiKey: 'qwen-SECRETQWEN',
    codexApiKey: 'cx-SECRETCODEX', claudeApiKey: 'ant-SECRETCLAUDE',
  });
  const input = { prompt: 'P', model: '', signal: undefined };
  mockFetch(() => jsonResponse({ choices: [{ message: { content: 'area: do thing' } }] }));
  for (const id of ['openrouter', 'deepseek', 'qwen', 'codex']) {
    calls.length = 0;
    const adapter = providers.getTitleProviderAdapter(id);
    const out = await adapter.generate({ ...input, model: adapter.defaultModel() });
    assert.equal(out, 'area: do thing', id);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.messages[0].content, 'P');
    assert.equal(body.model, adapter.defaultModel() === 'deepseek-flash' ? 'deepseek-flash' : body.model);
    assert.match(calls[0].init.headers.Authorization, /^Bearer /);
  }
  calls.length = 0;
  await providers.getTitleProviderAdapter('deepseek').generate({ ...input, model: 'deepseek-flash' });
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  calls.length = 0;
  await providers.getTitleProviderAdapter('qwen').generate({ ...input, model: 'qwen3.8-max' });
  assert.match(calls[0].url, /\/compatible-mode\/v1\/chat\/completions$/);
  calls.length = 0;
  await providers.getTitleProviderAdapter('codex').generate({ ...input, model: 'gpt-4o-mini' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');

  calls.length = 0;
  mockFetch(() => jsonResponse({ content: [{ type: 'text', text: 'api: anthropic title' }] }));
  const claudeOut = await providers.getTitleProviderAdapter('claude').generate({ ...input, model: 'claude-haiku-4-5-20251001' });
  assert.equal(claudeOut, 'api: anthropic title');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'ant-SECRETCLAUDE');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');

  mockFetch(() => jsonResponse({}, 401));
  await assert.rejects(
    () => providers.getTitleProviderAdapter('deepseek').generate({ ...input, model: 'deepseek-flash' }),
    (err) => err.message === 'title generator HTTP 401' && !ALL_KEYS.some((k) => err.message.includes(k)),
  );

  // --- default generator through the service: routes to the 'auto' provider; log has no key ---
  setSettings({ openrouterApiKey: BAD_OR_KEY, deepseekApiKey: DS_KEY, qwenApiKey: undefined, codexApiKey: undefined, claudeApiKey: undefined });
  calls.length = 0;
  mockFetch(() => jsonResponse({ choices: [{ message: { content: 'auth: fix token expiry' } }] }));
  const viaDefault = await providers.generateTitleViaProvider({ prompt: 'P', model: 'openai/gpt-4o-mini' });
  assert.equal(viaDefault, 'auth: fix token expiry');
  assert.match(calls[0].url, /deepseek/);
  assert.equal(JSON.parse(calls[0].init.body).model, 'deepseek-flash');

  setSettings({}, true);
  const logs = [];
  setSettings({ openrouterApiKey: BAD_OR_KEY });
  const chat = addChat('s-prov', 'Claude chat 1', undefined, undefined, undefined, {});
  const { appendChatHistoryEvents } = await import('../lib/persist/chat-history-persist.js');
  appendChatHistoryEvents(chat.id, 's-prov', [{ rec: { kind: 'localUser', text: 'Napraw logowanie' } }]);
  const svc = createChatTitleService({ log: (m) => logs.push(m) });
  assert.equal((await svc.requestTitle(chat.id)).reason, 'no_generator');
  assert.ok(logs.some((m) => /no title generator available \(.*wrong format/.test(m)), logs.join('\n'));
  assert.ok(!logs.join('\n').includes(BAD_OR_KEY));

  // --- routes: providers list ---
  setSettings({ openrouterApiKey: OR_KEY, deepseekApiKey: DS_KEY });
  const listRes = await invoke('GET', '/api/settings/auto-title/providers');
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.ok, true);
  assert.equal(byId(listRes.body.providers, 'openrouter').available, true);
  assert.equal(listRes.body.selected.provider, 'auto');
  assert.equal(listRes.body.effective.provider, 'openrouter');
  assert.ok(!JSON.stringify(listRes.body).includes('SECRET'));

  // --- routes: test endpoint — no chat written, no settings change, no key in response ---
  const chatsBefore = JSON.stringify(loadChats());
  const settingsBefore = JSON.stringify(loadSettings());
  calls.length = 0;
  mockFetch(() => jsonResponse({ choices: [{ message: { content: 'login: fix mobile button' } }] }));
  const okTest = await invoke('POST', '/api/settings/auto-title/test', { provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.equal(okTest.status, 200);
  assert.equal(okTest.body.ok, true);
  assert.equal(okTest.body.title, 'login: fix mobile button');
  assert.equal(okTest.body.provider, 'deepseek');
  assert.equal(JSON.parse(calls[0].init.body).model, 'deepseek-v4-pro');
  assert.ok(!ALL_KEYS.some((k) => JSON.stringify(okTest.body).includes(k)));
  mockFetch(() => jsonResponse({}, 500));
  const failTest = await invoke('POST', '/api/settings/auto-title/test', { provider: 'openrouter' });
  assert.equal(failTest.body.ok, false);
  assert.ok(!ALL_KEYS.some((k) => JSON.stringify(failTest.body).includes(k)));
  const unavailTest = await invoke('POST', '/api/settings/auto-title/test', { provider: 'qwen' });
  assert.equal(unavailTest.body.ok, false);
  assert.equal(unavailTest.body.reason, 'no_key');
  assert.equal((await invoke('POST', '/api/settings/auto-title/test', { provider: 'sdk' })).status, 400);
  assert.equal(JSON.stringify(loadChats()), chatsBefore);
  assert.equal(JSON.stringify(loadSettings()), settingsBefore);

  // --- PATCH validation ---
  const bad = await invoke('PATCH', '/api/settings', { autoTitle: { provider: 'bogus' } });
  assert.equal(bad.status, 400);
  assert.equal((await invoke('PATCH', '/api/settings', { autoTitle: { provider: 'sdk' } })).status, 400);
  assert.equal(loadSettings().autoTitle, undefined);
  const good = await invoke('PATCH', '/api/settings', { autoTitle: { provider: 'deepseek', model: 'deepseek-v4-pro', mode: 'first' } });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.deepEqual(
    { p: loadSettings().autoTitle.provider, m: loadSettings().autoTitle.model },
    { p: 'deepseek', m: 'deepseek-v4-pro' },
  );
  assert.equal(good.body.autoTitle.provider, 'deepseek');
  await invoke('PATCH', '/api/settings', { autoTitle: { provider: 'auto' } });
  assert.equal(loadSettings().autoTitle.provider, undefined);

  console.log('chat-title-providers.test.js OK');
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(claudeCfgDir, { recursive: true, force: true });
  removeIsolatedDataDir();
}
