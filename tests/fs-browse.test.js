import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createBrowseFolder,
  homeBrowseDir,
  isAgentSandboxHome,
  isValidBrowseFolderName,
  listAbsoluteBrowseDir,
  normalizeBrowseDir,
  resolveExistingBrowseDir,
  toBrowsePosix,
} from '../lib/fs-browse.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

test('normalizeBrowseDir: empty and ~ map to the home directory', () => {
  assert.equal(normalizeBrowseDir(''), homeBrowseDir());
  assert.equal(normalizeBrowseDir('~'), homeBrowseDir());
  assert.equal(normalizeBrowseDir('~/x'), path.join(homeBrowseDir(), 'x'));
  assert.equal(normalizeBrowseDir('/abs/path'), '/abs/path');
});

test('toBrowsePosix normalizes separators and a trailing slash', () => {
  assert.equal(toBrowsePosix('C:\\proj\\app'), 'C:/proj/app');
  assert.equal(toBrowsePosix('/home/u/'), '/home/u');
});

test('listAbsoluteBrowseDir lists a temp directory: dirs first, hidden excluded', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-browse-'));
  await mkdir(path.join(dir, 'zeta'));
  await mkdir(path.join(dir, 'alpha'));
  await writeFile(path.join(dir, 'app.code-workspace'), '{"folders":[]}', 'utf8');
  await writeFile(path.join(dir, '.hidden'), 'x', 'utf8');
  await writeFile(path.join(dir, 'readme.txt'), 'hi', 'utf8');

  const result = listAbsoluteBrowseDir(dir);
  assert.equal(result.ok, true);
  assert.equal(result.home, toBrowsePosix(homeBrowseDir()));
  assert.equal(result.path, toBrowsePosix(dir));
  const names = result.entries.map((entry) => entry.name);
  assert.ok(names.indexOf('.hidden') === -1, 'hidden entries excluded by default');
  // directories come first, alphabetically, then files
  assert.deepEqual(names, ['alpha', 'zeta', 'app.code-workspace', 'readme.txt']);
  const fileEntry = result.entries.find((entry) => entry.name === 'app.code-workspace');
  assert.equal(fileEntry.isDir, false);
  assert.equal(fileEntry.path, toBrowsePosix(path.join(dir, 'app.code-workspace')));
  assert.equal(typeof fileEntry.sizeBytes, 'number');
});

test('listAbsoluteBrowseDir: includeHidden shows dot entries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-browse-hidden-'));
  await writeFile(path.join(dir, '.env'), 'x', 'utf8');
  const visible = listAbsoluteBrowseDir(dir);
  assert.equal(visible.entries.some((entry) => entry.name === '.env'), false);
  const hidden = listAbsoluteBrowseDir(dir, { includeHidden: true });
  assert.equal(hidden.entries.some((entry) => entry.name === '.env'), true);
});

test('listAbsoluteBrowseDir: ~/missing walks to login home', () => {
  const result = listAbsoluteBrowseDir('~/this-folder-should-not-exist-cretli-picker');
  assert.equal(result.ok, true);
  assert.equal(result.path, toBrowsePosix(homeBrowseDir()));
});

test('listAbsoluteBrowseDir: canGoUp false at the filesystem root', () => {
  const root = path.parse(process.cwd()).root || '/';
  const result = listAbsoluteBrowseDir(root);
  assert.equal(result.ok, true);
  assert.equal(result.canGoUp, false);
  assert.equal(result.parent, toBrowsePosix(root));
});

test('homeBrowseDir is a real directory and skips the agent sandbox', () => {
  const home = homeBrowseDir();
  assert.equal(fs.existsSync(home), true);
  assert.equal(fs.statSync(home).isDirectory(), true);
  assert.equal(isAgentSandboxHome(resolveDataPath('runtime-home')), true);
  assert.equal(isAgentSandboxHome('/root'), true);
  if (home !== '/') {
    assert.equal(isAgentSandboxHome(home), false);
  }
});

test('listAbsoluteBrowseDir walks up from a missing path or a file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-browse-err-'));
  await writeFile(path.join(dir, 'readme.txt'), 'x', 'utf8');
  const missing = listAbsoluteBrowseDir(path.join(dir, 'nope', 'nested'));
  assert.equal(missing.ok, true);
  assert.equal(missing.path, toBrowsePosix(dir));
  assert.equal(missing.entries.some((entry) => entry.name === 'readme.txt'), true);
  const filePath = path.join(dir, 'readme.txt');
  const fromFile = listAbsoluteBrowseDir(filePath);
  assert.equal(fromFile.ok, true);
  assert.equal(fromFile.path, toBrowsePosix(dir));
  assert.equal(resolveExistingBrowseDir(path.join(dir, 'missing-leaf')), dir);
});

test('isValidBrowseFolderName rejects empty, dots, separators and overlong names', () => {
  assert.equal(isValidBrowseFolderName('alpha'), true);
  assert.equal(isValidBrowseFolderName('  alpha  '), true);
  assert.equal(isValidBrowseFolderName(''), false);
  assert.equal(isValidBrowseFolderName('.'), false);
  assert.equal(isValidBrowseFolderName('..'), false);
  assert.equal(isValidBrowseFolderName('foo/bar'), false);
  assert.equal(isValidBrowseFolderName('foo\\bar'), false);
  assert.equal(isValidBrowseFolderName('a'.repeat(256)), false);
});

test('createBrowseFolder creates one directory and rejects unsafe names', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cretli-mkdir-'));
  const created = createBrowseFolder(dir, 'new-app');
  assert.equal(created.ok, true);
  assert.equal(created.path, toBrowsePosix(path.join(dir, 'new-app')));
  assert.equal(fs.statSync(path.join(dir, 'new-app')).isDirectory(), true);
  const listed = listAbsoluteBrowseDir(dir);
  assert.equal(listed.entries.some((entry) => entry.name === 'new-app'), true);
  const duplicate = createBrowseFolder(dir, 'new-app');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'exists');
  const nested = createBrowseFolder(dir, 'a/b');
  assert.equal(nested.ok, false);
  assert.equal(nested.error, 'invalid-name');
  assert.equal(fs.existsSync(path.join(dir, 'a')), false);
  const missingParent = createBrowseFolder(path.join(dir, 'nope'), 'x');
  assert.equal(missingParent.ok, false);
  assert.equal(missingParent.error, 'not-found');
});
