import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  filterTodoItemsByReviewState,
  parseReviewListFilter,
  resolveAcceptErrorKey,
  resolveAggregateReviewBadge,
  resolveIndependenceMarkerKey,
  resolveReviewBadge,
  resolveReviewerReportLinkState,
  shouldShowLeafReviewBadge,
} from '../app_front/features/todo/todoReviewBadge.js';

const componentSource = fs.readFileSync(
  new URL('../app_front/components/ui/cr-todo-review-badge.js', import.meta.url),
  'utf8',
);
const appScss = fs.readFileSync(new URL('../app_front/css/app.scss', import.meta.url), 'utf8');

const reviewer = (over = {}) => ({
  delegationId: 'd1', harness: 'codex', model: 'gpt-x', verdict: 'PASS', ...over,
});
const review = (code, plan) => ({ code, plan });

test('passed code review shows reviewer, success tone and no marker for a different model', () => {
  const badge = resolveReviewBadge(review({
    state: 'passed',
    reviewers: [reviewer()],
    reviewerCount: 1,
    implementer: { model: 'other' },
    independence: { class: 'different_base_model', independent: true },
  }), 'code');
  assert.equal(badge.state, 'passed');
  assert.equal(badge.tone, 'success');
  assert.equal(badge.labelKey, 'todo.reviewBadge.code.passedSingle');
  assert.equal(badge.labelParams.reviewer, 'codex/gpt-x');
  assert.equal(badge.noImplementer, false);
  assert.equal(resolveIndependenceMarkerKey(badge.independenceClass), null);
});

test('failed, pending, stale, manual and unknown map to distinct tones and keys', () => {
  const tones = {};
  for (const state of ['failed', 'pending', 'stale', 'manual', 'unknown', 'none']) {
    const badge = resolveReviewBadge(review({ state, reviewers: [reviewer()] }), 'code');
    tones[state] = badge.tone;
    assert.equal(badge.state, state);
  }
  assert.deepEqual(tones, {
    failed: 'error', pending: 'info', stale: 'warn', manual: 'success', unknown: 'warn', none: 'muted',
  });
  assert.equal(resolveReviewBadge(review({ state: 'manual' }), 'code').labelKey, 'todo.reviewBadge.code.manual');
  assert.equal(resolveReviewBadge(review({ state: 'manual' }), 'code').iconName, 'mdi-account-check');
});

test('plan review is a separate subject and never a code badge', () => {
  const r = review({ state: 'none' }, { state: 'passed', reviewers: [reviewer()], reviewerCount: 1 });
  const code = resolveReviewBadge(r, 'code');
  const plan = resolveReviewBadge(r, 'plan');
  assert.equal(code.state, 'none');
  assert.equal(plan.state, 'passed');
  assert.equal(plan.labelKey, 'todo.reviewBadge.plan.passedSingle');
  assert.notEqual(code.labelKey, plan.labelKey);
});

test('unknown state strings and a missing review fall back to none', () => {
  assert.equal(resolveReviewBadge(null, 'code').state, 'none');
  assert.equal(resolveReviewBadge(review({ state: 'weird' }), 'code').state, 'none');
});

test('fan-out shows the model count and keeps the full list for details', () => {
  const badge = resolveReviewBadge(review({
    state: 'passed',
    reviewers: [reviewer(), reviewer({ delegationId: 'd2', model: 'm2' })],
    reviewerCount: 2,
    implementer: { model: 'x' },
  }), 'code');
  assert.equal(badge.labelKey, 'todo.reviewBadge.code.passedFanout');
  assert.equal(badge.labelParams.count, '2');
  assert.equal(badge.reviewerCount, 2);
});

test('independence markers cover both same-model classes and the no-implementer case', () => {
  assert.equal(
    resolveIndependenceMarkerKey('same_model_other_harness'),
    'todo.reviewIndependence.sameModelOtherHarness',
  );
  assert.equal(
    resolveIndependenceMarkerKey('same_model_same_harness'),
    'todo.reviewIndependence.sameModelSameHarness',
  );
  const noImpl = resolveReviewBadge(review({ state: 'passed', reviewers: [reviewer()] }), 'code');
  assert.equal(noImpl.noImplementer, true, 'a PASS without an implementer must be marked');
});

