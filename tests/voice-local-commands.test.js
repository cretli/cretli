import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandHandlers, createIdempotentRunner } from '../app_front/features/voice/commandHandlers.js';
import {
  LOCAL_COMMANDS,
  createLocalExecutors,
  matchLocalCommand,
  matchSendWindowCommand,
  normalizeSpokenText,
  runLocalCommand,
} from '../app_front/features/voice/localCommands.js';
import { listVoiceActionIds } from '../lib/voice/action-registry.ts';

test('every local command maps to a registry action with an executor', () => {
  const ids = new Set(listVoiceActionIds());
  const executors = createLocalExecutors();
  for (const command of LOCAL_COMMANDS) {
    assert.ok(ids.has(command.action), `${command.id} -> ${command.action} is not a registry action`);
    assert.equal(typeof executors[command.action], 'function', command.action);
  }
});

test('normalization strips diacritics, case and punctuation', () => {
  assert.equal(normalizeSpokenText('  Następny, AGENT! '), 'nastepny agent');
  assert.equal(normalizeSpokenText('Zatrzymaj się'), 'zatrzymaj sie');
});

test('whole-utterance commands match in Polish and English', () => {
  assert.equal(matchLocalCommand('Stop!').action, 'stop_agent');
  assert.equal(matchLocalCommand('zatrzymaj agenta').id, 'stop_agent');
  assert.deepEqual(matchLocalCommand('następny agent').args, { direction: 'next' });
  assert.deepEqual(matchLocalCommand('Previous chat').args, { direction: 'previous' });
  assert.deepEqual(matchLocalCommand('poprzedni czat').args, { direction: 'previous' });
  const sw = matchLocalCommand('przełącz na Pickera');
  assert.equal(sw.action, 'switch_chat');
  assert.deepEqual(sw.args, { title: 'pickera' });
  assert.equal(matchLocalCommand('switch to shop').args.title, 'shop');
});

test('sentences that merely start with a command word are prompts', () => {
  for (const text of ['stop using Redux in the store', 'next agent should retry the build', 'zatrzymaj się z refaktoryzacją i dodaj testy', 'please stop', '']) {
    assert.equal(matchLocalCommand(text), null, text);
  }
});

function makeChatModule() {
  const calls = [];
  const chats = [
    { id: 'a', title: 'Alpha chat' },
    { id: 'b', title: 'Beta chat' },
    { id: 'c', title: 'Gamma chat', archived: true },
  ];
  let active = 'a';
  const module = {
    calls,
    getChatsList: () => chats,
    getActiveChatIdValue: () => active,
    getChatListAgentStatePublic: () => 'idle',
    selectChat: (id) => { active = id; calls.push(['select', id]); },
    sendKeySequenceToActiveChat: (seq) => { calls.push(['keys', seq]); return true; },
    getActiveSendBar: () => ({
      input: { value: '' },
      submit() { calls.push(['submit', this.input.value]); },
    }),
    switchVoiceWorkspace: async (args) => { calls.push(['workspace', args.workspace]); return { ok: true }; },
  };
  return module;
}

test('local commands run through the shared handlers exactly once', async () => {
  const chatModule = makeChatModule();
  const handlers = createCommandHandlers({ loadChatModule: async () => chatModule });
  const executors = createLocalExecutors(handlers);

  assert.equal((await runLocalCommand(matchLocalCommand('stop'), executors)).ok, true);
  assert.deepEqual(chatModule.calls, [['keys', '\x03']]);

  chatModule.calls.length = 0;
  const next = await runLocalCommand(matchLocalCommand('następny agent'), executors);
  assert.equal(next.chatId, 'b');
  const wrapped = await runLocalCommand(matchLocalCommand('next agent'), executors);
  assert.equal(wrapped.chatId, 'a', 'archived chats are skipped and the list wraps');
  const back = await runLocalCommand(matchLocalCommand('previous agent'), executors);
  assert.equal(back.chatId, 'b');
  assert.equal(chatModule.calls.length, 3);
});

test('"switch to" prefers a chat title and falls back to a workspace', async () => {
  const chatModule = makeChatModule();
  const handlers = createCommandHandlers({ loadChatModule: async () => chatModule });
  const executors = createLocalExecutors(handlers);
  const chat = await runLocalCommand(matchLocalCommand('switch to beta'), executors);
  assert.equal(chat.chatId, 'b');
  const ws = await runLocalCommand(matchLocalCommand('switch to shop'), executors);
  assert.equal(ws.ok, true);
  assert.deepEqual(chatModule.calls.at(-1), ['workspace', 'shop']);
});

test('sendPrompt fills the active send bar and submits once', async () => {
  const chatModule = makeChatModule();
  const handlers = createCommandHandlers({ loadChatModule: async () => chatModule });
  const result = await handlers.sendPrompt('add tests');
  assert.equal(result.ok, true);
  assert.deepEqual(chatModule.calls, [['submit', 'add tests']]);
  assert.equal((await handlers.sendPrompt('  ')).ok, false);
});

test('the idempotent runner returns the first result inside the window and retries failures', async () => {
  let at = 0;
  const runOnce = createIdempotentRunner({ now: () => at, ttlMs: 1000 });
  let runs = 0;
  const run = async () => { runs += 1; return { ok: true, n: runs }; };
  assert.equal((await runOnce('k', run)).n, 1);
  assert.equal((await runOnce('k', run)).n, 1);
  at = 2000;
  assert.equal((await runOnce('k', run)).n, 2);
  let fails = 0;
  const failing = async () => { fails += 1; return { ok: false }; };
  await runOnce('f', failing);
  await Promise.resolve();
  await runOnce('f', failing);
  assert.equal(fails, 2);
});

