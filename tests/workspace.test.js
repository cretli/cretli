import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { loadWorkspace, resolveWorkspaceFolderPath } from '../lib/workspace.js';

test('resolveWorkspaceFolderPath keeps POSIX absolute paths', () => {
  const actual = resolveWorkspaceFolderPath('/ws', '/home/user/www/example.com');
  assert.equal(actual, path.resolve('/home/user/www/example.com'));
});

test('resolveWorkspaceFolderPath maps a Windows drive path to WSL on Linux', () => {
  if (process.platform === 'win32') return;
  const actual = resolveWorkspaceFolderPath('/ws', 'C:\\Users\\user\\project');
  assert.equal(actual, path.resolve('/mnt/c/Users/user/project'));
});

test('resolveWorkspaceFolderPath maps a file:// Windows URI to WSL on Linux', () => {
  if (process.platform === 'win32') return;
  const actual = resolveWorkspaceFolderPath('/ws', 'file:///C:/Users/user/project');
  assert.equal(actual, path.resolve('/mnt/c/Users/user/project'));
});

test('loadWorkspace parses JSONC and does not break https URLs in strings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-ws-jsonc-'));
  const filePath = path.join(dir, 'app.code-workspace');
  await writeFile(filePath, `{
    // comment
    "folders": [{ "path": ".", "name": "Root" }],
    "settings": { "homepage": "https://example.com" }
  }`, 'utf8');
  const actual = loadWorkspace(filePath);
  assert.equal(actual.folders[0].name, 'Root');
  assert.equal(actual.folders[0].resolvedPath, path.resolve(dir));
});
