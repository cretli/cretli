import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathInsideBase, listWorkspaceEntries, resolveExistingDir } from '../lib/files-list.js';

const inputRoot = mkdtempSync(path.join(os.tmpdir(), 'cretli-files-list-'));
mkdirSync(path.join(inputRoot, 'src'));
writeFileSync(path.join(inputRoot, 'readme.md'), 'hi');
writeFileSync(path.join(inputRoot, '.hidden'), 'x');

const actualMissing = listWorkspaceEntries({ basePath: path.join(inputRoot, 'nope') });
assert.equal(actualMissing.ok, false);
assert.equal(actualMissing.error, 'no-workspace');
assert.deepEqual(actualMissing.entries, []);

const actualEmptyDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-files-empty-'));
const actualEmpty = listWorkspaceEntries({ basePath: actualEmptyDir });
assert.equal(actualEmpty.ok, true);
assert.deepEqual(actualEmpty.entries, []);

const actualList = listWorkspaceEntries({ basePath: inputRoot });
assert.equal(actualList.ok, true);
assert.deepEqual(actualList.entries.map((row) => row.name), ['src', 'readme.md']);
assert.equal(actualList.entries[0].isDir, true);
assert.equal(actualList.entries[1].isDir, false);

const actualHidden = listWorkspaceEntries({ basePath: inputRoot, includeHidden: true });
assert.equal(actualHidden.entries.some((row) => row.name === '.hidden'), true);

const actualOutside = listWorkspaceEntries({
  basePath: inputRoot,
  relDir: '..',
});
assert.equal(actualOutside.ok, false);
assert.equal(actualOutside.error, 'outside');

assert.equal(isPathInsideBase(inputRoot, inputRoot), true);
assert.equal(isPathInsideBase(inputRoot, path.join(inputRoot, 'src')), true);
assert.equal(isPathInsideBase(inputRoot, path.resolve(inputRoot, '..')), false);
assert.equal(resolveExistingDir(inputRoot), path.resolve(inputRoot));
assert.equal(resolveExistingDir(path.join(inputRoot, 'missing')), '');

console.log('files-list.test.js: ok');
