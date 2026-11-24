import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspaceDefaultFolder } from '../app_front/features/chat/newChatDefaultFolder.js';

const folders = [
  { resolvedPath: '/w/projects', enabled: true },
  { resolvedPath: '/w/site', enabled: true },
  { resolvedPath: '/w/off', enabled: false },
];

test('uses the configured default folder', () => {
  assert.equal(resolveWorkspaceDefaultFolder({ folders, defaultFolder: '/w/site/' }), '/w/site');
});

test('falls back to the first enabled folder when the default is missing or disabled', () => {
  assert.equal(resolveWorkspaceDefaultFolder({ folders }), '/w/projects');
  assert.equal(resolveWorkspaceDefaultFolder({ folders, defaultFolder: '/w/off' }), '/w/projects');
});

test('falls back to the workspace directory without folders', () => {
  assert.equal(resolveWorkspaceDefaultFolder({ folders: [], workspaceDir: '/w' }), '/w');
  assert.equal(resolveWorkspaceDefaultFolder(null), '');
});
