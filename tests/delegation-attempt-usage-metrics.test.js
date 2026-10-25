/**
 * Reliable per-attempt metrics for Claude/Codex (leaf "Wiarygodne metryki
 * Claude i Codex per próba"): ledger-derived tokens/cache/cost, tool calls from
 * `tool_call` events, and idempotent late fill after a terminal verdict.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { acceptDelegationFinalReport, applyLateDelegationMetrics, createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { collectRoomDelegationMetrics, noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import { recordUsage } from '../lib/usage/usage-ledger.ts';
import { readUsageEvents } from '../lib/persist/usage-persist.js';
import { buildAttemptUsageMetrics, readAttemptUsageMetrics } from '../lib/usage/attempt-usage.ts';
import {
  areMetricsEqual,
  compactMetrics,
  mergeLateMetrics,
  normalizeMetrics,
  resetMetricsPatch,
} from '../lib/delegation-metrics.js';
import { DELEGATION_FINAL_REPORT_ERROR_CODE } from '../lib/sdk/sdk-run-outcome.ts';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('sdk');

const project = makeTempDir('cr-attempt-usage-');
const service = createDelegationService({ workspaceDirForAgent: () => project, isModelAvailable: () => true });

let seq = 0;
async function startJob(transport = 'claude', assignment = 'review') {
  const parent = addChat(`sess-au-${seq += 1}`, `au-${seq}`, null, project, 'planner', { agentTransport: 'sdk', sdkMode: 'agent' });
  const started = await service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'sdk', model: 'sdk/test' },
    sourceKind: 'text',
    taskText: 'Do the thing.',
    assignment,
    idempotencyKey: `au-${seq}-${Math.random().toString(16).slice(2)}`,
  });
  assert.equal(started.ok, true, started.error || '');
  // The metric collector keys off the stored transport; the mock adapter only
  // runs `sdk`, so the stored transport is switched after the start.
  return updateDelegationRecord(started.delegation.id, { executor: { transport } });
}

/** Records one ledger delta for a job attempt, like the harness recorder does. */
function usage(job, tokens, extra = {}) {
  return recordUsage({
    provider: 'other',
    harness: job.executor.transport,
    eventType: 'delta',
    role: job.assignment,
    delegationId: job.id,
    attemptId: job.attemptId,
    runId: job.runId || 'run-x',
    sourceSessionId: 'sess-default',
    model: 'm',
    tokens,
    ...extra,
  });
}
const events = () => readUsageEvents({ from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString() });
const REPORT = 'Checked everything.\nTASK: review\nVERDICT: PASS';

test('Claude multi-turn: turns sum once, cache stays apart from ordinary tokens', async () => {
  const job = await startJob('claude');
  usage(job, { textInput: 100, textOutput: 40, cachedInput: 900, cacheWrite: 50 }, { requestId: 'r1' });
  usage(job, { textInput: 30, textOutput: 10, cachedInput: 1000 }, { requestId: 'r2' });
  const metrics = readAttemptUsageMetrics({ delegation: getDelegationById(job.id) });
  assert.equal(metrics.tokens_in, 130);
  assert.equal(metrics.tokens_out, 50);
  assert.equal(metrics.cache_read_tokens, 1900);
  assert.equal(metrics.cache_write_tokens, 50);
});

test('Codex: tokens reach the attempt; unknown stays null without a usage event', async () => {
  const job = await startJob('codex');
  const none = readAttemptUsageMetrics({ delegation: getDelegationById(job.id) });
  assert.equal(none.tokens_in, null, 'missing usage is null, not 0');
  assert.equal(none.tokens_out, null);
  assert.equal(none.usage_coverage, 'none');
  usage(job, { textInput: 500, textOutput: 80 }, { requestId: 'c1' });
  const metrics = readAttemptUsageMetrics({ delegation: getDelegationById(job.id) });
  assert.equal(metrics.tokens_in, 500);
  assert.equal(metrics.tokens_out, 80);
  assert.equal(metrics.usage_coverage, 'partial', 'no run proof yet');
});

