import assert from 'node:assert/strict';
import { takeMissingSdkHistoryRecords } from '../app_front/features/chat/sdkEventReplayGuard.js';
import {
  partitionRecordsByWindowStart,
  readOldestCreatedAt,
  rememberHistoryWindowStart,
  sortRecordsByCreatedAt,
} from '../app_front/features/chat/chatHistoryWindowOrder.js';

const lastNightUser = {
  kind: 'localUser',
  text: 'hej',
  createdAt: '2026-08-27T21:12:02.357Z',
};
const lastNightAssistant = {
  kind: 'sdk',
  eventStreamId: 'stream-last-night',
  roomEventSeq: 10,
  createdAt: '2026-08-27T21:12:08.992Z',
  event: { type: 'assistant' },
};
const tonightUser = {
  kind: 'localUser',
  text: 'hej',
  createdAt: '2026-08-27T22:18:42.797Z',
};
const tonightAssistant = {
  kind: 'sdk',
  eventStreamId: 'stream-tonight',
  roomEventSeq: 11,
  createdAt: '2026-08-27T22:18:52.525Z',
  event: { type: 'assistant' },
};

const inputUnsorted = [tonightUser, tonightAssistant, lastNightUser, lastNightAssistant];
const actualSorted = sortRecordsByCreatedAt(inputUnsorted);
assert.deepEqual(
  actualSorted.map((record) => record.createdAt),
  [
    lastNightUser.createdAt,
    lastNightAssistant.createdAt,
    tonightUser.createdAt,
    tonightAssistant.createdAt,
  ]
);

const inputChat = {};
rememberHistoryWindowStart(inputChat, [tonightUser, tonightAssistant], { reset: true });
assert.equal(inputChat._historyWindowOldestAt, tonightUser.createdAt);

const inputServerBatch = [lastNightUser, lastNightAssistant, tonightUser, tonightAssistant];
const actualParts = partitionRecordsByWindowStart(
  inputServerBatch,
  inputChat._historyWindowOldestAt
);
assert.deepEqual(
  actualParts.older.map((record) => record.createdAt),
  [lastNightUser.createdAt, lastNightAssistant.createdAt]
);
assert.deepEqual(
  actualParts.newer.map((record) => record.createdAt),
  [tonightUser.createdAt, tonightAssistant.createdAt]
);

const inputHydratedChat = {
  _sdkEventStreamId: 'stream-tonight',
  _sdkLastRoomEventSeq: 13,
  _sdkHydratedRoomEventSeqByStream: { 'stream-tonight': 13 },
};
const actualMissing = takeMissingSdkHistoryRecords(inputHydratedChat, inputServerBatch);
assert.deepEqual(
  actualMissing.map((record) => record.eventStreamId),
  ['stream-last-night']
);
const actualMissingParts = partitionRecordsByWindowStart(
  actualMissing,
  inputChat._historyWindowOldestAt
);
assert.equal(actualMissingParts.newer.length, 0);
assert.equal(actualMissingParts.older.length, 1);
assert.equal(actualMissingParts.older[0].eventStreamId, 'stream-last-night');

const actualOlderSlice = partitionRecordsByWindowStart(
  inputServerBatch,
  inputChat._historyWindowOldestAt
).older;
assert.equal(
  actualOlderSlice.some((record) => record.kind === 'localUser'),
  true,
  'older slice must keep localUser rows that takeMissing skips'
);

rememberHistoryWindowStart(inputChat, actualOlderSlice);
assert.equal(inputChat._historyWindowOldestAt, lastNightUser.createdAt);
assert.equal(readOldestCreatedAt(inputServerBatch), lastNightUser.createdAt);

const actualEmpty = partitionRecordsByWindowStart([], '2026-08-27T22:18:42.797Z');
assert.deepEqual(actualEmpty, { older: [], newer: [] });

const actualNoWindow = partitionRecordsByWindowStart([tonightAssistant], '');
assert.deepEqual(actualNoWindow.older, []);
assert.deepEqual(actualNoWindow.newer, [tonightAssistant]);

console.log('All chat-history-window-order tests passed.');
