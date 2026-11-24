/**
 * Unit tests for the deterministic triage queue
 * (lib/workspace-watcher-triage-signals.js): per signal threshold -1 / threshold /
 * threshold + 1, revision change resets the entry, the entry disappears when the
 * signal clears, and the queue survives a restart (re-read from the store).
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeTriageSignals,
  probeWorktreeBase,
  reconcileTriageQueue,
  refreshTriageQueue,
} from '../lib/workspace-watcher-triage-signals.js';
import { DEFAULT_TRIAGE_THRESHOLDS } from '../lib/workspace-watcher-triage-config.js';
import {
  getWorkspaceWatcher,
  invalidateWorkspaceWatchersCache,
  normalizeWorkspaceWatcherPolicy,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const iso = (ago) => new Date(NOW - ago).toISOString();
const TH = DEFAULT_TRIAGE_THRESHOLDS;
const signals = (input) => computeTriageSignals({ now: NOW, ...input }).map((c) => c.signal);

/** Run `build(age)` at threshold -1 / threshold (no signal) and threshold + 1 (signal). */
function assertBoundary(signal, threshold, build) {
  assert.deepEqual(signals(build(threshold - 1)), [], `${signal} below threshold`);
  assert.deepEqual(signals(build(threshold)), [], `${signal} at threshold (strictly above fires)`);
  assert.ok(signals(build(threshold + 1)).includes(signal), `${signal} above threshold`);
}

test('defaults: K = 20 commits and documented time thresholds', () => {
  assert.equal(TH.baseBehindCommits, 20);
  assert.equal(TH.staleDoingTreeMs, 7 * 86_400_000);
  assert.equal(TH.doneUnintegratedMs, 48 * 3_600_000);
  assert.equal(TH.planUnreviewedMs, 24 * 3_600_000);
  assert.equal(TH.planUnapprovedMs, 12 * 3_600_000);
  assert.equal(normalizeWorkspaceWatcherPolicy({}).triage.baseBehindCommits, 20);
  assert.equal(normalizeWorkspaceWatcherPolicy({ triage: { baseBehindCommits: 5 } }).triage.baseBehindCommits, 5);
});

test('stale_doing_tree', () => {
  assertBoundary('stale_doing_tree', TH.staleDoingTreeMs, (age) => ({ items: [
    { id: 'r', status: 'doing', updatedAt: iso(age + 1000) },
    { id: 'c', status: 'doing', parentId: 'r', updatedAt: iso(age) },
  ] }));
  // Fresh activity anywhere in the tree clears the signal.
  assert.deepEqual(signals({ items: [
    { id: 'r', status: 'doing', updatedAt: iso(TH.staleDoingTreeMs * 2) },
    { id: 'c', status: 'ready', parentId: 'r', updatedAt: iso(1000) },
  ] }), []);
});

test('tree_done_unintegrated', () => {
  assertBoundary('tree_done_unintegrated', TH.doneUnintegratedMs, (age) => ({ items: [
    { id: 'r', status: 'doing', executionMode: 'worktree', updatedAt: iso(age) },
    { id: 'a', status: 'done', parentId: 'r', updatedAt: iso(age) },
    { id: 'b', status: 'done', parentId: 'r', updatedAt: iso(age + 5000) },
  ] }));
  // One open leaf: not all leaves are done.
  assert.deepEqual(signals({ items: [
    { id: 'r', status: 'doing', executionMode: 'worktree' },
    { id: 'a', status: 'done', parentId: 'r', updatedAt: iso(TH.doneUnintegratedMs * 3) },
    { id: 'b', status: 'ready', parentId: 'r', updatedAt: iso(TH.doneUnintegratedMs * 3) },
  ] }), []);
});

