import './helpers/isolated-data-dir.js';
/**
 * A todo agent started for another project's folder gets that project's
 * registry workspace (SQL registry), not the UI's current workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { listRegisteredWorkspacesForFolder, resolveWorkspaceForFolder } from '../lib/workspace-registry-service.js';

const ID_A = 'cretli:ws:11111111-1111-4111-8111-111111111111';
const ID_B = 'cretli:ws:22222222-2222-4222-8222-222222222222';
const ID_C = 'cretli:ws:33333333-3333-4333-8333-333333333333';

const settings = {
  workspaces: [
    { id: ID_A, kind: 'folders', label: 'cretli' },
    { id: ID_B, kind: 'folders', label: 'acme' },
    { id: ID_C, kind: 'folders', label: 'acme-copy' },
  ],
  workspaceSidebarConfig: {
    [ID_A]: { folders: { '/work/cretli': { enabled: true } } },
    [ID_B]: { folders: { '/work/acme': { enabled: true }, '/work/shared': { enabled: true } } },
    [ID_C]: { folders: { '/work/shared': { enabled: true }, '/work/off': { enabled: false } } },
  },
};

test('a folder resolves to the registry workspace that owns it', () => {
  assert.equal(resolveWorkspaceForFolder(settings, '/work/acme')?.id, ID_B);
  assert.equal(resolveWorkspaceForFolder(settings, '/work/cretli')?.id, ID_A);
});

test('an ambiguous or unknown folder resolves to nothing', () => {
  assert.equal(listRegisteredWorkspacesForFolder(settings, '/work/shared').length, 2);
  assert.equal(resolveWorkspaceForFolder(settings, '/work/shared'), null);
  assert.equal(resolveWorkspaceForFolder(settings, '/work/other'), null);
  assert.equal(resolveWorkspaceForFolder(settings, '/work/off'), null);
  assert.equal(resolveWorkspaceForFolder(settings, ''), null);
});

import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { loadChats, saveChats, migrateChatWorkspaceIds } from '../lib/persist/chats-persist.js';
import { resolveTodoChatWorkspace } from '../lib/routes/todos-routes.js';

const row = (id, extra) => ({ id, title: id, cursorSessionId: `s-${id}`, createdAt: '2026-01-01T00:00:00.000Z', ...extra });

function seedChats() {
  saveChats([
    row('one', { workspaceFolder: '/work/acme', workspaceFile: '/x/acme.code-workspace' }),
    row('amb', { workspaceFolder: '/work/shared' }),
    row('set', { workspaceFolder: '/work/acme', workspaceId: 'cretli:ws:keep' }),
    row('none', {}),
  ]);
}

test('migration defaults to dry-run and does not write', () => {
  seedChats();
  const report = migrateChatWorkspaceIds(settings);
  assert.equal(report.dryRun, true);
  assert.equal(report.updated, 1);
  assert.equal(loadChats().find((c) => c.id === 'one').workspaceId, undefined);
  assert.ok(fs.existsSync(path.join(ISOLATED_DATA_DIR, 'chats.json')));
});

test('apply writes only unambiguous folders and keeps existing fields', () => {
  seedChats();
  const report = migrateChatWorkspaceIds(settings, { dryRun: false });
  assert.deepEqual(report.assignments, [{ chatId: 'one', workspaceId: ID_B }]);
  assert.equal(report.ambiguous, 1);
  assert.equal(report.alreadySet, 1);
  assert.equal(report.noFolder, 1);
  const chats = loadChats();
  const one = chats.find((c) => c.id === 'one');
  assert.equal(one.workspaceId, ID_B);
  assert.equal(one.workspaceFile, '/x/acme.code-workspace');
  assert.equal(chats.find((c) => c.id === 'amb').workspaceId, undefined);
  assert.equal(chats.find((c) => c.id === 'set').workspaceId, 'cretli:ws:keep');
});

test('todo start resolves workspaceId from the registry and ignores the UI file', () => {
  const uiFile = '/ui/cretli.code-workspace';
  const other = resolveTodoChatWorkspace({ workspaceFolder: '/work/acme' }, uiFile, settings);
  assert.equal(other.workspaceId, ID_B);
  assert.notEqual(other.workspaceFile, uiFile);
  const unknown = resolveTodoChatWorkspace({ workspaceFolder: '/work/other' }, uiFile, settings);
  assert.deepEqual(unknown, { workspaceId: '', workspaceFile: null });
  const noFolder = resolveTodoChatWorkspace({}, uiFile, settings);
  assert.equal(noFolder.workspaceFile, uiFile);
});
