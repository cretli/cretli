import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  BASELINE_CONTROL_ID,
  BASELINE_TEMP_PREFIX,
  classifyReviewVerify,
  extractBaseCommit,
  sweepBaselineTempDirs,
} from '../lib/review-verify-baseline.js';
import { createTempRepo, commitFile, git } from './helpers/temp-git-repo.js';

after(removeIsolatedDataDir);

const projectRoot = path.resolve(import.meta.dirname, '..');
const CATALOG = {
  [BASELINE_CONTROL_ID]: 'tests/todo-ref.test.js',
  notices: 'tests/notices.test.js',
  'model-stats': 'tests/model-stats.test.js',
};

/**
 * @param {{ present?: string[], failing?: Record<string, number|string>, tmpDir: string, cacheDir: string, extractError?: boolean }} opts
 * failing: id -> number of runs (of the first N) that fail, or 'always'
 */
function makeDeps(opts) {
  const calls = { extract: 0, spawn: [] };
  const counters = {};
  const present = opts.present || Object.keys(CATALOG);
  return {
    calls,
    deps: {
      tmpDir: opts.tmpDir,
      cacheDir: opts.cacheDir,
      async extract({ dest }) {
        calls.extract += 1;
        if (opts.extractError) throw new Error('bad object');
        for (const id of present) {
          fs.mkdirSync(path.join(dest, 'tests'), { recursive: true });
          fs.writeFileSync(path.join(dest, CATALOG[id]), '');
        }
      },
      async spawnFile({ filePath }) {
        const id = Object.keys(CATALOG).find((key) => filePath.endsWith(CATALOG[key]));
        calls.spawn.push(id);
        counters[id] = (counters[id] || 0) + 1;
        const spec = (opts.failing || {})[id];
        const fails = spec === 'always' || (typeof spec === 'number' && counters[id] <= spec)
          || spec === 'env';
        if (spec === 'env') return { ok: false, output: 'Error: ENOENT no such file', error: 'exit 1' };
        return fails ? { ok: false, output: 'boom', error: 'exit 1' } : { ok: true, output: 'ok' };
      },
    },
  };
}

function rawFailing(...ids) {
  return { ok: false, results: ids.map((id) => ({ id, ok: false, durationMs: 1, outputTail: 'x' })), error: 'x' };
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-baseline-test-'));
  const tmpDir = path.join(base, 'tmp');
  const cacheDir = path.join(base, 'cache');
  fs.mkdirSync(tmpDir);
  return { base, tmpDir, cacheDir };
}

test('baseline-only failure -> passed with preexistingFailures; temp dir removed', async () => {
  const env = setup();
  const { deps } = makeDeps({ ...env, failing: { notices: 'always' } });
  const raw = rawFailing('notices');
  const frozen = JSON.stringify(raw);
  const out = await classifyReviewVerify({ raw, projectRoot, baseCommit: 'abc', deps });
  assert.equal(out.status, 'passed');
  assert.deepEqual(out.preexistingFailures, ['notices']);
  assert.deepEqual(out.newFailures, []);
  assert.equal(out.rawOk, false);
  assert.equal(out.baseline.source, 'base-commit');
  assert.equal(JSON.stringify(raw), frozen, 'raw result is not mutated');
  assert.deepEqual(fs.readdirSync(env.tmpDir), [], 'temp tree always removed');
});

test('a failure that passes at base is NEW -> failed; mixed with preexisting', async () => {
  const env = setup();
  const { deps } = makeDeps({ ...env, failing: { notices: 'always' } });
  const out = await classifyReviewVerify({ raw: rawFailing('notices', 'model-stats'), projectRoot, baseCommit: 'abc', deps });
  assert.equal(out.status, 'failed');
  assert.deepEqual(out.newFailures, ['model-stats']);
  assert.deepEqual(out.preexistingFailures, ['notices']);
});

test('test file absent at base is NEW', async () => {
  const env = setup();
  const { deps } = makeDeps({ ...env, present: [BASELINE_CONTROL_ID] });
  const out = await classifyReviewVerify({ raw: rawFailing('notices'), projectRoot, baseCommit: 'abc', deps });
  assert.equal(out.status, 'failed');
  assert.deepEqual(out.newFailures, ['notices']);
});

test('a catalog file missing from the material and absent at base does not block', async () => {
  const env = setup();
  const { deps } = makeDeps({ ...env, present: [BASELINE_CONTROL_ID] });
  // A host catalog newer than the leaf's branch names a test the branch never had.
  const raw = {
    ok: false,
    results: [
      { id: 'notices', ok: false, durationMs: 0, outputTail: 'Missing catalog file tests/notices.test.js' },
      { id: 'model-stats', ok: false, durationMs: 1, outputTail: 'assertion failed' },
    ],
    error: 'x',
  };
  const out = await classifyReviewVerify({ raw, projectRoot, baseCommit: 'abc', deps });
  assert.deepEqual(out.preexistingFailures, ['notices']);
  // A real failure of a test absent at base still counts as new.
  assert.deepEqual(out.newFailures, ['model-stats']);
  assert.equal(out.status, 'failed');
  const onlyMissing = await classifyReviewVerify({ raw: { ...raw, results: [raw.results[0]] }, projectRoot, baseCommit: 'abc', deps });
  assert.equal(onlyMissing.status, 'passed');
});

test('disagreeing runs are flaky and do not block', async () => {
  const env = setup();
  const { deps } = makeDeps({ ...env, failing: { notices: 1 } });
  const out = await classifyReviewVerify({ raw: rawFailing('notices'), projectRoot, baseCommit: 'abc', deps });
  assert.equal(out.status, 'passed');
  assert.deepEqual(out.flakyFailures, ['notices']);
});

