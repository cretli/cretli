import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_INTEGRATE_DISABLED,
  AUTO_INTEGRATE_NOT_READY,
  AUTO_INTEGRATE_REVIEW_REQUIRED,
  authorizeAutomaticIntegration,
  runAutomaticIntegration,
} from '../lib/integration/auto-integrator.js';

const ready = {
  id: 'todo-1',
  integration: { state: 'ready' },
};
const result = {
  cycleId: 'cycle-1',
  patchPath: '/tmp/result.patch',
  review: { outcome: 'pass', verified: true },
};

test('automatic integration is disabled by default', () => {
  assert.deepEqual(authorizeAutomaticIntegration({ todo: ready, result }), {
    ok: false,
    reason: AUTO_INTEGRATE_DISABLED,
  });
});

test('enabled policy requires verified review PASS', () => {
  const decision = authorizeAutomaticIntegration({
    policy: { autoIntegrate: true },
    todo: ready,
    result: { ...result, review: { outcome: 'pass', verified: false } },
  });
  assert.equal(decision.reason, AUTO_INTEGRATE_REVIEW_REQUIRED);
});

test('enabled policy authorizes only prepared ready results', () => {
  assert.deepEqual(authorizeAutomaticIntegration({ policy: { autoIntegrate: true }, todo: ready, result }), {
    ok: true,
    todoId: 'todo-1',
    cycleId: 'cycle-1',
  });
  assert.equal(authorizeAutomaticIntegration({
    policy: { autoIntegrate: true }, todo: ready, result: { ...result, patchPath: '' },
  }).reason, AUTO_INTEGRATE_NOT_READY);
});

test('policy OFF never calls integration or rejection', async () => {
  let calls = 0;
  const decision = await runAutomaticIntegration({ todo: ready, result, deps: {
    apply: async () => { calls += 1; return { ok: true }; },
    reject: async () => { calls += 1; },
  } });
  assert.equal(decision.reason, AUTO_INTEGRATE_DISABLED);
  assert.equal(calls, 0);
});

test('authorized result is applied and a failed apply is rejected to ready', async () => {
  let rejected = null;
  const applied = await runAutomaticIntegration({ policy: { autoIntegrate: true }, todo: ready, result,
    deps: { apply: async () => ({ ok: true }) },
  });
  assert.equal(applied.ok, true);
  const failed = await runAutomaticIntegration({ policy: { autoIntegrate: true }, todo: ready, result,
    deps: { apply: async () => ({ ok: false, reason: 'conflict' }), reject: async (value) => { rejected = value; } },
  });
  assert.deepEqual({ ok: failed.ok, reason: failed.reason, rejected: failed.rejected }, { ok: false, reason: 'conflict', rejected: true });
  assert.equal(rejected.reason, 'conflict');
});

test('HEAD failure is tolerated and accounted for as a rejected candidate', async () => {
  const resultWithHeadFailure = await runAutomaticIntegration({ policy: { autoIntegrate: true }, todo: ready, result,
    deps: { apply: async () => { const error = new Error('HEAD unavailable'); error.code = 'WORKTREE_GIT_FAILED'; throw error; }, reject: async () => {} },
  });
  assert.equal(resultWithHeadFailure.reason, 'WORKTREE_GIT_FAILED');
  assert.equal(resultWithHeadFailure.rejected, true);
});

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTempRepo, git, tempDir } from './helpers/temp-git-repo.js';
import { integrateGitResult, copyFileAtomically, acceptMovedTypeErrors, runIntegrationGates, recoverMaterializationIntent } from '../lib/integration/git-integrator.js';
import { findStaleWorktreeFiles } from '../lib/integration/stale-worktree-diagnostic.js';
import {
  FRONTEND_SMOKE_STOP_REASON,
  confirmWorkspaceTodoIntegration,
  automaticallyIntegrateWorkspaceTodo,
  markTodoIntegrationReady,
} from '../lib/workspace-watcher-integration.js';
import { addTodo, getTodoById, loadTodosData, updateTodo, writeTodoReview } from '../lib/persist/todos-legacy-adapter.js';
import { syncTodoReviewTarget } from '../lib/todo-review-sync-hooks.js';
import { getWorkspaceWatcher, mutateWorkspaceWatcherRow, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { listOperatorEventsSince } from '../lib/persist/operator-journal-persist.js';
import { mutateWorktreeRegistry, readWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { worktreeResultPatchPath } from '../lib/worktree/worktree-result.ts';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';

async function fixture(t, review, { baseline = false, dataDir: requestedDataDir = '' } = {}) {
  const { dir: repo, baseCommit } = createTempRepo({ file: 'leaf.txt', content: 'base\n' });
  const dataDir = requestedDataDir || tempDir('cretli-auto-data-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); if (!requestedDataDir) fs.rmSync(dataDir, { recursive: true, force: true }); });
  git(repo, ['config', 'user.name', 'Cretli Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  if (baseline) {
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs/typecheck-baseline.json'), '{"baseline":true}\n');
    git(repo, ['add', 'docs/typecheck-baseline.json']); git(repo, ['commit', '-qm', 'add unchanged baseline']);
  }
  const currentBaseCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(repo, 'leaf.txt'), 'leaf\n');
  const patch = git(repo, ['diff', '--binary']);
  fs.writeFileSync(path.join(repo, 'leaf.txt'), 'base\n');
  const todo = addTodo(dataDir, repo, { title: 'Integrate leaf', status: 'doing' }).items.at(-1);
  const patchPath = worktreeResultPatchPath(dataDir, todo.id, 'cycle-1');
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, patch);
  const prepared = { ...result, ...(review ? { review } : {}), todoId: todo.id, patchPath, baseCommit: currentBaseCommit, materialRevision: 'reviewed-material',
    patchSha256: createHash('sha256').update(patch).digest('hex'), changedFiles: [{ path: 'leaf.txt' }] };
  mutateWorktreeRegistry((doc) => {
    doc.items[todo.id] = { todoId: todo.id, workspaceFolder: repo, worktreePath: repo, branch: 'leaf', baseCommit: currentBaseCommit,
    creationState: 'ready', executionState: 'execution_closed', integrationState: 'ready', results: {} };
    return { changed: true };
  }, { dataDir });
  assert.equal((await markTodoIntegrationReady({ todoId: todo.id, workspaceFolder: repo, dataDir, cycleId: 'cycle-1', result: prepared })).ok, true);
  return { repo, dataDir, todo, prepared, baseCommit: currentBaseCommit };
}

function call(f, policy = { autoIntegrate: true }) {
  return automaticallyIntegrateWorkspaceTodo({ workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id, policy, deps: { gates: () => {} } });
}

test('production caller resolves registry result and confirms verified HEAD; foreign staging survives', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo, 'foreign.txt'), 'staged\n');
  git(f.repo, ['add', 'foreign.txt']);
  fs.writeFileSync(path.join(f.repo, 'foreign.txt'), 'unstaged\n');
  const staged = git(f.repo, ['diff', '--cached', '--binary']);
  const outcome = await call(f);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const todo = getTodoById(f.dataDir, f.repo, f.todo.id);
  assert.equal(todo.status, 'done');
  assert.equal(todo.integration.state, 'integrated');
  assert.equal(todo.integration.evidence.source, 'auto_integrator');
  assert.equal(todo.integration.evidence.targetCommit, git(f.repo, ['rev-parse', 'HEAD']).trim());
  assert.match(git(f.repo, ['show', '-s', '--format=%B', 'HEAD']), /Verified-by: none/);
  assert.equal(git(f.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim(), 'leaf.txt');
  assert.equal(git(f.repo, ['diff', '--cached', '--binary']), staged);
  assert.equal(fs.readFileSync(path.join(f.repo, 'foreign.txt'), 'utf8'), 'unstaged\n');
});

