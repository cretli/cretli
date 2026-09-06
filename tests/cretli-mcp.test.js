import assert from 'node:assert/strict';
import { createMcpHandler } from '../scripts/cretli-mcp.js';
import { CRETILI_MCP_TOOL_DEFS } from '../lib/mcp/mcp-builtin-tools.js';

const CHATS = [
  {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    title: 'Fix widget',
    workspaceFolder: '/tmp/w1',
    agentTransport: 'sdk',
    updatedAt: '2026-09-05T10:00:00Z',
    forkParentChatId: 'ffffffff-1111-2222-3333-444444444444',
  },
  {
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    title: 'Widget harnes',
    workspaceFolder: '/tmp/w2',
    agentTransport: 'opencode',
    updatedAt: '2026-09-04T10:00:00Z',
    archivedAt: '2026-09-04T12:00:00Z',
  },
  {
    id: 'cccccccc-1111-2222-3333-444444444444',
    title: 'Widget tests',
    workspaceFolder: '/tmp/w1',
    agentTransport: 'sdk',
    updatedAt: '2026-09-03T10:00:00Z',
  },
];

const HISTORY_EVENTS = [
  { seq: 1, rec: { kind: 'localUser', text: 'hello' } },
  {
    seq: 2,
    rec: {
      kind: 'sdk',
      event: {
        type: 'tool_call',
        name: 'bash',
        status: 'completed',
        call_id: 'c1',
        args: { command: 'ls' },
        result: 'ok',
      },
    },
  },
  {
    seq: 3,
    rec: {
      kind: 'sdk',
      event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } },
    },
  },
  { seq: 4, rec: { kind: 'localUser', text: 'again' } },
  {
    seq: 5,
    rec: {
      kind: 'sdk',
      event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    },
  },
];

const calls = [];
const client = {
  async listChats({ includeArchived } = {}) {
    calls.push(['list', includeArchived === true]);
    return includeArchived === true ? CHATS : CHATS.filter((chat) => !chat.archivedAt);
  },
  async getChatHistory(chatId, options) {
    calls.push(['history', chatId, options]);
    const seqRaw = Number(options?.seq);
    if (Number.isInteger(seqRaw) && seqRaw > 0) {
      const event = HISTORY_EVENTS.find((row) => row.seq === seqRaw) || null;
      return { ok: true, headSeq: 5, event, events: event ? [event] : [] };
    }
    const tailRaw = Number.parseInt(String(options?.tail || '0'), 10);
    const beforeRaw = Number.parseInt(String(options?.before || '0'), 10);
    const wantsPage = Number.isFinite(tailRaw) && tailRaw > 0;
    const wantsBefore = Number.isFinite(beforeRaw) && beforeRaw > 0;
    if (wantsPage || wantsBefore) {
      const pool = beforeRaw > 0 ? HISTORY_EVENTS.filter((event) => event.seq < beforeRaw) : HISTORY_EVENTS;
      const slice = pool.slice(-(wantsPage ? tailRaw : 40));
      return {
        ok: true,
        headSeq: 5,
        events: slice,
        hasOlder: slice.length > 0 && slice[0].seq > 1,
      };
    }
    const sinceRaw = Number(options?.since);
    const sinceSeq = Number.isFinite(sinceRaw) ? sinceRaw : -1;
    const limit = Number(options?.limit) || 40;
    const tail = HISTORY_EVENTS.filter((event) => event.seq > sinceSeq);
    const slice = tail.slice(0, limit);
    return {
      ok: true,
      headSeq: 5,
      events: slice,
      hasMore: tail.length > slice.length,
    };
  },
  async archiveChat(chatId, archived) {
    calls.push(['archive', chatId, archived]);
    return { id: chatId, title: 'Fix widget' };
  },
  async renameChat(chatId, title) {
    calls.push(['rename', chatId, title]);
    return { id: chatId, title };
  },
  async deleteChat(chatId) {
    calls.push(['delete', chatId]);
    return { ok: true };
  },
};

const session = { mode: 'agent', workspaceFolder: '/tmp/w1' };
const handle = createMcpHandler(client, session);

// Notifications must not produce a response.
assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

// initialize echoes the requested protocol version.
const initialized = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
assert.equal(initialized.result.serverInfo.name, 'cretli');
assert.equal(initialized.result.protocolVersion, '2025-06-18');
assert.deepEqual(initialized.result.capabilities.tools, {});

