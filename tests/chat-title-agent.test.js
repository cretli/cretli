/**
 * Agent-set titles: applyAgentTitle (source gating, manual lock, sanitizer, throttle, CAS),
 * buildAgentTitleHint, outbound prompt injection, dispatcher skip, route, MCP tool, settings validation.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';

const { addChat, loadChats, updateChat } = await import('../lib/persist/chats-persist.js');
const { getChatTitleHistory } = await import('../lib/persist/chat-title-history-persist.js');
const { loadSettings, saveSettings, getAutoTitleSettings } = await import('../lib/persist/settings.js');
const agent = await import('../lib/chat-title-agent.js');
const { applyHarnessOutboundPrompt } = await import('../lib/sdk/harness-plan-prompt.js');
const { createChatTitleDispatcher } = await import('../lib/chat-title-dispatcher.js');
const { registerChatsRoutes } = await import('../lib/routes/chats-routes.js');
const { registerSettingsRoutes } = await import('../lib/routes/settings-routes.js');
const { removeIsolatedDataDir } = await import('./helpers/isolated-data-dir.js');

const setSource = (source, mode = 'first') => saveSettings({ ...loadSettings(), autoTitle: { mode, source } });
const newChat = (n, extras = {}) => addChat(`s-${n}`, 'Claude chat 1', undefined, undefined, undefined, extras);
const titleOf = (id) => loadChats().find((c) => c.id === id);

try {
  assert.equal(getAutoTitleSettings({}).source, 'server');
  assert.equal(getAutoTitleSettings({ autoTitle: { source: 'bogus' } }).source, 'server');

  // --- gating by source / mode ---
  const a = newChat(1);
  setSource('server');
  assert.equal(agent.applyAgentTitle(a.id, 'auth: fix token').reason, 'disabled');
  assert.equal(agent.buildAgentTitleHint({ chatId: a.id, mode: 'agent' }), '');
  setSource('agent', 'off');
  assert.equal(agent.applyAgentTitle(a.id, 'auth: fix token').reason, 'disabled');

  // --- applies, goes through history as 'agent' ---
  setSource('agent');
  assert.match(agent.buildAgentTitleHint({ chatId: a.id, mode: 'agent' }), /placeholder name/);
  assert.equal(agent.buildAgentTitleHint({ chatId: a.id, mode: 'plan' }), '');
  assert.equal(agent.buildAgentTitleHint({ chatId: a.id, mode: 'ask' }), '');
  const first = agent.applyAgentTitle(a.id, '"auth: fix token expiry"');
  assert.equal(first.status, 'applied');
  assert.equal(titleOf(a.id).title, 'auth: fix token expiry');
  assert.equal(titleOf(a.id).titleSource, 'auto');
  assert.equal(getChatTitleHistory(a.id).at(-1).reason, 'agent');

  // --- throttle after a generated title; update hint is suppressed meanwhile ---
  assert.equal(agent.applyAgentTitle(a.id, 'auth: another try').reason, 'throttled');
  assert.equal(agent.buildAgentTitleHint({ chatId: a.id, mode: 'agent' }), '');
  const later = () => Date.now() + 11 * 60 * 1000;
  assert.match(agent.buildAgentTitleHint({ chatId: a.id, mode: 'agent' }, { now: later }), /changed substantially/);
  assert.equal(agent.applyAgentTitle(a.id, 'auth: refresh tokens', { now: later }).status, 'applied');

  // --- sanitizer: generic / secret-looking titles rejected ---
  const b = newChat(2);
  assert.equal(agent.applyAgentTitle(b.id, 'Chat').reason, 'rejected_output');
  assert.equal(agent.applyAgentTitle(b.id, 'sk-abcdefghijklmnop leak').reason, 'rejected_output');
  assert.equal(titleOf(b.id).titleSource, 'default');

  // --- manual lock / temp / delegation / unknown ---
  const m = newChat(3);
  updateChat(m.id, { title: 'My own name' });
  assert.equal(agent.applyAgentTitle(m.id, 'x: y z').reason, 'manual');
  assert.equal(agent.buildAgentTitleHint({ chatId: m.id, mode: 'agent' }), '');
  assert.equal(agent.applyAgentTitle(newChat(4, { delegationId: 'd1' }).id, 'x: y z').reason, 'delegation');
  assert.equal(agent.applyAgentTitle('nope', 'x: y z').reason, 'not_found');
  // finished delegation chat (user continues by hand) is eligible; a running one is not
  let delegationStatus = 'running';
  agent.__resetAgentTitleStateForTest(() => ({ status: delegationStatus }));
  const dc = newChat(8, { delegationId: 'd2' });
  assert.equal(agent.applyAgentTitle(dc.id, 'x: y z').reason, 'delegation');
  assert.equal(agent.buildAgentTitleHint({ chatId: dc.id, mode: 'agent' }), '');
  delegationStatus = 'completed';
  assert.match(agent.buildAgentTitleHint({ chatId: dc.id, mode: 'agent' }), /placeholder name/);
  assert.equal(agent.applyAgentTitle(dc.id, 'deleg: finished chat title').status, 'applied');
  agent.__resetAgentTitleStateForTest();

  // --- outbound prompt carries the hint (and only then) ---
  const c = newChat(5);
  const withHint = applyHarnessOutboundPrompt('do the thing', { cwd: process.cwd(), chatId: c.id, mode: 'agent', reportContext: '' });
  assert.match(withHint, /chat_set_title/);
  assert.ok(withHint.endsWith('do the thing'));
  setSource('server');
  assert.doesNotMatch(applyHarnessOutboundPrompt('do the thing', { cwd: process.cwd(), chatId: c.id, mode: 'agent', reportContext: '' }), /chat_set_title/);

  // --- dispatcher: source 'agent' schedules no server job, 'both' still does ---
  let scheduled = 0;
  const mk = (source) => createChatTitleDispatcher({
    service: { requestTitle: async () => ({}) },
    loadChat: () => ({ id: 'x', titleSource: 'default' }),
    getSettings: () => ({ mode: 'first', source }),
    defer: (fn) => { scheduled += 1; fn(); },
  });
  assert.equal(mk('agent').noteRunFinished('x', { status: 'completed' }), false);
  assert.equal(mk('both').noteRunFinished('x', { status: 'completed' }), true);
  assert.equal(mk('server').noteRunFinished('x', { status: 'completed' }), true);
  assert.equal(scheduled, 2);

  // --- route ---
  const handlers = new Map();
  const app = {};
  for (const verb of ['get', 'post', 'patch', 'delete', 'put']) app[verb] = (p, fn) => handlers.set(`${verb.toUpperCase()} ${p}`, fn);
  registerChatsRoutes(app, {});
  registerSettingsRoutes(app, {});
  const call = (key, req) => new Promise((resolve) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    handlers.get(key)({ params: {}, query: {}, body: {}, headers: {}, ...req }, res);
  });
  setSource('both');
  const d = newChat(6);
  const ok = await call('POST /api/chats/:id/agent-title', { params: { id: d.id }, body: { title: 'api: route title' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'applied');
  assert.equal(titleOf(d.id).title, 'api: route title');
  assert.equal((await call('POST /api/chats/:id/agent-title', { params: { id: 'nope' }, body: { title: 'a: b c' } })).status, 404);

  // --- MCP tool uses the calling chat only (ignores any chat arg) ---
  const { BUILTIN_TOOLS } = await import('../lib/mcp/builtin/catalog.js').then((m) => ({ BUILTIN_TOOLS: m.listBuiltinMcpMutatingToolNames() }));
  assert.ok(BUILTIN_TOOLS.includes('chat_set_title'));
  const tools = (await import('../lib/mcp/builtin/chat-tools.js'));
  const toolList = tools.CHAT_TOOLS || tools.default || Object.values(tools).find(Array.isArray);
  const tool = toolList.find((t) => t.name === 'chat_set_title');
  const seen = [];
  const client = { setAgentTitle: async (id, title) => { seen.push([id, title]); return { status: 'applied', title }; } };
  const res = await tool.handler({ title: 'tool: sets title', chat: 'other-chat' }, { client, session: { chatId: 'caller-chat', workspaceFolder: process.cwd() } });
  assert.deepEqual(seen, [['caller-chat', 'tool: sets title']]);
  assert.match(res.content[0].text, /Title set/);
  await assert.rejects(() => tool.handler({ title: 'x' }, { client, session: {} }), /calling chat/);

  // --- real in-process MCP client path (what builtin tools use inside Cretli) ---
  const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
  const e = newChat(7);
  const inproc = createInProcessMcpClient({ harness: 'claude', chatId: e.id, workspaceFolder: process.cwd() });
  const viaClient = await tool.handler({ title: 'inproc: real client path' }, { client: inproc, session: { chatId: e.id, workspaceFolder: process.cwd() } });
  assert.match(viaClient.content[0].text, /Title set/);
  assert.equal(titleOf(e.id).title, 'inproc: real client path');

  // --- settings PATCH validation for source ---
  const patch = (body) => call('PATCH /api/settings', { body });
  assert.equal((await patch({ autoTitle: { source: 'bogus' } })).status, 400);
  console.log('chat-title-agent.test.js OK');
} finally {
  removeIsolatedDataDir();
}
