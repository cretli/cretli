/**
 * Reviewer pair gate: an unsatisfiable fixed pair is detected at review start,
 * the repeat of an already-started identity is refused, and the operator
 * journal carries a deduplicated alert that a satisfiable pair clears.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import { evaluateReviewerPairSatisfiability } from '../lib/reviewer-policy.js';
import { evaluateReviewerPairStartGate } from '../lib/delegation-code-review-phase.js';
import { evaluatePairGateAtStart } from '../lib/delegation-service.js';
import { readLatestOperatorEventsByLeaf } from '../lib/persist/operator-journal-persist.js';

const A = { harness: 'opencode', model: 'opencode/a' };
const B = { harness: 'opencode', model: 'opencode/b' };
const C = { harness: 'opencode', model: 'opencode/c' };
const low = { harness: 'opencode', model: 'opencode/a::low' };
const medium = { harness: 'opencode', model: 'opencode/a::medium' };

// Pure function.
{
  const same = evaluateReviewerPairSatisfiability({ members: [low, medium], hardExcluded: [], candidates: [] });
  assert.equal(same.satisfiable, false);
  assert.equal(same.distinct, 1);
  assert.equal(same.missing[0].reason, 'same_identity');
  assert.equal(same.missing[0].model, 'opencode/a::medium');
  const sameWithOther = evaluateReviewerPairSatisfiability({ members: [low, medium], hardExcluded: [], candidates: [C] });
  assert.equal(sameWithOther.satisfiable, true, 'an eligible stand-in of another identity satisfies it');
  const implementer = evaluateReviewerPairSatisfiability({ members: [A, B], hardExcluded: [{ harness: 'opencode', model: 'opencode/b' }], candidates: [] });
  assert.deepEqual([implementer.satisfiable, implementer.distinct, implementer.missing[0].reason], [false, 1, 'excluded']);
  const orchestrator = evaluateReviewerPairSatisfiability({ members: [A, B], hardExcluded: [{ model: 'opencode/a' }], candidates: [A] });
  assert.equal(orchestrator.satisfiable, false, 'an excluded identity is not a stand-in either');
  const unstartable = evaluateReviewerPairSatisfiability({ members: [A, { ...B, startable: false }], hardExcluded: [], candidates: [] });
  assert.deepEqual([unstartable.satisfiable, unstartable.missing[0].reason], [false, 'unstartable']);
  assert.equal(evaluateReviewerPairSatisfiability({ members: [A, B] }).satisfiable, true);
  const plusOne = evaluateReviewerPairSatisfiability({ members: [A, { ...B, startable: false }], candidates: [C] });
  assert.equal(plusOne.satisfiable, true);
}

// Start gate: first reviewer starts, the repeat of its identity is refused.
{
  const base = { members: [low, medium], hardExcluded: [], isStartable: () => true, candidatesFor: () => [] };
  const open = (reviewerId) => ({ codeReviewClosureEpoch: 0, round: 1, materialRevision: 'm1',
    codeReviewPoolRound: { key: '1:m1', epoch: 0, mode: 'closure', pool: true, started: ['d1'], results: {}, reviewers: { d1: reviewerId }, memberships: {}, superseded: [], resolved: '', degradedReason: '' } });
  const first = evaluateReviewerPairStartGate({ ...base, workflow: { round: 1, materialRevision: 'm1' }, reviewer: { transport: 'opencode', model: 'opencode/a::low' } });
  assert.equal(first.satisfiable, false);
  assert.equal(first.refuse, false);
  assert.equal(first.missing, 'opencode/opencode/a::medium');
  const repeat = evaluateReviewerPairStartGate({ ...base, workflow: open('opencode/opencode/a'), reviewer: { transport: 'opencode', model: 'opencode/a::medium' } });
  assert.equal(repeat.refuse, true, 'same canonical identity already started in the open round');
  const other = evaluateReviewerPairStartGate({ ...base, members: [A, B], workflow: open('opencode/opencode/a'), reviewer: { transport: 'opencode', model: 'opencode/a' } });
  assert.deepEqual([other.satisfiable, other.refuse], [true, false]);
}

// Journal alert: once per leaf + round, cleared by a satisfiable event.
{
  const folder = ISOLATED_DATA_DIR;
  const input = (members) => ({ cwd: folder, dataDir: ISOLATED_DATA_DIR, controllerChatId: 'no-such-chat', workflow: null, leafId: 'leaf-1', delegations: [], members, reviewer: { transport: 'opencode', model: members[0].model } });
  const kinds = ['reviewer_pair_unsatisfiable', 'reviewer_pair_satisfiable'];
  assert.equal(evaluatePairGateAtStart(input([low, medium])).satisfiable, false);
  evaluatePairGateAtStart(input([low, medium]));
  let latest = readLatestOperatorEventsByLeaf(folder, kinds, { dataDir: ISOLATED_DATA_DIR }).get('leaf-1');
  assert.equal(latest.kind, 'reviewer_pair_unsatisfiable');
  assert.match(latest.summary, /leaf leaf-1, round .*, missing opencode\/opencode\/a::medium/);
  const firstAt = latest.createdAt;
  evaluatePairGateAtStart(input([low, medium]));
  latest = readLatestOperatorEventsByLeaf(folder, kinds, { dataDir: ISOLATED_DATA_DIR }).get('leaf-1');
  assert.equal(latest.createdAt, firstAt, 'same leaf + round writes no second event');
  assert.equal(evaluatePairGateAtStart(input([A, B])).satisfiable, true);
  latest = readLatestOperatorEventsByLeaf(folder, kinds, { dataDir: ISOLATED_DATA_DIR }).get('leaf-1');
  assert.equal(latest.kind, 'reviewer_pair_satisfiable', 'a satisfiable pair clears the alert');
  evaluatePairGateAtStart(input([A, B]));
  assert.equal(readLatestOperatorEventsByLeaf(folder, kinds, { dataDir: ISOLATED_DATA_DIR }).get('leaf-1').createdAt, latest.createdAt, 'clear is written once');
}

console.log('reviewer-pair-unsatisfiable: ok');
