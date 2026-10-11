/**
 * Tests for lib/todo-review-read.js — compact list summary, full detail block
 * with the container aggregate, the review list filter and the
 * delegation-report link state (docs/todo-review-contract.md §10.6, §11.3, §12).
 */
import assert from 'node:assert/strict';
import {
  attachTodoReviewReadModels,
  buildTodoReviewReadModel,
  parseTodoReviewFilter,
  resolveTodoReviewReportLinkState,
  summarizeTodoReviewForList,
  todoReviewMatchesFilter,
} from '../lib/todo-review-read.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

/**
 * @param {object} snapshot
 * @returns {object}
 */
function leafWithCode(snapshot) {
  return {
    id: 'leaf-1',
    parentId: 'root-1',
    review: { schemaVersion: 1, generation: 3, code: snapshot },
  };
}

runCase('list summary: a leaf without a snapshot is none, never unknown', () => {
  const summary = summarizeTodoReviewForList({ id: 'leaf-1', parentId: 'root-1' });
  assert.deepEqual(summary, {
    review_state: 'none',
    review_plan_state: 'none',
    review_reviewer: null,
    review_independence: 'unknown',
  });
});

runCase('list summary: a container reports empty review fields', () => {
  const summary = summarizeTodoReviewForList({ id: 'root-1', review: { code: { state: 'passed' } } }, { isContainer: true });
  assert.deepEqual(summary, {
    review_state: '',
    review_plan_state: '',
    review_reviewer: null,
    review_independence: '',
  });
});

runCase('list summary: fan-out reports the first reviewer plus the count', () => {
  const summary = summarizeTodoReviewForList(leafWithCode({
    state: 'passed',
    reviewerCount: 2,
    independence: { class: 'same_model_other_harness', independent: true },
    reviewers: [
      { delegationId: 'd1', attemptId: 'a1', harness: 'deepseek', model: 'flash' },
      { delegationId: 'd2', attemptId: 'a2', harness: 'claude', model: 'sonnet' },
    ],
  }));
  assert.equal(summary.review_state, 'passed');
  assert.deepEqual(summary.review_reviewer, { harness: 'deepseek', model: 'flash', count: 2 });
  assert.equal(summary.review_independence, 'same_model_other_harness');
});

runCase('list filter parses a bare state as the code subject', () => {
  assert.deepEqual(parseTodoReviewFilter('passed'), { ok: true, subject: 'code', state: 'passed' });
  assert.deepEqual(parseTodoReviewFilter('plan:none'), { ok: true, subject: 'plan', state: 'none' });
  assert.deepEqual(parseTodoReviewFilter(''), { ok: true, subject: 'code', state: '' });
  assert.equal(parseTodoReviewFilter('banana').ok, false);
  assert.equal(parseTodoReviewFilter('body:passed').ok, false);
});

runCase('list filter matches leaves only, by the requested subject', () => {
  const item = leafWithCode({ state: 'passed' });
  assert.equal(todoReviewMatchesFilter(item, false, { subject: 'code', state: 'passed' }), true);
  assert.equal(todoReviewMatchesFilter(item, false, { subject: 'code', state: 'failed' }), false);
  assert.equal(todoReviewMatchesFilter(item, true, { subject: 'code', state: 'passed' }), false);
  assert.equal(todoReviewMatchesFilter(item, false, {}), true);
});

runCase('detail read model always exposes code and plan, other only when stored', () => {
  const missing = buildTodoReviewReadModel({ id: 'leaf-1' });
  assert.equal(missing.code.state, 'none');
  assert.equal(missing.code.subjectSource, 'default');
  assert.equal(missing.plan.state, 'none');
  assert.equal(Object.prototype.hasOwnProperty.call(missing, 'other'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(missing, 'aggregate'), false);

  const withOther = buildTodoReviewReadModel({
    id: 'leaf-1',
    review: { code: { state: 'passed' }, other: { state: 'unknown' } },
  });
  assert.equal(withOther.code.state, 'passed');
  assert.equal(withOther.other.state, 'unknown');
});

runCase('detail read model derives the container aggregate from direct children', () => {
  const root = { id: 'root-1' };
  const childPassed = { id: 'leaf-1', parentId: 'root-1', review: { code: { state: 'passed' } } };
  const childNone = { id: 'leaf-2', parentId: 'root-1' };
  const model = buildTodoReviewReadModel(root, { children: [childPassed, childNone] });
  assert.equal(model.aggregate.source, 'children');
  assert.equal(model.aggregate.code.passed, 1);
  assert.equal(model.aggregate.code.none, 1);
  assert.equal(model.aggregate.plan.none, 2);
  assert.equal(model.aggregate.truncated, false);
  assert.equal(Object.prototype.hasOwnProperty.call(model.aggregate, 'reviewers'), false);
});

runCase('attach read models marks containers and adds fields without dropping stored keys', () => {
  const root = { id: 'root-1', title: 'Root' };
  const leaf = { id: 'leaf-1', parentId: 'root-1', title: 'Leaf', review: { code: { state: 'passed' } } };
  const [rootOut, leafOut] = attachTodoReviewReadModels([root, leaf]);
  assert.equal(rootOut.review_state, '');
  assert.equal(rootOut.aggregate, undefined, 'parent gets its rollup only on its own review block');
  assert.equal(rootOut.review.aggregate.code.passed, 1);
  assert.equal(leafOut.review_state, 'passed');
  assert.equal(leafOut.title, 'Leaf');
  assert.equal(leafOut.review.code.state, 'passed');
});

runCase('report link state names the retention and deletion cases', () => {
  assert.equal(resolveTodoReviewReportLinkState(), 'delegation_missing');
  assert.equal(resolveTodoReviewReportLinkState({ delegationExists: false }), 'delegation_missing');
  assert.equal(resolveTodoReviewReportLinkState({ delegation: { report: 'ok' } }), 'available');
  assert.equal(resolveTodoReviewReportLinkState({ delegation: { report: '' } }), 'report_missing');
  assert.equal(resolveTodoReviewReportLinkState({ delegation: { report: 'ok' }, chatExists: false }), 'chat_deleted');
  const trimmed = { report: 'x'.repeat(2000), archivedAt: '2026-01-01T00:00:00.000Z' };
  assert.equal(resolveTodoReviewReportLinkState({ delegation: trimmed }), 'report_trimmed');
  assert.equal(
    resolveTodoReviewReportLinkState({ delegation: { report: 'short', archivedAt: '2026-01-01T00:00:00.000Z' } }),
    'available',
  );
});

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('todo-review-read: all passed');
