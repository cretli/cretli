import assert from 'node:assert/strict';
import { installViewApiHead } from '../app_front/features/chat/history/services/viewApiHead.js';
import {
  HISTORY_SYNC_STATUS,
  replaceViewAppliedRecords,
  resetViewAppliedSeqMemoryForTests,
  resetViewAppliedState,
} from '../app_front/features/chat/chatHistoryConvergence.js';
import { beginSdkHistoryHydration, bufferSdkRoomEventDuringHydration, finishSdkHistoryHydration } from '../app_front/features/chat/sdkEventReplayGuard.js';
import { runSdkHistoryConvergence } from '../app_front/features/chat/chatHistoryConvergenceRun.js';

resetViewAppliedSeqMemoryForTests();

const assistant = { kind: 'sdk', historySeq: 101, text: 'after lock' };
const seeded = { kind: 'sdk', historySeq: 100, text: 'seed' };
const chat = {
  id: 'hidden-sleep',
  cursorSessionId: 'sess-hidden-sleep',
  _sdkRichView: {},
};
replaceViewAppliedRecords(chat.id, chat, [seeded]);

let hidden = false;
let fetchCalls = 0;
const hiddenDuringSleep = await runSdkHistoryConvergence(chat, { reason: 'visibility' }, {
  isDocumentHidden: () => hidden,
  getResumeDeferMs: () => 25,
  sleep: async () => {
    hidden = true;
  },
  fetchDelta: async () => {
    fetchCalls += 1;
    return { headSeq: 101, ackSeq: 101, events: [assistant] };
  },
  readLocal: async () => ({ events: [seeded, assistant] }),
  applyCatchUp: async () => {
    throw new Error('apply must not run while hidden after sleep');
  },
  getStoreAckSeq: () => 100,
});
assert.equal(hiddenDuringSleep.status, HISTORY_SYNC_STATUS.DEFERRED);
assert.equal(hiddenDuringSleep.deferReason, 'document_hidden');
assert.equal(fetchCalls, 0, 'Hidden flip during sleep must skip fetchDelta');

hidden = false;
let appliedSeqs = [];
const visibleAgain = await runSdkHistoryConvergence(chat, { reason: 'visibility' }, {
  isDocumentHidden: () => hidden,
  getResumeDeferMs: () => 0,
  fetchDelta: async () => {
    fetchCalls += 1;
    return { headSeq: 101, ackSeq: 101, events: [] };
  },
  readLocal: async () => ({ events: [seeded, assistant] }),
  applyCatchUp: async (_target, records) => {
    appliedSeqs = records.map((row) => Number(row.historySeq) || 0);
    return records.length;
  },
  getStoreAckSeq: () => 100,
});
assert.equal(visibleAgain.status, HISTORY_SYNC_STATUS.SUCCESS);
assert.equal(fetchCalls, 1);
assert.equal(appliedSeqs.includes(101), true, 'Visible rerun must apply the local catch-up record');

resetViewAppliedSeqMemoryForTests();
// A failed append must release hydration so replay and subsequent live frames can run.
const frozen = { id: 'failed-hydration', _sdkRichView: {} };
beginSdkHistoryHydration(frozen);
const pending = { type: 'sdkEvent', roomEventSeq: 1 };
bufferSdkRoomEventDuringHydration(frozen, pending);
let released = [];
const failedApply = await runSdkHistoryConvergence(frozen, { reason: 'replay_complete' }, {
  fetchDelta: async () => ({ headSeq: 1, ackSeq: 1, events: [{ historySeq: 1, kind: 'sdk' }] }),
  readLocal: async () => ({ events: [] }),
  applyCatchUp: async () => { throw new Error('render failed'); },
  completeHydration: (target, records) => { released = finishSdkHistoryHydration(target, records); },
});
assert.equal(failedApply.deferReason, 'apply_failed');
assert.equal(frozen._sdkHistoryHydrating, false);
assert.deepEqual(released, [pending]);
assert.equal(frozen._sdkLastRoomEventSeq, undefined, 'Failed rows cannot advance the room watermark');

