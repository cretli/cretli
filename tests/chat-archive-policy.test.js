/**
 * Unit tests for the shared chat-archive gate (lib/chat-archive-policy.js),
 * which the Workspace Watcher orchestrator now uses at its report, reconcile
 * and boot archive sites. Fully dependency-injected so no chat store, no
 * delegation store and no model are required (assignment requirement G).
 *
 * Runner: plain assertion script — `node tests/chat-archive-policy.test.js`.
 */

import assert from 'node:assert/strict';
import {
  CHAT_ARCHIVE_GRACE_MS,
  archiveChatFamily,
  createChatArchivable,
  isChatAlreadyArchived,
} from '../lib/chat-archive-policy.js';

/** @type {number} */
let failures = 0;
const cases = [];

/**
 * @param {string} name
 * @param {() => void} fn
 */
function runCase(name, fn) {
  cases.push([name, fn]);
}

function asString(value) {
  return String(value == null ? '' : value).trim();
}

const NOW = Date.parse('2026-03-03T12:00:00.000Z');
/** An `updatedAt` clearly past the 15-minute archive grace. */
const OLD_AT = new Date(NOW - CHAT_ARCHIVE_GRACE_MS - 1000).toISOString();

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function chat(overrides = {}) {
  return {
    id: 'orchestrator',
    workspaceFolder: '/tmp/cr',
    updatedAt: OLD_AT,
    ...overrides,
  };
}

/**
 * Deps that archive nothing unless overridden, so each case opts into exactly
 * the signals it asserts on.
 *
 * @param {{ chats?: object[], rows?: Record<string, object[]>, archived: string[] }} input
 * @param {object} [extra]
 * @returns {object}
 */
function makeDeps(input, extra = {}) {
  const chats = input.chats || [];
  const rows = input.rows || {};
  return {
    loadChats: () => chats,
    updateChat: (id) => { input.archived.push(asString(id)); },
    listDelegationsForParent: (parentId) => rows[asString(parentId)] || [],
    isChatRunConfirmedIdle: () => true,
    isDelegationSlotOccupied: () => false,
    // Default: no live cycle child, so the archive proceeds; the dedicated
    // requirement-4 case overrides this to exercise the fail-closed guard.
    hasActiveWorkspaceWatcherCycleChildren: () => false,
    ...extra,
  };
}

runCase('success archives the terminal delegated child before the orchestrator', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'orchestrator' }),
      chat({ id: 'child', pickPurpose: 'implement' }),
    ],
    rows: { orchestrator: [{ parentChatId: 'orchestrator', childChatId: 'child', status: 'completed' }] },
    archived,
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, ['child', 'orchestrator'], 'children first, then the parent');
  assert.deepEqual(out.archived, ['child', 'orchestrator']);
  assert.equal(out.reason, 'archived');
  assert.equal(out.skipped, 0);
});

runCase('a delegated child that still occupies its slot refuses the whole portfolio', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'orchestrator' }),
      chat({ id: 'child', pickPurpose: 'implement' }),
    ],
    rows: { orchestrator: [{ parentChatId: 'orchestrator', childChatId: 'child', status: 'completed' }] },
    archived,
  }, { isDelegationSlotOccupied: () => true });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'a slot-holding child blocks its parent too');
  assert.deepEqual(out.archived, []);
  assert.equal(out.reason, 'family_blocked');
});

runCase('a pinned orchestrator is left in place', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [chat({ id: 'orchestrator', watcherPinned: true })],
    archived,
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'watcherPinned never archives');
  assert.equal(out.reason, 'family_blocked');
});

runCase('a pinned delegated child refuses its parent', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'orchestrator' }),
      chat({ id: 'child', pickPurpose: 'review', watcherPinned: true }),
    ],
    rows: { orchestrator: [{ parentChatId: 'orchestrator', childChatId: 'child', status: 'completed' }] },
    archived,
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'a pinned child blocks the family via the store fork cascade');
  assert.equal(out.reason, 'family_blocked');
});

