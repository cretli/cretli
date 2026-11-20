import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyDelegationWorkflowPatch, applyParentWorkflowUpdate } from '../lib/delegation-workflow.js';
import { syncCodeReviewWorkflowAfterFinish } from '../lib/delegation-service.js';
import { recordReviewFindings } from '../lib/persist/review-findings-ledger-persist.js';
import { getReviewLessonsDataPath } from '../lib/persist/review-lessons-persist.js';
import { drainLessonDistillation } from '../lib/review-lessons-distill.js';
import { listLessons } from '../lib/review-lessons-service.js';
import { resetReviewRoundResolutionState } from '../lib/review-round-resolution.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

resetReviewRoundResolutionState();
const poolRecord = (ids) => ({ key: '0::0', epoch: 0, mode: 'audit', pool: true, started: ids, results: {}, superseded: [], resolved: '' });
const seedPool = (parent, leafId, ids) => applyDelegationWorkflowPatch({
  parentChatId: parent.id, leafId, workspaceFolder: parent.workspace, codeReviewPoolRound: poolRecord(ids), idempotencyKey: `seed-${crypto.randomUUID()}`, countReview: false,
});
const parentPass = (parent, leafId) => applyParentWorkflowUpdate({
  parentChatId: parent.id, leafId, workspaceFolder: parent.workspace, lastVerdict: 'PASS', idempotencyKey: `pass-${crypto.randomUUID()}`,
});
const finish = async (row) => { syncCodeReviewWorkflowAfterFinish(row); await drainLessonDistillation(); };
// Replaying a finish after the round resolved may hit the workflow layer's own idempotency
// conflict (pre-existing, unrelated); the distillation hook runs before that and must stay a no-op.
const replay = async (row) => {
  try { syncCodeReviewWorkflowAfterFinish(row); } catch { /* workflow-layer replay conflict */ }
  await drainLessonDistillation();
};
/** Seed two distinct leaves whose fixed findings of one category pass the distillation threshold. */
function seedRecurring(category) {
  for (const count of [2, 1]) {
    recordReviewFindings({
      workspaceFolder: ISOLATED_DATA_DIR, leafId: crypto.randomUUID(), delegationId: crypto.randomUUID(), attemptId: 'a', mode: 'audit',
      findings: Array.from({ length: count }, (_, i) => ({ id: `F${i + 1}`, status: 'FIXED', priority: 'P2', category, files: [`lib/${category}/x.js`], summary: `s${i}` })),
    });
  }
}
const lessonsOf = (category) => listLessons(ISOLATED_DATA_DIR).filter((row) => row.category === category);

// Pool PASS -> FAIL resolves FAIL: no distillation.
{
  seedRecurring('perf');
  const parent = makeParent();
  const leafId = crypto.randomUUID();
  const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
  const b = makeReview({ parentId: parent.id, leafId, verdict: 'FAIL' });
  seedPool(parent, leafId, [a.id, b.id]);
  await finish(a);
  await finish(b);
  assert.equal(lessonsOf('perf').length, 0);
}
// Two pool PASS trigger once; a later parent PASS and replays add nothing.
{
  seedRecurring('i18n');
  const parent = makeParent();
  const leafId = crypto.randomUUID();
  const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-a' });
  const b = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-b' });
  seedPool(parent, leafId, [a.id, b.id]);
  await finish(a);
  assert.equal(lessonsOf('i18n').length, 0, 'lone PASS is pending');
  await finish(b);
  assert.equal(lessonsOf('i18n').length, 1);
  parentPass(parent, leafId);
  await replay(b);
  await replay(a);
  assert.equal(lessonsOf('i18n').length, 1);
  // Even with the in-memory round memory lost (restart), a replayed finish creates no duplicate.
  resetReviewRoundResolutionState();
  await replay(b);
  assert.equal(lessonsOf('i18n').length, 1);
}
// A lone PASS resolved through applyParentWorkflowUpdate triggers once.
{
  seedRecurring('scope-creep');
  const parent = makeParent();
  const leafId = crypto.randomUUID();
  const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
  const b = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
  seedPool(parent, leafId, [a.id, b.id]);
  await finish(a);
  assert.equal(lessonsOf('scope-creep').length, 0);
  parentPass(parent, leafId);
  await drainLessonDistillation();
  assert.equal(lessonsOf('scope-creep').length, 1);
  parentPass(parent, leafId);
  await replay(b);
  assert.equal(lessonsOf('scope-creep').length, 1);
}
// Distillation errors never throw out of the finish hooks; they are logged.
{
  seedRecurring('error-handling');
  fs.mkdirSync(path.dirname(getReviewLessonsDataPath(ISOLATED_DATA_DIR)), { recursive: true });
  fs.writeFileSync(getReviewLessonsDataPath(ISOLATED_DATA_DIR), '{ not json');
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const parent = makeParent();
    const leafId = crypto.randomUUID();
    const single = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
    assert.doesNotThrow(() => syncCodeReviewWorkflowAfterFinish(single));
    assert.doesNotThrow(() => parentPass(parent, leafId));
    await drainLessonDistillation();
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((line) => line.includes('distillation failed')), 'failure is logged');
}
console.log('review-lessons-distill-trigger tests passed');
