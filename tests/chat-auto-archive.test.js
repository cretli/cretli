/**
 * Unit tests for automatic idle-chat archiving
 * (lib/persist/settings.js `getChatAutoArchiveSettings` and
 * lib/chat-auto-archive.js `sweepIdleChats`).
 *
 * Fully dependency-injected: no chat store, no delegation store, no model.
 *
 * Runner: plain assertion script — `node tests/chat-auto-archive.test.js`.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  CHAT_AUTO_ARCHIVE_DEFAULT_UNIT,
  CHAT_AUTO_ARCHIVE_DEFAULT_VALUE,
  CHAT_AUTO_ARCHIVE_UNIT_MS,
  getChatAutoArchiveSettings,
} from '../lib/persist/settings.js';
import { CHAT_AUTO_ARCHIVE_DAY_MS, sweepIdleChats } from '../lib/chat-auto-archive.js';
import { reportChatAutoArchive } from '../lib/chat-auto-archive-worker.js';

let failures = 0;
const pending = [];

/**
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => console.log(`ok - ${name}`), (err) => {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }));
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
    listDelegationsForController: (parentId) => rows[String(parentId)] || [],
    isChatRunConfirmedIdle: () => true,
    isDelegationSlotOccupied: () => false,
    isTerminalDelegationStatus: (status) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status),
    loadFavoriteChatIds: () => new Set(),
    ...extra,
  };
}

test('auto-archive defaults to disabled with a 30-day idle window', async () => {
  assert.deepEqual(getChatAutoArchiveSettings({}), {
    enabled: false,
    idleValue: CHAT_AUTO_ARCHIVE_DEFAULT_VALUE,
    idleUnit: CHAT_AUTO_ARCHIVE_DEFAULT_UNIT,
    idleMs: CHAT_AUTO_ARCHIVE_DEFAULT_VALUE * CHAT_AUTO_ARCHIVE_UNIT_MS[CHAT_AUTO_ARCHIVE_DEFAULT_UNIT],
    skipFavorites: true,
    skipUnread: true,
  });
  assert.equal(getChatAutoArchiveSettings({ chatAutoArchive: { skipFavorites: false } }).skipFavorites, false);
});

test('auto-archive settings accept minutes, hours and days', async () => {
  assert.deepEqual(getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue: 15, idleUnit: 'minutes' } }), {
    enabled: true,
    idleValue: 15,
    idleUnit: 'minutes',
    idleMs: 15 * 60_000,
    skipFavorites: true,
    skipUnread: true,
  });
  assert.deepEqual(getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue: 2.4, idleUnit: 'hours' } }), {
    enabled: true,
    idleValue: 2,
    idleUnit: 'hours',
    idleMs: 2 * 60 * 60_000,
    skipFavorites: true,
    skipUnread: true,
  });
});

test('an out-of-range or corrupt value falls back to the default window', async () => {
  for (const idleValue of [0, -3, 525_601, 10_000_000, 'nope', null, undefined]) {
    const out = getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue, idleUnit: 'minutes' } });
    assert.equal(out.idleValue, CHAT_AUTO_ARCHIVE_DEFAULT_VALUE, `idleValue=${idleValue}`);
    assert.equal(out.idleUnit, CHAT_AUTO_ARCHIVE_DEFAULT_UNIT);
    assert.equal(out.idleMs, CHAT_AUTO_ARCHIVE_DEFAULT_VALUE * CHAT_AUTO_ARCHIVE_UNIT_MS[CHAT_AUTO_ARCHIVE_DEFAULT_UNIT]);
  }
});

test('an unknown unit falls back to the default window', async () => {
  const out = getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue: 5, idleUnit: 'weeks' } });
  assert.equal(out.idleUnit, CHAT_AUTO_ARCHIVE_DEFAULT_UNIT);
  assert.equal(out.idleValue, CHAT_AUTO_ARCHIVE_DEFAULT_VALUE);
});

test('a seven-day value keeps the original 7-day window', async () => {
  const out = getChatAutoArchiveSettings({ chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } });
  assert.equal(out.idleMs, 7 * CHAT_AUTO_ARCHIVE_DAY_MS);
});

test('disabled auto-archive never writes to the store', async () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat()], archived });
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: false, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.equal(out.enabled, false);
  assert.equal(out.reason, 'disabled');
  assert.deepEqual(out.archived, []);
  assert.deepEqual(archived, []);
});

test('an idle chat past the window is archived', async () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat()], archived });
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, ['chat-1']);
  assert.deepEqual(out.archived, ['chat-1']);
  assert.equal(out.considered, 1);
  assert.equal(out.reason, 'archived');
});

test('a chat younger than the window is left alone', async () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ updatedAt: FRESH_AT })], archived });
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.considered, 0);
});

test('a pinned chat is never archived', async () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ watcherPinned: true })], archived });
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.considered, 0);
});

test('a chat with an unconfirmed-idle run is never archived', async () => {
  const archived = [];
  const deps = makeDeps(
    { chats: [chat()], archived },
    { isChatRunConfirmedIdle: () => false },
  );
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.deepEqual(out.archived, []);
});

test('an already archived chat is skipped', async () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ archived: true, archivedAt: OLD_AT })], archived });
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.considered, 0);
});

test('a family is archived children-before-parent', async () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'parent' }),
      chat({ id: 'child', forkParentChatId: 'parent', forkKind: 'delegation' }),
    ],
    rows: { parent: [{ parentChatId: 'parent', childChatId: 'child', status: 'completed' }] },
    archived,
  });
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, ['child', 'parent']);
  assert.deepEqual(out.archived, ['child', 'parent']);
});

test('a child that acquires a delegation slot during the sweep blocks the parent cascade', async () => {
  const archived = [];
  let occupied = false;
  const deps = makeDeps({
    chats: [chat({ id: 'parent' }), chat({ id: 'child', forkParentChatId: 'parent' })],
    rows: { parent: [{ childChatId: 'child', status: 'completed' }] },
    archived,
  }, {
    isDelegationSlotOccupied: () => occupied,
    updateChat: async (id) => {
      archived.push(id);
      if (id === 'child') occupied = true;
    },
  });
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, ['child']);
  assert.deepEqual(out.archived, ['child']);
  assert.ok(out.skipped > 0);
});

test('a family with a running delegated child stays visible', async () => {
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
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.skipped, 2);
});

test('a family with a running forked child stays visible', async () => {
  const archived = [];
  const deps = makeDeps(
    { chats: [chat({ id: 'parent' }), chat({ id: 'child', forkParentChatId: 'parent' })], archived },
    { isChatRunConfirmedIdle: ({ chatId }) => chatId !== 'child' },
  );
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.deepEqual(out.archived, []);
});

test('postponing archiving restarts the idle window, with or without skipUnread', async () => {
  const postponed = chat({ autoArchivePostponedAt: FRESH_AT });
  for (const skipUnread of [true, false]) {
    const archived = [];
    const out = await sweepIdleChats({
      settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days', skipUnread } },
      now: NOW,
      deps: makeDeps({ chats: [postponed], archived }),
    });
    assert.deepEqual(archived, [], `skipUnread=${skipUnread}`);
    assert.deepEqual(out.archived, []);
  }
  const archived = [];
  await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps: makeDeps({ chats: [chat({ autoArchivePostponedAt: OLD_AT })], archived }),
  });
  assert.deepEqual(archived, ['chat-1'], 'an old postpone does not hold the chat');
});

test('a starred chat is skipped by default', async () => {
  const archived = [];
  const deps = makeDeps(
    { chats: [chat({ id: 'fav' }), chat({ id: 'plain' })], archived },
    { loadFavoriteChatIds: () => new Set(['fav']) },
  );
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.equal(out.skipFavorites, true);
  assert.deepEqual(archived, ['plain']);
});

test('a starred child keeps its whole family visible', async () => {
  const archived = [];
  const deps = makeDeps(
    {
      chats: [
        chat({ id: 'parent' }),
        chat({ id: 'child', forkParentChatId: 'parent', forkKind: 'delegation' }),
      ],
      rows: { parent: [{ parentChatId: 'parent', childChatId: 'child', status: 'completed' }] },
      archived,
    },
    { loadFavoriteChatIds: () => ['child'] },
  );
  await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
});

test('starred chats are archived when skipFavorites is off', async () => {
  const archived = [];
  const deps = makeDeps(
    { chats: [chat({ id: 'fav' })], archived },
    { loadFavoriteChatIds: () => { throw new Error('must not be read'); } },
  );
  await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days', skipFavorites: false } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, ['fav']);
});

test('an unreadable favorites list fails closed', async () => {
  const archived = [];
  const deps = makeDeps(
    { chats: [chat()], archived },
    { loadFavoriteChatIds: () => null },
  );
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps,
  });
  assert.deepEqual(archived, []);
  assert.equal(out.reason, 'favorites_load_failed');
});

/**
 * @param {object[]} chats
 * @param {Record<string, unknown>} [config]
 * @returns {Promise<{ out: Awaited<ReturnType<typeof sweepIdleChats>>, archived: string[] }>}
 */
