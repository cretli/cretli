import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { inspectReviewRecheckWithoutChange } from '../lib/delegation-review-recheck-gate.js';
import { computeTodoPlanContentKey, computeTodoPlanRevisionKey } from '../lib/plan-reviewer-cooperation.js';

const executor = { transport: 'opencode', model: 'rev-a' };

/**
 * @param {string} parentChatId
 * @param {string} leafId
 * @param {object} patch
 * @param {string} [reviewSubject]
 */
function seedReview(parentChatId, leafId, patch = {}, reviewSubject = 'code') {
  const row = createDelegationRecord({
    parentChatId,
    childChatId: `child-${crypto.randomUUID()}`,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor,
    assignment: 'review',
    status: 'completed',
    leafId,
    reviewSubject,
    todoPlanRevisionKey: patch.todoPlanRevisionKey,
    todoPlanContentKey: patch.todoPlanContentKey,
    reviewedMaterialRevision: patch.reviewedMaterialRevision,
  });
  const { todoPlanRevisionKey, todoPlanContentKey, reviewedMaterialRevision, ...updatable } = patch;
  updateDelegationRecord(row.id, {
    reportVerdict: 'FAIL',
    queuedAt: new Date(Date.now() - 60000).toISOString(),
    ...updatable,
  });
  return row;
}

function ids() {
  return { parentChatId: `parent-${crypto.randomUUID()}`, leafId: crypto.randomUUID() };
}

test('N1: a reviewer-timeout row is not a usable prior review; a normal interrupted verdict row still is', () => {
  const { parentChatId, leafId } = ids();
  const timedOut = seedReview(parentChatId, leafId, {
    status: 'interrupted', interruptCode: 'run_deadline_exceeded', cancelCause: 'run_deadline_exceeded',
  });
  const base = { parentChatId, assignment: 'review', reviewSubject: 'code', leafId, executor };
  assert.equal(inspectReviewRecheckWithoutChange(base).ok, true, 'same reviewer after a timeout needs no allow_recheck');
  updateDelegationRecord(timedOut.id, { status: 'completed', interruptCode: '', cancelCause: '' });
  assert.equal(inspectReviewRecheckWithoutChange(base).ok, false, 'a completed verdict row blocks');
});

test('N2: a changed live material revision re-admits a recheck without any implement/fix row', () => {
  const { parentChatId, leafId } = ids();
  seedReview(parentChatId, leafId, { reviewedMaterialRevision: 'rev-1' });
  const base = { parentChatId, assignment: 'review', reviewSubject: 'code', leafId, executor };
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, materialRevision: 'rev-1' }).ok, false);
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, materialRevision: 'rev-2' }).ok, true);
  // Legacy fallback: no stored revision or no live revision -> row-based rule (still blocked).
  assert.equal(inspectReviewRecheckWithoutChange({ ...base, materialRevision: '' }).ok, false);
  const legacy = ids();
  seedReview(legacy.parentChatId, legacy.leafId);
  assert.equal(inspectReviewRecheckWithoutChange({
    ...base, ...legacy, materialRevision: 'rev-9',
  }).ok, false);
});

test('plan gate compares content only: unchanged markdown with a new updatedAt stays refused', () => {
  const { parentChatId, leafId } = ids();
  const v1 = { plan: { markdown: '# Plan\n\nstep one', updatedAt: '2026-10-01T10:00:00.000Z' } };
  const approvedNoEdit = { plan: { markdown: '# Plan\n\nstep one', updatedAt: '2026-10-02T10:00:00.000Z' } };
  const edited = { plan: { markdown: '# Plan\n\nstep one\nstep two', updatedAt: '2026-10-03T10:00:00.000Z' } };
  assert.notEqual(computeTodoPlanRevisionKey(v1), computeTodoPlanRevisionKey(approvedNoEdit));
  assert.equal(computeTodoPlanContentKey(v1), computeTodoPlanContentKey(approvedNoEdit));
  seedReview(parentChatId, leafId, {
    todoPlanRevisionKey: computeTodoPlanRevisionKey(v1),
    todoPlanContentKey: computeTodoPlanContentKey(v1),
  }, 'plan');
  const gate = (todo) => inspectReviewRecheckWithoutChange({
    parentChatId, assignment: 'review', reviewSubject: 'plan', leafId, executor,
    todoPlanRevisionKey: computeTodoPlanRevisionKey(todo),
    todoPlanContentKey: computeTodoPlanContentKey(todo),
  });
  assert.equal(gate(approvedNoEdit).ok, false);
  assert.equal(gate(edited).ok, true);
});

test('plan gate falls back to the legacy revision key for rows without a content key', () => {
  const { parentChatId, leafId } = ids();
  const todo = { plan: { markdown: 'x', updatedAt: '2026-10-01T10:00:00.000Z' } };
  seedReview(parentChatId, leafId, { todoPlanRevisionKey: computeTodoPlanRevisionKey(todo) }, 'plan');
  const input = {
    parentChatId, assignment: 'review', reviewSubject: 'plan', leafId, executor,
    todoPlanRevisionKey: computeTodoPlanRevisionKey(todo),
    todoPlanContentKey: computeTodoPlanContentKey(todo),
  };
  assert.equal(inspectReviewRecheckWithoutChange(input).ok, false);
});

test('subject other is intentionally uncovered and never blocked', () => {
  const { parentChatId, leafId } = ids();
  seedReview(parentChatId, leafId, {}, 'other');
  assert.equal(inspectReviewRecheckWithoutChange({
    parentChatId, assignment: 'review', reviewSubject: 'other', leafId, executor,
  }).ok, true);
});
