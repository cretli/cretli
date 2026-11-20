import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { commandHandlers, createCommandHandlers } from '../app_front/features/voice/commandHandlers.js';
import { createBrowserVoiceMode } from '../app_front/features/voice/browserVoiceMode.js';
import { matchLocalCommand } from '../app_front/features/voice/localCommands.js';
import {
  executeRealtimeTool,
  noteRealtimeUserSpeech,
  resetRealtimeToolGuards,
  setRealtimeConfirmGuard,
  setRealtimeToolModules,
} from '../app_front/features/voice/realtimeTools.js';
import { createConfirmBinding } from '../app_front/features/voice/voiceConfirmBinding.js';
import { createConfirmGuard } from '../app_front/features/voice/voiceConfirmGuard.js';
import { VOICE_ACTIONS, getVoiceAction } from '../lib/voice/action-registry.ts';
import { loadCorpus } from '../scripts/voice-control-benchmark.mjs';

/** Harness: fake chat / tasks modules, a manual clock for the confirm guard, a recorded run list. */
function setup() {
  const state = {
    started: [],
    deleted: [],
    chats: [{ id: 'c1', title: 'Old chat' }, { id: 'c2', title: 'Other chat' }],
    active: 'c1',
    tasks: [{ label: 'Build front' }, { label: 'Deploy prod' }, { label: 'Deploy staging' }],
  };
  const clock = { time: 1000 };
  setRealtimeConfirmGuard(createConfirmGuard({ now: () => clock.time }));
  setRealtimeToolModules({
    chat: {
      getChatsList: () => state.chats,
      getActiveChatIdValue: () => state.active,
      requestDeleteChat: (id) => { state.deleted.push(id); state.chats = state.chats.filter((chat) => chat.id !== id); },
    },
    tasks: { runTaskByLabel: (label) => { state.started.push(label); return true; } },
    getTasks: async () => ({ tasks: state.tasks }),
  });
  const original = commandHandlers.getActiveChat;
  commandHandlers.getActiveChat = async () => ({ id: state.active, title: 'x' });
  return {
    state,
    clock,
    /** The driver answers the question aloud. */
    answer() {
      noteRealtimeUserSpeech();
      clock.time += 2000;
    },
    restore() {
      commandHandlers.getActiveChat = original;
      setRealtimeToolModules(null);
      setRealtimeConfirmGuard(null);
      resetRealtimeToolGuards();
    },
  };
}

test('registry: workspace is a confirm family with per-action risk, task_run confirm, the rest safe', () => {
  const workspace = getVoiceAction('workspace');
  assert.equal(workspace.risk, 'confirm');
  assert.equal(workspace.actionRisk.task_run, 'confirm');
  for (const action of workspace.properties.action.enum) assert.ok(workspace.actionRisk[action], action);
  for (const action of ['list', 'switch', 'folders', 'folder', 'tasks']) assert.equal(workspace.actionRisk[action], 'safe', action);
  assert.deepEqual(Object.keys(workspace.actionRisk).sort(), [...workspace.properties.action.enum].sort());
  assert.ok('id' in workspace.properties && 'confirm' in workspace.properties);
  assert.equal(getVoiceAction('delete_chat').risk, 'confirm');
  assert.ok('id' in getVoiceAction('delete_chat').properties);
  for (const entry of VOICE_ACTIONS) {
    if (entry.actionRisk) assert.ok(Object.values(entry.actionRisk).includes(entry.risk), entry.id);
  }
});

test('corpus: the task_run utterance is a confirm case', () => {
  const item = loadCorpus().find((entry) => entry.tool === 'workspace' && entry.args.action === 'task_run');
  assert.equal(item.target.risk, 'confirm');
});

test('task_run: the first call never runs the task', async () => {
  const h = setup();
  try {
    const first = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    assert.equal(first.needsConfirm, true);
    assert.equal(first.task, 'Build front');
    assert.ok(first.id);
    assert.deepEqual(h.state.started, []);
  } finally { h.restore(); }
});

test('task_run: unknown and ambiguous labels are reported at step one and bind nothing', async () => {
  const h = setup();
  try {
    assert.match((await executeRealtimeTool('workspace', { action: 'task_run', label: 'nope' })).error, /Unknown task/);
    assert.match((await executeRealtimeTool('workspace', { action: 'task_run', label: 'deploy' })).error, /Ambiguous task/);
    h.answer();
    assert.equal((await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: 't1' })).code, 'no_pending');
    assert.deepEqual(h.state.started, []);
  } finally { h.restore(); }
});

