import assert from 'node:assert/strict';
import {
  HISTORY_SYNC_RETRY_MAX,
  HISTORY_SYNC_STATUS,
  createInFlightHistorySyncTracker,
  dedupeHistoryRecords,
  getViewAppliedOrigin,
  getViewAppliedSeq,
  nextHistorySyncRetryDelayMs,
  noteViewAppliedRecords,
  replaceViewAppliedRecords,
  resetViewAppliedSeqMemoryForTests,
  resetViewAppliedState,
  resolveChatHistoryConvergence,
  resolveHistorySyncPollFollowUp,
  selectRecordsNewerThan,
  setChatHistorySyncInFlight,
  shouldClearPendingRemoteHistory,
  shouldKeepHistorySyncInFlight,
  markHistorySyncInFlightForWsReplay,
  clearHistorySyncInFlightAfterWsReplay,
  shouldMarkConnectionHealthyAfterHistorySync,
  syncViewAppliedSessionKey,
} from '../app_front/features/chat/chatHistoryConvergence.js';
import {
  ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
  shouldApplyReplayEventsToRenderedView,
  shouldHttpCatchUpAfterWsReplay,
} from '../app_front/features/chat/chatResumePolicy.js';

resetViewAppliedSeqMemoryForTests();

const assistant = { kind: 'sdk', historySeq: 101, text: 'done' };
const duplicate = { kind: 'sdk', historySeq: 101, text: 'done-dup' };
const nextAssistant = { kind: 'sdk', historySeq: 102, text: 'parent continued' };
assert.deepEqual(
  dedupeHistoryRecords([assistant, duplicate, nextAssistant]).map((row) => row.historySeq),
  [101, 102]
);
assert.deepEqual(
  selectRecordsNewerThan([assistant, nextAssistant], 101).map((row) => row.historySeq),
  [102]
);

const chat = {};
replaceViewAppliedRecords('chat-a', chat, [{ historySeq: 50 }]);
assert.equal(getViewAppliedSeq('chat-a', chat), 50);
assert.equal(getViewAppliedOrigin('chat-a', chat), 50);

const hiddenAfterFetch = resolveChatHistoryConvergence({
  reason: 'visibility',
  documentHidden: true,
  backgroundMs: 2000,
  socketGeneration: 4,
  unackedPingAgeMs: 0,
  serverHeadSeq: 102,
  storeAckSeq: 102,
  viewAppliedSeq: 100,
  fetchedRecords: [assistant, nextAssistant],
  localRecords: [assistant, nextAssistant],
  draftText: 'still typing',
  scrollTop: 88,
});
assert.equal(hiddenAfterFetch.status, HISTORY_SYNC_STATUS.DEFERRED);
assert.equal(hiddenAfterFetch.shouldApplyToView, false);
assert.equal(hiddenAfterFetch.shouldClearPending, false);
assert.equal(hiddenAfterFetch.draftText, 'still typing');
assert.equal(hiddenAfterFetch.scrollTop, 88);

const view = [];
const visibleAgain = resolveChatHistoryConvergence({
  reason: 'visibility',
  documentHidden: false,
  backgroundMs: 0,
  serverHeadSeq: 102,
  storeAckSeq: 102,
  viewAppliedSeq: 100,
  fetchedRecords: [],
  localRecords: [assistant, duplicate, nextAssistant],
  draftText: 'still typing',
  scrollTop: 88,
});
assert.equal(visibleAgain.status, HISTORY_SYNC_STATUS.SUCCESS);
assert.equal(visibleAgain.shouldClearPending, true);
for (const record of visibleAgain.recordsToApply) {
  if (view.some((row) => row.historySeq === record.historySeq)) continue;
  view.push(record);
}
assert.deepEqual(view.map((row) => row.text), ['done', 'parent continued']);
assert.equal(visibleAgain.draftText, 'still typing');
assert.equal(visibleAgain.scrollTop, 88);

