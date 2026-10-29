/**
 * Bulk "integrate with agent": batch record, eligibility, lazy dispatch, outcome
 * protocol, capability fencing, safe boundary, workspace lock and recovery.
 *
 * Repositories and data dirs live under os.tmpdir(); nothing touches the real repo.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { createLegacyJsonTodosBackend, setTodosBackend } from '../lib/persist/todos-store.js';
import { ensureWorktree } from '../lib/worktree-manager.js';
import {
  SMART_MERGE_RUNNING,
  buildSmartMergeRequest,
  confirmWorkspaceTodoIntegration,
  invalidateTodoIntegrationProof,
  markTodoIntegrationNoCode,
  prepareManualTodoIntegration,
  refuseWhenIntegrationLockedForWriter,
  rejectWorkspaceTodoIntegration,
  reportSmartMergeOutcome,
} from '../lib/workspace-watcher-integration.js';
import {
  abandonIntegrateBatch,
  annotateBatchEligibility,
  attachBatchChat,
  buildEligibilityContext,
  cancelIntegrateBatch,
  checkBatchLegacyReport,
  createIntegrateBatch,
  handleBatchNext,
  readIntegrateBatch,
  recordBatchLegacyReport,
  resolveBatchEntry,
  resumeIntegrateBatch,
} from '../lib/integrate-batch.js';
import { rollbackIntegrationRequest } from '../lib/workspace-watcher-integration.js';
import {
  acquireIntegrationLock,
  bindIntegrationLockChat,
  checkIntegrationUnlocked,
  clearIntegrationLock,
  getIntegrationLock,
} from '../lib/integration-lock.js';
import { evaluateBoundary, inspectWorkspaceBoundary, parsePorcelainV2 } from '../lib/integrate-batch-boundary.js';
import { fingerprintTodoMaterial } from '../lib/todo-integration-proof.js';
import { runGit } from '../lib/worktree/git-worktree.ts';
import { createTempRepo, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpRuntimeDeps, setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';

const SAFE = () => ({ ok: true, unmerged: [], inProgress: [], dirty: {} });
const IDLE = () => ({ known: true, busy: false });
const BUSY = () => ({ known: true, busy: true });
const UNKNOWN = () => ({ known: false, busy: false, reason: 'adapter_missing' });
/** Chat bound to the batch lock, i.e. the batch agent the lib guard accepts. */
const BATCH_CHAT = 'chat-batch';

/** Hold one facade read to exercise concurrent batch commands without timers. */
function holdTodoRead() {
  const backend = createLegacyJsonTodosBackend();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const previous = setTodosBackend({
    ...backend,
    listTodos: async (...args) => {
      const document = backend.listTodos(...args);
      entered();
      await gate;
      return document;
    },
  });
  return { started, release, restore: () => setTodosBackend(previous) };
}

test('legacy report rejects an epoch abandoned while the todo read was pending', async (t) => {
  const world = await makeWorld('report-read-race', 1);
  t.after(world.cleanup);
  const created = await create(world, [world.todos[0].id]);
  const first = await next(world, created);
  const held = holdTodoRead();
  t.after(() => { held.release(); held.restore(); });
  const pending = checkBatchLegacyReport({
    dataDir: world.dataDir, workspaceFolder: world.repo, todoId: world.todos[0].id,
    body: { batchId: created.batch.id, entryId: first.body.entry.entryId, attempt: 1, epoch: 1, token: created.secret },
  });
  await held.started;
  held.restore();
  assert.equal((await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: world.deps })).ok, true);
  held.release();
  assert.equal((await pending).ok, false);
});

test('cancel during a suspended resume remains durable after resume completes', async (t) => {
  const world = await makeWorld('cancel-resume-race', 1);
  t.after(world.cleanup);
  const created = await create(world, [world.todos[0].id]);
  await next(world, created);
  const held = holdTodoRead();
  t.after(() => { held.release(); held.restore(); });
  const resumed = resumeIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: world.deps });
  await held.started;
  const cancelled = cancelIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: world.deps });
  held.restore();
  held.release();
  assert.equal((await resumed).ok, true);
  assert.equal((await cancelled).ok, true);
  assert.equal(readIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: world.deps }).status, 'cancelled');
});

/**
 * @param {string} name
 * @param {number} count worktree todos awaiting integration
 */
