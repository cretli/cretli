import '../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { extractCases } from '../lib/reviewer-eval/extract.js';
import { aggregateScores, scoreCase } from '../lib/reviewer-eval/score.js';
import { runEval } from '../lib/reviewer-eval/run.js';
import { readCases, writeCases } from '../lib/reviewer-eval/store.js';
import { execFileSync } from 'node:child_process';
import { main } from '../scripts/reviewer-eval.js';
import { loadHistorySources } from '../lib/reviewer-eval/sources.js';
import { createPreFixCheckout } from '../lib/reviewer-eval/worktree.js';
import { readResultsForDate } from '../lib/reviewer-eval/store.js';
import { formatScoreTable } from '../lib/reviewer-eval/score.js';
import { parseUnifiedDiff } from '../lib/reviewer-eval/diff.js';
import { runGit } from '../lib/worktree/git-worktree.ts';

const diff = (file, oldStart, newStart = oldStart) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${oldStart},3 +${newStart},4 @@\n x\n`;

test('extract: source_todo_id fix and same-lines fix yield cases; accepted is preserved', () => {
  const todos = [
    { id: 'leaf1', status: 'done', updated_at: '2026-11-01T00:00:00Z' },
    { id: 'fixA', status: 'done', sourceTodoId: 'leaf1', title: 'Off by one', updated_at: '2026-11-02T00:00:00Z' },
    { id: 'later', status: 'done', title: 'Touch same lines', updated_at: '2026-11-10T00:00:00Z' },
    { id: 'old', status: 'done', title: 'Too late', updated_at: '2027-01-30T00:00:00Z' },
    { id: 'nopass', status: 'done', updated_at: '2026-11-01T00:00:00Z' },
  ];
  const diffs = {
    leaf1: diff('lib/a.js', 1, 1), fixA: diff('lib/a.js', 40, 40), later: diff('lib/a.js', 2, 2), old: diff('lib/a.js', 2, 2), nopass: diff('lib/z.js', 1),
  };
  const cases = extractCases({
    todos, passedReviewLeafIds: ['leaf1'], readLeafDiff: (t) => diffs[t.id],
    existing: [{ id: 'leaf1:fixA', accepted: true }],
  });
  assert.deepEqual(cases.map((c) => c.id).sort(), ['leaf1:fixA', 'leaf1:later']);
  const a = cases.find((c) => c.id === 'leaf1:fixA');
  assert.equal(a.accepted, true);
  assert.deepEqual(a.truth, [{ file: 'lib/a.js', line: 40, end: 42 }]);
  assert.equal(cases.find((c) => c.id === 'leaf1:later').accepted, false);
});

const tcase = { description: 'bug', truth: [{ file: 'lib/a.js', line: 40 }] };
const fail = 'TASK: review\nVERDICT: FAIL';
const jf = (files, extra = {}) => ({ category: 'bug', summary: 's', files, ...extra });

test('scoring: hit, possibleHit, miss, false alarm', () => {
  assert.equal(scoreCase(tcase, { report: fail, findings: [jf(['lib/a.js:42'])] }).raw.hit, true);
  const possible = scoreCase(tcase, { report: fail, findings: [jf(['lib/a.js'])] }).raw;
  assert.deepEqual([possible.hit, possible.possibleHit, possible.miss], [false, true, false]);
  const miss = scoreCase(tcase, { report: fail, findings: [jf(['lib/b.js:1'])] }).raw;
  assert.deepEqual([miss.hit, miss.possibleHit, miss.miss, miss.falseAlarms], [false, false, true, 1]);
  assert.equal(scoreCase(tcase, { report: fail, findings: [] }).raw.miss, true);
});

test('scoring: rejected counts only at the raw level; final needs VERDICT FAIL', () => {
  const rejectedAlarm = scoreCase(tcase, { report: fail, findings: [jf(['lib/b.js:1'], { rejected: true })] });
  assert.equal(rejectedAlarm.raw.falseAlarms, 1);
  assert.equal(rejectedAlarm.verified.falseAlarms, 0);
  assert.equal(rejectedAlarm.final.falseAlarms, 0);
  const rejectedHit = scoreCase(tcase, { report: fail, findings: [jf(['lib/a.js:40'], { rejected: true })] });
  assert.equal(rejectedHit.raw.hit, true);
  assert.equal(rejectedHit.verified.miss, true);
  const passReport = scoreCase(tcase, { report: 'VERDICT: PASS', findings: [jf(['lib/a.js:40'])] });
  assert.deepEqual([passReport.raw.hit, passReport.verified.hit, passReport.final.hit], [true, true, false]);
  const rows = aggregateScores([{ harness: 'h', model: 'm', scores: passReport }, { harness: 'h', model: 'm', scores: rejectedAlarm }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw.falseAlarms, 1);
});

test('scoring parses the report when findings are not injected', () => {
  const report = `\`\`\`findings-json\n${JSON.stringify({ findings: [{ id: 'F1', files: ['lib/a.js:41'], summary: 's' }] })}\n\`\`\`\n${fail}`;
  assert.equal(scoreCase(tcase, { report }).final.hit, true);
});

