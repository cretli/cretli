import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { commandHandlers, createCommandHandlers } from '../app_front/features/voice/commandHandlers.js';
import { createLocalExecutors, matchLocalCommand, runLocalCommand } from '../app_front/features/voice/localCommands.js';
import { executeRealtimeTool, noteRealtimeUserSpeech, setRealtimeConfirmGuard } from '../app_front/features/voice/realtimeTools.js';
import { createConfirmGuard } from '../app_front/features/voice/voiceConfirmGuard.js';
import { quickCommandTarget } from '../app_front/features/voice/voiceOpsDeps.js';
import {
  VOICE_OPS_ACTIONS,
  VOICE_OPS_CONFIRM_TTL_MS,
  countGitChanges,
  createOpsToolHandlers,
  describeOpsResult,
  isQuickCommandBlockedByVoice,
  matchQuickCommand,
  parseAheadBehind,
  resolveVoiceOpsAction,
} from '../app_front/features/voice/voiceOpsTools.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { VOICE_ACTIONS, buildRealtimeTools, getVoiceAction } from '../lib/voice/action-registry.ts';
import { buildGeminiLiveSetup, toGeminiFunctionDeclarations } from '../lib/voice/gemini-live-config.ts';
import { REALTIME_TOOLS, buildRealtimeClientSecretBody } from '../lib/voice/realtime-session-config.ts';
import { loadCorpus, validateCorpus } from '../scripts/voice-control-benchmark.mjs';

const STATUS_LINES = [' M app_front/secret/path.js', 'M  lib/other.ts', '?? notes/todo.txt', '?? tmp.log'];

function makeOps(overrides = {}) {
  const clock = { time: 1000 };
  const state = {
    context: { workspaceFolder: '/w/shop', chatId: 'c1', scopeKey: 'k1' },
    info: { ok: true, isRepo: true, branch: 'feature/login', upstream: 'origin/feature/login', aheadBehind: 'ahead 2, behind 1', statusShort: STATUS_LINES },
    runs: [{ runId: 'r1', taskLabel: 'Build' }, { runId: 'r2', taskLabel: 'Dev server' }],
    quick: ['git status', 'npm run dev', 'git pull'],
    plan: { ok: true, fingerprint: 'fp1', changed: 2, untracked: 2, sensitiveFiles: 0, largeFiles: 0 },
    target: 'keys',
    draftEmpty: true,
    commits: [],
    fingerprints: [],
    stopped: [],
    ran: [],
    ...overrides,
  };
  const handlers = createOpsToolHandlers({
    getContext: () => state.context,
    getGitInfo: () => state.info,
    getCommitPlan: () => state.plan,
    commitAll: async (message, fingerprint) => { state.commits.push(message); state.fingerprints.push(fingerprint); return { ok: true, head: 'abc1234' }; },
    isDraftFieldEmpty: () => state.draftEmpty,
    listTaskRuns: () => state.runs,
    stopTaskRun: async (runId) => { state.stopped.push(runId); return { ok: true }; },
    listQuickCommands: () => state.quick,
    getQuickTarget: () => state.target,
    runQuickCommand: async (text) => { state.ran.push(text); return { ok: true }; },
    now: () => clock.time,
  });
  return { state, handlers, clock };
}

test('registry: one flat family tool, confirm risk, same shape for OpenAI and Gemini', () => {
  const action = getVoiceAction('ops');
  assert.equal(action.risk, 'confirm');
  assert.deepEqual(action.required, ['action']);
  assert.deepEqual(action.properties.action.enum, [...VOICE_OPS_ACTIONS]);
  assert.deepEqual(Object.keys(action.properties), ['action', 'message', 'name', 'id', 'confirm']);
  const openai = buildRealtimeTools().find((tool) => tool.name === 'ops');
  assert.equal(openai.parameters.additionalProperties, false);
  assert.deepEqual(openai.parameters.properties, action.properties);
  const gemini = toGeminiFunctionDeclarations().find((tool) => tool.name === 'ops');
  assert.equal('additionalProperties' in gemini.parameters, false);
  assert.equal(gemini.description, action.description);
  // The schema stays small: one family instead of five tools (chars/4 estimate, see docs §9c).
  assert.ok(JSON.stringify(buildRealtimeTools().find((tool) => tool.name === 'ops')).length / 4 < 220);
});

