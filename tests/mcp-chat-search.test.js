import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  appendChatHistoryEvents,
  readChatHistoryFromHttpQuery,
} from '../lib/persist/chat-history-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import {
  CRETILI_MCP_TOOL_DEFS,
  createCretliMcpToolHandlers,
} from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpReadTools } from '../lib/mcp/mcp-policy.js';
import {
  MCP_SEARCH_MAX_LIMIT,
  MCP_SEARCH_SCAN_MAX_CHARS,
  MCP_SEARCH_SCAN_MAX_EVENTS,
  MCP_SEARCH_SNIPPET_CHARS,
  buildSearchSnippet,
  clampSearchLimit,
  normalizeSearchQuery,
  parseSearchCursor,
  scanHistoryForMatches,
} from '../lib/mcp/builtin/chat-search.js';

const workspace = '/tmp/mcp-chat-search-ws';
const workspaceB = '/tmp/mcp-chat-search-ws-b';

// Registration: chat_search is a read-only builtin tool.
const searchDef = CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'chat_search');
assert.ok(searchDef, 'chat_search is registered in the builtin catalog');
assert.equal(searchDef.annotations.readOnlyHint, true);
assert.deepEqual(searchDef.inputSchema.required, ['chat', 'query']);
assert.ok(getBuiltinMcpReadTools().includes('chat_search'));

// Pure helpers: validation and bounds.
assert.equal(clampSearchLimit(undefined), 20);
assert.equal(clampSearchLimit(1000), MCP_SEARCH_MAX_LIMIT);
assert.equal(normalizeSearchQuery('  falcon  '), 'falcon');
assert.throws(() => normalizeSearchQuery('a'), /VALIDATION_ERROR|at least/i);
assert.throws(() => normalizeSearchQuery(''), /VALIDATION_ERROR|at least/i);
assert.deepEqual(parseSearchCursor(''), { fromSeq: 0 });
assert.deepEqual(parseSearchCursor('seq:12'), { fromSeq: 12 });
assert.throws(() => parseSearchCursor('nope'), /invalid/i);

const boundedScan = scanHistoryForMatches({
  chatId: 'c',
  events: [
    { seq: 1, rec: { kind: 'localUser', text: `${'a'.repeat(MCP_SEARCH_SCAN_MAX_CHARS + 10)}NEEDLE` } },
    { seq: 2, rec: { kind: 'localUser', text: 'NEEDLE two' } },
  ],
  query: 'NEEDLE',
  limit: 10,
});
assert.equal(boundedScan.items.length, 1);
assert.equal(boundedScan.items[0].seq, 1);
assert.equal(boundedScan.next_cursor, 'seq:2');
assert.equal(boundedScan.truncated, true);
const manyEvents = Array.from({ length: MCP_SEARCH_SCAN_MAX_EVENTS + 5 }, (_, index) => ({
  seq: index + 1,
  rec: { kind: 'localUser', text: `row-${index}` },
}));
const eventBound = scanHistoryForMatches({ chatId: 'c', events: manyEvents, query: 'NEEDLE', limit: 10 });
assert.equal(eventBound.scanned_events, MCP_SEARCH_SCAN_MAX_EVENTS);
assert.equal(eventBound.next_cursor, `seq:${MCP_SEARCH_SCAN_MAX_EVENTS + 1}`);
assert.ok(buildSearchSnippet('x'.repeat(5000) + 'NEEDLE' + 'y'.repeat(5000), 5000, 6).length <= MCP_SEARCH_SNIPPET_CHARS);

