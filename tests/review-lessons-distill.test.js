import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyRejectedReviewFindings, recordReviewFindings } from '../lib/persist/review-findings-ledger-persist.js';
import { distillReviewLessons, normalizeFindingFile } from '../lib/review-lessons-distill.js';
import { addLesson, listLessons, updateLesson } from '../lib/review-lessons-service.js';

let seq = 0;
const newWorkspace = () => `${ISOLATED_DATA_DIR}/ws-${(seq += 1)}`;
const finding = (id, status, extra = {}) => ({
  id, status, priority: 'P2', category: 'missing-test', files: ['lib/routes/a.js'], summary: `finding ${id}`, ...extra,
});
/** Record findings of one leaf (a fresh leaf per call unless given). */
function record(ws, findings, { leafId = crypto.randomUUID(), source, mode = 'audit' } = {}) {
  recordReviewFindings({ workspaceFolder: ws, leafId, delegationId: crypto.randomUUID(), attemptId: 'a', mode, findings, source });
  return leafId;
}
const fixed = (n, extra) => Array.from({ length: n }, (_, i) => finding(`F${i + 1}`, 'FIXED', extra));

// Below threshold -> nothing.
{
  const ws = newWorkspace();
  record(ws, fixed(1));
  record(ws, fixed(1));
  const out = distillReviewLessons(ws);
  assert.equal(out.candidates.length, 0);
  assert.equal(listLessons(ws).length, 0);
}
// 3 findings in ONE leaf -> nothing (needs two distinct leaves).
{
  const ws = newWorkspace();
  record(ws, fixed(3));
  assert.equal(distillReviewLessons(ws).candidates.length, 0);
}
// Across 2 leaves -> exactly one implementer candidate; replay adds nothing.
{
  const ws = newWorkspace();
  record(ws, fixed(2));
  record(ws, fixed(1));
  const out = distillReviewLessons(ws);
  assert.equal(out.candidates.length, 1);
  const lesson = out.candidates[0];
  assert.equal(lesson.status, 'candidate');
  assert.equal(lesson.origin, 'distilled');
  assert.equal(lesson.audience, 'implementer');
  assert.equal(lesson.kind, 'avoid');
  assert.deepEqual(lesson.pathGlobs, ['lib/routes/**']);
  assert.equal(lesson.evidence.length, 3);
  assert.ok(lesson.text.length <= 300 && !/\n/.test(lesson.text));
  const again = distillReviewLessons(ws);
  assert.equal(again.candidates.length, 0);
  assert.equal(again.skipped[0].reason, 'covered');
  assert.equal(listLessons(ws).length, 1);
}
// Already covered by an active lesson (or a retired one is not coverage) -> skipped.
{
  const ws = newWorkspace();
  record(ws, fixed(2));
  record(ws, fixed(1));
  addLesson(ws, { audience: 'implementer', kind: 'avoid', category: 'missing-test', text: 'Always add tests for new routes.', pathGlobs: ['lib/**'], activate: true });
  const out = distillReviewLessons(ws);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.skipped[0].reason, 'covered');
  assert.equal(listLessons(ws).length, 1);
}
// out_of_scope / follow_up never produce suppress (nor avoid).
{
  const ws = newWorkspace();
  for (let i = 0; i < 3; i += 1) record(ws, [finding('F1', 'OUT_OF_SCOPE'), finding('F2', 'FOLLOW_UP')]);
  const leaf = record(ws, [finding('F1', 'NEW')]);
  // Even an attempted rejection cannot turn out_of_scope into a rejected outcome.
  applyRejectedReviewFindings({ workspaceFolder: ws, leafId: leaf, rejected: [{ key: 'R1A1-F1', reason: 'wont_fix' }] });
  assert.equal(distillReviewLessons(ws).candidates.length, 0);
}
// rejected/false_positive x3 across 2 leaves -> one suppress candidate; wont_fix/duplicate never.
{
  const ws = newWorkspace();
  const l1 = record(ws, [finding('F1', 'NEW'), finding('F2', 'NEW')]);
  const l2 = record(ws, [finding('F1', 'NEW')]);
  applyRejectedReviewFindings({ workspaceFolder: ws, leafId: l1, rejected: [{ key: 'R1A1-F1', reason: 'false_positive' }, { key: 'R1A1-F2', reason: 'false_positive' }] });
  applyRejectedReviewFindings({ workspaceFolder: ws, leafId: l2, rejected: [{ key: 'R1A1-F1', reason: 'false_positive' }] });
  const out = distillReviewLessons(ws);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].kind, 'suppress');
  assert.equal(out.candidates[0].audience, 'reviewer');
  assert.equal(out.candidates[0].status, 'candidate');
  const other = newWorkspace();
  const a = record(other, [finding('F1', 'NEW'), finding('F2', 'NEW')]);
  const b = record(other, [finding('F1', 'NEW')]);
  applyRejectedReviewFindings({ workspaceFolder: other, leafId: a, rejected: [{ key: 'R1A1-F1', reason: 'wont_fix' }, { key: 'R1A1-F2', reason: 'duplicate' }] });
  applyRejectedReviewFindings({ workspaceFolder: other, leafId: b, rejected: [{ key: 'R1A1-F1', reason: 'out_of_scope_elsewhere' }] });
  assert.equal(distillReviewLessons(other).candidates.length, 0);
}
// security never suppress; P1 never suppress.
{
  for (const extra of [{ category: 'security' }, { priority: 'P1' }]) {
    const ws = newWorkspace();
    const l1 = record(ws, [finding('F1', 'NEW', extra), finding('F2', 'NEW', extra)]);
    const l2 = record(ws, [finding('F1', 'NEW', extra)]);
    applyRejectedReviewFindings({ workspaceFolder: ws, leafId: l1, rejected: [{ key: 'R1A1-F1', reason: 'false_positive' }, { key: 'R1A1-F2', reason: 'false_positive' }] });
    applyRejectedReviewFindings({ workspaceFolder: ws, leafId: l2, rejected: [{ key: 'R1A1-F1', reason: 'false_positive' }] });
    assert.equal(distillReviewLessons(ws).candidates.filter((c) => c.kind === 'suppress').length, 0);
  }
}
// Backfill-only findings count half: 3 are not enough, 6 across 2 leaves are.
{
  const ws = newWorkspace();
  record(ws, fixed(2), { source: 'backfill' });
  record(ws, fixed(1), { source: 'backfill' });
  assert.equal(distillReviewLessons(ws).candidates.length, 0);
  record(ws, fixed(3), { source: 'backfill' });
  assert.equal(distillReviewLessons(ws).candidates.length, 1);
  // Mixed: 2 live + 2 backfill = 3 weight across 2 leaves.
  const mixed = newWorkspace();
  record(mixed, fixed(2));
  record(mixed, fixed(2), { source: 'backfill' });
  assert.equal(distillReviewLessons(mixed).candidates.length, 1);
}
// Outside the window -> nothing; configurable thresholds; dry run writes nothing.
{
  const ws = newWorkspace();
  record(ws, fixed(2));
  record(ws, fixed(1));
  assert.equal(distillReviewLessons(ws, { now: Date.now() + 100 * 24 * 3600 * 1000 }).candidates.length, 0);
  assert.equal(distillReviewLessons(ws, { minFindings: 4 }).candidates.length, 0);
  const dry = distillReviewLessons(ws, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.candidates.length, 1);
  assert.equal(listLessons(ws).length, 0);
}
// A summary the store rejects (private path) still yields a candidate without it.
{
  const ws = newWorkspace();
  record(ws, fixed(2, { summary: 'See /home/someone/project/file.js' }));
  record(ws, fixed(1, { summary: 'See /home/someone/project/file.js' }));
  const out = distillReviewLessons(ws);
  assert.equal(out.candidates.length, 1);
  assert.ok(!/\/home\//.test(out.candidates[0].text));
}
// F1: absolute / Windows / tilde file paths never leak a username into prefix, text or globs.
{
  const leaky = /home\/|Users|someone|~/i;
  const cases = {
    posix: ['/home/someone/proj/lib/routes/a.js'],
    windows: ['C:\\Users\\someone\\proj\\lib\\routes\\a.js'],
    tilde: ['~/someone/proj/b.js'],
    relativeHome: ['home/someone/c.js'],
  };
  for (const [name, files] of Object.entries(cases)) {
    const ws = newWorkspace();
    record(ws, fixed(2, { files }));
    record(ws, fixed(1, { files }));
    const out = distillReviewLessons(ws);
    assert.equal(out.candidates.length, 1, name);
    const lesson = out.candidates[0];
    assert.ok(!leaky.test(lesson.text), `${name}: text ${lesson.text}`);
    assert.ok(lesson.pathGlobs.every((g) => !leaky.test(g)), `${name}: globs ${lesson.pathGlobs}`);
    assert.ok(!leaky.test(JSON.stringify(out.skipped)), name);
  }
  // Absolute path with a known top-level dir reduces to the repo-relative tail.
  const ws = newWorkspace();
  const files = ['/home/someone/proj/lib/routes/a.js'];
  record(ws, fixed(2, { files }));
  record(ws, fixed(1, { files: ['lib/routes/b.js'] }));
  const out = distillReviewLessons(ws);
  assert.deepEqual(out.candidates[0].pathGlobs, ['lib/routes/**']);
  // Unusable-only paths bucket by category with no path prefix (no glob).
  const ws2 = newWorkspace();
  record(ws2, fixed(2, { files: ['/etc/x/y.js'] }));
  record(ws2, fixed(1, { files: ['C:\\Users\\someone\\z.js'] }));
  const out2 = distillReviewLessons(ws2);
  assert.equal(out2.candidates.length, 1);
  assert.deepEqual(out2.candidates[0].pathGlobs, []);
}
// F1: the store guard rejects slash-less and Windows forward-slash private paths.
for (const text of ['See C:/Users/x/a.js', 'See /Users/x/a.js', 'See home/x/a.js', 'See ~/x/a.js']) {
  assert.throws(() => addLesson(newWorkspace(), { audience: 'implementer', kind: 'avoid', category: 'missing-test', text }), { code: 'VALIDATION' }, text);
}
assert.throws(() => addLesson(newWorkspace(), { audience: 'implementer', kind: 'avoid', category: 'missing-test', text: 'ok', pathGlobs: ['home/x/**'] }), { code: 'VALIDATION' });
// NEW-1: legitimate `users/` and `home/` repo folders are kept; every private form is still dropped.
{
  assert.equal(normalizeFindingFile('lib/routes/users/a.js'), 'lib/routes/users/a.js');
  assert.equal(normalizeFindingFile('app_front/features/home/x.js'), 'app_front/features/home/x.js');
  assert.equal(normalizeFindingFile('src/users/x.ts'), 'src/users/x.ts');
  assert.equal(normalizeFindingFile('/work/proj/lib/routes/users/a.js'), 'lib/routes/users/a.js');
  // FU-2: non-repo prefixes before a known folder are dropped consistently.
  assert.equal(normalizeFindingFile('.cretli-worktrees/cretli/t-1/lib/a.js'), 'lib/a.js');
  assert.equal(normalizeFindingFile('www/someone/lib/a.js'), 'lib/a.js');
  assert.equal(normalizeFindingFile('misc/a.js'), 'misc/a.js');
  for (const bad of ['home/x/a.js', '~/a.js', '/root/a.js', 'C:/Users/x/a.js', '/Users/x/a.js', '/mnt/c/Users/x/a.js', 'file:///home/x/a.js']) assert.equal(normalizeFindingFile(bad), '', bad);
  for (const bad of ['/home/x/lib/a.js', 'C:\\Users\\x\\lib\\a.js', 'C:/Users/x/lib/a.js', '/Users/x/lib/a.js', '~/lib/a.js', '/root/lib/a.js', '/mnt/c/Users/x/lib/a.js', 'file:///home/x/lib/a.js', 'home/x/lib/a.js']) {
    // Re-anchored at a known folder (no username survives) or dropped entirely.
    assert.ok(['', 'lib/a.js'].includes(normalizeFindingFile(bad)), bad);
  }
  const ws = newWorkspace();
  record(ws, fixed(2, { files: ['lib/routes/users/a.js'] }));
  record(ws, fixed(1, { files: ['lib/routes/users/b.js'] }));
  assert.deepEqual(distillReviewLessons(ws).candidates[0].pathGlobs, ['lib/routes/**']);
  const ws2 = newWorkspace();
  record(ws2, fixed(2, { files: ['app_front/features/home/x.js'] }));
  record(ws2, fixed(1, { files: ['app_front/features/home/y.js'] }));
  assert.deepEqual(distillReviewLessons(ws2).candidates[0].pathGlobs, ['app_front/features/**']);
  const stored = addLesson(newWorkspace(), { audience: 'implementer', kind: 'avoid', category: 'missing-test', text: 'Cover users/ handlers with a test', pathGlobs: ['app_front/users/**'] });
  assert.deepEqual(stored.pathGlobs, ['app_front/users/**']);
  for (const text of ['See /mnt/c/Users/x/a.js', 'See file:///home/x/a.js', 'See /root/a.js']) {
    assert.throws(() => addLesson(newWorkspace(), { audience: 'implementer', kind: 'avoid', category: 'missing-test', text }), { code: 'VALIDATION' }, text);
  }
  // FU-3: dry-run never echoes a private summary.
  const ws3 = newWorkspace();
  record(ws3, fixed(2, { summary: 'See /home/someone/project/file.js' }));
  record(ws3, fixed(1, { summary: 'See /home/someone/project/file.js' }));
  const dry = distillReviewLessons(ws3, { dryRun: true });
  assert.equal(dry.candidates.length, 1);
  assert.ok(!/someone|\/home\//.test(dry.candidates[0].text));
}
// NEW-2: markdown-wrapped private paths in a summary are redacted (not dropped by a store throw)
// in the stored candidate and the dry-run output; the store rejects them from human callers.
{
  const summary = 'Token leaked in `/home/alice/proj/lib/routes/a.js` and [~/notes](x)';
  const ws = newWorkspace();
  record(ws, fixed(2, { summary }));
  record(ws, fixed(1, { summary }));
  const dry = distillReviewLessons(ws, { dryRun: true });
  assert.ok(!/alice|\/home\/|~\//.test(dry.candidates[0].text), dry.candidates[0].text);
  const out = distillReviewLessons(ws);
  assert.equal(out.candidates.length, 1);
  const text = out.candidates[0].text;
  assert.ok(!/alice|\/home\/|~\//.test(text), text);
  assert.ok(text.includes('`lib/routes/a.js`'), `redacted to the repo tail: ${text}`);
  assert.ok(!/alice/.test(JSON.stringify(listLessons(ws))));
  for (const bad of ['See `/home/x/a.js`', 'See `~/x`', 'See [/home/x/a.js](y)', 'See </home/x/a.js>', 'See **/home/x/a.js**']) {
    assert.throws(() => addLesson(newWorkspace(), { audience: 'implementer', kind: 'avoid', category: 'missing-test', text: bad }), { code: 'VALIDATION' }, bad);
  }
}
// F2: an identical-text lesson retired by a human is skipped as `retired`, not resurrected or reported.
{
  const ws = newWorkspace();
  record(ws, fixed(2));
  record(ws, fixed(1));
  const first = distillReviewLessons(ws, { dryRun: true }).candidates[0];
  const added = addLesson(ws, { audience: 'implementer', kind: 'avoid', category: 'missing-test', text: first.text, pathGlobs: ['lib/routes/**'] });
  updateLesson(ws, added.id, { status: 'retired', retiredReason: 'no longer relevant' }, added.revision);
  const out = distillReviewLessons(ws);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.skipped[0].reason, 'retired');
  const rows = listLessons(ws);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'retired');
}
console.log('review-lessons-distill tests passed');