test('no push or merge exists in the registry or in either Realtime declaration', () => {
  const forbidden = /push|merge/i;
  for (const entry of VOICE_ACTIONS) {
    assert.doesNotMatch(entry.id, forbidden, entry.id);
    assert.doesNotMatch(JSON.stringify(entry), forbidden, `registry ${entry.id}`);
  }
  assert.doesNotMatch(JSON.stringify(REALTIME_TOOLS), forbidden, 'OpenAI tools');
  assert.doesNotMatch(JSON.stringify(buildRealtimeClientSecretBody({}).session.tools), forbidden, 'OpenAI session tools');
  assert.doesNotMatch(JSON.stringify(toGeminiFunctionDeclarations()), forbidden, 'Gemini declarations');
  assert.doesNotMatch(JSON.stringify(buildGeminiLiveSetup({}).setup.tools), forbidden, 'Gemini setup tools');
  for (const name of VOICE_OPS_ACTIONS) assert.doesNotMatch(name, forbidden, name);
  assert.equal(resolveVoiceOpsAction('push'), '');
  assert.equal(resolveVoiceOpsAction('merge'), '');
});

test('action names and spoken aliases resolve; unknown actions are refused', async () => {
  assert.equal(resolveVoiceOpsAction('git status'), 'git_status');
  assert.equal(resolveVoiceOpsAction('Git-Commit'), 'git_commit');
  assert.equal(resolveVoiceOpsAction('szybkie komendy'), 'quick_list');
  assert.equal(resolveVoiceOpsAction('stop task'), 'task_stop');
  const { handlers } = makeOps();
  assert.equal((await handlers.ops({ action: 'git_push' })).ok, false);
});

test('git status: counts, branch and ahead/behind, never a path', async () => {
  const { handlers } = makeOps();
  const result = await handlers.ops({ action: 'git_status' });
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'feature/login');
  assert.equal(result.changed, 2);
  assert.equal(result.untracked, 2);
  assert.equal(result.ahead, 2);
  assert.equal(result.behind, 1);
  assert.equal(result.clean, false);
  assert.equal(result.untrusted, true);
  assert.doesNotMatch(JSON.stringify(result), /secret|path\.js|notes|tmp\.log/);
  assert.deepEqual(countGitChanges(STATUS_LINES), { changed: 2, untracked: 2 });
  assert.deepEqual(parseAheadBehind('behind 3'), { ahead: 0, behind: 3 });
  assert.deepEqual(parseAheadBehind(''), { ahead: 0, behind: 0 });
});

test('git status: clean tree, no repository and API failure', async () => {
  assert.equal((await makeOps({ info: { ok: true, isRepo: true, branch: 'main', statusShort: [] } }).handlers.ops({ action: 'git_status' })).clean, true);
  const noRepo = await makeOps({ info: { ok: true, isRepo: false } }).handlers.ops({ action: 'git_status' });
  assert.equal(noRepo.code, 'no_repo');
  const failed = await makeOps({ info: { ok: false, error: 'boom' } }).handlers.ops({ action: 'git_status' });
  assert.equal(failed.ok, false);
  assert.equal((await makeOps({ info: null }).handlers.ops({ action: 'git_status' })).code, 'git_unavailable');
});

test('git commit is two-step: the first call only reads back, the second commits once', async () => {
  const { handlers, state } = makeOps();
  const first = await handlers.ops({ action: 'git_commit', message: 'fix login redirect' });
  assert.equal(first.needsConfirm, true);
  assert.ok(first.id);
  assert.equal(first.changed, 2);
  assert.equal(first.untracked, 2);
  assert.equal(first.message, 'fix login redirect');
  assert.deepEqual(state.commits, [], 'step one commits nothing');
  const second = await handlers.ops({ action: 'git_commit', confirm: true, id: first.id });
  assert.equal(second.ok, true);
  assert.equal(second.committed, true);
  assert.deepEqual(state.commits, ['fix login redirect']);
  // One use only.
  const replay = await handlers.ops({ action: 'git_commit', confirm: true, id: first.id });
  assert.equal(replay.ok, false);
  assert.deepEqual(state.commits, ['fix login redirect']);
});

test('git commit confirm flow: missing id, stale id, no first step, other action in between, expiry, context', async () => {
  const { handlers, state, clock } = makeOps();
  const ask = async (message = 'wip') => (await handlers.ops({ action: 'git_commit', message })).id;

  // Confirm without a first step.
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: true, id: 'commit1' })).code, 'no_pending');
  // Missing id (a bare yes).
  await ask();
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: true })).code, 'no_id');
  // Stale / foreign id.
  await ask();
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: true, id: 'commit999' })).code, 'id_mismatch');
  // Another ops action in between drops the binding.
  const id = await ask();
  await handlers.ops({ action: 'git_status' });
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: true, id })).code, 'no_pending');
  // Expired window.
  const late = await ask();
  clock.time += VOICE_OPS_CONFIRM_TTL_MS + 1;
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: true, id: late })).code, 'expired');
  // Workspace changed.
  const moved = await ask();
  state.context = { ...state.context, workspaceFolder: '/w/other' };
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: true, id: moved })).code, 'context_changed');
  state.context = { ...state.context, workspaceFolder: '/w/shop', scopeKey: 'k2' };
  const rescoped = await ask();
  state.context = { ...state.context, scopeKey: 'k3' };
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: true, id: rescoped })).code, 'context_changed');
  state.context = { ...state.context, scopeKey: 'k1' };
  // A different message at step two is refused.
  const read = await ask('fix login');
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: true, id: read, message: 'drop database' })).code, 'message_changed');
  // The read-back message is committed even when step two omits it.
  const ok = await ask('fix login');
  assert.equal((await handlers.ops({ action: 'git_commit', confirm: 'true', id: ok })).ok, true);
  assert.deepEqual(state.commits, ['fix login']);
});

