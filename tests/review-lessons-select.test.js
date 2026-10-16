import assert from 'node:assert/strict';
import {
  extractPathsFromText,
  isReviewLessonsEnabled,
  REVIEW_LESSONS_PROMPT_CHAR_BUDGET,
  selectReviewLessons,
} from '../lib/review-lessons-select.js';

const lesson = (id, over = {}) => ({
  id, audience: 'implementer', kind: 'do', status: 'active', category: 'missing-test', text: `Rule ${id}`,
  pathGlobs: [], appliesToModels: [], evidence: [], updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});
const ids = (rows) => rows.map((row) => row.id);

// Glob match wins over a keyword-only and a plain lesson.
{
  const lessons = [
    lesson('plain', { evidence: [{}, {}, {}] }),
    lesson('keyword', { category: 'docs-not-updated' }),
    lesson('glob', { pathGlobs: ['lib/**/*.js'] }),
  ];
  const picked = selectReviewLessons({
    lessons, audience: 'implementer', leafText: 'Update the docs in lib/foo/bar.js', candidatePaths: [],
  });
  assert.deepEqual(ids(picked), ['glob', 'keyword', 'plain']);
}

// A lesson whose globs miss every known path is not injected.
assert.deepEqual(ids(selectReviewLessons({
  lessons: [lesson('other', { pathGlobs: ['app_front/**'] })], audience: 'implementer', candidatePaths: ['lib/a.js'],
})), []);

// Candidate and retired lessons are never injected; wrong audience/kind neither.
assert.deepEqual(ids(selectReviewLessons({
  lessons: [
    lesson('c', { status: 'candidate' }), lesson('r', { status: 'retired' }),
    lesson('rev', { audience: 'reviewer', kind: 'suppress' }), lesson('ok'),
  ],
  audience: 'implementer',
})), ['ok']);

// Suppressions: reviewer audience only, never security.
assert.deepEqual(ids(selectReviewLessons({
  lessons: [
    lesson('s1', { audience: 'reviewer', kind: 'suppress' }),
    lesson('s2', { audience: 'reviewer', kind: 'suppress', category: 'security' }),
  ],
  audience: 'reviewer',
})), ['s1']);

// Model restriction.
assert.deepEqual(ids(selectReviewLessons({
  lessons: [lesson('m', { appliesToModels: ['sonnet'] })], audience: 'implementer', executorModel: 'sonnet::effort=medium',
})), ['m']);
assert.deepEqual(ids(selectReviewLessons({
  lessons: [lesson('m', { appliesToModels: ['sonnet'] })], audience: 'implementer', executorModel: 'opus',
})), []);

// Budget: count cap and character cap.
{
  const many = Array.from({ length: 10 }, (_, i) => lesson(`n${i}`));
  assert.equal(selectReviewLessons({ lessons: many, audience: 'implementer' }).length, 6);
  const fat = Array.from({ length: 6 }, (_, i) => lesson(`f${i}`, { text: 'x'.repeat(290) }));
  const picked = selectReviewLessons({ lessons: fat, audience: 'implementer' });
  assert.ok(picked.length < 6 && picked.length > 0);
  assert.ok(picked.reduce((n, row) => n + row.text.length, 0) <= REVIEW_LESSONS_PROMPT_CHAR_BUDGET);
}

// No active lessons -> empty; deterministic.
assert.deepEqual(selectReviewLessons({ lessons: [], audience: 'implementer' }), []);
assert.deepEqual(selectReviewLessons({ lessons: [lesson('a', { status: 'retired' })], audience: 'implementer' }), []);
assert.deepEqual(selectReviewLessons({ lessons: [lesson('a')], audience: 'bogus' }), []);

// Path extraction and flags.
assert.deepEqual(extractPathsFromText('Edit `lib/a.js` and tests/b.test.js, then README.md.').sort(), ['README.md', 'lib/a.js', 'tests/b.test.js']);
assert.equal(isReviewLessonsEnabled({}), false, 'no audience: master flag only');
// Rollout defaults: implementer on, planner and reviewer (suppress) off.
assert.equal(isReviewLessonsEnabled({}, 'implementer'), true);
assert.equal(isReviewLessonsEnabled({}, 'reviewer'), false);
assert.equal(isReviewLessonsEnabled({}, 'planner'), false);
assert.equal(isReviewLessonsEnabled({ CRETLI_REVIEW_LESSONS: '0' }, 'implementer'), false, 'master off disables all');
assert.equal(isReviewLessonsEnabled({ CRETLI_REVIEW_LESSONS_IMPLEMENT: 'off' }, 'implementer'), false);
assert.equal(isReviewLessonsEnabled({ CRETLI_REVIEW_LESSONS: '0', CRETLI_REVIEW_LESSONS_REVIEW: '1' }, 'reviewer'), false);
assert.equal(isReviewLessonsEnabled({ CRETLI_REVIEW_LESSONS: '1' }, 'implementer'), true);
assert.equal(isReviewLessonsEnabled({ CRETLI_REVIEW_LESSONS: '1', CRETLI_REVIEW_LESSONS_REVIEW: 'off' }, 'reviewer'), false);
assert.equal(isReviewLessonsEnabled({ CRETLI_REVIEW_LESSONS_REVIEW: '1' }, 'reviewer'), true, 'audience opt-in works without the master flag');

console.log('review-lessons-select tests passed');
