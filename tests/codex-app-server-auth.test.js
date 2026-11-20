import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-dir.js';
import { CodexAppServer } from '../lib/codex/codex-app-server.ts';
import { isCodexCliFound, resolveCodexCli } from '../lib/codex/codex-cli.ts';

// No model request: the fake key tests only local CLI authentication state.
test('real CLI API-key login preserves the saved ChatGPT credential file', { skip: !isCodexCliFound(), timeout: 30000 }, async (t) => {
  const home = makeTempDir('cretli-codex-auth-');
  const authFile = path.join(home, 'auth.json');
  const original = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake-saved-token' } });
  fs.writeFileSync(authFile, original);
  const client = new CodexAppServer({
    cli: resolveCodexCli(),
    apiKey: 'fake-api-key',
    env: { ...process.env, CODEX_HOME: home },
  });
  t.after(() => client.close());
  await client.initialize({ workingDirectory: home, model: 'gpt-5.6-sol', approvalPolicy: 'never', sandboxMode: 'read-only' }, null);
  const result = await client.request('account/read', { refreshToken: false });
  assert.equal(result.account?.type, 'apiKey');
  assert.equal(fs.readFileSync(authFile, 'utf8'), original);
});
