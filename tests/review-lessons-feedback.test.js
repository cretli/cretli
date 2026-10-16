import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyDelegationWorkflowPatch, applyParentWorkflowUpdate } from '../lib/delegation-workflow.js';
import { syncCodeReviewWorkflowAfterFinish } from '../lib/delegation-service.js';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { applyRejectedReviewFindings, closeReviewFindingsCycle, getReviewFindingsLedger, recordReviewFindings } from '../lib/persist/review-findings-ledger-persist.js';
import { getReviewLessonsDataPath } from '../lib/persist/review-lessons-persist.js';
import { distillReviewLessons } from '../lib/review-lessons-distill.js';
import { applyRoundFeedback, computeRoundFeedback, decideLessonTransition, drainLessonFeedback, listWorkspaceFiles, resolveFeedbackOptions, setLessonDemotionNotifier } from '../lib/review-lessons-feedback.js';
import { scoutGlobToRegExp } from '../lib/workspace-scout-glob.js';
import { lessonEffectiveness, selectReviewLessons } from '../lib/review-lessons-select.js';
import { addLesson, listLessons, ReviewLessonsError, updateLesson } from '../lib/review-lessons-service.js';
import { resetReviewRoundResolutionState } from '../lib/review-round-resolution.js';
import { makeParent, makeReview } from './helpers/review-round-fixtures.js';

resetReviewRoundResolutionState();
let seq = 0;
const newWorkspace = () => `${ISOLATED_DATA_DIR}/fb-${(seq += 1)}`;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const lesson = (ws, extra = {}) => addLesson(ws, {
  audience: 'implementer', kind: 'avoid', category: 'missing-test', text: `Add tests for changed routes ${crypto.randomUUID()}.`, pathGlobs: ['lib/**'], activate: true, ...extra,
});
const get = (ws, id) => listLessons(ws).find((row) => row.id === id);
const finding = (id, extra = {}) => ({ id, status: 'NEW', priority: 'P2', category: 'missing-test', files: ['lib/routes/a.js'], summary: `s ${id}`, ...extra });
const record = (ws, leafId, delegationId, findings, mode = 'audit') => recordReviewFindings({ workspaceFolder: ws, leafId, delegationId, attemptId: 'a', mode, findings });
/** Plain delegation rows for the pure entry point (no persistence). */
const impl = (leafId, ids, createdAt = iso(-2000)) => ({ id: crypto.randomUUID(), assignment: 'implement', leafId, createdAt, injectedLessonIds: ids });
const review = (leafId, id, ids = [], createdAt = iso(-1000)) => ({ id, assignment: 'review', leafId, createdAt, injectedLessonIds: ids });
const round = (id, verdict, memberIds = [id]) => ({ id, verdict, memberIds, source: 'single', resolvedAt: iso() });
const apply = (ws, leafId, r, delegations, extra = {}) => applyRoundFeedback({ leafId, workspaceFolder: ws, parentChatId: 'p' }, r, { delegations, files: null, ...extra });
const stats = (ws, id) => get(ws, id).stats;

// Defect 3: compiled globs are memoized so a walk never recompiles a glob per file.
{
  const first = scoutGlobToRegExp('lib/memoized/**');
  assert.equal(scoutGlobToRegExp('lib/memoized/**'), first, 'a compiled glob is reused, not rebuilt');
  // The cache is bounded: filling it with distinct globs evicts the oldest entry.
  for (let i = 0; i < 5000; i += 1) scoutGlobToRegExp(`cache-probe-${i}/**`);
  assert.notEqual(scoutGlobToRegExp('lib/memoized/**'), first, 'the compiled-glob cache stays bounded');
}

