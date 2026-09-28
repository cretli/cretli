import assert from 'node:assert/strict';
import {
  applyCatchUpSdkHistoryRecords,
  applyLiveServerHistoryCards,
} from '../app_front/features/chat/chatHistoryViewApply.js';
import { insertRecordByViewOrder } from '../app_front/features/chat/chatHistoryViewOrder.js';
import {
  getViewAppliedSeq,
  replaceViewAppliedRecords,
  resetViewAppliedSeqMemoryForTests,
  resetViewAppliedState,
} from '../app_front/features/chat/chatHistoryConvergence.js';
import {
  beginSdkHistoryHydration,
  bufferSdkRoomEventDuringHydration,
  finishSdkHistoryHydration,
  selectMissingSdkHistoryRecords,
} from '../app_front/features/chat/sdkEventReplayGuard.js';
import { runSdkHistoryConvergence } from '../app_front/features/chat/chatHistoryConvergenceRun.js';

resetViewAppliedSeqMemoryForTests();

function createFakeView(options = {}) {
  const nodes = [];
  return {
    nodes,
    prependHistoryRecords(records) {
      nodes.unshift(...records);
    },
    async appendHistoryRecords(records) {
      if (typeof options.failAppend === 'function' && options.failAppend()) {
        throw new Error('render failed');
      }
      for (const record of records) {
        if (record?.kind === 'localUser') {
          const text = typeof record.text === 'string' ? record.text.trim() : '';
          if (!text) continue;
          if (nodes.some((row) => row?.kind === 'localUser' && String(row.text || '').trim() === text)) {
            continue;
          }
        }
        insertRecordByViewOrder(nodes, record);
      }
    },
    hasQueuedOrSentUserText(text) {
      const raw = String(text || '').trim();
      if (!raw) return false;
      return nodes.some((row) => row?.kind === 'localUser' && String(row.text || '').trim() === raw);
    },
  };
}

const streamChat = {
  id: 'apply-a',
  _sdkEventStreamId: 'room-e',
  _sdkLastRoomEventSeq: 2,
  _sdkHydratedRoomEventSeqByStream: { 'room-e': 2 },
};
const unsorted = [
  { kind: 'sdk', historySeq: 103, eventStreamId: 'room-e', roomEventSeq: 5, event: { type: 'assistant' } },
  { kind: 'sdk', historySeq: 101, eventStreamId: 'room-e', roomEventSeq: 3, event: { type: 'assistant' } },
  { kind: 'sdk', historySeq: 102, eventStreamId: 'room-e', roomEventSeq: 4, event: { type: 'assistant' } },
];
replaceViewAppliedRecords('apply-a', streamChat, [{ historySeq: 100 }]);
streamChat._sdkRichView = createFakeView();
const applied = await applyCatchUpSdkHistoryRecords(streamChat, unsorted);
assert.equal(applied, 3);
assert.deepEqual(
  streamChat._sdkRichView.nodes.map((row) => row.historySeq),
  [101, 102, 103]
);
assert.equal(streamChat._sdkLastRoomEventSeq, 5);
assert.equal(getViewAppliedSeq('apply-a', streamChat), 103);

resetViewAppliedSeqMemoryForTests();
const failChat = {
  id: 'apply-b',
  _sdkEventStreamId: 'room-e',
  _sdkLastRoomEventSeq: 2,
  _sdkHydratedRoomEventSeqByStream: { 'room-e': 2 },
};
replaceViewAppliedRecords('apply-b', failChat, [{ historySeq: 100 }]);
let shouldFail = true;
failChat._sdkRichView = createFakeView({
  failAppend: () => shouldFail,
});
await assert.rejects(
  () => applyCatchUpSdkHistoryRecords(failChat, [
    { kind: 'sdk', historySeq: 101, eventStreamId: 'room-e', roomEventSeq: 3, event: { type: 'assistant' } },
  ]),
  /render failed/
);
assert.equal(failChat._sdkLastRoomEventSeq, 2, 'Render failure must not move room watermarks');
assert.equal(getViewAppliedSeq('apply-b', failChat), 100);
assert.equal(
  selectMissingSdkHistoryRecords(failChat, [
    { kind: 'sdk', historySeq: 101, eventStreamId: 'room-e', roomEventSeq: 3, event: { type: 'assistant' } },
  ]).length,
  1
);
shouldFail = false;
const retried = await applyCatchUpSdkHistoryRecords(failChat, [
  { kind: 'sdk', historySeq: 101, eventStreamId: 'room-e', roomEventSeq: 3, event: { type: 'assistant' } },
]);
assert.equal(retried, 1);
assert.equal(failChat._sdkLastRoomEventSeq, 3);
assert.equal(getViewAppliedSeq('apply-b', failChat), 101);

