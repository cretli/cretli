/**
 * Lessons triggered by diff patterns (added lines of the leaf diff).
 */
import './helpers/isolated-data-dir.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addReviewLesson, updateReviewLesson, ReviewLessonsError } from '../lib/persist/review-lessons-persist.js';
import { diffPatternError, lessonMatchesAddedLines, selectReviewLessons } from '../lib/review-lessons-select.js';
import { captureProjectLeafManifest, readLeafDiffForLessons } from '../lib/todo-leaf-material.js';
import { readRunLessonLeafDiff, resolveRunReviewLessons } from '../lib/delegation-service.js';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { LESSON_MCP_TOOLS } from '../lib/mcp/builtin/lesson-tools.js';
import { commitFile, createTempRepo, git } from './helpers/temp-git-repo.js';

const folder = path.join(ISOLATED_DATA_DIR, 'diffpat-ws');
fs.mkdirSync(folder, { recursive: true });
const lessonBase = { audience: 'implementer', kind: 'avoid', category: 'perf', status: 'active' };
let seq = 0;
const mk = (extra) => addReviewLesson(folder, { ...lessonBase, text: `Rule number ${seq += 1}.`, ...extra });
const select = (lessons, extra) => selectReviewLessons({ lessons, audience: 'implementer', ...extra });

test('(a) worktree: pattern in baseCommit does not trigger, added line does', async () => {
  const { dir: repo } = createTempRepo();
  const baseCommit = commitFile(repo, 'a.js', 'const old = eval(x);\n');
  const lesson = { diffPatterns: ['\\beval\\('], text: 'x' };
  const material = { mode: 'worktree', baseCommit };
  let diff = await readLeafDiffForLessons(material, repo);
  assert.deepEqual(diff.addedLines, []);
  assert.equal(lessonMatchesAddedLines(lesson, diff.addedLines), false);
  // Ranking: a hit lifts the lesson above an otherwise equal one (maxLessons 1).
  const plain = { id: 'a-plain', status: 'active', audience: 'implementer', kind: 'avoid', text: 'p' };
  const pat = { ...lesson, id: 'z-pattern', status: 'active', audience: 'implementer', kind: 'avoid' };
  assert.deepEqual(select([pat, plain], { addedLines: diff.addedLines, maxLessons: 1 }).map((l) => l.id), ['a-plain']);
  fs.appendFileSync(path.join(repo, 'a.js'), 'const fresh = eval(y);\n');
  fs.writeFileSync(path.join(repo, 'new.js'), 'ok();\n');
  diff = await readLeafDiffForLessons(material, repo);
  assert.ok(diff.addedLines.includes('const fresh = eval(y);'));
  assert.ok(diff.addedLines.includes('ok();'), 'untracked file counts as additions');
  assert.deepEqual(diff.paths, ['a.js', 'new.js']);
  assert.equal(lessonMatchesAddedLines(lesson, diff.addedLines), true);
  assert.deepEqual(select([pat, plain], { addedLines: diff.addedLines, maxLessons: 1 }).map((l) => l.id), ['z-pattern']);
});

test('(b) pattern hit without a path hit selects the lesson; globs still gate', () => {
  const both = mk({ pathGlobs: ['src/**'], diffPatterns: ['TODO\\(hack\\)'] });
  const globOnly = mk({ pathGlobs: ['src/**'] });
  const picked = select([both, globOnly], { candidatePaths: ['docs/readme.md'], addedLines: ['// TODO(hack) later'] });
  assert.deepEqual(picked.map((l) => l.id), [both.id]);
});

test('(c) project mode: no diff text, manifest paths reach candidatePaths', async () => {
  const { dir: repo } = createTempRepo();
  commitFile(repo, 'a.js', 'x\n');
  const baseManifest = captureProjectLeafManifest(repo);
  fs.appendFileSync(path.join(repo, 'a.js'), 'eval(1)\n');
  const diff = await readLeafDiffForLessons({ mode: 'project', baseManifest }, repo);
  assert.deepEqual(diff.paths, ['a.js']);
  assert.deepEqual(diff.addedLines, []);
  const byGlob = mk({ pathGlobs: ['a.js'] });
  const gatedPattern = mk({ pathGlobs: ['other/**'], diffPatterns: ['eval'] });
  const picked = select([byGlob, gatedPattern], { candidatePaths: diff.paths, addedLines: diff.addedLines });
  assert.deepEqual(picked.map((l) => l.id), [byGlob.id], 'project mode never evaluates diffPatterns');
});

