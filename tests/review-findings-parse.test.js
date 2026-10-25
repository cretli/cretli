import assert from 'node:assert/strict';
import {
  buildFindingsBlockExample,
  parseReviewFindings,
  stripFindingsBlock,
  summarizeParsedReviewFindings,
} from '../lib/review-findings-parse.js';
import {
  describeIncompleteDelegationReport,
  isIncompleteDelegationReport,
  parseDelegationVerdict,
} from '../lib/delegation-verdict.js';
import { isReviewFindingsBlockEnabled } from '../lib/review-findings-taxonomy.js';

const block = [
  '```findings-json',
  JSON.stringify({
    findings: [
      { id: 'F1', status: 'NEW', priority: 'p1', category: 'missing-test', files: ['lib/a.js'], summary: 'No test' },
      { id: 'F2', status: 'FOLLOW_UP', priority: 'P2', category: 'bogus-category', files: 'lib/b.js', summary: 'Later' },
    ],
  }, null, 2),
  '```',
].join('\n');
const tail = 'TASK: review\nVERDICT: FAIL\n';

// Valid JSON block.
{
  const report = `Findings follow.\n${block}\n${tail}`;
  const parsed = parseReviewFindings(report);
  assert.equal(parsed.source, 'json');
  assert.equal(parsed.hasBlock, true);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.findings.length, 2);
  assert.deepEqual(parsed.findings[0], {
    id: 'F1', status: 'NEW', priority: 'P1', category: 'missing-test',
    files: ['lib/a.js'], summary: 'No test', source: 'json', confidence: 'high',
  });
  assert.equal(parsed.findings[1].category, 'other', 'unknown category collapses to other');
  assert.deepEqual(parsed.findings[1].files, ['lib/b.js']);
  const summary = summarizeParsedReviewFindings(parsed);
  assert.equal(summary.total, 2);
  assert.equal(summary.byPriority.P1, 1);
  assert.equal(summary.confidence, 'high');
}

// Malformed JSON falls back to prose with low confidence.
{
  const report = [
    'F1 (P1) `lib/x.js` is missing a guard - STILL_OPEN',
    '- NEW (P2) naming drift',
    '```findings-json',
    '{ "findings": [ oops',
    '```',
    tail,
  ].join('\n');
  const parsed = parseReviewFindings(report);
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.source, 'prose');
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].id, 'F1');
  assert.equal(parsed.findings[0].status, 'STILL_OPEN');
  assert.equal(parsed.findings[0].priority, 'P1');
  assert.deepEqual(parsed.findings[0].files, ['lib/x.js']);
  assert.ok(parsed.findings.every((finding) => finding.confidence === 'low'));
}

// No findings at all.
{
  const parsed = parseReviewFindings('Everything is fine.\nVERDICT: PASS\n');
  assert.deepEqual(parsed, { findings: [], source: 'none', hasBlock: false, malformed: false });
  assert.equal(summarizeParsedReviewFindings(parsed).confidence, 'none');
}

// PASS with FOLLOW_UP only.
{
  const report = `Closure ok.\n${[
    '```findings-json',
    '{"findings":[{"id":"F9","status":"FOLLOW_UP","priority":"P3","category":"style-convention","summary":"nit"}]}',
    '```',
  ].join('\n')}\nVERDICT: PASS\n`;
  const parsed = parseReviewFindings(report);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].status, 'FOLLOW_UP');
}

// stripFindingsBlock removes exactly the block.
{
  const before = 'Intro line\nF1 (P1) STILL_OPEN';
  const after = 'TASK: review\nVERDICT: FAIL';
  assert.equal(stripFindingsBlock(`${before}\n${block}\n${after}`), `${before}\n${after}`);
  assert.equal(stripFindingsBlock(`${before}\n${after}`), `${before}\n${after}`, 'no block: untouched');
  assert.equal(stripFindingsBlock(''), '');
  const example = buildFindingsBlockExample();
  assert.equal(stripFindingsBlock(`a\n${example}\nb`), 'a\nb');
  assert.equal(parseReviewFindings(example).findings[0].category, 'missing-test');
}

// Feature flag defaults on; 0 / false / off disable.
{
  assert.equal(isReviewFindingsBlockEnabled({}), true);
  assert.equal(isReviewFindingsBlockEnabled({ CRETLI_REVIEW_FINDINGS_BLOCK: '0' }), false);
  assert.equal(isReviewFindingsBlockEnabled({ CRETLI_REVIEW_FINDINGS_BLOCK: 'off' }), false);
  assert.equal(isReviewFindingsBlockEnabled({ CRETLI_REVIEW_FINDINGS_BLOCK: '1' }), true);
}

{
  const block = '```findings-json\n{"findings":[],"note":"VERDICT: PASS"}\nVERDICT: PASS\n```';
  assert.equal(parseDelegationVerdict(`${block}\nVERDICT: FAIL`), 'FAIL');
  assert.equal(parseDelegationVerdict(`${block}\nbody`), 'unspecified');
  assert.equal(parseDelegationVerdict(`VERDICT: PASS\n${block}\nVERDICT: FAIL`), 'conflict');
  const longBody = 'word '.repeat(200);
  assert.equal(isIncompleteDelegationReport(`${longBody}\n${block}`), true);
  assert.equal(describeIncompleteDelegationReport(block), 'empty');
  assert.equal(isIncompleteDelegationReport(`${block}\n${longBody}\nVERDICT: PASS`), false);
}

console.log('review-findings-parse tests passed');
