/**
 * Manual (Todo-panel) worktree starts.
 *
 * A tree whose ROOT resolves to `worktree` creates ONE worktree keyed by the
 * root id, freezes it on the chat and lets manual integration prepare/confirm/
 * reject. Every Git repo lives under os.tmpdir(); the real checkout is never
 * touched. The orchestrator seam is not needed here because these tests never
 * start a Watcher cycle.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { getWorktreeRecord, readWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { registerTodosRoutes, clearManualStartJobs } from '../lib/routes/todos-routes.js';
import { prepareWorkspaceWatcherExecution, clearWorktreePrepareLocks } from '../lib/workspace-watcher-worktree.js';
import { classifyWorkspaceDoingTodos } from '../lib/workspace-watcher-recovery.js';
import { buildLiveWorktreePredicate } from '../lib/todo-worktree-manual.js';
import { resolveDelegationWorkspaceWriteConflict } from '../lib/delegation-workspace-guard.js';
import { WORKTREE_ERROR_CODES, WorktreeError } from '../lib/worktree/worktree-errors.js';
import { createTempRepo, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

/**
 * @param {string} name
 * @returns {{ dataDir: string, baseDir: string, repo: string, cleanup: () => void }}
 */
function makeSuite(name) {
  const dataDir = tempDir(`cretli-manual-data-${name}-`);
  const baseDir = tempDir(`cretli-manual-base-${name}-`);
  const repo = createTempRepo().dir;
  return {
    dataDir,
    baseDir,
    repo,
    cleanup: () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

/**
 * Fake Express app with the real todo routes registered.
 *
 * @param {(workspaceFolder: string) => object | null} loadWatcherPolicy
 * @param {{ dataDir: string, probeBusy?: boolean }} deps
 * @returns {{ invoke: (method: string, urlPath: string, req?: object) => Promise<{status:number, body:object}>, } | any}
 */
function makeApp(loadWatcherPolicy, deps) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
    patch(p, fn) { handlers.set(`PATCH ${p}`, fn); },
    delete(p, fn) { handlers.set(`DELETE ${p}`, fn); },
  };
  registerTodosRoutes(app, {
    dataDir: deps.dataDir,
    getCurrentCwd: () => deps.repo,
    getCurrentWorkspaceFile: () => path.join(deps.repo, 'proj.code-workspace'),
    agentModel: 'auto',
    getLocalCallbackBaseUrl: () => 'http://127.0.0.1:9999',
    useHttps: false,
    loadWatcherPolicy,
    probeChatRunLiveness: () => (deps.probeBusy
      ? { known: true, busy: true, reason: 'busy' }
      : { known: true, busy: false, reason: 'idle' }),
    worktreeDeps: deps.worktreeDeps,
  });
  const invoke = (method, urlPath, req = {}) => {
    const fn = handlers.get(`${method} ${urlPath}`);
    if (!fn) throw new Error(`no handler ${method} ${urlPath}`);
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); },
      };
      Promise.resolve(fn({ params: {}, query: {}, body: {}, ...req }, res)).catch((error) => {
        resolve({ status: 500, body: { ok: false, error: String(error && error.message) } });
      });
    });
  };
  return { invoke };
}

/**
 * Start a todo and, when the route answers 202, poll until the job settles.
 *
 * @param {any} app
 * @param {string} todoId
 * @param {string} workspaceFolder
 * @param {object} [body]
 * @returns {Promise<{ status: number, body: object }>}
 */
async function startAndSettle(app, todoId, workspaceFolder, body = {}) {
  const first = await app.invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: todoId },
    body: { agentTransport: 'claude', workspaceFolder, ...body },
  });
  if (first.status !== 202) return first;
  for (let i = 0; i < 400; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const poll = await app.invoke('GET', '/api/todos/:id/start-agent/status', {
      params: { id: todoId },
      query: { workspaceFolder, forceNew: body.forceNew ? 'true' : '' },
    });
    if (poll.status !== 202 && poll.body?.state !== 'preparing') return poll;
  }
  throw new Error('start-agent job did not settle');
}

/**
 * @param {string} dataDir
 * @param {string} repo
 * @param {string} name
 * @param {object} baseDir
 */
function setWorktreePolicy(dataDir, repo, baseDir, policy = {}) {
  return upsertWorkspaceWatcher(repo, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 25,
      maxParallel: 1,
      executionMode: 'worktree',
      worktree: worktreeConfig(baseDir),
      ...policy,
    },
  }, { dataDir });
}

