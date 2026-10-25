import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { REALTIME_TOOL_NAMES, executeRealtimeTool } from '../app_front/features/voice/realtimeTools.js';
import { listVoiceCommandIds } from '../app_front/features/voice/voiceCommandCatalog.js';
import { createVoiceStateSync, formatVoiceState } from '../app_front/features/voice/voiceStateSync.js';
import {
  VOICE_ACTIONS,
  getVoiceAction,
  isVoiceActionId,
  listVoiceActionIds,
} from '../lib/voice/action-registry.ts';
import { toGeminiFunctionDeclarations, buildGeminiLiveSetup } from '../lib/voice/gemini-live-config.ts';
import { REALTIME_TOOLS, buildRealtimeClientSecretBody } from '../lib/voice/realtime-session-config.ts';

test('registry ids are unique and every entry is well formed', () => {
  const ids = listVoiceActionIds();
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 32);
  for (const action of VOICE_ACTIONS) {
    assert.ok(['safe', 'confirm'].includes(action.risk), action.id);
    assert.ok(action.description.length > 0, action.id);
    for (const name of action.required) assert.ok(name in action.properties, `${action.id}.${name}`);
    assert.equal(action.handler, action.id);
  }
});

test('registry <-> OpenAI tools <-> Gemini declarations stay aligned', () => {
  const expectedIds = listVoiceActionIds();
  assert.deepEqual(REALTIME_TOOLS.map((tool) => tool.name), expectedIds);
  assert.deepEqual(buildRealtimeClientSecretBody({}).session.tools.map((tool) => tool.name), expectedIds);
  const declarations = toGeminiFunctionDeclarations();
  assert.deepEqual(declarations.map((entry) => entry.name), expectedIds);
  assert.deepEqual(
    buildGeminiLiveSetup({}).setup.tools[0].functionDeclarations.map((entry) => entry.name),
    expectedIds
  );
  for (const declaration of declarations) {
    assert.equal('additionalProperties' in declaration.parameters, false, declaration.name);
    assert.equal(declaration.description, getVoiceAction(declaration.name).description);
  }
});

test('registry <-> catalog <-> i18n <-> client handlers stay aligned', () => {
  const expectedIds = [...listVoiceActionIds()].sort();
  assert.deepEqual([...listVoiceCommandIds()].sort(), expectedIds);
  assert.deepEqual([...REALTIME_TOOL_NAMES].sort(), expectedIds);
  for (const id of expectedIds) {
    assert.ok(en.voice.command[id], `en.voice.command.${id}`);
    assert.ok(pl.voice.command[id], `pl.voice.command.${id}`);
  }
});

test('the client refuses tool names outside the registry', async () => {
  assert.equal(isVoiceActionId('send_prompt'), true);
  assert.equal(isVoiceActionId('constructor'), false);
  for (const name of ['rm_rf', 'constructor', '__proto__', 'toString', '']) {
    const actual = await executeRealtimeTool(name, {});
    assert.equal(actual.ok, false, name);
    assert.match(actual.error, /Unknown tool/);
  }
});

function makeHarness() {
  const sent = [];
  const deleted = [];
  const snapshot = { chatId: 'c1', title: 'First', harness: 'sdk', mode: 'agent', running: false, workspace: 'app', readMode: 'off' };
  const sync = createVoiceStateSync({
    getSnapshot: () => ({ ...snapshot }),
    sendItem: (item) => sent.push(item),
    deleteItem: (id) => deleted.push(id),
  });
  return { sent, deleted, snapshot, sync };
}

test('state block carries chat, workspace, approval and read mode', () => {
  const text = formatVoiceState({
    chatId: 'c1', title: 'Fix login', harness: 'codex', mode: 'plan', running: true,
    workspace: 'shop', pendingApproval: { kind: 'permission', count: 2 }, readMode: 'final',
  });
  assert.match(text, /active_chat: Fix login \(id c1, codex, plan, running\)/);
  assert.match(text, /workspace: shop/);
  assert.match(text, /pending_approval: permission x2/);
  assert.match(text, /read_mode: final/);
  assert.match(formatVoiceState({}), /active_chat: none/);
});

test('state stays current across 12 turns and the history prune never removes it', async () => {
  const { sent, deleted, snapshot, sync } = makeHarness();
  await sync.sync();
  assert.equal(sent.length, 1);
  const itemIds = [];
  for (let turn = 1; turn <= 12; turn += 1) {
    // Mirror realtimeSession: the state item is kept out of the prunable history.
    for (const id of [`u${turn}`, `a${turn}`, sent.at(-1).id]) {
      if (!sync.isStateItem(id)) itemIds.push(id);
    }
    const stale = itemIds.splice(0, Math.max(0, itemIds.length - 4));
    assert.equal(stale.some((id) => sync.isStateItem(id)), false);
    if (turn === 5) Object.assign(snapshot, { chatId: 'c2', title: 'Second', running: true });
    if (turn === 9) snapshot.pendingApproval = { kind: 'permission', count: 1 };
    await sync.sync();
  }
  assert.equal(sent.length, 3, 'unchanged turns send nothing');
  assert.match(sent.at(-1).text, /active_chat: Second \(id c2, sdk, agent, running\)/);
  assert.match(sent.at(-1).text, /pending_approval: permission/);
  assert.equal(sync.getCurrentText(), sent.at(-1).text);
  assert.deepEqual(deleted, [sent[0].id, sent[1].id], 'each update replaces the previous item');
});

test('state is re-sent when the provider drops it and after reconnect', async () => {
  const { sent, sync } = makeHarness();
  await sync.sync();
  assert.equal(sync.markDeleted('someone_else'), false);
  assert.equal(sync.markDeleted(sent[0].id), true);
  await sync.sync();
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].id, sent[0].id);
  // Reconnect: a new socket has no history, so the same text must be sent again.
  sync.reset();
  await sync.sync();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].text, sent[1].text);
});

test('each provider session resets state sync on reconnect', () => {
  for (const file of ['realtimeSession.js', 'geminiLiveSession.js']) {
    const source = fs.readFileSync(new URL(`../app_front/features/voice/${file}`, import.meta.url), 'utf8');
    assert.ok(source.includes('stateSync.reset()'), `${file} resets state on reconnect`);
  }
});
