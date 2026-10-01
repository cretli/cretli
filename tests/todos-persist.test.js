import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  addTodo,
  deleteTodo,
  hashTodoCreateArgs,
  linkTodoChat,
  loadTodosData,
  TODOS_MAX_ITEMS,
  updateTodo,
  workspaceKeyFromCwd,
} from '../lib/persist/todos-persist.js';

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
        assignee: { harness: 'opencode', model: 'glm-x', role: 'implement' },
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
        assignee: { harness: 'opencode', role: 'wrench' },
        createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
    idempotency: {},
  }), 'utf8');
  const doc = loadTodosData(dataDir, project);
  const byTitle = new Map(doc.items.map((row) => [row.title, row]));
  const good = byTitle.get('Good');
  assert.deepEqual(good.assignee, { harness: 'opencode', model: 'glm-x', role: 'implement' });
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
    hashTodoCreateArgs({ ...base, assignee: { harness: 'opencode', role: 'implement' } }),
    rootHash
  );
  assert.notEqual(
    hashTodoCreateArgs({ ...base, assignee: { harness: 'opencode', role: 'review' } }),
    hashTodoCreateArgs({ ...base, assignee: { harness: 'opencode', role: 'implement' } })
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
    assignee: { harness: 'opencode', model: 'm', role: 'review' },
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
    assignee: { harness: 'opencode', model: 'm', role: 'implement' },
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
  assert.equal(actual.assignee.harness, 'opencode');
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
    assignee: { harness: 'opencode', role: 'implement' },
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
    sourceHarness: 'opencode',
  }).item;
  assert.equal(created.createdByChatId, 'chat-creator');
  assert.deepEqual(created.linkedChatIds, ['chat-creator']);
  assert.equal(created.sourceHarness, 'opencode');
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

await Promise.all(pendingCases);

try {
  rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // ignore
}

process.exit(failed ? 1 : 0);
