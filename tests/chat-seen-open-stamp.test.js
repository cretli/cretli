import './helpers/isolated-data-dir.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { loadChats, saveChats } from '../lib/persist/chats-legacy-store.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { widgetChatListScope } from '../lib/widget/widget-chat-scope.ts';

/**
 * POST /api/chats/:id/seen: a plain call only reads an unread result, while
 * `opened: true` also stamps a chat with nothing unread, at most once a minute.
 */

const MINUTE = 60_000;
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();

saveChats([
  { id: 'read', title: 'Read', workspaceFile: '/w', agentTransport: 'opencode', lastFinishedAt: iso(60 * MINUTE), lastSeenAt: iso(30 * MINUTE) },
  { id: 'recent', title: 'Recent', workspaceFile: '/w', agentTransport: 'opencode', lastSeenAt: iso(MINUTE / 2) },
  { id: 'never', title: 'Never', workspaceFile: '/w', agentTransport: 'opencode' },
  { id: 'unread', title: 'Unread', workspaceFile: '/w', agentTransport: 'opencode', lastFinishedAt: iso(MINUTE) },
]);

const app = express();
app.use(express.json());
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
const server = await new Promise((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const port = server.address().port;

/**
 * @param {string} id
 * @param {object} [body]
 * @returns {Promise<string>} `lastSeenAt` stored after the call
 */
async function postSeen(id, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/chats/${id}/seen`, {
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200);
  return String(loadChats().find((chat) => chat.id === id)?.lastSeenAt || '');
}

try {
  const seenOf = (id) => String(loadChats().find((chat) => chat.id === id)?.lastSeenAt || '');

  const readBefore = seenOf('read');
  assert.equal(await postSeen('read'), readBefore, 'a plain call has nothing to read');
  const readAfter = await postSeen('read', { opened: true });
  assert.ok(readAfter > readBefore, 'opening a read chat restarts its idle window');

  const recentBefore = seenOf('recent');
  assert.equal(await postSeen('recent', { opened: true }), recentBefore, 'one stamp a minute');

  assert.ok(await postSeen('never', { opened: true }), 'a chat without a finished run is stamped too');
  assert.ok(await postSeen('unread'), 'a plain call still reads an unread result');
  console.log('chat-seen-open-stamp.test.js: ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
  removeIsolatedDataDir();
}
