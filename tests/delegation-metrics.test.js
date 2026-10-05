/**
 * Per-delegation run metrics (task "Metryki per delegacja"). Covers the pure
 * helpers in `lib/delegation-metrics.js` and the SDK tool-call counter in
 * `lib/sdk/sdk-run-tool-activity.js` that feeds `tool_calls_n`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DELEGATION_METRICS_FIELDS,
  buildRunMetrics,
  captureGitSnapshot,
  diffGitSnapshots,
  emptyMetrics,
  isExecuteAssignment,
  isMetricsEmpty,
  normalizeMetrics,
  parseNumstat,
} from '../lib/delegation-metrics.js';
import {
  hasOpenSdkRunTools,
  noteSdkRunToolActivity,
  resetSdkRunToolActivity,
} from '../lib/sdk/sdk-run-tool-activity.js';
import { collectRoomDelegationMetrics } from '../lib/delegation-run-bridge.js';
import { beginHarnessRun } from '../lib/usage/harness-usage.js';

// --- emptyMetrics / normalizeMetrics -----------------------------------------
const blank = emptyMetrics();
assert.deepEqual(Object.keys(blank), [...DELEGATION_METRICS_FIELDS]);
assert.ok(DELEGATION_METRICS_FIELDS.every((field) => blank[field] === null));
assert.equal(isMetricsEmpty(blank), true);
assert.equal(isMetricsEmpty({ ...blank, tokens_out: 0 }), false, 'an explicit 0 is data, not empty');

assert.deepEqual(normalizeMetrics(null), blank, 'a missing metrics object becomes the all-null shape');
assert.deepEqual(normalizeMetrics('nope'), blank);
assert.deepEqual(normalizeMetrics([1, 2]), blank, 'an array is not a metrics object');

assert.equal(normalizeMetrics({ tokens_in: '100' }).tokens_in, 100, 'numeric strings coerce');
assert.equal(normalizeMetrics({ tokens_out: -5 }).tokens_out, null, 'a negative count is invalid');
assert.equal(normalizeMetrics({ tool_calls_n: 3.6 }).tool_calls_n, 4, 'counts round to integers');
assert.equal(normalizeMetrics({ tokens_out_per_sec: 12.34567 }).tokens_out_per_sec, 12.3457,
  'the rate keeps four decimals');
assert.equal(normalizeMetrics({ tokens_out_per_sec: -0.1 }).tokens_out_per_sec, null);
const stripped = normalizeMetrics({ tokens_out: 5, bogus: 9, harness: 'x' });
assert.equal(stripped.tokens_out, 5);
assert.ok(!('bogus' in stripped) && !('harness' in stripped), 'unknown keys are dropped');
assert.deepEqual(Object.keys(stripped), [...DELEGATION_METRICS_FIELDS]);

// --- isExecuteAssignment -----------------------------------------------------
assert.equal(isExecuteAssignment('implement'), true);
assert.equal(isExecuteAssignment('Fix'), true, 'assignment matching is case-insensitive');
assert.equal(isExecuteAssignment('  review  '), false);
assert.equal(isExecuteAssignment('plan'), false);
assert.equal(isExecuteAssignment(''), false);
assert.equal(isExecuteAssignment(null), false);

// --- buildRunMetrics ---------------------------------------------------------
const built = buildRunMetrics({
  tokensIn: 1000,
  tokensOut: 500,
  toolCalls: 7,
  filesChanged: 2,
  linesAdded: 30,
  linesRemoved: 4,
  startedAtMs: 0,
  finishedAtMs: 10_000,
});
assert.equal(built.tokens_in, 1000);
assert.equal(built.tokens_out, 500);
assert.equal(built.tokens_out_per_sec, 50, '500 output tokens over 10s = 50/s');
assert.equal(built.tool_calls_n, 7);
assert.equal(built.files_changed, 2);
assert.equal(built.lines_added, 30);
assert.equal(built.lines_removed, 4);

assert.equal(buildRunMetrics({ tokensOut: 500 }).tokens_out_per_sec, null,
  'no duration suppresses the rate rather than dividing');
assert.equal(buildRunMetrics({ tokensOut: 500, startedAtMs: 5, finishedAtMs: 5 }).tokens_out_per_sec, null,
  'a zero-length run has no rate');
assert.equal(buildRunMetrics({ tokensOut: 500, startedAtMs: 10_000, finishedAtMs: 0 }).tokens_out_per_sec, null,
  'an out-of-order finish is ignored');
assert.equal(buildRunMetrics({ startedAtMs: 0, finishedAtMs: 10_000 }).tokens_out_per_sec, null,
  'no output tokens means no rate even with a duration');
assert.deepEqual(buildRunMetrics(), blank, 'an all-missing run yields the null shape');

// --- parseNumstat ------------------------------------------------------------
const parsed = parseNumstat([
  '10\t2\tlib/a.js',
  '-\t-\tassets/logo.png',
  '0\t0\tunchanged-but-listed.js',
  '5\t1\tlib/with space.js',
  'malformed line',
  '',
].join('\n'));
assert.deepEqual(parsed['lib/a.js'], { added: 10, removed: 2 });
assert.deepEqual(parsed['assets/logo.png'], { added: null, removed: null }, 'binary keeps the path, no counts');
assert.deepEqual(parsed['lib/with space.js'], { added: 5, removed: 1 }, 'path may contain spaces');
assert.ok(!('malformed line' in parsed), 'a line without two tabs is skipped');

// --- diffGitSnapshots --------------------------------------------------------
assert.equal(diffGitSnapshots(null, { files: {}, untracked: [] }), null, 'a missing baseline yields no data');
assert.equal(diffGitSnapshots({ files: {}, untracked: [] }, null), null, 'a missing head yields no data');

// Pre-existing dirty file (base) is NOT attributed to the run; only the delta is.
assert.deepEqual(
  diffGitSnapshots(
    { files: { 'x.js': { added: 10, removed: 2 } }, untracked: ['pre.ts'] },
    { files: { 'x.js': { added: 14, removed: 2 } }, untracked: ['pre.ts'] },
  ),
  { files_changed: 1, lines_added: 4, lines_removed: 0 },
  'only the 4 added lines in x.js are this run, the pre-existing 10 are not',
);

// A file the run newly edits (absent from the baseline diff) contributes fully.
assert.deepEqual(
  diffGitSnapshots(
    { files: { 'x.js': { added: 10, removed: 2 } }, untracked: [] },
    { files: { 'x.js': { added: 10, removed: 2 }, 'new.js': { added: 5, removed: 0 } }, untracked: [] },
  ),
  { files_changed: 1, lines_added: 5, lines_removed: 0 },
  'a tracked file that first appears in the head diff is a new change',
);

// A run that deletes lines counts them; a run that reverts to base counts nothing.
assert.deepEqual(
  diffGitSnapshots(
    { files: { 'a.js': { added: 3, removed: 1 } }, untracked: [] },
    { files: { 'a.js': { added: 3, removed: 6 } }, untracked: [] },
  ),
  { files_changed: 1, lines_added: 0, lines_removed: 5 },
);
assert.deepEqual(
  diffGitSnapshots(
    { files: { 'a.js': { added: 3, removed: 1 } }, untracked: [] },
    { files: { 'a.js': { added: 3, removed: 1 } }, untracked: [] },
  ),
  { files_changed: 0, lines_added: 0, lines_removed: 0 },
  'an unchanged tree is zero, not null',
);

// Run reverts a pre-existing dirty file back to HEAD: the path still moved, but line deltas are zero.
assert.deepEqual(
  diffGitSnapshots(
    { files: { 'dirty.js': { added: 10, removed: 2 } }, untracked: [] },
    { files: {}, untracked: [] },
  ),
  { files_changed: 1, lines_added: 0, lines_removed: 0 },
  'reverting dirty work to HEAD counts the file, not phantom line churn',
);

// Newly created untracked files count as changed; deleted ones too.
assert.deepEqual(
  diffGitSnapshots(
    { files: {}, untracked: ['gone.ts'] },
    { files: {}, untracked: ['made.ts'] },
  ),
  { files_changed: 2, lines_added: 0, lines_removed: 0 },
  'untracked add and untracked delete each move files_changed',
);

// --- captureGitSnapshot degrades to null off a repo --------------------------
assert.equal(captureGitSnapshot(''), null, 'an empty folder is not a snapshot');
assert.equal(captureGitSnapshot('/no/such/dir-cretli-test'), null, 'a missing dir is not a repo');

// --- SDK tool-call counter ---------------------------------------------------
const room = {};
resetSdkRunToolActivity(room);
assert.equal(room._toolCallsTotal, 0, 'reset zeroes the counter');

noteSdkRunToolActivity(room, { type: 'tool_call', call_id: 'c1' });
assert.equal(room._toolCallsTotal, 0, 'an open tool_call is not counted');
assert.equal(hasOpenSdkRunTools(room), true);

noteSdkRunToolActivity(room, { type: 'tool_result', call_id: 'c1' });
assert.equal(room._toolCallsTotal, 1, 'a tool_result closes and counts one call');
assert.equal(hasOpenSdkRunTools(room), false, 'closing clears the idle guard set');

noteSdkRunToolActivity(room, { type: 'tool_result', name: 'Bash' });
assert.equal(room._toolCallsTotal, 2, 'a name-only result still counts');

noteSdkRunToolActivity(room, { type: 'tool_result' });
assert.equal(room._toolCallsTotal, 3, 'even a result without id/name counts once');

noteSdkRunToolActivity(room, { type: 'message' });
assert.equal(room._toolCallsTotal, 3, 'non-tool events are ignored');

resetSdkRunToolActivity(room);
assert.equal(room._toolCallsTotal, 0, 'a new run restarts the tally');

// --- collectRoomDelegationMetrics (SDK tool_calls_n) -------------------------
const sdkRoom = { _toolCallsTotal: 5, _lastUsagePayload: { inputTokens: 100, outputTokens: 50 } };
const implementMetrics = collectRoomDelegationMetrics(sdkRoom, {
  assignment: 'implement',
  executor: { transport: 'sdk' },
});
assert.equal(implementMetrics.tool_calls_n, 5, 'implement records tool_calls_n on SDK');
assert.equal(implementMetrics.tokens_in, 100);

const reviewMetrics = collectRoomDelegationMetrics(sdkRoom, {
  assignment: 'review',
  executor: { transport: 'sdk' },
});
assert.equal(reviewMetrics.tool_calls_n, null, 'review leaves tool_calls_n null on SDK');
assert.equal(reviewMetrics.tokens_in, 100, 'token fields are still collected for review');

const planMetrics = collectRoomDelegationMetrics(sdkRoom, {
  assignment: 'plan',
  executor: { transport: 'sdk' },
});
assert.equal(planMetrics.tool_calls_n, null, 'plan leaves tool_calls_n null on SDK');

// --- collectRoomDelegationMetrics (DeepSeek token snapshot) ------------------
// A deepseek room's `_lastUsagePayload` (accumulated by the DeepSeek room usage
// path across DSH steps) must reach the card instead of staying null.
const deepseekRoom = { _lastUsagePayload: { inputTokens: 350, outputTokens: 55 } };
const deepseekMetrics = collectRoomDelegationMetrics(deepseekRoom, {
  assignment: 'implement',
  executor: { transport: 'deepseek' },
});
assert.equal(deepseekMetrics.tokens_in, 350, 'deepseek reports the run input tokens');
assert.equal(deepseekMetrics.tokens_out, 55, 'deepseek reports the run output tokens');
assert.equal(deepseekMetrics.tool_calls_n, null, 'deepseek tracks no tool-call tally');

const emptyDeepseekMetrics = collectRoomDelegationMetrics({}, {
  assignment: 'implement',
  executor: { transport: 'deepseek' },
});
assert.equal(emptyDeepseekMetrics.tokens_in, null, 'no snapshot stays null, never a fabricated 0');
assert.equal(emptyDeepseekMetrics.tokens_out, null);

// --- beginHarnessRun clears stale SDK usage snapshot -------------------------
const usageRoom = { _lastUsagePayload: { inputTokens: 999, outputTokens: 888 }, _lastRecordedUsageTokens: { textInput: 1 } };
beginHarnessRun(usageRoom);
assert.equal(usageRoom._lastUsagePayload, null, 'a new run drops the previous usage payload');
assert.equal(usageRoom._lastRecordedUsageTokens, null, 'recorded token baseline resets too');

// --- git integration against a throwaway repo --------------------------------
// Proves `captureGitSnapshot` parses real `git diff --numstat` / `ls-files`
// output and that `diffGitSnapshots` attributes only the run's edits. The repo
// is created fresh in tmp, so this is isolated from the shared worktree.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-metrics-git-'));
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'tracked.js'), 'a\nb\nc\n');
  git(['add', 'tracked.js']);
  git(['commit', '-q', '-m', 'base']);
  return dir;
}

try {
  const dir = makeRepo();
  // Someone else's pre-existing edit sits in the tree before the run starts.
  fs.writeFileSync(path.join(dir, 'tracked.js'), 'a\nb\nc\npre\n');
  fs.writeFileSync(path.join(dir, 'other.ts'), 'pre-existing untracked\n');

  const base = captureGitSnapshot(dir);
  assert.ok(base && base.files && Array.isArray(base.untracked), 'a real repo yields a snapshot');
  assert.equal(base.untracked.includes('other.ts'), true, 'untracked files are listed');

  // The run edits a tracked file (adds 2, removes 1) and creates one new file.
  fs.writeFileSync(path.join(dir, 'tracked.js'), 'a\nX\nc\npre\nnew\nnew2\n');
  fs.writeFileSync(path.join(dir, 'made-by-run.ts'), 'created\n');

  const head = captureGitSnapshot(dir);
  const delta = diffGitSnapshots(base, head);
  assert.ok(delta, 'a snapshot pair diffs to data, not null');
  assert.ok(delta.files_changed >= 2,
    `the edited tracked file and the new file are both counted (got ${delta.files_changed})`);
  assert.ok(delta.lines_added >= 2, 'added lines are attributed to the run');
  assert.equal(typeof delta.lines_removed, 'number');

  // An unedited run reports zero churn (never a wrong non-zero, never null).
  const same = diffGitSnapshots(head, captureGitSnapshot(dir));
  assert.deepEqual(same, { files_changed: 0, lines_added: 0, lines_removed: 0 });

  fs.rmSync(dir, { recursive: true, force: true });
} catch (err) {
  // Git must exist for this suite; surface the real cause instead of a false OK.
  if (String(err?.message || '').includes('ENOENT')) throw new Error('git binary required for delegation-metrics.test.js');
  throw err;
}

console.log('delegation-metrics.test.js OK');
