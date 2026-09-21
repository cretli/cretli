import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { saveChats } from '../lib/persist/chats-persist.js';
import { bumpChatHistoryRevision, clearChatHistoryRevision } from '../lib/persist/chat-history-revisions.js';
import { appendChatHistoryEvents, deleteChatHistory } from '../lib/persist/chat-history-persist.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { widgetChatListScope } from '../lib/widget/widget-chat-scope.js';

const ownChat = {
  id: 'chat-own',
  title: 'Own',
  widgetInstallationId: 'inst-1',
  widgetPageSessionId: 'page-1',
  workspaceFile: '/work/project.code-workspace',
  workspaceFolder: '/work/project',
  agentTransport: 'sdk',
};
const foreignChat = {
  id: 'chat-foreign',
  title: 'Foreign',
  widgetInstallationId: 'inst-2',
  widgetPageSessionId: 'page-2',
  workspaceFile: '/work/other.code-workspace',
  workspaceFolder: '/work/other',
  agentTransport: 'sdk',
};
saveChats([ownChat, foreignChat]);
bumpChatHistoryRevision(ownChat.id, 3);
bumpChatHistoryRevision(foreignChat.id, 9);

const access = {
  installationId: 'inst-1',
  pageSessionId: 'page-1',
  workspaceFile: '/work/project.code-workspace',
  workspaceFolder: '/work/project',
};

const app = express();
app.use((req, _res, next) => {
  if (req.headers['x-test-widget'] === '1') req.widgetAccess = access;
  next();
});
registerChatsRoutes(app, {
  widgetChatListScope,
  dataDir: '',
  agentSessions: new Map(),
  getCurrentAgentRunResumeId: () => '',
  setCurrentAgentRunResumeId: () => {},
  agentCmd: '',
  agentModel: '',
  workspaceDirForAgent: () => '/tmp',
  getCurrentWorkspaceFile: () => null,
  getCurrentCwd: () => '/tmp',
  buildAgentSpawnEnv: () => ({}),
});

const server = await new Promise((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const port = server.address().port;

/**
 * @param {string} path
 * @param {Record<string, string>} [headers]
 */
async function getJson(path, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

/**
 * @param {string} path
 * @param {object} body
 * @param {Record<string, string>} [headers]
 */
async function postJson(path, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const widgetOmit = await getJson('/api/chats/history-revisions', { 'x-test-widget': '1' });
assert.equal(widgetOmit.status, 200);
assert.equal(widgetOmit.body.ok, true);
assert.equal(widgetOmit.body.revisions[ownChat.id].headSeq, 3);
assert.equal(widgetOmit.body.revisions[foreignChat.id], undefined);

const widgetLeakAttempt = await getJson(
  `/api/chats/history-revisions?ids=${ownChat.id},${foreignChat.id}`,
  { 'x-test-widget': '1' },
);
assert.equal(widgetLeakAttempt.body.revisions[foreignChat.id], undefined);
assert.equal(widgetLeakAttempt.body.revisions[ownChat.id].headSeq, 3);

const mainOmit = await getJson('/api/chats/history-revisions');
assert.equal(mainOmit.body.revisions[ownChat.id].headSeq, 3);
assert.equal(mainOmit.body.revisions[foreignChat.id].headSeq, 9);

const agentOmit = await getJson('/api/chats/agent-states', { 'x-test-widget': '1' });
assert.equal(agentOmit.body.ok, true);
assert.equal(agentOmit.body.states[foreignChat.id], undefined);
for (const row of Object.values(agentOmit.body.states || {})) {
  assert.notEqual(row.state, 'idle');
}

appendChatHistoryEvents(ownChat.id, 'sess-own', [
  { rec: { kind: 'localUser', text: 'hello own' } },
]);
appendChatHistoryEvents(foreignChat.id, 'sess-foreign', [
  { rec: { kind: 'localUser', text: 'hello foreign' } },
]);

const emptyBatch = await postJson('/api/chats/history-batch', {}, { 'x-test-widget': '1' });
assert.equal(emptyBatch.status, 400);
assert.equal(emptyBatch.body.ok, false);

const widgetBatch = await postJson(
  '/api/chats/history-batch',
  {
    chats: [
      { id: ownChat.id, since: 0, limit: 10 },
      { id: foreignChat.id, since: 0, limit: 10 },
    ],
  },
  { 'x-test-widget': '1' },
);
assert.equal(widgetBatch.status, 200);
assert.equal(widgetBatch.body.ok, true);
assert.ok(widgetBatch.body.histories[ownChat.id]);
assert.equal(widgetBatch.body.histories[ownChat.id].events.length, 1);
assert.equal(widgetBatch.body.histories[foreignChat.id], undefined);

const mainBatch = await postJson('/api/chats/history-batch', {
  chats: [
    { id: ownChat.id, since: 0, limit: 10 },
    { id: foreignChat.id, since: 0, limit: 10 },
  ],
});
assert.equal(mainBatch.body.histories[ownChat.id].events.length, 1);
assert.equal(mainBatch.body.histories[foreignChat.id].events.length, 1);

const singleGet = await getJson(`/api/chats/${ownChat.id}/history?since=0&limit=10`);
assert.equal(singleGet.status, 200);
assert.equal(singleGet.body.ok, true);
assert.equal(singleGet.body.events.length, 1);

ownChat.summaries = [{ summary: 'heavy', at: '2026-01-01T00:00:00.000Z' }];
saveChats([ownChat, foreignChat]);
const listSlim = await getJson('/api/chats');
assert.equal(listSlim.status, 200);
assert.equal(listSlim.body.chats.find((row) => row.id === ownChat.id)?.summaries, undefined);
assert.equal(typeof listSlim.body.archivedCounts, 'object');
const listFull = await getJson('/api/chats?includeSummaries=1');
assert.equal(listFull.body.chats.find((row) => row.id === ownChat.id)?.summaries?.length, 1);

await new Promise((resolve) => server.close(resolve));
clearChatHistoryRevision(ownChat.id);
clearChatHistoryRevision(foreignChat.id);
deleteChatHistory(ownChat.id);
deleteChatHistory(foreignChat.id);
removeIsolatedDataDir();
console.log('chat-list-poll-http.test.js OK');
