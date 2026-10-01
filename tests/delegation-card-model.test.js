import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { buildDelegationCardModel, projectDelegationCardsFromHistory } from '../lib/delegation-card-model.js';

const inputRunning = {
  status: 'running',
  attemptId: 'a1',
  attempts: [],
  unverified: true,
  startedAt: '2026-09-18T10:00:00.000Z',
};
const actualRunning = buildDelegationCardModel(inputRunning);
assert.equal(actualRunning.canCancel, true);
assert.equal(actualRunning.canRetry, false);
assert.equal(actualRunning.canAck, false);
assert.equal(actualRunning.canRate, false, 'a running job is not rateable');
assert.equal(actualRunning.userRating, null);
assert.equal(actualRunning.attemptNumber, 1);

const inputDone = {
  status: 'completed',
  attemptId: 'a2',
  attempts: [{ attemptId: 'a1' }],
  unverified: true,
  acknowledgedAt: '',
  startedAt: '2026-09-18T10:00:00.000Z',
  finishedAt: '2026-09-18T10:01:00.000Z',
};
const actualDone = buildDelegationCardModel(inputDone);
assert.equal(actualDone.canRetry, true);
assert.equal(actualDone.canAck, true);
assert.equal(actualDone.showUnverified, true);
assert.equal(actualDone.attemptNumber, 2);
assert.equal(actualDone.durationMs, 60000);
assert.equal(actualDone.deliveryState, 'pending');
assert.equal(actualDone.canRate, true, 'a terminal job without a rating is rateable');
assert.equal(actualDone.userRating, null);
assert.deepEqual(actualDone.actions, ['ack', 'retry', 'rate']);

// A persisted user rating makes the card read-only: no second rating action.
const ratedDone = buildDelegationCardModel({
  ...inputDone,
  userRating: { score: 4, tags: ['great'], note: ' solid ', ts: '2026-09-18T10:02:00.000Z' },
});
assert.equal(ratedDone.canRate, false);
assert.deepEqual(ratedDone.userRating, {
  score: 4,
  tags: ['great'],
  note: 'solid',
  ts: '2026-09-18T10:02:00.000Z',
});
assert.deepEqual(ratedDone.actions, ['ack', 'retry'], 'the rate action disappears once rated');

// A malformed rating payload degrades to "not rated" instead of crashing.
const brokenRating = buildDelegationCardModel({ ...inputDone, userRating: { score: 9 } });
assert.equal(brokenRating.canRate, true);
assert.equal(brokenRating.userRating, null);

const reconnectEvents = [
  {
    seq: 1,
    rec: {
      payload: JSON.stringify({
        id: 'd1',
        status: 'running',
        attemptId: 'a1',
        attempts: [],
        event: 'started',
      }),
    },
  },
  {
    seq: 2,
    rec: {
      payload: JSON.stringify({
        id: 'd1',
        status: 'completed',
        attemptId: 'a1',
        attempts: [],
        event: 'finished',
        historyDeliveredAt: '2026-09-18T10:01:00.000Z',
        reportDeliveredAt: '2026-09-18T10:01:01.000Z',
      }),
    },
  },
  {
    seq: 3,
    rec: {
      payload: JSON.stringify({
        id: 'd1',
        status: 'running',
        attemptId: 'a2',
        attempts: [{ attemptId: 'a1', status: 'completed' }],
        event: 'retry',
      }),
    },
  },
  {
    seq: 1,
    rec: {
      payload: JSON.stringify({
        id: 'd1',
        status: 'queued',
        attemptId: 'stale',
        event: 'started',
      }),
    },
  },
];
const projected = projectDelegationCardsFromHistory(reconnectEvents);
const card = projected.get('d1');
assert.equal(card.status, 'running');
assert.equal(card.attemptNumber, 2);
assert.equal(card.canCancel, true);
assert.equal(card.canRetry, false);
assert.equal(card.attemptHistory.length, 2);
assert.equal(card.deliveryState, 'pending');

const cancelledReconnect = projectDelegationCardsFromHistory([
  {
    seq: 4,
    rec: {
      payload: JSON.stringify({
        id: 'd1',
        status: 'cancelled',
        attemptId: 'a2',
        attempts: [{ attemptId: 'a1' }],
        event: 'finished',
        delivery: 'uncertain',
      }),
    },
  },
]);
assert.equal(cancelledReconnect.get('d1').canRetry, true);
assert.equal(cancelledReconnect.get('d1').actions.includes('retry'), true);
assert.equal(cancelledReconnect.get('d1').showUncertain, true);
assert.equal(cancelledReconnect.get('d1').canCancel, false);

console.log('delegation-card-model.test.js OK');
