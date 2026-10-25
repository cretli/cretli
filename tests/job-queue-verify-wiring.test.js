import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createJobQueue, createQueuedVerifyRunner, getJobQueueMetricsSnapshot, REVIEW_VERIFY_JOB_KIND } from '../lib/job-queue/index.js';
import { createLoadSnapshotProvider } from '../lib/server-health/load-snapshot.js';
import { createTempRepo } from './helpers/temp-git-repo.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, getDelegationById } from '../lib/persist/delegations-persist.js';
import { startAutoVerifyAfterImplement } from '../lib/delegation-service.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-queue-wiring-'));
}

function makeRepo() {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'lib', 'c.js'), 'export const c = 3;\n');
  fs.writeFileSync(path.join(root, 'tests', 'uses-a.test.js'), "import '../lib/a.js';\n");
  fs.writeFileSync(path.join(root, 'tests', 'uses-c.test.js'), "import '../lib/c.js';\n");
  return root;
}

const CATALOG = { a: 'tests/uses-a.test.js', c: 'tests/uses-c.test.js' };

/** Runner over a fake per-id step; `outcomes[id]` decides pass/fail. */
function makeRunner({ outcomes = {}, calls = [] } = {}) {
  const dir = tmp();
  const queue = createJobQueue({ dir, concurrency: 4 });
  const runner = createQueuedVerifyRunner({
    queue,
    resolveCatalog: () => CATALOG,
    runStep: async ({ ids }) => {
      calls.push(ids[0]);
      const ok = outcomes[ids[0]] !== false;
      return {
        ok,
        output: `out ${ids[0]}`,
        ...(ok ? {} : { error: `${ids[0]} exploded` }),
        dataDir: ok ? '' : '/tmp/not-removed',
        results: [{ id: ids[0], ok, durationMs: 7, outputTail: `tail ${ids[0]}` }],
      };
    },
  });
  return { queue, runner, dir, calls };
}

test('queued runner: a second run is served from the hash cache; a touched dependency re-runs only its test', async () => {
  const root = makeRepo();
  const { queue, runner, calls } = makeRunner();
  const first = await runner({ ids: ['a', 'c'], projectRoot: root });
  assert.equal(first.ok, true);
  assert.deepEqual(calls.sort(), ['a', 'c']);
  assert.deepEqual(first.results.map((r) => r.id), ['a', 'c'], 'results keep id order');
  calls.length = 0;
  const second = await runner({ ids: ['a', 'c'], projectRoot: root });
  assert.deepEqual(calls, []);
  assert.equal(second.ok, true);
  assert.equal(second.results.every((r) => r.cached === true), true);
  fs.writeFileSync(path.join(root, 'lib', 'a.js'), 'export const a = 2;\n');
  const third = await runner({ ids: ['a', 'c'], projectRoot: root });
  assert.deepEqual(calls, ['a']);
  assert.equal(third.results.find((r) => r.id === 'c').cached, true);
  assert.deepEqual(queue.metrics().testCache, { hits: 3, misses: 3 });
  queue.close();
});

test('queued runner: integration mode and failures never touch the cache; result keeps the runReviewVerify shape', async () => {
  const root = makeRepo();
  const { queue, runner, calls } = makeRunner({ outcomes: { c: false } });
  const first = await runner({ ids: ['a', 'c'], projectRoot: root });
  assert.equal(first.ok, false);
  assert.equal(first.error, 'c exploded');
  assert.equal(first.dataDir, '/tmp/not-removed');
  assert.match(first.output, /==> a\nout a/);
  assert.deepEqual(first.results.map((r) => [r.id, r.ok]), [['a', true], ['c', false]]);
  calls.length = 0;
  await runner({ ids: ['a', 'c'], projectRoot: root });
  assert.deepEqual(calls, ['c'], 'the passing test is cached, the failing one re-runs');
  calls.length = 0;
  await runner({ ids: ['a', 'c'], projectRoot: root, mode: 'integration' });
  assert.deepEqual(calls.sort(), ['a', 'c'], 'integration runs everything fresh');
  queue.close();
});

test('queued runner: unknown ids, empty catalogs and a closed queue degrade like the raw runner', async () => {
  const root = makeRepo();
  const { queue, runner } = makeRunner();
  assert.match((await runner({ ids: ['nope'], projectRoot: root })).error, /Unknown review verify id: nope/);
  // Without ids the whole catalog is verified.
  assert.deepEqual((await runner({ projectRoot: root })).results.map((r) => r.id), ['a', 'c']);
  const emptyDir = tmp();
  const emptyQueue = createJobQueue({ dir: emptyDir, concurrency: 1 });
  const emptyRunner = createQueuedVerifyRunner({ queue: emptyQueue, resolveCatalog: () => ({}), runStep: async () => ({ ok: true }) });
  assert.equal((await emptyRunner({ projectRoot: root })).notApplicable, true);
  emptyQueue.close();
  fs.writeFileSync(path.join(root, 'lib', 'c.js'), 'export const c = 4;\n');
  queue.close();
  const closed = await runner({ ids: ['c'], projectRoot: root });
  assert.equal(closed.ok, false);
  assert.match(closed.error, /closed/);
});