test('git commit: no message asks for one, nothing to commit, commit failure is reported', async () => {
  const { handlers } = makeOps();
  const noMessage = await handlers.ops({ action: 'git_commit' });
  assert.equal(noMessage.code, 'no_message');
  assert.equal(noMessage.needsClarification, true);
  const clean = await makeOps({ plan: { ok: true, fingerprint: 'f', changed: 0, untracked: 0, sensitiveFiles: 0, largeFiles: 0 } }).handlers.ops({ action: 'git_commit', message: 'x' });
  assert.equal(clean.code, 'nothing_to_commit');
  const failing = createOpsToolHandlers({
    getContext: () => ({ workspaceFolder: '/w', chatId: 'c', scopeKey: 'k' }),
    getGitInfo: () => ({ ok: true, isRepo: true, branch: 'main', statusShort: ['M a'] }),
    getCommitPlan: () => ({ ok: true, fingerprint: 'f', changed: 1, untracked: 0, sensitiveFiles: 0, largeFiles: 0 }),
    commitAll: async () => ({ ok: false, error: 'hook failed' }),
  });
  const step = await failing.ops({ action: 'git_commit', message: 'x' });
  const done = await failing.ops({ action: 'git_commit', confirm: true, id: step.id });
  assert.equal(done.ok, false);
  assert.equal(done.code, 'commit_failed');
});

test('Realtime: confirm needs driver speech after the question', async () => {
  const clock = { time: 1000 };
  const guard = createConfirmGuard({ now: () => clock.time });
  const driverConfirm = { ask: (a, t) => guard.askConfirm(a, t), consume: (a, t) => guard.consumeConfirm(a, t) };
  const { handlers, state } = makeOps();
  const first = await handlers.ops({ action: 'git_commit', message: 'ship it' }, { driverConfirm });
  clock.time += 2000;
  // The model confirms by itself: no driver speech in between.
  const refused = await handlers.ops({ action: 'git_commit', confirm: true, id: first.id }, { driverConfirm });
  assert.equal(refused.code, 'no_driver_answer');
  assert.deepEqual(state.commits, []);
  // Again, this time the driver answers.
  const second = await handlers.ops({ action: 'git_commit', message: 'ship it' }, { driverConfirm });
  guard.noteUserSpeech();
  clock.time += 2000;
  const done = await handlers.ops({ action: 'git_commit', confirm: true, id: second.id }, { driverConfirm });
  assert.equal(done.ok, true);
  assert.deepEqual(state.commits, ['ship it']);
});

test('executeRealtimeTool reaches ops with the driver guard and drops the binding when another tool runs', async () => {
  const state = makeOps().state;
  const real = createCommandHandlers({ loadOpsDeps: async () => ({
    getContext: () => state.context,
    getGitInfo: () => state.info,
    getCommitPlan: () => state.plan,
    commitAll: async (message) => { state.commits.push(message); return { ok: true }; },
    listTaskRuns: () => state.runs,
    stopTaskRun: async (runId) => { state.stopped.push(runId); return { ok: true }; },
    listQuickCommands: () => state.quick,
    getQuickTarget: () => state.target,
    runQuickCommand: async (text) => { state.ran.push(text); return { ok: true }; },
  }) });
  const originals = { ops: commandHandlers.ops, cancelOps: commandHandlers.cancelOps };
  commandHandlers.ops = real.ops;
  commandHandlers.cancelOps = real.cancelOps;
  const clock = { time: 1000 };
  setRealtimeConfirmGuard(createConfirmGuard({ now: () => clock.time }));
  try {
    // Without driver speech the model alone cannot commit.
    const a = await executeRealtimeTool('ops', { action: 'git_commit', message: 'one' });
    clock.time += 2000;
    assert.equal((await executeRealtimeTool('ops', { action: 'git_commit', confirm: true, id: a.id })).code, 'no_driver_answer');
    // Another voice tool between the two steps closes the confirmation.
    const b = await executeRealtimeTool('ops', { action: 'git_commit', message: 'two' });
    await executeRealtimeTool('app_status', { action: 'cost' });
    noteRealtimeUserSpeech();
    clock.time += 2000;
    assert.equal((await executeRealtimeTool('ops', { action: 'git_commit', confirm: true, id: b.id })).code, 'no_pending');
    // The happy path.
    const c = await executeRealtimeTool('ops', { action: 'git_commit', message: 'three' });
    noteRealtimeUserSpeech();
    clock.time += 2000;
    assert.equal((await executeRealtimeTool('ops', { action: 'git_commit', confirm: true, id: c.id })).ok, true);
    assert.deepEqual(state.commits, ['three']);
  } finally {
    Object.assign(commandHandlers, originals);
    setRealtimeConfirmGuard(null);
  }
});

