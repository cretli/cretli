import assert from 'node:assert/strict';
import test from 'node:test';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  listVoiceCommandGroups,
  listVoiceCommandIds,
  VOICE_COMMAND_CATALOG,
  VOICE_COMMAND_GROUPS,
} from '../app_front/features/voice/voiceCommandCatalog.js';
import { REALTIME_TOOLS } from '../lib/voice/realtime-session-config.js';

test('catalog ids match the server-pinned Realtime tools', () => {
  const actualIds = listVoiceCommandIds().sort();
  const expectedIds = REALTIME_TOOLS.map((tool) => tool.name).sort();
  assert.deepEqual(actualIds, expectedIds);
});

test('catalog ids are unique and every group is used', () => {
  const ids = listVoiceCommandIds();
  assert.equal(new Set(ids).size, ids.length);
  const usedGroups = new Set(VOICE_COMMAND_CATALOG.map((entry) => entry.group));
  assert.deepEqual([...usedGroups].sort(), [...VOICE_COMMAND_GROUPS].sort());
});

test('grouped catalog keeps every command and drops empty groups', () => {
  const groups = listVoiceCommandGroups();
  const groupedIds = groups.flatMap((group) => group.commands.map((entry) => entry.id));
  assert.deepEqual(groupedIds.sort(), listVoiceCommandIds().sort());
  assert.equal(
    groups.every((group) => group.commands.length > 0),
    true
  );
});

test('every catalog command has a spoken example in en and pl', () => {
  for (const id of listVoiceCommandIds()) {
    assert.equal(typeof en.voice.command[id], 'string', `en.voice.command.${id}`);
    assert.ok(en.voice.command[id].length > 0, `en.voice.command.${id} is empty`);
    assert.equal(typeof pl.voice.command[id], 'string', `pl.voice.command.${id}`);
    assert.ok(pl.voice.command[id].length > 0, `pl.voice.command.${id} is empty`);
  }
  for (const group of VOICE_COMMAND_GROUPS) {
    assert.ok(en.voice.commandsGroup[group], `en.voice.commandsGroup.${group}`);
    assert.ok(pl.voice.commandsGroup[group], `pl.voice.commandsGroup.${group}`);
  }
});