test('unavailable baseline keeps the raw failure (control failing, ENOENT, extract error, no commit)', async () => {
  for (const scenario of [
    { failing: { [BASELINE_CONTROL_ID]: 'always', notices: 'always' }, reason: 'baseline_control_not_passing' },
    { failing: { notices: 'env' }, reason: 'baseline_environment_error' },
    { extractError: true, reason: /base_extract_failed/ },
  ]) {
    const env = setup();
    const { deps } = makeDeps({ ...env, ...scenario });
    const out = await classifyReviewVerify({ raw: rawFailing('notices'), projectRoot, baseCommit: 'abc', deps });
    assert.equal(out.status, 'failed');
    assert.equal(out.baseline.source, 'unavailable');
    assert.match(out.baseline.reason, scenario.reason instanceof RegExp ? scenario.reason : new RegExp(scenario.reason));
    assert.deepEqual(out.newFailures, ['notices']);
    assert.deepEqual(fs.readdirSync(env.tmpDir), []);
  }
  const noCommit = await classifyReviewVerify({ raw: rawFailing('notices'), projectRoot, baseCommit: '' });
  assert.equal(noCommit.status, 'failed');
  assert.equal(noCommit.baseline.reason, 'no_base_commit');
});

test('budget expiry -> unavailable', async () => {
  const env = setup();
  const { deps } = makeDeps({ ...env, failing: { notices: 'always' } });
  let tick = 0;
  deps.now = () => (tick += 100000);
  const out = await classifyReviewVerify({ raw: rawFailing('notices'), projectRoot, baseCommit: 'abc', budgetMs: 1000, deps });
  assert.equal(out.baseline.source, 'unavailable');
  assert.equal(out.baseline.reason, 'baseline_budget_expired');
});

test('cache is reused per base commit; a new commit recomputes', async () => {
  const env = setup();
  const first = makeDeps({ ...env, failing: { notices: 'always' } });
  await classifyReviewVerify({ raw: rawFailing('notices'), projectRoot, baseCommit: 'c1', deps: first.deps });
  assert.equal(first.calls.extract, 1);
  const second = makeDeps({ ...env, failing: { notices: 'always' } });
  const out = await classifyReviewVerify({ raw: rawFailing('notices'), projectRoot, baseCommit: 'c1', deps: second.deps });
  assert.equal(second.calls.extract, 0);
  assert.equal(second.calls.spawn.length, 0);
  assert.deepEqual(out.preexistingFailures, ['notices']);
  const third = makeDeps({ ...env, failing: { notices: 'always' } });
  await classifyReviewVerify({ raw: rawFailing('notices'), projectRoot, baseCommit: 'c2', deps: third.deps });
  assert.equal(third.calls.extract, 1);
});

test('an all-green raw run never touches the baseline', async () => {
  const { deps, calls } = makeDeps(setup());
  const out = await classifyReviewVerify({ raw: { ok: true, results: [] }, projectRoot, baseCommit: 'abc', deps });
  assert.equal(out.status, 'passed');
  assert.equal(out.baseline.source, 'not-needed');
  assert.equal(calls.extract, 0);
});

test('extractBaseCommit extracts the base into a temp dir and leaves the repo and stash alone', async () => {
  const repo = createTempRepo();
  const repoDir = repo.dir || repo;
  const base = commitFile(repoDir, 'old.txt', 'old\n');
  const baseSha = git(repoDir, ['rev-parse', 'HEAD']).trim();
  commitFile(repoDir, 'new.txt', 'new\n');
  fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'wip');
  const stashBefore = git(repoDir, ['stash', 'list']);
  const statusBefore = git(repoDir, ['status', '--porcelain']);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `${BASELINE_TEMP_PREFIX}t-`));
  await extractBaseCommit({ projectRoot: repoDir, baseCommit: baseSha, dest });
  assert.ok(fs.existsSync(path.join(dest, 'old.txt')));
  assert.ok(!fs.existsSync(path.join(dest, 'new.txt')));
  assert.equal(git(repoDir, ['stash', 'list']), stashBefore);
  assert.equal(git(repoDir, ['status', '--porcelain']), statusBefore);
  await assert.rejects(extractBaseCommit({ projectRoot: repoDir, baseCommit: 'deadbeef'.repeat(5), dest }));
  fs.rmSync(dest, { recursive: true, force: true });
  void base;
});

// A Watcher worktree may be owned by a different user than the one running the
// server (root serving /home/<user> checkouts). Without a scoped safe.directory
// Git refuses it as "dubious ownership" and the verify baseline is lost.
test('extractBaseCommit works on a checkout owned by another user', { skip: typeof process.getuid !== 'function' || process.getuid() !== 0 }, async () => {
  const repo = createTempRepo();
  const repoDir = repo.dir;
  const baseSha = repo.baseCommit;
  fs.chownSync(repoDir, 65534, 65534);
  for (const entry of fs.readdirSync(repoDir, { recursive: true })) {
    fs.lchownSync(path.join(repoDir, String(entry)), 65534, 65534);
  }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `${BASELINE_TEMP_PREFIX}own-`));
  try {
    await extractBaseCommit({ projectRoot: repoDir, baseCommit: baseSha, dest });
    assert.ok(fs.existsSync(path.join(dest, 'README.md')));
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('startup sweep removes only old prefixed dirs', () => {
  const env = setup();
  const old = path.join(env.tmpDir, `${BASELINE_TEMP_PREFIX}old`);
  const other = path.join(env.tmpDir, 'unrelated');
  fs.mkdirSync(old);
  fs.mkdirSync(other);
  sweepBaselineTempDirs({ tmpDir: env.tmpDir, now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(other));
});
