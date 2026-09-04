import assert from 'node:assert/strict';
import {
  coalesceSdkHistoryItems,
  extendHistorySliceToStreamBoundary,
  mergeSdkHistoryStreamText,
  readSdkHistoryStreamKind,
  readSdkHistoryStreamText,
} from '../lib/sdk/sdk-history-stream-coalesce.js';

function assistantRec(text) {
  return {
    kind: 'sdk',
    event: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

function thinkingRec(text) {
  return { kind: 'sdk', event: { type: 'thinking', text } };
}

assert.equal(readSdkHistoryStreamKind(assistantRec('a')), 'assistant');
assert.equal(readSdkHistoryStreamKind(thinkingRec('hmm')), 'thinking');
assert.equal(readSdkHistoryStreamKind({ kind: 'sdk', event: { type: 'tool_call' } }), '');
assert.equal(readSdkHistoryStreamText(assistantRec('Hej')), 'Hej');
assert.equal(mergeSdkHistoryStreamText('Hej', 'Hej!'), 'Hej!');
assert.equal(mergeSdkHistoryStreamText('Hej', ' då'), 'Hej då');

const coalesced = coalesceSdkHistoryItems([
  { rec: assistantRec('Tak, ') },
  { rec: assistantRec('widzę') },
  { rec: { kind: 'sdk', event: { type: 'tool_call', name: 'bash' } } },
  { rec: assistantRec('Koniec.') },
]);
assert.equal(coalesced.length, 3);
assert.equal(readSdkHistoryStreamText(coalesced[0].rec), 'Tak, widzę');
assert.equal(coalesced[1].rec.event.type, 'tool_call');
assert.equal(readSdkHistoryStreamText(coalesced[2].rec), 'Koniec.');

const pool = [];
for (let i = 1; i <= 10; i += 1) {
  pool.push({ seq: i, rec: { kind: 'localUser', text: `u${i}` } });
}
for (let i = 11; i <= 30; i += 1) {
  pool.push({ seq: i, rec: assistantRec(`t${i}`) });
}
const limited = pool.slice(-8);
assert.equal(limited[0].seq, 23);
const extended = extendHistorySliceToStreamBoundary(pool, limited, 2000);
assert.equal(extended[0].seq, 11);
assert.equal(extended[extended.length - 1].seq, 30);

const thinkingThenAnswer = [
  { seq: 1, rec: thinkingRec('plan') },
  { seq: 2, rec: assistantRec('hi') },
  { seq: 3, rec: assistantRec(' there') },
];
const answerTail = extendHistorySliceToStreamBoundary(
  thinkingThenAnswer,
  thinkingThenAnswer.slice(-1),
  2000,
);
assert.equal(answerTail[0].seq, 2);
assert.equal(answerTail.length, 2);

console.log('sdk-history-stream-coalesce.test.js OK');
