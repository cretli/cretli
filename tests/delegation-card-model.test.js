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
assert.equal(actualDone.userRating, null);
assert.deepEqual(actualDone.actions, ['ack', 'retry']);

// A persisted rating is shown read-only on the card.
const ratedDone = buildDelegationCardModel({
  ...inputDone,
  userRating: { score: 4, tags: ['great'], note: ' solid ', ts: '2026-09-18T10:02:00.000Z' },
});
assert.deepEqual(ratedDone.userRating, {
  score: 4,
  tags: ['great'],
  note: 'solid',
  ts: '2026-09-18T10:02:00.000Z',
});
assert.deepEqual(ratedDone.actions, ['ack', 'retry']);

// A malformed rating payload degrades to "not rated" instead of crashing.
const brokenRating = buildDelegationCardModel({ ...inputDone, userRating: { score: 9 } });
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

// Human accept (todo review contract §7): review attempts only, bound to the attempt.
const reviewCard = buildDelegationCardModel({ status: 'completed', assignment: 'review', attemptId: 'a1' });
assert.equal(reviewCard.canAccept, true);
assert.equal(reviewCard.attemptId, 'a1');
assert.equal(reviewCard.actions.includes('accept'), true);
assert.equal(buildDelegationCardModel({ status: 'completed', assignment: 'implement', attemptId: 'a1' }).canAccept, false);
assert.equal(buildDelegationCardModel({ status: 'running', assignment: 'review', attemptId: 'a1' }).canAccept, false);
assert.equal(buildDelegationCardModel({ status: 'completed', assignment: 'review' }).canAccept, false, 'no attempt id, no accept');
const acceptedCard = buildDelegationCardModel({
  status: 'completed', assignment: 'review', attemptId: 'a1',
  acknowledgedAt: '2026-01-01T00:00:00.000Z', acknowledgedReason: 'accepted', acknowledgedActor: 'human',
});
assert.equal(acceptedCard.canAccept, false);
assert.equal(acceptedCard.isAccepted, true);
// A plain "reviewed" ack only dismissed the card; accept stays possible.
assert.equal(buildDelegationCardModel({
  status: 'completed', assignment: 'review', attemptId: 'a1',
  acknowledgedAt: '2026-01-01T00:00:00.000Z', acknowledgedReason: 'reviewed', acknowledgedActor: 'human',
}).canAccept, true);

// M2: an agent/system/unknown `accepted` ack is a channel signal, not the human
// UI action, so it neither hides the button nor shows "accepted manually".
for (const actor of ['agent', 'system', 'unknown', '']) {
  const card = buildDelegationCardModel({
    status: 'completed', assignment: 'review', attemptId: 'a1',
    acknowledgedAt: '2026-01-01T00:00:00.000Z', acknowledgedReason: 'accepted', acknowledgedActor: actor,
    acknowledgedAttemptId: 'a1',
  });
  assert.equal(card.canAccept, true, `actor "${actor}" must not block human accept`);
  assert.equal(card.isAccepted, false, `actor "${actor}" is not a manual acceptance`);
}
// A human acceptance of an OLDER attempt does not disable the current one.
const wrongAttempt = buildDelegationCardModel({
  status: 'completed', assignment: 'review', attemptId: 'a2',
  acknowledgedAt: '2026-01-01T00:00:00.000Z', acknowledgedReason: 'accepted', acknowledgedActor: 'human',
  acknowledgedAttemptId: 'a1',
});
assert.equal(wrongAttempt.canAccept, true);
assert.equal(wrongAttempt.isAccepted, false);
// Only the matching human acceptance disables it.
const matching = buildDelegationCardModel({
  status: 'completed', assignment: 'review', attemptId: 'a2',
  acknowledgedAt: '2026-01-01T00:00:00.000Z', acknowledgedReason: 'accepted', acknowledgedActor: 'human',
  acknowledgedAttemptId: 'a2',
});
assert.equal(matching.canAccept, false);
assert.equal(matching.isAccepted, true);

console.log('delegation-card-model.test.js OK');

