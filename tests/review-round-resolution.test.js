import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyDelegationWorkflowPatch, applyParentWorkflowUpdate, getDelegationWorkflow } from '../lib/delegation-workflow.js';
import { syncCodeReviewWorkflowAfterFinish } from '../lib/delegation-service.js';
import {
  resetReviewRoundResolutionState,
  resolveReviewRounds,
  subscribeReviewRoundResolved,
} from '../lib/review-round-resolution.js';
import { listDelegationsForController } from '../lib/persist/delegations-persist.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

/** @type {{ leaf: object, round: object }[]} */
let fired = [];
resetReviewRoundResolutionState();
subscribeReviewRoundResolved((leaf, round) => fired.push({ leaf, round }));
const reset = () => { fired = []; };
const newLeaf = () => crypto.randomUUID();
const poolRecord = (ids, overrides = {}) => ({
  key: '0::0', epoch: 0, mode: 'audit', pool: true, started: ids, results: {}, superseded: [], resolved: '',
  ...overrides,
});
const seedPool = (parent, leafId, ids, overrides = {}) => applyDelegationWorkflowPatch({
  parentChatId: parent.id,
  leafId,
  workspaceFolder: parent.workspace,
  codeReviewPoolRound: poolRecord(ids, overrides),
  idempotencyKey: `seed-${crypto.randomUUID()}`,
  countReview: false,
});
const parentPass = (parent, leafId) => applyParentWorkflowUpdate({
  parentChatId: parent.id,
  leafId,
  workspaceFolder: parent.workspace,
  lastVerdict: 'PASS',
  idempotencyKey: `pass-${crypto.randomUUID()}`,
});

// Single reviewer: FAIL then PASS = 2 rounds, one notification each.
{
  const parent = makeParent();
  const leafId = newLeaf();
  const r1 = makeReview({ parentId: parent.id, leafId, verdict: 'FAIL', mode: 'audit' });
  syncCodeReviewWorkflowAfterFinish(r1);
  const r2 = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', mode: 'closure' });
  syncCodeReviewWorkflowAfterFinish(r2);
  assert.deepEqual(fired.map((f) => f.round.verdict), ['FAIL', 'PASS']);
  const { rounds } = resolveReviewRounds({
    delegations: listDelegationsForController(parent.id),
    leafId,
    workflow: getDelegationWorkflow(parent.id, leafId),
  });
  assert.deepEqual(rounds.map((r) => r.verdict), ['FAIL', 'PASS']);
  reset();
}

// Pool PASS -> FAIL resolves FAIL; a late sibling is ignored.
{
  const parent = makeParent();
  const leafId = newLeaf();
  const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
  const b = makeReview({ parentId: parent.id, leafId, verdict: 'FAIL' });
  const c = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
  seedPool(parent, leafId, [a.id, b.id, c.id]);
  syncCodeReviewWorkflowAfterFinish(a);
  assert.equal(fired.length, 0, 'lone PASS stays pending');
  syncCodeReviewWorkflowAfterFinish(b);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].round.verdict, 'FAIL');
  syncCodeReviewWorkflowAfterFinish(c);
  assert.equal(fired.length, 1, 'late sibling ignored');
  reset();
}

// Pool two PASS resolves PASS once.
{
  const parent = makeParent();
  const leafId = newLeaf();
  const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-a' });
  const b = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-b' });
  seedPool(parent, leafId, [a.id, b.id]);
  syncCodeReviewWorkflowAfterFinish(a);
  assert.equal(fired.length, 0);
  syncCodeReviewWorkflowAfterFinish(b);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].round.verdict, 'PASS');
  assert.equal(fired[0].round.source, 'pool');
  // Parent PASS afterwards sees the same latest credible review: no second fire.
  parentPass(parent, leafId);
  assert.equal(fired.length, 1);
  reset();
}

// Lone pool PASS pending, resolved by parent PASS; late second member does not fire.
{
  const parent = makeParent();
  const leafId = newLeaf();
  const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-a' });
  const b = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-b' });
  seedPool(parent, leafId, [a.id, b.id]);
  syncCodeReviewWorkflowAfterFinish(a);
  assert.equal(fired.length, 0);
  assert.equal(
    resolveReviewRounds({
      delegations: listDelegationsForController(parent.id).filter((r) => r.id === a.id),
      leafId,
      workflow: getDelegationWorkflow(parent.id, leafId),
    }).pending?.memberIds.length,
    1,
  );
  parentPass(parent, leafId);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].round.source, 'parent');
  assert.equal(fired[0].round.verdict, 'PASS');
  syncCodeReviewWorkflowAfterFinish(b);
  assert.equal(fired.length, 1, 'late member after parent PASS does not fire again');
  // The parent-closed round is archived as PASS so stats still count it.
  const closed = getDelegationWorkflow(parent.id, leafId);
  assert.equal(closed.codeReviewPoolRound, null);
  assert.equal(closed.codeReviewPoolHistory.length, 1);
  assert.equal(closed.codeReviewPoolHistory[0].resolved, 'PASS');
  assert.deepEqual(
    resolveReviewRounds({
      delegations: listDelegationsForController(parent.id), leafId, workflow: closed,
    }).rounds.map((r) => r.verdict),
    ['PASS'],
  );
  reset();
}

