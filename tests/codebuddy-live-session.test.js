import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  applyCodeBuddyTransportOptions,
  createCodeBuddyLiveSession,
  installCodeBuddyMcpReadyGate,
  isCodeBuddyLiveSessionOpen,
} from '../lib/codebuddy/codebuddy-live-session.js';
import { toCodeBuddyMcpServers } from '../lib/mcp/mcp-vendor-map.js';
import { markMcpBridgeToolsListed, waitForMcpBridgeToolsListed } from '../lib/mcp/mcp-bridge-ready.js';

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

const planCreated = createCodeBuddyLiveSession({
  sdk: {
    unstable_v2_createSession: (options) => ({
      closed: false,
      transport: { options: { model: options.model } },
    }),
  },
  model: 'default-model',
  pathToCodebuddyCode: '/opt/codebuddy-launcher.sh',
  env: { HOME: '/tmp' },
  cwd: '/tmp/workspace',
  permissionMode: 'plan',
});
assert.equal(planCreated.transport.options.permissionMode, 'plan');

// Exercise the actual SDK permission callback with an absolute workspace test.
let reviewCanUseTool;
createCodeBuddyLiveSession({
  sdk: {
    unstable_v2_createSession: (options) => {
      reviewCanUseTool = options.canUseTool;
      return { transport: { options: {} } };
    },
  },
  model: 'default-model',
  pathToCodebuddyCode: '/opt/codebuddy-launcher.sh',
  env: {},
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  permissionMode: 'bypassPermissions',
  assignment: 'review',
});
const absoluteTest = fileURLToPath(new URL('./codebuddy-live-session.test.js', import.meta.url));
assert.equal((await reviewCanUseTool('Bash', { command: `node --test ${absoluteTest}` })).behavior, 'allow');
assert.equal((await reviewCanUseTool('Bash', { command: 'node --test /tmp/outside.test.js' })).behavior, 'deny');
assert.equal((await reviewCanUseTool('Bash', { command: 'node scripts/review-lint.js lib/codebuddy/codebuddy-live-session.js' })).behavior, 'allow');
assert.equal((await reviewCanUseTool('Bash', { command: 'node scripts/review-lint.js --fix lib/codebuddy/codebuddy-live-session.js' })).behavior, 'deny');
assert.equal((await reviewCanUseTool('Edit', { file_path: absoluteTest })).behavior, 'deny');

// The CLI drops every MCP server when one entry has no explicit transport type.
assert.deepEqual(
  toCodeBuddyMcpServers({
    cretli_bridge: { type: 'stdio', command: '/usr/bin/node', args: ['bridge.js'], env: { A: '1' } },
    untyped: { command: 'node', args: [] },
    remote: { url: 'https://example.com/mcp', headers: { 'x-key': 'v' } },
    broken: {},
  }),
  {
    cretli_bridge: { type: 'stdio', command: '/usr/bin/node', args: ['bridge.js'], env: { A: '1' } },
    untyped: { type: 'stdio', command: 'node', args: [], env: {} },
    remote: { type: 'http', url: 'https://example.com/mcp', headers: { 'x-key': 'v' } },
  },
);

/**
 * @returns {{ session: object, sent: object[], handled: object[] }}
 */
function createGateFixture() {
  /** @type {object[]} */
  const sent = [];
  /** @type {object[]} */
  const handled = [];
  const session = {
    closed: false,
    initialized: false,
    transport: {
      options: {},
      sendControlRequest: async (payload) => {
        sent.push(payload);
        return {};
      },
    },
    initialize: async () => {
      throw new Error('the stock initialize must be replaced');
    },
    handleControlRequest: async (request) => {
      handled.push(request);
    },
  };
  return { session, sent, handled };
}

const gate = createGateFixture();
let releaseGate = () => {};
let gateWaits = 0;
assert.equal(
  installCodeBuddyMcpReadyGate(gate.session, () => {
    gateWaits += 1;
    return new Promise((resolve) => {
      releaseGate = resolve;
    });
  }),
  true,
);
await gate.session.initialize();
await gate.session.initialize();
assert.equal(gate.sent.length, 1, 'initialize is sent once');
assert.equal(gate.sent[0].subtype, 'initialize');
const hookIds = gate.sent[0].hooks.UserPromptSubmit[0].hookCallbackIds;
assert.equal(hookIds.length, 1);
const hookRequest = { request_id: 'r1', request: { subtype: 'hook_callback', callback_id: hookIds[0] } };
const firstHook = gate.session.handleControlRequest(hookRequest);
await Promise.resolve();
assert.equal(gate.handled.length, 0, 'the first prompt is held until MCP is ready');
releaseGate();
await firstHook;
assert.equal(gate.handled.length, 1);
await gate.session.handleControlRequest(hookRequest);
assert.equal(gate.handled.length, 2);
assert.equal(gateWaits, 1, 'only the first prompt waits');
await gate.session.handleControlRequest({ request_id: 'r2', request: { subtype: 'can_use_tool' } });
assert.equal(gate.handled.length, 3, 'other control requests pass straight through');

const failingGate = createGateFixture();
installCodeBuddyMcpReadyGate(failingGate.session, async () => {
  throw new Error('bridge down');
});
await failingGate.session.handleControlRequest(hookRequest);
assert.equal(failingGate.handled.length, 1, 'a failed wait never blocks the prompt');

assert.equal(installCodeBuddyMcpReadyGate({ transport: { options: {} } }, async () => {}), false);
assert.equal(installCodeBuddyMcpReadyGate(createGateFixture().session, undefined), false);

const withoutMcp = createGateFixture();
createCodeBuddyLiveSession({
  sdk: { unstable_v2_createSession: () => withoutMcp.session },
  model: 'default-model',
  pathToCodebuddyCode: '/opt/codebuddy-launcher.sh',
  env: {},
  cwd: '/tmp/workspace',
  permissionMode: 'bypassPermissions',
  waitForMcpReady: async () => {},
});
await assert.rejects(() => withoutMcp.session.initialize(), /stock initialize/, 'no MCP servers, no gate');

assert.equal(await waitForMcpBridgeToolsListed('', { timeoutMs: 0 }), null);
assert.equal(await waitForMcpBridgeToolsListed('chat-a', { timeoutMs: 5 }), null);
const pendingReady = waitForMcpBridgeToolsListed('chat-a', { timeoutMs: 1000 });
markMcpBridgeToolsListed('chat-a', { now: 100, toolNames: ['todo_show'] });
assert.deepEqual(await pendingReady, { at: 100, toolNames: ['todo_show'] });
assert.deepEqual(await waitForMcpBridgeToolsListed('chat-a', { since: 100, timeoutMs: 0 }), { at: 100, toolNames: ['todo_show'] });
assert.equal(await waitForMcpBridgeToolsListed('chat-a', { since: 101, timeoutMs: 5 }), null, 'an older mark does not count');
assert.equal(await waitForMcpBridgeToolsListed('chat-b', { timeoutMs: 5 }), null, 'marks are per chat');

console.log('codebuddy-live-session.test.js OK');
