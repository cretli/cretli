/**
 * B4 path for the zai plugin when it is switched off (CRETLI_OPTIONAL_HARNESSES
 * without zai): the id stays a valid transport, its chats stay readable but
 * refuse prompts and write nothing, and neither the catalog, delegation_start
 * nor model_pick can select it. Generic mechanics are covered with mistral in
 * tests/optional-harness-disabled-compat.test.js; this pins them for zai.
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
  // The boot load ran and registered nothing: zai is a known plugin that is off.
  resetOptionalHarnessStateForTests();
  setLoadedOptionalHarnessIds([]);
  resetKnownOptionalHarnessManifestsForTests();
});

after(() => {
  removeIsolatedDataDir();
});

test('zai is detected as a known plugin that is off, and not when it is loaded', () => {
  assert.deepEqual(getDisabledOptionalHarness('zai'), { id: 'zai', label: 'Z.AI SDK', dependsOn: ['opencode'] });
  assert.equal(getDisabledOptionalHarness('zai', { loadedIds: ['zai'], committed: true }), null);
});

test('prompts to an zai chat are refused while the plugin is off', async () => {
  const chat = addChat('sess-zai-off', 'Z.AI chat', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'zai' });
  assert.equal(chat.agentTransport, 'zai');
  assert.throws(() => assertChatCanReceiveMessages(chat), { code: HARNESS_PLUGIN_DISABLED_CODE, status: 409 });
  await assert.rejects(startChatRun({ chatId: chat.id, prompt: 'Continue' }), { code: HARNESS_PLUGIN_DISABLED_CODE });

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
  });
  attachDisabledOptionalHarnessSocket(socket, { id: 'zai', label: 'Z.AI SDK' });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'hi' })));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].code, HARNESS_PLUGIN_DISABLED_CODE);
  assert.equal(socket.sent[0].pluginId, 'zai');
});

test('catalog, delegation_start and model_pick never accept disabled zai', async () => {
  const rows = await listHarnessCatalog();
  assert.equal(rows.some((row) => row.id === 'zai' && row.enabled), false);

  const row = readSyncHarnessDelegatableRow('zai');
  assert.equal(row?.enabled, false);
  const verdict = evaluateDelegationStartHardGates({
    role: 'implement', harness: 'zai', model: 'glm-5.1', harnessRow: row, checkReviewAdapter: false,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'harness_unavailable');

  const favorite = (id) => ({ favorites_configured: true, items: [{ id, roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] });
  const picked = pickModelForPurpose({
    role: 'implement',
    harnesses: [
      { id: 'zai', enabled: row.enabled, ready: true, can_delegate: true },
      { id: 'x', enabled: true, ready: true, can_delegate: true },
    ],
    modelsByHarness: { zai: favorite('glm-5.1'), x: favorite('m-x') },
    rotation: { mode: 'off' },
    explore: false,
    history: { entries: [] },
  });
  assert.notEqual(picked.pick?.harness, 'zai');
});

test('saving unrelated settings keeps the stored favorite models', () => {
  saveSettings({ zaiChatEnabledModels: ['glm-5.1'] });
  saveSettings({ ...loadSettings(), theme: 'dark' });
  assert.deepEqual(loadSettings().zaiChatEnabledModels, ['glm-5.1']);
});
