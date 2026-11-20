import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { runReviewFindingsBackfill } from '../scripts/backfill-review-findings.js';
import { getReviewFindingsLedger, getReviewFindingsLedgerDataPath, recordReviewFindings } from '../lib/persist/review-findings-ledger-persist.js';
import { distillReviewLessons } from '../lib/review-lessons-distill.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

const report = (findings, verdict) => `Notes\n\`\`\`findings-json\n${JSON.stringify({ findings })}\n\`\`\`\nVERDICT: ${verdict}\n`;
const fixedFindings = (n) => Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}`, status: 'FIXED', priority: 'P2', category: 'test-weak', files: ['lib/persist/a.js'], summary: `s${i}` }));
const parent = makeParent('backfill');
const leaves = [crypto.randomUUID(), crypto.randomUUID()];
const rows = [
  makeReview({ parentId: parent.id, leafId: leaves[0], verdict: 'PASS', report: report(fixedFindings(3), 'PASS') }),
  makeReview({ parentId: parent.id, leafId: leaves[1], verdict: 'PASS', report: report(fixedFindings(3), 'PASS') }),
  makeReview({ parentId: parent.id, leafId: crypto.randomUUID(), verdict: 'PASS', report: 'Looks fine.\nVERDICT: PASS\n' }),
];
const ledgerFile = getReviewFindingsLedgerDataPath();
const snapshot = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '');

// Dry run reports the work and writes nothing.
const before = snapshot();
const dry = runReviewFindingsBackfill({ workspaceFolder: ISOLATED_DATA_DIR });
assert.equal(dry.apply, false);
assert.equal(dry.recorded, 2);
assert.equal(dry.findings, 6);
assert.equal(snapshot(), before);
assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, leaves[0]), null);

// A live-recorded delegation is never rewritten by the backfill.
recordReviewFindings({ workspaceFolder: ISOLATED_DATA_DIR, leafId: leaves[1], delegationId: rows[1].id, attemptId: rows[1].attemptId, mode: rows[1].reviewMode, findings: fixedFindings(1) });

// Apply: backfilled entries are low confidence and flagged.
const applied = runReviewFindingsBackfill({ workspaceFolder: ISOLATED_DATA_DIR, apply: true });
assert.equal(applied.recorded, 1);
const item = getReviewFindingsLedger(ISOLATED_DATA_DIR, leaves[0]);
assert.equal(item.entries.length, 3);
assert.ok(item.entries.every((entry) => entry.source === 'backfill' && entry.confidence === 'low' && entry.outcome === 'fixed'));
assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, leaves[1]).entries.length, 1, 'live record untouched');
assert.equal(getReviewFindingsLedger(ISOLATED_DATA_DIR, leaves[1]).entries[0].source, 'live');

// Idempotent: a second real run adds nothing.
const afterFirst = snapshot();
const second = runReviewFindingsBackfill({ workspaceFolder: ISOLATED_DATA_DIR, apply: true });
assert.equal(second.recorded, 0);
assert.equal(snapshot(), afterFirst);

// Backfill-only evidence needs the double count: 3 backfilled + 1 live is below the bar.
assert.equal(distillReviewLessons(ISOLATED_DATA_DIR, { dryRun: true }).candidates.length, 0);
console.log('review-findings-backfill tests passed');
