import assert from 'node:assert/strict';
import { buildInteractivePtyEnv } from '../lib/pty-env.js';

const actualEnv = buildInteractivePtyEnv({
  localRuntimeHome: '/tmp/cretli-home',
  overrides: { HOME: '/tmp/cretli-home' },
});
assert.equal(actualEnv.TERM, 'xterm-256color');
assert.equal(actualEnv.FORCE_COLOR, '1');
assert.equal(actualEnv.NO_COLOR, undefined);
assert.ok(String(actualEnv.PM2_HOME).includes('.pm2-uid-'));
console.log('pty-env.test.js OK');
