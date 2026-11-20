import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTempRepo, git, tempDir } from './helpers/temp-git-repo.js';
import { integrateGitResult, recoverMaterializationIntent } from '../lib/integration/git-integrator.js';

const lines = (...xs) => `${xs.join('\n')}\n`;
const base = lines(...Array.from({ length: 20 }, (_, i) => `line${i + 1}`));

function setup(t, wipText) {
  const { dir: repo } = createTempRepo({ file: 'shared.txt', content: base });
  // Keep checkouts byte-identical to the LF fixtures regardless of the host's autocrlf.
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'user.name', 'Cretli Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  const dataDir = tempDir('cretli-wip-data-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  // The patch edits line 2 of shared.txt.
  const patchedText = base.replace('line2\n', 'line2-patched\n');
  fs.writeFileSync(path.join(repo, 'shared.txt'), patchedText);
  const patchPath = path.join(dataDir, 'p.patch');
  fs.writeFileSync(patchPath, git(repo, ['diff', '--binary']));
  fs.writeFileSync(path.join(repo, 'shared.txt'), wipText);
  fs.writeFileSync(path.join(repo, 'other.txt'), 'staged\n');
  git(repo, ['add', 'other.txt']);
  return { repo, dataDir, patchPath };
}

const run = (f, extra = {}) => integrateGitResult({ workspaceFolder: f.repo, dataDir: f.dataDir, todoId: 't1', result: { patchPath: f.patchPath, patchSha256: 'x', cycleId: 'c1' }, gates: () => {}, ...extra });

test('WIP in another region of the same file: integrates, WIP preserved, index untouched', async (t) => {
  const wip = base.replace('line18\n', 'line18-wip\n');
  const f = setup(t, wip);
  const indexBefore = git(f.repo, ['ls-files', '-s', 'other.txt']);
  const inodeBefore = fs.statSync(path.join(f.repo, 'shared.txt')).ino;
  const out = await run(f);
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(f.repo, 'shared.txt'), 'utf8'), base.replace('line2\n', 'line2-patched\n').replace('line18\n', 'line18-wip\n'));
  assert.equal(fs.statSync(path.join(f.repo, 'shared.txt')).ino, inodeBefore);
  // The commit holds the patch only, never the WIP.
  assert.equal(git(f.repo, ['show', 'HEAD:shared.txt']), base.replace('line2\n', 'line2-patched\n'));
  // Author and committer come from the repository config, never a hardcoded bot identity.
  assert.equal(git(f.repo, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']).trim(), 'Cretli Test <test@example.com>|Cretli Test <test@example.com>');
  assert.equal(git(f.repo, ['ls-files', '-s', 'other.txt']), indexBefore);
  assert.equal(git(f.repo, ['diff', '--cached', '--name-only']).trim(), 'other.txt');
  assert.match(git(f.repo, ['diff', '--', 'shared.txt']), /\+line18-wip/);
  const carry = path.join(f.dataDir, 'worktree-results', '_carry');
  const copies = fs.readdirSync(carry);
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(carry, copies[0], 'shared.txt'), 'utf8'), wip);
});

test('overlapping hunks refuse with a diagnosis and leave the tree untouched', async (t) => {
  const wip = base.replace('line2\n', 'line2-wip\n');
  const f = setup(t, wip);
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  const indexBefore = git(f.repo, ['ls-files', '-s']);
  await assert.rejects(run(f), (error) => {
    assert.equal(error.code, 'protected_workspace_change');
    assert.match(error.artifacts, /shared\.txt: patch hunks overlap uncommitted changes at merged lines/);
    return true;
  });
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.readFileSync(path.join(f.repo, 'shared.txt'), 'utf8'), wip);
  assert.equal(git(f.repo, ['ls-files', '-s']), indexBefore);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'worktree-results', '_carry')), false);
});

const wipRegion = base.replace('line18\n', 'line18-wip\n');
const merged = base.replace('line2\n', 'line2-patched\n').replace('line18\n', 'line18-wip\n');

test('file edited after the check is not overwritten; merged copy is kept in _carry', async (t) => {
  const f = setup(t, wipRegion);
  const edited = `${wipRegion}user typed this\n`;
  await assert.rejects(run(f, { afterPublish: () => fs.writeFileSync(path.join(f.repo, 'shared.txt'), edited) }), (error) => {
    assert.equal(error.code, 'materialization_mismatch');
    assert.match(error.artifacts, /shared\.txt \(merged copy: /);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(f.repo, 'shared.txt'), 'utf8'), edited);
  const carry = path.join(f.dataDir, 'worktree-results', '_carry');
  const [dir] = fs.readdirSync(carry);
  assert.equal(fs.readFileSync(path.join(carry, dir, '_merged', 'shared.txt'), 'utf8'), merged);
});

test('crash after publish: recovery completes the WIP merge when the file is still untouched', async (t) => {
  const f = setup(t, wipRegion);
  await assert.rejects(run(f, { afterPublish: () => { throw new Error('crash'); } }));
  assert.equal(fs.readFileSync(path.join(f.repo, 'shared.txt'), 'utf8'), wipRegion);
  const recovered = await recoverMaterializationIntent({ workspaceFolder: f.repo });
  assert.equal(recovered.recovered, true);
  assert.equal(fs.readFileSync(path.join(f.repo, 'shared.txt'), 'utf8'), merged);
});

test('without a dataDir integration still works and leaves no merged store behind', async (t) => {
  const f = setup(t, wipRegion);
  const out = await run(f, { dataDir: undefined });
  assert.equal(out.ok, true);
  assert.equal(fs.readFileSync(path.join(f.repo, 'shared.txt'), 'utf8'), merged);
  assert.deepEqual(fs.readdirSync(path.join(f.repo, '.git')).filter((name) => name.startsWith('cretli-wip-merged')), []);
});
