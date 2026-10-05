import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { claimWorkspaceTodo, pickNextWorkspaceReadyTodo, releaseStaleWorkspaceTodoClaims } from '../lib/workspace-watcher.js';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { listReadyTodoLeaves } from '../lib/todo-tree.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';

const dataDir = ISOLATED_DATA_DIR;
const cwd = ISOLATED_DATA_DIR;
const childPath = fileURLToPath(new URL('./helpers/todo-claim-child.js', import.meta.url));
function child(id, revision, mode, name) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [childPath, dataDir, cwd, id, revision, mode, name]);
    let out = '', errors = '';
    processChild.stdout.on('data', (chunk) => { out += chunk; });
    processChild.stderr.on('data', (chunk) => { errors += chunk; });
    processChild.on('error', reject);
    processChild.on('exit', (code) => {
      if (code !== 0) reject(new Error(errors));
      else { try { resolve(JSON.parse(out.trim())); } catch (error) { reject(error); } }
    });
  });
}
const claim = (todo, extra = {}) => claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'owner', expectedUpdatedAt: todo.updatedAt, ...extra });
try {
  const todo = addTodo(dataDir, cwd, { title: 'Contended', status: 'ready' }).item;
  const other = addTodo(dataDir, cwd, { title: 'Concurrent edits', status: 'ready' }).item;
  const results = await Promise.all([
    ...Array.from({ length: 4 }, (_, index) => child(todo.id, todo.updatedAt, 'claim', `owner-${index}`)),
    child(other.id, other.updatedAt, 'edit', 'note-A'),
    child(other.id, other.updatedAt, 'edit', 'note-B'),
  ]);
  assert.equal(results.filter((result) => result.claimed).length, 1, 'only one process may claim');
  assert.equal(results.filter((result) => result.reason === 'cas_conflict').length, 3);
  const edited = getTodoById(dataDir, cwd, other.id);
  assert.ok(edited.changelog.some((entry) => entry.text === 'note-A'));
  assert.ok(edited.changelog.some((entry) => entry.text === 'note-B'), 'parallel writes cannot lose unrelated edits');

  const current = getTodoById(dataDir, cwd, todo.id);
  assert.equal(claim(current).reason, 'not_ready', 'fresh CAS cannot steal a doing todo');
  assert.equal(claimWorkspaceTodo({ dataDir, workspaceFolder: cwd, todoId: todo.id, claimedByChatId: 'other-owner' }).reason, 'not_ready', 'omitting CAS cannot overwrite doing');
  updateTodo(dataDir, cwd, todo.id, { status: 'done' });
  const done = getTodoById(dataDir, cwd, todo.id);
  assert.equal(done.claimedByChatId, undefined);
  assert.equal(done.claimLeaseUntil, undefined);
  assert.equal(claim(done).reason, 'not_ready');

  const root = addTodo(dataDir, cwd, { title: 'Sequential', status: 'ready' }).item;
  const first = addTodo(dataDir, cwd, { title: 'First', parentId: root.id, status: 'ready' }).item;
  const later = addTodo(dataDir, cwd, { title: 'Later', parentId: root.id, status: 'ready' }).item;
  assert.equal(claim(later).reason, 'blocked');
  assert.equal(claim(root).reason, 'blocked', 'a container is not a leaf claim');
  updateTodo(dataDir, cwd, root.id, { runMode: 'parallel' });
  assert.equal(claim(getTodoById(dataDir, cwd, later.id)).claimed, true, 'explicit parallel allows the later sibling');

  const leaseTodo = addTodo(dataDir, cwd, { title: 'Lease', status: 'ready' }).item;
  const now = Date.now();
  assert.equal(claim(leaseTodo, { now, ttlMs: 1000 }).item.claimLeaseUntil, new Date(now + 1000).toISOString());
  releaseStaleWorkspaceTodoClaims({ dataDir, workspaceFolder: cwd, now: now + 2000, probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }) });
  assert.equal(getTodoById(dataDir, cwd, leaseTodo.id).status, 'doing', 'TTL alone cannot steal live work');
  releaseStaleWorkspaceTodoClaims({ dataDir, workspaceFolder: cwd, now: now + 2000, probeChatRunLiveness: () => ({ known: false, busy: true, reason: 'adapter_missing' }) });
  assert.equal(getTodoById(dataDir, cwd, leaseTodo.id).status, 'doing', 'unknown liveness keeps the claim');
  releaseStaleWorkspaceTodoClaims({ dataDir, workspaceFolder: cwd, now: now + 2000, probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }) });
  assert.equal(getTodoById(dataDir, cwd, leaseTodo.id).status, 'ready');
  assert.equal(getTodoById(dataDir, cwd, leaseTodo.id).claimLeaseUntil, undefined);

  const reservation = getTodoById(dataDir, cwd, leaseTodo.id);
  claim(reservation, { claimedByChatId: 'starting-owner' });
  upsertWorkspaceWatcher(cwd, { activeCycle: { cycleId: 'start', chatId: 'starting-owner', todoIds: [reservation.id], phase: 'starting', startedAt: new Date(now).toISOString(), startDeadlineAt: new Date(now + 10000).toISOString() } }, { dataDir });
  releaseStaleWorkspaceTodoClaims({ dataDir, workspaceFolder: cwd, now, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }) });
  assert.equal(getTodoById(dataDir, cwd, reservation.id).claimedByChatId, 'starting-owner', 'a reserved start cannot lose its claim before its chat exists');
  const delegatedTodo = addTodo(dataDir, cwd, { title: 'Live child', status: 'ready' }).item;
  claim(delegatedTodo, { claimedByChatId: 'delegating-owner' });
  const delegation = createDelegationRecord({ parentChatId: 'delegating-owner', workspaceFolder: cwd, status: 'running' });
  releaseStaleWorkspaceTodoClaims({ dataDir, workspaceFolder: cwd, now, probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }) });
  assert.equal(getTodoById(dataDir, cwd, delegatedTodo.id).status, 'doing', 'idle orchestrator does not abandon live child work');
  updateDelegationRecord(delegation.id, { status: 'completed' });
  releaseStaleWorkspaceTodoClaims({ dataDir, workspaceFolder: cwd, now, probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }) });
  assert.equal(getTodoById(dataDir, cwd, delegatedTodo.id).status, 'ready');
  releaseStaleWorkspaceTodoClaims({ dataDir, workspaceFolder: cwd, now: now + 20000, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }) });
  assert.equal(getTodoById(dataDir, cwd, reservation.id).status, 'ready', 'a crashed reservation is released after its grace period');

  const candidates = [
    { id: 'old', status: 'ready', siblingIndex: 0, updatedAt: '2020' },
    { id: 'assigned', status: 'ready', siblingIndex: 3, updatedAt: '2025', assignee: { harness: 'sdk' } },
    { id: 'ordered', status: 'ready', siblingIndex: 1, updatedAt: '2022' },
  ];
  assert.equal(pickNextWorkspaceReadyTodo({ items: candidates, allowedHarnesses: ['sdk'] }).id, 'assigned');
  assert.equal(pickNextWorkspaceReadyTodo({ items: candidates, allowedHarnesses: ['claude'] }).id, 'old');
  assert.equal(pickNextWorkspaceReadyTodo({ items: candidates, failures: { assigned: 3, old: 3 } }).id, 'ordered');
  updateTodo(dataDir, cwd, first.id, { blockedReason: 'Failure ceiling reached', appendChangelog: { kind: 'note', text: 'Blocked after failures' } });
  assert.deepEqual(listReadyTodoLeaves([getTodoById(dataDir, cwd, first.id)]), []);
  updateTodo(dataDir, cwd, first.id, { status: 'ready' });
  assert.equal(getTodoById(dataDir, cwd, first.id).blockedReason, undefined, 'manual retry clears the blocker');
  console.log('todo claims: all passed');
} finally {
  removeIsolatedDataDir();
}
