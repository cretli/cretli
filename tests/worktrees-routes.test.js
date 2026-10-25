/**
 * Worktree routes: list, merge refusal, reject and cleanup guards. A fake
 * express app keeps the test free of HTTP and auth; repositories live in tmp.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import {
  ensureWorktree, isOnlyLeafCheckpointsAhead, isOnlyLeafCheckpointsAheadAsync, updateWorktreeState,
} from '../lib/worktree-manager.js';
import { listWorkspaceWorktrees, listWorkspaceWorktreesAsync } from '../lib/worktree-list.js';
import { invalidateWorktreeListCache } from '../lib/worktree-list-cache.js';
import { registerWorktreesRoutes } from '../lib/routes/worktrees-routes.js';
import { createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

/**
 * @param {string} dataDir
 * @param {string} repo
 */
function makeApp(dataDir, repo) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    use() {},
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
  };
  registerWorktreesRoutes(app, {
    dataDir,
    getCurrentCwd: () => repo,
    getCurrentWorkspaceFile: () => '',
    getLocalCallbackBaseUrl: () => 'https://127.0.0.1:3011',
    useHttps: true,
  });
  const invoke = (method, pattern, params = {}, req = {}) => {
    const fn = handlers.get(`${method} ${pattern}`);
    if (!fn) throw new Error(`no handler ${method} ${pattern}`);
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); },
        on() {},
      };
      fn({ params, query: {}, body: {}, headers: {}, ...req }, res);
    });
  };
  return { invoke };
}

/**
 * @param {string} name
 */
