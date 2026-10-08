import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import fs from 'node:fs';
import path from 'node:path';
import { claimWorkspaceTodo, pickNextWorkspaceReadyTodo, releaseStaleWorkspaceTodoClaims } from '../lib/workspace-watcher.js';
import { releaseWorkspaceWatcherCycleTodoClaim } from '../lib/workspace-watcher-cycle-close.js';
import { getWorkspaceWatcher, getWorkspaceWatchersDataPath, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
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
  releaseStaleWorkspaceTodoClaims({
    dataDir,
    workspaceFolder: cwd,
    now: now + 2000,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    getChat: () => ({ archived: true }),
  });
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
  releaseStaleWorkspaceTodoClaims({
    dataDir,
    workspaceFolder: cwd,
    now,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    getChat: () => ({ archived: true }),
  });
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

  // --- Recovery of `doing` rows: classification, fencing, and what never auto-recovers.
  const ws = path.join(ISOLATED_DATA_DIR, 'recovery-ws');
  fs.mkdirSync(ws, { recursive: true });
  upsertWorkspaceWatcher(ws, { mode: 'autopilot' }, { dataDir });
  const idle = () => ({ known: true, busy: false, reason: 'idle' });
  const busy = () => ({ known: true, busy: true, reason: 'busy' });
  const archivedChat = () => ({ archived: true });
  const openChat = () => ({ archived: false });
  const reconcile = (extra = {}) => releaseStaleWorkspaceTodoClaims({ dataDir, workspaceFolder: ws, probeChatRunLiveness: idle, getChat: archivedChat, ...extra });
  const stateOf = (result, id) => result.states.find((row) => row.todoId === id);
  const doing = (title, extra = {}) => {
    const item = addTodo(dataDir, ws, { title, status: 'ready', ...extra }).item;
    updateTodo(dataDir, ws, item.id, { status: 'doing' });
    return getTodoById(dataDir, ws, item.id);
  };

  // Legacy/manual `doing` with no execution identity: never released, whatever the probe says.
  const legacy = doing('Legacy manual doing');
  let pass = reconcile();
  assert.equal(stateOf(pass, legacy.id).state, 'unknown');
  assert.equal(stateOf(pass, legacy.id).reason, 'missing_identity');
  assert.equal(stateOf(pass, legacy.id).source, 'none');
  assert.equal(getTodoById(dataDir, ws, legacy.id).status, 'doing', 'missing identity never auto-recovers');

  // Chat/API start without a claim, executor known through orchestratorChatId.
  const unclaimed = doing('Unclaimed with executor', { orchestratorChatId: 'exec-chat' });
  pass = reconcile({ probeChatRunLiveness: busy });
  assert.equal(stateOf(pass, unclaimed.id).state, 'active', 'a busy executor keeps the work');
  assert.equal(stateOf(pass, unclaimed.id).source, 'orchestrator_chat');
  for (const reason of ['state_missing', 'adapter_missing', 'adapter_error', 'run_mismatch', 'probe_failed']) {
    pass = reconcile({ probeChatRunLiveness: () => ({ known: false, busy: false, reason }) });
    assert.equal(stateOf(pass, unclaimed.id).state, 'unknown', `${reason} stays unknown`);
    assert.equal(stateOf(pass, unclaimed.id).reason, reason);
    assert.equal(getTodoById(dataDir, ws, unclaimed.id).status, 'doing', `${reason} never auto-recovers`);
  }
  pass = reconcile({ getChat: openChat });
  assert.equal(stateOf(pass, unclaimed.id).state, 'user_action', 'an open idle chat may be waiting for its human');
  assert.equal(stateOf(pass, unclaimed.id).reason, 'idle_open_chat');
  assert.equal(getTodoById(dataDir, ws, unclaimed.id).status, 'doing');

  // A blocked delegation report needs a human (the reported incident shape).
  const blockedJob = createDelegationRecord({ parentChatId: 'exec-chat', workspaceFolder: ws, status: 'running' });
  pass = reconcile();
  assert.equal(stateOf(pass, unclaimed.id).state, 'active', 'an occupied delegation slot keeps the work');
  assert.equal(stateOf(pass, unclaimed.id).delegationId, blockedJob.id);
  updateDelegationRecord(blockedJob.id, { status: 'completed', taskOutcome: 'blocked', runStoppingAt: new Date().toISOString() });
  pass = reconcile();
  assert.equal(stateOf(pass, unclaimed.id).state, 'active', 'runStopping still occupies the slot');
  assert.equal(stateOf(pass, unclaimed.id).reason, 'run_stopping');
  updateDelegationRecord(blockedJob.id, { runStoppingAt: '' });
  pass = reconcile();
  assert.equal(stateOf(pass, unclaimed.id).state, 'user_action');
  assert.equal(stateOf(pass, unclaimed.id).reason, 'delegation_blocked');
  assert.equal(getTodoById(dataDir, ws, unclaimed.id).status, 'doing', 'a blocked report is never resumed automatically');

  // Aggregating parent: status follows its children and is never released.
  const parentTodo = addTodo(dataDir, ws, { title: 'Parent', status: 'ready', orchestratorChatId: 'gone-chat' }).item;
  const childTodo = addTodo(dataDir, ws, { title: 'Child', parentId: parentTodo.id, status: 'ready' }).item;
  updateTodo(dataDir, ws, childTodo.id, { status: 'doing' });
  assert.equal(getTodoById(dataDir, ws, parentTodo.id).status, 'doing', 'parent status is derived from the child');
  pass = reconcile({ probeChatRunLiveness: (input) => (input.chatId === 'gone-chat' ? { known: false, busy: false, reason: 'chat_missing' } : idle()) });
  assert.equal(stateOf(pass, parentTodo.id).state, 'dependency');
  assert.equal(stateOf(pass, parentTodo.id).reason, 'aggregates_children');
  assert.equal(stateOf(pass, childTodo.id).source, 'ancestor_orchestrator_chat');
  assert.equal(stateOf(pass, childTodo.id).state, 'recoverable', 'a deleted executor chat is confirmed gone');
  assert.deepEqual(pass.released, [childTodo.id], 'released in the same reconcile pass');
  assert.equal(getTodoById(dataDir, ws, childTodo.id).status, 'ready');
  assert.ok(getTodoById(dataDir, ws, childTodo.id).changelog.some((entry) => /released abandoned work/.test(entry.text)));
  assert.notEqual(getTodoById(dataDir, ws, parentTodo.id).status, 'done', 'a recovered child never completes its parent');

  // observe/off detect a recoverable row but do not release an unclaimed one.
  const observed = doing('Observed only', { orchestratorChatId: 'closed-chat' });
  upsertWorkspaceWatcher(ws, { mode: 'observe' }, { dataDir });
  pass = reconcile();
  assert.equal(stateOf(pass, observed.id).state, 'recoverable');
  assert.deepEqual(pass.skipped.filter((row) => row.todoId === observed.id), [{ todoId: observed.id, reason: 'watcher_not_autopilot' }]);
  assert.equal(getTodoById(dataDir, ws, observed.id).status, 'doing');
  upsertWorkspaceWatcher(ws, { mode: 'autopilot', paused: true }, { dataDir });
  assert.equal(reconcile().released.includes(observed.id), false, 'a paused autopilot does not resume unclaimed work');
  upsertWorkspaceWatcher(ws, { mode: 'autopilot', paused: false }, { dataDir });

  // Race between the probe and the write: a slot that appears before the locked
  // re-validation keeps the work (fencing), and nothing is released.
  let delegationReads = 0;
  pass = reconcile({
    loadDelegations: () => {
      delegationReads += 1;
      return delegationReads === 1 ? [] : [{ id: 'late-job', parentChatId: 'closed-chat', status: 'running' }];
    },
  });
  assert.deepEqual(pass.skipped.filter((row) => row.todoId === observed.id), [{ todoId: observed.id, reason: 'already-active' }]);
  assert.equal(getTodoById(dataDir, ws, observed.id).status, 'doing', 'a run that started after the probe is never duplicated');
  pass = reconcile();
  assert.ok(pass.released.includes(observed.id), 'confirmed idle + archived chat is released');

  // Durable execution identity + idempotent claim replay (lost response after an accepted claim).
  const fenced = addTodo(dataDir, ws, { title: 'Fenced', status: 'ready' }).item;
  const firstClaim = claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: fenced.id, claimedByChatId: 'cycle-chat', expectedUpdatedAt: fenced.updatedAt, cycleId: 'cycle-1' });
  assert.equal(firstClaim.claimed, true);
  const identity = firstClaim.item.execution;
  assert.ok(identity.attemptId, 'fencing id is persisted');
  assert.equal(identity.key, `${fenced.id}:cycle-1`);
  assert.equal(identity.todoRevision, fenced.updatedAt);
  assert.equal(identity.source, 'watcher_claim');
  assert.equal(identity.chatId, 'cycle-chat');
  assert.equal(identity.cycleId, 'cycle-1');
  assert.equal(identity.phase, 'claimed');
  const replay = claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: fenced.id, claimedByChatId: 'cycle-chat', expectedUpdatedAt: fenced.updatedAt, cycleId: 'cycle-1' });
  assert.equal(replay.claimed, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.item.execution.attemptId, identity.attemptId, 'a replayed claim never creates a second attempt');
  assert.equal(replay.item.updatedAt, firstClaim.item.updatedAt, 'a replay writes nothing');
  assert.equal(claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: fenced.id, claimedByChatId: 'cycle-chat', cycleId: 'cycle-2' }).reason, 'not_ready', 'another cycle cannot take a claimed todo');
  assert.equal(claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: fenced.id, claimedByChatId: 'other-chat', cycleId: 'cycle-1' }).reason, 'not_ready');

  // Expired lease + unknown liveness keeps the claim; confirmed idle releases it and keeps the attempt.
  pass = reconcile({ now: Date.now() + 86_400_000, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'state_missing' }) });
  assert.equal(stateOf(pass, fenced.id).state, 'unknown');
  assert.equal(getTodoById(dataDir, ws, fenced.id).claimedByChatId, 'cycle-chat', 'an expired lease is not proof the run ended');
  pass = reconcile({ getChat: archivedChat });
  assert.ok(pass.released.includes(fenced.id), 'a watcher claim with a confirmed idle archived owner is released');
  const afterRelease = getTodoById(dataDir, ws, fenced.id);
  assert.equal(afterRelease.status, 'ready');
  assert.equal(afterRelease.execution.phase, 'released');
  assert.equal(afterRelease.execution.releaseReason, 'idle_archived_chat');

  // Claimed rows honor the same human/blocker gates as unclaimed work.
  const claimedHuman = addTodo(dataDir, ws, { title: 'Claimed blocked', status: 'ready' }).item;
  claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: claimedHuman.id, claimedByChatId: 'block-chat', expectedUpdatedAt: claimedHuman.updatedAt, cycleId: 'block-cycle' });
  updateTodo(dataDir, ws, claimedHuman.id, { blockedReason: 'Needs operator' });
  pass = reconcile({ getChat: archivedChat });
  assert.equal(stateOf(pass, claimedHuman.id).state, 'user_action');
  assert.equal(stateOf(pass, claimedHuman.id).reason, 'blocked_reason');
  assert.equal(getTodoById(dataDir, ws, claimedHuman.id).status, 'doing');
  assert.equal(getTodoById(dataDir, ws, claimedHuman.id).blockedReason, 'Needs operator');
  const claimedDeleg = addTodo(dataDir, ws, { title: 'Claimed deleg blocked', status: 'ready' }).item;
  claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: claimedDeleg.id, claimedByChatId: 'deleg-chat', expectedUpdatedAt: claimedDeleg.updatedAt, cycleId: 'deleg-cycle' });
  const delegBlock = createDelegationRecord({ parentChatId: 'deleg-chat', workspaceFolder: ws, status: 'running', leafId: claimedDeleg.id });
  updateDelegationRecord(delegBlock.id, { status: 'completed', taskOutcome: 'blocked' });
  pass = reconcile({ getChat: archivedChat });
  assert.equal(stateOf(pass, claimedDeleg.id).state, 'user_action');
  assert.equal(stateOf(pass, claimedDeleg.id).reason, 'delegation_blocked');
  assert.equal(getTodoById(dataDir, ws, claimedDeleg.id).status, 'doing');

  // A late release from the old attempt cannot free the newer attempt.
  const secondClaim = claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: fenced.id, claimedByChatId: 'cycle-chat', expectedUpdatedAt: afterRelease.updatedAt, cycleId: 'cycle-2' });
  assert.equal(secondClaim.claimed, true);
  assert.notEqual(secondClaim.item.execution.attemptId, identity.attemptId);
  assert.equal(secondClaim.item.execution.previous.attemptId, identity.attemptId, 'the previous attempt stays visible to the new cycle');
  assert.equal(secondClaim.item.execution.previous.phase, 'released');
  releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder: ws, todoId: fenced.id, chatId: 'cycle-chat', cycleId: 'cycle-1', dataDir });
  assert.equal(getTodoById(dataDir, ws, fenced.id).status, 'doing', 'a stale attempt cannot reset the newer one');
  assert.equal(getTodoById(dataDir, ws, fenced.id).execution.attemptId, secondClaim.item.execution.attemptId);
  releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder: ws, todoId: fenced.id, chatId: 'other-chat', cycleId: 'cycle-2', dataDir });
  assert.equal(getTodoById(dataDir, ws, fenced.id).claimedByChatId, 'cycle-chat', 'a foreign chat cannot release the claim');
  releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder: ws, todoId: fenced.id, chatId: 'cycle-chat', cycleId: 'cycle-2', dataDir });
  assert.equal(getTodoById(dataDir, ws, fenced.id).status, 'ready', 'the current attempt releases its own claim');

  const bareCycle = addTodo(dataDir, ws, { title: 'Bare cycle claim', status: 'ready' }).item;
  const bareFirst = claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: bareCycle.id, claimedByChatId: 'bare-chat', expectedUpdatedAt: bareCycle.updatedAt, cycleId: 'bare-old' });
  assert.equal(bareFirst.claimed, true);
  releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder: ws, todoId: bareCycle.id, chatId: 'bare-chat', cycleId: 'bare-old', dataDir });
  const bareReady = getTodoById(dataDir, ws, bareCycle.id);
  const bareSecond = claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: bareCycle.id, claimedByChatId: 'bare-chat', expectedUpdatedAt: bareReady.updatedAt });
  assert.equal(bareSecond.claimed, true);
  assert.equal(bareSecond.item.execution.cycleId || '', '');
  releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder: ws, todoId: bareCycle.id, chatId: 'bare-chat', cycleId: 'bare-old', dataDir });
  assert.equal(getTodoById(dataDir, ws, bareCycle.id).status, 'doing', 'a stale cycleId cannot release a newer claim without cycleId');
  releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder: ws, todoId: bareCycle.id, chatId: 'bare-chat', dataDir });
  assert.equal(getTodoById(dataDir, ws, bareCycle.id).status, 'doing', 'a release with no attempt or cycle fence cannot clear a fenced attempt');

  // A recovered todo is never completed by recovery itself.
  assert.equal([legacy, unclaimed, observed, fenced].some((row) => getTodoById(dataDir, ws, row.id).status === 'done'), false);

  // Corrupt watcher store: unknown state, nothing released, bytes untouched.
  const corruptDir = path.join(ISOLATED_DATA_DIR, 'corrupt-store');
  fs.mkdirSync(corruptDir, { recursive: true });
  const stuck = addTodo(corruptDir, ws, { title: 'Stuck', status: 'ready', orchestratorChatId: 'gone-chat' }).item;
  updateTodo(corruptDir, ws, stuck.id, { status: 'doing' });
  const storeFile = getWorkspaceWatchersDataPath({ dataDir: corruptDir });
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, '{ not json', 'utf8');
  const corruptPass = releaseStaleWorkspaceTodoClaims({ dataDir: corruptDir, workspaceFolder: ws, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }) });
  assert.deepEqual(corruptPass.released, []);
  assert.equal(corruptPass.errors[0].scope, 'watcher');
  assert.equal(getTodoById(corruptDir, ws, stuck.id).status, 'doing', 'an unreadable store never frees work');
  assert.equal(fs.readFileSync(storeFile, 'utf8'), '{ not json', 'the corrupt store is never overwritten');
  // Manual recover shares the autopilot atomic path.
  const manualLeaf = addTodo(dataDir, ws, { title: 'Manual recover', status: 'ready' }).item;
  updateTodo(dataDir, ws, manualLeaf.id, { status: 'doing', orchestratorChatId: 'gone-manual' });
  const manualPass = reconcile({ getChat: archivedChat });
  assert.equal(stateOf(manualPass, manualLeaf.id).state, 'recoverable');
  const { recoverWorkspaceWatcherTodo } = await import('../lib/workspace-watcher-todo-recover.js');
  const manualRow = getTodoById(dataDir, ws, manualLeaf.id);
  const recovered = recoverWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: ws,
    todoId: manualLeaf.id,
    expectedUpdatedAt: manualRow.updatedAt,
    idempotencyKey: 'manual-test',
    probeChatRunLiveness: idle,
    getChat: archivedChat,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.outcome, 'released');
  assert.equal(recovered.startsNewExecution, true);
  assert.equal(getTodoById(dataDir, ws, manualLeaf.id).status, 'ready');

  // policy.recoverIdleOpenChat: default false => user_action; true => recoverable; never promotes unknown.
  const idleOpen = doing('Idle open chat flag', { orchestratorChatId: 'open-exec' });
  let idleOpenPass = reconcile({ getChat: openChat });
  assert.equal(stateOf(idleOpenPass, idleOpen.id).state, 'user_action');
  assert.equal(stateOf(idleOpenPass, idleOpen.id).reason, 'idle_open_chat');
  upsertWorkspaceWatcher(ws, { policy: { recoverIdleOpenChat: true } }, { dataDir });
  idleOpenPass = reconcile({ getChat: openChat });
  assert.equal(getWorkspaceWatcher(ws, { dataDir }).policy.recoverIdleOpenChat, true);
  assert.equal(stateOf(idleOpenPass, idleOpen.id).state, 'recoverable');
  assert.equal(stateOf(idleOpenPass, idleOpen.id).reason, 'idle_open_chat');
  assert.equal(stateOf(idleOpenPass, legacy.id).state, 'unknown', 'recoverIdleOpenChat never promotes missing_identity');

  // Unknown escalation: threshold, single notify, dedup, signature reset.
  const { observeWorkspaceTodoUnknownEscalations } = await import('../lib/workspace-watcher-todo-recover.js');
  const escWs = path.join(ISOLATED_DATA_DIR, 'esc-ws');
  fs.mkdirSync(escWs, { recursive: true });
  upsertWorkspaceWatcher(escWs, { mode: 'autopilot', policy: { unknownEscalationObservations: 2 } }, { dataDir });
  const escTodo = addTodo(dataDir, escWs, { title: 'Esc unknown', status: 'ready', orchestratorChatId: 'esc-exec' }).item;
  updateTodo(dataDir, escWs, escTodo.id, { status: 'doing' });
  claimWorkspaceTodo({ dataDir, workspaceFolder: escWs, todoId: escTodo.id, claimedByChatId: 'esc-exec', expectedUpdatedAt: escTodo.updatedAt });
  const escOpenChat = () => ({ archived: false });
  let escNotifies = 0;
  const escNotify = () => { escNotifies += 1; return true; };
  const escBase = Date.now();
  observeWorkspaceTodoUnknownEscalations({
    dataDir, workspaceFolder: escWs, now: escBase, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }), getChat: escOpenChat, notify: escNotify,
  });
  assert.equal(escNotifies, 0, 'below threshold: no notify');
  observeWorkspaceTodoUnknownEscalations({
    dataDir, workspaceFolder: escWs, now: escBase + 5000, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }), getChat: escOpenChat, notify: escNotify,
  });
  assert.equal(escNotifies, 1, 'at threshold: one notify');
  observeWorkspaceTodoUnknownEscalations({
    dataDir, workspaceFolder: escWs, now: escBase + 10000, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }), getChat: escOpenChat, notify: escNotify,
  });
  assert.equal(escNotifies, 1, 'same signature: dedup');
  observeWorkspaceTodoUnknownEscalations({
    dataDir,
    workspaceFolder: escWs,
    now: escBase + 15000,
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'probe_failed' }),
    getChat: escOpenChat,
    notify: escNotify,
  });
  assert.equal(escNotifies, 1, 'new signature resets count: still below second threshold');
  observeWorkspaceTodoUnknownEscalations({
    dataDir,
    workspaceFolder: escWs,
    now: escBase + 20000,
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'probe_failed' }),
    getChat: escOpenChat,
    notify: escNotify,
  });
  assert.equal(escNotifies, 2, 'new signature reaches threshold again');

  // Observe mode: detect/report unknown escalation without claim release.
  const observeEscWs = path.join(ISOLATED_DATA_DIR, 'observe-esc-ws');
  fs.mkdirSync(observeEscWs, { recursive: true });
  upsertWorkspaceWatcher(observeEscWs, {
    mode: 'observe',
    policy: { unknownEscalationObservations: 2, quietHoursStart: 0, quietHoursEnd: 24 },
  }, { dataDir });
  const observeEscTodo = addTodo(dataDir, observeEscWs, { title: 'Observe esc', status: 'ready' }).item;
  updateTodo(dataDir, observeEscWs, observeEscTodo.id, { status: 'doing' });
  let observeNotifies = 0;
  const observeNotify = () => { observeNotifies += 1; return true; };
  observeWorkspaceTodoUnknownEscalations({
    dataDir, workspaceFolder: observeEscWs, now: escBase, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }), notify: observeNotify,
  });
  observeWorkspaceTodoUnknownEscalations({
    dataDir, workspaceFolder: observeEscWs, now: escBase + 5000, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }), notify: observeNotify,
  });
  assert.equal(observeNotifies, 1, 'observe: threshold notify despite quiet-hours policy');
  assert.equal(getTodoById(dataDir, observeEscWs, observeEscTodo.id).status, 'doing', 'observe: no automatic release');
  const offEscWs = path.join(ISOLATED_DATA_DIR, 'off-esc-ws');
  fs.mkdirSync(offEscWs, { recursive: true });
  upsertWorkspaceWatcher(offEscWs, { mode: 'off', policy: { unknownEscalationObservations: 1 } }, { dataDir });
  const offEscTodo = addTodo(dataDir, offEscWs, { title: 'Off esc', status: 'ready' }).item;
  updateTodo(dataDir, offEscWs, offEscTodo.id, { status: 'doing' });
  let offNotifies = 0;
  observeWorkspaceTodoUnknownEscalations({
    dataDir, workspaceFolder: offEscWs, now: escBase, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }), notify: () => { offNotifies += 1; return true; },
  });
  assert.equal(offNotifies, 0, 'off: no escalation notify');

  const { enrichWorkspaceTodoRecoveryView } = await import('../lib/workspace-watcher-todo-recover.js');
  const recoverableView = enrichWorkspaceTodoRecoveryView(
    { state: 'recoverable', todoId: 'v1', reason: 'chat_missing' },
    { status: 'doing', updatedAt: '2026-01-01T00:00:00.000Z', execution: { phase: 'claimed' } },
  );
  assert.equal(recoverableView.displayState, 'recoverable');
  assert.notEqual(recoverableView.displayState, 'recovery_in_progress');
  assert.equal(recoverableView.recoveryInProgress, false);
  const startingView = enrichWorkspaceTodoRecoveryView(
    { state: 'unknown', todoId: 'v2', reason: 'adapter_missing' },
    { status: 'doing', execution: { phase: 'starting' }, updatedAt: '2026-01-02T00:00:00.000Z' },
  );
  assert.equal(startingView.recoveryInProgress, true);
  assert.equal(startingView.displayState, 'recovery_in_progress');
  assert.notEqual(startingView.displayState, 'unknown');

  // Guardrails: paused watcher skips release and escalation side effects.
  const guardWs = path.join(ISOLATED_DATA_DIR, 'guard-ws');
  fs.mkdirSync(guardWs, { recursive: true });
  upsertWorkspaceWatcher(guardWs, { mode: 'autopilot', paused: true, policy: { unknownEscalationObservations: 1 } }, { dataDir });
  const guardTodo = addTodo(dataDir, guardWs, { title: 'Guard claimed', status: 'ready', orchestratorChatId: 'gone-guard' }).item;
  updateTodo(dataDir, guardWs, guardTodo.id, { status: 'doing' });
  claimWorkspaceTodo({ dataDir, workspaceFolder: guardWs, todoId: guardTodo.id, claimedByChatId: 'cycle-g', expectedUpdatedAt: guardTodo.updatedAt, cycleId: 'g-cycle' });
  const guardPass = releaseStaleWorkspaceTodoClaims({
    dataDir, workspaceFolder: guardWs, probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }), getChat: archivedChat,
  });
  assert.equal(getTodoById(dataDir, guardWs, guardTodo.id).status, 'doing', 'paused: no claimed release');
  assert.equal(guardPass.released.includes(guardTodo.id), false);
  const guardUnknown = addTodo(dataDir, guardWs, { title: 'Guard unknown', status: 'ready' }).item;
  updateTodo(dataDir, guardWs, guardUnknown.id, { status: 'doing' });
  let guardNotifies = 0;
  for (let i = 0; i < 2; i += 1) {
    observeWorkspaceTodoUnknownEscalations({
      dataDir,
      workspaceFolder: guardWs,
      now: escBase + i * 5000,
      probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'adapter_missing' }),
      notify: () => { guardNotifies += 1; return true; },
    });
  }
  assert.equal(guardNotifies, 0, 'paused: no unknown escalation notify');

  // MCP in-process recover_todo returns real outcomes (not configure).
  const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
  const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
  setBuiltinMcpRuntimeDeps({
    dataDir,
    taskRuns: new Map(),
    agentRuns: new Map(),
    loadTasksForWorkspace: () => ({ tasks: [] }),
    workspaceDirForAgent: () => '',
  });
  const mcp = createInProcessMcpClient({ chatId: 'todo-claims-mcp' });
  const mcpLeaf = addTodo(dataDir, ws, { title: 'MCP recover path', status: 'ready', orchestratorChatId: 'mcp-gone' }).item;
  updateTodo(dataDir, ws, mcpLeaf.id, { status: 'doing' });
  const mcpRow = getTodoById(dataDir, ws, mcpLeaf.id);
  const mcpReleased = await mcp.workspaceWatcherUpdate({
    action: 'recover_todo',
    workspaceFolder: ws,
    todoId: mcpLeaf.id,
    expectedUpdatedAt: mcpRow.updatedAt,
  });
  assert.equal(mcpReleased.action, 'recover_todo');
  assert.notEqual(mcpReleased.action, 'configure');
  assert.equal(mcpReleased.ok, true);
  assert.equal(mcpReleased.outcome, 'released');
  assert.equal(getTodoById(dataDir, ws, mcpLeaf.id).status, 'ready');
  const mcpStaleLeaf = addTodo(dataDir, ws, { title: 'MCP stale', status: 'ready', orchestratorChatId: 'mcp-stale' }).item;
  updateTodo(dataDir, ws, mcpStaleLeaf.id, { status: 'doing' });
  const mcpConflict = await mcp.workspaceWatcherUpdate({
    action: 'recover_todo',
    workspaceFolder: ws,
    todoId: mcpStaleLeaf.id,
    expectedUpdatedAt: '1970-01-01T00:00:00.000Z',
  });
  assert.equal(mcpConflict.action, 'recover_todo');
  assert.equal(mcpConflict.ok, false);
  assert.equal(mcpConflict.outcome, 'conflict');
  assert.equal(getTodoById(dataDir, ws, mcpStaleLeaf.id).status, 'doing');

  // REST/MCP atomic outcomes: already-active, non-leaf refused.
  const activeLeaf = doing('Active slot', { orchestratorChatId: 'busy-exec' });
  claimWorkspaceTodo({ dataDir, workspaceFolder: ws, todoId: activeLeaf.id, claimedByChatId: 'busy-exec', expectedUpdatedAt: activeLeaf.updatedAt });
  const activeRow = getTodoById(dataDir, ws, activeLeaf.id);
  const activeResult = recoverWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: ws,
    todoId: activeLeaf.id,
    expectedUpdatedAt: activeRow.updatedAt,
    probeChatRunLiveness: busy,
    getChat: openChat,
  });
  assert.equal(activeResult.outcome, 'already-active');
  assert.equal(getTodoById(dataDir, ws, activeLeaf.id).status, 'doing');
  const parentBlock = addTodo(dataDir, ws, { title: 'Parent block', status: 'ready' }).item;
  const parentChild = addTodo(dataDir, ws, { title: 'Parent child', parentId: parentBlock.id, status: 'ready' }).item;
  updateTodo(dataDir, ws, parentChild.id, { status: 'doing' });
  const parentRow = getTodoById(dataDir, ws, parentBlock.id);
  assert.equal(parentRow.status, 'doing');
  const parentResult = recoverWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: ws,
    todoId: parentBlock.id,
    expectedUpdatedAt: parentRow.updatedAt,
  });
  assert.equal(parentResult.ok, false);
  assert.equal(parentResult.outcome, 'blocked');
  assert.equal(parentResult.error?.code, 'NOT_LEAF');

  console.log('todo claims: all passed');
} finally {
  removeIsolatedDataDir();
}