test('task stop: by name, one running task without a name, candidates when ambiguous', async () => {
  const { handlers, state } = makeOps();
  const ambiguous = await handlers.ops({ action: 'task_stop' });
  assert.equal(ambiguous.code, 'ambiguous');
  assert.deepEqual(ambiguous.candidates, ['Build', 'Dev server']);
  assert.equal(ambiguous.id, undefined);
  assert.equal((await handlers.ops({ action: 'task_stop', name: 'deploy' })).code, 'not_found');

  const first = await handlers.ops({ action: 'task_stop', name: 'dev' });
  assert.equal(first.needsConfirm, true);
  assert.equal(first.task, 'Dev server');
  assert.deepEqual(state.stopped, []);
  const done = await handlers.ops({ action: 'task_stop', confirm: true, id: first.id });
  assert.equal(done.stopped, true);
  assert.deepEqual(state.stopped, ['r2']);

  const single = makeOps({ runs: [{ runId: 'r9', taskLabel: 'Watch' }] });
  const step = await single.handlers.ops({ action: 'task_stop' });
  assert.equal(step.task, 'Watch');
  assert.equal((await makeOps({ runs: [] }).handlers.ops({ action: 'task_stop' })).code, 'none_running');
});

test('task stop: a run that ended or an id of another action does nothing', async () => {
  const { handlers, state } = makeOps();
  const step = await handlers.ops({ action: 'task_stop', name: 'build' });
  state.runs = [];
  assert.equal((await handlers.ops({ action: 'task_stop', confirm: true, id: step.id })).code, 'not_running');
  assert.deepEqual(state.stopped, []);
  const again = makeOps();
  const commit = await again.handlers.ops({ action: 'git_commit', message: 'x' });
  assert.equal((await again.handlers.ops({ action: 'task_stop', confirm: true, id: commit.id })).code, 'no_pending');
  assert.deepEqual(again.state.stopped, []);
});

test('quick commands: list is capped and untrusted; matching by number, fragment, ambiguity', async () => {
  const { handlers } = makeOps();
  const listed = await handlers.ops({ action: 'quick_list' });
  assert.deepEqual(listed.commands, ['git status', 'npm run dev', 'git pull']);
  assert.equal(listed.untrusted, true);
  const many = makeOps({ quick: Array.from({ length: 20 }, (_, index) => `cmd ${index}`) });
  const capped = await many.handlers.ops({ action: 'quick_list' });
  assert.ok(capped.commands.length <= 8);
  assert.equal(capped.total, 20);
  assert.equal((await makeOps({ quick: [] }).handlers.ops({ action: 'quick_list' })).total, 0);

  assert.deepEqual(matchQuickCommand(['git status', 'git pull'], '2'), { index: 1 });
  assert.deepEqual(matchQuickCommand(['git status', 'git pull'], 'Pull'), { index: 1 });
  assert.deepEqual(matchQuickCommand(['git status', 'git pull'], 'git').ambiguous, ['git status', 'git pull']);
  assert.equal(matchQuickCommand(['git status'], '5').missing, true);
});

test('quick run: terminal keys need the two-step confirm, the chat field only drafts', async () => {
  const keys = makeOps({ target: 'keys' });
  const ambiguous = await keys.handlers.ops({ action: 'quick_run', name: 'git' });
  assert.equal(ambiguous.code, 'ambiguous');
  assert.deepEqual(keys.state.ran, []);
  const step = await keys.handlers.ops({ action: 'quick_run', name: 'npm run dev' });
  assert.equal(step.needsConfirm, true);
  assert.equal(step.command, 'npm run dev');
  assert.deepEqual(keys.state.ran, []);
  const done = await keys.handlers.ops({ action: 'quick_run', confirm: true, id: step.id });
  assert.equal(done.ran, true);
  assert.deepEqual(keys.state.ran, ['npm run dev']);

  const draft = makeOps({ target: 'draft' });
  const drafted = await draft.handlers.ops({ action: 'quick_run', name: '2' });
  assert.equal(drafted.drafted, true);
  assert.deepEqual(draft.state.ran, ['npm run dev']);

  assert.equal((await makeOps({ target: 'none' }).handlers.ops({ action: 'quick_run', name: '1' })).code, 'no_target');
  assert.equal((await keys.handlers.ops({ action: 'quick_run' })).code, 'no_name');
});

