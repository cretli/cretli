/**
 * Git scope resolution and path authorization (lib/git-context.js).
 *
 * The resolver is pure apart from its injected deps, so these tests use fake
 * chat / task / worktree records and never touch the network or a live server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GIT_SCOPE_ERROR_CODES,
  isPathInsideBase,
  normalizeFolder,
  readGitScopeInput,
  resolveGitRequestContext,
  resolvePathWithinBase,
} from '../lib/git-context.js';

function makeDeps(overrides = {}) {
  const chats = overrides.chats || [];
  const todos = overrides.todos || {};
  const worktrees = overrides.worktrees || {};
  return {
    loadChats: () => chats,
    getTodoById: (dataDir, cwd, id) => (todos[id] && todos[id].workspaceFolder === cwd ? todos[id] : null),
    getWorktreeRecord: (todoId) => worktrees[todoId] || null,
  };
}

function resolve(req, deps, getCurrentCwd = () => '/global/cwd') {
  return resolveGitRequestContext(req, { dataDir: '/data', getCurrentCwd, deps });
}

test('no scope falls back to the global cwd', () => {
  const result = resolve({ query: {}, body: {} }, makeDeps(), () => '/global/cwd');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'global');
  assert.equal(result.executionFolder, '/global/cwd');
  assert.equal(result.workspaceFolder, '/global/cwd');
  assert.equal(result.isWorktree, false);
});

test('chat scope uses its stored execution folder', () => {
  const deps = makeDeps({
    chats: [{ id: 'chat-1', title: 'A', workspaceFolder: '/project', executionFolder: '/wt/todo-9' }],
  });
  const result = resolve({ query: { chatId: 'chat-1' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'chat');
  assert.equal(result.executionFolder, '/wt/todo-9');
  assert.equal(result.workspaceFolder, '/project');
  assert.equal(result.chatId, 'chat-1');
});

test('chat scope without an explicit execution folder uses the logical workspace', () => {
  const deps = makeDeps({ chats: [{ id: 'chat-1', workspaceFolder: '/project' }] });
  const result = resolve({ query: { chatId: 'chat-1' } }, deps);
  assert.equal(result.executionFolder, '/project');
  assert.equal(result.source, 'chat');
});

test('a client workspace cannot override the stored chat workspace', () => {
  const deps = makeDeps({ chats: [{ id: 'chat-1', workspaceFolder: '/project-a' }] });
  const result = resolve({ query: { chatId: 'chat-1', workspaceFolder: '/project-b' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'chat');
  assert.equal(result.executionFolder, '/project-a');
  assert.equal(result.workspaceFolder, '/project-a');
});

test('a chat without stored folders never uses the client workspace as execution folder', () => {
  const deps = makeDeps({ chats: [{ id: 'chat-1' }] });
  const result = resolve({ query: { chatId: 'chat-1', workspaceFolder: '/project-b' } }, deps, () => '/global/cwd');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'chat');
  assert.notEqual(result.executionFolder, path.resolve('/project-b'));
  assert.equal(result.executionFolder, '/global/cwd');
});

test('todo scope with a live worktree resolves the worktree path', () => {
  const deps = makeDeps({
    todos: { 'todo-9': { id: 'todo-9', title: 'Fix', status: 'doing', workspaceFolder: '/project' } },
    worktrees: {
      'todo-9': {
        todoId: 'todo-9',
        workspaceFolder: '/project',
        worktreePath: '/worktrees/todo-9',
        branch: 'todo/todo-9',
        baseCommit: 'abcdef1234567890',
        executionState: 'active',
        integrationState: 'ready',
        integration: { readyAt: '2026-01-01T00:00:00.000Z' },
      },
    },
  });
  const result = resolve({ query: { todoId: 'todo-9', workspaceFolder: '/project' } }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'worktree');
  assert.equal(result.isWorktree, true);
  assert.equal(result.executionFolder, '/worktrees/todo-9');
  assert.equal(result.worktree.branch, 'todo/todo-9');
  assert.equal(result.worktree.baseCommit, 'abcdef1234567890');
  assert.equal(result.worktree.integrationState, 'ready');
  assert.equal(result.todo.title, 'Fix');
});

test('todo scope in project mode keeps the logical workspace', () => {
  const deps = makeDeps({
    todos: { 'todo-1': { id: 'todo-1', title: 'Doc', status: 'ready', workspaceFolder: '/project' } },
  });
  const result = resolve({ query: { todoId: 'todo-1', workspaceFolder: '/project' } }, deps);
  assert.equal(result.source, 'todo');
  assert.equal(result.isWorktree, false);
  assert.equal(result.executionFolder, '/project');
});

test('a cleaned worktree record is ignored', () => {
  const deps = makeDeps({
    todos: { 'todo-1': { id: 'todo-1', workspaceFolder: '/project' } },
    worktrees: {
      'todo-1': { todoId: 'todo-1', worktreePath: '/worktrees/old', branch: 'b', baseCommit: 'a', cleanedAt: '2026-01-02T00:00:00.000Z' },
    },
  });
  const result = resolve({ query: { todoId: 'todo-1', workspaceFolder: '/project' } }, deps);
  assert.equal(result.isWorktree, false);
  assert.equal(result.executionFolder, '/project');
});

test('an unknown chat is refused instead of falling back to the global cwd', () => {
  const result = resolve({ query: { chatId: 'missing' } }, makeDeps());
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_SCOPE_ERROR_CODES.CHAT_NOT_FOUND);
});

test('an unknown task is refused', () => {
  const result = resolve({ query: { todoId: 'missing', workspaceFolder: '/project' } }, makeDeps());
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_SCOPE_ERROR_CODES.TODO_NOT_FOUND);
});

test('a task scope without a workspace folder is refused', () => {
  const result = resolve({ query: { todoId: 'todo-1' } }, makeDeps());
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_SCOPE_ERROR_CODES.WORKSPACE_REQUIRED);
});

test('a chat id paired with a foreign task id is a conflict', () => {
  const deps = makeDeps({ chats: [{ id: 'chat-1', todoId: 'todo-a', workspaceFolder: '/project' }] });
  const result = resolve({ query: { chatId: 'chat-1', todoId: 'todo-b' } }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_SCOPE_ERROR_CODES.CONTEXT_CONFLICT);
});

test('readGitScopeInput reads query first, then body, and ignores client execution folders', () => {
  const input = readGitScopeInput({
    query: { chatId: 'chat-1' },
    body: { chatId: 'chat-2', todoId: 'todo-1', workspaceFolder: '/project', executionFolder: '/etc' },
  });
  assert.deepEqual(input, { chatId: 'chat-1', todoId: 'todo-1', workspaceFolder: path.resolve('/project') });
});

test('isPathInsideBase accepts the base and descendants, rejects siblings', () => {
  assert.equal(isPathInsideBase('/a/b', '/a/b'), true);
  assert.equal(isPathInsideBase('/a/b', '/a/b/c'), true);
  assert.equal(isPathInsideBase('/a/b', '/a/bc'), false);
  assert.equal(isPathInsideBase('/a/b', '/a'), false);
});

test('resolvePathWithinBase accepts a file inside the base and rejects traversal', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-git-scope-'));
  const inside = path.join(base, 'src');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'a.txt'), 'hi');
  try {
    const ok = resolvePathWithinBase(base, 'src/a.txt');
    assert.equal(ok.ok, true);
    assert.equal(ok.relPosix, 'src/a.txt');
    const escape = resolvePathWithinBase(base, '../outside.txt');
    assert.equal(escape.ok, false);
    assert.match(escape.error, /outside/i);
    const absolute = resolvePathWithinBase(base, '/etc/passwd');
    assert.equal(absolute.ok, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolvePathWithinBase still resolves a deleted file through its parent', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-git-scope-'));
  try {
    const result = resolvePathWithinBase(base, 'removed.txt');
    assert.equal(result.ok, true);
    assert.equal(result.relPosix, 'removed.txt');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('normalizeFolder resolves relative paths and keeps absolute ones', () => {
  assert.equal(normalizeFolder('/a/b'), path.resolve('/a/b'));
  assert.equal(normalizeFolder(''), '');
});
