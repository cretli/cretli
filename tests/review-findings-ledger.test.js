import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncCodeReviewWorkflowAfterFinish } from '../lib/delegation-service.js';
import { resetReviewRoundResolutionState } from '../lib/review-round-resolution.js';
import {
  applyRejectedReviewFindings,
  getReviewFindingsLedger,
  getReviewFindingsLedgerDataPath,
  listOpenReviewFindings,
  listSuppressCandidateFindings,
  recordReviewFindings,
} from '../lib/persist/review-findings-ledger-persist.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

resetReviewRoundResolutionState();

/** @returns {string} a report with a findings block and a verdict. */
function report(findings, verdict) {
  const block = `\`\`\`findings-json\n${JSON.stringify({ findings })}\n\`\`\``;
  return `Review notes\n${block}\nTASK: review\nVERDICT: ${verdict}\n`;
}

/** Finish a review through the real server finish hook. */
function finish(parent, leafId, mode, findings, verdict, extra = {}) {
  const row = makeReview({
    parentId: parent.id, leafId, mode, report: report(findings, verdict), verdict, ...extra,
  });
  syncCodeReviewWorkflowAfterFinish(row);
  return row;
}

const byKey = (item) => Object.fromEntries(item.entries.map((entry) => [entry.key, entry]));
const f = (id, status, extra = {}) => ({
  id, status, priority: 'P1', category: 'missing-test', files: ['lib/a.js'], summary: `finding ${id}`, ...extra,
});
const newLeaf = () => crypto.randomUUID();

// Audit FAIL (epoch bump) -> closure FIXED -> fixed; closure NEW shares the cycle; PASS starts a new cycle.
{
  const parent = makeParent('ledger-flow');
  const leafId = newLeaf();
  finish(parent, leafId, 'audit', [f('F1', 'NEW'), f('F2', 'NEW', { priority: 'P2' })], 'FAIL');
  let item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  assert.equal(item.cycle, 1);
  assert.deepEqual(Object.keys(byKey(item)).sort(), ['R1A1-F1', 'R1A1-F2']);
  assert.equal(listOpenReviewFindings(ISOLATED_DATA_DIR, leafId).length, 2);

  finish(parent, leafId, 'closure', [f('F1', 'FIXED'), f('F2', 'STILL_OPEN'), f('F3', 'NEW')], 'FAIL');
  item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  const entries = byKey(item);
  assert.equal(item.cycle, 1, 'closure epoch bumps do not close the cycle');
  assert.equal(entries['R1A1-F1'].outcome, 'fixed');
  assert.equal(entries['R1A1-F2'].outcome, 'open');
  assert.equal(entries['R1C1-F3'].outcome, 'open', 'closure NEW gets a closure key in the same cycle');
  assert.equal(entries['R1C1-F3'].cycle, 1);

  finish(parent, leafId, 'closure', [f('R1A1-F2', 'FIXED'), f('R1C1-F3', 'FIXED')], 'PASS');
  item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  assert.equal(byKey(item)['R1A1-F2'].outcome, 'fixed');
  assert.equal(item.cycle, 2, 'resolved PASS closes the cycle');
  assert.equal(listOpenReviewFindings(ISOLATED_DATA_DIR, leafId).length, 0);

  finish(parent, leafId, 'audit', [f('F1', 'NEW')], 'FAIL');
  item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  assert.ok(byKey(item)['R2A1-F1'], 'the next review starts a new cycle');
  assert.equal(byKey(item)['R1A1-F1'].outcome, 'fixed', 'closed cycle entries are kept');
}

// Two different F1 from a pool audit stay distinct; a bare F1 is ambiguous -> unlinked.
{
  const parent = makeParent('ledger-pool');
  const leafId = newLeaf();
  finish(parent, leafId, 'audit', [f('F1', 'NEW', { summary: 'alpha' })], 'FAIL', { model: 'opencode/a' });
  finish(parent, leafId, 'audit', [f('F1', 'NEW', { summary: 'beta' })], 'FAIL', { model: 'opencode/b' });
  let item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  const entries = byKey(item);
  assert.equal(entries['R1A1-F1'].summary, 'alpha');
  assert.equal(entries['R1A2-F1'].summary, 'beta');
  finish(parent, leafId, 'closure', [f('F1', 'FIXED')], 'FAIL');
  item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  const unlinked = item.entries.filter((entry) => entry.outcome === 'unlinked');
  assert.equal(unlinked.length, 1);
  assert.equal(byKey(item)['R1A1-F1'].outcome, 'open', 'ambiguous raw id does not fix either finding');
  finish(parent, leafId, 'closure', [f('R1A1-F1', 'FIXED')], 'FAIL');
  assert.equal(byKey(getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId))['R1A1-F1'].outcome, 'fixed');
}