test('quick run: an edited list or a changed panel between the steps runs nothing', async () => {
  const edited = makeOps();
  const step = await edited.handlers.ops({ action: 'quick_run', name: 'npm run dev' });
  edited.state.quick = ['git status', 'npm run dev --watch', 'y'];
  assert.equal((await edited.handlers.ops({ action: 'quick_run', confirm: true, id: step.id })).code, 'list_changed');
  assert.deepEqual(edited.state.ran, []);

  const moved = makeOps();
  const second = await moved.handlers.ops({ action: 'quick_run', name: 'npm run dev' });
  moved.state.target = 'draft';
  assert.equal((await moved.handlers.ops({ action: 'quick_run', confirm: true, id: second.id })).code, 'panel_changed');
  assert.deepEqual(moved.state.ran, []);
});

test('quickCommandTarget mirrors the panel the quick-command bar delivers to', () => {
  const doc = (active) => ({ getElementById: (id) => ({ classList: { contains: () => id === active } }) });
  assert.equal(quickCommandTarget(doc('terminal-panel')), 'keys');
  assert.equal(quickCommandTarget(doc('tasks-panel')), 'keys');
  assert.equal(quickCommandTarget(doc('chat-panel')), 'draft');
  assert.equal(quickCommandTarget(doc('git-panel')), 'none');
  assert.equal(quickCommandTarget(null), 'none');
});

test('local phrases (PL and EN) reach only the safe ops actions', () => {
  const cases = [
    ['git status', { action: 'git_status' }],
    ['Git status!', { action: 'git_status' }],
    ["What's the git status?", { action: 'git_status' }],
    ['status gita', { action: 'git_status' }],
    ['Jaki jest status gita?', { action: 'git_status' }],
    ['co w gicie', { action: 'git_status' }],
    ['szybkie komendy', { action: 'quick_list' }],
    ['Quick commands', { action: 'quick_list' }],
    ['what quick commands do I have', { action: 'quick_list' }],
  ];
  for (const [phrase, args] of cases) {
    const command = matchLocalCommand(phrase);
    assert.equal(command?.action, 'ops', phrase);
    assert.deepEqual(command.args, args, phrase);
  }
});

test('false positives: sentences that merely mention git or commands stay prompts, confirm actions have no phrase', () => {
  for (const phrase of [
    'run git status and fix the conflict',
    'git status shows a conflict in the router',
    'quick commands are broken in the toolbar',
    'add a quick commands section to the settings page',
    'commit the changes',
    'commit everything with the message fix login',
    'zacommituj zmiany',
    'push to origin',
    'git push',
    'merge the branch',
    'stop the build task',
    'zatrzymaj zadanie build',
    'run quick command 2',
    'uruchom szybką komendę 2',
    'sprawdź status gita w skrypcie wdrożenia i napisz test',
  ]) {
    assert.equal(matchLocalCommand(phrase), null, phrase);
  }
});

test('Web Speech path: the phrase calls ops with the same arguments and speaks a localized message', async () => {
  const calls = [];
  const handlers = {
    ops: async (args) => {
      calls.push(args);
      return args.action === 'git_status'
        ? { ok: true, branch: 'main', changed: 2, untracked: 1, ahead: 1, behind: 0, clean: false }
        : { ok: true, total: 2, commands: ['git status', 'git pull'] };
    },
  };
  const executors = createLocalExecutors(handlers);
  const status = await runLocalCommand(matchLocalCommand('git status'), executors);
  const quick = await runLocalCommand(matchLocalCommand('szybkie komendy'), executors);
  assert.deepEqual(calls, [{ action: 'git_status' }, { action: 'quick_list' }]);
  assert.match(status.message, /main/);
  assert.match(quick.message, /git status, git pull/);
});

