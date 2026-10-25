import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeupScheduler } from '../lib/wakeup-scheduler.js';
import { createUsageLimitResumeKind, RESUME_CHAT_PROMPT } from '../lib/usage-limit-resume-executor.js';
import { resolvePauseDueAt } from '../lib/usage-limit-resume-policy.js';

const RESET = Date.parse('2026-10-19T12:00:00Z');
const baseSettings = {
  enabled: true, marginMs: 120_000, jitterMs: 0, maxChain: 2, maxPerTick: 3,
  catchUpMs: 900_000, allowPremium: false, resumeDelegations: true,
};
const DUE = RESET + baseSettings.marginMs;

const pause = (id, over = {}) => ({
  id, kind: 'usage_limit_resume', subjectType: 'chat', subjectId: `chat-${id}`, parentChatId: '', leafId: '',
  subjectAttemptId: '', subjectModel: 'claude-sonnet-4', harness: 'claude', model: '',
  resetAt: new Date(RESET).toISOString(), resetSource: 'provider', code: 'usage_limit',
  pausedAt: new Date(RESET - 60_000).toISOString(), state: 'armed', reason: '', attempts: 0,
  pendingAttempt: 0, resumeRequestId: '', lastResumeAt: '', chain: 0, updatedAt: '', ...over,
});
const delegationPause = (id, over = {}) => pause(id, {
  subjectType: 'delegation', subjectId: `del-${id}`, subjectAttemptId: 'att-1', ...over,
});

function setup({ rows, settings = {}, deps = {} } = {}) {
  const store = { rows: rows.map((r) => ({ ...r })) };
  const calls = { startChatRun: [], retry: [] };
  const fake = {
    getLimit: () => null,
    estimateCostTier: () => 2,
    loadChat: (id) => ({ id }),
    getTransport: () => 'sdk',
    hasChatRunAdapter: () => true,
    startChatRun: async (input) => { calls.startChatRun.push(input); return { accepted: true, runId: 'r' }; },
    lookupChatRunRequest: () => null,
    probeChatRunLiveness: () => ({ known: true, busy: false }),
    getDelegation: () => ({ id: 'd', status: 'failed', attemptId: 'att-1' }),
    retryDelegation: async (id) => { calls.retry.push(id); return { ok: true }; },
    readSettings: () => ({ ...baseSettings, ...settings }),
    ...deps,
  };
  const scheduler = createWakeupScheduler({
    store: {
      list: () => store.rows.map((r) => ({ ...r })),
      patch: (id, fields, _now, expectState) => {
        const row = store.rows.find((r) => r.id === id);
        if (!row || (expectState && row.state !== expectState)) return null;
        Object.assign(row, fields);
        return { ...row };
      },
    },
  });
  scheduler.registerKind(createUsageLimitResumeKind(fake));
  return { scheduler, store, calls, row: (id = store.rows[0].id) => store.rows.find((r) => r.id === id) };
}

test('before dueAt nothing; at dueAt exactly one resume; two ticks resume once', async () => {
  const t = setup({ rows: [pause('a')] });
  await t.scheduler.tick({ now: DUE - 1 });
  assert.equal(t.calls.startChatRun.length, 0);
  await t.scheduler.tick({ now: DUE });
  await t.scheduler.tick({ now: DUE + 60_000 });
  assert.equal(t.calls.startChatRun.length, 1);
  const call = t.calls.startChatRun[0];
  assert.deepEqual(
    { chatId: call.chatId, prompt: call.prompt, mode: call.mode, requestId: call.requestId },
    { chatId: 'chat-a', prompt: RESUME_CHAT_PROMPT, mode: 'agent', requestId: 'ulresume:a:1' },
  );
  assert.match(RESUME_CHAT_PROMPT, /^\[AUTO-RESUME\]/);
  assert.equal(t.row().state, 'resumed');
  assert.equal(t.row().attempts, 1);
});

test('a defer leaves attempts unchanged and the record armed; the later tick resumes once', async () => {
  let busy = true;
  const t = setup({
    rows: [pause('a')],
    deps: { probeChatRunLiveness: () => ({ known: true, busy, reason: busy ? 'busy' : 'idle' }) },
  });
  await t.scheduler.tick({ now: DUE });
  assert.equal(t.row().state, 'armed');
  assert.equal(t.row().attempts, 0);
  assert.equal(t.calls.startChatRun.length, 0);
  busy = false;
  await t.scheduler.tick({ now: DUE + 60_000 });
  assert.equal(t.calls.startChatRun.length, 1);
});

