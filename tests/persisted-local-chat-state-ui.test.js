/**
 * UI2 slice: persisted local chat `harnessState` handling.
 *
 * Covers the pure classifier, list hydration transport preservation, the
 * transport reconnect/socket guards, i18n coverage, the new-chat normalizer
 * regression, and a source-wiring check for `openTerminal`.
 *
 * No DOM is required: the heavy browser modules are exercised through their
 * pure exports and the injectable transport/controller factories.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  BLOCKING_PERSISTED_LOCAL_CHAT_STATE_CODES,
  PERSISTED_LOCAL_CHAT_STATE_MESSAGE_KEYS,
  isBlockingPersistedLocalChatHarnessState,
  resolveBlockingPersistedLocalChatStateCode,
  resolvePersistedLocalChatHarnessDisplay,
  resolvePersistedLocalChatTransport,
  resolvePersistedLocalChatUnavailableMessageKey,
} from '../app_front/features/chat/persistedLocalChatState.js';
import { normalizeNewChatHarnessId } from '../app_front/features/chat/newChatHarnessStatus.js';
import { createChatController } from '../app_front/features/chat/chatController.js';
import { createChatTransport } from '../app_front/features/chat/chatTransport.js';
import {
  initChatHistorySyncPoll,
  runChatHistoryRevisionPoll,
  selectPersistedLocalChatHistoryPollChats,
  stopChatHistorySyncPoll,
} from '../app_front/features/chat/chatHistorySyncPoll.js';
import { applyChatConnectionRecovery } from '../app_front/features/chat/chatServerRecovery.js';
import { getLastAckedSeq } from '../app_front/lib/sdk-chat-history-store.js';
import { resolveSidebarHarnessIcon } from '../app_front/features/sidebar/sidebarView.js';
import {
  CHAT_PING_INTERVAL_MS,
  CHAT_RECONNECT_DELAYS,
  CHAT_RECONNECT_MAX,
  WS_PATH_AGENT_SDK,
} from '../app_front/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

// --- 1. classifier: only the four blocking codes block -------------------------
assert.deepEqual(
  [...BLOCKING_PERSISTED_LOCAL_CHAT_STATE_CODES],
  ['plugin_unavailable', 'plugin_disabled', 'plugin_capability', 'host_incompatible'],
);

for (const code of BLOCKING_PERSISTED_LOCAL_CHAT_STATE_CODES) {
  const chat = { harnessState: { code, runnable: false } };
  assert.equal(resolveBlockingPersistedLocalChatStateCode(chat), code);
  assert.equal(isBlockingPersistedLocalChatHarnessState(chat), true);
}

// `not_loaded` means "not imported during this list read" — it must never block.
assert.equal(
  resolveBlockingPersistedLocalChatStateCode({ harnessState: { code: 'not_loaded', runnable: false } }),
  '',
);
assert.equal(
  isBlockingPersistedLocalChatHarnessState({ harnessState: { code: 'not_loaded', runnable: false } }),
  false,
);
// No state / unknown / malformed state is non-blocking legacy or built-in.
assert.equal(resolveBlockingPersistedLocalChatStateCode({}), '');
assert.equal(resolveBlockingPersistedLocalChatStateCode({ harnessState: null }), '');
assert.equal(resolveBlockingPersistedLocalChatStateCode({ harnessState: { code: 'weird' } }), '');
assert.equal(resolveBlockingPersistedLocalChatStateCode({ harnessState: { code: ' plugin_unavailable ' } }), 'plugin_unavailable');
assert.equal(resolveBlockingPersistedLocalChatStateCode(null), '');
assert.equal(resolveBlockingPersistedLocalChatStateCode(undefined), '');

// --- 2. transport resolution preserves the exact raw id only when blocked ------
const blockedAlpha = { agentTransport: 'Alpha-Plugin', harnessState: { code: 'plugin_unavailable' } };
assert.equal(resolvePersistedLocalChatTransport(blockedAlpha), 'Alpha-Plugin');
assert.equal(blockedAlpha.agentTransport, 'Alpha-Plugin', 'input must not be mutated');
// Exact string (including surrounding whitespace) is preserved, never trimmed/rewritten.
assert.equal(
  resolvePersistedLocalChatTransport({ agentTransport: '  Beta  ', harnessState: { code: 'plugin_disabled' } }),
  '  Beta  ',
);
// Non-blocking rows keep the pre-plugin normalization (unknown -> sdk).
assert.equal(
  resolvePersistedLocalChatTransport({ agentTransport: 'ghost', harnessState: { code: 'not_loaded' } }),
  'sdk',
);
assert.equal(resolvePersistedLocalChatTransport({ agentTransport: 'ghost' }), 'sdk');
assert.equal(resolvePersistedLocalChatTransport({ agentTransport: 'claude' }), 'claude');
assert.equal(resolvePersistedLocalChatTransport({ agentTransport: 'cursor' }), 'sdk');
// Blocked but missing transport still falls back to the legacy default.
assert.equal(resolvePersistedLocalChatTransport({ harnessState: { code: 'plugin_capability' } }), 'sdk');

// --- 3. display: blocked chats never fall back to Cursor -----------------------
const blockedDisplay = resolvePersistedLocalChatHarnessDisplay({
  agentTransport: 'Alpha-Plugin',
  harnessState: { code: 'plugin_unavailable' },
});
assert.equal(blockedDisplay.blocked, true);
assert.equal(blockedDisplay.label, 'Alpha-Plugin');
assert.notEqual(blockedDisplay.label, 'Cursor');
assert.notEqual(blockedDisplay.label, 'Cursor SDK');
assert.equal(blockedDisplay.transportId, 'alpha-plugin');
assert.equal(blockedDisplay.messageKey, 'chat.localHarnessStateUnavailable');
assert.equal(
  resolvePersistedLocalChatUnavailableMessageKey({ harnessState: { code: 'host_incompatible' } }),
  'chat.localHarnessStateHostIncompatible',
);
assert.equal(resolvePersistedLocalChatHarnessDisplay({ agentTransport: 'not_loaded' }).blocked, false);
assert.equal(
  resolvePersistedLocalChatHarnessDisplay({ harnessState: { code: 'not_loaded' } }).blocked,
  false,
);
assert.equal(resolvePersistedLocalChatHarnessDisplay({}).label, '');

// --- 4. i18n: one non-empty string per blocking code in en + pl ----------------
const readKey = (dict, dotted) => {
  const parts = dotted.split('.');
  let value = dict;
  for (const part of parts) {
    value = value && typeof value === 'object' ? value[part] : undefined;
  }
  return value;
};
for (const code of BLOCKING_PERSISTED_LOCAL_CHAT_STATE_CODES) {
  const key = PERSISTED_LOCAL_CHAT_STATE_MESSAGE_KEYS[code];
  assert.equal(typeof readKey(en, key), 'string', `missing en ${key}`);
  assert.equal(typeof readKey(pl, key), 'string', `missing pl ${key}`);
  assert.ok(readKey(en, key).trim().length > 0, `empty en ${key}`);
  assert.ok(readKey(pl, key).trim().length > 0, `empty pl ${key}`);
}

// --- 5. new-chat normalizer stays exactly as before (regression) --------------
assert.equal(normalizeNewChatHarnessId('nonsense'), 'sdk');
assert.equal(normalizeNewChatHarnessId('plugin_unavailable'), 'sdk');
assert.equal(normalizeNewChatHarnessId('not_loaded'), 'sdk');
assert.equal(normalizeNewChatHarnessId('alpha', { localIds: new Set(['alpha']) }), 'alpha');
assert.equal(normalizeNewChatHarnessId('Alpha-Plugin'), 'sdk');
assert.equal(normalizeNewChatHarnessId(undefined), 'sdk');

// --- 6. chatController hydration: blocked row keeps raw transport + state ------
async function testChatControllerHydration() {
  const chats = [];
  const noop = () => {};
  const controller = createChatController({
    api: {
      getChats: async () => ({
        ok: true,
        chats: [
          {
            id: 'blocked-local',
            title: 'Blocked local',
            cursorSessionId: 'sess-blocked',
            agentTransport: 'Alpha-Plugin',
            harnessState: { code: 'plugin_unavailable', runnable: false },
          },
          {
            id: 'not-loaded-local',
            title: 'Not loaded local',
            cursorSessionId: 'sess-not-loaded',
            agentTransport: 'ghost-plugin',
            harnessState: { code: 'not_loaded', runnable: false },
          },
          {
            id: 'legacy-sdk',
            title: 'Legacy SDK',
            cursorSessionId: 'sess-sdk',
            agentTransport: 'nonsense',
          },
        ],
      }),
    },
    CHAT_BUFFER_MAX: 1000,
    LAST_CHAT_ID_KEY: 'cretli-last-chat-id',
    getChats: () => chats,
    getActiveChatId: () => '',
    setActiveChatId: noop,
    getWorkspaces: () => [],
    setWorkspaces: noop,
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFile: noop,
    getSelectedWorkspaceFolder: () => '',
    setSelectedWorkspaceFolder: noop,
    getSelectedModel: () => 'auto',
    setSelectedModel: noop,
    readChatBufferForChatRestore: () => null,
    updateFolderSelect: noop,
    renderModelSelectOptions: noop,
    renderChatList: noop,
    updateChatBarSelect: noop,
    selectChat: noop,
    syncBackgroundChatConnections: noop,
    bindChatVisibilityAndReconnect: noop,
    startChatBackgroundMonitor: noop,
    startGlobalChatPingLoop: noop,
    ensureChatConnection: noop,
    openTerminal: noop,
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: noop,
  });

  await controller.loadChatsFromServer({ skipAutoSelect: true });

  const blocked = chats.find((chat) => chat.id === 'blocked-local');
  assert.ok(blocked, 'blocked row must hydrate');
  assert.equal(blocked.agentTransport, 'Alpha-Plugin', 'blocked transport must not normalize to sdk');
  assert.equal(blocked.harnessState.code, 'plugin_unavailable', 'harnessState must stay on the chat');
  assert.equal(isBlockingPersistedLocalChatHarnessState(blocked), true);

  const notLoaded = chats.find((chat) => chat.id === 'not-loaded-local');
  assert.ok(notLoaded, 'not_loaded row must hydrate');
  assert.equal(notLoaded.agentTransport, 'sdk', 'not_loaded stays on the legacy normalization path');
  assert.equal(notLoaded.harnessState.code, 'not_loaded');

  const legacy = chats.find((chat) => chat.id === 'legacy-sdk');
  assert.equal(legacy.agentTransport, 'sdk', 'no-state unknown transport keeps falling back to sdk');
  assert.equal('harnessState' in legacy, false, 'no-state rows must not grow a harnessState');
}
await testChatControllerHydration();

// --- 6b. live refresh: non-blocking -> blocking transition tears down + re-renders -----
async function testChatControllerBlockedTransition() {
  const runtimeChat = {
    id: 'transition-local',
    title: 'Transition local',
    cursorSessionId: 'sess-transition',
    agentTransport: 'Alpha-Plugin',
    harnessState: { code: 'not_loaded' },
    pane: { isConnected: true },
    ws: { readyState: 1 },
    _connectionStatus: 'connected',
  };
  const backgroundChat = {
    id: 'transition-background',
    title: 'Background local',
    cursorSessionId: 'sess-transition-bg',
    agentTransport: 'Beta-Plugin',
    harnessState: { code: 'not_loaded' },
    ws: { readyState: 1 },
  };
  const chats = [runtimeChat, backgroundChat];
  let serverRows = [
    {
      id: runtimeChat.id,
      cursorSessionId: runtimeChat.cursorSessionId,
      agentTransport: 'Alpha-Plugin',
      harnessState: { code: 'not_loaded' },
    },
    {
      id: backgroundChat.id,
      cursorSessionId: backgroundChat.cursorSessionId,
      agentTransport: 'Beta-Plugin',
      harnessState: { code: 'not_loaded' },
    },
  ];
  const opened = [];
  const tornDown = [];
  const ensured = [];
  const noop = () => {};
  const controller = createChatController({
    api: { getChats: async () => ({ ok: true, chats: serverRows }) },
    CHAT_BUFFER_MAX: 1000,
    LAST_CHAT_ID_KEY: 'cretli-last-chat-id',
    getChats: () => chats,
    getActiveChatId: () => '',
    setActiveChatId: noop,
    getWorkspaces: () => [],
    setWorkspaces: noop,
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFile: noop,
    getSelectedWorkspaceFolder: () => '',
    setSelectedWorkspaceFolder: noop,
    getSelectedModel: () => 'auto',
    setSelectedModel: noop,
    readChatBufferForChatRestore: () => null,
    updateFolderSelect: noop,
    renderModelSelectOptions: noop,
    renderChatList: noop,
    updateChatBarSelect: noop,
    selectChat: noop,
    syncBackgroundChatConnections: noop,
    bindChatVisibilityAndReconnect: noop,
    startChatBackgroundMonitor: noop,
    startGlobalChatPingLoop: noop,
    ensureChatConnection: (chat) => ensured.push(chat.id),
    teardownBlockedChatRuntime: (chat) => tornDown.push(chat.id),
    openTerminal: (chat) => opened.push(chat.id),
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: noop,
  });

  // First refresh: both rows are not_loaded (non-blocking) -> no transition side effects.
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.deepEqual(opened, [], 'non-blocking rows must not trigger the render hook');
  assert.deepEqual(tornDown, [], 'non-blocking rows must not trigger teardown');
  assert.deepEqual(ensured, [], 'non-blocking rows must not trigger the ensure fallback');

  // Second refresh flips both rows blocking. Only the chat with a mounted pane is
  // re-rendered; every transitioned chat still tears its live runtime down.
  serverRows = [
    { ...serverRows[0], harnessState: { code: 'plugin_unavailable' } },
    { ...serverRows[1], harnessState: { code: 'plugin_disabled' } },
  ];
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.deepEqual(opened, ['transition-local'], 'only the mounted pane is replaced');
  assert.deepEqual(
    tornDown,
    ['transition-local', 'transition-background'],
    'every transitioned chat must be torn down',
  );
  assert.deepEqual(ensured, [], 'the transport teardown API is preferred over ensure');

  // Third refresh with the same blocking state is not a transition: no repeated work.
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.deepEqual(opened, ['transition-local'], 'blocked -> blocked must not re-render');
  assert.deepEqual(
    tornDown,
    ['transition-local', 'transition-background'],
    'blocked -> blocked must not re-teardown',
  );

  // Flipping back to not_loaded is a recovery: the mounted blocked notice must be rebuilt
  // through the ordinary openTerminal hook (never by re-rendering the blocked pane), and
  // the live runtime must not be torn down again.
  serverRows = [
    { ...serverRows[0], harnessState: { code: 'not_loaded' } },
    { ...serverRows[1], harnessState: { code: 'not_loaded' } },
  ];
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.deepEqual(
    opened,
    ['transition-local', 'transition-local'],
    'not_loaded recovery must run the restore hook for the mounted notice',
  );
  assert.deepEqual(
    tornDown,
    ['transition-local', 'transition-background'],
    'not_loaded recovery must not teardown',
  );

  // A further non-blocking refresh is not a transition: no repeated restore work.
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.deepEqual(
    opened,
    ['transition-local', 'transition-local'],
    'non-blocking -> non-blocking must not re-run the restore hook',
  );
}
await testChatControllerBlockedTransition();

// --- 6c. blocked -> not_loaded refresh restores a mounted notice exactly once --------
async function testChatControllerNoticeRestore() {
  const noticePane = {
    isConnected: true,
    dataset: { persistedLocalStateCode: 'plugin_unavailable' },
    removed: false,
  };
  const normalPane = { isConnected: true, dataset: {}, normal: true };
  const noticeChat = {
    id: 'notice-local',
    title: 'Notice local',
    cursorSessionId: 'sess-notice',
    agentTransport: 'Alpha-Plugin',
    harnessState: { code: 'plugin_unavailable' },
    pane: noticePane,
    _connectionStatus: 'disconnected',
  };
  const backgroundBlocked = {
    id: 'notice-background',
    title: 'Notice background',
    cursorSessionId: 'sess-notice-bg',
    agentTransport: 'Beta-Plugin',
    harnessState: { code: 'plugin_disabled' },
  };
  const routineChat = {
    id: 'routine-local',
    title: 'Routine local',
    cursorSessionId: 'sess-routine',
    agentTransport: 'ghost-plugin',
    harnessState: { code: 'not_loaded' },
    pane: normalPane,
  };
  const chats = [noticeChat, backgroundBlocked, routineChat];
  const serverRows = [
    {
      id: 'notice-local',
      cursorSessionId: 'sess-notice',
      agentTransport: 'Alpha-Plugin',
      harnessState: { code: 'not_loaded' },
    },
    {
      id: 'notice-background',
      cursorSessionId: 'sess-notice-bg',
      agentTransport: 'Beta-Plugin',
      harnessState: { code: 'not_loaded' },
    },
    {
      id: 'routine-local',
      cursorSessionId: 'sess-routine',
      agentTransport: 'ghost-plugin',
      harnessState: { code: 'not_loaded' },
    },
    {
      id: 'brand-new',
      cursorSessionId: 'sess-new',
      agentTransport: 'sdk',
      harnessState: { code: 'not_loaded' },
    },
  ];
  const opened = [];
  const noop = () => {};
  const controller = createChatController({
    api: { getChats: async () => ({ ok: true, chats: serverRows }) },
    CHAT_BUFFER_MAX: 1000,
    LAST_CHAT_ID_KEY: 'cretli-last-chat-id',
    getChats: () => chats,
    getActiveChatId: () => '',
    setActiveChatId: noop,
    getWorkspaces: () => [],
    setWorkspaces: noop,
    getSelectedWorkspaceFile: () => '',
    setSelectedWorkspaceFile: noop,
    getSelectedWorkspaceFolder: () => '',
    setSelectedWorkspaceFolder: noop,
    getSelectedModel: () => 'auto',
    setSelectedModel: noop,
    readChatBufferForChatRestore: () => null,
    updateFolderSelect: noop,
    renderModelSelectOptions: noop,
    renderChatList: noop,
    updateChatBarSelect: noop,
    selectChat: noop,
    syncBackgroundChatConnections: noop,
    bindChatVisibilityAndReconnect: noop,
    startChatBackgroundMonitor: noop,
    startGlobalChatPingLoop: noop,
    ensureChatConnection: noop,
    teardownBlockedChatRuntime: noop,
    // Emulate the real openTerminal restore contract: drop the stale notice, then mount a
    // single fresh normal pane. A duplicate invocation would leave an extra pane behind.
    openTerminal: (chat) => {
      opened.push(chat.id);
      if (chat.pane) {
        chat.pane.removed = true;
        chat.pane = null;
      }
      chat.pane = { isConnected: true, dataset: {}, normal: true };
    },
    getChatsForCurrentWorkspace: () => chats,
    setChatStatus: noop,
  });

  await controller.loadChatsFromServer({ skipAutoSelect: true });

  assert.deepEqual(opened, ['notice-local'], 'only the mounted notice is restored');
  assert.equal(noticePane.removed, true, 'the stale notice must be removed');
  assert.equal(noticeChat.pane.normal, true, 'a fresh normal pane must be mounted');
  assert.equal(
    chats.filter((chat) => chat.id === 'notice-local').length,
    1,
    'restore must not duplicate the chat/pane',
  );
  assert.equal(backgroundBlocked.pane, undefined, 'a background blocked chat without a pane is left alone');
  assert.equal(routineChat.pane, normalPane, 'a routine non-blocking pane is untouched');
  assert.ok(chats.some((chat) => chat.id === 'brand-new'), 'a new chat is still hydrated');

  // Re-running the same non-blocking refresh is not a transition: no second restore.
  await controller.loadChatsFromServer({ skipAutoSelect: true });
  assert.deepEqual(opened, ['notice-local'], 'repeated non-blocking refresh must not re-run the hook');
}
await testChatControllerNoticeRestore();

// --- 7. transport guards: blocked chats never open a socket or reconnect timer -
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {FakeWebSocket[]} */
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}