async function makeWorld(name, count = 2) {
  const dataDir = tempDir(`cretli-ib-data-${name}-`);
  const baseDir = tempDir(`cretli-ib-base-${name}-`);
  const repo = createTempRepo().dir;
  const todos = [];
  for (let i = 0; i < count; i += 1) {
    const todo = addTodo(dataDir, repo, { title: `todo ${i + 1}`, status: 'doing', executionMode: 'worktree' }).item;
    const created = ensureWorktree({
      todoId: todo.id, workspaceFolder: repo, mode: 'worktree', config: worktreeConfig(baseDir), registryOptions: { dataDir },
    });
    fs.writeFileSync(path.join(created.record.worktreePath, `feature-${i + 1}.txt`), `feature ${i + 1}\n`);
    const prepared = await prepareManualTodoIntegration({ todoId: todo.id, workspaceFolder: repo, dataDir });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    todos.push(todo);
  }
  return {
    dataDir, repo, todos,
    deps: { inspectBoundary: SAFE, probeChatRunLiveness: UNKNOWN },
    cleanup: () => { for (const dir of [dataDir, baseDir, repo]) fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * @param {ReturnType<typeof makeWorld>} world
 * @param {string[]} ids
 * @param {object} [extra]
 */
async function create(world, ids, extra = {}) {
  const created = await createIntegrateBatch({
    dataDir: world.dataDir,
    workspaceFolder: world.repo,
    todoIds: ids,
    baseUrl: 'https://127.0.0.1:3011',
    insecureTls: true,
    deps: world.deps,
    ...extra,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  // The REST route binds the batch chat right after create, before the agent can
  // confirm; mirror that so the lib lock guard sees the real owner.
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: BATCH_CHAT, deps: extra.deps || world.deps });
  return created;
}

/**
 * @param {ReturnType<typeof makeWorld>} world
 * @param {{ batch: { id: string, epoch: number }, secret: string }} created
 * @param {Record<string, unknown>} fields
 * @param {object} [deps]
 */
async function next(world, created, fields = {}, deps = world.deps) {
  return await handleBatchNext({
    dataDir: world.dataDir,
    body: { batchId: created.batch.id, epoch: created.batch.epoch, token: created.secret, ...fields },
    deps,
  });
}

/**
 * What the agent does after the legacy report: confirm through the real path.
 * The batch agent's chat id is the caller identity the lib guard checks.
 *
 * @param {ReturnType<typeof makeWorld>} world
 * @param {string} todoId
 * @param {string} [callerChatId]
 */
async function agentConfirm(world, todoId, callerChatId = BATCH_CHAT) {
  const todo = getTodoById(world.dataDir, world.repo, todoId);
  const result = await confirmWorkspaceTodoIntegration({
    todoId,
    workspaceFolder: world.repo,
    dataDir: world.dataDir,
    callerChatId,
    expectedUpdatedAt: todo.updatedAt,
    proof: { simple: true },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
}

function stateOf(view, entryId) {
  return view.entries.find((entry) => entry.entryId === entryId).state;
}

test('create keeps click order, collapses aliases and skips ineligible todos with reasons', async (t) => {
  const world = await makeWorld('create', 2);
  t.after(world.cleanup);
  const child = addTodo(world.dataDir, world.repo, { title: 'child', status: 'done', parentId: world.todos[0].id }).item;
  const plain = addTodo(world.dataDir, world.repo, { title: 'plain', status: 'ready' }).item;
  const created = await create(world, [world.todos[1].id, world.todos[0].id, child.id, world.todos[0].id, plain.id, 'missing-id']);
  assert.deepEqual(created.view.entries.map((entry) => entry.todoId), [world.todos[1].id, world.todos[0].id]);
  assert.ok(created.view.entries.every((entry) => entry.mode === 'smart-merge'));
  const reasons = Object.fromEntries(created.skipped.map((row) => [row.todoId, row.reason]));
  assert.equal(reasons[child.id], `aliased:${world.todos[0].id}`);
  assert.equal(reasons[plain.id], 'not_eligible');
  assert.equal(reasons['missing-id'], 'not_found');
  assert.ok(!JSON.stringify(created.view).includes(created.secret));
  assert.ok(created.prompt.includes(created.secret));
  assert.ok(!/git push|push origin/i.test(created.prompt));
});

test('empty and locked creates are refused; a running smart merge refuses create', async (t) => {
  const world = await makeWorld('refuse', 2);
  t.after(world.cleanup);
  const empty = await createIntegrateBatch({ dataDir: world.dataDir, workspaceFolder: world.repo, todoIds: ['nope'], deps: world.deps });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
  const first = await create(world, [world.todos[0].id]);
  const second = await createIntegrateBatch({ dataDir: world.dataDir, workspaceFolder: world.repo, todoIds: [world.todos[1].id], deps: world.deps });
  assert.equal(second.reason, 'integration_locked');
  await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: first.batch.id, forceLiveness: true, deps: world.deps });
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null);
  const built = await buildSmartMergeRequest({ todoId: world.todos[1].id, workspaceFolder: world.repo, dataDir: world.dataDir, baseUrl: 'https://127.0.0.1:3011' });
  assert.equal(built.ok, true);
  const busy = await createIntegrateBatch({ dataDir: world.dataDir, workspaceFolder: world.repo, todoIds: [world.todos[0].id], deps: world.deps });
  assert.equal(busy.reason, 'busy');
});

test('a stale smart-merge marker of a dead agent does not block create', async (t) => {
  const world = await makeWorld('stale-marker', 2);
  t.after(world.cleanup);
  const stale = getTodoById(world.dataDir, world.repo, world.todos[1].id);
  updateTodo(world.dataDir, world.repo, stale.id, {
    status: stale.status,
    strictStatus: true,
    integration: { ...stale.integration, reason: SMART_MERGE_RUNNING, updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
  });
  const created = await createIntegrateBatch({ dataDir: world.dataDir, workspaceFolder: world.repo, todoIds: [world.todos[0].id], deps: world.deps });
  assert.notEqual(created.reason, 'busy');
  assert.equal(created.ok, true);
});

test('batchEligibility matches the resolver for smart-merge, verify and none', async (t) => {
  const world = await makeWorld('elig', 1);
  t.after(world.cleanup);
  const done = addTodo(world.dataDir, world.repo, { title: 'done leaf', status: 'done' }).item;
  const ready = addTodo(world.dataDir, world.repo, { title: 'ready', status: 'ready' }).item;
  const items = JSON.parse(JSON.stringify(
    [world.todos[0], done, ready].map((row) => getTodoById(world.dataDir, world.repo, row.id)),
  ));
  const annotated = annotateBatchEligibility({ dataDir: world.dataDir, workspaceFolder: world.repo, items });
  const byId = Object.fromEntries(annotated.map((row) => [row.id, row.batchEligibility]));
  assert.equal(byId[world.todos[0].id].mode, 'smart-merge');
  assert.equal(byId[done.id].mode, 'verify');
  assert.equal(byId[ready.id].mode, 'none');
  const ctx = await buildEligibilityContext({ dataDir: world.dataDir, workspaceFolder: world.repo });
  for (const id of [world.todos[0].id, done.id, ready.id]) {
    assert.equal(resolveBatchEntry(ctx, id).mode, byId[id].mode);
  }
  acquireIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo, owner: 'single', todoId: 'x', chatId: '' });
  const locked = annotateBatchEligibility({ dataDir: world.dataDir, workspaceFolder: world.repo, items });
  assert.ok(locked.every((row) => row.batchEligibility.mode === 'none' && row.batchEligibility.reason === 'locked'));
});

test('entries are built lazily, one at a time, with pending_confirm and stale fencing', async (t) => {
  const world = await makeWorld('protocol', 2);
  t.after(world.cleanup);
  const calls = [];
  const deps = {
    ...world.deps,
    buildSmartMergeRequest: async (input) => { calls.push(input.todoId); return await buildSmartMergeRequest(input); },
  };
  const created = await create(world, world.todos.map((row) => row.id));
  assert.deepEqual(calls, []);
  const first = await next(world, created, {}, deps);
  assert.equal(first.body.action, 'entry');
  assert.deepEqual(calls, [world.todos[0].id]);
  assert.equal(first.body.entry.mode, 'smart-merge');
  assert.match(first.body.entry.prompt, /smart-merge-report-from-agent/);
  assert.match(first.body.entry.prompt, new RegExp(`"batchId":"${created.batch.id}"`));
  assert.equal(first.body.batch.entries.filter((entry) => entry.state === 'running').length, 1);
  // asking again returns the same entry without building the next one
  const again = await next(world, created, {}, deps);
  assert.equal(again.body.entry.entryId, first.body.entry.entryId);
  assert.deepEqual(calls, [world.todos[0].id]);
  const entryId = first.body.entry.entryId;
  assert.equal((await next(world, created, { entryId, attempt: 9, outcome: 'merged' }, deps)).status, 409);
  const pending = await next(world, created, { entryId, attempt: 1, outcome: 'merged' }, deps);
  assert.equal(pending.body.action, 'pending_confirm');
  assert.deepEqual(calls, [world.todos[0].id]);
  await reportSmartMergeOutcome({ todoId: world.todos[0].id, workspaceFolder: world.repo, dataDir: world.dataDir, outcome: 'merged' });
  await agentConfirm(world, world.todos[0].id);
  const advanced = await next(world, created, { entryId, attempt: 1, outcome: 'merged' }, deps);
  assert.equal(advanced.body.action, 'entry');
  assert.equal(advanced.body.entry.todoId, world.todos[1].id);
  assert.deepEqual(calls, [world.todos[0].id, world.todos[1].id]);
  assert.equal(stateOf(advanced.body.batch, entryId), 'merged');
  // idempotent: the resolved entry is answered without advancing
  const replay = await next(world, created, { entryId, attempt: 1, outcome: 'merged' }, deps);
  assert.equal(replay.body.action, 'resolved');
  assert.deepEqual(calls, [world.todos[0].id, world.todos[1].id]);
  await reportSmartMergeOutcome({ todoId: world.todos[1].id, workspaceFolder: world.repo, dataDir: world.dataDir, outcome: 'merged' });
  await agentConfirm(world, world.todos[1].id);
  const done = await next(world, created, { entryId: advanced.body.entry.entryId, attempt: 1, outcome: 'merged' }, deps);
  assert.equal(done.body.action, 'stop');
  assert.equal(done.body.reason, 'completed');
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null);
});