// Seeded chat: text, tool args, tool result, a huge text and page-able rows.
const chat = addChat('sess-search', 'Search chat', null, workspace, 'model-a', {
  agentTransport: 'sdk',
});
appendChatHistoryEvents(chat.id, 'sess-search', [
  { rec: { kind: 'localUser', text: 'The FALCON_MARKER appears in plain text.' } },
  {
    rec: {
      kind: 'sdk',
      event: {
        type: 'tool_call',
        name: 'bash',
        status: 'completed',
        call_id: 'c1',
        args: { command: 'echo falcon_marker-in-args' },
        result: 'nothing here',
      },
    },
  },
  {
    rec: {
      kind: 'sdk',
      event: {
        type: 'tool_call',
        name: 'bash',
        status: 'completed',
        call_id: 'c2',
        args: { command: 'ls' },
        result: 'output FALCON_MARKER in result',
      },
    },
  },
  { rec: { kind: 'localUser', text: `${'x'.repeat(5000)}FALCON_MARKER${'y'.repeat(5000)}` } },
]);
for (let i = 0; i < 6; i += 1) {
  appendChatHistoryEvents(chat.id, 'sess-search', [
    { rec: { kind: 'localUser', text: `row-${i} PAGINATE_ME row-${i}` } },
  ]);
}

const client = createInProcessMcpClient({ harness: 'sdk', chatId: chat.id, workspaceFolder: workspace });
const handlers = createCretliMcpToolHandlers(client, {
  chatId: chat.id,
  workspaceFolder: workspace,
  mode: 'agent',
});

// Case-insensitive phrase across text, tool args and tool result.
const hit = await handlers.chat_search({ chat: chat.id, query: 'falcon_marker' });
assert.equal(hit.isError, false);
const bySeq = new Map(hit.structuredContent.items.map((item) => [item.seq, item]));
assert.equal(bySeq.get(1).field, 'text');
assert.equal(bySeq.get(2).field, 'args');
assert.equal(bySeq.get(3).field, 'result');
assert.ok(bySeq.get(4), 'the huge text event matches');

// Snippet is bounded, elided and carries the pointer; the full body is not returned.
const longItem = bySeq.get(4);
assert.ok(longItem.snippet.length <= MCP_SEARCH_SNIPPET_CHARS);
assert.match(longItem.snippet, /FALCON_MARKER/);
assert.match(longItem.snippet, /…/);
assert.equal(longItem.pointer, `cretli-ref chat=${chat.id} seq=4`);
assert.ok(hit.content[0].text.includes(longItem.pointer));
assert.ok(!hit.content[0].text.includes('x'.repeat(4000)), 'whole event bodies are not returned');

// Pagination: limit, cursor, no duplicates.
const page1 = await handlers.chat_search({ chat: chat.id, query: 'PAGINATE_ME', limit: 2 });
assert.equal(page1.isError, false);
assert.equal(page1.structuredContent.items.length, 2);
assert.equal(page1.structuredContent.truncated, true);
assert.ok(page1.structuredContent.next_cursor);
assert.match(page1.content[0].text, /next_cursor:/);
const seenSeqs = new Set(page1.structuredContent.items.map((item) => item.seq));
let cursor = page1.structuredContent.next_cursor;
for (let guard = 0; cursor && guard < 10; guard += 1) {
  const next = await handlers.chat_search({
    chat: chat.id,
    query: 'PAGINATE_ME',
    limit: 2,
    cursor,
  });
  assert.equal(next.isError, false);
  for (const item of next.structuredContent.items) {
    assert.equal(seenSeqs.has(item.seq), false, `duplicate seq ${item.seq}`);
    seenSeqs.add(item.seq);
  }
  cursor = next.structuredContent.next_cursor;
}
assert.equal(seenSeqs.size, 6);

// Title reference resolves like chat_history.
const byTitle = await handlers.chat_search({ chat: 'Search chat', query: 'FALCON_MARKER' });
assert.equal(byTitle.isError, false);
assert.ok(byTitle.structuredContent.items.length >= 1);

// No match is an empty, non-error page.
const none = await handlers.chat_search({ chat: chat.id, query: 'ZZZ_NOT_PRESENT_ZZZ' });
assert.equal(none.isError, false);
assert.deepEqual(none.structuredContent.items, []);
assert.equal(none.structuredContent.truncated, false);
assert.match(none.content[0].text, /no matches/);

