/**
 * Data compatibility for a repo harness plugin that is known but switched off
 * (mistral is the first one): its chats stay readable but refuse prompts and
 * leave the history untouched, no picker or delegation start can select it,
 * and saving settings keeps its stored keys and favorite models.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  resetOptionalHarnessStateForTests,
  setLoadedOptionalHarnessIds,
} from '../lib/agent-harness/optional-harness-state.ts';
import {
  HARNESS_PLUGIN_DISABLED_CODE,
  attachDisabledOptionalHarnessSocket,
  getDisabledOptionalHarness,
  resetKnownOptionalHarnessManifestsForTests,
} from '../lib/agent-harness/disabled-optional-harness.ts';
import {
  isPersistedLocalChatTransport,
  resolvePersistedLocalChatState,
} from '../lib/agent-harness/persisted-local-chat-state.ts';
import { addChat } from '../lib/persist/chats-persist.js';
import { assertChatCanReceiveMessages } from '../lib/chat-message-guard.js';
import { startChatRun } from '../lib/chat-run-service.js';
import { listHarnessCatalog, readSyncHarnessDelegatableRow } from '../lib/harness-catalog.js';
import { evaluateDelegationStartHardGates } from '../lib/delegation-model-gates.js';
import { pickModelForPurpose } from '../lib/model-pick-service.js';
import { resolveWorkspaceWatcherOrchestrator } from '../lib/workspace-watcher-orchestrator.js';
import { isBlockingPersistedLocalChatHarnessState, isReadOnlyOptionalPluginChat } from '../app_front/features/chat/persistedLocalChatState.js';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import { AUTH_CSRF_HEADER, createSession, getCsrfTokenForSessionToken, requireAuth, setPassword } from '../lib/auth.js';
import { registerSettingsRoutes } from '../lib/routes/settings-routes.js';
import { resolvePersistedLocalChatHarnessDisplay, resolvePersistedLocalChatUnavailableMessage } from '../app_front/features/chat/persistedLocalChatState.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { readChatSource } from './helpers/chatSource.js';

/** Hash every file under a directory so "nothing was written" is checkable. */
function snapshotTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

before(() => {
  // The boot load ran and registered nothing: mistral is a known plugin that is off.
  resetOptionalHarnessStateForTests();
  setLoadedOptionalHarnessIds([]);
  resetKnownOptionalHarnessManifestsForTests();
});

after(() => {
  removeIsolatedDataDir();
});

test('a known optional plugin that is not loaded is detected from its manifest', () => {
  assert.deepEqual(getDisabledOptionalHarness('mistral'), { id: 'mistral', label: 'Mistral AI' });
  assert.deepEqual(getDisabledOptionalHarness(' Mistral '), { id: 'mistral', label: 'Mistral AI' });
  assert.equal(getDisabledOptionalHarness('sdk'), null);
  assert.equal(getDisabledOptionalHarness('not-a-plugin'), null);
  assert.equal(getDisabledOptionalHarness('mistral', { loadedIds: ['mistral'] }), null, 'loaded plugin is not disabled');
  // Boot window: until the boot load commits its result "not loaded" carries no meaning, so
  // nothing is reported as disabled (server.js loads plugins before it accepts any request).
  assert.equal(getDisabledOptionalHarness('mistral', { committed: false }), null, 'before the boot load nothing is disabled');
});

