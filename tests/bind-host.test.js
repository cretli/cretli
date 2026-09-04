import assert from 'node:assert/strict';
import {
  DEFAULT_BIND_HOST,
  assertLanSetupGuard,
  isLanBindHost,
  resolveBindHost,
} from '../lib/bind-host.js';

assert.equal(DEFAULT_BIND_HOST, '127.0.0.1');

const previousBind = process.env.CRETLI_BIND;
const previousLegacy = process.env.CURSOR_REMOTE_BIND;
const previousBindHost = process.env.BIND_HOST;
delete process.env.CRETLI_BIND;
delete process.env.CURSOR_REMOTE_BIND;
delete process.env.BIND_HOST;

try {
  assert.equal(resolveBindHost(), '127.0.0.1');
  assert.equal(isLanBindHost(), false);
  assert.equal(isLanBindHost('127.0.0.1'), false);
  assert.equal(isLanBindHost('localhost'), false);
  assert.equal(isLanBindHost('::1'), false);
  assert.equal(isLanBindHost('0.0.0.0'), true);

  assert.equal(assertLanSetupGuard({
    authConfigured: false,
    setupToken: '',
    lanExposed: false,
  }).ok, true);
  assert.equal(assertLanSetupGuard({
    authConfigured: true,
    setupToken: '',
    lanExposed: true,
  }).ok, true);
  assert.equal(assertLanSetupGuard({
    authConfigured: false,
    setupToken: 'secret-token',
    lanExposed: true,
  }).ok, true);
  const blocked = assertLanSetupGuard({
    authConfigured: false,
    setupToken: '',
    lanExposed: true,
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /CRETLI_SETUP_TOKEN/);
} finally {
  if (typeof previousBind === 'string') process.env.CRETLI_BIND = previousBind;
  else delete process.env.CRETLI_BIND;
  if (typeof previousLegacy === 'string') process.env.CURSOR_REMOTE_BIND = previousLegacy;
  else delete process.env.CURSOR_REMOTE_BIND;
  if (typeof previousBindHost === 'string') process.env.BIND_HOST = previousBindHost;
  else delete process.env.BIND_HOST;
}

console.log('bind-host.test.js OK');