// Counter transitions: recurred vs cleanAfterInjection, injected once per round, non-injected untouched.
{
  const ws = newWorkspace(); const leafId = crypto.randomUUID();
  const hit = lesson(ws); const clean = lesson(ws, { category: 'perf', pathGlobs: [] }); const outsideGlob = lesson(ws, { pathGlobs: ['app_front/**'] }); const idle = lesson(ws);
  record(ws, leafId, 'rev1', [finding('F1')]);
  const rows = [impl(leafId, [hit.id, clean.id, outsideGlob.id]), review(leafId, 'rev1')];
  const out = apply(ws, leafId, round('rev1', 'FAIL'), rows);
  assert.equal(out.applied, true);
  assert.deepEqual(stats(ws, hit.id), { injected: 1, recurred: 1, cleanAfterInjection: 0 });
  assert.deepEqual(stats(ws, clean.id), { injected: 1, recurred: 0, cleanAfterInjection: 1 }, 'other category -> clean');
  assert.deepEqual(stats(ws, outsideGlob.id), { injected: 1, recurred: 0, cleanAfterInjection: 1 }, 'same category outside the globs -> clean');
  assert.deepEqual(stats(ws, idle.id), { injected: 0, recurred: 0, cleanAfterInjection: 0 }, 'a lesson that was not injected is untouched');
  assert.ok(get(ws, hit.id).lastInjectedAt);
  assert.equal(get(ws, idle.id).revision, 1);
  // Two implement delegations carrying the same lesson still count one injection for the round.
  const ws2 = newWorkspace(); const leaf2 = crypto.randomUUID(); const twice = lesson(ws2);
  apply(ws2, leaf2, round('rev9', 'PASS'), [impl(leaf2, [twice.id]), impl(leaf2, [twice.id]), review(leaf2, 'rev9')]);
  assert.deepEqual(stats(ws2, twice.id), { injected: 1, recurred: 0, cleanAfterInjection: 1 });
  // A later PASS round counts a second injection; a replay of the same round does not.
  const again = apply(ws, leafId, round('rev1', 'FAIL'), rows);
  assert.equal(again.replayed, true);
  assert.deepEqual(stats(ws, hit.id), { injected: 1, recurred: 1, cleanAfterInjection: 0 });
  apply(ws, leafId, round('rev2', 'PASS'), [...rows, review(leafId, 'rev2', [], iso(-500))]);
  assert.deepEqual(stats(ws, hit.id), { injected: 2, recurred: 1, cleanAfterInjection: 1 });
  // BLOCKED rounds carry no signal.
  assert.equal(apply(ws, leafId, round('rev3', 'BLOCKED'), rows).skipped, 'verdict');
  // Retired lessons keep their counters frozen.
  const gone = lesson(ws2); updateLesson(ws2, gone.id, { status: 'retired', retiredReason: 'obsolete' }, 1);
  apply(ws2, leaf2, round('rev10', 'PASS'), [impl(leaf2, [gone.id]), review(leaf2, 'rev10')]);
  assert.equal(stats(ws2, gone.id).injected, 0);
}

// Cycle attribution: a finding of a closed cycle still counts for its round; later cycles' findings do not leak in.
{
  const ws = newWorkspace(); const leafId = crypto.randomUUID(); const l = lesson(ws);
  record(ws, leafId, 'late', [finding('F1')]);
  closeReviewFindingsCycle({ workspaceFolder: ws, leafId, roundId: 'x', memberIds: [] });
  record(ws, leafId, 'next', [finding('F1')]);
  const rows = [impl(leafId, [l.id], iso(-9000)), review(leafId, 'late', [], iso(-8000))];
  apply(ws, leafId, round('late', 'FAIL'), rows);
  assert.equal(stats(ws, l.id).recurred, 1, 'late result is attributed to the cycle it belongs to');
  // Implement delegations of the earlier cycle are not counted for a round of the next cycle.
  const l2 = lesson(ws);
  apply(ws, leafId, round('next', 'FAIL'), [impl(leafId, [l2.id], iso(-9500)), ...rows, review(leafId, 'next', [], iso(-100))]);
  assert.equal(stats(ws, l2.id).injected, 0, 'implement before the previous cycle ended is out of window');
}

