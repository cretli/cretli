import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousAnthropic = process.env.ANTHROPIC_API_KEY;
const previousDataDir = process.env.CRETLI_DATA_DIR;
const previousClaudeConfig = process.env.CRETLI_CLAUDE_CONFIG_DIR;
const previousOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const previousExternalConfig = process.env.CLAUDE_CONFIG_DIR;
const previousAuthMode = process.env.CRETLI_CLAUDE_AUTH_MODE;
const previousModel = process.env.ANTHROPIC_MODEL;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-api-key-'));
process.env.CRETLI_DATA_DIR = tempDir;
process.env.CRETLI_CLAUDE_AUTH_MODE = 'api-key';
fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
  claudeApiKey: 'settings-claude-key',
  claudeAuthMode: 'api-key',
}));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_MODEL;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.CLAUDE_CONFIG_DIR;

const {
  buildClaudeProcessEnv,
  ensureClaudeHomeDir,
  getClaudeApiKeyFromEnv,
  getClaudeApiKeyFromSettings,
  getClaudeApiKeyMetaForClient,
  getEffectiveClaudeApiKey,
  isClaudeHarnessConfigured,
  resolveClaudeHomeDir,
} = await import('../lib/claude/claude-api-key.js');
const { getClaudeAuthMode, normalizeClaudeAuthMode } = await import('../lib/claude/claude-auth-mode.js');

try {
  assert.equal(getClaudeApiKeyFromEnv(), '');
  assert.equal(getClaudeApiKeyFromSettings(), 'settings-claude-key');
  assert.equal(getEffectiveClaudeApiKey(), 'settings-claude-key');
  let meta = getClaudeApiKeyMetaForClient();
  assert.equal(meta.claudeApiKeyEffective, true);
  assert.equal(meta.claudeApiKeyFromEnv, false);
  assert.equal(meta.claudeApiKeyStoredInSettings, true);

  process.env.ANTHROPIC_API_KEY = 'env-claude-key';
  assert.equal(getClaudeApiKeyFromEnv(), 'env-claude-key');
  assert.equal(getEffectiveClaudeApiKey(), 'env-claude-key');
  meta = getClaudeApiKeyMetaForClient();
  assert.equal(meta.claudeApiKeyFromEnv, true);
  assert.equal(meta.claudeApiKeyEffective, true);

  const env = buildClaudeProcessEnv();
  assert.equal(env.ANTHROPIC_API_KEY, 'env-claude-key');
  assert.ok(String(env.CLAUDE_CONFIG_DIR || '').endsWith('claude-api-home'));
  assert.equal(env.CLAUDE_CONFIG_DIR, resolveClaudeHomeDir());
  // Options.env replaces the subprocess environment, so the inherited env must survive.
  assert.equal(env.PATH, process.env.PATH);

  delete process.env.ANTHROPIC_API_KEY;
  const settingsEnv = buildClaudeProcessEnv();
  assert.equal(settingsEnv.ANTHROPIC_API_KEY, 'settings-claude-key');
  assert.ok(fs.existsSync(ensureClaudeHomeDir()));
  assert.equal(isClaudeHarnessConfigured(), true);

  // Legacy subscription settings are ignored; Claude.ai login is not an auth path.
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    claudeApiKey: 'settings-claude-key',
  }));
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(normalizeClaudeAuthMode(undefined), 'api-key');
  assert.equal(normalizeClaudeAuthMode('api-key'), 'api-key');
  assert.equal(getClaudeAuthMode(), 'api-key');
  process.env.ANTHROPIC_API_KEY = 'env-only-key';
  assert.equal(getClaudeAuthMode(), 'api-key');
  const envOnlyEnv = buildClaudeProcessEnv();
  assert.equal(envOnlyEnv.ANTHROPIC_API_KEY, 'env-only-key');
  assert.equal(isClaudeHarnessConfigured(), true);
  // An old subscription selection cannot take precedence over user API billing.
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    claudeApiKey: 'settings-claude-key',
    claudeAuthMode: 'subscription',
  }));
  assert.equal(getClaudeAuthMode(), 'api-key');

  const legacyHome = path.join(tempDir, 'claude-home');
  fs.mkdirSync(legacyHome, { recursive: true });
  fs.writeFileSync(path.join(legacyHome, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'plan-token' },
  }));
  process.env.CLAUDE_CONFIG_DIR = legacyHome;
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    claudeApiKey: 'settings-claude-key',
    claudeAuthMode: 'subscription',
  }));
  process.env.ANTHROPIC_API_KEY = 'env-claude-key';
  process.env.ANTHROPIC_API_KEY = 'env-claude-key';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'legacy-oauth-token';
  const isolatedEnv = buildClaudeProcessEnv();
  assert.equal(isolatedEnv.ANTHROPIC_API_KEY, 'env-claude-key');
  assert.equal(isolatedEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(isolatedEnv.CLAUDE_CONFIG_DIR, resolveClaudeHomeDir());
  assert.notEqual(isolatedEnv.CLAUDE_CONFIG_DIR, legacyHome);

  // --- Task I: third-party providers and a gateway + bearer token ---
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    claudeAuthMode: 'api-key',
  }));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;

  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  assert.equal(isClaudeHarnessConfigured(), true);
  const bedrockEnv = buildClaudeProcessEnv();
  assert.equal(bedrockEnv.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(bedrockEnv.ANTHROPIC_API_KEY, undefined);
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  process.env.CLAUDE_CODE_USE_VERTEX = 'true';
  assert.equal(isClaudeHarnessConfigured(), true);
  assert.equal(buildClaudeProcessEnv().CLAUDE_CODE_USE_VERTEX, 'true');
  delete process.env.CLAUDE_CODE_USE_VERTEX;
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1';
  assert.equal(isClaudeHarnessConfigured(), true);
  assert.equal(buildClaudeProcessEnv().CLAUDE_CODE_USE_FOUNDRY, '1');
  delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  assert.equal(isClaudeHarnessConfigured(), false);

  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com';
  assert.equal(isClaudeHarnessConfigured(), false, 'custom proxy credentials are not accepted as a provider');
  process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-secret';
  assert.equal(isClaudeHarnessConfigured(), false);
  const gatewayEnv = buildClaudeProcessEnv();
  assert.equal(gatewayEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(gatewayEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;

} finally {
  if (typeof previousAnthropic === 'string') process.env.ANTHROPIC_API_KEY = previousAnthropic;
  else delete process.env.ANTHROPIC_API_KEY;
  if (typeof previousModel === 'string') process.env.ANTHROPIC_MODEL = previousModel;
  else delete process.env.ANTHROPIC_MODEL;
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  if (typeof previousClaudeConfig === 'string') process.env.CRETLI_CLAUDE_CONFIG_DIR = previousClaudeConfig;
  else delete process.env.CRETLI_CLAUDE_CONFIG_DIR;
  if (typeof previousOauth === 'string') process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOauth;
  else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof previousExternalConfig === 'string') process.env.CLAUDE_CONFIG_DIR = previousExternalConfig;
  else delete process.env.CLAUDE_CONFIG_DIR;
  if (typeof previousAuthMode === 'string') process.env.CRETLI_CLAUDE_AUTH_MODE = previousAuthMode;
  else delete process.env.CRETLI_CLAUDE_AUTH_MODE;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('claude-api-key.test.js OK');
