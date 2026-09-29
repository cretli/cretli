import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousDataDir = process.env.CRETLI_DATA_DIR;
const previousAnthropic = process.env.ANTHROPIC_API_KEY;
const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const previousOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const previousClaudeConfig = process.env.CRETLI_CLAUDE_CONFIG_DIR;
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-subscription-'));
process.env.CRETLI_DATA_DIR = tempDir;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.CRETLI_CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_CONFIG_DIR;

const subscriptionModule = await import('../lib/claude/claude-subscription.js');
const {
  CLAUDE_KEYCHAIN_SERVICE,
  getClaudeOauthTokenFromEnv,
  hasClaudeAiOauth,
  hasClaudeSubscriptionAuth,
  hasClaudeKeychainCredentials,
  resolveClaudeSubscriptionConfigDir,
} = subscriptionModule;
const {
  buildClaudeProcessEnv,
  ensureClaudeHomeDir,
  isClaudeHarnessConfigured,
  resolveClaudeHomeDir,
} = await import('../lib/claude/claude-api-key.js');

/** @param {string} mode */
function writeSettings(mode) {
  fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
    claudeApiKey: 'settings-claude-key',
    claudeAuthMode: mode,
  }));
}

/** @param {string} dir */
function writeOauthCredentials(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'plan-access-token', refreshToken: 'plan-refresh-token' },
  }));
}

try {
  // Task B: Cretli no longer refreshes the plan token itself.
  assert.equal('refreshClaudeSubscriptionIfNeeded' in subscriptionModule, false);

  writeSettings('subscription');

  // --- Task C: CLAUDE_CODE_OAUTH_TOKEN is the recommended plan path ---
  assert.equal(getClaudeOauthTokenFromEnv(), '');
  process.env.CLAUDE_CODE_OAUTH_TOKEN = '  setup-token-value  ';
  assert.equal(getClaudeOauthTokenFromEnv(), 'setup-token-value');
  assert.equal(hasClaudeSubscriptionAuth(), true);
  assert.equal(isClaudeHarnessConfigured(), true);

  const oauthEnv = buildClaudeProcessEnv();
  assert.equal(oauthEnv.CLAUDE_CODE_OAUTH_TOKEN, '  setup-token-value  ');
  assert.equal(oauthEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(oauthEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(oauthEnv.CLAUDE_CONFIG_DIR, resolveClaudeHomeDir());

  // Without any credential source the plan is not configured.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.equal(hasClaudeSubscriptionAuth(), false);
  assert.equal(isClaudeHarnessConfigured(), false);
  assert.equal(resolveClaudeSubscriptionConfigDir(), '');

  // A credentials file also counts and drives CLAUDE_CONFIG_DIR.
  const planDir = path.join(tempDir, 'claude-home');
  writeOauthCredentials(planDir);
  assert.equal(hasClaudeAiOauth(planDir), true);
  assert.equal(resolveClaudeSubscriptionConfigDir(), path.resolve(planDir));
  assert.equal(hasClaudeSubscriptionAuth(), true);
  assert.equal(isClaudeHarnessConfigured(), true);
  const fileEnv = buildClaudeProcessEnv();
  assert.equal(fileEnv.CLAUDE_CONFIG_DIR, path.resolve(planDir));
  fs.rmSync(planDir, { recursive: true, force: true });

  // --- Task D: macOS Keychain detection (no secret is ever read) ---
  let execCalls = [];
  const execOk = (/** @type {string} */ bin, /** @type {string[]} */ args) => {
    execCalls.push({ bin, args });
    return Buffer.from('');
  };
  const execFail = () => {
    throw new Error('item not found');
  };

  assert.equal(hasClaudeKeychainCredentials({ platform: 'linux', exec: execOk }), false);
  assert.equal(execCalls.length, 0);
  assert.equal(hasClaudeKeychainCredentials({ platform: 'darwin', exec: execFail }), false);
  assert.equal(hasClaudeKeychainCredentials({ platform: 'darwin', exec: execOk }), true);
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].bin, 'security');
  assert.deepEqual(execCalls[0].args.slice(0, 2), ['find-generic-password', '-s']);
  assert.equal(execCalls[0].args[2], CLAUDE_KEYCHAIN_SERVICE);
  assert.equal(execCalls[0].args.includes('-w'), false);
  assert.equal(execCalls[0].args.includes('-g'), false);

  // Keychain-only machine: config true, but CLAUDE_CONFIG_DIR must not be
  // overridden to the isolated dir (that would hide the Keychain entry).
  assert.equal(isClaudeHarnessConfigured({ platform: 'darwin', exec: execOk }), true);
  assert.equal(isClaudeHarnessConfigured({ platform: 'darwin', exec: execFail }), false);
  const keychainEnv = buildClaudeProcessEnv({ platform: 'darwin', exec: execOk });
  assert.equal(keychainEnv.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(keychainEnv.ANTHROPIC_API_KEY, undefined);

  // --- API-key mode must not bill the plan ---
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-plan-token';
  delete process.env.ANTHROPIC_API_KEY;
  writeSettings('api-key');
  const apiEnv = buildClaudeProcessEnv();
  assert.equal(apiEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(apiEnv.ANTHROPIC_API_KEY, 'settings-claude-key');
  assert.equal(apiEnv.CLAUDE_CONFIG_DIR, ensureClaudeHomeDir());
} finally {
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  if (typeof previousAnthropic === 'string') process.env.ANTHROPIC_API_KEY = previousAnthropic;
  else delete process.env.ANTHROPIC_API_KEY;
  if (typeof previousAuthToken === 'string') process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
  else delete process.env.ANTHROPIC_AUTH_TOKEN;
  if (typeof previousOauth === 'string') process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOauth;
  else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof previousClaudeConfig === 'string') process.env.CRETLI_CLAUDE_CONFIG_DIR = previousClaudeConfig;
  else delete process.env.CRETLI_CLAUDE_CONFIG_DIR;
  if (typeof previousConfigDir === 'string') process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  else delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('claude-subscription.test.js OK');
