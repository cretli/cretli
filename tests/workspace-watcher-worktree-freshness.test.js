import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './helpers/isolated-data-dir.js';
import { createTempRepo, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';
import {
  applyWorktreeFreshness,
  buildWorktreeActiveAgentCheck,
  decideWorktreeFreshness,
  prepareWorkspaceWatcherExecution,
} from '../lib/workspace-watcher-worktree.js';

test('decideWorktreeFreshness: input state -> decision', () => {
  assert.equal(decideWorktreeFreshness({ behind: 50, unintegrated: false }).action, 'keep');
  assert.equal(decideWorktreeFreshness({ behind: 51, unintegrated: false }).action, 'release');
  assert.equal(decideWorktreeFreshness({ behind: 402, unintegrated: true }).action, 'notify_carry');
  assert.equal(decideWorktreeFreshness({ behind: 402, unintegrated: true, active: true }).reason, 'agent_active');
  assert.equal(decideWorktreeFreshness({ behind: 10, unintegrated: false }, { maxBehind: 5 }).action, 'release');
  assert.equal(decideWorktreeFreshness({ behind: 999 }, { maxBehind: 0 }).action, 'keep');
  assert.equal(decideWorktreeFreshness({ behind: 51 }, { maxBehind: 'x' }).action, 'release');
});

test('applyWorktreeFreshness releases a stale clean worktree', async () => {
  const calls = [];
  const out = await applyWorktreeFreshness({ todoId: 't1' }, {
    hasActiveAgent: () => false,
    deps: {
      readFacts: async () => ({ behind: 60, unintegrated: false }),
      release: (p) => { calls.push(p.todoId); return { released: true }; },
    },
  });
  assert.equal(out.action, 'release');
  assert.equal(out.released, true);
  assert.deepEqual(calls, ['t1']);
});

test('applyWorktreeFreshness keeps work and saves a carry patch', async () => {
  let released = false;
  const out = await applyWorktreeFreshness({ todoId: 't2' }, {
    hasActiveAgent: () => false,
    deps: {
      readFacts: async () => ({ behind: 60, unintegrated: true }),
      release: () => { released = true; return { released: true }; },
      saveCarry: async () => '/x/_carry/t2.patch',
    },
  });
  assert.equal(out.action, 'notify_carry');
  assert.equal(out.patchPath, '/x/_carry/t2.patch');
  assert.equal(released, false);
});

test('applyWorktreeFreshness keeps a stale clean worktree while an agent is active', async () => {
  let released = 0;
  const out = await applyWorktreeFreshness({ todoId: 't3' }, {
    hasActiveAgent: () => true,
    deps: {
      readFacts: async () => ({ behind: 400, unintegrated: false }),
      release: () => { released += 1; return { released: true }; },
    },
  });
  assert.equal(out.action, 'keep');
  assert.equal(out.reason, 'agent_active');
  assert.equal(released, 0);
});

test('applyWorktreeFreshness without hasActiveAgent fails closed (keep, never release)', async () => {
  let released = 0;
  const out = await applyWorktreeFreshness({ todoId: 't4' }, {
    deps: {
      readFacts: async () => ({ behind: 400, unintegrated: false }),
      release: () => { released += 1; return { released: true }; },
    },
  });
  assert.equal(out.action, 'keep');
  assert.equal(released, 0);
});

test('buildWorktreeActiveAgentCheck: busy chat, unknown probe, excluded starter', () => {
  const probe = ({ chatId }) => (chatId === 'busy' ? { known: true, busy: true } : { known: true, busy: false });
  assert.equal(buildWorktreeActiveAgentCheck(probe)({ chats: ['idle', 'busy'] }), true);
  assert.equal(buildWorktreeActiveAgentCheck(probe)({ chats: ['idle'] }), false);
  assert.equal(buildWorktreeActiveAgentCheck(probe, 'busy')({ chats: ['busy'] }), false);
  assert.equal(buildWorktreeActiveAgentCheck(null)({ chats: ['x'] }), true);
  assert.equal(buildWorktreeActiveAgentCheck(() => { throw new Error('boom'); })({ chats: ['x'] }), true);
});

test('start path forwards the active-agent check to the freshness release', async (t) => {
  const dataDir = tempDir('cretli-fresh-data-');
  const baseDir = tempDir('cretli-fresh-base-');
  const repo = createTempRepo().dir;
  t.after(() => { for (const d of [dataDir, baseDir, repo]) fs.rmSync(d, { recursive: true, force: true }); });
  const todoId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const base = {
    todoId,
    workspaceFolder: repo,
    todo: { executionMode: 'worktree' },
    policy: { executionMode: 'worktree', worktree: worktreeConfig(baseDir) },
    dataDir,
  };
  await prepareWorkspaceWatcherExecution(base);
  const releases = [];
  const freshness = {
    readFacts: async () => ({ behind: 400, unintegrated: false }),
    release: (p) => { releases.push(p); return { released: false }; },
  };
  // Busy agent: kept, release never called.
  await prepareWorkspaceWatcherExecution({ ...base, hasActiveAgent: () => true, deps: { freshness } });
  assert.equal(releases.length, 0);
  // No check supplied: fail closed, release never called.
  await prepareWorkspaceWatcherExecution({ ...base, deps: { freshness } });
  assert.equal(releases.length, 0);
  // Idle: release is called and receives the very same callback.
  const idle = () => false;
  await prepareWorkspaceWatcherExecution({ ...base, hasActiveAgent: idle, deps: { freshness } });
  assert.equal(releases.length, 1);
  assert.equal(releases[0].hasActiveAgent, idle);
});
