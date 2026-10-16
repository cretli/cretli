import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recordReviewFindings } from '../lib/persist/review-findings-ledger-persist.js';
import { containsPrivateData } from '../lib/review-lessons-privacy.js';
import { loadTodosData } from '../lib/persist/todos-persist.js';
import { assertNotCommittedRuleDuplicate, findCommittedRuleDuplicate, proposeLessonCheck } from '../lib/review-lessons-checks.js';
import { addLesson, listLessons, updateLesson } from '../lib/review-lessons-service.js';

let seq = 0;
const newWorkspace = () => {
  const dir = path.join(ISOLATED_DATA_DIR, `chk-${(seq += 1)}`);
  fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
  return dir;
};
const base = { audience: 'implementer', kind: 'avoid', category: 'missing-test' };
const RULE = 'All comments must be in English: JSDoc block comments, inline comments and SCSS comments.';
const todosOf = (ws) => loadTodosData(process.env.CRETLI_TEST_DATA_DIR, ws).items;

// Duplicate-of-committed-rule guard with fixture rule files (CLAUDE.md and .cursor/rules/*.mdc).
{
  const ws = newWorkspace();
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Rules\n\n- Never commit the data/ directory to the repository.\n');
  fs.writeFileSync(path.join(ws, '.cursor', 'rules', 'style.mdc'), `# Style\n\n${RULE}\n`);
  // Normalized substring match: case, punctuation and markdown are ignored.
  assert.equal(findCommittedRuleDuplicate(ws, 'never commit the DATA directory to the repository')?.file, 'CLAUDE.md');
  assert.equal(findCommittedRuleDuplicate(ws, 'all comments must be in English')?.file, '.cursor/rules/style.mdc');
  assert.equal(findCommittedRuleDuplicate(ws, 'Always write a regression test for every fixed bug.'), null);
  assert.equal(findCommittedRuleDuplicate(ws, 'short'), null, 'tiny needles never match');
  // Activation through add and update is refused with a hint; candidates are still allowed.
  assert.throws(() => addLesson(ws, { ...base, text: 'All comments must be in English.', activate: true }), (err) => err.code === 'DUPLICATE_RULE' && /strengthen/.test(err.message) && /style\.mdc/.test(err.message));
  const candidate = addLesson(ws, { ...base, text: 'All comments must be in English.' });
  assert.equal(candidate.status, 'candidate');
  assert.throws(() => updateLesson(ws, candidate.id, { status: 'active' }, candidate.revision), (err) => err.code === 'DUPLICATE_RULE');
  assert.equal(listLessons(ws).find((row) => row.id === candidate.id).status, 'candidate');
  const fine = addLesson(ws, { ...base, text: 'Add a regression test next to every changed route handler.', activate: true });
  assert.equal(fine.status, 'active');
  // The fixture path is injectable, and nothing outside the workspace is ever read.
  const outside = path.join(ISOLATED_DATA_DIR, `outside-${seq}.md`);
  fs.writeFileSync(outside, 'Never put secrets into lesson text files.\n');
  assert.equal(findCommittedRuleDuplicate(ws, 'Never put secrets into lesson text files', { ruleFiles: [path.relative(ws, outside)] }), null);
  assert.equal(findCommittedRuleDuplicate(ws, 'Never put secrets into lesson text files', { ruleFiles: [outside] }), null);
  fs.writeFileSync(path.join(ws, 'extra.md'), 'Prefer small functions with a single purpose.\n');
  assert.equal(findCommittedRuleDuplicate(ws, 'prefer small functions with a single purpose', { ruleFiles: ['extra.md'] })?.file, 'extra.md');
  assert.equal(findCommittedRuleDuplicate(ws, 'prefer small functions with a single purpose', { ruleFiles: [] }), null);
  // A symlink escaping the workspace is not followed.
  fs.symlinkSync(outside, path.join(ws, 'link.md'));
  assert.equal(findCommittedRuleDuplicate(ws, 'Never put secrets into lesson text files', { ruleFiles: ['link.md'] }), null);
  assert.doesNotThrow(() => assertNotCommittedRuleDuplicate(ws, 'Something wholly unrelated to any committed rule here.'));
}

