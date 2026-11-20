import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { widgetChatListScope } from '../lib/widget/widget-chat-scope.ts';
import { useChatsBackendFromEnv, registerChatsBackendTeardown, seedChatRows } from './helpers/chats-backends.js';

await useChatsBackendFromEnv();
const { appendChatHistoryEvents } = await import('../lib/persist/chat-history-persist.js');
const {
  CONTENT_SEARCH_MAX_QUERY_CHARS,
  CONTENT_SEARCH_MAX_RESULTS,
  CONTENT_SEARCH_SNIPPET_CHARS,
  searchChatContents,
} = await import('../lib/chat-content-search.js');

/**
 * Content search over one workspace: matches across chats, scoping, the archived flag,
 * the time / size limits, query validation and snippet trimming.
 */

const wsA = '/work/search-a';
const wsB = '/work/search-b';
const rows = [
  { id: 'a-1', title: 'Billing export', workspaceFile: wsA, agentTransport: 'opencode', updatedAt: '2026-03-01T00:00:00.000Z' },
  { id: 'a-2', title: 'Login bug', workspaceFile: wsA, agentTransport: 'opencode', updatedAt: '2026-03-02T00:00:00.000Z' },
  { id: 'a-3', title: 'Unrelated', workspaceFile: wsA, agentTransport: 'opencode', updatedAt: '2026-03-03T00:00:00.000Z' },
  { id: 'a-arch', title: 'Old invoices', workspaceFile: wsA, agentTransport: 'opencode', archivedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b-1', title: 'Other workspace', workspaceFile: wsB, agentTransport: 'opencode' },
];
await seedChatRows(rows);

const say = (chatId, text, kind = 'localUser') => appendChatHistoryEvents(chatId, 'sess-cs', [{ rec: { kind, text } }]);
await say('a-1', 'Please fix the zebra-ledger export for March.');
await say('a-2', 'The zebra-ledger login redirect loops.');
await say('a-3', 'Nothing relevant here.');
await say('a-arch', 'Archived zebra-ledger discussion.');
await say('b-1', 'Secret zebra-ledger of another workspace.');
// Tool output is not message text and must never surface.
await appendChatHistoryEvents('a-3', 'sess-cs', [{
  rec: { kind: 'sdk', event: { type: 'tool_call', name: 'bash', status: 'completed', call_id: 'c', args: { command: 'echo toolonlymarker' }, result: 'toolonlymarker' } },
}]);
await say('a-3', `${'pad '.repeat(400)}longmatch-token${' tail'.repeat(400)}`);

const app = express();
registerChatsRoutes(app, {
  widgetChatListScope,
  dataDir: '',
  agentSessions: new Map(),
  agentCmd: '',
  agentModel: '',
  workspaceDirForAgent: () => '/tmp',
  getCurrentWorkspaceFile: () => null,
  getCurrentCwd: () => '/tmp',
  buildAgentSpawnEnv: () => ({}),
});
const server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
const port = server.address().port;
const getJson = async (query) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/chats/content-search?${query}`);
  return { status: response.status, body: await response.json() };
};
const ws = (file, extra = '') => `workspaceFile=${encodeURIComponent(file)}${extra}`;

// Matches across chats, newest chat first, scoped to workspace A, archived excluded by default.
const found = await getJson(`q=zebra-ledger&${ws(wsA)}`);
assert.equal(found.status, 200);
assert.equal(found.body.ok, true);
assert.equal(found.body.untrusted, true);
assert.deepEqual(found.body.results.map((row) => row.chatId), ['a-2', 'a-1']);
assert.deepEqual(Object.keys(found.body.results[0]).sort(), ['at', 'chatId', 'snippet', 'title']);
assert.match(found.body.results[0].snippet, /zebra-ledger/);
assert.equal(found.body.results[0].at, '2026-03-02T00:00:00.000Z', 'hit is dated by chat activity when events carry no time');
assert.equal(found.body.results[0].title, 'Login bug');
assert.ok(!found.body.results.some((row) => row.chatId === 'b-1'), 'another workspace never appears');
assert.ok(!JSON.stringify(found.body).includes('Secret'), 'no text of another workspace leaks');

// Case-insensitive.
assert.equal((await getJson(`q=ZEBRA-LEDGER&${ws(wsA)}`)).body.results.length, 2);

// Archived chats only when asked.
const withArchived = await getJson(`q=zebra-ledger&${ws(wsA, '&archived=include')}`);
assert.deepEqual(withArchived.body.results.map((row) => row.chatId).sort(), ['a-1', 'a-2', 'a-arch']);

// Workspace B scope sees only its own chat.
assert.deepEqual((await getJson(`q=zebra-ledger&${ws(wsB)}`)).body.results.map((row) => row.chatId), ['b-1']);

// Tool args / results are not searched.
assert.equal((await getJson(`q=toolonlymarker&${ws(wsA)}`)).body.results.length, 0);

// Snippet is trimmed to the cap and carries the match.
const long = (await getJson(`q=longmatch-token&${ws(wsA)}`)).body.results[0];
assert.ok(long.snippet.length <= CONTENT_SEARCH_SNIPPET_CHARS, `snippet ${long.snippet.length} chars`);
assert.match(long.snippet, /longmatch-token/);
assert.ok(!/\s{2,}/.test(long.snippet), 'whitespace collapsed');

// Validation.
assert.equal((await getJson(`q=z&${ws(wsA)}`)).status, 400);
assert.equal((await getJson(`${ws(wsA)}`)).status, 400);
assert.equal((await getJson(`q=${'x'.repeat(CONTENT_SEARCH_MAX_QUERY_CHARS + 1)}&${ws(wsA)}`)).status, 400);
assert.equal((await getJson('q=zebra-ledger')).status, 400, 'a workspace is required');

// Limits: result cap, chat cap and the time budget (injected clock, injected reader).
const many = Array.from({ length: 60 }, (_, i) => ({ id: `m-${i}`, title: `m ${i}`, updatedAt: `2026-02-01T00:00:${String(i).padStart(2, '0')}.000Z` }));
const reader = async () => ({ events: [{ seq: 1, rec: { kind: 'localUser', text: 'needle here' } }] });
const capped = await searchChatContents({ chats: many, query: 'needle', readPage: reader });
assert.equal(capped.results.length, CONTENT_SEARCH_MAX_RESULTS);
assert.equal(capped.truncated, true);
let reads = 0;
const countingReader = async () => { reads += 1; return { events: [] }; };
const chatCapped = await searchChatContents({ chats: many, query: 'needle', readPage: countingReader });
assert.equal(reads, 40, 'at most 40 chats are scanned');
assert.equal(chatCapped.truncated, true);
let tick = 0;
const timed = await searchChatContents({
  chats: many, query: 'nomatch', readPage: reader, budgetMs: 100, now: () => { tick += 60; return tick; },
});
assert.ok(timed.scannedChats <= 2, `time budget stops the scan (${timed.scannedChats})`);
assert.equal(timed.truncated, true);
const throwing = await searchChatContents({ chats: many.slice(0, 2), query: 'x1', readPage: async () => { throw new Error('boom'); } });
assert.deepEqual(throwing.results, [], 'a failing chat read is skipped');

// F1: one oversized message is clipped to the budget BEFORE it is searched.
const { CONTENT_SEARCH_CHARS_PER_CHAT, findContentMatch } = await import('../lib/chat-content-search.js');
const huge = `${'a'.repeat(2_000_000)}beyond-cap-needle`;
assert.equal(findContentMatch([{ seq: 1, rec: { kind: 'localUser', text: huge } }], 'beyond-cap-needle'), null, 'match past the cap is not scanned');
const inside = findContentMatch([{ seq: 1, rec: { kind: 'localUser', text: `${'a'.repeat(1000)}inside-needle${'b'.repeat(2_000_000)}` } }], 'inside-needle');
assert.ok(inside && /inside-needle/.test(inside.snippet), 'match inside the cap is found');
let lowered = 0;
const spyText = new String('x'.repeat(2_000_000));
const origLower = String.prototype.toLowerCase;
String.prototype.toLowerCase = function patched() { if (this.length > CONTENT_SEARCH_CHARS_PER_CHAT) lowered += 1; return origLower.call(this); };
try { findContentMatch([{ seq: 1, rec: { kind: 'localUser', text: String(spyText) } }], 'zz'); } finally { String.prototype.toLowerCase = origLower; }
assert.equal(lowered, 0, 'no message longer than the budget is ever lowercased');

// F2: a read that never resolves cannot outlive the budget; partial results are kept.
const hanging = Array.from({ length: 3 }, (_, i) => ({ id: `h-${i}`, title: `h ${i}`, updatedAt: `2026-04-0${3 - i}T00:00:00.000Z` }));
const startedAt = Date.now();
const stuck = await searchChatContents({
  chats: hanging,
  query: 'needle',
  budgetMs: 150,
  readPage: async (id) => (id === 'h-0'
    ? { events: [{ seq: 1, rec: { kind: 'localUser', text: 'needle early' } }] }
    : new Promise(() => {})),
});
assert.ok(Date.now() - startedAt < 1500, 'returns near the budget, not after the stuck read');
assert.deepEqual(stuck.results.map((row) => row.chatId), ['h-0'], 'partial results are returned');
assert.equal(stuck.truncated, true);
assert.equal(stuck.timedOut, true);
// Deadline between events of a long page.
let calls = 0;
const slowClock = () => { calls += 1; return calls > 3 ? 10_000 : 0; };
const events = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, rec: { kind: 'localUser', text: i === 0 ? 'needle oldest' : 'filler' } }));
assert.equal(findContentMatch(events, 'needle', { isExpired: () => slowClock() > 100 }), null, 'expired deadline stops the event loop');

await new Promise((resolve) => server.close(resolve));
removeIsolatedDataDir();
console.log('chat-content-search-http.test.js OK');

registerChatsBackendTeardown();