globalThis.WebSocket = FakeWebSocket;
if (!globalThis.location) {
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:3011' };
}

function createTransport(chat) {
  const chats = [chat];
  const noop = () => {};
  return createChatTransport({
    WS_PATH_AGENT_SDK,
    CHAT_RECONNECT_MAX,
    CHAT_RECONNECT_DELAYS,
    CHAT_PING_INTERVAL_MS,
    getChats: () => chats,
    getActiveChatId: () => chat.id,
    getMaintainSessionsEnabled: () => false,
    getChatActivityAt: () => Date.now(),
    getSkipCatchUpOnResume: () => false,
    appLogger: { log() {} },
    setChatStatus: noop,
    setAgentState: noop,
    renderChatTerminalState: noop,
    buildCatchUpSignature: () => '',
    processAgentOutput: noop,
    processAgentOutputCatchUp: noop,
    updateAwaitingInput: noop,
    setLaunchCommand: noop,
    scrollChatTerminalToBottom: noop,
  });
}

const blockedChat = {
  id: 'blocked-transport',
  cursorSessionId: 'sess-blocked-transport',
  agentTransport: 'Alpha-Plugin',
  harnessState: { code: 'plugin_unavailable', runnable: false },
};
const blockedTransport = createTransport(blockedChat);
FakeWebSocket.instances.length = 0;
blockedTransport.ensureChatConnection(blockedChat);
assert.equal(FakeWebSocket.instances.length, 0, 'blocked chat must not open a WebSocket');
assert.ok(!blockedChat._reconnectTimer, 'blocked chat must not arm a reconnect timer');
assert.equal(blockedChat._connectionStatus, 'disconnected');

