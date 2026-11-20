import assert from 'node:assert/strict';
import {
  advanceSdkRoomEventWatermarksFromMessages,
  allowSdkLiveEventsDuringHydration,
  beginSdkHistoryHydration,
  bufferSdkRoomEventDuringHydration,
  finishSdkHistoryHydration,
  shouldApplySdkRoomEvent,
  syncSdkEventStream,
  selectMissingSdkHistoryRecords,
  selectRoomCoveredSdkHistoryRecords,
  takeMissingSdkHistoryRecords,
  hasSdkHistoryRoomWatermarks,
  ownsSdkHistoryHydration,
  hasUnrenderedSdkRoomEventSeq,
  rememberUnrenderedSdkRoomEvent,
  noteRenderedSdkRoomEvent,
  clearUnrenderedSdkRoomEvents,
} from '../app_front/features/chat/sdkEventReplayGuard.js';

const chat = {};

// Server-authored delegation cards have no room stream watermark. Catch-up
// must deliver both the initial child link and subsequent status updates.
const delegationStarted = {
  kind: 'meta', variant: 'delegation', historySeq: 10,
  payload: JSON.stringify({ id: 'job-1', childChatId: 'child-1', status: 'running' }),
};
const delegationFinished = {
  ...delegationStarted, historySeq: 11,
  payload: JSON.stringify({ id: 'job-1', childChatId: 'child-1', status: 'completed' }),
};
const mailboxStarted = {
  kind: 'meta', variant: 'mailbox', historySeq: 20,
  payload: JSON.stringify({ id: 'mail-1', status: 'queued' }),
};
const mailboxDelivered = {
  ...mailboxStarted, historySeq: 21,
  payload: JSON.stringify({ id: 'mail-1', status: 'delivered' }),
};
const relatedChat = {
  kind: 'meta', variant: 'relatedChat', historySeq: 22,
  payload: JSON.stringify({ role: 'child', chatId: 'child-1' }),
};
assert.deepEqual(takeMissingSdkHistoryRecords({}, [
  { kind: 'localUser', text: 'already visible' }, delegationStarted, delegationFinished,
]), [{ kind: 'localUser', text: 'already visible' }, delegationStarted, delegationFinished]);
assert.deepEqual(takeMissingSdkHistoryRecords({}, [mailboxStarted, mailboxDelivered, relatedChat]), [
  mailboxStarted, mailboxDelivered, relatedChat,
]);

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
assert.equal(missingResumeRecords.length, 3);
assert.equal(missingResumeRecords[0].roomEventSeq, 4);
assert.equal(missingResumeRecords[1].eventStreamId, 'room-f');
assert.equal(missingResumeRecords[2].kind, 'localUser');
assert.equal(resumeChat._sdkLastRoomEventSeq, 4);
assert.equal(resumeChat._sdkHydratedRoomEventSeqByStream['room-f'], 1);
assert.equal(
  takeMissingSdkHistoryRecords(resumeChat, missingResumeRecords).filter((row) => row.kind !== 'localUser').length,
  0
);

const probeChat = {
  _sdkEventStreamId: 'room-select',
  _sdkLastRoomEventSeq: 3,
  _sdkHydratedRoomEventSeqByStream: { 'room-select': 3 },
};
const selected = selectMissingSdkHistoryRecords(probeChat, [
  { kind: 'sdk', eventStreamId: 'room-select', roomEventSeq: 4, event: { type: 'assistant' } },
]);
assert.equal(selected.length, 1);
assert.equal(probeChat._sdkLastRoomEventSeq, 3);
assert.equal(probeChat._sdkHydratedRoomEventSeqByStream['room-select'], 3);

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

assert.equal(hasSdkHistoryRoomWatermarks({}), false);
assert.equal(hasSdkHistoryRoomWatermarks({ _sdkLastRoomEventSeq: 0 }), false);
assert.equal(hasSdkHistoryRoomWatermarks({ _sdkHydratedRoomEventSeqByStream: {} }), false);
assert.equal(hasSdkHistoryRoomWatermarks({ _sdkLastRoomEventSeq: 9 }), true);
assert.equal(
  hasSdkHistoryRoomWatermarks({ _sdkHydratedRoomEventSeqByStream: { 'stream-a': 4 } }),
  true,
);

const coveredChat = {
  _sdkEventStreamId: 'room-cover',
  _sdkLastRoomEventSeq: 4,
  _sdkHydratedRoomEventSeqByStream: { 'room-cover': 4 },
};
const alreadyLive = {
  kind: 'sdk',
  historySeq: 102,
  eventStreamId: 'room-cover',
  roomEventSeq: 4,
  event: { type: 'assistant' },
};
assert.deepEqual(selectRoomCoveredSdkHistoryRecords(coveredChat, [alreadyLive]), [alreadyLive]);
assert.equal(selectMissingSdkHistoryRecords(coveredChat, [alreadyLive]).length, 0);
assert.equal(coveredChat._sdkLastRoomEventSeq, 4);