// F1: duplicate detection compares the sanitized canonical key, not the raw id.
{
  const leafId = newLeaf();
  const result = recordReviewFindings({
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId,
    delegationId: 'sanitize-1',
    mode: 'audit',
    findings: [
      { id: 'F1 x', status: 'NEW', priority: 'P1', category: 'other', summary: 'spaced' },
      { id: 'F1-x', status: 'NEW', priority: 'P1', category: 'other', summary: 'dashed' },
      { id: 'F1 x', status: 'NEW', priority: 'P1', category: 'other', summary: 'spaced again' },
    ],
  });
  const keys = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId).entries.map((entry) => entry.key);
  assert.deepEqual(result.keys, ['R1A1-F1X', 'R1A1-N1', 'R1A1-N2'], 'colliding sanitized ids get unique keys');
  assert.equal(new Set(keys).size, keys.length, 'no duplicate canonical keys');
}

// Late pool sibling (null workflow patch) is still recorded; retry and replay do not duplicate.
{
  const parent = makeParent('ledger-late');
  const leafId = newLeaf();
  // Phase-less review: no workflow patch, but the ledger still records it.
  const row = finish(parent, leafId, '', [f('F1', 'NEW')], 'FAIL');
  let item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  assert.equal(item.entries.length, 1);
  const seq = item.seq;
  syncCodeReviewWorkflowAfterFinish(row);
  item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  assert.equal(item.entries.length, 1, 'replayed finish is a no-op');
  assert.equal(item.seq, seq);

  updateDelegationRecord(row.id, { report: report([f('F1', 'NEW', { summary: 'retried' })], 'FAIL'), attemptId: 'attempt-2' });
  syncCodeReviewWorkflowAfterFinish({ ...row, report: report([f('F1', 'NEW', { summary: 'retried' })], 'FAIL'), attemptId: 'attempt-2' });
  item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  assert.equal(item.entries.length, 1, 'retry keeps the latest attempt only');
  assert.equal(item.entries[0].summary, 'retried');
}

// closure_rounds_exhausted -> still_open_at_stop.
{
  const previous = process.env.CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES;
  process.env.CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES = '1';
  try {
    const parent = makeParent('ledger-stop');
    const leafId = newLeaf();
    finish(parent, leafId, 'audit', [f('F1', 'NEW')], 'FAIL');
    finish(parent, leafId, 'closure', [f('F1', 'STILL_OPEN')], 'FAIL');
    const item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
    assert.equal(byKey(item)['R1A1-F1'].outcome, 'still_open_at_stop');
    assert.equal(item.cycle, 1);
  } finally {
    if (previous === undefined) delete process.env.CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES;
    else process.env.CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES = previous;
  }
}

// N3: rejecting a FOLLOW_UP finding never makes it a suppress candidate.
{
  const parent = makeParent('ledger-followup-reject');
  const leafId = newLeaf();
  finish(parent, leafId, 'audit', [f('F1', 'FOLLOW_UP', { priority: 'P3' })], 'PASS');
  const result = applyRejectedReviewFindings({
    workspaceFolder: ISOLATED_DATA_DIR, leafId, rejected: [{ key: 'R1A1-F1', reason: 'wont_fix' }],
  });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.notRejectable, ['R1A1-F1']);
  const entry = byKey(getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId))['R1A1-F1'];
  assert.equal(entry.outcome, 'follow_up');
  assert.equal(entry.rejection, null);
  assert.equal(listSuppressCandidateFindings(ISOLATED_DATA_DIR, leafId).length, 0);
}

// N2: generated fallback keys never collide with existing keys.
{
  const parent = makeParent('ledger-key-collision');
  const leafId = newLeaf();
  // Raw ids that equal fallback spellings, an id sanitizing to empty, and duplicates.
  finish(parent, leafId, 'audit', [
    f('N1', 'NEW'), f('', 'NEW'), f('!!!', 'NEW'), f('F1', 'NEW'), f('F1', 'NEW'),
  ], 'FAIL');
  const item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  const keys = item.entries.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, `keys unique: ${keys.join(',')}`);
  assert.equal(keys.length, 5);
}

