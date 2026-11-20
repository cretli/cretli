import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import {
  acquireWorkspaceWatcherLease,
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { runReviewVerify } from '../lib/sdk/sdk-review-verify.ts';
import {
  hasCycleChildWithPendingVerify,
  isVerifyPendingBlockMessage,
  reportWorkspaceWatcherCycle,
} from '../lib/workspace-watcher-cycle.js';
import {
  DELEGATION_VERIFY_PENDING_BEFORE_REVIEW,
  VERIFY_PENDING_MAX_AGE_MS,
  waitForImplementVerifyBeforeReview,
} from '../lib/delegation-implement-verify-gate.js';
import { isDelegationWaitSettled } from '../lib/mcp/builtin/delegation-wait.js';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-verify-parallel-'));
test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  removeIsolatedDataDir();
});

/**
 * Builds a throwaway project whose `tests/<id>.js` scripts append
 * `<id> start|end <ms>` lines to a shared log, sleeping `sleepMs` in between.
 * The runner spawns each file with plain `node`, so no real catalog is involved.
 */
function makeFakeProject(name, steps) {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  const log = path.join(root, 'log.txt');
  const catalog = {};
  for (const step of steps) {
    const rel = `tests/${step.id}.js`;
    fs.writeFileSync(path.join(root, rel), [
      "const fs = require('node:fs');",
      `const log = ${JSON.stringify(log)};`,
      `fs.appendFileSync(log, '${step.id} start ' + Date.now() + '\\n');`,
      `setTimeout(() => {`,
      `  fs.appendFileSync(log, '${step.id} end ' + Date.now() + '\\n');`,
      `  process.exit(${step.exit || 0});`,
      `}, ${step.sleepMs});`,
    ].join('\n'));
    catalog[step.id] = rel;
  }
  return { root, log, catalog };
}

/** Highest number of steps that were running at the same time. */
function maxOverlap(logPath) {
  const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => {
    const [id, kind, at] = line.split(' ');
    return { id, kind, at: Number(at) };
  });
  // Ends sort before starts at the same instant so back-to-back steps do not count as overlapping.
  events.sort((a, b) => a.at - b.at || (a.kind === 'end' ? -1 : 1));
  let running = 0;
  let peak = 0;
  for (const event of events) {
    running += event.kind === 'start' ? 1 : -1;
    peak = Math.max(peak, running);
  }
  return peak;
}

test('runReviewVerify honours the concurrency bound and keeps catalog order', async () => {
  const project = makeFakeProject('bounded', [
    { id: 'slow', sleepMs: 400 },
    { id: 'fast', sleepMs: 20 },
    { id: 'mid', sleepMs: 150 },
    { id: 'last', sleepMs: 20 },
  ]);
  const previous = process.env.CRETLI_REVIEW_VERIFY_CONCURRENCY;
  process.env.CRETLI_REVIEW_VERIFY_CONCURRENCY = '2';
  try {
    const run = await runReviewVerify({ projectRoot: project.root, catalog: project.catalog, ids: ['slow', 'fast', 'mid', 'last'] });
    assert.equal(run.ok, true, run.error);
    assert.deepEqual(run.results.map((r) => r.id), ['slow', 'fast', 'mid', 'last'], 'results follow catalog order, not finish order');
    assert.ok(run.results.every((r) => typeof r.startedAt === 'string' && r.durationMs >= 0));
    assert.equal(run.timing.concurrency, 2);
    assert.equal(maxOverlap(project.log), 2, 'never more than the bound, and actually parallel');
    assert.ok(run.output.indexOf('==> slow') < run.output.indexOf('==> fast'), 'combined output keeps catalog order');
    // Wall clock is below the serial sum only if steps overlapped.
    assert.ok(run.timing.durationMs < run.timing.sumStepMs, 'parallel run is faster than the sum of its steps');
  } finally {
    if (previous === undefined) delete process.env.CRETLI_REVIEW_VERIFY_CONCURRENCY;
    else process.env.CRETLI_REVIEW_VERIFY_CONCURRENCY = previous;
  }
});

