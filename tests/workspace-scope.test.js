import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatWorkspaceScope, resolveWorkspaceScope } from '../lib/workspace-scope.js';

const idA = 'cretli:ws:11111111-1111-4111-8111-111111111111';
const idB = 'cretli:ws:22222222-2222-4222-8222-222222222222';
const settings = {
  workspaceFile: '/stale/global.code-workspace',
  workspaces: [
    { id: idA, kind: 'folders' },
    { id: idB, kind: 'folders' },
    { id: '/work/project.code-workspace', kind: 'file', workspaceFile: '/work/project.code-workspace' },
  ],
  workspaceSidebarConfig: {
    [idA]: { folders: { '/work/shared': { enabled: true }, '/work/a': { enabled: true } } },
    [idB]: { folders: { '/work/shared': { enabled: true } } },
    '/work/project.code-workspace': { folders: { '/work/project': { enabled: true } } },
  },
};

test('explicit workspace scope never falls back to global selection', () => {
  assert.deepEqual(resolveWorkspaceScope({}, settings), { ok: false, code: 'workspace-scope-required' });
});

test('workspace id, file, and folder conflicts are rejected', () => {
  assert.deepEqual(resolveWorkspaceScope({ workspaceId: idA, workspaceFile: '/work/project.code-workspace' }, settings), {
    ok: false,
    code: 'workspace-scope-conflict',
  });
  assert.deepEqual(resolveWorkspaceScope({ workspaceFile: '/work/project.code-workspace', workspaceFolder: '/work/a' }, settings), {
    ok: false,
    code: 'workspace-scope-conflict',
  });
});

test('a folder workspace id keeps its identity while its legacy workspace file stays empty', () => {
  assert.deepEqual(resolveWorkspaceScope({ workspaceId: idA, workspaceFolder: '/work/a' }, settings), {
    ok: true,
    workspaceId: idA,
    workspaceFile: null,
    folder: '/work/a',
    source: 'workspaceId',
    ambiguous: false,
  });
  assert.deepEqual(resolveWorkspaceScope({ workspaceId: 'cretli:ws:missing' }, settings), {
    ok: false,
    code: 'workspace-unknown',
  });
});

test('an ambiguous folder remains folder-scoped and carries no guessed workspace id', () => {
  assert.deepEqual(resolveWorkspaceScope({ workspaceFolder: '/work/shared' }, settings), {
    ok: true,
    workspaceId: '',
    workspaceFile: null,
    folder: '/work/shared',
    source: 'workspaceFolder',
    ambiguous: true,
  });
});

test('chat scope trusts an out-of-registry worktree folder', () => {
  assert.deepEqual(resolveChatWorkspaceScope({ workspaceFile: '/work/project.code-workspace', workspaceFolder: '/tmp/tree' }, settings), {
    ok: true,
    workspaceId: '/work/project.code-workspace',
    workspaceFile: '/work/project.code-workspace',
    folder: '/tmp/tree',
    source: 'chat',
    ambiguous: false,
  });
});

test('unknown file or id is rejected and an empty value is ignored', () => {
  assert.deepEqual(resolveWorkspaceScope({ workspaceFile: '/nowhere.code-workspace' }, settings), { ok: false, code: 'workspace-unknown' });
  assert.deepEqual(resolveWorkspaceScope({ workspaceId: '  ', workspaceFile: '', workspaceFolder: null }, settings), {
    ok: false,
    code: 'workspace-scope-required',
  });
  assert.deepEqual(resolveWorkspaceScope(undefined, settings), { ok: false, code: 'workspace-scope-required' });
});

test('id selects the workspace before file; matching id + file agree', () => {
  const byId = resolveWorkspaceScope({ workspaceId: '/work/project.code-workspace' }, settings);
  assert.equal(byId.source, 'workspaceId');
  const both = resolveWorkspaceScope({ workspaceId: '/work/project.code-workspace', workspaceFile: '/work/project.code-workspace' }, settings);
  assert.equal(both.ok, true);
  assert.equal(both.source, 'workspaceId');
});

test('file + member folder is ok and carries both values; a non-member folder conflicts', () => {
  assert.deepEqual(resolveWorkspaceScope({ workspaceFile: '/work/project.code-workspace', workspaceFolder: '/work/project' }, settings), {
    ok: true,
    workspaceId: '/work/project.code-workspace',
    workspaceFile: '/work/project.code-workspace',
    folder: '/work/project',
    source: 'workspaceFile',
    ambiguous: false,
  });
  assert.deepEqual(resolveWorkspaceScope({ workspaceId: idB, workspaceFolder: '/work/a' }, settings), {
    ok: false,
    code: 'workspace-scope-conflict',
  });
});

test('a folder in one workspace resolves to it; the global selection is never consulted', () => {
  const only = resolveWorkspaceScope({ workspaceFolder: '/work/a' }, settings);
  assert.equal(only.workspaceId, idA);
  assert.equal(only.ambiguous, false);
  // settings.workspaceFile points at a different (stale) workspace and must not leak in.
  assert.notEqual(only.workspaceFile, settings.workspaceFile);
  assert.equal(resolveWorkspaceScope({ workspaceFolder: '/nowhere' }, settings).workspaceId, '');
});

test('chat scope never conflicts and handles an empty chat', () => {
  assert.equal(resolveChatWorkspaceScope({ workspaceId: idA, workspaceFile: '/other.code-workspace', workspaceFolder: '/x' }, settings).ok, true);
  assert.equal(resolveChatWorkspaceScope(null, settings).ok, false);
});