// tools/list exposes the chat tools.
const tools = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
assert.deepEqual(
  tools.result.tools.map((tool) => tool.name).sort(),
  CRETILI_MCP_TOOL_DEFS.map((tool) => tool.name).sort(),
);
assert.ok(tools.result.tools.some((tool) => tool.name === 'chat_history'));

// Default list is the calling workspace only.
const listed = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chat_list', arguments: {} } });
assert.match(listed.result.content[0].text, /Fix widget/);
assert.match(listed.result.content[0].text, /Widget tests/);
assert.doesNotMatch(listed.result.content[0].text, /Widget harnes/);

const listedAll = await handle({
  jsonrpc: '2.0',
  id: 31,
  method: 'tools/call',
  params: { name: 'chat_list', arguments: { scope: 'all', include_archived: true } },
});
assert.match(listedAll.result.content[0].text, /Widget harnes/);

// chat_show resolves by id prefix, includes fork parent, compact tail.
const shown = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'chat_show', arguments: { chat: 'aaaaaaaa' } } });
assert.match(shown.result.content[0].text, /# Fix widget/);
assert.match(shown.result.content[0].text, /fork_parent: ffffffff-1111-2222-3333-444444444444/);
assert.match(shown.result.content[0].text, /> hello/);
assert.match(shown.result.content[0].text, /all done/);
assert.equal(shown.result.structuredContent.fork_parent_chat_id, CHATS[0].forkParentChatId);
assert.doesNotMatch(shown.result.content[0].text, /command":"ls"/);

const foreign = await handle({
  jsonrpc: '2.0',
  id: 41,
  method: 'tools/call',
  params: { name: 'chat_show', arguments: { chat: 'bbbbbbbb' } },
});
assert.equal(foreign.result.isError, true);
assert.match(foreign.result.content[0].text, /OUT_OF_SCOPE/);

const historyPage = await handle({
  jsonrpc: '2.0',
  id: 42,
  method: 'tools/call',
  params: { name: 'chat_history', arguments: { chat: 'aaaaaaaa', limit: 2 } },
});
assert.match(historyPage.result.content[0].text, /4 {2}user {2}again/);
assert.match(historyPage.result.content[0].text, /5 {2}assistant {2}second/);
assert.doesNotMatch(historyPage.result.content[0].text, /hello/);
assert.match(historyPage.result.content[0].text, /next_before_seq: 4/);
assert.equal(historyPage.result.structuredContent.next_before_seq, 4);

const older = await handle({
  jsonrpc: '2.0',
  id: 43,
  method: 'tools/call',
  params: { name: 'chat_history', arguments: { chat: 'aaaaaaaa', before_seq: 4, limit: 2 } },
});
assert.match(older.result.content[0].text, /2 {2}tool {2}bash/);
assert.match(older.result.content[0].text, /3 {2}assistant {2}all done/);

const forward = await handle({
  jsonrpc: '2.0',
  id: 44,
  method: 'tools/call',
  params: { name: 'chat_history', arguments: { chat: 'aaaaaaaa', from_seq: 1, limit: 2 } },
});
assert.match(forward.result.content[0].text, /1 {2}user {2}hello/);
assert.match(forward.result.content[0].text, /next_from_seq: 3/);
assert.equal(forward.result.structuredContent.next_from_seq, 3);
const forwardOpts = calls.filter((row) => row[0] === 'history').at(-1)[2];
assert.equal(forwardOpts.tail, undefined);
assert.equal(forwardOpts.since, 0);
assert.equal(forwardOpts.limit, 2);

const withPayloads = await handle({
  jsonrpc: '2.0',
  id: 45,
  method: 'tools/call',
  params: {
    name: 'chat_history',
    arguments: { chat: 'aaaaaaaa', from_seq: 2, limit: 1, include_tool_payloads: true },
  },
});
assert.match(withPayloads.result.content[0].text, /args/);
assert.match(withPayloads.result.content[0].text, /ls/);

const eventSlice = await handle({
  jsonrpc: '2.0',
  id: 46,
  method: 'tools/call',
  params: { name: 'chat_event', arguments: { chat: 'aaaaaaaa', seq: 1, field: 'text', offset: 0, length: 2 } },
});
assert.equal(eventSlice.result.isError, false);
assert.match(eventSlice.result.content[0].text, /seq: 1/);
assert.match(eventSlice.result.content[0].text, /next_offset: 2/);
assert.match(eventSlice.result.content[0].text, /he/);
assert.equal(eventSlice.result.structuredContent.seq, 1);
assert.equal(eventSlice.result.structuredContent.next_offset, 2);
assert.equal(JSON.stringify(eventSlice.result.structuredContent).includes('hello'), false);

const fractionalLength = await handle({
  jsonrpc: '2.0',
  id: 461,
  method: 'tools/call',
  params: { name: 'chat_event', arguments: { chat: 'aaaaaaaa', seq: 1, field: 'text', offset: 0, length: 0.5 } },
});
assert.equal(fractionalLength.result.isError, true);
assert.match(fractionalLength.result.content[0].text, /VALIDATION_ERROR/);
assert.doesNotMatch(fractionalLength.result.content[0].text, /next_offset: 0/);

const zeroLength = await handle({
  jsonrpc: '2.0',
  id: 462,
  method: 'tools/call',
  params: { name: 'chat_event', arguments: { chat: 'aaaaaaaa', seq: 1, field: 'text', length: 0 } },
});
assert.equal(zeroLength.result.isError, true);
assert.match(zeroLength.result.content[0].text, /VALIDATION_ERROR/);

const missingEvent = await handle({
  jsonrpc: '2.0',
  id: 47,
  method: 'tools/call',
  params: { name: 'chat_event', arguments: { chat: 'aaaaaaaa', seq: 99, field: 'text' } },
});
assert.equal(missingEvent.result.isError, true);
assert.match(missingEvent.result.content[0].text, /NOT_FOUND/);

const badField = await handle({
  jsonrpc: '2.0',
  id: 48,
  method: 'tools/call',
  params: { name: 'chat_event', arguments: { chat: 'aaaaaaaa', seq: 1, field: 'body' } },
});
assert.equal(badField.result.isError, true);
assert.match(badField.result.content[0].text, /VALIDATION_ERROR/);

const foreignEvent = await handle({
  jsonrpc: '2.0',
  id: 49,
  method: 'tools/call',
  params: { name: 'chat_event', arguments: { chat: 'bbbbbbbb', seq: 1, field: 'text' } },
});
assert.equal(foreignEvent.result.isError, true);
assert.match(foreignEvent.result.content[0].text, /OUT_OF_SCOPE/);

// chat_archive archives via the API client.
await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'chat_archive', arguments: { chat: 'aaaa' } } });
assert.deepEqual(calls.at(-1), ['archive', CHATS[0].id, true]);