// Infra-failed review is not a round.
{
  const parent = makeParent();
  const leafId = newLeaf();
  const failed = makeReview({ parentId: parent.id, leafId, status: 'failed', report: '' });
  syncCodeReviewWorkflowAfterFinish(failed);
  assert.equal(fired.length, 0);
  assert.equal(resolveReviewRounds({
    delegations: listDelegationsForController(parent.id), leafId, workflow: null,
  }).rounds.length, 0);
  parentPass(parent, leafId);
  assert.equal(fired.length, 0, 'no credible review on the leaf');
  reset();
}

// Single reviewer finish + parent PASS: exactly once.
{
  const parent = makeParent();
  const leafId = newLeaf();
  syncCodeReviewWorkflowAfterFinish(makeReview({ parentId: parent.id, leafId, verdict: 'PASS' }));
  parentPass(parent, leafId);
  assert.equal(fired.length, 1);
  reset();
}

// Parent PASS whose latest credible review is a plan review does not fire.
{
  const parent = makeParent();
  const leafId = newLeaf();
  syncCodeReviewWorkflowAfterFinish(makeReview({ parentId: parent.id, leafId, verdict: 'PASS' }));
  reset();
  makeReview({ parentId: parent.id, leafId, verdict: 'PASS', subject: 'plan', mode: '', planKey: 'rev-1', finishedAt: new Date(Date.now() + 5000).toISOString() });
  parentPass(parent, leafId);
  assert.equal(fired.length, 0);
}

// Feature flag off: a single-reviewer PASS and a parent PASS each resolve once.
{
  const prior = process.env.CRETLI_DELEGATION_CODE_REVIEW_PHASE;
  process.env.CRETLI_DELEGATION_CODE_REVIEW_PHASE = '0';
  try {
    const parent = makeParent();
    const leafA = newLeaf();
    syncCodeReviewWorkflowAfterFinish(makeReview({ parentId: parent.id, leafId: leafA, verdict: 'PASS', mode: '' }));
    assert.equal(fired.length, 1);
    const leafB = newLeaf();
    makeReview({ parentId: parent.id, leafId: leafB, verdict: 'PASS', mode: '' });
    parentPass(parent, leafB);
    assert.equal(fired.length, 2);
    parentPass(parent, leafB);
    assert.equal(fired.length, 2, 'replayed-by-identity parent PASS does not fire twice');
  } finally {
    if (prior === undefined) delete process.env.CRETLI_DELEGATION_CODE_REVIEW_PHASE;
    else process.env.CRETLI_DELEGATION_CODE_REVIEW_PHASE = prior;
  }
  reset();
}

// Two real pool rounds (FAIL then PASS) stay separate after the parent PASS
// cleared the live record into the durable history.
{
  const parent = makeParent();
  const leafId = newLeaf();
  const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-a' });
  const b = makeReview({ parentId: parent.id, leafId, verdict: 'FAIL', model: 'rev-b' });
  seedPool(parent, leafId, [a.id, b.id]);
  syncCodeReviewWorkflowAfterFinish(a);
  syncCodeReviewWorkflowAfterFinish(b);
  assert.deepEqual(fired.map((f) => f.round.verdict), ['FAIL'], 'round 1 resolves FAIL');

  const afterRound1 = getDelegationWorkflow(parent.id, leafId);
  const c = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-a' });
  const d = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', model: 'rev-b' });
  seedPool(parent, leafId, [c.id, d.id], {
    key: '0::0',
    epoch: afterRound1.codeReviewClosureEpoch,
    mode: 'closure',
  });
  syncCodeReviewWorkflowAfterFinish(c);
  syncCodeReviewWorkflowAfterFinish(d);
  assert.deepEqual(fired.map((f) => f.round.verdict), ['FAIL', 'PASS'], 'round 2 resolves PASS');

  parentPass(parent, leafId);
  const cleared = getDelegationWorkflow(parent.id, leafId);
  assert.equal(cleared.codeReviewPoolRound, null, 'parent PASS clears the live record');
  assert.equal(cleared.codeReviewPoolHistory.length, 2, 'both rounds are archived');
  assert.deepEqual(fired.map((f) => f.round.verdict), ['FAIL', 'PASS'], 'live notifications unchanged');

  const { rounds, pending } = resolveReviewRounds({
    delegations: listDelegationsForController(parent.id),
    leafId,
    workflow: cleared,
  });
  assert.deepEqual(rounds.map((r) => r.verdict), ['FAIL', 'PASS'], 'two separate rounds after the clear');
  assert.ok(rounds.every((r) => r.source === 'pool'));
  assert.equal(pending, null);
  reset();
}

console.log('review-round-resolution tests passed');