// Errors: missing chat / bad query / bad cursor.
const missing = await handlers.chat_search({ chat: 'no-such-chat-xyz', query: 'FALCON_MARKER' });
assert.equal(missing.isError, true);
assert.match(missing.content[0].text, /NOT_FOUND/);
for (const badQuery of ['', ' ', 'a']) {
  const res = await handlers.chat_search({ chat: chat.id, query: badQuery });
  assert.equal(res.isError, true, `query=${JSON.stringify(badQuery)} must be rejected`);
  assert.match(res.content[0].text, /VALIDATION_ERROR/);
}
const missingQuery = await handlers.chat_search({ chat: chat.id });
assert.equal(missingQuery.isError, true);
assert.match(missingQuery.content[0].text, /VALIDATION_ERROR/);
const badCursor = await handlers.chat_search({ chat: chat.id, query: 'PAGINATE_ME', cursor: 'nope' });
assert.equal(badCursor.isError, true);
assert.match(badCursor.content[0].text, /VALIDATION_ERROR/);

// Scope: another workspace is OUT_OF_SCOPE unless scope=all.
const other = addChat('sess-search-other', 'Search other ws', null, workspaceB, 'model-a', {
  agentTransport: 'sdk',
});
appendChatHistoryEvents(other.id, 'sess-search-other', [
  { rec: { kind: 'localUser', text: 'OTHER_WS_MARKER' } },
]);
const denied = await handlers.chat_search({ chat: other.id, query: 'OTHER_WS_MARKER' });
assert.equal(denied.isError, true);
assert.match(denied.content[0].text, /OUT_OF_SCOPE/);
const allowed = await handlers.chat_search({ chat: other.id, query: 'OTHER_WS_MARKER', scope: 'all' });
assert.equal(allowed.isError, false);
assert.equal(allowed.structuredContent.items[0].seq, 1);

// Remote HTTP client: chat_search reuses getChatHistory({ since, limit }) and the
// stub route delegates to the same query function as production.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'POST' && url.pathname === '/api/login') {
    req.resume();
    req.on('end', () => {
      reply(200, { ok: true, csrfToken: 'csrf' }, { 'Set-Cookie': 'cr_session=tok; Path=/; HttpOnly' });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/chats') {
    return reply(200, { ok: true, chats: [chat, other] });
  }
  const historyMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/history$/);
  if (req.method === 'GET' && historyMatch) {
    return reply(200, readChatHistoryFromHttpQuery(
      decodeURIComponent(historyMatch[1]),
      Object.fromEntries(url.searchParams),
    ));
  }
  return reply(404, { ok: false, error: 'Not found' });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const apiClient = new CretliApiClient({ baseUrl: `http://127.0.0.1:${port}`, password: 'good' });
  const httpHandlers = createCretliMcpToolHandlers(apiClient, {
    chatId: chat.id,
    workspaceFolder: workspace,
    mode: 'agent',
  });
  const viaHttp = await httpHandlers.chat_search({ chat: chat.id, query: 'PAGINATE_ME', limit: 2 });
  assert.equal(viaHttp.isError, false);
  assert.equal(viaHttp.structuredContent.items.length, 2);
  assert.ok(viaHttp.structuredContent.next_cursor);
  const viaHttpNext = await httpHandlers.chat_search({
    chat: chat.id,
    query: 'PAGINATE_ME',
    limit: 2,
    cursor: viaHttp.structuredContent.next_cursor,
  });
  assert.equal(viaHttpNext.isError, false);
  assert.ok(viaHttpNext.structuredContent.items.length >= 1);
  assert.equal(viaHttpNext.structuredContent.items[0].seq > viaHttp.structuredContent.items[1].seq, true);
} finally {
  server.close();
}

removeIsolatedDataDir();
console.log('mcp-chat-search.test.js OK');
