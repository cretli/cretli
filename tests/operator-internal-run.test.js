import '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordOperatorEvent } from '../lib/persist/operator-journal-persist.js';
import { appendOperatorAudit, recordOperatorRunReport } from '../lib/operator/operator-audit.js';
import { OPERATOR_SAFE_HARNESSES, createOperatorScheduler, operatorExcludedHarnesses, summarizeRunToolCalls } from '../lib/operator/operator-scheduler.js';
import { ensureOperatorChat } from '../lib/operator/operator-chat.js';
import { OPERATOR_CHAT_META_KEY } from '../lib/operator/operator-chat.js';
import { getMeta, openOperatorStore, setMeta } from '../lib/operator/operator-internal-store.js';
import { clearBreaker, evaluateDailyBudget, readBreaker, recordRunOutcome } from '../lib/operator/operator-limits.js';
import { normalizeOperatorSettings } from '../lib/operator/operator-settings.js';
import { startOperatorSchedulerSafely, stopOperatorSchedulerSafely } from '../lib/operator/operator-boot.js';

const T0 = Date.parse('2026-11-11T10:00:00.000Z');
const WS = path.resolve('/tmp/operator-ws-run');
const quiet = { warn() {}, error() {} };

function fixture(settings = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-run-'));
  const rows = new Map();
  const notices = [];
  const calls = { addChat: [], start: [], cancel: [] };
  const state = { now: T0, harness: 'claude', busy: true, tokens: 0 };
  const chatDeps = {
    getChatById: async (id) => rows.get(id) || null,
    loadChats: async () => [...rows.values()],
    addChat: async (_s, title, _f, folder, model, extras) => { const row = { id: extras.id, title, workspaceFolder: folder, ...extras }; rows.set(row.id, row); return row; },
  };
  const deps = {
    chatDeps,
    pickExecutor: async () => (state.harness ? { harness: state.harness, model: 'm1' } : null),
    addChat: async (_s, title, _f, folder, model, extras) => { const row = { id: extras.id, title, workspaceFolder: folder, ...extras }; calls.addChat.push(row); return row; },
    startChatRun: async (input) => { calls.start.push(input); return { accepted: true, runId: 'r' }; },
    cancelRun: async (input) => { calls.cancel.push(input); },
    probeLiveness: async () => ({ known: true, busy: state.busy, reason: '' }),
    measureTokens: async () => state.tokens,
    appendNotice: async (id, text, meta) => { notices.push({ id, text, meta }); },
    readWorkspaceState: async () => 'state',
  };
  const store = { dataDir, now: T0 };
  const scheduler = createOperatorScheduler({ dataDir, settings: { enabled: true, coalesceMs: 0, ...settings }, now: () => state.now, logger: quiet, deps, idleGraceMs: 1000 });
  const emit = (kind, summary = `${kind}: leaf l1, x`, ws = WS) => recordOperatorEvent(ws, kind, summary, { dataDir, now: state.now });
  const q = (sql, ...a) => { const db = openOperatorStore(store); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
  return { dataDir, scheduler, state, calls, notices, emit, q, rows, store, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('ensureOperatorChat: idempotent, concurrent calls share one chat, recreated under the same id', async () => {
  const f = fixture();
  try {
    const deps = f.scheduler && {};
    const opts = { dataDir: f.dataDir, deps: { getChatById: async (id) => f.rows.get(id) || null, loadChats: async () => [...f.rows.values()], addChat: async (_s, title, _f, folder, _m, extras) => { const row = { id: extras.id, title, ...extras }; f.rows.set(row.id, row); return row; } } };
    const [a, b] = await Promise.all([ensureOperatorChat(opts), ensureOperatorChat(opts)]);
    assert.equal(a.chatId, b.chatId);
    assert.equal(f.rows.size, 1);
    assert.equal(f.rows.get(a.chatId).operatorChat, true);
    const again = await ensureOperatorChat(opts);
    assert.equal(again.created, false);
    f.rows.delete(a.chatId);
    const back = await ensureOperatorChat(opts);
    assert.equal(back.chatId, a.chatId);
    assert.equal(back.created, true);
    void deps;
  } finally { f.cleanup(); }
});

test('ensureOperatorChat: crash window with a reserved id converges on that id', async () => {
  const f = fixture();
  try {
    const db = openOperatorStore(f.store);
    try { setMeta(db, OPERATOR_CHAT_META_KEY, 'reserved-id-1'); } finally { db.close(); }
    const opts = { dataDir: f.dataDir, deps: { getChatById: async (id) => f.rows.get(id) || null, loadChats: async () => [...f.rows.values()], addChat: async (_s, t, _f, _w, _m, extras) => { const row = { id: extras.id, ...extras }; f.rows.set(row.id, row); return row; } } };
    const result = await ensureOperatorChat(opts);
    assert.equal(result.chatId, 'reserved-id-1');
    assert.ok(f.rows.has('reserved-id-1'));
  } finally { f.cleanup(); }
});

test('a disabled scheduler does nothing', async () => {
  const f = fixture({ enabled: false });
  try {
    f.emit('review_failed');
    assert.deepEqual(await f.scheduler.tick(), { skipped: 'disabled' });
    assert.equal(f.q('SELECT * FROM operator_runs').length, 0);
  } finally { f.cleanup(); }
});

test('review_failed starts one plan-mode run in a new hidden operator_run chat; a second event waits for the slot', async () => {
  const f = fixture();
  try {
    f.emit('review_failed');
    const first = await f.scheduler.tick();
    assert.equal(first.started, true);
    assert.equal(f.calls.addChat.length, 1);
    const chat = f.calls.addChat[0];
    assert.equal(chat.pickPurpose, 'operator_run');
    assert.equal(chat.isTemporary, true);
    assert.equal(chat.sdkMode, 'plan');
    assert.equal(chat.agentTransport, 'claude');
    assert.ok(chat.operatorRunId && chat.operatorParentChatId);
    assert.equal(f.calls.start[0].mode, 'plan');
    assert.deepEqual(f.calls.start[0].origin, { kind: 'system', subtype: 'operator' });
    assert.match(f.calls.start[0].prompt, /<untrusted source="event:review_failed"/);
    f.state.now += 100;
    f.emit('needs_human', 'needs_human: leaf l2, y', path.resolve('/tmp/operator-ws-other'));
    const second = await f.scheduler.tick();
    assert.deepEqual(second, { skipped: 'running' });
    assert.equal(f.q("SELECT * FROM operator_runs WHERE state='running'").length, 1);
    assert.equal(f.calls.addChat.length, 1);
  } finally { f.cleanup(); }
});

test('a report finishes the run: events acked, tool-call summary appended to the owner thread', async () => {
  const f = fixture();
  try {
    f.emit('review_failed');
    const { runId } = await f.scheduler.tick();
    appendOperatorAudit({ runId, tool: 'todo_list', outcome: 'allowed' }, f.store);
    appendOperatorAudit({ runId, tool: 'todo_list', outcome: 'allowed' }, f.store);
    appendOperatorAudit({ runId, tool: 'todo_update', outcome: 'denied', reason: 'not allowed' }, f.store);
    recordOperatorRunReport({ runId }, { summary: 'All good', proposals: [{ title: 'Retry review', rationale: 'because' }] }, f.store);
    f.state.tokens = 1234;
    f.state.now += 5000;
    const done = await f.scheduler.tick();
    assert.equal(done.ok, true);
    assert.equal(f.q('SELECT state FROM operator_runs WHERE id=?', runId)[0].state, 'completed');
    assert.equal(f.q("SELECT state FROM operator_internal_queue WHERE state='acked' AND claimed_by_run=?", runId).length, 1);
    const text = f.notices.map((n) => n.text).join('\n');
    assert.match(text, /All good/);
    assert.match(text, /Proposals: Retry review/);
    assert.match(text, /Tool calls: 3, 1 denied — todo_list×2/);
    assert.match(text, /Tokens: 1234/);
    assert.equal(f.q('SELECT tokens_used FROM operator_runs WHERE id=?', runId)[0].tokens_used, 1234);
    assert.equal(readBreaker(f.store).failures, 0);
  } finally { f.cleanup(); }
});

test('summarizeRunToolCalls without audit rows', () => {
  const f = fixture();
  try { assert.equal(summarizeRunToolCalls(f.store, 'nope'), 'Tool calls: none.'); } finally { f.cleanup(); }
});

test('deadline fails the run, cancels the chat and returns the event once, then parks it', async () => {
  const f = fixture({ runDeadlineMs: 60_000 });
  try {
    f.emit('review_failed');
    const { runId } = await f.scheduler.tick();
    f.state.now += 61_000;
    const failed = await f.scheduler.tick();
    assert.deepEqual([failed.ok, failed.reason], [false, 'deadline']);
    assert.equal(f.calls.cancel.length, 1);
    assert.equal(f.q('SELECT state, failure_reason FROM operator_runs WHERE id=?', runId)[0].failure_reason, 'deadline');
    assert.equal(f.q("SELECT attempts FROM operator_internal_queue WHERE state='pending'").length, 1);
    await f.scheduler.tick(); // second attempt starts again
    f.state.now += 61_000;
    await f.scheduler.tick();
    assert.equal(f.q("SELECT * FROM operator_internal_queue WHERE state='parked'").length, 1);
  } finally { f.cleanup(); }
});

test('an idle chat without a report is missing_report', async () => {
  const f = fixture();
  try {
    f.emit('review_failed');
    await f.scheduler.tick();
    f.state.busy = false;
    f.state.now += 500;
    assert.deepEqual(await f.scheduler.tick(), { skipped: 'running' }, 'inside the grace period');
    f.state.now += 2000;
    const failed = await f.scheduler.tick();
    assert.equal(failed.reason, 'missing_report');
  } finally { f.cleanup(); }
});

test('token cap cancels a triage run', async () => {
  const f = fixture({ perRunTokens: { triage: 1000, diagnosis: 250000 } });
  try {
    f.emit('operator_test');
    const { runId } = await f.scheduler.tick();
    assert.equal(f.q('SELECT run_kind FROM operator_runs WHERE id=?', runId)[0].run_kind, 'triage');
    f.state.tokens = 1500;
    const failed = await f.scheduler.tick();
    assert.equal(failed.reason, 'token_cap');
    assert.equal(f.calls.cancel.length, 1);
  } finally { f.cleanup(); }
});

test('a harness other than claude|sdk fails the run as no_safe_harness without creating a chat; it is not a breaker failure', async () => {
  const f = fixture({ circuitBreakerFailures: 1 });
  try {
    f.state.harness = 'codex';
    f.emit('review_failed');
    const result = await f.scheduler.tick();
    assert.equal(result.reason, 'no_safe_harness');
    assert.equal(f.calls.addChat.length, 0);
    assert.equal(f.calls.start.length, 0);
    assert.equal(f.q('SELECT state, failure_reason FROM operator_runs')[0].failure_reason, 'no_safe_harness');
    assert.equal(readBreaker(f.store).paused, false);
    f.state.harness = '';
    f.state.now += 10;
    f.emit('blocked', 'blocked: leaf l9, z');
    assert.equal((await f.scheduler.tick()).reason, 'no_model');
  } finally { f.cleanup(); }
});

test('circuit breaker: counted failures trip it once, it persists, owner-priority events still run, clear resumes', async () => {
  const f = fixture({ runDeadlineMs: 60_000, circuitBreakerFailures: 2 });
  try {
    for (let i = 0; i < 2; i += 1) {
      f.emit('needs_human', `needs_human: leaf l${i}, x`);
      f.state.now += 10;
      await f.scheduler.tick();
      f.state.now += 61_000;
      await f.scheduler.tick();
      // drain the retry attempt of this event so the next loop starts a fresh one
      while (f.q("SELECT 1 FROM operator_internal_queue WHERE state IN ('pending','claimed')").length) {
        const r = await f.scheduler.tick();
        if (r.skipped === 'circuit_open') break;
        f.state.now += 61_000;
      }
    }
    const breaker = readBreaker(f.store);
    assert.equal(breaker.paused, true);
    assert.equal(breaker.notified, true);
    assert.equal(f.notices.filter((n) => n.meta.kind === 'circuit_open').length, 1);
    // A new priority 2 event is held back; a priority 1 event (watcher_stopped) is not, but 0 is the only exempt class.
    f.emit('blocked', 'blocked: leaf lz, x');
    assert.equal((await f.scheduler.tick()).skipped, 'circuit_open');
    clearBreaker(f.store);
    assert.equal(readBreaker(f.store).paused, false);
    const resumed = await f.scheduler.tick();
    assert.equal(resumed.started, true);
  } finally { f.cleanup(); }
});

test('breaker counting is idempotent per run and a completed run resets the counter', () => {
  const f = fixture();
  try {
    const a = recordRunOutcome(f.store, { runId: 'r1', ok: false, reason: 'deadline', threshold: 3 });
    assert.equal(a.failures, 1);
    assert.equal(recordRunOutcome(f.store, { runId: 'r1', ok: false, reason: 'deadline', threshold: 3 }).failures, 1);
    assert.equal(recordRunOutcome(f.store, { runId: 'r2', ok: false, reason: 'no_safe_harness', threshold: 3 }).failures, 1);
    assert.equal(recordRunOutcome(f.store, { runId: 'r3', ok: false, reason: 'server_shutdown', threshold: 3 }).failures, 1);
    assert.equal(recordRunOutcome(f.store, { runId: 'r4', ok: true, threshold: 3 }).failures, 0);
    // persistent: a fresh read (new process) sees the counter
    recordRunOutcome(f.store, { runId: 'r5', ok: false, reason: 'missing_report', threshold: 3 });
    assert.equal(readBreaker(f.store).failures, 1);
  } finally { f.cleanup(); }
});

test('hourly limit holds back priority 2 events but not priority 0-1', async () => {
  const f = fixture({ runsPerHour: 1 });
  try {
    f.emit('review_failed');
    const { runId } = await f.scheduler.tick();
    recordOperatorRunReport({ runId }, { summary: 's' }, f.store);
    f.state.now += 5000;
    await f.scheduler.tick();
    f.emit('blocked', 'blocked: leaf l5, x');
    f.state.now += 10;
    assert.equal((await f.scheduler.tick()).skipped, 'runs_per_hour');
    f.emit('watcher_stopped', 'watcher_stopped: reason manual');
    f.state.now += 10;
    assert.equal((await f.scheduler.tick()).started, true);
  } finally { f.cleanup(); }
});

test('daily budget: triage-only at 80%, stop at 100% with a reserve for priority 0-1 and one notice', async () => {
  const s = { dailyTokenBudget: 100_000, triageOnlyAt: 0.8, reserveFraction: 0.1 };
  assert.deepEqual(evaluateDailyBudget(79_999, s, 2), { allowed: true, triageOnly: false });
  assert.equal(evaluateDailyBudget(80_000, s, 2).triageOnly, true);
  assert.equal(evaluateDailyBudget(100_000, s, 2).allowed, false);
  assert.equal(evaluateDailyBudget(100_000, s, 1).reserve, true);
  assert.equal(evaluateDailyBudget(110_000, s, 1).allowed, false);

  const f = fixture({ dailyTokenBudget: 10_000 });
  try {
    const db = openOperatorStore(f.store);
    try {
      db.prepare("INSERT INTO operator_runs(id, state, owner_instance_id, heartbeat_at, lease_expires_at, started_at, tokens_used) VALUES ('old','completed','x',?,?,?,8500)")
        .run(new Date(T0).toISOString(), new Date(T0).toISOString(), new Date(T0 - 1000).toISOString());
    } finally { db.close(); }
    f.emit('review_failed');
    const started = await f.scheduler.tick();
    assert.equal(started.kind, 'triage', '85% of the daily budget forces triage');
    recordOperatorRunReport({ runId: started.runId }, { summary: 's' }, f.store);
    const db2 = openOperatorStore(f.store);
    try { db2.prepare('UPDATE operator_runs SET tokens_used = 12000 WHERE id = ?').run('old'); } finally { db2.close(); }
    f.state.now += 5000;
    await f.scheduler.tick();
    f.emit('blocked', 'blocked: leaf l6, x');
    f.state.now += 10;
    assert.equal((await f.scheduler.tick()).skipped, 'daily_budget_reserve_spent');
    await f.scheduler.tick();
    assert.equal(f.notices.filter((n) => n.meta.kind === 'budget').length, 1);
  } finally { f.cleanup(); }
});

test('integration_ready is always a triage run', async () => {
  const f = fixture();
  try {
    f.emit('integration_ready', 'integration_ready: leaf l3, ok');
    f.state.now += 1;
    const started = await f.scheduler.tick();
    assert.equal(started.kind, 'triage');
  } finally { f.cleanup(); }
});

test('settings are clamped and the scheduler boots only when enabled', async () => {
  const s = normalizeOperatorSettings({ enabled: true, runsPerHour: -5, perRunTokens: { triage: 'x' }, dailyTokenBudget: 5 });
  assert.equal(s.runsPerHour, 1);
  assert.equal(s.perRunTokens.triage, 60_000);
  assert.equal(s.dailyTokenBudget, 10_000);
  const d = normalizeOperatorSettings(undefined);
  assert.deepEqual([d.enabled, d.runsPerHour, d.perRunTokens.diagnosis, d.dailyTokenBudget, d.runDeadlineMs], [false, 12, 250_000, 1_500_000, 900_000]);
  assert.equal(startOperatorSchedulerSafely({ settings: {} }), false);
  const f = fixture();
  try {
    assert.equal(startOperatorSchedulerSafely({ settings: { operatorInternal: { enabled: true } }, schedulerOptions: { dataDir: f.dataDir, logger: quiet, tickMs: 3_600_000, deps: f.scheduler && {} } }), true);
    assert.equal(startOperatorSchedulerSafely({ settings: { operatorInternal: { enabled: true } } }), true, 'second start is a no-op');
  } finally {
    await stopOperatorSchedulerSafely();
    f.cleanup();
  }
});

test('getMeta of the reserved chat id survives', () => {
  const f = fixture();
  try {
    const db = openOperatorStore(f.store);
    try { assert.equal(getMeta(db, OPERATOR_CHAT_META_KEY), ''); } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('F2: the default picker is called with a hard exclude list covering every non-safe harness', async () => {
  const excluded = operatorExcludedHarnesses();
  for (const id of ['codex', 'opencode', 'antigravity', 'deepseek', 'qwen']) assert.ok(excluded.includes(id), id);
  for (const id of OPERATOR_SAFE_HARNESSES) assert.ok(!excluded.includes(id), id);
  const f = fixture();
  try {
    let seen = null;
    const scheduler = createOperatorScheduler({
      dataDir: f.dataDir, settings: { enabled: true, coalesceMs: 0 }, now: () => f.state.now, logger: quiet,
      deps: { ...scheduler_deps(f), pickExecutor: undefined, pickModel: (input) => { seen = input; return { ok: true, pick: { harness: 'claude', model: 'm' } }; } },
    });
    f.emit('review_failed');
    assert.equal((await scheduler.tick()).started, true);
    assert.deepEqual(seen.excludeHarnesses, excluded);
    assert.equal(seen.purpose, 'operator_run');
    assert.equal(seen.role, 'plan');
  } finally { f.cleanup(); }
});

function scheduler_deps(f) {
  return {
    chatDeps: { getChatById: async (id) => f.rows.get(id) || null, loadChats: async () => [...f.rows.values()], addChat: async (_s, t, _f, _w, _m, x) => { const row = { id: x.id, ...x }; f.rows.set(row.id, row); return row; } },
    addChat: async (_s, t, _f, _w, _m, x) => ({ id: x.id, ...x }),
    startChatRun: async () => ({ accepted: true }), cancelRun: async () => {}, probeLiveness: async () => ({ known: true, busy: true }),
    measureTokens: async () => 0, appendNotice: async () => {}, readWorkspaceState: async () => '',
  };
}

test('F3: an exception after the slot was claimed fails the run as start_failed and returns the events', async () => {
  const f = fixture();
  try {
    const scheduler = createOperatorScheduler({
      dataDir: f.dataDir, settings: { enabled: true, coalesceMs: 0 }, now: () => f.state.now, logger: quiet,
      deps: { ...scheduler_deps(f), pickExecutor: async () => { throw new Error('picker exploded'); } },
    });
    f.emit('review_failed');
    const result = await scheduler.tick();
    assert.equal(result.reason, 'start_failed');
    assert.equal(f.q("SELECT * FROM operator_runs WHERE state='running'").length, 0);
    assert.equal(f.q("SELECT failure_reason FROM operator_runs")[0].failure_reason, 'start_failed');
    assert.equal(f.q("SELECT * FROM operator_internal_queue WHERE state='pending'").length, 1, 'event returned for one retry');
  } finally { f.cleanup(); }
});

test('F3: a running row without chat/deadline (crashed start) is bounded from started_at', async () => {
  const f = fixture({ runDeadlineMs: 60_000 });
  try {
    f.emit('review_failed');
    const orphan = f.scheduler;
    // Simulate the crash window: slot claimed by this instance, chat_id/deadline_at never written.
    const { claimRunSlot } = await import('../lib/operator/operator-internal-store.js');
    claimRunSlot({ ...f.store, now: f.state.now }, { ownerInstanceId: orphan.instanceId, workspace: WS });
    assert.deepEqual(await orphan.tick(), { skipped: 'running' });
    f.state.now += 61_000;
    assert.equal((await orphan.tick()).reason, 'start_failed');
    assert.equal(f.q("SELECT * FROM operator_runs WHERE state='running'").length, 0);
  } finally { f.cleanup(); }
});

test('F4: disabling at runtime keeps supervising the live run, then reports disabled', async () => {
  const f = fixture({ runDeadlineMs: 60_000 });
  try {
    let enabled = true;
    const scheduler = createOperatorScheduler({
      dataDir: f.dataDir, settings: () => normalizeOperatorSettings({ enabled, coalesceMs: 0, runDeadlineMs: 60_000 }), now: () => f.state.now, logger: quiet,
      deps: { ...scheduler_deps(f), pickExecutor: async () => ({ harness: 'claude', model: 'm' }) },
    });
    f.emit('review_failed');
    assert.equal((await scheduler.tick()).started, true);
    enabled = false;
    assert.deepEqual(await scheduler.tick(), { skipped: 'running' });
    f.state.now += 61_000;
    assert.equal((await scheduler.tick()).reason, 'deadline');
    assert.deepEqual(await scheduler.tick(), { skipped: 'disabled' });
    f.emit('blocked', 'blocked: leaf l8, x');
    assert.deepEqual(await scheduler.tick(), { skipped: 'disabled' }, 'no new run while disabled');
  } finally { f.cleanup(); }
});
