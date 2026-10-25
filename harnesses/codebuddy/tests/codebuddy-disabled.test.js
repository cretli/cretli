/**
 * B4 path for the codebuddy plugin when it is switched off (CRETLI_OPTIONAL_HARNESSES
 * without codebuddy): the id stays a valid transport, its chats stay readable but
 * refuse prompts and write nothing, and neither the catalog, delegation_start
 * nor model_pick can select it. Generic mechanics are covered with mistral in
 * tests/optional-harness-disabled-compat.test.js; this pins them for codebuddy.
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
  // The boot load ran and registered nothing: codebuddy is a known plugin that is off.
  resetOptionalHarnessStateForTests();
  setLoadedOptionalHarnessIds([]);
  resetKnownOptionalHarnessManifestsForTests();
});

after(() => {
  removeIsolatedDataDir();
});

test('codebuddy is detected as a known plugin that is off, and not when it is loaded', () => {
  assert.deepEqual(getDisabledOptionalHarness('codebuddy'), { id: 'codebuddy', label: 'CodeBuddy' });
  assert.equal(getDisabledOptionalHarness('codebuddy', { loadedIds: ['codebuddy'], committed: true }), null);
});

test('prompts to a codebuddy chat are refused while the plugin is off', async () => {
  const chat = addChat('sess-codebuddy-off', 'CodeBuddy chat', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'codebuddy' });
  assert.equal(chat.agentTransport, 'codebuddy');
  assert.throws(() => assertChatCanReceiveMessages(chat), { code: HARNESS_PLUGIN_DISABLED_CODE, status: 409 });
  await assert.rejects(startChatRun({ chatId: chat.id, prompt: 'Continue' }), { code: HARNESS_PLUGIN_DISABLED_CODE });

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
  });
  attachDisabledOptionalHarnessSocket(socket, { id: 'codebuddy', label: 'CodeBuddy' });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'hi' })));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].code, HARNESS_PLUGIN_DISABLED_CODE);
  assert.equal(socket.sent[0].pluginId, 'codebuddy');
});

test('catalog, delegation_start and model_pick never accept disabled codebuddy', async () => {
  const rows = await listHarnessCatalog();
  assert.equal(rows.some((row) => row.id === 'codebuddy' && row.enabled), false);

  const row = readSyncHarnessDelegatableRow('codebuddy');
  assert.equal(row?.enabled, false);
  const verdict = evaluateDelegationStartHardGates({
    role: 'implement', harness: 'codebuddy', model: 'hy4-preview-f', harnessRow: row, checkReviewAdapter: false,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'harness_unavailable');

  const favorite = (id) => ({ favorites_configured: true, items: [{ id, roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] });
  const picked = pickModelForPurpose({
    role: 'implement',
    harnesses: [
      { id: 'codebuddy', enabled: row.enabled, ready: true, can_delegate: true },
      { id: 'x', enabled: true, ready: true, can_delegate: true },
    ],
    modelsByHarness: { codebuddy: favorite('hy4-preview-f'), x: favorite('m-x') },
    rotation: { mode: 'off' },
    explore: false,
    history: { entries: [] },
  });
  assert.notEqual(picked.pick?.harness, 'codebuddy');
});

test('saving unrelated settings keeps the stored codebuddy key and favorite models', () => {
  saveSettings({ codebuddyApiKey: 'test-key-not-real', codebuddyChatEnabledModels: ['hy4-preview-f'] });
  saveSettings({ ...loadSettings(), theme: 'dark' });
  const saved = loadSettings();
  assert.equal(saved.codebuddyApiKey, 'test-key-not-real');
  assert.deepEqual(saved.codebuddyChatEnabledModels, ['hy4-preview-f']);
});
