import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ConversationForkError,
  executeConversationFork,
} from '../lib/conversation-fork-execute.js';
import { parseRelatedChatPayload } from '../lib/chat-relation-history.js';
import { appendChatHistoryEvents, loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { loadChats, saveChats } from '../lib/persist/chats-persist.js';

function seedParent(withEvents) {
  const id = randomUUID();
  saveChats([...loadChats(), {
    id, title: 'Big chat', cursorSessionId: `sess-${id}`, agentTransport: 'claude', model: 'm',
    workspaceFolder: '/tmp/ws', createdAt: new Date().toISOString(),
    summaries: [{ summary: 'old summary', at: new Date().toISOString() }],
  }]);
  const parent = loadChats().find((row) => row.id === id);
  if (withEvents) appendChatHistoryEvents(id, parent.cursorSessionId, [{ rec: { kind: 'localUser', text: 'hello' } }]);
  return parent;
}

const parent = seedParent(true);
const forked = await executeConversationFork({ parentChat: parent, mode: 'reference', message: 'go' });
assert.equal(forked.chat.forkKind, 'reference');
assert.equal(forked.chat.summaries, undefined);
const childEvents = loadChatHistory(forked.chat.id)?.events || [];
assert.equal(childEvents.some((row) => row.rec?.kind === 'localUser'), false);
const link = childEvents.find((row) => row.rec?.variant === 'relatedChat');
assert.equal(parseRelatedChatPayload(link.rec.payload).chatId, parent.id);
assert.match(forked.initialPrompt, /New user message:\ngo/);
assert.match(forked.initialPrompt, new RegExp(`chat_history\\(\\{ chat: "${parent.id}" \\}\\)`));
assert.match(forked.initialPrompt, new RegExp(`chat_show\\(\\{ chat: "${parent.id}" \\}\\)`));

const before = loadChats().length;
const empty = seedParent(false);
const afterSeed = loadChats().length;
await assert.rejects(
  executeConversationFork({ parentChat: empty, mode: 'reference' }),
  (err) => err instanceof ConversationForkError && err.status === 409 && err.code === 'reference_requires_saved_history',
);
await assert.rejects(
  executeConversationFork({ parentChat: parent, mode: 'bogus' }),
  (err) => err instanceof ConversationForkError && err.status === 400,
);
assert.equal(loadChats().length, afterSeed, 'no chat row is created on failure');
assert.ok(afterSeed > before);

// Missing mode keeps the copy-history behavior.
const plain = await executeConversationFork({ parentChat: parent });
assert.equal(plain.chat.forkKind, 'conversation');
assert.equal((loadChatHistory(plain.chat.id)?.events || []).some((row) => row.rec?.kind === 'localUser'), true);

// Explicit invalid modes and analyze + reference are rejected before any chat row exists.
for (const badMode of ['', 5, null, 'bogus']) {
  await assert.rejects(
    executeConversationFork({ parentChat: parent, mode: badMode }),
    (err) => err instanceof ConversationForkError && err.status === 400,
    `mode ${JSON.stringify(badMode)}`,
  );
}
await assert.rejects(
  executeConversationFork({ parentChat: parent, mode: 'reference', analyze: true }),
  (err) => err instanceof ConversationForkError && err.status === 400,
);
assert.equal(loadChats().length, afterSeed + 1, 'only the plain fork above added a row');

// Reference forks inherit auto-compression settings but not summaries.
const compressing = seedParent(true);
saveChats(loadChats().map((row) => (row.id === compressing.id
  ? { ...row, autoContextCompressionEnabled: true, autoContextCompressionThreshold: 80 } : row)));
const compressed = await executeConversationFork({ parentChat: loadChats().find((row) => row.id === compressing.id), mode: 'reference' });
const storedChild = loadChats().find((row) => row.id === compressed.chat.id);
assert.equal(storedChild.autoContextCompressionEnabled, true);
assert.equal(storedChild.autoContextCompressionThreshold, 80);
assert.equal(storedChild.summaries, undefined);

// HTTP mapping of the typed errors.
const { registerChatsRoutes } = await import('../lib/routes/chats-routes.js');
const routes = new Map();
registerChatsRoutes({ get() {}, post: (r, h) => routes.set(`POST ${r}`, h), patch() {}, put() {}, delete() {} }, {});
async function postFork(id, body) {
  const res = { statusCode: 200, body: null, status(c) { res.statusCode = c; return res; }, json(v) { res.body = v; return res; } };
  await routes.get('POST /api/chats/:id/fork')({ params: { id }, body, headers: {}, query: {} }, res);
  return res;
}
const before409 = loadChats().length;
assert.equal((await postFork(empty.id, { mode: 'reference' })).statusCode, 409);
assert.equal((await postFork(parent.id, { mode: 5 })).statusCode, 400);
assert.equal((await postFork(parent.id, { mode: '' })).statusCode, 400);
assert.equal(loadChats().length, before409, 'no chat row on HTTP failure');
const ok = await postFork(parent.id, { mode: 'reference' });
assert.equal(ok.statusCode, 200);
assert.equal(ok.body.chat.forkKind, 'reference');

console.log('conversation-fork-reference.test.js OK');
