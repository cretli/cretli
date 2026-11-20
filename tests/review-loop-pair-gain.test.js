import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildReviewLoopStats } from '../lib/review-loop-stats.js';
import {
  applyRejectedReviewFindings,
  recordReviewFindings,
  listReviewFindingsLedgerItems,
} from '../lib/persist/review-findings-ledger-persist.js';
import { loadDelegationsReadonly } from '../lib/persist/delegations-persist.js';
import { upsertDelegationWorkflow } from '../lib/persist/delegation-workflows-persist.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { resetReviewRoundResolutionState } from '../lib/review-round-resolution.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

resetReviewRoundResolutionState();

let n = 0;
const fnd = (id, files, extra = {}) => ({
  id, status: 'NEW', priority: 'P1', category: 'other', files, summary: `finding ${id}`, ...extra,
});

/**
 * One two-reviewer round whose findings go through the real ledger writer.
 * Reviewers use per-scenario model ids so every scenario owns one pair row.
 */
function scenario({ a = [], b = [], fixed = ['A:F1'], reject = [], onlyOneMember = false, ghost = false }) {
  n += 1;
  const parent = makeParent(`pair-${n}`);
  const leafId = crypto.randomUUID();
  const ra = makeReview({ parentId: parent.id, leafId, verdict: 'FAIL', model: `pair-a-${n}` });
  const rb = onlyOneMember ? null : makeReview({ parentId: parent.id, leafId, verdict: 'FAIL', model: `pair-b-${n}` });
  const base = { workspaceFolder: ISOLATED_DATA_DIR, leafId, mode: 'audit' };
  recordReviewFindings({ ...base, delegationId: ra.id, findings: a });
  if (rb) recordReviewFindings({ ...base, delegationId: rb.id, findings: b });
  if (ghost) recordReviewFindings({ ...base, delegationId: crypto.randomUUID(), findings: [fnd('G1', ['lib/g.js:1'])] });
  // Closure marks FIXED on the canonical keys (A is audit 1, B audit 2).
  const keyOf = (ref) => { const [who, id] = ref.split(':'); return `R1A${who === 'A' ? 1 : 2}-${id}`; };
  recordReviewFindings({
    ...base, mode: 'closure', delegationId: crypto.randomUUID(),
    findings: fixed.map((ref) => ({ id: keyOf(ref), status: 'FIXED' })),
  });
  if (reject.length) {
    applyRejectedReviewFindings({ workspaceFolder: ISOLATED_DATA_DIR, leafId, rejected: reject.map((ref) => ({ key: keyOf(ref), reason: 'false_positive' })) });
  }
  const workflow = {
    parentChatId: parent.id, leafId, workspaceFolder: ISOLATED_DATA_DIR,
    codeReviewPoolRound: {
      key: `pool-${n}`, epoch: 1, mode: 'audit', started: [ra.id, ...(rb ? [rb.id] : [])], results: {}, resolved: 'FAIL',
    },
  };
  upsertDelegationWorkflow(workflow);
  return { pairKey: `opencode/pair-a-${n} | opencode/pair-b-${n}`, ra, rb, leafId, workflow };
}

function statsFor(...scenarios) {
  const stats = buildReviewLoopStats({
    delegations: loadDelegationsReadonly(),
    workflows: scenarios.map((s) => s.workflow),
    reviewFindingsLedger: listReviewFindingsLedgerItems(ISOLATED_DATA_DIR),
    ratings: [],
    now: Date.now() + 60_000,
  });
  return stats.workspaces.find((w) => w.workspaceFolder === ISOLATED_DATA_DIR).windows['30d'].pairGain;
}
const pairOf = (gain, s) => gain.pairs.find((p) => p.pair === s.pairKey);
const memberA = (pair, s) => pair.members[`opencode/pair-a-${s.pairKey.match(/pair-a-(\d+)/)[1]}`];