test('manual root start prepares the ROOT worktree and freezes it on the chat', async (t) => {
  const suite = makeSuite('root');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });

  const root = addTodo(suite.dataDir, suite.repo, { title: 'root work', status: 'ready', executionMode: 'worktree' }).item;
  addTodo(suite.dataDir, suite.repo, { title: 'child', parentId: root.id, status: 'ready' });

  const result = await startAndSettle(app, root.id, suite.repo);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  assert.ok(record, 'the root worktree record exists');
  assert.equal(record.executionState, 'active');
  assert.equal(result.body.chat.executionFolder, record.worktreePath);
  assert.equal(result.body.todo.chatId, result.body.chat.id);
  assert.equal(result.body.worktree, true);
});

test('a leaf start and a forceNew start both reuse the ROOT worktree', async (t) => {
  const suite = makeSuite('leaf');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });

  const root = addTodo(suite.dataDir, suite.repo, { title: 'root', status: 'doing', executionMode: 'worktree' }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, { title: 'leaf', parentId: root.id, status: 'ready', executionMode: 'project' }).item;

  const first = await startAndSettle(app, leaf.id, suite.repo);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  assert.equal(first.body.chat.executionFolder, record.worktreePath);
  assert.equal(getWorktreeRecord(leaf.id, { dataDir: suite.dataDir }), null, 'the leaf must not own a record');

  const again = await startAndSettle(app, leaf.id, suite.repo, { forceNew: true });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.chat.executionFolder, record.worktreePath);
  assert.notEqual(again.body.chat.id, first.body.chat.id);
});

test('continuing in a new chat reuses the prepared worktree without re-running prepare', async (t) => {
  const suite = makeSuite('continue');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir, {
    worktree: { ...worktreeConfig(suite.baseDir), prepareCommand: [process.execPath, '-e', 'process.exit(0)'] },
  });
  let prepared = 0;
  const worktreeDeps = { runPrepareCommand: async () => { prepared += 1; } };
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo, worktreeDeps });

  const root = addTodo(suite.dataDir, suite.repo, { title: 'root', status: 'ready', executionMode: 'worktree' }).item;
  addTodo(suite.dataDir, suite.repo, { title: 'child', parentId: root.id, status: 'ready' });

  const first = await startAndSettle(app, root.id, suite.repo);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(prepared, 1, 'the first start prepares the worktree');
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });

  // A second orchestrator must be answered in one request: the client does not
  // poll here, and a slow prepare used to outlive its request timeout.
  const again = await app.invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: root.id },
    body: { agentTransport: 'claude', workspaceFolder: suite.repo, forceNew: true },
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(prepared, 1, 'an active worktree is not prepared again');
  assert.notEqual(again.body.chat.id, first.body.chat.id);
  assert.equal(again.body.chat.executionFolder, record.worktreePath);
  assert.equal(again.body.todo.orchestratorChatId, again.body.chat.id);
  assert.ok(again.body.initialPrompt.includes(first.body.chat.id), 'the prompt points at the previous chat');
  assert.equal(getWorktreeRecord(root.id, { dataDir: suite.dataDir }).executionState, 'active');
});

test('a flipped override with a live record keeps the frozen folder', async (t) => {
  const suite = makeSuite('frozen');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });

  const root = addTodo(suite.dataDir, suite.repo, { title: 'frozen', status: 'ready', executionMode: 'worktree' }).item;
  const first = await startAndSettle(app, root.id, suite.repo);
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  updateTodo(suite.dataDir, suite.repo, root.id, { executionMode: 'project' });

  const second = await startAndSettle(app, root.id, suite.repo, { forceNew: true });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.chat.executionFolder, record.worktreePath);
  assert.equal(second.body.chat.executionFolder, first.body.chat.executionFolder);
});

test('a dirty main tree refuses the start with a translated message and no chat', async (t) => {
  const suite = makeSuite('dirty');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'dirty', status: 'ready', executionMode: 'worktree' }).item;
  fs.writeFileSync(path.join(suite.repo, 'uncommitted.txt'), 'x\n');

  const result = await startAndSettle(app, root.id, suite.repo);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.ok, false);
  assert.match(String(result.body.error || ''), /uncommitted|worktree/i);
  assert.equal(getTodoById(suite.dataDir, suite.repo, root.id).chatId, undefined);
  assert.equal(getTodoById(suite.dataDir, suite.repo, root.id).status, 'ready');
  assert.equal(getWorktreeRecord(root.id, { dataDir: suite.dataDir }), null);
});