test('describeOpsResult: localized messages in PL and EN, errors mapped', () => {
  const makeT = (dict) => (key, params = {}) => key.split('.').reduce((node, part) => node?.[part], dict).replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
  for (const [dict, expectDirty] of [[en, /Branch main: 2 changed, 1 untracked\. 3 ahead\./], [pl, /Gałąź main: 2 zmienionych, 1 nieśledzonych\. 3 do przodu\./]]) {
    const t = makeT(dict);
    const dirty = describeOpsResult({ ok: true, branch: 'main', changed: 2, untracked: 1, ahead: 3, behind: 0, clean: false }, { action: 'git_status' }, t);
    assert.match(dirty.message, expectDirty);
    assert.ok(describeOpsResult({ ok: true, branch: 'main', clean: true, changed: 0, untracked: 0, ahead: 0, behind: 0 }, { action: 'git_status' }, t).message.includes('main'));
    assert.ok(describeOpsResult({ ok: true, total: 0 }, { action: 'quick_list' }, t).message.length > 0);
    assert.ok(describeOpsResult({ ok: false, code: 'no_repo' }, { action: 'git_status' }, t).error.length > 0);
  }
  assert.deepEqual(Object.keys(en.voice.ops).sort(), Object.keys(pl.voice.ops).sort());
  assert.ok(en.voice.command.ops && pl.voice.command.ops);
});

test('corpus: ops utterances match the schema, push and merge requests are no-call', () => {
  const corpus = loadCorpus();
  assert.deepEqual(validateCorpus(corpus), []);
  const ops = corpus.filter((item) => item.tool === 'ops');
  assert.ok(ops.length >= 6);
  for (const lang of ['pl', 'en']) assert.ok(ops.some((item) => item.lang === lang), lang);
  for (const action of VOICE_OPS_ACTIONS) assert.ok(ops.some((item) => item.args.action === action), action);
  for (const item of ops.filter((entry) => VOICE_OPS_ACTIONS.includes(entry.args.action) && entry.args.action !== 'git_status' && entry.args.action !== 'quick_list')) {
    assert.equal(item.target.risk, 'confirm', item.id);
  }
  const pushRequests = corpus.filter((item) => /push|wypchnij|zmerguj/i.test(item.text));
  assert.ok(pushRequests.length >= 2);
  for (const item of pushRequests) assert.equal(item.tool, null, item.id);
});

const BLOCKED_COMMANDS = [
  // Plain history changes.
  'git push', 'git  push', 'GIT PUSH --force', 'git push origin main', 'git -C ../app push', 'git pull', 'git pull --rebase',
  'git merge feature', 'git rebase -i HEAD~3', 'git reset --hard origin/main', 'git cherry-pick abc', 'git commit --amend -m x',
  'git commit -m wip', 'git checkout main', 'git branch -D old', 'git tag v1', 'git stash pop', 'git remote add x y', 'git clean -fd',
  'gh pr merge 12 --squash', 'gh repo sync', 'gh api -X PUT repos/a/b/merge', 'gh pr close 3',
  // Review bypasses: aliases, config, substitution, chaining, wrappers, quoting, globbing.
  'git -c alias.p=push p', 'git -c alias.p=!git\\ push p', 'git --config-env=alias.p=X p', 'git p', 'git $(echo push)', 'git `echo push`',
  'git ${CMD}', 'git $CMD', 'git status; git push', 'git status && git push', 'git status || git push', 'git status | git push',
  'git status & git push', 'git status\ngit push', 'git status > out.txt', 'git log < in.txt', 'sh -c "git push"', 'bash -c "git push"',
  'eval git push', 'echo push | xargs git', 'xargs git push', 'g""it push', "g'i't push", '/usr/bin/g?t push', 'git pu\\sh', '/usr/bin/git push',
  'FOO=1 git push', 'env git push',
  // Round 3: environment prefixes, launchers and any quote character.
  "GIT_PAGER='git push' git log", 'GIT_PAGER=cat git log', 'GIT_SSH_COMMAND=evil git fetch', 'GIT_CONFIG_PARAMETERS=x git status',
  'GIT_EXTERNAL_DIFF=evil git diff', 'NODE_OPTIONS=--inspect npm run dev', 'env GIT_PAGER=x git log', '/usr/bin/env git status', 'sudo git status',
  'doas git status', 'nohup git status', 'time git status', 'nice git status', 'ionice git status', 'timeout 5 git status', 'stdbuf -o0 git status',
  'command git status', 'builtin echo', 'setsid git status', 'chroot / git status', 'unbuffer git status', 'watch git status', 'script -c x', 'su root',
  'git log --grep "x"', "git log --grep 'x'", 'npm run "dev"', "echo 'hi'", 'git log --grep=a\\b', 'git', 'git --version', 'git log --output=/tmp/x', 'git diff --ext-diff', 'git fetch --upload-pack=evil',
  'git branch new-branch', 'git tag -d v1', 'git stash drop', 'git remote remove origin', 'gh', 'gh pr', 'gh --repo a/b pr list',
  // Round 5: the filter is an allowlist, so dashed binaries, grouping, refspecs, abbreviated or glued options,
  // late environment assignments, unknown launchers and flags before the gh verb are all refused.
  '/usr/lib/git-core/git-push origin main', 'git-push origin main', 'git-merge x', '(git push)', '( git push )', '!git push', '~/bin/push',
  'git fetch origin main:main', 'git fetch . +refs/heads/old:refs/heads/main', 'git fetch -u origin x:cur', 'git fetch origin main',
  'git fetch --upload-pa=./p .', 'git grep --op=rm TODO', 'git grep -lOrm TODO', 'git grep TODO', 'git log --outp=/tmp/x', 'git log -n x',
  'git log --grep fix', 'git -C ../app status', 'git -p log', 'git --no-pager -c x=y log', 'git log -- a', 'git diff --ext-diff',
  'git stash show', 'git shortlog', 'flock /tmp/l env GIT_EXTERNAL_DIFF=rm git diff', 'taskset 1 env GIT_SSH=./p git fetch',
  'strace git status', 'busybox sh', 'gh pr -b list merge 5', 'gh pr merge 5', 'npm run', 'npm run build -- --x', 'npm exec x',
  'npx x', 'npm install', 'pnpm lint --fix', 'make -f x y', 'make CC=x', 'node -e x', 'node ../x.js', 'node /tmp/x.js', 'node x',
  'docker compose up', 'FOO', 'rm -rf build', 'git\tpush',
];

