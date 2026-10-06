/**
 * Local / HTTP hydration with delayed HTTP, live during replay, and session isolation.
 */
import assert from 'node:assert/strict';

import {
  applyCatchUpSdkHistoryRecords,
  applyReplayViewCoverage,
  replaySdkRichViewHistory,
} from '../app_front/features/chat/chatHistoryViewApply.js';
import {
  buildExpectedHydratedHistory,
  bufferLiveEventDuringHistoryReplay,
  LOCAL_HTTP_MERGE_CATCH_UP,
  LOCAL_HTTP_MERGE_REPLACE,
  ownsHydrationForViewGeneration,
  resetHistoryReplayTrackingForTests,
  resolveLocalToHttpMergeMode,
  isHistoryReplayInFlight,
  takePendingLiveEventsAfterReplaySettle,
  trackHistoryReplayPromise,
  waitForHistoryReplaySettled,
} from '../app_front/features/chat/chatHistoryHydrationLive.js';
import {
  captureHydrationHttpBoundary,
  isHydrationHttpBoundaryCurrent,
  mergeServerSdkHistoryIntoRichView,
} from '../app_front/features/chat/chatHistoryHttpMerge.js';
import { runHistoryReplayAsyncTail } from '../app_front/lib/chatHistoryReplayAsyncLoop.js';
import {
  createChatHistoryReplayLifecycle,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import { createChatHistoryReplayGenerationGate } from '../app_front/lib/chatHistoryReplayGenerationGate.js';
import {
  buildHistoryReplayResult,
  emptyHistoryReplayResult,
} from '../app_front/lib/chatHistoryReplayResult.js';
import {
  bumpViewApplyGeneration,
  dedupeHistoryRecords,
  getViewAppliedSeq,
  resetViewAppliedSeqMemoryForTests,
  resetViewAppliedState,
  sortRecordsForViewApply,
  syncViewAppliedSessionKey,
} from '../app_front/features/chat/chatHistoryConvergence.js';
import {
  beginSdkHistoryHydration,
  finishSdkHistoryHydration,
  hasSdkHistoryRoomWatermarks,
} from '../app_front/features/chat/sdkEventReplayGuard.js';
import { insertRecordByViewOrder } from '../app_front/features/chat/chatHistoryViewOrder.js';

/** @param {number} from @param {number} to @param {string} [streamId] */
function seqRows(from, to, streamId = 'room-a') {
  const out = [];
  for (let seq = from; seq <= to; seq += 1) {
    out.push({
      kind: 'sdk',
      historySeq: seq,
      eventStreamId: streamId,
      roomEventSeq: seq,
      text: `m-${seq}`,
      createdAt: new Date(seq).toISOString(),
    });
  }
  return out;
}

/** @param {object} chat @param {unknown[]} records */
function applyRecordsToFakeView(chat, records) {
  for (const record of records) {
    insertRecordByViewOrder(chat._sdkRichView.nodes, record);
  }
}

resetViewAppliedSeqMemoryForTests();

{
  const chat = { id: 'mode-a', _sdkViewAppliedSeq: 0, _sdkViewAppliedSeqs: new Set() };
  assert.equal(resolveLocalToHttpMergeMode(chat, false), LOCAL_HTTP_MERGE_REPLACE);
  chat._sdkLastRoomEventSeq = 5;
  chat._sdkHydratedRoomEventSeqByStream = { 'room-a': 5 };
  assert.equal(resolveLocalToHttpMergeMode(chat, true), LOCAL_HTTP_MERGE_CATCH_UP);
  assert.equal(hasSdkHistoryRoomWatermarks(chat), true);
}

{
  const local = seqRows(1, 25);
  const http = seqRows(1, 30);
  const live = seqRows(31, 31);
  const expectedReplace = buildExpectedHydratedHistory({
    localRecords: local,
    httpRecords: http,
    liveRecords: live,
    mode: LOCAL_HTTP_MERGE_REPLACE,
  });
  assert.equal(expectedReplace.length, 31);
  const expectedCatchUp = buildExpectedHydratedHistory({
    localRecords: local,
    httpRecords: http,
    liveRecords: live,
    mode: LOCAL_HTTP_MERGE_CATCH_UP,
  });
  assert.equal(expectedCatchUp.length, 31);
  assert.deepEqual(
    expectedCatchUp.map((row) => row.historySeq),
    expectedReplace.map((row) => row.historySeq),
  );
}

{
  const chat = {
    id: 'delay-a',
    cursorSessionId: 'sess-1',
    _sdkViewApplyGeneration: 2,
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkRichView: {
      nodes: [],
      hasQueuedOrSentUserText: () => false,
      prependHistoryRecords(records) {
        for (const record of records) insertRecordByViewOrder(this.nodes, record);
      },
      async appendHistoryRecords(records) {
        for (const record of records) insertRecordByViewOrder(this.nodes, record);
      },
    },
  };
  beginSdkHistoryHydration(chat);
  chat._sdkHistoryHydrationGeneration = 2;
  const localRecords = seqRows(1, 25);
  const gate = createChatHistoryReplayGenerationGate();
  const lifecycle = createChatHistoryReplayLifecycle({ active: () => false });
  const run = lifecycle.beginReplay({
    source: 'local',
    totalRecords: localRecords.length,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  gate.activate(run.generation);
  chat._sdkActiveHistoryReplayGeneration = run.generation;
  chat._sdkLastRoomEventSeq = 20;
  chat._sdkHydratedRoomEventSeqByStream = { 'room-a': 20 };
  applyRecordsToFakeView(chat, localRecords.slice(0, HISTORY_REPLAY_SYNC_HEAD));
  let applied = HISTORY_REPLAY_SYNC_HEAD;
  const tailPromise = (async () => {
    await runHistoryReplayAsyncTail({
      records: localRecords,
      startIndex: HISTORY_REPLAY_SYNC_HEAD,
      replayGeneration: run.generation,
      lifecycle,
      scheduleFrame: (cb) => setTimeout(cb, 0),
      isCancelled: () => !gate.isActive(run.generation),
      applyHistoryRecord: (row) => {
        applyRecordsToFakeView(chat, [row]);
        applied += 1;
      },
      finalizeTail: () => {},
      getAppliedMeta: () => ({ applied, children: applied }),
    });
    return buildHistoryReplayResult({
      generation: run.generation,
      total: localRecords.length,
      applied,
      reason: 'complete',
    });
  })();
  trackHistoryReplayPromise(chat, tailPromise);
  assert.equal(isHistoryReplayInFlight(chat), true);
  let httpResolved = false;
  const httpPromise = new Promise((resolve) => {
    setTimeout(() => {
      httpResolved = true;
      resolve(seqRows(1, 25));
    }, 20);
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(httpResolved, false);
  const httpRecords = await httpPromise;
  assert.equal(httpResolved, true);
  await waitForHistoryReplaySettled(chat);
  assert.equal(applied, localRecords.length);
  const mergeMode = resolveLocalToHttpMergeMode(chat, true);
  assert.equal(mergeMode, LOCAL_HTTP_MERGE_CATCH_UP);
  await applyCatchUpSdkHistoryRecords(chat, httpRecords);
  const merged = sortRecordsForViewApply(
    dedupeHistoryRecords([...localRecords, ...httpRecords]),
  );
  assert.equal(chat._sdkRichView.nodes.length, merged.length);
  assert.equal(getViewAppliedSeq('delay-a', chat), merged.length);
}

{
  const chat = {
    id: 'live-mid',
    _sdkViewApplyGeneration: 1,
    _sdkEventStreamId: 'room-a',
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkRichView: { nodes: [] },
  };
  beginSdkHistoryHydration(chat);
  chat._sdkHistoryHydrationGeneration = 1;
  const records = seqRows(1, 30);
  let applied = 0;
  const replayPromise = (async () => {
    for (const row of records) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      applyRecordsToFakeView(chat, [row]);
      applied += 1;
    }
    return buildHistoryReplayResult({
      generation: 7,
      total: records.length,
      applied,
      reason: 'complete',
    });
  })();
  chat._sdkActiveHistoryReplayGeneration = 7;
  trackHistoryReplayPromise(chat, replayPromise);
  const liveFrame = {
    type: 'sdkEvent',
    eventStreamId: 'room-a',
    roomEventSeq: 31,
    event: { type: 'assistant', message: { content: [{ type: 'text', text: 'live-31' }] } },
  };
  assert.equal(bufferLiveEventDuringHistoryReplay(chat, liveFrame), true);
  assert.equal(chat._sdkPendingRoomEvents.length, 1);
  await waitForHistoryReplaySettled(chat);
  const pending = finishSdkHistoryHydration(chat, records);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].roomEventSeq, 31);
  applyRecordsToFakeView(chat, [
    {
      kind: 'sdk',
      historySeq: 31,
      eventStreamId: 'room-a',
      roomEventSeq: 31,
      text: 'live-31',
      createdAt: new Date(31).toISOString(),
    },
  ]);
  const expected = buildExpectedHydratedHistory({
    httpRecords: records,
    liveRecords: [{ historySeq: 31, eventStreamId: 'room-a', roomEventSeq: 31 }],
    mode: LOCAL_HTTP_MERGE_REPLACE,
  });
  assert.equal(chat._sdkRichView.nodes.length, expected.length);
}

{
  const chatA = {
    id: 'sess-a',
    cursorSessionId: 'sess-a',
    _sdkEventStreamId: 'room-a',
    _sdkViewApplyGeneration: 1,
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkRichView: { nodes: [] },
  };
  const chatB = {
    id: 'sess-b',
    cursorSessionId: 'sess-b',
    _sdkEventStreamId: 'room-b',
    _sdkViewApplyGeneration: 1,
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkRichView: { nodes: [] },
  };
  beginSdkHistoryHydration(chatA);
  chatA._sdkHistoryHydrationGeneration = 1;
  chatA._sdkHydratedRoomEventSeqByStream = { 'room-a': 3 };
  chatA._sdkLastRoomEventSeq = 3;
  bufferLiveEventDuringHistoryReplay(chatA, {
    type: 'sdkEvent',
    eventStreamId: 'room-a',
    roomEventSeq: 4,
  });
  resetViewAppliedState('sess-b', chatB);
  syncViewAppliedSessionKey('sess-b', chatB, 'sess-b');
  chatB._sdkHydratedRoomEventSeqByStream = { 'room-b': 1 };
  chatB._sdkLastRoomEventSeq = 1;
  assert.equal(chatA._sdkPendingRoomEvents.length, 1);
  assert.equal(chatB._sdkPendingRoomEvents, undefined);
  assert.equal(chatA._sdkHydratedRoomEventSeqByStream['room-a'], 3);
  assert.equal(chatB._sdkHydratedRoomEventSeqByStream['room-b'], 1);
  assert.equal(ownsHydrationForViewGeneration(chatA, 1), true);
  assert.equal(ownsHydrationForViewGeneration(chatA, 2), false);
}

{
  const chat = {
    id: 'offline-fp',
    cursorSessionId: 'sess-off',
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkRichView: {
      nodes: [],
      replayHistoryRecords: async (records) =>
        buildHistoryReplayResult({
          generation: 1,
          total: records.length,
          applied: records.length,
          reason: 'complete',
        }),
    },
  };
  const localOnly = seqRows(1, 5);
  syncViewAppliedSessionKey('offline-fp', chat, 'sess-off');
  const result = await replaySdkRichViewHistory(chat, localOnly, {
    instant: true,
    source: 'local',
  });
  assert.equal(result.applied, 5);
  applyReplayViewCoverage('offline-fp', chat, localOnly, result.applied);
  assert.equal(getViewAppliedSeq('offline-fp', chat), 5);
  assert.equal(resolveLocalToHttpMergeMode(chat, true), LOCAL_HTTP_MERGE_REPLACE);
}

{
  const chat = {
    id: 'replay-flush',
    _sdkViewApplyGeneration: 1,
    _sdkEventStreamId: 'room-a',
    _sdkRichView: { nodes: [] },
  };
  beginSdkHistoryHydration(chat);
  finishSdkHistoryHydration(chat, seqRows(1, 5));
  assert.equal(chat._sdkHistoryHydrating, false);
  const liveFrame = {
    type: 'sdkEvent',
    eventStreamId: 'room-a',
    roomEventSeq: 6,
  };
  const replayPromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return buildHistoryReplayResult({ generation: 3, total: 1, applied: 1, reason: 'complete' });
  })();
  chat._sdkActiveHistoryReplayGeneration = 3;
  trackHistoryReplayPromise(chat, replayPromise);
  assert.equal(bufferLiveEventDuringHistoryReplay(chat, liveFrame), true);
  assert.equal(chat._sdkPendingRoomEvents.length, 1);
  /** @type {Record<string, unknown>[]} */
  const flushed = [];
  chat._processSdkSocketMessage = (message) => {
    flushed.push(message);
  };
  await waitForHistoryReplaySettled(chat);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].roomEventSeq, 6);
  assert.equal(takePendingLiveEventsAfterReplaySettle(chat).length, 0);
}

