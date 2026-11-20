import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandHandlers } from '../app_front/features/voice/commandHandlers.js';
import {
  DRAG_SWITCH_PX,
  buildAgentList,
  dragIntent,
  pickWaitingAgent,
  resolveAgent,
  summarizeAgents,
} from '../app_front/features/car/orchestratorModel.js';

const workspaces = [
  { name: 'Shop', workspaceFile: '/w/shop.code-workspace' },
  { name: 'Blog', workspaceFile: '/w/blog.code-workspace' },
];
const chats = [
  { id: 'a', title: 'Fix checkout', workspaceFile: '/w/shop.code-workspace' },
  { id: 'b', title: 'Write post', workspaceFile: '/w/blog.code-workspace' },
  { id: 'c', title: 'Fix login', workspaceFile: '/w/shop.code-workspace' },
  { id: 'd', title: 'Old chat', workspaceFile: '/w/shop.code-workspace', archivedAt: '2026-01-01T00:00:00Z' },
  { id: 'e', title: 'Fix checkout', workspaceFile: '/w/blog.code-workspace' },
];
const states = {
  a: { state: 'busy', delegationStatus: '', recoveryStatus: '' },
  b: { state: 'waiting', inputRequested: true },
  c: { state: 'attention', delegationStatus: 'failed' },
};

const build = (extra = {}) => buildAgentList({ chats, workspaces, states, cards: [], activeChatId: 'a', ...extra });

test('agents of every workspace: needs-decision first, archived dropped, workspace labelled', () => {
  const rows = build();
  assert.deepEqual(rows.map((r) => r.chatId), ['b', 'c', 'a', 'e']);
  assert.deepEqual(rows.map((r) => r.status), ['needs_decision', 'error', 'working', 'idle']);
  assert.equal(rows[0].workspaceLabel, 'Blog');
  assert.equal(rows.find((r) => r.chatId === 'a').active, true);
  assert.equal(rows.some((r) => r.chatId === 'd'), false);
});

test('an open decision card lifts its chat to the top', () => {
  const rows = build({ states: { a: states.a }, cards: [{ id: 'k', status: 'pending', subject: { chatId: 'e' } }] });
  assert.equal(rows[0].chatId, 'e');
  assert.equal(rows[0].status, 'needs_decision');
});

test('CAR12: the model keeps every agent; any cap is presentation only', async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `x${i}`, title: `Agent ${i} unit` }));
  const rows = buildAgentList({ chats: many });
  assert.equal(rows.length, 80);
  assert.equal(buildAgentList({ chats: many, limit: 5 }).length, 5);
  // An agent far beyond any page is still found, by id and by spoken name.
  assert.equal(resolveAgent(rows, { chatId: 'x77' }).row.chatId, 'x77');
  assert.equal(resolveAgent(rows, { name: 'agent 77 unit' }).row.chatId, 'x77');
  const selected = [];
  const handlers = createCommandHandlers({
    loadChatModule: async () => ({
      getChatsList: () => many,
      getActiveChatIdValue: () => 'x0',
      selectChat: (id) => selected.push(id),
    }),
    loadCarService: async () => ({ loadAgentRows: async () => rows }),
  });
  const result = await handlers.switchAgent({ name: 'agent 77 unit' });
  assert.equal(result.ok, true);
  assert.deepEqual(selected, ['x77']);
  const listed = await handlers.listAgents();
  assert.equal(listed.total, 80);
  assert.equal(listed.agents.length, 20);
});

test('resolveAgent: id, waiting, name, workspace narrowing, ambiguity', () => {
  const rows = build();
  assert.equal(resolveAgent(rows, { chatId: 'c' }).row.chatId, 'c');
  assert.equal(resolveAgent(rows, { chatId: 'zzz' }).code, 'not_found');
  assert.equal(resolveAgent(rows, { waiting: true }).row.chatId, 'b');
  assert.equal(resolveAgent(build({ states: {} }), { waiting: true }).code, 'none_waiting');
  assert.equal(resolveAgent(rows, { name: 'login' }).row.chatId, 'c');
  assert.equal(resolveAgent(rows, { name: 'write post' }).row.chatId, 'b');
  const ambiguous = resolveAgent(rows, { name: 'fix checkout' });
  assert.equal(ambiguous.code, 'ambiguous');
  assert.equal(resolveAgent(rows, { name: 'fix checkout', workspace: 'blog' }).row.chatId, 'e');
  assert.equal(resolveAgent(rows, { name: 'fix checkout', workspace: 'shop' }).row.chatId, 'a');
  assert.equal(resolveAgent(rows, { name: 'fix checkout', workspace: 'nowhere' }).code, 'not_found');
  assert.equal(resolveAgent(rows, {}).code, 'bad_reference');
});

test('the waiting pick prefers another agent over the open one', () => {
  const rows = build({ activeChatId: 'b', states: { b: { inputRequested: true }, c: { inputRequested: true } } });
  assert.equal(pickWaitingAgent(rows).chatId, 'c');
  const only = build({ activeChatId: 'b', states: { b: { inputRequested: true } } });
  assert.equal(pickWaitingAgent(only).chatId, 'b');
});

test('dragging: a long horizontal drag switches, a short move is a tap, a vertical one scrolls', () => {
  const at = (x, y) => ({ x, y });
  assert.equal(dragIntent(at(0, 0), at(DRAG_SWITCH_PX + 5, 4)), 'switch');
  assert.equal(dragIntent(at(100, 0), at(0, 5)), 'switch', 'either direction');
  assert.equal(dragIntent(at(0, 0), at(3, 4)), 'tap');
  assert.equal(dragIntent(at(0, 0), at(40, 2)), null, 'too short');
  assert.equal(dragIntent(at(0, 0), at(90, 90)), null, 'diagonal drags do nothing');
});

test('the spoken summary counts the busy states', () => {
  const text = summarizeAgents(build(), (key, vars) => (key === 'car.agentsSummary' ? `${vars.count}: ${vars.parts}` : key.split('.').pop()));
  assert.match(text, /^4: 1 needs_decision, 1 error, 1 working$/);
});

function makeHandlers(rows) {
  const selected = [];
  const chatModule = {
    getChatsList: () => chats,
    getActiveChatIdValue: () => 'a',
    selectChat: (id, options) => selected.push([id, options]),
  };
  const handlers = createCommandHandlers({
    loadChatModule: async () => chatModule,
    loadCarService: async () => ({ loadAgentRows: async () => rows }),
  });
  return { handlers, selected };
}

test('switch_agent selects the chat (switching workspace with it) and reports the workspace', async () => {
  const { handlers, selected } = makeHandlers(build());
  const waiting = await handlers.switchAgent({ waiting: true });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.chatId, 'b');
  assert.equal(waiting.workspace, 'Blog');
  assert.deepEqual(selected, [['b', { byUser: true }]]);
  const missing = await handlers.switchAgent({ name: 'nothing like it' });
  assert.equal(missing.ok, false);
  assert.equal(selected.length, 1, 'a failed lookup selects nothing');
  const ambiguous = await handlers.switchAgent({ name: 'fix checkout' });
  assert.equal(ambiguous.ok, false);
  assert.deepEqual([...ambiguous.candidates].length, 2);
  assert.equal(selected.length, 1);
});

test('list_agents returns rows and a one-line summary', async () => {
  const { handlers } = makeHandlers(build());
  const result = await handlers.listAgents();
  assert.equal(result.ok, true);
  assert.equal(result.agents[0].chat_id, 'b');
  assert.equal(result.agents[0].status, 'needs_decision');
  assert.equal(typeof result.message, 'string');
});
