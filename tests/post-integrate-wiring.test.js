import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTempRepo, git, tempDir } from './helpers/temp-git-repo.js';
import { createPostIntegrator } from '../lib/integration/post-integrate.js';
import { automaticallyIntegrateWorkspaceTodo, markTodoIntegrationReady } from '../lib/workspace-watcher-integration.js';
import { addTodo } from '../lib/persist/todos-persist.js';
import { mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { worktreeResultPatchPath } from '../lib/worktree/worktree-result.ts';
import { getWorkspaceWatcherRuntimeControl } from '../lib/workspace-watcher-runtime-control.js';
import { blockNewStarts, releasePostIntegrateBlockIfOwned, unblockNewStarts } from '../lib/workspace-watcher-runtime.js';

const REL = 'lib/leaf.js';

async function fixture(t) {
  const { dir: repo, baseCommit } = createTempRepo({ file: 'README.md', content: 'base\n' });
  const dataDir = tempDir('cretli-post-wiring-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  git(repo, ['config', 'user.name', 'Cretli Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  fs.mkdirSync(path.join(repo, 'lib'));
  fs.writeFileSync(path.join(repo, REL), 'leaf\n');
  git(repo, ['add', '-N', REL]);
  const patch = git(repo, ['diff', '--binary']);
  git(repo, ['rm', '-q', '--cached', REL]);
  fs.rmSync(path.join(repo, 'lib'), { recursive: true });
  const todo = addTodo(dataDir, repo, { title: 'Integrate leaf', status: 'doing' }).items.at(-1);
  const patchPath = worktreeResultPatchPath(dataDir, todo.id, 'cycle-1');
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, patch);
  const prepared = { cycleId: 'cycle-1', review: { outcome: 'pass', verified: true }, todoId: todo.id, patchPath, baseCommit,
    materialRevision: 'reviewed-material', patchSha256: createHash('sha256').update(patch).digest('hex'),
    changedFiles: [{ path: REL }, { path: 'app_front/x.js' }] };
  mutateWorktreeRegistry((doc) => {
    doc.items[todo.id] = { todoId: todo.id, workspaceFolder: repo, worktreePath: repo, branch: 'leaf', baseCommit,
      creationState: 'ready', executionState: 'execution_closed', integrationState: 'ready', results: {} };
    return { changed: true };
  }, { dataDir });
  assert.equal((await markTodoIntegrationReady({ todoId: todo.id, workspaceFolder: repo, dataDir, cycleId: 'cycle-1', result: prepared })).ok, true);
  return { repo, dataDir, todo };
}

function fakes(f, policy) {
  const calls = [];
  const states = [];
  const integrator = createPostIntegrator({
    getPolicy: () => policy,
    exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true }; },
    runtime: {
      block: () => { calls.push('block'); blockNewStarts({ dataDir: f.dataDir }); states.push(getWorkspaceWatcherRuntimeControl({ dataDir: f.dataDir }).startsEnabled); },
      unblock: () => { calls.push('unblock'); unblockNewStarts({ dataDir: f.dataDir }); },
      activeCycles: () => ({ count: 0 }),
    },
    now: () => 0, sleep: async () => {},
  });
  return { calls, states, integrator };
}

const run = (f, policy, integrator) => automaticallyIntegrateWorkspaceTodo({
  workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id, policy, deps: { gates: () => {}, postIntegrator: integrator },
});

test('commit -> decision -> lock -> build + restart -> boot release', async (t) => {
  const f = await fixture(t);
  const policy = { autoIntegrate: true, autoRestart: true };
  const { calls, states, integrator } = fakes(f, policy);
  assert.equal((await run(f, policy, integrator)).ok, true);
  await integrator.flush();
  assert.deepEqual(calls, ['npm run build:front', 'block', 'bash scripts/task-restart-server.sh']);
  assert.deepEqual(states, [false]);
  // Restart keeps the owned block; the new process releases it at boot.
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir: f.dataDir }).startsEnabled, false);
  assert.deepEqual(releasePostIntegrateBlockIfOwned({ dataDir: f.dataDir }), { released: true });
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir: f.dataDir }).startsEnabled, true);
});

test('autoRestart OFF (default): commit happens, nothing recorded or executed', async (t) => {
  const f = await fixture(t);
  const policy = { autoIntegrate: true };
  const { calls, integrator } = fakes(f, policy);
  assert.equal((await run(f, policy, integrator)).ok, true);
  await integrator.flush();
  assert.deepEqual(calls, []);
  assert.deepEqual(integrator.pendingPaths(), []);
});

test('failed integration does not trigger post-integration', async (t) => {
  const f = await fixture(t);
  const policy = { autoRestart: true };
  const { calls, integrator } = fakes(f, policy);
  assert.equal((await run(f, policy, integrator)).ok, false);
  await integrator.flush();
  assert.deepEqual(calls, []);
});