test('run --dry-run starts no model and runs only accepted cases', async () => {
  const dir = path.join(ISOLATED_DATA_DIR, 'eval-dry');
  writeCases(dir, [{ id: 'a:b', accepted: true, truth: [], diff: '' }, { id: 'c:d', accepted: false, truth: [], diff: '' }]);
  let started = 0;
  const client = { startDelegation: async () => { started += 1; }, getDelegation: async () => { started += 1; } };
  const lines = [];
  const code = await main(['run', '--harness', 'h', '--model', 'm', '--dry-run'], { dataDir: dir, client, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.equal(started, 0);
  assert.match(lines.join('\n'), /would review 1 accepted/);
  assert.equal(fs.existsSync(path.join(dir, 'reviewer-eval', 'results')), false);
});

test('run (non-dry) uses the delegation client for accepted cases only and scores the report', async () => {
  const calls = [];
  const client = {
    startDelegation: async (a) => { calls.push(a); return { delegation: { id: 'd1' } }; },
    getDelegation: async () => ({ status: 'completed', report: `\`\`\`findings-json\n${JSON.stringify({ findings: [{ id: 'F1', files: ['lib/a.js:40'], summary: 's' }] })}\n\`\`\`\n${fail}` }),
  };
  const out = await runEval({
    cases: [{ id: 'x:y', accepted: true, truth: [{ file: 'lib/a.js', line: 40 }], diff: 'd' }, { id: 'n:o', accepted: false }],
    harness: 'h', model: 'm', client, chatId: 'chat', sleep: async () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].assignment, 'review');
  assert.equal(calls[0].reviewSubject, 'code');
  assert.equal(out.results[0].scores.final.hit, true);
});

test('store round-trips cases', () => {
  const dir = path.join(ISOLATED_DATA_DIR, 'eval-store');
  writeCases(dir, [{ id: 'q', accepted: false }]);
  assert.deepEqual(readCases(dir), [{ id: 'q', accepted: false }]);
});

const okReport = (file) => `\`\`\`findings-json\n${JSON.stringify({ findings: [{ id: 'F1', files: [file], summary: 's' }] })}\n\`\`\`\n${fail}`;

test('F1: long hunk keeps its range; finding at the changed line scores same', () => {
  const longHunk = 'diff --git a/lib/a.js b/lib/a.js\n--- a/lib/a.js\n+++ b/lib/a.js\n@@ -40,12 +40,12 @@\n';
  const [parsed] = parseUnifiedDiff(longHunk);
  assert.deepEqual(parsed.hunks[0], { oldStart: 40, oldEnd: 51, newStart: 40, newEnd: 51 });
  const cases = extractCases({
    todos: [{ id: 'l', status: 'done', updated_at: '2026-11-01T00:00:00Z' }, { id: 'f', status: 'done', sourceTodoId: 'l', title: 't' }],
    passedReviewLeafIds: ['l'], readLeafDiff: (t) => (t.id === 'l' ? diff('lib/a.js', 1) : longHunk),
  });
  assert.deepEqual(cases[0].truth, [{ file: 'lib/a.js', line: 40, end: 51 }]);
  assert.equal(scoreCase(cases[0], { report: okReport('lib/a.js:49') }).raw.hit, true);
  assert.equal(scoreCase(cases[0], { report: okReport('lib/a.js:60') }).raw.hit, false);
});

test('F2: timeout, failed status and empty report are infra and excluded from counts', async () => {
  const mk = (row) => ({ startDelegation: async () => ({ delegation: { id: 'd' } }), getDelegation: async () => row });
  const cases = [{ id: 'x:y', accepted: true, truth: [{ file: 'lib/a.js', line: 40 }], diff: 'd' }];
  const run = (client, extra = {}) => runEval({ cases, harness: 'h', model: 'm', client, chatId: 'c', sleep: async () => {}, ...extra });
  const failed = await run(mk({ status: 'failed', report: okReport('lib/a.js:40') }));
  assert.equal(failed.results[0].infra.reason, 'failed');
  assert.equal(failed.results[0].scores, undefined);
  const empty = await run(mk({ status: 'completed', report: '  ' }));
  assert.equal(empty.results[0].infra.reason, 'empty-report');
  const slow = await run(mk({ status: 'running' }), { timeoutMs: 0 });
  assert.equal(slow.results[0].infra.reason, 'timeout');
  const good = await run(mk({ status: 'completed', report: okReport('lib/a.js:40') }));
  const rows = aggregateScores([...failed.results, ...empty.results, ...slow.results, ...good.results]);
  assert.equal(rows[0].cases, 1);
  assert.equal(rows[0].infra, 3);
  assert.equal(rows[0].raw.hits, 1);
});

test('F7: verified row only with rejection data', () => {
  const noRej = aggregateScores([{ harness: 'h', model: 'm', scores: scoreCase(tcase, { report: fail, findings: [jf(['lib/a.js:40'])] }) }]);
  assert.doesNotMatch(formatScoreTable(noRej), /\tverified\t/);
  const rej = aggregateScores([{ harness: 'h', model: 'm', scores: scoreCase(tcase, { report: fail, findings: [jf(['lib/b.js:1'], { rejected: true })] }) }]);
  assert.match(formatScoreTable(rej), /\tverified\t/);
});

test('F3: two runs on the same day keep separate files and one combined table', async () => {
  const dir = path.join(ISOLATED_DATA_DIR, 'eval-two-runs');
  writeCases(dir, [{ id: 'x:y', accepted: true, truth: [{ file: 'lib/a.js', line: 40 }], diff: 'd' }]);
  const client = {
    startDelegation: async () => ({ delegation: { id: 'd' } }),
    getDelegation: async () => ({ status: 'completed', report: okReport('lib/a.js:40') }),
  };
  const lines = [];
  const deps = { dataDir: dir, client, log: (l) => lines.push(l), now: () => new Date('2026-11-17T10:00:00Z') };
  assert.equal(await main(['run', '--harness', 'h1', '--model', 'm/1', '--chat', 'c', '--workspace', dir], { ...deps, listTodos: async () => [] }), 0);
  assert.equal(await main(['run', '--harness', 'h2', '--model', 'm2', '--chat', 'c', '--workspace', dir], { ...deps, listTodos: async () => [] }), 0);
  const files = fs.readdirSync(path.join(dir, 'reviewer-eval', 'results'));
  assert.equal(files.length, 2);
  assert.equal(readResultsForDate(dir, '2026-11-17').length, 2);
  const table = lines.at(-1);
  assert.match(table, /h1\/m\/1/);
  assert.match(table, /h2\/m2/);
});

test('R2/F6: run refuses without --chat, with an orchestrating chat, and when the server is down', async () => {
  const dir = path.join(ISOLATED_DATA_DIR, 'eval-refuse');
  writeCases(dir, [{ id: 'x:y', accepted: true, truth: [], diff: '' }]);
  const lines = [];
  const base = { dataDir: dir, client: { startDelegation: async () => { throw new Error('must not start'); } }, log: (l) => lines.push(l) };
  assert.equal(await main(['run', '--harness', 'h', '--model', 'm'], { ...base, listTodos: async () => [] }), 2);
  assert.match(lines.at(-1), /--chat/);
  const busy = [{ id: 'todo1', status: 'doing', orchestrator_chat_id: 'chat9' }];
  assert.equal(await main(['run', '--harness', 'h', '--model', 'm', '--chat', 'chat9'], { ...base, listTodos: async () => busy }), 2);
  assert.match(lines.at(-1), /dedicated chat/);
  const down = async () => { throw new Error('connect ECONNREFUSED'); };
  assert.equal(await main(['run', '--harness', 'h', '--model', 'm', '--chat', 'c'], { ...base, listTodos: down }), 2);
  assert.match(lines.at(-1), /^error: connect ECONNREFUSED$/);
});

test('F5: accepted case that cannot be regenerated is kept as stale', () => {
  const cases = extractCases({ todos: [], passedReviewLeafIds: [], readLeafDiff: () => '', existing: [{ id: 'gone:1', accepted: true }, { id: 'gone:2', accepted: false }] });
  assert.deepEqual(cases, [{ id: 'gone:1', accepted: true, stale: true }]);
});

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(ISOLATED_DATA_DIR, 'repo-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  git('commit', '-qam', 'leaf');
  return { repo, base, head: git('rev-parse', 'HEAD') };
}

test('F4: loadHistorySources selects PASS code reviews and reads diffs from leafMaterial', async () => {
  const { repo, base, head } = tempRepo();
  const rows = [
    { assignment: 'review', reviewSubject: 'code', report: 'VERDICT: PASS', leaf: 'LEAF1' },
    { assignment: 'review', reviewSubject: 'plan', report: 'VERDICT: PASS', leaf: 'plan1' },
    { assignment: 'review', reviewSubject: 'code', report: 'VERDICT: FAIL', leaf: 'failed1' },
    { assignment: 'implement', reviewSubject: 'code', report: 'VERDICT: PASS', leaf: 'impl1' },
  ];
  const todo = { id: 'leaf1', leafMaterial: { baseCommit: base, lastCheckpoint: { commit: head } } };
  const src = await loadHistorySources(repo, { todos: [todo] }, {
    listDelegations: () => rows, readLeafId: (r) => r.leaf,
    parseVerdict: (r) => String(r).replace('VERDICT: ', ''), runGit,
  });
  assert.deepEqual([...src.passedReviewLeafIds], ['leaf1']);
  const zero = parseUnifiedDiff(src.readLeafDiff(todo));
  assert.deepEqual(zero, [{ file: 'a.txt', hunks: [{ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }] }]);
  assert.match(src.readReviewDiff(todo), /^ one$/m);
  assert.equal(src.readPreFixCommit(todo), head);
  assert.equal(src.readLeafDiff({ id: 'nomaterial' }), '');
});

test('extract CLI path writes cases to the isolated data dir', async () => {
  const dir = path.join(ISOLATED_DATA_DIR, 'eval-extract');
  const todos = [{ id: 'l', status: 'done', updated_at: '2026-11-01T00:00:00Z' }, { id: 'f', status: 'done', sourceTodoId: 'l', title: 'fix' }];
  const lines = [];
  const code = await main(['extract', '--workspace', dir], {
    dataDir: dir, log: (l) => lines.push(l), listTodos: async () => todos,
    loadSources: async () => ({ passedReviewLeafIds: new Set(['l']), readLeafDiff: (t) => (t.id === 'l' ? diff('lib/a.js', 1) : diff('lib/a.js', 30)) }),
  });
  assert.equal(code, 0);
  assert.match(lines[0], /1 cases, 0 accepted/);
  assert.equal(readCases(dir)[0].accepted, false);
});

test('R1: pre-fix checkout is a detached worktree at the commit and is removed; OUT_OF_SCOPE aborts', async () => {
  const { repo, base, head } = tempRepo();
  const co = createPreFixCheckout({ repo, commit: base, runGit });
  assert.equal(fs.readFileSync(path.join(co.folder, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'one\ntwo\nthree\n');
  co.cleanup();
  assert.equal(fs.existsSync(co.folder), false);
  let folder = '';
  const client = {
    startDelegation: async (a) => { folder = a.workspaceFolder; const e = new Error('out'); e.code = 'OUT_OF_SCOPE'; throw e; },
    getDelegation: async () => null,
  };
  await assert.rejects(runEval({
    cases: [{ id: 'x:y', accepted: true, truth: [], diff: '', preFixCommit: head }], harness: 'h', model: 'm', client, chatId: 'c',
    prepareCheckout: (c) => createPreFixCheckout({ repo, commit: c.preFixCommit, runGit }),
  }), /OUT_OF_SCOPE/);
  assert.notEqual(folder, '');
  assert.equal(fs.existsSync(folder), false);
});
