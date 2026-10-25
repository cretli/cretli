/**
 * Bulk integrate routes over real HTTP: route capture order, lock gating of the
 * existing mutating routes, the public `next` callback and the legacy report fence.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import { ensureWorktree } from '../lib/worktree-manager.js';
import { prepareManualTodoIntegration } from '../lib/workspace-watcher-integration.js';
import { registerIntegrateBatchRoutes } from '../lib/routes/integrate-batch-routes.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { registerWorktreesRoutes } from '../lib/routes/worktrees-routes.js';
import { registerChatAgentRoutes } from '../lib/routes/chat-agent-routes.js';
import { isPublicApiPath } from '../lib/auth.js';
import { createTempRepo, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

/**
 * @param {string} name
 * @returns {Promise<{ base: string, dataDir: string, repo: string, todos: object[], call: Function, close: () => Promise<void> }>}
 */
async function startWorld(name) {
  const dataDir = tempDir(`cretli-ibr-data-${name}-`);
  const baseDir = tempDir(`cretli-ibr-base-${name}-`);
  const repo = createTempRepo().dir;
  const todos = [];
  for (let i = 0; i < 2; i += 1) {
    const todo = addTodo(dataDir, repo, { title: `todo ${i + 1}`, status: 'doing', executionMode: 'worktree' }).item;
    const created = ensureWorktree({
      todoId: todo.id, workspaceFolder: repo, mode: 'worktree', config: worktreeConfig(baseDir), registryOptions: { dataDir },
    });
    fs.writeFileSync(path.join(created.record.worktreePath, `f${i}.txt`), `f${i}\n`);
    assert.equal((await prepareManualTodoIntegration({ todoId: todo.id, workspaceFolder: repo, dataDir })).ok, true);
    todos.push(todo);
  }
  const app = express();
  app.use(express.json());
  const common = {
    dataDir,
    getCurrentCwd: () => repo,
    getCurrentWorkspaceFile: () => '',
    getLocalCallbackBaseUrl: () => 'https://127.0.0.1:3011',
    useHttps: true,
    agentModel: '',
  };
  registerIntegrateBatchRoutes(app, { ...common, verifyAgentCallback: () => true });
  registerTodosRoutes(app, common);
  registerWorktreesRoutes(app, common);
  registerChatAgentRoutes(app, { ...common, agentCmd: '', workspaceDirForAgent: () => repo, verifyAgentCallback: () => true });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    base, dataDir, repo, todos, call,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      for (const dir of [dataDir, baseDir, repo]) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the next callback is a public path and integrate-batch is not captured by /api/todos/:id', async (t) => {
  assert.equal(isPublicApiPath('/api/integrate-batch/next'), true);
  const world = await startWorld('routes');
  t.after(world.close);
  const list = await world.call('GET', '/api/todos/integrate-batch');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.batches, []);
  assert.equal((await world.call('GET', '/api/todos/integrate-batch/unknown')).status, 404);
  const todos = await world.call('GET', '/api/todos');
  const row = todos.body.items.find((item) => item.id === world.todos[0].id);
  assert.equal(row.batchEligibility.mode, 'smart-merge');
});

