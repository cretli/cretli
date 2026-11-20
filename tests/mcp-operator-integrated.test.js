import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, after } from 'node:test';
import { commitFile, createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const dataDir = tempDir('cretli-operator-integrated-data-');
process.env.CRETLI_DATA_DIR = dataDir;
const { addTodo, updateTodo, listTodos } = await import('../lib/persist/todos-store.js');
const { callExternalOperatorTool, EXTERNAL_OPERATOR_TOOLS } = await import('../lib/mcp/mcp-external-operator-tools.js');
const { listReadyTodoLeaves } = await import('../lib/todo-tree.js');
const { confirmWorkspaceTodoIntegration, prepareManualTodoIntegration } = await import('../lib/workspace-watcher-integration.js');
const { ensureWorktree, updateWorktreeState } = await import('../lib/worktree-manager.js');
const { readWorktreeRegistry } = await import('../lib/persist/worktree-registry-persist.js');
const { attachTodoIntegrationReadModels } = await import('../lib/todo-integration-read.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
setBuiltinMcpRuntimeDeps({ dataDir });
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function fixture(t) {
  const repo = createTempRepo();
  t.after(() => fs.rmSync(repo.dir, { recursive: true, force: true }));
  const client = { id: 'operator-test', name: 'Test operator', mode: 'operator', workspaceFolder: repo.dir };
  return { repo, client };
}
async function call(client, name, args) {
  const response = await callExternalOperatorTool(client, name, args);
  assert.equal(response.isError, false, response.content[0].text);
  return JSON.parse(response.content[0].text);
}
async function add(repo, input = {}) {
  const doc = await addTodo(dataDir, repo.dir, { title: 'Task', status: 'doing', ...input });
  return doc.item;
}
async function read(repo, id) {
  return (await listTodos(dataDir, repo.dir)).items.find((row) => row.id === id);
}

test('operator confirms a squash commit using short SHA and prepare cannot reopen it', async (t) => {
  const { repo, client } = fixture(t);
  await call(client, 'operator_handoff', {});
  const todo = await add(repo);
  const base = tempDir('cretli-operator-integrated-worktrees-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const created = ensureWorktree({ todoId: todo.id, workspaceFolder: repo.dir, mode: 'worktree', config: worktreeConfig(base), registryOptions: { dataDir } });
  updateWorktreeState({ todoId: todo.id, registryOptions: { dataDir }, executionState: 'active' });
  const original = commitFile(created.record.worktreePath, 'feature.txt', 'feature\n');
  await updateTodo(dataDir, repo.dir, todo.id, { integration: { state: 'ready', materialRevision: 'original-material' } });
  git(repo.dir, ['merge', '--squash', created.record.branch]);
  git(repo.dir, ['commit', '-qm', 'squash task']);
  const squash = git(repo.dir, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(squash, original);
  assert.equal(git(repo.dir, ['branch', '--contains', original, '--format=%(refname)']).includes('refs/heads/main'), false);
  const result = await call(client, 'operator_todo_integrated', { todo_id: todo.id.slice(0, 8), commit: squash.slice(0, 10) });
  assert.equal(result.status, 'done');
  assert.equal(result.evidence.targetCommit, squash);
  assert.equal(result.evidence.materialRevision, 'original-material');
  const before = await read(repo, todo.id);
  const prepared = await prepareManualTodoIntegration({ todoId: todo.id, workspaceFolder: repo.dir, dataDir });
  assert.equal(prepared.reason, 'already_integrated');
  assert.deepEqual(await read(repo, todo.id), before);
  assert.equal(listReadyTodoLeaves((await listTodos(dataDir, repo.dir)).items).length, 0, 'the Watcher has no leaf to restart');
  const record = readWorktreeRegistry({ dataDir }).items[todo.id];
  if (record) assert.equal(record.integrationState, 'integrated');
});

test('one commit confirms multiple leaves and their finished container with current tree proof', async (t) => {
  const { repo, client } = fixture(t);
  await call(client, 'operator_handoff', {});
  const root = await add(repo, { title: 'Tree', status: 'idea' });
  const first = await add(repo, { parentId: root.id, status: 'ready' });
  const second = await add(repo, { parentId: root.id, status: 'ready' });
  const commit = commitFile(repo.dir, 'both.txt', 'two leaf changes\n');
  const refused = await callExternalOperatorTool(client, 'operator_todo_integrated', { todo_id: root.id, commit });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /descendants_open/);
  assert.equal((await read(repo, root.id)).integration, undefined);
  for (const leaf of [first, second]) {
    const result = await call(client, 'operator_todo_integrated', { todo_id: leaf.id, commit });
    assert.equal(result.status, 'done');
    assert.equal(result.evidence.scope, undefined);
  }
  const result = await call(client, 'operator_todo_integrated', { todo_id: root.id, commit });
  assert.equal(result.status, 'done');
  assert.equal(result.evidence.scope, 'tree');
  const rows = attachTodoIntegrationReadModels((await listTodos(dataDir, repo.dir)).items);
  assert.equal(rows.find((row) => row.id === root.id).integrationSummary.state, 'integrated');
});

test('already done todo gets proof and prepare leaves its status and revision unchanged', async (t) => {
  const { repo, client } = fixture(t);
  await call(client, 'operator_handoff', {});
  const todo = await add(repo, { status: 'done' });
  const prepared = await prepareManualTodoIntegration({ todoId: todo.id, workspaceFolder: repo.dir, dataDir });
  assert.equal(prepared.reason, 'already_integrated');
  assert.equal((await read(repo, todo.id)).updatedAt, todo.updatedAt);
  const result = await call(client, 'operator_todo_integrated', { todo_id: todo.id, commit: repo.baseCommit });
  assert.equal(result.status, 'done');
  assert.equal(result.evidence.branchVerified, true);
});

test('commit must be on target branch; operator lease and operator mode are required', async (t) => {
  const { repo, client } = fixture(t);
  const todo = await add(repo);
  await call({ ...client, id: 'other-operator' }, 'operator_handoff', {});
  let result = await callExternalOperatorTool(client, 'operator_todo_integrated', { todo_id: todo.id, commit: repo.baseCommit });
  assert.equal(result.isError, true);
  await call(client, 'operator_handoff', { takeover: true });
  git(repo.dir, ['checkout', '-qb', 'unmerged']);
  const commit = commitFile(repo.dir, 'unmerged.txt');
  git(repo.dir, ['checkout', '-q', 'main']);
  result = await callExternalOperatorTool(client, 'operator_todo_integrated', { todo_id: todo.id, commit });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /target_commit_not_on_branch/);
  assert.deepEqual(await read(repo, todo.id), todo);
  result = await callExternalOperatorTool({ ...client, mode: 'agent' }, 'operator_todo_integrated', { todo_id: todo.id, commit: repo.baseCommit });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /FORBIDDEN/);
  assert.deepEqual(EXTERNAL_OPERATOR_TOOLS.find((row) => row.name === 'operator_todo_integrated').inputSchema.required, ['todo_id', 'commit']);
});

test('prepare preserves a ready task status while publishing its worktree result', async (t) => {
  const { repo } = fixture(t);
  const todo = await add(repo, { status: 'ready' });
  const base = tempDir('cretli-prepare-preserve-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const created = ensureWorktree({ todoId: todo.id, workspaceFolder: repo.dir, mode: 'worktree', config: worktreeConfig(base), registryOptions: { dataDir } });
  updateWorktreeState({ todoId: todo.id, registryOptions: { dataDir }, executionState: 'active' });
  commitFile(created.record.worktreePath, 'ready.txt');
  const result = await prepareManualTodoIntegration({ todoId: todo.id, workspaceFolder: repo.dir, dataDir });
  assert.equal(result.ok, true, result.reason);
  assert.equal((await read(repo, todo.id)).status, 'ready');
  assert.equal((await read(repo, todo.id)).integration.state, 'ready');
});

test('commit confirmation respects CAS and preparing cannot overwrite proof on an open todo', async (t) => {
  const { repo, client } = fixture(t);
  await call(client, 'operator_handoff', {});
  const todo = await add(repo);
  await updateTodo(dataDir, repo.dir, todo.id, { body: 'new material' });
  const stale = await confirmWorkspaceTodoIntegration({
    todoId: todo.id, workspaceFolder: repo.dir, dataDir,
    expectedUpdatedAt: todo.updatedAt, proof: { commit: repo.baseCommit },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'conflict');
  assert.equal((await read(repo, todo.id)).integration, undefined);
  await call(client, 'operator_todo_integrated', { todo_id: todo.id, commit: repo.baseCommit });
  await updateTodo(dataDir, repo.dir, todo.id, { status: 'doing' });
  const before = await read(repo, todo.id);
  assert.equal((await prepareManualTodoIntegration({ todoId: todo.id, workspaceFolder: repo.dir, dataDir })).reason, 'already_integrated');
  assert.deepEqual(await read(repo, todo.id), before);
});

test('prepare rechecks completion after its asynchronous Git diff', async (t) => {
  const { repo } = fixture(t);
  const todo = await add(repo);
  const base = tempDir('cretli-prepare-concurrent-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const created = ensureWorktree({ todoId: todo.id, workspaceFolder: repo.dir, mode: 'worktree', config: worktreeConfig(base), registryOptions: { dataDir } });
  updateWorktreeState({ todoId: todo.id, registryOptions: { dataDir }, executionState: 'active' });
  commitFile(created.record.worktreePath, 'concurrent.txt');
  const { collectWorktreeExecutionDiff } = await import('../lib/worktree/git-worktree.ts');
  const result = await prepareManualTodoIntegration({
    todoId: todo.id, workspaceFolder: repo.dir, dataDir,
    deps: { collectWorktreeExecutionDiff: async (input) => {
      const diff = collectWorktreeExecutionDiff(input);
      await updateTodo(dataDir, repo.dir, todo.id, { status: 'done' });
      return diff;
    } },
  });
  assert.equal(result.reason, 'already_integrated');
  assert.equal((await read(repo, todo.id)).status, 'done');
  assert.notEqual(readWorktreeRegistry({ dataDir }).items[todo.id].integrationState, 'ready');
});
