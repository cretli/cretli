import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  addTodo,
  deleteTodo,
  hashTodoCreateArgs,
  linkTodoChat,
  loadTodosData,
  normalizeTodoReview,
  TODOS_MAX_ITEMS,
  TODOS_MAX_IDEMPOTENCY_ENTRIES,
  TODOS_MAX_IDEMPOTENCY_KEY_LENGTH,
  updateTodo,
  workspaceKeyFromCwd,
  writeTodoReview,
} from '../lib/persist/todos-persist.js';
import {
  registerWorkspaceWatcherAutopilotRunner,
  stopWorkspaceWatcherAutopilotSchedule,
  workspaceWatcherAutopilotPendingDebounceCount,
} from '../lib/workspace-watcher-event-schedule.js';

let failed = 0;

/** @type {Promise<void>[]} */
const pendingCases = [];

function reportFailure(name, err) {
  failed += 1;
  console.error('FAIL:', name);
  console.error(err && err.stack ? err.stack : String(err));
}

function runCase(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingCases.push(result.then(() => console.log('OK:', name), (err) => reportFailure(name, err)));
      return;
    }
    console.log('OK:', name);
  } catch (err) {
    reportFailure(name, err);
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
  assert.equal(doc.version, 3);
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
  updateTodo(dataDir, project, id, { sourceHarness: 'testfake' });
  const actualItem = loadTodosData(dataDir, project).items[0];
  assert.equal(actualItem.sourceHarness, 'testfake');
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

runCase('migration v2 -> v3: roots get siblingIndex from array order, missing parent becomes root', () => {
  const dataDir = path.join(tmpRoot, 'mig');
  mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
  const project = path.join(tmpRoot, 'migproj');
  mkdirSync(project, { recursive: true });
  const key = workspaceKeyFromCwd(project);
  assert.ok(key);
  writeFileSync(path.join(dataDir, 'todos', `${key}.json`), JSON.stringify({
    version: 2,
    updatedAt: '2024-01-01T00:00:00.000Z',
    items: [
      { id: 't1', title: 'One', status: 'idea', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 't2', title: 'Two', status: 'idea', parentId: 'missing-parent', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 't3', title: 'Three', status: 'idea', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
    ],
    idempotency: {},
  }), 'utf8');
  const doc = loadTodosData(dataDir, project);
  assert.equal(doc.version, 3);
  assert.equal(doc.items.length, 3);
  const byTitle = new Map(doc.items.map((row) => [row.title, row]));
  assert.equal(byTitle.get('One').siblingIndex, 0);
  assert.equal(byTitle.get('Two').siblingIndex, 1);
  assert.equal(byTitle.get('Two').parentId, undefined);
  assert.equal(byTitle.get('Three').siblingIndex, 2);
});

runCase('saved file writes version 3', () => {
  const dataDir = path.join(tmpRoot, 'v3');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'v3proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Versioned' });
  const key = workspaceKeyFromCwd(project);
  const raw = JSON.parse(readFileSync(path.join(dataDir, 'todos', `${key}.json`), 'utf8'));
  assert.equal(raw.version, 3);
});

runCase('loadTodosData: normalizes tree fields and drops invalid ones', () => {
  const dataDir = path.join(tmpRoot, 'norm');
  mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
  const project = path.join(tmpRoot, 'normproj');
  mkdirSync(project, { recursive: true });
  const key = workspaceKeyFromCwd(project);
  writeFileSync(path.join(dataDir, 'todos', `${key}.json`), JSON.stringify({
    version: 3,
    updatedAt: '2024-01-01T00:00:00.000Z',
    items: [
      {
        id: 'n1', title: 'Good', status: 'idea',
        assignee: { harness: 'testfake', model: 'glm-x', role: 'implement' },
        runMode: 'sequential',
        orchestratorChatId: 'chat-orch',
        chatId: 'chat-run',
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'n2', title: 'BadHarness', status: 'idea',
        assignee: { harness: 'banana', role: 'plan' },
        runMode: 'weird',
        siblingIndex: -3,
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'n3', title: 'BadRole', status: 'idea',
        assignee: { harness: 'testfake', role: 'wrench' },
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
    idempotency: {},
  }), 'utf8');
  const doc = loadTodosData(dataDir, project);
  const byTitle = new Map(doc.items.map((row) => [row.title, row]));
  const good = byTitle.get('Good');
  assert.deepEqual(good.assignee, { harness: 'testfake', model: 'glm-x', role: 'implement' });
  assert.equal(good.runMode, 'sequential');
  assert.equal(good.orchestratorChatId, 'chat-orch');
  assert.equal(good.chatId, 'chat-run');
  const badHarness = byTitle.get('BadHarness');
  assert.equal(badHarness.assignee, undefined);
  assert.equal(badHarness.runMode, undefined);
  const badRole = byTitle.get('BadRole');
  assert.equal(badRole.assignee, undefined);
});

runCase('addTodo: child with parentId and default sibling position', () => {
  const dataDir = path.join(tmpRoot, 'child');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'childproj');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Root' }).item;
  const first = addTodo(dataDir, project, { title: 'First', parentId: root.id }).item;
  const second = addTodo(dataDir, project, { title: 'Second', parentId: root.id }).item;
  const doc = loadTodosData(dataDir, project);
  const byTitle = new Map(doc.items.map((row) => [row.title, row]));
  assert.equal(byTitle.get('First').parentId, root.id);
  assert.equal(byTitle.get('First').siblingIndex, 0);
  assert.equal(byTitle.get('Second').siblingIndex, 1);
  assert.equal(byTitle.get('Root').siblingIndex, 0);
  assert.equal(first.parentId, root.id);
  assert.equal(second.parentId, root.id);
});

runCase('addTodo: missing parent rejects NOT_FOUND', () => {
  const dataDir = path.join(tmpRoot, 'nopar');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'noparproj');
  mkdirSync(project, { recursive: true });
  assert.throws(
    () => addTodo(dataDir, project, { title: 'Orphan', parentId: 'nope' }),
    (e) => e.code === 'NOT_FOUND'
  );
});

runCase('depth limit: chain of 6 ok, 7th rejected', () => {
  const dataDir = path.join(tmpRoot, 'depth');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'depthproj');
  mkdirSync(project, { recursive: true });
  let parent = addTodo(dataDir, project, { title: 'L1' }).item;
  for (let i = 2; i <= 6; i += 1) {
    parent = addTodo(dataDir, project, { title: `L${i}`, parentId: parent.id }).item;
  }
  assert.throws(
    () => addTodo(dataDir, project, { title: 'L7', parentId: parent.id }),
    (e) => e.code === 'VALIDATION' && /depth/i.test(e.message)
  );
});

runCase('updateTodo: cycle rejected', () => {
  const dataDir = path.join(tmpRoot, 'cyc');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'cycproj');
  mkdirSync(project, { recursive: true });
  const a = addTodo(dataDir, project, { title: 'A' }).item;
  const b = addTodo(dataDir, project, { title: 'B', parentId: a.id }).item;
  assert.throws(
    () => updateTodo(dataDir, project, a.id, { parentId: b.id }),
    (e) => e.code === 'VALIDATION'
  );
  assert.throws(
    () => updateTodo(dataDir, project, a.id, { parentId: a.id }),
    (e) => e.code === 'VALIDATION'
  );
});