test('persisted state marks the chat plugin_disabled and names the plugin', async () => {
  assert.equal(isPersistedLocalChatTransport('mistral'), true);
  assert.equal(isPersistedLocalChatTransport('sdk'), false);
  const state = await resolvePersistedLocalChatState('mistral', { providers: [] });
  assert.equal(state?.code, 'plugin_disabled');
  assert.equal(state?.runnable, false);
  assert.equal(state?.plugin?.label, 'Mistral AI');

  const chat = { agentTransport: 'mistral', harnessState: state };
  const display = resolvePersistedLocalChatHarnessDisplay(chat);
  assert.equal(display.blocked, true);
  assert.equal(display.label, 'mistral', 'the saved transport is never shown as Cursor');
  const translate = (dict) => (key, vars) => {
    const leaf = key.split('.').reduce((node, part) => node?.[part], dict);
    return String(leaf).replace(/\{(\w+)\}/g, (_m, name) => vars?.[name] ?? '');
  };
  assert.match(resolvePersistedLocalChatUnavailableMessage(chat, translate(en)), /Enable the Mistral AI plugin/);
  assert.match(resolvePersistedLocalChatUnavailableMessage(chat, translate(pl)), /Włącz wtyczkę Mistral AI/);
  // The boot cache keeps only the code: the message falls back to the transport id.
  assert.match(
    resolvePersistedLocalChatUnavailableMessage({ agentTransport: 'mistral', harnessState: { code: 'plugin_disabled' } }, translate(en)),
    /Enable the mistral plugin/,
  );
});

test('prompts to a disabled-plugin chat are refused and the data directory is untouched', async () => {
  const chat = addChat('sess-mistral-off', 'Mistral chat', null, ISOLATED_DATA_DIR, 'test', { agentTransport: 'mistral' });
  assert.equal(chat.agentTransport, 'mistral');
  // Let deferred writes from creating the chat (notification center) settle first.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const treeBefore = snapshotTree(ISOLATED_DATA_DIR);

  assert.throws(() => assertChatCanReceiveMessages(chat), { code: HARNESS_PLUGIN_DISABLED_CODE, status: 409 });
  await assert.rejects(startChatRun({ chatId: chat.id, prompt: 'Continue' }), { code: HARNESS_PLUGIN_DISABLED_CODE });

  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
  });
  attachDisabledOptionalHarnessSocket(socket, { id: 'mistral', label: 'Mistral AI' });
  for (const type of ['send', 'queueForceSend', 'ping']) {
    socket.emit('message', Buffer.from(JSON.stringify({ type, text: 'hi' })));
  }
  socket.emit('message', Buffer.from('not json'));
  assert.equal(socket.sent.length, 2, 'only prompt frames are answered');
  assert.ok(socket.sent.every((frame) => frame.type === 'sdkError' && frame.code === HARNESS_PLUGIN_DISABLED_CODE && frame.pluginId === 'mistral'));

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(snapshotTree(ISOLATED_DATA_DIR), treeBefore, 'refused prompts write nothing');
});

test('a chat on an enabled plugin is not blocked by the guard', () => {
  assert.equal(getDisabledOptionalHarness('mistral', { loadedIds: ['mistral'], committed: true }), null);
});