test('task_run: confirm=true without step one is refused', async () => {
  const h = setup();
  try {
    h.answer();
    const result = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build', confirm: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no_pending');
    assert.deepEqual(h.state.started, []);
  } finally { h.restore(); }
});

test('task_run: confirm without driver speech is refused', async () => {
  const h = setup();
  try {
    const first = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    h.clock.time += 2000;
    const result = await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: first.id });
    assert.equal(result.code, 'no_driver_answer');
    assert.deepEqual(h.state.started, []);
  } finally { h.restore(); }
});

test('task_run: the correct two-step runs exactly once, bound to the label of step one', async () => {
  const h = setup();
  try {
    const first = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    h.answer();
    // The confirming call names another task: the bound one runs.
    const done = await executeRealtimeTool('workspace', { action: 'task_run', label: 'deploy prod', confirm: true, id: first.id });
    assert.equal(done.ok, true);
    assert.deepEqual(h.state.started, ['Build front']);
    h.answer();
    assert.equal((await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: first.id })).code, 'no_pending');
    assert.equal(h.state.started.length, 1);
  } finally { h.restore(); }
});

test('task_run: wrong id, expired window, changed chat and an intervening tool refuse', async () => {
  const h = setup();
  try {
    const a = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    h.answer();
    assert.equal((await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: 'other' })).code, 'id_mismatch');
    // The driver window (30 s) is the stricter clock here; the 60 s binding window is covered below.
    const b = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    h.clock.time += 31_000;
    noteRealtimeUserSpeech();
    assert.equal((await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: b.id })).ok, false);
    const c = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    h.state.active = 'c2';
    h.answer();
    assert.equal((await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: c.id })).code, 'context_changed');
    h.state.active = 'c1';
    const d = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    await executeRealtimeTool('workspace', { action: 'tasks' });
    h.answer();
    assert.equal((await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: d.id })).code, 'no_pending');
    assert.ok(a.id);
    assert.deepEqual(h.state.started, []);
  } finally { h.restore(); }
});

test('confirm binding: single use, expiry, context and action are enforced', () => {
  const clock = { time: 0 };
  const binding = createConfirmBinding({ now: () => clock.time });
  const ctx = { workspaceFolder: '/w', chatId: 'c1' };
  const id = binding.bind('task_run', 't', ctx, { label: 'Build' });
  assert.equal(binding.consume('delete_chat', id, ctx).result.code, 'no_pending', 'other action');
  const second = binding.bind('task_run', 't', ctx, { label: 'Build' });
  clock.time += 60_001;
  assert.equal(binding.consume('task_run', second, ctx).result.code, 'expired');
  const third = binding.bind('task_run', 't', ctx, { label: 'Build' });
  assert.equal(binding.consume('task_run', third, { ...ctx, workspaceFolder: '/other' }).result.code, 'context_changed');
  const fourth = binding.bind('task_run', 't', ctx, { label: 'Build' });
  assert.deepEqual(binding.consume('task_run', fourth, ctx), { ok: true, data: { label: 'Build' } });
  assert.equal(binding.consume('task_run', fourth, ctx).result.code, 'no_pending');
});

test('Web Speech has no local phrase that runs a task or deletes a chat', () => {
  for (const phrase of ['run the build task', 'uruchom task build front', 'delete this chat', 'usuń ten czat', 'confirm', 'tak']) {
    assert.equal(matchLocalCommand(phrase), null, phrase);
  }
});

test('delete_chat: first call never deletes; confirm without step one, without driver speech or with a wrong id is refused', async () => {
  const h = setup();
  try {
    const first = await executeRealtimeTool('delete_chat', { chat_id: 'c2' });
    assert.equal(first.needsConfirm, true);
    assert.equal(first.title, 'Other chat');
    assert.ok(first.id);
    assert.deepEqual(h.state.deleted, []);
    h.clock.time += 2000;
    assert.equal((await executeRealtimeTool('delete_chat', { chat_id: 'c2', confirm: true, id: first.id })).code, 'no_driver_answer');
    assert.equal((await executeRealtimeTool('delete_chat', { chat_id: 'c2', confirm: true })).code, 'no_pending');
    const second = await executeRealtimeTool('delete_chat', { chat_id: 'c2' });
    h.answer();
    assert.equal((await executeRealtimeTool('delete_chat', { chat_id: 'c2', confirm: true, id: 'zzz' })).code, 'id_mismatch');
    assert.deepEqual(h.state.deleted, []);
    assert.ok(second.id);
  } finally { h.restore(); }
});