// scheduleChatReconnect must also be a no-op even with a live-looking session.
blockedTransport.scheduleChatReconnect(blockedChat);
assert.ok(!blockedChat._reconnectTimer, 'blocked chat must not schedule a reconnect');
assert.equal(FakeWebSocket.instances.length, 0);

// Sanity: an unblocked sdk chat still opens a socket, so the guard is scoped.
const sdkChat = {
  id: 'sdk-transport',
  cursorSessionId: 'sess-sdk-transport',
  agentTransport: 'sdk',
};
const sdkTransport = createTransport(sdkChat);
FakeWebSocket.instances.length = 0;
sdkTransport.ensureChatConnection(sdkChat);
assert.equal(FakeWebSocket.instances.length, 1, 'unblocked sdk chat still connects');
assert.equal(sdkChat._connectionStatus, 'connecting');

// --- 8. source wiring: openTerminal returns before any SDK init ---------------
const chatSource = read('app_front/chat.js');
const openStart = chatSource.indexOf('function openTerminal(chat)');
assert.ok(openStart > -1, 'openTerminal must exist');
const sdkInit = chatSource.indexOf('chat._sdkRichView = createSdkRichView', openStart);
assert.ok(sdkInit > openStart, 'SDK rich view init must exist');
const guardOffset = chatSource.indexOf('isBlockingPersistedLocalChatHarnessState(chat)', openStart);
assert.ok(guardOffset > -1, 'openTerminal must consult the blocking helper');
assert.ok(guardOffset < sdkInit, 'blocked guard must run before SDK rich view creation');
assert.match(
  chatSource.slice(openStart, sdkInit),
  /renderPersistedLocalChatBlockedPane\(chat\);\s*\n\s*return;/,
  'blocked openTerminal path must render the notice and return',
);

