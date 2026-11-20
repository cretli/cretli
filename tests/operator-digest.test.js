import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildOperatorDigest,
  collectOperatorDigestForWorkspace,
  collectOperatorDigestState,
  createOperatorDigestJob,
  digestDayKey,
  emptyOperatorDigestState,
  mergeOperatorDigestStates,
  publishOperatorDigest,
  scrubPaths,
} from '../lib/notifications/operator-digest-producer.ts';
import { listNotifications } from '../lib/notifications/notification-store.ts';
import { createPeriodicJobRunner } from '../lib/periodic-job-runner.js';
import { addTodo, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';

const POLICY = { requirePlanApproval: true };
const FEEDBACK = { kind: 'extracted', rootId: 'fb', reportId: 'rep' };
const todos = [
  { id: 'b2', title: 'Needs plan', status: 'ready', plan: { markdown: '# p' } },
  { id: 'a1', title: 'Approved parent', status: 'ready', plan: { markdown: '# p', approvedAt: '2026-01-01T00:00:00Z' } },
  { id: 'a2', parentId: 'a1', title: 'Child under approved', status: 'ready', plan: { markdown: '# c' } },
  { id: 'c3', title: 'Failed review', status: 'doing', review: { code: { state: 'failed' } } },
  { id: 'd4', title: 'Parked', status: 'idea', blockedReason: 'needs_human: pick one' },
  { id: 'e5', title: 'Done thing', status: 'done', review: { code: { state: 'failed' } } },
];

test('digest is deterministic and lists every waiting category', () => {
  const watcher = { policy: POLICY, stopReason: 'loop_no_eligible_work', lastBlocked: { todoId: 'd4', reasonCode: 'needs_human' } };
  const build = (items) => buildOperatorDigest(mergeOperatorDigestStates([collectOperatorDigestForWorkspace(items, watcher, '/home/someone/work/acme-app')]));
  const digest = build(todos);
  assert.deepEqual(digest, build([...todos].reverse()), 'input order does not change the text');
  assert.equal(digest.title, 'Waiting for you: 5 items');
  assert.match(digest.body, /Plans to approve: 1\n- Needs plan \[b2\]/);
  assert.match(digest.body, /Failed reviews to handle: 1\n- Failed review \[c3\]/);
  assert.match(digest.body, /Needs a human decision: 1\n- Parked \[d4\]/);
  assert.match(digest.body, /Blocked trees: 1/);
  assert.match(digest.body, /Stopped watchers: 1\n- acme-app: loop_no_eligible_work/);
  assert.doesNotMatch(digest.body, /Child under approved|Done thing/);
});

const plans = (items, policy = POLICY) => collectOperatorDigestForWorkspace(items, { policy }, '/x/ws').plansToApprove.map((i) => i.id);

test('plans to approve follow the shared plan gate', () => {
  // Feedback-derived with its own unapproved plan still waits under an approved ancestor.
  const parent = { id: 'p', title: 'Parent', status: 'ready', plan: { markdown: '# p', approvedAt: '2026-01-01T00:00:00Z' } };
  const feedback = { id: 'f1', parentId: 'p', title: 'Feedback leaf', status: 'ready', feedbackOrigin: FEEDBACK, plan: { markdown: '# f' } };
  assert.ok(plans([parent, feedback]).includes('f1'));
  // requirePlanApproval=false lists no ordinary draft, but keeps the feedback exception.
  const draft = { id: 'd1', title: 'Draft', status: 'ready', plan: { markdown: '# d' } };
  assert.deepEqual(plans([draft], { requirePlanApproval: false }), []);
  assert.deepEqual(plans([draft, { ...feedback, id: 'f2', parentId: undefined }], { requirePlanApproval: false }), ['f2']);
  // Deferred and done todos are not waiting at the gate; no policy means no claim.
  assert.deepEqual(plans([{ ...draft, status: 'deferred' }, { ...draft, id: 'd2', status: 'done' }]), []);
  assert.deepEqual(collectOperatorDigestForWorkspace([draft], null).plansToApprove, []);
});

test('digest text never carries absolute paths or home directories', () => {
  const state = collectOperatorDigestForWorkspace(
    [{ id: 'x1', title: 'Fix /home/someone/work/acme-app/lib/a.js', status: 'doing', review: { code: { state: 'failed' } } }],
    { policy: POLICY, stopReason: 'manual stop in /home/someone/work/acme-app now' },
    '/home/someone/work/acme-app',
  );
  const digest = buildOperatorDigest(state);
  const all = `${digest.title}\n${digest.body}`;
  assert.doesNotMatch(all, /\/home\/|someone|C:\\|\/Users\//);
  assert.match(all, /acme-app: manual stop in a\.js|acme-app: manual stop in acme-app now/);
});

test('an empty digest is never produced or published', async () => {
  assert.equal(buildOperatorDigest(emptyOperatorDigestState()), null);
  let published = 0;
  const result = await publishOperatorDigest({ now: new Date(2026, 0, 5, 10).getTime(), collect: async () => emptyOperatorDigestState(), publish: async () => { published += 1; return { created: true }; } });
  assert.deepEqual([result.published, result.reason, published], [false, 'empty', 0]);
});

test('the scheduler publishes once a day into the notification store (test clock)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-digest-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-digest-ws-'));
  const storePath = path.join(dataDir, 'notification-center.json');
  addTodo(dataDir, cwd, { title: 'Plan me', status: 'ready', plan: { markdown: '# p' } });
  const blocked = addTodo(dataDir, cwd, { title: 'Stuck', status: 'ready' }).item;
  updateTodo(dataDir, cwd, blocked.id, { blockedReason: 'needs_human' });
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  const state = await collectOperatorDigestState(dataDir);
  assert.ok(state.needsHuman.length >= 1);

  let clock = new Date(2026, 0, 5, 8, 0).getTime();
  const job = createOperatorDigestJob({
    dataDir,
    now: () => clock,
    publish: (input) => publishOperatorDigest({ ...input, storePath }),
  });
  let intervalFn;
  let bootFn;
  const runner = createPeriodicJobRunner({
    now: () => clock,
    setIntervalFn: (fn) => { intervalFn = fn; return 1; },
    setTimeoutFn: (fn) => { bootFn = fn; return 1; },
    clearIntervalFn: () => {},
    clearTimeoutFn: () => {},
  });
  runner.register(job);
  runner.start();
  bootFn(); // the jittered boot run also arms the interval
  await new Promise((r) => setTimeout(r, 50));
  const tick = async () => { await intervalFn(); await new Promise((r) => setTimeout(r, 50)); };
  const count = () => listNotifications({}, { storePath }).items.filter((n) => String(n.fingerprint || '').startsWith('operator-digest:')).length;

  await tick();
  assert.equal(count(), 0, 'before the digest hour nothing is sent');
  clock = new Date(2026, 0, 5, 9, 30).getTime();
  await tick();
  assert.equal(count(), 1);
  clock += 60 * 60 * 1000;
  await tick();
  assert.equal(count(), 1, 'a second run the same day is a duplicate');
  clock = new Date(2026, 0, 6, 9, 30).getTime();
  await tick();
  assert.equal(count(), 2, 'the next day sends again');
  const item = listNotifications({}, { storePath }).items.find((n) => n.fingerprint === `operator-digest:${digestDayKey(new Date(2026, 0, 5).getTime())}`);
  assert.match(item.body, /Needs a human decision: 1 - Stuck/);
  assert.equal(item.category, 'system');
  runner.stop();
});