{
  const chat = {
    id: 'merge-prod',
    cursorSessionId: 'sess-merge',
    _sdkViewApplyGeneration: 1,
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkLastRoomEventSeq: 10,
    _sdkHydratedRoomEventSeqByStream: { 'room-a': 10 },
    _sdkRichView: {
      nodes: [],
      hasQueuedOrSentUserText: () => false,
      prependHistoryRecords(records) {
        for (const record of records) insertRecordByViewOrder(this.nodes, record);
      },
      async appendHistoryRecords(records) {
        for (const record of records) insertRecordByViewOrder(this.nodes, record);
      },
      async replayHistoryRecords(records) {
        for (const record of records) insertRecordByViewOrder(this.nodes, record);
        return buildHistoryReplayResult({
          generation: Math.round(Number(chat._sdkActiveHistoryReplayGeneration) || 1),
          total: records.length,
          applied: records.length,
          reason: 'complete',
        });
      },
    },
  };
  syncViewAppliedSessionKey('merge-prod', chat, 'sess-merge');
  applyRecordsToFakeView(chat, seqRows(1, 10));
  applyReplayViewCoverage('merge-prod', chat, seqRows(1, 10), 10);
  const httpBoundary = captureHydrationHttpBoundary(chat, 'sess-merge');
  let httpResolved = false;
  const delayedHttp = new Promise((resolve) => {
    setTimeout(() => {
      httpResolved = true;
      resolve(seqRows(11, 12));
    }, 15);
  });
  const tailPromise = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return buildHistoryReplayResult({ generation: 2, total: 1, applied: 1, reason: 'complete' });
  })();
  chat._sdkActiveHistoryReplayGeneration = 2;
  trackHistoryReplayPromise(chat, tailPromise);
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(httpResolved, false);
  const httpRecords = await delayedHttp;
  await waitForHistoryReplaySettled(chat);
  const merged = await mergeServerSdkHistoryIntoRichView(
    chat,
    httpRecords,
    'sess-merge',
    true,
    httpBoundary,
    () => {},
  );
  assert.equal(merged.staleHttp, undefined);
  assert.equal(merged.hydratedRecords.length, 2);
  assert.equal(chat._sdkRichView.nodes.length, 12);
}

