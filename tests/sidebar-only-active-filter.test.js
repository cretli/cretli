/**
 * Unit tests for the "active workspace only" sidebar filter (pure part).
 *
 * Covers the search suspension, the preferred-folder key (clones resolve their
 * own folder), the show-all fallback when the active folder is not in the
 * catalog and the pass-through when the filter is off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterWorkspacesByActiveWorkspace,
  workspaceGroupFolder,
} from '../app_front/features/sidebar/sidebarOnlyActiveFilter.js';

const ACTIVE = '/home/me/projects/cretli';
const OTHER = '/home/me/projects/other';

/** Two groups: the active project and a sibling. */
function workspaces() {
  return [
    { sidebarKey: 'ws/cretli.code-workspace', workspaceFile: 'ws/cretli.code-workspace', workspaceDir: '/home/me/projects' },
    { sidebarKey: 'ws/other.code-workspace', workspaceFile: 'ws/other.code-workspace', workspaceDir: '/home/me/projects' },
  ];
}

const preferred = (sidebarKey) => (sidebarKey === 'ws/cretli.code-workspace' ? ACTIVE : OTHER);

test('filter keeps only the group whose resolved folder is the active one', () => {
  const result = filterWorkspacesByActiveWorkspace(workspaces(), {
    activeWorkspaceFolder: ACTIVE,
    searching: false,
    enabled: true,
    getPreferredWorkspaceFolder: preferred,
  });
  assert.equal(result.applied, true);
  assert.equal(result.fallback, false);
  assert.deepEqual(
    result.workspaces.map((workspace) => workspace.sidebarKey),
    ['ws/cretli.code-workspace'],
  );
});

test('filter is suspended while a search is active', () => {
  const result = filterWorkspacesByActiveWorkspace(workspaces(), {
    activeWorkspaceFolder: ACTIVE,
    searching: true,
    enabled: true,
    getPreferredWorkspaceFolder: preferred,
  });
  assert.equal(result.applied, false);
  assert.equal(result.workspaces.length, 2);
});

test('filter is off when the flag is disabled', () => {
  const result = filterWorkspacesByActiveWorkspace(workspaces(), {
    activeWorkspaceFolder: ACTIVE,
    searching: false,
    enabled: false,
    getPreferredWorkspaceFolder: preferred,
  });
  assert.equal(result.applied, false);
  assert.equal(result.workspaces.length, 2);
});

test('filter is suspended without an active workspace folder', () => {
  const result = filterWorkspacesByActiveWorkspace(workspaces(), {
    activeWorkspaceFolder: '',
    searching: false,
    enabled: true,
    getPreferredWorkspaceFolder: preferred,
  });
  assert.equal(result.applied, false);
  assert.equal(result.workspaces.length, 2);
});

test('a clone group resolves by its configured folder, not the shared file', () => {
  const rows = [
    { sidebarKey: 'ws/cretli.code-workspace', workspaceFile: 'ws/cretli.code-workspace', workspaceFolder: OTHER },
    { sidebarKey: 'ws/cretli.code-workspace::clone:acme', workspaceFile: 'ws/cretli.code-workspace', isClone: true },
  ];
  const preferredClone = (sidebarKey) => (
    sidebarKey.includes('::clone:') ? ACTIVE : OTHER
  );
  const result = filterWorkspacesByActiveWorkspace(rows, {
    activeWorkspaceFolder: ACTIVE,
    searching: false,
    enabled: true,
    getPreferredWorkspaceFolder: preferredClone,
  });
  assert.equal(result.applied, true);
  assert.deepEqual(result.workspaces.map((workspace) => workspace.sidebarKey), [
    'ws/cretli.code-workspace::clone:acme',
  ]);
});

test('an active folder outside the catalog falls back to all workspaces', () => {
  const result = filterWorkspacesByActiveWorkspace(workspaces(), {
    activeWorkspaceFolder: '/home/me/projects/unknown',
    searching: false,
    enabled: true,
    getPreferredWorkspaceFolder: preferred,
  });
  assert.equal(result.applied, false);
  assert.equal(result.fallback, true);
  assert.equal(result.workspaces.length, 2);
});

test('a folder-only group matches through workspaceFolder/workspaceDir', () => {
  const rows = [
    { sidebarKey: '', workspaceFile: '', workspaceDir: OTHER },
  ];
  assert.equal(workspaceGroupFolder(rows[0], () => ''), OTHER);
  const result = filterWorkspacesByActiveWorkspace(rows, {
    activeWorkspaceFolder: OTHER,
    searching: false,
    enabled: true,
    getPreferredWorkspaceFolder: () => '',
  });
  assert.equal(result.applied, true);
  assert.equal(result.workspaces.length, 1);
});

test('paths are compared after separator and trailing-slash normalization', () => {
  const result = filterWorkspacesByActiveWorkspace(
    [{ sidebarKey: 'k', workspaceFile: 'k', workspaceFolder: 'C:\\me\\project\\' }],
    {
      activeWorkspaceFolder: 'C:/me/project',
      searching: false,
      enabled: true,
      getPreferredWorkspaceFolder: () => '',
    },
  );
  assert.equal(result.applied, true);
  assert.equal(result.workspaces.length, 1);
});

test('worktree filter keeps only chats of the given worktree todo', async () => {
  const { filterChatsByWorktree, chatWorktreeTodoId } = await import(
    '../app_front/features/sidebar/sidebarOnlyActiveFilter.js'
  );
  const chats = [
    { id: 'a', todoId: 't1', onWorktree: true },
    { id: 'b', todoId: 't2', onWorktree: true },
    { id: 'c' },
  ];
  assert.deepEqual(filterChatsByWorktree(chats, 't1').map((c) => c.id), ['a']);
  assert.equal(filterChatsByWorktree(chats, '').length, 3);
  assert.equal(chatWorktreeTodoId(chats[0]), 't1');
  assert.equal(chatWorktreeTodoId({ todoId: 't1' }), '');
});