resetViewAppliedSeqMemoryForTests();
const liveChat = { id: 'apply-c' };
replaceViewAppliedRecords('apply-c', liveChat, [{ historySeq: 100 }]);
liveChat._sdkRichView = createFakeView();
await applyLiveServerHistoryCards(liveChat, [
  { historySeq: 102, kind: 'meta', variant: 'mailbox', payload: '{}' },
]);
assert.equal(getViewAppliedSeq('apply-c', liveChat), 100);
assert.equal(liveChat._sdkRichView.nodes[0].historySeq, 102);

let resolveStaleAppend = () => {};
liveChat._sdkRichView = {
  nodes: [],
  appendHistoryRecords() {
    return new Promise((resolve) => {
      resolveStaleAppend = resolve;
    });
  },
};
const staleLive = applyLiveServerHistoryCards(liveChat, [
  { historySeq: 104, kind: 'meta', variant: 'mailbox', payload: '{}' },
]);
liveChat._sdkRichView = createFakeView();
resetViewAppliedState('apply-c', liveChat);
resolveStaleAppend();
await staleLive;
assert.equal(
  getViewAppliedSeq('apply-c', liveChat),
  0,
  'A destroyed view must not note coverage on the replacement pane'
);

resetViewAppliedSeqMemoryForTests();
const swapChat = {
  id: 'apply-d',
};
replaceViewAppliedRecords('apply-d', swapChat, [{ historySeq: 100 }]);
let resolveOldAppend = () => {};
swapChat._sdkRichView = {
  nodes: [],
  prependHistoryRecords() {},
  appendHistoryRecords() {
    return new Promise((resolve) => {
      resolveOldAppend = resolve;
    });
  },
};
const staleCatchUp = applyCatchUpSdkHistoryRecords(swapChat, [
  { kind: 'sdk', historySeq: 102, eventStreamId: 'room', roomEventSeq: 1, event: { type: 'assistant' } },
]);
resetViewAppliedState('apply-d', swapChat);
swapChat._sdkRichView = createFakeView();
resolveOldAppend();
const staleApplied = await staleCatchUp;
assert.equal(staleApplied, 0);
assert.equal(swapChat._sdkRichView.nodes.length, 0);
assert.equal(
  getViewAppliedSeq('apply-d', swapChat),
  0,
  'Catch-up must not note coverage on a view replaced during await'
);

resetViewAppliedSeqMemoryForTests();
const promptChat = { id: 'apply-e' };
replaceViewAppliedRecords('apply-e', promptChat, [{ historySeq: 100 }]);
promptChat._sdkRichView = createFakeView();
const promptApplied = await applyCatchUpSdkHistoryRecords(promptChat, [
  { kind: 'localUser', historySeq: 101, text: 'new prompt' },
]);
assert.equal(promptApplied, 1);
assert.equal(promptChat._sdkRichView.nodes[0].text, 'new prompt');
assert.equal(getViewAppliedSeq('apply-e', promptChat), 101);

resetViewAppliedSeqMemoryForTests();
const echoChat = { id: 'apply-f' };
replaceViewAppliedRecords('apply-f', echoChat, [{ historySeq: 100 }]);
echoChat._sdkRichView = createFakeView();
echoChat._sdkRichView.nodes.push({ kind: 'localUser', text: 'already shown' });
const echoApplied = await applyCatchUpSdkHistoryRecords(echoChat, [
  { kind: 'localUser', historySeq: 101, text: 'already shown' },
]);
assert.equal(echoApplied, 1);
assert.equal(
  echoChat._sdkRichView.nodes.filter((row) => row.kind === 'localUser').length,
  1,
  'An optimistic prompt must not be duplicated'
);
assert.equal(getViewAppliedSeq('apply-f', echoChat), 101);