// (a) same file, lines 10 and 12 -> shared
{
  const s = scenario({ a: [fnd('F1', ['lib/x.js:10'])], b: [fnd('F1', ['lib/x.js:12'])] });
  const p = pairOf(statsFor(s), s);
  assert.equal(memberA(p, s).shared, 1);
  assert.equal(memberA(p, s).unique, 0);
  assert.equal(p.pairAddedLowRounds, 0);
  assert.equal(p.pairAddedHighRounds, 0);
}

// (b) same category and file, lines 10 and 80 -> unique, pairAddedLow
{
  const s = scenario({
    a: [fnd('F1', ['lib/x.js:10'], { category: 'correctness' })],
    b: [fnd('F1', ['lib/x.js:80'], { category: 'correctness' })],
    fixed: ['A:F1', 'B:F1'],
  });
  const p = pairOf(statsFor(s), s);
  assert.equal(memberA(p, s).unique, 1);
  assert.equal(p.pairAddedLowRounds, 1);
  assert.equal(p.pairAddedLow, 1);
  assert.equal(p.rounds, 1);
}

// (c) same file and category, no lines -> ambiguous, only pairAddedHigh
{
  const s = scenario({
    a: [fnd('F1', ['lib/x.js'], { category: 'correctness' })],
    b: [fnd('F1', ['lib/x.js'], { category: 'correctness' })],
  });
  const p = pairOf(statsFor(s), s);
  assert.equal(memberA(p, s).ambiguous, 1);
  assert.equal(p.pairAddedLowRounds, 0);
  assert.equal(p.pairAddedHighRounds, 1);
}

// v5: same file without lines, different categories -> still ambiguous, low does not rise
{
  const s = scenario({
    a: [fnd('F1', ['lib/x.js'], { category: 'error-handling' })],
    b: [fnd('F1', ['lib/x.js'], { category: 'other' })],
  });
  const p = pairOf(statsFor(s), s);
  assert.equal(memberA(p, s).ambiguous, 1);
  assert.equal(p.pairAddedLowRounds, 0);
  assert.equal(p.pairAddedHighRounds, 1);
}

// (d) same local id F1, different files -> unique (keys never decide identity)
{
  const s = scenario({ a: [fnd('F1', ['lib/a.js:3'])], b: [fnd('F1', ['lib/b.js:3'])] });
  const p = pairOf(statsFor(s), s);
  assert.equal(memberA(p, s).unique, 1);
  assert.equal(p.pairAddedLowRounds, 1);
}

// (e) a rejected finding is not counted as confirmed
{
  const s = scenario({
    a: [fnd('F1', ['lib/a.js:3']), fnd('F2', ['lib/c.js:9'])],
    b: [fnd('F1', ['lib/b.js:3'])],
    fixed: ['A:F1', 'A:F2'],
    reject: ['A:F2'],
  });
  const p = pairOf(statsFor(s), s);
  assert.equal(memberA(p, s).confirmed, 1);
  assert.equal(memberA(p, s).unique, 1);
}

// (f) no files, or files empty after the privacy scrub -> unmatchable
{
  const s1 = scenario({ a: [fnd('F1', [])], b: [fnd('F1', ['lib/b.js:3'])] });
  const s2 = scenario({ a: [fnd('F1', ['/etc/secret/passwd'])], b: [fnd('F1', ['lib/b.js:3'])] });
  const gain = statsFor(s1, s2);
  for (const s of [s1, s2]) {
    const p = pairOf(gain, s);
    assert.equal(memberA(p, s).unmatchable, 1);
    assert.equal(memberA(p, s).unique, 0);
    assert.equal(p.pairAddedHighRounds, 0);
  }
}