// Retirement rules (table-driven).
{
  const options = resolveFeedbackOptions({}, {});
  const now = Date.now();
  const base = { status: 'active', createdAt: iso(-DAY), pathGlobs: [], lastEvidenceAt: '', lastInjectedAt: '' };
  const cases = [
    ['seven injections never trigger', base, { injected: 7, recurred: 7 }, undefined, null],
    ['8 injections at exactly the ratio keep the lesson', base, { injected: 8, recurred: 4 }, undefined, null],
    ['8 injections above the ratio demote', base, { injected: 8, recurred: 5 }, undefined, { status: 'candidate', reason: 'ineffective' }],
    ['candidates are not demoted again', { ...base, status: 'candidate' }, { injected: 10, recurred: 10 }, undefined, null],
    ['globs with no file retire as stale_paths', { ...base, pathGlobs: ['gone/**'] }, { injected: 0, recurred: 0 }, ['lib/a.js'], { status: 'retired', reason: 'stale_paths' }],
    ['a matching file keeps the lesson', { ...base, pathGlobs: ['lib/**'] }, { injected: 0, recurred: 0 }, ['lib/a.js'], null],
    ['an unknown file list never retires', { ...base, pathGlobs: ['gone/**'] }, { injected: 0, recurred: 0 }, null, null],
    ['no evidence and no injection for 180+ days retires as inactive', { ...base, createdAt: iso(-181 * DAY) }, { injected: 0, recurred: 0 }, undefined, { status: 'retired', reason: 'inactive' }],
    ['recent evidence keeps an old lesson', { ...base, createdAt: iso(-400 * DAY), lastEvidenceAt: iso(-10 * DAY) }, { injected: 0, recurred: 0 }, undefined, null],
    ['recent injection keeps an old lesson', { ...base, createdAt: iso(-400 * DAY), lastInjectedAt: iso(-10 * DAY) }, { injected: 3, recurred: 0 }, undefined, null],
    ['179 days is not yet inactive', { ...base, createdAt: iso(-179 * DAY) }, { injected: 0, recurred: 0 }, undefined, null],
    ['retired lessons never change', { ...base, status: 'retired', createdAt: iso(-999 * DAY) }, { injected: 0, recurred: 0 }, undefined, null],
  ];
  for (const [name, row, st, files, expected] of cases) {
    assert.deepEqual(decideLessonTransition(row, st, { now, options, files }), expected, name);
  }
  assert.equal(resolveFeedbackOptions({}, { CRETLI_REVIEW_LESSONS_RETIRE_MIN_INJECTIONS: '3' }).minInjections, 3, 'thresholds are configurable');
  // Defect 4: a listing built for different globs must never retire a lesson whose globs changed after it.
  const changed = { ...base, pathGlobs: ['changed/**'] };
  assert.equal(
    decideLessonTransition(changed, { injected: 0, recurred: 0 }, { now, options, files: ['lib/a.js'], listedGlobs: new Set(['gone/**']) }),
    null,
    'a glob the listing did not cover is never stale',
  );
  assert.deepEqual(
    decideLessonTransition(changed, { injected: 0, recurred: 0 }, { now, options, files: ['lib/a.js'], listedGlobs: new Set(['changed/**']) }),
    { status: 'retired', reason: 'stale_paths' },
    'a covered glob with no file still retires',
  );
  // End to end through the store: retired keeps status + reason, and is not reactivated by later rounds.
  const ws = newWorkspace(); const leafId = crypto.randomUUID();
  const stale = lesson(ws, { pathGlobs: ['gone/**'] }); const fine = lesson(ws);
  apply(ws, leafId, round('r1', 'PASS'), [], { files: ['lib/a.js'] });
  assert.equal(get(ws, stale.id).status, 'retired');
  assert.equal(get(ws, stale.id).retiredReason, 'stale_paths');
  assert.equal(get(ws, stale.id).statusReason, 'stale_paths');
  assert.equal(get(ws, fine.id).status, 'active');
  apply(ws, leafId, round('r2', 'PASS'), [impl(leafId, [stale.id]), review(leafId, 'r2')], { files: ['lib/a.js'] });
  assert.equal(get(ws, stale.id).status, 'retired');
  assert.equal(get(ws, stale.id).stats.injected, 0);
  // Inactive via the store with an injected clock.
  const old = lesson(ws, { pathGlobs: [] });
  apply(ws, leafId, round('r3', 'PASS'), [], { now: Date.now() + 200 * DAY, files: null });
  assert.equal(get(ws, old.id).retiredReason, 'inactive');
  // 8 injected rounds, mostly recurring -> candidate, not retired.
  const noisy = lesson(ws, { pathGlobs: [] });
  for (let i = 0; i < 8; i += 1) {
    const id = `n${i}`; const lf = crypto.randomUUID();
    record(ws, lf, id, [finding('F1')]);
    apply(ws, lf, round(id, 'FAIL'), [impl(lf, [noisy.id]), review(lf, id)]);
  }
  assert.equal(get(ws, noisy.id).status, 'candidate');
  assert.equal(get(ws, noisy.id).statusReason, 'ineffective');
  // A human can still retire with a reason (supersession); status + reason are kept.
  const kept = lesson(ws);
  const done = updateLesson(ws, kept.id, { status: 'retired', retiredReason: 'superseded_by_check', supersededByTodoId: 'todo-1' }, kept.revision);
  assert.equal(done.status, 'retired');
  assert.equal(done.retiredReason, 'superseded_by_check');
  assert.equal(done.statusReason, 'superseded_by_check');
  assert.equal(done.supersededByTodoId, 'todo-1');
}