runCase('unknown liveness (isChatRunConfirmedIdle false) is never archived', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ id: 'orchestrator' })], archived }, {
    isChatRunConfirmedIdle: ({ chatId }) => chatId !== 'orchestrator',
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'not-confirmed-idle stays (fail-closed)');
  assert.equal(out.reason, 'family_blocked');
});

runCase('a throwing liveness probe is treated as not-idle and skipped', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ id: 'orchestrator' })], archived }, {
    isChatRunConfirmedIdle: () => { throw new Error('adapter unavailable'); },
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'a probe error never archives');
  assert.equal(out.reason, 'family_blocked');
});

runCase('an update inside the archive grace window is left in place', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [chat({ id: 'orchestrator', updatedAt: new Date(NOW - 60_000).toISOString() })],
    archived,
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'a freshly touched chat is not hidden');
  assert.equal(out.reason, 'family_blocked');
});

runCase('an active watcher cycle child guard (requirement D) blocks archive even if the cycle closed', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ id: 'orchestrator' })], archived }, {
    hasActiveWorkspaceWatcherCycleChildren: () => true,
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'hasActiveWorkspaceWatcherCycleChildren true leaves everything alone');
  assert.equal(out.reason, 'cycle_children_active');
});

runCase('a non-terminal delegated child status refuses the portfolio', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'orchestrator' }),
      chat({ id: 'child', pickPurpose: 'implement' }),
    ],
    rows: { orchestrator: [{ parentChatId: 'orchestrator', childChatId: 'child', status: 'running' }] },
    archived,
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'a still-running child is not hidden');
  assert.equal(out.reason, 'family_blocked');
});

runCase('a deleted or already-archived child does not block the parent', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [chat({ id: 'orchestrator' })],
    rows: {
      orchestrator: [
        // Child row exists but its chat is gone from the store.
        { parentChatId: 'orchestrator', childChatId: 'missing-child', status: 'completed' },
      ],
    },
    archived,
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, ['orchestrator'], 'a vanished child never blocks its parent');
  assert.equal(out.reason, 'archived');
});

runCase('a busy fork descendant refuses the orchestrator (fork cascade cannot hide it)', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'orchestrator' }),
      chat({ id: 'fork', pickPurpose: 'implement', forkParentChatId: 'orchestrator' }),
    ],
    archived,
  }, { isChatRunConfirmedIdle: ({ chatId }) => chatId !== 'fork' });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'a busy fork child blocks the parent from the cascade');
  assert.equal(out.reason, 'family_blocked');
});

runCase('a failed delegation read is fail-closed', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ id: 'orchestrator' })], archived }, {
    listDelegationsForParent: () => { throw new Error('delegation store unavailable'); },
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, [], 'no archive without a trustworthy delegation read');
  assert.equal(out.reason, 'cycle_children_active');
});

runCase('a store write failure on a child blocks the parent and never throws', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'orchestrator' }),
      chat({ id: 'child', pickPurpose: 'implement' }),
    ],
    rows: { orchestrator: [{ parentChatId: 'orchestrator', childChatId: 'child', status: 'completed' }] },
    archived,
  }, {
    updateChat: (id) => {
      const value = asString(id);
      if (value === 'child') throw new Error('write failed');
      archived.push(value);
    },
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  // A delegation child is a real fork child, so archiving the parent would
  // cascade `archived` over the child that the direct write just failed to
  // reach. The failed child must leave the whole family in place.
  assert.deepEqual(archived, [], 'a failed child write blocks the parent from hiding it');
  assert.equal(out.skipped, 1, 'the write failure counts as a skip, not a throw');
  assert.equal(out.reason, 'nothing_to_archive');
});

