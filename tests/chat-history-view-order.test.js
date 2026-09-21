import assert from 'node:assert/strict';
import {
  compareViewOrderKeys,
  findExistingViewOrderIndex,
  findViewInsertIndex,
  foldDuplicateViewOrderNodes,
  insertRecordByViewOrder,
  isSameViewOrderKey,
  resolveViewOrderKey,
  viewOrderIdentity,
} from '../app_front/features/chat/chatHistoryViewOrder.js';

const STREAM_A = 'stream-a';
const STREAM_B = 'stream-b';
const STREAM_ROOM = 'room';

const key101 = resolveViewOrderKey({
  historySeq: 101,
  eventStreamId: STREAM_ROOM,
  roomEventSeq: 101,
});
const key102 = resolveViewOrderKey({
  historySeq: 102,
  eventStreamId: STREAM_ROOM,
  roomEventSeq: 102,
});
assert.equal(compareViewOrderKeys(key101, key102) < 0, true);
assert.equal(compareViewOrderKeys(key102, key101) > 0, true);

const roomOnly102 = resolveViewOrderKey({ eventStreamId: STREAM_ROOM, roomEventSeq: 102 });
const recovered101 = resolveViewOrderKey({
  historySeq: 101,
  eventStreamId: STREAM_ROOM,
  roomEventSeq: 101,
});
assert.equal(
  compareViewOrderKeys(recovered101, roomOnly102) < 0,
  true,
  'HTTP 101 must sit before a live card stamped only with room seq 102 of the same stream'
);

const historyOnly101 = resolveViewOrderKey({ historySeq: 101 });
const historyOnly102 = resolveViewOrderKey({ historySeq: 102 });
assert.equal(compareViewOrderKeys(historyOnly101, historyOnly102) < 0, true);

assert.equal(
  compareViewOrderKeys(historyOnly101, roomOnly102),
  0,
  'Do not mix historySeq with roomEventSeq from another namespace'
);

const existing = [
  { historySeq: 100, text: 'seed' },
  { eventStreamId: STREAM_ROOM, roomEventSeq: 102, text: 'response 102' },
];
assert.equal(findViewInsertIndex(existing.map(resolveViewOrderKey), recovered101), 1);

const nodes = [
  { historySeq: 100, text: 'seed' },
  { kind: 'runFinished', status: 'finished', eventStreamId: STREAM_ROOM, roomEventSeq: 102 },
];
insertRecordByViewOrder(nodes, {
  historySeq: 101,
  eventStreamId: STREAM_ROOM,
  roomEventSeq: 101,
  text: 'response 101',
});
assert.deepEqual(
  nodes.map((row) => row.text || row.kind),
  ['seed', 'response 101', 'runFinished']
);

const liveThenRetry = [
  { historySeq: 100, text: 'seed' },
  { eventStreamId: STREAM_ROOM, roomEventSeq: 102, text: 'response 102' },
];
insertRecordByViewOrder(liveThenRetry, {
  eventStreamId: STREAM_ROOM,
  roomEventSeq: 101,
  text: 'response 101',
});
assert.deepEqual(
  liveThenRetry.map((row) => row.text),
  ['seed', 'response 101', 'response 102']
);

const delegationAfter = [
  { historySeq: 100, text: 'seed' },
  { historySeq: 102, kind: 'meta', variant: 'delegation' },
];
insertRecordByViewOrder(delegationAfter, { historySeq: 101, text: 'response 101' });
assert.deepEqual(
  delegationAfter.map((row) => row.historySeq),
  [100, 101, 102]
);

insertRecordByViewOrder(delegationAfter, { text: 'unknown live' });
assert.equal(delegationAfter.at(-1).text, 'unknown live');

const oldStreamA102 = resolveViewOrderKey({ eventStreamId: STREAM_A, roomEventSeq: 102 });
const newStreamB1 = resolveViewOrderKey({ eventStreamId: STREAM_B, roomEventSeq: 1 });
assert.equal(
  compareViewOrderKeys(newStreamB1, oldStreamA102),
  0,
  'Room seq from a new stream must not sort before an older stream'
);
assert.equal(
  compareViewOrderKeys(
    resolveViewOrderKey({ historySeq: 50, eventStreamId: STREAM_A, roomEventSeq: 102 }),
    resolveViewOrderKey({ historySeq: 51, eventStreamId: STREAM_B, roomEventSeq: 1 })
  ) < 0,
  true,
  'historySeq may still order records of the same chat across streams'
);

