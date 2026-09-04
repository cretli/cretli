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
