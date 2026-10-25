import assert from 'node:assert/strict';
import test from 'node:test';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  VOICE_WORK_ACTIONS,
  VOICE_WORK_ACTION_RISK,
  VOICE_WORK_CONFIRM_TTL_MS,
  createWorkToolHandlers,
  matchVoiceTodo,
  resolveVoiceWorkAction,
} from '../app_front/features/voice/voiceWorkTools.js';
import { VOICE_ACTIONS, buildRealtimeTools, getVoiceAction } from '../lib/voice/action-registry.ts';
import { toGeminiFunctionDeclarations } from '../lib/voice/gemini-live-config.ts';
import { executeRealtimeTool } from '../app_front/features/voice/realtimeTools.js';
import { capVoiceResult } from '../app_front/features/voice/voiceAppMatch.js';

const TODOS = [
  { id: 't1', title: 'Naprawić logowanie', status: 'ready' },
  { id: 't2', title: 'Add dark theme', status: 'ready' },
  { id: 't3', title: 'Doing thing', status: 'doing' },
  { id: 't4', title: 'Done thing', status: 'done' },
  { id: 'p1', title: 'Parent', status: 'ready' },
  { id: 'c1', title: 'Child of parent', status: 'ready', parentId: 'p1' },
];

function makeHarness(overrides = {}) {
  const state = {
    context: { workspaceFolder: '/w/a', chatId: 'chat-1' },
    todos: structuredClone(TODOS),
    delegations: [
      { id: 'd1', status: 'running', assignment: 'implement', active: true, executor: { transport: 'codex', model: 'gpt' } },
      { id: 'd2', status: 'completed', assignment: 'review', active: false, executor: {} },
    ],
    watcher: { watcher: { mode: 'autopilot', paused: false, stopReason: '', activeCycles: [{}] } },
    started: [],
    cancelled: [],
    paused: [],
    clock: 1000,
    ...overrides,
  };
  const handlers = createWorkToolHandlers({
    getContext: () => ({ ...state.context }),
    listTodos: () => state.todos,
    startTodo: ({ todo }) => { state.started.push(todo.id); return { ok: true, state: 'started' }; },
    getWatcherView: () => state.watcher,
    setWatcherPaused: (value) => { state.paused.push(value); return { ok: true }; },
    listDelegations: () => state.delegations,
    cancelDelegation: (id) => { state.cancelled.push(id); return { ok: true }; },
    now: () => state.clock,
  });
  return { state, work: handlers.work };
}

test('every work action has a risk and a handler path', async () => {
  assert.deepEqual(Object.keys(VOICE_WORK_ACTION_RISK).sort(), [...VOICE_WORK_ACTIONS].sort());
  for (const action of VOICE_WORK_ACTIONS) {
    assert.ok(['safe', 'confirm'].includes(VOICE_WORK_ACTION_RISK[action]), action);
    const { work } = makeHarness();
    const result = await work({ action });
    assert.doesNotMatch(String(result.error || ''), /^Action must be one of/, action);
  }
  assert.equal(VOICE_WORK_ACTION_RISK.todo_start, 'confirm');
  assert.equal(VOICE_WORK_ACTION_RISK.delegation_cancel, 'confirm');
  assert.equal(getVoiceAction('work').risk, 'confirm');
  const unknown = await makeHarness().work({ action: 'approve_plan' });
  assert.equal(unknown.ok, false);
});

test('registry and schemas contain no plan approval action', () => {
  const work = getVoiceAction('work');
  const enumValues = work.properties.action.enum;
  assert.deepEqual(enumValues, [...VOICE_WORK_ACTIONS]);
  const forbidden = /approv|plan|accept|grant/i;
  for (const value of enumValues) assert.doesNotMatch(value, forbidden, value);
  for (const key of Object.keys(work.properties)) assert.doesNotMatch(key, /approv|plan/i, key);
  for (const action of VOICE_ACTIONS) {
    assert.doesNotMatch(action.id, /plan_approv|approve_plan|approved_at|plan\.approvedAt/i, action.id);
  }
  const serialized = JSON.stringify([buildRealtimeTools(), toGeminiFunctionDeclarations()]);
  assert.doesNotMatch(serialized, /approvedAt/);
  assert.equal(resolveVoiceWorkAction('approve plan'), '');
  assert.equal(resolveVoiceWorkAction('zatwierdz plan'), '');
});

