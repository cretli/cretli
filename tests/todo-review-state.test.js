/**
 * Tests for lib/todo-review-state.js — state/subject vocabulary, predicates,
 * independence classification, subtree aggregation and the stable snapshot
 * comparison (docs/todo-review-contract.md §4, §9, §12).
 */
import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import {
  aggregateTodoReviewStates,
  classifyTodoReviewIndependence,
  compareTodoReviewSnapshots,
  compareTodoReviewSubjects,
  isTodoCodeReviewPassed,
  isTodoPlanReviewPassed,
  isTodoReviewFailed,
  isTodoReviewGateQualified,
  isTodoReviewIndependent,
  isTodoReviewManual,
  isTodoReviewPending,
  isTodoReviewState,
  isTodoReviewStale,
  isTodoReviewSubject,
  isTodoReviewUnknown,
  summarizeTodoReviewIndependence,
  todoReviewDecisionKey,
  todoReviewStateForSubject,
} from '../lib/todo-review-state.js';

let failed = 0;

function reportFailure(name, err) {
  failed += 1;
  console.error('FAIL:', name);
  console.error(err && err.stack ? err.stack : String(err));
}

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    reportFailure(name, err);
  }
}

/**
 * @param {object} snapshot
 * @param {string} subject
 * @returns {object}
 */
function reviewWith(snapshot, subject = 'code') {
  return { review: { [subject]: snapshot } };
}

runCase('vocabulary: states and subjects', () => {
  for (const state of ['none', 'pending', 'passed', 'failed', 'manual', 'stale', 'unknown']) {
    assert.equal(isTodoReviewState(state), true, state);
  }
  assert.equal(isTodoReviewState('banana'), false);
  assert.equal(isTodoReviewState(''), false);
  assert.equal(isTodoReviewState(undefined), false);
  for (const subject of ['code', 'plan', 'other']) {
    assert.equal(isTodoReviewSubject(subject), true, subject);
  }
  assert.equal(isTodoReviewSubject('banana'), false);
});

runCase('state predicates: code and plan are independent', () => {
  const todo = {
    review: {
      code: { state: 'passed' },
      plan: { state: 'stale' },
    },
  };
  assert.equal(todoReviewStateForSubject(todo, 'code'), 'passed');
  assert.equal(todoReviewStateForSubject(todo, 'plan'), 'stale');
  assert.equal(todoReviewStateForSubject(todo, 'other'), 'none');
  assert.equal(isTodoCodeReviewPassed(todo), true);
  assert.equal(isTodoPlanReviewPassed(todo), false);
  assert.equal(isTodoReviewStale(todo, 'plan'), true);
  assert.equal(isTodoReviewStale(todo, 'code'), false);
});

runCase('state predicates: failed/pending/manual/unknown and missing subject', () => {
  assert.equal(isTodoReviewFailed(reviewWith({ state: 'failed' })), true);
  assert.equal(isTodoReviewPending(reviewWith({ state: 'pending' })), true);
  assert.equal(isTodoReviewManual(reviewWith({ state: 'manual' })), true);
  assert.equal(isTodoReviewUnknown(reviewWith({ state: 'unknown' })), true);
  assert.equal(isTodoReviewUnknown({}), false);
  assert.equal(todoReviewStateForSubject({}, 'code'), 'none');
  // A malformed state must never read as passed.
  assert.equal(todoReviewStateForSubject(reviewWith({ state: 'banana' }), 'code'), 'unknown');
  assert.equal(isTodoCodeReviewPassed(reviewWith({ state: 'banana' })), false);
});

