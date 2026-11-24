import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createChromeExtToolExecutor, CHROME_EXT_MCP_TOOLS } from '../lib/mcp/builtin/chrome-ext-tools.js';
import { CRETILI_MCP_TOOL_DEFS, createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { createFixture, openShopTab, OWNER } from './helpers/chrome-ext-fixture.js';

const folder = '/work/acme';
const session = { chatId: 'chat-1', sessionId: 'run-1', harness: 'codex', workspaceFolder: folder, mode: 'agent' };
const NAMES = ['chrome_ext_status', 'chrome_ext_open', 'chrome_ext_docs', 'chrome_ext_fetch'];

function fixture(overrides = {}) {
  const calls = [];
  const execute = createChromeExtToolExecutor({
    loadChat: async () => ({ id: session.chatId, workspaceFolder: folder }),
    resolveOwner: () => 'user-1', ownerActive: () => true, allowsExtension: () => true,
    bridge: {
      status: (owner) => { calls.push({ status: owner }); return { paired: true, connected: true, killed: false, allowedDomains: [], pendingDomains: [] }; },
      async execute(context, name, args) {
        await context.authorize();
        calls.push({ context, name, args });
        return { ok: true, data: { echoed: name } };
      },
    },
    ...overrides,
  });
  return { execute, calls };
}

test('all four tools are in the shared catalog and blocked in Plan/Ask', async () => {
  assert.deepEqual(CHROME_EXT_MCP_TOOLS.map((t) => t.name), NAMES);
  for (const tool of CHROME_EXT_MCP_TOOLS) {
    assert.ok(CRETILI_MCP_TOOL_DEFS.some((row) => row.name === tool.name));
    assert.equal(tool.inputSchema.type, 'object');
    for (const mode of ['plan', 'ask', '']) {
      const result = await createCretliMcpToolHandlers({}, { ...session, mode })[tool.name]({});
      assert.equal(result.structuredContent.code, 'PLAN_MODE_DENIED', `${tool.name}/${mode}`);
    }
  }
});

test('every gate applies to every tool, including status', async () => {
  for (const name of NAMES) {
    for (const overrides of [
      { allowsExtension: () => false }, { resolveOwner: () => '' }, { ownerActive: () => false },
      { loadChat: async () => null }, { loadChat: async () => ({ workspaceFolder: '/another' }) },
    ]) {
      const { execute, calls } = fixture(overrides);
      await assert.rejects(execute(name, { confirm: true, url: 'https://a.example.com', tabId: 1, items: [] }, session), { code: 'OUT_OF_SCOPE' }, name);
      assert.equal(calls.length, 0);
    }
    await assert.rejects(fixture().execute(name, {}, { ...session, getMode: () => 'plan' }), { code: 'PLAN_MODE_DENIED' });
    for (const fields of [{ delegationId: 'd' }, { delegationAssignment: 'review' }, { pickPurpose: 'scout' }, { pickPurpose: 'watcher-orchestrator' }]) {
      const { execute, calls } = fixture({ loadChat: async () => ({ workspaceFolder: folder, ...fields }) });
      await assert.rejects(execute(name, {}, session), { code: 'OUT_OF_SCOPE' });
      assert.equal(calls.length, 0);
    }
    await assert.rejects(fixture().execute(name, {}, { ...session, delegationId: 'd' }), { code: 'OUT_OF_SCOPE' });
  }
});

test('the policy key is checked for the workspace scope', async () => {
  let key;
  const { execute } = fixture({ allowsExtension: (value) => { key = value; return true; } });
  await execute('chrome_ext_status', {}, { ...session, workspaceFile: 'cretli:ws:example' });
  assert.equal(key, 'cretli:ws:example');
});

test('delegation-parent-only chats are denied and both status and dispatch use INSTANCE_OWNER_ID', async () => {
  const { execute, calls } = fixture({
    resolveOwner: () => 'active-login-session',
    ownerActive: (owner) => owner === 'active-login-session',
  });
  for (const name of NAMES) {
    const denied = fixture({ loadChat: async () => ({ workspaceFolder: folder, delegationParentChatId: 'parent-chat' }) });
    await assert.rejects(denied.execute(name, { confirm: true }, session), { code: 'OUT_OF_SCOPE' }, name);
    assert.equal(denied.calls.length, 0);
  }
  const status = await execute('chrome_ext_status', {}, session);
  assert.equal(status.isError, false);
  assert.equal(calls[0].status, OWNER);
  const dispatched = await execute('chrome_ext_docs', { tabId: 1 }, session);
  assert.equal(dispatched.isError, false);
  assert.equal(calls[1].context.ownerSessionId, OWNER);
  assert.equal(calls[1].context.authorize instanceof Function, true);
});

test('consent, mode and owner are rechecked right before dispatch', async () => {
  for (const invalidate of ['mode', 'consent', 'owner']) {
    let started = false;
    const { execute } = fixture({
      allowsExtension: () => !(started && invalidate === 'consent'),
      resolveOwner: () => (started && invalidate === 'owner' ? 'user-2' : 'user-1'),
      bridge: { async execute(context) { started = true; await context.authorize(); assert.fail('must stay blocked'); } },
    });
    const current = { ...session, getMode: () => (started && invalidate === 'mode' ? 'plan' : 'agent') };
    await assert.rejects(execute('chrome_ext_docs', { tabId: 1 }, current), { code: invalidate === 'mode' ? 'PLAN_MODE_DENIED' : 'OUT_OF_SCOPE' });
  }
});

test('confirm:true is required for open_url and download only', async () => {
  for (const [name, args] of [['chrome_ext_open', { url: 'https://a.example.com' }], ['chrome_ext_fetch', { tabId: 1, items: [{ href: 'https://a.example.com/x.pdf' }] }]]) {
    for (const confirm of [undefined, false, 'true']) {
      const { execute, calls } = fixture();
      await assert.rejects(execute(name, { ...args, confirm }, session), { code: 'VALIDATION_ERROR' });
      assert.equal(calls.length, 0);
    }
    const { execute, calls } = fixture();
    await execute(name, { ...args, confirm: true }, session);
    assert.equal(calls[0].args.confirm, undefined, 'confirm is not forwarded to the bridge');
  }
  const { execute } = fixture();
  assert.equal((await execute('chrome_ext_docs', { tabId: 1 }, session)).isError, false);
  assert.equal((await execute('chrome_ext_status', {}, session)).structuredContent.paired, true);
});

test('no Claude subscription check exists or runs', async () => {
  const source = readFileSync(new URL('../lib/mcp/builtin/chrome-ext-tools.js', import.meta.url), 'utf8');
  assert.ok(!/subscription/i.test(source.replace(/no Claude subscription[^\n]*/i, '')));
  const prev = process.env.CRETLI_CLAUDE_CONFIG_DIR;
  process.env.CRETLI_CLAUDE_CONFIG_DIR = '/nonexistent-claude-config';
  try {
    assert.equal((await fixture().execute('chrome_ext_status', {}, session)).isError, false);
  } finally {
    if (prev === undefined) delete process.env.CRETLI_CLAUDE_CONFIG_DIR; else process.env.CRETLI_CLAUDE_CONFIG_DIR = prev;
  }
});

test('bridge failures become structured tool errors; domain gating end to end', async () => {
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    const execute = createChromeExtToolExecutor({
      bridge: fx.bridge, loadChat: async () => ({ workspaceFolder: folder }),
      resolveOwner: () => OWNER, ownerActive: () => true, allowsExtension: () => true,
    });
    const denied = await execute('chrome_ext_open', { url: 'https://billing.acme.test/', confirm: true }, session);
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.code, 'E_DOMAIN_NOT_ALLOWED');
    const status = await execute('chrome_ext_status', {}, session);
    assert.deepEqual(status.structuredContent.pendingDomains, ['billing.acme.test']);
    assert.ok(!JSON.stringify(status).match(/token/i));
    await openShopTab(fx, client);
    client.respondWith(() => ({ ok: true, data: { items: [{ selector: 'a', href: 'https://shop.example.com/1.pdf', text: 'Invoice', mimeHint: 'application/pdf' }] } }));
    const listed = await execute('chrome_ext_docs', { tabId: 7 }, session);
    assert.equal(listed.structuredContent.items[0].href, 'https://shop.example.com/1.pdf');
    fx.bridge.setKilled(OWNER, true);
    assert.equal((await execute('chrome_ext_docs', { tabId: 7 }, session)).structuredContent.code, 'E_KILLED');
  } finally { await fx.close(); }
});
