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
import { addTodo } from '../lib/persist/todos-legacy-adapter.js';
import { mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { worktreeResultPatchPath } from '../lib/worktree/worktree-result.ts';
import { getWorkspaceWatcherRuntimeControl } from '../lib/workspace-watcher-runtime-control.js';
import { blockNewStarts, releasePostIntegrateBlockIfOwned, unblockNewStarts } from '../lib/workspace-watcher-runtime.js';

test('unconfirmed post-integration restart releases the owned gate', async (t) => {
  const dataDir = tempDir('cretli-post-unconfirmed-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = 0;
  const calls = [];
  const decisions = [];
  const notifications = [];
  const integrator = createPostIntegrator({
    getPolicy: () => ({ autoRestart: true }),
    exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true }; },
    supervisorChildPid: () => 100,
    notify: (result) => notifications.push(result.reason),
    runtime: { block: () => blockNewStarts({ dataDir }), unblock: () => unblockNewStarts({ dataDir }), activeCycles: () => ({ count: 0 }), recordDecision: (decision) => decisions.push(decision) },
    now: () => time, sleep: async (ms) => { time += ms; }, pollMs: 10, restartConfirmMs: 20,
  });
  integrator.record(['lib/change.js']);
  const result = await integrator.flush();
  assert.equal(result.reason, 'restart_unconfirmed');
  assert.deepEqual(calls, ['bash scripts/task-restart-server.sh']);
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir }).startsEnabled, true);
  assert.deepEqual(decisions, [{ kind: 'restart_unconfirmed', reason: 'restart_unconfirmed' }]);
  assert.deepEqual(notifications, ['restart_unconfirmed']);
});

test('front build completes before restart request even when process never returns', async (t) => {
  const dataDir = tempDir('cretli-post-before-restart-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  let time = 0;
  const integrator = createPostIntegrator({
    getPolicy: () => ({ autoRestart: true }),
    exec: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'bash') throw new Error('simulated process exit before completion');
      return { ok: true };
    },
    supervisorChildPid: () => 100,
    runtime: { block: () => blockNewStarts({ dataDir }), unblock: () => unblockNewStarts({ dataDir }), activeCycles: () => ({ count: 0 }) },
    now: () => time, sleep: async (ms) => { time += ms; }, pollMs: 10, restartConfirmMs: 20,
  });
  integrator.record(['lib/change.js', 'app_front/change.js']);
  const result = await integrator.flush();
  assert.equal(result.reason, 'restart_unconfirmed');
  assert.deepEqual(calls, ['npm run build:front', 'bash scripts/task-restart-server.sh']);
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir }).startsEnabled, true);
});

test('front build failure skips restart, records failure, and releases the gate', async (t) => {
  const dataDir = tempDir('cretli-post-build-failure-');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const decisions = [];
  const integrator = createPostIntegrator({
    getPolicy: () => ({ autoRestart: true }),
    exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: false }; },
    supervisorChildPid: () => 100,
    runtime: {
      block: () => blockNewStarts({ dataDir }),
      unblock: () => unblockNewStarts({ dataDir }),
      activeCycles: () => ({ count: 0 }),
      recordDecision: (decision) => decisions.push(decision),
    },
  });
  integrator.record(['lib/change.js', 'app_front/change.js']);
  const result = await integrator.flush();
  assert.equal(result.reason, 'front_build_failed');
  assert.deepEqual(calls, ['npm run build:front']);
  assert.deepEqual(decisions, [{ kind: 'front_build_failed', reason: 'front_build_failed' }]);
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir }).startsEnabled, true);
});

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
  let time = 0;
  const integrator = createPostIntegrator({
    getPolicy: () => policy,
    exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true }; },
    supervisorChildPid: () => 101,
    runtime: {
      block: () => { calls.push('block'); blockNewStarts({ dataDir: f.dataDir }); states.push(getWorkspaceWatcherRuntimeControl({ dataDir: f.dataDir }).startsEnabled); },
      unblock: () => { calls.push('unblock'); unblockNewStarts({ dataDir: f.dataDir }); },
      activeCycles: () => ({ count: 0 }),
    },
    now: () => time, sleep: async (ms) => { time += ms; }, pollMs: 10, restartConfirmMs: 20,
  });
  return { calls, states, integrator };
}

const run = (f, policy, integrator) => automaticallyIntegrateWorkspaceTodo({
  workspaceFolder: f.repo, dataDir: f.dataDir, todoId: f.todo.id, policy, deps: { gates: () => {}, postIntegrator: integrator },
});

test('commit -> decision -> lock -> front build before restart request', async (t) => {
  const f = await fixture(t);
  const policy = { autoIntegrate: true, autoRestart: true };
  const { calls, states, integrator } = fakes(f, policy);
  assert.equal((await run(f, policy, integrator)).ok, true);
  await integrator.flush();
  assert.deepEqual(calls, ['block', 'npm run build:front', 'bash scripts/task-restart-server.sh', 'unblock']);
  assert.deepEqual(states, [false]);
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

test('unconfirmed restart unblocks starts after front build and restart request', async (t) => {
  const f = await fixture(t);
  const policy = { autoIntegrate: true, autoRestart: true };
  let time = 0;
  const calls = [];
  const integrator = createPostIntegrator({
    getPolicy: () => policy,
    exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true }; },
    supervisorChildPid: () => 101,
    runtime: { block: () => blockNewStarts({ dataDir: f.dataDir }), unblock: () => unblockNewStarts({ dataDir: f.dataDir }), activeCycles: () => ({ count: 0 }) },
    now: () => time, sleep: async (ms) => { time += ms; }, pollMs: 10, restartConfirmMs: 20,
  });
  integrator.record(['lib/new.js', 'app_front/new.js']);
  const result = await integrator.flush();
  assert.equal(result.reason, 'restart_unconfirmed');
  assert.deepEqual(calls, ['npm run build:front', 'bash scripts/task-restart-server.sh']);
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir: f.dataDir }).startsEnabled, true);
});

test('stale owned post-integrate block releases only when idle', async (t) => {
  const f = await fixture(t);
  blockNewStarts({ dataDir: f.dataDir });
  const { releaseStalePostIntegrateBlock } = await import('../lib/workspace-watcher-runtime.js');
  const marker = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'workspace-watcher-runtime-owner.json'), 'utf8'));
  const now = Date.parse(marker.since) + 1000;
  assert.equal(releaseStalePostIntegrateBlock({ dataDir: f.dataDir, now, maxAgeMs: 500, activeCycles: { count: 1 } }).released, false);
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir: f.dataDir }).startsEnabled, false);
  assert.equal(releaseStalePostIntegrateBlock({ dataDir: f.dataDir, now, maxAgeMs: 500, activeCycles: { count: 0 } }).released, true);
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir: f.dataDir }).startsEnabled, true);
});
