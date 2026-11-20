import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_COUNTDOWN_IMMINENT_TONE,
  ARCHIVE_COUNTDOWN_SOON_TONE,
  formatArchiveCountdown,
  resolveArchiveCountdownImminentMs,
  collectChatForkDescendants,
  resolveArchiveCountdownWarnMs,
  resolveChatArchiveCountdown,
} from '../app_front/features/sidebar/sidebarChatArchiveCountdown.js';
import {
  __resetChatAutoArchiveConfigForTest,
  getChatAutoArchiveConfig,
  normalizeChatAutoArchiveConfig,
  setChatAutoArchiveConfig,
  subscribeChatAutoArchiveConfig,
} from '../app_front/features/chat/chatAutoArchiveConfig.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

/** @param {number} ms */
function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * A chat whose idle deadline is `remainingMs` away for the given window.
 *
 * @param {number} remainingMs
 * @param {number} idleMs
 * @param {object} [overrides]
 */
function chatWithRemaining(remainingMs, idleMs, overrides = {}) {
  return {
    id: 'c1',
    title: 'Chat',
    updatedAt: iso(NOW - idleMs + remainingMs),
    ...overrides,
  };
}

const THIRTY_DAYS = 30 * DAY;
const CONFIG = { enabled: true, idleMs: THIRTY_DAYS };

test('formatArchiveCountdown renders compact minute/hour/day labels', () => {
  assert.equal(formatArchiveCountdown(0), '<1m');
  assert.equal(formatArchiveCountdown(59_000), '<1m');
  assert.equal(formatArchiveCountdown(45 * MINUTE), '45m');
  assert.equal(formatArchiveCountdown(HOUR), '1h');
  assert.equal(formatArchiveCountdown(3 * HOUR + 20 * MINUTE), '3h20m');
  assert.equal(formatArchiveCountdown(12 * HOUR + 5 * MINUTE), '12h');
  assert.equal(formatArchiveCountdown(DAY), '1d');
  assert.equal(formatArchiveCountdown(2 * DAY + 4 * HOUR), '2d4h');
  assert.equal(formatArchiveCountdown(30 * DAY), '30d');
});

test('the warning window scales with the idle window and stays bounded', () => {
  assert.equal(resolveArchiveCountdownWarnMs(THIRTY_DAYS), 3 * DAY);
  assert.equal(resolveArchiveCountdownWarnMs(2 * HOUR), 12 * MINUTE);
  assert.equal(resolveArchiveCountdownWarnMs(30 * MINUTE), 3 * MINUTE);
  // A one-minute window must still warn, but never for more than half of it.
  assert.equal(resolveArchiveCountdownWarnMs(MINUTE), MINUTE / 2);
  assert.equal(resolveArchiveCountdownWarnMs(0), 0);
});

test('the imminent tone is at most an hour and at least a minute', () => {
  assert.equal(resolveArchiveCountdownImminentMs(THIRTY_DAYS), HOUR);
  assert.equal(resolveArchiveCountdownImminentMs(2 * HOUR), 2.4 * MINUTE);
  assert.equal(resolveArchiveCountdownImminentMs(MINUTE), MINUTE / 2);
});

test('an unread result hides the countdown unless skipUnread is off', () => {
  const unread = { lastFinishedAt: iso(NOW - 40 * DAY) };
  const row = chatWithRemaining(HOUR, THIRTY_DAYS, unread);
  assert.equal(resolveChatArchiveCountdown(row, { now: NOW, config: CONFIG, state: 'idle' }), null);
  const off = { ...CONFIG, skipUnread: false };
  assert.ok(resolveChatArchiveCountdown(row, { now: NOW, config: off, state: 'idle' }));
  const child = chatWithRemaining(HOUR, THIRTY_DAYS, { ...unread, delegationParentChatId: 'parent' });
  assert.ok(resolveChatArchiveCountdown(child, { now: NOW, config: CONFIG, state: 'idle' }));
  const scout = chatWithRemaining(HOUR, THIRTY_DAYS, { ...unread, title: '[Scout] Sweep' });
  assert.ok(resolveChatArchiveCountdown(scout, { now: NOW, config: CONFIG, state: 'idle' }));
});

test('opening a chat pushes the countdown back', () => {
  const justOpened = chatWithRemaining(MINUTE, THIRTY_DAYS, { lastSeenAt: iso(NOW - DAY) });
  assert.equal(resolveChatArchiveCountdown(justOpened, { now: NOW, config: CONFIG, state: 'idle' }), null);
  const opened = chatWithRemaining(MINUTE, THIRTY_DAYS, { lastSeenAt: iso(NOW - THIRTY_DAYS + HOUR) });
  const result = resolveChatArchiveCountdown(opened, { now: NOW, config: CONFIG, state: 'idle' });
  assert.equal(result?.remainingMs, HOUR);
});