// propose-check: exactly one idea todo, deterministic key, privacy-clean, never writes the check.
{
  const ws = newWorkspace();
  const checkable = addLesson(ws, { ...base, text: 'Register every new test file in the review-verify catalog.', checkable: true, checkHint: 'Lint rule over tests/*.test.js', pathGlobs: ['tests/**'] });
  const first = proposeLessonCheck(ws, checkable.id, { dataDir: process.env.CRETLI_TEST_DATA_DIR, createdByChatId: 'chat-1' });
  const second = proposeLessonCheck(ws, checkable.id, { dataDir: process.env.CRETLI_TEST_DATA_DIR });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.todo.id, second.todo.id);
  // Editing the lesson afterwards still resolves to the one existing todo (no CONFLICT).
  const edited = updateLesson(ws, checkable.id, { text: 'Register every new test file in the review-verify catalog, always.' }, checkable.revision);
  const afterEdit = proposeLessonCheck(ws, checkable.id, { dataDir: process.env.CRETLI_TEST_DATA_DIR });
  assert.equal(afterEdit.created, false);
  assert.equal(afterEdit.todo.id, first.todo.id);
  const items = todosOf(ws);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'idea');
  assert.match(items[0].body, /Register every new test file/);
  assert.match(items[0].body, /Lint rule over tests/);
  assert.match(items[0].body, /review-verify catalog/);
  // Not checkable / unknown / retired lessons propose nothing.
  const plain = addLesson(ws, { ...base, text: 'Keep functions short and focused on one job.' });
  assert.throws(() => proposeLessonCheck(ws, plain.id, { dataDir: process.env.CRETLI_TEST_DATA_DIR }), /checkable/);
  assert.throws(() => proposeLessonCheck(ws, 'missing', { dataDir: process.env.CRETLI_TEST_DATA_DIR }), (err) => err.code === 'NOT_FOUND');
  const old = addLesson(ws, { ...base, text: 'Keep changelog entries in sync with releases.', checkable: true });
  updateLesson(ws, old.id, { status: 'retired', retiredReason: 'obsolete' }, old.revision);
  assert.throws(() => proposeLessonCheck(ws, old.id, { dataDir: process.env.CRETLI_TEST_DATA_DIR }), /Retired/);
  assert.equal(todosOf(ws).length, 1);
  // Retiring after the check landed keeps status + reason + the superseding todo.
  const done = updateLesson(ws, checkable.id, { status: 'retired', retiredReason: 'superseded_by_check', supersededByTodoId: first.todo.id }, edited.revision);
  assert.equal(done.status, 'retired');
  assert.equal(done.retiredReason, 'superseded_by_check');
  assert.equal(done.supersededByTodoId, first.todo.id);
}

// Privacy: a private path in the check hint cannot reach a todo (rejected at the lesson store).
{
  const ws = newWorkspace();
  assert.throws(() => addLesson(ws, { ...base, text: 'Keep paths relative in docs.', checkable: true, checkHint: 'see /home/someone/project/lib/x.js' }), /private/);
}
// Privacy: evidence summaries from the ledger are redacted before they reach the todo body.
{
  const ws = newWorkspace();
  recordReviewFindings({ workspaceFolder: ws, leafId: 'leaf-p', delegationId: 'd1', attemptId: 'a', mode: 'audit', findings: [{ id: 'F1', priority: 'P2', category: 'docs-not-updated', files: ['docs/a.md'], summary: 'Missing note in /home/someone/www/project/docs/a.md and 192.168.1.20' }] });
  const l = addLesson(ws, { ...base, category: 'docs-not-updated', text: 'Update docs when routes change.', checkable: true, evidence: [{ leafId: 'leaf-p', ledgerKey: 'R1A1-F1', outcome: 'fixed', actor: '' }] });
  const { todo } = proposeLessonCheck(ws, l.id, { dataDir: process.env.CRETLI_TEST_DATA_DIR });
  assert.match(todo.body, /R1A1-F1/);
  assert.equal(containsPrivateData(todo.body), false);
  assert.equal(containsPrivateData(todo.title), false);
  assert.doesNotMatch(todo.body, /someone|192\.168/);
}
console.log('review-lessons-checks tests passed');