test('automatic integration uses the newest legacy implement row verification result', async (t) => {
  const f = await fixture(t, { outcome: 'pass', verified: true }, { dataDir: ISOLATED_DATA_DIR });
  const legacy = createDelegationRecord({
    workspaceFolder: f.repo,
    leafId: f.todo.id,
    status: 'completed',
    assignment: 'implement',
  });
  updateDelegationRecord(legacy.id, {
    verifyResult: { status: 'passed', ids: ['x', 'y'], stale: false },
  });
  const outcome = await call(f);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const message = git(f.repo, ['show', '-s', '--format=%B', 'HEAD']);
  assert.match(message, /Verified-by: unit/);
  assert.match(message, /Verified-ids: x,y/);
});


test('real temporary-index conflict rejects to ready with patch note and preserves index and tree', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'master\n');
  git(f.repo, ['add', 'leaf.txt']); git(f.repo, ['commit', '-qm', 'master changes']);
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  const index = fs.readFileSync(path.join(f.repo, '.git/index'));
  const outcome = await call(f);
  assert.equal(outcome.reason, 'integration_conflict');
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git/index')), index);
  assert.equal(fs.readFileSync(path.join(f.repo, 'leaf.txt'), 'utf8'), 'master\n');
  const todo = getTodoById(f.dataDir, f.repo, f.todo.id);
  assert.equal(todo.status, 'ready');
  assert.equal(todo.integration.state, 'rejected');
  assert.ok(todo.body.includes(f.prepared.patchPath));
});

test('dirty scope refuses publication and policy OFF preserves HEAD', async (t) => {
  const f = await fixture(t);
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  assert.equal((await call(f, {})).reason, AUTO_INTEGRATE_DISABLED);
  fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'foreign edit\n');
  assert.match((await call(f)).reason, /^protected_workspace_change; artifacts: leaf.txt: patch hunks overlap/);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
  assert.equal(fs.readFileSync(path.join(f.repo, 'leaf.txt'), 'utf8'), 'foreign edit\n');
});

test('frontend smoke failure durably stops the watcher before notification, evidence todo and rejection', async (t) => {
  const f = await fixture(t);
  const artifacts = tempDir('cretli-smoke-evidence-');
  t.after(() => fs.rmSync(artifacts, { recursive: true, force: true }));
  fs.mkdirSync(path.join(artifacts, 'results'), { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'results', 'failure.png'), 'image');
  fs.writeFileSync(path.join(artifacts, 'results', 'console-errors.json'), '["TypeError"]');
  const order = [];
  const outcome = await automaticallyIntegrateWorkspaceTodo({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id,
    policy: { autoIntegrate: true },
    deps: {
      gates: async () => { throw Object.assign(new Error('browser failed'), { code: 'frontend_browser_failed', artifacts }); },
      smokeFailure: {
        mutateWatcher: (...args) => { order.push('pause'); return mutateWorkspaceWatcherRow(...args); },
        broadcast: () => { order.push('broadcast'); },
        notify: async () => { order.push('notify'); return { created: true, id: 'notification-1' }; },
        createTodo: (...args) => { order.push('todo'); return addTodo(...args); },
      },
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rejected, true);
  assert.deepEqual(order, ['pause', 'broadcast', 'notify', 'todo']);
  const evidence = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir });
  assert.equal(evidence.stopReason, FRONTEND_SMOKE_STOP_REASON);
  const todos = loadTodosData(f.dataDir, f.repo).items;
  const evidenceTodo = todos.find((item) => item.title === 'Investigate frontend smoke test failure');
  assert.ok(evidenceTodo);
  assert.match(evidenceTodo.body, /failure\.png/);
  assert.match(evidenceTodo.body, /console-errors\.json/);
  assert.match(evidenceTodo.body, new RegExp(f.baseCommit));
  assert.equal((await call(f)).reason, 'stopped');
});

test('failed smoke notification keeps the durable stop and never creates or rejects a todo', async (t) => {
  const f = await fixture(t);
  let created = false;
  const outcome = await automaticallyIntegrateWorkspaceTodo({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id,
    policy: { autoIntegrate: true },
    deps: {
      gates: async () => { throw Object.assign(new Error('browser failed'), { code: 'frontend_browser_failed' }); },
      smokeFailure: {
        notify: async () => { throw new Error('notification store unavailable'); },
        createTodo: () => { created = true; },
        broadcast: () => {},
      },
    },
  });
  assert.equal(outcome.rejected, false);
  assert.equal(outcome.suspendError, 'notification store unavailable');
  assert.equal(created, false);
  assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).stopReason, FRONTEND_SMOKE_STOP_REASON);
  assert.equal(getTodoById(f.dataDir, f.repo, f.todo.id).integration.state, 'ready');
  assert.equal((await call(f)).reason, 'stopped');
});

test('production smoke adapter persists the existing notification and todo records', async (t) => {
  const f = await fixture(t);
  const artifacts = tempDir('cretli-smoke-production-');
  t.after(() => fs.rmSync(artifacts, { recursive: true, force: true }));
  fs.writeFileSync(path.join(artifacts, 'browser.log'), 'console error: missing key');
  const outcome = await automaticallyIntegrateWorkspaceTodo({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id,
    policy: { autoIntegrate: true },
    deps: { gates: async () => { throw Object.assign(new Error('browser failed'), { code: 'frontend_browser_failed', artifacts }); } },
  });
  assert.equal(outcome.rejected, true);
  const notifications = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'notification-center.json'), 'utf8'));
  assert.equal(notifications.items[0].title, 'Frontend smoke test failed');
  assert.equal(notifications.items[0].severity, 'error');
  const evidenceTodo = loadTodosData(f.dataDir, f.repo).items
    .find((item) => item.title === 'Investigate frontend smoke test failure');
  assert.match(evidenceTodo?.body || '', /browser\.log/);
  assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).stopReason, FRONTEND_SMOKE_STOP_REASON);
});

test('real missing HEAD retains WORKTREE_GIT_FAILED', async (t) => {
  const repo = tempDir('cretli-auto-head-');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  await assert.rejects(() => integrateGitResult({ workspaceFolder: repo, result: {}, todoId: 'leaf' }), { code: 'WORKTREE_GIT_FAILED' });
});

