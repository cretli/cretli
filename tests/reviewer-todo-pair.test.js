import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The data dir is resolved at import time, so set it before the dynamic imports.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-pair-'));
process.env.CRETLI_DATA_DIR = dataDir;
const { addTodo, updateTodo, getTodoById, loadTodosData, normalizeReviewerPair } = await import('../lib/persist/todos-persist.js');
const { saveDelegationSettings } = await import('../lib/persist/delegation-settings-persist.js');
const { clearDelegationEnvCache, resolveReviewerPool, readLeafTodoReviewerPair } = await import('../lib/delegation-settings.js');
const { addReviewerPairMember, readReviewerPairMembers } = await import('../lib/persist/reviewer-pairs-persist.js');
const { selectModelPick } = await import('../lib/model-role-profiles.js');

const ws = path.join(dataDir, 'ws');
fs.mkdirSync(ws, { recursive: true });
const todoPair = [{ harness: 'claude', model: 'rev-a' }, { harness: 'codex', model: 'rev-b' }];
const wsPair = [{ harness: 'qwen', model: 'ws-a' }, { harness: 'deepseek', model: 'ws-b' }];
const setWorkspace = (fields) => {
  saveDelegationSettings(ws, fields);
  clearDelegationEnvCache();
};

test('normalizeReviewerPair trims, caps at two and drops malformed values', () => {
  assert.deepEqual(
    normalizeReviewerPair({ enabled: true, members: [{ harness: ' a ', model: ' b ' }, { harness: 'x' }, { harness: 'c', model: 'd' }, { harness: 'e', model: 'f' }] }),
    { enabled: true, members: [{ harness: 'a', model: 'b' }, { harness: 'c', model: 'd' }] },
  );
  for (const bad of [undefined, null, 'x', 5, [], {}, { enabled: 'yes' }, { members: [{ harness: 1, model: 2 }] }]) {
    assert.equal(normalizeReviewerPair(bad), undefined);
  }
  assert.deepEqual(normalizeReviewerPair({ enabled: false }), { enabled: false });
});

test('todo create/update persist, normalize and clear reviewer_pair', () => {
  const created = addTodo(dataDir, ws, { title: 'pair todo', status: 'ready', reviewerPair: { enabled: true, members: todoPair } });
  const item = getTodoById(dataDir, ws, created.item.id);
  assert.deepEqual(item.reviewerPair, { enabled: true, members: todoPair });
  const plain = addTodo(dataDir, ws, { title: 'plain todo', status: 'ready', reviewerPair: { members: [{ harness: 'x' }] } });
  assert.equal('reviewerPair' in getTodoById(dataDir, ws, plain.item.id), false, 'malformed value = absent');
  updateTodo(dataDir, ws, plain.item.id, { reviewerPair: { enabled: false } });
  assert.deepEqual(getTodoById(dataDir, ws, plain.item.id).reviewerPair, { enabled: false });
  updateTodo(dataDir, ws, plain.item.id, { reviewerPair: {} });
  assert.equal('reviewerPair' in getTodoById(dataDir, ws, plain.item.id), false, 'empty object clears');
  assert.deepEqual(readLeafTodoReviewerPair(dataDir, ws, item.id), { enabled: true, members: todoPair });
  assert.deepEqual(readLeafTodoReviewerPair(dataDir, ws, item.id.slice(0, 8)), { enabled: true, members: todoPair });
  assert.equal(readLeafTodoReviewerPair(dataDir, ws, 'nope'), undefined);
  assert.equal(loadTodosData(dataDir, ws).items.length, 2);
});

test('per-todo pair enables the pool while the workspace setting is off', () => {
  setWorkspace({ reviewer_pair_enabled: false });
  const pool = resolveReviewerPool(ws, { dataDir, todoReviewerPair: { enabled: true, members: todoPair } });
  assert.equal(pool.active, true);
  assert.deepEqual(pool.members, todoPair);
});

test('per-todo pair overrides the configured workspace pair', () => {
  setWorkspace({ reviewer_pair_enabled: true, reviewer_pair_members: wsPair });
  const pool = resolveReviewerPool(ws, { dataDir, todoReviewerPair: { enabled: true, members: todoPair } });
  assert.deepEqual(pool.members, todoPair);
});

test('per-todo disable overrides an enabled workspace setting', () => {
  setWorkspace({ reviewer_pair_enabled: true, reviewer_pair_members: wsPair });
  assert.equal(resolveReviewerPool(ws, { dataDir }).active, true);
  const pool = resolveReviewerPool(ws, { dataDir, todoReviewerPair: { enabled: false } });
  assert.deepEqual(pool, { active: false, strict: false, learned: [], members: [] });
});

test('absent or malformed override keeps the workspace behavior byte-identical', () => {
  setWorkspace({ reviewer_pair_enabled: true, reviewer_pair_members: wsPair });
  const baseline = resolveReviewerPool(ws, { dataDir });
  for (const value of [undefined, null, {}, 'junk', { enabled: true }, { enabled: true, members: [todoPair[0]] }, { members: todoPair }]) {
    assert.deepEqual(resolveReviewerPool(ws, { dataDir, todoReviewerPair: value }), baseline);
  }
  setWorkspace({ reviewer_pair_enabled: false, reviewer_pair_members: [] });
  assert.equal(resolveReviewerPool(ws, { dataDir, todoReviewerPair: { enabled: true } }).active, false);
});

test('excluding the last implementer degrades the todo pair', () => {
  const harnesses = ['pa', 'pb', 'pc'].map((id) => ({ id, enabled: true, ready: true, can_delegate: true }));
  const modelsByHarness = {};
  for (const id of ['pa', 'pb', 'pc']) {
    modelsByHarness[id] = { favorites_configured: true, items: [{ id: `m-${id}`, roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] };
  }
  const members = [{ harness: 'pb', model: 'm-pb' }, { harness: 'pc', model: 'm-pc' }];
  const base = { role: 'review', harnesses, modelsByHarness, rotation: 'off' };
  const intact = selectModelPick({ ...base, preferModels: members, count: 2 });
  assert.ok(!intact.rotation.pool?.degraded);
  const degraded = selectModelPick({ ...base, preferModels: members, excludeModels: ['m-pb', 'm-pc'] });
  assert.equal(degraded.ok, true);
  assert.equal(degraded.rotation.pool.degraded, true);
  assert.equal(degraded.pick.harness, 'pa');
});

test('strict pair is sticky within one todo orchestrator and fresh for the next', () => {
  setWorkspace({ reviewer_pair_enabled: false, reviewer_pair_members: [], reviewer_pair_strict: true });
  const todoA = 'orchestrator-todo-a';
  const todoB = 'orchestrator-todo-b';
  addReviewerPairMember(todoA, todoPair[0]);
  addReviewerPairMember(todoA, todoPair[1]);
  for (let round = 0; round < 3; round += 1) {
    const pool = resolveReviewerPool(ws, { dataDir, parentChatId: todoA, delegations: [] });
    assert.equal(pool.active, true);
    assert.deepEqual(pool.members, todoPair, 'same pair every review round of the todo');
  }
  assert.equal(addReviewerPairMember(todoA, wsPair[0]), false, 'a full pair is never rotated');
  assert.equal(resolveReviewerPool(ws, { dataDir, parentChatId: todoB, delegations: [] }).active, false, 'a new todo starts fresh');
  assert.equal(readReviewerPairMembers(todoB).length, 0);
  const forced = resolveReviewerPool(ws, { dataDir, parentChatId: todoB, delegations: [], todoReviewerPair: { enabled: false } });
  assert.equal(forced.active, false);
});