test('prompts prefer MCP: wrapper names integrate_next, entry rules travel once', async (t) => {
  const world = await makeWorld('prompts', 1);
  t.after(world.cleanup);
  const created = await create(world, [world.todos[0].id]);
  assert.match(created.prompt, /Call the Cretli MCP tool integrate_next/);
  assert.ok(created.prompt.includes(JSON.stringify({ batch_id: created.batch.id, epoch: created.batch.epoch, token: created.secret })));
  assert.ok(created.prompt.indexOf('integrate_next') < created.prompt.indexOf('curl '), 'curl is only the fallback');
  const first = await next(world, created);
  assert.equal(first.body.action, 'entry');
  assert.doesNotMatch(first.body.entry.prompt, /Rules for this smart-merge entry/);
  assert.match(first.body.entry.rules, /smart_merge_report/);
  assert.match(first.body.entry.rules, /integrate_next/);
  assert.doesNotMatch(first.body.entry.rules, /legacy report|fenced/);
});

test('MCP integrate_next drives the batch and is scoped to the caller workspace', async (t) => {
  const world = await makeWorld('mcp-next', 1);
  const previous = getBuiltinMcpRuntimeDeps();
  setBuiltinMcpRuntimeDeps({ dataDir: world.dataDir, integrateBatchDeps: world.deps });
  t.after(() => { setBuiltinMcpRuntimeDeps(previous); world.cleanup(); });
  const created = await create(world, [world.todos[0].id]);
  const handlersFor = (workspaceFolder) => {
    const session = { chatId: BATCH_CHAT, workspaceFolder, harness: 'opencode', mode: 'agent' };
    return createCretliMcpToolHandlers(createInProcessMcpClient({ harness: 'opencode', chatId: BATCH_CHAT, workspaceFolder }), session);
  };
  const capability = { batch_id: created.batch.id, epoch: created.batch.epoch, token: created.secret };
  const foreign = await handlersFor(tempDir('cretli-ib-foreign-')).integrate_next(capability);
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /not_found/);
  const handlers = handlersFor(world.repo);
  const badToken = await handlers.integrate_next({ ...capability, token: 'wrong' });
  assert.equal(badToken.isError, true);
  assert.match(badToken.content[0].text, /invalid_token/);
  const first = await handlers.integrate_next(capability);
  assert.equal(first.isError, false);
  assert.equal(first.structuredContent.action, 'entry');
  const entry = first.structuredContent.entry;
  assert.match(first.content[0].text, /Rules for this smart-merge entry/);
  // The entry prompt carries the real capability, never the placeholder.
  assert.ok(entry.prompt.includes(created.secret));
  const report = await handlers.smart_merge_report({
    todo_id: world.todos[0].id,
    outcome: 'merged',
    batch: { batchId: created.batch.id, entryId: entry.entryId, attempt: entry.attempt, epoch: created.batch.epoch, token: created.secret },
  });
  assert.equal(report.isError, false, report.content[0].text);
  await agentConfirm(world, world.todos[0].id);
  const done = await handlers.integrate_next({ ...capability, entry_id: entry.entryId, attempt: entry.attempt, outcome: 'merged', summary: 'ok' });
  assert.equal(done.isError, false, done.content[0].text);
  assert.equal(done.structuredContent.action, 'stop');
  assert.equal(done.structuredContent.reason, 'completed');
});

test('three unconfirmed reports fail the entry; a rejected todo never counts as verified', async (t) => {
  const world = await makeWorld('unconfirmed', 2);
  t.after(world.cleanup);
  const created = await create(world, [world.todos[0].id, world.todos[1].id]);
  const first = await next(world, created);
  const entryId = first.body.entry.entryId;
  assert.equal((await next(world, created, { entryId, attempt: 1, outcome: 'merged' })).body.action, 'pending_confirm');
  assert.equal((await next(world, created, { entryId, attempt: 1, outcome: 'merged' })).body.action, 'pending_confirm');
  const third = await next(world, created, { entryId, attempt: 1, outcome: 'merged' });
  assert.equal(stateOf(third.body.batch, entryId), 'failed');
  assert.equal(third.body.batch.entries[0].reason, 'unconfirmed');
  // safe boundary: the batch continues with the independent second entry
  assert.equal(third.body.action, 'entry');
  assert.equal(third.body.entry.todoId, world.todos[1].id);
});

test('verify entry completes through confirm or no-code with no legacy report', async (t) => {
  const world = await makeWorld('verify', 0);
  t.after(world.cleanup);
  const done = addTodo(world.dataDir, world.repo, { title: 'finished', status: 'done' }).item;
  const created = await create(world, [done.id]);
  assert.equal(created.view.entries[0].mode, 'verify');
  const first = await next(world, created);
  assert.equal(first.body.entry.mode, 'verify');
  assert.ok(!/smart-merge-report-from-agent/.test(first.body.entry.prompt));
  const entryId = first.body.entry.entryId;
  assert.equal((await next(world, created, { entryId, attempt: 1, outcome: 'verified' })).body.action, 'pending_confirm');
  const current = getTodoById(world.dataDir, world.repo, done.id);
  const noCode = await markTodoIntegrationNoCode({
    todoId: done.id,
    workspaceFolder: world.repo,
    dataDir: world.dataDir,
    callerChatId: BATCH_CHAT,
    expectedUpdatedAt: current.updatedAt,
    reason: 'docs only',
  });
  assert.equal(noCode.ok, true);
  const finished = await next(world, created, { entryId, attempt: 1, outcome: 'no_code' });
  assert.equal(finished.body.action, 'stop');
  assert.equal(stateOf(finished.body.batch, entryId), 'verified');
});

test('no_code on a smart-merge entry with changed files fails the entry', async (t) => {
  const world = await makeWorld('nocode', 1);
  t.after(world.cleanup);
  const created = await create(world, [world.todos[0].id]);
  const first = await next(world, created);
  const entryId = first.body.entry.entryId;
  const todoId = world.todos[0].id;
  // The agent claims no-code although the prepared result has changes. The
  // regular no-code path refuses that, so record the claim as a confirmed no-code
  // would read, with a matching material fingerprint.
  const before = getTodoById(world.dataDir, world.repo, todoId);
  updateTodo(world.dataDir, world.repo, todoId, {
    status: 'done',
    strictStatus: true,
    expectedUpdatedAt: before.updatedAt,
    integration: { ...before.integration, changeScope: 'none', noCodeReason: 'x' },
  });
  const staged = getTodoById(world.dataDir, world.repo, todoId);
  updateTodo(world.dataDir, world.repo, todoId, {
    expectedUpdatedAt: staged.updatedAt,
    integration: { ...staged.integration, noCodeMaterialFingerprint: fingerprintTodoMaterial(staged) },
  });
  const settled = await next(world, created, { entryId, attempt: 1, outcome: 'no_code' });
  assert.equal(settled.body.batch.entries[0].state, 'failed');
  assert.equal(settled.body.batch.entries[0].reason, 'no_code_with_changes');
});

