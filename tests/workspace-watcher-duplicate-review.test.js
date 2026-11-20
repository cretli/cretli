import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, loadTodosData } from '../lib/persist/todos-legacy-adapter.js';
import { upsertWorkspaceWatcher, normalizeWorkspaceWatcherPolicy, getWorkspaceWatcher, mutateWorkspaceWatcherRow } from '../lib/persist/workspace-watchers-persist.js';
import {
  findDuplicateGroups, reviewDuplicateTodos, decideDuplicateProposal, listDuplicateProposals,
} from '../lib/workspace-watcher-duplicate-review.js';

function fixture(policy = { duplicateReview: true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-dup-review-'));
  const dataDir = path.join(root, 'store');
  const workspaceFolder = path.join(root, 'workspace');
  fs.mkdirSync(workspaceFolder);
  upsertWorkspaceWatcher(workspaceFolder, { mode: 'observe', policy }, { dataDir });
  const add = (title, status = 'idea', body = '') => addTodo(dataDir, workspaceFolder, { title, status, body }).item;
  const items = () => loadTodosData(dataDir, workspaceFolder).items;
  const notices = [];
  const notify = (n) => notices.push(n);
  return { dataDir, workspaceFolder, add, items, notices, notify, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('policy defaults to disabled', () => {
  assert.equal(normalizeWorkspaceWatcherPolicy({}).duplicateReview, false);
  assert.equal(normalizeWorkspaceWatcherPolicy({ duplicateReview: 'yes' }).duplicateReview, false);
  assert.equal(normalizeWorkspaceWatcherPolicy({ duplicateReview: true }).duplicateReview, true);
});

test('detects exact title and stall-signature duplicates only among open todos', () => {
  const items = [
    { id: 'a', title: 'Fix  Thing', status: 'ready', createdAt: '1' },
    { id: 'b', title: 'fix thing', status: 'idea', createdAt: '2' },
    { id: 'c', title: 'fix thing', status: 'done', createdAt: '3' },
    { id: 'd', title: 'Other one', status: 'idea', createdAt: '4', body: 'x\nstall-signature: s1' },
    { id: 'e', title: 'Different title', status: 'idea', createdAt: '5', body: 'stall-signature: s1' },
    { id: 'f', title: 'Almost fix thing!', status: 'idea', createdAt: '6' },
  ];
  const groups = findDuplicateGroups(items);
  assert.equal(groups.length, 2);
  const title = groups.find((g) => g.kind === 'title');
  assert.equal(title.keepId, 'a');
  assert.deepEqual(title.duplicateIds, ['b']);
  assert.equal(groups.find((g) => g.kind === 'signature').keepId, 'd');
});

test('disabled by default: no proposals, no notices', async () => {
  const f = fixture({});
  try {
    f.add('Same'); f.add('Same');
    const result = await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify });
    assert.equal(result.skipped, 'disabled');
    assert.equal(f.notices.length, 0);
    assert.equal(listDuplicateProposals(f.workspaceFolder, { dataDir: f.dataDir }).length, 0);
  } finally { f.cleanup(); }
});

test('enabled: proposes once, notifies, logs Why, closes nothing; human defer approves', async () => {
  const f = fixture();
  try {
    const keep = f.add('Event-loop stall: writeJsonAtomic (x.js)');
    const dup = f.add('Event-loop stall: writeJsonAtomic (x.js)');
    const running = f.add('Event-loop stall: writeJsonAtomic (x.js)', 'doing');
    const first = await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify });
    assert.equal(first.proposed.length, 1);
    assert.equal(f.notices.length, 1);
    const row = getWorkspaceWatcher(f.workspaceFolder, { dataDir: f.dataDir });
    assert.ok(row.decisions.some((d) => d.kind === 'duplicate_proposal' && d.reason.includes('awaiting human decision')));
    // No automatic status change.
    assert.deepEqual(f.items().map((t) => t.status).sort(), ['doing', 'idea', 'idea']);
    // Second pass does not re-propose.
    assert.equal((await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify })).proposed.length, 0);
    assert.equal(f.notices.length, 1);

    const proposal = first.proposed[0];
    assert.equal(proposal.keepId, running.id);
    assert.deepEqual(proposal.duplicateIds.sort(), [keep.id, dup.id].sort());
    const decided = await decideDuplicateProposal(f.workspaceFolder, proposal.id, 'defer', { dataDir: f.dataDir });
    assert.equal(decided.ok, true);
    assert.deepEqual(f.items().map((t) => t.status).sort(), ['deferred', 'deferred', 'doing']);
    assert.equal(f.items().length, 3);
    assert.equal((await decideDuplicateProposal(f.workspaceFolder, proposal.id, 'defer', { dataDir: f.dataDir })).ok, false);
  } finally { f.cleanup(); }
});

test('dismiss keeps todos untouched and the group is not proposed again', async () => {
  const f = fixture();
  try {
    f.add('Same'); f.add('Same');
    const { proposed } = await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify });
    const decided = await decideDuplicateProposal(f.workspaceFolder, proposed[0].id, 'dismiss', { dataDir: f.dataDir });
    assert.equal(decided.proposal.status, 'dismissed');
    assert.deepEqual(f.items().map((t) => t.status), ['idea', 'idea']);
    assert.equal((await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify })).proposed.length, 0);
    await assert.rejects(() => decideDuplicateProposal(f.workspaceFolder, 'x', 'close', { dataDir: f.dataDir }));
  } finally { f.cleanup(); }
});