test('todo_ready lists only ready leaves, capped and flagged untrusted', async () => {
  const { work } = makeHarness();
  const result = await work({ action: 'todo_ready' });
  assert.equal(result.ok, true);
  assert.equal(result.untrusted, true);
  assert.deepEqual(result.todos.map((todo) => todo.id), ['t1', 't2', 'c1']);
  const many = makeHarness({
    todos: Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, title: `Todo ${i} ${'y'.repeat(200)}`, status: 'ready' })),
  });
  const capped = await many.work({ action: 'todo_ready' });
  assert.ok(capped.todos.length <= 8);
  assert.equal(capped.truncated, true);
  assert.ok(JSON.stringify(capped).length <= 1200);
  assert.ok(capped.todos.every((todo) => todo.title.length <= 70));
  const none = await makeHarness({ todos: [] }).work({ action: 'todo_ready' });
  assert.equal(none.ready, 0);
});

test('todo_status resolves by id or diacritic-insensitive title and reports ambiguity', async () => {
  const { work } = makeHarness();
  assert.equal((await work({ action: 'todo_status', id: 't2' })).title, 'Add dark theme');
  const byTitle = await work({ action: 'todo_status', query: 'NAPRAWIC logowanie' });
  assert.equal(byTitle.id, 't1');
  assert.equal(byTitle.untrusted, true);
  assert.equal(matchVoiceTodo(TODOS, { query: 'naprawić' }).todo.id, 't1');
  assert.equal(matchVoiceTodo(TODOS, { query: 'LOGOWANIE' }).todo.id, 't1');
  const ambiguous = await work({ action: 'todo_status', query: 'thing' });
  assert.equal(ambiguous.needsClarification, true);
  assert.equal((await work({ action: 'todo_status', query: 'nonexistent' })).ok, false);
  assert.equal((await work({ action: 'todo_status' })).ok, false);
});

test('todo_start needs the confirming second step with the same id', async () => {
  const { state, work } = makeHarness();
  const first = await work({ action: 'todo_start', query: 'dark theme' });
  assert.equal(first.needsConfirm, true);
  assert.equal(first.id, 't2');
  assert.equal(first.untrusted, true);
  assert.equal(state.started.length, 0);
  const second = await work({ action: 'todo_start', id: 't2', confirm: true });
  assert.equal(second.ok, true);
  assert.deepEqual(state.started, ['t2']);
  // The window is consumed: repeating the confirm does nothing.
  const again = await work({ action: 'todo_start', id: 't2', confirm: true });
  assert.equal(again.ok, false);
  assert.deepEqual(state.started, ['t2']);
});

test('todo_start refuses a bare confirm, a different id and a first call with confirm', async () => {
  const bare = makeHarness();
  assert.equal((await bare.work({ action: 'todo_start', confirm: true })).ok, false);
  assert.equal((await bare.work({ action: 'todo_start', id: 't2', confirm: true })).ok, false);
  assert.equal(bare.state.started.length, 0, 'confirm without a first step never acts');

  const mismatch = makeHarness();
  await mismatch.work({ action: 'todo_start', id: 't2' });
  const wrong = await mismatch.work({ action: 'todo_start', id: 't1', confirm: true });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /not the one described/);
  const noId = await mismatch.work({ action: 'todo_start', confirm: true });
  assert.equal(noId.ok, false);
  assert.equal(mismatch.state.started.length, 0);
  // The mismatch consumed the window, so the right id alone is not enough either.
  assert.equal((await mismatch.work({ action: 'todo_start', id: 't2', confirm: true })).ok, false);
  assert.equal(mismatch.state.started.length, 0);

  const bareYes = makeHarness();
  await bareYes.work({ action: 'todo_start', id: 't1' });
  const clarification = await bareYes.work({ action: 'todo_start', confirm: true });
  assert.equal(clarification.needsClarification, true);
  assert.equal(bareYes.state.started.length, 0);
});

