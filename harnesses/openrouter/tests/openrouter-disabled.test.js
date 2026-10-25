/**
 * B4 path for the openrouter plugin when it is switched off (CRETLI_OPTIONAL_HARNESSES
 * without openrouter): the id stays a valid transport, its chats stay readable but
 * refuse prompts and write nothing, and neither the catalog, delegation_start
 * nor model_pick can select it. Generic mechanics are covered with mistral in
 * tests/optional-harness-disabled-compat.test.js; this pins them for openrouter.
 */
import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, test } from 'node:test';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from '../../../tests/helpers/isolated-data-dir.js';
import {
  resetOptionalHarnessStateForTests,
  setLoadedOptionalHarnessIds,
} from '../../../lib/agent-harness/optional-harness-state.ts';
import {
  HARNESS_PLUGIN_DISABLED_CODE,
  attachDisabledOptionalHarnessSocket,
  getDisabledOptionalHarness,
  resetKnownOptionalHarnessManifestsForTests,
} from '../../../lib/agent-harness/disabled-optional-harness.ts';
import { addChat } from '../../../lib/persist/chats-persist.js';
import { assertChatCanReceiveMessages } from '../../../lib/chat-message-guard.js';
import { startChatRun } from '../../../lib/chat-run-service.js';
import { listHarnessCatalog, readSyncHarnessDelegatableRow } from '../../../lib/harness-catalog.js';
import { evaluateDelegationStartHardGates } from '../../../lib/delegation-model-gates.js';
import { pickModelForPurpose } from '../../../lib/model-pick-service.js';
import { loadSettings, saveSettings } from '../../../lib/persist/settings.js';

before(() => {
  // The boot load ran and registered nothing: openrouter is a known plugin that is off.
  resetOptionalHarnessStateForTests();
  setLoadedOptionalHarnessIds([]);
  resetKnownOptionalHarnessManifestsForTests();
});

after(() => {
  removeIsolatedDataDir();
});

test('openrouter is detected as a known plugin that is off, and not when it is loaded', () => {
  assert.deepEqual(getDisabledOptionalHarness('openrouter'), { id: 'openrouter', label: 'OpenRouter' });
  assert.equal(getDisabledOptionalHarness('openrouter', { loadedIds: ['openrouter'], committed: true }), null);
});

test('prompts to an openrouter chat are refused while the plugin is off', async () => {
  const chat = addChat('sess-openrouter-off', 'OpenRouter chat', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'openrouter' });
  assert.equal(chat.agentTransport, 'openrouter');
  assert.throws(() => assertChatCanReceiveMessages(chat), { code: HARNESS_PLUGIN_DISABLED_CODE, status: 409 });
  await assert.rejects(startChatRun({ chatId: chat.id, prompt: 'Continue' }), { code: HARNESS_PLUGIN_DISABLED_CODE });

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
  });
  attachDisabledOptionalHarnessSocket(socket, { id: 'openrouter', label: 'OpenRouter' });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'hi' })));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].code, HARNESS_PLUGIN_DISABLED_CODE);
  assert.equal(socket.sent[0].pluginId, 'openrouter');
});

test('catalog, delegation_start and model_pick never accept disabled openrouter', async () => {
  const rows = await listHarnessCatalog();
  assert.equal(rows.some((row) => row.id === 'openrouter' && row.enabled), false);

  const row = readSyncHarnessDelegatableRow('openrouter');
  assert.equal(row?.enabled, false);
  const verdict = evaluateDelegationStartHardGates({
    role: 'implement', harness: 'openrouter', model: 'openai/gpt-4o', harnessRow: row, checkReviewAdapter: false,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'harness_unavailable');

  const favorite = (id) => ({ favorites_configured: true, items: [{ id, roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] });
  const picked = pickModelForPurpose({
    role: 'implement',
    harnesses: [
      { id: 'openrouter', enabled: row.enabled, ready: true, can_delegate: true },
      { id: 'x', enabled: true, ready: true, can_delegate: true },
    ],
    modelsByHarness: { openrouter: favorite('openai/gpt-4o'), x: favorite('m-x') },
    rotation: { mode: 'off' },
    explore: false,
    history: { entries: [] },
  });
  assert.notEqual(picked.pick?.harness, 'openrouter');
});

test('saving unrelated settings keeps the stored openrouter key and favorite models', () => {
  saveSettings({ openrouterApiKey: 'test-key-not-real', openrouterChatEnabledModels: ['openai/gpt-4o'] });
  saveSettings({ ...loadSettings(), theme: 'dark' });
  const saved = loadSettings();
  assert.equal(saved.openrouterApiKey, 'test-key-not-real');
  assert.deepEqual(saved.openrouterChatEnabledModels, ['openai/gpt-4o']);
});