const crossStreamLive = [
  { eventStreamId: STREAM_A, roomEventSeq: 102, text: 'old A102' },
];
insertRecordByViewOrder(crossStreamLive, {
  eventStreamId: STREAM_B,
  roomEventSeq: 1,
  text: 'new B1',
});
assert.deepEqual(
  crossStreamLive.map((row) => row.text),
  ['old A102', 'new B1'],
  'Live B1 must stay after A102'
);

const recoverB1AfterB2 = [
  { eventStreamId: STREAM_A, roomEventSeq: 102, text: 'old A102' },
  { eventStreamId: STREAM_B, roomEventSeq: 2, text: 'new B2' },
];
insertRecordByViewOrder(recoverB1AfterB2, {
  eventStreamId: STREAM_B,
  roomEventSeq: 1,
  text: 'new B1',
});
assert.deepEqual(
  recoverB1AfterB2.map((row) => row.text),
  ['old A102', 'new B1', 'new B2'],
  'Recovered B1 sits before B2; both stay after A102'
);

const noStreamRoom = [
  { roomEventSeq: 102, text: 'old 102' },
];
insertRecordByViewOrder(noStreamRoom, { roomEventSeq: 1, text: 'new 1' });
assert.deepEqual(
  noStreamRoom.map((row) => row.text),
  ['old 102', 'new 1'],
  'Missing stream id must not invent a global room-seq order'
);
assert.equal(
  compareViewOrderKeys(
    resolveViewOrderKey({ roomEventSeq: 1 }),
    resolveViewOrderKey({ roomEventSeq: 102 })
  ),
  0
);

assert.equal(
  isSameViewOrderKey(
    resolveViewOrderKey({ historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77 }),
    resolveViewOrderKey({ historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77 })
  ),
  true,
  'Identical historySeq is the same card'
);
assert.equal(
  isSameViewOrderKey(
    resolveViewOrderKey({ historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77 }),
    resolveViewOrderKey({ eventStreamId: STREAM_B, roomEventSeq: 77 })
  ),
  true,
  'Live room stamp without historySeq matches the persisted card'
);
assert.equal(
  isSameViewOrderKey(
    resolveViewOrderKey({ historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77 }),
    resolveViewOrderKey({ historySeq: 305, eventStreamId: STREAM_B, roomEventSeq: 259 })
  ),
  false
);
assert.equal(
  isSameViewOrderKey(
    resolveViewOrderKey({ eventStreamId: STREAM_A, roomEventSeq: 77 }),
    resolveViewOrderKey({ eventStreamId: STREAM_B, roomEventSeq: 77 })
  ),
  false,
  'Room seq is per stream'
);
assert.equal(
  findExistingViewOrderIndex(
    [
      resolveViewOrderKey({ historySeq: 295, eventStreamId: STREAM_B, roomEventSeq: 25 }),
      resolveViewOrderKey({ historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77 }),
      resolveViewOrderKey({ historySeq: 305, eventStreamId: STREAM_B, roomEventSeq: 259 }),
    ],
    resolveViewOrderKey({ historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77 })
  ),
  1
);

const liveAnswerThenCatchUp = [
  { eventStreamId: STREAM_B, roomEventSeq: 77, text: 'plan once' },
  { historySeq: 305, eventStreamId: STREAM_B, roomEventSeq: 259, text: 'usage' },
];
insertRecordByViewOrder(liveAnswerThenCatchUp, {
  historySeq: 304,
  eventStreamId: STREAM_B,
  roomEventSeq: 77,
  text: 'plan once again',
});
assert.deepEqual(
  liveAnswerThenCatchUp.map((row) => row.text),
  ['plan once', 'usage'],
  'Catch-up of an already-rendered answer must not insert a second card before later usage'
);

assert.equal(
  viewOrderIdentity({ historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77 }),
  'h:304'
);
const stackedAnswers = [
  { historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77, text: 'plan a' },
  { historySeq: 304, eventStreamId: STREAM_B, roomEventSeq: 77, text: 'plan b' },
  { historySeq: 305, eventStreamId: STREAM_B, roomEventSeq: 259, text: 'usage' },
];
foldDuplicateViewOrderNodes(stackedAnswers);
assert.deepEqual(
  stackedAnswers.map((row) => row.text),
  ['plan a', 'usage'],
  'Already stacked duplicate Answer cards collapse to the first copy'
);

console.log('All chat-history-view-order tests passed.');