// Ratings and duration feed the per-pair summary.
{
  const s = scenario({ a: [fnd('F1', ['lib/a.js:3'])], b: [fnd('F1', ['lib/b.js:3'])] });
  const stats = buildReviewLoopStats({
    delegations: loadDelegationsReadonly(),
    workflows: [s.workflow],
    reviewFindingsLedger: listReviewFindingsLedgerItems(ISOLATED_DATA_DIR),
    ratings: [{ delegationId: s.ra.id, score: 4 }, { delegationId: s.rb.id, score: 2 }],
    now: Date.now() + 60_000,
  });
  const p = pairOf(stats.workspaces[0].windows['30d'].pairGain, s);
  assert.equal(p.avgRating, 3);
  assert.equal(typeof memberA(p, s).medianDurationMs, 'number');
}

// F1: partner finding without usable files is missing data -> ambiguous, not unique
{
  const s1 = scenario({ a: [fnd('F1', ['lib/x.js:10'])], b: [fnd('F1', [])] });
  const s2 = scenario({ a: [fnd('F1', ['lib/x.js:10'])], b: [fnd('F1', ['/etc/secret/passwd'])] });
  const gain = statsFor(s1, s2);
  for (const s of [s1, s2]) {
    const p = pairOf(gain, s);
    assert.equal(memberA(p, s).ambiguous, 1);
    assert.equal(memberA(p, s).unique, 0);
    assert.equal(p.pairAddedLowRounds, 0);
    assert.equal(p.pairAddedHighRounds, 1);
  }
}

// F2: a FIXED status inside an audit report does not confirm; a closure FIXED does
{
  const s = scenario({
    a: [fnd('F1', ['lib/a.js:3'], { status: 'FIXED' })],
    b: [fnd('F1', ['lib/b.js:3'])],
    fixed: [],
  });
  const p = pairOf(statsFor(s), s);
  assert.equal(memberA(p, s).confirmed, 0);
  assert.equal(p.pairAddedLowRounds, 0);
  const s2 = scenario({
    a: [fnd('F1', ['lib/a.js:3'], { status: 'FIXED' })],
    b: [fnd('F1', ['lib/b.js:3'])],
  });
  const p2 = pairOf(statsFor(s2), s2);
  assert.equal(memberA(p2, s2).confirmed, 1);
  assert.equal(p2.pairAddedLowRounds, 1);
}

// (g) a round with one member is skipped
{
  const s = scenario({ a: [fnd('F1', ['lib/a.js:3'])], onlyOneMember: true });
  assert.equal(pairOf(statsFor(s), s), undefined);
}

// (h) ledger entries whose delegation has no record are counted, not guessed
{
  const s = scenario({ a: [fnd('F1', ['lib/a.js:3'])], b: [fnd('F1', ['lib/b.js:3'])], ghost: true });
  const gain = statsFor(s);
  assert.ok(gain.missingDelegation >= 1);
  assert.ok(pairOf(gain, s), 'the pair itself is still reported');
}

// Real route path: the ledger and ratings reach buildReviewLoopStats.
{
  const routes = new Map();
  registerDelegationsRoutes({
    get: (p, fn) => routes.set(`GET ${p}`, fn),
    post: (p, fn) => routes.set(`POST ${p}`, fn),
  }, { workspaceDirForAgent: () => ISOLATED_DATA_DIR });
  const s = scenario({ a: [fnd('F1', ['lib/a.js:3'])], b: [fnd('F1', ['lib/b.js:3'])] });
  let body;
  await routes.get('GET /api/review-loop-stats')(
    { params: {}, query: { workspaceFolder: ISOLATED_DATA_DIR }, body: {}, headers: {} },
    { status() { return this; }, json(payload) { body = payload; return this; } },
  );
  assert.equal(body.ok, true);
  const gain = body.workspaces[0].windows['30d'].pairGain;
  const p = pairOf(gain, s);
  assert.ok(p, 'route output carries the pair built from the persisted ledger');
  assert.equal(memberA(p, s).unique, 1);
}

console.log('review-loop-pair-gain tests passed');
