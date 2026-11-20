/**
 * Ownerless `doing` leaves return to `ready` after an idle threshold.
 *
 * Unit table (input state -> classification) plus an end-to-end sweep through
 * the existing recover path (changelog note + decision record).
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import {
  classifyWorkspaceDoingTodos,
  resolveOrphanDoingMinMs,
  WORKSPACE_ORPHAN_DOING_DEFAULT_MS,
} from '../lib/workspace-watcher-recovery.js';
import { releaseStaleWorkspaceTodoClaims } from '../lib/workspace-watcher.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const unknownProbe = () => ({ known: false, busy: false, reason: 'state_missing' });

function classify(item, extra = {}) {
  const [row] = classifyWorkspaceDoingTodos({
    items: [{ status: 'doing', id: 't1', ...item }],
    delegations: extra.delegations || [],
    cycles: extra.cycles || [],
    probe: unknownProbe,
    isCycleChatAlive: () => false,
    now: NOW,
    hasLiveWorktree: extra.hasLiveWorktree,
    reviewPolicy: extra.policy,
  });
  return row;
}

try {
  assert.equal(resolveOrphanDoingMinMs({}), WORKSPACE_ORPHAN_DOING_DEFAULT_MS);
  assert.equal(resolveOrphanDoingMinMs({ orphanDoingMinMs: 0 }), 0);
  assert.equal(resolveOrphanDoingMinMs({ orphanDoingMinMs: 5000 }), 5000);

  const old = { updatedAt: iso(NOW - 31 * MIN) };
  const fresh = { updatedAt: iso(NOW - 5 * MIN) };

  let row = classify(old);
  assert.equal(row.state, 'recoverable');
  assert.equal(row.reason, 'orphan_doing_idle');

  assert.equal(classify(fresh).state, 'unknown', 'idle below threshold stays unknown');
  assert.equal(classify(old, { policy: { orphanDoingMinMs: 0 } }).state, 'unknown', '0 disables');
  assert.equal(classify(old, { policy: { orphanDoingMinMs: 60 * MIN } }).state, 'unknown', 'custom threshold');
  assert.equal(classify({ ...old, claimedByChatId: 'c1' }).state, 'unknown', 'claimed leaf is not an orphan');
  assert.notEqual(classify({ ...old, chatId: 'c1' }).reason, 'orphan_doing_idle', 'owner chat is not an orphan');
  assert.notEqual(classify({ ...old, orchestratorChatId: 'c1' }).reason, 'orphan_doing_idle');
  assert.equal(classify({ ...old, blockedReason: 'x' }).state, 'user_action');
  assert.equal(classify(old, { hasLiveWorktree: () => true }).state, 'user_action', 'worktree blocks');
  assert.equal(
    classify(old, { cycles: [{ chatId: 'cx', todoIds: ['t1'], phase: 'starting' }] }).state,
    'unknown',
    'a cycle listing the leaf blocks (race with a starting cycle)',
  );
  assert.notEqual(
    classify(old, { delegations: [{ id: 'd1', leafId: 't1', status: 'running', controllerChatId: 'p', startedAt: iso(NOW - MIN) }] }).reason,
    'orphan_doing_idle',
    'a delegation on the leaf blocks',
  );

  // End to end: sweep releases through the recover path.
  const dataDir = ISOLATED_DATA_DIR;
  const cwd = path.join(ISOLATED_DATA_DIR, 'orphan-doing');
  fs.mkdirSync(cwd, { recursive: true });
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot', enabled: true }, { dataDir });
  const todo = addTodo(dataDir, cwd, { title: 'orphan', status: 'ready' }).item;
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', expectedUpdatedAt: todo.updatedAt });
  const doing = getTodoById(dataDir, cwd, todo.id);
  assert.equal(doing.status, 'doing');

  const early = await releaseStaleWorkspaceTodoClaims({
    workspaceFolder: cwd, dataDir, now: Date.parse(doing.updatedAt) + 5 * MIN, probeChatRunLiveness: unknownProbe,
  });
  assert.deepEqual(early.released, []);

  const swept = await releaseStaleWorkspaceTodoClaims({
    workspaceFolder: cwd, dataDir, now: Date.parse(doing.updatedAt) + 31 * MIN, probeChatRunLiveness: unknownProbe,
  });
  assert.deepEqual(swept.released, [todo.id]);
  const after = getTodoById(dataDir, cwd, todo.id);
  assert.equal(after.status, 'ready');
  assert.match(JSON.stringify(after.changelog), /released abandoned work[^"]*orphan_doing_idle/);
  const decisions = getWorkspaceWatcher(cwd, { dataDir }).decisions;
  assert.ok(decisions.some((d) => d.kind === 'orphan_doing_released' && d.nextTodoId === todo.id));
  console.log('workspace-watcher-orphan-doing.test.js: ok');
} finally {
  removeIsolatedDataDir();
}
