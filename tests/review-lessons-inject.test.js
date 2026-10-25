import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createDelegationRecord,
  getDelegationById,
  loadDelegations,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { addReviewLesson, updateReviewLesson } from '../lib/persist/review-lessons-persist.js';
import { resolveRunReviewLessons } from '../lib/delegation-service.js';

const folder = path.join(ISOLATED_DATA_DIR, 'inject-ws');
fs.mkdirSync(folder, { recursive: true });
const base = { parentChatId: 'parent-x', workspaceFolder: folder, executor: { transport: 'opencode', model: 'm' } };

// Every record carries an array, also when nothing was injected.
for (const assignment of ['implement', 'review']) {
  const row = createDelegationRecord({ ...base, assignment });
  assert.deepEqual(row.injectedLessonIds, []);
  assert.equal(row.lessonsInjectedAt, '');
}

// create + patch + reload.
const created = createDelegationRecord({ ...base, assignment: 'implement', injectedLessonIds: ['a', 'a', ' b '] });
assert.deepEqual(created.injectedLessonIds, ['a', 'b']);
updateDelegationRecord(created.id, { injectedLessonIds: ['c', 'd'], lessonsInjectedAt: '2026-01-01T00:00:00.000Z' });
assert.deepEqual(getDelegationById(created.id).injectedLessonIds, ['c', 'd']);
updateDelegationRecord(created.id, { status: 'running' });
const reloaded = loadDelegations().find((row) => row.id === created.id);
assert.deepEqual(reloaded.injectedLessonIds, ['c', 'd']);
assert.equal(reloaded.lessonsInjectedAt, '2026-01-01T00:00:00.000Z');

// Selection: flag off -> nothing; flag on -> active lessons; replay keeps ids.
const active = addReviewLesson(folder, { audience: 'implementer', kind: 'do', category: 'missing-test', text: 'Add a regression test for every fix.', status: 'active' });
addReviewLesson(folder, { audience: 'implementer', kind: 'do', category: 'perf', text: 'Candidate only.', status: 'candidate' });
const record = createDelegationRecord({ ...base, assignment: 'implement' });
const ctx = { cwd: folder, assignment: 'implement', model: 'm', sourceText: 'fix the tests' };
const previous = process.env.CRETLI_REVIEW_LESSONS;
try {
  process.env.CRETLI_REVIEW_LESSONS = '0';
  assert.deepEqual(resolveRunReviewLessons(record, ctx), { reviewLessons: null, injectedLessonIds: [], enabled: false });
  // Default (flag unset): implementers get lessons.
  delete process.env.CRETLI_REVIEW_LESSONS;
  assert.deepEqual(resolveRunReviewLessons(record, ctx).injectedLessonIds, [active.id]);
  process.env.CRETLI_REVIEW_LESSONS = '1';
  const first = resolveRunReviewLessons(record, ctx);
  assert.deepEqual(first.injectedLessonIds, [active.id]);
  assert.equal(first.reviewLessons.audience, 'implementer');
  const pinned = updateDelegationRecord(record.id, {
    injectedLessonIds: first.injectedLessonIds, lessonsInjectedAt: '2026-01-01T00:00:00.000Z',
  });
  addReviewLesson(folder, { audience: 'implementer', kind: 'avoid', category: 'missing-test', text: 'Added later.', status: 'active' });
  assert.deepEqual(resolveRunReviewLessons(pinned, ctx).injectedLessonIds, [active.id], 'replay is stable');
  // Replay keeps injection order and still shows a pinned lesson retired since.
  const second = addReviewLesson(folder, { audience: 'implementer', kind: 'do', category: 'perf', text: 'Second pinned.', status: 'active' });
  const ordered = updateDelegationRecord(createDelegationRecord({ ...base, assignment: 'implement' }).id, {
    injectedLessonIds: [second.id, active.id], lessonsInjectedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(resolveRunReviewLessons(ordered, ctx).injectedLessonIds, [second.id, active.id]);
  updateReviewLesson(folder, second.id, { status: 'retired' }, second.revision);
  assert.deepEqual(resolveRunReviewLessons(ordered, ctx).injectedLessonIds, [second.id, active.id]);
  // Audit code reviewers get no implementer lessons.
  const review = createDelegationRecord({ ...base, assignment: 'review', reviewSubject: 'code', reviewMode: 'audit' });
  assert.deepEqual(resolveRunReviewLessons(review, { ...ctx, assignment: 'review' }).injectedLessonIds, []);
} finally {
  if (previous === undefined) delete process.env.CRETLI_REVIEW_LESSONS;
  else process.env.CRETLI_REVIEW_LESSONS = previous;
}

console.log('review-lessons-inject tests passed');