test('capability: wrong secret is 401, resume rotates the epoch, legacy reports are fenced', async (t) => {
  const world = await makeWorld('capability', 2);
  t.after(world.cleanup);
  const created = await create(world, world.todos.map((row) => row.id));
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-1', deps: world.deps });
  assert.equal((await handleBatchNext({ dataDir: world.dataDir, body: { batchId: created.batch.id, epoch: 1, token: 'wrong' }, deps: world.deps })).status, 401);
  assert.equal((await handleBatchNext({ dataDir: world.dataDir, body: { batchId: created.batch.id, epoch: 1 }, deps: world.deps })).status, 401);
  const first = await next(world, created);
  const entry = first.body.entry;
  const todoId = world.todos[0].id;
  // missing / wrong context for a batch todo is rejected
  assert.equal((await checkBatchLegacyReport({ dataDir: world.dataDir, workspaceFolder: world.repo, todoId, body: {} })).ok, false);
  const context = { batchId: created.batch.id, entryId: entry.entryId, attempt: 1, epoch: 1, token: created.secret };
  const fence = await checkBatchLegacyReport({ dataDir: world.dataDir, workspaceFolder: world.repo, todoId, body: context });
  assert.equal(fence.ok, true);
  recordBatchLegacyReport({ dataDir: world.dataDir, batchId: fence.batchId, entryId: fence.entryId, outcome: 'merged', deps: world.deps });
  assert.equal(readIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: world.deps }).entries[0].state, 'awaiting_confirmation');
  // a non-batch todo is untouched by the fence
  const other = addTodo(world.dataDir, world.repo, { title: 'other', status: 'doing' }).item;
  assert.equal((await checkBatchLegacyReport({ dataDir: world.dataDir, workspaceFolder: world.repo, todoId: other.id, body: {} })).ok, true);
  // resume with an idle agent rotates the epoch; the old secret then answers 409
  const resumed = await resumeIntegrateBatch({
    dataDir: world.dataDir, batchId: created.batch.id, deps: { ...world.deps, probeChatRunLiveness: IDLE },
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal((await next(world, created, { entryId: entry.entryId, attempt: 1, outcome: 'merged' })).status, 409);
  assert.equal((await checkBatchLegacyReport({ dataDir: world.dataDir, workspaceFolder: world.repo, todoId, body: context })).ok, false);
  assert.notEqual(getTodoById(world.dataDir, world.repo, todoId).integration.reason, SMART_MERGE_RUNNING, 'resume cleared the running marker');
  const fresh = await handleBatchNext({
    dataDir: world.dataDir,
    body: { batchId: created.batch.id, epoch: 2, token: resumed.secret },
    deps: world.deps,
  });
  assert.equal(fresh.body.action, 'entry');
  assert.equal(fresh.body.entry.todoId, todoId);
  assert.equal(fresh.body.entry.attempt, 2);
});

test('boundary: clean failure continues; unmerged, in-progress or drifted workspace pauses', async (t) => {
  const world = await makeWorld('boundary', 2);
  t.after(world.cleanup);
  const clean = evaluateBoundary({ snapshot: {}, current: SAFE() });
  assert.equal(clean.safe, true);
  assert.equal(evaluateBoundary({ snapshot: {}, current: { ...SAFE(), unmerged: ['a.txt'] } }).safe, false);
  assert.equal(evaluateBoundary({ snapshot: {}, current: { ...SAFE(), inProgress: ['merge_in_progress'] } }).safe, false);
  assert.equal(evaluateBoundary({ snapshot: { a: 'x' }, current: { ...SAFE(), dirty: { a: 'y' } } }).safe, false);
  assert.equal(evaluateBoundary({ snapshot: {}, current: { ok: false, reason: 'git' } }).safe, false);

  // real git: a dirty file edited after dispatch pauses; an untouched one does not
  fs.writeFileSync(path.join(world.repo, 'wip.txt'), 'one\n');
  const before = inspectWorkspaceBoundary({ workspaceFolder: world.repo });
  assert.equal(before.ok, true);
  assert.deepEqual(Object.keys(before.dirty), ['wip.txt']);
  assert.equal(evaluateBoundary({ snapshot: before.dirty, current: inspectWorkspaceBoundary({ workspaceFolder: world.repo }) }).safe, true);
  fs.writeFileSync(path.join(world.repo, 'wip.txt'), 'two\n');
  const drift = evaluateBoundary({ snapshot: before.dirty, current: inspectWorkspaceBoundary({ workspaceFolder: world.repo }) });
  assert.equal(drift.safe, false);
  assert.deepEqual(drift.paths, ['wip.txt']);
  fs.rmSync(path.join(world.repo, 'wip.txt'));

  // batch level: an unsafe boundary after a failure pauses; resume stays paused until fixed
  let unsafe = true;
  const deps = {
    ...world.deps,
    inspectBoundary: () => (unsafe ? { ...SAFE(), unmerged: ['conflict.txt'] } : SAFE()),
  };
  const created = await create(world, world.todos.map((row) => row.id));
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-b', deps });
  const first = await handleBatchNext({ dataDir: world.dataDir, body: { batchId: created.batch.id, epoch: 1, token: created.secret }, deps: { ...deps, inspectBoundary: SAFE } });
  const entryId = first.body.entry.entryId;
  const failed = await handleBatchNext({
    dataDir: world.dataDir,
    body: { batchId: created.batch.id, epoch: 1, token: created.secret, entryId, attempt: 1, outcome: 'failed', summary: 'conflict' },
    deps,
  });
  assert.equal(failed.body.action, 'stop');
  assert.equal(failed.body.reason, 'paused');
  assert.equal(failed.body.batch.status, 'paused');
  const idleDeps = { ...deps, probeChatRunLiveness: IDLE };
  const stillPaused = await resumeIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: idleDeps });
  assert.equal(stillPaused.ok, false);
  assert.equal(stillPaused.reason, 'boundary_unsafe');
  unsafe = false;
  const resumed = await resumeIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, entryAction: 'skip', deps: idleDeps });
  assert.equal(resumed.ok, true);
  assert.equal(stateOf(resumed.view, entryId), 'failed');
  const after = await handleBatchNext({
    dataDir: world.dataDir,
    body: { batchId: created.batch.id, epoch: 2, token: resumed.secret },
    deps: idleDeps,
  });
  assert.equal(after.body.entry.todoId, world.todos[1].id);
});

test('sequential siblings of a failed entry are skipped blocked_by', async (t) => {
  const world = await makeWorld('siblings', 0);
  t.after(world.cleanup);
  const parent = addTodo(world.dataDir, world.repo, { title: 'parent', status: 'doing', runMode: 'sequential' }).item;
  const a = addTodo(world.dataDir, world.repo, { title: 'a', status: 'done', parentId: parent.id }).item;
  const b = addTodo(world.dataDir, world.repo, { title: 'b', status: 'done', parentId: parent.id }).item;
  const created = await create(world, [a.id, b.id]);
  const first = await next(world, created);
  const failed = await next(world, created, { entryId: first.body.entry.entryId, attempt: 1, outcome: 'failed', summary: 'x' });
  assert.equal(failed.body.action, 'stop');
  assert.equal(failed.body.reason, 'completed');
  assert.equal(failed.body.batch.entries[1].state, 'skipped');
  assert.equal(failed.body.batch.entries[1].reason, `blocked_by:${first.body.entry.entryId}`);
});

