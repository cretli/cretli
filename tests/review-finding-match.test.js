import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchFindings, parseFindingFileRef } from '../lib/review-finding-match.js';
import { parseReviewFindings } from '../lib/review-findings-parse.js';

const f = (category, files, summary = 's') => ({ category, files, summary });

test('(a) same file, lines 10 and 12 -> same', () => {
  assert.equal(matchFindings(f('x', ['lib/a.js:10']), f('y', ['lib/a.js:12'])), 'same');
});
test('(b) same category, lines 10 and 80 -> distinct', () => {
  assert.equal(matchFindings(f('bug', ['lib/a.js:10']), f('bug', ['lib/a.js:80'])), 'distinct');
});
test('(c) no lines, same category -> ambiguous', () => {
  assert.equal(matchFindings(f('bug', ['lib/a.js']), f('bug', ['lib/a.js'])), 'ambiguous');
});
test('(d) no lines, different categories (incl. other) -> ambiguous', () => {
  assert.equal(matchFindings(f('bug', ['lib/a.js']), f('other', ['lib/a.js:3'])), 'ambiguous');
  assert.equal(matchFindings(f('bug', ['lib/a.js']), f('missing-test', ['lib/a.js'])), 'ambiguous');
});
test('(e) different files -> distinct', () => {
  assert.equal(matchFindings(f('bug', ['lib/a.js:1']), f('bug', ['lib/b.js:1'])), 'distinct');
});
test('(f) empty after scrub -> unmatchable', () => {
  assert.equal(matchFindings(f('bug', ['/etc/passwd:3']), f('bug', ['lib/a.js:3'])), 'unmatchable');
  assert.equal(matchFindings(f('bug', []), f('bug', ['lib/a.js:3'])), 'unmatchable');
});
test('(g) prose finding loses its line -> ambiguous', () => {
  const parsed = parseReviewFindings('F1 (P2) NEW broken check in `lib/a.js:10`\nTASK: review\nVERDICT: FAIL');
  assert.equal(parsed.source, 'prose');
  assert.deepEqual(parsed.findings[0].files, ['lib/a.js']);
  assert.equal(matchFindings(parsed.findings[0], f('bug', ['lib/a.js:10'])), 'ambiguous');
});
test('ranges, boundary of 5 and path parsing', () => {
  assert.deepEqual(parseFindingFileRef('lib/a.js:3-9'), { path: 'lib/a.js', start: 3, end: 9 });
  assert.equal(matchFindings(f('x', ['lib/a.js:10']), f('x', ['lib/a.js:15'])), 'same');
  assert.equal(matchFindings(f('x', ['lib/a.js:10']), f('x', ['lib/a.js:16'])), 'distinct');
  assert.equal(matchFindings(f('x', ['lib/a.js:1-20']), f('x', ['lib/a.js:30'])), 'distinct');
  assert.equal(matchFindings(f('x', ['lib/a.js:1-28']), f('x', ['lib/a.js:30'])), 'same');
});