test('the human confirm / no-code attestation stays usable while a batch owns the lock', async (t) => {
  const world = await startWorld('human-lock');
  t.after(world.close);
  const created = await world.call('POST', '/api/todos/integrate-batch', {
    todoIds: [world.todos[0].id], workspaceFolder: world.repo, agentTransport: 'opencode',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  // The operator's REST no-code review is exempt from the batch lock.
  const plain = addTodo(world.dataDir, world.repo, { title: 'docs only', status: 'done' }).item;
  const noCode = await world.call('POST', `/api/todos/${plain.id}/integration`, {
    action: 'no-code', expectedUpdatedAt: plain.updatedAt, reason: 'docs only',
  });
  assert.equal(noCode.status, 200, JSON.stringify(noCode.body));
  assert.equal(getTodoById(world.dataDir, world.repo, plain.id).integration.noCodeReason, 'docs only');
  // ... and so is the operator's confirm of the batch target.
  const target = getTodoById(world.dataDir, world.repo, world.todos[0].id);
  const confirmed = await world.call('POST', `/api/todos/${world.todos[0].id}/integration`, {
    action: 'confirm', expectedUpdatedAt: target.updatedAt, proof: { simple: true },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(getTodoById(world.dataDir, world.repo, world.todos[0].id).status, 'done');
});

test('batch create opens one chat, gates the mutating routes and the callback fences reports', async (t) => {
  const world = await startWorld('gate');
  t.after(world.close);
  const created = await world.call('POST', '/api/todos/integrate-batch', {
    todoIds: world.todos.map((row) => row.id),
    workspaceFolder: world.repo,
    agentTransport: 'opencode',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok(created.body.chat.id);
  assert.match(created.body.initialPrompt, /api\/integrate-batch\/next/);
  const batchId = created.body.batch.id;
  const secret = /"token":"([^"]+)"/.exec(created.body.initialPrompt)[1];

  // locked: every listed mutating route is refused
  const id = world.todos[0].id;
  const refused = [
    await world.call('POST', `/api/todos/${id}/smart-merge`, {}),
    await world.call('POST', `/api/todos/${id}/verify-integration`, {}),
    await world.call('POST', `/api/todos/${id}/integration`, { action: 'prepare' }),
    await world.call('POST', `/api/todos/${id}/integration`, { action: 'merge' }),
    await world.call('POST', `/api/todos/${id}/integration`, { action: 'apply' }),
    await world.call('POST', `/api/todos/${id}/integration`, { action: 'reject', reason: 'x' }),
    await world.call('POST', `/api/todos/${id}/integration`, { action: 'invalidate', reason: 'x' }),
    await world.call('POST', `/api/worktrees/${id}/merge`, {}),
    await world.call('POST', `/api/worktrees/${id}/reject`, {}),
    await world.call('POST', `/api/worktrees/${id}/cleanup`, {}),
  ];
  for (const answer of refused) {
    assert.equal(answer.status, 409);
    assert.equal(answer.body.error, 'integration_locked');
  }
  // a second batch is refused too
  const second = await world.call('POST', '/api/todos/integrate-batch', { todoIds: [id], workspaceFolder: world.repo, agentTransport: 'opencode' });
  assert.equal(second.status, 409);

  // wrong secret is 401 on the public callback even from loopback
  const wrong = await world.call('POST', '/api/integrate-batch/next', { batchId, epoch: 1, token: 'nope' });
  assert.equal(wrong.status, 401);
  const first = await world.call('POST', '/api/integrate-batch/next', { batchId, epoch: 1, token: secret });
  assert.equal(first.body.action, 'entry');
  assert.equal(first.body.entry.todoId, id);

  // a non-canonical workspace spelling does not bypass the fence
  const sloppy = await world.call('POST', '/api/smart-merge-report-from-agent', {
    todoId: id, workspaceFolder: `${world.repo}${path.sep}.`, outcome: 'merged',
  });
  assert.equal(sloppy.status, 409);
  assert.equal(sloppy.body.error, 'batch_context_invalid');

  // legacy report fence: missing context is rejected and changes nothing
  const bare = await world.call('POST', '/api/smart-merge-report-from-agent', {
    todoId: id, workspaceFolder: world.repo, outcome: 'merged',
  });
  assert.equal(bare.status, 409);
  assert.equal(bare.body.error, 'batch_context_invalid');
  assert.equal(getTodoById(world.dataDir, world.repo, id).integration.appliedAt, undefined);
  const fenced = await world.call('POST', '/api/smart-merge-report-from-agent', {
    todoId: id, workspaceFolder: world.repo, outcome: 'merged', batchId, entryId: first.body.entry.entryId, attempt: 1, epoch: 1, token: secret,
  });
  assert.equal(fenced.status, 200, JSON.stringify(fenced.body));
  const view = await world.call('GET', `/api/todos/integrate-batch/${batchId}`);
  assert.equal(view.body.batch.entries[0].state, 'awaiting_confirmation');

  // cancel keeps the lock while the entry is open; abandon with override releases it
  const cancel = await world.call('POST', `/api/todos/integrate-batch/${batchId}/cancel`, {});
  assert.equal(cancel.body.batch.status, 'cancelling');
  const denied = await world.call('POST', `/api/todos/integrate-batch/${batchId}/abandon`, {});
  assert.equal(denied.status, 409);
  const abandoned = await world.call('POST', `/api/todos/integrate-batch/${batchId}/abandon`, { forceLiveness: true });
  assert.equal(abandoned.status, 200);
  assert.equal(abandoned.body.batch.status, 'abandoned');
  const free = await world.call('POST', `/api/todos/${id}/integration`, { action: 'prepare' });
  assert.notEqual(free.status, 409);
  // a stale report of the abandoned batch is rejected and changes nothing
  const stale = await world.call('POST', '/api/smart-merge-report-from-agent', {
    todoId: id, workspaceFolder: world.repo, outcome: 'failed', batchId, entryId: first.body.entry.entryId, attempt: 1, epoch: 1, token: secret,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'batch_context_invalid');
});

test('a single smart merge takes the lock and a second one is refused until it is cleared', async (t) => {
  const world = await startWorld('single');
  t.after(world.close);
  const id = world.todos[0].id;
  const first = await world.call('POST', `/api/todos/${id}/smart-merge`, { workspaceFolder: world.repo, agentTransport: 'opencode' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await world.call('POST', `/api/todos/${world.todos[1].id}/smart-merge`, {});
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'integration_locked');
  const created = await world.call('POST', '/api/todos/integrate-batch', { todoIds: [world.todos[1].id], agentTransport: 'opencode' });
  assert.equal(created.status, 409);
  const cleared = await world.call('POST', '/api/integration-lock/clear', {});
  assert.equal(cleared.status, 200);
  const after = await world.call('POST', `/api/todos/${world.todos[1].id}/smart-merge`, { workspaceFolder: world.repo, agentTransport: 'opencode' });
  assert.equal(after.status, 200);
});

test('batch chat on a non-sdk harness drops the Cursor-only `auto` model', async (t) => {
  const world = await startWorld('model-auto');
  t.after(world.close);
  const created = await world.call('POST', '/api/todos/integrate-batch', {
    todoIds: [world.todos[0].id], workspaceFolder: world.repo, agentTransport: 'opencode', model: 'auto',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok(!created.body.chat.model, `unexpected model ${created.body.chat.model}`);
});