// chat_delete asks for confirmation first, then deletes with confirm=true.
const unconfirmed = await handle({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: { name: 'chat_delete', arguments: { chat: 'bbbbbbbb', scope: 'all' } },
});
assert.match(unconfirmed.result.content[0].text, /confirm=true/);
await handle({
  jsonrpc: '2.0',
  id: 7,
  method: 'tools/call',
  params: { name: 'chat_delete', arguments: { chat: 'bbbbbbbb', confirm: true, scope: 'all' } },
});
assert.deepEqual(calls.at(-1), ['delete', CHATS[1].id]);

// Unknown tool is a protocol error; ambiguous reference is a tool error.
const unknown = await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } });
assert.equal(unknown.error.code, -32602);
const ambiguous = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'chat_archive', arguments: { chat: 'widget' } } });
assert.equal(ambiguous.result.isError, true);
assert.match(ambiguous.result.content[0].text, /Ambiguous/);

const planHandle = createMcpHandler(client, { mode: 'plan', workspaceFolder: '/tmp/w1' });
const planDenied = await planHandle({
  jsonrpc: '2.0',
  id: 10,
  method: 'tools/call',
  params: { name: 'chat_archive', arguments: { chat: 'aaaaaaaa' } },
});
assert.equal(planDenied.result.isError, true);
assert.match(planDenied.result.content[0].text, /PLAN_MODE_DENIED/);
assert.equal(calls.filter((row) => row[0] === 'archive').length, 1);

const planEvent = await planHandle({
  jsonrpc: '2.0',
  id: 50,
  method: 'tools/call',
  params: { name: 'chat_event', arguments: { chat: 'aaaaaaaa', seq: 1, field: 'text' } },
});
assert.equal(planEvent.result.isError, false);

console.log('cretli-mcp.test.js OK');