test('leaf_done_unconfirmed', () => {
  assertBoundary('leaf_done_unconfirmed', TH.doneUnintegratedMs, (age) => ({ items: [
    { id: 'l', status: 'done', executionMode: 'worktree', integration: { state: 'rejected' }, updatedAt: iso(age) },
  ] }));
  assert.deepEqual(signals({ items: [
    { id: 'l', status: 'done', updatedAt: iso(TH.doneUnintegratedMs * 3) },
  ] }), [], 'a project-mode leaf without integration data is not a candidate');
});

test('plan_draft_unreviewed and plan_review_unapproved', () => {
  assertBoundary('plan_draft_unreviewed', TH.planUnreviewedMs, (age) => ({ items: [
    { id: 'p', status: 'idea', updatedAt: iso(age), plan: { markdown: '# plan', updatedAt: iso(age) }, review: { plan: { state: 'none' } } },
  ] }));
  assertBoundary('plan_review_unapproved', TH.planUnapprovedMs, (age) => ({ items: [
    { id: 'p', status: 'idea', updatedAt: iso(age), plan: { markdown: '# plan', updatedAt: iso(age * 2) }, review: { plan: { state: 'passed', updatedAt: iso(age) } } },
  ] }));
  const approved = { id: 'p', status: 'idea', plan: { markdown: '# plan', updatedAt: iso(TH.planUnreviewedMs * 2), approvedAt: iso(1000) }, review: { plan: { state: 'none' } } };
  assert.deepEqual(signals({ items: [approved] }), []);
});

test('leaf_needs_human and leaf_needs_rescope', () => {
  for (const [code, signal] of [['needs_human', 'leaf_needs_human'], ['needs_rescope', 'leaf_needs_rescope']]) {
    assertBoundary(signal, TH.needsHumanMs, (age) => ({
      items: [{ id: 'l', status: 'idea', blockedReason: 'waiting', updatedAt: iso(age) }],
      reports: [{ reportId: 'r', outcome: 'blocked', reasonCode: code, todoIds: ['l'], at: iso(age) }],
    }));
  }
  // Resolved (blockedReason cleared by a status change) -> no signal.
  assert.deepEqual(signals({
    items: [{ id: 'l', status: 'ready', updatedAt: iso(1000) }],
    reports: [{ reportId: 'r', outcome: 'blocked', reasonCode: 'needs_human', todoIds: ['l'], at: iso(TH.needsHumanMs * 3) }],
  }), []);
});

test('integration_ready_idle', () => {
  assertBoundary('integration_ready_idle', TH.integrationReadyMs, (age) => ({ items: [
    { id: 'l', status: 'doing', integration: { state: 'ready' }, updatedAt: iso(age) },
  ] }));
});

test('worktree_base_behind and worktree_patch_conflict', () => {
  const items = [{ id: 'r', status: 'doing', updatedAt: iso(1000) }];
  const records = [{ todoId: 'r', baseCommit: 'abc', updatedAt: iso(1000) }];
  const run = (probe) => signals({ items, worktreeRecords: records, baseProbes: { r: probe } });
  assert.deepEqual(run({ behind: TH.baseBehindCommits - 1, applies: true }), []);
  assert.deepEqual(run({ behind: TH.baseBehindCommits, applies: true }), []);
  assert.deepEqual(run({ behind: TH.baseBehindCommits + 1, applies: true }), ['worktree_base_behind']);
  assert.deepEqual(run({ behind: 0, applies: false }), ['worktree_patch_conflict']);
  assert.deepEqual(run({ behind: null, applies: null }), [], 'unknown probe result is not a signal');
  const custom = computeTriageSignals({ now: NOW, items, worktreeRecords: records, baseProbes: { r: { behind: 6 } }, thresholds: { baseBehindCommits: 5 } });
  assert.deepEqual(custom.map((c) => c.signal), ['worktree_base_behind']);
});