test('event replay never double counts', async () => {
  const job = await startJob('claude');
  usage(job, { textInput: 10, textOutput: 5 }, { requestId: 'same' });
  usage(job, { textInput: 10, textOutput: 5 }, { requestId: 'same' });
  const metrics = buildAttemptUsageMetrics({ delegation: getDelegationById(job.id), events: [...events(), ...events()] });
  assert.equal(metrics.tokens_in, 10);
  assert.equal(metrics.tokens_out, 5);
});

test('retry keeps attempts apart; same-session resume and new session sum inside one attempt', async () => {
  const job = await startJob('claude');
  const first = job.attemptId;
  usage(job, { textInput: 10, textOutput: 1 }, { requestId: 'a1', runId: 'run-1', sourceSessionId: 'sess-A' });
  // Resume of the same session inside the attempt: new run id, same attempt.
  usage(job, { textInput: 20, textOutput: 2 }, { requestId: 'a2', runId: 'run-2', sourceSessionId: 'sess-A' });
  // New session inside the attempt.
  usage(job, { textInput: 40, textOutput: 4 }, { requestId: 'a3', runId: 'run-3', sourceSessionId: 'sess-B' });
  const current = getDelegationById(job.id);
  const sum = buildAttemptUsageMetrics({ delegation: current, attemptId: first, events: events() });
  assert.equal(sum.tokens_in, 70);
  assert.equal(sum.tokens_out, 7);
  // A retry is a new attempt id: the old usage must not leak into it.
  const retried = { ...current, attemptId: 'attempt-2', runId: 'run-9', attempts: [{ ...current, attemptId: first, runId: current.runId }] };
  const fresh = buildAttemptUsageMetrics({ delegation: retried, attemptId: 'attempt-2', events: events() });
  assert.equal(fresh.tokens_in, null);
  const archived = buildAttemptUsageMetrics({ delegation: retried, attemptId: first, events: events() });
  assert.equal(archived.tokens_in, 70);
});

test('subscription: equivalent price is not an extra charge; metered keeps reported vs estimated', async () => {
  const sub = await startJob('claude');
  usage(sub, { textInput: 10, textOutput: 5 }, { requestId: 's1', billingMode: 'subscription', usd: null });
  const subscription = readAttemptUsageMetrics({ delegation: getDelegationById(sub.id) });
  assert.equal(subscription.billing_mode, 'subscription');
  assert.equal(subscription.estimated_usd, null);
  assert.equal(subscription.reported_usd, null);
  const api = await startJob('claude');
  usage(api, { textInput: 10, textOutput: 5 }, { requestId: 'm1', reportedUsd: 0.25, usd: 0.25 });
  const metered = readAttemptUsageMetrics({ delegation: getDelegationById(api.id) });
  assert.equal(metered.billing_mode, 'metered');
  assert.equal(metered.reported_usd, 0.25);
});

test('normalize/merge: optional keys survive, legacy 7-key rows stay readable, merge is idempotent', () => {
  const legacy = normalizeMetrics({ tokens_in: 5 });
  assert.deepEqual(Object.keys(legacy).length, 7);
  const rich = normalizeMetrics({ tokens_in: 5, cache_read_tokens: 9, billing_mode: 'subscription', usage_coverage: 'partial', reported_usd: '0.5', bogus: 1 });
  assert.equal(rich.cache_read_tokens, 9);
  assert.equal(rich.billing_mode, 'subscription');
  assert.equal(rich.reported_usd, 0.5);
  assert.equal('bogus' in rich, false);
  assert.equal(normalizeMetrics({ billing_mode: 'weird' }).billing_mode, undefined);
  const once = mergeLateMetrics({ tool_calls_n: 3, tokens_in: 1 }, { tokens_in: 7, tool_calls_n: 99, cache_read_tokens: 2 });
  assert.equal(once.tokens_in, 7, 'ledger-owned value is replaced by the recomputed one');
  assert.equal(once.tool_calls_n, 3, 'a known non-ledger value is never overwritten');
  assert.equal(once.cache_read_tokens, 2);
  assert.ok(areMetricsEqual(mergeLateMetrics(once, { tokens_in: 7, cache_read_tokens: 2 }), once));
  assert.equal(mergeLateMetrics({ tokens_in: 4 }, { tokens_in: null }).tokens_in, 4, 'unknown never erases known');
  assert.equal(compactMetrics(normalizeMetrics({})), null);
  assert.deepEqual(compactMetrics({ tokens_in: 2 }), { tokens_in: 2 });
  assert.equal(resetMetricsPatch().billing_mode, null);
});

