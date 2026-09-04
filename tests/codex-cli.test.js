import assert from 'node:assert/strict';
import {
  getCodexCliFromEnv,
  getCodexCliMissingHint,
  getCodexPlatformPackageName,
  isCodexCliFound,
  isCodexNativeMissingOutput,
  resolveCodexCli,
} from '../lib/codex/codex-cli.js';
import { resolveCodexHomeDir } from '../lib/codex/codex-home.js';

assert.equal(getCodexPlatformPackageName('linux', 'x64'), '@openai/codex-linux-x64');
assert.equal(getCodexPlatformPackageName('linux', 'arm64'), '@openai/codex-linux-arm64');
assert.equal(getCodexPlatformPackageName('android', 'arm64'), '@openai/codex-linux-arm64');
assert.equal(getCodexPlatformPackageName('android', 'x64'), '@openai/codex-linux-x64');
assert.equal(getCodexPlatformPackageName('darwin', 'arm64'), '@openai/codex-darwin-arm64');
assert.equal(getCodexPlatformPackageName('win32', 'x64'), '@openai/codex-win32-x64');
assert.equal(getCodexPlatformPackageName('freebsd', 'x64'), '');

const androidHint = getCodexCliMissingHint('android', 'arm64');
assert.match(androidHint, /@openai\/codex-linux-arm64/);
assert.match(androidHint, /--force/);
assert.match(androidHint, /Termux|Android/i);

const termuxLinuxHint = getCodexCliMissingHint('linux', 'arm64', {
  PREFIX: '/data/data/com.termux/files/usr',
});
assert.match(termuxLinuxHint, /--force/);

const linuxHint = getCodexCliMissingHint('linux', 'x64', {});
assert.match(linuxHint, /@openai\/codex-linux-x64/);
assert.equal(/--force/.test(linuxHint), false);

const nativeMissingStack = `
Error: Missing optional dependency @openai/codex-linux-arm64. Reinstall Codex: npm install -g @openai/codex@latest
    at findCodexExecutable (file:///data/data/com.termux/files/home/projects/cretli/node_modules/@openai/codex/bin/codex.js:105:9)
    at file:///data/data/com.termux/files/home/projects/cretli/node_modules/@openai/codex/bin/codex.js:110:20
    at ModuleJob.run (node:internal/modules/esm/module_job:447:25)
`;
assert.equal(isCodexNativeMissingOutput(nativeMissingStack), true);
assert.equal(isCodexNativeMissingOutput('device code ABCD-EFGHI'), false);

const previous = process.env.CODEX_BIN;
delete process.env.CODEX_BIN;

try {
  const resolved = resolveCodexCli();
  assert.equal(typeof resolved, 'string');
  assert.ok(resolved.length > 0);
  assert.equal(typeof isCodexCliFound(), 'boolean');
  const home = resolveCodexHomeDir();
  assert.ok(home.includes('codex-home'));
  process.env.CODEX_BIN = '/tmp/does-not-exist-codex-bin';
  assert.equal(getCodexCliFromEnv(), '/tmp/does-not-exist-codex-bin');
  assert.equal(resolveCodexCli(), '/tmp/does-not-exist-codex-bin');
  assert.equal(isCodexCliFound(), false);
} finally {
  if (typeof previous === 'string') process.env.CODEX_BIN = previous;
  else delete process.env.CODEX_BIN;
}

console.log('codex-cli.test.js OK');
