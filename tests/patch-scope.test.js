import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parsePatchScope, writePatchScope } from '../lib/worktree/patch-scope.js';
import { collectWorktreeExecutionDiff } from '../lib/worktree/git-worktree.js';
import { git } from './helpers/temp-git-repo.js';

import { createScopeFixture } from './helpers/patch-scope-fixture.js';

function pathsOf(files) {
  return [...new Set(files.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))].sort();
}

test('scope matches a hand-written set and independent NUL-separated git oracle', (t) => {
  const { dir, baseCommit } = createScopeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diff = collectWorktreeExecutionDiff({ worktreePath: dir, baseCommit });
  // Ask Git to identify copies as well; the production collector need not enable copy detection.
  const trackedCopyPatch = git(dir, ['diff', '--binary', '-M', '-C', '--find-copies-harder', baseCommit]);
  const trackedDefault = git(dir, ['diff', '--binary', baseCommit, '--']);
  const patch = trackedCopyPatch + diff.patch.slice(trackedDefault.length);
  const expected = ['checkpoint.txt', 'modify.txt', 'rename old.txt', 'rename new.txt', 'copy source.txt', 'copy target.txt', 'delete.txt', 'binary.bin', 'untracked.txt', 'mode.sh', 'empty.txt', 'link.txt', 'space name.txt', 'zażółć.txt', 'tab\tquote".txt', 'ambiguous b/name.txt'].sort();
  const files = parsePatchScope(patch);
  assert.deepEqual(pathsOf(files), expected);
  const fields = git(dir, ['diff', '--name-status', '-z', '-M', baseCommit]).split('\0').filter(Boolean);
  const oracle = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    oracle.push(fields[i++]);
    if (/^[RC]/.test(status)) oracle.push(fields[i++]);
  }
  oracle.push(...git(dir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  // -M does not label copy origins; independently read -C to add that source to the authorization oracle.
  const copyFields = git(dir, ['diff', '--name-status', '-z', '-M', '-C', '--find-copies-harder', baseCommit]).split('\0').filter(Boolean);
  for (let i = 0; i < copyFields.length;) {
    const status = copyFields[i++];
    const first = copyFields[i++];
    if (/^[RC]/.test(status)) { if (status.startsWith('C')) oracle.push(first); i += 1; }
  }
  assert.deepEqual([...new Set(oracle)].sort(), expected);
  assert.equal(files.find((file) => file.path === 'link.txt').mode, '120000');
  assert.equal(files.find((file) => file.path === 'mode.sh').mode, '100755');
  assert.equal(files.find((file) => file.path === 'empty.txt').status, 'A');
  assert.equal(files.find((file) => file.path === 'binary.bin').binary, true);
  assert.equal(files.find((file) => file.path === 'copy target.txt').status, 'C');
  const patchPath = path.join(dir, 'scope.patch');
  fs.writeFileSync(patchPath, patch);
  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  const scopePath = writePatchScope({ patchPath, patchSha256 }, ['modify.txt']);
  assert.equal(scopePath, `${patchPath}.files.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(scopePath)), { patchSha256, files, conflicts: ['modify.txt'] });
  assert.equal(writePatchScope({ patchPath, patchSha256 }), scopePath);
  assert.deepEqual(JSON.parse(fs.readFileSync(scopePath)).conflicts, []);
});

test('quoted rename/copy headers, binary marker and empty mode-only entries retain paths', () => {
  const patch = 'diff --git "a/old\\tname" "b/new\\tname"\nsimilarity index 100%\nrename from "old\\tname"\nrename to "new\\tname"\n'
    + 'diff --git a/source b/target\nsimilarity index 100%\ncopy from source\ncopy to target\n'
    + 'diff --git a/data b/data\nindex 1234567..abcdef0 100644\nBinary files a/data and b/data differ\n'
    + 'diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\n'
    + 'diff --git a/mode b/mode\nold mode 100644\nnew mode 100755\n';
  assert.deepEqual(parsePatchScope(patch), [
    { path: 'new\tname', oldPath: 'old\tname', status: 'R', binary: false },
    { path: 'target', oldPath: 'source', status: 'C', binary: false },
    { path: 'data', status: 'M', binary: true },
    { path: 'empty', status: 'A', mode: '100644', binary: false },
    { path: 'mode', status: 'M', mode: '100755', binary: false },
  ]);
});