test('lock: single owner blocks a batch, a failed report and confirm release it, idle and clear free it; unknown keeps it', async (t) => {
  const world = await makeWorld('lock', 2);
  t.after(world.cleanup);
  const todoId = world.todos[0].id;
  await buildSmartMergeRequest({ todoId, workspaceFolder: world.repo, dataDir: world.dataDir, baseUrl: 'https://127.0.0.1:3011' });
  acquireIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo, owner: 'single', todoId, chatId: 'chat-s', now: new Date(Date.now() - 5 * 60_000).toISOString() });
  assert.equal(checkIntegrationUnlocked({ dataDir: world.dataDir, workspaceFolder: world.repo, deps: { isChatRunConfirmedIdle: () => false } }).ok, false);
  const refused = await createIntegrateBatch({ dataDir: world.dataDir, workspaceFolder: world.repo, todoIds: [world.todos[1].id], deps: world.deps });
  assert.equal(refused.reason, 'integration_locked');
  // unknown liveness keeps the lock; confirmed idle past the grace releases it
  assert.ok(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo, deps: { isChatRunConfirmedIdle: () => { throw new Error('probe'); } } }));
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo, deps: { isChatRunConfirmedIdle: () => true } }), null);
  // the lib-level failed report releases a single lock without any REST call
  acquireIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo, owner: 'single', todoId, chatId: '' });
  await reportSmartMergeOutcome({ todoId, workspaceFolder: world.repo, dataDir: world.dataDir, outcome: 'failed', summary: 'x' });
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null);
  // a merged report keeps the lock until the confirm releases it, so a batch
  // cannot start in the window between the report and the attestation
  acquireIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo, owner: 'single', todoId, chatId: '' });
  await reportSmartMergeOutcome({ todoId, workspaceFolder: world.repo, dataDir: world.dataDir, outcome: 'merged' });
  assert.ok(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), 'a merged report keeps the single lock');
  await agentConfirm(world, todoId);
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null, 'the confirm released it');
  // explicit clear
  acquireIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo, owner: 'single', todoId, chatId: '' });
  assert.equal(clearIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }).ok, true);
  // an active batch lock cannot be cleared, and blocks single flows
  const created = await create(world, [world.todos[1].id]);
  assert.equal(clearIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }).reason, 'batch_owned');
  assert.equal(checkIntegrationUnlocked({ dataDir: world.dataDir, workspaceFolder: world.repo }).ok, false);
  await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: world.deps });
});

test('liveness: busy or unknown keeps ownership, idle + stale becomes stalled, override is recorded', async (t) => {
  const world = await makeWorld('liveness', 1);
  t.after(world.cleanup);
  let clock = Date.now();
  const make = (probe) => ({ ...world.deps, probeChatRunLiveness: probe, now: () => clock, staleMs: 1000 });
  const created = await create(world, [world.todos[0].id], { deps: make(UNKNOWN) });
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-l', deps: make(UNKNOWN) });
  await next(world, created, {}, make(UNKNOWN));
  clock += 10_000;
  const read = (probe) => readIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: make(probe) });
  assert.equal(read(BUSY).status, 'running');
  assert.equal(read(UNKNOWN).status, 'running');
  assert.equal(read(UNKNOWN).liveness.known, false);
  assert.equal((await resumeIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: make(UNKNOWN) })).reason, 'liveness_unknown');
  assert.equal((await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: make(BUSY) })).reason, 'agent_busy');
  assert.equal(read(IDLE).status, 'stalled');
  // cancel while an entry is open keeps the lock
  const cancelled = await cancelIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: make(IDLE) });
  assert.equal(cancelled.view.status, 'cancelling');
  assert.ok(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }));
  const abandoned = await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: make(UNKNOWN) });
  assert.equal(abandoned.ok, true);
  assert.equal(abandoned.view.status, 'abandoned');
  assert.equal(abandoned.view.overrides.length, 1);
  assert.equal(abandoned.view.entries[0].override, true);
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null);
  const todo = getTodoById(world.dataDir, world.repo, world.todos[0].id);
  assert.notEqual(todo.integration.reason, SMART_MERGE_RUNNING);
  assert.ok(fs.existsSync(path.join(world.repo, '.git')));
  assert.equal(todo.integration.state, 'ready', 'worktree result is kept');
});

test('cancel without an open entry ends the batch and releases the lock', async (t) => {
  const world = await makeWorld('cancel', 2);
  t.after(world.cleanup);
  const created = await create(world, world.todos.map((row) => row.id));
  const cancelled = await cancelIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: world.deps });
  assert.equal(cancelled.view.status, 'cancelled');
  assert.ok(cancelled.view.entries.every((entry) => entry.state === 'cancelled'));
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null);
  const answer = await next(world, created);
  assert.equal(answer.body.action, 'stop');
});

const UNMERGED = () => ({ ok: true, unmerged: ['conflict.txt'], inProgress: [], dirty: {} });
const MERGING = () => ({ ok: true, unmerged: [], inProgress: ['merge_in_progress'], dirty: {} });

test('boundary gates create, first dispatch and resume from stalled', async (t) => {
  const world = await makeWorld('gate', 2);
  t.after(world.cleanup);
  const ids = world.todos.map((row) => row.id);
  // create refuses an unsafe workspace and takes no lock
  const refused = await createIntegrateBatch({
    dataDir: world.dataDir, workspaceFolder: world.repo, todoIds: ids, deps: { ...world.deps, inspectBoundary: MERGING },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'boundary_unsafe');
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null);
  // first dispatch pauses with boundary_unsafe and builds nothing
  const created = await create(world, ids);
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-g', deps: world.deps });
  const calls = [];
  const unsafeDeps = {
    ...world.deps,
    inspectBoundary: UNMERGED,
    buildSmartMergeRequest: async (input) => { calls.push(input.todoId); return await buildSmartMergeRequest(input); },
  };
  const first = await next(world, created, {}, unsafeDeps);
  assert.equal(first.body.action, 'stop');
  assert.equal(first.body.batch.status, 'paused');
  assert.match(first.body.batch.pausedReason, /^boundary_unsafe:unmerged_paths/);
  assert.deepEqual(calls, []);
  // once safe the paused batch resumes and dispatches
  const idle = { ...world.deps, probeChatRunLiveness: IDLE };
  const resumed = await resumeIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: idle });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const entry = await handleBatchNext({
    dataDir: world.dataDir, body: { batchId: created.batch.id, epoch: 2, token: resumed.secret }, deps: world.deps,
  });
  assert.equal(entry.body.action, 'entry');
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-g2', deps: world.deps });
  // stalled (and forced running) resume also needs a safe boundary
  const stalledDeps = { ...idle, inspectBoundary: UNMERGED };
  const clock = Date.now() + 10 * 60_000;
  const stalled = readIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: { ...idle, now: () => clock } });
  assert.equal(stalled.status, 'stalled');
  const blocked = await resumeIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: stalledDeps });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'boundary_unsafe');
  assert.equal(readIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: idle }).epoch, 2, 'epoch not rotated');
  const forced = await resumeIntegrateBatch({
    dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: { ...world.deps, inspectBoundary: MERGING },
  });
  assert.equal(forced.reason, 'boundary_unsafe');
  await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: world.deps });
});

test('single lock: orphan TTL, unknown and busy never expire, rollback and invalidate release', async (t) => {
  const world = await makeWorld('ttl', 1);
  t.after(world.cleanup);
  const todoId = world.todos[0].id;
  const base = { dataDir: world.dataDir, workspaceFolder: world.repo };
  const lockAt = (ageMs, chatId) => acquireIntegrationLock({
    ...base, owner: 'single', todoId, chatId, now: new Date(Date.now() - ageMs).toISOString(),
  });
  // chat never bound: held inside the orphan TTL, reclaimed after it
  lockAt(60_000, '');
  assert.ok(getIntegrationLock(base));
  assert.equal(getIntegrationLock({ ...base, now: Date.now() + 11 * 60_000 }), null);
  // unknown liveness keeps the lock indefinitely (no time-based expiry)
  lockAt(5 * 60_000, 'chat-u');
  const unknown = () => ({ known: false, busy: false });
  assert.ok(getIntegrationLock({ ...base, deps: { probeChatRunLiveness: unknown } }));
  assert.ok(getIntegrationLock({ ...base, now: Date.now() + 72 * 3_600_000, deps: { probeChatRunLiveness: unknown } }));
  // positive idle evidence releases it
  assert.equal(getIntegrationLock({ ...base, deps: { probeChatRunLiveness: IDLE } }), null);
  // a chat known to be busy never expires
  lockAt(5 * 60_000, 'chat-b');
  assert.ok(getIntegrationLock({ ...base, now: Date.now() + 24 * 3_600_000, deps: { probeChatRunLiveness: BUSY } }));
  // rollback of a failed start releases the lock and the marker
  await buildSmartMergeRequest({ todoId, workspaceFolder: world.repo, dataDir: world.dataDir, baseUrl: 'https://127.0.0.1:3011' });
  assert.equal(getTodoById(world.dataDir, world.repo, todoId).integration.reason, SMART_MERGE_RUNNING);
  await rollbackIntegrationRequest({ ...base, targetId: todoId, todoId });
  assert.equal(getIntegrationLock(base), null);
  assert.notEqual(getTodoById(world.dataDir, world.repo, todoId).integration.reason, SMART_MERGE_RUNNING);
});