test('delete_chat: the correct two-step deletes exactly once and only the chat step one described', async () => {
  const h = setup();
  try {
    const first = await executeRealtimeTool('delete_chat', { chat_id: 'c2' });
    h.answer();
    const done = await executeRealtimeTool('delete_chat', { chat_id: 'c1', confirm: true, id: first.id });
    assert.equal(done.ok, true);
    assert.equal(done.chatId, 'c2', 'a different chat_id in the confirming call is ignored');
    assert.deepEqual(h.state.deleted, ['c2']);
    h.answer();
    assert.equal((await executeRealtimeTool('delete_chat', { confirm: true, id: first.id })).code, 'no_pending');
    assert.deepEqual(h.state.deleted, ['c2']);
    // Another voice tool between the steps drops the binding.
    const again = await executeRealtimeTool('delete_chat', { chat_id: 'c1' });
    await executeRealtimeTool('app_status', { action: 'cost' });
    h.answer();
    assert.equal((await executeRealtimeTool('delete_chat', { confirm: true, id: again.id })).code, 'no_pending');
    assert.deepEqual(h.state.deleted, ['c2']);
  } finally { h.restore(); }
});

test('a step-one binding does not survive a session boundary', async () => {
  const h = setup();
  try {
    const first = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    resetRealtimeToolGuards();
    h.answer();
    assert.equal((await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: first.id })).code, 'no_pending');
    assert.deepEqual(h.state.started, []);
  } finally { h.restore(); }
});

// -- Scout "read in this session" memory ------------------------------------------------------------------------

const PROPOSAL = { id: 'f1', title: 'Split the router', category: 'refactor', rationale: 'Too long.', status: 'pending', updatedAt: '2026-11-11T10:00:00Z' };

function inboxDeps(findings) {
  return {
    getContext: () => ({ workspaceFolder: '/w/shop', chatId: 'c1' }),
    getNotificationState: () => ({ initialized: true, items: [] }),
    listScoutProposals: async () => ({ ok: true, findings, total: findings.length }),
    decideScoutProposal: async () => ({ ok: true }),
  };
}

test('Scout memory is cleared by a session boundary: list in session A, accept in session B is not_listed', async () => {
  const real = createCommandHandlers({ loadInboxDeps: async () => inboxDeps([PROPOSAL]) });
  const originals = { inbox: commandHandlers.inbox, cancelInbox: commandHandlers.cancelInbox, resetSession: commandHandlers.resetSession };
  Object.assign(commandHandlers, { inbox: real.inbox, cancelInbox: real.cancelInbox, resetSession: real.resetSession });
  try {
    await executeRealtimeTool('inbox', { action: 'list_scout' });
    // Control: still the same session, the proposal counts as read.
    assert.equal((await executeRealtimeTool('inbox', { action: 'scout_accept', id: 'f1' })).needsConfirm, true);
    // Session B starts (or A ends): the same unchanged proposal must be listed again.
    resetRealtimeToolGuards();
    assert.equal((await executeRealtimeTool('inbox', { action: 'scout_accept', id: 'f1' })).code, 'not_listed');
    await executeRealtimeTool('inbox', { action: 'list_scout' });
    assert.equal((await executeRealtimeTool('inbox', { action: 'scout_accept', id: 'f1' })).needsConfirm, true);
  } finally {
    Object.assign(commandHandlers, originals);
  }
});