test('revision change resets the entry, a cleared signal removes it', () => {
  const mk = (updatedAt, status = 'doing') => computeTriageSignals({ now: NOW, items: [
    { id: 'l', status, integration: { state: 'ready' }, updatedAt },
  ] });
  const old = iso(TH.integrationReadyMs + 1000);
  const first = reconcileTriageQueue(null, mk(old), NOW - 60_000);
  assert.equal(first.entries.length, 1);
  const again = reconcileTriageQueue(first, mk(old), NOW);
  assert.equal(again.entries[0].firstSeenAt, first.entries[0].firstSeenAt, 'same revision keeps firstSeenAt');
  const newer = iso(TH.integrationReadyMs + 500);
  const reset = reconcileTriageQueue(again, mk(newer), NOW);
  assert.equal(reset.entries.length, 1);
  assert.notEqual(reset.entries[0].revision, again.entries[0].revision);
  assert.equal(reset.entries[0].firstSeenAt, new Date(NOW).toISOString(), 'new revision starts a new entry');
  const cleared = reconcileTriageQueue(reset, mk(iso(1000)), NOW);
  assert.deepEqual(cleared.entries, [], 'entry disappears when the signal clears');
});

test('queue is persisted, survives a restart and never changes the mode', async () => {
  const ws = '/tmp/cretli-triage-ws';
  upsertWorkspaceWatcher(ws, { mode: 'observe' });
  const items = [{ id: 'l', status: 'doing', integration: { state: 'ready' }, updatedAt: iso(TH.integrationReadyMs + 1000) }];
  const queue = await refreshTriageQueue(ws, { now: NOW, items, worktreeRecords: [] });
  assert.equal(queue.entries.length, 1);
  invalidateWorkspaceWatchersCache(); // simulated restart: drop in-memory caches, re-read from disk
  const row = getWorkspaceWatcher(ws);
  assert.equal(row.triageQueue.v, 1);
  assert.equal(row.triageQueue.entries[0].signal, 'integration_ready_idle');
  assert.equal(row.mode, 'observe');
  assert.deepEqual(row.activeCycles, [], 'no cycle is started because of the queue');
  const later = await refreshTriageQueue(ws, { now: NOW + 60_000, items, worktreeRecords: [] });
  assert.equal(later.entries[0].firstSeenAt, queue.entries[0].firstSeenAt, 'firstSeenAt survives the restart');
  const cleared = await refreshTriageQueue(ws, { now: NOW + 120_000, items: [], worktreeRecords: [] });
  assert.deepEqual(cleared.entries, []);
  assert.deepEqual(getWorkspaceWatcher(ws).triageQueue.entries, []);
});

