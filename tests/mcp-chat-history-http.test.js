import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  appendChatHistoryEvents,
  readChatHistoryFromHttpQuery,
} from '../lib/persist/chat-history-persist.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { formatMcpToolResult } from '../lib/mcp/mcp-runtime.js';
import { MCP_EVENT_TEXT_CHARS } from '../lib/mcp/builtin/chat-history-format.js';

const workspace = '/tmp/mcp-history-http-ws';
const workspaceB = '/tmp/mcp-history-http-ws-b';
const chat = addChat('sess-http-hist', 'HTTP history', null, workspace, 'model-a', {
  agentTransport: 'sdk',
});
for (let i = 1; i <= 5; i += 1) {
  appendChatHistoryEvents(chat.id, 'sess-http-hist', [
    { rec: { kind: 'localUser', text: `msg-${i}` } },
  ]);
}

const mixed = readChatHistoryFromHttpQuery(chat.id, { since: 0, tail: 2, limit: 2 });
assert.deepEqual(mixed.events.map((row) => row.seq), [4, 5]);

const forwardQuery = readChatHistoryFromHttpQuery(chat.id, { since: 0, limit: 2 });
assert.deepEqual(forwardQuery.events.map((row) => row.seq), [1, 2]);
assert.equal(forwardQuery.hasMore, true);

const exactSeq = readChatHistoryFromHttpQuery(chat.id, { seq: 3, tail: 2, since: 0 });
assert.deepEqual(exactSeq.events.map((row) => row.seq), [3]);
assert.equal(exactSeq.event.seq, 3);

const missingSeq = readChatHistoryFromHttpQuery(chat.id, { seq: 99 });
assert.equal(missingSeq.event, null);
assert.deepEqual(missingSeq.events, []);

const gapChat = addChat('sess-http-gap', 'HTTP gap', null, workspace, 'model-a', {
  agentTransport: 'sdk',
});
const historyDir = path.join(ISOLATED_DATA_DIR, 'chat-history');
fs.mkdirSync(historyDir, { recursive: true });
fs.writeFileSync(path.join(historyDir, `${gapChat.id}.json`), JSON.stringify({
  v: 1,
  chatId: gapChat.id,
  cursorSessionId: 'sess-http-gap',
  headSeq: 9,
  updatedAt: new Date().toISOString(),
  events: [
    { seq: 1, rec: { kind: 'localUser', text: 'g1' } },
    { seq: 5, rec: { kind: 'localUser', text: 'g5' } },
    { seq: 9, rec: { kind: 'localUser', text: 'g9' } },
  ],
}));
const gapExact = readChatHistoryFromHttpQuery(gapChat.id, { seq: 3 });
assert.equal(gapExact.event, null);
assert.deepEqual(gapExact.events, []);
const gapFive = readChatHistoryFromHttpQuery(gapChat.id, { seq: 5 });
assert.equal(gapFive.event.seq, 5);

