import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  JOB_PRIORITIES,
  buildImportIndex,
  buildTscIncrementalArgs,
  computeTestHash,
  createJobQueue,
  getJobQueueMetricsSnapshot,
  resolvePoolSize,
  runTestsWithCache,
  selectVerifyTests,
} from '../lib/job-queue/index.js';
import { createFairQueue } from '../lib/storage/fair-queue.js';
import { JOB_QUEUE_MIGRATIONS } from '../lib/job-queue/schema.js';
import { selectVerifyIdsForChange } from '../lib/delegation-review-verify-plan.js';
import { countAutoVerifyChainsInFlight, resetAutoVerifyChainsForTests, trackAutoVerifyChain } from '../lib/auto-verify-inflight.js';

const HASH_A = 'a'.repeat(64);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-queue-test-'));
}

/** Queue on a throw-away store dir; the lease is the production default. */
function openQueue(options = {}) {
  const dir = options.dir || tmp();
  const queue = createJobQueue({ handlers: {}, ...options, dir });
  return { queue, dir };
}

test('pool size scales to cores and honours the env override', () => {
  assert.equal(resolvePoolSize({ cores: 28, env: {} }), 28);
  assert.equal(resolvePoolSize({ cores: 0, env: {} }), 1);
  assert.equal(resolvePoolSize({ cores: 28, env: { CRETLI_JOB_WORKERS: '4' } }), 4);
  assert.equal(resolvePoolSize({ cores: 28, env: { CRETLI_JOB_WORKERS: 'x' } }), 28);
});

test('fair queue accepts custom priority classes and rejects unknown ones', () => {
  const q = createFairQueue({ priorities: ['a', 'b'] });
  q.push({ id: '1', priority: 'b', sizeBytes: 1 });
  q.push({ id: '2', priority: 'a', sizeBytes: 1 });
  assert.equal(q.shift()?.id, '2');
  assert.throws(() => q.push({ id: '3', priority: 'stop', sizeBytes: 1 }), /Unknown storage priority/);
  assert.throws(() => createFairQueue({ priorities: [] }), TypeError);
  assert.equal(createFairQueue().metrics().depthByPriority.stop, 0, 'default storage classes are unchanged');
});