const transportSource = read('app_front/features/chat/chatTransport.js');
const ensureStart = transportSource.indexOf('function ensureChatConnection(chat)');
const ensureGuard = transportSource.indexOf('isBlockingPersistedLocalChatHarnessState(chat)', ensureStart);
const ensureSocket = transportSource.indexOf('new WebSocket(', ensureStart);
assert.ok(ensureStart > -1 && ensureGuard > ensureStart, 'ensureChatConnection must consult the blocking helper');
assert.ok(ensureGuard < ensureSocket, 'ensureChatConnection must guard before new WebSocket');

const reconnectStart = transportSource.indexOf('function scheduleChatReconnect(chat)');
const reconnectGuard = transportSource.indexOf('isBlockingPersistedLocalChatHarnessState(chat)', reconnectStart);
const reconnectTimer = transportSource.indexOf('_reconnectTimer = setTimeout', reconnectStart);
assert.ok(reconnectStart > -1 && reconnectGuard > reconnectStart, 'scheduleChatReconnect must consult the blocking helper');
assert.ok(reconnectGuard < reconnectTimer, 'scheduleChatReconnect must guard before arming the timer');

const resumeStart = Math.max(
  transportSource.indexOf('function resumeActiveChat(reason'),
  transportSource.indexOf('const resumeActiveChat = (reason')
);
const resumeGuard = transportSource.indexOf('isBlockingPersistedLocalChatHarnessState(active)', resumeStart);
const resumeSync = transportSource.indexOf('onSdkResume(active', resumeStart);
assert.ok(resumeStart > -1 && resumeGuard > resumeStart, 'resumeActiveChat must consult the blocking helper');
assert.ok(resumeGuard < resumeSync, 'resumeActiveChat must guard before SDK history sync');