test('todo_start is cancelled by a workspace or chat change between the steps', async () => {
  for (const change of [{ workspaceFolder: '/w/b' }, { chatId: 'chat-2' }]) {
    const { state, work } = makeHarness();
    await work({ action: 'todo_start', id: 't1' });
    Object.assign(state.context, change);
    const result = await work({ action: 'todo_start', id: 't1', confirm: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /changed/);
    assert.equal(state.started.length, 0);
  }
  const expired = makeHarness();
  await expired.work({ action: 'todo_start', id: 't1' });
  expired.state.clock += VOICE_WORK_CONFIRM_TTL_MS + 1;
  assert.equal((await expired.work({ action: 'todo_start', id: 't1', confirm: true })).ok, false);
  assert.equal(expired.state.started.length, 0);
  const otherAction = makeHarness();
  await otherAction.work({ action: 'todo_start', id: 't1' });
  await otherAction.work({ action: 'watcher_status' });
  assert.equal((await otherAction.work({ action: 'todo_start', id: 't1', confirm: true })).ok, false);
});

test('todo_start never starts doing, done, blocked or parent todos', async () => {
  const { state, work } = makeHarness();
  for (const id of ['t3', 't4', 'p1']) {
    const result = await work({ action: 'todo_start', id });
    assert.equal(result.ok, false, id);
    assert.equal(result.needsConfirm, undefined, id);
  }
  assert.equal(state.started.length, 0);
});

test('watcher status, pause and resume', async () => {
  const { state, work } = makeHarness();
  const status = await work({ action: 'watcher_status' });
  assert.deepEqual(
    { mode: status.mode, paused: status.paused, activeCycles: status.activeCycles },
    { mode: 'autopilot', paused: false, activeCycles: 1 }
  );
  assert.equal((await work({ action: 'watcher_pause' })).paused, true);
  assert.equal((await work({ action: 'watcher_resume' })).paused, false);
  assert.deepEqual(state.paused, [true, false]);
  const missing = await makeHarness({ watcher: null }).work({ action: 'watcher_status' });
  assert.equal(missing.ok, false);
  const failing = createWorkToolHandlers({
    getContext: () => ({}), listTodos: () => [], startTodo: () => ({}), getWatcherView: () => null,
    setWatcherPaused: () => ({ ok: false, error: 'boom' }), listDelegations: () => [], cancelDelegation: () => ({}),
  });
  assert.equal((await failing.work({ action: 'watcher_pause' })).ok, false);
});

test('delegation_status lists active ones, flags untrusted text and caps the result', async () => {
  const { work } = makeHarness();
  const listed = await work({ action: 'delegation_status' });
  assert.equal(listed.active, 1);
  assert.equal(listed.untrusted, true);
  assert.deepEqual(listed.delegations.map((row) => row.id), ['d1']);
  assert.equal((await work({ action: 'delegation_status', id: 'd2' })).status, 'completed');
  assert.equal((await work({ action: 'delegation_status', id: 'zzz' })).ok, false);
  const many = makeHarness({
    delegations: Array.from({ length: 20 }, (_, i) => ({ id: `d-${i}`, status: 'running', active: true, assignment: 'implement', executor: { transport: 't'.repeat(80) } })),
  });
  const capped = await many.work({ action: 'delegation_status' });
  assert.ok(capped.delegations.length <= 8);
  assert.equal(capped.truncated, true);
  assert.ok(JSON.stringify(capped).length <= 1200);
  assert.equal((await makeHarness({ delegations: [] }).work({ action: 'delegation_status' })).active, 0);
});

test('delegation_cancel needs the confirming second step with the same id', async () => {
  const { state, work } = makeHarness();
  const first = await work({ action: 'delegation_cancel' });
  assert.equal(first.needsConfirm, true);
  assert.equal(first.id, 'd1');
  assert.equal(state.cancelled.length, 0);
  const second = await work({ action: 'delegation_cancel', id: 'd1', confirm: true });
  assert.equal(second.ok, true);
  assert.deepEqual(state.cancelled, ['d1']);
  assert.equal((await work({ action: 'delegation_cancel', id: 'd1', confirm: true })).ok, false);
  assert.deepEqual(state.cancelled, ['d1']);
});

test('delegation_cancel refuses bare confirm, other id, context change and inactive rows', async () => {
  const bare = makeHarness();
  assert.equal((await bare.work({ action: 'delegation_cancel', id: 'd1', confirm: true })).ok, false);
  assert.equal(bare.state.cancelled.length, 0);

  const mismatch = makeHarness({
    delegations: [
      { id: 'd1', status: 'running', active: true, assignment: 'implement', executor: {} },
      { id: 'd3', status: 'running', active: true, assignment: 'review', executor: {} },
    ],
  });
  const ambiguous = await mismatch.work({ action: 'delegation_cancel' });
  assert.equal(ambiguous.needsClarification, true);
  await mismatch.work({ action: 'delegation_cancel', id: 'd1' });
  assert.equal((await mismatch.work({ action: 'delegation_cancel', id: 'd3', confirm: true })).ok, false);
  assert.equal((await mismatch.work({ action: 'delegation_cancel', confirm: true })).ok, false);
  assert.equal(mismatch.state.cancelled.length, 0);

  const moved = makeHarness();
  await moved.work({ action: 'delegation_cancel', id: 'd1' });
  moved.state.context.workspaceFolder = '/w/other';
  assert.equal((await moved.work({ action: 'delegation_cancel', id: 'd1', confirm: true })).ok, false);
  assert.equal(moved.state.cancelled.length, 0);

  const finished = makeHarness();
  const inactive = await finished.work({ action: 'delegation_cancel', id: 'd2' });
  assert.equal(inactive.ok, false);
  assert.equal(inactive.needsConfirm, undefined);
  const stale = makeHarness();
  await stale.work({ action: 'delegation_cancel', id: 'd1' });
  stale.state.delegations[0].active = false;
  assert.equal((await stale.work({ action: 'delegation_cancel', id: 'd1', confirm: true })).ok, false);
  assert.equal(stale.state.cancelled.length, 0);
});

test('Polish spoken action aliases resolve with diacritics', () => {
  assert.equal(resolveVoiceWorkAction('wznów watchera'), 'watcher_resume');
  assert.equal(resolveVoiceWorkAction('Wstrzymaj watchera'), 'watcher_pause');
  assert.equal(resolveVoiceWorkAction('anuluj delegację'), 'delegation_cancel');
  assert.equal(resolveVoiceWorkAction('przerwij delegację'), 'delegation_cancel');
  assert.equal(resolveVoiceWorkAction('status delegacji'), 'delegation_status');
  assert.equal(resolveVoiceWorkAction('gotowe zadania'), 'todo_ready');
  assert.equal(resolveVoiceWorkAction('todo_start'), 'todo_start');
  assert.equal(resolveVoiceWorkAction(''), '');
});

test('work is registered, localized and reachable through the client', async () => {
  assert.ok(en.voice.command.work);
  assert.ok(pl.voice.command.work);
  assert.ok(capVoiceResult({ a: 1 }));
  const result = await executeRealtimeTool('work', { action: 'nope' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Action must be one of/);
});

test('todo_start never claims started when the start path fails', async () => {
  for (const error of ['The worktree has uncommitted changes.', 'API key required', 'Could not start']) {
    const state = { clock: 1000 };
    const handlers = createWorkToolHandlers({
      getContext: () => ({ workspaceFolder: '/w/a', chatId: 'c' }),
      listTodos: () => structuredClone(TODOS),
      startTodo: () => ({ ok: false, error }),
      getWatcherView: () => null,
      setWatcherPaused: () => ({ ok: true }),
      listDelegations: () => [],
      cancelDelegation: () => ({ ok: true }),
      now: () => state.clock,
    });
    await handlers.work({ action: 'todo_start', id: 't2' });
    const result = await handlers.work({ action: 'todo_start', id: 't2', confirm: true });
    assert.equal(result.ok, false);
    assert.notEqual(result.started, true);
    assert.match(result.error, new RegExp(error.slice(0, 10)));
  }
});

test('startTodo receives the context bound at step one (same workspace folder)', async () => {
  const seen = [];
  const handlers = createWorkToolHandlers({
    getContext: () => ({ workspaceFile: '/w/bound.code-workspace', workspaceFolder: '/w/bound', chatId: 'c' }),
    listTodos: () => structuredClone(TODOS),
    startTodo: ({ todo, context }) => { seen.push({ id: todo.id, context }); return { ok: true }; },
    getWatcherView: () => null,
    setWatcherPaused: () => ({ ok: true }),
    listDelegations: () => [],
    cancelDelegation: () => ({ ok: true }),
  });
  await handlers.work({ action: 'todo_start', id: 't2' });
  await handlers.work({ action: 'todo_start', id: 't2', confirm: true });
  assert.deepEqual(seen, [{
    id: 't2',
    context: { workspaceFile: '/w/bound.code-workspace', workspaceFolder: '/w/bound', chatId: 'c' },
  }]);
});

test('a workspace change between the steps keeps the file/folder pair bound at step one', async () => {
  const seen = [];
  const state = {
    context: { workspaceFile: '/w/a.code-workspace', workspaceFolder: '/w/a', chatId: 'c' },
  };
  const handlers = createWorkToolHandlers({
    getContext: () => ({ ...state.context }),
    listTodos: () => structuredClone(TODOS),
    startTodo: ({ todo, context }) => { seen.push({ id: todo.id, context }); return { ok: true }; },
    getWatcherView: () => null,
    setWatcherPaused: () => ({ ok: true }),
    listDelegations: () => [],
    cancelDelegation: () => ({ ok: true }),
  });
  await handlers.work({ action: 'todo_start', id: 't2' });
  // The header now points at another workspace file while the bound folder and
  // chat stay the same; the start must use the pair the user confirmed.
  state.context.workspaceFile = '/w/b.code-workspace';
  const result = await handlers.work({ action: 'todo_start', id: 't2', confirm: true });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{
    id: 't2',
    context: { workspaceFile: '/w/a.code-workspace', workspaceFolder: '/w/a', chatId: 'c' },
  }]);
});