test('invalidate releases the owner single lock', async (t) => {
  const world = await makeWorld('invalidate', 1);
  t.after(world.cleanup);
  const todoId = world.todos[0].id;
  await reportSmartMergeOutcome({ todoId, workspaceFolder: world.repo, dataDir: world.dataDir, outcome: 'merged' });
  await agentConfirm(world, todoId);
  acquireIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo, owner: 'single', todoId, chatId: 'chat-i' });
  const result = await invalidateTodoIntegrationProof({
    todoId,
    workspaceFolder: world.repo,
    dataDir: world.dataDir,
    expectedUpdatedAt: getTodoById(world.dataDir, world.repo, todoId).updatedAt,
    reason: 'reverted',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null);
});

test('resume creates the chat first; a failed chat leaves epoch and state untouched', async (t) => {
  const world = await makeWorld('openchat', 1);
  t.after(world.cleanup);
  const created = await create(world, [world.todos[0].id]);
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-o', deps: world.deps });
  await next(world, created);
  const idle = { ...world.deps, probeChatRunLiveness: IDLE };
  const failed = await resumeIntegrateBatch({
    dataDir: world.dataDir, batchId: created.batch.id, deps: idle, openChat: () => { throw new Error('no chat'); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'chat_unavailable');
  const view = readIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: idle });
  assert.equal(view.epoch, 1);
  assert.equal(view.chatId, 'chat-o');
  assert.equal(view.entries[0].state, 'running');
  const ok = await resumeIntegrateBatch({
    dataDir: world.dataDir, batchId: created.batch.id, deps: idle, openChat: () => ({ chat: { id: 'chat-new' } }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.view.epoch, 2);
  assert.equal(ok.view.chatId, 'chat-new');
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }).chatId, 'chat-new');
  assert.match(ok.prompt, /"resolved"/);
});

test('verify entry: no_code claim needs the recorded no-code review', async (t) => {
  const world = await makeWorld('verifynocode', 1);
  t.after(world.cleanup);
  const todoId = world.todos[0].id;
  await reportSmartMergeOutcome({ todoId, workspaceFolder: world.repo, dataDir: world.dataDir, outcome: 'merged' });
  await agentConfirm(world, todoId);
  const plain = addTodo(world.dataDir, world.repo, { title: 'plain done', status: 'done' }).item;
  const created = await create(world, [plain.id]);
  const first = await next(world, created);
  assert.equal(first.body.entry.mode, 'verify');
  const entryId = first.body.entry.entryId;
  const target = getTodoById(world.dataDir, world.repo, plain.id);
  const confirmed = await confirmWorkspaceTodoIntegration({
    todoId: plain.id,
    workspaceFolder: world.repo,
    dataDir: world.dataDir,
    callerChatId: BATCH_CHAT,
    expectedUpdatedAt: target.updatedAt,
    proof: { simple: true },
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const claimed = await next(world, created, { entryId, attempt: 1, outcome: 'no_code' });
  assert.equal(claimed.body.batch.entries[0].state, 'failed');
  assert.equal(claimed.body.batch.entries[0].reason, 'no_code_not_recorded');
});

test('library guard: reject / invalidate honour the lock for every entry point (REST, MCP)', async (t) => {
  const world = await makeWorld('guard', 2);
  t.after(world.cleanup);
  const [a, b] = world.todos;
  const base = { workspaceFolder: world.repo, dataDir: world.dataDir };
  assert.equal(await refuseWhenIntegrationLockedForWriter({ ...base, todoId: a.id }), null, 'no lock, no refusal');
  const created = await create(world, [b.id]);
  bindIntegrationLockChat({ ...base, batchId: created.batch.id, chatId: 'chat-batch' });
  assert.equal((await rejectWorkspaceTodoIntegration({ ...base, todoId: b.id, callerChatId: 'chat-other' })).reason, 'integration_locked');
  assert.equal((await rejectWorkspaceTodoIntegration({ ...base, todoId: b.id })).reason, 'integration_locked', 'no caller identity is not the batch agent');
  assert.equal((await invalidateTodoIntegrationProof({ ...base, todoId: b.id, expectedUpdatedAt: 'x', reason: 'r' })).reason, 'integration_locked');
  assert.notEqual((await rejectWorkspaceTodoIntegration({ ...base, todoId: b.id, callerChatId: 'chat-batch' })).reason, 'integration_locked');
  await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: world.deps });
  acquireIntegrationLock({ ...base, owner: 'single', todoId: a.id, chatId: 'chat-a' });
  assert.equal((await rejectWorkspaceTodoIntegration({ ...base, todoId: b.id, callerChatId: 'chat-x' })).reason, 'integration_locked');
  // the single-lock owner is not refused by the guard (it gets the normal result)
  assert.notEqual((await rejectWorkspaceTodoIntegration({ ...base, todoId: a.id })).reason, 'integration_locked');
});