test('reject exception preserves original failure and exposes secondary error', async () => {
  const failed = await runAutomaticIntegration({ policy: { autoIntegrate: true }, todo: ready, result, deps: {
    apply: () => ({ ok: false, reason: 'integration_conflict' }), reject: () => { throw new Error('storage unavailable'); },
  } });
  assert.equal(failed.reason, 'integration_conflict');
  assert.equal(failed.rejectError, 'storage unavailable');
  assert.equal(failed.rejected, false);
});

test('moved type errors use total and refuse growth outside leaf', () => {
  const before = { projects: { app: { 'old.js': 3, 'foreign.js': 1 } } };
  assert.equal(acceptMovedTypeErrors(before, { projects: { app: { 'new.js': 3, 'foreign.js': 1 } } }, ['old.js', 'new.js']), true);
  assert.equal(acceptMovedTypeErrors(before, { projects: { app: { 'new.js': 4, 'foreign.js': 1 } } }, ['old.js', 'new.js']), false);
  assert.equal(acceptMovedTypeErrors(before, { projects: { app: { 'new.js': 1, 'foreign.js': 2 } } }, ['old.js', 'new.js']), false);
});

test('affected test failing on HEAD is baseline; a new failure blocks', async (t) => {
  const root = tempDir('cretli-auto-gates-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'); const baseline = path.join(root, 'baseline');
  for (const dir of [candidate, baseline]) {
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests/failure.test.js'), 'process.exit(1)');
  }
  const input = { candidate, baseline, files: ['tests/failure.test.js'] };
  // The test intentionally has no lint executable: install a deterministic successful fixture.
  fs.mkdirSync(path.join(candidate, 'node_modules/eslint/bin'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'node_modules/eslint/bin/eslint.js'), '');
  await assert.doesNotReject(() => runIntegrationGates(input));
  fs.writeFileSync(path.join(baseline, 'tests/failure.test.js'), 'process.exit(0)');
  await assert.rejects(() => runIntegrationGates(input), { code: 'test_failed:tests/failure.test.js' });
});

import { runWorkspaceWatcherAutopilot } from '../lib/workspace-watcher-cycle.js';

test('real autopilot drains persisted ready result, records audit and does not need a closing cycle', async (t) => {
  const f = await fixture(t);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true, requirePlanApproval: false } }, { dataDir: f.dataDir });
  const outcome = await runWorkspaceWatcherAutopilot({ dataDir: f.dataDir });
  assert.equal(getTodoById(f.dataDir, f.repo, f.todo.id).status, 'done', JSON.stringify(outcome));
  const row = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir });
  assert.equal(row.automaticIntegrations.length, 1);
  assert.equal(row.automaticIntegrations[0].ok, true);
  assert.equal(row.automaticIntegrations[0].commit, git(f.repo, ['rev-parse', 'HEAD']).trim());
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  await runWorkspaceWatcherAutopilot({ dataDir: f.dataDir });
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
});

test('review-failed ready leaf records a visible automatic-integration skip', async (t) => {
  const f = await fixture(t);
  mutateWorktreeRegistry((doc) => {
    doc.items[f.todo.id].results['cycle-1'].review = { outcome: 'fail', verified: true };
    return { changed: true };
  }, { dataDir: f.dataDir });
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true } }, { dataDir: f.dataDir });
  const outcome = await call(f);
  assert.equal(outcome.reason, 'review_not_passed');
  const audit = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).automaticIntegrations;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, 'review_not_passed');
  assert.equal(audit[0].skipped, true);
  assert.equal(audit[0].todoId, f.todo.id);
});

test('durable rate and failure limits prevent Git publication', async (t) => {
  const f = await fixture(t);
  const entry = { todoId: 'previous', at: new Date().toISOString(), ok: false, reason: 'conflict' };
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true }, automaticIntegrations: [entry] }, { dataDir: f.dataDir });
  assert.equal((await call(f, { autoIntegrate: true, autoIntegrateMaxPerHour: 1 })).reason, 'integration_rate_limit');
  assert.equal((await call(f, { autoIntegrate: true, autoIntegrateMaxFailures: 1 })).reason, 'integration_failure_limit');
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']).trim(), f.baseCommit);
});

test('gate failures leave repository index and working tree unchanged', async (t) => {
  const f = await fixture(t);
  const index = fs.readFileSync(path.join(f.repo, '.git/index'));
  await assert.rejects(() => integrateGitResult({ workspaceFolder: f.repo, result: f.prepared, todoId: f.todo.id,
    gates: () => { throw Object.assign(new Error('lint failure'), { code: 'eslint_failed' }); },
  }), { code: 'eslint_failed' });
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']).trim(), f.baseCommit);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git/index')), index);
  assert.equal(fs.readFileSync(path.join(f.repo, 'leaf.txt'), 'utf8'), 'base\n');
});

test('generated baseline patch is excluded and recomputed on candidate only', async (t) => {
  const f = await fixture(t);
  const baseline = 'docs/typecheck-baseline.json';
  fs.mkdirSync(path.join(f.repo, 'docs'));
  fs.writeFileSync(path.join(f.repo, baseline), 'base\n');
  git(f.repo, ['add', baseline]); git(f.repo, ['commit', '-qm', 'baseline']);
  fs.writeFileSync(path.join(f.repo, baseline), 'leaf stale baseline\n');
  const generatedPatch = git(f.repo, ['diff', '--binary']);
  fs.writeFileSync(path.join(f.repo, baseline), 'master baseline\n');
  git(f.repo, ['add', baseline]); git(f.repo, ['commit', '-qm', 'master baseline']);
  fs.appendFileSync(f.prepared.patchPath, generatedPatch);
  const outcome = await integrateGitResult({ workspaceFolder: f.repo, result: f.prepared, todoId: f.todo.id, gates: ({ candidate }) => {
    assert.equal(fs.readFileSync(path.join(candidate, baseline), 'utf8').replace(/\r\n/g, '\n'), 'master baseline\n');
    fs.writeFileSync(path.join(candidate, baseline), 'recomputed\n');
    fs.writeFileSync(path.join(candidate, 'unrelated.txt'), 'gate output\n');
  } });
  assert.equal(outcome.ok, true);
  assert.equal(fs.readFileSync(path.join(f.repo, baseline), 'utf8'), 'recomputed\n');
  assert.equal(git(f.repo, ['show', 'HEAD:unrelated.txt'], { allowFailure: true }), '');
  assert.equal(fs.existsSync(path.join(f.repo, 'unrelated.txt')), false);
});

test('published commit files are materialized and concurrent post-publication edits are signaled', async (t) => {
  const normal = await fixture(t);
  const integrated = await integrateGitResult({ workspaceFolder: normal.repo, todoId: normal.todo.id, result: normal.prepared, gates: () => {} });
  assert.equal(fs.readFileSync(path.join(normal.repo, 'leaf.txt'), 'utf8').replace(/\r\n/g, '\n'), 'leaf\n');
  assert.equal(git(normal.repo, ['show', `${integrated.commit}:leaf.txt`]), 'leaf\n');

  const raced = await fixture(t);
  await assert.rejects(() => integrateGitResult({ workspaceFolder: raced.repo, todoId: raced.todo.id, result: raced.prepared,
    gates: () => {}, afterMaterialize: async () => fs.writeFileSync(path.join(raced.repo, 'leaf.txt'), 'base\n'),
  }), { code: 'materialization_mismatch' });
  assert.equal(git(raced.repo, ['show', 'HEAD:leaf.txt']), 'leaf\n');
  assert.equal(fs.readFileSync(path.join(raced.repo, 'leaf.txt'), 'utf8').replace(/\r\n/g, '\n'), 'base\n');
});