function makeStartDeps(overrides = {}) {
  const calls = { start: [], poll: [], render: 0, opened: [], shown: 0 };
  const deps = {
    findItem: () => ({ id: 't2' }),
    resolveHarness: () => 'codex',
    isSdkReady: () => true,
    startAgent: async (id, body) => { calls.start.push({ id, body }); return { ok: true, chat: { id: 'c9' }, initialPrompt: 'Do it', reused: false }; },
    pollStatus: async (id, folder) => { calls.poll.push({ id, folder }); return { ok: true, chat: { id: 'c9' }, initialPrompt: 'Polled' }; },
    renderList: () => { calls.render += 1; },
    openChat: (chat, options) => { calls.opened.push({ chat, options }); },
    showChatPanel: () => { calls.shown += 1; },
    messages: { sdkRequiresApiKey: 'needs key', startFailed: 'start failed', networkError: 'network' },
    ...overrides,
  };
  return { deps, calls };
}

const START_OPTIONS = { workspaceFile: '/w/a.code-workspace', workspaceFolder: '/w/a' };

test('voice todo start hands the initial prompt to the opened chat', async () => {
  const { startTodoForVoice } = await import('../app_front/features/todo/todoVoiceStart.js');
  const { deps, calls } = makeStartDeps();
  const result = await startTodoForVoice('t2', { ...START_OPTIONS, agentTransport: 'codex' }, deps);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.start[0].body.model, 'auto');
  assert.equal(calls.start[0].body.agentTransport, 'codex');
  assert.equal(calls.start[0].body.workspaceFolder, '/w/a');
  assert.deepEqual(calls.opened[0].options, { initialPrompt: 'Do it', reused: false });
  assert.equal(calls.shown, 1);
});