test('report link state never guesses available', () => {
  assert.equal(resolveReviewerReportLinkState({}), 'unavailable');
  assert.equal(resolveReviewerReportLinkState({ reportLinkState: 'report_trimmed' }), 'report_trimmed');
  assert.equal(resolveReviewerReportLinkState({ reportLinkState: 'chat_deleted' }), 'chat_deleted');
  assert.equal(resolveReviewerReportLinkState({ reportLinkState: 'bogus' }), 'unavailable');
});

test('a done leaf always shows a badge, an unreviewed ready leaf stays quiet', () => {
  assert.equal(shouldShowLeafReviewBadge({ status: 'done' }), true);
  assert.equal(shouldShowLeafReviewBadge({ status: 'ready' }), false);
  assert.equal(shouldShowLeafReviewBadge({ status: 'doing', review: review({ state: 'pending' }) }), true);
  assert.equal(shouldShowLeafReviewBadge({ status: 'ready', review: review({ state: 'none' }, { state: 'stale' }) }), true);
});

test('three done todos (other-model PASS / human accept / none) are visually distinct', () => {
  const pass = resolveReviewBadge(review({
    state: 'passed', reviewers: [reviewer()], implementer: { model: 'y' },
    independence: { class: 'different_base_model', independent: true },
  }), 'code');
  const manual = resolveReviewBadge(review({ state: 'manual' }), 'code');
  const none = resolveReviewBadge(review({ state: 'none' }), 'code');
  // `passed` and `manual` intentionally share the success tone; they must differ
  // in icon AND label, and the manual tint is a CSS rule on `data-state`.
  assert.equal(pass.tone, manual.tone);
  assert.notEqual(pass.iconName, manual.iconName);
  assert.notEqual(pass.labelKey, manual.labelKey);
  assert.notEqual(manual.iconName, none.iconName);
  assert.notEqual(manual.labelKey, none.labelKey);
  assert.notEqual(pass.tone, none.tone);
  assert.notEqual(pass.iconName, none.iconName);
  assert.match(componentSource, /\.badge\[data-state='manual'\]/);
});

test('report link state: a click-resolved state wins, trimmed/deleted/missing are reachable', () => {
  const row = { delegationId: 'd9' };
  assert.equal(resolveReviewerReportLinkState(row, {}), 'unavailable');
  assert.equal(resolveReviewerReportLinkState(row, { d9: 'report_trimmed' }), 'report_trimmed');
  assert.equal(resolveReviewerReportLinkState(row, { d9: 'chat_deleted' }), 'chat_deleted');
  assert.equal(resolveReviewerReportLinkState(row, { d9: 'delegation_missing' }), 'delegation_missing');
  assert.equal(resolveReviewerReportLinkState(row, { d9: 'bogus' }), 'unavailable');
  assert.equal(resolveReviewerReportLinkState(row, { other: 'chat_deleted' }), 'unavailable');
});

