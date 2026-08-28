import assert from 'node:assert/strict';
import { chunkReplayPayloads } from '../lib/sdk/sdk-ws-transport.js';
import { formatRoomEventSeqDiag } from '../lib/sdk/sdk-room-state.js';
import {
  beginSdkHistoryHydration,
  finishSdkHistoryHydration,
  shouldApplySdkRoomEvent,
  syncSdkEventStream,
} from '../app_front/features/chat/sdkEventReplayGuard.js';

const streamId = 'smoke-stream-1';
const inputEntries = Array.from({ length: 30 }, (_, index) => ({
  payload: {
    type: 'sdkEvent',
    roomEventSeq: index + 1,
    event: { type: 'assistant', message: { content: [{ text: `evt-${index + 1}` }] } },
  },
}));

const replayBatches = chunkReplayPayloads(inputEntries, 10);
assert.equal(replayBatches.length, 3);

const mockChat = { id: 'chat-smoke', _processSdkSocketMessage: null };
const appliedEvents = [];
mockChat._processSdkSocketMessage = (message) => {
  appliedEvents.push(message);
};

syncSdkEventStream(mockChat, streamId);
beginSdkHistoryHydration(mockChat);
finishSdkHistoryHydration(mockChat, [
  { kind: 'sdk', eventStreamId: streamId, roomEventSeq: 5, event: { type: 'assistant' } },
]);

for (const batch of replayBatches) {
  mockChat._sdkReplayBatchActive = true;
  for (const event of batch) {
    const replayMsg = { ...event, replay: true };
    if (!shouldApplySdkRoomEvent(mockChat, replayMsg)) continue;
    mockChat._processSdkSocketMessage(replayMsg);
  }
}

assert.equal(appliedEvents.length, 25);
assert.equal(appliedEvents[0].roomEventSeq, 6);
assert.equal(appliedEvents.at(-1).roomEventSeq, 30);

const roomState = {
  type: 'sdkRoomState',
  eventStreamId: streamId,
  lastRoomEventSeq: 30,
  busy: false,
  queuedCount: 0,
};
mockChat._sdkLastRoomEventSeq = 30;
const seqDiag = formatRoomEventSeqDiag(mockChat._sdkLastRoomEventSeq, roomState.lastRoomEventSeq);
assert.equal(seqDiag.isSynced, true);

console.log('All sdk-ws-reconnect-smoke tests passed.');