// --- 9. history poll: blocked chats are dropped before any HTTP / resume sync ------
// Pure selection keeps every non-blocked row (including `not_loaded` and legacy) and
// drops only the four blocking codes, plus rows without an id/session.
const pollRows = [
  { id: 'blocked-unavailable', cursorSessionId: 's1', harnessState: { code: 'plugin_unavailable' } },
  { id: 'blocked-disabled', cursorSessionId: 's2', harnessState: { code: 'plugin_disabled' } },
  { id: 'blocked-capability', cursorSessionId: 's3', harnessState: { code: 'plugin_capability' } },
  { id: 'blocked-host', cursorSessionId: 's4', harnessState: { code: 'host_incompatible' } },
  { id: 'not-loaded', cursorSessionId: 's5', harnessState: { code: 'not_loaded' } },
  { id: 'legacy', cursorSessionId: 's6' },
  { id: 'no-session', harnessState: { code: 'plugin_unavailable' } },
];
assert.deepEqual(
  selectPersistedLocalChatHistoryPollChats(pollRows).map((chat) => chat.id),
  ['not-loaded', 'legacy'],
  'only blocked chats are excluded from the history poll',
);
assert.deepEqual(selectPersistedLocalChatHistoryPollChats(null), []);

if (typeof globalThis.document === 'undefined') {
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
}

const originalFetch = globalThis.fetch;
/** @type {string[]} */
const pollFetchCalls = [];
function installPollFetchStub() {
  globalThis.fetch = async (url) => {
    const href = String(url);
    pollFetchCalls.push(href);
    if (href.includes('/api/chats/agent-states')) {
      return { status: 200, ok: true, json: async () => ({ ok: true, states: {} }) };
    }
    if (href.includes('/api/chats/history-revisions')) {
      const ids = decodeURIComponent(href).match(/ids=([^&]*)/)?.[1]?.split(',') || [];
      const revisions = {};
      for (const id of ids) revisions[id] = { headSeq: 5, hasPendingDelegation: false };
      return { status: 200, ok: true, json: async () => ({ ok: true, revisions }) };
    }
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };
}

async function runHistoryPollScenario(chats, activeId) {
  const syncCalls = [];
  initChatHistorySyncPoll({
    getChats: () => chats,
    getActiveChatId: () => activeId,
    syncSdkHistoryOnResume: async (chat, context = {}) => {
      syncCalls.push({ id: chat.id, reason: context.reason });
      return { status: 'success' };
    },
    appLogger: { log() {} },
    getSdkRoomBusMode: () => 'local',
    hasOpenHarnessWs: () => false,
  });
  await runChatHistoryRevisionPoll();
  stopChatHistorySyncPoll();
  return syncCalls;
}

installPollFetchStub();

// Blocked-only list: returns before the agent-state or history HTTP call entirely.
pollFetchCalls.length = 0;
const blockedOnlySync = await runHistoryPollScenario(
  [{ id: 'blocked-only', cursorSessionId: 's', agentTransport: 'Alpha-Plugin', harnessState: { code: 'plugin_unavailable' } }],
  'blocked-only',
);
assert.deepEqual(blockedOnlySync, [], 'blocked active chat must never resume-sync history');
assert.equal(pollFetchCalls.length, 0, 'a blocked-only poll must not issue agent-state/history HTTP');

// Mixed list with an unblocked active chat: the unblocked chat still syncs, the blocked
// row never reaches the history-revisions request.
pollFetchCalls.length = 0;
const mixedSync = await runHistoryPollScenario(
  [
    { id: 'blocked-mixed', cursorSessionId: 's', agentTransport: 'Alpha-Plugin', harnessState: { code: 'plugin_disabled' } },
    { id: 'ok-mixed', cursorSessionId: 's', agentTransport: 'sdk' },
  ],
  'ok-mixed',
);
assert.deepEqual(mixedSync, [{ id: 'ok-mixed', reason: 'cross_device_poll' }], 'unblocked active chat still syncs');
const revisionFetch = pollFetchCalls.filter((href) => href.includes('/api/chats/history-revisions'));
assert.equal(revisionFetch.length, 1, 'one history-revisions request expected');
assert.ok(revisionFetch[0].includes('ok-mixed'), 'unblocked chat id must be polled');
assert.ok(!revisionFetch[0].includes('blocked-mixed'), 'blocked chat id must never reach history HTTP');

