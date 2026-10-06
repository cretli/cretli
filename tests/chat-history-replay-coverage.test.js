/**
 * Replay completion vs view coverage (C-ACK-03) and catch-up without false ACK.
 */
import assert from 'node:assert/strict';

import { runHistoryReplayAsyncTail } from '../app_front/lib/chatHistoryReplayAsyncLoop.js';
import {
  createChatHistoryReplayLifecycle,
  HISTORY_REPLAY_CHUNK_SIZE,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import { createChatHistoryReplayGenerationGate } from '../app_front/lib/chatHistoryReplayGenerationGate.js';
import { buildHistoryReplayResult } from '../app_front/lib/chatHistoryReplayResult.js';
import {
  applyReplayViewCoverage,
  replaySdkRichViewHistory,
} from '../app_front/features/chat/chatHistoryViewApply.js';
import {
  getViewAppliedSeq,
  resetViewAppliedSeqMemoryForTests,
} from '../app_front/features/chat/chatHistoryConvergence.js';
import { monoNow, resetChatPerfBudget } from '../app_front/lib/chatPerfBudget.js';
import { UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS } from '../app_front/lib/uiFreezeRenderBudgets.js';
import { __resetUiFreezeCountersForTest } from '../app_front/lib/uiFreezeCounters.js';

/** @param {number} count */
function makeSeqRecords(count) {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'localUser',
    text: `m-${index}`,
    historySeq: index + 1,
    createdAt: new Date(0).toISOString(),
  }));
}

resetViewAppliedSeqMemoryForTests();

{
  const chat = { id: 'cov-a', _sdkViewAppliedSeq: 0, _sdkViewAppliedSeqs: new Set() };
  const records = makeSeqRecords(30);
  applyReplayViewCoverage('cov-a', chat, records, HISTORY_REPLAY_SYNC_HEAD);
  assert.equal(getViewAppliedSeq('cov-a', chat), HISTORY_REPLAY_SYNC_HEAD);
  assert.notEqual(getViewAppliedSeq('cov-a', chat), records.length);
}

resetViewAppliedSeqMemoryForTests();

{
  const gate = createChatHistoryReplayGenerationGate();
  const lifecycle = createChatHistoryReplayLifecycle({ active: () => false });
  const total = HISTORY_REPLAY_SYNC_HEAD + HISTORY_REPLAY_CHUNK_SIZE * 3;
  const records = makeSeqRecords(total);
  const run = lifecycle.beginReplay({
    source: 'local',
    totalRecords: total,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(run.generation);
  lifecycle.noteSyncApplied(run.generation, HISTORY_REPLAY_SYNC_HEAD);
  let applied = HISTORY_REPLAY_SYNC_HEAD;
  const tailPromise = runHistoryReplayAsyncTail({
    records,
    startIndex: HISTORY_REPLAY_SYNC_HEAD,
    replayGeneration: run.generation,
    lifecycle,
    scheduleFrame: (cb) => cb(),
    isCancelled: () => !gate.isActive(run.generation),
    applyHistoryRecord: () => {
      const deadline = monoNow() + 2;
      while (monoNow() < deadline) {
        /* slow apply so the first slice yields before the full tail */
      }
      applied += 1;
    },
    finalizeTail: () => {},
    getAppliedMeta: () => ({ applied, children: applied }),
  });
  const recordsPerSlice = Math.max(1, Math.floor(UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS / 2));
  assert.equal(applied, HISTORY_REPLAY_SYNC_HEAD + recordsPerSlice);
  gate.revoke();
  await tailPromise;
  const result = buildHistoryReplayResult({
    generation: run.generation,
    total,
    applied,
    reason: 'cancelled',
  });
  assert.ok(result.cancelled);
  assert.ok(applied < total);
  assert.equal(result.applied, applied);
  const chat = { id: 'cov-b', _sdkViewAppliedSeq: 0, _sdkViewAppliedSeqs: new Set() };
  applyReplayViewCoverage('cov-b', chat, records, result.applied);
  assert.equal(getViewAppliedSeq('cov-b', chat), applied);
  assert.ok(getViewAppliedSeq('cov-b', chat) < total);
}

resetViewAppliedSeqMemoryForTests();

{
  const records = makeSeqRecords(12);
  /** @type {import('../app_front/lib/chatHistoryReplayResult.js').HistoryReplayResult} */
  let replayResult = buildHistoryReplayResult({
    generation: 3,
    total: records.length,
    applied: records.length,
    reason: 'complete',
  });
  const chat = {
    id: 'cov-c',
    _sdkActiveHistoryReplayGeneration: 3,
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkRichView: {
      replayHistoryRecords: async () => replayResult,
    },
  };
  const actual = await replaySdkRichViewHistory(chat, records, { instant: true, source: 'local' });
  assert.equal(actual.applied, records.length);
  assert.equal(actual.total, records.length);
  assert.equal(actual.cancelled, false);
  assert.equal(getViewAppliedSeq('cov-c', chat), records.length);
}

resetViewAppliedSeqMemoryForTests();

{
  const records = makeSeqRecords(40);
  const partialApplied = HISTORY_REPLAY_SYNC_HEAD + 4;
  const chat = {
    id: 'cov-d',
    _sdkActiveHistoryReplayGeneration: 5,
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkRichView: {
      replayHistoryRecords: async () =>
        buildHistoryReplayResult({
          generation: 5,
          total: records.length,
          applied: partialApplied,
          reason: 'superseded',
        }),
    },
  };
  const actual = await replaySdkRichViewHistory(chat, records, { source: 'http' });
  assert.equal(actual.applied, partialApplied);
  assert.ok(actual.cancelled);
  assert.equal(getViewAppliedSeq('cov-d', chat), partialApplied);
}

resetViewAppliedSeqMemoryForTests();

{
  const records = makeSeqRecords(15);
  const chat = { id: 'cov-e', _sdkViewAppliedSeq: 0, _sdkViewAppliedSeqs: new Set() };
  applyReplayViewCoverage('cov-e', chat, records, 10);
  assert.equal(getViewAppliedSeq('cov-e', chat), 10);
  applyReplayViewCoverage('cov-e', chat, records, 10);
  assert.equal(getViewAppliedSeq('cov-e', chat), 10);
  applyReplayViewCoverage('cov-e', chat, records, 15);
  assert.equal(getViewAppliedSeq('cov-e', chat), 15);
}

console.log('chat-history-replay-coverage.test.js: ok');
