import assert from 'node:assert/strict';
import {
  applyCodeBuddyTransportOptions,
  createCodeBuddyLiveSession,
  isCodeBuddyLiveSessionOpen,
} from '../lib/codebuddy/codebuddy-live-session.js';

const session = {
  closed: false,
  transport: {
    options: {
      model: 'default-model',
    },
  },
};

applyCodeBuddyTransportOptions(session, {
  cwd: '/tmp/workspace',
  permissionMode: 'bypassPermissions',
  settingSources: ['project'],
  includePartialMessages: true,
  executablePath: '/opt/codebuddy-launcher.sh',
});

assert.equal(session.transport.options.cwd, '/tmp/workspace');
assert.equal(session.transport.options.permissionMode, 'bypassPermissions');
assert.deepEqual(session.transport.options.settingSources, ['project']);
assert.equal(session.transport.options.includePartialMessages, true);
assert.equal(session.transport.options.executablePath, '/opt/codebuddy-launcher.sh');
assert.equal(isCodeBuddyLiveSessionOpen(session), true);
assert.equal(isCodeBuddyLiveSessionOpen({ closed: true }), false);
assert.equal(isCodeBuddyLiveSessionOpen(null), false);

assert.doesNotThrow(() => applyCodeBuddyTransportOptions({}, { cwd: '/tmp' }));

const created = createCodeBuddyLiveSession({
  sdk: {
    unstable_v2_createSession: (options) => {
      assert.equal(options.model, 'default-model');
      assert.equal(typeof options.canUseTool, 'function');
      return {
        closed: false,
        transport: { options: { model: options.model } },
      };
    },
  },
  model: 'default-model',
  pathToCodebuddyCode: '/opt/codebuddy-launcher.sh',
  env: { HOME: '/tmp' },
  cwd: '/tmp/workspace',
  permissionMode: 'bypassPermissions',
});
assert.equal(created.transport.options.cwd, '/tmp/workspace');
assert.equal(created.transport.options.permissionMode, 'bypassPermissions');

console.log('codebuddy-live-session.test.js OK');
