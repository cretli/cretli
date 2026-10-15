import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.CRETLI_DATA_DIR = '/tmp/cretli-codex-thread-options-test';
process.env.CODEX_API_KEY = 'codex-options-test-key';
process.env.OPENAI_API_KEY = 'openai-should-not-leak';
delete process.env.CODEX_BIN;

const dataDir = process.env.CRETLI_DATA_DIR;
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'config.json'),
  JSON.stringify({ codexAuthMode: 'api-key' }),
);

const { buildCodexClientOptions } = await import('../lib/codex/codex-thread-options.js');

const actualOptions = buildCodexClientOptions({
  cwd: '/tmp/codex-workspace',
  model: 'gpt-5.6-terra',
  sdkMode: 'plan',
});

assert.equal(actualOptions.apiKey, 'codex-options-test-key');
assert.equal(actualOptions.env.CODEX_API_KEY, 'codex-options-test-key');
assert.ok(String(actualOptions.env.CODEX_HOME).includes('codex-home'));
assert.equal(actualOptions.threadOptions.workingDirectory, '/tmp/codex-workspace');
assert.equal(actualOptions.threadOptions.skipGitRepoCheck, true);
assert.equal(actualOptions.threadOptions.model, 'gpt-5.6-terra');
assert.equal(actualOptions.threadOptions.modelReasoningEffort, undefined);
assert.equal(actualOptions.threadOptions.sandboxMode, 'danger-full-access');
assert.equal(actualOptions.threadOptions.approvalPolicy, 'never');

const lunaHighOptions = buildCodexClientOptions({
  cwd: '/tmp/codex-workspace',
  model: 'gpt-5.6-luna::effort=high',
});
assert.equal(lunaHighOptions.threadOptions.model, 'gpt-5.6-luna');
assert.equal(lunaHighOptions.threadOptions.modelReasoningEffort, 'high');

const agentOptions = buildCodexClientOptions({
  cwd: '/tmp/codex-workspace',
  sdkMode: 'agent',
});
assert.equal(agentOptions.threadOptions.sandboxMode, 'danger-full-access');
assert.equal(agentOptions.threadOptions.model, 'gpt-5.6-sol');

// Review delegations and Scout scans get the read-only sandbox: it is the hard
// write block that certifies Codex reviews.
const reviewOptions = buildCodexClientOptions({
  cwd: '/tmp/codex-workspace',
  sdkMode: 'agent',
  reviewReadOnly: true,
});
assert.equal(reviewOptions.threadOptions.sandboxMode, 'read-only');
assert.equal(reviewOptions.threadOptions.approvalPolicy, 'never');
const scoutOptions = buildCodexClientOptions({
  cwd: '/tmp/codex-workspace',
  scoutReadOnly: true,
});
assert.equal(scoutOptions.threadOptions.sandboxMode, 'read-only');
const implementOptions = buildCodexClientOptions({
  cwd: '/tmp/codex-workspace',
  sdkMode: 'agent',
  reviewReadOnly: false,
});
assert.equal(implementOptions.threadOptions.sandboxMode, 'danger-full-access');
process.env.CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX = '0';
const noSandboxReview = buildCodexClientOptions({ cwd: '/tmp/codex-workspace', reviewReadOnly: true });
assert.equal(noSandboxReview.threadOptions.sandboxMode, 'danger-full-access', 'kill switch restores the old mode');
const noSandboxScout = buildCodexClientOptions({ cwd: '/tmp/codex-workspace', scoutReadOnly: true });
assert.equal(noSandboxScout.threadOptions.sandboxMode, 'read-only', 'Scout stays read-only regardless');
delete process.env.CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX;

fs.writeFileSync(
  path.join(dataDir, 'config.json'),
  JSON.stringify({ codexAuthMode: 'chatgpt' }),
);
const chatgptOptions = buildCodexClientOptions({
  cwd: '/tmp/codex-workspace',
});
assert.equal(chatgptOptions.apiKey, undefined);
assert.equal(chatgptOptions.env.CODEX_API_KEY, undefined);
assert.equal(chatgptOptions.env.OPENAI_API_KEY, undefined);
const homeConfig = path.join(String(chatgptOptions.env.CODEX_HOME), 'config.toml');
assert.equal(fs.existsSync(homeConfig), true);
assert.match(fs.readFileSync(homeConfig, 'utf8'), /cli_auth_credentials_store\s*=\s*"file"/);

console.log('codex-thread-options.test.js OK');
