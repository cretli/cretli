import test from 'node:test';
import assert from 'node:assert/strict';
import { patchSidebarChatRowVisualState } from '../app_front/features/sidebar/sidebarChatRowVisualPatch.js';
import {
  __resetChatAutoArchiveConfigForTest,
  setChatAutoArchiveConfig,
} from '../app_front/features/chat/chatAutoArchiveConfig.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const THIRTY_DAYS = 30 * DAY;

/** @param {number} ms */
function iso(ms) {
  return new Date(ms).toISOString();
}

function makeAttrs() {
  const attrs = new Map();
  return {
    get(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    set(name, value) {
      attrs.set(name, String(value));
    },
  };
}

function makeAwaitingEl() {
  const attrs = makeAttrs();
  return {
    hidden: true,
    className: '',
    innerHTML: '',
    getAttribute: attrs.get,
    setAttribute: attrs.set,
    querySelector() {
      return null;
    },
  };
}

function makeLi() {
  const stateEl = { className: '', title: '', setAttribute(name, value) { if (name === 'title') this.title = value; } };
  const awaitingEl = makeAwaitingEl();
  return {
    dataset: {},
    classList: { toggled: [], toggle(name, value) { this.toggled.push([name, value]); } },
    _stateEl: stateEl,
    _awaitingEl: awaitingEl,
    querySelector(selector) {
      if (selector === '.sidebar-chat-item-state') return stateEl;
      if (selector === '.sidebar-chat-item-awaiting') return awaitingEl;
      return null;
    },
  };
}

function idleMeta() {
  return { tone: 'idle', label: 'Ready' };
}

test('a near-deadline idle chat renders the countdown chip in place of the idle status', () => {
  __resetChatAutoArchiveConfigForTest();
  setChatAutoArchiveConfig({ enabled: true, idleValue: 30, idleUnit: 'days' });
  const li = makeLi();
  const chat = { id: 'c1', title: 'Chat', updatedAt: iso(Date.now() - (THIRTY_DAYS - 2 * DAY)) };
  patchSidebarChatRowVisualState(li, chat, { t: (key) => key, getSidebarChatStateMeta: idleMeta });

  assert.equal(li._awaitingEl.hidden, false, 'the chip becomes visible');
  assert.equal(li._awaitingEl.className, 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--archive-soon');
  assert.match(li._awaitingEl.innerHTML, /mdi-progress-clock/);
  assert.match(li._awaitingEl.innerHTML, /sidebar-chat-item-activity-label">\d+d/);
  assert.match(li.dataset.visualKey, /archive-soon/);
  assert.equal(li._stateEl.className, 'sidebar-chat-item-state sidebar-chat-item-state--idle');
  __resetChatAutoArchiveConfigForTest();
});

test('a chat with live work keeps its run status instead of the countdown', () => {
  __resetChatAutoArchiveConfigForTest();
  setChatAutoArchiveConfig({ enabled: true, idleValue: 30, idleUnit: 'days' });
  const li = makeLi();
  const chat = { id: 'c1', title: 'Chat', updatedAt: iso(Date.now() - (THIRTY_DAYS - 2 * DAY)) };
  patchSidebarChatRowVisualState(li, chat, {
    t: (key) => key,
    getSidebarChatStateMeta: () => ({ tone: 'active', label: 'Working', activityKey: 'run' }),
  });

  assert.equal(li._awaitingEl.className, 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--active');
  assert.doesNotMatch(li._awaitingEl.innerHTML, /mdi-progress-clock/);
  __resetChatAutoArchiveConfigForTest();
});

test('a pinned chat never shows the countdown even when idle past the window', () => {
  __resetChatAutoArchiveConfigForTest();
  setChatAutoArchiveConfig({ enabled: true, idleValue: 30, idleUnit: 'days' });
  const li = makeLi();
  const chat = { id: 'c1', title: 'Chat', updatedAt: iso(Date.now() - THIRTY_DAYS), watcherPinned: true };
  patchSidebarChatRowVisualState(li, chat, { t: (key) => key, getSidebarChatStateMeta: idleMeta });

  assert.equal(li._awaitingEl.hidden, true, 'nothing replaces the idle chip for a pinned chat');
  assert.equal(li._awaitingEl.className, 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--idle');
  __resetChatAutoArchiveConfigForTest();
});

test('a disconnected chat keeps its connection warning instead of the countdown', () => {
  __resetChatAutoArchiveConfigForTest();
  setChatAutoArchiveConfig({ enabled: true, idleValue: 30, idleUnit: 'days' });
  const li = makeLi();
  const chat = { id: 'c1', title: 'Chat', updatedAt: iso(Date.now() - THIRTY_DAYS) };
  patchSidebarChatRowVisualState(li, chat, {
    t: (key) => key,
    getSidebarChatStateMeta: () => ({ tone: 'disconnected', label: 'Disconnected' }),
  });

  assert.equal(li._awaitingEl.hidden, false);
  assert.equal(li._awaitingEl.className, 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--disconnected');
  assert.equal(li._stateEl.className, 'sidebar-chat-item-state sidebar-chat-item-state--disconnected');
  __resetChatAutoArchiveConfigForTest();
});

test('with auto-archive disabled the chip stays hidden even at the deadline', () => {
  __resetChatAutoArchiveConfigForTest();
  const li = makeLi();
  const chat = { id: 'c1', title: 'Chat', updatedAt: iso(Date.now() - THIRTY_DAYS) };
  patchSidebarChatRowVisualState(li, chat, { t: (key) => key, getSidebarChatStateMeta: idleMeta });

  assert.equal(li._awaitingEl.hidden, true);
  assert.equal(li._awaitingEl.className, 'sidebar-chat-item-awaiting sidebar-chat-item-awaiting--idle');
  __resetChatAutoArchiveConfigForTest();
});
