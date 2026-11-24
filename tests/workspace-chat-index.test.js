import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-ws-chat-index-'));
process.env.CRETLI_DATA_DIR = dir;
process.env.CURSOR_REMOTE_DATA_DIR = dir;
const { listChatsByWorkspaceMatchKey, workspaceChatIndexStats } = await import('../lib/workspace-chat-index.js');
const chatsPersist = await import('../lib/persist/chats-persist.js');
const { defaultWorkspaceWatcherSnapshotDeps } = await import('../lib/workspace-watcher.js');

const norm = (folder) => String(folder ?? '').toLowerCase();

test('groups by raw folder, skips pinned and id-less rows, canonicalizes once per distinct folder', () => {
  const rows = [
    { id: 'a', workspaceFolder: '/W/one' },
    { id: 'b', workspaceFolder: '/w/ONE' },
    { id: 'c', workspaceFolder: '/w/two' },
    { id: 'd', workspaceFolder: '/w/one', watcherPinned: true },
    { id: '  ', workspaceFolder: '/w/one' },
  ];
  let calls = 0;
  const matchKeyOf = (f) => { calls += 1; return norm(f); };
  const out = listChatsByWorkspaceMatchKey(rows, matchKeyOf, '/w/one');
  assert.deepEqual(out.map((c) => c.id).sort(), ['a', 'b']);
  assert.equal(calls, 3, 'one canonicalization per distinct raw folder, not per chat');
});

test('index is reused for the same rows array and rebuilt for a new one', () => {
  const rows = [{ id: 'a', workspaceFolder: '/x' }];
  const before = { ...workspaceChatIndexStats };
  listChatsByWorkspaceMatchKey(rows, norm, '/x');
  listChatsByWorkspaceMatchKey(rows, norm, '/x');
  assert.equal(workspaceChatIndexStats.builds - before.builds, 1);
  assert.equal(workspaceChatIndexStats.hits - before.hits, 1);
  const next = [...rows, { id: 'b', workspaceFolder: '/x' }];
  assert.deepEqual(listChatsByWorkspaceMatchKey(next, norm, '/x').map((c) => c.id), ['a', 'b']);
});

test('snapshot deps never serve a stale chat list after chat writes', async () => {
  const ws = path.join(dir, 'ws-a');
  fs.mkdirSync(ws, { recursive: true });
  const other = path.join(dir, 'ws-b');
  fs.mkdirSync(other, { recursive: true });
  const at = new Date().toISOString();
  const row = (id, workspaceFolder, extra = {}) => ({ id, title: id, workspaceFolder, createdAt: at, updatedAt: at, ...extra });
  await chatsPersist.saveChatsAsync([row('c1', ws), row('c2', other)]);
  const deps = defaultWorkspaceWatcherSnapshotDeps(dir);
  assert.deepEqual(await deps.listWorkspaceChatIds(ws), ['c1']);
  // Writer adds a chat to the workspace.
  await chatsPersist.saveChatsAsync([row('c1', ws), row('c2', other), row('c3', ws)]);
  assert.deepEqual((await deps.listWorkspaceChatIds(ws)).sort(), ['c1', 'c3']);
  // Writer moves a chat to another folder and pins another.
  await chatsPersist.saveChatsAsync([row('c1', other), row('c2', other), row('c3', ws, { watcherPinned: true })]);
  assert.deepEqual(await deps.listWorkspaceChatIds(ws), []);
  assert.deepEqual((await deps.listWorkspaceChatIds(other)).sort(), ['c1', 'c2']);
});
