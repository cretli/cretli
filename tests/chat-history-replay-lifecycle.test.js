/**
 * Task 0.1 — history replay lifecycle diagnostics (generation, supersede, full-span).
 */
import assert from 'node:assert/strict';

import {
  createChatHistoryReplayLifecycle,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import {
  currentSpanName,
  endSpan,
  resetChatPerfBudget,
} from '../app_front/lib/chatPerfBudget.js';
import { __resetUiFreezeCountersForTest } from '../app_front/lib/uiFreezeCounters.js';

/** @param {boolean} on */
function createHarness(on) {
  /** @type {Array<{ category: string, event: string, payload: Record<string, unknown> }>} */
  const events = [];
  const lifecycle = createChatHistoryReplayLifecycle({
    active: () => on,
    trace: (category, event, payload) => {
      events.push({ category, event, payload: payload || {} });
    },
  });
  return { lifecycle, events };
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();

{
  const { lifecycle, events } = createHarness(false);
  const first = lifecycle.beginReplay({
    source: 'local',
    totalRecords: 120,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  assert.equal(first.trackAsync, true);
  assert.equal(events.length, 0);
  lifecycle.finishReplay(first.generation, { reason: 'complete', applied: 120 });
  assert.equal(events.length, 0);
}

resetChatPerfBudget();
{
  const { lifecycle, events } = createHarness(true);
  const run = lifecycle.beginReplay({
    source: 'http',
    totalRecords: 48,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  assert.equal(run.generation, 1);
  assert.equal(currentSpanName(), 'history.replay');
  lifecycle.noteSyncApplied(run.generation, HISTORY_REPLAY_SYNC_HEAD);
  lifecycle.noteAsyncLoopStarted(run.generation);
  lifecycle.noteBatch(run.generation, {
    batchRecords: 8,
    applyMs: 10,
    yieldMs: 2,
    batchMs: 12,
    applied: 28,
  });
  lifecycle.finishReplay(run.generation, {
    reason: 'complete',
    applied: 48,
    children: 200,
  });
  assert.equal(currentSpanName(), 'idle');
  assert.ok(events.some((row) => row.event === 'start' && row.payload.source === 'http'));
  assert.ok(events.some((row) => row.event === 'batch' && row.payload.applied === 28));
  assert.ok(events.some((row) => row.event === 'end' && row.payload.reason === 'complete'));
  assert.equal(endSpan(), null);
}

resetChatPerfBudget();
{
  const { lifecycle, events } = createHarness(true);
  const first = lifecycle.beginReplay({
    source: 'local',
    totalRecords: 200,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  lifecycle.noteSyncApplied(first.generation, HISTORY_REPLAY_SYNC_HEAD);
  lifecycle.noteAsyncLoopStarted(first.generation);
  const second = lifecycle.beginReplay({
    source: 'http',
    totalRecords: 80,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  assert.equal(second.generation, 2);
  assert.ok(events.some((row) => row.event === 'supersede'));
  assert.equal(currentSpanName(), 'history.replay');
  lifecycle.finishReplay(first.generation, {
    reason: 'complete',
    applied: 200,
  });
  assert.ok(events.some((row) => row.event === 'stale-complete'));
  lifecycle.finishReplay(second.generation, {
    reason: 'complete',
    applied: 80,
  });
  assert.equal(currentSpanName(), 'idle');
}

resetChatPerfBudget();
{
  const { lifecycle, events } = createHarness(true);
  const run = lifecycle.beginReplay({
    source: 'local',
    totalRecords: 12,
    syncHead: 12,
    instant: true,
  });
  assert.equal(run.trackAsync, false);
  lifecycle.noteSyncApplied(run.generation, 12);
  lifecycle.finishReplay(run.generation, { reason: 'complete', applied: 12 });
  assert.equal(currentSpanName(), 'idle');
  assert.equal(events.filter((row) => row.event === 'async-start').length, 0);
}

resetChatPerfBudget();
{
  const { lifecycle, events } = createHarness(true);
  const run = lifecycle.beginReplay({
    source: 'http',
    totalRecords: 64,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  lifecycle.noteAsyncLoopStarted(run.generation);
  lifecycle.onViewDestroyed(0);
  assert.equal(currentSpanName(), 'idle');
  lifecycle.finishReplay(run.generation, { reason: 'complete', applied: 64 });
  assert.ok(events.some((row) => row.event === 'destroy-async-complete'));
  assert.equal(events.filter((row) => row.event === 'stale-complete').length, 0);
}

console.log('chat-history-replay-lifecycle.test.js: ok');