{
  const chat = {
    id: 'stale-http',
    cursorSessionId: 'sess-old',
    _sdkViewApplyGeneration: 1,
    _sdkViewAppliedSeq: 5,
    _sdkViewAppliedSeqs: new Set(),
    _sdkLastRoomEventSeq: 5,
    _sdkHydratedRoomEventSeqByStream: { 'room-a': 5 },
    _sdkRichView: {
      nodes: [],
      hasQueuedOrSentUserText: () => false,
      async replayHistoryRecords(records) {
        for (const record of records) insertRecordByViewOrder(this.nodes, record);
        return buildHistoryReplayResult({
          generation: 1,
          total: records.length,
          applied: records.length,
          reason: 'complete',
        });
      },
    },
  };
  applyRecordsToFakeView(chat, seqRows(1, 5));
  const httpBoundary = captureHydrationHttpBoundary(chat, 'sess-old');
  chat.cursorSessionId = 'sess-new';
  syncViewAppliedSessionKey('stale-http', chat, 'sess-new');
  assert.equal(isHydrationHttpBoundaryCurrent(chat, httpBoundary), false);
  const merged = await mergeServerSdkHistoryIntoRichView(
    chat,
    seqRows(1, 20),
    'sess-old',
    false,
    httpBoundary,
    () => {},
  );
  assert.equal(merged.staleHttp, true);
  assert.equal(chat._sdkRichView.nodes.length, 5);
  assert.equal(chat._sdkLastRoomEventSeq, 5);
  assert.equal(chat._sdkHydratedRoomEventSeqByStream['room-a'], 5);
}

{
  const chat = {
    id: 'stale-view',
    cursorSessionId: 'sess-view',
    _sdkViewApplyGeneration: 1,
    _sdkViewAppliedSeq: 0,
    _sdkViewAppliedSeqs: new Set(),
    _sdkRichView: { nodes: [], async replayHistoryRecords() { return emptyHistoryReplayResult(); } },
  };
  const httpBoundary = captureHydrationHttpBoundary(chat, 'sess-view');
  bumpViewApplyGeneration(chat);
  const merged = await mergeServerSdkHistoryIntoRichView(
    chat,
    seqRows(1, 3),
    'sess-view',
    false,
    httpBoundary,
    () => {},
  );
  assert.equal(merged.staleHttp, true);
}

resetViewAppliedSeqMemoryForTests();
console.log('chat-history-hydration-live.test.js: ok');
