import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { addTodo } from '../lib/persist/todos-legacy-adapter.js';
import {
  acquireWorkspaceWatcherLease,
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  adoptRunningLeafDelegations,
  buildWorkspaceWatcherCyclePrompt,
  reportWorkspaceWatcherCycle,
} from '../lib/workspace-watcher-cycle.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

after(() => removeIsolatedDataDir());

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-orphan-child-'));
const T0 = Date.parse('2026-10-24T13:00:00.000Z');
const OLD_CHAT = 'old-cycle-chat';
const NEW_CHAT = 'new-cycle-chat';

/** @param {string} name */
function setup(name) {
  const dataDir = path.join(tmpRoot, name);
  const cwd = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const todo = addTodo(dataDir, cwd, { title: 'leaf', status: 'doing' }).item;
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot', policy: { requirePlanApproval: false } }, { dataDir });
  return { dataDir, cwd, todo };
}

/** @param {Record<string, any>} patch */
function child(patch) {
  return { id: 'deleg-1', parentChatId: OLD_CHAT, status: 'running', assignment: 'implement', ...patch };
}

test('a blocked report is rejected while the cycle\'s own implement child is running', async () => {
  const { dataDir, cwd, todo } = setup('reject');
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: {
      cycleId: 'c1', todoIds: [todo.id], startedAt: new Date(T0).toISOString(), chatId: OLD_CHAT, runId: 'r', phase: 'running',
    },
    lease: acquireWorkspaceWatcherLease(row, { token: 't', ttlMs: 60_000, now: T0 }).lease,
  }), { dataDir });
  const result = await reportWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, sourceChatId: OLD_CHAT, outcome: 'blocked', todoIds: [todo.id], cycleId: 'c1',
    reasonCode: 'env_infra', message: 'bounded waits exhausted',
    deps: { loadDelegations: () => [child({})] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'child_running');
  assert.match(result.message, /delegation_wait/);
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, 'the cycle stays open');

  // A review child (not implement/fix) or a terminal child does not block the report.
  const closed = await reportWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0, sourceChatId: OLD_CHAT, outcome: 'blocked', todoIds: [todo.id], cycleId: 'c1',
    reasonCode: 'needs_human', message: 'waiting',
    deps: { loadDelegations: () => [child({ status: 'completed' }), child({ id: 'r1', assignment: 'review' })] },
  });
  assert.equal(closed.ok, true);
});

test('a new cycle adopts the running implement child of the same leaf', () => {
  const { dataDir, cwd, todo } = setup('adopt');
  /** @type {any[]} */
  const reassigned = [];
  const rows = [
    child({ sourceText: `cretli-ref todo=${todo.id}`, workspaceFolder: cwd }),
    child({ id: 'other-leaf', sourceText: 'cretli-ref todo=ffffffff-ffff-4fff-8fff-ffffffffffff', workspaceFolder: cwd }),
    child({ id: 'done', status: 'completed', leafId: todo.id }),
    child({ id: 'rev', assignment: 'review', leafId: todo.id }),
  ];
  const adopted = adoptRunningLeafDelegations({
    todoId: todo.id, chatId: NEW_CHAT, workspaceFolder: cwd, dataDir,
    deps: { loadDelegations: () => rows, reassignDelegationController: (ids, to) => reassigned.push({ ids, to }) },
  });
  assert.deepEqual(adopted.map((row) => row.id), ['deleg-1']);
  assert.deepEqual(reassigned, [{ ids: ['deleg-1'], to: NEW_CHAT }]);

  const prompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: cwd,
    watcher: { policy: {} },
    decision: { kind: 'start' },
    todo: { id: todo.id, title: 'leaf' },
    adoptedDelegations: adopted,
  });
  assert.match(prompt, /ADOPTED/);
  assert.ok(prompt.includes('deleg-1'));
  assert.doesNotMatch(prompt, /then `delegation_start` the implementation/);
  assert.match(prompt, /loop `delegation_wait` until your implement\/fix child ends/);

  const plain = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: cwd, watcher: { policy: {} }, decision: { kind: 'start' }, todo: { id: todo.id, title: 'leaf' },
  });
  assert.doesNotMatch(plain, /ADOPTED/);
});