resetViewAppliedSeqMemoryForTests();
const emptyPromptChat = { id: 'apply-g' };
replaceViewAppliedRecords('apply-g', emptyPromptChat, [{ historySeq: 100 }]);
emptyPromptChat._sdkRichView = createFakeView();
const emptyApplied = await applyCatchUpSdkHistoryRecords(emptyPromptChat, [
  { kind: 'localUser', historySeq: 101, text: '   ' },
]);
assert.equal(emptyApplied, 0);
assert.equal(
  getViewAppliedSeq('apply-g', emptyPromptChat),
  100,
  'Do not mark coverage for a prompt the UI does not hold'
);

resetViewAppliedSeqMemoryForTests();
const coveredChat = {
  id: 'apply-h',
  _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 2,
  _sdkHydratedRoomEventSeqByStream: { room: 2 },
};
replaceViewAppliedRecords('apply-h', coveredChat, [{ historySeq: 100 }]);
coveredChat._sdkRichView = createFakeView();
coveredChat._sdkRichView.nodes.push({
  kind: 'sdk',
  historySeq: 102,
  eventStreamId: 'room',
  roomEventSeq: 2,
});
const coveredApplied = await applyCatchUpSdkHistoryRecords(coveredChat, [
  { kind: 'sdk', historySeq: 102, eventStreamId: 'room', roomEventSeq: 2, event: { type: 'assistant' } },
]);
assert.equal(coveredApplied, 0);
assert.equal(coveredChat._sdkRichView.nodes.length, 1);
assert.equal(
  getViewAppliedSeq('apply-h', coveredChat),
  100,
  'Room-covered seq 102 must not invent coverage for missing 101'
);
const filledGap = await applyCatchUpSdkHistoryRecords(coveredChat, [
  { kind: 'localUser', historySeq: 101, text: 'other client' },
  { kind: 'sdk', historySeq: 102, eventStreamId: 'room', roomEventSeq: 2, event: { type: 'assistant' } },
]);
assert.equal(filledGap, 1);
assert.equal(getViewAppliedSeq('apply-h', coveredChat), 102);
assert.deepEqual(
  coveredChat._sdkRichView.nodes.map((row) => row.historySeq),
  [101, 102],
  'Catch-up of missing 101 must insert before the already-rendered 102'
);
assert.equal(coveredChat._sdkLastRoomEventSeq, 2, 'Room watermarks must not roll back or jump');

resetViewAppliedSeqMemoryForTests();
const racedChat = {
  id: 'apply-race',
  _sdkEventStreamId: 'room-b',
  _sdkLastRoomEventSeq: 76,
  _sdkHydratedRoomEventSeqByStream: { 'room-b': 76 },
};
replaceViewAppliedRecords('apply-race', racedChat, [{ historySeq: 303 }]);
racedChat._sdkRichView = createFakeView();
racedChat._sdkRichView.nodes.push(
  { kind: 'sdk', eventStreamId: 'room-b', roomEventSeq: 77, event: { type: 'assistant' }, text: 'plan' },
  { kind: 'sdk', historySeq: 305, eventStreamId: 'room-b', roomEventSeq: 259, event: { type: 'usage' } }
);
const racedApplied = await applyCatchUpSdkHistoryRecords(racedChat, [
  {
    kind: 'sdk',
    historySeq: 304,
    eventStreamId: 'room-b',
    roomEventSeq: 77,
    event: { type: 'assistant' },
    text: 'plan',
  },
]);
assert.equal(racedApplied, 1);
assert.equal(
  racedChat._sdkRichView.nodes.filter((row) => Number(row.roomEventSeq) === 77).length,
  1,
  'Live answer plus catch-up of the same room seq must not render two Answer cards'
);
assert.equal(getViewAppliedSeq('apply-race', racedChat), 304);

