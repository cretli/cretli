import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncCodeReviewWorkflowAfterFinish } from '../lib/delegation-service.js';
import { applyRejectedReviewFindings } from '../lib/persist/review-findings-ledger-persist.js';
import { addLesson, listLessons, updateLesson } from '../lib/review-lessons-service.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

const ws = ISOLATED_DATA_DIR;
const base = { audience: 'reviewer', kind: 'suppress', text: 'Do not flag the intentional sync read in boot.', category: 'other' };

/** Record an audit with two findings (P2, P1) and reject both with the given reasons. */
function seedLedger(reasons) {
  const leafId = crypto.randomUUID();
  const parent = makeParent('lessons-service');
  const findings = [
    { id: 'F1', status: 'NEW', priority: 'P2', category: 'other', files: ['lib/a.js'], summary: 'one' },
    { id: 'F2', status: 'NEW', priority: 'P1', category: 'other', files: ['lib/b.js'], summary: 'two' },
  ];
  const report = `\`\`\`findings-json\n${JSON.stringify({ findings })}\n\`\`\`\nTASK: review\nVERDICT: FAIL\n`;
  syncCodeReviewWorkflowAfterFinish(makeReview({ parentId: parent.id, leafId, mode: 'audit', report, verdict: 'FAIL' }));
  applyRejectedReviewFindings({
    workspaceFolder: ws, leafId, actor: 'orchestrator',
    rejected: [{ key: 'R1A1-F1', reason: reasons[0] }, { key: 'R1A1-F2', reason: reasons[1] }],
  });
  return leafId;
}
const ev = (leafId, key) => [{ ledgerKey: key, leafId, outcome: 'rejected', actor: 'orchestrator' }];

// Validation errors.
assert.throws(() => addLesson(ws, { ...base, kind: 'do', category: 'not-a-category' }), { code: 'VALIDATION' });
assert.throws(() => addLesson(ws, { ...base, kind: 'do', text: 'Read /home/someone/x first.' }), { code: 'VALIDATION' });
assert.throws(() => addLesson(ws, { ...base, kind: 'do', text: 'Call http://192.168.1.5/api.' }), { code: 'VALIDATION' });
assert.throws(() => addLesson(ws, { ...base, kind: 'do', audience: 'nobody' }), { code: 'VALIDATION' });

// Suppress guards.
assert.throws(() => addLesson(ws, { ...base, category: 'security', evidence: [] }), /security/);
assert.throws(() => addLesson(ws, { ...base, evidence: [] }), /false_positive/);
const leafId = seedLedger(['false_positive', 'false_positive']);
assert.throws(() => addLesson(ws, { ...base, evidence: ev(leafId, 'R1A1-F2') }), /P1/, 'P1 evidence is refused');
const wontFixLeaf = seedLedger(['wont_fix', 'wont_fix']);
assert.throws(() => addLesson(ws, { ...base, evidence: ev(wontFixLeaf, 'R1A1-F1') }), /false_positive/, 'non-false_positive reason is refused');
assert.throws(() => addLesson(ws, { ...base, evidence: ev(leafId, 'R1A1-NOPE') }), { code: 'VALIDATION' });
const suppress = addLesson(ws, { ...base, evidence: ev(leafId, 'R1A1-F1') });
assert.equal(suppress.status, 'candidate');

// Default candidate; active only with the explicit flag.
const doLesson = { audience: 'implementer', kind: 'do', text: 'Run the touched suites before reporting.', category: 'missing-test' };
assert.equal(addLesson(ws, { ...doLesson, status: 'active' }).status, 'candidate');
const flagOnly = addLesson(ws, { ...doLesson, text: 'Run lint on touched files.', activate: true });
assert.equal(flagOnly.status, 'active', 'activate:true alone activates');
assert.equal('activate' in flagOnly, false, 'transport-only flag is not persisted');
const active = addLesson(ws, { ...doLesson, text: 'Update every caller of a changed signature.', status: 'active', activate: true });
assert.equal(active.status, 'active');

// Update revalidates: a candidate cannot be turned into a security suppress.
assert.throws(() => updateLesson(ws, suppress.id, { category: 'security' }, suppress.revision), { code: 'VALIDATION' });
assert.throws(() => updateLesson(ws, 'missing', {}, 1), { code: 'NOT_FOUND' });

// F1: suppress evidence is persisted, so a suppress candidate can be activated, edited and retired.
assert.equal(suppress.evidence.length, 1);
assert.equal(suppress.evidence[0].ledgerKey, 'R1A1-F1');
const activated = updateLesson(ws, suppress.id, { status: 'active' }, suppress.revision);
assert.equal(activated.status, 'active');
assert.equal(activated.evidence.length, 1, 'evidence survives updates');
const edited = updateLesson(ws, suppress.id, { text: 'Do not flag the intentional sync read in startup.' }, activated.revision);
const retired = updateLesson(ws, suppress.id, { status: 'retired', retired_reason: 'obsolete' }, edited.revision);
assert.equal(retired.status, 'retired');
assert.equal(retired.retiredReason, 'obsolete');
// The security guard is exercised on update with valid evidence present.
assert.throws(() => updateLesson(ws, suppress.id, { category: 'security' }, retired.revision), /security/);
// F5: invalid status is rejected; store-owned fields cannot be overwritten by a plain update.
assert.throws(() => updateLesson(ws, suppress.id, { status: 'bogus' }, retired.revision), { code: 'VALIDATION' });
const guarded = updateLesson(ws, suppress.id, { evidence: [], stats: { injected: 99 }, origin: 'distilled', lastEvidenceAt: 'x', id: 'other' }, retired.revision);
assert.equal(guarded.evidence.length, 1);
assert.equal(guarded.stats.injected, 0);
assert.equal(guarded.origin, 'manual');
assert.equal(guarded.id, suppress.id);
// F4: a status-only patch keeps globs and models.
const scoped = addLesson(ws, { ...doLesson, text: 'Scoped rule for lib files.', pathGlobs: ['lib/**'], appliesToModels: ['m1'] });
const statusOnly = updateLesson(ws, scoped.id, { status: 'active' }, scoped.revision);
assert.deepEqual(statusOnly.pathGlobs, ['lib/**']);
assert.deepEqual(statusOnly.appliesToModels, ['m1']);
assert.equal(listLessons(ws).length, 5);
console.log('review-lessons-service tests passed');