/**
 * Stub HTTP server for CretliApiClient. It reuses readChatHistoryFromHttpQuery
 * (the same query function as production GET /api/chats/:id/history) but is
 * not the Express router.
 */
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
    return reply(200, { ok: true, chats: [chat, gapChat] });
  }
  const historyMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/history$/);
  if (req.method === 'GET' && historyMatch) {
    return reply(200, readChatHistoryFromHttpQuery(historyMatch[1], Object.fromEntries(url.searchParams)));
  }
  reply(404, { ok: false, error: 'Not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const apiClient = new CretliApiClient({ baseUrl: `http://127.0.0.1:${port}`, password: 'good' });
  const handlers = createCretliMcpToolHandlers(apiClient, {
    chatId: chat.id,
    workspaceFolder: workspace,
    mode: 'agent',
  });
  const page = await handlers.chat_history({ chat: chat.id, from_seq: 1, limit: 2 });
  assert.equal(page.isError, false);
  assert.match(page.content[0].text, /1 {2}user {2}msg-1/);
  assert.doesNotMatch(page.content[0].text, /msg-5/);
  assert.match(page.content[0].text, /next_from_seq: 3/);
  assert.equal(page.structuredContent.next_from_seq, 3);
  const openRouterText = formatMcpToolResult(page);
  assert.match(openRouterText, /next_from_seq: 3/);

  const viaHttp = await handlers.chat_event({ chat: chat.id, seq: 3, field: 'text' });
  assert.equal(viaHttp.isError, false);
  assert.match(viaHttp.content[0].text, /msg-3/);
  assert.equal(viaHttp.structuredContent.next_offset, null);

  const gapMiss = await handlers.chat_event({ chat: gapChat.id, seq: 3, field: 'text' });
  assert.equal(gapMiss.isError, true);
  assert.match(gapMiss.content[0].text, /NOT_FOUND/);
} finally {
  server.close();
}

const pagingOnly = formatMcpToolResult({
  content: [{ type: 'text', text: '1  user  hello' }],
  structuredContent: { next_from_seq: 9, next_before_seq: null },
});
assert.match(pagingOnly, /next_from_seq: 9/);

const localClient = createInProcessMcpClient({
  harness: 'sdk',
  chatId: chat.id,
  workspaceFolder: workspace,
});
const local = createCretliMcpToolHandlers(localClient, {
  chatId: chat.id,
  workspaceFolder: workspace,
  mode: 'agent',
});

const longChat = addChat('sess-http-long', 'HTTP long', null, workspace, 'model-a', {
  agentTransport: 'sdk',
});
const unicode = 'żółć 😀\nlinia';
const longText = `${'α'.repeat(1800)}${unicode}UNIQUE_TAIL_MARKER`;
appendChatHistoryEvents(longChat.id, 'sess-http-long', [
  { rec: { kind: 'localUser', text: longText } },
]);
const preview = await local.chat_history({ chat: longChat.id, from_seq: 1, limit: 1 });
assert.match(preview.content[0].text, /text_truncated: true/);
assert.match(preview.content[0].text, /continue: chat_event/);
assert.doesNotMatch(preview.content[0].text, /UNIQUE_TAIL_MARKER/);
const converted = formatMcpToolResult(preview);
assert.match(converted, /continue: chat_event/);

let offset = 0;
let recovered = '';
for (let i = 0; i < 8; i += 1) {
  const slice = await local.chat_event({
    chat: longChat.id,
    seq: 1,
    field: 'text',
    offset,
    length: MCP_EVENT_TEXT_CHARS,
  });
  assert.equal(slice.isError, false);
  const fragment = String(slice.content[0].text).split('--- fragment ---\n')[1] ?? '';
  recovered += fragment;
  if (slice.structuredContent.next_offset == null) break;
  assert.ok(slice.structuredContent.next_offset > offset);
  offset = slice.structuredContent.next_offset;
}
assert.equal(recovered, longText);
assert.match(recovered, /UNIQUE_TAIL_MARKER/);

const showChat = addChat('sess-http-show', 'HTTP show', null, workspace, 'model-a', {
  agentTransport: 'sdk',
});
for (let i = 1; i <= 10; i += 1) {
  appendChatHistoryEvents(showChat.id, 'sess-http-show', [
    { rec: { kind: 'localUser', text: `MESSAGE_${i} ${'z'.repeat(900)}` } },
  ]);
}
const shown = await local.chat_show({ chat: showChat.id });
assert.match(shown.content[0].text, /MESSAGE_10/);
assert.equal(shown.structuredContent.newest_seq, 10);
assert.match(shown.content[0].text, new RegExp(`MESSAGE_${shown.structuredContent.oldest_seq}`));

const systemChat = addChat('sess-http-sys', 'HTTP system', null, workspace, 'model-a', {
  agentTransport: 'sdk',
});
for (let i = 0; i < 6; i += 1) {
  appendChatHistoryEvents(systemChat.id, 'sess-http-sys', [
    { rec: { kind: 'sdk', event: { type: 'system', text: `sys-${i}` } } },
  ]);
}
appendChatHistoryEvents(systemChat.id, 'sess-http-sys', [
  { rec: { kind: 'localUser', text: 'after-system' } },
]);
const seenFrom = new Set();
let fromSeq = 1;
let sawUser = false;
for (let i = 0; i < 8; i += 1) {
  assert.equal(seenFrom.has(fromSeq), false);
  seenFrom.add(fromSeq);
  const page = await local.chat_history({ chat: systemChat.id, from_seq: fromSeq, limit: 2 });
  if (page.content[0].text.includes('after-system')) {
    sawUser = true;
    break;
  }
  assert.match(page.content[0].text, /next_from_seq:/);
  fromSeq = page.structuredContent.next_from_seq;
  assert.ok(fromSeq > 0);
}
assert.equal(sawUser, true);

const other = addChat('sess-http-other', 'HTTP other ws', null, workspaceB, 'model-a', {
  agentTransport: 'sdk',
});
appendChatHistoryEvents(other.id, 'sess-http-other', [
  { rec: { kind: 'localUser', text: 'secret-other' } },
]);
const denied = await local.chat_history({ chat: other.id });
assert.equal(denied.isError, true);
assert.match(denied.content[0].text, /OUT_OF_SCOPE/);
const allowed = await local.chat_history({ chat: other.id, scope: 'all' });
assert.equal(allowed.isError, false);
assert.match(allowed.content[0].text, /secret-other/);

console.log('mcp-chat-history-http.test.js OK');