function makeSuite(name) {
  const dataDir = tempDir(`cretli-wr-data-${name}-`);
  const baseDir = tempDir(`cretli-wr-base-${name}-`);
  const repo = createTempRepo().dir;
  const todo = addTodo(dataDir, repo, { title: `routes ${name}`, status: 'doing', executionMode: 'worktree' }).item;
  const created = ensureWorktree({
    todoId: todo.id, workspaceFolder: repo, mode: 'worktree', config: worktreeConfig(baseDir), registryOptions: { dataDir },
  });
  fs.writeFileSync(path.join(created.record.worktreePath, 'feature.txt'), 'feature\n');
  return {
    dataDir, repo, todo, record: created.record, app: makeApp(dataDir, repo),
    cleanup: () => { for (const dir of [dataDir, baseDir, repo]) fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('GET /api/worktrees/list returns reconciled rows for the workspace', async (t) => {
  const suite = makeSuite('list');
  t.after(suite.cleanup);
  const { status, body } = await suite.app.invoke('GET', '/api/worktrees/list');
  assert.equal(status, 200);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].todoId, suite.todo.id);
  assert.equal(body.rows[0].actions.merge, true);
  assert.equal(body.rows[0].worktreePath, suite.record.worktreePath);
});

test('an unknown todo id is a 404 on every action', async (t) => {
  const suite = makeSuite('unknown');
  t.after(suite.cleanup);
  for (const [method, route] of [
    ['GET', '/api/worktrees/:todoId/diff'],
    ['GET', '/api/worktrees/:todoId/merge-preview'],
    ['POST', '/api/worktrees/:todoId/merge'],
    ['POST', '/api/worktrees/:todoId/reject'],
    ['POST', '/api/worktrees/:todoId/cleanup'],
  ]) {
    const { status } = await suite.app.invoke(method, route, { todoId: 'nope' });
    assert.equal(status, 404, route);
  }
});

test('merge is refused with the blocker list and leaves the todo untouched', async (t) => {
  const suite = makeSuite('merge-blocked');
  t.after(suite.cleanup);
  fs.writeFileSync(path.join(suite.repo, 'local.txt'), 'wip\n');
  const { status, body } = await suite.app.invoke('POST', '/api/worktrees/:todoId/merge', { todoId: suite.todo.id }, {
    body: { agentTransport: 'opencode', model: 'auto' },
  });
  assert.equal(status, 409);
  assert.equal(body.error, 'dirty_workspace');
  assert.ok(body.blockers.some((row) => row.code === 'dirty_workspace'));
  assert.equal(getTodoById(suite.dataDir, suite.repo, suite.todo.id).integration, undefined);
});

test('merge preview exposes the preflight facts', async (t) => {
  const suite = makeSuite('preview');
  t.after(suite.cleanup);
  const { status, body } = await suite.app.invoke('GET', '/api/worktrees/:todoId/merge-preview', { todoId: suite.todo.id });
  assert.equal(status, 200);
  assert.equal(body.preflight.targetBranch, 'main');
  assert.equal(body.preflight.uncommittedFiles, 1);
});

test('cleanup of an unintegrated worktree needs the discard confirmation naming the branch', async (t) => {
  const suite = makeSuite('cleanup');
  t.after(suite.cleanup);
  const refused = await suite.app.invoke('POST', '/api/worktrees/:todoId/cleanup', { todoId: suite.todo.id }, { body: {} });
  assert.equal(refused.status, 409);
  assert.ok(fs.existsSync(suite.record.worktreePath));
  const wrongBranch = await suite.app.invoke('POST', '/api/worktrees/:todoId/cleanup', { todoId: suite.todo.id }, {
    body: { discard: true, confirmBranch: 'something-else' },
  });
  assert.equal(wrongBranch.status, 400);
  assert.ok(fs.existsSync(suite.record.worktreePath));
  const discarded = await suite.app.invoke('POST', '/api/worktrees/:todoId/cleanup', { todoId: suite.todo.id }, {
    body: { discard: true, confirmBranch: suite.record.branch },
  });
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.equal(fs.existsSync(suite.record.worktreePath), false);
  assert.match(git(suite.repo, ['branch', '--list', suite.record.branch]), new RegExp(suite.record.branch.split('/').pop()));
});

test('async list matches the sync list row for row', async (t) => {
  const suite = makeSuite('async-parity');
  t.after(suite.cleanup);
  fs.writeFileSync(path.join(suite.record.worktreePath, 'second.txt'), 'two\n');
  git(suite.record.worktreePath, ['add', 'feature.txt']);
  git(suite.record.worktreePath, ['commit', '-m', 'work on feature']);
  invalidateWorktreeListCache();
  const sync = listWorkspaceWorktrees({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  const asyncListed = await listWorkspaceWorktreesAsync({ dataDir: suite.dataDir, workspaceFolder: suite.repo });
  assert.deepEqual(asyncListed, sync);
  assert.equal(asyncListed.rows[0].aheadCommits, 1);
  assert.equal(asyncListed.rows[0].uncommittedFiles, 1);
});

test('list is cached for a short time and dropped by invalidation', async (t) => {
  const suite = makeSuite('cache');
  t.after(suite.cleanup);
  invalidateWorktreeListCache();
  const input = { dataDir: suite.dataDir, workspaceFolder: suite.repo };
  const first = await listWorkspaceWorktreesAsync(input);
  assert.equal(first.rows[0].uncommittedFiles, 1);
  fs.writeFileSync(path.join(suite.record.worktreePath, 'later.txt'), 'x\n');
  assert.equal((await listWorkspaceWorktreesAsync(input)).rows[0].uncommittedFiles, 1, 'served from cache');
  invalidateWorktreeListCache();
  assert.equal((await listWorkspaceWorktreesAsync(input)).rows[0].uncommittedFiles, 2, 'fresh after invalidation');
});

test('a registry write invalidates the cached list', async (t) => {
  const suite = makeSuite('cache-registry');
  t.after(suite.cleanup);
  invalidateWorktreeListCache();
  const input = { dataDir: suite.dataDir, workspaceFolder: suite.repo };
  assert.equal((await listWorkspaceWorktreesAsync(input)).rows[0].executionState, 'none');
  updateWorktreeState({ todoId: suite.todo.id, executionState: 'execution_closed', registryOptions: { dataDir: suite.dataDir } });
  assert.equal((await listWorkspaceWorktreesAsync(input)).rows[0].executionState, 'execution_closed');
});

test('leaf-checkpoint check: async equals sync, including divergent history', async (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const rev = (ref) => git(repo, ['rev-parse', ref]).trim();
  const base = rev('HEAD');
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(repo, ['checkout', '-b', 'leaf-side']);
  fs.writeFileSync(path.join(repo, 'cp.txt'), '1\n');
  git(repo, ['add', 'cp.txt']);
  git(repo, ['commit', '-m', 'Cretli leaf checkpoint for todo-1']);
  const checkpointHead = rev('HEAD');
  git(repo, ['checkout', branch]);
  fs.writeFileSync(path.join(repo, 'extra.txt'), 'x\n');
  git(repo, ['add', 'extra.txt']);
  git(repo, ['commit', '-m', 'unrelated base-side commit']);
  const divergedBase = rev('HEAD');
  fs.writeFileSync(path.join(repo, 'plain.txt'), 'p\n');
  git(repo, ['add', 'plain.txt']);
  git(repo, ['commit', '-m', 'plain commit']);
  const plainHead = rev('HEAD');
  const cases = [
    [base, checkpointHead], // fast-forward over a checkpoint
    [divergedBase, checkpointHead], // divergent: base has a commit head lacks
    [base, plainHead], // non-checkpoint subjects
    [base, base], // nothing ahead
    [base, ''], // missing head
    [base, 'not-a-ref'], // git failure
  ];
  for (const [b, h] of cases) {
    assert.equal(await isOnlyLeafCheckpointsAheadAsync(repo, b, h), isOnlyLeafCheckpointsAhead(repo, b, h), `${b.slice(0, 7)}..${h.slice(0, 7)}`);
  }
  assert.equal(isOnlyLeafCheckpointsAhead(repo, divergedBase, checkpointHead), false);
  assert.equal(isOnlyLeafCheckpointsAhead(repo, base, checkpointHead), true);
});
