/**
 * Tests for the manual resume service (leaf R12): CAS, idempotency, path
 * selection, gates and fencing. Each test uses its own temp store.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeRecoveryStore,
  getRun,
  openRecoveryStore,
  transitionRun,
  writeRunIntent,
} from '../lib/recovery/recovery-store.ts';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import { isRunCancelled, markRunWaiting, requestRunCancel } from '../lib/recovery/recovery-queue.ts';
import {
  RESUME_CONTINUATION_PROMPT,
  checkRunFence,
  createRecoveryResumeService,
  finishResumedAttempt,
  recordResumedAttemptAck,
} from '../lib/recovery/recovery-resume.ts';
import { noteChatRunFinished } from '../lib/chat-run/chat-run-recovery.ts';
import { createRuntimeRecoveryResumeService } from '../lib/routes/recovery-resume-routes.js';
import { makeTempDir } from './helpers/temp-dir.js';

function setup(extra = {}) {
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-resume-') });
  const ids = createRecoveryIds();
  writeRunIntent(
    {
      logicalRunId: ids.logicalRunId,
      attemptId: ids.attemptId,
      requestId: ids.requestId,
      family: 'chat',
      owner: 'chat-run-service',
      chatId: 'chat-1',
      sessionId: 'sess-1',
      harness: 'claude',
      ...extra,
    },
    store
  );
  return { store, ids };
}

function interrupt(store, ids, to = 'interrupted', patch = { interruptedPrompt: 'SECRET LAST PROMPT' }) {
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun(
    { logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store).run;
  return transitionRun(
    { logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to, reason: 'server_restart', patch },
    store
  ).run;
}

function build(store, over = {}) {
  const calls = { reattach: [], start: [] };
  const service = createRecoveryResumeService({
    store,
    probeLiveness: () => 'dead',
    getCapabilities: () => ({ canReattach: true, canResumeSession: true }),
    reattach: async (i) => { calls.reattach.push(i); return { accepted: true, adapterRunId: 'a1' }; },
    startContinuation: async (i) => { calls.start.push(i); return { accepted: true, adapterRunId: 'a2' }; },
    ...over,
  });
  return { service, calls };
}

const req = (ids, run, key = 'k1', extra = {}) => ({
  chatId: 'chat-1',
  logicalRunId: ids.logicalRunId,
  expectedState: run.state,
  expectedRevision: run.revision,
  idempotencyKey: key,
  ...extra,
});

test('new turn in same session; replay with same key does not launch twice', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service, calls } = build(store);
  const first = await service.resumeRun(req(ids, run));
  assert.equal(first.status, 'resumed');
  assert.equal(first.path, 'new_turn_same_session');
  assert.match(first.attemptId, /^att/);
  const again = await service.resumeRun(req(ids, run));
  assert.equal(again.replayed, true);
  assert.equal(again.attemptId, first.attemptId);
  assert.equal(calls.start.length, 1);
  assert.equal(getRun(ids.logicalRunId, store).state, 'running'); // fenced ack linked adapter run a2
  closeRecoveryStore(store);
});

test('no replay of last prompt: fixed neutral continuation only', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service, calls } = build(store);
  await service.resumeRun(req(ids, run));
  assert.equal(calls.start[0].prompt, RESUME_CONTINUATION_PROMPT);
  assert.ok(!calls.start[0].prompt.includes('SECRET LAST PROMPT'));
  assert.match(calls.start[0].prompt, /verify/i);
  closeRecoveryStore(store);
});

test('stale CAS token => conflict, nothing launched', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service, calls } = build(store);
  const stale = await service.resumeRun(req(ids, { ...run, revision: run.revision - 1 }));
  assert.equal(stale.status, 'conflict');
  const wrongState = await service.resumeRun(req(ids, { ...run, state: 'unknown' }, 'k2'));
  assert.equal(wrongState.status, 'conflict');
  assert.equal(calls.start.length, 0);
  assert.equal(getRun(ids.logicalRunId, store).state, 'interrupted');
  closeRecoveryStore(store);
});

test('concurrent double resume: one launch, other already_recovering', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  let release;
  const gateP = new Promise((r) => { release = r; });
  const { service, calls } = build(store, {
    startContinuation: async (i) => { calls.start.push(i); await gateP; return { accepted: true }; },
  });
  const a = service.resumeRun(req(ids, run, 'ka'));
  const b = service.resumeRun(req(ids, run, 'kb'));
  const second = await b;
  assert.equal(second.status, 'already_recovering');
  release();
  assert.equal((await a).status, 'resumed');
  assert.equal(calls.start.length, 1);
  closeRecoveryStore(store);
});

test('path selection: reattach, unsupported, alive without reattach, unknown liveness', async () => {
  let s = setup();
  let run = interrupt(s.store, s.ids);
  let b = build(s.store, { probeLiveness: () => 'alive' });
  let r = await b.service.resumeRun(req(s.ids, run));
  assert.equal(r.path, 'reattach');
  assert.equal(b.calls.reattach.length, 1);
  assert.equal(b.calls.start.length, 0);
  closeRecoveryStore(s.store);

  s = setup();
  run = interrupt(s.store, s.ids);
  b = build(s.store, { getCapabilities: () => ({ canResumeSession: false, transcriptLost: true }) });
  r = await b.service.resumeRun(req(s.ids, run));
  assert.equal(r.status, 'unsupported');
  assert.equal(r.details.transcriptLost, true);
  assert.equal(getRun(s.ids.logicalRunId, s.store).state, 'interrupted');
  closeRecoveryStore(s.store);

  s = setup();
  run = interrupt(s.store, s.ids);
  b = build(s.store, { probeLiveness: () => 'alive', getCapabilities: () => ({ canResumeSession: true }) });
  r = await b.service.resumeRun(req(s.ids, run));
  assert.equal(r.status, 'executor_alive');
  assert.equal(b.calls.start.length, 0);
  closeRecoveryStore(s.store);

  s = setup();
  run = interrupt(s.store, s.ids, 'unknown');
  b = build(s.store);
  r = await b.service.resumeRun(req(s.ids, run));
  assert.equal(r.status, 'liveness_unknown');
  r = await b.service.resumeRun(req(s.ids, run, 'k2', { confirmUnknown: true }));
  assert.equal(r.status, 'resumed');
  closeRecoveryStore(s.store);

  // A lifecycle `unknown` run whose boot re-probe plan is not exhausted is
  // refused even with confirmUnknown; once escalated, confirmation resumes it.
  s = setup();
  run = interrupt(s.store, s.ids, 'unknown', { bootEvidence: { state: 'unknown', escalated: false } });
  b = build(s.store);
  r = await b.service.resumeRun(req(s.ids, run, 'k3', { confirmUnknown: true }));
  assert.equal(r.status, 'liveness_unknown');
  assert.equal(r.reason, 'reprobe_pending');
  assert.equal(b.calls.start.length, 0);
  closeRecoveryStore(s.store);

  s = setup();
  run = interrupt(s.store, s.ids, 'unknown', { bootEvidence: { state: 'unknown', escalated: true } });
  b = build(s.store);
  r = await b.service.resumeRun(req(s.ids, run, 'k4', { confirmUnknown: true }));
  assert.equal(r.status, 'resumed');
  closeRecoveryStore(s.store);
});

test('no persisted session => unsupported, never a silent fresh session', async () => {
  const { store, ids } = setup({ sessionId: '' });
  const run = interrupt(store, ids);
  const { service, calls } = build(store);
  const r = await service.resumeRun(req(ids, run));
  assert.equal(r.status, 'unsupported');
  assert.equal(calls.start.length, 0);
  closeRecoveryStore(store);
});

test('Stop is honored', async () => {
  const { store, ids } = setup();
  interrupt(store, ids);
  requestRunCancel({ logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId, reason: 'user' }, store);
  const { service, calls } = build(store);
  const r = await service.resumeRun(req(ids, getRun(ids.logicalRunId, store)));
  assert.equal(r.status, 'cancelled');
  assert.equal(calls.start.length, 0);
  closeRecoveryStore(store);
});

test('waiting question is not auto-answered or resumed', async () => {
  const { store, ids } = setup();
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store).run;
  markRunWaiting(
    { logicalRunId: ids.logicalRunId, expectedRevision: run.revision, kind: 'question', requestId: createRecoveryIds().requestId },
    store
  );
  const { service, calls } = build(store);
  const r = await service.resumeRun(req(ids, getRun(ids.logicalRunId, store)));
  assert.equal(r.status, 'waiting');
  assert.equal(calls.start.length + calls.reattach.length, 0);
  closeRecoveryStore(store);
});

test('gates: limits, family, runStoppingAt, non-chat family', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids, 'interrupted', { runStoppingAt: '2026-01-01' });
  let b = build(store);
  assert.equal((await b.service.resumeRun(req(ids, run))).status, 'stopping');
  b = build(store, { isRunStopping: () => false, checkLimits: () => ({ allowed: false, reason: 'budget' }) });
  const limited = await b.service.resumeRun(req(ids, run, 'k2'));
  assert.equal(limited.status, 'limit_blocked');
  assert.equal(limited.reason, 'budget');
  b = build(store, { isRunStopping: () => false, authorizeFamily: () => ({ allowed: false, reason: 'not_family_owner' }) });
  assert.equal((await b.service.resumeRun(req(ids, run, 'k3'))).status, 'family_blocked');
  closeRecoveryStore(store);
});

test('production policy gate preserves run state when workspace mode blocks resume', async () => {
  for (const [settings, actor, reason, workspaceFolder] of [
    [{ chatRestartRecoveryMode: 'automatic', chatRestartRecoveryWorkspaces: { '/w/off': 'off' } }, 'automatic', 'recovery_mode_off', '/w/off'],
    [{ chatRestartRecoveryMode: 'manual' }, 'automatic', 'recovery_mode_not_automatic', ''],
  ]) {
    const { store, ids } = setup({ workspaceFolder });
    const run = interrupt(store, ids);
    const service = createRuntimeRecoveryResumeService({
      store,
      loadSettings: () => settings,
    });
    const outcome = await service.resumeRun({
      ...req(ids, run, `policy-${actor}`),
      actor,
    });
    assert.equal(outcome.status, 'limit_blocked');
    assert.equal(outcome.reason, reason);
    assert.deepEqual(getRun(ids.logicalRunId, store), run);
    closeRecoveryStore(store);
  }
});

test('production policy blocks a disabled harness before claiming the run', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const service = createRuntimeRecoveryResumeService({
    store,
    loadSettings: () => ({ chatRestartRecoveryMode: 'automatic', enabledHarnesses: ['codex'] }),
  });
  const outcome = await service.resumeRun({ ...req(ids, run, 'disabled-harness'), actor: 'automatic' });
  assert.equal(outcome.status, 'limit_blocked');
  assert.equal(outcome.reason, 'harness_disabled');
  assert.deepEqual(getRun(ids.logicalRunId, store), run);
  closeRecoveryStore(store);
});

test('production policy blocks harness cost limits and chat permission before claiming', async () => {
  for (const testCase of [
    {
      expected: 'harness_usage_limited',
      options: { getHarnessUsageLimit: () => ({ reason: 'cost_cap' }) },
    },
    {
      expected: 'chat_archived',
      options: {
        getHarnessUsageLimit: () => null,
        assertChatCanReceiveMessages: () => {
          const error = new Error('archived');
          error.code = 'chat_archived';
          throw error;
        },
      },
    },
  ]) {
    const { store, ids } = setup();
    const run = interrupt(store, ids);
    const service = createRuntimeRecoveryResumeService({
      store,
      loadSettings: () => ({ chatRestartRecoveryMode: 'automatic', enabledHarnesses: ['claude'] }),
      loadChats: () => [{ id: run.chatId, cursorSessionId: run.sessionId }],
      ...testCase.options,
    });
    const outcome = await service.resumeRun({ ...req(ids, run, `production-${testCase.expected}`), actor: 'automatic' });
    assert.equal(outcome.status, 'limit_blocked');
    assert.equal(outcome.reason, testCase.expected);
    assert.deepEqual(getRun(ids.logicalRunId, store), run);
    closeRecoveryStore(store);
  }
});

test('production policy keeps Stop, waiting and family gates ahead of workspace off', async () => {
  const settings = { chatRestartRecoveryMode: 'automatic', chatRestartRecoveryWorkspaces: { '/w/off': 'off' } };
  const cases = [
    ['cancelled', (store, ids) => requestRunCancel({ logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId, reason: 'user' }, store)],
    ['waiting', (store, ids) => {
      const current = getRun(ids.logicalRunId, store);
      markRunWaiting({ logicalRunId: ids.logicalRunId, expectedRevision: current.revision, kind: 'question', requestId: createRecoveryIds().requestId }, store);
    }],
    ['stopping', () => {}],
    ['family_blocked', () => {}],
  ];
  for (const [expectedStatus, prepare] of cases) {
    const extra = expectedStatus === 'stopping'
      ? { workspaceFolder: '/w/off', runStoppingAt: '2026-01-01' }
      : expectedStatus === 'family_blocked'
        ? { workspaceFolder: '/w/off', family: 'delegation', owner: 'delegation-service' }
        : { workspaceFolder: '/w/off' };
    const { store, ids } = setup(extra);
    if (expectedStatus === 'waiting') {
      const initial = getRun(ids.logicalRunId, store);
      transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: initial.revision, to: 'running' }, store);
    } else {
      interrupt(store, ids, 'interrupted', expectedStatus === 'stopping'
        ? { interruptedPrompt: 'SECRET LAST PROMPT', runStoppingAt: '2026-01-01' }
        : { interruptedPrompt: 'SECRET LAST PROMPT' });
    }
    prepare(store, ids);
    const service = createRuntimeRecoveryResumeService({ store, loadSettings: () => settings });
    const outcome = await service.resumeRun({ ...req(ids, getRun(ids.logicalRunId, store), `ordered-${expectedStatus}`), actor: 'automatic' });
    assert.equal(outcome.status, expectedStatus);
    closeRecoveryStore(store);
  }
});

test('automatic actor is refused inside resumeRun when the adapter is not validated (evaluateAutomaticResume bypassed)', async () => {
  for (const isAdapterValidated of [undefined, () => false, (harness) => harness === 'other']) {
    const { store, ids } = setup();
    const run = interrupt(store, ids);
    const { service, calls } = build(store, { isAdapterValidated });
    const outcome = await service.resumeRun({ ...req(ids, run, 'auto-bypass'), actor: 'automatic' });
    assert.equal(outcome.status, 'unsupported');
    assert.equal(outcome.reason, 'adapter_not_validated');
    assert.equal(calls.start.length + calls.reattach.length, 0);
    assert.deepEqual(getRun(ids.logicalRunId, store), run, 'refusal does not claim the run');
    closeRecoveryStore(store);
  }
  // A manual actor is not subject to the automatic enable gate; a validated adapter passes.
  const manual = setup();
  const manualRun = interrupt(manual.store, manual.ids);
  const m = build(manual.store, { isAdapterValidated: () => false });
  assert.equal((await m.service.resumeRun({ ...req(manual.ids, manualRun, 'manual-ok'), actor: 'manual' })).status, 'resumed');
  closeRecoveryStore(manual.store);
  const valid = setup();
  const validRun = interrupt(valid.store, valid.ids);
  const v = build(valid.store, { isAdapterValidated: (harness) => harness === 'claude' });
  assert.equal((await v.service.resumeRun({ ...req(valid.ids, validRun, 'auto-ok'), actor: 'automatic' })).status, 'resumed');
  closeRecoveryStore(valid.store);
});

test('launch failure returns to interrupted and the key replays the failure', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  let launches = 0;
  const { service } = build(store, {
    startContinuation: async () => { launches += 1; throw new Error('boom /secret/path'); },
  });
  const r = await service.resumeRun(req(ids, run));
  assert.equal(r.status, 'launch_failed');
  assert.equal(r.reason, 'launch_failed');
  assert.ok(!JSON.stringify(getRun(ids.logicalRunId, store)).includes('/secret/path'));
  const after = getRun(ids.logicalRunId, store);
  assert.equal(after.state, 'interrupted');
  assert.equal(r.revision, after.revision);
  const again = await service.resumeRun(req(ids, run));
  assert.equal(again.status, 'launch_failed');
  assert.equal(again.replayed, true);
  assert.equal(launches, 1);
  // Retry with a NEW key and the fresh revision from the failure result.
  const retry = await service.resumeRun(req(ids, { state: 'interrupted', revision: r.revision }, 'k-new'));
  assert.equal(retry.replayed, false);
  assert.equal(launches, 2);
  closeRecoveryStore(store);
});

test('old-run callback after resume => run_mismatch', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service } = build(store);
  assert.equal(checkRunFence({ logicalRunId: ids.logicalRunId, attemptId: ids.attemptId }, store).ok, true);
  const r = await service.resumeRun(req(ids, run));
  const old = checkRunFence({ logicalRunId: ids.logicalRunId, attemptId: ids.attemptId }, store);
  assert.equal(old.ok, false);
  assert.equal(old.code, 'run_mismatch');
  assert.equal(checkRunFence({ logicalRunId: ids.logicalRunId, attemptId: r.attemptId }, store).ok, true);
  closeRecoveryStore(store);
});

test('accounting unchanged: no retry/failure fields touched', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids, 'interrupted', { failures: 1, interruptContinuedAt: '' });
  const { service } = build(store);
  await service.resumeRun(req(ids, run));
  const after = getRun(ids.logicalRunId, store);
  assert.equal(after.failures, 1);
  assert.equal(after.interruptContinuedAt, '');
  assert.equal(after.cycleCount, undefined);
  assert.equal(after.backoffUntil, undefined);
  closeRecoveryStore(store);
});

test('invalid input and unknown run', async () => {
  const { store } = setup();
  const { service } = build(store);
  assert.equal((await service.resumeRun({})).status, 'invalid');
  assert.equal(
    (await service.resumeRun({ logicalRunId: createRecoveryIds().logicalRunId, expectedState: 'interrupted', expectedRevision: 1, idempotencyKey: 'x' })).status,
    'not_found'
  );
  closeRecoveryStore(store);
});

test('route: maps result status to HTTP and passes the CAS token', async () => {
  const { registerRecoveryResumeRoutes } = await import('../lib/routes/recovery-resume-routes.js');
  let handler;
  const app = { post: (_p, h) => { handler = h; } };
  let seen;
  registerRecoveryResumeRoutes(app, {
    service: { resumeRun: async (i) => { seen = i; return { status: 'conflict', reason: 'state_mismatch' }; } },
  });
  let code; let body;
  await handler(
    { params: { id: 'c', logicalRunId: 'lr' }, body: { expectedState: 'interrupted', expectedRevision: 3, idempotencyKey: 'k' } },
    { status(c) { code = c; return this; }, json(b) { body = b; } }
  );
  assert.equal(code, 409);
  assert.equal(seen.expectedRevision, 3);
  assert.equal(body.status, 'conflict');
});

test('reattach without a real attach collaborator => reattach_deferred, nothing mutated', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service, calls } = build(store, { probeLiveness: () => 'alive', reattach: undefined });
  const r = await service.resumeRun(req(ids, run));
  assert.equal(r.status, 'reattach_deferred');
  assert.equal(r.reason, 'liveness_confirmed_only');
  const after = getRun(ids.logicalRunId, store);
  assert.equal(after.state, 'interrupted');
  assert.equal(after.revision, run.revision);
  assert.equal(calls.start.length, 0);
  closeRecoveryStore(store);
});

test('session changed => unsupported session_changed, no launch', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service, calls } = build(store, { getCurrentSessionId: () => 'other-session' });
  const r = await service.resumeRun(req(ids, run));
  assert.equal(r.status, 'unsupported');
  assert.equal(r.reason, 'session_changed');
  assert.equal(calls.start.length, 0);
  closeRecoveryStore(store);
});

test('Stop during launch window => no launch, cancelled_during_resume', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { calls } = build(store);
  const realNow = Date.now;
  // Stop lands right after the claim and attempt write: hook into now().
  let n = 0;
  const svc = createRecoveryResumeService({
    store,
    now: () => {
      n += 1;
      if (n === 3) requestRunCancel({ logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId, reason: 'user' }, store);
      return realNow();
    },
    probeLiveness: () => 'dead',
    getCapabilities: () => ({ canResumeSession: true }),
    startContinuation: async (i) => { calls.start.push(i); return { accepted: true }; },
  });
  const r = await svc.resumeRun(req(ids, run));
  assert.equal(r.status, 'cancelled');
  assert.equal(r.reason, 'cancelled_during_resume');
  assert.equal(calls.start.length, 0);
  closeRecoveryStore(store);
});

test('replay of a claim left in_progress after a crash is not reported as resumed', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  let release;
  const gateP = new Promise((r) => { release = r; });
  const { service } = build(store, { startContinuation: async () => { await gateP; return { accepted: true }; } });
  const first = service.resumeRun(req(ids, run));
  await new Promise((r) => setImmediate(r));
  const second = createRecoveryResumeService({ store, getCapabilities: () => ({}) });
  const replay = await second.resumeRun(req(ids, run));
  assert.equal(replay.status, 'in_progress');
  assert.equal(replay.replayed, true);
  release();
  assert.equal((await first).status, 'resumed');
  assert.equal((await first).fencing, 'unlinked'); // no adapter run id => stays starting
  closeRecoveryStore(store);
});

test('fence: ack/finish of a stale attempt never mutate the run; current attempt links and finishes', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service } = build(store);
  const first = await service.resumeRun(req(ids, run));
  const after = getRun(ids.logicalRunId, store);
  assert.equal(after.state, 'running');
  assert.equal(after.acceptance.adapterRunId, 'a2');
  const staleAttempt = createRecoveryIds().attemptId;
  assert.equal(recordResumedAttemptAck({ logicalRunId: ids.logicalRunId, attemptId: staleAttempt, adapterRunId: 'evil' }, store).reason, 'run_mismatch');
  const staleFinish = finishResumedAttempt({
    logicalRunId: ids.logicalRunId, attemptId: staleAttempt, to: 'completed', proof: { source: 'adapter_event', detail: 'x' },
  }, store);
  assert.deepEqual([staleFinish.applied, staleFinish.reason], [false, 'run_mismatch']);
  assert.equal(getRun(ids.logicalRunId, store).revision, after.revision);
  const ok = finishResumedAttempt({
    logicalRunId: ids.logicalRunId, attemptId: first.attemptId, to: 'completed', proof: { source: 'adapter_event', detail: 'done', adapterRunId: 'a2' },
  }, store);
  assert.equal(ok.applied, true);
  assert.equal(getRun(ids.logicalRunId, store).state, 'completed');
  closeRecoveryStore(store);
});

function lostClaim(store, ids, mutate, over = {}) {
  const cancelled = [];
  const { service } = build(store, {
    startContinuation: async () => { mutate(); return { accepted: true, adapterRunId: 'late-run', ...over }; },
    cancelLaunched: async (i) => { cancelled.push(i); },
  });
  return { service, cancelled };
}

const sweepAway = (store, ids) => () => {
  // A sweep/other writer takes the claim: not a Stop.
  const row = getRun(ids.logicalRunId, store);
  transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: row.revision, expectedState: 'recovering', to: 'interrupted' }, store);
};

test('FU-1: a claim lost to a non-Stop reason cancels the turn but not the run; later resume works', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service, cancelled } = lostClaim(store, ids, sweepAway(store, ids));
  const r = await service.resumeRun(req(ids, run));
  assert.equal(r.reason, 'claim_lost_after_launch');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].adapterRunId, 'late-run');
  assert.equal(cancelled[0].reason, 'claim_lost');
  assert.equal(isRunCancelled(ids.logicalRunId, store), false);
  const fresh = getRun(ids.logicalRunId, store);
  assert.equal(fresh.state, 'interrupted');
  const { service: again } = build(store);
  assert.equal((await again.resumeRun(req(ids, fresh, 'k2'))).status, 'resumed');
  closeRecoveryStore(store);
});

test('FU-1: a claim lost while a Stop is recorded keeps the run cancelled and cancels the turn', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service, cancelled } = lostClaim(store, ids, () => {
    requestRunCancel({ logicalRunId: ids.logicalRunId, requestId: createRecoveryIds().requestId, reason: 'user' }, store);
  });
  const r = await service.resumeRun(req(ids, run));
  assert.equal(r.status, 'superseded');
  assert.equal(cancelled.length, 1);
  assert.equal(isRunCancelled(ids.logicalRunId, store), true);
  assert.equal(getRun(ids.logicalRunId, store).state, 'cancelled');
  closeRecoveryStore(store);
});

test('FU-1: unlinked launch (empty adapter run id) plus lost claim makes no cancelChatRun call', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids, 'interrupted', { acceptance: { state: 'accepted', adapterRunId: 'old-run' } });
  const calls = [];
  const service = createRuntimeRecoveryResumeService({
    store,
    probeLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    getCapabilities: () => ({ canResumeSession: true }),
    loadSettings: () => ({}),
    getHarnessUsageLimit: () => null,
    assertCanAcceptNewRun: () => {},
    loadChats: () => [{ id: 'chat-1', cursorSessionId: 'sess-1' }],
    assertChatCanReceiveMessages: () => {},
    startChatRun: async () => { sweepAway(store, ids)(); return { accepted: true, runId: '' }; },
    cancelChatRun: async (i) => { calls.push(i); },
  });
  const r = await service.resumeRun(req(ids, run));
  assert.equal(r.reason, 'claim_lost_after_launch');
  assert.equal(calls.length, 0);
  closeRecoveryStore(store);
});

test('route cancelLaunched passes the internal reason and the exact adapter run id', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids, 'interrupted', { acceptance: { state: 'accepted', adapterRunId: 'old-run' } });
  const calls = [];
  const service = createRuntimeRecoveryResumeService({
    store,
    probeLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    getCapabilities: () => ({ canResumeSession: true }),
    loadSettings: () => ({}),
    getHarnessUsageLimit: () => null,
    assertCanAcceptNewRun: () => {},
    loadChats: () => [{ id: 'chat-1', cursorSessionId: 'sess-1' }],
    assertChatCanReceiveMessages: () => {},
    startChatRun: async () => { sweepAway(store, ids)(); return { accepted: true, runId: 'late-run' }; },
    cancelChatRun: async (i) => { calls.push(i); },
  });
  await service.resumeRun(req(ids, run));
  assert.deepEqual(calls, [{ chatId: 'chat-1', runId: 'late-run', reason: 'internal_cancel' }]);
  closeRecoveryStore(store);
});

test('a resumed run reaches terminal through noteChatRunFinished; a stale adapter run id is ignored', async () => {
  const { store, ids } = setup();
  const run = interrupt(store, ids);
  const { service } = build(store, { startContinuation: async () => ({ accepted: true, adapterRunId: 'a9' }) });
  await service.resumeRun(req(ids, run));
  assert.equal(noteChatRunFinished({ chatId: 'chat-1', runId: 'old-adapter-run', status: 'finished', store }), false);
  assert.equal(getRun(ids.logicalRunId, store).state, 'running');
  assert.equal(noteChatRunFinished({ chatId: 'chat-1', runId: 'a9', status: 'finished', store }), true);
  assert.equal(getRun(ids.logicalRunId, store).state, 'completed');
  closeRecoveryStore(store);
});