test('startup recovery completes an interrupted materialization and leaves no stop reason', async (t) => {
  const f = await fixture(t);
  let commit = '';
  await assert.rejects(() => integrateGitResult({ workspaceFolder: f.repo, todoId: f.todo.id, result: f.prepared,
    gates: () => {}, afterPublish: async (entry) => { commit = entry.commit; throw new Error('simulated process kill'); },
  }), /simulated process kill/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'leaf.txt'), 'utf8'), 'base\n');
  assert.equal((await recoverMaterializationIntent({ workspaceFolder: f.repo })).recovered, true);
  assert.equal(fs.readFileSync(path.join(f.repo, 'leaf.txt'), 'utf8').replace(/\r\n/g, '\n'), 'leaf\n');
  assert.equal(git(f.repo, ['show', `${commit}:leaf.txt`]), 'leaf\n');
  assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir })?.stopReason || '', '');
});

test('startup recovery preserves foreign work and refuses materialization', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => integrateGitResult({ workspaceFolder: f.repo, todoId: f.todo.id, result: f.prepared,
    gates: () => {}, afterPublish: async () => { fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'foreign WIP\n'); throw new Error('simulated process kill'); },
  }), { code: 'confirmation_pending' });
  assert.deepEqual(await recoverMaterializationIntent({ workspaceFolder: f.repo }), {
    recovered: false, reason: 'foreign_worktree', files: ['leaf.txt'],
  });
  assert.equal(fs.readFileSync(path.join(f.repo, 'leaf.txt'), 'utf8'), 'foreign WIP\n');
});

test('startup recovery finishes a crash partway through multi-file materialization', async (t) => {
  const { dir: repo } = createTempRepo({ file: 'a.txt', content: 'a0\n' });
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ['config', 'user.name', 'Cretli Test']); git(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b0\n'); git(repo, ['add', 'b.txt']); git(repo, ['commit', '-qm', 'add b']);
  const parent = git(repo, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b1\n');
  git(repo, ['commit', '-qam', 'integrate']);
  const commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const blob = (file) => git(repo, ['rev-parse', `${commit}:${file}`]).trim();
  // Crash state: a.txt already materialized, b.txt still at the parent version, unrelated WIP present.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b0\n');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'wip\n');
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  fs.writeFileSync(path.join(gitDir, 'cretli-materialization-intent.json'), JSON.stringify({ commit, parent,
    files: [{ path: 'a.txt', blob: blob('a.txt') }, { path: 'b.txt', blob: blob('b.txt') }] }));
  const outcome = await recoverMaterializationIntent({ workspaceFolder: repo });
  assert.equal(outcome.recovered, true);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'a1\n');
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'), 'b1\n');
  assert.equal(fs.readFileSync(path.join(repo, 'unrelated.txt'), 'utf8'), 'wip\n');
  assert.equal(fs.existsSync(path.join(gitDir, 'cretli-materialization-intent.json')), false);
});

test('startup recovery preserves non-UTF-8 blob bytes and verifies them before clearing intent', async (t) => {
  const { dir: repo } = createTempRepo({ file: 'payload.bin', content: Buffer.from([0x10, 0x20, 0x30]) });
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ['config', 'user.name', 'Cretli Test']); git(repo, ['config', 'user.email', 'test@example.com']);
  const parent = git(repo, ['rev-parse', 'HEAD']).trim();
  const expected = Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x0a]);
  fs.writeFileSync(path.join(repo, 'payload.bin'), expected); git(repo, ['add', 'payload.bin']); git(repo, ['commit', '-qm', 'binary integration']);
  const commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const blob = git(repo, ['rev-parse', `${commit}:payload.bin`]).trim();
  fs.writeFileSync(path.join(repo, 'payload.bin'), Buffer.from([0x10, 0x20, 0x30]));
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  const intent = path.join(gitDir, 'cretli-materialization-intent.json');
  fs.writeFileSync(intent, JSON.stringify({ commit, parent, files: [{ path: 'payload.bin', blob }] }));
  assert.equal((await recoverMaterializationIntent({ workspaceFolder: repo })).recovered, true);
  const actual = fs.readFileSync(path.join(repo, 'payload.bin'));
  assert.deepEqual(actual, expected);
  assert.equal(git(repo, ['hash-object', '--', 'payload.bin']).trim(), blob);
  assert.equal(fs.existsSync(intent), false);
});

test('startup recovery refuses symlinked target directories and preserves outside files and intent', async (t) => {
  const repo = tempDir('cretli-recovery-repo-');
  const outside = tempDir('cretli-recovery-outside-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Cretli Test']); git(repo, ['config', 'user.email', 'test@example.com']);
  fs.mkdirSync(path.join(repo, 'nested'));
  fs.writeFileSync(path.join(repo, 'nested/payload.txt'), 'parent\n'); git(repo, ['add', 'nested/payload.txt']); git(repo, ['commit', '-qm', 'base']);
  const parent = git(repo, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(repo, 'nested/payload.txt'), 'committed\n'); git(repo, ['add', 'nested/payload.txt']); git(repo, ['commit', '-qm', 'integration']);
  const commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const blob = git(repo, ['rev-parse', `${commit}:nested/payload.txt`]).trim();
  fs.rmSync(path.join(repo, 'nested'), { recursive: true, force: true });
  fs.writeFileSync(path.join(outside, 'payload.txt'), 'parent\n');
  try { fs.symlinkSync(outside, path.join(repo, 'nested'), 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error?.code)) { t.skip(`directory symlinks unavailable: ${error.code}`); return; }
    throw error;
  }
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  const intent = path.join(gitDir, 'cretli-materialization-intent.json');
  fs.writeFileSync(intent, JSON.stringify({ commit, parent, files: [{ path: 'nested/payload.txt', blob }] }));
  assert.deepEqual(await recoverMaterializationIntent({ workspaceFolder: repo }), {
    recovered: false, reason: 'symlinked_intent_path', file: 'nested/payload.txt',
  });
  assert.equal(fs.readFileSync(path.join(outside, 'payload.txt'), 'utf8'), 'parent\n');
  assert.equal(fs.existsSync(intent), true);
});

test('materialization mismatch stops automation with a decision and a notification', async (t) => {
  const f = await fixture(t);
  const notices = [];
  const outcome = await automaticallyIntegrateWorkspaceTodo({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id, policy: { autoIntegrate: true },
    deps: {
      gates: () => {},
      afterMaterialize: async () => fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'base\n'),
      notify: async (notice) => { notices.push(notice); return { created: true }; },
    },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /^materialization_mismatch/);
  const row = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir });
  assert.equal(row.stopReason, 'integration_materialization_mismatch');
  assert.ok(row.decisions.some((entry) => entry.kind === 'integration_materialization_mismatch'));
  assert.equal(notices.length, 1);
  assert.equal((await call(f)).reason, 'stopped');
});

