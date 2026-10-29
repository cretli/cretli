/**
 * Workspace Watcher unknown-liveness handling.
 *
 * - A `doing` todo parked in `user_action` (open worktree) whose claiming chat
 *   has no run state after a restart is idle, not an agent of unknown liveness.
 * - Unknown liveness occupies at most one slot: with spare capacity the Watcher
 *   keeps starting work.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { decideWorkspaceWatcherAction, snapshotWorkspaceWatcher } from '../lib/workspace-watcher.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-unknown-'));
const T0 = Date.parse('2026-10-23T01:00:00.000Z');
const goneProbe = () => ({ known: false, busy: false, reason: 'state_missing' });

let failed = 0;
function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

function setup(name, { worktree = true } = {}) {
  const dataDir = path.join(tmpRoot, `data-${name}`);
  const cwd = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { maxParallel: 3, cooldownMs: 0, maxCyclesPerDay: 50, requirePlanApproval: false },
  }, { dataDir });
  const chatId = `chat-${name}`;
  const held = addTodo(dataDir, cwd, { title: 'held', status: 'ready' }).item;
  updateTodo(dataDir, cwd, held.id, {
    status: 'doing',
    claimedByChatId: chatId,
    claimedAt: new Date(T0 - 3600_000).toISOString(),
    claimLeaseUntil: new Date(T0 - 1000).toISOString(),
  });
  addTodo(dataDir, cwd, { title: 'next', status: 'ready' });
  if (worktree) {
    mutateWorktreeRegistry((doc) => {
      doc.items[held.id] = {
        todoId: held.id,
        workspaceFolder: cwd,
        worktreePath: path.join(cwd, '.wt', held.id),
        branch: `cretli/todo/${held.id}`,
        baseCommit: 'abc123',
        creationState: 'ready',
        executionState: 'active',
        cycles: [],
      };
      return doc;
    }, { dataDir });
  }
  return { dataDir, cwd, chatId, held };
}

const snap = async (ctx, delegations = []) => await snapshotWorkspaceWatcher({
  workspaceFolder: ctx.cwd,
  dataDir: ctx.dataDir,
  now: T0,
  deps: {
    listWorkspaceChatIds: () => [ctx.chatId],
    probeChatRunLiveness: goneProbe,
    loadDelegations: () => delegations,
  },
});

runCase('user_action (worktree_open) + state_missing is idle and a cycle can start', async () => {
  const ctx = setup('ua');
  const snapshot = await snap(ctx);
  assert.equal(snapshot.doingStates.find((r) => r.todoId === ctx.held.id)?.state, 'user_action');
  assert.equal(snapshot.unknownAgentCount, 0);
  assert.deepEqual(snapshot.unknownChats, []);
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy: { maxParallel: 1, requirePlanApproval: false, cooldownMs: 0 } },
    snapshot,
    now: T0,
  });
  assert.notEqual(decision.reason, 'unknown_liveness');
  assert.equal(decision.kind, 'start_cycle');
});

runCase('without a user_action state the same claimed chat stays unknown (guard unchanged)', async () => {
  const ctx = setup('plain', { worktree: false });
  const snapshot = await snap(ctx);
  assert.equal(snapshot.unknownAgentCount, 1);
  assert.deepEqual(snapshot.unknownChats, [{ chatId: ctx.chatId, reason: 'state_missing' }]);
});

runCase('a user_action chat that holds a live delegation slot stays unknown', async () => {
  const ctx = setup('deleg');
  const snapshot = await snap(ctx, [{ id: 'd1', status: 'running', parentChatId: ctx.chatId, childChatId: 'child-x', workspaceFolder: ctx.cwd }]);
  assert.ok(snapshot.unknownChatIds.includes(ctx.chatId));
});

runCase('one unknown occupies a single slot: spare capacity still starts work', () => {
  const snapshot = { readyTodoCount: 1, activeAgentCount: 0, unknownAgentCount: 3, readyLeaves: [{ id: 'ready', status: 'ready' }], items: [{ id: 'ready', status: 'ready' }] };
  const watcher = { mode: 'autopilot', enabled: true, policy: { maxParallel: 2, requirePlanApproval: false, cooldownMs: 0 } };
  const open = decideWorkspaceWatcherAction({ watcher, snapshot, now: T0 });
  assert.notEqual(open.reason, 'unknown_liveness');
  assert.equal(open.kind, 'start_cycle');
  // One real agent plus the unknown slot fills maxParallel 2: held back.
  const full = decideWorkspaceWatcherAction({ watcher, snapshot: { ...snapshot, activeAgentCount: 1 }, now: T0 });
  assert.equal(full.kind, 'wait_active');
  assert.equal(full.reason, 'unknown_liveness');
  // maxParallel 1 keeps the safety behaviour.
  const single = decideWorkspaceWatcherAction({ watcher: { ...watcher, policy: { ...watcher.policy, maxParallel: 1 } }, snapshot, now: T0 });
  assert.equal(single.reason, 'unknown_liveness');
});

if (failed) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