runCase('gate predicate requires independent, current material and an implementer', () => {
  const base = {
    state: 'passed',
    independence: { independent: true, class: 'different_base_model', reference: 'implementer' },
    material: { current: true },
    implementer: { delegationId: 'd0', attemptId: 'a0' },
  };
  assert.equal(isTodoReviewGateQualified(reviewWith(base)), true);
  assert.equal(isTodoReviewGateQualified(reviewWith({ ...base, material: { current: false } })), false);
  assert.equal(isTodoReviewGateQualified(reviewWith({ ...base, implementer: null })), false);
  assert.equal(isTodoReviewGateQualified(reviewWith({
    ...base,
    independence: { independent: false, class: 'same_model_same_harness', reference: 'implementer' },
  })), false);
  assert.equal(isTodoReviewIndependent(reviewWith(base)), true);
});

runCase('independence: auto and empty model are unknown', () => {
  assert.equal(classifyTodoReviewIndependence({ model: 'auto', harness: 'a' }, { model: 'auto', harness: 'a' }), 'unknown');
  assert.equal(classifyTodoReviewIndependence({ model: '', harness: 'a' }, { model: 'gpt-5', harness: 'a' }), 'unknown');
  assert.equal(classifyTodoReviewIndependence({ model: 'gpt-5', harness: 'a' }, { model: '', harness: 'a' }), 'unknown');
  assert.equal(classifyTodoReviewIndependence({ model: 'gpt-5', harness: 'a' }, null), 'unknown');
});

runCase('independence: ::effort parameters compare by base model', () => {
  assert.equal(
    classifyTodoReviewIndependence(
      { model: 'testfakeb-chat::effort=high', harness: 'testfake' },
      { model: 'testfakeb-chat', harness: 'testfake' },
    ),
    'same_model_same_harness',
  );
  assert.equal(
    classifyTodoReviewIndependence(
      { model: 'testfakeb-chat::effort=high', harness: 'codex' },
      { model: 'testfakeb-chat', harness: 'testfake' },
    ),
    'same_model_other_harness',
  );
  assert.equal(
    classifyTodoReviewIndependence(
      { model: 'gpt-5::effort=high', harness: 'testfake' },
      { model: 'testfakeb-chat', harness: 'testfake' },
    ),
    'different_base_model',
  );
  assert.equal(
    classifyTodoReviewIndependence(
      { model: 'gpt-5', harness: 'testfake' },
      { model: 'gpt-5', harness: 'codex' },
    ),
    'same_model_other_harness',
  );
});

runCase('independence: a stored class on the reviewer entry is respected', () => {
  assert.equal(
    classifyTodoReviewIndependence({ independence: 'same_model_other_harness' }, { model: 'gpt-5' }),
    'same_model_other_harness',
  );
});

runCase('independence: round aggregation follows §9.3', () => {
  const implementer = { model: 'gpt-5', harness: 'testfake' };
  const different = { model: 'testfakeb-chat', harness: 'testfake' };
  const otherHarness = { model: 'gpt-5', harness: 'codex' };
  const sameHarness = { model: 'gpt-5', harness: 'testfake' };

  assert.deepEqual(
    summarizeTodoReviewIndependence([different], implementer),
    { independent: true, class: 'different_base_model', reference: 'implementer' },
  );
  // Any same-model-same-harness reviewer downgrades the round.
  assert.equal(
    summarizeTodoReviewIndependence([different, sameHarness], implementer).class,
    'same_model_same_harness',
  );
  assert.equal(
    summarizeTodoReviewIndependence([different, otherHarness], implementer).class,
    'same_model_other_harness',
  );
  // Unknown reviewers keep the round unknown.
  assert.equal(
    summarizeTodoReviewIndependence([{ model: 'auto' }], implementer).class,
    'unknown',
  );
  assert.deepEqual(
    summarizeTodoReviewIndependence([], implementer),
    { independent: false, class: 'unknown', reference: 'none' },
  );
});