test('stale worktree diagnostic reports only files reverted to an older blob', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo, 'untouched.txt'), 'same\n');
  git(f.repo, ['add', 'untouched.txt']); git(f.repo, ['commit', '-qm', 'untouched']);
  fs.writeFileSync(path.join(f.repo, 'foreign.txt'), 'one\n');
  git(f.repo, ['add', 'foreign.txt']); git(f.repo, ['commit', '-qm', 'foreign']);
  await integrateGitResult({ workspaceFolder: f.repo, todoId: f.todo.id, result: f.prepared, gates: () => {} });
  fs.writeFileSync(path.join(f.repo, 'foreign.txt'), 'foreign edit\n');
  assert.deepEqual((await findStaleWorktreeFiles(f.repo, 10)).files, []);
  fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'base\n');
  const diagnostic = await findStaleWorktreeFiles(f.repo, 10);
  assert.deepEqual(diagnostic.files.map((entry) => entry.path), ['leaf.txt']);
  assert.equal(diagnostic.files[0].olderCommits.length, 3); // base, untouched and foreign commits all carry the old blob
});

async function mismatchThenResume(t, { existingRow }) {
  const f = await fixture(t);
  if (existingRow) upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true, autoRestart: true } }, { dataDir: f.dataDir });
  const flushed = [];
  const postIntegrator = { record: (paths) => { flushed.push(paths); return true; }, flush: async () => {} };
  const attempt = (afterMaterialize) => automaticallyIntegrateWorkspaceTodo({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id, policy: { autoIntegrate: true, autoRestart: true },
    deps: { gates: () => {}, notify: async () => ({ created: true }), postIntegrator, afterMaterialize },
  });
  const first = await attempt(async () => fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'base\n'));
  assert.match(first.reason, /^materialization_mismatch/);
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  assert.equal(flushed.length, 0);
  return { f, attempt, head, flushed };
}

const clearStop = (f) => mutateWorkspaceWatcherRow(f.repo, () => ({ stopReason: '' }), { dataDir: f.dataDir });

for (const existingRow of [false, true]) {
  test(`materialization mismatch resume re-verifies files before confirming (existing row: ${existingRow})`, async (t) => {
    const { f, attempt, head, flushed } = await mismatchThenResume(t, { existingRow });
    // Stop cleared but the stale file is still there: no confirmation, no restart, still stopped.
    clearStop(f);
    const stuck = await attempt();
    assert.match(String(stuck.reason), /^materialization_mismatch/, JSON.stringify(stuck));
    assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).stopReason, 'integration_materialization_mismatch');
    assert.notEqual(getTodoById(f.dataDir, f.repo, f.todo.id).status, 'done');
    assert.equal(flushed.length, 0);
    // File repaired: the published commit is confirmed without re-applying the patch, then the restart is scheduled.
    clearStop(f);
    fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'leaf\n');
    const resumed = await attempt();
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
    const todo = getTodoById(f.dataDir, f.repo, f.todo.id);
    assert.equal(todo.status, 'done');
    assert.equal(todo.integration.state, 'integrated');
    assert.equal(flushed.length, 1);
  });
}

test('resume rechecks unchanged baseline files included in original materialization scope', async (t) => {
  const f = await fixture(t, undefined, { baseline: true });
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true, autoRestart: true } }, { dataDir: f.dataDir });
  const flushed = [];
  const attempt = (afterMaterialize) => automaticallyIntegrateWorkspaceTodo({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id,
    policy: { autoIntegrate: true, autoRestart: true },
    deps: { gates: () => {}, notify: async () => ({ created: true }),
      postIntegrator: { record: (paths) => { flushed.push(paths); return true; }, flush: async () => {} }, afterMaterialize },
  });
  const first = await attempt(async () => fs.writeFileSync(path.join(f.repo, 'docs/typecheck-baseline.json'), '{"stale":true}\n'));
  assert.match(first.reason, /^materialization_mismatch/);
  const row = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir });
  assert.ok(row.automaticIntegrations.some((entry) => entry.reason === 'materialization_pending'));
  clearStop(f);
  const resumed = await attempt();
  assert.match(resumed.reason, /^materialization_mismatch/);
  assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).stopReason, 'integration_materialization_mismatch');
  assert.notEqual(getTodoById(f.dataDir, f.repo, f.todo.id).status, 'done');
  assert.equal(flushed.length, 0);
});

for (const reason of ['publication_pending', 'confirmation_pending']) {
  test(`recovered ${reason} with a stale working-tree file stops without confirming or restarting`, async (t) => {
    const f = await fixture(t);
    const flushed = [];
    const integrated = await integrateGitResult({ workspaceFolder: f.repo, todoId: f.todo.id, result: f.prepared, gates: () => {} });
    // Simulate an interruption between update-ref and the file copy: the working tree is back at the pre-commit content.
    fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'base\n');
    upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true, autoRestart: true }, automaticIntegrations: [{
      todoId: f.todo.id, at: new Date().toISOString(), ok: false, reason,
      commit: integrated.commit, branch: integrated.branch, cycleId: f.prepared.cycleId, patchSha256: f.prepared.patchSha256,
    }] }, { dataDir: f.dataDir });
    const notify = async () => ({ created: true });
    const outcome = await automaticallyIntegrateWorkspaceTodo({
      workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id, policy: { autoIntegrate: true, autoRestart: true },
      deps: { gates: () => {}, notify, postIntegrator: { record: (paths) => { flushed.push(paths); return true; }, flush: async () => {} } },
    });
    assert.match(String(outcome.reason), /^materialization_mismatch/, JSON.stringify(outcome));
    const row = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir });
    assert.equal(row.stopReason, 'integration_materialization_mismatch');
    assert.ok(row.decisions.some((d) => d.kind === 'integration_materialization_mismatch'));
    assert.notEqual(getTodoById(f.dataDir, f.repo, f.todo.id).status, 'done');
    assert.equal(flushed.length, 0);
  });
}

test('asynchronous lint and size regeneration failures block gates', async (t) => {
  const root = tempDir('cretli-auto-lint-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate'); const baseline = path.join(root, 'baseline');
  fs.mkdirSync(path.join(candidate, 'node_modules/eslint/bin'), { recursive: true });
  fs.mkdirSync(baseline);
  fs.writeFileSync(path.join(candidate, 'node_modules/eslint/bin/eslint.js'), 'process.exit(1)');
  fs.writeFileSync(path.join(candidate, 'source.js'), '');
  await assert.rejects(() => runIntegrationGates({ candidate, baseline, files: ['source.js'] }), { code: 'eslint_failed' });
  fs.mkdirSync(path.join(candidate, 'scripts'));
  fs.writeFileSync(path.join(candidate, 'scripts/front-size-baseline.js'), 'process.exit(1)');
  await assert.rejects(() => runIntegrationGates({ candidate, baseline, files: [] }), { code: 'size_baseline_failed' });
});