test('voice todo start polls while the worktree is preparing', async () => {
  const { startTodoForVoice } = await import('../app_front/features/todo/todoVoiceStart.js');
  const { deps, calls } = makeStartDeps({ startAgent: async () => ({ ok: true, state: 'preparing' }) });
  const result = await startTodoForVoice('t2', START_OPTIONS, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.poll, [{ id: 't2', folder: '/w/a' }]);
  assert.equal(calls.opened[0].options.initialPrompt, 'Polled');
});

test('voice todo start reports not started for dirty, not-ready, SDK and network failures', async () => {
  const { startTodoForVoice } = await import('../app_front/features/todo/todoVoiceStart.js');
  const cases = [
    [{ startAgent: async () => ({ ok: false, code: 'WORKTREE_DIRTY' }) }, 'WORKTREE_DIRTY', /uncommitted/],
    [{ startAgent: async () => ({ ok: true, state: 'ready' }) }, undefined, /start failed/],
    [{ startAgent: async () => ({ ok: false, error: 'blocked' }) }, undefined, /blocked/],
    [{ startAgent: async () => { throw new Error('down'); } }, undefined, /network/],
    [{ resolveHarness: () => 'sdk', isSdkReady: () => false }, 'SDK_NOT_READY', /needs key/],
  ];
  for (const [overrides, code, pattern] of cases) {
    const { deps, calls } = makeStartDeps(overrides);
    const result = await startTodoForVoice('t2', START_OPTIONS, deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.match(result.error, pattern);
    assert.equal(calls.opened.length, 0);
    assert.equal(calls.shown, 0);
  }
});

test('the wired startTodo uses the bound context folder and the panel adapter', async () => {
  const { readFile } = await import('node:fs/promises');
  const tools = await readFile(new URL('../app_front/features/voice/realtimeTools.js', import.meta.url), 'utf8');
  assert.match(tools, /startTodoAgentForVoice\(/);
  assert.doesNotMatch(tools, /postTodoStartAgent/);
  assert.match(tools, /context\?\.workspaceFolder/);
  assert.match(tools, /context\?\.workspaceFile/);
  // The workspace file is captured in getContext (step one), not read from the
  // header trigger inside startTodo (step two).
  assert.match(tools, /workspaceFile: trigger\?\.dataset\?\.workspaceFile/);
  assert.equal((tools.match(/trigger\?\.dataset\?\.workspaceFile/g) || []).length, 1);
});

test('another voice tool between the two steps clears the pending confirmation', async () => {
  const state = { started: [] };
  const handlers = createWorkToolHandlers({
    getContext: () => ({ workspaceFolder: '/w/a', chatId: 'c' }),
    listTodos: () => structuredClone(TODOS),
    startTodo: ({ todo }) => { state.started.push(todo.id); return { ok: true }; },
    getWatcherView: () => null,
    setWatcherPaused: () => ({ ok: true }),
    listDelegations: () => [],
    cancelDelegation: () => ({ ok: true }),
  });
  await handlers.work({ action: 'todo_start', id: 't2' });
  handlers.cancelPending();
  const result = await handlers.work({ action: 'todo_start', id: 't2', confirm: true });
  assert.equal(result.ok, false);
  assert.deepEqual(state.started, []);
  const { readFile } = await import('node:fs/promises');
  const tools = await readFile(new URL('../app_front/features/voice/realtimeTools.js', import.meta.url), 'utf8');
  assert.match(tools, /name !== 'work'\) workTools\.cancelPending\(\)/);
});

test('behavior-critical tool hints stay in the registry descriptions', () => {
  const text = (id) => getVoiceAction(id).description;
  assert.match(text('send_prompt'), /Repeat the prompt back briefly before sending/);
  assert.match(text('set_model'), /Never claim the model changed until this returns ok:true/);
  assert.match(text('set_model'), /do not call list_models first/);
  assert.match(JSON.stringify(getVoiceAction('set_chat_mode').properties), /agent = implement/);
  assert.match(JSON.stringify(getVoiceAction('create_chat').properties), /shop, libs, cretli/);
  assert.match(JSON.stringify(getVoiceAction('switch_workspace').properties), /shop, libs, cretli/);
  assert.match(text('delete_chat'), /confirm=true/);
});
