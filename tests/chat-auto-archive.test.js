/**
 * Unit tests for automatic idle-chat archiving
 * (lib/persist/settings.js `getChatAutoArchiveSettings` and
 * lib/chat-auto-archive.js `sweepIdleChats`).
 *
 * Fully dependency-injected: no chat store, no delegation store, no model.
 *
 * Runner: plain assertion script — `node tests/chat-auto-archive.test.js`.
 */

import assert from 'node:assert/strict';
import {
  CHAT_AUTO_ARCHIVE_DEFAULT_UNIT,
  CHAT_AUTO_ARCHIVE_DEFAULT_VALUE,
  CHAT_AUTO_ARCHIVE_UNIT_MS,
  getChatAutoArchiveSettings,
} from '../lib/persist/settings.js';
import { CHAT_AUTO_ARCHIVE_DAY_MS, sweepIdleChats } from '../lib/chat-auto-archive.js';

let failures = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

const NOW = Date.parse('2026-03-03T12:00:00.000Z');
const OLD_AT = new Date(NOW - 8 * CHAT_AUTO_ARCHIVE_DAY_MS).toISOString();
const FRESH_AT = new Date(NOW - CHAT_AUTO_ARCHIVE_DAY_MS).toISOString();

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function chat(overrides = {}) {
  return {
    id: 'chat-1',
    workspaceFolder: '/tmp/cr',
    updatedAt: OLD_AT,
    ...overrides,
  };
}

/**
 * @param {{ chats?: object[], rows?: Record<string, object[]>, archived: string[] }} input
 * @param {object} [extra]
 * @returns {object}
 */
function makeDeps(input, extra = {}) {
  const chats = input.chats || [];
  const rows = input.rows || {};
  return {
    loadChats: () => chats,
    updateChat: (id) => { input.archived.push(String(id)); },
    listDelegationsForParent: (parentId) => rows[String(parentId)] || [],
    isChatRunConfirmedIdle: () => true,
    isDelegationSlotOccupied: () => false,
    isTerminalDelegationStatus: (status) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status),
    ...extra,
  };
}

test('auto-archive defaults to disabled with a 30-day idle window', () => {
  assert.deepEqual(getChatAutoArchiveSettings({}), {
    enabled: false,
    idleValue: CHAT_AUTO_ARCHIVE_DEFAULT_VALUE,
    idleUnit: CHAT_AUTO_ARCHIVE_DEFAULT_UNIT,
    idleMs: CHAT_AUTO_ARCHIVE_DEFAULT_VALUE * CHAT_AUTO_ARCHIVE_UNIT_MS[CHAT_AUTO_ARCHIVE_DEFAULT_UNIT],
  });
});

test('auto-archive settings accept minutes, hours and days', () => {
  assert.deepEqual(getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue: 15, idleUnit: 'minutes' } }), {
    enabled: true,
    idleValue: 15,
    idleUnit: 'minutes',
    idleMs: 15 * 60_000,
  });
  assert.deepEqual(getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue: 2.4, idleUnit: 'hours' } }), {
    enabled: true,
    idleValue: 2,
    idleUnit: 'hours',
    idleMs: 2 * 60 * 60_000,
  });
});

test('an out-of-range or corrupt value falls back to the default window', () => {
  for (const idleValue of [0, -3, 525_601, 10_000_000, 'nope', null, undefined]) {
    const out = getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue, idleUnit: 'minutes' } });
    assert.equal(out.idleValue, CHAT_AUTO_ARCHIVE_DEFAULT_VALUE, `idleValue=${idleValue}`);
    assert.equal(out.idleUnit, CHAT_AUTO_ARCHIVE_DEFAULT_UNIT);
    assert.equal(out.idleMs, CHAT_AUTO_ARCHIVE_DEFAULT_VALUE * CHAT_AUTO_ARCHIVE_UNIT_MS[CHAT_AUTO_ARCHIVE_DEFAULT_UNIT]);
  }
});

test('an unknown unit falls back to the default window', () => {
  const out = getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue: 5, idleUnit: 'weeks' } });
  assert.equal(out.idleUnit, CHAT_AUTO_ARCHIVE_DEFAULT_UNIT);
  assert.equal(out.idleValue, CHAT_AUTO_ARCHIVE_DEFAULT_VALUE);
});

test('a seven-day value keeps the original 7-day window', () => {
  const out = getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } });
  assert.equal(out.idleMs, 7 * CHAT_AUTO_ARCHIVE_DAY_MS);
});

test('disabled auto-archive never writes to the store', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat()], archived });
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: false, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.equal(out.enabled, false);
  assert.equal(out.reason, 'disabled');
  assert.deepEqual(out.archived, []);
  assert.deepEqual(archived, []);
});

test('an idle chat past the window is archived', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat()], archived });
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, ['chat-1']);
  assert.deepEqual(out.archived, ['chat-1']);
  assert.equal(out.considered, 1);
  assert.equal(out.reason, 'archived');
});

test('a chat younger than the window is left alone', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ updatedAt: FRESH_AT })], archived });
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.considered, 0);
});

test('a pinned chat is never archived', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ watcherPinned: true })], archived });
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.considered, 0);
});

test('a chat with an unconfirmed-idle run is never archived', () => {
  const archived = [];
  const deps = makeDeps(
    { chats: [chat()], archived },
    { isChatRunConfirmedIdle: () => false },
  );
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.deepEqual(out.archived, []);
});

test('an already archived chat is skipped', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ archived: true, archivedAt: OLD_AT })], archived });
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.considered, 0);
});

test('a family is archived children-before-parent', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'parent' }),
      chat({ id: 'child', forkParentChatId: 'parent', forkKind: 'delegation' }),
    ],
    rows: { parent: [{ parentChatId: 'parent', childChatId: 'child', status: 'completed' }] },
    archived,
  });
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, ['child', 'parent']);
  assert.deepEqual(out.archived, ['child', 'parent']);
});

test('a family with a running delegated child stays visible', () => {
  const archived = [];
  const deps = makeDeps(
    {
      chats: [
        chat({ id: 'parent' }),
        chat({ id: 'child', forkParentChatId: 'parent', forkKind: 'delegation' }),
      ],
      rows: { parent: [{ parentChatId: 'parent', childChatId: 'child', status: 'starting' }] },
      archived,
    },
    { isTerminalDelegationStatus: () => false, isDelegationSlotOccupied: () => true },
  );
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.skipped, 2);
});

test('a failing chat-store read never throws', () => {
  const out = sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps: {
      loadChats: () => { throw new Error('corrupt store'); },
    },
  });
  assert.equal(out.reason, 'load_failed');
  assert.deepEqual(out.archived, []);
});

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nchat-auto-archive: all cases passed');