test('Web Speech start and stop reset the Scout memory and pending bindings too', async () => {
  const real = createCommandHandlers({ loadInboxDeps: async () => inboxDeps([PROPOSAL]) });
  let resets = 0;
  const handlers = { ...real, resetSession: () => { resets += 1; real.resetSession(); } };
  const state = { value: {}, get() { return this.value; }, set(next) { this.value = next; } };
  const mode = createBrowserVoiceMode({
    handlers,
    state,
    executors: {},
    isRealtimeActive: () => false,
    eventTarget: null,
    gate: { reset() {}, subscribe: () => () => {}, getPending: () => null, isActive: () => false },
    createInput: () => ({ start: () => ({ ok: true }), stop() {} }),
  });
  await handlers.inbox({ action: 'list_scout' });
  assert.equal((await handlers.inbox({ action: 'scout_accept', id: 'f1' })).needsConfirm, true);
  mode.start();
  assert.equal((await handlers.inbox({ action: 'scout_accept', id: 'f1' })).code, 'not_listed');
  await handlers.inbox({ action: 'list_scout' });
  mode.stop();
  assert.equal((await handlers.inbox({ action: 'scout_accept', id: 'f1' })).code, 'not_listed');
  assert.ok(resets >= 2);
});

test('proposals trimmed out of the answer do not count as read', async () => {
  const long = (index) => ({
    id: `p${index}`,
    title: `Proposal ${index} ${'t'.repeat(300)}`,
    category: 'refactor',
    rationale: 'r'.repeat(400),
    status: 'pending',
    updatedAt: `2026-11-11T10:0${index}:00Z`,
  });
  const findings = Array.from({ length: 8 }, (_, index) => long(index + 1));
  const real = createCommandHandlers({ loadInboxDeps: async () => inboxDeps(findings) });
  const listed = await real.inbox({ action: 'list_scout' });
  const shownIds = listed.proposals.map((entry) => entry.id);
  assert.ok(shownIds.length > 0 && shownIds.length < findings.length, `capping dropped rows (shown ${shownIds.length})`);
  assert.equal(listed.truncated, true);
  const trimmed = findings.find((entry) => !shownIds.includes(entry.id));
  assert.equal((await real.inbox({ action: 'scout_accept', id: trimmed.id })).code, 'not_listed');
  assert.equal((await real.inbox({ action: 'scout_accept', id: shownIds[0] })).needsConfirm, true);
});

test('task_run: a task list that changes between the steps never runs a different task', async () => {
  const h = setup();
  try {
    const first = await executeRealtimeTool('workspace', { action: 'task_run', label: 'build' });
    assert.equal(first.task, 'Build front');
    // The bound task disappears and a longer label that still matches the fragment appears.
    h.state.tasks = [{ label: 'Build front deploy' }, { label: 'Deploy prod' }];
    h.answer();
    const done = await executeRealtimeTool('workspace', { action: 'task_run', confirm: true, id: first.id });
    assert.equal(done.code, 'task_changed');
    assert.deepEqual(h.state.started, []);
  } finally { h.restore(); }
});

test('a Scout list still in flight when the session resets does not mark proposals read in the new session', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = { ...inboxDeps([PROPOSAL]), listScoutProposals: async () => { await gate; return { ok: true, findings: [PROPOSAL], total: 1 }; } };
  const real = createCommandHandlers({ loadInboxDeps: async () => deps });
  const originals = { inbox: commandHandlers.inbox, cancelInbox: commandHandlers.cancelInbox, resetSession: commandHandlers.resetSession };
  Object.assign(commandHandlers, { inbox: real.inbox, cancelInbox: real.cancelInbox, resetSession: real.resetSession });
  try {
    const listing = executeRealtimeTool('inbox', { action: 'list_scout' });
    // Session A ends while its request is still waiting for the server.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetRealtimeToolGuards();
    release();
    assert.equal((await listing).code, 'stale_session');
    deps.listScoutProposals = async () => ({ ok: true, findings: [PROPOSAL], total: 1 });
    assert.equal((await executeRealtimeTool('inbox', { action: 'scout_accept', id: 'f1' })).code, 'not_listed');
  } finally {
    Object.assign(commandHandlers, originals);
  }
});

test('a session reset while the inbox handlers are still loading makes the old call stale', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const real = createCommandHandlers({ loadInboxDeps: async () => { await gate; return inboxDeps([PROPOSAL]); } });
  const listing = real.inbox({ action: 'list_scout' });
  const twin = real.inbox({ action: 'list_notifications' });
  // The session ends before the first load finished.
  real.resetSession();
  release();
  assert.equal((await listing).code, 'stale_session');
  assert.equal((await twin).code, 'stale_session');
  assert.equal((await real.inbox({ action: 'scout_accept', id: 'f1' })).code, 'not_listed');
  await real.inbox({ action: 'list_scout' });
  assert.equal((await real.inbox({ action: 'scout_accept', id: 'f1' })).needsConfirm, true);
});
