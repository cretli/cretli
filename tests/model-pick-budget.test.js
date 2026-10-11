/**
 * Budget semantics: reported / estimated / subscription / unknown stay
 * separate, a partial reading is never called a total, and a hard cap is only
 * `enforceable` with a trusted price, an enforceable bound and an atomic
 * reservation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateModelPickBudget,
  readModelPickBudgetStates,
} from '../lib/model-pick-budget.js';

test('reported and estimated are separated and summed as a known subset', () => {
  const reading = evaluateModelPickBudget({
    cost: { reportedUsd: 1.5, estimatedUsd: 0.5, pricedEventCount: 2, unknownEventCount: 0 },
  });
  assert.equal(reading.reportedUsd, 1.5);
  assert.equal(reading.estimatedUsd, 0.5);
  assert.equal(reading.knownUsd, 2);
  assert.equal(reading.label, 'total');
  assert.equal(reading.partial, false);
  assert.equal(reading.coverage, 1);
});

test('an unknown event keeps the reading partial and never counts as zero', () => {
  const reading = evaluateModelPickBudget({
    cost: { reportedUsd: 1, estimatedUsd: null, pricedEventCount: 1, unknownEventCount: 1 },
  });
  assert.equal(reading.knownUsd, 1);
  assert.equal(reading.label, 'known-subset');
  assert.equal(reading.partial, true);
  assert.equal(reading.coverage, 0.5);
  // The known sum is a lower bound; the cap remainder is only a lower bound.
  assert.equal(reading.cap.remainingIsLowerBound, true);
});

test('a subscription-only reading has no marginal USD and coverage 1', () => {
  const reading = evaluateModelPickBudget({
    cost: { reportedUsd: null, estimatedUsd: null, subscriptionEventCount: 3, unknownEventCount: 0, pricedEventCount: 0 },
  });
  assert.equal(reading.knownUsd, null);
  assert.equal(reading.label, 'subscription');
  assert.equal(reading.coverage, 1);
});

test('a hard cap is only enforceable with price, enforcement and reservation', () => {
  const base = {
    cost: { reportedUsd: 3, estimatedUsd: null, pricedEventCount: 1, unknownEventCount: 0 },
    capUsd: 10,
    priceTrusted: true,
    enforced: true,
    atomicReservation: true,
  };
  const enforceable = evaluateModelPickBudget(base);
  assert.equal(enforceable.cap.status, 'enforceable');
  assert.equal(enforceable.cap.remainingUsd, 7);
  assert.equal(enforceable.cap.overThreshold, false);
  assert.equal(enforceable.stopFutureStarts, false);

  const noReservation = evaluateModelPickBudget({ ...base, atomicReservation: false });
  assert.equal(noReservation.cap.status, 'observational');
  assert.equal(noReservation.cap.remainingUsd, null);

  const noPrice = evaluateModelPickBudget({ ...base, priceTrusted: false });
  assert.equal(noPrice.cap.status, 'observational');
});

test('an observational reading stops future starts after the threshold', () => {
  const reading = evaluateModelPickBudget({
    cost: { reportedUsd: 11, estimatedUsd: null, pricedEventCount: 1, unknownEventCount: 0 },
    capUsd: 10,
    priceTrusted: false,
  });
  assert.equal(reading.cap.status, 'observational');
  assert.equal(reading.cap.overThreshold, true);
  assert.equal(reading.stopFutureStarts, true);
});

test('no measurement at all is unavailable, not a zero balance', () => {
  const reading = evaluateModelPickBudget({ cost: {}, capUsd: 10 });
  assert.equal(reading.hasMeasurement, false);
  assert.equal(reading.cap.status, 'unavailable');
  assert.equal(reading.knownUsd, null);
});

test('readModelPickBudgetStates keeps missing values null', () => {
  const states = readModelPickBudgetStates({ reportedUsd: 0 });
  assert.equal(states.reportedUsd, 0);
  assert.equal(states.estimatedUsd, null);
  assert.equal(states.unknownEventCount, 0);
});