test('collect: Claude/Codex take tokens from the ledger and tool calls from distinct finished tool_call ids', async () => {
  const job = await startJob('claude');
  const ledger = { tokens_in: 12, tokens_out: 3, cache_read_tokens: 4, usage_coverage: 'partial' };
  const room = { delegationId: job.id, delegationAttemptId: job.attemptId, cwd: project };
  for (const status of ['running', 'completed', 'completed']) {
    await noteDelegationRoomEvent(room, { type: 'sdkEvent', runId: job.runId, event: { type: 'tool_call', call_id: 't1', status } });
  }
  await noteDelegationRoomEvent(room, { type: 'sdkEvent', runId: job.runId, event: { type: 'tool_call', call_id: 't2', status: 'error' } });
  const metrics = collectRoomDelegationMetrics(room, getDelegationById(job.id), { usageMetrics: ledger });
  assert.equal(metrics.tool_calls_n, 2, 'replayed/duplicate ids count once');
  assert.equal(metrics.tokens_in, 12);
  assert.equal(metrics.cache_read_tokens, 4);
  const noTools = collectRoomDelegationMetrics({ cwd: project }, getDelegationById(job.id), { usageMetrics: null });
  assert.equal(noTools.tool_calls_n, null, 'no tool event observed stays null');
  assert.equal(noTools.tokens_in, null);
});

test('final_report path: ledger metrics land on the attempt, late adapter finish completes it without touching verdict/ACK/slot', async () => {
  const job = await startJob('claude', 'review');
  usage(job, { textInput: 100, textOutput: 20, cachedInput: 5 }, { requestId: 'f1' });
  const accepted = await acceptDelegationFinalReport({
    delegationId: job.id, attemptId: job.attemptId, report: REPORT, taskOutcome: 'success',
  });
  assert.equal(accepted.accepted, true);
  const afterReport = getDelegationById(job.id);
  assert.equal(afterReport.status, 'completed');
  assert.equal(afterReport.metrics.tokens_in, 100);
  assert.equal(afterReport.metrics.cache_read_tokens, 5);
  // Late usage + tool events arrive, then the quiet stop of the adapter.
  usage(job, { textInput: 11, textOutput: 2 }, { requestId: 'f2' });
  const room = { delegationId: job.id, delegationAttemptId: job.attemptId, chatId: job.childChatId, serverHold: true, cwd: project };
  await noteDelegationRoomEvent(room, { type: 'sdkEvent', runId: job.runId, event: { type: 'tool_call', call_id: 'x1', status: 'completed' } });
  const before = getDelegationById(job.id);
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', lastErrorCode: DELEGATION_FINAL_REPORT_ERROR_CODE, runId: job.runId });
  const late = getDelegationById(job.id);
  assert.equal(late.metrics.tokens_in, 111, 'late usage fills the same attempt');
  assert.equal(late.metrics.tool_calls_n, 1);
  for (const key of ['status', 'reportVerdict', 'taskOutcome', 'acknowledgedAt', 'slotHeldBy', 'runStoppingAt', 'finalReportAcceptedAt', 'attemptId']) {
    assert.equal(late[key], before[key], `${key} unchanged by late metrics`);
  }
  // Replay: byte-identical metrics, no extra write.
  const stamp = late.updatedAt;
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', lastErrorCode: DELEGATION_FINAL_REPORT_ERROR_CODE, runId: job.runId });
  const replay = getDelegationById(job.id);
  assert.deepEqual(replay.metrics, late.metrics);
  assert.equal(replay.updatedAt, stamp, 'idempotent: nothing rewritten');
});

test('adapter finish path: normal completed finish stores metrics; a second terminal finish only fills', async () => {
  const job = await startJob('codex', 'implement');
  usage(job, { textInput: 7, textOutput: 3 }, { requestId: 'p1' });
  const room = { delegationId: job.id, delegationAttemptId: job.attemptId, chatId: job.childChatId, _currentRunAssistantText: 'Done, changed the files as requested and all behaves.', cwd: project };
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: job.runId });
  const done = getDelegationById(job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.metrics.tokens_in, 7);
  usage(job, { textInput: 1, textOutput: 1 }, { requestId: 'p2' });
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: job.runId });
  const again = getDelegationById(job.id);
  assert.equal(again.status, 'completed');
  assert.equal(again.metrics.tokens_in, 8);
});