test('concurrency 1 runs the steps serially', async () => {
  const project = makeFakeProject('serial', [
    { id: 's1', sleepMs: 60 },
    { id: 's2', sleepMs: 60 },
    { id: 's3', sleepMs: 60 },
  ]);
  const previous = process.env.CRETLI_REVIEW_VERIFY_CONCURRENCY;
  process.env.CRETLI_REVIEW_VERIFY_CONCURRENCY = '1';
  try {
    const run = await runReviewVerify({ projectRoot: project.root, catalog: project.catalog });
    assert.equal(run.ok, true, run.error);
    assert.equal(run.timing.concurrency, 1);
    assert.equal(maxOverlap(project.log), 1);
  } finally {
    if (previous === undefined) delete process.env.CRETLI_REVIEW_VERIFY_CONCURRENCY;
    else process.env.CRETLI_REVIEW_VERIFY_CONCURRENCY = previous;
  }
});

test('a failing step does not hide the others', async () => {
  const project = makeFakeProject('failing', [
    { id: 'good', sleepMs: 20 },
    { id: 'bad', sleepMs: 20, exit: 1 },
    { id: 'also-good', sleepMs: 20 },
  ]);
  const run = await runReviewVerify({ projectRoot: project.root, catalog: project.catalog });
  assert.equal(run.ok, false);
  assert.deepEqual(run.results.map((r) => [r.id, r.ok]), [['good', true], ['bad', false], ['also-good', true]]);
  assert.ok(run.results.every((r) => !r.timedOut));
  assert.ok(run.error, 'run carries the first failing step error');
});

test('a step killed by the per-step limit is reported timedOut and fails the run', async () => {
  const project = makeFakeProject('timeout', [
    { id: 'quick', sleepMs: 10 },
    { id: 'hang', sleepMs: 30_000 },
  ]);
  const run = await runReviewVerify({ projectRoot: project.root, catalog: project.catalog, timeoutMs: 400 });
  assert.equal(run.ok, false);
  const hang = run.results.find((r) => r.id === 'hang');
  const quick = run.results.find((r) => r.id === 'quick');
  assert.equal(hang.ok, false);
  assert.equal(hang.timedOut, true);
  assert.equal(quick.ok, true);
  assert.equal(quick.timedOut, undefined);
  assert.match(run.error, /hang timed out after 400 ms/);
});

test('verify-pending block messages are recognised', () => {
  assert.ok(isVerifyPendingBlockMessage('review start CONFLICT verify_pending'));
  assert.ok(isVerifyPendingBlockMessage('host verify in flight'));
  assert.ok(!isVerifyPendingBlockMessage('plan not approved'));
  assert.ok(!isVerifyPendingBlockMessage(''));
});

// ---- verifyPending marker: gate wait / expiry and delegation_wait ----

