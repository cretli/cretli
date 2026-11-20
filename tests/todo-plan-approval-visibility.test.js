import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldOfferPlanApproval } from '../app_front/features/todo/planApprovalVisibility.js';

const PLAN_MARKDOWN = '# Plan\n\nStep 1';

/**
 * Build a done root item. `plan` fields are merged into the default plan so a
 * case can override `approvedAt` (or `markdown`) without dropping the rest of
 * the plan — overriding the whole `plan` object would make an "approved" case
 * pass only because the markdown disappeared.
 */
const itemWithPlan = (over = {}) => {
  const { plan, ...rest } = over;
  return {
    id: 'root',
    status: 'done',
    ...rest,
    plan: { markdown: PLAN_MARKDOWN, ...(plan || {}) },
  };
};

test('done item with markdown and no approvedAt is offered approval', () => {
  assert.equal(shouldOfferPlanApproval(itemWithPlan()), true);
});

test('an approved plan keeps its markdown and is never offered approval again', () => {
  const pending = itemWithPlan();
  assert.equal(shouldOfferPlanApproval(pending), true);

  const approved = { ...pending, plan: { ...pending.plan, approvedAt: '2024-01-01T00:00:00.000Z' } };
  // The only difference between the two items is approvedAt, so the decision
  // below can only come from that field.
  assert.deepEqual(
    { ...approved, plan: { markdown: approved.plan.markdown } },
    { ...pending, plan: { markdown: pending.plan.markdown } },
    'approval case must keep the same plan markdown',
  );
  assert.ok(approved.plan.markdown.trim().length > 0, 'approved case must keep a non-empty plan');
  assert.equal(shouldOfferPlanApproval(approved), false);

  // The fixture itself must keep the plan markdown when only approvedAt is
  // overridden — otherwise this case could pass because the plan is empty.
  const viaFixture = itemWithPlan({ plan: { approvedAt: '2024-01-01T00:00:00.000Z' } });
  assert.equal(viaFixture.plan.markdown, PLAN_MARKDOWN);
  assert.equal(shouldOfferPlanApproval(viaFixture), false);
});

test('empty or whitespace-only markdown is not approvable', () => {
  assert.equal(shouldOfferPlanApproval(itemWithPlan({ plan: { markdown: '' } })), false);
  assert.equal(shouldOfferPlanApproval(itemWithPlan({ plan: { markdown: '   \n\t ' } })), false);
  assert.equal(shouldOfferPlanApproval({ id: 'x', status: 'done' }), false);
  assert.equal(shouldOfferPlanApproval({ id: 'x', status: 'done', plan: null }), false);
  assert.equal(shouldOfferPlanApproval(null), false);
});

test('status does not change the approval decision', () => {
  for (const status of ['idea', 'ready', 'doing', 'done']) {
    assert.equal(shouldOfferPlanApproval(itemWithPlan({ status })), true, `status ${status} must be approvable`);
    assert.equal(
      shouldOfferPlanApproval(itemWithPlan({ status, plan: { markdown: ' \n ' } })),
      false,
      `status ${status} with an empty plan must not be approvable`,
    );
  }
});

test('shouldOfferPlanApproval does not mutate the item', () => {
  const item = itemWithPlan();
  const snapshot = JSON.parse(JSON.stringify(item));
  shouldOfferPlanApproval(item);
  assert.deepEqual(item, snapshot);
  assert.equal(item.plan.approvedAt, undefined);
});

// The card module registers a custom element at import time (needs a DOM), so
// it is checked as source text under plain `node --test`.
test('cr-todo-card uses the helper and no longer gates approval on status', () => {
  const src = readFileSync(new URL('../app_front/components/ui/cr-todo-card.js', import.meta.url), 'utf8');
  assert.match(src, /shouldOfferPlanApproval/);
  const start = src.indexOf('_renderPlanApprovalBanner(item)');
  assert.ok(start >= 0, 'approval banner method must exist');
  const end = src.indexOf('_renderPlanSection(item)', start);
  assert.ok(end > start, 'plan section method must follow the banner');
  assert.doesNotMatch(src.slice(start, end), /status\s*!==\s*['"]done['"]/);
});