test('cancel and error paths keep their terminal outcome and still record metrics', async () => {
  const cancelled = await startJob('claude', 'implement');
  usage(cancelled, { textInput: 9, textOutput: 1 }, { requestId: 'x1' });
  const room = { delegationId: cancelled.id, delegationAttemptId: cancelled.attemptId, chatId: cancelled.childChatId, cwd: project };
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'cancelled', runId: cancelled.runId });
  const c = getDelegationById(cancelled.id);
  assert.equal(c.status, 'cancelled');
  assert.equal(c.metrics.tokens_in, 9);

  const failed = await startJob('codex', 'implement');
  usage(failed, { textInput: 4, textOutput: 2 }, { requestId: 'e1' });
  const roomE = { delegationId: failed.id, delegationAttemptId: failed.attemptId, chatId: failed.childChatId, cwd: project };
  await noteDelegationRoomEvent(roomE, { type: 'sdkRunFinished', status: 'error', lastErrorMessage: 'boom', runId: failed.runId });
  const f = getDelegationById(failed.id);
  assert.equal(f.status, 'failed');
  assert.equal(f.metrics.tokens_in, 4);
  // A late error after the terminal verdict must not rewrite it, but late usage fills.
  usage(failed, { textInput: 6, textOutput: 0 }, { requestId: 'e2' });
  await noteDelegationRoomEvent(roomE, { type: 'sdkRunFinished', status: 'error', lastErrorMessage: 'again', runId: failed.runId });
  const f2 = getDelegationById(failed.id);
  assert.equal(f2.status, 'failed');
  assert.equal(f2.error, f.error);
  assert.equal(f2.metrics.tokens_in, 10);
  assert.equal(f2.afterTerminalCount, 1);
});

test('applyLateDelegationMetrics targets an archived attempt and refuses unknown ones', async () => {
  const job = await startJob('claude', 'implement');
  const archivedAttempt = { attemptId: 'old-attempt', status: 'failed', metrics: normalizeMetrics({ tool_calls_n: 2 }) };
  updateDelegationRecord(job.id, { attempts: [archivedAttempt] });
  const res = applyLateDelegationMetrics(job.id, 'old-attempt', { tokens_in: 33 });
  assert.equal(res.applied, true);
  const row = getDelegationById(job.id);
  assert.equal(row.attempts[0].metrics.tokens_in, 33);
  assert.equal(row.attempts[0].metrics.tool_calls_n, 2);
  assert.equal(row.metrics.tokens_in, null, 'the live attempt is untouched');
  assert.equal(applyLateDelegationMetrics(job.id, 'old-attempt', { tokens_in: 33 }).applied, false, 'replay is a no-op');
  assert.equal(applyLateDelegationMetrics(job.id, 'ghost', { tokens_in: 1 }).reason, 'stale_attempt');
  assert.equal(applyLateDelegationMetrics(job.id, row.attemptId, {}).reason, 'empty');
});

test('finishDelegation on a terminal job fills metrics only', async () => {
  const job = await startJob('claude', 'review');
  await acceptDelegationFinalReport({ delegationId: job.id, attemptId: job.attemptId, report: REPORT, taskOutcome: 'success' });
  const before = getDelegationById(job.id);
  finishDelegation(before, { status: 'completed', attemptId: before.attemptId, metrics: { tokens_in: 5, tokens_out: 1 } });
  const after = getDelegationById(job.id);
  assert.equal(after.metrics.tokens_in, 5);
  assert.equal(after.status, before.status);
  assert.equal(after.reportVerdict, before.reportVerdict);
});

// ---- Fix round 1: real adapter -> ledger -> attempt path, per-transport sources ----

import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import { normalizeClaudeMessage } from '../lib/agent-harness/claude-event-normalizer.ts';
import { normalizeCodexThreadEvent } from '../lib/agent-harness/codex-event-normalizer.ts';
import { buildClaudeUsageSdkEvent } from '../lib/claude/claude-agent-ws.ts';
import { makeTempDir } from './helpers/temp-dir.js';