function seedImplement({ pendingSince, status = 'completed' }) {
  const parent = addChat(crypto.randomUUID(), 'parent', null, ISOLATED_DATA_DIR, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const leafId = crypto.randomUUID();
  const record = createDelegationRecord({
    parentChatId: parent.id,
    workspaceFolder: tmpRoot,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'implement',
    status,
    leafId,
    finishedAt: new Date().toISOString(),
  });
  // Set through update so the marker is persisted the way the auto-verify chain writes it.
  if (pendingSince) updateDelegationRecord(record.id, { verifyPending: { since: new Date(pendingSince).toISOString(), revision: 'rev-1' } });
  const reviewInput = {
    parentChatId: parent.id,
    assignment: 'review',
    executionMode: 'agent',
    reviewSubject: 'code',
    leafId,
  };
  return { record, reviewInput };
}

test('wait helper returns immediately when nothing is pending', async () => {
  const gate = await waitForImplementVerifyBeforeReview({ assignment: 'implement' }, { maxWaitMs: 50, pollMs: 10 });
  assert.equal(gate.ok, true);
  const { reviewInput } = seedImplement({ pendingSince: 0 });
  const started = Date.now();
  const second = await waitForImplementVerifyBeforeReview(reviewInput, { maxWaitMs: 2000, pollMs: 10 });
  assert.equal(second.ok, true);
  assert.ok(Date.now() - started < 1000, 'no marker means no waiting');
});

test('gate waits for a live marker and proceeds once it is cleared', async () => {
  const { record, reviewInput } = seedImplement({ pendingSince: Date.now() });
  setTimeout(() => updateDelegationRecord(record.id, { verifyPending: null }), 120);
  const started = Date.now();
  const gate = await waitForImplementVerifyBeforeReview(reviewInput, { maxWaitMs: 3000, pollMs: 20 });
  const waited = Date.now() - started;
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.ok(waited >= 100, `waited for the marker (${waited}ms)`);
  assert.ok(waited < 2500, 'returned soon after the marker cleared, not at the budget');
});

test('gate returns the retryable verify_pending result when the wait budget expires', async () => {
  const { reviewInput } = seedImplement({ pendingSince: Date.now() });
  const started = Date.now();
  const gate = await waitForImplementVerifyBeforeReview(reviewInput, { maxWaitMs: 150, pollMs: 20 });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, DELEGATION_VERIFY_PENDING_BEFORE_REVIEW);
  assert.equal(gate.status, 409);
  assert.equal(gate.retryable, true);
  assert.ok(Date.now() - started >= 140, 'waited for the whole budget');
});

test('gate stops waiting when the signal aborts', async () => {
  const { reviewInput } = seedImplement({ pendingSince: Date.now() });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const started = Date.now();
  const gate = await waitForImplementVerifyBeforeReview(reviewInput, { maxWaitMs: 5000, pollMs: 20, signal: controller.signal });
  assert.equal(gate.ok, false);
  assert.ok(Date.now() - started < 2000);
});

test('an orphaned marker older than the max age does not block or delay the gate', async () => {
  const { reviewInput } = seedImplement({ pendingSince: Date.now() - VERIFY_PENDING_MAX_AGE_MS - 1000 });
  const started = Date.now();
  const gate = await waitForImplementVerifyBeforeReview(reviewInput, { maxWaitMs: 3000, pollMs: 20 });
  assert.equal(gate.ok, true);
  assert.ok(Date.now() - started < 1000);
});

test('delegation_wait treats a terminal row with a live verify marker as unsettled', () => {
  const live = { status: 'completed', verifyPending: { since: new Date().toISOString(), revision: 'r' } };
  assert.equal(isDelegationWaitSettled(live), false);
  const orphaned = { status: 'completed', verifyPending: { since: new Date(Date.now() - VERIFY_PENDING_MAX_AGE_MS - 1000).toISOString(), revision: 'r' } };
  assert.equal(isDelegationWaitSettled(orphaned), true, 'orphaned marker is ignored');
  assert.equal(isDelegationWaitSettled({ status: 'completed', verifyPending: null }), true, 'cleared marker settles');
  assert.equal(isDelegationWaitSettled({ status: 'completed' }), true);
  assert.equal(isDelegationWaitSettled({ status: 'running', verifyPending: null }), false);
  assert.equal(isDelegationWaitSettled(null), false);
});

// ---- watcher: deferral while verify runs, resumption afterwards ----

const CYCLE_CHAT = 'orch-verify-defer';

test('hasCycleChildWithPendingVerify matches only live markers of this cycle chat', () => {
  const live = { id: 'a', parentChatId: CYCLE_CHAT, verifyPending: { since: new Date().toISOString() } };
  assert.equal(hasCycleChildWithPendingVerify(CYCLE_CHAT, [live]), true);
  assert.equal(hasCycleChildWithPendingVerify(CYCLE_CHAT, [{ ...live, parentChatId: 'other' }]), false);
  assert.equal(hasCycleChildWithPendingVerify(CYCLE_CHAT, [{ ...live, verifyPending: { since: new Date(Date.now() - VERIFY_PENDING_MAX_AGE_MS - 1000).toISOString() } }]), false);
  assert.equal(hasCycleChildWithPendingVerify(CYCLE_CHAT, [{ id: 'b', parentChatId: CYCLE_CHAT, verifyPending: null }]), false);
  assert.equal(hasCycleChildWithPendingVerify('', [live]), false);
});

