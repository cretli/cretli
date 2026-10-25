/**
 * B4 path for the deepseek plugin when it is switched off (CRETLI_OPTIONAL_HARNESSES
 * without deepseek): the id stays a valid transport, its chats stay readable but
 * refuse prompts and write nothing, and neither the catalog, delegation_start
 * nor model_pick can select it. Generic mechanics are covered with mistral in
 * tests/optional-harness-disabled-compat.test.js; this pins them for deepseek.
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
  // The boot load ran and registered nothing: deepseek is a known plugin that is off.
  resetOptionalHarnessStateForTests();
  setLoadedOptionalHarnessIds([]);
  resetKnownOptionalHarnessManifestsForTests();
});

after(() => {
  removeIsolatedDataDir();
});

test('deepseek is detected as a known plugin that is off, and not when it is loaded', () => {
  assert.deepEqual(getDisabledOptionalHarness('deepseek'), { id: 'deepseek', label: 'DeepSeek Harness' });
  assert.equal(getDisabledOptionalHarness('deepseek', { loadedIds: ['deepseek'], committed: true }), null);
});

test('prompts to a deepseek chat are refused while the plugin is off', async () => {
  const chat = addChat('sess-deepseek-off', 'DeepSeek chat', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'deepseek' });
  assert.equal(chat.agentTransport, 'deepseek');
  assert.throws(() => assertChatCanReceiveMessages(chat), { code: HARNESS_PLUGIN_DISABLED_CODE, status: 409 });
  await assert.rejects(startChatRun({ chatId: chat.id, prompt: 'Continue' }), { code: HARNESS_PLUGIN_DISABLED_CODE });

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
  });
  attachDisabledOptionalHarnessSocket(socket, { id: 'deepseek', label: 'DeepSeek Harness' });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'hi' })));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].code, HARNESS_PLUGIN_DISABLED_CODE);
  assert.equal(socket.sent[0].pluginId, 'deepseek');
});

test('catalog, delegation_start and model_pick never accept disabled deepseek', async () => {
  const rows = await listHarnessCatalog();
  assert.equal(rows.some((row) => row.id === 'deepseek' && row.enabled), false);

  const row = readSyncHarnessDelegatableRow('deepseek');
  assert.equal(row?.enabled, false);
  const verdict = evaluateDelegationStartHardGates({
    role: 'implement', harness: 'deepseek', model: 'deepseek-flash', harnessRow: row, checkReviewAdapter: false,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'harness_unavailable');

  const favorite = (id) => ({ favorites_configured: true, items: [{ id, roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] });
  const picked = pickModelForPurpose({
    role: 'implement',
    harnesses: [
      { id: 'deepseek', enabled: row.enabled, ready: true, can_delegate: true },
      { id: 'x', enabled: true, ready: true, can_delegate: true },
    ],
    modelsByHarness: { deepseek: favorite('deepseek-flash'), x: favorite('m-x') },
    rotation: { mode: 'off' },
    explore: false,
    history: { entries: [] },
  });
  assert.notEqual(picked.pick?.harness, 'deepseek');
});

test('saving unrelated settings keeps the stored deepseek key and favorite models', () => {
  saveSettings({ deepseekApiKey: 'test-key-not-real', deepseekChatEnabledModels: ['deepseek-flash'] });
  saveSettings({ ...loadSettings(), theme: 'dark' });
  const saved = loadSettings();
  assert.equal(saved.deepseekApiKey, 'test-key-not-real');
  assert.deepEqual(saved.deepseekChatEnabledModels, ['deepseek-flash']);
});
