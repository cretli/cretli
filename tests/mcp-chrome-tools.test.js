import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'cretli-chrome-test-'));
process.env.CRETLI_DATA_DIR = temp;
const { createChromeToolExecutor, CHROME_MCP_TOOLS } = await import('../lib/mcp/builtin/chrome-tools.js');
const { createChromeAccessRegistry } = await import('../lib/browser/chrome-access.js');
const { rememberMcpExecutionContext, resetMcpExecutionRegistryForTests } = await import('../lib/mcp/mcp-execution-registry.js');
const { ChromeExtensionBridge, resolveChromeExtensionLaunch } = await import('../lib/browser/chrome-extension-bridge.js');
const { buildClaudeProcessEnv } = await import('../lib/claude/claude-api-key.ts');
const { CRETILI_MCP_TOOL_DEFS, createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');

after(() => rmSync(temp, { recursive: true, force: true }));

const session = { chatId: 'chat-1', sessionId: 'run-1', harness: 'codex', workspaceFolder: temp, mode: 'agent' };
const args = { tool: 'read_page', arguments: { tabId: 42 }, confirm: true };

function fixture(overrides = {}) {
  const calls = [];
  const execute = createChromeToolExecutor({
    loadChat: async () => ({ id: session.chatId, workspaceFolder: temp }),
    resolveOwner: () => 'user-1', ownerActive: () => true,
    allowsChrome: () => true, subscription: () => true,
    access: { get: () => null, request: async () => ({ decision: 'deny', ownerSessionId: '' }) },
    bridge: { async execute(context, tool, input, signal) {
      await context.authorize();
      calls.push({ context, tool, input, signal });
      return tool ? { content: [{ type: 'text', text: 'page' }], isError: false } : { tools: [{ name: 'read_page' }] };
    } },
    ...overrides,
  });
  return { execute, calls };
}

test('both tools are in the shared catalog and blocked in Plan/Ask', async () => {
  for (const tool of CHROME_MCP_TOOLS) {
    assert.ok(CRETILI_MCP_TOOL_DEFS.some((row) => row.name === tool.name));
    assert.equal(tool.readOnly, false);
    for (const mode of ['plan', 'ask', '']) {
      const result = await createCretliMcpToolHandlers({}, { ...session, mode })[tool.name](args);
      assert.equal(result.structuredContent.code, 'PLAN_MODE_DENIED');
    }
  }
});

test('every harness gets upstream schemas and calls with unchanged arguments', async () => {
  for (const harness of ['codex', 'cursor', 'openrouter', 'opencode', 'claude', 'qwen', 'deepseek', 'codebuddy', 'mistral']) {
    const { execute, calls } = fixture();
    const context = { ...session, harness };
    const tools = await execute('chrome_tools', {}, context);
    assert.equal(tools.structuredContent.tools[0].name, 'read_page');
    assert.equal((await execute('chrome_call', args, context)).content[0].text, 'page');
    assert.equal(calls[1].context.harness, harness);
    assert.deepEqual(calls[1].input, { tabId: 42 });
  }
});

test('workspace consent, login and live owner are required before connecting', async () => {
  for (const overrides of [
    { allowsChrome: () => false }, { resolveOwner: () => '' }, { ownerActive: () => false },
    { loadChat: async () => null }, { loadChat: async () => ({ workspaceFolder: '/another-workspace' }) },
  ]) {
    const { execute, calls } = fixture(overrides);
    await assert.rejects(execute('chrome_tools', {}, session), { code: 'OUT_OF_SCOPE' });
    assert.equal(calls.length, 0);
  }
  await assert.rejects(fixture({ subscription: () => false }).execute('chrome_tools', {}, session), { code: 'HARNESS_UNAVAILABLE' });
});

test('Chrome uses subscription credentials while chat billing stays on API', async () => {
  const changes = {
    CRETLI_CLAUDE_AUTH_MODE: 'api-key',
    CRETLI_CLAUDE_CONFIG_DIR: path.join(temp, 'subscription'),
    CLAUDE_CONFIG_DIR: path.join(temp, 'api-config'),
    ANTHROPIC_API_KEY: 'test-api-key',
    ANTHROPIC_AUTH_TOKEN: 'test-provider-token',
    ANTHROPIC_BASE_URL: 'https://example.com',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CHROME_PERMISSION_MODE: 'bypassPermissions',
  };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  mkdirSync(changes.CRETLI_CLAUDE_CONFIG_DIR);
  writeFileSync(path.join(changes.CRETLI_CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'test-subscription-token' },
  }));
  try {
    Object.assign(process.env, changes);
    const { execute, calls } = fixture({ subscription: undefined });
    await execute('chrome_tools', {}, session);
    await execute('chrome_call', args, session);
    assert.equal(calls.length, 2);
    const { env, args: launchArgs } = resolveChromeExtensionLaunch();
    assert.deepEqual(launchArgs, ['--claude-in-chrome-mcp']);
    assert.equal(env.CLAUDE_CONFIG_DIR, changes.CRETLI_CLAUDE_CONFIG_DIR);
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CHROME_PERMISSION_MODE']) {
      assert.equal(env[key], undefined, key);
    }
    assert.equal(process.env.CRETLI_CLAUDE_AUTH_MODE, 'api-key');
    assert.notEqual(buildClaudeProcessEnv().CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR);
    assert.equal(buildClaudeProcessEnv().CLAUDE_CODE_USE_BEDROCK, '1');

    rmSync(path.join(changes.CRETLI_CLAUDE_CONFIG_DIR, '.credentials.json'));
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    await execute('chrome_tools', {}, session);
    assert.equal(resolveChromeExtensionLaunch().env.CLAUDE_CODE_OAUTH_TOKEN, 'test-oauth-token');
    assert.equal(buildClaudeProcessEnv().CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('policy scope follows the workspace id, never a neighboring folder', async () => {
  let key;
  const { execute } = fixture({ allowsChrome: (value) => { key = value; return true; } });
  await execute('chrome_tools', {}, { ...session, workspaceFile: 'cretli:ws:example' });
  assert.equal(key, 'cretli:ws:example');
});

test('delegations, review and Watcher cannot connect even in Agent mode', async () => {
  for (const fields of [
    { delegationId: 'd' }, { delegationAssignment: 'review' },
    { delegationParentChatId: 'parent' }, { pickPurpose: 'watcher-orchestrator' },
  ]) {
    const { execute, calls } = fixture({ loadChat: async () => ({ workspaceFolder: temp, ...fields }) });
    await assert.rejects(execute('chrome_tools', {}, session), { code: 'OUT_OF_SCOPE' });
    assert.equal(calls.length, 0);
  }
  const { execute } = fixture();
  await assert.rejects(execute('chrome_tools', {}, { ...session, delegationId: 'd' }), { code: 'OUT_OF_SCOPE' });
  await assert.rejects(execute('chrome_tools', {}, { ...session, delegationAssignment: 'review' }), { code: 'OUT_OF_SCOPE' });
});

test('live mode and consent are rechecked after bridge startup', async () => {
  for (const invalidate of ['mode', 'consent', 'owner']) {
    let started = false;
    const { execute } = fixture({
      allowsChrome: () => !(started && invalidate === 'consent'),
      resolveOwner: () => started && invalidate === 'owner' ? 'user-2' : 'user-1',
      bridge: { async execute(context) { started = true; await context.authorize(); assert.fail('action must stay blocked'); } },
    });
    const current = { ...session, getMode: () => started && invalidate === 'mode' ? 'plan' : 'agent' };
    await assert.rejects(execute('chrome_call', args, current), { code: invalidate === 'mode' ? 'PLAN_MODE_DENIED' : 'OUT_OF_SCOPE' });
  }
  await assert.rejects(fixture().execute('chrome_tools', {}, { ...session, getMode: () => '' }), { code: 'PLAN_MODE_DENIED' });
});

test('global approval resumes a Chrome call without a chat socket and survives disconnects', async () => {
  const access = createChromeAccessRegistry({ onChange: () => {} });
  rememberMcpExecutionContext({ ...session, runId: 'round-1', attemptId: '', delegationId: '' });
  let loggedIn = true;
  const { execute, calls } = fixture({ access, resolveOwner: () => '', allowsChrome: () => false,
    ownerActive: (owner) => loggedIn && owner === 'approving-user' });
  try {
    const result = execute('chrome_tools', {}, session);
    await new Promise(setImmediate);
    const [prompt] = access.list();
    assert.equal(prompt.chatId, session.chatId);
    assert.equal(calls.length, 0);
    assert.deepEqual(access.resolve(prompt.id, 'allow', session.chatId, 'approving-user'), { ok: true });
    assert.equal((await result).structuredContent.tools[0].name, 'read_page');
    await execute('chrome_call', args, session);
    assert.equal(calls[1].context.ownerSessionId, 'approving-user');
    assert.equal(access.list().length, 0);
    loggedIn = false;
    await assert.rejects(execute('chrome_call', args, session), /login authorizing Chrome access ended/);
    assert.equal(calls.length, 2);
  } finally { resetMcpExecutionRegistryForTests(); }
});

test('an approval cannot move to another run and a refusal never reaches Chrome', async () => {
  const access = createChromeAccessRegistry({ onChange: () => {} });
  const remember = (runId) => rememberMcpExecutionContext({ ...session, runId, attemptId: '', delegationId: '' });
  remember('round-1');
  const { execute, calls } = fixture({ access, resolveOwner: () => '' });
  try {
    const first = assert.rejects(execute('chrome_tools', {}, session), /expired|run changed/);
    await new Promise(setImmediate);
    const [old] = access.list();
    remember('round-2');
    assert.equal(access.resolve(old.id, 'allow', session.chatId, 'user-1').code, 'not-found');
    await first;
    const next = assert.rejects(execute('chrome_tools', {}, session), /browser-access-deny/);
    await new Promise(setImmediate);
    const [prompt] = access.list();
    assert.notEqual(prompt.id, old.id);
    access.resolve(prompt.id, 'deny', session.chatId, 'user-1');
    await next;
    await assert.rejects(execute('chrome_tools', {}, session), /browser-access-deny/);
    assert.equal(access.list().length, 0);
    assert.equal(calls.length, 0);
  } finally { resetMcpExecutionRegistryForTests(); }
});

test('approval rechecks live mode and delegated/widget chats cannot request access', async () => {
  const access = createChromeAccessRegistry({ onChange: () => {} });
  let mode = 'agent';
  rememberMcpExecutionContext({ ...session, runId: 'round-1', attemptId: '', delegationId: '' }, { getMode: () => mode });
  try {
    const { execute, calls } = fixture({ access, resolveOwner: () => '' });
    const waiting = assert.rejects(execute('chrome_tools', {}, session), { code: 'PLAN_MODE_DENIED' });
    await new Promise(setImmediate);
    mode = 'plan';
    access.resolve(access.list()[0].id, 'allow', session.chatId, 'user-1');
    await waiting;
    assert.equal(calls.length, 0);
    mode = 'agent';
    for (const fields of [{ widgetInstallationId: 'widget' }, { delegationParentChatId: 'parent' }]) {
      const blocked = fixture({ access, resolveOwner: () => '', loadChat: async () => ({ workspaceFolder: temp, ...fields }) });
      await assert.rejects(blocked.execute('chrome_tools', {}, session), { code: 'OUT_OF_SCOPE' });
      assert.equal(blocked.calls.length, 0);
    }
  } finally { resetMcpExecutionRegistryForTests(); }
});

test('an unanswered request stays global after the short tool wait and can be approved before retry', async () => {
  const access = createChromeAccessRegistry({ waitMs: 1, onChange: () => {} });
  rememberMcpExecutionContext({ ...session, runId: 'round-1', attemptId: '', delegationId: '' });
  try {
    const { execute, calls } = fixture({ access, resolveOwner: () => '' });
    const waiting = assert.rejects(execute('chrome_tools', {}, session), /browser-access-pending/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await waiting;
    assert.equal(calls.length, 0);
    access.resolve(access.list()[0].id, 'allow', session.chatId, 'user-1');
    await execute('chrome_call', args, session);
    assert.equal(calls.length, 1);
  } finally { resetMcpExecutionRegistryForTests(); }
});

test('calls require acknowledgment and an object payload', async () => {
  for (const input of [{ ...args, confirm: false }, { ...args, tool: '' }, { ...args, tool: 42 },
    { ...args, arguments: [] }, { ...args, arguments: null }, { ...args, arguments: undefined }, { ...args, arguments: 'text' }]) {
    const { execute, calls } = fixture();
    await assert.rejects(execute('chrome_call', input, session), { code: 'VALIDATION_ERROR' });
    assert.equal(calls.length, 0);
  }
});

test('upstream errors survive and images also get a local path for text-only harnesses', async () => {
  const image = { type: 'image', mimeType: 'image/png', data: Buffer.from('image').toString('base64') };
  const { execute } = fixture({
    bridge: { async execute() { return { content: [{ type: 'text', text: 'extension error' }, image], isError: true }; } },
    saveImage(chatId, frame) {
      assert.equal(chatId, session.chatId); assert.equal(Buffer.from(frame.data, 'base64').toString(), 'image'); assert.equal(frame.mimeType, 'image/png');
      return { path: '/tmp/chrome.png' };
    },
  });
  const result = await execute('chrome_call', args, session);
  assert.equal(result.isError, true);
  assert.equal(result.content[1].text, 'Chrome image: /tmp/chrome.png');
  assert.deepEqual(result.content[2], image);
});

const mockLaunch = () => ({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/chrome-extension-mcp.mjs', import.meta.url))], env: {} });
const connectionContext = { ...session, ownerSessionId: 'user-1', authorize: async () => {} };
const body = (result) => JSON.parse(result.content[0].text);

test('real stdio bridge reuses a connection and isolates chats, owners and workspaces', async () => {
  const bridge = new ChromeExtensionBridge({ launch: mockLaunch });
  try {
    const { tools } = await bridge.execute(connectionContext, '');
    assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'slow', 'fail']);
    const one = body(await bridge.execute(connectionContext, 'echo', { tabId: 42 }));
    assert.deepEqual(one.args, { tabId: 42 });
    assert.equal(body(await bridge.execute(connectionContext, 'echo')).pid, one.pid);
    for (const changed of [{ chatId: 'chat-2' }, { harness: 'qwen' }, { ownerSessionId: 'user-2' }, { workspaceFile: 'cretli:ws:other' }]) {
      assert.notEqual(body(await bridge.execute({ ...connectionContext, ...changed }, 'echo')).pid, one.pid);
    }
    await bridge.closeSession(session.sessionId);
    assert.equal(bridge.entries.size, 0);
  } finally { await bridge.closeAll(); }
});

test('concurrent startup is shared; invalid tools and cancellation close without replay', async () => {
  const bridge = new ChromeExtensionBridge({ launch: mockLaunch });
  try {
    const results = await Promise.all([bridge.execute(connectionContext, 'echo'), bridge.execute(connectionContext, 'echo')]);
    assert.equal(body(results[0]).pid, body(results[1]).pid);
    await assert.rejects(bridge.execute(connectionContext, 'unknown'), /Unknown Chrome/);
    assert.equal(bridge.entries.size, 0);
    await assert.rejects(bridge.execute(connectionContext, 'fail'), /upstream failure/);
    assert.equal(bridge.entries.size, 0);
    await bridge.execute(connectionContext, 'echo');
    const abort = new AbortController();
    const pending = bridge.execute(connectionContext, 'slow', {}, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(pending);
    assert.equal(bridge.entries.size, 0);
  } finally { await bridge.closeAll(); }
});

test('idle connections expire, while an active action keeps its connection', async () => {
  const bridge = new ChromeExtensionBridge({ launch: mockLaunch, idleMs: 20 });
  try {
    await bridge.execute(connectionContext, 'echo');
    await bridge.execute(connectionContext, 'slow');
    assert.equal(bridge.entries.size, 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(bridge.entries.size, 0);
  } finally { await bridge.closeAll(); }
});

test('harness session teardown and server shutdown also close extension children', async () => {
  const { chromeExtensionBridge } = await import('../lib/browser/chrome-extension-bridge.js');
  const { disposeSessionConnections, disposeAllConnections } = await import('../lib/mcp/mcp-runtime.js');
  const originalLaunch = chromeExtensionBridge.launch;
  chromeExtensionBridge.launch = mockLaunch;
  try {
    await chromeExtensionBridge.execute(connectionContext, 'echo');
    assert.equal(await disposeSessionConnections(session.sessionId), 1);
    assert.equal(chromeExtensionBridge.entries.size, 0);
    await chromeExtensionBridge.execute(connectionContext, 'echo');
    assert.equal(await disposeAllConnections(), 1);
    assert.equal(chromeExtensionBridge.entries.size, 0);
  } finally {
    await chromeExtensionBridge.closeAll();
    chromeExtensionBridge.launch = originalLaunch;
  }
});