const oneMissing = resolveChatHistoryConvergence({
  reason: 'cross_device_poll',
  documentHidden: false,
  serverHeadSeq: 11,
  storeAckSeq: 10,
  viewAppliedSeq: 10,
  fetchedRecords: [{ historySeq: 11, text: 'single reply' }],
});
assert.equal(oneMissing.status, HISTORY_SYNC_STATUS.SUCCESS);
assert.equal(oneMissing.recordsToApply[0].text, 'single reply');

const pageLimit = resolveChatHistoryConvergence({
  reason: 'cross_device_poll',
  documentHidden: false,
  serverHeadSeq: 600,
  storeAckSeq: 200,
  viewAppliedSeq: 100,
  fetchedRecords: Array.from({ length: 100 }, (_, i) => ({ historySeq: 101 + i })),
  fetchIncomplete: true,
});
assert.equal(pageLimit.status, HISTORY_SYNC_STATUS.PARTIAL);
assert.equal(pageLimit.shouldClearPending, false);
assert.equal(pageLimit.nextViewAppliedSeq, 200);

const fetchError = resolveChatHistoryConvergence({
  reason: 'visibility',
  fetchFailed: true,
  serverHeadSeq: 20,
  storeAckSeq: 10,
  viewAppliedSeq: 10,
});
assert.equal(fetchError.status, HISTORY_SYNC_STATUS.ERROR);
assert.equal(shouldClearPendingRemoteHistory(fetchError), false);

assert.equal(shouldHttpCatchUpAfterWsReplay(), true);
assert.equal(shouldApplyReplayEventsToRenderedView(), true);

const tracker = createInFlightHistorySyncTracker();
let runs = 0;
const first = tracker.run('chat-b', async () => {
  runs += 1;
  await Promise.resolve();
  return runs;
});
const second = tracker.run('chat-b', async () => {
  runs += 1;
  return runs;
});
assert.equal(tracker.isRunning('chat-b'), true);
const firstResult = await first;
const secondResult = await second;
assert.equal(firstResult, 2, 'A signal during an in-flight sync must recheck once');
assert.equal(secondResult, 2);
assert.equal(runs, 2);

const staleTracker = createInFlightHistorySyncTracker({ staleMs: 25 });
let releaseHung = () => {};
const hungTask = new Promise((resolve) => {
  releaseHung = resolve;
});
const hungResult = await staleTracker.run('chat-stale', () => hungTask);
assert.equal(hungResult.deferReason, 'timeout');
assert.equal(staleTracker.isRunning('chat-stale'), false);
releaseHung({ status: HISTORY_SYNC_STATUS.SUCCESS });
let recoveredRuns = 0;
const recoveredResult = await staleTracker.run('chat-stale', async () => {
  recoveredRuns += 1;
  return { status: HISTORY_SYNC_STATUS.SUCCESS };
});
assert.equal(recoveredRuns, 1);
assert.equal(recoveredResult.status, HISTORY_SYNC_STATUS.SUCCESS);

assert.ok(ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS > 0);

resetViewAppliedSeqMemoryForTests();
const reviewChat = {};
replaceViewAppliedRecords('review', reviewChat, [{ historySeq: 100 }]);
assert.equal(getViewAppliedSeq('review', reviewChat), 100);
noteViewAppliedRecords('review', reviewChat, [{ historySeq: 102 }]);
assert.equal(
  getViewAppliedSeq('review', reviewChat),
  100,
  'A later live card must not mark earlier seqs as covered'
);
const gapAfterLiveCard = resolveChatHistoryConvergence({
  serverHeadSeq: 102,
  storeAckSeq: 102,
  viewAppliedSeq: 102,
  fetchedRecords: [{ historySeq: 101, text: 'missing answer' }, { historySeq: 102 }],
});
assert.notEqual(gapAfterLiveCard.status, HISTORY_SYNC_STATUS.UNCHANGED);
assert.equal(
  gapAfterLiveCard.recordsToApply.some((row) => row.text === 'missing answer'),
  true,
  'Fetched seq 101 must still apply when a later card raised the max seq'
);

