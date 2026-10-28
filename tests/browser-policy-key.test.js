/**
 * Browser policy key resolution: a folder-only scope (Watcher or folder chats)
 * falls back to the policy of the single registry workspace that contains it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWorkspacePolicy, resolveBrowserPolicy, resolveBrowserPolicyKey, setWorkspacePolicy } from '../lib/browser/policy-store.js';

const FILE_A = '/ws/acme.code-workspace';
const FILE_B = '/ws/acme-full.code-workspace';

const settings = {
  workspaces: [
    { kind: 'file', workspaceFile: FILE_A },
    { kind: 'file', workspaceFile: FILE_B },
  ],
  workspaceSidebarConfig: {
    [FILE_A]: { folders: { '/work/acme': { enabled: true } } },
    [FILE_B]: { folders: { '/work/acme': { enabled: true }, '/work/shared': { enabled: true } } },
  },
};
const singleSettings = {
  workspaces: [{ kind: 'file', workspaceFile: FILE_A }],
  workspaceSidebarConfig: { [FILE_A]: { folders: { '/work/acme': { enabled: true } } } },
};

function withDataDir(fn) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-policy-key-'));
  try {
    fn(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('a folder without its own entry uses the one registry workspace that has a policy', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, FILE_A, { allowedOrigins: ['http://localhost:3010'] });
    const key = resolveBrowserPolicyKey(dataDir, '/work/acme', settings);
    assert.equal(key, FILE_A);
    assert.deepEqual(getWorkspacePolicy(dataDir, key).allowedOrigins, ['http://localhost:3010']);
  });
});

test('a folder entry of its own wins over the registry workspace', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, FILE_A, { allowedOrigins: ['http://localhost:3010'] });
    setWorkspacePolicy(dataDir, '/work/acme', { allowedOrigins: ['http://localhost:4000'] });
    assert.equal(resolveBrowserPolicyKey(dataDir, '/work/acme', settings), '/work/acme');
  });
});

test('several candidate policies are never guessed', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, FILE_A, { allowedOrigins: ['http://localhost:3010'] });
    setWorkspacePolicy(dataDir, FILE_B, { allowedOrigins: ['http://localhost:3020'] });
    assert.equal(resolveBrowserPolicyKey(dataDir, '/work/acme', settings), '/work/acme');
    assert.deepEqual(getWorkspacePolicy(dataDir, '/work/acme').allowedOrigins, []);
  });
});

test('workspace keys and unknown folders resolve to themselves', () => {
  withDataDir((dataDir) => {
    assert.equal(resolveBrowserPolicyKey(dataDir, FILE_A, settings), FILE_A);
    assert.equal(resolveBrowserPolicyKey(dataDir, '/work/other', settings), '/work/other');
    assert.equal(resolveBrowserPolicyKey(dataDir, '', settings), '');
  });
});

test('folder inherits only external consent from its single registered workspace', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, '/work/acme', { allowedOrigins: ['https://example.com'] });
    setWorkspacePolicy(dataDir, FILE_A, { allowExternalBrowser: true, allowedOrigins: ['https://other.example'] });
    const policy = resolveBrowserPolicy(dataDir, '/work/acme', singleSettings);
    assert.equal(policy.allowExternalBrowser, true);
    assert.deepEqual(policy.allowedOrigins, ['https://example.com']);
    assert.equal(resolveBrowserPolicy(dataDir, FILE_A, singleSettings).allowExternalBrowser, true);
  });
});

test('ambiguous folder never inherits external consent', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, FILE_A, { allowExternalBrowser: true });
    assert.equal(resolveBrowserPolicy(dataDir, '/work/acme', settings).allowExternalBrowser, false);
  });
});

test('folder without workspace consent stays denied, but its own consent grants access', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, FILE_A, { allowedOrigins: ['https://example.com'] });
    assert.equal(resolveBrowserPolicy(dataDir, '/work/acme', singleSettings).allowExternalBrowser, false);
    setWorkspacePolicy(dataDir, '/work/acme', { allowExternalBrowser: true });
    assert.equal(resolveBrowserPolicy(dataDir, '/work/acme', singleSettings).allowExternalBrowser, true);
  });
});

test('workspace-file key does not inherit consent from a folder entry', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, '/work/acme', { allowExternalBrowser: true });
    assert.equal(resolveBrowserPolicy(dataDir, FILE_A, singleSettings).allowExternalBrowser, false);
  });
});