runCase('updateTodo: move renumbers old and new sibling groups', () => {
  const dataDir = path.join(tmpRoot, 'move');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'moveproj');
  mkdirSync(project, { recursive: true });
  const r1 = addTodo(dataDir, project, { title: 'R1' }).item;
  const r2 = addTodo(dataDir, project, { title: 'R2' }).item;
  addTodo(dataDir, project, { title: 'A', parentId: r1.id });
  const b = addTodo(dataDir, project, { title: 'B', parentId: r1.id }).item;
  addTodo(dataDir, project, { title: 'C', parentId: r2.id });
  addTodo(dataDir, project, { title: 'D', parentId: r2.id });

  // Move B under R2 at the front of the group.
  updateTodo(dataDir, project, b.id, { parentId: r2.id, siblingIndex: 0 });
  let doc = loadTodosData(dataDir, project);
  const group = (parentId) => doc.items
    .filter((row) => row.parentId === parentId)
    .sort((x, y) => x.siblingIndex - y.siblingIndex)
    .map((row) => row.title);
  assert.deepEqual(group(r1.id), ['A']);
  assert.deepEqual(group(r2.id), ['B', 'C', 'D']);
  const indexes = doc.items.filter((row) => row.parentId === r2.id).map((row) => row.siblingIndex);
  assert.deepEqual(indexes.sort(), [0, 1, 2]);

  // Move B back to root: both groups renumber again.
  updateTodo(dataDir, project, b.id, { parentId: null });
  doc = loadTodosData(dataDir, project);
  const moved = doc.items.find((row) => row.id === b.id);
  assert.equal(moved.parentId, undefined);
  const r1Children = doc.items.filter((row) => row.parentId === r1.id).map((row) => row.siblingIndex);
  assert.deepEqual(r1Children.sort(), [0]);
});

runCase('deleteTodo removes the whole subtree and returns all removed items', () => {
  const dataDir = path.join(tmpRoot, 'subtree');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'subtreeproj');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Root' }).item;
  const mid = addTodo(dataDir, project, { title: 'Mid', parentId: root.id, chatId: 'chat-mid' }).item;
  const leaf = addTodo(dataDir, project, { title: 'Leaf', parentId: mid.id, chatId: 'chat-leaf' }).item;
  addTodo(dataDir, project, { title: 'Other' });
  const { doc, removed, removedItems } = deleteTodo(dataDir, project, root.id);
  assert.equal(removed.id, root.id);
  const removedIds = removedItems.map((row) => row.id).sort();
  assert.deepEqual(removedIds, [root.id, mid.id, leaf.id].sort());
  const remaining = doc.items.map((row) => row.title);
  assert.deepEqual(remaining, ['Other']);
});

runCase('hashTodoCreateArgs: parentId and assignee change the hash', () => {
  const base = { title: 'T', body: 'B', status: 'idea' };
  const rootHash = hashTodoCreateArgs(base);
  assert.notEqual(hashTodoCreateArgs({ ...base, parentId: 'p1' }), rootHash);
  assert.notEqual(
    hashTodoCreateArgs({ ...base, assignee: { harness: 'testfake', role: 'implement' } }),
    rootHash
  );
  assert.notEqual(
    hashTodoCreateArgs({ ...base, assignee: { harness: 'testfake', role: 'review' } }),
    hashTodoCreateArgs({ ...base, assignee: { harness: 'testfake', role: 'implement' } })
  );
  assert.equal(hashTodoCreateArgs({ ...base, parentId: undefined }), rootHash);
});

runCase('idempotency replay detects parentId mismatch as CONFLICT', () => {
  const dataDir = path.join(tmpRoot, 'idem');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'idemproj');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Root' }).item;
  addTodo(dataDir, project, { title: 'Kid', idempotencyKey: 'k1' });
  assert.throws(
    () => addTodo(dataDir, project, { title: 'Kid', idempotencyKey: 'k1', parentId: root.id }),
    (e) => e.code === 'CONFLICT'
  );
});

runCase('idempotency: truncates keys, caps entry count, prunes orphans, clears on delete', () => {
  const dataDir = path.join(tmpRoot, 'idem-bounds');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'idem-bounds-proj');
  mkdirSync(project, { recursive: true });
  const longKey = `k-${'x'.repeat(TODOS_MAX_IDEMPOTENCY_KEY_LENGTH + 40)}`;
  const created = addTodo(dataDir, project, { title: 'Live', idempotencyKey: longKey });
  const liveId = created.item.id;
  const storedKey = Object.keys(created.idempotency)[0];
  assert.equal(storedKey.length, TODOS_MAX_IDEMPOTENCY_KEY_LENGTH);
  const wsKey = workspaceKeyFromCwd(project);
  assert.ok(wsKey);
  const todosPath = path.join(dataDir, 'todos', `${wsKey}.json`);
  /** @type {Record<string, { hash: string, todoId: string }>} */
  const idempotency = {};
  for (let i = 0; i < TODOS_MAX_IDEMPOTENCY_ENTRIES + 10; i += 1) {
    idempotency[`extra-${i}`] = { hash: 'h', todoId: liveId };
  }
  idempotency['orphan-key'] = { hash: 'h', todoId: '00000000-0000-0000-0000-000000000099' };
  writeFileSync(todosPath, JSON.stringify({
    version: 3,
    updatedAt: new Date().toISOString(),
    items: created.items,
    idempotency,
  }));
  const reloaded = loadTodosData(dataDir, project);
  assert.equal(Object.keys(reloaded.idempotency).length, TODOS_MAX_IDEMPOTENCY_ENTRIES);
  assert.equal(reloaded.idempotency['orphan-key'], undefined);
  assert.equal(reloaded.idempotency['extra-0'], undefined, 'oldest extras drop first');
  assert.ok(reloaded.idempotency[`extra-${TODOS_MAX_IDEMPOTENCY_ENTRIES + 9}`]);
  deleteTodo(dataDir, project, liveId);
  const afterDelete = loadTodosData(dataDir, project);
  assert.equal(Object.keys(afterDelete.idempotency).length, 0);
});

runCase('plan approval resets when markdown changes', () => {
  const dataDir = path.join(tmpRoot, 'planreset');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'planresetproj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Approval' });
  const id = loadTodosData(dataDir, project).items[0].id;
  updateTodo(dataDir, project, id, { plan: { markdown: 'v1' } });
  updateTodo(dataDir, project, id, { plan: { approvedAt: '2024-01-01T00:00:00.000Z' } });
  let item = loadTodosData(dataDir, project).items[0];
  assert.ok(item.plan.approvedAt);

  updateTodo(dataDir, project, id, { plan: { markdown: 'v2 different' } });
  item = loadTodosData(dataDir, project).items[0];
  assert.equal(item.plan.approvedAt, undefined);

  // Re-approve, then edit with identical markdown: approval survives.
  updateTodo(dataDir, project, id, { plan: { approvedAt: '2024-01-02T00:00:00.000Z' } });
  updateTodo(dataDir, project, id, { plan: { markdown: 'v2 different' } });
  item = loadTodosData(dataDir, project).items[0];
  assert.equal(item.plan.approvedAt, '2024-01-02T00:00:00.000Z');
});