// In-flight transitions: a chat that turns blocking after the poll's start snapshot must
// not drive SDK history. `_serverRunState.state === 'busy'` keeps each row monitored so it
// would otherwise be fetched/pulled.
async function runPollWithFetch(chatList, activeId, fetchImpl) {
  const syncCalls = [];
  globalThis.fetch = fetchImpl;
  initChatHistorySyncPoll({
    getChats: () => chatList,
    getActiveChatId: () => activeId,
    syncSdkHistoryOnResume: async (chat, context = {}) => {
      syncCalls.push({ id: chat.id, reason: context.reason });
      return { status: 'success' };
    },
    appLogger: { log() {} },
    getSdkRoomBusMode: () => 'local',
    hasOpenHarnessWs: () => false,
  });
  await runChatHistoryRevisionPoll();
  stopChatHistorySyncPoll();
  return syncCalls;
}

function jsonResponse(payload) {
  return { status: 200, ok: true, json: async () => payload };
}

// 9a. Blocked while waiting for the revision response: the loop re-check drops the
// background chat before any history-batch pull, and it never ingests.
const inFlightBgRevision = {
  id: 'inflight-bg-revision',
  cursorSessionId: 'sess-inflight-bg',
  agentTransport: 'sdk',
  _serverRunState: { state: 'attention', delegationId: 'd-rev', attention: false },
};
pollFetchCalls.length = 0;
const inFlightRevisionSync = await runPollWithFetch(
  [inFlightBgRevision],
  'some-other-active',
  async (url) => {
    const href = String(url);
    pollFetchCalls.push(href);
    if (href.includes('/api/chats/agent-states')) {
      // Echo the monitored state back (same dedupe key) so the row stays monitored.
      return jsonResponse({ ok: true, states: { [inFlightBgRevision.id]: { ...inFlightBgRevision._serverRunState } } });
    }
    if (href.includes('/api/chats/history-revisions')) {
      // Flip to blocking while the revision request is in flight.
      inFlightBgRevision.harnessState = { code: 'plugin_unavailable' };
      return jsonResponse({
        ok: true,
        revisions: { [inFlightBgRevision.id]: { headSeq: 9, hasPendingDelegation: false } },
      });
    }
    if (href.includes('/api/chats/history-batch')) return jsonResponse({ ok: true, histories: {} });
    return jsonResponse({ ok: true });
  },
);
assert.deepEqual(inFlightRevisionSync, [], 'a chat blocked in flight must not resume-sync');
assert.ok(
  pollFetchCalls.some((href) => href.includes('/api/chats/history-revisions')),
  'the in-flight scenario must reach the revision request before the transition',
);
assert.equal(
  isBlockingPersistedLocalChatHarnessState(inFlightBgRevision),
  true,
  'the scenario must have flipped the chat to blocking in flight',
);
assert.equal(
  pollFetchCalls.filter((href) => href.includes('/api/chats/history-batch')).length,
  0,
  'a chat blocked while the revision was in flight must not be pulled',
);
assert.equal(getLastAckedSeq(inFlightBgRevision.id), 0, 'no history delta may be ingested');
assert.notEqual(inFlightBgRevision._pendingRemoteHistory, true, 'no pull may be queued for the blocked chat');

// 9b. Blocked while waiting for the history-batch response: the post-POST re-check drops
// the ingest so the store ack never advances.
const inFlightBgBatch = {
  id: 'inflight-bg-batch',
  cursorSessionId: 'sess-inflight-batch',
  agentTransport: 'sdk',
  _serverRunState: { state: 'attention', delegationId: 'd-batch', attention: false },
};
pollFetchCalls.length = 0;
const inFlightBatchSync = await runPollWithFetch(
  [inFlightBgBatch],
  'some-other-active',
  async (url) => {
    const href = String(url);
    pollFetchCalls.push(href);
    if (href.includes('/api/chats/agent-states')) {
      return jsonResponse({ ok: true, states: { [inFlightBgBatch.id]: { ...inFlightBgBatch._serverRunState } } });
    }
    if (href.includes('/api/chats/history-revisions')) {
      return jsonResponse({
        ok: true,
        revisions: { [inFlightBgBatch.id]: { headSeq: 9, hasPendingDelegation: false } },
      });
    }
    if (href.includes('/api/chats/history-batch')) {
      // Flip to blocking while the batch POST is in flight.
      inFlightBgBatch.harnessState = { code: 'plugin_disabled' };
      return jsonResponse({
        ok: true,
        histories: {
          [inFlightBgBatch.id]: { headSeq: 9, ackSeq: 9, events: [] },
        },
      });
    }
    return jsonResponse({ ok: true });
  },
);
assert.deepEqual(inFlightBatchSync, [], 'a chat blocked in flight must not resume-sync');
assert.equal(
  pollFetchCalls.filter((href) => href.includes('/api/chats/history-batch')).length,
  1,
  'the batch POST is expected to have been issued before the transition',
);
assert.equal(
  getLastAckedSeq(inFlightBgBatch.id),
  0,
  'a chat blocked while the batch was in flight must not ingest the delta',
);

globalThis.fetch = originalFetch;