/** Room + kernel wired to the real ledger, like the WS adapters do at runtime. */
function realRoom(job, harness) {
  const kernel = createAgentRoomKernel({ transport: harness, persistHistory: () => {}, recordUsage });
  const room = kernel.createRoomState({
    sessionKey: `${harness}-${Math.random().toString(16).slice(2)}`,
    chatId: job.childChatId,
    modelId: 'claude-sonnet-4-5',
    delegationId: job.id,
    delegationAttemptId: job.attemptId,
    delegationAssignment: job.assignment,
  });
  return { kernel, room };
}

/** One Claude run: the production normalizer turns `result` into the usage item. */
function claudeRun(kernel, room, runId, usageRaw, extra = {}) {
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId });
  for (const item of normalizeClaudeMessage({ type: 'result', subtype: 'success', session_id: extra.sessionId || 'cs', usage: usageRaw })) {
    if (item.kind !== 'usage') continue;
    kernel.broadcastRoom(room, { type: 'sdkEvent', event: { ...buildClaudeUsageSdkEvent(item), ...(extra.requestId ? { requestId: extra.requestId } : {}) } });
  }
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId, status: 'completed' });
}

/** One Codex turn: `turn.completed` through the production normalizer. */
function codexTurn(kernel, room, runId, usage) {
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId });
  for (const item of normalizeCodexThreadEvent({ type: 'turn.completed', usage })) {
    if (item.kind !== 'usage') continue;
    kernel.broadcastRoom(room, { type: 'sdkEvent', event: { type: 'usage', usage: item.usage, final: true } });
  }
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId, status: 'completed' });
}

test('real path Claude: same-session resume + new session sum once; replay of a result does not double count', async () => {
  const job = await startJob('claude');
  const { kernel, room } = realRoom(job, 'claude');
  claudeRun(kernel, room, 'run-a', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }, { requestId: 'req-1', sessionId: 'S1' });
  // Replay of the very same result (reconnect): identity dedupes it.
  claudeRun(kernel, room, 'run-a', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }, { requestId: 'req-1', sessionId: 'S1' });
  // Same-session resume (new run) and a brand new session in one attempt.
  claudeRun(kernel, room, 'run-b', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 }, { requestId: 'req-2', sessionId: 'S1' });
  claudeRun(kernel, room, 'run-c', { input_tokens: 7, output_tokens: 3 }, { requestId: 'req-3', sessionId: 'S2' });
  const metrics = readAttemptUsageMetrics({ delegation: getDelegationById(job.id) });
  assert.equal(metrics.tokens_out, 28);
  assert.equal(metrics.cache_read_tokens, 1900);
  assert.equal(metrics.cache_write_tokens, 50);
  assert.equal(metrics.usage_coverage, 'complete', 'every run reported final usage');
});

test('real path Codex: turn.completed usage per turn, cached split from input, unknown stays null', async () => {
  const job = await startJob('codex');
  const { kernel, room } = realRoom(job, 'codex');
  assert.equal(readAttemptUsageMetrics({ delegation: getDelegationById(job.id) }).tokens_in, null);
  codexTurn(kernel, room, 'run-1', { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 });
  codexTurn(kernel, room, 'run-2', { input_tokens: 500, cached_input_tokens: 100, output_tokens: 20 });
  const metrics = readAttemptUsageMetrics({ delegation: getDelegationById(job.id) });
  assert.equal(metrics.tokens_in, 400 + 400);
  assert.equal(metrics.cache_read_tokens, 700);
  assert.equal(metrics.tokens_out, 70);
});