// Plain lesson_update cannot write stats or the automatic status reason.
{
  const ws = newWorkspace(); const l = lesson(ws);
  const next = updateLesson(ws, l.id, { stats: { injected: 99 }, statusReason: 'x', lastInjectedAt: 'y', text: 'Keep tests close to the changed routes.' }, l.revision);
  assert.deepEqual(next.stats, { injected: 0, recurred: 0, cleanAfterInjection: 0 });
  assert.equal(next.statusReason, undefined);
  assert.equal(next.lastInjectedAt, undefined);
}

// Reviewer exposure: suppress lessons demote when the pattern is reported by another reviewer and ends fixed.
{
  const notified = [];
  setLessonDemotionNotifier((row, reason) => notified.push([row.id, reason]));
  const setup = (outcome) => {
    const ws = newWorkspace(); const leafId = crypto.randomUUID(); const seedLeaf = crypto.randomUUID();
    record(ws, seedLeaf, 'seed', [finding('F1', { files: ['lib/x.js'] })]);
    applyRejectedReviewFindings({ workspaceFolder: ws, leafId: seedLeaf, rejected: [{ key: 'R1A1-F1', reason: 'false_positive' }] });
    const suppress = addLesson(ws, {
      audience: 'reviewer', kind: 'suppress', category: 'missing-test', text: 'Do not demand tests for generated fixtures.', pathGlobs: ['lib/**'], activate: true,
      evidence: [{ leafId: seedLeaf, ledgerKey: 'R1A1-F1', outcome: 'rejected', actor: 'orchestrator' }],
    });
    record(ws, leafId, 'rev-b', [finding('F1', { status: outcome })]);
    const rows = [review(leafId, 'rev-a', [suppress.id]), review(leafId, 'rev-b', [], iso(-500))];
    return { ws, leafId, suppress, rows };
  };
  const bad = setup('FIXED');
  apply(bad.ws, bad.leafId, round('rev-b', 'FAIL'), bad.rows);
  assert.equal(get(bad.ws, bad.suppress.id).status, 'candidate');
  assert.equal(get(bad.ws, bad.suppress.id).statusReason, 'suppressed_real_issue');
  assert.deepEqual(notified, [[bad.suppress.id, 'suppressed_real_issue']]);
  apply(bad.ws, bad.leafId, round('rev-b', 'FAIL'), bad.rows);
  apply(bad.ws, bad.leafId, round('rev-c', 'FAIL'), bad.rows);
  assert.equal(notified.length, 1, 'notified once');
  // Ending not fixed (open / out of scope) keeps the suppression.
  for (const status of ['NEW', 'OUT_OF_SCOPE']) {
    const kept = setup(status);
    apply(kept.ws, kept.leafId, round('rev-b', 'FAIL'), kept.rows);
    assert.equal(get(kept.ws, kept.suppress.id).status, 'active', status);
  }
  // The pattern reported by the very reviewer that was exposed is not "another reviewer".
  const same = setup('FIXED');
  apply(same.ws, same.leafId, round('rev-b', 'FAIL'), [review(same.leafId, 'rev-b', [same.suppress.id])]);
  assert.equal(get(same.ws, same.suppress.id).status, 'active');
  setLessonDemotionNotifier(null);
}

