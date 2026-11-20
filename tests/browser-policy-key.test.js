import './helpers/isolated-data-dir.js';
/**
 * Browser policy key resolution: a folder-only scope (Watcher or folder chats)
 * falls back to the policy of the single registry workspace that contains it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  browserScopeKey,
  getWorkspacePolicy,
  listFolderOverrides,
  migratePolicyStore,
  normalizeWorkspaceKey,
  resolveBrowserPolicy,
  resolveBrowserPolicyKey,
  setWorkspacePolicy,
} from '../lib/browser/policy-store.js';
import { normalizeWorkspaceKey as storageNormalizeKey } from '../lib/browser/storage-state.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';
import { resolveRoomClaudeChrome } from '../lib/claude/claude-agent-ws.ts';

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
    setWorkspacePolicy(dataDir, FILE_A, { allowClaudeChrome: true });
    assert.equal(resolveBrowserPolicy(dataDir, '/work/acme', singleSettings).allowClaudeChrome, true);
    assert.equal(resolveBrowserPolicy(dataDir, FILE_A, singleSettings).allowExternalBrowser, true);
  });
});

test('ambiguous folder never inherits external consent', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, FILE_A, { allowExternalBrowser: true });
    assert.equal(resolveBrowserPolicy(dataDir, '/work/acme', settings).allowExternalBrowser, false);
    setWorkspacePolicy(dataDir, FILE_A, { allowClaudeChrome: true });
    assert.equal(resolveBrowserPolicy(dataDir, '/work/acme', settings).allowClaudeChrome, false);
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

test('opaque folder workspace ids stay verbatim while filesystem keys resolve', () => {
  const id = 'cretli:ws:11111111-1111-4111-8111-111111111111';
  assert.equal(normalizeWorkspaceKey(id), id);
  assert.equal(normalizeWorkspaceKey('relative/folder'), path.resolve('relative/folder'));
  const realPath = path.resolve('projects/cretli:ws:folder');
  assert.equal(normalizeWorkspaceKey(realPath), realPath);
});

const ID = 'cretli:ws:11111111-1111-4111-8111-111111111111';
const ID_B = 'cretli:ws:22222222-2222-4222-8222-222222222222';
const registry = { workspaces: [{ id: ID, kind: 'folders' }] };

test('a cretli:ws: key is identical under two working directories, in both stores', () => {
  const original = process.cwd();
  const keys = [];
  try {
    for (const dir of [os.tmpdir(), path.parse(original).root]) {
      process.chdir(dir);
      keys.push([normalizeWorkspaceKey(ID), storageNormalizeKey(ID)]);
    }
  } finally {
    process.chdir(original);
  }
  assert.deepEqual(keys[0], [ID, ID]);
  assert.deepEqual(keys[1], [ID, ID]);
});

test('legacy cwd-prefixed ids: registered key migrates, unregistered one is quarantined, rerun is a no-op', () => {
  withDataDir((dataDir) => {
    const file = path.join(dataDir, 'browser-policy.json');
    const legacy = path.join(path.parse(process.cwd()).root, 'previous-server-cwd', ID);
    const orphan = path.join(path.parse(process.cwd()).root, 'previous-server-cwd', ID_B);
    const realPath = path.join(path.parse(process.cwd()).root, 'projects', 'cretli:ws:folder');
    writeFileSync(file, JSON.stringify({
      v: 1,
      workspaces: {
        [legacy]: { allowExternalBrowser: true },
        [orphan]: { allowClaudeChrome: true },
        [realPath]: { allowClaudeChrome: true },
      },
    }));

    assert.equal(migratePolicyStore(dataDir, registry), true);
    let stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(stored.workspaces).sort(), [ID, realPath].sort());
    assert.deepEqual(stored.legacyKeys, { [orphan]: { allowClaudeChrome: true } });
    assert.equal(getWorkspacePolicy(dataDir, ID).allowExternalBrowser, true);
    // The quarantined entry is never applied as a policy.
    assert.equal(getWorkspacePolicy(dataDir, ID_B).allowClaudeChrome, false);

    const before = readFileSync(file, 'utf8');
    assert.equal(migratePolicyStore(dataDir, registry), false);
    assert.equal(readFileSync(file, 'utf8'), before);

    // legacyKeys survives a save, and an existing plain entry wins over a legacy one.
    setWorkspacePolicy(dataDir, ID, { allowClaudeChrome: true });
    stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(stored.legacyKeys, { [orphan]: { allowClaudeChrome: true } });
    assert.equal(getWorkspacePolicy(dataDir, ID).allowExternalBrowser, true);
    assert.equal(getWorkspacePolicy(dataDir, ID).allowClaudeChrome, true);
  });
});

test('resolving a key migrates registered legacy entries on the way', () => {
  withDataDir((dataDir) => {
    const legacy = path.join(path.parse(process.cwd()).root, 'old-cwd', ID);
    writeFileSync(path.join(dataDir, 'browser-policy.json'), JSON.stringify({
      v: 1,
      workspaces: { [legacy]: { allowExternalBrowser: true } },
    }));
    assert.equal(resolveBrowserPolicy(dataDir, ID, registry).allowExternalBrowser, true);
  });
});

const chat = { workspaceFile: FILE_A, workspaceFolder: '/work/acme' };

test('a chat with workspace + folder resolves to the workspace key everywhere, a folder-only chat to the folder entry', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, FILE_A, { allowClaudeChrome: true, allowedOrigins: ['http://localhost:3010'] });
    setWorkspacePolicy(dataDir, '/work/acme', { allowedOrigins: ['http://localhost:4000'] });

    // Shared scope key: agent tools, session manager and Claude Chrome check all use it.
    assert.equal(browserScopeKey({ ...chat, cwd: '/work/acme' }), FILE_A);
    assert.equal(new BrowserSessionManager({}).resolveWorkspaceKey({ ...chat, cwd: '/tmp/tree' }), FILE_A);
    assert.equal(resolveBrowserPolicyKey(dataDir, browserScopeKey(chat), settings), FILE_A);

    const seen = [];
    const allows = (key) => {
      seen.push(key);
      return resolveBrowserPolicy(dataDir, key, singleSettings).allowClaudeChrome === true;
    };
    assert.equal(resolveRoomClaudeChrome({ chatId: 'c1', cwd: '/work/acme' }, chat, 'agent', allows), true);
    assert.deepEqual(seen, [FILE_A]);

    // Folder-only chat: the folder entry applies.
    const folderOnly = { workspaceFolder: '/work/acme' };
    assert.equal(browserScopeKey(folderOnly), '/work/acme');
    assert.equal(new BrowserSessionManager({}).resolveWorkspaceKey({ workspaceFolder: '/work/acme', cwd: '/tmp/tree' }), '/work/acme');
    assert.equal(resolveBrowserPolicyKey(dataDir, browserScopeKey(folderOnly), singleSettings), '/work/acme');
    assert.deepEqual(resolveBrowserPolicy(dataDir, '/work/acme', singleSettings).allowedOrigins, ['http://localhost:4000']);
  });
});

test('ambiguous folder with both workspaces consenting keeps both flags off unless its own entry sets them', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, FILE_A, { allowExternalBrowser: true, allowClaudeChrome: true });
    setWorkspacePolicy(dataDir, FILE_B, { allowExternalBrowser: true, allowClaudeChrome: true });
    let policy = resolveBrowserPolicy(dataDir, '/work/acme', settings);
    assert.equal(policy.allowExternalBrowser, false);
    assert.equal(policy.allowClaudeChrome, false);

    setWorkspacePolicy(dataDir, '/work/acme', { allowedOrigins: ['http://localhost:4000'], allowLocalhost: false });
    policy = resolveBrowserPolicy(dataDir, '/work/acme', settings);
    assert.equal(policy.allowExternalBrowser, false);
    assert.equal(policy.allowClaudeChrome, false);
    assert.deepEqual(policy.allowedOrigins, ['http://localhost:4000']);
    assert.equal(policy.allowLocalhost, false);

    setWorkspacePolicy(dataDir, '/work/acme', { allowExternalBrowser: true });
    policy = resolveBrowserPolicy(dataDir, '/work/acme', settings);
    assert.equal(policy.allowExternalBrowser, true);
    assert.equal(policy.allowClaudeChrome, false);
  });
});

test('saving a workspace policy leaves a folder override in place and lists it', () => {
  withDataDir((dataDir) => {
    setWorkspacePolicy(dataDir, '/work/acme', { allowedOrigins: ['http://localhost:4000'] });
    setWorkspacePolicy(dataDir, FILE_A, { allowedOrigins: ['http://localhost:3010'] });
    assert.deepEqual(getWorkspacePolicy(dataDir, '/work/acme').allowedOrigins, ['http://localhost:4000']);
    assert.deepEqual(listFolderOverrides(dataDir, FILE_A, singleSettings), ['/work/acme']);
    assert.deepEqual(listFolderOverrides(dataDir, FILE_B, singleSettings), []);
  });
});