test('an active later lockout defers, then resumes once it clears', async () => {
  let lockout = { resetAt: new Date(DUE + 300_000).toISOString() };
  const t = setup({ rows: [pause('a')], deps: { getLimit: () => lockout } });
  await t.scheduler.tick({ now: DUE });
  assert.equal(t.calls.startChatRun.length, 0);
  lockout = null;
  await t.scheduler.tick({ now: DUE + 300_001 });
  assert.equal(t.calls.startChatRun.length, 1);
});

test('restart after resuming (chat): lookup accepted:true -> resumed, no second call', async () => {
  const t = setup({
    rows: [pause('a', { state: 'resuming', attempts: 1, pendingAttempt: 1, resumeRequestId: 'ulresume:a:1' })],
    deps: { lookupChatRunRequest: () => ({ accepted: true, runId: 'r' }) },
  });
  await t.scheduler.tick({ now: DUE + 1000 });
  assert.equal(t.row().state, 'resumed');
  assert.equal(t.calls.startChatRun.length, 0);
});

test('restart after resuming (chat): accepted:false refunds to armed and waits a tick', async () => {
  const t = setup({
    rows: [pause('a', { state: 'resuming', attempts: 1, pendingAttempt: 1, resumeRequestId: 'ulresume:a:1' })],
    deps: { lookupChatRunRequest: () => ({ accepted: false }) },
  });
  await t.scheduler.tick({ now: DUE + 1000 });
  assert.equal(t.row().state, 'armed');
  assert.equal(t.row().attempts, 0);
  assert.equal(t.calls.startChatRun.length, 0);
});

for (const [name, lookup, probe, expected] of [
  ['null + busy probe -> resumed', () => null, { known: true, busy: true }, ['resumed', '']],
  ['throwing lookup + busy probe -> resumed', () => { throw new Error('x'); }, { known: true, busy: true }, ['resumed', '']],
  ['null + idle probe -> blocked start_uncertain', () => null, { known: true, busy: false }, ['blocked', 'start_uncertain']],
  ['null + unknown probe -> blocked start_uncertain', () => null, { known: false, busy: false }, ['blocked', 'start_uncertain']],
]) {
  test(`restart after resuming (chat): ${name}`, async () => {
    const t = setup({
      rows: [pause('a', { state: 'resuming', attempts: 1, pendingAttempt: 1, resumeRequestId: 'ulresume:a:1' })],
      deps: { lookupChatRunRequest: lookup, probeChatRunLiveness: () => probe },
    });
    await t.scheduler.tick({ now: DUE + 1000 });
    await t.scheduler.tick({ now: DUE + 61_000 });
    assert.deepEqual([t.row().state, t.row().reason], expected);
    assert.equal(t.calls.startChatRun.length, 0, 'never a second provider call');
  });
}

test('chat start errors: refusal refunds, chat_not_found blocks, ambiguous stays resuming', async () => {
  const run = async (code) => {
    const t = setup({
      rows: [pause('a')],
      deps: { startChatRun: async () => { const e = new Error(code); e.code = code; throw e; } },
    });
    await t.scheduler.tick({ now: DUE });
    return t.row();
  };
  const busy = await run('recipient_busy');
  assert.deepEqual([busy.state, busy.attempts], ['armed', 0]);
  assert.equal((await run('chat_archived')).state, 'armed');
  const missing = await run('chat_not_found');
  assert.deepEqual([missing.state, missing.reason], ['blocked', 'chat_not_found']);
  const timeout = await run('ETIMEDOUT');
  assert.deepEqual([timeout.state, timeout.pendingAttempt], ['resuming', 1]);
});

test('delegation preflight: moved row -> cancelled subject_moved, no retry', async () => {
  for (const row of [
    { status: 'completed', attemptId: 'att-1' },
    { status: 'running', attemptId: 'att-1' },
    { status: 'failed', attemptId: 'att-2' },
  ]) {
    const t = setup({ rows: [delegationPause('a')], deps: { getDelegation: () => row } });
    await t.scheduler.tick({ now: DUE });
    assert.deepEqual([t.row().state, t.row().reason], ['cancelled', 'subject_moved']);
    assert.equal(t.calls.retry.length, 0);
  }
});