test('an explicit snapshot choice reaches manual start and preserves dirty files for the agent', async (t) => {
  const suite = makeSuite('dirty-snapshot');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'snapshot', status: 'ready', executionMode: 'worktree' }).item;
  fs.writeFileSync(path.join(suite.repo, 'uncommitted.txt'), 'local work\n');
  const result = await startAndSettle(app, root.id, suite.repo, { dirtyPolicy: 'snapshot' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  assert.equal(record.baseKind, 'snapshot');
  assert.equal(fs.readFileSync(path.join(record.worktreePath, 'uncommitted.txt'), 'utf8'), 'local work\n');
});

test('worktree mode without a layout derives and persists the layout, then starts', async (t) => {
  const suite = makeSuite('nolayout');
  t.after(suite.cleanup);
  // The repo lives directly in os.tmpdir(), so the derived root is shared; clean
  // up this repo's namespace so the test leaves nothing behind.
  const derivedRoot = path.join(path.dirname(suite.repo), '.cretli-worktrees');
  t.after(() => fs.rmSync(path.join(derivedRoot, path.basename(suite.repo)), { recursive: true, force: true }));
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5, executionMode: 'worktree' },
  }, { dataDir: suite.dataDir });
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'nolayout', status: 'ready', executionMode: 'worktree' }).item;

  const result = await startAndSettle(app, root.id, suite.repo);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  assert.ok(record, 'the derived worktree record exists');
  assert.equal(result.body.chat.executionFolder, record.worktreePath);
  // The derivation is persisted, so the per-workspace settings panel shows it.
  const layout = getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).policy.worktree;
  assert.equal(layout.root, derivedRoot);
  assert.equal(layout.namespace, path.basename(suite.repo));
  assert.equal(layout.branchPrefix, `${path.basename(suite.repo)}/todo/`);
});

test('D1: a live descendant record blocks a manual root start with 409', async (t) => {
  const suite = makeSuite('mixing');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'root', status: 'doing', executionMode: 'worktree' }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, { title: 'leaf', parentId: root.id, status: 'doing', executionMode: 'worktree' }).item;
  await prepareWorkspaceWatcherExecution({
    todoId: leaf.id,
    workspaceFolder: suite.repo,
    todo: leaf,
    policy: getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).policy,
    dataDir: suite.dataDir,
  });

  const result = await app.invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: root.id },
    body: { agentTransport: 'claude', workspaceFolder: suite.repo },
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'WORKTREE_REGISTRY_CONFLICT');
  assert.equal(result.body.conflictTodoId, leaf.id);
});

test('D1: a live ancestor record blocks the Watcher leaf prepare with 409', async (t) => {
  const suite = makeSuite('mixing-watcher');
  t.after(suite.cleanup);
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const root = addTodo(suite.dataDir, suite.repo, { title: 'root', status: 'doing', executionMode: 'worktree' }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, { title: 'leaf', parentId: root.id, status: 'ready', executionMode: 'worktree' }).item;
  const policy = getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).policy;
  await prepareWorkspaceWatcherExecution({
    todoId: root.id,
    workspaceFolder: suite.repo,
    todo: root,
    policy,
    dataDir: suite.dataDir,
  });
  await assert.rejects(
    () => prepareWorkspaceWatcherExecution({
      todoId: leaf.id,
      workspaceFolder: suite.repo,
      todo: leaf,
      policy,
      dataDir: suite.dataDir,
      lineageTodoIds: [root.id],
    }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
  );
});