runCase('subtree aggregate counts direct children per subject', () => {
  const children = [
    { review: { code: { state: 'passed' }, plan: { state: 'passed' } } },
    { review: { code: { state: 'failed' }, plan: { state: 'none' } } },
    { review: { code: { state: 'unknown' } } },
    {},
  ];
  const aggregate = aggregateTodoReviewStates(children);
  assert.equal(aggregate.source, 'children');
  assert.equal(aggregate.code.passed, 1);
  assert.equal(aggregate.code.failed, 1);
  assert.equal(aggregate.code.unknown, 1);
  assert.equal(aggregate.code.none, 1);
  assert.equal(aggregate.plan.passed, 1);
  assert.equal(aggregate.plan.none, 3);
  assert.equal(aggregate.truncated, false);
});

runCase('subtree aggregate reads truncated from the subject snapshot', () => {
  const fromSubject = aggregateTodoReviewStates([
    { review: { code: { state: 'unknown', truncated: true }, plan: { state: 'none' } } },
  ]);
  assert.equal(fromSubject.truncated, true, 'a truncated code snapshot flags the rollup');
  const fromPlan = aggregateTodoReviewStates([
    { review: { code: { state: 'passed' }, plan: { state: 'unknown', truncated: true } } },
  ]);
  assert.equal(fromPlan.truncated, true, 'a truncated plan snapshot flags the rollup');
  // The container-level `review.truncated` is not part of the persisted shape
  // and must not be read (docs/todo-review-contract.md §5.6, §12.1).
  const containerLevelOnly = aggregateTodoReviewStates([
    { review: { code: { state: 'passed' }, truncated: true } },
  ]);
  assert.equal(containerLevelOnly.truncated, false);
});

runCase('snapshot comparison ignores timestamps and generation', () => {
  const base = {
    generation: 1,
    computedAt: '2024-01-01T00:00:00.000Z',
    code: {
      state: 'passed',
      reviewers: [{ delegationId: 'd1', attemptId: 'a1', verdict: 'PASS', startedAt: '2024-01-01T00:00:00.000Z' }],
    },
  };
  const later = {
    ...base,
    generation: 9,
    computedAt: '2030-01-01T00:00:00.000Z',
    code: {
      ...base.code,
      reviewers: [{ delegationId: 'd1', attemptId: 'a1', verdict: 'PASS', startedAt: '2030-01-01T00:00:00.000Z' }],
    },
  };
  assert.equal(compareTodoReviewSnapshots(base, later), true);
  assert.equal(todoReviewDecisionKey(base), todoReviewDecisionKey(later));

  const changed = { ...later, code: { ...later.code, reviewers: [{ ...later.code.reviewers[0], verdict: 'FAIL' }] } };
  assert.equal(compareTodoReviewSnapshots(base, changed), false);

  const reordered = {
    ...base,
    code: {
      ...base.code,
      reviewers: [
        { delegationId: 'd2', attemptId: 'a2', verdict: 'PASS' },
        { delegationId: 'd1', attemptId: 'a1', verdict: 'PASS' },
      ],
    },
  };
  const reorderedAgain = {
    ...base,
    code: { ...base.code, reviewers: [...reordered.code.reviewers].reverse() },
  };
  assert.equal(compareTodoReviewSnapshots(reordered, reorderedAgain), true);
});

runCase('per-subject comparison and container aggregate are stable', () => {
  assert.equal(
    compareTodoReviewSubjects({ state: 'passed', updatedAt: '2024-01-01T00:00:00.000Z' }, { state: 'passed', updatedAt: '2030-01-01T00:00:00.000Z' }),
    true,
  );
  assert.equal(compareTodoReviewSubjects({ state: 'passed' }, { state: 'failed' }), false);
  assert.equal(compareTodoReviewSubjects(null, null), true);

  const aggregateA = aggregateTodoReviewStates([{ review: { code: { state: 'passed' } } }]);
  const aggregateB = aggregateTodoReviewStates([{ review: { code: { state: 'passed' } } }]);
  assert.equal(
    compareTodoReviewSnapshots({ aggregate: aggregateA }, { aggregate: aggregateB }),
    true,
  );
});

process.exit(failed ? 1 : 0);