async function sweep(chats, config = {}) {
  /** @type {string[]} */
  const archived = [];
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days', ...config } },
    now: NOW,
    deps: makeDeps({ chats, archived }),
  });
  return { out, archived };
}

test('an unread finished chat is skipped by default', async () => {
  const { out, archived } = await sweep([chat({ lastFinishedAt: OLD_AT })]);
  assert.equal(out.skipUnread, true);
  assert.deepEqual(archived, []);
});

test('an unread forked child keeps its whole family visible', async () => {
  const { archived } = await sweep([
    chat({ id: 'parent' }),
    chat({ id: 'fork', forkParentChatId: 'parent', lastFinishedAt: OLD_AT }),
  ]);
  assert.deepEqual(archived, []);
});

test('an unread delegation child does not hold its parent back', async () => {
  const { archived } = await sweep([
    chat({ id: 'parent' }),
    chat({
      id: 'child',
      forkParentChatId: 'parent',
      delegationParentChatId: 'parent',
      delegationId: 'job-1',
      lastFinishedAt: OLD_AT,
    }),
  ]);
  assert.deepEqual([...archived].sort(), ['child', 'parent']);
});

test('an unread technical chat is still archived', async () => {
  const { archived } = await sweep([chat({ title: '[Scout] Sweep', lastFinishedAt: OLD_AT })]);
  assert.deepEqual(archived, ['chat-1']);
});