const suppressLesson = (ws) => {
  const seedLeaf = crypto.randomUUID();
  record(ws, seedLeaf, `seed-${seedLeaf}`, [finding('F1', { files: ['lib/x.js'] })]);
  applyRejectedReviewFindings({ workspaceFolder: ws, leafId: seedLeaf, rejected: [{ key: 'R1A1-F1', reason: 'false_positive' }] });
  return addLesson(ws, {
    audience: 'reviewer', kind: 'suppress', category: 'missing-test', text: 'Do not demand tests for generated fixtures.', pathGlobs: ['lib/**'], activate: true,
    evidence: [{ leafId: seedLeaf, ledgerKey: 'R1A1-F1', outcome: 'rejected', actor: 'orchestrator' }],
  });
};

// Suppress demotion only counts findings recorded after the reviewer was created.
{
  const ws = newWorkspace(); const leafId = crypto.randomUUID();
  const suppress = suppressLesson(ws);
  record(ws, leafId, 'rev-1', [finding('F1', { status: 'FIXED' })]);
  // Round 2 reviewer was created after the fix was recorded and never saw it as a live issue.
  const late = [review(leafId, 'rev-2', [suppress.id], iso(60_000))];
  apply(ws, leafId, round('rev-2', 'PASS'), late);
  assert.equal(get(ws, suppress.id).status, 'active', 'a finding fixed before the reviewer existed does not demote');
  // A fixed finding recorded after the reviewer was created still demotes.
  const ws2 = newWorkspace(); const leaf2 = crypto.randomUUID();
  const s2 = suppressLesson(ws2);
  record(ws2, leaf2, 'rev-x', [finding('F1', { status: 'FIXED' })]);
  apply(ws2, leaf2, round('rev-x', 'FAIL'), [review(leaf2, 'rev-2', [s2.id], iso(-60_000)), review(leaf2, 'rev-x')]);
  assert.equal(get(ws2, s2.id).statusReason, 'suppressed_real_issue');
}

