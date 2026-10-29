import './helpers/isolated-data-dir.js';
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
import { integrateGitResult, acceptMovedTypeErrors, runIntegrationGates } from '../lib/integration/git-integrator.js';
import {
  FRONTEND_SMOKE_STOP_REASON,
  automaticallyIntegrateWorkspaceTodo,
  markTodoIntegrationReady,
} from '../lib/workspace-watcher-integration.js';
import { addTodo, getTodoById, loadTodosData } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, mutateWorkspaceWatcherRow, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { worktreeResultPatchPath } from '../lib/worktree/worktree-result.ts';

async function fixture(t) {
  const { dir: repo, baseCommit } = createTempRepo({ file: 'leaf.txt', content: 'base\n' });
  const dataDir = tempDir('cretli-auto-data-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  git(repo, ['config', 'user.name', 'Cretli Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'leaf.txt'), 'leaf\n');
  const patch = git(repo, ['diff', '--binary']);
  fs.writeFileSync(path.join(repo, 'leaf.txt'), 'base\n');
  const todo = addTodo(dataDir, repo, { title: 'Integrate leaf', status: 'doing' }).items.at(-1);
  const patchPath = worktreeResultPatchPath(dataDir, todo.id, 'cycle-1');
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, patch);
  const prepared = { ...result, todoId: todo.id, patchPath, baseCommit, materialRevision: 'reviewed-material',
    patchSha256: createHash('sha256').update(patch).digest('hex'), changedFiles: [{ path: 'leaf.txt' }] };
  mutateWorktreeRegistry((doc) => {
    doc.items[todo.id] = { todoId: todo.id, workspaceFolder: repo, worktreePath: repo, branch: 'leaf', baseCommit,
      creationState: 'ready', executionState: 'execution_closed', integrationState: 'ready', results: {} };
    return { changed: true };
  }, { dataDir });
  assert.equal((await markTodoIntegrationReady({ todoId: todo.id, workspaceFolder: repo, dataDir, cycleId: 'cycle-1', result: prepared })).ok, true);
  return { repo, dataDir, todo, prepared, baseCommit };
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
  assert.equal(git(f.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim(), 'leaf.txt');
  assert.equal(git(f.repo, ['diff', '--cached', '--binary']), staged);
  assert.equal(fs.readFileSync(path.join(f.repo, 'foreign.txt'), 'utf8'), 'unstaged\n');
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
  assert.equal((await call(f)).reason, 'protected_workspace_change');
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
    assert.equal(fs.readFileSync(path.join(candidate, baseline), 'utf8'), 'master baseline\n');
    fs.writeFileSync(path.join(candidate, baseline), 'recomputed\n');
    fs.writeFileSync(path.join(candidate, 'unrelated.txt'), 'gate output\n');
  } });
  assert.equal(outcome.ok, true);
  assert.equal(fs.readFileSync(path.join(f.repo, baseline), 'utf8'), 'recomputed\n');
  assert.equal(git(f.repo, ['show', 'HEAD:unrelated.txt'], { allowFailure: true }), '');
  assert.equal(fs.existsSync(path.join(f.repo, 'unrelated.txt')), false);
});

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
