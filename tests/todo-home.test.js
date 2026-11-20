import test from 'node:test';
import assert from 'node:assert/strict';
import { findPinConflicts, resolveTodoHome, todoHomeConflicts } from '../lib/todo-home.js';

const DIRS = new Set(['/p/a', '/p/b', '/p/shared', '/p/solo', '/w']);
const registry = [
  { id: '/w/one.code-workspace', kind: 'file', workspaceFile: '/w/one.code-workspace' },
  { id: '/w/two.code-workspace', kind: 'file', workspaceFile: '/w/two.code-workspace' },
  { id: 'cretli:ws:solo', kind: 'folders' },
];
const FILE_FOLDERS = {
  '/w/one.code-workspace': ['/p/a', '/p/b'],
  '/w/two.code-workspace': ['/p/b'],
};
const loadFileFolders = (file) => FILE_FOLDERS[file] || [];
const base = (sidebarConfig) => ({ registry, sidebarConfig, existsSet: DIRS, loadFileFolders });
const sidebar = {
  '/w/one.code-workspace': { folder: '/p/a', folders: { '/p/a': {}, '/p/b': {} } },
  '/w/two.code-workspace': { folder: '/p/b', folders: { '/p/b': {} } },
  'cretli:ws:solo': { folder: '/p/solo', folders: { '/p/solo': {} } },
};

test('explicit workspace id resolves to its home; secondary caller folder becomes the execution folder', () => {
  const r = resolveTodoHome({ workspaceId: '/w/one.code-workspace', workspaceFolder: '/p/b' }, base(sidebar));
  assert.deepEqual(r, { ok: true, workspaceId: '/w/one.code-workspace', homeFolder: '/p/a', executionFolder: '/p/b', folders: ['/p/a', '/p/b'], source: 'workspace' });
});

test('workspaceFile and bare home folder resolve to the owning workspace', () => {
  assert.equal(resolveTodoHome({ workspaceFile: '/w/two.code-workspace' }, base(sidebar)).homeFolder, '/p/b');
  assert.equal(resolveTodoHome({ workspaceFolder: '/p/solo' }, base(sidebar)).workspaceId, 'cretli:ws:solo');
});

test('a folder contained in exactly one workspace maps to it, in several requires a workspace', () => {
  const only = { ...sidebar, '/w/two.code-workspace': { folder: '/p/shared', folders: { '/p/shared': {} } } };
  FILE_FOLDERS['/w/two.code-workspace'] = ['/p/shared'];
  const r = resolveTodoHome({ workspaceFolder: '/p/b' }, base(only));
  assert.equal(r.workspaceId, '/w/one.code-workspace');
  FILE_FOLDERS['/w/two.code-workspace'] = ['/p/b'];
  const many = resolveTodoHome({ workspaceFolder: '/p/zzz' }, base(sidebar));
  assert.equal(many.source, 'unregistered-folder');
  const both = { ...sidebar, '/w/two.code-workspace': { folder: '/p/shared', folders: { '/p/shared': {}, '/p/b': {} } } };
  const r2 = resolveTodoHome({ workspaceFolder: '/p/b' }, base(both));
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'workspace_required');
});

test('an unregistered folder keeps today\'s behaviour', () => {
  const r = resolveTodoHome({ workspaceFolder: '/elsewhere' }, base(sidebar));
  assert.equal(r.ok, true);
  assert.equal(r.source, 'unregistered-folder');
  assert.equal(r.homeFolder, '/elsewhere');
});

test('workspaces pinned to one folder both get todo_home_shared; pins are checked', () => {
  const shared = { ...sidebar, '/w/two.code-workspace': { folder: '/p/a', folders: { '/p/a': {} } } };
  const conflicts = todoHomeConflicts(registry, shared, { existsSet: DIRS });
  assert.deepEqual([...conflicts.get('/p/a')].sort(), ['/w/one.code-workspace', '/w/two.code-workspace']);
  for (const id of ['/w/one.code-workspace', '/w/two.code-workspace']) {
    const r = resolveTodoHome({ workspaceId: id }, base(shared));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'todo_home_shared');
  }
  assert.deepEqual(findPinConflicts({ registry, sidebarConfig: sidebar, workspaceId: '/w/two.code-workspace', folder: '/p/a', existsSet: DIRS }), ['/w/one.code-workspace']);
  assert.deepEqual(findPinConflicts({ registry, sidebarConfig: sidebar, workspaceId: '/w/two.code-workspace', folder: '/p/shared', existsSet: DIRS }), []);
});

test('no input at all requires a workspace', () => {
  assert.equal(resolveTodoHome({}, base(sidebar)).code, 'workspace_required');
});

test('workspaces without any existing folder get no home and never conflict on the server cwd', () => {
  const reg = [{ id: 'cretli:ws:x', kind: 'folders' }, { id: 'cretli:ws:y', kind: 'folders' }];
  const ctx = { registry: reg, sidebarConfig: {}, existsSet: new Set() };
  assert.equal(todoHomeConflicts(reg, {}, { existsSet: new Set() }).size, 0);
  const r = resolveTodoHome({ workspaceId: 'cretli:ws:x' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'workspace_required');
});