runCase('repairs an archived parent with a later live descendant through archived forks', () => {
  const archived = [];
  const deps = makeDeps({
    chats: [
      chat({ id: 'orchestrator', archivedAt: OLD_AT }),
      chat({ id: 'child', forkParentChatId: 'orchestrator', archivedAt: OLD_AT }),
      chat({ id: 'grandchild', forkParentChatId: 'child' }),
    ],
    rows: {
      orchestrator: [{ childChatId: 'child', status: 'completed' }],
      child: [{ childChatId: 'grandchild', status: 'completed' }],
    },
    archived,
  });
  const out = archiveChatFamily('orchestrator', { now: NOW, deps });
  assert.deepEqual(archived, ['grandchild'], 'only the unarchived descendant needs a write');
  assert.deepEqual(out.archived, ['grandchild']);
});

runCase('an archived parent cannot hide a busy, pinned, fresh or slot-holding later child', () => {
  for (const blocked of ['busy', 'pinned', 'fresh', 'slot', 'parent-busy']) {
    const archived = [];
    const deps = makeDeps({
      chats: [
        chat({ id: 'orchestrator', archivedAt: OLD_AT }),
        chat({
          id: 'child',
          forkParentChatId: 'orchestrator',
          watcherPinned: blocked === 'pinned',
          updatedAt: blocked === 'fresh' ? new Date(NOW - 1000).toISOString() : OLD_AT,
        }),
      ],
      rows: { orchestrator: [{ childChatId: 'child', status: 'completed' }] },
      archived,
    }, {
      isChatRunConfirmedIdle: ({ chatId }) => !((blocked === 'busy' && chatId === 'child')
        || (blocked === 'parent-busy' && chatId === 'orchestrator')),
      isDelegationSlotOccupied: () => blocked === 'slot',
    });
    archiveChatFamily('orchestrator', { now: NOW, deps });
    assert.deepEqual(archived, [], `${blocked} blocks the repair`);
  }
});

runCase('an empty or unknown root id is a no-op', () => {
  const archived = [];
  const deps = makeDeps({ chats: [chat({ id: 'orchestrator' })], archived });
  assert.equal(archiveChatFamily('', { now: NOW, deps }).reason, 'no_chat');
  assert.equal(archiveChatFamily('ghost', { now: NOW, deps }).reason, 'chat_missing');
  assert.deepEqual(archived, []);
});

runCase('createChatArchivable matches the canArchive criterion (pin/grace/idle/unknown)', () => {
  const archivable = createChatArchivable({ now: NOW, isChatRunConfirmedIdle: () => true });
  assert.equal(archivable(chat({ id: 'ok' })), true);
  assert.equal(archivable(chat({ id: 'pin', watcherPinned: true })), false);
  assert.equal(archivable(chat({ id: 'arch', archived: true })), false);
  assert.equal(archivable(chat({ id: 'arch2', archivedAt: OLD_AT })), false);
  assert.equal(archivable(chat({ id: 'fresh', updatedAt: new Date(NOW - 1000).toISOString() })), false);
  assert.equal(archivable(chat({ id: 'bad', updatedAt: 'not-a-date' })), false);
  assert.equal(archivable(null), false);
  const unknown = createChatArchivable({ now: NOW, isChatRunConfirmedIdle: () => false });
  assert.equal(unknown(chat({ id: 'ok' })), false, 'unknown/not-idle is fail-closed');
});

runCase('isChatAlreadyArchived reads both archive flags', () => {
  assert.equal(isChatAlreadyArchived({ archived: true }), true);
  assert.equal(isChatAlreadyArchived({ archivedAt: '2026-01-01T00:00:00.000Z' }), true);
  assert.equal(isChatAlreadyArchived({}), false);
  assert.equal(isChatAlreadyArchived(null), false);
});

for (const [name, fn] of cases) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failures += 1;
    console.log('FAIL:', name);
    console.log(String(err && err.stack ? err.stack : err));
  }
}

if (failures) {
  console.log(`chat-archive-policy: ${failures} failed`);
  process.exit(1);
}
console.log('chat-archive-policy tests passed');