test('production caller rejects a real HEAD read failure without masking its Git code', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.repo, '.git/HEAD'), 'ref: refs/heads/missing\n');
  const outcome = await call(f);
  assert.equal(outcome.reason, 'WORKTREE_GIT_FAILED');
  assert.equal(outcome.rejected, true);
  assert.equal(getTodoById(f.dataDir, f.repo, f.todo.id).status, 'ready');
});

test('durable publication journal recovers confirmation without another commit', async (t) => {
  const f = await fixture(t);
  const integrated = await integrateGitResult({ workspaceFolder: f.repo, todoId: f.todo.id, result: f.prepared, gates: () => {} });
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true }, automaticIntegrations: [{
    todoId: f.todo.id, at: new Date().toISOString(), ok: false, reason: 'publication_pending',
    commit: integrated.commit, branch: integrated.branch, cycleId: f.prepared.cycleId, patchSha256: f.prepared.patchSha256,
  }] }, { dataDir: f.dataDir });
  const outcome = await call(f, { autoIntegrate: true, autoIntegrateMaxFailures: 1, autoIntegrateMaxPerHour: 1 });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(getTodoById(f.dataDir, f.repo, f.todo.id).status, 'done');
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
  assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).automaticIntegrations[0].ok, true);
});

const fails = (n, ageMs) => Array.from({ length: n }, (_, i) => ({
  todoId: `old-${i}`, at: new Date(Date.now() - ageMs + i).toISOString(), ok: false, reason: 'typecheck_regression',
}));

test('five fresh failures hit the limit; five older than 6h do not', async (t) => {
  const fresh = await fixture(t);
  upsertWorkspaceWatcher(fresh.repo, { mode: 'autopilot', policy: { autoIntegrate: true }, automaticIntegrations: fails(5, 60000) }, { dataDir: fresh.dataDir });
  assert.equal((await call(fresh, { autoIntegrate: true, autoIntegrateMaxFailures: 5 })).reason, 'integration_failure_limit');
  assert.equal(git(fresh.repo, ['rev-parse', 'HEAD']).trim(), fresh.baseCommit);

  const stale = await fixture(t);
  upsertWorkspaceWatcher(stale.repo, { mode: 'autopilot', policy: { autoIntegrate: true }, automaticIntegrations: fails(5, 7 * 3600000) }, { dataDir: stale.dataDir });
  const outcome = await call(stale, { autoIntegrate: true, autoIntegrateMaxFailures: 5 });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
});

test('a confirmed integration of any todo resets a fresh failure series', async (t) => {
  const f = await fixture(t);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true }, automaticIntegrations: fails(5, 60000) }, { dataDir: f.dataDir });
  // Confirm a different todo through the real confirm path (the function behind
  // `todo_integration confirm`) so the genuine confirmation timestamp is what
  // resets the series.
  const other = addTodo(f.dataDir, f.repo, { title: 'Manually integrated', status: 'doing' }).items.find((item) => item.title === 'Manually integrated');
  const confirmed = await confirmWorkspaceTodoIntegration({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: other.id, expectedUpdatedAt: other.updatedAt,
    proof: { simple: true },
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.ok(getTodoById(f.dataDir, f.repo, other.id).integration.evidence.confirmedAt);
  const outcome = await call(f, { autoIntegrate: true, autoIntegrateMaxFailures: 5 });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
});

test('failure limit yields one decision and one notification per episode', async (t) => {
  const f = await fixture(t);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true, autoIntegrateMaxFailures: 5, requirePlanApproval: false }, automaticIntegrations: fails(5, 60000) }, { dataDir: f.dataDir });
  const sent = [];
  const deps = { notify: (payload) => { sent.push(payload); return true; } };
  await runWorkspaceWatcherAutopilot({ dataDir: f.dataDir, deps });
  await runWorkspaceWatcherAutopilot({ dataDir: f.dataDir, deps });
  const row = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir });
  assert.equal(row.decisions.filter((d) => d.reason === 'integration_failure_limit').length, 1);
  assert.equal(sent.filter((p) => /integration_failure_limit/.test(p.body)).length, 1);
  assert.ok(row.notified.integration_failure_limit);
  // The decision names the leaf and cause behind the block, not just a counter.
  const decision = row.decisions.find((d) => d.reason === 'integration_failure_limit');
  assert.equal(decision.integrationFailure.cause, 'typecheck_regression');
  assert.equal(decision.integrationFailure.count, 5);
  assert.match(decision.integrationFailure.todoId, /^old-/);
  assert.match(sent[0].body, /last: old-\d+ typecheck_regression/);
  // The block disappears (older failures): the episode is cleared.
  mutateWorkspaceWatcherRow(f.repo, () => ({ automaticIntegrations: fails(5, 7 * 3600000) }), { dataDir: f.dataDir });
  await runWorkspaceWatcherAutopilot({ dataDir: f.dataDir, deps });
  assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).notified.integration_failure_limit, undefined);
});

const PENDING_REVIEW = { outcome: 'unknown', reportedOutcome: 'pending', verified: false };

function passedReviewSnapshot() {
  return { code: {
    state: 'passed', stateReason: 'fresh_review', subject: 'code',
    independence: { independent: true, class: 'different_base_model', reference: 'implementer' },
    material: { current: true },
    reviewers: [{ delegationId: 'd1', attemptId: 'a1', usable: true, verdict: 'PASS' }],
    reviewerCount: 1, implementer: { attemptId: 'impl1' },
  } };
}

test('review pending at cycle close skips; once review passes the retry integrates exactly once', async (t) => {
  const f = await fixture(t, PENDING_REVIEW);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true, requirePlanApproval: false } }, { dataDir: f.dataDir });
  const first = await call(f);
  assert.equal(first.reason, 'review_not_passed');
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  let audit = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).automaticIntegrations;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].skipped, true);
  // The review transitions to passed (server-written snapshot).
  const current = getTodoById(f.dataDir, f.repo, f.todo.id);
  writeTodoReview(f.dataDir, f.repo, f.todo.id, passedReviewSnapshot(), { expectedUpdatedAt: current.updatedAt, expectedGeneration: Number(current.review?.generation) || 0 });
  const second = await call(f);
  assert.equal(second.ok, true, JSON.stringify(second));
  const commit = git(f.repo, ['rev-parse', 'HEAD']);
  assert.notEqual(commit, head);
  audit = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).automaticIntegrations;
  assert.equal(audit.filter((entry) => entry.ok === true).length, 1);
  assert.equal(audit.at(-1).patchSha256, f.prepared.patchSha256);
  // A second pass finds nothing to integrate and creates no further commit.
  const third = await call(f);
  assert.equal(third.ok, false);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), commit);
  assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).automaticIntegrations.filter((entry) => entry.ok === true).length, 1);
});

