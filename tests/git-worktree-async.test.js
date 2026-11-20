import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  collectWorktreeExecutionDiff,
  collectWorktreeExecutionDiffAsync,
  listWorktreeStatusEntries,
  listWorktreeStatusEntriesAsync,
  logSlowGitCall,
  runGit,
  runGitAsync,
} from '../lib/worktree/git-worktree.ts';
import { writePatchScope, writePatchScopeAsync } from '../lib/worktree/patch-scope.ts';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { createScopeFixture } from './helpers/patch-scope-fixture.js';

/** Alias that makes Git sleep, so the call is slow without a huge repository. */
const sleepArgs = (seconds) => ['-c', `alias.nap=!sleep ${seconds}`, 'nap'];

function captureWarnings(t) {
  const lines = [];
  const original = console.warn;
  console.warn = (...parts) => { lines.push(parts.join(' ')); };
  t.after(() => { console.warn = original; });
  return lines;
}

test('runGitAsync keeps the event loop running while Git works; runGit does not', async (t) => {
  const { dir } = createTempRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  t.after(() => clearInterval(timer));
  const result = await runGitAsync(sleepArgs(0.5), dir, { allowFailure: true });
  assert.equal(result.status, 0);
  assert.ok(ticks >= 5, `timer fired ${ticks} times during the async call`);
  const before = ticks;
  runGit(sleepArgs(0.2), dir, { allowFailure: true });
  assert.equal(ticks, before, 'the synchronous call starves the timer');
});

test('runGitAsync mirrors runGit results and errors', async (t) => {
  const { dir } = createTempRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sync = runGit(['rev-parse', '--verify', 'HEAD'], dir);
  const async = await runGitAsync(['rev-parse', '--verify', 'HEAD'], dir);
  assert.deepEqual(async, sync);
  const failed = await runGitAsync(['rev-parse', '--verify', 'no-such-ref'], dir, { allowFailure: true });
  assert.notEqual(failed.status, 0);
  await assert.rejects(
    () => runGitAsync(['rev-parse', '--verify', 'no-such-ref'], dir),
    (error) => error.code === 'WORKTREE_GIT_FAILED' || /failed in/.test(error.message),
  );
  const hashed = await runGitAsync(['hash-object', '--stdin'], dir, { input: 'hello\n' });
  assert.equal(hashed.stdout.trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('slow Git calls log one line with the subcommand and cwd basename only', async (t) => {
  const { dir } = createTempRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = captureWarnings(t);
  await runGitAsync(sleepArgs(1.1), dir, { allowFailure: true });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^\[slow-git\] git nap async took \d+ms in /);
  assert.ok(lines[0].endsWith(path.basename(dir)));
  assert.ok(!lines[0].includes(dir), 'the full cwd is not logged');
  assert.ok(!lines[0].includes('sleep'), 'option values are not logged');
  logSlowGitCall(['status'], dir, 10);
  assert.equal(lines.length, 1, 'a fast call logs nothing');
});

test('async diff, status and patch scope match their sync twins', async (t) => {
  const { dir, baseCommit } = createScopeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await listWorktreeStatusEntriesAsync(dir), listWorktreeStatusEntries(dir));
  const syncDiff = collectWorktreeExecutionDiff({ worktreePath: dir, baseCommit });
  const asyncDiff = await collectWorktreeExecutionDiffAsync({ worktreePath: dir, baseCommit });
  assert.deepEqual(asyncDiff, syncDiff);
  const patchPath = path.join(dir, '..', `async-scope-${process.pid}.patch`);
  t.after(() => fs.rmSync(patchPath, { force: true }));
  fs.writeFileSync(patchPath, syncDiff.patch);
  const result = { patchPath, patchSha256: createHash('sha256').update(syncDiff.patch).digest('hex') };
  const syncScope = JSON.parse(fs.readFileSync(writePatchScope(result), 'utf8'));
  const asyncScope = JSON.parse(fs.readFileSync(await writePatchScopeAsync(result), 'utf8'));
  assert.deepEqual(asyncScope, syncScope);
  assert.equal(await writePatchScopeAsync({ ...result, patchSha256: 'bad' }), null);
});