test('component follows the cr-* rules: Shadow DOM, static styles, MDI via slots', () => {
  assert.doesNotMatch(componentSource, /createRenderRoot/);
  assert.match(componentSource, /static styles = css`/);
  assert.match(componentSource, /::slotted\(\.mdi\)/);
  assert.match(componentSource, /<slot name=/);
  assert.doesNotMatch(componentSource, /<span class="mdi/);
  assert.doesNotMatch(componentSource, /#[0-9a-fA-F]{3,6}\b/, 'tokens only, no hex');
  assert.match(componentSource, /@media \(max-width: 640px\)/, 'compact is CSS, not a JS snapshot');
  assert.doesNotMatch(appScss, /\.cr-review-badge|\.cr-review-independence|\.cr-review-reviewer/);
  assert.match(appScss, /\.todo-row-review \{/, 'row host box is preserved');
});

test('plan badge title never borrows the code independence marker', () => {
  assert.match(componentSource, /if \(badge\.subject === 'code'\) \{\s*const marker/);
});

test('Polish fan-out copy has no count-dependent plural form', () => {
  const pl = fs.readFileSync(new URL('../app_front/i18n/pl.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pl, /\{count\} modele/);
});

test('aggregate rolls up direct children and never claims a single PASS', () => {
  const agg = resolveAggregateReviewBadge({
    aggregate: {
      code: { passed: 3, manual: 1, none: 1, failed: 0, stale: 0, pending: 0, unknown: 0 },
      plan: {},
    },
  });
  assert.equal(agg.total, 5);
  assert.equal(agg.reviewed, 4);
  assert.equal(agg.tone, 'muted', 'one unreviewed child keeps the rollup from turning green');
  const failed = resolveAggregateReviewBadge({ aggregate: { code: { passed: 1, failed: 1 } } });
  assert.equal(failed.tone, 'error');
  const all = resolveAggregateReviewBadge({ aggregate: { code: { passed: 2 } } });
  assert.equal(all.tone, 'success');
  assert.equal(resolveAggregateReviewBadge({}), null);
  assert.equal(resolveAggregateReviewBadge({ aggregate: { code: {} } }), null);
});

test('review list filters keep matching leaves and their ancestors', () => {
  const items = [
    { id: 'root' },
    { id: 'a', parentId: 'root', review: review({ state: 'passed' }) },
    { id: 'b', parentId: 'root', review: review({ state: 'none' }) },
    { id: 'c', parentId: 'root', review: review({ state: 'passed' }, { state: 'stale' }) },
  ];
  assert.deepEqual(filterTodoItemsByReviewState(items, 'none').map((i) => i.id), ['root', 'b']);
  assert.deepEqual(filterTodoItemsByReviewState(items, 'stale').map((i) => i.id), ['root', 'c']);
  assert.equal(filterTodoItemsByReviewState(items, '').length, 4);
  assert.equal(parseReviewListFilter('bogus'), '');
  assert.equal(parseReviewListFilter('stale'), 'stale');
});

test('accept rejection codes map to explanatory keys', () => {
  assert.equal(resolveAcceptErrorKey({ code: 'ack_attempt_mismatch' }), 'chat.delegationAcceptStaleAttempt');
  assert.equal(resolveAcceptErrorKey({ code: 'ack_material_mismatch' }), 'chat.delegationAcceptStaleMaterial');
  assert.equal(resolveAcceptErrorKey({ code: 'ack_todo_revision_mismatch' }), 'chat.delegationAcceptStaleTodo');
  assert.equal(resolveAcceptErrorKey({ code: 'accept_expectation_required' }), 'chat.delegationAcceptContextMissing');
  assert.equal(resolveAcceptErrorKey({}), 'chat.delegationAcceptFailed');
});

// --- accept wiring (no jsdom in this suite: asserted from sources + transport) --

test('accept sends the context pinned when the card appeared, unchanged', async () => {
  const richView = fs.readFileSync(new URL('../app_front/lib/sdk-rich-view.js', import.meta.url), 'utf8');
  const chat = fs.readFileSync(new URL('../app_front/chat.js', import.meta.url), 'utf8');
  assert.match(richView, /card\.dataset\.acceptTodoRevision = String\(ctx\.todoRevision/);
  assert.match(richView, /hooks\.onAcceptDelegation\?\.\(delegationId, pinned\)/);
  assert.match(richView, /delegationAcceptContextFailed/, 'a failed context load is visible');
  assert.match(richView, /delegationAcceptConfirm/, 'confirmation copy is used');
  assert.match(chat, /todoRevision: String\(payload\?\.todoRevision \?\? ''\)/);
  const { postDelegationAccept } = await import('../app_front/api.js');
  const previous = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), body: JSON.parse(init.body || '{}') });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await postDelegationAccept('job-1', { attemptId: 'a', materialRevision: '', todoRevision: 'r1' });
  } finally {
    globalThis.fetch = previous;
  }
  assert.equal(seen[0].body.todoRevision, 'r1');
  assert.equal(seen[0].body.materialRevision, '', 'an empty captured revision is sent, not dropped');
});