test('a reused chat with no folder is re-pointed once; a different folder is a 409', async (t) => {
  const suite = makeSuite('reuse');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'reuse', status: 'ready', executionMode: 'worktree' }).item;

  // Pre-create the worktree record and a chat that has no folder yet.
  const record = (await prepareWorkspaceWatcherExecution({
    todoId: root.id,
    workspaceFolder: suite.repo,
    todo: root,
    policy: getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).policy,
    dataDir: suite.dataDir,
  })).record;
  const chat = addChat('session-x', '[Todo] reuse', null, suite.repo, undefined, {
    agentTransport: 'claude',
    todoId: root.id,
  });
  updateTodo(suite.dataDir, suite.repo, root.id, { chatId: chat.id, status: 'doing' });

  const reused = await startAndSettle(app, root.id, suite.repo);
  assert.equal(reused.status, 200, JSON.stringify(reused.body));
  assert.equal(reused.body.reused, true);
  assert.equal(reused.body.chat.executionFolder, record.worktreePath);
  assert.equal(loadChats().find((row) => row.id === chat.id).executionFolder, record.worktreePath);

  // A chat already frozen to a different folder is never silently re-pointed.
  const other = path.join(suite.baseDir, 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  const { updateChat } = await import('../lib/persist/chats-persist.js');
  updateChat(chat.id, { executionFolder: other });
  const conflict = await app.invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: root.id },
    body: { agentTransport: 'claude', workspaceFolder: suite.repo },
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, 'WORKTREE_REUSE_MISMATCH');
});

test('manual integration prepare/confirm works on the ROOT and reject keeps doing', async (t) => {
  const suite = makeSuite('integration');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'integrate', status: 'ready', executionMode: 'worktree' }).item;
  const started = await startAndSettle(app, root.id, suite.repo);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 'feature.js'), 'export const x = 1;\n');

  const prepared = await app.invoke('POST', '/api/todos/:id/integration', {
    params: { id: root.id },
    body: { action: 'prepare', workspaceFolder: suite.repo },
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const item = getTodoById(suite.dataDir, suite.repo, root.id);
  assert.equal(item.integration.state, 'ready');
  assert.equal(item.status, 'doing');
  assert.equal(getWorktreeRecord(root.id, { dataDir: suite.dataDir }).integrationState, 'ready');
  const stored = readWorktreeRegistry({ dataDir: suite.dataDir }).items[root.id];
  const cycleId = Object.keys(stored.results)[0];
  assert.match(cycleId, /^manual-/);

  const applied = await app.invoke('POST', '/api/todos/:id/integration', {
    params: { id: root.id },
    body: { action: 'apply', workspaceFolder: suite.repo },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(fs.readFileSync(path.join(suite.repo, 'feature.js'), 'utf8'), 'export const x = 1;\n');

  const confirmed = await app.invoke('POST', '/api/todos/:id/integration', {
    params: { id: root.id },
    body: { action: 'confirm', workspaceFolder: suite.repo, expectedUpdatedAt: applied.body.item.updatedAt },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(getTodoById(suite.dataDir, suite.repo, root.id).status, 'done');
});

test('a non-root integration prepare resolves the tree ROOT', async (t) => {
  const suite = makeSuite('non-root-resolve');
  t.after(suite.cleanup);
  const loadPolicy = () => null;
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'r', status: 'doing', executionMode: 'worktree' }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, { title: 'l', parentId: root.id, status: 'doing' }).item;
  const result = await app.invoke('POST', '/api/todos/:id/integration', {
    params: { id: leaf.id },
    body: { action: 'prepare', workspaceFolder: suite.repo },
  });
  // The node itself is accepted and resolved to the root; the tree has no
  // worktree here, which is the honest refusal (was `not_root` before).
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error, 'no_worktree');
});

test('manual merge integrates a worktree tree from any node and is replay-safe', async (t) => {
  const suite = makeSuite('merge');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'merge', status: 'ready', executionMode: 'worktree' }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, { title: 'leaf', parentId: root.id, status: 'ready' }).item;
  const started = await startAndSettle(app, root.id, suite.repo);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 'feature.js'), 'export const x = 1;\n');

  const merged = await app.invoke('POST', '/api/todos/:id/integration', {
    params: { id: leaf.id },
    body: { action: 'merge', workspaceFolder: suite.repo },
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.applied, true);
  assert.equal(merged.body.alreadyApplied, false);
  assert.equal(merged.body.item.id, root.id, 'the item returned is the tree ROOT');
  assert.equal(fs.readFileSync(path.join(suite.repo, 'feature.js'), 'utf8'), 'export const x = 1;\n');
  const after = getTodoById(suite.dataDir, suite.repo, root.id);
  assert.equal(after.status, 'doing', 'merge leaves the decision to confirm/reject');
  assert.equal(after.integration.state, 'ready');

  const replay = await app.invoke('POST', '/api/todos/:id/integration', {
    params: { id: leaf.id },
    body: { action: 'merge', workspaceFolder: suite.repo },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.alreadyApplied, true);
  assert.equal(replay.body.applied, false);
});