test('a still-pending review is not upgraded and keeps skipping', async (t) => {
  const f = await fixture(t, PENDING_REVIEW);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true, requirePlanApproval: false } }, { dataDir: f.dataDir });
  assert.equal((await call(f)).reason, 'review_not_passed');
  assert.equal((await call(f)).reason, 'review_not_passed');
  assert.equal(getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).automaticIntegrations.length, 1);
});

test('review-sync hook triggers the integration retry only when the review becomes passed', async (t) => {
  const f = await fixture(t, PENDING_REVIEW);
  const calls = [];
  const target = { workspaceFolder: f.repo, todoId: f.todo.id, dataDir: f.dataDir };
  const deps = (state) => ({
    computeSnapshot: async () => (state === 'passed' ? passedReviewSnapshot() : { code: { state: 'pending' } }),
    retryAutoIntegration: async (value) => { calls.push(value.todoId); },
  });
  await syncTodoReviewTarget(target, { deps: deps('pending'), env: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  await syncTodoReviewTarget(target, { deps: deps('passed'), env: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [f.todo.id]);
});

async function staleScanRepo(t, commits) {
  const { dir: repo } = createTempRepo({ file: 'a.txt', content: 'v0\n' });
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ['config', 'user.name', 'Cretli Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  for (let i = 1; i <= commits; i += 1) {
    fs.writeFileSync(path.join(repo, 'a.txt'), `v${i}\n`);
    git(repo, ['commit', '-qam', `c${i}`]);
  }
  fs.writeFileSync(path.join(repo, 'a.txt'), `v${Math.floor(commits / 2)}\n`);
  return repo;
}

test('stale-file scan over 100 commits keeps the event loop responsive', async (t) => {
  const repo = await staleScanRepo(t, 100);
  let maxGap = 0;
  let samples = 0;
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last - 10); last = now; samples += 1; }, 10);
  let report;
  try {
    report = await findStaleWorktreeFiles(repo, 100);
    // Let the timer observe any block at the very end of the scan before it is cleared.
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally { clearInterval(timer); }
  assert.deepEqual(report.files.map((entry) => entry.path), ['a.txt']);
  assert.equal(report.truncated, false);
  assert.ok(samples > 0, 'the sampler never ran during the scan');
  assert.ok(maxGap < 100, `event loop delayed ${maxGap}ms`);
});

test('stale-file scan is truncated by an abort during in-flight work and by an exhausted budget', async (t) => {
  const repo = await staleScanRepo(t, 100);
  const pre = await findStaleWorktreeFiles(repo, 100, { signal: AbortSignal.abort() });
  assert.deepEqual([pre.truncated, pre.files], [true, []]);
  const controller = new AbortController();
  const inflight = findStaleWorktreeFiles(repo, 100, { signal: controller.signal });
  controller.abort(); // the first git child is already running
  const aborted = await inflight;
  assert.deepEqual([aborted.truncated, aborted.files], [true, []]);
  const overrun = await findStaleWorktreeFiles(repo, 100, { budgetMs: 1 });
  assert.deepEqual([overrun.truncated, overrun.files], [true, []]);
});

test('stale-file scan returns truncated when a stat hangs past the budget or is aborted', async (t) => {
  const repo = await staleScanRepo(t, 3);
  const hang = () => new Promise(() => {});
  const started = Date.now();
  const overrun = await findStaleWorktreeFiles(repo, 3, { budgetMs: 300, stat: hang });
  assert.deepEqual([overrun.truncated, overrun.files], [true, []]);
  assert.ok(Date.now() - started < 3000, 'scan did not return promptly');
  const controller = new AbortController();
  const pending = findStaleWorktreeFiles(repo, 3, { signal: controller.signal, stat: hang });
  setTimeout(() => controller.abort(), 200);
  const abortedAt = Date.now();
  const aborted = await pending;
  assert.deepEqual([aborted.truncated, aborted.files], [true, []]);
  assert.ok(Date.now() - abortedAt < 3000, 'abort did not return promptly');
});

test('after auto-integration git status is clean for integrated paths and content equals the commit', async (t) => {
  const f = await fixture(t);
  const integrated = await integrateGitResult({ workspaceFolder: f.repo, todoId: f.todo.id, result: f.prepared, gates: () => {} });
  assert.deepEqual(integrated.files.includes('leaf.txt'), true);
  for (const file of integrated.files) {
    assert.equal(git(f.repo, ['status', '--porcelain', '--', file]).trim(), '', `${file} must be clean`);
    assert.equal(git(f.repo, ['hash-object', '--path', file, '--', file]).trim(), git(f.repo, ['rev-parse', `${integrated.commit}:${file}`]).trim());
    assert.notEqual(git(f.repo, ['rev-parse', `${integrated.commit}:${file}`]).trim(), git(f.repo, ['rev-parse', `${integrated.commit}^:${file}`], { allowFailure: true }).trim());
  }
  assert.deepEqual(fs.readdirSync(f.repo).filter((name) => name.includes('cretli-integrate')), []);
});

test('atomic copy rejects temp-name collisions and symlinks without touching the target or its link destination', (t) => {
  const dir = tempDir('cretli-atomic-copy-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.txt');
  const target = path.join(dir, 'target.txt');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(source, 'new\n');
  fs.writeFileSync(target, 'old\n');
  fs.writeFileSync(outside, 'outside\n');
  const fixedName = () => 'fixed';
  const temporary = `${target}.cretli-integrate-fixed.tmp`;

  fs.writeFileSync(temporary, 'squatter\n');
  assert.throws(() => copyFileAtomically(source, target, { tempName: fixedName }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(temporary, 'utf8'), 'squatter\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n');
  fs.rmSync(temporary);

  fs.symlinkSync(outside, temporary);
  assert.throws(() => copyFileAtomically(source, target, { tempName: fixedName }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n');
  assert.equal(fs.lstatSync(temporary).isSymbolicLink(), true);
  fs.rmSync(temporary);

  copyFileAtomically(source, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new\n');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('cretli-integrate')), []);
});

test('atomic copy removes its temp file when the rename fails', (t) => {
  const dir = tempDir('cretli-atomic-copy-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.txt');
  const target = path.join(dir, 'target-dir');
  fs.writeFileSync(source, 'new\n');
  fs.mkdirSync(path.join(target, 'child'), { recursive: true });
  assert.throws(() => copyFileAtomically(source, target));
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('cretli-integrate')), []);
});

test('tree: first leaf confirmed manually keeps the tree record, second leaf auto-integrates', async (t) => {
  const f = await fixture(t);
  // The tree root owns the live tree worktree record (it shares the repo checkout here) and has
  // one finished per-leaf worktree, so the post-confirm cleanup considers it a parallel-leaf tree.
  const root = addTodo(f.dataDir, f.repo, { title: 'Tree root', status: 'doing' }).items.find((item) => item.title === 'Tree root');
  const leaf1 = addTodo(f.dataDir, f.repo, { title: 'Leaf one', parentId: root.id, status: 'doing', siblingIndex: 0 }).items.find((item) => item.title === 'Leaf one');
  updateTodo(f.dataDir, f.repo, f.todo.id, { parentId: root.id, siblingIndex: 1, expectedUpdatedAt: getTodoById(f.dataDir, f.repo, f.todo.id).updatedAt });
  mutateWorktreeRegistry((doc) => {
    doc.items[root.id] = { todoId: root.id, workspaceFolder: f.repo, worktreePath: f.repo, branch: 'tree', baseCommit: f.baseCommit,
      creationState: 'ready', executionState: 'execution_closed', integrationState: 'ready', results: {} };
    doc.items['finished-leaf'] = { todoId: 'finished-leaf', treeTodoId: root.id, workspaceFolder: f.repo, worktreePath: f.repo, branch: 'finished-leaf',
      baseCommit: f.baseCommit, creationState: 'ready', executionState: 'execution_closed', integrationState: 'integrated', cleanedAt: new Date().toISOString(), results: {} };
    return { changed: true };
  }, { dataDir: f.dataDir });

  const confirmed = await confirmWorkspaceTodoIntegration({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: leaf1.id,
    expectedUpdatedAt: getTodoById(f.dataDir, f.repo, root.id).updatedAt, proof: { simple: true },
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  // The background cleanup must not drop the tree record while leaf two is still open.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const record = readWorktreeRegistry({ dataDir: f.dataDir }).items[root.id];
  assert.ok(record && !record.cleanedAt, 'tree worktree record survives the confirmation');
  assert.ok(fs.existsSync(f.repo));

  const outcome = await call(f);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(git(f.repo, ['show', 'HEAD:leaf.txt']), 'leaf\n');
});

test('a todo with a current confirmation is skipped untouched and never counts as a failure', async (t) => {
  const f = await fixture(t);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true } }, { dataDir: f.dataDir });
  // The operator integrated the leaf by hand; the stored state is back to `ready` but the evidence is current.
  const current = getTodoById(f.dataDir, f.repo, f.todo.id);
  await updateTodo(f.dataDir, f.repo, f.todo.id, {
    integration: { ...current.integration, evidence: { confirmedAt: new Date().toISOString(), source: 'human_worktree' } },
    expectedUpdatedAt: current.updatedAt,
  });
  const before = getTodoById(f.dataDir, f.repo, f.todo.id);
  for (let i = 0; i < 3; i += 1) {
    const outcome = await call(f, { autoIntegrate: true, autoIntegrateMaxFailures: 1 });
    assert.deepEqual({ ok: outcome.ok, reason: outcome.reason, skipped: outcome.skipped }, { ok: false, reason: 'already_integrated', skipped: true });
  }
  const after = getTodoById(f.dataDir, f.repo, f.todo.id);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.deepEqual(after.integration, before.integration);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']).trim(), f.baseCommit);
  const audit = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).automaticIntegrations;
  assert.equal(audit.filter((entry) => entry.skipped !== true).length, 0);
});

test('an already integrated state is never reverted to awaiting by an attempt', async (t) => {
  const f = await fixture(t);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true } }, { dataDir: f.dataDir });
  const current = getTodoById(f.dataDir, f.repo, f.todo.id);
  const confirmed = await confirmWorkspaceTodoIntegration({
    workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id, expectedUpdatedAt: current.updatedAt, proof: { simple: true },
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const before = getTodoById(f.dataDir, f.repo, f.todo.id);
  assert.equal(before.integration.state, 'integrated');
  const outcome = await call(f, { autoIntegrate: true, autoIntegrateMaxFailures: 1 });
  assert.equal(outcome.reason, 'already_integrated');
  const after = getTodoById(f.dataDir, f.repo, f.todo.id);
  assert.equal(after.integration.state, 'integrated');
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.status, before.status);
});

