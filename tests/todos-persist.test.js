import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  addTodo,
  deleteTodo,
  loadTodosData,
  TODOS_MAX_ITEMS,
  updateTodo,
  workspaceKeyFromCwd,
} from '../lib/persist/todos-persist.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cr-todos-'));

runCase('workspaceKeyFromCwd: null/empty', () => {
  assert.equal(workspaceKeyFromCwd(''), null);
  assert.equal(workspaceKeyFromCwd(null), null);
});

runCase('loadTodosData: empty dir', () => {
  const dataDir = path.join(tmpRoot, 'd1');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd1proj');
  mkdirSync(project, { recursive: true });
  const doc = loadTodosData(dataDir, project);
  assert.equal(doc.version, 2);
  assert.ok(Array.isArray(doc.items));
  assert.equal(doc.items.length, 0);
});

runCase('addTodo + load round-trip', () => {
  const dataDir = path.join(tmpRoot, 'd2');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd2proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: '  Hello  ', body: 'note', status: 'ready' });
  const doc = loadTodosData(dataDir, project);
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].title, 'Hello');
  assert.equal(doc.items[0].body, 'note');
  assert.equal(doc.items[0].status, 'ready');
  assert.ok(doc.items[0].id);
});

runCase('addTodo: requires a title', () => {
  const dataDir = path.join(tmpRoot, 'd3');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd3proj');
  mkdirSync(project, { recursive: true });
  assert.throws(
    () => addTodo(dataDir, project, { title: '   ' }),
    (e) => e.code === 'VALIDATION'
  );
});

runCase('updateTodo: title and status', () => {
  const dataDir = path.join(tmpRoot, 'd4');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd4proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'A' });
  const doc0 = loadTodosData(dataDir, project);
  const id = doc0.items[0].id;
  updateTodo(dataDir, project, id, { title: 'B', status: 'done' });
  const doc = loadTodosData(dataDir, project);
  assert.equal(doc.items[0].title, 'B');
  assert.equal(doc.items[0].status, 'done');
});

runCase('updateTodo: NOT_FOUND', () => {
  const dataDir = path.join(tmpRoot, 'd5');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd5proj');
  mkdirSync(project, { recursive: true });
  assert.throws(() => updateTodo(dataDir, project, 'nope', { title: 'x' }), (e) => e.code === 'NOT_FOUND');
});

runCase('deleteTodo', () => {
  const dataDir = path.join(tmpRoot, 'd6');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd6proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'x' });
  const id = loadTodosData(dataDir, project).items[0].id;
  deleteTodo(dataDir, project, id);
  assert.equal(loadTodosData(dataDir, project).items.length, 0);
});

runCase('updateTodo: sourceHarness persists', () => {
  const dataDir = path.join(tmpRoot, 'd-harness');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd-harness-proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'From OpenCode' });
  const id = loadTodosData(dataDir, project).items[0].id;
  updateTodo(dataDir, project, id, { sourceHarness: 'opencode' });
  const actualItem = loadTodosData(dataDir, project).items[0];
  assert.equal(actualItem.sourceHarness, 'opencode');
  const cleared = updateTodo(dataDir, project, id, { sourceHarness: '' });
  assert.equal(cleared.items[0].sourceHarness, undefined);
});

runCase('updateTodo: chatId link', () => {
  const dataDir = path.join(tmpRoot, 'd9');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd9proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Linked' });
  const id = loadTodosData(dataDir, project).items[0].id;
  updateTodo(dataDir, project, id, { chatId: 'chat-uuid-1', status: 'doing' });
  const doc = loadTodosData(dataDir, project);
  assert.equal(doc.items[0].chatId, 'chat-uuid-1');
  assert.equal(doc.items[0].status, 'doing');
  const cleared = updateTodo(dataDir, project, id, { chatId: null });
  assert.equal(cleared.items[0].chatId, undefined);
});

runCase('updateTodo: plan and changelog', () => {
  const dataDir = path.join(tmpRoot, 'd11');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd11proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Plan task' });
  const id = loadTodosData(dataDir, project).items[0].id;
  updateTodo(dataDir, project, id, {
    plan: { markdown: '## Steps\n1. A' },
    appendChangelog: { kind: 'plan', text: 'Initial plan' },
    linkedChatId: 'chat-a',
  });
  const item = loadTodosData(dataDir, project).items[0];
  assert.match(item.plan.markdown, /Steps/);
  assert.equal(item.changelog.length, 1);
  assert.deepEqual(item.linkedChatIds, ['chat-a']);
});

runCase('deleteTodo returns the removed entry', () => {
  const dataDir = path.join(tmpRoot, 'd10');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd10proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'gone' });
  const id = loadTodosData(dataDir, project).items[0].id;
  const { doc, removed } = deleteTodo(dataDir, project, id);
  assert.equal(doc.items.length, 0);
  assert.equal(removed.id, id);
});

runCase('loadTodosData: recovers from corrupted JSON', () => {
  const dataDir = path.join(tmpRoot, 'd7');
  mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
  const project = path.join(tmpRoot, 'd7proj');
  mkdirSync(project, { recursive: true });
  const key = workspaceKeyFromCwd(project);
  assert.ok(key);
  writeFileSync(path.join(dataDir, 'todos', `${key}.json`), 'not-json', 'utf8');
  const doc = loadTodosData(dataDir, project);
  assert.equal(doc.items.length, 0);
});

runCase('item limit', () => {
  const dataDir = path.join(tmpRoot, 'd8');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'd8proj');
  mkdirSync(project, { recursive: true });
  for (let i = 0; i < TODOS_MAX_ITEMS; i += 1) {
    addTodo(dataDir, project, { title: `t${i}` });
  }
  assert.throws(() => addTodo(dataDir, project, { title: 'overflow' }), (e) => e.code === 'LIMIT');
});

try {
  rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // ignore
}

process.exit(failed ? 1 : 0);