test('F1: sdk/qwen keep the room token value and attach no overlapping ledger cache', async () => {
  for (const transport of ['sdk', 'qwen']) {
    const job = await startJob(transport);
    const room = { delegationId: job.id, delegationAttemptId: job.attemptId, cwd: project, _lastUsagePayload: { inputTokens: 1000, outputTokens: 40 } };
    const ledger = { tokens_in: 600, tokens_out: 40, cache_read_tokens: 400, cache_write_tokens: 5, usage_coverage: 'complete' };
    const metrics = collectRoomDelegationMetrics(room, getDelegationById(job.id), { usageMetrics: ledger, omitGit: true });
    assert.equal(metrics.tokens_in, 1000, `${transport}: room value (cache-inclusive)`);
    assert.equal(metrics.cache_read_tokens ?? null, null, `${transport}: cache is not added on top`);
    assert.equal(metrics.cache_write_tokens ?? null, null);
    // Room without its own usage: tokens and cache come together from the ledger.
    const fallback = collectRoomDelegationMetrics({ cwd: project }, getDelegationById(job.id), { usageMetrics: ledger, omitGit: true });
    assert.equal(fallback.tokens_in, 600);
    assert.equal(fallback.cache_read_tokens, 400);
  }
  // final_report path never stores ledger tokens for a room-sourced transport.
  const sdkJob = await startJob('sdk', 'review');
  usage(sdkJob, { textInput: 600, textOutput: 40, cachedInput: 400 }, { requestId: 'sdk-1' });
  await acceptDelegationFinalReport({ delegationId: sdkJob.id, attemptId: sdkJob.attemptId, report: REPORT, taskOutcome: 'success' });
  assert.equal(getDelegationById(sdkJob.id).metrics.cache_read_tokens ?? null, null);
  assert.equal(getDelegationById(sdkJob.id).metrics.tokens_in, null, 'adapter finish is the only writer');
});

test('F2: repeated Codex item ids across runs of one attempt are counted per run; replay still dedupes', async () => {
  const job = await startJob('codex');
  const room = { delegationId: job.id, delegationAttemptId: job.attemptId, cwd: project };
  const call = (runId, status = 'completed') => noteDelegationRoomEvent(room, {
    type: 'sdkEvent', runId, event: { type: 'tool_call', call_id: 'item_0', status },
  });
  // runId is only an attempt-current fence for the bridge: keep the job's own run id.
  const runId = job.runId;
  await call(runId); await call(runId); // replay in the same run
  assert.equal(collectRoomDelegationMetrics(room, getDelegationById(job.id), { omitGit: true }).tool_calls_n, 1);
  // Resume mints another run whose first item is item_0 again.
  updateDelegationRecord(job.id, { runId: 'run-resumed' });
  await call('run-resumed'); await call('run-resumed');
  assert.equal(collectRoomDelegationMetrics(room, getDelegationById(job.id), { omitGit: true }).tool_calls_n, 2);
});

test('F2b: sdkEvent without runId through the real kernel counts item ids per run; same-run replay dedupes', async () => {
  const job = await startJob('codex');
  const { kernel, room } = realRoom(job, 'codex');
  room.cwd = project;
  kernel.afterBroadcast = undefined;
  const wired = createAgentRoomKernel({ transport: 'codex', persistHistory: () => {}, recordUsage, afterBroadcast: noteDelegationRoomEvent });
  const call = (id, status = 'completed') => wired.broadcastRoom(room, { type: 'sdkEvent', event: { type: 'tool_call', call_id: id, status } });
  const count = () => collectRoomDelegationMetrics(room, getDelegationById(job.id), { omitGit: true }).tool_calls_n;
  wired.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'codex-run-1' });
  call('item_0'); call('item_1'); call('item_0'); // replay in the same run
  assert.equal(count(), 2);
  wired.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'codex-run-1', status: 'completed' });
  wired.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'codex-run-2' });
  call('item_0'); call('item_1'); call('item_1');
  assert.equal(count(), 4);
});

test('F3: coverage is complete only when every run of the attempt has final usage', async () => {
  const job = await startJob('claude');
  const run = (runId, proof) => recordUsage({
    provider: 'other', harness: 'claude', eventType: 'run', role: job.assignment, delegationId: job.id, attemptId: job.attemptId,
    runId, sourceSessionId: 'sess-default', model: 'm', coverage: { proof, expectedRequests: 1, coveredRequests: proof ? 1 : 0, scope: 'own' },
  });
  usage(job, { textInput: 5, textOutput: 1 }, { requestId: 'k1', runId: 'r1' });
  usage(job, { textInput: 5, textOutput: 1 }, { requestId: 'k2', runId: 'r2' });
  run('r1', true);
  assert.equal(readAttemptUsageMetrics({ delegation: getDelegationById(job.id) }).usage_coverage, 'partial', 'r2 has no run proof');
  run('r2', true);
  assert.equal(readAttemptUsageMetrics({ delegation: getDelegationById(job.id) }).usage_coverage, 'complete');
});

