import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { saveChats } from '../lib/persist/chats-persist.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { widgetChatListScope } from '../lib/widget/widget-chat-scope.js';

/**
 * Proves the server-side archive window on GET /api/chats:
 * - `includeArchived=1` WITHOUT `archiveWorkspace` still returns the full index
 *   (backward compatible) with `fullIndex: true`.
 * - `includeArchived=1&archiveWorkspace=<file>` returns every live row plus only
 *   the archived rows of that workspace, with `fullIndex: false` (a partial
 *   payload must never drive activity pruning).
 * The reduction is asserted at the route/payload layer, not in e2e.
 */

const wsA = '/work/project-a';
const wsB = '/work/project-b';

const rows = [
  { id: 'a-live-1', title: 'A live 1', workspaceFile: wsA, agentTransport: 'opencode' },
  { id: 'a-live-2', title: 'A live 2', workspaceFile: wsA, agentTransport: 'opencode' },
  { id: 'a-arch-1', title: 'A arch 1', workspaceFile: wsA, agentTransport: 'opencode', archivedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'a-arch-2', title: 'A arch 2', workspaceFile: wsA, agentTransport: 'opencode', archivedAt: '2026-01-02T00:00:00.000Z' },
  { id: 'b-live-1', title: 'B live 1', workspaceFile: wsB, agentTransport: 'opencode' },
  { id: 'b-arch-1', title: 'B arch 1', workspaceFile: wsB, agentTransport: 'opencode', archivedAt: '2026-01-03T00:00:00.000Z' },
  { id: 'b-arch-2', title: 'B arch 2', workspaceFile: wsB, agentTransport: 'opencode', archivedAt: '2026-01-04T00:00:00.000Z' },
  { id: 'b-arch-3', title: 'B arch 3', workspaceFile: wsB, agentTransport: 'opencode', archivedAt: '2026-01-05T00:00:00.000Z' },
];
saveChats(rows);

const app = express();
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
 * @returns {Promise<{ status: number, body: any }>}
 */
async function getJson(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
}

/**
 * @param {Array<{ id: string }>} chats
 * @returns {string[]}
 */
const idsOf = (chats) => [...new Set((chats || []).map((chat) => chat.id))].sort();

// 1) Backward compatible: unscoped includeArchived returns the full index.
const fullIndex = await getJson('/api/chats?includeArchived=1');
assert.equal(fullIndex.status, 200);
assert.equal(fullIndex.body.ok, true);
assert.equal(fullIndex.body.fullIndex, true, 'unscoped archived load is the authoritative full index');
assert.deepEqual(idsOf(fullIndex.body.chats), rows.map((row) => row.id).sort(), 'full index carries every archived row of every workspace');

// 2) Scoped window: live rows of all workspaces + archived rows of the scope only.
const scoped = await getJson(`/api/chats?includeArchived=1&archiveWorkspace=${encodeURIComponent(wsA)}`);
assert.equal(scoped.status, 200);
assert.equal(scoped.body.ok, true);
assert.equal(scoped.body.fullIndex, false, 'a scoped window is partial and must not prune activity');
assert.deepEqual(idsOf(scoped.body.chats), ['a-arch-1', 'a-arch-2', 'a-live-1', 'a-live-2', 'b-live-1'],
  'scoped payload keeps live rows across workspaces but only the scoped workspace archived rows');
// Workspace B archived rows are dropped from the window (the payload reduction).
assert.deepEqual(
  idsOf(scoped.body.chats).filter((id) => id.startsWith('b-arch')),
  [],
  'other workspaces archived rows are excluded from the scoped window',
);

// 3) archivedCounts stays global so collapsed groups keep their count badge.
const countsFor = (prefix) => Object.entries(scoped.body.archivedCounts || {})
  .filter(([key]) => key.startsWith(`${prefix}\n`))
  .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
assert.equal(countsFor(wsA), 2, 'scoped response still reports the full archived count for workspace A');
assert.equal(countsFor(wsB), 3, 'scoped response still reports the full archived count for workspace B');

// 4) Normalization tolerance: trailing slash and backslashes still match the scope.
const scopedTrailing = await getJson(`/api/chats?includeArchived=1&archiveWorkspace=${encodeURIComponent(`${wsA}/`)}`);
assert.deepEqual(idsOf(scopedTrailing.body.chats), ['a-arch-1', 'a-arch-2', 'a-live-1', 'a-live-2', 'b-live-1'],
  'trailing slash on the scope is normalized away');
const scopedBackslash = await getJson(`/api/chats?includeArchived=1&archiveWorkspace=${encodeURIComponent(wsA.replace(/\//g, '\\'))}`);
assert.deepEqual(idsOf(scopedBackslash.body.chats), ['a-arch-1', 'a-arch-2', 'a-live-1', 'a-live-2', 'b-live-1'],
  'backslash separators on the scope are normalized away');

// 5) Scope without includeArchived is inert: unchanged live-only boot list.
const liveOnlyScoped = await getJson(`/api/chats?archiveWorkspace=${encodeURIComponent(wsA)}`);
assert.equal(liveOnlyScoped.body.fullIndex, false);
assert.deepEqual(idsOf(liveOnlyScoped.body.chats), ['a-live-1', 'a-live-2', 'b-live-1'],
  'archiveWorkspace is ignored unless includeArchived is set');

await new Promise((resolve) => server.close(resolve));
removeIsolatedDataDir();
console.log('chat-archive-scope-http.test.js OK');