test('(d)(e) validation errors', () => {
  const bad = (diffPatterns) => assert.throws(() => mk({ diffPatterns }), (err) => err instanceof ReviewLessonsError);
  bad(['(unclosed']);
  bad(['(a+)+']);
  bad(['(.*)*']);
  bad(['(\\w+)*']);
  bad(['((a+)b)+']);
  bad(['/eval/i']);
  bad(['x'.repeat(201)]);
  bad(Array.from({ length: 11 }, (_, i) => `p${i}`));
  assert.doesNotThrow(() => mk({ diffPatterns: Array.from({ length: 10 }, (_, i) => `p${i}`) }));
  assert.doesNotThrow(() => mk({ diffPatterns: ['(ab)?c+', '[(a+)+]'] }));
  const ok = mk({});
  assert.throws(() => updateReviewLesson(folder, ok.id, { diff_patterns: ['(a+)+'] }, ok.revision), ReviewLessonsError);
  const updated = updateReviewLesson(folder, ok.id, { diff_patterns: ['foo'] }, ok.revision);
  assert.deepEqual(updated.diffPatterns, ['foo']);
});

test('a bad stored pattern never throws during selection', () => {
  const broken = { id: 'b', status: 'active', audience: 'implementer', kind: 'avoid', text: 't', diffPatterns: ['(', '(a+)+', 7] };
  const gated = { ...broken, pathGlobs: ['src/**'] };
  assert.deepEqual(select([gated], { candidatePaths: ['docs/x.md'], addedLines: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'] }), []);
});

test('reader error falls back to no diff info; selection still works', async () => {
  const diff = await readLeafDiffForLessons({ mode: 'worktree', baseCommit: 'deadbeef' }, path.join(ISOLATED_DATA_DIR, 'not-a-repo'));
  assert.deepEqual(diff, { paths: [], addedLines: [] });
  const plain = mk({});
  assert.equal(select([plain], { candidatePaths: diff.paths, addedLines: diff.addedLines }).length, 1);
});

test('replay with pinned ids ignores the diff', () => {
  const lesson = mk({ diffPatterns: ['zzz'] });
  const record = createDelegationRecord({ parentChatId: 'p', workspaceFolder: folder, assignment: 'implement', executor: { transport: 'opencode', model: 'm' }, injectedLessonIds: [lesson.id], lessonsInjectedAt: '2026-01-01T00:00:00.000Z' });
  const out = resolveRunReviewLessons(record, { cwd: folder, assignment: 'implement', model: 'm', leafDiff: { paths: [], addedLines: ['nothing'] } });
  assert.deepEqual(out.injectedLessonIds, [lesson.id]);
});

test('MCP lesson_add / lesson_update pass diff_patterns through', async () => {
  const calls = [];
  const client = {
    addReviewLesson: async (a) => { calls.push(['add', a]); return { id: 'x', diffPatterns: a.lesson.diffPatterns }; },
    updateReviewLesson: async (a) => { calls.push(['update', a]); return { id: 'x', diffPatterns: a.patch.diff_patterns }; },
  };
  const session = { workspaceFolder: folder };
  const add = LESSON_MCP_TOOLS.find((t) => t.name === 'lesson_add');
  const upd = LESSON_MCP_TOOLS.find((t) => t.name === 'lesson_update');
  assert.ok(add.inputSchema.properties.diff_patterns);
  assert.ok(upd.inputSchema.properties.patch.properties.diff_patterns);
  await add.handler({ audience: 'implementer', kind: 'do', text: 't', category: 'perf', diff_patterns: ['a'], workspace_folder: folder }, { client, session });
  assert.deepEqual(calls[0][1].lesson.diffPatterns, ['a']);
  await upd.handler({ id: 'x', expected_revision: 1, patch: { diff_patterns: ['b'] }, workspace_folder: folder }, { client, session });
  assert.deepEqual(calls[1][1].patch.diff_patterns, ['b']);
});

test('F1: catastrophic and backreference shapes are rejected, simple patterns accepted', () => {
  for (const bad of ['(.|\\s)*x', '(a{1,50})+b', '(a|ab)*c', '.*.*.*.*.*.*=', '\\s*\\s*\\s*x', '(a)\\1', '(?<n>a)\\k<n>', '(a?)+']) {
    assert.ok(diffPatternError(bad), `should reject ${bad}`);
  }
  for (const good of ['console\\.log\\(', '\\bTODO\\b', 'await\\s+fetch', '(ab)?c', '(?:foo|bar)baz', 'a.*b.*c']) {
    assert.equal(diffPatternError(good), null, `should accept ${good}`);
  }
});

test('F1: a stored catastrophic pattern is cut off by the time budget', () => {
  const evil = { id: 'evil', status: 'active', audience: 'implementer', kind: 'avoid', text: 'e', diffPatterns: ['(.|\\s)*x'] };
  const started = Date.now();
  assert.equal(lessonMatchesAddedLines(evil, [' '.repeat(40)]), false);
  const picked = select([{ ...evil, pathGlobs: ['src/**'] }], { candidatePaths: ['docs/x.md'], addedLines: [' '.repeat(40)] });
  assert.deepEqual(picked, []);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('F3/F4: added lines starting with ++, CRLF and non-ASCII paths', async () => {
  const { dir: repo } = createTempRepo();
  const baseCommit = commitFile(repo, 'a.js', 'x\n');
  fs.writeFileSync(path.join(repo, 'a.js'), 'x\n++i;\r\n');
  fs.writeFileSync(path.join(repo, 'żółw.js'), 'y();\n');
  const diff = await readLeafDiffForLessons({ mode: 'worktree', baseCommit }, repo);
  assert.ok(diff.addedLines.includes('++i;'));
  assert.ok(diff.paths.includes('żółw.js'));
  const pathsOnly = await readLeafDiffForLessons({ mode: 'worktree', baseCommit }, repo, { wantAddedLines: false });
  assert.deepEqual(pathsOnly.addedLines, []);
  assert.ok(pathsOnly.paths.includes('a.js'));
  assert.deepEqual(await readLeafDiffForLessons({ mode: 'worktree', baseCommit }, ''), { paths: [], addedLines: [] });
});

test('F2/F6: wiring - diff read skipped on replay and when no lesson needs it; leafDiff changes the result', async () => {
  const wsFolder = path.join(ISOLATED_DATA_DIR, 'diffpat-wiring');
  fs.mkdirSync(wsFolder, { recursive: true });
  const { dir: repo } = createTempRepo();
  const baseCommit = commitFile(repo, 'a.js', 'x\n');
  fs.appendFileSync(path.join(repo, 'a.js'), 'danger();\n');
  const leafTodo = { leafMaterial: { mode: 'worktree', baseCommit, baseCapturedAt: '2026-01-01T00:00:00.000Z' } };
  const base = { parentChatId: 'p', workspaceFolder: wsFolder, assignment: 'implement', executor: { transport: 'opencode', model: 'm' } };
  const ctx = { assignment: 'implement', leafTodo, executionFolder: repo, cwd: wsFolder };
  const fresh = createDelegationRecord(base);
  // No active lesson with globs/patterns: nothing to read.
  addReviewLesson(wsFolder, { ...lessonBase, text: 'Plain rule.' });
  assert.equal(await readRunLessonLeafDiff(fresh, ctx), null);
  const withPattern = addReviewLesson(wsFolder, { ...lessonBase, text: 'No danger calls.', pathGlobs: ['src/**'], diffPatterns: ['danger\\('] });
  const diff = await readRunLessonLeafDiff(fresh, ctx);
  assert.ok(diff.addedLines.includes('danger();'));
  // Replay: pinned record never reads the diff.
  const pinned = createDelegationRecord({ ...base, injectedLessonIds: [withPattern.id], lessonsInjectedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(await readRunLessonLeafDiff(pinned, ctx), null);
  // leafDiff changes the outcome for a non-pinned record.
  const run = (leafDiff) => resolveRunReviewLessons(fresh, { cwd: wsFolder, assignment: 'implement', model: 'm', leafDiff }).injectedLessonIds;
  const outside = { paths: ['docs/x.md'], addedLines: [] };
  assert.ok(run({ ...outside, addedLines: diff.addedLines }).includes(withPattern.id), 'a pattern hit selects the lesson despite the path miss');
  assert.ok(!run(outside).includes(withPattern.id), 'without added lines the path gate drops it');
});

test('F1: a validation-passing quadratic pattern hits the vm timeout branch', () => {
  assert.equal(diffPatternError('\\w+\\s*='), null);
  const lines = Array.from({ length: 2000 }, () => 'a'.repeat(1024));
  const budget = { remainingMs: 250, skip: new Set() };
  const started = Date.now();
  const hit = lessonMatchesAddedLines({ diffPatterns: ['\\w+\\s*='] }, lines, budget);
  const took = Date.now() - started;
  assert.equal(hit, false);
  assert.ok(took < 200, `took ${took} ms`);
  assert.ok(budget.skip.has('\\w+\\s*='), 'timeout branch marks the pattern as skipped');
});