// Per-signal scenarios: `fire(rev)` yields an input where the signal holds and the
// todo carrying it has revision `rev`; `clear` yields an input where it no longer holds.
const OLD = (extra = 0) => iso(TH.staleDoingTreeMs * 2 + extra);
const SCENARIOS = {
  stale_doing_tree: {
    fire: (rev) => ({ items: [{ id: 'r', status: 'doing', updatedAt: rev }, { id: 'c', status: 'doing', parentId: 'r', updatedAt: OLD() }] }),
    clear: (rev) => ({ items: [{ id: 'r', status: 'doing', updatedAt: rev }, { id: 'c', status: 'doing', parentId: 'r', updatedAt: iso(1000) }] }),
  },
  tree_done_unintegrated: {
    fire: (rev) => ({ items: [{ id: 'r', status: 'doing', executionMode: 'worktree', updatedAt: rev }, { id: 'a', status: 'done', parentId: 'r', updatedAt: OLD() }] }),
    clear: (rev) => ({ items: [{ id: 'r', status: 'doing', executionMode: 'worktree', updatedAt: rev }, { id: 'a', status: 'ready', parentId: 'r', updatedAt: OLD() }] }),
  },
  leaf_done_unconfirmed: {
    fire: (rev) => ({ items: [{ id: 'l', status: 'done', executionMode: 'worktree', integration: { state: 'rejected' }, updatedAt: rev }] }),
    clear: (rev) => ({ items: [{ id: 'l', status: 'done', updatedAt: rev }] }),
  },
  plan_draft_unreviewed: {
    fire: (rev) => ({ items: [{ id: 'p', status: 'idea', updatedAt: rev, plan: { markdown: '# p', updatedAt: OLD() }, review: { plan: { state: 'none' } } }] }),
    clear: (rev) => ({ items: [{ id: 'p', status: 'idea', updatedAt: rev, plan: { markdown: '# p', updatedAt: OLD(), approvedAt: iso(10) }, review: { plan: { state: 'none' } } }] }),
  },
  plan_review_unapproved: {
    fire: (rev) => ({ items: [{ id: 'p', status: 'idea', updatedAt: rev, plan: { markdown: '# p', updatedAt: OLD() }, review: { plan: { state: 'passed', updatedAt: OLD() } } }] }),
    clear: (rev) => ({ items: [{ id: 'p', status: 'idea', updatedAt: rev, plan: { markdown: '# p', updatedAt: OLD(), approvedAt: iso(10) }, review: { plan: { state: 'passed', updatedAt: OLD() } } }] }),
  },
  ...Object.fromEntries([['needs_human', 'leaf_needs_human'], ['needs_rescope', 'leaf_needs_rescope']].map(([code, signal]) => [signal, {
    fire: (rev) => ({ items: [{ id: 'l', status: 'idea', blockedReason: 'x', updatedAt: rev }], reports: [{ reportId: 'r', outcome: 'blocked', reasonCode: code, todoIds: ['l'], at: OLD() }] }),
    clear: (rev) => ({ items: [{ id: 'l', status: 'ready', updatedAt: rev }], reports: [{ reportId: 'r', outcome: 'blocked', reasonCode: code, todoIds: ['l'], at: OLD() }] }),
  }])),
  integration_ready_idle: {
    fire: (rev) => ({ items: [{ id: 'l', status: 'doing', integration: { state: 'ready' }, updatedAt: rev }] }),
    clear: (rev) => ({ items: [{ id: 'l', status: 'doing', integration: { state: 'integrated' }, updatedAt: rev }] }),
  },
  worktree_base_behind: {
    fire: (rev) => ({ items: [{ id: 'r', status: 'doing', updatedAt: rev }], worktreeRecords: [{ todoId: 'r', baseCommit: 'a' }], baseProbes: { r: { behind: 21, applies: true } } }),
    clear: (rev) => ({ items: [{ id: 'r', status: 'doing', updatedAt: rev }], worktreeRecords: [{ todoId: 'r', baseCommit: 'a' }], baseProbes: { r: { behind: 3, applies: true } } }),
  },
  worktree_patch_conflict: {
    fire: (rev) => ({ items: [{ id: 'r', status: 'doing', updatedAt: rev }], worktreeRecords: [{ todoId: 'r', baseCommit: 'a' }], baseProbes: { r: { behind: 0, applies: false } } }),
    clear: (rev) => ({ items: [{ id: 'r', status: 'doing', updatedAt: rev }], worktreeRecords: [{ todoId: 'r', baseCommit: 'a' }], baseProbes: { r: { behind: 0, applies: true } } }),
  },
};

for (const [signal, scenario] of Object.entries(SCENARIOS)) {
  test(`${signal}: root revision change resets the entry, clearing removes it`, () => {
    const compute = (input) => computeTriageSignals({ now: NOW, ...input }).filter((c) => c.signal === signal);
    const revA = iso(TH.staleDoingTreeMs * 3);
    const revB = iso(TH.staleDoingTreeMs * 3 - 1000);
    const first = reconcileTriageQueue(null, compute(scenario.fire(revA)), NOW - 60_000);
    assert.equal(first.entries.length, 1, 'signal fires');
    assert.equal(first.entries[0].revision, revA, 'revision is the todo\'s own updatedAt');
    const same = reconcileTriageQueue(first, compute(scenario.fire(revA)), NOW);
    assert.equal(same.entries[0].firstSeenAt, first.entries[0].firstSeenAt, 'same revision is deduplicated');
    const reset = reconcileTriageQueue(same, compute(scenario.fire(revB)), NOW);
    assert.equal(reset.entries.length, 1);
    assert.notEqual(reset.entries[0].key, first.entries[0].key);
    assert.equal(reset.entries[0].firstSeenAt, new Date(NOW).toISOString(), 'revision change starts a new entry');
    assert.deepEqual(reconcileTriageQueue(reset, compute(scenario.clear(revB)), NOW).entries, [], 'entry removed when the signal clears');
  });
}