const ownedChat = { _sdkViewApplyGeneration: 4 };
beginSdkHistoryHydration(ownedChat);
assert.equal(ownedChat._sdkHistoryHydrationGeneration, 4);
assert.equal(ownsSdkHistoryHydration(ownedChat, 4), true);
assert.equal(ownsSdkHistoryHydration(ownedChat, 5), false);
ownedChat._sdkViewApplyGeneration = 5;
beginSdkHistoryHydration(ownedChat);
bufferSdkRoomEventDuringHydration(ownedChat, { type: 'sdkEvent', replay: true, roomEventSeq: 1 });
assert.equal(ownsSdkHistoryHydration(ownedChat, 4), false);
assert.equal(ownsSdkHistoryHydration(ownedChat, 5), true);
assert.equal(ownedChat._sdkPendingRoomEvents.length, 1);
finishSdkHistoryHydration(ownedChat, []);
assert.equal(ownsSdkHistoryHydration(ownedChat, 5), false);
assert.equal(ownedChat._sdkHistoryHydrationGeneration, undefined);

const holeChat = {
  _sdkEventStreamId: 'room-hole',
  _sdkLastRoomEventSeq: 100,
  _sdkHydratedRoomEventSeqByStream: { 'room-hole': 100 },
};
assert.equal(shouldApplySdkRoomEvent(holeChat, {
  eventStreamId: 'room-hole',
  roomEventSeq: 101,
}), true);
rememberUnrenderedSdkRoomEvent(holeChat, {
  eventStreamId: 'room-hole',
  roomEventSeq: 101,
});
assert.equal(hasUnrenderedSdkRoomEventSeq(holeChat, 'room-hole', 101), true);
assert.equal(shouldApplySdkRoomEvent(holeChat, {
  eventStreamId: 'room-hole',
  roomEventSeq: 102,
}), true);
assert.equal(holeChat._sdkLastRoomEventSeq, 102);
const holeRecord101 = {
  kind: 'sdk',
  historySeq: 101,
  eventStreamId: 'room-hole',
  roomEventSeq: 101,
  event: { type: 'assistant' },
};
const holeRecord102 = {
  kind: 'sdk',
  historySeq: 102,
  eventStreamId: 'room-hole',
  roomEventSeq: 102,
  event: { type: 'assistant' },
};
assert.deepEqual(selectRoomCoveredSdkHistoryRecords(holeChat, [holeRecord101, holeRecord102]), [
  holeRecord102,
]);
assert.deepEqual(selectMissingSdkHistoryRecords(holeChat, [holeRecord101, holeRecord102]), [
  holeRecord101,
]);
assert.equal(shouldApplySdkRoomEvent(holeChat, {
  eventStreamId: 'room-hole',
  roomEventSeq: 101,
}), true, 'A hole at 101 must remain retryable after 102 advanced the watermark');
noteRenderedSdkRoomEvent(holeChat, {
  eventStreamId: 'room-hole',
  roomEventSeq: 101,
});
assert.equal(hasUnrenderedSdkRoomEventSeq(holeChat, 'room-hole', 101), false);
assert.equal(shouldApplySdkRoomEvent(holeChat, {
  eventStreamId: 'room-hole',
  roomEventSeq: 101,
}), false);
assert.deepEqual(selectRoomCoveredSdkHistoryRecords(holeChat, [holeRecord101]), [holeRecord101]);

const takeHoleChat = {
  _sdkEventStreamId: 'room-take',
  _sdkLastRoomEventSeq: 102,
  _sdkHydratedRoomEventSeqByStream: { 'room-take': 102 },
};
rememberUnrenderedSdkRoomEvent(takeHoleChat, {
  eventStreamId: 'room-take',
  roomEventSeq: 101,
});
const takenHole = takeMissingSdkHistoryRecords(takeHoleChat, [
  {
    kind: 'sdk',
    historySeq: 101,
    eventStreamId: 'room-take',
    roomEventSeq: 101,
    event: { type: 'assistant' },
  },
  {
    kind: 'sdk',
    historySeq: 102,
    eventStreamId: 'room-take',
    roomEventSeq: 102,
    event: { type: 'assistant' },
  },
]);
assert.equal(takenHole.length, 1);
assert.equal(takenHole[0].roomEventSeq, 101);
assert.equal(takeHoleChat._sdkLastRoomEventSeq, 102);
assert.equal(hasUnrenderedSdkRoomEventSeq(takeHoleChat, 'room-take', 101), false);

rememberUnrenderedSdkRoomEvent(takeHoleChat, {
  eventStreamId: 'room-take',
  roomEventSeq: 103,
});
clearUnrenderedSdkRoomEvents(takeHoleChat);
assert.equal(hasUnrenderedSdkRoomEventSeq(takeHoleChat, 'room-take', 103), false);

console.log('All sdk-event-replay-guard tests passed.');
