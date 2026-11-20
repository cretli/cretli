import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { samePath } from '../lib/same-path.js';
import { isChatInWorkspace } from '../lib/mcp/builtin/tool-context.js';
import { filterChatsForWorkspace } from '../lib/mcp/builtin/chat-scope.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-workspace-scope-'));
const workspace = path.join(root, 'workspace');
const other = path.join(root, 'other');
fs.mkdirSync(workspace);
fs.mkdirSync(other);
const alias = path.join(root, 'workspace-alias');
fs.symlinkSync(workspace, alias, 'dir');

test('samePath resolves home, symlink and trailing separator aliases', () => {
  assert.equal(samePath(alias + path.sep, workspace), true);
  if (workspace.startsWith(os.homedir() + path.sep)) {
    assert.equal(samePath(`~${workspace.slice(os.homedir().length)}`, workspace), true);
  }
});

test('chat scope accepts folder aliases and falls through to workspace file', () => {
  assert.equal(isChatInWorkspace({ workspaceFolder: alias }, workspace), true);
  assert.equal(isChatInWorkspace({ workspaceFolder: other, workspaceFile: path.join(root, 'project.code-workspace') }, workspace, path.join(root, 'project.code-workspace')), true);
  assert.deepEqual(filterChatsForWorkspace([
    { id: 'same', workspaceFolder: alias },
    { id: 'other', workspaceFolder: other },
  ], workspace).map((chat) => chat.id), ['same']);
});

test('chat scope still rejects a different real folder', () => {
  assert.equal(isChatInWorkspace({ workspaceFolder: other }, workspace), false);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
