import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { commandHandlers } from '../app_front/features/voice/commandHandlers.js';
import { LOCAL_COMMANDS, createLocalExecutors, matchLocalCommand, runLocalCommand } from '../app_front/features/voice/localCommands.js';
import { executeRealtimeTool } from '../app_front/features/voice/realtimeTools.js';
import { getVoiceAction, listVoiceActionIds } from '../lib/voice/action-registry.ts';

/** Command family introduced by browser voice mode and car mode: local phrase <-> registry action <-> handler. */
const FAMILY = {
  stop_agent: { handler: 'stopAgent', args: {}, phrase: 'stop' },
  cycle_agent: { handler: 'cycleChat', args: { direction: 'previous' }, phrase: 'previous agent', handlerArgs: [-1] },
  cycle_card: { handler: 'cycleCard', args: { direction: 'previous' }, phrase: 'previous card', handlerArgs: [-1] },
  switch_chat: { handler: 'switchChat', args: { chat_id: 'c9' }, phrase: null },
  car_mode: { handler: 'setCarMode', args: { enable: false }, phrase: 'close car mode', handlerArgs: [false] },
  choose_option: { handler: 'chooseOption', args: { option: 2 }, phrase: 'option two', handlerArgs: [{ option: 2 }] },
  orchestrator: { handler: 'setOrchestrator', args: { enable: true }, phrase: 'orkiestrator', handlerArgs: [true] },
  list_agents: { handler: 'listAgents', args: {}, phrase: 'what are the agents doing', handlerArgs: [] },
  switch_agent: { handler: 'switchAgent', args: { waiting: true }, phrase: 'who is waiting', handlerArgs: [{ waiting: true }] },
  whats_new: { handler: 'whatsNew', args: {}, phrase: "what's new", handlerArgs: [] },
  chat_ops: { handler: 'chatOps', args: { action: 'search', query: 'login' }, phrase: 'search chats for login' },
  ops: { handler: 'ops', args: { action: 'git_status' }, phrase: 'git status' },
  inbox: { handler: 'inbox', args: { action: 'list_scout' }, phrase: 'show scout proposals' },
  confirm_choice: { handler: 'confirmChoice', args: { confirm: false }, phrase: 'no', handlerArgs: [{ confirm: false }], pending: true },
};

function patchHandlers() {
  const calls = [];
  const originals = {};
  for (const { handler } of Object.values(FAMILY)) {
    originals[handler] = commandHandlers[handler];
    commandHandlers[handler] = async (...args) => {
      calls.push([handler, args]);
      return { ok: true, handler };
    };
  }
  commandHandlers.switchTo = async (...args) => { calls.push(['switchTo', args]); return { ok: true }; };
  return { calls, restore: () => Object.assign(commandHandlers, originals) };
}

test('every action of the family is in the registry, and every local command targets one', () => {
  const ids = new Set(listVoiceActionIds());
  for (const id of Object.keys(FAMILY)) assert.ok(ids.has(id), id);
  for (const command of LOCAL_COMMANDS) assert.ok(ids.has(command.action), command.id);
  const executors = createLocalExecutors();
  for (const command of LOCAL_COMMANDS) assert.equal(typeof executors[command.action], 'function', command.action);
  assert.equal(getVoiceAction('confirm_choice').risk, 'confirm');
});

test('Web Speech, OpenAI and Gemini reach the same handler exactly once', async () => {
  const { calls, restore } = patchHandlers();
  try {
    for (const [action, spec] of Object.entries(FAMILY)) {
      // Realtime (OpenAI tool arguments arrive as parsed JSON, Gemini as the call's args object).
      for (const transport of ['openai', 'gemini']) {
        calls.length = 0;
        const payload = transport === 'openai' ? JSON.parse(JSON.stringify(spec.args)) : { ...spec.args };
        const result = await executeRealtimeTool(action, payload);
        assert.equal(result.ok, true, `${transport} ${action}`);
        assert.equal(calls.length, 1, `${transport} ${action} ran once`);
        assert.equal(calls[0][0], spec.handler, `${transport} ${action}`);
      }
      // Browser voice (no model): the phrase resolves to the same action and handler.
      if (!spec.phrase) continue;
      calls.length = 0;
      const command = matchLocalCommand(spec.phrase, { hasPendingChoice: true });
      assert.equal(command?.action, action, spec.phrase);
      const result = await runLocalCommand(command);
      assert.equal(result.ok, true, `web speech ${action}`);
      assert.equal(calls.length, 1, `web speech ${action} ran once`);
      assert.equal(calls[0][0], spec.handler, `web speech ${action}`);
      if (spec.handlerArgs) assert.deepEqual(calls[0][1], spec.handlerArgs, `web speech ${action} arguments`);
    }
  } finally {
    restore();
  }
});

test('the local matcher is bypassed in Realtime: both sessions only call executeRealtimeTool', () => {
  for (const file of ['realtimeSession.js', 'geminiLiveSession.js']) {
    const source = fs.readFileSync(new URL(`../app_front/features/voice/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes('executeRealtimeTool('), `${file} executes tools through realtimeTools`);
    assert.equal(source.includes('localCommands'), false, `${file} does not use the local matcher`);
  }
});

test('confirm and cancel phrases only match while a pick waits', () => {
  assert.equal(matchLocalCommand('tak'), null);
  assert.equal(matchLocalCommand('yes'), null);
  assert.equal(matchLocalCommand('tak', { hasPendingChoice: true }).args.confirm, true);
  assert.equal(matchLocalCommand('anuluj', { hasPendingChoice: true }).args.confirm, false);
  // Without a pick, a bare "cancel" is a prompt, never a stop.
  assert.equal(matchLocalCommand('cancel'), null);
  assert.equal(matchLocalCommand('anuluj'), null);
});

test('orchestrator phrases in Polish and English', () => {
  assert.deepEqual(matchLocalCommand('Orkiestrator').args, { enable: true });
  assert.deepEqual(matchLocalCommand('wszyscy agenci').args, { enable: true });
  assert.deepEqual(matchLocalCommand('show all agents').args, { enable: true });
  assert.deepEqual(matchLocalCommand('zamknij orkiestrator').args, { enable: false });
  assert.deepEqual(matchLocalCommand('close orchestrator').args, { enable: false });
  assert.equal(matchLocalCommand('co robią agenci?').action, 'list_agents');
  assert.deepEqual(matchLocalCommand('który agent czeka').args, { waiting: true });
  assert.deepEqual(matchLocalCommand('Switch to the waiting agent').args, { waiting: true });
  // A sentence that merely mentions agents is a prompt.
  assert.equal(matchLocalCommand('wszyscy agenci powinni uruchomić testy'), null);
});

test('option and car mode phrases', () => {
  assert.deepEqual(matchLocalCommand('opcja 2').args, { option: 2 });
  assert.deepEqual(matchLocalCommand('wybieram drugą').args, { option: 2 });
  assert.deepEqual(matchLocalCommand('Option three!').args, { option: 3 });
  assert.equal(matchLocalCommand('opcja dziewięć'), null, 'not an option number: a prompt');
  assert.equal(matchLocalCommand('option 7'), null);
  assert.deepEqual(matchLocalCommand('tryb samochodowy').args, { enable: true });
  assert.deepEqual(matchLocalCommand('Car mode').args, { enable: true });
  assert.deepEqual(matchLocalCommand('zamknij tryb samochodowy').args, { enable: false });
  assert.deepEqual(matchLocalCommand('exit car mode').args, { enable: false });
});
