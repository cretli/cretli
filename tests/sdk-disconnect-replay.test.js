import assert from 'node:assert/strict';
import {
  beginSdkHistoryHydration,
  finishSdkHistoryHydration,
  shouldApplySdkRoomEvent,
  syncSdkEventStream,
  takeMissingSdkHistoryRecords,
} from '../app_front/features/chat/sdkEventReplayGuard.js';
import {
  buildSdkRoomStatePayload,
  resolveAgentStateFromRoomState,
  shouldSyncHistoryFromRoomState,
} from '../lib/sdk/sdk-room-state.js';
import { chunkReplayPayloads } from '../lib/sdk/sdk-ws-transport.js';

const streamId = 'stream-mid-run';

function buildReplayEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    at: Date.now(),
    payload: {
      type: 'sdkEvent',
      roomEventSeq: index + 1,
      event: { type: 'assistant', message: { content: [{ text: `chunk-${index + 1}` }] } },
    },
  }));
}

const inputEntries = buildReplayEntries(12);
const replayBatches = chunkReplayPayloads(inputEntries, 5);
assert.equal(replayBatches.length, 3);
assert.equal(replayBatches[0][0].roomEventSeq, 1);
assert.equal(replayBatches[2].at(-1).roomEventSeq, 12);

const chat = { id: 'chat-1' };
beginSdkHistoryHydration(chat);
syncSdkEventStream(chat, streamId);
finishSdkHistoryHydration(chat, [
  { kind: 'sdk', eventStreamId: streamId, roomEventSeq: 4, event: { type: 'assistant' } },
]);

for (const batch of replayBatches) {
  for (const event of batch) {
    if (!shouldApplySdkRoomEvent(chat, event)) continue;
    chat._sdkLastRoomEventSeq = Math.max(Number(chat._sdkLastRoomEventSeq) || 0, Number(event.roomEventSeq));
  }
}
assert.equal(chat._sdkLastRoomEventSeq, 12);

const serverHistoryAfterDisconnect = Array.from({ length: 12 }, (_, index) => ({
  kind: 'sdk',
  eventStreamId: streamId,
  roomEventSeq: index + 1,
  event: { type: 'assistant', message: { content: [{ text: `chunk-${index + 1}` }] } },
}));
const missingAfterResume = takeMissingSdkHistoryRecords(chat, serverHistoryAfterDisconnect);
assert.equal(missingAfterResume.length, 0);

const behindChat = { _sdkEventStreamId: streamId, _sdkLastRoomEventSeq: 8 };
const roomState = buildSdkRoomStatePayload({
  eventStreamId: streamId,
  eventSeq: 12,
  busy: true,
  currentRun: { id: 'run-abc' },
  pendingPrompts: [],
  clients: new Set([{}]),
});
assert.equal(shouldSyncHistoryFromRoomState(behindChat, roomState), true);
assert.equal(resolveAgentStateFromRoomState('idle', roomState), 'active');

const syncedChat = { _sdkEventStreamId: streamId, _sdkLastRoomEventSeq: 12 };
assert.equal(shouldSyncHistoryFromRoomState(syncedChat, roomState), false);

console.log('All sdk-disconnect-replay tests passed.');
