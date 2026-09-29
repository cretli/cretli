import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousAnthropic = process.env.ANTHROPIC_API_KEY;
const previousDataDir = process.env.CRETLI_DATA_DIR;
const previousClaudeConfig = process.env.CRETLI_CLAUDE_CONFIG_DIR;
const previousModel = process.env.ANTHROPIC_MODEL;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-api-key-'));
process.env.CRETLI_DATA_DIR = tempDir;
fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
  claudeApiKey: 'settings-claude-key',
  claudeAuthMode: 'api-key',
}));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_MODEL;

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
  assert.ok(String(env.CLAUDE_CONFIG_DIR || '').endsWith('claude-home'));
  assert.equal(env.CLAUDE_CONFIG_DIR, resolveClaudeHomeDir());
  // Options.env replaces the subprocess environment, so the inherited env must survive.
  assert.equal(env.PATH, process.env.PATH);

  delete process.env.ANTHROPIC_API_KEY;
  const settingsEnv = buildClaudeProcessEnv();
  assert.equal(settingsEnv.ANTHROPIC_API_KEY, 'settings-claude-key');
  assert.ok(fs.existsSync(ensureClaudeHomeDir()));
  assert.equal(isClaudeHarnessConfigured(), true);

  // Task 5: with no explicit setting, an env key picks API-key billing.
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    claudeApiKey: 'settings-claude-key',
  }));
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(normalizeClaudeAuthMode(undefined), 'subscription');
  assert.equal(normalizeClaudeAuthMode('api-key'), 'api-key');
  assert.equal(getClaudeAuthMode(), 'subscription');
  process.env.ANTHROPIC_API_KEY = 'env-only-key';
  assert.equal(getClaudeAuthMode(), 'api-key');
  const envOnlyEnv = buildClaudeProcessEnv();
  assert.equal(envOnlyEnv.ANTHROPIC_API_KEY, 'env-only-key');
  assert.equal(isClaudeHarnessConfigured(), true);
  // An explicit subscription setting still wins over the inherited env key.
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    claudeApiKey: 'settings-claude-key',
    claudeAuthMode: 'subscription',
  }));
  assert.equal(getClaudeAuthMode(), 'subscription');

  const planHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-plan-'));
  fs.writeFileSync(path.join(planHome, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'plan-token' },
  }));
  process.env.CRETLI_CLAUDE_CONFIG_DIR = planHome;
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    claudeApiKey: 'settings-claude-key',
    claudeAuthMode: 'subscription',
  }));
  process.env.ANTHROPIC_API_KEY = 'env-claude-key';
  const planEnv = buildClaudeProcessEnv();
  assert.equal(planEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(planEnv.CLAUDE_CONFIG_DIR, path.resolve(planHome));
  assert.equal(isClaudeHarnessConfigured(), true);
  delete process.env.CRETLI_CLAUDE_CONFIG_DIR;
  fs.rmSync(planHome, { recursive: true, force: true });
} finally {
  if (typeof previousAnthropic === 'string') process.env.ANTHROPIC_API_KEY = previousAnthropic;
  else delete process.env.ANTHROPIC_API_KEY;
  if (typeof previousModel === 'string') process.env.ANTHROPIC_MODEL = previousModel;
  else delete process.env.ANTHROPIC_MODEL;
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  if (typeof previousClaudeConfig === 'string') process.env.CRETLI_CLAUDE_CONFIG_DIR = previousClaudeConfig;
  else delete process.env.CRETLI_CLAUDE_CONFIG_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('claude-api-key.test.js OK');