test('CAR3: a double or parallel stop sends Ctrl-C once; the window then reopens', async () => {
  const chatModule = makeChatModule();
  let at = 1000;
  const handlers = createCommandHandlers({
    loadChatModule: async () => chatModule,
    runOnce: createIdempotentRunner({ now: () => at }),
  });
  const [a, b] = await Promise.all([handlers.stopAgent(), handlers.stopAgent()]);
  assert.equal(a.ok && b.ok, true);
  await handlers.stopAgent();
  assert.deepEqual(chatModule.calls, [['keys', '\x03']], 'one key sequence for three calls');
  at += 3000;
  await handlers.stopAgent();
  assert.equal(chatModule.calls.length, 2, 'a stop after the window is a new stop');
});

test('CAR3: the same prompt and the same switch twice inside the window run once', async () => {
  const chatModule = makeChatModule();
  const handlers = createCommandHandlers({ loadChatModule: async () => chatModule });
  await Promise.all([handlers.sendPrompt('add tests'), handlers.sendPrompt('add tests')]);
  assert.equal(chatModule.calls.filter((c) => c[0] === 'submit').length, 1);
  await handlers.sendPrompt('something else');
  assert.equal(chatModule.calls.filter((c) => c[0] === 'submit').length, 2);
  await Promise.all([handlers.switchChat({ chat_id: 'b' }), handlers.switchChat({ chat_id: 'b' })]);
  assert.equal(chatModule.calls.filter((c) => c[0] === 'select').length, 1);
});

test('CAR10: handler errors are translated, not raw English literals', async () => {
  const chatModule = makeChatModule();
  chatModule.sendKeySequenceToActiveChat = () => false;
  const handlers = createCommandHandlers({ loadChatModule: async () => chatModule });
  const { t } = await import('../app_front/i18n/index.js');
  assert.equal((await handlers.stopAgent()).error, t('car.err.nothing_to_stop'));
  assert.equal((await handlers.switchChat({ chat_id: 'zzz' })).error, t('car.err.chat_not_found'));
  assert.equal((await handlers.sendPrompt('')).error, t('car.err.empty_prompt'));
});

test('REG2: switch B, A, B executes the final switch when the active chat changed', async () => {
  const chatModule = makeChatModule();
  const handlers = createCommandHandlers({ loadChatModule: async () => chatModule });
  await handlers.switchChat({ chat_id: 'b' });
  await handlers.switchChat({ chat_id: 'a' });
  await handlers.switchChat({ chat_id: 'b' });
  assert.equal(chatModule.getActiveChatIdValue(), 'b');
  assert.deepEqual(chatModule.calls.filter((c) => c[0] === 'select').map((c) => c[1]), ['b', 'a', 'b']);
});

test('REG3: cycle next, previous, next ends on the second chat', async () => {
  const chatModule = makeChatModule();
  const handlers = createCommandHandlers({ loadChatModule: async () => chatModule });
  await handlers.cycleChat(1);
  await handlers.cycleChat(-1);
  await handlers.cycleChat(1);
  assert.equal(chatModule.getActiveChatIdValue(), 'b');
  assert.deepEqual(chatModule.calls.filter((c) => c[0] === 'select').map((c) => c[1]), ['b', 'a', 'b']);
});

test('card navigation phrases map to cycle_card', () => {
  for (const [phrase, direction] of [
    ['następna karta', 'next'], ['Następną kartę', 'next'], ['next card', 'next'],
    ['poprzednia karta', 'previous'], ['previous card', 'previous'], ['prev decision', 'previous'],
  ]) {
    const command = matchLocalCommand(phrase);
    assert.equal(command?.action, 'cycle_card', phrase);
    assert.equal(command.args.direction, direction, phrase);
  }
  // Agent stepping is unchanged and a sentence is still a prompt.
  assert.equal(matchLocalCommand('next agent').action, 'cycle_agent');
  assert.equal(matchLocalCommand('read the next card in the deck please'), null);
});

test('car v2/4: a bare cancel is not a stop; stopping needs an explicit phrase', () => {
  for (const text of ['anuluj', 'cancel', 'Anuluj!', 'cofnij', 'odwołaj']) {
    assert.equal(matchLocalCommand(text), null, text);
    assert.equal(matchLocalCommand(text, { carMode: true }), null, `${text} (car)`);
  }
  for (const text of ['zatrzymaj agenta', 'stop agent', 'przerwij agenta', 'stop the agent', 'zatrzymaj czat', 'przerwij agenta']) {
    assert.equal(matchLocalCommand(text, { carMode: true })?.action, 'stop_agent', text);
  }
  // Cancel still answers a waiting pick.
  assert.equal(matchLocalCommand('anuluj', { hasPendingChoice: true }).args.confirm, false);
});

test('car v2/4: a bare "stop" stops outside car mode only', () => {
  assert.equal(matchLocalCommand('stop').action, 'stop_agent');
  assert.equal(matchLocalCommand('zatrzymaj').action, 'stop_agent');
  assert.equal(matchLocalCommand('stop', { carMode: true }), null);
  assert.equal(matchLocalCommand('zatrzymaj', { carMode: true }), null);
});

test('car v2/4: undo-window phrases', () => {
  for (const text of ['cofnij', 'Anuluj', 'nie wysyłaj', 'cancel', 'undo', 'cofnij to', 'never mind', 'nie']) {
    assert.equal(matchSendWindowCommand(text), 'undo_send', text);
  }
  for (const text of ['wyślij', 'Wyślij teraz', 'send', 'send it', 'send now']) {
    assert.equal(matchSendWindowCommand(text), 'send_now', text);
  }
  for (const text of ['wyślij maila do klienta', 'cancel the subscription flow', 'undo the last commit', '']) {
    assert.equal(matchSendWindowCommand(text), null, text);
  }
});
