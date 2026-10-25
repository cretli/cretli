/**
 * Route-level tests for the workspace quick-switch endpoints.
 *
 * Reuses the fake express app + throwaway git repository pattern from
 * `git-routes-scope.test.js`: `GET /api/git/branches` must parse
 * `for-each-ref` output (including names `normalizeGitArg` rejects) and the
 * guarded `switch` action must refuse while any work is live in the workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGitBranchRefs, registerGitRoutes } from '../lib/routes/git-routes.js';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-git-branches-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', 'tracked.txt'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/**
 * @param {(req: object) => object} resolveScope
 * @param {object} [extraCtx] e.g. gitGuardDeps
 */
function makeApp(resolveScope, extraCtx = {}) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
  };
  registerGitRoutes(app, { getCurrentCwd: () => repo, resolveScope, ...extraCtx });
  const invoke = (method, urlPath, req = {}) => {
    const fn = handlers.get(`${method} ${urlPath}`);
    if (!fn) throw new Error(`no handler ${method} ${urlPath}`);
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); },
      };
      fn({ params: {}, query: {}, body: {}, ...req }, res);
    });
  };
  return { invoke };
}

const repo = makeRepo();

function workspaceScope() {
  return {
    ok: true,
    source: 'workspace',
    chatId: '',
    todoId: '',
    workspaceFolder: repo,
    executionFolder: repo,
    isWorktree: false,
    worktree: null,
    todo: null,
    chat: null,
  };
}

test.after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test('parseGitBranchRefs reads for-each-ref output and flags arg-unsafe names', () => {
  const parsed = parseGitBranchRefs('main\t*\nfeature/one\t\nweird+branch\t\n@odd\t\n');
  assert.deepEqual(parsed, [
    { name: 'main', current: true, argSafe: true },
    { name: 'feature/one', current: false, argSafe: true },
    { name: 'weird+branch', current: false, argSafe: false },
    { name: '@odd', current: false, argSafe: false },
  ]);
  assert.deepEqual(parseGitBranchRefs(''), []);
  assert.deepEqual(parseGitBranchRefs(null), []);
});

test('branches endpoint lists local branches with the current marker', async () => {
  execFileSync('git', ['branch', 'feature/one'], { cwd: repo });
  const { invoke } = makeApp(() => workspaceScope());
  const res = await invoke('GET', '/api/git/branches');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, 'workspace');
  const names = res.body.branches.map((branch) => branch.name);
  assert.ok(names.includes('main'));
  assert.ok(names.includes('feature/one'));
  const current = res.body.branches.find((branch) => branch.current);
  assert.equal(current.name, 'main');
});

test('branches endpoint reports a non-repo without crashing', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-git-norepo-'));
  try {
    const { invoke } = makeApp(() => ({ ...workspaceScope(), workspaceFolder: emptyDir, executionFolder: emptyDir }));
    const res = await invoke('GET', '/api/git/branches');
    assert.equal(res.body.ok, false);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('switch is allowed when the workspace has no live work', async () => {
  execFileSync('git', ['branch', 'feature/two'], { cwd: repo });
  const { invoke } = makeApp(() => workspaceScope(), {
    gitGuardDeps: {
      loadChats: () => [],
      listActiveDelegations: () => [],
      loadWorkspaceWatchers: () => [],
    },
  });
  const res = await invoke('POST', '/api/git/run', { body: { action: 'switch', arg: 'feature/two' } });
  assert.equal(res.body.ok, true, res.body.error || '');
  const back = await invoke('POST', '/api/git/run', { body: { action: 'switch', arg: 'main' } });
  assert.equal(back.body.ok, true, back.body.error || '');
});

test('switch is refused with workspace_busy while a chat runs in the repo', async () => {
  execFileSync('git', ['branch', 'feature/three'], { cwd: repo });
  const { invoke } = makeApp(() => workspaceScope(), {
    gitGuardDeps: {
      loadChats: () => [{ id: 'chat-1', executionFolder: repo }],
      probeChatRunLiveness: () => ({ known: true, busy: true }),
      listActiveDelegations: () => [],
      loadWorkspaceWatchers: () => [],
    },
  });
  const res = await invoke('POST', '/api/git/run', { body: { action: 'switch', arg: 'feature/three' } });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'workspace_busy');
  // The current branch did not change.
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).toString().trim();
  assert.equal(branch, 'main');
});

test('switch is refused while a watcher cycle is active in the workspace', async () => {
  execFileSync('git', ['branch', 'feature/four'], { cwd: repo });
  const { invoke } = makeApp(() => workspaceScope(), {
    gitGuardDeps: {
      loadChats: () => [],
      listActiveDelegations: () => [],
      loadWorkspaceWatchers: () => [{ workspaceFolder: repo }],
      getWorkspaceWatcherActiveCycles: () => [{ cycleId: 'cycle-1' }],
    },
  });
  const res = await invoke('POST', '/api/git/run', { body: { action: 'switch', arg: 'feature/four' } });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'workspace_busy');
});

test('switch still rejects an option-like argument before the guard runs', async () => {
  const { invoke } = makeApp(() => workspaceScope(), {
    gitGuardDeps: {
      loadChats: () => [{ id: 'chat-1', executionFolder: repo }],
      probeChatRunLiveness: () => ({ known: true, busy: true }),
      listActiveDelegations: () => [],
      loadWorkspaceWatchers: () => [],
    },
  });
  const res = await invoke('POST', '/api/git/run', { body: { action: 'switch', arg: '-ff' } });
  assert.equal(res.body.ok, false);
  assert.notEqual(res.body.code, 'workspace_busy');
});
