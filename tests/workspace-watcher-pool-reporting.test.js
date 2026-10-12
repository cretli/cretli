import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWorkspaceWatcherAction } from '../lib/workspace-watcher.js';
import { computeWatcherSchedule } from '../lib/workspace-watcher-guardrails.js';
import { normalizeWorkspaceWatcherRow, getWorkspaceWatcherActiveCycles } from '../lib/persist/workspace-watchers-persist.js';
import { partitionWorkspaceWatcherCyclesByPool, workspaceWatcherStartPoolGate } from '../lib/workspace-watcher-pool.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';

const policy = { maxParallel: 4, maxParallelWorktree: 2, maxParallelProject: 2, requirePlanApproval: false };
const worktreeLeaf = { id: 'wt-next', status: 'ready', executionMode: 'worktree' };
const projectLeaf = { id: 'pj-next', status: 'ready', executionMode: 'project' };
const watcher = { mode: 'autopilot', enabled: true, policy };
const snapshot = {
  readyTodoCount: 1, readyLeaves: [worktreeLeaf], activeAgentCount: 1,
  worktreeAgentCount: 1, projectAgentCount: 0, errors: [],
};

test('outside agents and own cycles share a pool cap and still permit the other pool', () => {
  const decision = decideWorkspaceWatcherAction({ watcher, snapshot, activeCycleCounts: { worktree: 1, project: 0 } });
  assert.equal(decision.kind, 'wait_active');
  assert.equal(decision.pool, 'worktree');
  const fallback = decideWorkspaceWatcherAction({
    watcher, snapshot: { ...snapshot, readyTodoCount: 2, readyLeaves: [worktreeLeaf, projectLeaf] },
    activeCycleCounts: { worktree: 1, project: 0 },
  });
  assert.equal(fallback.kind, 'start_cycle');
  assert.equal(fallback.nextTodoId, projectLeaf.id);
});

test('cycle pool is frozen across policy and todo changes, including persistence', () => {
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/my-app', policy: { executionMode: 'project' },
    activeCycles: [{ cycleId: 'cycle', todoIds: ['running'], startedAt: '2026-01-01T00:00:00Z', executionMode: 'worktree' }],
  });
  const cycles = getWorkspaceWatcherActiveCycles(row);
  const todos = new Map([['running', { id: 'running', executionMode: 'project' }], [worktreeLeaf.id, worktreeLeaf]]);
  const pools = partitionWorkspaceWatcherCyclesByPool({ cycles, todos, policy: row.policy });
  assert.equal(pools.worktree.length, 1);
  assert.equal(pools.project.length, 0);
  const gate = workspaceWatcherStartPoolGate({ todoId: worktreeLeaf.id, cycles, todos, policy, snapshot });
  assert.equal(gate.occupied, 2);
  assert.equal(gate.full, true);
});

test('schedule reports both caps, preserves the global blocker and respects candidate fallback', () => {
  const decision = { reason: 'cycle_active', pool: 'worktree' };
  const input = { watcher, now: Date.parse('2026-01-01T00:00:00Z'), activeCycleCount: 2, worktreeRunning: 2, projectRunning: 0, decision };
  const schedule = computeWatcherSchedule(input);
  assert.equal(schedule.worktreeRunning, 2);
  assert.equal(schedule.projectRunning, 0);
  assert.equal(schedule.maxParallelWorktree, 2);
  assert.equal(schedule.maxParallelProject, 2);
  assert.equal(schedule.blockedKind, 'wait_worktree_parallel');
  assert.equal(schedule.due, false);
  assert.equal(computeWatcherSchedule({ ...input, activeCycleCount: 4 }).blockedReason, 'max_parallel');
  assert.equal(computeWatcherSchedule({ ...input, decision: { reason: 'ready' } }).allowed, true);
  assert.equal(computeWatcherSchedule({ ...input, decision: { reason: 'project_parallel' } }).blockedKind, 'wait_project_parallel');
});

test('MCP status text exposes pool caps and occupancy', async () => {
  const handlers = createCretliMcpToolHandlers({ workspaceWatcherShow: async () => ({
    watcher, snapshot, schedule: { running: 2, worktreeRunning: 2, projectRunning: 0, blockedReason: 'worktree_parallel' },
  }) }, { workspaceFolder: '/tmp/my-app', chatId: 'chat' });
  const result = await handlers.watcher_status({});
  assert.match(result.content[0].text, /maxParallelWorktree=2 maxParallelProject=2/);
  assert.match(result.content[0].text, /running=2 worktree=2 project=0 blocked=worktree_parallel/);
});
