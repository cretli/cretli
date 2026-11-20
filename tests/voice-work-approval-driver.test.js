import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkToolHandlers } from '../app_front/features/voice/voiceWorkTools.js';
import { collectPendingApprovals, createApprovalToolHandlers } from '../app_front/features/approval/voiceApprovalTools.js';
import { createConfirmGuard } from '../app_front/features/voice/voiceConfirmGuard.js';

/** Guard with a manual clock; `speak()` is the driver answering aloud. */
function makeGuard() {
  const clock = { time: 1000 };
  const guard = createConfirmGuard({ now: () => clock.time });
  return {
    clock,
    driverConfirm: {
      ask: (action, target) => guard.askConfirm(action, target),
      consume: (action, target) => guard.consumeConfirm(action, target),
    },
    speak() {
      guard.noteUserSpeech();
      clock.time += 2000;
    },
  };
}

function makeWork() {
  const state = { started: [], cancelled: [] };
  const handlers = createWorkToolHandlers({
    getContext: () => ({ workspaceFolder: '/w', chatId: 'c1' }),
    listTodos: () => [{ id: 't1', title: 'Fix login', status: 'ready' }],
    startTodo: ({ todo }) => { state.started.push(todo.id); return { ok: true }; },
    getWatcherView: () => null,
    setWatcherPaused: () => ({ ok: true }),
    listDelegations: () => [{ id: 'd1', status: 'running', assignment: 'implement', active: true, executor: {} }],
    cancelDelegation: (id) => { state.cancelled.push(id); return { ok: true }; },
  });
  return { state, work: handlers.work };
}

const WORK_CASES = [
  { action: 'todo_start', id: 't1', done: (state) => state.started },
  { action: 'delegation_cancel', id: 'd1', done: (state) => state.cancelled },
];

for (const { action, id, done } of WORK_CASES) {
  test(`work ${action}: confirm without driver speech is refused and does nothing`, async () => {
    const g = makeGuard();
    const { state, work } = makeWork();
    const opts = { driverConfirm: g.driverConfirm };
    assert.equal((await work({ action, id }, opts)).needsConfirm, true);
    g.clock.time += 2000; // time passes but the driver stays silent
    const refused = await work({ action, id, confirm: true }, opts);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'no_driver_answer');
    assert.deepEqual(done(state), []);
    // The binding is single-use: even after speech the old confirm cannot be replayed.
    g.speak();
    assert.equal((await work({ action, id, confirm: true }, opts)).ok, false);
    assert.deepEqual(done(state), []);
  });

  test(`work ${action}: speech before step one does not count`, async () => {
    const g = makeGuard();
    const { state, work } = makeWork();
    const opts = { driverConfirm: g.driverConfirm };
    g.speak();
    await work({ action, id }, opts);
    g.clock.time += 2000;
    const refused = await work({ action, id, confirm: true }, opts);
    assert.equal(refused.code, 'no_driver_answer');
    assert.deepEqual(done(state), []);
  });

  test(`work ${action}: a correct two-step with speech after the question acts exactly once`, async () => {
    const g = makeGuard();
    const { state, work } = makeWork();
    const opts = { driverConfirm: g.driverConfirm };
    await work({ action, id }, opts);
    g.speak();
    const result = await work({ action, id, confirm: true }, opts);
    assert.equal(result.ok, true);
    assert.deepEqual(done(state), [id]);
    assert.equal((await work({ action, id, confirm: true }, opts)).ok, false);
    assert.deepEqual(done(state), [id]);
  });

  test(`work ${action}: without a driver guard (Web Speech) the model two-step is unchanged`, async () => {
    const { state, work } = makeWork();
    await work({ action, id });
    assert.equal((await work({ action, id, confirm: true })).ok, true);
    assert.deepEqual(done(state), [id]);
  });
}

function makeApproval() {
  const replies = [];
  const chat = {
    id: 'c1',
    title: 'Chat',
    _opencodePendingPermission: { type: 'opencode_permission', requestId: 'req-a', action: 'bash' },
    _sdkServerPendingPermissionCount: 1,
  };
  const handlers = createApprovalToolHandlers({
    getActiveChat: () => ({ id: 'c1', title: 'Chat' }),
    listPendingApprovals: () => collectPendingApprovals({ chats: [chat], activeChatId: 'c1' }),
    replyToApproval: (input) => { replies.push(input); return { ok: true }; },
  });
  return { replies, approval: handlers.approval };
}

for (const answer of ['once', 'reject']) {
  const args = { action: 'answer', answer, request_id: 'req-a', chat_id: 'c1' };

  test(`approval ${answer}: answer without driver speech is refused and sends nothing`, async () => {
    const g = makeGuard();
    const { replies, approval } = makeApproval();
    const opts = { driverConfirm: g.driverConfirm };
    await approval({ action: 'describe_pending' }, opts);
    g.clock.time += 2000;
    const refused = await approval(args, opts);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'no_driver_answer');
    assert.deepEqual(replies, []);
    g.speak();
    assert.equal((await approval(args, opts)).ok, false); // closed: needs a fresh describe
    assert.deepEqual(replies, []);
  });

  test(`approval ${answer}: speech before describe_pending does not count`, async () => {
    const g = makeGuard();
    const { replies, approval } = makeApproval();
    const opts = { driverConfirm: g.driverConfirm };
    g.speak();
    await approval({ action: 'describe_pending' }, opts);
    g.clock.time += 2000;
    assert.equal((await approval(args, opts)).code, 'no_driver_answer');
    assert.deepEqual(replies, []);
  });

  test(`approval ${answer}: speech after the question lets exactly one answer through`, async () => {
    const g = makeGuard();
    const { replies, approval } = makeApproval();
    const opts = { driverConfirm: g.driverConfirm };
    await approval({ action: 'describe_pending' }, opts);
    g.speak();
    assert.equal((await approval(args, opts)).ok, true);
    assert.deepEqual(replies, [{ chatId: 'c1', requestId: 'req-a', answer }]);
    assert.equal((await approval(args, opts)).ok, false);
    assert.equal(replies.length, 1);
  });

  test(`approval ${answer}: without a driver guard (Web Speech) the described answer is unchanged`, async () => {
    const { replies, approval } = makeApproval();
    await approval({ action: 'describe_pending' });
    assert.equal((await approval(args)).ok, true);
    assert.equal(replies.length, 1);
  });
}