// Defect 5: re-recording a delegation keeps the first-recorded timestamp of each finding key.
{
  const ws = newWorkspace(); const leafId = crypto.randomUUID();
  const suppress = suppressLesson(ws);
  record(ws, leafId, 'rev-old', [finding('F1', { status: 'FIXED' })]);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const reviewerCreatedAt = iso(0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  // Same delegation, new report hash: the ledger replaces the entries but must keep the original time.
  recordReviewFindings({ workspaceFolder: ws, leafId, delegationId: 'rev-old', attemptId: 'a', mode: 'audit', reportHash: 'changed', findings: [finding('F1', { status: 'FIXED' })] });
  const ledger = getReviewFindingsLedger(ws, leafId);
  const delegations = [review(leafId, 'rev-a', [suppress.id], reviewerCreatedAt)];
  const plan = computeRoundFeedback({ leafId, round: round('rev-a', 'FAIL', ['rev-old', 'rev-a']), delegations, ledger, lessons: listLessons(ws) });
  assert.equal(plan.realIssue.has(suppress.id), false, 'a re-recorded old finding never demotes the suppress lesson');
  assert.ok(ledger.entries[0].recordedAt, 'findings keep their first-recorded timestamp');
}

// Stale-path walk: nested data/ is walked, a truncated walk retires nothing, a missing path still retires.
{
  const ws = newWorkspace();
  const put = (rel) => { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
  put('src/data/model.js'); put('data/root-only.js'); put('lib/a.js'); put('lib/b.js'); put('lib/c.js');
  const files = listWorkspaceFiles(ws);
  assert.ok(files.includes('src/data/model.js'), 'nested data/ is walked');
  assert.ok(!files.includes('data/root-only.js'), 'root data/ is skipped');
  const nested = lesson(ws, { pathGlobs: ['src/data/**'] });
  const missing = lesson(ws, { pathGlobs: ['gone/**'] });
  const outcome = apply(ws, crypto.randomUUID(), round('r1', 'PASS'), [], { files: undefined });
  assert.equal(outcome.applied, true);
  assert.equal(get(ws, nested.id).status, 'active', 'files under nested data/ keep the lesson active');
  assert.equal(get(ws, missing.id).status, 'retired');
  assert.equal(get(ws, missing.id).statusReason, 'stale_paths');
  assert.equal(get(ws, missing.id).retiredReason, 'stale_paths', 'retired lessons keep status and reason');
  // Truncated: the listing is unknown, so nothing retires.
  assert.equal(listWorkspaceFiles(ws, { maxFiles: 2 }), null);
  const ws3 = newWorkspace();
  for (const n of ['a', 'b', 'c', 'd']) { const f = path.join(ws3, 'lib', `${n}.js`); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
  const absent = lesson(ws3, { pathGlobs: ['gone/**'] });
  apply(ws3, crypto.randomUUID(), round('r1', 'PASS'), [], { files: undefined, maxFiles: 2 });
  assert.equal(get(ws3, absent.id).status, 'active', 'truncated walk retires nothing');
  // Early exit: once every glob matched the cut-off does not matter.
  assert.deepEqual(listWorkspaceFiles(ws3, { maxFiles: 2, globs: ['lib/**'] }).length > 0, true);
}

// Defect 1 + 6: skipped roots are unverifiable and bare directory globs are never stale.
{
  const ws = newWorkspace();
  const put = (rel) => { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
  put('src/components/Button.js'); put('data/tracked.js'); put('dist/bundle.js');
  const bareDir = addLesson(ws, { audience: 'implementer', kind: 'avoid', category: 'missing-test', text: `Directory glob ${crypto.randomUUID()}.`, pathGlobs: ['src/components'], activate: true });
  assert.deepEqual(get(ws, bareDir.id).pathGlobs, ['src/components/**'], 'a bare directory glob is normalized on save');
  const rootData = lesson(ws, { pathGlobs: ['data/**'] });
  const rootDist = lesson(ws, { pathGlobs: ['dist/**'] });
  const stale = lesson(ws, { pathGlobs: ['nothing-here/**'] });
  apply(ws, crypto.randomUUID(), round('dirs', 'PASS'), [], { files: undefined });
  assert.equal(get(ws, bareDir.id).status, 'active', 'a bare directory glob matches files below it');
  assert.equal(get(ws, rootData.id).status, 'active', 'a glob into skipped root data/ is unverifiable, not stale');
  assert.equal(get(ws, rootDist.id).status, 'active', 'a glob into skipped root dist/ is unverifiable, not stale');
  assert.equal(get(ws, stale.id).status, 'retired', 'a glob with no file anywhere still retires');
}

// Defect 2: an unreadable directory or an unhandled symlink makes the listing unknown.
{
  const ws = newWorkspace();
  const put = (rel) => { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
  put('lib/a.js'); put('other/b.js');
  const realReaddir = fs.readdirSync;
  fs.readdirSync = (dir, options) => {
    if (String(dir).endsWith(`${path.sep}other`)) throw new Error('EACCES');
    return realReaddir(dir, options);
  };
  try {
    assert.equal(listWorkspaceFiles(ws, { globs: ['other/**'] }), null, 'an unreadable directory makes the listing unknown');
  } finally { fs.readdirSync = realReaddir; }
  fs.symlinkSync(path.join(ws, 'lib/a.js'), path.join(ws, 'linked.js'));
  assert.equal(listWorkspaceFiles(ws, { globs: ['linked.js'] }), null, 'an unhandled symlink makes the listing unknown');
}

// A real bug outside an earlier leaf's scope is still reported: suppress is built only from false_positive.
{
  const ws = newWorkspace();
  for (let i = 0; i < 3; i += 1) record(ws, crypto.randomUUID(), `d${i}`, [finding('F1', { status: 'OUT_OF_SCOPE' }), finding('F2', { status: 'FOLLOW_UP' })]);
  assert.equal(distillReviewLessons(ws).candidates.length, 0);
  const leafId = crypto.randomUUID();
  record(ws, leafId, 'o1', [finding('F1', { status: 'OUT_OF_SCOPE' })]);
  assert.throws(() => addLesson(ws, {
    audience: 'reviewer', kind: 'suppress', category: 'missing-test', text: 'Ignore everything outside the leaf scope.',
    evidence: [{ leafId, ledgerKey: 'R1A1-F1', outcome: 'out_of_scope', actor: 'orchestrator' }],
  }), ReviewLessonsError);
  // Even an active suppress lesson is never selected for security findings.
  assert.deepEqual(selectReviewLessons({ audience: 'reviewer', lessons: [{ id: 's', status: 'active', audience: 'reviewer', kind: 'suppress', category: 'security', text: 'x' }] }), []);
}

// Ranking: a lesson that keeps recurring ranks below a proven one; unmeasured lessons are neutral.
{
  const mk = (id, injected, cleanAfterInjection) => ({ id, status: 'active', audience: 'implementer', kind: 'avoid', category: 'perf', text: `Rule ${id} about cache`, stats: { injected, recurred: injected - cleanAfterInjection, cleanAfterInjection }, pathGlobs: [] });
  assert.equal(lessonEffectiveness({}), 0.5);
  assert.ok(lessonEffectiveness(mk('a', 10, 9)) > lessonEffectiveness(mk('b', 10, 1)));
  const ranked = selectReviewLessons({ audience: 'implementer', leafText: 'speed up the cache', lessons: [mk('b', 10, 1), mk('n', 0, 0), mk('a', 10, 9)] });
  assert.deepEqual(ranked.map((row) => row.id), ['a', 'n', 'b']);
}

// Real finish paths: pool round once, lone PASS via applyParentWorkflowUpdate once, replay never double counts.
{
  const poolRecord = (ids) => ({ key: '0::0', epoch: 0, mode: 'audit', pool: true, started: ids, results: {}, superseded: [], resolved: '' });
  const finish = async (row) => { try { syncCodeReviewWorkflowAfterFinish(row); } catch { /* workflow-layer replay conflict */ } await drainLessonFeedback(); };
  const makeImpl = (parent, leafId, ids) => createDelegationRecord({
    parentChatId: parent.id, workspaceFolder: ISOLATED_DATA_DIR, executor: { transport: 'opencode', model: 'opencode/test' }, status: 'completed',
    assignment: 'implement', leafId, sourceText: `impl ${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), injectedLessonIds: ids,
  });
  const sleep = (n) => new Promise((resolve) => setTimeout(resolve, n));
  const ws = ISOLATED_DATA_DIR;
  const mine = (id) => get(ws, id).stats;

  // Pool PASS + PASS: one resolved round -> one injection, however many members finish or replay.
  {
    const parent = makeParent(); const leafId = crypto.randomUUID(); const l = lesson(ws, { pathGlobs: [] });
    makeImpl(parent, leafId, [l.id]); await sleep(5);
    const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' }); const b = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
    applyDelegationWorkflowPatch({ parentChatId: parent.id, leafId, workspaceFolder: ws, codeReviewPoolRound: poolRecord([a.id, b.id]), idempotencyKey: `seed-${crypto.randomUUID()}`, countReview: false });
    await finish(a);
    assert.equal(mine(l.id).injected, 0, 'pending pool round is not counted');
    await finish(b);
    assert.deepEqual(mine(l.id), { injected: 1, recurred: 0, cleanAfterInjection: 1 });
    await finish(a); await finish(b);
    assert.equal(mine(l.id).injected, 1, 'replayed finish does not double count');
    // A fresh process (cleared in-memory identity) still cannot double count: the store keys the round.
    resetReviewRoundResolutionState();
    await finish(b);
    assert.equal(mine(l.id).injected, 1, 'store-level idempotency survives a restart');
  }
  // Pool with a FAIL member resolves FAIL immediately; the late sibling is ignored.
  {
    const parent = makeParent(); const leafId = crypto.randomUUID(); const l = lesson(ws, { pathGlobs: [] });
    makeImpl(parent, leafId, [l.id]); await sleep(5);
    const a = makeReview({ parentId: parent.id, leafId, verdict: 'FAIL' }); const b = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
    applyDelegationWorkflowPatch({ parentChatId: parent.id, leafId, workspaceFolder: ws, codeReviewPoolRound: poolRecord([a.id, b.id]), idempotencyKey: `seed-${crypto.randomUUID()}`, countReview: false });
    await finish(a); await finish(b);
    assert.equal(mine(l.id).injected, 1);
  }
  // Lone pool PASS resolved by the parent: counted once, replay no-op.
  {
    const parent = makeParent(); const leafId = crypto.randomUUID(); const l = lesson(ws, { pathGlobs: [] });
    makeImpl(parent, leafId, [l.id]); await sleep(5);
    const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' }); const b = makeReview({ parentId: parent.id, leafId, verdict: 'PASS', status: 'failed', report: '' });
    applyDelegationWorkflowPatch({ parentChatId: parent.id, leafId, workspaceFolder: ws, codeReviewPoolRound: poolRecord([a.id, b.id]), idempotencyKey: `seed-${crypto.randomUUID()}`, countReview: false });
    await finish(a);
    assert.equal(mine(l.id).injected, 0);
    const pass = { parentChatId: parent.id, leafId, workspaceFolder: ws, lastVerdict: 'PASS', idempotencyKey: `pass-${crypto.randomUUID()}` };
    applyParentWorkflowUpdate(pass); await drainLessonFeedback();
    assert.equal(mine(l.id).injected, 1);
    applyParentWorkflowUpdate(pass); await drainLessonFeedback();
    applyParentWorkflowUpdate({ ...pass, idempotencyKey: `pass-${crypto.randomUUID()}` }); await drainLessonFeedback();
    assert.equal(mine(l.id).injected, 1, 'replayed parent PASS does not double count');
  }
  // A failing feedback write never throws out of the finish hook.
  {
    const parent = makeParent(); const leafId = crypto.randomUUID();
    const a = makeReview({ parentId: parent.id, leafId, verdict: 'PASS' });
    const l = lesson(ws, { pathGlobs: [] });
    // Corrupt the lessons file so the feedback pass throws for real.
    const storePath = getReviewLessonsDataPath(ws); const backup = fs.readFileSync(storePath);
    makeImpl(parent, leafId, [l.id]);
    const original = console.error; const logged = []; console.error = (...args) => logged.push(args.join(' '));
    try {
      fs.writeFileSync(storePath, '{ not json');
      assert.doesNotThrow(() => syncCodeReviewWorkflowAfterFinish(a));
      await drainLessonFeedback();
    } finally { console.error = original; fs.writeFileSync(storePath, backup); }
    assert.ok(logged.some((line) => line.includes('[review-lessons] feedback failed')), `logged: ${JSON.stringify(logged)}`);
  }
}
console.log('review-lessons-feedback tests passed');