test('library guard: confirm / no-code honour the locks; the human attestation is exempt', async (t) => {
  const world = await makeWorld('guard-writers', 4);
  t.after(world.cleanup);
  const [a, b, c, d] = world.todos;
  const base = { workspaceFolder: world.repo, dataDir: world.dataDir };
  const plain = (title) => addTodo(world.dataDir, world.repo, { title, status: 'done' }).item;
  const fresh = (id) => getTodoById(world.dataDir, world.repo, id);
  const confirmOf = (id, extra = {}) => confirmWorkspaceTodoIntegration({
    ...base, todoId: id, expectedUpdatedAt: fresh(id).updatedAt, proof: { simple: true }, ...extra,
  });
  const noCodeOf = (id, extra = {}) => markTodoIntegrationNoCode({
    ...base, todoId: id, expectedUpdatedAt: fresh(id).updatedAt, reason: 'docs only', ...extra,
  });

  // no lock: no refusal, with or without a caller identity
  assert.equal(await refuseWhenIntegrationLockedForWriter({ ...base, todoId: a.id }), null, 'no lock, no refusal');
  assert.equal(await refuseWhenIntegrationLockedForWriter({ ...base, todoId: a.id, callerChatId: 'chat-x' }), null);
  const noLockConfirm = await confirmOf(a.id);
  assert.equal(noLockConfirm.ok, true, JSON.stringify(noLockConfirm));
  const noLockNoCode = await noCodeOf(plain('docs only without a lock').id);
  assert.equal(noLockNoCode.ok, true, JSON.stringify(noLockNoCode));

  // single lock: the locked todo may write, another todo is refused
  acquireIntegrationLock({ ...base, owner: 'single', todoId: b.id, chatId: 'chat-b' });
  assert.equal((await confirmOf(c.id)).reason, 'integration_locked', 'another todo is refused');
  assert.equal((await noCodeOf(plain('docs only under a single lock').id)).reason, 'integration_locked');
  const ownerConfirm = await confirmOf(b.id);
  assert.equal(ownerConfirm.ok, true, JSON.stringify(ownerConfirm));
  assert.equal(getIntegrationLock(base), null, 'confirm released the single lock');
  const noCodeTarget = plain('owner no-code');
  acquireIntegrationLock({ ...base, owner: 'single', todoId: noCodeTarget.id, chatId: 'chat-n' });
  const ownerNoCode = await noCodeOf(noCodeTarget.id);
  assert.equal(ownerNoCode.ok, true, JSON.stringify(ownerNoCode));
  assert.equal(getIntegrationLock(base), null, 'no-code released the single lock');

  // an active batch: a non-owner MCP confirm / no-code is refused, the batch
  // chat is accepted, and the human UI attestation still passes
  const created = await create(world, [c.id]);
  assert.equal((await confirmOf(d.id, { callerChatId: 'chat-other' })).reason, 'integration_locked');
  assert.equal((await confirmOf(d.id)).reason, 'integration_locked', 'no caller identity is not the batch agent');
  const foreignNoCode = plain('docs only under a batch (foreign)');
  assert.equal((await noCodeOf(foreignNoCode.id, { callerChatId: 'chat-other' })).reason, 'integration_locked');
  assert.equal((await noCodeOf(foreignNoCode.id)).reason, 'integration_locked', 'no caller identity is not the batch agent');
  const humanConfirm = await confirmOf(d.id, { humanAttested: true });
  assert.equal(humanConfirm.ok, true, JSON.stringify(humanConfirm));
  const humanNoCode = await noCodeOf(plain('docs only under a batch (human)').id, { humanAttested: true });
  assert.equal(humanNoCode.ok, true, JSON.stringify(humanNoCode));
  const ownerBatchConfirm = await confirmOf(c.id, { callerChatId: BATCH_CHAT });
  assert.equal(ownerBatchConfirm.ok, true, JSON.stringify(ownerBatchConfirm));
  const ownerBatchNoCode = await noCodeOf(plain('docs only under a batch (owner)').id, { callerChatId: BATCH_CHAT });
  assert.equal(ownerBatchNoCode.ok, true, JSON.stringify(ownerBatchNoCode));
  await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: world.deps });
});

test('resume: no chat is requested when reconcile / skip leaves the batch complete', async (t) => {
  const world = await makeWorld('resume-done', 1);
  t.after(world.cleanup);
  let unsafe = true;
  const deps = {
    ...world.deps,
    inspectBoundary: () => (unsafe ? { ...SAFE(), unmerged: ['conflict.txt'] } : SAFE()),
    probeChatRunLiveness: IDLE,
  };
  const created = await create(world, [world.todos[0].id]);
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-r', deps });
  const first = await handleBatchNext({ dataDir: world.dataDir, body: { batchId: created.batch.id, epoch: 1, token: created.secret }, deps: { ...deps, inspectBoundary: SAFE } });
  const failed = await handleBatchNext({
    dataDir: world.dataDir,
    body: { batchId: created.batch.id, epoch: 1, token: created.secret, entryId: first.body.entry.entryId, attempt: 1, outcome: 'failed', summary: 'x' },
    deps,
  });
  assert.equal(failed.body.batch.status, 'paused');
  unsafe = false;
  let opened = 0;
  const resumed = await resumeIntegrateBatch({
    dataDir: world.dataDir,
    batchId: created.batch.id,
    entryAction: 'skip',
    openChat: () => { opened += 1; return { chat: { id: 'new-chat' } }; },
    deps,
  });
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(opened, 0, 'a batch that finishes completed must not create a chat');
  assert.equal(resumed.chat, null);
  assert.equal(resumed.view.status, 'completed');
  assert.equal(getIntegrationLock({ dataDir: world.dataDir, workspaceFolder: world.repo }), null);
});

test('fix round: canonical workspace fence, terminal fence, marker, token-free store, cancelling, aliases', async (t) => {
  const world = await makeWorld('fix', 2);
  t.after(world.cleanup);
  const [a, b] = world.todos;
  const created = await create(world, [a.id, b.id]);
  const first = await next(world, created);
  assert.equal(first.body.action, 'entry');
  // A3: the entry carries the capability in the response, the store never does.
  assert.ok(first.body.entry.prompt.includes(created.secret));
  assert.ok(!fs.readFileSync(path.join(world.dataDir, 'integrate-batches.json'), 'utf8').includes(created.secret));
  attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-fix', deps: world.deps });
  // B1: a non-canonical workspace spelling does not bypass the fence.
  const sloppy = `${world.repo}${path.sep}.`;
  assert.equal((await checkBatchLegacyReport({ dataDir: world.dataDir, workspaceFolder: sloppy, todoId: a.id, body: {} })).ok, false);
  // A2: failing through next clears the running marker.
  assert.equal(getTodoById(world.dataDir, world.repo, a.id).integration.reason, SMART_MERGE_RUNNING);
  const failed = await next(world, created, { entryId: first.body.entry.entryId, attempt: 1, outcome: 'failed', summary: 'x' });
  assert.equal(failed.body.action, 'entry');
  assert.notEqual(getTodoById(world.dataDir, world.repo, a.id).integration.reason, SMART_MERGE_RUNNING);
  // A5: cancelling survives a pause and a later resume ends cancelled.
  const second = failed.body.entry;
  await cancelIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: world.deps });
  const UNMERGED = () => ({ ok: true, unmerged: ['x'], inProgress: [], dirty: {} });
  const paused = await next(world, created, { entryId: second.entryId, attempt: 1, outcome: 'failed', summary: 'x' }, { ...world.deps, inspectBoundary: UNMERGED });
  assert.equal(paused.body.reason, 'paused');
  assert.equal(readIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: world.deps }).status, 'cancelling');
  const resumed = await resumeIntegrateBatch({
    dataDir: world.dataDir, batchId: created.batch.id, forceLiveness: true, deps: world.deps,
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.view.status, 'cancelled');
  // A1: a stale report of the now terminal batch changes nothing.
  const stale = await checkBatchLegacyReport({
    dataDir: world.dataDir,
    workspaceFolder: world.repo,
    todoId: b.id,
    body: { batchId: created.batch.id, entryId: second.entryId, attempt: 1, epoch: 1, token: created.secret },
  });
  assert.equal(stale.ok, false);
  assert.ok(!fs.readFileSync(path.join(world.dataDir, 'integrate-batches.json'), 'utf8').includes(created.secret));
});

test('fix round: recovery applies no_code_with_changes on resume and abandon', async (t) => {
  for (const action of ['resume', 'abandon']) {
    const world = await makeWorld(`b3-${action}`, 1);
    t.after(world.cleanup);
    const todoId = world.todos[0].id;
    const created = await create(world, [todoId]);
    const first = await next(world, created);
    assert.equal(first.body.action, 'entry');
    attachBatchChat({ dataDir: world.dataDir, batchId: created.batch.id, chatId: 'chat-b3', deps: world.deps });
    // The todo is recorded as no-code although its prepared result has changes.
    const before = getTodoById(world.dataDir, world.repo, todoId);
    updateTodo(world.dataDir, world.repo, todoId, {
      status: 'done',
      strictStatus: true,
      expectedUpdatedAt: before.updatedAt,
      integration: { ...before.integration, changeScope: 'none', noCodeReason: 'x' },
    });
    const staged = getTodoById(world.dataDir, world.repo, todoId);
    updateTodo(world.dataDir, world.repo, todoId, {
      expectedUpdatedAt: staged.updatedAt,
      integration: { ...staged.integration, noCodeMaterialFingerprint: fingerprintTodoMaterial(staged) },
    });
    const idle = { ...world.deps, probeChatRunLiveness: IDLE };
    if (action === 'resume') {
      const resumed = await resumeIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: idle });
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
    } else {
      assert.equal((await abandonIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: idle })).ok, true);
    }
    const view = readIntegrateBatch({ dataDir: world.dataDir, batchId: created.batch.id, deps: idle });
    assert.equal(view.entries[0].state, 'failed');
    assert.equal(view.entries[0].reason, 'no_code_with_changes');
  }
});

