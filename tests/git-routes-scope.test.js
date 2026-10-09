/**
 * Route-level Git scope tests.
 *
 * A tiny fake express app keeps the test free of HTTP, auth and a live server;
 * a throwaway local Git repository gives the routes a real folder without any
 * network. The authorized execution folder is injected through `resolveScope`
 * so the test asserts the route uses the resolved scope, not a global cwd.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerGitRoutes } from '../lib/routes/git-routes.js';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-git-routes-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', 'tracked.txt'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/**
 * @param {(req: object) => object} resolveScope
 * @param {string} repo
 */
function makeApp(resolveScope, repo) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
  };
  registerGitRoutes(app, { getCurrentCwd: () => repo, resolveScope });
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
const otherRepo = makeRepo();

function scopeFor(executionFolder, extra = {}) {
  return {
    ok: true,
    source: extra.source || (extra.isWorktree ? 'worktree' : 'chat'),
    chatId: 'chat-1',
    todoId: extra.todoId || '',
    workspaceFolder: repo,
    executionFolder,
    isWorktree: extra.isWorktree === true,
    worktree: extra.worktree || null,
    todo: extra.todo || null,
    chat: { id: 'chat-1', title: 'Chat' },
  };
}

test.after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(otherRepo, { recursive: true, force: true });
});

test('info runs in the authorized execution folder and reports the scope', async () => {
  const { invoke } = makeApp(() => scopeFor(repo, {
    isWorktree: true,
    todoId: 'todo-1',
    worktree: { branch: 'todo/todo-1', baseCommit: 'abc', worktreePath: repo, integrationState: 'ready' },
    todo: { id: 'todo-1', title: 'Task', integration: { state: 'ready' } },
  }), repo);
  const res = await invoke('GET', '/api/git/info');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.isRepo, true);
  assert.equal(res.body.cwd, repo);
  assert.equal(res.body.isWorktree, true);
  assert.equal(res.body.todoId, 'todo-1');
  assert.equal(res.body.worktree.branch, 'todo/todo-1');
  assert.equal(res.body.branch, 'main');
});

test('info never falls back to the global cwd when the scope resolver fails', async () => {
  const { invoke } = makeApp(() => ({ ok: false, code: 'chat_not_found', error: 'Unknown chat: x' }), otherRepo);
  const res = await invoke('GET', '/api/git/info', { query: { chatId: 'x' } });
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'chat_not_found');
  assert.equal(res.body.cwd, undefined);
});

test('file-diff rejects a path outside the authorized folder', async () => {
  const { invoke } = makeApp(() => scopeFor(repo), repo);
  const escape = await invoke('GET', '/api/git/file-diff', { query: { path: '../outside.txt' } });
  assert.equal(escape.status, 400);
  assert.equal(escape.body.ok, false);
  assert.match(escape.body.error, /outside/i);

  const absolute = await invoke('GET', '/api/git/file-diff', { query: { path: '/etc/passwd' } });
  assert.equal(absolute.status, 400);
});

test('file-diff returns a diff for a tracked file in the authorized folder', async () => {
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n');
  const { invoke } = makeApp(() => scopeFor(repo), repo);
  const res = await invoke('GET', '/api/git/file-diff', { query: { path: 'tracked.txt' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.diff, /\+two/);
});

test('git run executes in the authorized folder', async () => {
  const { invoke } = makeApp(() => scopeFor(repo), repo);
  const res = await invoke('POST', '/api/git/run', { body: { action: 'status' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.executionFolder, repo);
  const unknown = await invoke('POST', '/api/git/run', { body: { action: 'definitely-not-an-action' } });
  assert.equal(unknown.body.ok, false);
});

test('two scopes resolve to different folders in the same route registration', async () => {
  let current = repo;
  const { invoke } = makeApp(() => scopeFor(current), repo);
  const first = await invoke('GET', '/api/git/info');
  assert.equal(first.body.cwd, repo);
  current = otherRepo;
  const second = await invoke('GET', '/api/git/info');
  assert.equal(second.body.cwd, otherRepo);
  assert.notEqual(first.body.cwd, second.body.cwd);
});