// Rejected (orchestrator) and OUT_OF_SCOPE / FOLLOW_UP outcomes; write -> reload.
{
  const parent = makeParent('ledger-reject');
  const leafId = newLeaf();
  finish(parent, leafId, 'audit', [
    f('F1', 'NEW'), f('F2', 'OUT_OF_SCOPE'), f('F3', 'FOLLOW_UP', { priority: 'P3' }),
  ], 'FAIL');
  const result = applyRejectedReviewFindings({
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId,
    rejected: [
      { key: 'R1A1-F1', reason: 'false_positive', note: 'covered elsewhere' },
      { key: 'R9A9-F1', reason: 'wont_fix' },
      // F2: an explicit rejection attempt on an OUT_OF_SCOPE finding is ignored.
      { key: 'R1A1-F2', reason: 'wont_fix', note: 'must not apply' },
    ],
    actor: 'orchestrator',
  });
  assert.deepEqual(result, { applied: ['R1A1-F1'], unknown: ['R9A9-F1'], notRejectable: ['R1A1-F2'] });
  const item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId);
  const entries = byKey(item);
  assert.equal(entries['R1A1-F1'].outcome, 'rejected');
  assert.equal(entries['R1A1-F1'].rejection.actor, 'orchestrator');
  assert.equal(entries['R1A1-F1'].rejection.reason, 'false_positive');
  assert.equal(entries['R1A1-F2'].outcome, 'out_of_scope', 'OUT_OF_SCOPE is never rejected');
  assert.equal(entries['R1A1-F2'].rejection, null, 'no rejection stored on an out-of-scope finding');
  assert.equal(entries['R1A1-F3'].outcome, 'follow_up');
  assert.deepEqual(
    listSuppressCandidateFindings(ISOLATED_DATA_DIR, leafId).map((entry) => entry.key),
    ['R1A1-F1'],
    'only rejected findings feed suppress candidates; OUT_OF_SCOPE never does',
  );
  assert.equal(listOpenReviewFindings(ISOLATED_DATA_DIR, leafId).length, 0);
  const onDisk = JSON.parse(fs.readFileSync(getReviewFindingsLedgerDataPath(), 'utf8'));
  const stored = onDisk.items.find((row) => row.leafId === leafId);
  assert.deepEqual(stored, item, 'reloaded ledger equals the written one');
}

// Direct recorder: replay of the same attempt is a no-op.
{
  const input = {
    workspaceFolder: ISOLATED_DATA_DIR, leafId: newLeaf(), delegationId: 'd-1', attemptId: 'a-1',
    mode: 'audit', findings: [f('F1', 'NEW')],
  };
  assert.equal(recordReviewFindings(input).recorded, true);
  assert.equal(recordReviewFindings(input).recorded, false);
}

// FU-E(2): findings are scrubbed at write time, not only on the read route.
{
  const leafId = newLeaf();
  const result = recordReviewFindings({
    workspaceFolder: ISOLATED_DATA_DIR,
    leafId,
    delegationId: 'privacy-write-scrub',
    mode: 'audit',
    findings: [f('F1', 'NEW', {
      files: ['/home/alice/proj/lib/a.js', 'lib/b.js', 'C:\\Users\\Jan Kowalski\\proj\\lib\\c.js'],
      summary: 'Token leaked in `/home/alice/proj/lib/a.js`',
    })],
  });
  assert.equal(result.recorded, true);
  const entry = byKey(getReviewFindingsLedger(ISOLATED_DATA_DIR, leafId))[result.keys[0]];
  assert.deepEqual(entry.files, ['lib/a.js', 'lib/b.js', 'lib/c.js'], 'private file heads are scrubbed before storing');
  assert.equal(entry.summary, 'Token leaked in `lib/a.js`', 'summary is scrubbed before storing');
  assert.ok(!/alice|Jan|Kowalski/.test(JSON.stringify(entry)), 'no name survives in the stored entry');
}

// Delegation record round-trip: reviewFindings survives create + patch + reload.
{
  const parent = makeParent('roundtrip');
  const summary = {
    source: 'json', total: 2, byPriority: { P1: 1, P2: 1 }, byCategory: { correctness: 2 },
    byStatus: { NEW: 2 }, confidence: 'high', parsedAt: '2026-01-01T00:00:00.000Z',
  };
  const row = makeReview({ parentId: parent.id, leafId: newLeaf(), verdict: 'PASS', reviewFindings: summary });
  assert.deepEqual(getDelegationById(row.id).reviewFindings, summary, 'create stores reviewFindings');
  const patched = { ...summary, total: 3, byPriority: { P1: 3 }, parsedAt: '2026-02-02T00:00:00.000Z' };
  updateDelegationRecord(row.id, { reviewFindings: patched });
  const reloaded = getDelegationById(row.id);
  assert.deepEqual(reloaded.reviewFindings, patched, 'patch replaces reviewFindings');
}

console.log('review-findings-ledger tests passed');