test('F5: unmeasured attempts expose no optional metrics', async () => {
  const job = await startJob('claude');
  const none = readAttemptUsageMetrics({ delegation: getDelegationById(job.id) });
  assert.equal(none.usage_coverage, 'none');
  const metrics = collectRoomDelegationMetrics({ cwd: project }, getDelegationById(job.id), { usageMetrics: none, omitGit: true });
  assert.equal(metrics.usage_coverage ?? null, null, 'coverage none is not stored');
  assert.equal(compactMetrics({ usage_coverage: 'none' }), null);
  assert.equal(compactMetrics({ tokens_in: 1, usage_coverage: 'none' }).usage_coverage, undefined);
});

test('F6: rate-table USD is estimated; USD without the estimated flag is mapped, not dropped', async () => {
  const job = await startJob('claude');
  usage(job, { textInput: 1000, textOutput: 500 }, { requestId: 'u1', model: 'claude-sonnet-4-5' });
  const priced = readAttemptUsageMetrics({ delegation: getDelegationById(job.id) });
  assert.ok(priced.estimated_usd > 0, 'rate-table price is an estimate');
  assert.equal(priced.reported_usd, null);
  // A priced event that lost its estimated flag: money exists, so it must land
  // in a field instead of leaving billing_mode "metered" with no amount.
  const unflagged = events().filter((e) => e.attemptId === job.attemptId).map((e) => ({ ...e, estimated: false, usd: 0.5 }));
  const metrics = buildAttemptUsageMetrics({ delegation: getDelegationById(job.id), events: unflagged });
  assert.equal(metrics.billing_mode, 'metered');
  assert.equal(metrics.reported_usd, null);
  assert.equal(metrics.estimated_usd, 0.5);
});

test('real retry: the old attempt keeps its metrics, the new attempt starts unmeasured', async () => {
  const job = await startJob('sdk', 'review');
  usage(job, { textInput: 50, textOutput: 5 }, { requestId: 'rt1' });
  const first = job.attemptId;
  const room = { delegationId: job.id, delegationAttemptId: first, chatId: job.childChatId, cwd: project };
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'error', lastErrorMessage: 'boom', runId: job.runId });
  assert.equal(getDelegationById(job.id).status, 'failed');
  assert.equal(getDelegationById(job.id).metrics.tokens_in, 50);
  resetMockChatRuns();
  const retried = await service.retry(job.id);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const after = getDelegationById(job.id);
  assert.notEqual(after.attemptId, first);
  assert.equal(after.metrics.tokens_in, null, 'live metrics reset');
  assert.equal(after.metrics.cache_read_tokens ?? null, null);
  const archived = after.attempts.find((row) => row.attemptId === first);
  assert.equal(archived.metrics.tokens_in, 50, 'archived snapshot keeps the old attempt');
  assert.equal(readAttemptUsageMetrics({ delegation: after }).tokens_in, null, 'new attempt does not inherit ledger usage');
});

test('superseded attempt: late finish through noteDelegationRoomEvent fills only the archived attempt', async () => {
  const job = await startJob('sdk', 'review');
  const first = job.attemptId;
  const room = { delegationId: job.id, delegationAttemptId: first, chatId: job.childChatId, cwd: project };
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'error', lastErrorMessage: 'boom', runId: job.runId });
  resetMockChatRuns();
  const retried = await service.retry(job.id);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const mid = getDelegationById(job.id);
  usage(job, { textInput: 33, textOutput: 3 }, { requestId: 'late1' });
  await noteDelegationRoomEvent(room, { type: 'sdkRunFinished', status: 'completed', runId: job.runId });
  const after = getDelegationById(job.id);
  assert.equal(after.attempts.find((row) => row.attemptId === first).metrics.tokens_in, 33);
  assert.equal(after.status, mid.status, 'current attempt status untouched');
  assert.equal(after.metrics.tokens_in, null, 'current attempt metrics untouched');
});
