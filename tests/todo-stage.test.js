/**
 * deriveTodoStage: pins rules 1-5 of the todo stage stepper (app_front/features/todo/state/todoStage.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTodoStage, hasApprovedAncestorPlan, isTodoFullyIntegrated } from '../app_front/features/todo/state/todoStage.js';

/** Builds a front item; overrides win. */
function item(over = {}) {
  return {
    status: 'ready',
    plan: { markdown: 'plan', approvedAt: '' },
    review: { plan: { state: 'none' }, code: { state: 'none' } },
    integrationSummary: { state: 'unconfirmed', detail: '' },
    ...over,
  };
}
const step = (it, id) => deriveTodoStage(it).steps.find((s) => s.id === id);

test('step order and shape', () => {
  const stage = deriveTodoStage(item());
  assert.deepEqual(stage.steps.map((s) => s.id), ['planning', 'review', 'implementation', 'integration', 'integrated']);
  for (const s of stage.steps) assert.ok(['done', 'active', 'pending', 'blocked'].includes(s.state));
});

test('rule 1: planning follows plan markdown', () => {
  assert.equal(step(item({ plan: { markdown: '  ' } }), 'planning').state, 'active');
  assert.equal(step(item({ plan: {} }), 'planning').state, 'active');
  assert.equal(step(item(), 'planning').state, 'done');
  assert.equal(deriveTodoStage(item({ plan: { markdown: '' } })).current, 'planning');
});

test('rule 2: every plan review state value', () => {
  const rev = (state, approvedAt = '') => step(item({ plan: { markdown: 'p', approvedAt }, review: { plan: { state } } }), 'review');
  assert.equal(rev('passed').state, 'done');
  assert.equal(rev('manual').state, 'done');
  assert.equal(rev('pending').state, 'active');
  assert.equal(rev('failed').state, 'blocked');
  assert.equal(rev('stale').state, 'blocked');
  assert.equal(rev('none').state, 'pending');
  assert.deepEqual(rev('none', '2026-01-01T00:00:00Z'), { id: 'review', state: 'done', hint: 'skipped' });
  assert.deepEqual(rev('unknown'), { id: 'review', state: 'active', hint: 'verifyMissing' });
  assert.deepEqual(rev('unknown', '2026-01-01T00:00:00Z'), { id: 'review', state: 'active', hint: 'verifyMissing' });
  assert.equal(step(item({ review: undefined }), 'review').state, 'pending');
});

test('rule 3: implementation covers every code review state', () => {
  const approved = { markdown: 'p', approvedAt: '2026-01-01T00:00:00Z' };
  const impl = (over) => step(item(over), 'implementation');
  assert.equal(impl({ status: 'done' }).state, 'done');
  assert.equal(impl({ status: 'done' }).hint, 'notReviewed');
  assert.equal(impl({ status: 'done', review: { code: { state: 'passed' } } }).hint, undefined);
  for (const state of ['failed', 'stale']) {
    const s = impl({ plan: approved, status: 'doing', review: { code: { state } } });
    assert.equal(s.state, 'blocked');
    assert.equal(s.hint, 'changesRequested');
  }
  const pending = impl({ plan: approved, status: 'doing', review: { code: { state: 'pending' } } });
  assert.deepEqual([pending.state, pending.hint], ['active', 'inReview']);
  for (const state of ['none', 'unknown']) {
    assert.equal(impl({ plan: approved, status: 'ready', review: { code: { state } } }).state, 'active', state);
  }
  for (const state of ['passed', 'manual']) {
    assert.deepEqual(impl({ plan: approved, status: 'ready', review: { code: { state } } }), { id: 'implementation', state: 'done', hint: 'notClosed' }, state);
  }
  assert.equal(impl({ plan: approved, status: 'doing' }).state, 'active');
  assert.equal(impl({ plan: approved, status: 'idea' }).state, 'pending');
  assert.equal(impl({ status: 'ready' }).state, 'pending');
});

test('rule 4: integration states and details', () => {
  const integ = (state, detail = '') => step(item({ integrationSummary: { state, detail } }), 'integration');
  assert.equal(integ('unconfirmed').state, 'pending');
  assert.equal(integ('awaiting').state, 'active');
  assert.equal(integ('integrated').state, 'done');
  assert.deepEqual([integ('partial').state, integ('partial').hint], ['active', 'partial']);
  assert.equal(integ('unconfirmed', 'conflict').state, 'blocked');
  assert.equal(integ('rejected', 'rejected').state, 'blocked');
  assert.equal(integ('partial', 'conflict').state, 'blocked');
  assert.equal(integ('unconfirmed', 'no_code_changes').state, 'done');
  assert.equal(integ('unconfirmed', 'no_code_changes').hint, 'noCode');
  const stale = integ('unconfirmed', 'stale_evidence');
  assert.deepEqual([stale.state, stale.hint], ['pending', 'stale_evidence']);
  assert.equal(integ('awaiting', 'proof_invalidated').hint, 'proof_invalidated');
  assert.equal(integ('integrated', 'working_directory_applied').state, 'done');
  assert.equal(integ('awaiting', 'legacy_confirmation').state, 'active');
  assert.equal(step(item({ integrationSummary: undefined }), 'integration').state, 'pending');
});