test('opening a chat restarts its idle window', async () => {
  const { archived } = await sweep([chat({ lastFinishedAt: OLD_AT, lastSeenAt: FRESH_AT })]);
  assert.deepEqual(archived, []);
});

test('a read chat is archived once the window passes after opening it', async () => {
  const finished = new Date(NOW - 20 * CHAT_AUTO_ARCHIVE_DAY_MS).toISOString();
  const { archived } = await sweep([chat({ lastFinishedAt: finished, lastSeenAt: OLD_AT })]);
  assert.deepEqual(archived, ['chat-1']);
});

test('with skipUnread off, unread and recently opened chats follow updatedAt only', async () => {
  const { archived } = await sweep([
    chat({ id: 'unread', lastFinishedAt: OLD_AT }),
    chat({ id: 'opened', lastSeenAt: FRESH_AT }),
  ], { skipUnread: false });
  assert.deepEqual([...archived].sort(), ['opened', 'unread']);
});

test('a failing chat-store read never throws', async () => {
  const out = await sweepIdleChats({
    settings: { chatAutoArchive: { enabled: true, idleValue: 7, idleUnit: 'days' } },
    now: NOW,
    deps: {
      loadChats: () => { throw new Error('corrupt store'); },
    },
  });
  assert.equal(out.reason, 'load_failed');
  assert.deepEqual(out.archived, []);
});

test('reportChatAutoArchive logs and publishes one system notification', async () => {
  const published = [];
  const lines = [];
  await reportChatAutoArchive(
    { archived: ['a', 'b'], archivedTitles: ['Alpha', 'Beta'], idleValue: 7, idleUnit: 'days' },
    { now: 1, publish: async (n) => { published.push(n); }, log: (l) => lines.push(l) },
  );
  assert.equal(published.length, 1);
  assert.equal(published[0].category, 'system');
  assert.equal(published[0].title, 'Archived 2 idle chats');
  assert.match(published[0].body, /Alpha/);
  assert.equal(lines.length, 1);
  assert.equal(reportChatAutoArchive({ archived: [] }, { publish: () => assert.fail('no publish') }), undefined);
});

await Promise.all(pending);
if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nchat-auto-archive: all cases passed');