test('manual merge works from a done tree and the list reports the live worktree', async (t) => {
  const suite = makeSuite('merge-done');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'done root', status: 'ready', executionMode: 'worktree' }).item;
  const leaf = addTodo(suite.dataDir, suite.repo, { title: 'done leaf', parentId: root.id, status: 'ready' }).item;
  const started = await startAndSettle(app, root.id, suite.repo);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 'feature.js'), 'export const x = 1;\n');
  // A tree closed as done without integration is exactly the stranded case.
  updateTodo(suite.dataDir, suite.repo, leaf.id, { status: 'done', strictStatus: true });
  updateTodo(suite.dataDir, suite.repo, root.id, { status: 'done', strictStatus: true });

  const list = await app.invoke('GET', '/api/todos', { query: { workspaceFolder: suite.repo } });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const rootRow = list.body.items.find((row) => row.id === root.id);
  const leafRow = list.body.items.find((row) => row.id === leaf.id);
  assert.equal(rootRow.worktree.live, true);
  assert.equal(rootRow.worktree.ownerTodoId, root.id);
  assert.equal(rootRow.worktree.branch, record.branch);
  assert.equal(leafRow.worktree.live, true, 'a subtask reports the ROOT worktree it belongs to');
  assert.equal(leafRow.worktree.ownerTodoId, root.id);

  const merged = await app.invoke('POST', '/api/todos/:id/integration', {
    params: { id: leaf.id },
    body: { action: 'merge', workspaceFolder: suite.repo },
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(fs.readFileSync(path.join(suite.repo, 'feature.js'), 'utf8'), 'export const x = 1;\n');
  // A container whose children are all done is derived back to `done`; the
  // integration pointer is what keeps the result awaiting a human decision.
  const afterRoot = getTodoById(suite.dataDir, suite.repo, root.id);
  assert.equal(afterRoot.status, 'done');
  assert.equal(afterRoot.integration.state, 'ready');
  assert.equal(getWorktreeRecord(root.id, { dataDir: suite.dataDir }).integrationState, 'ready');
});

test('manual merge reports the conflicted paths and leaves the workspace untouched', async (t) => {
  const suite = makeSuite('merge-conflict');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'conflict', status: 'ready', executionMode: 'worktree' }).item;
  const started = await startAndSettle(app, root.id, suite.repo);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const record = getWorktreeRecord(root.id, { dataDir: suite.dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 'README.md'), '# agent result\n');
  fs.writeFileSync(path.join(suite.repo, 'README.md'), '# user changed the same file\n');

  const merged = await app.invoke('POST', '/api/todos/:id/integration', {
    params: { id: root.id },
    body: { action: 'merge', workspaceFolder: suite.repo },
  });
  assert.equal(merged.status, 409, JSON.stringify(merged.body));
  assert.equal(merged.body.error, 'integration_conflict');
  assert.deepEqual(merged.body.conflicts, ['README.md']);
  assert.equal(fs.readFileSync(path.join(suite.repo, 'README.md'), 'utf8'), '# user changed the same file\n');
  assert.equal(getTodoById(suite.dataDir, suite.repo, root.id).integration?.state, 'ready');
});

test('a doing todo with a live worktree record is user_action and never auto-released', async (t) => {
  const suite = makeSuite('recovery');
  t.after(suite.cleanup);
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const root = addTodo(suite.dataDir, suite.repo, { title: 'live', status: 'doing', executionMode: 'worktree' }).item;
  await prepareWorkspaceWatcherExecution({
    todoId: root.id,
    workspaceFolder: suite.repo,
    todo: root,
    policy: getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).policy,
    dataDir: suite.dataDir,
  });
  const item = getTodoById(suite.dataDir, suite.repo, root.id);
  const states = classifyWorkspaceDoingTodos({
    items: [item],
    delegations: [],
    cycles: [],
    probe: () => ({ known: true, busy: false, reason: 'idle' }),
    isCycleChatAlive: () => false,
    getChat: () => null,
    now: Date.now(),
    hasLiveWorktree: buildLiveWorktreePredicate(suite.dataDir),
  });
  assert.equal(states[0].state, 'user_action');
  assert.equal(states[0].reason, 'worktree_open');
  assert.equal(getTodoById(suite.dataDir, suite.repo, root.id).status, 'doing');
});