resetViewAppliedSeqMemoryForTests();
const runChat = { id: 'apply-i', cursorSessionId: 'sess-1' };
replaceViewAppliedRecords('apply-i', runChat, [{ historySeq: 100 }]);
let resolveFetch = () => {};
const fetchHold = new Promise((resolve) => {
  resolveFetch = resolve;
});
let hydrationRecords = null;
let notified = false;
runChat._sdkRichView = createFakeView();
runChat._sdkHistoryHydrating = true;
const heldRun = runSdkHistoryConvergence(runChat, { reason: 'visibility' }, {
  isDocumentHidden: () => false,
  fetchDelta: async () => {
    await fetchHold;
    return {
      headSeq: 101,
      ackSeq: 101,
      events: [{ kind: 'localUser', historySeq: 101, text: 'from server' }],
    };
  },
  readLocal: async () => ({ events: [{ historySeq: 100 }] }),
  completeHydration: (_chat, records) => {
    hydrationRecords = records;
    runChat._sdkHistoryHydrating = false;
  },
  notifyReachable: () => {
    notified = true;
  },
  getStoreAckSeq: () => 100,
});
resetViewAppliedState('apply-i', runChat);
runChat._sdkRichView = createFakeView();
resolveFetch();
const heldResult = await heldRun;
assert.equal(heldResult.deferReason, 'view_replaced');
assert.equal(runChat._sdkRichView.nodes.length, 0);
assert.equal(getViewAppliedSeq('apply-i', runChat), 0);
assert.deepEqual(hydrationRecords, []);
assert.equal(notified, false);

resetViewAppliedSeqMemoryForTests();
const nextGenChat = {
  id: 'apply-j',
  cursorSessionId: 'sess-1',
  _sdkEventStreamId: 'room',
};
replaceViewAppliedRecords('apply-j', nextGenChat, [{ historySeq: 100 }]);
nextGenChat._sdkRichView = createFakeView();
nextGenChat._sdkRichView.nodes.push({ kind: 'sdk', historySeq: 100, text: 'seed' });
beginSdkHistoryHydration(nextGenChat);
let resolveNextGenFetch = () => {};
const nextGenFetchHold = new Promise((resolve) => {
  resolveNextGenFetch = resolve;
});
let nextGenHydrationCalls = 0;
let nextGenHydrationRecords = null;
const nextGenPendingEvent = {
  type: 'sdkEvent',
  replay: true,
  eventStreamId: 'room',
  roomEventSeq: 101,
  event: { type: 'assistant', message: { content: [{ type: 'text', text: 'from new pane' }] } },
};
const nextGenRun = runSdkHistoryConvergence(nextGenChat, { reason: 'visibility' }, {
  isDocumentHidden: () => false,
  fetchDelta: async () => {
    await nextGenFetchHold;
    return { headSeq: 101, ackSeq: 101, events: [] };
  },
  readLocal: async () => ({ events: [{ historySeq: 100 }] }),
  completeHydration: (target, records) => {
    nextGenHydrationCalls += 1;
    nextGenHydrationRecords = records;
    finishSdkHistoryHydration(target, records);
  },
  getStoreAckSeq: () => 100,
});
resetViewAppliedState('apply-j', nextGenChat);
nextGenChat._sdkRichView = createFakeView();
beginSdkHistoryHydration(nextGenChat);
bufferSdkRoomEventDuringHydration(nextGenChat, nextGenPendingEvent);
resolveNextGenFetch();
const nextGenResult = await nextGenRun;
assert.equal(nextGenResult.deferReason, 'view_replaced');
assert.equal(nextGenHydrationCalls, 0, 'An older run must not complete a newer pane hydration');
assert.equal(nextGenHydrationRecords, null);
assert.equal(nextGenChat._sdkHistoryHydrating, true);
assert.equal(nextGenChat._sdkPendingRoomEvents.length, 1);
assert.equal(nextGenChat._sdkPendingRoomEvents[0].roomEventSeq, 101);
assert.equal(nextGenChat._sdkRichView.nodes.length, 0);
assert.equal(getViewAppliedSeq('apply-j', nextGenChat), 0);

console.log('All chat-history-view-apply tests passed.');