test('delegation preflight: missing row -> blocked session_not_resumable', async () => {
  const t = setup({ rows: [delegationPause('a')], deps: { getDelegation: () => null } });
  await t.scheduler.tick({ now: DUE });
  assert.deepEqual([t.row().state, t.row().reason], ['blocked', 'session_not_resumable']);
  assert.equal(t.calls.retry.length, 0);
});

test('delegation resume calls retry once and maps refusals', async () => {
  const ok = setup({ rows: [delegationPause('a')] });
  await ok.scheduler.tick({ now: DUE });
  await ok.scheduler.tick({ now: DUE + 60_000 });
  assert.deepEqual(ok.calls.retry, ['del-a']);
  assert.equal(ok.row().state, 'resumed');
  for (const code of ['still_active', 'update_in_progress', 'slot_conflict', 'runtime_not_ready', 'parent_archived']) {
    const t = setup({ rows: [delegationPause('a')], deps: { retryDelegation: async () => ({ ok: false, code }) } });
    await t.scheduler.tick({ now: DUE });
    assert.deepEqual([t.row().state, t.row().attempts], ['armed', 0], code);
  }
  const gone = setup({ rows: [delegationPause('a')], deps: { retryDelegation: async () => ({ ok: false, code: 'not_found' }) } });
  await gone.scheduler.tick({ now: DUE });
  assert.deepEqual([gone.row().state, gone.row().reason], ['blocked', 'session_not_resumable']);
  const thrown = setup({ rows: [delegationPause('a')], deps: { retryDelegation: async () => { throw new Error('boom'); } } });
  await thrown.scheduler.tick({ now: DUE });
  assert.equal(thrown.row().state, 'resuming');
});

test('delegation restart: same attemptId -> armed refunded; new attemptId -> resumed, no retry', async () => {
  const resuming = { state: 'resuming', attempts: 1, pendingAttempt: 1, resumeRequestId: 'ulresume:a:1' };
  const same = setup({ rows: [delegationPause('a', resuming)] });
  await same.scheduler.tick({ now: DUE + 1000 });
  assert.deepEqual([same.row().state, same.row().attempts], ['armed', 0]);
  assert.equal(same.calls.retry.length, 0);
  const moved = setup({
    rows: [delegationPause('a', resuming)],
    deps: { getDelegation: () => ({ status: 'running', attemptId: 'att-2' }) },
  });
  await moved.scheduler.tick({ now: DUE + 1000 });
  assert.equal(moved.row().state, 'resumed');
  assert.equal(moved.calls.retry.length, 0);
  const missing = setup({ rows: [delegationPause('a', resuming)], deps: { getDelegation: () => null } });
  await missing.scheduler.tick({ now: DUE + 1000 });
  assert.deepEqual([missing.row().state, missing.row().reason], ['blocked', 'session_not_resumable']);
});

test('10 due records with maxPerTick:3 -> 3 resumes in dueAt order', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => pause(`p${i}`, {
    resetAt: new Date(RESET - i * 1000).toISOString(),
  }));
  const t = setup({ rows, settings: { maxPerTick: 3 } });
  await t.scheduler.tick({ now: DUE + 60_000 });
  // Earlier reset => earlier dueAt: p9 is the oldest.
  assert.deepEqual(t.calls.startChatRun.map((c) => c.chatId), ['chat-p9', 'chat-p8', 'chat-p7']);
});