// Repair fetches and replays the whole tail despite both watermarks claiming coverage.
const repair = {
  id: 'missing-question', _sdkRichView: {}, _sdkEventStreamId: 'room',
  _sdkLastRoomEventSeq: 102, _sdkReplayTagged: true,
};
replaceViewAppliedRecords(repair.id, repair, [{ historySeq: 101 }, { historySeq: 102 }]);
const tail = [
  { kind: 'sdk', historySeq: 101, eventStreamId: 'room', roomEventSeq: 101,
    event: { type: 'opencode_question', requestId: 'question-1' } },
  { kind: 'sdk', historySeq: 102, eventStreamId: 'room', roomEventSeq: 102,
    event: { type: 'assistant' } },
];
let replayed = [];
let repairPending = [];
const repairDeps = {
  fetchDelta: async () => { throw new Error('Delta must not be used for missing interactive cards'); },
  fetchTail: async () => {
    assert.equal(bufferSdkRoomEventDuringHydration(repair, { type: 'sdkEvent', roomEventSeq: 103 }), true,
      'Live tagged frames must survive replacement of the tail');
    return { events: tail };
  },
  replayTail: async (_target, records) => {
    replayed = records;
    return { reason: 'complete', applied: records.length };
  },
  readLocal: async () => { throw new Error('Truncated local cache is not repair evidence'); },
  completeHydration: (target, records) => { repairPending = finishSdkHistoryHydration(target, records); },
};
const repaired = await runSdkHistoryConvergence(repair, { reason: 'room_state_missing_interactive' }, repairDeps);
assert.equal(repaired.status, 'success');
assert.deepEqual(replayed, tail);
assert.equal(repairPending[0].roomEventSeq, 103);
assert.equal(repair._sdkHistoryHydrating, false);
assert.equal(repair._sdkHistoryRepairing, undefined);

for (const mode of ['fetch', 'replay', 'partial']) {
  const result = await runSdkHistoryConvergence(repair, { reason: 'room_state_missing_interactive' }, {
    ...repairDeps,
    fetchTail: async () => mode === 'fetch' ? null : { events: tail },
    replayTail: async () => {
      if (mode === 'replay') throw new Error('Replay failed');
      return { reason: 'cancelled', applied: 1 };
    },
  });
  assert.equal(result.status, 'error', mode);
  assert.equal(repair._sdkHistoryHydrating, false, mode);
}
const hiddenRepair = await runSdkHistoryConvergence(repair, { reason: 'room_state_missing_interactive' }, {
  ...repairDeps, isDocumentHidden: () => true,
});
assert.equal(hiddenRepair.status, 'deferred');
assert.equal(repair._sdkHistoryHydrating, false, 'Hidden repair must not start hydration');

const replaced = { id: 'repair-view-replaced', _sdkRichView: {} };
let settleTail;
const heldTail = new Promise((resolve) => { settleTail = resolve; });
let completedNewView = false;
const oldRepair = runSdkHistoryConvergence(replaced, { reason: 'room_state_missing_interactive' }, {
  fetchTail: () => heldTail,
  completeHydration: () => { completedNewView = true; },
});
resetViewAppliedState(replaced.id, replaced);
replaced._sdkRichView = {};
beginSdkHistoryHydration(replaced);
bufferSdkRoomEventDuringHydration(replaced, pending);
settleTail({ events: tail });
const replacedResult = await oldRepair;
assert.equal(replacedResult.deferReason, 'view_replaced');
assert.equal(completedNewView, false, 'Old repair must not complete hydration of a new pane');
assert.equal(replaced._sdkHistoryHydrating, true);
assert.equal(replaced._sdkHistoryRepairing, undefined, 'A new hydration must discard old repair mode');
assert.deepEqual(replaced._sdkPendingRoomEvents, [pending]);

const card = (connected, ...classes) => ({
  isConnected: connected, classList: { contains: (name) => classes.includes(name) },
});
const scope = {
  openCodeQuestionByRequestId: new Map([
    ['pending', card(true)], ['detached', card(false)],
    ['answered', card(true, 'sdk-rich-opencode-question--answered')],
    ['resolved', card(true, 'sdk-rich-opencode-question--resolved')],
  ]),
  openCodePermissionByRequestId: new Map([
    ['pending', card(true)], ['detached', card(false)],
    ['answered', card(true, 'sdk-rich-opencode-permission--answered')],
    ['resolved', card(true, 'sdk-rich-opencode-permission--resolved')],
  ]),
};
installViewApiHead(scope);
assert.deepEqual(scope.viewPublicApi.getPendingInteractiveCounts(), { questions: 1, permissions: 1 });

console.log('All chat-history-convergence-run tests passed.');
