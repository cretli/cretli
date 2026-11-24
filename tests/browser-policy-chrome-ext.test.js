/**
 * allowCretliChromeExtension policy key: default, update and inheritance.
 * (browser-policy-key.test.js cannot run under `node --test` because it loads the Claude WS module.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getWorkspacePolicy, resolveBrowserPolicy, setWorkspacePolicy } from '../lib/browser/policy-store.js';

const FILE_A = '/ws/acme.code-workspace';
const FILE_B = '/ws/acme-full.code-workspace';
const single = {
  workspaces: [{ kind: 'file', workspaceFile: FILE_A }],
  workspaceSidebarConfig: { [FILE_A]: { folders: { '/work/acme': { enabled: true } } } },
};
const ambiguous = {
  workspaces: [{ kind: 'file', workspaceFile: FILE_A }, { kind: 'file', workspaceFile: FILE_B }],
  workspaceSidebarConfig: {
    [FILE_A]: { folders: { '/work/acme': { enabled: true } } },
    [FILE_B]: { folders: { '/work/acme': { enabled: true } } },
  },
};

test('allowCretliChromeExtension defaults to false, updates and inherits like allowClaudeChrome', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-policy-ext-'));
  try {
    assert.equal(getWorkspacePolicy(dataDir, FILE_A).allowCretliChromeExtension, false);
    setWorkspacePolicy(dataDir, FILE_A, { allowCretliChromeExtension: true });
    assert.equal(getWorkspacePolicy(dataDir, FILE_A).allowCretliChromeExtension, true);
    // A patch without the key keeps it, and it is independent of allowClaudeChrome.
    setWorkspacePolicy(dataDir, FILE_A, { allowClaudeChrome: true });
    assert.equal(getWorkspacePolicy(dataDir, FILE_A).allowCretliChromeExtension, true);
    assert.equal(resolveBrowserPolicy(dataDir, '/work/acme', single).allowCretliChromeExtension, true);
    assert.equal(resolveBrowserPolicy(dataDir, '/work/acme', ambiguous).allowCretliChromeExtension, false);
    setWorkspacePolicy(dataDir, FILE_A, { allowCretliChromeExtension: false });
    assert.equal(getWorkspacePolicy(dataDir, FILE_A).allowCretliChromeExtension, false);
    setWorkspacePolicy(dataDir, FILE_B, { allowClaudeChrome: true });
    assert.equal(getWorkspacePolicy(dataDir, FILE_B).allowCretliChromeExtension, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