runCase('strict validation: siblingIndex, assignee, runMode', () => {
  const dataDir = path.join(tmpRoot, 'strict');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'strictproj');
  mkdirSync(project, { recursive: true });
  assert.throws(() => addTodo(dataDir, project, { title: 'X', siblingIndex: 'abc' }), (e) => e.code === 'VALIDATION');
  assert.throws(() => addTodo(dataDir, project, { title: 'X', siblingIndex: -1 }), (e) => e.code === 'VALIDATION');
  assert.throws(() => addTodo(dataDir, project, { title: 'X', siblingIndex: 1.5 }), (e) => e.code === 'VALIDATION');
  assert.throws(
    () => addTodo(dataDir, project, { title: 'X', assignee: { harness: 'banana', role: 'plan' } }),
    (e) => e.code === 'VALIDATION'
  );
  assert.throws(() => addTodo(dataDir, project, { title: 'X', runMode: 'chaotic' }), (e) => e.code === 'VALIDATION');
  const ok = addTodo(dataDir, project, {
    title: 'X',
    assignee: { harness: 'testfake', model: 'm', role: 'review' },
    runMode: 'sequential',
    orchestratorChatId: 'chat-orch-1',
  }).item;
  assert.equal(ok.runMode, 'sequential');
  assert.equal(ok.orchestratorChatId, 'chat-orch-1');
  const cleared = updateTodo(dataDir, project, ok.id, { runMode: null, assignee: null });
  const clearedItem = cleared.items.find((row) => row.id === ok.id);
  assert.equal(clearedItem.runMode, undefined);
  assert.equal(clearedItem.assignee, undefined);
});

runCase('updateTodo: undefined keys (route-style partial patch) keep tree fields and position', () => {
  const dataDir = path.join(tmpRoot, 'partial');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'partialproj');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Root' }).item;
  const first = addTodo(dataDir, project, { title: 'First', parentId: root.id }).item;
  addTodo(dataDir, project, { title: 'Second', parentId: root.id });
  updateTodo(dataDir, project, first.id, {
    chatId: 'chat-1',
    assignee: { harness: 'testfake', model: 'm', role: 'implement' },
  });
  const untouched = {
    chatId: undefined,
    parentId: undefined,
    siblingIndex: undefined,
    assignee: undefined,
    runMode: undefined,
    orchestratorChatId: undefined,
  };
  for (const patch of [{ title: 'First 2' }, { status: 'doing' }, { body: 'notes' }]) {
    updateTodo(dataDir, project, first.id, { ...untouched, ...patch });
  }
  const actual = loadTodosData(dataDir, project).items.find((row) => row.id === first.id);
  assert.equal(actual.parentId, root.id);
  assert.equal(actual.chatId, 'chat-1');
  assert.equal(actual.assignee.harness, 'testfake');
  assert.equal(actual.siblingIndex, 0);
  assert.equal(actual.title, 'First 2');
});

runCase('updateTodo: siblingIndex move inside the same group', () => {
  const dataDir = path.join(tmpRoot, 'samegroup');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'samegroupproj');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Root' }).item;
  const ids = {};
  for (const title of ['A', 'B', 'C']) {
    ids[title] = addTodo(dataDir, project, { title, parentId: root.id }).item.id;
  }
  const order = () => loadTodosData(dataDir, project).items
    .filter((row) => row.parentId === root.id)
    .sort((a, b) => a.siblingIndex - b.siblingIndex)
    .map((row) => row.title)
    .join(',');
  updateTodo(dataDir, project, ids.B, { siblingIndex: 2 });
  assert.equal(order(), 'A,C,B');
  updateTodo(dataDir, project, ids.B, { siblingIndex: 0 });
  assert.equal(order(), 'B,A,C');
  updateTodo(dataDir, project, ids.A, { parentId: root.id });
  assert.equal(order(), 'B,A,C');
});

runCase('updateTodo: assignee with empty harness clears it (MCP clear form)', () => {
  const dataDir = path.join(tmpRoot, 'clearassignee');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'clearassigneeproj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, {
    title: 'Assigned',
    assignee: { harness: 'testfake', role: 'implement' },
  }).item;
  updateTodo(dataDir, project, item.id, { assignee: { harness: '', role: '' } });
  const actual = loadTodosData(dataDir, project).items.find((row) => row.id === item.id);
  assert.equal(actual.assignee, undefined);
});

runCase('updateTodo: explicit null parentId moves to root', () => {
  const dataDir = path.join(tmpRoot, 'nullparent');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'nullparentproj');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Root' }).item;
  const child = addTodo(dataDir, project, { title: 'Child', parentId: root.id }).item;
  updateTodo(dataDir, project, child.id, { parentId: null });
  const actual = loadTodosData(dataDir, project).items.find((row) => row.id === child.id);
  assert.equal(actual.parentId, undefined);
});

runCase('updateTodo: empty string parentId moves to root (MCP clear form)', () => {
  const dataDir = path.join(tmpRoot, 'emptyparent');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'emptyparentproj');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Root' }).item;
  const child = addTodo(dataDir, project, { title: 'Child', parentId: root.id, runMode: 'sequential' }).item;
  updateTodo(dataDir, project, child.id, { parentId: '', runMode: '' });
  const actual = loadTodosData(dataDir, project).items.find((row) => row.id === child.id);
  assert.equal(actual.parentId, undefined);
  assert.equal(actual.runMode, undefined);
});

runCase('addTodo: idempotency replay with a different runMode or siblingIndex conflicts', () => {
  const dataDir = path.join(tmpRoot, 'idemtree');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'idemtreeproj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Node', idempotencyKey: 'k1', runMode: 'parallel' });
  assert.throws(
    () => addTodo(dataDir, project, { title: 'Node', idempotencyKey: 'k1', runMode: 'sequential' }),
    (err) => err.code === 'CONFLICT',
  );
  addTodo(dataDir, project, { title: 'Other', idempotencyKey: 'k2' });
  assert.throws(
    () => addTodo(dataDir, project, { title: 'Other', idempotencyKey: 'k2', siblingIndex: 3 }),
    (err) => err.code === 'CONFLICT',
  );
  const replay = addTodo(dataDir, project, { title: 'Node', idempotencyKey: 'k1', runMode: 'parallel' });
  assert.equal(replay.replayed, true);
});

runCase('concurrent updates do not lose writes', async () => {
  const dataDir = path.join(tmpRoot, 'concurrent');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'concurrentproj');
  mkdirSync(project, { recursive: true });
  const id = addTodo(dataDir, project, { title: 'Shared' }).item.id;
  const JOBS = 25;
  const jobs = Array.from({ length: JOBS }, (_, i) => Promise.resolve().then(() => {
    updateTodo(dataDir, project, id, { appendChangelog: { kind: 'note', text: `note-${i}` } });
  }));
  await Promise.all(jobs);
  const item = loadTodosData(dataDir, project).items[0];
  const texts = item.changelog.map((entry) => entry.text);
  for (let i = 0; i < JOBS; i += 1) {
    assert.ok(texts.includes(`note-${i}`), `missing note-${i}`);
  }
  assert.equal(item.changelog.length, JOBS);
});

runCase('addTodo: stores createdByChatId and seeds linkedChatIds', () => {
  const dataDir = path.join(tmpRoot, 'creator');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'creatorproj');
  mkdirSync(project, { recursive: true });
  const created = addTodo(dataDir, project, {
    title: 'From chat',
    createdByChatId: 'chat-creator',
    sourceHarness: 'testfake',
  }).item;
  assert.equal(created.createdByChatId, 'chat-creator');
  assert.deepEqual(created.linkedChatIds, ['chat-creator']);
  assert.equal(created.sourceHarness, 'testfake');
  const reloaded = loadTodosData(dataDir, project).items[0];
  assert.equal(reloaded.createdByChatId, 'chat-creator');
  assert.deepEqual(reloaded.linkedChatIds, ['chat-creator']);
});