test('catalog, model_pick and delegation_start never accept the disabled plugin', async () => {
  const rows = await listHarnessCatalog();
  assert.equal(rows.some((row) => row.id === 'mistral' && row.enabled), false);

  const row = readSyncHarnessDelegatableRow('mistral');
  assert.equal(row?.enabled, false);
  const verdict = evaluateDelegationStartHardGates({
    role: 'implement', harness: 'mistral', model: 'mistral-large-latest', harnessRow: row, checkReviewAdapter: false,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'harness_unavailable');

  const harnesses = [
    ...rows.filter((r) => r.id !== 'mistral'),
    { id: 'mistral', enabled: row.enabled, ready: true, can_delegate: true },
    { id: 'x', enabled: true, ready: true, can_delegate: true },
  ];
  const favorite = (id) => ({ favorites_configured: true, items: [{ id, roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] });
  const picked = pickModelForPurpose({
    role: 'implement',
    harnesses: harnesses.filter((r) => r.id === 'mistral' || r.id === 'x'),
    modelsByHarness: { mistral: favorite('mistral-large-latest'), x: favorite('m-x') },
    rotation: { mode: 'off' },
    explore: false,
    history: { entries: [] },
  });
  assert.notEqual(picked.pick?.harness, 'mistral');
});

test('saving settings while the plugin is disabled keeps its API keys and favorite models', async () => {
  saveSettings({
    mistralApiKey: 'test-key-not-real',
    mistralVibeApiKey: 'test-vibe-key-not-real',
    mistralChatEnabledModels: ['mistral-large-latest'],
  });
  setPassword('test-password-123');
  const sessionToken = createSession();
  const csrf = getCsrfTokenForSessionToken(sessionToken);
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  registerSettingsRoutes(app, {
    port: 0,
    useHttps: false,
    serverInstanceToken: 'test-instance-token',
    frontHotFallbackEnabled: false,
    getLanHost: () => null,
    getConfiguredWorkspaceSelection: () => ({ workspaceFile: '', workspaceFolder: '' }),
    isSessionSyncEnabled: () => false,
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/settings`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: `cr_session=${encodeURIComponent(sessionToken)}`,
        [AUTH_CSRF_HEADER]: csrf,
      },
      body: JSON.stringify({ enabledHarnesses: ['sdk', 'claude'], sdkRunIdleTimeoutSeconds: 120 }),
    });
    assert.equal(res.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const saved = loadSettings();
  assert.deepEqual(saved.enabledHarnesses, ['sdk', 'claude'], 'the save really happened');
  assert.equal(saved.mistralApiKey, 'test-key-not-real');
  assert.equal(saved.mistralVibeApiKey, 'test-vibe-key-not-real');
  assert.deepEqual(saved.mistralChatEnabledModels, ['mistral-large-latest']);
});

test('the Watcher orchestrator resolver never selects the disabled plugin', async () => {
  const listHarnessModels = async ({ harness }) => ({
    harness,
    favorites_configured: true,
    items: [{ id: `${harness}-model`, enabled: true, roles: ['implement', 'plan', 'review', 'fix'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }],
  });
  const deps = { listHarnessModels, mcpCapabilityProbe: () => ({ ok: true }) };
  const explicit = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { orchestrator: { harness: 'mistral', model: 'mistral-large-latest' } } },
    workspaceFolder: ISOLATED_DATA_DIR,
    overrideRows: [],
    deps,
  });
  assert.equal(explicit.ok, false);
  // No catalog row exists for an unloaded plugin, so the gate reports it as having no usable model.
  assert.ok(['orchestrator_harness_unavailable', 'orchestrator_model_usage_limited'].includes(explicit.reason), explicit.reason);

  const automatic = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: {} },
    workspaceFolder: ISOLATED_DATA_DIR,
    overrideRows: [],
    deps,
  });
  if (automatic.ok) assert.notEqual(automatic.harness, 'mistral');
});

test('front: a known disabled plugin opens read-only (history path kept), other blocked states stay blocked', () => {
  const pluginOff = { agentTransport: 'mistral', harnessState: { code: 'plugin_disabled' } };
  assert.equal(isReadOnlyOptionalPluginChat(pluginOff), true);
  assert.equal(isBlockingPersistedLocalChatHarnessState(pluginOff), false, 'history load / ws connect are not skipped');
  const localOff = { agentTransport: 'alpha', harnessState: { code: 'plugin_disabled' } };
  assert.equal(isReadOnlyOptionalPluginChat(localOff), false);
  assert.equal(isBlockingPersistedLocalChatHarnessState(localOff), true);
  assert.equal(isBlockingPersistedLocalChatHarnessState({ agentTransport: 'mistral', harnessState: { code: 'host_incompatible' } }), true);
  // The composer is made read-only through the shared archive/send-UI sync.
  const source = readChatSource();
  const sync = source.slice(source.indexOf('function syncArchivedChatSendUi'));
  assert.match(sync.slice(0, sync.indexOf('\n}\n')), /isReadOnlyOptionalPluginChat\(chat\)[\s\S]*setReadOnly\(archived \|\| pluginOff\)/);
});
