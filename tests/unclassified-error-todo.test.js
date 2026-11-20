import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { noteUnclassifiedRunError } from '../lib/harness-usage-limits.js';
import { resolveProjectPath } from '../lib/runtime-paths.js';
import { listTodos } from '../lib/persist/todos-store.js';
import { resetUnclassifiedRegistries, syncUnclassifiedErrors } from '../lib/usage/unclassified-errors.js';

function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-unclassified-todo-'));
  resetUnclassifiedRegistries();
  const todos = [];
  const findTodoBySignature = async (id) => todos.find((todo) => todo.body.includes(`unclassified-error-signature: ${id}`));
  const createTodo = async (todo) => { todos.push(todo); return todo; };
  return { dataDir, todos, createTodo, findTodoBySignature, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

function record(dataDir, message, extra = {}) {
  noteUnclassifiedRunError({ harness: 'sdk', model: 'model-a', message, dataDir, ...extra });
}

function setOccurrenceWindow(dataDir, firstSeenAt, lastSeenAt) {
  const file = path.join(dataDir, 'usage', 'unclassified-errors.jsonl');
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  rows[0].firstSeenAt = firstSeenAt;
  rows[0].lastSeenAt = lastSeenAt;
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('recurring unclassified error creates one idea todo with stable marker', async () => {
  const t = setup();
  try {
    for (let i = 0; i < 3; i += 1) record(t.dataDir, 'provider returned an unknown response', { context: { chatId: 'chat-1' } });
    await syncUnclassifiedErrors({ dataDir: t.dataDir, createTodo: t.createTodo, findTodoBySignature: t.findTodoBySignature });
    await syncUnclassifiedErrors({ dataDir: t.dataDir, createTodo: t.createTodo, findTodoBySignature: t.findTodoBySignature });
    assert.equal(t.todos.length, 1);
    assert.equal(t.todos[0].status, 'idea');
    assert.match(t.todos[0].body, /unclassified-error-signature: [0-9a-f]{16}/);
    assert.match(t.todos[0].body, /Redacted message: provider returned an unknown response/);
    assert.match(t.todos[0].body, /Occurrences: 3/);
  } finally { t.done(); }
});

test('does not create todo below threshold', async () => {
  const t = setup();
  try {
    record(t.dataDir, 'provider returned an unknown response');
    record(t.dataDir, 'provider returned an unknown response');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, createTodo: t.createTodo, findTodoBySignature: t.findTodoBySignature });
    assert.equal(t.todos.length, 0);
  } finally { t.done(); }
});

test('skips tool_not_found signatures', async () => {
  const t = setup();
  try {
    for (let i = 0; i < 3; i += 1) record(t.dataDir, 'tool xyz not found');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, createTodo: t.createTodo, findTodoBySignature: t.findTodoBySignature });
    assert.equal(t.todos.length, 0);
  } finally { t.done(); }
});

test('three new occurrences within a later 24-hour window trigger after an old first occurrence', async () => {
  const t = setup();
  try {
    const day1 = '2026-01-01T10:00:00.000Z';
    const day3 = '2026-01-03T10:00:00.000Z';
    record(t.dataDir, 'provider returned an unknown response');
    setOccurrenceWindow(t.dataDir, day1, day1);
    await syncUnclassifiedErrors({ dataDir: t.dataDir, createTodo: t.createTodo, findTodoBySignature: t.findTodoBySignature });
    for (let i = 0; i < 3; i += 1) record(t.dataDir, 'provider returned an unknown response');
    setOccurrenceWindow(t.dataDir, day1, day3);
    await syncUnclassifiedErrors({ dataDir: t.dataDir, createTodo: t.createTodo, findTodoBySignature: t.findTodoBySignature });
    assert.equal(t.todos.length, 1);
  } finally { t.done(); }
});

test('context workspace changes do not create another todo in a separate workspace store', async () => {
  const t = setup();
  const workspaceA = mkdtempSync(path.join(tmpdir(), 'cretli-unclassified-ws-a-'));
  const workspaceB = mkdtempSync(path.join(tmpdir(), 'cretli-unclassified-ws-b-'));
  try {
    const stores = new Map([[workspaceA, []], [workspaceB, []]]);
    const createTodo = async (todo) => { stores.get(todo.workspaceFolder).push(todo); };
    const findTodoBySignature = async (id) => [...stores.values()].flat().find((todo) => todo.body.includes(`unclassified-error-signature: ${id}`));
    for (let i = 0; i < 3; i += 1) record(t.dataDir, 'provider returned an unknown response', { context: { workspaceFolder: workspaceA } });
    await syncUnclassifiedErrors({ dataDir: t.dataDir, createTodo, findTodoBySignature });
    record(t.dataDir, 'provider returned an unknown response', { context: { workspaceFolder: workspaceB } });
    await syncUnclassifiedErrors({ dataDir: t.dataDir, createTodo, findTodoBySignature });
    assert.equal(stores.get(workspaceA).length + stores.get(workspaceB).length, 1);
    assert.equal(stores.get(workspaceA).length, 1);
  } finally {
    t.done();
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  }
});

test('omitted repoRoot uses the project root while explicit dataDir is preserved', async () => {
  const t = setup();
  try {
    for (let i = 0; i < 3; i += 1) record(t.dataDir, 'provider returned an unknown response');
    await syncUnclassifiedErrors({ dataDir: t.dataDir });
    const listed = await listTodos(t.dataDir, resolveProjectPath());
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].status, 'idea');
  } finally { t.done(); }
});
