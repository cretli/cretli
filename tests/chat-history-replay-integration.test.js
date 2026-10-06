/**
 * Integration harness: local → HTTP supersede → destroy while async tail runs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHistoryReplayAsyncTail } from '../app_front/lib/chatHistoryReplayAsyncLoop.js';
import {
  createChatHistoryReplayLifecycle,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import {
  currentSpanName,
  resetChatPerfBudget,
} from '../app_front/lib/chatPerfBudget.js';
import { __resetUiFreezeCountersForTest } from '../app_front/lib/uiFreezeCounters.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(path.join(projectRoot, 'tests/fixtures/synthetic-history-replay-records.json'), 'utf8'),
);

assert.equal(fixture.recordCount, fixture.records.length);
assert.ok(fixture.records.length > 20);

/** @type {Array<{ category: string, event: string, payload: Record<string, unknown> }>} */
const events = [];
const lifecycle = createChatHistoryReplayLifecycle({
  active: () => true,
  trace: (category, event, payload) => {
    events.push({ category, event, payload: payload || {} });
  },
});

/** @param {unknown[]} records @param {'local'|'http'} source */
function beginSyncHead(records, source) {
  return lifecycle.beginReplay({
    source,
    totalRecords: records.length,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
}

/** @param {unknown[]} records @param {number} generation @param {number} startIndex */
async function runTail(records, generation, startIndex) {
  let appliedCount = startIndex;
  await runHistoryReplayAsyncTail({
    records,
    startIndex,
    replayGeneration: generation,
    lifecycle,
    scheduleFrame: (cb) => setTimeout(cb, 0),
    applyHistoryRecord: (row) => {
      appliedCount += 1;
      const message = row && typeof row === 'object' && 'message' in row ? String(row.message) : '';
      assert.ok(message.length > 0);
    },
    finalizeTail: () => {},
    getAppliedMeta: () => ({ applied: appliedCount, children: appliedCount }),
  });
  return appliedCount;
}

resetChatPerfBudget();
__resetUiFreezeCountersForTest();
events.length = 0;
lifecycle.reset();

const localRecords = fixture.records;
const localRun = beginSyncHead(localRecords, 'local');
lifecycle.noteSyncApplied(localRun.generation, localRun.syncHead);
lifecycle.noteAsyncLoopStarted(localRun.generation);

const httpRecords = fixture.records.slice(0, 40);
const httpRun = beginSyncHead(httpRecords, 'http');
assert.equal(httpRun.generation, localRun.generation + 1);
assert.ok(events.some((row) => row.event === 'supersede'));
assert.equal(currentSpanName(), 'history.replay');

lifecycle.onViewDestroyed(0);
assert.equal(currentSpanName(), 'idle');
assert.ok(events.some((row) => row.event === 'destroy'));

const tailPromise = runTail(localRecords, localRun.generation, localRun.syncHead);
await tailPromise;

assert.ok(
  events.some((row) => row.event === 'stale-complete' && row.payload.generation === localRun.generation),
  'superseded generation should stale-complete',
);
const switchEnds = events.filter((row) => row.event === 'end');
assert.equal(switchEnds.length, 2);
assert.ok(switchEnds.some((row) => row.payload.reason === 'superseded'));
assert.ok(switchEnds.some((row) => row.payload.reason === 'destroyed'));
assert.equal(lifecycle.getActiveAsyncLoops(), 0);

resetChatPerfBudget();
lifecycle.reset();
events.length = 0;

const destroyRun = beginSyncHead(httpRecords, 'http');
lifecycle.noteAsyncLoopStarted(destroyRun.generation);
lifecycle.onViewDestroyed(0);
await runTail(httpRecords, destroyRun.generation, destroyRun.syncHead);
assert.ok(
  events.some(
    (row) => row.event === 'destroy-async-complete' && row.payload.generation === destroyRun.generation,
  ),
);
assert.equal(events.filter((row) => row.event === 'stale-complete').length, 0);

const destroyScenarioEnds = events.filter((row) => row.event === 'end');
assert.equal(destroyScenarioEnds.length, 1);
assert.equal(destroyScenarioEnds[0].payload.reason, 'destroyed');

resetChatPerfBudget();
__resetUiFreezeCountersForTest();
events.length = 0;
lifecycle.reset();

const solo = beginSyncHead(localRecords, 'local');
lifecycle.noteSyncApplied(solo.generation, solo.syncHead);
await runTail(localRecords, solo.generation, solo.syncHead);
assert.equal(currentSpanName(), 'idle');
const soloEnd = events.filter((row) => row.event === 'end');
assert.equal(soloEnd.length, 1);
assert.equal(soloEnd[0].payload.reason, 'complete');
assert.ok(soloEnd[0].payload.durationMs >= 0);
const batchEvents = events.filter((row) => row.event === 'batch');
assert.ok(batchEvents.length > 0);
assert.ok(batchEvents.every((row) => Number(row.payload.applyMs) >= 0));
assert.ok(batchEvents.some((row) => Number(row.payload.batchMs) >= Number(row.payload.yieldMs)));

const largeRecord = localRecords[Math.floor(localRecords.length / 2)];
assert.ok(Buffer.byteLength(String(largeRecord.message), 'utf8') >= 700 * 1024);

console.log('chat-history-replay-integration.test.js: ok');