runCase('addTodo: idempotency replay keeps links untouched', () => {
  const dataDir = path.join(tmpRoot, 'replaylinks');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'replaylinksproj');
  mkdirSync(project, { recursive: true });
  const first = addTodo(dataDir, project, {
    title: 'Replay',
    idempotencyKey: 'k-links',
    createdByChatId: 'chat-a',
  }).item;
  const replayed = addTodo(dataDir, project, {
    title: 'Replay',
    idempotencyKey: 'k-links',
    createdByChatId: 'chat-b',
  });
  assert.equal(replayed.replayed, true);
  const item = loadTodosData(dataDir, project).items.find((row) => row.id === first.id);
  assert.equal(item.createdByChatId, 'chat-a');
  assert.deepEqual(item.linkedChatIds, ['chat-a']);
});

runCase('linkTodoChat: adds link without bumping updatedAt; duplicate is a no-op', () => {
  const dataDir = path.join(tmpRoot, 'linktodo');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'linktodoproj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Link me' }).item;
  const before = loadTodosData(dataDir, project).items[0].updatedAt;
  const added = linkTodoChat(dataDir, project, item.id, 'chat-x');
  assert.equal(added.changed, true);
  assert.deepEqual(added.item.linkedChatIds, ['chat-x']);
  assert.equal(added.item.updatedAt, before, 'link must not bump the item revision');
  const again = linkTodoChat(dataDir, project, item.id, 'chat-x');
  assert.equal(again.changed, false);
  assert.equal(loadTodosData(dataDir, project).items[0].updatedAt, before);
});

runCase('linkTodoChat: concurrent update with the pre-link expected_updated_at succeeds', () => {
  const dataDir = path.join(tmpRoot, 'linkrace');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'linkraceproj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Race' }).item;
  const revision = loadTodosData(dataDir, project).items[0].updatedAt;
  linkTodoChat(dataDir, project, item.id, 'chat-delegate');
  const updated = updateTodo(dataDir, project, item.id, {
    status: 'doing',
    expectedUpdatedAt: revision,
    linkedChatId: 'chat-agent',
  });
  const row = updated.items.find((entry) => entry.id === item.id);
  assert.equal(row.status, 'doing');
  assert.deepEqual(row.linkedChatIds, ['chat-agent', 'chat-delegate']);
});

runCase('linkedChatIds: capped at 100, newest first', () => {
  const dataDir = path.join(tmpRoot, 'linkcap');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'linkcapproj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Cap' }).item;
  for (let i = 0; i < 120; i += 1) {
    updateTodo(dataDir, project, item.id, { linkedChatId: `chat-${i}` });
  }
  const row = loadTodosData(dataDir, project).items.find((entry) => entry.id === item.id);
  assert.equal(row.linkedChatIds.length, 100);
  assert.equal(row.linkedChatIds[0], 'chat-119');
  assert.equal(row.linkedChatIds.includes('chat-0'), false);
});

runCase('tree completion: reject premature parent done, roll up all levels and invalidate stale parent CAS', () => {
  const dataDir = path.join(tmpRoot, 'rollup-data');
  const project = path.join(tmpRoot, 'rollup-project');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Root', status: 'ready' }).item;
  const branch = addTodo(dataDir, project, { title: 'Branch', status: 'ready', parentId: root.id }).item;
  const first = addTodo(dataDir, project, { title: 'First', status: 'ready', parentId: branch.id }).item;
  const last = addTodo(dataDir, project, { title: 'Last', status: 'ready', parentId: root.id }).item;
  const get = (id) => loadTodosData(dataDir, project).items.find((row) => row.id === id);
  assert.throws(() => updateTodo(dataDir, project, root.id, { status: 'done' }), (e) => e.code === 'VALIDATION');
  assert.equal(get(first.id).status, 'ready', 'attempting parent done never completes children');
  const rootRevision = get(root.id).updatedAt;
  updateTodo(dataDir, project, first.id, { status: 'done' });
  assert.equal(get(branch.id).status, 'done');
  assert.equal(get(root.id).status, 'doing');
  assert.notEqual(get(root.id).updatedAt, rootRevision);
  assert.throws(() => updateTodo(dataDir, project, root.id, { title: 'stale', expectedUpdatedAt: rootRevision }), (e) => e.code === 'CONFLICT');
  updateTodo(dataDir, project, last.id, { status: 'done' });
  assert.equal(get(root.id).status, 'done');
  updateTodo(dataDir, project, first.id, { status: 'ready' });
  assert.equal(get(branch.id).status, 'ready');
  assert.equal(get(root.id).status, 'doing');
  const added = addTodo(dataDir, project, { title: 'New unfinished child', parentId: branch.id, status: 'ready' }).item;
  updateTodo(dataDir, project, first.id, { status: 'done' });
  assert.equal(get(branch.id).status, 'doing');
  deleteTodo(dataDir, project, added.id);
  assert.equal(get(branch.id).status, 'done');
  assert.equal(get(root.id).status, 'done');
});

runCase('ready on a container promotes idea descendants and leaves doing work alone', () => {
  const dataDir = path.join(tmpRoot, 'promote-data');
  const project = path.join(tmpRoot, 'promote-project');
  mkdirSync(project, { recursive: true });
  const root = addTodo(dataDir, project, { title: 'Plan', status: 'idea' }).item;
  const branch = addTodo(dataDir, project, { title: 'Phase', status: 'idea', parentId: root.id }).item;
  const draft = addTodo(dataDir, project, { title: 'Draft leaf', status: 'idea', parentId: branch.id }).item;
  const started = addTodo(dataDir, project, { title: 'Started leaf', status: 'doing', parentId: branch.id }).item;
  updateTodo(dataDir, project, root.id, { status: 'ready' });
  const get = (id) => loadTodosData(dataDir, project).items.find((row) => row.id === id);
  assert.equal(get(draft.id).status, 'ready');
  assert.equal(get(branch.id).status, 'doing');
  assert.equal(get(started.id).status, 'doing');
  assert.equal(get(root.id).status, 'doing');
});