// --- 10. server recovery: blocked active chat is skipped, others still recover ------
const recoveryBlockedActive = {
  id: 'blocked-recovery',
  cursorSessionId: 's',
  agentTransport: 'Alpha-Plugin',
  harnessState: { code: 'host_incompatible' },
};
const recoveryHealthy = { id: 'healthy-recovery', cursorSessionId: 's', agentTransport: 'sdk' };
let recoveryEnsure = 0;
let recoveryForce = 0;
let recoveryHistory = 0;
let recoveryNotice = 0;
let recoveryBackground = 0;
const recoveryResult = applyChatConnectionRecovery(
  {
    getChats: () => [recoveryBlockedActive, recoveryHealthy],
    getActiveChatId: () => 'blocked-recovery',
    ensureChatConnection: () => { recoveryEnsure += 1; },
    forceReconnectChat: () => { recoveryForce += 1; },
    syncBackgroundChatConnections: () => { recoveryBackground += 1; },
    syncSdkHistoryOnResume: async () => { recoveryHistory += 1; },
    appendRecoveryNotice: () => { recoveryNotice += 1; },
    appLogger: { log() {} },
  },
  { serverRestarted: true },
);
assert.equal(recoveryForce, 0, 'blocked active chat must not force reconnect');
assert.equal(recoveryEnsure, 0, 'blocked active chat must not ensure a connection');
assert.equal(recoveryHistory, 0, 'blocked active chat must not sync history');
assert.equal(recoveryNotice, 0, 'blocked active chat must not receive recovery notices');
assert.equal(recoveryBackground, 1, 'background recovery for the other chats must still run');
assert.equal(recoveryResult.reconnectedActive, false);

// --- 11. live WS: blocked transition closes the socket and never warms up -----------
function createTransportForChats(chats, activeId, maintainSessions = true) {
  const noop = () => {};
  return createChatTransport({
    WS_PATH_AGENT_SDK,
    CHAT_RECONNECT_MAX,
    CHAT_RECONNECT_DELAYS,
    CHAT_PING_INTERVAL_MS,
    getChats: () => chats,
    getActiveChatId: () => activeId,
    getMaintainSessionsEnabled: () => maintainSessions,
    getChatActivityAt: () => Date.now(),
    getSkipCatchUpOnResume: () => false,
    appLogger: { log() {} },
    setChatStatus: noop,
    setAgentState: noop,
    renderChatTerminalState: noop,
    buildCatchUpSignature: () => '',
    processAgentOutput: noop,
    processAgentOutputCatchUp: noop,
    updateAwaitingInput: noop,
    setLaunchCommand: noop,
    scrollChatTerminalToBottom: noop,
  });
}

const blockedLive = {
  id: 'blocked-live',
  cursorSessionId: 'sess-blocked-live',
  agentTransport: 'Alpha-Plugin',
  harnessState: { code: 'plugin_unavailable' },
  _sdkEventStreamId: 'stream-live-1',
  _connectionStatus: 'connected',
};
const liveTransport = createTransportForChats([blockedLive], blockedLive.id, true);

// An open socket must be detached and closed when the chat is (now) blocked. The close
// handler must be cleared *before* close so a teardown cannot re-enter reconnect logic.
const liveSocket = new FakeWebSocket('ws://blocked-live');
liveSocket.readyState = FakeWebSocket.OPEN;
let liveSocketCloseHandlerCalls = 0;
liveSocket.onmessage = () => {};
liveSocket.onopen = () => {};
liveSocket.onerror = () => {};
liveSocket.onclose = () => { liveSocketCloseHandlerCalls += 1; };
blockedLive.ws = liveSocket;
FakeWebSocket.instances.length = 0;
liveTransport.ensureChatConnection(blockedLive);
assert.equal(liveSocket.readyState, FakeWebSocket.CLOSED, 'blocked transition must close the live socket');
assert.equal(liveSocket.onmessage, null, 'teardown must detach onmessage before close');
assert.equal(liveSocket.onopen, null, 'teardown must detach onopen before close');
assert.equal(liveSocket.onerror, null, 'teardown must detach onerror before close');
assert.equal(liveSocket.onclose, null, 'teardown must detach onclose before close');
assert.equal(liveSocketCloseHandlerCalls, 0, 'a detached onclose handler must not re-enter reconnect');
assert.equal(blockedLive.ws, null, 'blocked transition must drop the socket reference');
assert.equal(blockedLive._connectionStatus, 'disconnected');
assert.equal(FakeWebSocket.instances.length, 0, 'blocked transition must not open a replacement socket');
assert.ok(
  !liveSocket.sent.some((frame) => String(frame).includes('warmup')),
  'blocked transition must not send a warmup frame',
);

// The background enqueue path must neither warm up nor reconnect a blocked active chat,
// and it must tear down any socket that was already live (the skipAutoSelect list-refresh
// path reaches teardown through here).
const liveSocket2 = new FakeWebSocket('ws://blocked-live-2');
liveSocket2.readyState = FakeWebSocket.OPEN;
blockedLive.ws = liveSocket2;
blockedLive._sdkEventStreamId = 'stream-live-2';
delete blockedLive._sdkWarmupRequestedForStream;
FakeWebSocket.instances.length = 0;
liveTransport.syncBackgroundChatConnections();
assert.ok(
  !liveSocket2.sent.some((frame) => String(frame).includes('warmup')),
  'background enqueue must not warm up a blocked chat',
);
assert.equal(FakeWebSocket.instances.length, 0, 'background enqueue must not reconnect a blocked chat');
assert.equal(liveSocket2.readyState, FakeWebSocket.CLOSED, 'blocked enqueue must close the live socket');
assert.equal(blockedLive.ws, null, 'blocked enqueue must drop the socket reference');

// Source wiring: every queue/warmup entry point and the drain guard the helper.
const drainStart = transportSource.indexOf('function drainBackgroundReconnectQueue()');
const drainGuard = transportSource.indexOf('isBlockingPersistedLocalChatHarnessState(chat)', drainStart);
const drainDrain = transportSource.indexOf('ensureChatConnection(chat);', drainStart);
assert.ok(drainStart > -1 && drainGuard > drainStart, 'drainBackgroundReconnectQueue must guard blocked chats');
assert.ok(drainGuard < drainDrain, 'drain must filter blocked chats before connecting/warming');

