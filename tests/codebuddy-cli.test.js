import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getCodeBuddyCliFromEnv,
  isCodeBuddyCliFound,
  resolveCodeBuddyCli,
  resolveCodeBuddyCliForSpawn,
  resolveCodeBuddyHomeDir,
  resolveCodeBuddyNodePath,
} from '../lib/codebuddy/codebuddy-cli.js';

const previous = process.env.CODEBUDDY_CODE_PATH;
delete process.env.CODEBUDDY_CODE_PATH;

try {
  const resolved = resolveCodeBuddyCli();
  assert.equal(typeof resolved, 'string');
  assert.ok(resolved.length > 0);
  assert.equal(typeof isCodeBuddyCliFound(), 'boolean');
  const home = resolveCodeBuddyHomeDir();
  assert.ok(home.includes('codebuddy-home'));
  const nodePath = resolveCodeBuddyNodePath();
  assert.equal(typeof nodePath, 'string');
  assert.ok(nodePath.length > 0);
  const launcher = resolveCodeBuddyCliForSpawn();
  if (isCodeBuddyCliFound()) {
    assert.ok(launcher.endsWith('codebuddy-launcher.sh'));
    assert.equal(fs.existsSync(launcher), true);
    const body = fs.readFileSync(launcher, 'utf8');
    assert.ok(body.includes(nodePath));
    assert.ok(body.includes(resolved));
  }
  process.env.CODEBUDDY_CODE_PATH = '/tmp/does-not-exist-codebuddy-bin';
  assert.equal(getCodeBuddyCliFromEnv(), '/tmp/does-not-exist-codebuddy-bin');
  assert.equal(resolveCodeBuddyCli(), '/tmp/does-not-exist-codebuddy-bin');
  assert.equal(isCodeBuddyCliFound(), false);
  assert.equal(resolveCodeBuddyCliForSpawn(), '/tmp/does-not-exist-codebuddy-bin');
} finally {
  if (typeof previous === 'string') process.env.CODEBUDDY_CODE_PATH = previous;
  else delete process.env.CODEBUDDY_CODE_PATH;
}

console.log('codebuddy-cli.test.js OK');