test('the queue lives in the storage layer: lifecycle-opened WAL store at the current schema', async () => {
  const { queue, dir } = openQueue();
  const job = queue.enqueue({ kind: 'noop' });
  await job.done.catch(() => {});
  queue.close();
  const inspect = new DatabaseSync(path.join(dir, 'job-queue.sqlite'));
  assert.equal(inspect.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(Number(inspect.prepare('PRAGMA user_version').get().user_version), JOB_QUEUE_MIGRATIONS.length);
  assert.equal(Number(inspect.prepare('PRAGMA application_id').get().application_id), 0x43524554);
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM job_queue_jobs').get().n, 1);
  inspect.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a second live owner of the same store is refused by the coordinator lease', () => {
  const { queue, dir } = openQueue();
  assert.throws(() => createJobQueue({ dir, handlers: {} }), (error) => error.code === 'busy' || /busy|owner/i.test(String(error.message)));
  queue.close();
  // The lease is released on close, so the store can be owned again.
  createJobQueue({ dir, handlers: {} }).close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('priority classes order dispatch: interactive, cycle, maintenance', async () => {
  const order = [];
  // Hold the single slot so the rest queue up and are ordered by class.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { queue: q2, dir } = openQueue({ concurrency: 1, handlers: { gate: () => gate, work: async (p) => { order.push(p); } } });
  q2.enqueue({ kind: 'gate', priority: 'maintenance' });
  q2.enqueue({ kind: 'work', priority: 'maintenance', payload: 'm' });
  q2.enqueue({ kind: 'work', priority: 'cycle', payload: 'c' });
  q2.enqueue({ kind: 'work', priority: 'interactive', payload: 'i' });
  release();
  await q2.onIdle();
  assert.deepEqual(order, ['i', 'c', 'm']);
  assert.deepEqual([...JOB_PRIORITIES], ['interactive', 'cycle', 'maintenance']);
  q2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pool runs up to concurrency jobs in parallel; metrics carry depth, running and wait per class', async () => {
  let active = 0;
  let peak = 0;
  const { queue, dir } = openQueue({
    concurrency: 3,
    name: 'metrics-test',
    handlers: { slow: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active -= 1; return 1; } },
  });
  const jobs = Array.from({ length: 8 }, (_, i) => queue.enqueue({ kind: 'slow', priority: i % 2 ? 'cycle' : 'interactive' }));
  const mid = queue.metrics();
  assert.equal(mid.running, 3);
  assert.equal(mid.runningByPriority.interactive + mid.runningByPriority.cycle, 3);
  assert.equal(mid.queued, 5);
  assert.equal(Object.values(mid.depthByPriority).reduce((a, b) => a + b, 0), 5);
  await Promise.all(jobs.map((j) => j.done));
  assert.equal(peak, 3);
  const m = queue.metrics();
  assert.equal(m.concurrency, 3);
  assert.equal(m.counters.succeeded, 8);
  assert.equal(m.queued, 0);
  assert.equal(m.waitMs.n, 8);
  assert.equal(m.waitMsByPriority.interactive.n + m.waitMsByPriority.cycle.n, 8);
  assert.equal(m.waitMsByPriority.maintenance.n, 0);
  const snapshot = getJobQueueMetricsSnapshot();
  assert.ok(snapshot.queues.some((q) => q.name === 'metrics-test'));
  assert.equal(typeof snapshot.autoVerifyChainsInFlight, 'number');
  queue.close();
  assert.equal(getJobQueueMetricsSnapshot().queues.some((q) => q.name === 'metrics-test'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failed handler rejects the waiter and persists the error', async () => {
  const { queue, dir } = openQueue({ concurrency: 1, handlers: { boom: () => { throw new Error('nope'); } } });
  const job = queue.enqueue({ kind: 'boom' });
  await assert.rejects(job.done, /nope/);
  await queue.onIdle();
  assert.equal(queue.getJob(job.id)?.status, 'failed');
  assert.equal(queue.metrics().counters.failed, 1);
  assert.throws(() => queue.enqueue({ kind: 'x', priority: 'urgent' }), /Unknown job priority/);
  queue.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('queued and interrupted jobs survive a restart; recover:false kinds are failed as interrupted', async () => {
  const dir = tmp();
  const first = createJobQueue({ dir, concurrency: 1, handlers: { hang: () => new Promise(() => {}), orphan: () => new Promise(() => {}) } });
  first.enqueue({ kind: 'hang', payload: { n: 1 } });
  first.enqueue({ kind: 'hang', payload: { n: 2 } });
  const orphan = first.enqueue({ kind: 'orphan' });
  first.close();
  const seen = [];
  const second = createJobQueue({ dir, concurrency: 2, handlers: {} });
  second.registerHandler('hang', async (p) => { seen.push(p.n); });
  second.registerHandler('orphan', async () => seen.push('orphan'), { recover: false });
  // A job enqueued before start() must not be scheduled twice by recovery.
  const fresh = second.enqueue({ kind: 'hang', payload: { n: 3 } });
  second.start();
  await second.onIdle();
  await fresh.done;
  assert.deepEqual(seen.sort(), [1, 2, 3]);
  assert.equal(second.metrics().counters.recovered, 2);
  assert.equal(second.metrics().counters.interrupted, 1);
  assert.equal(second.getJob(orphan.id).status, 'failed');
  assert.equal(second.getJob(orphan.id).error, 'interrupted');
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retention prunes expired completed jobs and cache rows', async () => {
  const dir = tmp();
  let clock = 1000;
  const first = createJobQueue({ dir, now: () => clock, handlers: { ok: () => 'done' } });
  const job = first.enqueue({ kind: 'ok' });
  await job.done;
  first.testStore.put('tests/a.test.js', HASH_A, { durationMs: 1 });
  first.close();
  clock += 31 * 24 * 60 * 60 * 1000;
  const second = createJobQueue({ dir, now: () => clock, handlers: {} });
  assert.equal(second.getJob(job.id), null);
  assert.equal(second.testStore.get('tests/a.test.js', HASH_A), null);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepo() {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'lib', 'b.js'), "import { a } from './a.js';\nexport const b = a;\n");
  fs.writeFileSync(path.join(root, 'lib', 'c.js'), 'export const c = 3;\n');
  fs.writeFileSync(path.join(root, 'tests', 'uses-b.test.js'), "import '../lib/b.js';\n");
  fs.writeFileSync(path.join(root, 'tests', 'uses-c.test.js'), "import '../lib/c.js';\n");
  fs.writeFileSync(path.join(root, 'tests', 'control.test.js'), 'export {};\n');
  return root;
}

test('result cache: untouched tests are served from cache, touched ones re-run', async () => {
  const root = makeRepo();
  const { queue, dir } = openQueue({ concurrency: 4 });
  const ran = [];
  const tests = ['tests/uses-b.test.js', 'tests/uses-c.test.js'];
  const run = async (t) => { ran.push(t); return { ok: true, durationMs: 5 }; };
  const go = () => runTestsWithCache({ root, tests, index: buildImportIndex(root), store: queue.testStore, run, envKey: 'env', onCache: queue.recordCache });
  const first = await go();
  assert.equal(first.every((r) => !r.cached), true);
  ran.length = 0;
  const second = await go();
  assert.deepEqual(ran, []);
  assert.equal(second.every((r) => r.cached), true);
  // Touch a transitive dependency of uses-b only.
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'export const a = 2;\n');
  const third = await go();
  assert.deepEqual(ran, ['tests/uses-b.test.js']);
  assert.equal(third.find((r) => r.test === 'tests/uses-c.test.js')?.cached, true);
  assert.deepEqual(queue.metrics().testCache, { hits: 3, misses: 3 });
  queue.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('result cache never stores failures', async () => {
  const root = makeRepo();
  const { queue, dir } = openQueue();
  let calls = 0;
  const opts = { root, tests: ['tests/uses-c.test.js'], index: buildImportIndex(root), store: queue.testStore, envKey: 'env', run: async () => { calls += 1; return { ok: false }; } };
  await runTestsWithCache(opts);
  await runTestsWithCache(opts);
  assert.equal(calls, 2);
  queue.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('leaf selection = affected + control; integration = everything', () => {
  const root = makeRepo();
  const tests = ['tests/uses-b.test.js', 'tests/uses-c.test.js', 'tests/control.test.js'];
  const leaf = selectVerifyTests({ root, tests, changed: ['lib/a.js'], control: ['tests/control.test.js'] });
  assert.deepEqual(leaf.affected, ['tests/uses-b.test.js']);
  assert.deepEqual(leaf.selected, ['tests/control.test.js', 'tests/uses-b.test.js']);
  assert.deepEqual(leaf.skipped, ['tests/uses-c.test.js']);
  const full = selectVerifyTests({ root, tests, changed: [], mode: 'integration' });
  assert.deepEqual(full.selected, tests.slice().sort());
  const catalog = { b: 'tests/uses-b.test.js', c: 'tests/uses-c.test.js', ctl: 'tests/control.test.js' };
  const ids = selectVerifyIdsForChange({ root, catalog, changed: ['lib/c.js'], controlIds: ['ctl'] });
  assert.deepEqual(ids.ids.sort(), ['c', 'ctl']);
  assert.deepEqual(ids.skippedIds, ['b']);
  // No change set means nothing to narrow by: the whole catalog is selected.
  assert.deepEqual(selectVerifyIdsForChange({ root, catalog, changed: [], controlIds: ['ctl'] }).ids.sort(), ['b', 'c', 'ctl']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('tsc incremental args use a per-worktree or shared tsBuildInfo', () => {
  const a = buildTscIncrementalArgs({ root: '/w/one', cacheDir: '/cache' });
  const b = buildTscIncrementalArgs({ root: '/w/two', cacheDir: '/cache' });
  assert.notEqual(a.buildInfoPath, b.buildInfoPath);
  assert.ok(a.args.includes('--incremental') && a.args.includes('--noEmit'));
  const s1 = buildTscIncrementalArgs({ root: '/w/one', cacheDir: '/cache', scope: 'shared' });
  const s2 = buildTscIncrementalArgs({ root: '/w/two', cacheDir: '/cache', scope: 'shared' });
  assert.equal(s1.buildInfoPath, s2.buildInfoPath);
});

test('auto-verify in-flight count is exported for metrics', async () => {
  resetAutoVerifyChainsForTests();
  let done;
  trackAutoVerifyChain({ delegationId: 'd', projectRoot: '/p', promise: new Promise((r) => { done = r; }) });
  assert.equal(countAutoVerifyChainsInFlight(), 1);
  done();
  await new Promise((r) => setImmediate(r));
  assert.equal(countAutoVerifyChainsInFlight(), 0);
});

test('close() settles pending done and onIdle promises', async () => {
  let release;
  const { queue, dir } = openQueue({ concurrency: 1, handlers: { hold: () => new Promise((r) => { release = r; }) } });
  const running = queue.enqueue({ kind: 'hold' });
  const waiting = queue.enqueue({ kind: 'hold' });
  const idle = queue.onIdle();
  queue.close();
  await assert.rejects(running.done, /closed/);
  await assert.rejects(waiting.done, /closed/);
  await idle;
  release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache key covers env key, lockfile, fixtures and node version; integration bypasses cache', async () => {
  const root = makeRepo();
  const index = buildImportIndex(root);
  const key = (extra = {}) => computeTestHash({ root, test: 'tests/uses-c.test.js', index, envKey: 'env', ...extra }).hash;
  assert.throws(() => computeTestHash({ root, test: 'tests/uses-c.test.js', index }), /envKey is required/);
  const base = key();
  assert.notEqual(base, key({ envKey: 'other' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"v":1}');
  const withLock = key();
  assert.notEqual(base, withLock);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"v":2}');
  assert.notEqual(withLock, key());
  // A fixture outside the import graph still invalidates every key.
  fs.mkdirSync(path.join(root, 'tests', 'fixtures'));
  fs.writeFileSync(path.join(root, 'tests', 'fixtures', 'data.json'), '{"x":1}');
  const withFixture = key();
  fs.writeFileSync(path.join(root, 'tests', 'fixtures', 'data.json'), '{"x":2}');
  assert.notEqual(withFixture, key());

  const { queue: store, dir } = openQueue({ concurrency: 1 });
  const tests = ['tests/uses-c.test.js'];
  let runs = 0;
  const run = async () => { runs += 1; return { ok: true }; };
  const args = { root, tests, index, store: store.testStore, run, envKey: 'env', onCache: store.recordCache };
  await runTestsWithCache(args);
  await runTestsWithCache(args);
  assert.equal(runs, 1);
  const full = await runTestsWithCache({ ...args, mode: 'integration' });
  assert.equal(runs, 2);
  assert.equal(full[0].cached, false);
  await runTestsWithCache({ ...args, mode: 'integration' });
  assert.equal(store.metrics().testCache.hits, 1, 'integration never reads the cache');
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pump releases the running slot and keeps the job queued when claiming throws', async () => {
  let armed = false;
  let failedOnce = false;
  const { queue, dir } = openQueue({
    concurrency: 1,
    // The first clock read made by pump() itself (the claim in markRunning, not
    // the fair-queue shift) fails once.
    now: () => {
      if (armed && !failedOnce) {
        const frames = new Error('probe').stack;
        if (frames.includes('at pump') && !frames.includes('shift')) {
          failedOnce = true;
          throw new Error('claim failed');
        }
      }
      return Date.now();
    },
    handlers: { ok: () => 'fine' },
  });
  armed = true;
  const job = queue.enqueue({ kind: 'ok' });
  assert.equal(queue.metrics().running, 0);
  assert.equal(queue.metrics().queued, 1);
  assert.equal(queue.getJob(job.id).status, 'queued');
  queue.start();
  assert.equal(await job.done, 'fine');
  queue.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