test('a verify-only blocked report defers the close, then a later report resumes and closes', async () => {
  const cwd = path.join(tmpRoot, 'ws-watcher');
  fs.mkdirSync(cwd, { recursive: true });
  const dataDir = ISOLATED_DATA_DIR;
  const todo = addTodo(dataDir, cwd, { title: 'verify defer', status: 'ready' }).item;
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: CYCLE_CHAT, expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 50, maxParallel: 5, maxConsecutiveFailures: 3 },
  }, { dataDir });
  const T0 = Date.now();
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: {
      cycleId: 'c-verify',
      todoIds: [todo.id],
      startedAt: new Date(T0).toISOString(),
      chatId: CYCLE_CHAT,
      runId: 'run-seed',
      phase: 'running',
      planOnly: false,
    },
    lease: acquireWorkspaceWatcherLease(row, { token: 'seed-token', ttlMs: 600_000, now: T0 }).lease,
  }), { dataDir });

  const verifying = () => [{ id: 'impl-1', parentChatId: CYCLE_CHAT, status: 'completed', verifyPending: { since: new Date().toISOString(), revision: 'r1' } }];
  const base = { workspaceFolder: cwd, dataDir, sourceChatId: CYCLE_CHAT, cycleId: 'c-verify', todoIds: [todo.id] };

  const deferred = await reportWorkspaceWatcherCycle({
    ...base, now: T0 + 1000, outcome: 'blocked', message: 'review start CONFLICT verify_pending', deps: { loadDelegations: verifying },
  });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.deferred, true, 'close is deferred while the verify runs');
  let row = getWorkspaceWatcher(cwd, { dataDir });
  assert.ok(row.activeCycle, 'cycle stays open');
  assert.ok(!row.activeCycle.reportedOutcome, 'no blocked outcome is recorded');
  assert.equal(row.failures[todo.id], undefined, 'no backoff for the todo');
  assert.equal(getTodoById(dataDir, cwd, todo.id).claimedByChatId, CYCLE_CHAT);

  // The verify finished (marker gone) and the orchestrator resumed at review: the next report closes.
  const closed = await reportWorkspaceWatcherCycle({
    ...base, now: T0 + 2000, outcome: 'success', deps: { loadDelegations: () => [{ id: 'impl-1', parentChatId: CYCLE_CHAT, status: 'completed', verifyPending: null }] },
  });
  assert.equal(closed.ok, true, closed.reason);
  assert.equal(closed.deferred, undefined);
  row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null, 'cycle closed after resumption');
});

test('a blocked report with a non-verify message closes immediately even if a marker is live', async () => {
  const cwd = path.join(tmpRoot, 'ws-watcher-human');
  fs.mkdirSync(cwd, { recursive: true });
  const dataDir = ISOLATED_DATA_DIR;
  const chat = 'orch-human-block';
  const todo = addTodo(dataDir, cwd, { title: 'human block', status: 'ready' }).item;
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: chat, expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 50, maxParallel: 5, maxConsecutiveFailures: 3 },
  }, { dataDir });
  const T0 = Date.now();
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: { cycleId: 'c-human', todoIds: [todo.id], startedAt: new Date(T0).toISOString(), chatId: chat, runId: 'run-seed', phase: 'running', planOnly: false },
    lease: acquireWorkspaceWatcherLease(row, { token: 'seed-token-2', ttlMs: 600_000, now: T0 }).lease,
  }), { dataDir });
  const result = await reportWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, sourceChatId: chat, cycleId: 'c-human', todoIds: [todo.id], now: T0 + 1000,
    outcome: 'blocked', message: 'plan needs human approval',
    deps: { loadDelegations: () => [{ id: 'i', parentChatId: chat, status: 'completed', verifyPending: { since: new Date().toISOString(), revision: 'r' } }] },
  });
  assert.equal(result.ok, true, result.reason);
  assert.notEqual(result.deferred, true);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, null);
});