test('the verify job kind is not recovered after a restart (its caller is gone)', async () => {
  const dir = tmp();
  const first = createJobQueue({ dir, concurrency: 1, handlers: { [REVIEW_VERIFY_JOB_KIND]: () => new Promise(() => {}) } });
  const job = first.enqueue({ kind: REVIEW_VERIFY_JOB_KIND, priority: 'cycle', payload: { id: 'a', projectRoot: '/x' } });
  first.close();
  const second = createJobQueue({ dir, concurrency: 1 });
  let ran = 0;
  createQueuedVerifyRunner({ queue: second, resolveCatalog: () => CATALOG, runStep: async () => { ran += 1; return { ok: true }; } });
  await second.onIdle();
  assert.equal(ran, 0);
  assert.equal(second.getJob(job.id).status, 'failed');
  second.close();
});

test('queue metrics are exported through the health load snapshot', () => {
  const dir = tmp();
  const queue = createJobQueue({ dir, name: 'snapshot-test', concurrency: 2 });
  const provider = createLoadSnapshotProvider({
    getEventLoopLag: () => ({ p50: 0, p99: 0, max: 0 }),
    readProcesses: async () => '',
    getJobQueueMetrics: getJobQueueMetricsSnapshot,
  });
  const exported = provider.get().jobQueue;
  const row = exported.queues.find((q) => q.name === 'snapshot-test');
  assert.equal(row.concurrency, 2);
  assert.deepEqual(Object.keys(row.depthByPriority), ['interactive', 'cycle', 'maintenance']);
  assert.deepEqual(Object.keys(row.waitMsByPriority), ['interactive', 'cycle', 'maintenance']);
  assert.deepEqual(row.testCache, { hits: 0, misses: 0 });
  assert.equal(typeof exported.autoVerifyChainsInFlight, 'number');
  const without = createLoadSnapshotProvider({ getEventLoopLag: () => ({ p50: 0, p99: 0, max: 0 }), readProcesses: async () => '' }).get();
  assert.equal('jobQueue' in without, false);
  queue.close();
});

test('production auto-verify after implement runs through the shared job queue', async () => {
  const repo = createTempRepo();
  fs.mkdirSync(`${repo.dir}/scripts`, { recursive: true });
  fs.writeFileSync(`${repo.dir}/scripts/review-verify.js`, '');
  const previous = process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT;
  process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT = '1';
  try {
    const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
    const row = createDelegationRecord({
      parentChatId: parent.id,
      workspaceFolder: repo.dir,
      executor: { transport: 'testfake', model: 'testfake/test' },
      assignment: 'implement',
      status: 'completed',
      leafId: crypto.randomUUID(),
      finishedAt: new Date().toISOString(),
    });
    await startAutoVerifyAfterImplement(row);
    const after = getDelegationById(row.id);
    assert.equal(after.verifyPending, null);
    assert.equal(after.verifyResult.source, 'auto_after_implement');
    const queues = getJobQueueMetricsSnapshot().queues;
    assert.equal(queues.length, 1, 'the default verify queue is open');
    assert.ok(queues[0].counters.started > 0, 'catalog ids ran as queue jobs');
    // No change set: the full catalog runs fresh and never touches the result cache.
    assert.deepEqual(queues[0].testCache, { hits: 0, misses: 0 });
    assert.ok(fs.existsSync(path.join(ISOLATED_DATA_DIR, 'job-queue', 'job-queue.sqlite')));
  } finally {
    if (previous === undefined) delete process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT;
    else process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT = previous;
    const { resetDefaultJobQueueForTests } = await import('../lib/job-queue/index.js');
    resetDefaultJobQueueForTests();
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('freshIds bypass the result cache (curated-selected ids read files outside the import closure)', async () => {
  const root = makeRepo();
  const { queue, runner, calls } = makeRunner();
  await runner({ ids: ['a', 'c'], projectRoot: root });
  calls.length = 0;
  // Same code, nothing in the import closure changed: `a` is forced fresh, `c` stays cached.
  const second = await runner({ ids: ['a', 'c'], projectRoot: root, freshIds: ['a'] });
  assert.deepEqual(calls, ['a']);
  assert.equal(second.results.find((r) => r.id === 'a').cached, undefined);
  assert.equal(second.results.find((r) => r.id === 'c').cached, true);
  queue.close();
});

test('queue steps carry the material revision so isReviewVerifyInFlight can see them', async () => {
  const root = makeRepo();
  const seen = [];
  const dir = tmp();
  const queue = createJobQueue({ dir, concurrency: 2 });
  const runner = createQueuedVerifyRunner({
    queue,
    resolveCatalog: () => CATALOG,
    runStep: async (input) => { seen.push(input.materialRevision); return { ok: true, output: '', dataDir: '', results: [] }; },
  });
  await runner({ ids: ['a'], projectRoot: root, materialRevision: 'rev-1' });
  assert.deepEqual(seen, ['rev-1']);
  queue.close();
});

test('selectAutoVerifyIds: a curated path outside the import closure is fresh; no signal means fresh full run', async () => {
  const { selectAutoVerifyIds } = await import('../lib/delegation-service.js');
  const root = path.resolve(import.meta.dirname, '..');
  const docs = selectAutoVerifyIds({ changed: ['docs/storage-callers.md'], root });
  assert.ok(docs.ids.includes('storage-callers-contract'));
  assert.ok(docs.freshIds.includes('storage-callers-contract'), 'fs-read doc is not in the import closure');
  const code = selectAutoVerifyIds({ changed: ['lib/job-queue/test-cache.js'], root });
  assert.ok(code.ids.includes('todo-ref'), 'control id is added');
  assert.equal(code.freshIds.includes('todo-ref'), false, 'closure-only selection stays cacheable');
  const none = selectAutoVerifyIds({ changed: [], root });
  assert.deepEqual(none.freshIds, none.ids);
});
