import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidebarView } from '../app_front/features/sidebar/sidebarView.js';
import { writeChatOrder } from '../app_front/features/sidebar/sidebarChatOrder.js';

/**
 * The structural render signature decides whether `render()` rebuilds the whole
 * `.sidebar-body`. Per leaf 00df6141 the status tone/state and the active-chat
 * marker must NOT be part of it (they are applied by a targeted row patch), while
 * title / parent / archive / order MUST be.
 *
 * These run the real `createSidebarView` closure under Node with a fake
 * localStorage and injected deps, and call the exposed `renderSignature()` seam.
 */

function installLocalStorageStub() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  return map;
}

function makeView(state) {
  return createSidebarView({
    getWorkspaces: () => [{ name: 'WS', workspaceFile: '/w' }],
    getActiveWorkspaceFile: () => '/w',
    getActiveWorkspaceFolder: () => '/f',
    getActiveChatId: () => state.activeId,
    getArchivedCounts: () => ({}),
    getChats: () => state.chats,
    chatFavorites: { isFavorite: () => false },
    resolveChatState: (chat) => (chat && chat.id === state.activeId ? 'active' : 'idle'),
    getTerminalStateMeta: (chat) => ({
      tone: (chat && state.tones[chat.id]) || 'idle',
      label: (chat && state.labels[chat.id]) || 'Idle',
      status: chat && state.outcomes[chat.id] ? state.outcomes[chat.id] : '',
    }),
    escapeHtml: (value) => String(value ?? ''),
    canPinChatToUrl: () => false,
    selectChat: () => {},
    switchWorkspace: () => Promise.resolve(true),
  });
}

function baseState() {
  return {
    activeId: 'c1',
    chats: [
      { id: 'c1', title: 'Alpha', workspaceFile: '/w', workspaceFolder: '/f' },
      { id: 'c2', title: 'Beta', workspaceFile: '/w', workspaceFolder: '/f' },
    ],
    tones: { c1: 'active', c2: 'idle' },
    labels: { c1: 'Working', c2: 'Idle' },
    outcomes: {},
  };
}

test('status tone change does NOT change the structural signature', () => {
  installLocalStorageStub();
  const state = baseState();
  const view = makeView(state);
  const before = view.renderSignature();
  state.tones.c2 = 'attention';
  state.labels.c2 = 'Needs action';
  const after = view.renderSignature();
  assert.equal(after, before, 'a per-row status tone/label must not rebuild the list');
});

test('settled outcome change does NOT change the structural signature', () => {
  installLocalStorageStub();
  const state = baseState();
  const view = makeView(state);
  const before = view.renderSignature();
  state.tones.c2 = 'attention';
  state.outcomes.c2 = 'completed';
  const after = view.renderSignature();
  assert.equal(after, before);
});

test('switching the active chat does NOT change the structural signature', () => {
  installLocalStorageStub();
  const state = baseState();
  const view = makeView(state);
  const before = view.renderSignature();
  state.activeId = 'c2';
  const after = view.renderSignature();
  assert.equal(after, before, 'active chat is applied by a targeted row/class patch');
});

test('title change DOES change the structural signature', () => {
  installLocalStorageStub();
  const state = baseState();
  const view = makeView(state);
  const before = view.renderSignature();
  state.chats[1].title = 'Beta renamed';
  const after = view.renderSignature();
  assert.notEqual(after, before);
});

test('fork-parent change DOES change the structural signature', () => {
  installLocalStorageStub();
  const state = baseState();
  const view = makeView(state);
  const before = view.renderSignature();
  state.chats[1].forkParentChatId = 'c1';
  const after = view.renderSignature();
  assert.notEqual(after, before);
});

test('archiving a chat DOES change the structural signature', () => {
  installLocalStorageStub();
  const state = baseState();
  const view = makeView(state);
  const before = view.renderSignature();
  state.chats[1].archivedAt = '2026-10-05T00:00:00.000Z';
  const after = view.renderSignature();
  assert.notEqual(after, before);
});

test('chat order change DOES change the structural signature', () => {
  installLocalStorageStub();
  const state = baseState();
  const view = makeView(state);
  const before = view.renderSignature();
  writeChatOrder(['c2', 'c1']);
  const after = view.renderSignature();
  assert.notEqual(after, before);
});