test('a done root with all leaves done and no integration evidence still raises tree_done_unintegrated', async () => {
  const items = [
    { id: 'r', status: 'done', executionMode: 'worktree', updatedAt: iso(TH.doneUnintegratedMs * 2) },
    { id: 'a', status: 'done', parentId: 'r', updatedAt: iso(TH.doneUnintegratedMs * 2) },
  ];
  assert.deepEqual(signals({ items }), ['tree_done_unintegrated']);
  // Root without executionMode but with a live registry record (a done root has no probe).
  const inherit = [{ ...items[0], executionMode: 'inherit' }, items[1]];
  const ws = '/tmp/cretli-triage-ws-done-root';
  upsertWorkspaceWatcher(ws, { mode: 'observe' });
  const queue = await refreshTriageQueue(ws, { now: NOW, items: inherit, worktreeRecords: [{ todoId: 'r', baseCommit: 'a' }] });
  assert.deepEqual(queue.entries.map((e) => e.signal), ['tree_done_unintegrated']);
});

test('probeWorktreeBase tests the real worktree change set against HEAD (real git)', async () => {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  const build = (headChange, wtChange) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-triage-git-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const wt = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'leaf', wt, base);
    wtChange(wt);
    headChange(repo);
    return { repo, wt, base, root };
  };
  const commit = (repo, msg) => { git(repo, 'add', '.'); git(repo, 'commit', '-qm', msg); };
  const write = (dir, file, body) => fs.writeFileSync(path.join(dir, file), body);
  const probe = async (fx) => probeWorktreeBase({ repoRoot: fx.repo, worktreePath: fx.wt, baseCommit: fx.base, branch: 'leaf' });
  const indexBefore = (fx) => git(fx.repo, 'status', '--porcelain');

  // Uncommitted tracked change conflicting with a HEAD commit (branch tip == base!).
  const conflict = build((r) => { write(r, 'a.txt', 'theirs\n'); commit(r, 'head'); }, (w) => write(w, 'a.txt', 'mine\n'));
  const before = indexBefore(conflict);
  const c = await probe(conflict);
  assert.equal(c.behind, 1);
  assert.equal(c.applies, false, 'uncommitted conflicting change is detected');
  assert.equal(indexBefore(conflict), before, 'repo untouched');
  assert.equal(fs.readFileSync(path.join(conflict.repo, 'a.txt'), 'utf8'), 'theirs\n');

  // Untracked new file that HEAD also added.
  const untracked = build((r) => { write(r, 'new.txt', 'head\n'); commit(r, 'head'); }, (w) => write(w, 'new.txt', 'mine\n'));
  assert.equal((await probe(untracked)).applies, false, 'conflicting untracked file is detected');

  // Disjoint change applies; clean worktree with an empty diff also applies.
  const disjoint = build((r) => { write(r, 'b.txt', 'changed\n'); commit(r, 'head'); }, (w) => write(w, 'a.txt', 'mine\n'));
  assert.equal((await probe(disjoint)).applies, true);
  const clean = build((r) => { write(r, 'b.txt', 'changed\n'); commit(r, 'head'); }, () => {});
  const cr = await probe(clean);
  assert.equal(cr.applies, true);
  assert.equal(cr.behind, 1);

  // Missing worktree: unknown, not a signal.
  fs.rmSync(clean.wt, { recursive: true, force: true });
  assert.equal((await probe(clean)).applies, null);
  for (const fx of [conflict, untracked, disjoint, clean]) fs.rmSync(fx.root, { recursive: true, force: true });
});