const warmupStart = transportSource.indexOf('function requestActiveSdkWarmup(chat)');
const warmupGuard = transportSource.indexOf('isBlockingPersistedLocalChatHarnessState(chat)', warmupStart);
const warmupSend = transportSource.indexOf("type: 'warmup'", warmupStart);
assert.ok(warmupStart > -1 && warmupGuard > warmupStart, 'requestActiveSdkWarmup must guard blocked chats');
assert.ok(warmupGuard < warmupSend, 'warmup guard must run before sending');

const enqueueStart = transportSource.indexOf('function enqueueBackgroundChatReconnect(chat)');
const enqueueGuard = transportSource.indexOf('isBlockingPersistedLocalChatHarnessState(chat)', enqueueStart);
assert.ok(enqueueStart > -1 && enqueueGuard > enqueueStart, 'enqueueBackgroundChatReconnect must guard blocked chats');
const enqueueSource = transportSource.slice(enqueueStart, transportSource.indexOf('\n  function ', enqueueStart + 10));
const enqueueTeardownAt = enqueueSource.indexOf('teardownBlockedChatRuntime(chat)');
assert.ok(
  enqueueTeardownAt > enqueueSource.indexOf('isBlockingPersistedLocalChatHarnessState(chat)'),
  'blocked enqueue must tear the live runtime down, not only drop the queue entry',
);

const teardownStart = transportSource.indexOf('function teardownBlockedChatRuntime(chat)');
assert.ok(teardownStart > -1, 'teardownBlockedChatRuntime must exist');
const teardownSource = transportSource.slice(teardownStart, transportSource.indexOf('\n  function ', teardownStart + 10));
assert.match(teardownSource, /detachChatSocket\(socket\)/, 'teardown must detach the socket');
assert.match(teardownSource, /socket\.close\(\)/, 'teardown must close the socket');

// --- 12. mounted pane: blocked transition replaces the live SDK pane ----------------
const mountedStart = chatSource.indexOf('function replaceMountedPersistedLocalChatBlockedPane(chat)');
assert.ok(mountedStart > -1, 'replaceMountedPersistedLocalChatBlockedPane must exist');
const mountedEnd = chatSource.indexOf('\nfunction ', mountedStart + 10);
const mountedSource = chatSource.slice(mountedStart, mountedEnd);
assert.match(mountedSource, /_sdkRichView\?\.destroy\?\.\(\)/, 'mounted transition must destroy the rich view');
assert.match(
  mountedSource,
  /chatTransport\.teardownBlockedChatRuntime\(chat\)/,
  'mounted transition must delegate socket teardown to the transport helper',
);
assert.doesNotMatch(
  mountedSource,
  /chat\.ws = null/,
  'mounted transition must not zero the socket before the helper detaches it',
);
assert.match(mountedSource, /chat\.sdkModeBarEl = null/, 'mounted transition must unbind the shared mode bar');
assert.match(mountedSource, /chat\.pane\.remove\(\)/, 'mounted transition must remove the old pane');
const mountedRemoveAt = mountedSource.indexOf('chat.pane.remove()');
const mountedRenderAt = mountedSource.indexOf('renderPersistedLocalChatBlockedPane(chat)');
assert.ok(mountedRemoveAt > -1 && mountedRenderAt > mountedRemoveAt, 'old pane must be removed before the notice is re-rendered (no duplicates)');

const openMountedAt = chatSource.indexOf('if (isChatPaneMounted(chat)) {', chatSource.indexOf('function openTerminal(chat)'));
assert.ok(openMountedAt > -1, 'openTerminal must special-case a mounted pane');
const openMountedSlice = chatSource.slice(openMountedAt, chatSource.indexOf('return;', openMountedAt) + 8);
assert.match(openMountedSlice, /isBlockingPersistedLocalChatHarnessState\(chat\)/, 'mounted openTerminal must consult the blocking helper');
assert.match(openMountedSlice, /replaceMountedPersistedLocalChatBlockedPane\(chat\)/, 'mounted openTerminal must replace the SDK pane');
assert.match(chatSource, /pane\.dataset\.persistedLocalStateCode = resolveBlockingPersistedLocalChatStateCode\(chat\)/, 'blocked pane must record its state code');

// The shared history-sync entry point is a second line of defence: no SDK history fetch
// for a blocked chat even from a lifecycle path that forgot its own guard.
const historySyncStart = chatSource.indexOf('async function syncSdkHistoryOnResume(chat');
const historySyncGuard = chatSource.indexOf('isBlockingPersistedLocalChatHarnessState(chat)', historySyncStart);
const historySyncStartWork = chatSource.indexOf('setChatHistorySyncInFlight(chat, true', historySyncStart);
assert.ok(historySyncStart > -1 && historySyncGuard > historySyncStart, 'syncSdkHistoryOnResume must guard blocked chats');
assert.ok(historySyncGuard < historySyncStartWork, 'history-sync guard must run before any SDK history work');

// --- 13. sidebar icon: a blocked local plugin never shows a Cursor brand ------------
assert.equal(
  resolveSidebarHarnessIcon({ agentTransport: 'Alpha-Plugin', harnessState: { code: 'plugin_unavailable' } }),
  '',
  'blocked local plugin must render no brand icon',
);
assert.equal(
  resolveSidebarHarnessIcon({ agentTransport: 'Alpha-Plugin', harnessState: { code: 'plugin_disabled' } }),
  '',
);
assert.equal(resolveSidebarHarnessIcon({ agentTransport: 'sdk' }), 'cursor.svg');
assert.equal(resolveSidebarHarnessIcon({ agentTransport: 'claude' }), 'claude.svg');
assert.equal(resolveSidebarHarnessIcon({ agentTransport: 'opencode' }), 'opencode.svg');
// `not_loaded`/no-state still use the normal icon path (unknown -> the legacy default).
assert.equal(resolveSidebarHarnessIcon({ agentTransport: 'ghost', harnessState: { code: 'not_loaded' } }), 'cursor.svg');
assert.equal(resolveSidebarHarnessIcon({}), 'cursor.svg');

console.log('persisted-local-chat-state-ui.test.js OK');
