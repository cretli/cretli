import './helpers/isolated-data-dir.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { loadChats, saveChats } from '../lib/persist/chats-legacy-store.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { widgetChatListScope } from '../lib/widget/widget-chat-scope.ts';
import { toChatListDto } from '../lib/chat-list-dto.js';

/**
 * POST /api/chats/:id/archive-postpone: stamps `autoArchivePostponedAt` as a read
 * mark, leaving `updatedAt` (list paging order) and the read marker untouched.
 */

const UPDATED_AT = '2026-01-01T00:00:00.000Z';
const SEEN_AT = '2026-01-02T00:00:00.000Z';

saveChats([
  { id: 'idle', title: 'Idle', workspaceFile: '/w', agentTransport: 'opencode', updatedAt: UPDATED_AT, lastSeenAt: SEEN_AT },
  { id: 'gone', title: 'Gone', workspaceFile: '/w', agentTransport: 'opencode', archived: true, archivedAt: UPDATED_AT },
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

/** @param {string} id */
async function postpone(id) {
  return fetch(`http://127.0.0.1:${port}/api/chats/${id}/archive-postpone`, { method: 'POST' });
}

try {
  const before = Date.now();
  const response = await postpone('idle');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Date.parse(body.autoArchivePostponedAt) >= before - 1000);
  const row = loadChats().find((chat) => chat.id === 'idle');
  assert.equal(row?.autoArchivePostponedAt, body.autoArchivePostponedAt);
  assert.equal(row?.updatedAt, UPDATED_AT, 'postponing does not move the chat in the list');
  assert.equal(row?.lastSeenAt, SEEN_AT, 'postponing does not mark anything read');
  assert.equal(toChatListDto(row)?.autoArchivePostponedAt, body.autoArchivePostponedAt, 'the list DTO carries it');

  assert.equal((await postpone('gone')).status, 409, 'an archived chat cannot be postponed');
  assert.equal((await postpone('missing')).status, 404);
  console.log('chat-archive-postpone-route.test.js: ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
  removeIsolatedDataDir();
}