test('scrubPaths keeps only the last segment of POSIX, home and Windows paths, and leaves prose and URLs alone', () => {
  assert.equal(scrubPaths('Stop: ~/private-project broke'), 'Stop: private-project broke');
  assert.equal(scrubPaths('C:\\private-project failed'), 'private-project failed');
  assert.equal(scrubPaths('in C:\\Users\\Jane Doe\\work\\app now'), 'in app now');
  assert.equal(scrubPaths('/home/someone/www/client-x/app crashed'), 'app crashed');
  assert.equal(scrubPaths('read and/or write'), 'read and/or write');
  assert.equal(scrubPaths('see https://example.com/a/b'), 'see https://example.com/a/b');
  assert.equal(scrubPaths('open file:///home/someone/work/app now'), 'open app now');
  assert.equal(scrubPaths('path:/home/someone/work/app'), 'path:app');
  assert.equal(scrubPaths('see file://localhost/home/someone/work/app'), 'see app');
  assert.equal(scrubPaths('file://server/share/private/app'), 'app');
  assert.equal(scrubPaths('http://localhost:3011/x'), 'http://localhost:3011/x');
  assert.equal(scrubPaths('UNC \\\\server\\share'), 'UNC share');
  for (const text of ['~/private-project', 'C:\\Users\\Jane Doe\\x', '/home/someone/a/b']) {
    assert.doesNotMatch(scrubPaths(text), /Jane|someone|~|[A-Za-z]:\\/);
  }
});