const outOfOrderMerge = resolveChatHistoryConvergence({
  serverHeadSeq: 103,
  storeAckSeq: 103,
  viewAppliedSeq: 100,
  fetchedRecords: [{ historySeq: 103 }],
  localRecords: [{ historySeq: 101 }, { historySeq: 102 }, { historySeq: 103 }],
});
assert.deepEqual(
  outOfOrderMerge.recordsToApply.map((row) => row.historySeq),
  [101, 102, 103],
  'Merged records must be chronological before watermark selection'
);

const destroyedChat = { _sdkLastRoomEventSeq: 40, _sdkHydratedRoomEventSeqByStream: { room: 40 } };
destroyedChat._sdkUnrenderedRoomEventSeqsByStream = { room: [41] };
replaceViewAppliedRecords('pane', destroyedChat, [{ historySeq: 100 }, { historySeq: 102 }]);
resetViewAppliedState('pane', destroyedChat);
assert.equal(getViewAppliedSeq('pane', destroyedChat), 0);
assert.equal(destroyedChat._sdkLastRoomEventSeq, undefined);
assert.equal(destroyedChat._sdkUnrenderedRoomEventSeqsByStream, undefined);
replaceViewAppliedRecords('pane', destroyedChat, [{ historySeq: 100 }]);
assert.equal(getViewAppliedSeq('pane', destroyedChat), 100);

resetViewAppliedSeqMemoryForTests();
const liveFirst = {};
noteViewAppliedRecords('live-first', liveFirst, [{ historySeq: 102 }]);
assert.equal(
  getViewAppliedSeq('live-first', liveFirst),
  0,
  'A lone live card is not an explicit hydrated-window start'
);
replaceViewAppliedRecords('live-first', liveFirst, [
  { historySeq: 51 },
  { historySeq: 52 },
]);
assert.equal(getViewAppliedOrigin('live-first', liveFirst), 51);
assert.equal(getViewAppliedSeq('live-first', liveFirst), 52);

resetViewAppliedSeqMemoryForTests();
const sessionChat = { cursorSessionId: 'sess-a' };
replaceViewAppliedRecords('session', sessionChat, [{ historySeq: 80 }]);
assert.equal(getViewAppliedSeq('session', sessionChat), 80);
syncViewAppliedSessionKey('session', sessionChat, 'sess-a');
assert.equal(getViewAppliedSeq('session', sessionChat), 80);
syncViewAppliedSessionKey('session', sessionChat, 'sess-b');
assert.equal(getViewAppliedSeq('session', sessionChat), 0, 'A new SDK session must drop the previous window');
assert.equal(sessionChat._sdkViewAppliedSessionKey, 'sess-b');
sessionChat._sdkUnrenderedRoomEventSeqsByStream = { room: [81] };
syncViewAppliedSessionKey('session', sessionChat, 'sess-c');
assert.equal(sessionChat._sdkUnrenderedRoomEventSeqsByStream, undefined, 'A new SDK session must drop render-hole memory');

assert.equal(shouldMarkConnectionHealthyAfterHistorySync(HISTORY_SYNC_STATUS.ERROR), false);
assert.equal(shouldMarkConnectionHealthyAfterHistorySync(HISTORY_SYNC_STATUS.DEFERRED), false);
assert.equal(shouldMarkConnectionHealthyAfterHistorySync(HISTORY_SYNC_STATUS.PARTIAL), false);
assert.equal(shouldMarkConnectionHealthyAfterHistorySync(HISTORY_SYNC_STATUS.SUCCESS), true);

const errorWhileOpen = resolveHistorySyncPollFollowUp({
  status: HISTORY_SYNC_STATUS.ERROR,
  headSeq: 120,
  viewAppliedSeq: 100,
  wsOpen: true,
  retryAttempt: 0,
});
assert.equal(errorWhileOpen.notifyRestored, false);
assert.equal(errorWhileOpen.notifyReachable, false);
assert.equal(errorWhileOpen.canClearPending, false);
assert.equal(errorWhileOpen.retryDelayMs > 0, true);