test('countdown is hidden while auto-archive is disabled or the window is invalid', () => {
  const chat = chatWithRemaining(2 * DAY, THIRTY_DAYS);
  assert.equal(resolveChatArchiveCountdown(chat, { now: NOW, config: { enabled: false, idleMs: THIRTY_DAYS } }), null);
  assert.equal(resolveChatArchiveCountdown(chat, { now: NOW, config: { enabled: true, idleMs: 0 } }), null);
  assert.equal(resolveChatArchiveCountdown(chat, { now: NOW, config: null }), null);
});

test('countdown is hidden for pinned, archived and non-idle chats', () => {
  const base = { now: NOW, config: CONFIG, state: 'idle' };
  assert.equal(resolveChatArchiveCountdown(chatWithRemaining(2 * DAY, THIRTY_DAYS, { watcherPinned: true }), base), null);
  assert.equal(resolveChatArchiveCountdown(chatWithRemaining(2 * DAY, THIRTY_DAYS, { archivedAt: iso(NOW) }), base), null);
  assert.equal(resolveChatArchiveCountdown(chatWithRemaining(2 * DAY, THIRTY_DAYS, { archived: true }), base), null);
  assert.equal(resolveChatArchiveCountdown(chatWithRemaining(2 * DAY, THIRTY_DAYS), { ...base, state: 'active' }), null);
  assert.equal(resolveChatArchiveCountdown(chatWithRemaining(2 * DAY, THIRTY_DAYS), { ...base, state: 'awaiting' }), null);
  assert.equal(resolveChatArchiveCountdown(chatWithRemaining(2 * DAY, THIRTY_DAYS), { ...base, state: 'disconnected' }), null);
});

test('countdown is hidden for an unparseable updatedAt and before the warning window', () => {
  assert.equal(resolveChatArchiveCountdown({ id: 'c1', updatedAt: 'not-a-date' }, { now: NOW, config: CONFIG, state: 'idle' }), null);
  assert.equal(resolveChatArchiveCountdown({ id: 'c1' }, { now: NOW, config: CONFIG, state: 'idle' }), null);
  // 4 days left is outside the 3-day warning window for a 30-day setting.
  assert.equal(resolveChatArchiveCountdown(chatWithRemaining(4 * DAY, THIRTY_DAYS), { now: NOW, config: CONFIG, state: 'idle' }), null);
});

test('countdown shows the soon tone inside the warning window', () => {
  const actual = resolveChatArchiveCountdown(chatWithRemaining(2 * DAY, THIRTY_DAYS), {
    now: NOW,
    config: CONFIG,
    state: 'idle',
  });
  assert.deepEqual(actual, { remainingMs: 2 * DAY, warnMs: 3 * DAY, label: '2d', tone: ARCHIVE_COUNTDOWN_SOON_TONE });
});

test('countdown switches to the imminent tone near the deadline', () => {
  const actual = resolveChatArchiveCountdown(chatWithRemaining(30 * MINUTE, THIRTY_DAYS), {
    now: NOW,
    config: CONFIG,
    state: 'idle',
  });
  assert.equal(actual?.tone, ARCHIVE_COUNTDOWN_IMMINENT_TONE);
  assert.equal(actual?.label, '30m');
});

test('an overdue chat clamps the countdown to the floor instead of going negative', () => {
  const actual = resolveChatArchiveCountdown(chatWithRemaining(-5 * HOUR, THIRTY_DAYS), {
    now: NOW,
    config: CONFIG,
    state: 'idle',
  });
  assert.deepEqual(actual, { remainingMs: 0, warnMs: 3 * DAY, label: '<1m', tone: ARCHIVE_COUNTDOWN_IMMINENT_TONE });
});

