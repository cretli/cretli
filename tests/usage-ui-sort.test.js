import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCsv,
  buildSharePercent,
  normalizeUsageRow,
  sortUsageRows,
  usageSortValue,
} from '../app_front/features/usage/usageCharts.js';

function row(label, values = {}) {
  return normalizeUsageRow(values, { key: label, label });
}

const rows = [
  row('alpha', { usd: 1, runs: 2, okRuns: 1, totalTokens: 300, p95LatencyMs: 300 }),
  row('beta', { usd: 3, runs: 4, okRuns: 4, totalTokens: 100, p95LatencyMs: 900 }),
  row('gamma', { usd: null, runs: 0, totalTokens: 200, p95LatencyMs: null, unpricedEvents: 1 }),
];

test('usageSortValue reads the sortable fields', () => {
  assert.equal(usageSortValue(rows[0], 'usd'), 1);
  assert.equal(usageSortValue(rows[0], 'tokens'), 300);
  assert.equal(usageSortValue(rows[0], 'runs'), 2);
  assert.equal(usageSortValue(rows[0], 'successRate'), 0.5);
  assert.equal(usageSortValue(rows[0], 'p95'), 300);
  assert.equal(usageSortValue(rows[2], 'usd'), null);
  assert.equal(usageSortValue(rows[2], 'successRate'), null);
});

test('sortUsageRows sorts descending by default and ascending on demand', () => {
  assert.deepEqual(sortUsageRows(rows, 'usd').map((r) => r.label), ['beta', 'alpha', 'gamma']);
  assert.deepEqual(sortUsageRows(rows, 'usd', 'asc').map((r) => r.label), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(sortUsageRows(rows, 'tokens', 'desc').map((r) => r.label), ['alpha', 'gamma', 'beta']);
  assert.deepEqual(sortUsageRows(rows, 'runs', 'asc').map((r) => r.label), ['gamma', 'alpha', 'beta']);
  assert.deepEqual(sortUsageRows(rows, 'successRate', 'desc').map((r) => r.label), ['beta', 'alpha', 'gamma']);
  assert.deepEqual(sortUsageRows(rows, 'p95', 'desc').map((r) => r.label), ['beta', 'alpha', 'gamma']);
});

test('sortUsageRows keeps missing values last, regardless of direction', () => {
  assert.equal(sortUsageRows(rows, 'p95', 'asc').at(-1).label, 'gamma');
  assert.equal(sortUsageRows(rows, 'successRate', 'asc').at(-1).label, 'gamma');
});

test('sortUsageRows does not mutate and ignores unknown keys', () => {
  const original = rows.map((r) => r.label);
  const sorted = sortUsageRows(rows, 'nope');
  assert.deepEqual(rows.map((r) => r.label), original);
  assert.deepEqual(sorted.map((r) => r.label), original);
});

test('buildSharePercent returns a clamped integer percentage', () => {
  assert.equal(buildSharePercent(50, 100), 50);
  assert.equal(buildSharePercent(1, 3), 33);
  assert.equal(buildSharePercent(0, 100), 0);
  assert.equal(buildSharePercent(5, 0), 0);
  assert.equal(buildSharePercent(-5, 100), 0);
  assert.equal(buildSharePercent(200, 100), 100);
});

test('buildCsv quotes cells with separators, quotes and newlines', () => {
  const csv = buildCsv(['name', 'cost'], [['gpt,4o', '$1.00'], ['say "hi"', 'line\nbreak']]);
  assert.equal(
    csv,
    'name,cost\r\n"gpt,4o",$1.00\r\n"say ""hi""","line\nbreak"'
  );
  assert.equal(buildCsv([], []), '');
});

test('buildCsv neutralizes formula injection with a leading apostrophe', () => {
  const csv = buildCsv(
    ['name', 'note'],
    [
      ['=1+1', '+cmd'],
      ['-2', '@x'],
      ['\ttab', '\rcr'],
      ['safe', 'plain'],
    ]
  );
  assert.equal(
    csv,
    "name,note\r\n'=1+1,'+cmd\r\n'-2,'@x\r\n'\ttab,\"'\rcr\"\r\nsafe,plain"
  );
});

test('buildCsv keeps formula prefix correct together with quotes and commas', () => {
  assert.equal(buildCsv(['name'], [['=SUM(A1,B1)']]), `name\r\n"'=SUM(A1,B1)"`);
  assert.equal(buildCsv(['name'], [['=say "hi"']]), `name\r\n"'=say ""hi"""`);
});