// Plan-headroom snapshot is shown independently of a user pick reason.
const headroomCard = buildDelegationCardModel({
  ...inputRunning,
  pickReason: 'chosen by operator',
  planHeadroomSnapshot: {
    level: 3,
    hardFreePercent: 5,
    windows: [{ type: 'five_hour', utilization: 10, resetsAt: '2026-09-18T12:00:00.000Z' }],
  },
});
assert.equal(headroomCard.pickReason, 'chosen by operator');
assert.equal(headroomCard.planHeadroom.level, 3);
assert.equal(headroomCard.planHeadroom.windows[0].type, 'five_hour');
assert.equal(buildDelegationCardModel(inputRunning).planHeadroom, null);
assert.equal(buildDelegationCardModel({ ...inputRunning, planHeadroomSnapshot: { windows: 'x' } }).planHeadroom, null);

// Weekly pace snapshot sits next to headroom; missing/malformed records yield null.
const paceCard = buildDelegationCardModel({
  ...inputRunning,
  planPaceSnapshot: {
    level: -1,
    costFactor: 2,
    observedAt: '2026-09-18T10:00:00.000Z',
    windows: [{
      type: 'seven_day', utilization: 60, elapsedPct: 20, slackPct: -40,
      eligible: true, reason: '', resetsAt: '2026-09-25T10:00:00.000Z',
    }],
  },
});
assert.equal(paceCard.planPace.level, -1);
assert.equal(paceCard.planPace.costFactor, 2);
assert.equal(paceCard.planPace.windows[0].type, 'seven_day');
assert.equal(buildDelegationCardModel(inputRunning).planPace, null);
assert.equal(buildDelegationCardModel({ ...inputRunning, planPaceSnapshot: { windows: 'x' } }).planPace, null);
assert.equal(buildDelegationCardModel({ ...inputRunning, planPaceSnapshot: { level: 0, windows: [{ type: 'seven_day' }] } }).planPace, null);

// Plan A (5a7ead50) A6: the card explains why this executor was chosen —
// picker/continuation/manual source, controller context, a fallback's failure
// class and any active exclusion with scope and expiry.
const legacySelection = buildDelegationCardModel(inputDone);
assert.deepEqual(legacySelection.selection, {
  origin: 'unknown',
  detail: '',
  startContext: 'legacy_ad_hoc',
  startContextSource: '',
  continuationOf: '',
  uiActionProof: false,
  pickFallbackFrom: '',
  fallbackFailureClass: '',
  exclusion: null,
});
const explainedSelection = buildDelegationCardModel({
  ...inputDone,
  pickOrigin: 'unknown',
  pickOriginDetail: 'continuation',
  startContext: 'automatic',
  startContextSource: 'todo_execution_chat',
  continuationOf: 'prev-delegation-id',
  uiActionProof: true,
  pickFallbackFrom: 'failed-predecessor',
  fallbackFailureClass: 'transient_transport',
  executorExclusion: {
    failureClass: 'model_unavailable',
    scope: 'model',
    reason: 'model_unavailable',
    expiresAt: '2026-09-18T12:00:00.000Z',
  },
});
assert.equal(explainedSelection.selection.origin, 'unknown');
assert.equal(explainedSelection.selection.detail, 'continuation');
assert.equal(explainedSelection.selection.startContext, 'automatic');
assert.equal(explainedSelection.selection.startContextSource, 'todo_execution_chat');
assert.equal(explainedSelection.selection.continuationOf, 'prev-delegation-id');
assert.equal(explainedSelection.selection.uiActionProof, true);
assert.equal(explainedSelection.selection.fallbackFailureClass, 'transient_transport');
assert.deepEqual(explainedSelection.selection.exclusion, {
  failureClass: 'model_unavailable',
  scope: 'model',
  reason: 'model_unavailable',
  expiresAt: '2026-09-18T12:00:00.000Z',
});
const autoSelection = buildDelegationCardModel({ ...inputDone, pickOrigin: 'auto', startContext: 'automatic' });
assert.equal(autoSelection.selection.origin, 'auto');
assert.equal(autoSelection.selection.startContext, 'automatic');
assert.equal(autoSelection.selection.detail, '');
assert.equal(autoSelection.selection.exclusion, null);

assert.equal(explainedSelection.selection.pickFallbackFrom, 'failed-predecessor');