test('F1: quick_run is fail-closed: every bypass of the review and every non-read-only git/gh command is refused', async () => {
  for (const command of BLOCKED_COMMANDS) {
    assert.equal(isQuickCommandBlockedByVoice(command), true, command);
    for (const target of ['keys', 'draft']) {
      const { handlers, state } = makeOps({ quick: [command, 'npm run dev'], target });
      const result = await handlers.ops({ action: 'quick_run', name: '1' });
      assert.equal(result.code, 'not_by_voice', `${target}: ${JSON.stringify(command)}`);
      assert.deepEqual(state.ran, [], command);
    }
  }
});

test('F1: the read-only allowlist and the user\'s own scripts still run', () => {
  for (const command of [
    'git status', 'git status -sb', 'npm run build:prod', 'git diff', 'git diff --staged', 'git log --oneline -n 5', 'git log -3', 'git show HEAD',
    'git log origin/main..HEAD', 'git fetch', 'git fetch origin', 'git fetch --prune origin', 'git branch', 'git branch -a',
    'git branch --show-current', 'git tag', 'git tag -l', 'git stash list', 'git remote -v', 'git --no-pager log', 'git blame a.js',
    'git ls-files', 'gh pr list', 'gh pr view 12', 'gh pr status', 'gh issue list', 'gh issue view 3', 'gh run list', 'gh run view 9 --log',
    'npm run dev', 'npm test', 'pnpm run lint', 'yarn test', 'make deploy', 'make build test', 'node scripts/build.mjs',
  ]) {
    assert.equal(isQuickCommandBlockedByVoice(command), false, command);
  }
});

test('F1: a list edited into a push command between the steps still runs nothing', async () => {
  const { handlers, state } = makeOps({ quick: ['git status', 'npm run dev', 'git pull'] });
  const step = await handlers.ops({ action: 'quick_run', name: 'npm run dev' });
  assert.equal(step.needsConfirm, true);
  state.quick = ['git status', 'git push', 'git pull'];
  assert.equal((await handlers.ops({ action: 'quick_run', confirm: true, id: step.id })).ok, false);
  assert.deepEqual(state.ran, []);
});

test('F2: the fingerprint read back at step one travels with the commit; counts come from the plan', async () => {
  const { handlers, state } = makeOps({ plan: { ok: true, fingerprint: 'abc', changed: 3, untracked: 40, sensitiveFiles: 0, largeFiles: 0 } });
  const step = await handlers.ops({ action: 'git_commit', message: 'wip' });
  assert.equal(step.untracked, 40, 'untracked directories are counted per file');
  state.plan = { ...state.plan, fingerprint: 'changed-later' };
  await handlers.ops({ action: 'git_commit', confirm: true, id: step.id });
  assert.deepEqual(state.fingerprints, ['abc'], 'step two sends the step-one fingerprint, not a fresh one');
});