test('a patch already present in HEAD is "already integrated", not an integration_conflict failure', async (t) => {
  const f = await fixture(t);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true } }, { dataDir: f.dataDir });
  // Someone landed the same change by hand (like a1d15b89 in the field report).
  fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'leaf\n');
  git(f.repo, ['commit', '-qam', 'manual integration']);
  const head = git(f.repo, ['rev-parse', 'HEAD']).trim();
  const before = getTodoById(f.dataDir, f.repo, f.todo.id);
  for (let i = 0; i < 3; i += 1) {
    const outcome = await call(f, { autoIntegrate: true, autoIntegrateMaxFailures: 1 });
    assert.deepEqual({ ok: outcome.ok, reason: outcome.reason, skipped: outcome.skipped }, { ok: false, reason: 'already_integrated', skipped: true });
  }
  const after = getTodoById(f.dataDir, f.repo, f.todo.id);
  assert.equal(after.integration.state, 'ready');
  assert.equal(after.integration.reason || '', before.integration.reason || '');
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']).trim(), head);
  const audit = getWorkspaceWatcher(f.repo, { dataDir: f.dataDir }).automaticIntegrations;
  assert.equal(audit.length, 1, 'deduped skipped entry');
  assert.equal(audit[0].skipped, true);
  assert.equal(audit[0].reason, 'already_integrated');
});

test('a genuine conflict (HEAD differs from the patch) is still a rejected failure', async (t) => {
  const f = await fixture(t);
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true } }, { dataDir: f.dataDir });
  fs.writeFileSync(path.join(f.repo, 'leaf.txt'), 'someone else\n');
  git(f.repo, ['commit', '-qam', 'diverging change']);
  const outcome = await call(f);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'integration_conflict');
  assert.equal(outcome.skipped, undefined);
});

test('failure_limit names every distinct cause and leaf behind the counter', async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const entries = [
    { todoId: 'aaaa1111', at: new Date(now - 3000).toISOString(), ok: false, reason: 'integration_conflict' },
    { todoId: 'bbbb2222', at: new Date(now - 2000).toISOString(), ok: false, reason: 'typecheck_regression' },
    { todoId: 'aaaa1111', at: new Date(now - 1000).toISOString(), ok: false, reason: 'integration_conflict' },
  ];
  upsertWorkspaceWatcher(f.repo, { mode: 'autopilot', policy: { autoIntegrate: true }, automaticIntegrations: entries }, { dataDir: f.dataDir });
  const outcome = await call(f, { autoIntegrate: true, autoIntegrateMaxFailures: 3 });
  assert.equal(outcome.reason, 'integration_failure_limit');
  assert.deepEqual(outcome.failure.causes, ['integration_conflict', 'typecheck_regression']);
  assert.deepEqual(outcome.failure.todoIds, ['aaaa1111', 'bbbb2222']);
  assert.equal(outcome.failure.cause, 'integration_conflict');
});

test('materialization mismatch wakes the operator once per real stop, never on a repeat', async (t) => {
  const { f, attempt } = await mismatchThenResume(t, { existingRow: true });
  const stops = () => listOperatorEventsSince(f.repo, { kinds: ['watcher_stopped'] }, { dataDir: f.dataDir }).events;
  assert.equal(stops().length, 1, 'the first stop is a transition');
  // Still stopped: the next attempt stops early and records nothing.
  await attempt();
  assert.equal(stops().length, 1);
  // Cleared and failing again on resume: a new real stop, so one more event.
  clearStop(f);
  const stuck = await attempt();
  assert.match(String(stuck.reason), /^materialization_mismatch/);
  assert.equal(stops().length, 2);
});
