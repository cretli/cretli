import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const envKeys = [
  'CRETLI_DATA_DIR',
  'CRETLI_CLAUDE_AUTH_MODE',
  'CRETLI_CLAUDE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
];
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-plan-auth-'));
const credentialsDir = path.join(tempDir, 'signed-in-claude');
process.env.CRETLI_DATA_DIR = path.join(tempDir, 'data');
process.env.CRETLI_CLAUDE_CONFIG_DIR = credentialsDir;
process.env.CRETLI_CLAUDE_AUTH_MODE = 'subscription';
process.env.CLAUDE_CODE_USE_BEDROCK = '1';
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

const { buildClaudeProcessEnv, isClaudeHarnessConfigured } = await import('../lib/claude/claude-api-key.js');
const { getClaudeAuthMode } = await import('../lib/claude/claude-auth-mode.js');
const { hasClaudeSubscriptionAuth } = await import('../lib/claude/claude-subscription.js');

try {
  assert.equal(getClaudeAuthMode(), 'subscription');
  assert.equal(isClaudeHarnessConfigured(), false, 'subscription mode requires a local login');
  assert.equal(hasClaudeSubscriptionAuth(), false);
  assert.equal(buildClaudeProcessEnv().CLAUDE_CODE_USE_BEDROCK, undefined);

  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'test-access-token', refreshToken: 'test-refresh-token' },
  }));
  assert.equal(hasClaudeSubscriptionAuth(), true);
  assert.equal(isClaudeHarnessConfigured(), true);
  const planEnv = buildClaudeProcessEnv();
  assert.equal(planEnv.CLAUDE_CONFIG_DIR, credentialsDir);
  assert.equal(planEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(planEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);

  fs.rmSync(path.join(credentialsDir, '.credentials.json'));
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-setup-token';
  assert.equal(isClaudeHarnessConfigured(), true);
  assert.equal(buildClaudeProcessEnv().CLAUDE_CODE_OAUTH_TOKEN, 'test-setup-token');

  process.env.CRETLI_CLAUDE_AUTH_MODE = 'api-key';
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  assert.equal(getClaudeAuthMode(), 'api-key');
  const keyEnv = buildClaudeProcessEnv();
  assert.equal(keyEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(keyEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(isClaudeHarnessConfigured(), false);
} finally {
  for (const key of envKeys) {
    if (typeof previous[key] === 'string') process.env[key] = previous[key];
    else delete process.env[key];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('claude-coding-plan-auth.test.js OK');
