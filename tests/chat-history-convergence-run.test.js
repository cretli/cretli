import assert from 'node:assert/strict';
import {
  HISTORY_SYNC_STATUS,
  replaceViewAppliedRecords,
  resetViewAppliedSeqMemoryForTests,
} from '../app_front/features/chat/chatHistoryConvergence.js';
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
console.log('All chat-history-convergence-run tests passed.');
