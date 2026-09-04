import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addFileWorkspace,
  addFolderWorkspace,
  createFolderWorkspaceId,
  findWorkspace,
  isFolderWorkspaceId,
  removeWorkspace,
  sanitizeWorkspaces,
  seedFileWorkspaces,
} from '../lib/persist/workspace-registry.js';

test('sanitizeWorkspaces keeps file entries and posix paths', () => {
  const actual = sanitizeWorkspaces([
    { kind: 'file', workspaceFile: 'C:\\proj\\app.code-workspace' },
    { kind: 'file', id: '/home/u/a.code-workspace' },
    { kind: 'nope', workspaceFile: '/x.code-workspace' },
    null,
  ]);
  assert.equal(actual.length, 2);
  assert.equal(actual[0].kind, 'file');
  assert.equal(actual[0].id, 'C:/proj/app.code-workspace');
  assert.equal(actual[0].workspaceFile, 'C:/proj/app.code-workspace');
  assert.equal(actual[1].id, '/home/u/a.code-workspace');
});

test('sanitizeWorkspaces keeps folder-only ids and drops invalid ones', () => {
  const actual = sanitizeWorkspaces([
    { kind: 'folders', id: 'cretli:ws:abc' },
    { kind: 'folders', id: '/not-a-virtual-id' },
    { kind: 'folders' },
  ]);
  assert.deepEqual(actual, [{ id: 'cretli:ws:abc', kind: 'folders' }]);
});

test('sanitizeWorkspaces dedupes by id', () => {
  const actual = sanitizeWorkspaces([
    { kind: 'file', workspaceFile: '/a.code-workspace' },
    { kind: 'file', workspaceFile: '/a.code-workspace' },
  ]);
  assert.equal(actual.length, 1);
});

test('createFolderWorkspaceId uses the cretli:ws prefix', () => {
  const id = createFolderWorkspaceId();
  assert.equal(isFolderWorkspaceId(id), true);
  assert.notEqual(id, createFolderWorkspaceId());
});

test('seedFileWorkspaces builds file entries from scan paths', () => {
  const actual = seedFileWorkspaces(['/w/one.code-workspace', '', '/w/two.code-workspace']);
  assert.deepEqual(actual.map((item) => item.id), ['/w/one.code-workspace', '/w/two.code-workspace']);
});

test('addFileWorkspace appends a new file and is idempotent', () => {
  const first = addFileWorkspace([], '/proj/app.code-workspace');
  const second = addFileWorkspace(first, '/proj/app.code-workspace');
  assert.equal(second.length, 1);
  assert.equal(findWorkspace(second, '/proj/app.code-workspace')?.kind, 'file');
});

test('addFolderWorkspace appends a virtual workspace', () => {
  const actual = addFolderWorkspace([], { id: 'cretli:ws:shop', label: 'Shop' });
  assert.deepEqual(actual, [{ id: 'cretli:ws:shop', kind: 'folders', label: 'Shop' }]);
});

test('removeWorkspace drops a registry entry without touching others', () => {
  const list = [
    { kind: 'file', workspaceFile: '/a.code-workspace' },
    { kind: 'folders', id: 'cretli:ws:1' },
  ];
  const actual = removeWorkspace(list, '/a.code-workspace');
  assert.deepEqual(actual, [{ id: 'cretli:ws:1', kind: 'folders' }]);
});