test('fix round: boundary distinguishes absence from errors and fingerprints directories', (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, 'nested'));
  fs.writeFileSync(path.join(repo, 'nested', 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'x\n');
  const before = inspectWorkspaceBoundary({ workspaceFolder: repo });
  assert.equal(before.ok, true);
  fs.writeFileSync(path.join(repo, 'nested', 'a.txt'), 'two\n');
  const after = inspectWorkspaceBoundary({ workspaceFolder: repo });
  assert.notEqual(before.dirty['nested/a.txt'], after.dirty['nested/a.txt']);
  // A path the process cannot read is an inspection failure, not "absent".
  const secret = path.join(repo, 'locked.txt');
  fs.writeFileSync(secret, 'x');
  fs.chmodSync(secret, 0o000);
  if (process.getuid && process.getuid() !== 0) {
    const failed = inspectWorkspaceBoundary({ workspaceFolder: repo });
    assert.equal(failed.ok, false);
    assert.equal(evaluateBoundary({ snapshot: {}, current: failed }).safe, false);
  }
  fs.chmodSync(secret, 0o600);
  // A submodule-like nested repo is fingerprinted by HEAD and status, not a constant.
  const nested = path.join(repo, 'sub');
  fs.mkdirSync(nested);
  const git = (args) => execFileSync('git', args, { cwd: nested, stdio: 'ignore' });
  git(['init', '-q']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'one']);
  const sub1 = inspectWorkspaceBoundary({ workspaceFolder: repo });
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'two']);
  const sub2 = inspectWorkspaceBoundary({ workspaceFolder: repo });
  assert.equal(sub1.ok, true);
  assert.notEqual(sub1.dirty['sub/'] ?? sub1.dirty.sub, sub2.dirty['sub/'] ?? sub2.dirty.sub);
});

test('fix round: nested repo content edits of an already-dirty file change the fingerprint; caps fail closed', (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const nested = path.join(repo, 'sub');
  fs.mkdirSync(nested);
  const git = (args) => execFileSync('git', args, { cwd: nested, stdio: 'ignore' });
  fs.writeFileSync(path.join(nested, 'f.txt'), 'base\n');
  git(['init', '-q']);
  git(['add', 'f.txt']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one']);
  fs.writeFileSync(path.join(nested, 'f.txt'), 'edit one\n');
  const before = inspectWorkspaceBoundary({ workspaceFolder: repo });
  assert.equal(before.ok, true);
  fs.writeFileSync(path.join(nested, 'f.txt'), 'edit two\n');
  const after = inspectWorkspaceBoundary({ workspaceFolder: repo });
  assert.equal(after.ok, true);
  assert.notDeepEqual(before.dirty, after.dirty);
  const verdict = evaluateBoundary({ snapshot: before.dirty, current: after });
  assert.equal(verdict.safe, false);
  assert.ok(verdict.reasons.includes('workspace_drift'));
  const capped = inspectWorkspaceBoundary({ workspaceFolder: repo, nestedLimits: { maxFiles: 0 } });
  assert.equal(capped.ok, false);
  assert.equal(evaluateBoundary({ snapshot: before.dirty, current: capped }).safe, false);
  const bytes = inspectWorkspaceBoundary({ workspaceFolder: repo, nestedLimits: { maxBytes: 1 } });
  assert.equal(bytes.ok, false);
});

test('fix round: aliased child blocks the ancestor target\'s sequential siblings', async (t) => {
  const world = await makeWorld('alias', 0);
  t.after(world.cleanup);
  const baseDir = tempDir('cretli-ib-base-alias-');
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const group = addTodo(world.dataDir, world.repo, { title: 'group', status: 'doing', runMode: 'sequential' }).item;
  const p = addTodo(world.dataDir, world.repo, { title: 'p', status: 'doing', parentId: group.id, executionMode: 'worktree' }).item;
  const q = addTodo(world.dataDir, world.repo, { title: 'q', status: 'done', parentId: group.id }).item;
  const c = addTodo(world.dataDir, world.repo, { title: 'c', status: 'done', parentId: p.id }).item;
  const created = ensureWorktree({
    todoId: p.id, workspaceFolder: world.repo, mode: 'worktree', config: worktreeConfig(baseDir), registryOptions: { dataDir: world.dataDir },
  });
  fs.writeFileSync(path.join(created.record.worktreePath, 'p.txt'), 'p\n');
  assert.equal((await prepareManualTodoIntegration({ todoId: p.id, workspaceFolder: world.repo, dataDir: world.dataDir })).ok, true);
  const batch = await create(world, [c.id, q.id]);
  assert.equal(batch.view.entries[0].targetId, p.id);
  const first = await next(world, batch);
  const failed = await next(world, batch, { entryId: first.body.entry.entryId, attempt: 1, outcome: 'failed', summary: 'x' });
  assert.equal(failed.body.batch.entries[1].state, 'skipped');
  assert.equal(failed.body.batch.entries[1].reason, `blocked_by:${first.body.entry.entryId}`);
});

test('fix round: unborn nested repo is content-fingerprinted; malformed status fails closed', (t) => {
  const repo = createTempRepo().dir;
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const nested = path.join(repo, 'unborn');
  fs.mkdirSync(nested);
  execFileSync('git', ['init', '-q'], { cwd: nested, stdio: 'ignore' });
  fs.writeFileSync(path.join(nested, 'u.txt'), 'one\n');
  const before = inspectWorkspaceBoundary({ workspaceFolder: repo });
  assert.equal(before.ok, true);
  assert.match(JSON.stringify(before.dirty), /repo:unborn:/);
  fs.writeFileSync(path.join(nested, 'u.txt'), 'two\n');
  const after = inspectWorkspaceBoundary({ workspaceFolder: repo });
  assert.equal(after.ok, true);
  assert.notDeepEqual(before.dirty, after.dirty);
  assert.equal(inspectWorkspaceBoundary({ workspaceFolder: repo, nestedLimits: { maxBytes: 1 } }).ok, false);
  // unknown and malformed records throw
  assert.throws(() => parsePorcelainV2('Z weird\0'));
  assert.throws(() => parsePorcelainV2('1 M. N... 100644\0'));
  assert.throws(() => parsePorcelainV2('2 R. N... 1 2 3 h1 h2 R100 new\0'));
  assert.equal(parsePorcelainV2('? a.txt\0').length, 1);
  // a repo whose HEAD cannot be inspected fails closed
  const broken = inspectWorkspaceBoundary({
    workspaceFolder: repo,
    deps: { runGit: (args, cwd, o) => (path.basename(cwd) === 'unborn' && args[0] === 'symbolic-ref' ? { status: 1, stdout: '' } : runGit(args, cwd, o)) },
  });
  assert.equal(broken.ok, false);
});