test('F2/F3: sensitive files, large files, a busy workspace and a server tree_changed are surfaced, never committed', async () => {
  const sensitive = makeOps({ plan: { ok: true, fingerprint: 'f', changed: 1, untracked: 0, sensitiveFiles: 1, largeFiles: 0 } });
  assert.equal((await sensitive.handlers.ops({ action: 'git_commit', message: 'x' })).code, 'sensitive_files');
  const large = makeOps({ plan: { ok: true, fingerprint: 'f', changed: 1, untracked: 0, sensitiveFiles: 0, largeFiles: 2 } });
  assert.equal((await large.handlers.ops({ action: 'git_commit', message: 'x' })).code, 'large_files');
  const merging = makeOps({ plan: { ok: true, fingerprint: 'f', changed: 1, untracked: 0, sensitiveFiles: 0, largeFiles: 0, operationInProgress: true } });
  assert.equal((await merging.handlers.ops({ action: 'git_commit', message: 'x' })).code, 'operation_in_progress');
  const signed = makeOps({ plan: { ok: true, fingerprint: 'f', changed: 1, untracked: 0, sensitiveFiles: 0, largeFiles: 0, signingRequired: true } });
  assert.equal((await signed.handlers.ops({ action: 'git_commit', message: 'x' })).code, 'signing_required');
  const partial = makeOps({ plan: { ok: true, fingerprint: 'f', changed: 1, untracked: 0, sensitiveFiles: 0, largeFiles: 0, partiallyStaged: 2 } });
  const partialResult = await partial.handlers.ops({ action: 'git_commit', message: 'x' });
  assert.equal(partialResult.code, 'partially_staged');
  assert.equal(partialResult.count, 2);
  assert.deepEqual(merging.state.commits, []);
  const busy = makeOps({ plan: { ok: false, code: 'workspace_busy', error: 'Work is still running' } });
  const refused = await busy.handlers.ops({ action: 'git_commit', message: 'x' });
  assert.equal(refused.code, 'workspace_busy');
  assert.deepEqual(busy.state.commits, []);
  // The server's verdict at step two is passed on with its code.
  const failing = createOpsToolHandlers({
    getContext: () => ({ workspaceFolder: '/w', chatId: 'c', scopeKey: 'k' }),
    getGitInfo: () => ({ ok: true, isRepo: true, branch: 'main', statusShort: [] }),
    getCommitPlan: () => ({ ok: true, fingerprint: 'f', changed: 1, untracked: 0, sensitiveFiles: 0, largeFiles: 0 }),
    commitAll: async () => ({ ok: false, code: 'tree_changed', error: 'The files changed' }),
  });
  const step = await failing.ops({ action: 'git_commit', message: 'x' });
  assert.equal((await failing.ops({ action: 'git_commit', confirm: true, id: step.id })).code, 'tree_changed');
});

test('F7: the drafted path never overwrites a non-empty send field', async () => {
  const filled = makeOps({ target: 'draft', draftEmpty: false });
  const result = await filled.handlers.ops({ action: 'quick_run', name: 'npm run dev' });
  assert.equal(result.code, 'field_not_empty');
  assert.deepEqual(filled.state.ran, []);
  const empty = makeOps({ target: 'draft' });
  assert.equal((await empty.handlers.ops({ action: 'quick_run', name: 'npm run dev' })).drafted, true);
});

test('F1/F7: the new refusal codes have PL and EN texts', () => {
  const makeT = (dict) => (key) => key.split('.').reduce((node, part) => node?.[part], dict);
  for (const dict of [en, pl]) {
    for (const code of ['not_by_voice', 'field_not_empty', 'tree_changed', 'sensitive_files', 'large_files', 'workspace_busy', 'operation_in_progress', 'signing_required', 'partially_staged']) {
      const out = describeOpsResult({ ok: false, code }, { action: 'quick_run' }, makeT(dict));
      assert.ok(out.error && !out.error.startsWith('voice.'), code);
    }
  }
});

test('F6: buildOpsDeps maps the Git panel scope, plan, commit and quick-command helpers', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push([String(url), init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ ok: true, fingerprint: 'fp', changed: 1, untracked: 0, head: 'abc' }) };
  };
  try {
    const { setGitScope, resetGitScopeForTests } = await import('../app_front/features/git/gitScope.js');
    const { buildOpsDeps } = await import('../app_front/features/voice/voiceOpsDeps.js');
    resetGitScopeForTests();
    setGitScope({ workspaceFolder: '/w/shop' });
    const deps = buildOpsDeps();
    await deps.getCommitPlan().catch(() => null);
    await deps.commitAll('msg', 'fp').catch(() => null);
    const plan = requests.find(([url]) => url.includes('/api/git/commit-plan'));
    const commit = requests.find(([url]) => url.includes('/api/git/commit') && !url.includes('plan'));
    assert.ok(plan?.[0].includes('workspaceFolder=%2Fw%2Fshop'), 'plan carries the scope');
    assert.equal(commit?.[1], 'POST');
    assert.equal(commit?.[2].workspaceFolder, '/w/shop', 'commit body carries the scope');
    assert.equal(commit?.[2].fingerprint, 'fp');
    assert.equal(commit?.[2].message, 'msg');
    assert.equal(typeof deps.isDraftFieldEmpty, 'function');
    assert.ok(Array.isArray(deps.listQuickCommands()));
    resetGitScopeForTests();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