test('rule 5: integrated needs integration done and status done', () => {
  const integratedSummary = { state: 'integrated', detail: '' };
  assert.equal(step(item({ status: 'done', integrationSummary: integratedSummary }), 'integrated').state, 'done');
  assert.equal(step(item({ status: 'doing', integrationSummary: integratedSummary }), 'integrated').state, 'pending');
  assert.equal(step(item({ status: 'done' }), 'integrated').state, 'pending');
  assert.equal(isTodoFullyIntegrated(item({ status: 'done', integrationSummary: integratedSummary })), true);
});

test('scenario: no-code leaf, conflict leaf, partial container, done-without-review, stale evidence', () => {
  const noCode = item({ status: 'done', integrationSummary: { state: 'unconfirmed', detail: 'no_code_changes' } });
  assert.equal(deriveTodoStage(noCode).steps[3].state, 'done');
  assert.equal(isTodoFullyIntegrated(noCode), true);

  const conflict = item({ status: 'done', integrationSummary: { state: 'awaiting', detail: 'conflict' } });
  const cs = deriveTodoStage(conflict);
  assert.equal(cs.steps[3].state, 'blocked');
  assert.equal(cs.current, 'review');
  assert.equal(cs.steps[4].state, 'pending');

  const container = item({
    status: 'doing',
    integrationSummary: { state: 'partial', detail: '', aggregate: { confirmed: 1, required: 2 } },
  });
  const ps = deriveTodoStage(container);
  assert.equal(ps.steps[3].state, 'active');
  assert.equal(ps.steps[4].state, 'pending');

  const doneNoReview = item({
    status: 'done',
    plan: { markdown: 'p', approvedAt: '2026-01-01T00:00:00Z' },
    integrationSummary: { state: 'integrated', detail: '' },
  });
  const ds = deriveTodoStage(doneNoReview);
  assert.equal(ds.steps[2].hint, 'notReviewed');
  assert.equal(ds.current, 'integrated');
  assert.equal(ds.steps[4].state, 'done');

  const stale = item({ status: 'done', integrationSummary: { state: 'unconfirmed', detail: 'stale_evidence' } });
  const ss = deriveTodoStage(stale);
  assert.equal(ss.steps[3].hint, 'stale_evidence');
  assert.equal(ss.steps[4].state, 'pending');
});

test('current is the first unfinished step; tolerates empty item', () => {
  assert.equal(deriveTodoStage({}).current, 'planning');
  assert.equal(deriveTodoStage(null).steps.length, 5);
});

test('subtask under an approved ancestor plan: planning and review count as inherited', () => {
  const leaf = item({ plan: { markdown: '', approvedAt: '' } });
  const stage = deriveTodoStage(leaf, { planInherited: true });
  assert.deepEqual(stage.steps[0], { id: 'planning', state: 'done', hint: 'inherited' });
  assert.deepEqual(stage.steps[1], { id: 'review', state: 'done', hint: 'inherited' });
  assert.equal(stage.steps[2].state, 'active');
  assert.equal(deriveTodoStage(leaf).current, 'planning');
});

test('code review passed on an open leaf shows implementation done but not closed', () => {
  const leaf = item({ review: { plan: { state: 'none' }, code: { state: 'passed' } } });
  assert.deepEqual(step(leaf, 'implementation'), { id: 'implementation', state: 'done', hint: 'notClosed' });
  const done = item({ status: 'done', review: { plan: { state: 'none' }, code: { state: 'passed' } } });
  assert.deepEqual(step(done, 'implementation'), { id: 'implementation', state: 'done' });
});

test('hasApprovedAncestorPlan walks the parent chain', () => {
  const rootItem = { id: 'r', plan: { approvedAt: '2026-01-01T00:00:00Z' } };
  const mid = { id: 'm', parentId: 'r', plan: {} };
  const leaf = { id: 'l', parentId: 'm' };
  assert.equal(hasApprovedAncestorPlan([rootItem, mid, leaf], leaf), true);
  assert.equal(hasApprovedAncestorPlan([{ ...rootItem, plan: {} }, mid, leaf], leaf), false);
  assert.equal(hasApprovedAncestorPlan([rootItem], rootItem), false);
});

test('implementation hint tells a pair wait apart from a running review', () => {
  const pending = (stateReason) => step(item({ review: { plan: { state: 'none' }, code: { state: 'pending', stateReason } } }), 'implementation');
  assert.equal(pending('pair_reviewer_pending').hint, 'pairPending');
  assert.equal(pending('').hint, 'inReview');
});
