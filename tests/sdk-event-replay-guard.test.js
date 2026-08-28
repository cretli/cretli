import assert from 'node:assert/strict';
import {
  advanceSdkRoomEventWatermarksFromMessages,
  allowSdkLiveEventsDuringHydration,
  beginSdkHistoryHydration,
  bufferSdkRoomEventDuringHydration,
  finishSdkHistoryHydration,
  shouldApplySdkRoomEvent,
  syncSdkEventStream,
  takeMissingSdkHistoryRecords,
} from '../app_front/features/chat/sdkEventReplayGuard.js';

const chat = {};

syncSdkEventStream(chat, 'room-a');
assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 1 }), true);
assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 2 }), true);
assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 2 }), false);
assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 1 }), false);

syncSdkEventStream(chat, 'room-a');
assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 2 }), false);

syncSdkEventStream(chat, 'room-b');
assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 1 }), true);

assert.equal(shouldApplySdkRoomEvent(chat, {}), true);
assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 'invalid' }), true);

const hydratingChat = {};
beginSdkHistoryHydration(hydratingChat);
syncSdkEventStream(hydratingChat, 'room-c');
assert.equal(
  bufferSdkRoomEventDuringHydration(hydratingChat, {
    type: 'sdkEvent',
    roomEventSeq: 4,
  }),
  true
);
assert.equal(
  bufferSdkRoomEventDuringHydration(hydratingChat, {
    type: 'sdkEvent',
    roomEventSeq: 5,
  }),
  true
);

const pending = finishSdkHistoryHydration(hydratingChat, [
  { kind: 'sdk', eventStreamId: 'room-c', roomEventSeq: 4, event: { type: 'assistant' } },
  { kind: 'sdk', eventStreamId: 'old-room', roomEventSeq: 99, event: { type: 'assistant' } },
]);
assert.equal(pending.length, 2);
assert.equal(shouldApplySdkRoomEvent(hydratingChat, pending[0]), false);
assert.equal(shouldApplySdkRoomEvent(hydratingChat, pending[1]), true);
assert.equal(bufferSdkRoomEventDuringHydration(hydratingChat, {}), false);

const liveHydrationChat = {};
beginSdkHistoryHydration(liveHydrationChat);
allowSdkLiveEventsDuringHydration(liveHydrationChat);
assert.equal(
  bufferSdkRoomEventDuringHydration(liveHydrationChat, {
    type: 'sdkEvent',
    roomEventSeq: 1,
  }),
  false
);
finishSdkHistoryHydration(liveHydrationChat, []);
assert.equal(liveHydrationChat._sdkLiveDuringHydration, undefined);

const taggedHydrationChat = { _sdkReplayTagged: true };
beginSdkHistoryHydration(taggedHydrationChat);
assert.equal(
  bufferSdkRoomEventDuringHydration(taggedHydrationChat, {
    type: 'sdkEvent',
    roomEventSeq: 1,
  }),
  false
);
assert.equal(
  bufferSdkRoomEventDuringHydration(taggedHydrationChat, {
    type: 'sdkEvent',
    roomEventSeq: 2,
    replay: true,
  }),
  true
);

const earlyHydrationChat = {};
beginSdkHistoryHydration(earlyHydrationChat);
finishSdkHistoryHydration(earlyHydrationChat, [
  { kind: 'sdk', eventStreamId: 'room-d', roomEventSeq: 7, event: { type: 'assistant' } },
]);
syncSdkEventStream(earlyHydrationChat, 'room-d');
assert.equal(shouldApplySdkRoomEvent(earlyHydrationChat, { roomEventSeq: 7 }), false);
assert.equal(shouldApplySdkRoomEvent(earlyHydrationChat, { roomEventSeq: 8 }), true);

const resumeChat = {
  _sdkEventStreamId: 'room-e',
  _sdkLastRoomEventSeq: 3,
  _sdkHydratedRoomEventSeqByStream: { 'room-e': 2 },
};
const missingResumeRecords = takeMissingSdkHistoryRecords(resumeChat, [
  { kind: 'sdk', eventStreamId: 'room-e', roomEventSeq: 2, event: { type: 'assistant' } },
  { kind: 'sdk', eventStreamId: 'room-e', roomEventSeq: 4, event: { type: 'assistant' } },
  { kind: 'sdk', eventStreamId: 'room-f', roomEventSeq: 1, event: { type: 'assistant' } },
  { kind: 'localUser', text: 'bez bezpiecznego watermarka' },
]);
assert.equal(missingResumeRecords.length, 2);
assert.equal(missingResumeRecords[0].roomEventSeq, 4);
assert.equal(missingResumeRecords[1].eventStreamId, 'room-f');
assert.equal(resumeChat._sdkLastRoomEventSeq, 4);
assert.equal(resumeChat._sdkHydratedRoomEventSeqByStream['room-f'], 1);
assert.equal(
  takeMissingSdkHistoryRecords(resumeChat, missingResumeRecords).length,
  0
);

const preserveChat = {
  _sdkEventStreamId: 'room-p',
  _sdkLastRoomEventSeq: 9,
  _sdkHydratedRoomEventSeqByStream: { 'room-p': 9 },
};
beginSdkHistoryHydration(preserveChat);
finishSdkHistoryHydration(preserveChat, []);
assert.equal(preserveChat._sdkHydratedRoomEventSeqByStream['room-p'], 9);
assert.equal(preserveChat._sdkLastRoomEventSeq, 9);

advanceSdkRoomEventWatermarksFromMessages(preserveChat, [
  { type: 'sdkEvent', replay: true, roomEventSeq: 10 },
  { type: 'sdkEvent', replay: true, roomEventSeq: 11 },
]);
assert.equal(preserveChat._sdkLastRoomEventSeq, 11);
assert.equal(shouldApplySdkRoomEvent(preserveChat, { roomEventSeq: 10 }), false);

console.log('All sdk-event-replay-guard tests passed.');
