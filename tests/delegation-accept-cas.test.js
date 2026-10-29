/**
 * Human acceptance compare-and-set (`docs/todo-review-contract.md` §6.3, §7.3):
 * the screen must carry the attempt, the material revision and the todo
 * revision it displayed. Distinguishes an OMITTED expectation from a captured
 * empty one, resolves a prefix leaf id to the real todo and never fails open.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addTodo, deleteTodo, loadTodosData, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { createDelegationService, readDelegationAcceptContext } from '../lib/delegation-service.js';
import { snapshotDelegationAttempt } from '../lib/delegation-attempt.js';
import { readDelegationMaterialRevision } from '../lib/delegation-material-revision.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createTempRepo, commitFile } from './helpers/temp-git-repo.js';

const service = createDelegationService({
  workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  dataDir: ISOLATED_DATA_DIR,
  isModelAvailable: () => true,
});
const repo = createTempRepo({ file: 'notes.txt', content: 'one\n' });
const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-accept-plain-'));
let seq = 0;

test.after(() => {
  removeIsolatedDataDir();
  fs.rmSync(plainDir, { recursive: true, force: true });
});

function makeProject() {
  const dir = path.join(ISOLATED_DATA_DIR, `accept-ws-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTodo(project) {
  return addTodo(ISOLATED_DATA_DIR, project, { title: 'Leaf', status: 'doing' }).item;
}

function readRevision(project, id) {
  return loadTodosData(ISOLATED_DATA_DIR, project).items.find((row) => row.id === id).updatedAt;
}

function makeJob({ project, leafId, executionFolder = repo.dir, parentChatId = randomUUID() }) {
  const row = createDelegationRecord({
    parentChatId,
    workspaceFolder: project,
    executionFolder,
    executor: { transport: 'testfake', model: 'testfake/test' },
    assignment: 'review',
    executionMode: 'agent',
    leafId,
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
  });
  updateDelegationRecord(row.id, { status: 'completed', runStoppingAt: '', report: 'TASK: review\nVERDICT: PASS' });
  return getDelegationById(row.id);
}

async function accept(job, expectations) {
  return await service.acknowledge(job.id, {
    reason: 'accepted',
    actor: 'human',
    expectedAttemptId: job.attemptId,
    ...expectations,
  });
}

test('omitted todo revision is refused when the server can read one', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id });
  const material = readDelegationMaterialRevision(repo.dir);
  const result = await accept(job, { expectedMaterialRevision: material });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'accept_expectation_required');
  assert.equal(getDelegationById(job.id).acknowledgedReason, '');
});

test('matching todo revision accepts and persists the audited expectation', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id });
  const revision = readRevision(project, todo.id);
  const result = await accept(job, {
    expectedMaterialRevision: readDelegationMaterialRevision(repo.dir),
    expectedTodoRevision: revision,
  });
  assert.equal(result.ok, true, result.error);
  const stored = getDelegationById(job.id);
  assert.equal(stored.acknowledgedReason, 'accepted');
  assert.equal(stored.acknowledgedExpectedTodoRevision, revision);
  assert.equal(snapshotDelegationAttempt(stored).acknowledgedExpectedTodoRevision, revision);
  const review = loadTodosData(ISOLATED_DATA_DIR, project).items.find((row) => row.id === todo.id).review;
  assert.equal(review?.code?.acceptance?.expectedTodoRevision, revision);
});

test('a stale todo revision is a 409, never accepted', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id });
  const shown = readRevision(project, todo.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  updateTodo(ISOLATED_DATA_DIR, project, todo.id, { title: 'Leaf changed' });
  assert.notEqual(readRevision(project, todo.id), shown);
  const result = await accept(job, {
    expectedMaterialRevision: readDelegationMaterialRevision(repo.dir),
    expectedTodoRevision: shown,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'ack_todo_revision_mismatch');
  assert.equal(getDelegationById(job.id).acknowledgedReason, '');
});

test('a prefix leaf id resolves to the real todo and does not fail open', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id.slice(0, 8) });
  const context = await readDelegationAcceptContext(job, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(context.resolution, 'prefix');
  assert.equal(context.todoRevision, readRevision(project, todo.id));
  const material = readDelegationMaterialRevision(repo.dir);
  const wrong = await accept(job, { expectedMaterialRevision: material, expectedTodoRevision: 'bogus' });
  assert.equal(wrong.status, 409);
  const omitted = await accept(job, { expectedMaterialRevision: material });
  assert.equal(omitted.status, 400);
  const right = await accept(job, {
    expectedMaterialRevision: material,
    expectedTodoRevision: context.todoRevision,
  });
  assert.equal(right.ok, true, right.error);
});

test('a captured empty todo revision cannot bypass a now-known revision', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id });
  const result = await accept(job, {
    expectedMaterialRevision: readDelegationMaterialRevision(repo.dir),
    expectedTodoRevision: '',
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'ack_todo_revision_mismatch');
});

function expectNotAccepted(job, result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, code);
  assert.equal(getDelegationById(job.id).acknowledgedReason, '');
}

test('attributed job whose todo is already missing cannot accept captured-empty', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id });
  deleteTodo(ISOLATED_DATA_DIR, project, todo.id);
  const context = await readDelegationAcceptContext(job, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(context.resolution, 'missing');
  assert.equal(context.todoRevision, '');
  const result = await accept(job, {
    expectedMaterialRevision: readDelegationMaterialRevision(repo.dir),
    expectedTodoRevision: '',
  });
  expectNotAccepted(job, result, 'ack_todo_revision_mismatch');
});

test('attributed job whose todo is deleted after the context was read is a 409', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id });
  const shown = (await readDelegationAcceptContext(job, { dataDir: ISOLATED_DATA_DIR })).todoRevision;
  assert.ok(shown);
  deleteTodo(ISOLATED_DATA_DIR, project, todo.id);
  const result = await accept(job, {
    expectedMaterialRevision: readDelegationMaterialRevision(repo.dir),
    expectedTodoRevision: shown,
  });
  expectNotAccepted(job, result, 'ack_todo_revision_mismatch');
});

function findTodosFile(todoId) {
  const dir = path.join(ISOLATED_DATA_DIR, 'todos');
  const name = fs.readdirSync(dir).find((entry) => {
    return entry.endsWith('.json') && fs.readFileSync(path.join(dir, entry), 'utf8').includes(todoId);
  });
  assert.ok(name, 'todos file located');
  return path.join(dir, name);
}

test('an ambiguous prefix leaf id cannot pass with a captured empty revision', async () => {
  const project = makeProject();
  const first = makeTodo(project);
  const second = makeTodo(project);
  // Uuid prefixes never collide naturally: force two ids to share 8 chars.
  const file = findTodosFile(second.id);
  const forcedId = `${first.id.slice(0, 8)}${second.id.slice(8)}`;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(second.id).join(forcedId));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  const job = makeJob({ project, leafId: first.id.slice(0, 8) });
  const context = await readDelegationAcceptContext(job, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(context.resolution, 'ambiguous');
  assert.equal(context.todoRevision, '');
  const result = await accept(job, {
    expectedMaterialRevision: readDelegationMaterialRevision(repo.dir),
    expectedTodoRevision: '',
  });
  expectNotAccepted(job, result, 'ack_todo_revision_mismatch');
});

test('a failed todo read is unavailable and never accepts', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id });
  const target = findTodosFile(todo.id);
  const backup = `${target}.bak`;
  fs.renameSync(target, backup);
  fs.mkdirSync(target);
  try {
    const context = await readDelegationAcceptContext(job, { dataDir: ISOLATED_DATA_DIR });
    assert.equal(context.resolution, 'unavailable');
    assert.equal(context.todoRevision, '');
    const result = await accept(job, {
      expectedMaterialRevision: readDelegationMaterialRevision(repo.dir),
      expectedTodoRevision: '',
    });
    expectNotAccepted(job, result, 'ack_todo_unavailable');
  } finally {
    fs.rmdirSync(target);
    fs.renameSync(backup, target);
  }
});

test('agent acknowledgement of an attributed job with a missing todo is not blocked', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const job = makeJob({ project, leafId: todo.id });
  deleteTodo(ISOLATED_DATA_DIR, project, todo.id);
  const result = await service.acknowledge(job.id, { reason: 'reviewed', actor: 'agent' });
  assert.equal(result.ok, true, result.error);
});

test('an unattributed job accepts with a captured empty todo revision', async () => {
  const project = makeProject();
  const job = makeJob({ project, leafId: '' });
  const result = await accept(job, {
    expectedMaterialRevision: readDelegationMaterialRevision(repo.dir),
    expectedTodoRevision: '',
  });
  assert.equal(result.ok, true, result.error);
});

test('material: omitted is refused, captured-empty cannot hide a known revision', async () => {
  const project = makeProject();
  const job = makeJob({ project, leafId: '' });
  const omitted = await accept(job, {});
  assert.equal(omitted.status, 400);
  assert.equal(omitted.code, 'accept_expectation_required');
  const capturedEmpty = await accept(job, { expectedMaterialRevision: '' });
  assert.equal(capturedEmpty.status, 409);
  assert.equal(capturedEmpty.code, 'ack_material_mismatch');
});

test('material: a stale known revision is a 409', async () => {
  const project = makeProject();
  const job = makeJob({ project, leafId: '' });
  const shown = readDelegationMaterialRevision(repo.dir);
  commitFile(repo.dir, `later-${seq}.txt`, 'two\n');
  const result = await accept(job, { expectedMaterialRevision: shown });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'ack_material_mismatch');
});

test('material: an unavailable (no Git) current revision accepts a captured empty one', async () => {
  const project = makeProject();
  const job = makeJob({ project, leafId: '', executionFolder: plainDir });
  const result = await accept(job, { expectedMaterialRevision: '' });
  assert.equal(result.ok, true, result.error);
});

test('HTTP accept forwards todoRevision and keeps omitted distinct from empty', async () => {
  const project = makeProject();
  const todo = makeTodo(project);
  const parent = addChat(randomUUID(), 'accept-cas-parent', null, project, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
  });
  const job = makeJob({ project, leafId: todo.id, parentChatId: parent.id });
  const routes = new Map();
  registerDelegationsRoutes({
    get: (p, fn) => routes.set(`GET ${p}`, fn),
    post: (p, fn) => routes.set(`POST ${p}`, fn),
  }, { workspaceDirForAgent: () => project, dataDir: ISOLATED_DATA_DIR });
  async function post(body) {
    let status = 200;
    let payload;
    const res = { status(c) { status = c; return this; }, json(p) { payload = p; return this; } };
    await routes.get('POST /api/delegations/:id/accept')({
      params: { id: job.id }, query: { workspaceFolder: project }, body,
    }, res);
    return { status, body: payload };
  }
  const material = readDelegationMaterialRevision(repo.dir);
  const omitted = await post({ attemptId: job.attemptId, materialRevision: material });
  assert.equal(omitted.status, 400, JSON.stringify(omitted.body));
  const emptied = await post({ attemptId: job.attemptId, materialRevision: material, todoRevision: '' });
  assert.equal(emptied.status, 409, JSON.stringify(emptied.body));
  const ok = await post({
    attemptId: job.attemptId,
    materialRevision: material,
    todoRevision: readRevision(project, todo.id),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});
