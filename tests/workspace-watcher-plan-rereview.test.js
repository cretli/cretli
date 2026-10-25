/**
 * Plan re-review: a stale plan review (`plan_edited_after_review`) behind a
 * closed plan gate gets exactly one Watcher-started review round per plan
 * version, and the Watcher never approves the plan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_WATCHER_PLAN_REREVIEW_SUFFIX,
  evaluateWorkspaceWatcherGuardrails,
  evaluateWorkspaceWatcherPlanRereview,
} from '../lib/workspace-watcher-guardrails.js';
import { computeTodoPlanRevisionKey } from '../lib/plan-reviewer-cooperation.js';
import { buildWorkspaceWatcherPlanReviewResolver } from '../lib/workspace-watcher.js';
import { buildWorkspaceWatcherCyclePromptPlan } from '../lib/workspace-watcher-prompt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STALE = () => ({ state: 'stale', stateReason: 'plan_edited_after_review' });

function fixture({ approvedAt = '', plan = '# plan v2', updatedAt = '2026-10-23T10:00:00Z' } = {}) {
  const leaf = { id: 'leaf', parentId: 'root', status: 'ready', title: 'leaf', updatedAt: 'x' };
  const rootTodo = {
    id: 'root', parentId: '', status: 'doing', title: 'root',
    plan: { markdown: plan, updatedAt, ...(approvedAt ? { approvedAt } : {}) },
  };
  return { leaf, rootTodo, items: [rootTodo, leaf] };
}

function guard(over = {}) {
  const f = fixture(over.fixture);
  return {
    f,
    result: evaluateWorkspaceWatcherGuardrails({
      watcher: {
        policy: { requirePlanApproval: true, planApprovalScope: 'root', ...over.policy },
        planRequests: { root: '2026-10-23T11:00:00Z', ...over.planRequests },
      },
      pickedTodo: f.leaf,
      items: f.items,
      now: Date.parse('2026-10-24T12:00:00Z'),
      planReviewResolver: over.resolver === undefined ? STALE : over.resolver,
    }),
  };
}

test('stale plan review behind a closed gate starts one plan-only re-review', () => {
  const { f, result } = guard();
  assert.equal(result.allowed, true);
  assert.equal(result.planOnly, true);
  assert.equal(result.kind, 'plan_gate');
  assert.equal(result.reason, 'plan_rereview');
  assert.equal(result.planTargetId, 'root');
  assert.equal(result.planRereview.holderId, 'root');
  assert.equal(result.planRereview.planKey, computeTodoPlanRevisionKey(f.rootTodo));
  assert.equal(result.planRereview.markerKey, `root${WORKSPACE_WATCHER_PLAN_REREVIEW_SUFFIX}`);
});

test('once per plan version: marker for the current version blocks a second round', () => {
  const key = computeTodoPlanRevisionKey(fixture().rootTodo);
  const { result } = guard({ planRequests: { 'root#plan-review': key } });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'awaiting_plan_approval');
});

test('a new plan edit (new version) allows a new round', () => {
  const oldKey = computeTodoPlanRevisionKey(fixture().rootTodo);
  const { result } = guard({
    planRequests: { 'root#plan-review': oldKey },
    fixture: { plan: '# plan v3', updatedAt: '2026-10-24T09:00:00Z' },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'plan_rereview');
});

test('not triggered when the review is fresh, missing or not edit-stale', () => {
  for (const review of [
    { state: 'passed', stateReason: 'fresh_review' },
    { state: 'none', stateReason: 'no_review' },
    { state: 'stale', stateReason: 'material_changed' },
    null,
  ]) {
    const { result } = guard({ resolver: () => review });
    assert.equal(result.allowed, false, JSON.stringify(review));
    assert.equal(result.reason, 'awaiting_plan_approval');
  }
  assert.equal(guard({ resolver: null }).result.reason, 'awaiting_plan_approval');
});

test('approved plan opens the gate normally and never asks for a re-review', () => {
  const { result } = guard({ fixture: { approvedAt: '2026-10-24T08:00:00Z' } });
  assert.equal(result.kind, 'allowed');
  assert.equal(result.planOnly, false);
  assert.equal(result.planRereview, undefined);
});

test('disabled review phase suppresses the re-review', () => {
  const { result } = guard({ policy: { phases: { review: false } } });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'awaiting_plan_approval');
});

test('without a standing plan request the normal plan gate applies, not a re-review', () => {
  const f = fixture();
  const result = evaluateWorkspaceWatcherGuardrails({
    watcher: { policy: { requirePlanApproval: true, planApprovalScope: 'root' }, planRequests: {} },
    pickedTodo: f.leaf, items: f.items, now: Date.now(), planReviewResolver: STALE,
  });
  assert.equal(result.reason, 'plan_not_approved');
  assert.equal(result.planRereview, undefined);
});

test('pure evaluator reports why it is not due', () => {
  const f = fixture();
  const base = { watcher: { planRequests: {} }, items: f.items, pickedTodo: f.leaf };
  assert.equal(evaluateWorkspaceWatcherPlanRereview({ ...base }).reason, 'no_resolver');
  assert.equal(evaluateWorkspaceWatcherPlanRereview({ ...base, resolvePlanReview: () => null }).reason, 'review_not_stale');
  const noPlan = fixture({ plan: '' });
  assert.equal(evaluateWorkspaceWatcherPlanRereview({
    ...base, items: noPlan.items, pickedTodo: noPlan.leaf, resolvePlanReview: STALE,
  }).reason, 'no_saved_plan');
});

test('the re-review prompt forbids editing the plan and approving it', () => {
  const f = fixture();
  const { result } = guard();
  const plan = buildWorkspaceWatcherCyclePromptPlan({
    workspaceFolder: '/w',
    watcher: { policy: { requirePlanApproval: true } },
    decision: { kind: 'plan_gate', planOnly: true, planTargetId: 'root', planRereview: result.planRereview },
    todo: f.leaf,
  });
  const text = JSON.stringify(plan);
  assert.match(text, /PLAN RE-REVIEW ONLY/);
  assert.match(text, /NEVER set plan\.approvedAt/);
  assert.doesNotMatch(text, /save_plan/);
});

test('no Watcher code path sets plan.approvedAt', () => {
  for (const file of ['lib/workspace-watcher-guardrails.js', 'lib/workspace-watcher-cycle.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /approvedAt\s*[:=]\s*(new Date|Date\.now|at\b|now\b)/, file);
  }
});

test('default resolver reads the real plan-review snapshot (not null from a swallowed error)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-rereview-'));
  try {
    const resolve = buildWorkspaceWatcherPlanReviewResolver({ workspaceFolder: '/w/my-app', dataDir });
    const review = resolve(fixture().rootTodo);
    // No delegation records exist: a working snapshot answers `none`, whereas a
    // missing import (swallowed ReferenceError) used to answer null.
    assert.ok(review, 'resolver must return the plan snapshot');
    assert.equal(review.state, 'none');
    assert.equal(review.subject, 'plan');
    // The resolver output plugs straight into the gate: no review -> no re-review.
    const f = fixture();
    const decision = evaluateWorkspaceWatcherPlanRereview({
      watcher: { planRequests: {} }, items: f.items, pickedTodo: f.leaf, resolvePlanReview: resolve,
    });
    assert.equal(decision.due, false);
    assert.equal(decision.reason, 'review_not_stale');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