runCase('legacy done parent with open child is repaired on reads without rewriting storage', () => {
  const dataDir = path.join(tmpRoot, 'legacy-status-data');
  const project = path.join(tmpRoot, 'legacy-status-project');
  mkdirSync(project, { recursive: true });
  const parent = addTodo(dataDir, project, { title: 'Parent' }).item;
  addTodo(dataDir, project, { title: 'Child', parentId: parent.id, status: 'ready' });
  const file = path.join(dataDir, 'todos', `${workspaceKeyFromCwd(project)}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.items.find((row) => row.id === parent.id).status = 'done';
  writeFileSync(file, JSON.stringify(doc));
  const before = readFileSync(file, 'utf8');
  assert.equal(loadTodosData(dataDir, project).items.find((row) => row.id === parent.id).status, 'ready');
  assert.equal(readFileSync(file, 'utf8'), before);
});

runCase('review: round-trips a full snapshot through writeTodoReview and load', () => {
  const dataDir = path.join(tmpRoot, 'review-roundtrip');
  const project = path.join(tmpRoot, 'review-roundtrip-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Reviewed' }).item;
  const written = writeTodoReview(dataDir, project, item.id, {
    code: {
      state: 'passed',
      stateReason: 'fresh_review',
      subject: 'code',
      subjectSource: 'explicit',
      round: { index: 1, id: 'open-1', openedAt: '2024-01-01T00:00:00.000Z' },
      reviewers: [{
        delegationId: 'deleg-code',
        attemptId: 'attempt-code',
        leafId: item.id,
        harness: 'testfake',
        model: 'testfakeb-chat',
        baseModel: 'testfakeb-chat',
        status: 'completed',
        verdict: 'PASS',
        usable: true,
        startedAt: '2024-01-01T00:00:00.000Z',
        verifyStatus: 'passed',
        independence: 'different_base_model',
      }],
      implementer: {
        delegationId: 'deleg-impl',
        attemptId: 'attempt-impl',
        role: 'implement',
        harness: 'codex',
        model: 'gpt-5',
      },
      independence: { independent: true, class: 'different_base_model', reference: 'implementer' },
      material: { current: true, revision: 'abc123', kind: 'trusted', reason: 'fresh_review' },
    },
    plan: { state: 'pending', subject: 'plan', reviewers: [] },
  }, { expectedGeneration: 0 });
  assert.equal(written.changed, true);
  const item2 = loadTodosData(dataDir, project).items[0];
  assert.equal(item2.review.schemaVersion, 1);
  assert.equal(item2.review.generation, 1);
  assert.match(item2.review.decisionKey, /^sha256:/);
  assert.equal(item2.review.code.state, 'passed');
  assert.equal(item2.review.code.reviewers.length, 1);
  assert.equal(item2.review.code.reviewers[0].delegationId, 'deleg-code');
  assert.equal(item2.review.code.reviewers[0].attemptId, 'attempt-code');
  assert.equal(item2.review.code.implementer.role, 'implement');
  assert.equal(item2.review.plan.state, 'pending');
  // normalizeTodoReview is the load-time normalizer and stays stable.
  assert.deepEqual(normalizeTodoReview(item2.review), item2.review);
});

runCase('review: a per-subject write preserves the stored container aggregate', () => {
  const dataDir = path.join(tmpRoot, 'review-aggregate');
  const project = path.join(tmpRoot, 'review-aggregate-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Aggregate' }).item;
  const codeCounts = { passed: 1, failed: 0, pending: 0, none: 2, unknown: 0, stale: 0, manual: 0 };
  const planCounts = { passed: 0, failed: 0, pending: 0, none: 3, unknown: 0, stale: 0, manual: 0 };
  writeTodoReview(dataDir, project, item.id, {
    code: { state: 'passed', subject: 'code' },
    aggregate: { source: 'children', code: codeCounts, plan: planCounts },
  }, { expectedGeneration: 0 });
  const first = loadTodosData(dataDir, project).items[0];
  assert.equal(first.review.aggregate.code.passed, 1);
  assert.equal(first.review.aggregate.plan.none, 3);
  // A later plan-only write must not drop the stored rollup.
  const second = writeTodoReview(dataDir, project, item.id, {
    plan: { state: 'pending', subject: 'plan' },
  });
  assert.equal(second.changed, true);
  const after = loadTodosData(dataDir, project).items[0];
  assert.equal(after.review.code.state, 'passed', 'the code snapshot is preserved');
  assert.equal(after.review.aggregate.code.passed, 1, 'the stored aggregate is preserved');
  assert.equal(after.review.aggregate.plan.none, 3);
  // An explicit null still clears it deliberately.
  writeTodoReview(dataDir, project, item.id, {
    aggregate: null,
    plan: { state: 'pending', subject: 'plan' },
  });
  assert.equal(loadTodosData(dataDir, project).items[0].review.aggregate, undefined);
});

runCase('review: a legacy record without the field loads unchanged and is not rewritten', () => {
  const dataDir = path.join(tmpRoot, 'review-legacy');
  mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
  const project = path.join(tmpRoot, 'review-legacy-proj');
  mkdirSync(project, { recursive: true });
  const key = workspaceKeyFromCwd(project);
  const file = path.join(dataDir, 'todos', `${key}.json`);
  writeFileSync(file, JSON.stringify({
    version: 3,
    updatedAt: '2024-01-01T00:00:00.000Z',
    items: [{
      id: 'legacy-1',
      title: 'Old record',
      status: 'idea',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }],
    idempotency: {},
  }), 'utf8');
  const before = readFileSync(file, 'utf8');
  const doc = loadTodosData(dataDir, project);
  assert.equal(doc.items[0].review, undefined);
  assert.equal(readFileSync(file, 'utf8'), before, 'reading a legacy record must not migrate the file');
});

runCase('review: garbage values normalize to unknown and never crash', () => {
  const dataDir = path.join(tmpRoot, 'review-garbage');
  mkdirSync(path.join(dataDir, 'todos'), { recursive: true });
  const project = path.join(tmpRoot, 'review-garbage-proj');
  mkdirSync(project, { recursive: true });
  const key = workspaceKeyFromCwd(project);
  writeFileSync(path.join(dataDir, 'todos', `${key}.json`), JSON.stringify({
    version: 3,
    updatedAt: '2024-01-01T00:00:00.000Z',
    items: [
      {
        id: 'g1', title: 'Garbage state', status: 'idea',
        review: { code: { state: 'banana' }, plan: 'not-an-object' },
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'g2', title: 'Garbage review', status: 'idea',
        review: 'not-an-object',
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'g3', title: 'Unknown subject', status: 'idea',
        review: { code: { state: 'passed', subject: 'wrench' } },
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
    idempotency: {},
  }), 'utf8');
  const doc = loadTodosData(dataDir, project);
  const byId = new Map(doc.items.map((row) => [row.id, row]));
  assert.equal(byId.get('g1').review.code.state, 'unknown');
  assert.equal(byId.get('g1').review.plan.state, 'unknown');
  assert.equal(byId.get('g2').review, undefined);
  assert.equal(byId.get('g3').review.code.state, 'unknown');
  assert.equal(byId.get('g3').review.code.subjectSource, 'unknown');
});

runCase('review: reviewers without delegationId/attemptId are dropped', () => {
  const dataDir = path.join(tmpRoot, 'review-reviewers');
  const project = path.join(tmpRoot, 'review-reviewers-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Reviewers' }).item;
  writeTodoReview(dataDir, project, item.id, {
    code: {
      state: 'passed',
      reviewers: [
        { delegationId: 'd1', attemptId: 'a1', verdict: 'PASS' },
        { delegationId: 'd2', verdict: 'PASS' },
        { attemptId: 'a3', verdict: 'PASS' },
        {},
      ],
    },
  }, { expectedGeneration: 0 });
  const row = loadTodosData(dataDir, project).items[0];
  assert.equal(row.review.code.reviewers.length, 1);
  assert.equal(row.review.code.reviewers[0].delegationId, 'd1');
  assert.equal(row.review.code.reviewers[0].attemptId, 'a1');
  assert.equal(row.review.code.reviewerCount, 1);
});

runCase('review: a reviewer list above the cap is truncated and never stays passed', () => {
  const dataDir = path.join(tmpRoot, 'review-reviewers-cap');
  const project = path.join(tmpRoot, 'review-reviewers-cap-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Reviewer cap' }).item;
  const reviewers = [];
  for (let i = 0; i < 65; i += 1) {
    reviewers.push({ delegationId: `d${i}`, attemptId: `a${i}`, verdict: 'PASS', usable: true });
  }
  writeTodoReview(dataDir, project, item.id, {
    code: { state: 'passed', reviewers },
  }, { expectedGeneration: 0 });
  const row = loadTodosData(dataDir, project).items[0];
  assert.equal(row.review.code.reviewers.length, 64, 'the durable reviewer list is capped');
  assert.equal(row.review.code.truncated, true);
  assert.equal(row.review.code.state, 'unknown', 'a partial reviewer list must not certify a PASS');
});

runCase('review: write does not bump item.updatedAt and a parallel update keeps its earlier token', () => {
  const dataDir = path.join(tmpRoot, 'review-cas');
  const project = path.join(tmpRoot, 'review-cas-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'CAS' }).item;
  const revision = loadTodosData(dataDir, project).items[0].updatedAt;
  const written = writeTodoReview(dataDir, project, item.id, {
    code: { state: 'passed' },
  }, { expectedGeneration: 0 });
  assert.equal(written.changed, true);
  assert.equal(written.item.updatedAt, revision, 'review write must not advance the item CAS token');
  // A concurrent agent that read before the review write still succeeds.
  const updated = updateTodo(dataDir, project, item.id, {
    title: 'CAS updated',
    expectedUpdatedAt: revision,
  });
  assert.equal(updated.items[0].title, 'CAS updated');
  assert.equal(updated.items[0].review.code.state, 'passed');
});

runCase('review: a review-only write bumps doc.updatedAt but not parent state or statuses', async () => {
  const dataDir = path.join(tmpRoot, 'review-doc-rev');
  const project = path.join(tmpRoot, 'review-doc-rev-proj');
  mkdirSync(project, { recursive: true });
  const parent = addTodo(dataDir, project, { title: 'Parent', status: 'ready' }).item;
  const child = addTodo(dataDir, project, { title: 'Child', status: 'ready', parentId: parent.id }).item;
  const beforeDoc = loadTodosData(dataDir, project);
  const beforeParent = beforeDoc.items.find((row) => row.id === parent.id);
  const beforeChild = beforeDoc.items.find((row) => row.id === child.id);
  // The document revision is millisecond-granular; make sure the write lands in
  // a later millisecond so the assertion below is deterministic.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const written = writeTodoReview(dataDir, project, child.id, {
    code: { state: 'passed' },
  }, { expectedGeneration: 0 });
  assert.equal(written.changed, true);
  assert.notEqual(written.doc.updatedAt, beforeDoc.updatedAt, 'doc.updatedAt is a document revision and does change');
  const afterParent = written.doc.items.find((row) => row.id === parent.id);
  const afterChild = written.doc.items.find((row) => row.id === child.id);
  assert.equal(afterParent.updatedAt, beforeParent.updatedAt, 'parent status sync must not run on a review-only write');
  assert.equal(afterParent.status, beforeParent.status);
  assert.equal(afterChild.status, beforeChild.status);
  assert.equal(afterChild.updatedAt, beforeChild.updatedAt);
});

runCase('review: a normal update preserves review and an ignored patch key cannot delete it', () => {
  const dataDir = path.join(tmpRoot, 'review-preserve');
  const project = path.join(tmpRoot, 'review-preserve-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Preserve' }).item;
  writeTodoReview(dataDir, project, item.id, { code: { state: 'passed' } }, { expectedGeneration: 0 });
  updateTodo(dataDir, project, item.id, { title: 'Renamed', review: null });
  updateTodo(dataDir, project, item.id, { status: 'doing', review: { code: { state: 'none' } } });
  const row = loadTodosData(dataDir, project).items.find((entry) => entry.id === item.id);
  assert.equal(row.review.code.state, 'passed');
  assert.equal(row.review.generation, 1);
});

runCase('review: an identical snapshot is a no-op (no file write, no doc.updatedAt bump)', () => {
  const dataDir = path.join(tmpRoot, 'review-noop');
  const project = path.join(tmpRoot, 'review-noop-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Noop' }).item;
  const first = writeTodoReview(dataDir, project, item.id, {
    code: { state: 'passed', reviewers: [{ delegationId: 'd1', attemptId: 'a1', verdict: 'PASS' }] },
  }, { expectedGeneration: 0 });
  const file = path.join(dataDir, 'todos', `${workspaceKeyFromCwd(project)}.json`);
  const before = readFileSync(file, 'utf8');
  const second = writeTodoReview(dataDir, project, item.id, {
    // Same decision content, different timestamps and generation.
    code: {
      state: 'passed',
      reviewers: [{ delegationId: 'd1', attemptId: 'a1', verdict: 'PASS', startedAt: '2030-01-01T00:00:00.000Z' }],
    },
    generation: 99,
    computedAt: '2030-01-01T00:00:00.000Z',
  }, { expectedGeneration: first.generation });
  assert.equal(second.changed, false);
  assert.equal(second.doc.updatedAt, first.doc.updatedAt);
  assert.equal(readFileSync(file, 'utf8'), before, 'identical snapshot must not rewrite the file');
});

runCase('review: an older generation is rejected with CONFLICT', () => {
  const dataDir = path.join(tmpRoot, 'review-stale');
  const project = path.join(tmpRoot, 'review-stale-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Stale' }).item;
  const first = writeTodoReview(dataDir, project, item.id, { code: { state: 'passed' } }, { expectedGeneration: 0 });
  assert.throws(
    () => writeTodoReview(dataDir, project, item.id, { code: { state: 'failed' } }, { expectedGeneration: first.generation - 1 }),
    (err) => err.code === 'CONFLICT' && err.currentGeneration === first.generation,
  );
  assert.equal(loadTodosData(dataDir, project).items[0].review.code.state, 'passed');
});

runCase('review: a review write does not schedule a Workspace Watcher cycle', async () => {
  const dataDir = path.join(tmpRoot, 'review-nudge');
  const project = path.join(tmpRoot, 'review-nudge-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Nudge' }).item;
  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  stopWorkspaceWatcherAutopilotSchedule();
  registerWorkspaceWatcherAutopilotRunner(() => {});
  try {
    // Sanity: a real status change does nudge (the nudge is an async import).
    updateTodo(dataDir, project, item.id, { status: 'doing' });
    await flush();
    assert.ok(workspaceWatcherAutopilotPendingDebounceCount() >= 1, 'status change should nudge');
    stopWorkspaceWatcherAutopilotSchedule();
    registerWorkspaceWatcherAutopilotRunner(() => {});
    await flush();
    stopWorkspaceWatcherAutopilotSchedule();
    registerWorkspaceWatcherAutopilotRunner(() => {});
    writeTodoReview(dataDir, project, item.id, { code: { state: 'passed' } }, { expectedGeneration: 0 });
    await flush();
    assert.equal(workspaceWatcherAutopilotPendingDebounceCount(), 0, 'review write must not nudge');
  } finally {
    stopWorkspaceWatcherAutopilotSchedule();
  }
});

runCase('review: code and plan snapshots do not overwrite each other', () => {
  const dataDir = path.join(tmpRoot, 'review-subjects');
  const project = path.join(tmpRoot, 'review-subjects-proj');
  mkdirSync(project, { recursive: true });
  const item = addTodo(dataDir, project, { title: 'Subjects' }).item;
  const codeWrite = writeTodoReview(dataDir, project, item.id, {
    code: { state: 'passed', reviewers: [{ delegationId: 'd-code', attemptId: 'a-code' }] },
  }, { expectedGeneration: 0 });
  const planWrite = writeTodoReview(dataDir, project, item.id, {
    plan: { state: 'failed', reviewers: [{ delegationId: 'd-plan', attemptId: 'a-plan' }] },
  }, { expectedGeneration: codeWrite.generation });
  assert.equal(planWrite.changed, true);
  const row = loadTodosData(dataDir, project).items[0];
  assert.equal(row.review.code.state, 'passed');
  assert.equal(row.review.code.reviewers[0].delegationId, 'd-code');
  assert.equal(row.review.plan.state, 'failed');
  assert.equal(row.review.plan.reviewers[0].delegationId, 'd-plan');
  // A later code refresh still keeps the plan evidence.
  const codeAgain = writeTodoReview(dataDir, project, item.id, {
    code: { state: 'failed', reviewers: [{ delegationId: 'd-code', attemptId: 'a-code-2' }] },
  }, { expectedGeneration: planWrite.generation });
  assert.equal(codeAgain.review.plan.state, 'failed');
  assert.equal(codeAgain.review.code.state, 'failed');
});


runCase('plan revision follows markdown changes and survives approval and identical saves', () => {
  const dataDir = path.join(tmpRoot, 'plan-revision');
  const project = path.join(tmpRoot, 'plan-revision-project');
  mkdirSync(project, { recursive: true });
  const { item: todo } = addTodo(dataDir, project, { title: 'Revision' });
  updateTodo(dataDir, project, todo.id, { plan: { markdown: 'v1' } });
  const initial = loadTodosData(dataDir, project).items[0].plan;
  assert.equal(initial.markdownUpdatedAt, initial.updatedAt);
  updateTodo(dataDir, project, todo.id, {
    plan: { approvedAt: '2026-01-01T00:00:00.000Z', markdownUpdatedAt: '2099-01-01T00:00:00.000Z' },
  });
  updateTodo(dataDir, project, todo.id, { plan: { markdown: 'v1', sourceChatId: 'review-chat' } });
  const unchanged = loadTodosData(dataDir, project).items[0].plan;
  assert.equal(unchanged.markdownUpdatedAt, initial.markdownUpdatedAt);
  assert.ok(unchanged.approvedAt);
  updateTodo(dataDir, project, todo.id, { plan: { markdown: 'v2' } });
  const changed = loadTodosData(dataDir, project).items[0].plan;
  assert.equal(changed.markdownUpdatedAt, changed.updatedAt);
  assert.equal(changed.approvedAt, undefined);
});

runCase('legacy plan revision uses its stored update timestamp and freezes it on metadata patches', () => {
  const dataDir = path.join(tmpRoot, 'legacy-plan-revision');
  const project = path.join(tmpRoot, 'legacy-plan-project');
  mkdirSync(project, { recursive: true });
  const { item: todo } = addTodo(dataDir, project, { title: 'Legacy' });
  const file = path.join(dataDir, 'todos', `${workspaceKeyFromCwd(project)}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.items[0].plan = { markdown: 'v1', updatedAt: '2026-01-01T00:10:00.000Z' };
  writeFileSync(file, JSON.stringify(doc));
  assert.equal(loadTodosData(dataDir, project).items[0].plan.markdownUpdatedAt, '2026-01-01T00:10:00.000Z');
  updateTodo(dataDir, project, todo.id, { plan: { approvedAt: '2026-01-01T00:20:00.000Z' } });
  assert.equal(loadTodosData(dataDir, project).items[0].plan.markdownUpdatedAt, '2026-01-01T00:10:00.000Z');
});

runCase('plan.approvedBy: legacy plans load, operator provenance persists, UI re-approval and edits drop it', () => {
  const dataDir = path.join(tmpRoot, 'approved-by');
  const project = path.join(dataDir, 'proj');
  mkdirSync(project, { recursive: true });
  const { item: todo } = addTodo(dataDir, project, { title: 'Approver' });
  const file = path.join(dataDir, 'todos', `${workspaceKeyFromCwd(project)}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.items[0].plan = { markdown: 'v1', updatedAt: '2026-01-01T00:10:00.000Z', approvedAt: '2026-01-01T00:20:00.000Z' };
  writeFileSync(file, JSON.stringify(doc));
  const legacy = loadTodosData(dataDir, project).items[0].plan;
  assert.equal(legacy.approvedAt, '2026-01-01T00:20:00.000Z');
  assert.equal(legacy.approvedBy, undefined, 'legacy approved plan loads without approvedBy');

  const by = { kind: 'mcp-operator', clientId: 'c1', clientName: 'night-watch' };
  updateTodo(dataDir, project, todo.id, { plan: { approvedAt: '2026-02-01T00:00:00.000Z', approvedBy: by } });
  assert.deepEqual(loadTodosData(dataDir, project).items[0].plan.approvedBy, by);

  updateTodo(dataDir, project, todo.id, { plan: { approvedAt: '2026-03-01T00:00:00.000Z' } });
  assert.equal(loadTodosData(dataDir, project).items[0].plan.approvedBy, undefined, 'approval without provenance drops the old approver');

  updateTodo(dataDir, project, todo.id, { plan: { approvedAt: '2026-04-01T00:00:00.000Z', approvedBy: by } });
  updateTodo(dataDir, project, todo.id, { plan: { markdown: 'v2' } });
  const edited = loadTodosData(dataDir, project).items[0].plan;
  assert.equal(edited.approvedAt, undefined);
  assert.equal(edited.approvedBy, undefined, 'editing the markdown drops approvedBy with approvedAt');

  updateTodo(dataDir, project, todo.id, { plan: { approvedAt: '2026-05-01T00:00:00.000Z', approvedBy: { kind: 'user', clientId: 'x' } } });
  assert.equal(loadTodosData(dataDir, project).items[0].plan.approvedBy, undefined, 'unknown kinds are dropped');
});

function deferredFixture(name) {
  const dataDir = path.join(tmpRoot, name);
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, `${name}proj`);
  mkdirSync(project, { recursive: true });
  return { dataDir, project };
}

runCase('deferred: addTodo and load carry deferredUntil/deferredReason; unparseable date dropped; reason capped', () => {
  const { dataDir, project } = deferredFixture('def1');
  const { item } = addTodo(dataDir, project, {
    title: 'later', status: 'deferred', deferredUntil: '2026-12-01', deferredReason: 'x'.repeat(600),
  });
  assert.equal(item.status, 'deferred');
  const row = loadTodosData(dataDir, project).items[0];
  assert.equal(row.deferredUntil, '2026-12-01');
  assert.equal(row.deferredReason.length, 500);
  const bad = addTodo(dataDir, project, { title: 'bad', status: 'deferred', deferredUntil: 'not-a-date' }).item;
  assert.equal(loadTodosData(dataDir, project).items.find((r) => r.id === bad.id).deferredUntil, undefined);
  const plain = addTodo(dataDir, project, { title: 'idea', status: 'idea', deferredReason: 'ignored' }).item;
  assert.equal(loadTodosData(dataDir, project).items.find((r) => r.id === plain.id).deferredReason, undefined);
  const strict = addTodo(dataDir, project, { title: 's', status: 'deferred', strictStatus: true }).item;
  assert.equal(strict.status, 'deferred');
});

runCase('deferred: idea/ready -> deferred sets fields, leaving clears them, invalid date rejected', () => {
  const { dataDir, project } = deferredFixture('def2');
  const { item } = addTodo(dataDir, project, { title: 't', status: 'ready' });
  updateTodo(dataDir, project, item.id, {
    status: 'deferred', deferredUntil: '2026-11-05T00:00:00.000Z', deferredReason: '  wait for API  ', strictStatus: true,
  });
  let row = loadTodosData(dataDir, project).items[0];
  assert.equal(row.status, 'deferred');
  assert.equal(row.deferredUntil, '2026-11-05T00:00:00.000Z');
  assert.equal(row.deferredReason, 'wait for API');
  assert.throws(() => updateTodo(dataDir, project, item.id, { deferredUntil: 'nope' }), { code: 'VALIDATION' });
  // fields can be edited while deferred and cleared with an empty value
  updateTodo(dataDir, project, item.id, { deferredReason: '', deferredUntil: null });
  row = loadTodosData(dataDir, project).items[0];
  assert.equal(row.deferredReason, undefined);
  assert.equal(row.deferredUntil, undefined);
  updateTodo(dataDir, project, item.id, { deferredReason: 'again' });
  updateTodo(dataDir, project, item.id, { status: 'ready' });
  row = loadTodosData(dataDir, project).items[0];
  assert.equal(row.status, 'ready');
  assert.equal(row.deferredReason, undefined, 'leaving deferred clears the reason');
  const idea = addTodo(dataDir, project, { title: 'i', status: 'idea' }).item;
  updateTodo(dataDir, project, idea.id, { status: 'deferred' });
  updateTodo(dataDir, project, idea.id, { status: 'idea' });
  assert.equal(loadTodosData(dataDir, project).items.find((r) => r.id === idea.id).status, 'idea');
});

runCase('deferred: done -> deferred and deferred -> doing/done are rejected', () => {
  const { dataDir, project } = deferredFixture('def3');
  const done = addTodo(dataDir, project, { title: 'd', status: 'done' }).item;
  assert.throws(() => updateTodo(dataDir, project, done.id, { status: 'deferred' }), { code: 'CONFLICT' });
  const def = addTodo(dataDir, project, { title: 'x', status: 'deferred' }).item;
  assert.throws(() => updateTodo(dataDir, project, def.id, { status: 'doing' }), { code: 'CONFLICT' });
  assert.throws(() => updateTodo(dataDir, project, def.id, { status: 'done' }), { code: 'CONFLICT' });
  assert.equal(loadTodosData(dataDir, project).items.find((r) => r.id === def.id).status, 'deferred');
});

runCase('deferred: doing -> deferred releases the claim when no live run, rejected with live lease', () => {
  const { dataDir, project } = deferredFixture('def4');
  const { item } = addTodo(dataDir, project, { title: 'run', status: 'ready' });
  const live = new Date(Date.now() + 60_000).toISOString();
  updateTodo(dataDir, project, item.id, {
    status: 'doing', claimedByChatId: 'chat-1', claimedAt: new Date().toISOString(), claimLeaseUntil: live,
  });
  assert.throws(() => updateTodo(dataDir, project, item.id, { status: 'deferred' }), { code: 'CONFLICT' }, 'live run is rejected');
  assert.equal(loadTodosData(dataDir, project).items[0].status, 'doing');
  // expired lease: allowed, claim released
  updateTodo(dataDir, project, item.id, { claimLeaseUntil: new Date(Date.now() - 1000).toISOString() });
  updateTodo(dataDir, project, item.id, { status: 'deferred', deferredReason: 'parked' });
  const row = loadTodosData(dataDir, project).items[0];
  assert.equal(row.status, 'deferred');
  assert.equal(row.claimedByChatId, undefined);
  assert.equal(row.claimLeaseUntil, undefined);
  assert.equal(row.deferredReason, 'parked');
});

runCase('deferred: doing -> deferred rejected when todo has integration or leaf material', () => {
  const { dataDir, project } = deferredFixture('def5');
  const { item } = addTodo(dataDir, project, { title: 'wt', status: 'doing' });
  updateTodo(dataDir, project, item.id, { integration: { state: 'ready' } });
  assert.throws(() => updateTodo(dataDir, project, item.id, { status: 'deferred' }), { code: 'CONFLICT' });
  updateTodo(dataDir, project, item.id, { integration: null });
  updateTodo(dataDir, project, item.id, { status: 'deferred' });
  assert.equal(loadTodosData(dataDir, project).items[0].status, 'deferred');
});

runCase('deferred: container cascade defers open descendants, rejected with a doing descendant, restore returns idea', () => {
  const { dataDir, project } = deferredFixture('def6');
  const parent = addTodo(dataDir, project, { title: 'parent', status: 'idea' }).item;
  const a = addTodo(dataDir, project, { title: 'a', status: 'ready', parentId: parent.id }).item;
  const b = addTodo(dataDir, project, { title: 'b', status: 'idea', parentId: parent.id }).item;
  const c = addTodo(dataDir, project, { title: 'c', status: 'done', parentId: parent.id }).item;
  const statuses = () => Object.fromEntries(loadTodosData(dataDir, project).items.map((r) => [r.title, r.status]));
  updateTodo(dataDir, project, parent.id, { status: 'deferred', deferredReason: 'whole branch' });
  assert.deepEqual(statuses(), { parent: 'deferred', a: 'deferred', b: 'deferred', c: 'done' });
  // restore the container: ready descendants come back as idea too
  updateTodo(dataDir, project, parent.id, { status: 'ready' });
  // a done child keeps the container in the existing derived `doing` state
  assert.deepEqual(statuses(), { parent: 'doing', a: 'idea', b: 'idea', c: 'done' });
  assert.equal(loadTodosData(dataDir, project).items.find((r) => r.id === parent.id).deferredReason, undefined);
  // a doing descendant blocks the cascade
  updateTodo(dataDir, project, a.id, { status: 'doing' });
  assert.throws(() => updateTodo(dataDir, project, parent.id, { status: 'deferred' }), { code: 'CONFLICT' });
  assert.equal(statuses().b, 'idea', 'nothing was cascaded on rejection');
  void b; void c;
});

runCase('deferred: container with done + deferred children is derived deferred; restoring one child reopens it', () => {
  const { dataDir, project } = deferredFixture('def7');
  const parent = addTodo(dataDir, project, { title: 'parent', status: 'idea' }).item;
  const a = addTodo(dataDir, project, { title: 'a', status: 'done', parentId: parent.id }).item;
  const b = addTodo(dataDir, project, { title: 'b', status: 'ready', parentId: parent.id }).item;
  updateTodo(dataDir, project, b.id, { status: 'deferred' });
  assert.equal(loadTodosData(dataDir, project).items.find((r) => r.id === parent.id).status, 'deferred');
  updateTodo(dataDir, project, b.id, { status: 'idea' });
  // done + idea children keep the existing derived `doing` state
  assert.equal(loadTodosData(dataDir, project).items.find((r) => r.id === parent.id).status, 'doing');
  void a;
});

await Promise.all(pendingCases);

try {
  rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // ignore
}

process.exit(failed ? 1 : 0);