test('deleting or re-parenting a tree with a live worktree is refused without force', async (t) => {
  const suite = makeSuite('lifecycle');
  t.after(suite.cleanup);
  clearManualStartJobs();
  clearWorktreePrepareLocks();
  setWorktreePolicy(suite.dataDir, suite.repo, suite.baseDir);
  const loadPolicy = (folder) => getWorkspaceWatcher(folder, { dataDir: suite.dataDir });
  const app = makeApp(loadPolicy, { dataDir: suite.dataDir, repo: suite.repo });
  const root = addTodo(suite.dataDir, suite.repo, { title: 'live root', status: 'ready', executionMode: 'worktree' }).item;
  const started = await startAndSettle(app, root.id, suite.repo);
  assert.equal(started.status, 200, JSON.stringify(started.body));

  const blockedDelete = await app.invoke('DELETE', '/api/todos/:id', {
    params: { id: root.id },
    query: { workspaceFolder: suite.repo },
  });
  assert.equal(blockedDelete.status, 409, JSON.stringify(blockedDelete.body));
  assert.equal(blockedDelete.body.code, 'WORKTREE_REGISTRY_CONFLICT');

  const other = addTodo(suite.dataDir, suite.repo, { title: 'other', status: 'idea' }).item;
  const blockedReparent = await app.invoke('PATCH', '/api/todos/:id', {
    params: { id: root.id },
    body: { parentId: other.id, workspaceFolder: suite.repo },
  });
  assert.equal(blockedReparent.status, 409, JSON.stringify(blockedReparent.body));

  const forced = await app.invoke('DELETE', '/api/todos/:id', {
    params: { id: root.id },
    query: { workspaceFolder: suite.repo, force: 'true' },
  });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
});

test('the per-root prepare lock serializes two concurrent prepares for one tree', async (t) => {
  const suite = makeSuite('lock');
  t.after(suite.cleanup);
  clearWorktreePrepareLocks();
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 25,
      maxParallel: 1,
      executionMode: 'worktree',
      worktree: { ...worktreeConfig(suite.baseDir), prepareCommand: [process.execPath, '-e', 'process.exit(0)'] },
    },
  }, { dataDir: suite.dataDir });
  const policy = getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).policy;
  let created = 0;
  let prepared = 0;
  const deps = {
    runPrepareCommand: async () => {
      prepared += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
  const todoId = 'abababab-abab-abab-abab-abababababab';
  const [a, b] = await Promise.all([
    prepareWorkspaceWatcherExecution({ todoId, workspaceFolder: suite.repo, todo: {}, policy, dataDir: suite.dataDir, deps }),
    prepareWorkspaceWatcherExecution({ todoId, workspaceFolder: suite.repo, todo: {}, policy, dataDir: suite.dataDir, deps }),
  ]);
  if (a.created) created += 1;
  if (b.created) created += 1;
  assert.equal(created, 1, 'only one call creates the worktree');
  assert.equal(a.executionFolder, b.executionFolder);
  assert.equal(prepared, 2, 'each serialized call still runs its own prepare step');
});

test('delegated mutation in a worktree folder does not collide with the main folder', () => {
  const executionFolder = '/tmp/cretli-worktree-A';
  const active = [{
    id: 'd1',
    parentChatId: 'parent-main',
    status: 'running',
    assignment: 'implement',
    workspaceFolder: '/tmp/main-workspace',
    executionFolder: '/tmp/main-workspace',
  }];
  const worktreeJob = resolveDelegationWorkspaceWriteConflict({
    active,
    workspaceFolder: '/tmp/main-workspace',
    executionFolder,
    parentChatId: 'parent-worktree',
    incomingAssignment: 'implement',
  });
  assert.equal(worktreeJob.ok, true, 'a different execution folder is not busy');

  const sameFolder = resolveDelegationWorkspaceWriteConflict({
    active: [{ ...active[0], executionFolder, workspaceFolder: '/tmp/main-workspace' }],
    workspaceFolder: '/tmp/main-workspace',
    executionFolder,
    parentChatId: 'parent-worktree-2',
    incomingAssignment: 'implement',
  });
  assert.equal(sameFolder.ok, false);
  assert.equal(sameFolder.code, 'workspace_busy');
});