const deferredWhileOpen = resolveHistorySyncPollFollowUp({
  status: HISTORY_SYNC_STATUS.DEFERRED,
  headSeq: 120,
  viewAppliedSeq: 100,
  wsOpen: true,
  retryAttempt: 0,
});
assert.equal(deferredWhileOpen.notifyRestored, false);
assert.equal(deferredWhileOpen.retryDelayMs, 0);

assert.equal(nextHistorySyncRetryDelayMs(HISTORY_SYNC_RETRY_MAX) > 0, true);
assert.equal(nextHistorySyncRetryDelayMs(HISTORY_SYNC_RETRY_MAX + 1), 0);
const exhausted = resolveHistorySyncPollFollowUp({
  status: HISTORY_SYNC_STATUS.PARTIAL,
  headSeq: 200,
  viewAppliedSeq: 100,
  wsOpen: true,
  retryAttempt: HISTORY_SYNC_RETRY_MAX,
});
assert.equal(exhausted.retryDelayMs, 0);
assert.equal(exhausted.notifyRestored, false);

const inflightChat = {};
let inflightRenders = 0;
setChatHistorySyncInFlight(inflightChat, true, () => {
  inflightRenders += 1;
});
assert.equal(inflightChat._historySyncInFlight, true);
assert.equal(inflightRenders, 1);
setChatHistorySyncInFlight(inflightChat, true, () => {
  inflightRenders += 1;
});
assert.equal(inflightRenders, 1, 'Setter must no-op when the flag is unchanged');
assert.equal(shouldKeepHistorySyncInFlight({ status: HISTORY_SYNC_STATUS.PARTIAL }), false);
assert.equal(
  shouldKeepHistorySyncInFlight({ status: HISTORY_SYNC_STATUS.DEFERRED, deferReason: 'document_hidden' }),
  false
);
assert.equal(
  shouldKeepHistorySyncInFlight({ status: HISTORY_SYNC_STATUS.DEFERRED, deferReason: 'view_replaced' }),
  false
);
assert.equal(
  shouldKeepHistorySyncInFlight({ status: HISTORY_SYNC_STATUS.DEFERRED, deferReason: 'open_terminal_hydrating' }),
  false
);
assert.equal(shouldKeepHistorySyncInFlight({ status: HISTORY_SYNC_STATUS.SUCCESS }), false);
assert.equal(shouldKeepHistorySyncInFlight({ status: HISTORY_SYNC_STATUS.ERROR }), false);
assert.equal(shouldKeepHistorySyncInFlight({ status: HISTORY_SYNC_STATUS.UNCHANGED }), false);

const replayChat = {};
assert.equal(markHistorySyncInFlightForWsReplay(replayChat, false), false);
assert.equal(replayChat._historySyncInFlight, undefined);
assert.equal(markHistorySyncInFlightForWsReplay(replayChat, true), true);
assert.equal(replayChat._historySyncInFlight, true);
assert.equal(clearHistorySyncInFlightAfterWsReplay(replayChat, true), false);
assert.equal(replayChat._historySyncInFlight, true);
assert.equal(clearHistorySyncInFlightAfterWsReplay(replayChat, false), true);
assert.equal(replayChat._historySyncInFlight, false);

const timedChat = {};
let timedRenders = 0;
setChatHistorySyncInFlight(timedChat, true, () => {
  timedRenders += 1;
}, 25);
assert.equal(timedChat._historySyncInFlight, true);
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(timedChat._historySyncInFlight, false);
assert.equal(timedRenders, 2);

setChatHistorySyncInFlight(inflightChat, false);

resetViewAppliedSeqMemoryForTests();
console.log('All chat-history-convergence tests passed.');