test('an active or blocking fork descendant hides the parent countdown', () => {
  const parent = chatWithRemaining(30 * MINUTE, THIRTY_DAYS, { id: 'p' });
  const child = chatWithRemaining(30 * MINUTE, THIRTY_DAYS, { id: 'k', forkParentChatId: 'p' });
  const base = { now: NOW, config: CONFIG, state: 'idle' };
  assert.ok(resolveChatArchiveCountdown(parent, { ...base, descendants: [{ chat: child, state: 'idle' }] }));
  for (const state of ['active', 'awaiting', 'disconnected']) {
    assert.equal(resolveChatArchiveCountdown(parent, { ...base, descendants: [{ chat: child, state }] }), null, state);
  }
  assert.equal(resolveChatArchiveCountdown(parent, { ...base, descendants: [{ chat: child, state: 'idle', isFavorite: true }] }), null);
  assert.equal(resolveChatArchiveCountdown(parent, {
    ...base,
    descendants: [{ chat: { ...child, watcherPinned: true }, state: 'idle' }],
  }), null);
});

test('the family deadline follows its most recently active member', () => {
  const parent = chatWithRemaining(30 * MINUTE, THIRTY_DAYS, { id: 'p' });
  const lateChild = chatWithRemaining(2 * DAY, THIRTY_DAYS, { id: 'k', forkParentChatId: 'p' });
  const actual = resolveChatArchiveCountdown(parent, {
    now: NOW, config: CONFIG, state: 'idle', descendants: [{ chat: lateChild, state: 'idle' }],
  });
  assert.equal(actual?.remainingMs, 2 * DAY);
  assert.equal(actual?.tone, ARCHIVE_COUNTDOWN_SOON_TONE);
  const freshChild = chatWithRemaining(10 * DAY, THIRTY_DAYS, { id: 'k', forkParentChatId: 'p' });
  assert.equal(resolveChatArchiveCountdown(parent, {
    now: NOW, config: CONFIG, state: 'idle', descendants: [{ chat: freshChild, state: 'idle' }],
  }), null);
});

test('collectChatForkDescendants walks the live fork subtree and survives cycles', () => {
  const rows = [
    { id: 'p' },
    { id: 'a', forkParentChatId: 'p' },
    { id: 'b', forkParentChatId: 'a' },
    { id: 'gone', forkParentChatId: 'p', archived: true },
    { id: 'x', forkParentChatId: 'y' },
    { id: 'y', forkParentChatId: 'x' },
  ];
  assert.deepEqual(collectChatForkDescendants('p', rows).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(collectChatForkDescendants('x', rows).map((row) => row.id), ['y']);
  assert.deepEqual(collectChatForkDescendants('', rows), []);
});

test('postponing archiving restarts the countdown window', () => {
  const overdue = chatWithRemaining(-HOUR, THIRTY_DAYS);
  assert.ok(resolveChatArchiveCountdown(overdue, { now: NOW, config: CONFIG, state: 'idle' }));
  const postponed = { ...overdue, autoArchivePostponedAt: iso(NOW - MINUTE) };
  for (const skipUnread of [true, false]) {
    assert.equal(resolveChatArchiveCountdown(postponed, {
      now: NOW, config: { ...CONFIG, skipUnread }, state: 'idle',
    }), null, `skipUnread=${skipUnread}`);
  }
  const actual = resolveChatArchiveCountdown(chatWithRemaining(30 * MINUTE, THIRTY_DAYS), { now: NOW, config: CONFIG, state: 'idle' });
  assert.equal(actual?.warnMs, resolveArchiveCountdownWarnMs(THIRTY_DAYS));
});

test('config store normalizes a value/unit pair and notifies only on change', () => {
  __resetChatAutoArchiveConfigForTest();
  assert.deepEqual(getChatAutoArchiveConfig(), { enabled: false, idleMs: 0, skipFavorites: true, skipUnread: true });
  assert.deepEqual(normalizeChatAutoArchiveConfig({ enabled: true, idleValue: 2, idleUnit: 'hours' }), {
    enabled: true,
    idleMs: 2 * HOUR,
    skipFavorites: true,
    skipUnread: true,
  });

  const seen = [];
  const unsubscribe = subscribeChatAutoArchiveConfig((cfg) => seen.push(cfg));
  setChatAutoArchiveConfig({ enabled: true, idleValue: 2, idleUnit: 'hours' });
  setChatAutoArchiveConfig({ enabled: true, idleValue: 2, idleUnit: 'hours' });
  assert.equal(seen.length, 1, 'an identical value must not re-notify');
  assert.deepEqual(getChatAutoArchiveConfig(), { enabled: true, idleMs: 2 * HOUR, skipFavorites: true, skipUnread: true });
  unsubscribe();
  setChatAutoArchiveConfig({ enabled: false, idleValue: 2, idleUnit: 'hours' });
  assert.equal(seen.length, 1, 'unsubscribed listeners stop receiving updates');
  __resetChatAutoArchiveConfigForTest();
});