import { createServerStallWatchdog } from '../lib/server-health/server-stall-watchdog.js';
import { updateTodo } from '../lib/persist/todos-legacy-adapter.js';

test('F1: stall occurrence counter survives real persistence readback and changelog trimming', async () => {
  const f = fixture();
  try {
    let captured;
    createServerStallWatchdog({
      repoRoot: f.workspaceFolder, dataDir: f.dataDir,
      addTodo: () => {}, publishNotification: () => {},
      listTodos: async () => loadTodosData(f.dataDir, f.workspaceFolder),
      createWatchdog: (options) => { captured = options; return {}; },
    });
    const todo = f.add('Event-loop stall: fn (x.js)', 'idea', 'body\nstall-signature: sig1');
    const info = { signature: 'sig1', detectedAt: 'T', stalledForMs: 5, reason: 'heartbeat' };
    for (let i = 0; i < 40; i += 1) {
      await captured.onDuplicate(f.items().find((t) => t.id === todo.id), info);
    }
    const after = f.items().find((t) => t.id === todo.id);
    assert.match(after.body, /^stall-occurrences: 41$/m);
    assert.match(after.changelog.at(-1).text, /occurrence #41 /);
    assert.equal(after.body.match(/stall-signature: sig1/g).length, 1);
  } finally { f.cleanup(); }
});

test('F2: stale proposal (title edited, keeper gone) changes nothing', async () => {
  const f = fixture();
  try {
    const keep = f.add('Same'); const dup = f.add('Same');
    const { proposed } = await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify });
    updateTodo(f.dataDir, f.workspaceFolder, dup.id, { title: 'Now unique' });
    const result = await decideDuplicateProposal(f.workspaceFolder, proposed[0].id, 'defer', { dataDir: f.dataDir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale');
    assert.deepEqual(f.items().map((t) => t.status), ['idea', 'idea']);
    assert.equal(listDuplicateProposals(f.workspaceFolder, { dataDir: f.dataDir })[0].status, 'stale');
    assert.ok(getWorkspaceWatcher(f.workspaceFolder, { dataDir: f.dataDir }).decisions.some((d) => d.reason.includes('stale')));
    void keep;
  } finally { f.cleanup(); }
});

test('F3: duplicate containers are never proposed, so descendants are not cascade-deferred', async () => {
  const f = fixture();
  try {
    f.add('Same');
    const container = f.add('Same');
    const child = addTodo(f.dataDir, f.workspaceFolder, { title: 'Unique child', status: 'idea', parentId: container.id }).item;
    const groups = findDuplicateGroups(f.items());
    assert.equal(groups.length, 0);
    await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify });
    assert.equal(f.items().find((t) => t.id === child.id).status, 'idea');
  } finally { f.cleanup(); }
});

test('F4: concurrent defer/dismiss yields one winner with consistent audit; partial defer is resumable', async () => {
  const f = fixture();
  try {
    f.add('Same'); f.add('Same'); f.add('Same');
    const { proposed } = await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify });
    const id = proposed[0].id;
    const [a, b] = await Promise.all([
      decideDuplicateProposal(f.workspaceFolder, id, 'defer', { dataDir: f.dataDir }),
      decideDuplicateProposal(f.workspaceFolder, id, 'dismiss', { dataDir: f.dataDir }),
    ]);
    assert.equal([a, b].filter((r) => r.ok).length, 1);
    const final = listDuplicateProposals(f.workspaceFolder, { dataDir: f.dataDir })[0].status;
    const deferredCount = f.items().filter((t) => t.status === 'deferred').length;
    assert.equal(final === 'deferred', deferredCount === 2);
    assert.equal(final === 'dismissed', deferredCount === 0);
    const decisions = getWorkspaceWatcher(f.workspaceFolder, { dataDir: f.dataDir }).decisions.filter((d) => d.kind === 'duplicate_decision');
    assert.equal(decisions.length, 1);
  } finally { f.cleanup(); }
});

test('F4: a partially applied defer (status applying) blocks dismiss and resumes on retry', async () => {
  const f = fixture();
  try {
    f.add('Same'); f.add('Same'); f.add('Same');
    const { proposed } = await reviewDuplicateTodos(f.workspaceFolder, { dataDir: f.dataDir, notify: f.notify });
    const [first, second] = proposed[0].duplicateIds;
    const todo = f.items().find((t) => t.id === first);
    updateTodo(f.dataDir, f.workspaceFolder, first, { status: 'deferred', expectedUpdatedAt: todo.updatedAt });
    mutateWorkspaceWatcherRow(f.workspaceFolder, ({ row }) => ({
      duplicateProposals: row.duplicateProposals.map((e) => ({ ...e, status: 'applying', deferredIds: [first] })),
    }), { dataDir: f.dataDir });
    assert.equal((await decideDuplicateProposal(f.workspaceFolder, proposed[0].id, 'dismiss', { dataDir: f.dataDir })).ok, false);
    const resumed = await decideDuplicateProposal(f.workspaceFolder, proposed[0].id, 'defer', { dataDir: f.dataDir });
    assert.equal(resumed.ok, true);
    assert.deepEqual(resumed.deferred.sort(), [first, second].sort());
    assert.equal(f.items().filter((t) => t.status === 'deferred').length, 2);
  } finally { f.cleanup(); }
});