test('policy gates block or expire with no provider call', async () => {
  const cases = [
    ['maxChain', pause('a', { chain: 2 }), {}, {}, 'blocked', 'chain_exhausted'],
    ['premium', pause('a'), {}, { estimateCostTier: () => 5 }, 'blocked', 'premium_model'],
    ['empty subjectModel', pause('a', { subjectModel: '' }), {}, {}, 'blocked', 'premium_model'],
    ['fallback-ttl', pause('a', { resetSource: 'fallback-ttl' }), {}, {}, 'blocked', 'unconfirmed_reset'],
  ];
  for (const [name, row, settings, deps, state, reason] of cases) {
    const t = setup({ rows: [row], settings, deps });
    await t.scheduler.tick({ now: DUE });
    assert.deepEqual([t.row().state, t.row().reason], [state, reason], name);
    assert.equal(t.calls.startChatRun.length, 0, name);
  }
  const late = setup({ rows: [pause('a')] });
  await late.scheduler.tick({ now: DUE + baseSettings.catchUpMs + 1 });
  assert.deepEqual([late.row().state, late.row().reason], ['expired', 'catch_up_window_missed']);
  assert.equal(late.calls.startChatRun.length, 0);
  const allowed = setup({ rows: [pause('a')], settings: { allowPremium: true }, deps: { estimateCostTier: () => 5 } });
  await allowed.scheduler.tick({ now: DUE });
  assert.equal(allowed.calls.startChatRun.length, 1);
});

test('a chat without a run adapter or a missing chat is session_not_resumable', async () => {
  const noAdapter = setup({ rows: [pause('a')], deps: { hasChatRunAdapter: () => false } });
  await noAdapter.scheduler.tick({ now: DUE });
  assert.deepEqual([noAdapter.row().state, noAdapter.row().reason], ['blocked', 'session_not_resumable']);
  const gone = setup({ rows: [pause('a')], deps: { loadChat: () => null } });
  await gone.scheduler.tick({ now: DUE });
  assert.equal(gone.row().reason, 'session_not_resumable');
});

test('feature off: no resume and rows stay armed; resumeDelegations:false skips delegations', async () => {
  const off = setup({ rows: [pause('a')], settings: { enabled: false } });
  await off.scheduler.tick({ now: DUE });
  assert.equal(off.row().state, 'armed');
  assert.equal(off.calls.startChatRun.length, 0);
  const noDel = setup({ rows: [delegationPause('a')], settings: { resumeDelegations: false } });
  await noDel.scheduler.tick({ now: DUE });
  assert.equal(noDel.row().state, 'armed');
  assert.equal(noDel.calls.retry.length, 0);
});

test('dueAt is derived from current settings, never stored', () => {
  const kind = createUsageLimitResumeKind({ readSettings: () => baseSettings });
  assert.equal(kind.resolveDueAt(pause('a'), baseSettings), DUE);
  assert.equal(resolvePauseDueAt(pause('a'), { ...baseSettings, marginMs: 0 }), RESET);
});

test('F1: retry start_failed with a fresh attemptId is blocked, never resumed', async () => {
  let row = { status: 'failed', attemptId: 'att-1' };
  const t = setup({
    rows: [delegationPause('a')],
    deps: {
      getDelegation: () => row,
      retryDelegation: async () => { row = { status: 'failed', attemptId: 'att-2' }; return { ok: false, code: 'start_failed' }; },
    },
  });
  await t.scheduler.tick({ now: DUE });
  assert.deepEqual([t.row().state, t.row().reason], ['blocked', 'start_failed']);
});

test('F1: crash with a new attemptId already failed -> blocked start_uncertain, no retry', async () => {
  const calls = [];
  const t = setup({
    rows: [delegationPause('a', { state: 'resuming', attempts: 1, pendingAttempt: 1 })],
    deps: {
      getDelegation: () => ({ status: 'failed', attemptId: 'att-2' }),
      retryDelegation: async (id) => { calls.push(id); return { ok: true }; },
    },
  });
  await t.scheduler.tick({ now: DUE });
  assert.deepEqual([t.row().state, t.row().reason], ['blocked', 'start_uncertain']);
  assert.equal(calls.length, 0);
});

test('F2: unknown liveness defers (parent_busy); known idle resumes', async () => {
  const t = setup({ rows: [pause('a')], deps: { probeChatRunLiveness: () => ({ known: false, busy: false }) } });
  await t.scheduler.tick({ now: DUE });
  assert.deepEqual([t.row().state, t.row().attempts], ['armed', 0]);
  assert.equal(t.calls.startChatRun.length, 0);
  const idle = setup({ rows: [pause('a')] });
  await idle.scheduler.tick({ now: DUE });
  assert.equal(idle.calls.startChatRun.length, 1);
});
